import "./env.mjs";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module, Controller, All, Req, Res } from "@nestjs/common";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { makeDatabase } from "./database.mjs";
import { assert, id, str, int, ROLES } from "./domain.mjs";
import { fileURLToPath } from "node:url";
const platformDb = makeDatabase(
  process.env.PLATFORM_DATABASE_URL || process.env.MIGRATION_DATABASE_URL,
);
const supportDb = makeDatabase(process.env.DATABASE_URL);
export async function bootstrapAdmin() {
  assert(
    process.env.PLATFORM_ADMIN_PASSWORD?.length >= 14,
    "Set PLATFORM_ADMIN_PASSWORD (14+ characters)",
  );
  await platformDb.initialize();
  await platformDb.query(
    "INSERT INTO platform_admins(email,name,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING",
    [
      str(process.env.PLATFORM_ADMIN_EMAIL).toLowerCase(),
      "Platform administrator",
      await bcrypt.hash(process.env.PLATFORM_ADMIN_PASSWORD, 12),
    ],
  );
  await platformDb.destroy();
  console.log(
    "Platform administrator created. Existing credentials were preserved.",
  );
}
export async function startPlatform() {
  assert(
    process.env.PLATFORM_JWT_SECRET?.length >= 32,
    "PLATFORM_JWT_SECRET must contain at least 32 characters",
  );
  assert(
    process.env.PLATFORM_JWT_SECRET !== process.env.JWT_SECRET,
    "Use a distinct platform signing secret",
  );
  await platformDb.initialize();
  await supportDb.initialize();
  class PlatformApi {
    async handle(req, res) {
      try {
        const path = req.path.replace(/^\/platform-api\/?/, "");
        if (path === "login" && req.method === "POST") {
          const [admin] = await platformDb.query(
            "SELECT * FROM platform_admins WHERE email=$1 AND active",
            [str(req.body.email).toLowerCase()],
          );
          assert(
            admin &&
              (await bcrypt.compare(
                String(req.body.password || ""),
                admin.password_hash,
              )),
            "Invalid credentials",
            401,
          );
          return res.json({
            token: jwt.sign(
              { sub: admin.id, version: admin.token_version },
              process.env.PLATFORM_JWT_SECRET,
              {
                expiresIn: "15m",
                issuer: "aas-platform",
                audience: "aas-platform",
              },
            ),
          });
        }
        let claims;
        try {
          claims = jwt.verify(
            (req.headers.authorization || "").replace(/^Bearer /, ""),
            process.env.PLATFORM_JWT_SECRET,
            {
              issuer: "aas-platform",
              audience: "aas-platform",
              algorithms: ["HS256"],
            },
          );
        } catch {
          assert(false, "Platform sign-in required", 401);
        }
        const [admin] = await platformDb.query(
          "SELECT id,name FROM platform_admins WHERE id=$1 AND token_version=$2 AND active",
          [claims.sub, claims.version],
        );
        assert(admin, "Platform access revoked", 401);
        if (path === "tenants" && req.method === "GET")
          return res.json(
            await platformDb.query(
              "SELECT t.*, (SELECT count(*) FROM branches b WHERE b.tenant_id=t.id) AS branch_count FROM tenants t ORDER BY created_at DESC LIMIT 500",
            ),
          );
        if (path === "audit" && req.method === "GET")
          return res.json(
            await platformDb.query(
              "SELECT id,actor_id,tenant_id,action,reason,created_at FROM platform_audit ORDER BY created_at DESC LIMIT 300",
            ),
          );
        if (path === "tenants" && req.method === "POST") {
          const body = req.body;
          str(body.name);
          str(body.ownerEmail);
          assert(
            body.ownerPassword?.length >= 12,
            "Owner password needs 12+ characters",
          );
          const reason = str(body.reason, 500);
          const result = await platformDb.transaction(async (em) => {
            const [tenant] = await em.query(
              "INSERT INTO tenants(name) VALUES($1) RETURNING *",
              [body.name],
            );
            const [branch] = await em.query(
              "INSERT INTO branches(tenant_id,name) VALUES($1,$2) RETURNING *",
              [tenant.id, str(body.branchName || "Main Branch")],
            );
            await em.query(
              "INSERT INTO users(tenant_id,email,name,staff_id,password_hash,role,permissions,branches) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
              [
                tenant.id,
                body.ownerEmail.toLowerCase(),
                str(body.ownerName),
                "EMP-001",
                await bcrypt.hash(body.ownerPassword, 12),
                "owner",
                JSON.stringify(ROLES.owner),
                JSON.stringify([branch.id]),
              ],
            );
            await em.query(
              "INSERT INTO platform_audit(actor_id,tenant_id,action,reason) VALUES($1,$2,$3,$4)",
              [admin.id, tenant.id, "tenant.created", reason],
            );
            return tenant;
          });
          return res.status(201).json(result);
        }
        const match = path.match(/^tenants\/([^/]+)\/(state|support)$/);
        assert(match, "Endpoint not found", 404);
        assert(req.method === "POST", "Method not allowed", 405);
        const tenantId = id(match[1]);
        const reason = str(req.body.reason, 500);
        if (match[2] === "state") {
          assert(
            ["trial", "active", "suspended", "expired"].includes(
              req.body.state,
            ),
            "Invalid subscription state",
          );
          return res.json(
            await platformDb.transaction(async (em) => {
              const [tenant] = await em.query(
                "SELECT * FROM tenants WHERE id=$1 FOR UPDATE",
                [tenantId],
              );
              assert(tenant, "Tenant not found", 404);
              await em.query(
                "UPDATE tenants SET state=$1,storage_limit=$2 WHERE id=$3",
                [
                  req.body.state,
                  req.body.storageLimit === undefined
                    ? tenant.storage_limit
                    : int(req.body.storageLimit, 0, 1000000000000),
                  tenantId,
                ],
              );
              await em.query(
                "INSERT INTO platform_audit(actor_id,tenant_id,action,reason,data) VALUES($1,$2,$3,$4,$5)",
                [
                  admin.id,
                  tenantId,
                  "subscription.changed",
                  reason,
                  JSON.stringify({
                    before: tenant.state,
                    after: req.body.state,
                  }),
                ],
              );
              return { ok: true };
            }),
          );
        }
        // No impersonation token. Every read is a separate explicit, audited support action.
        await platformDb.query(
          "INSERT INTO platform_audit(actor_id,tenant_id,action,reason) VALUES($1,$2,$3,$4)",
          [admin.id, tenantId, "support.read", reason],
        );
        return res.json(
          await supportDb.transaction(async (em) => {
            await em.query(
              "SELECT set_config('app.tenant',$1,true),set_config('app.branch','',true)",
              [tenantId],
            );
            return {
              branches: await em.query("SELECT id,name,currency FROM branches"),
              orders: await em.query(
                "SELECT id,branch_id,number,status,source,created_at FROM orders ORDER BY created_at DESC LIMIT 100",
              ),
            };
          }),
        );
      } catch (e) {
        res.status(e.status || (e.code === "23505" ? 409 : 500)).json({
          error: e.status
            ? e.message
            : e.code === "23505"
              ? "Duplicate record"
              : "Platform request failed",
        });
      }
    }
  }
  Controller("platform-api")(PlatformApi);
  All(["", "{*path}"])(
    PlatformApi.prototype,
    "handle",
    Object.getOwnPropertyDescriptor(PlatformApi.prototype, "handle"),
  );
  Req()(PlatformApi.prototype, "handle", 0);
  Res()(PlatformApi.prototype, "handle", 1);
  class PlatformModule {}
  Module({ controllers: [PlatformApi] })(PlatformModule);
  const app = await NestFactory.create(PlatformModule);
  app.use(helmet());
  app.use(rateLimit({ windowMs: 60000, limit: 100 }));
  app.use("/platform-api/login", rateLimit({ windowMs: 900000, limit: 20 }));
  app.enableCors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" });
  await app.listen(Number(process.env.PLATFORM_PORT || 3001), "127.0.0.1");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "bootstrap") await bootstrapAdmin();
  else await startPlatform();
}
