import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { io } from "socket.io-client";
const base = "http://127.0.0.1:3000/api";
const branch = "20000000-0000-4000-8000-000000000001",
  north = "20000000-0000-4000-8000-000000000002",
  foreignBranch = "20000000-0000-4000-8000-000000000003";
const login = async (email) => {
  const r = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: process.env.DEMO_PASSWORD || "DemoOnly-ChangeMe-2026",
    }),
  });
  assert.equal(r.status, 200);
  return r.json();
};
const owner = await login("owner@demo.test"),
  manager = await login("manager@demo.test"),
  foreign = await login("owner2@demo.test");
const headers = (auth, branchId = branch) => ({
  Authorization: "Bearer " + auth.accessToken,
  "X-Branch-Id": branchId,
  "Idempotency-Key": randomUUID(),
});
assert.equal((await fetch(base + "/orders")).status, 401);
assert.equal(
  (await fetch(base + "/orders", { headers: headers(manager, north) })).status,
  403,
);
assert.equal(
  (await fetch(base + "/orders", { headers: headers(owner, foreignBranch) }))
    .status,
  404,
);
assert.equal(
  (
    await fetch(base + "/orders", {
      headers: {
        Authorization: "Bearer " + owner.refreshToken,
        "X-Branch-Id": branch,
      },
    })
  ).status,
  401,
);
const image = await sharp({
  create: { width: 20, height: 20, channels: 3, background: "#096c56" },
})
  .png()
  .toBuffer();
const form = new FormData();
form.append("file", new Blob([image], { type: "image/png" }), "test.png");
form.append("public", "false");
const r = await fetch(base + "/media", {
  method: "POST",
  headers: headers(owner),
  body: form,
});
assert.equal(r.status, 201, await r.clone().text());
const asset = await r.json();
assert.equal(
  (await fetch(base + "/media/" + asset.id, { headers: headers(owner) }))
    .status,
  200,
);
assert.equal(
  (
    await fetch(base + "/media/" + asset.id, {
      headers: headers(foreign, foreignBranch),
    })
  ).status,
  404,
);
const fake = new FormData();
fake.append(
  "file",
  new Blob(["<script>bad</script>"], { type: "image/png" }),
  "fake.png",
);
fake.append("public", "true");
const bad = await fetch(base + "/media", {
  method: "POST",
  headers: headers(owner),
  body: fake,
});
assert.ok(
  [400, 415, 422].includes(bad.status),
  "File content must be rejected as validation failure",
);
const connect = (auth, branchId, expected) =>
  new Promise((resolve, reject) => {
    const socket = io("http://127.0.0.1:3000", {
      auth: { token: auth.accessToken, branchId },
      reconnection: false,
      timeout: 5000,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket timeout"));
    }, 7000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.disconnect();
      expected ? resolve() : reject(new Error("Unauthorized room accepted"));
    });
    socket.on("connect_error", () => {
      clearTimeout(timer);
      socket.disconnect();
      expected ? reject(new Error("Authorized room rejected")) : resolve();
    });
  });
await connect(owner, branch, true);
await connect(owner, foreignBranch, false);
await connect(manager, north, false);
console.log(
  "PASS: HTTP authentication, branch denial, refresh-token separation, private uploads, content sniffing and authorized WebSocket subscriptions.",
);
