import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { transaction, db } from "./database.mjs";
import { assert, permitted, branchAllowed, id, digest } from "./domain.mjs";
const root = resolve(process.env.UPLOAD_DIR || "./uploads");
const s3 = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  ...(process.env.S3_ENDPOINT
    ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
    : {}),
});
export const storage = {
  async put(key, buffer) {
    if (process.env.STORAGE_DRIVER === "s3")
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: "image/webp",
        }),
      );
    else {
      const path = resolve(root, key);
      assert(path.startsWith(root + "/"), "Invalid storage key");
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, buffer, { flag: "wx" });
    }
  },
  async get(key) {
    if (process.env.STORAGE_DRIVER === "s3") {
      const r = await s3.send(
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
      );
      return Buffer.from(await r.Body.transformToByteArray());
    }
    return readFile(resolve(root, key));
  },
  async delete(key) {
    if (process.env.STORAGE_DRIVER === "s3")
      await s3.send(
        new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
      );
    else
      await unlink(resolve(root, key)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
  },
};
export async function upload(ops, user, branch, file, publicImage) {
  branchAllowed(user, branch);
  permitted(user, publicImage ? "menu.manage" : "finance.manage");
  assert(
    file?.buffer?.length && file.size <= 5 * 1024 * 1024,
    "Choose an image under 5 MB",
  );
  const image = sharp(file.buffer, {
    limitInputPixels: 25000000,
    failOn: "warning",
  });
  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    assert(false, "Invalid image content", 415);
  }
  assert(
    ["jpeg", "png", "webp"].includes(metadata.format),
    "Only actual JPEG, PNG and WebP images are supported",
  );
  const main = await image
    .rotate()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const thumb = await sharp(main)
    .resize(320, 320, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  const key = `${user.tenant_id}/${branch}/${randomUUID()}`;
  let stored = [];
  try {
    return await transaction({ ...user, branch_id: branch }, async (q) => {
      await q("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${user.tenant_id}:write`,
      ]);
      const [t] = await q("SELECT * FROM tenants WHERE id=$1", [
        user.tenant_id,
      ]);
      assert(
        process.env.SUBSCRIPTION_ENFORCED === "false" ||
          ["active", "trial"].includes(t.state),
        "Subscription access restricted",
        403,
      );
      await q("SELECT set_config('app.branch','',true)");
      const [{ size }] = await q(
        "SELECT COALESCE(sum(size),0) AS size FROM media",
      );
      await q("SELECT set_config('app.branch',$1,true)", [branch]);
      assert(
        Number(size) + main.length + thumb.length <= Number(t.storage_limit),
        "Storage allowance exceeded",
        413,
      );
      await storage.put(key + ".webp", main);
      stored.push(key + ".webp");
      await storage.put(key + "-thumb.webp", thumb);
      stored.push(key + "-thumb.webp");
      const [row] = await q(
        "INSERT INTO media(tenant_id,branch_id,object_key,thumb_key,size,public,mime) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,public,mime,size",
        [
          user.tenant_id,
          publicImage ? null : branch,
          key + ".webp",
          key + "-thumb.webp",
          main.length + thumb.length,
          publicImage,
          "image/webp",
        ],
      );
      await ops.audit(
        q,
        { ...user, branch_id: branch },
        "media.uploaded",
        row.id,
      );
      return row;
    });
  } catch (e) {
    await Promise.allSettled(stored.map((k) => storage.delete(k)));
    throw e;
  }
}
