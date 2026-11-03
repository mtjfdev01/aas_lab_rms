import "reflect-metadata";
import "./env.mjs";
import { NestFactory } from "@nestjs/core";
import { Module, Controller, All, Req, Res } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Server } from "socket.io";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { db, transaction } from "./database.mjs";
import { Operations } from "./service.mjs";
import { storage, upload } from "./media.mjs";
import {
  Fault,
  assert,
  branchAllowed,
  scopeRoom,
  id,
  permitted,
} from "./domain.mjs";
await db.initialize();
const [role] = await db.query(
  "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
);
const [ownership] = await db.query(
  "SELECT pg_has_role(current_user,tableowner,'USAGE') AS owns FROM pg_tables WHERE schemaname='public' AND tablename='orders'",
);
assert(
  role && !role.rolsuper && !role.rolbypassrls && !ownership?.owns,
  "Runtime DATABASE_URL must be a non-owner, non-superuser role without BYPASSRLS",
  500,
);
const ops = new Operations();
const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 },
}).single("file");
class Api {
  async handle(req, res) {
    try {
      const path = req.path.replace(/^\/api\/?/, "");
      if (path === "health") {
        await db.query("SELECT 1");
        return res.json({ status: "ok" });
      }
      if (path === "auth/login" && req.method === "POST")
        return res.json(await ops.login(req.body));
      if (path === "auth/refresh" && req.method === "POST")
        return res.json(await ops.refresh(req.body));
      if (path.startsWith("public/"))
        return res.json(
          await ops.public(
            req.headers["x-customer-token"] || req.query.token,
            req.method,
            path.slice(7),
            req.body || {},
            req.headers["idempotency-key"],
          ),
        );
      if (path.startsWith("media/public/")) {
        // Public asset resolution is deliberately token-scoped; no global media metadata lookup.
        const scope = await ops.publicScope(req.query.table);
        return await transaction(scope, async (q) => {
          const [asset] = await q(
            "SELECT * FROM media WHERE id=$1 AND public",
            [id(path.split("/").pop())],
          );
          assert(asset, "Image not found", 404);
          res
            .type("image/webp")
            .set("Cache-Control", "public, max-age=3600")
            .send(
              await storage.get(
                req.query.thumb ? asset.thumb_key : asset.object_key,
              ),
            );
        });
      }
      const user = await ops.authenticate(
        (req.headers.authorization || "").replace(/^Bearer /, ""),
      );
      const branch = req.headers["x-branch-id"] || null;
      if (path === "media" && req.method === "POST") {
        await new Promise((resolve, reject) =>
          uploadFile(req, res, (e) => (e ? reject(e) : resolve())),
        );
        return res
          .status(201)
          .json(
            await upload(
              ops,
              user,
              branch,
              req.file,
              req.body.public === "true",
            ),
          );
      }
      if (path.startsWith("media/")) {
        branchAllowed(user, branch);
        const imageId = id(path.split("/")[1]);
        return await ops.scoped(user, branch, async (q, s) => {
          const [asset] = await q("SELECT * FROM media WHERE id=$1", [imageId]);
          assert(asset, "Image not found", 404);
          if (!asset.public) permitted(user, "finance.manage");
          if (req.method === "DELETE") {
            permitted(user, asset.public ? "menu.manage" : "finance.manage");
            assert(
              !(
                await q(
                  "SELECT 1 FROM resources WHERE data->>'imageId'=$1 OR data->>'attachmentId'=$1",
                  [asset.id],
                )
              ).length,
              "Asset is referenced; replace its references first",
            );
            assert(
              !(
                await q(
                  "SELECT 1 FROM documents WHERE data->>'attachmentId'=$1",
                  [asset.id],
                )
              ).length,
              "Financial attachment is referenced",
            );
            await q("UPDATE media SET public=false WHERE id=$1", [asset.id]);
            await ops.audit(q, s, "media.retired", asset.id);
            return res.json({
              ok: true,
              note: "Asset retained for historical references",
            });
          }
          res
            .type("image/webp")
            .set("Cache-Control", "private, no-store")
            .send(
              await storage.get(
                req.query.thumb ? asset.thumb_key : asset.object_key,
              ),
            );
        });
      }
      const body = req.method === "GET" ? req.query : req.body || {};
      const result = await ops.staff(
        user,
        branch,
        req.method,
        path,
        body,
        req.headers["idempotency-key"],
      );
      return res.status(req.method === "POST" ? 201 : 200).json(result);
    } catch (e) {
      const status =
        e.status ||
        { 23505: 409, 23503: 400, "22P02": 400, 23514: 400, 42501: 403 }[
          e.code
        ] ||
        500;
      if (status === 500) console.error("Request failed:", e.code || e.name);
      return res.status(status).json({
        error:
          status === 500
            ? "Internal server error"
            : e.status
              ? e.message
              : status === 409
                ? "Conflicting or duplicate record"
                : "Invalid or inaccessible related record",
      });
    }
  }
}
Controller("api")(Api);
All(["", "{*path}"])(
  Api.prototype,
  "handle",
  Object.getOwnPropertyDescriptor(Api.prototype, "handle"),
);
Req()(Api.prototype, "handle", 0);
Res()(Api.prototype, "handle", 1);
class AppModule {}
Module({ controllers: [Api] })(AppModule);
const app = await NestFactory.create(AppModule, {
  logger: ["error", "warn", "log"],
});
app.use(helmet({ contentSecurityPolicy: false }));
app.enableCors({
  origin: process.env.WEB_ORIGIN || "http://localhost:5173",
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Branch-Id",
    "X-Customer-Token",
    "Idempotency-Key",
  ],
  methods: ["GET", "POST", "PATCH", "DELETE"],
});
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
app.use("/api/auth", rateLimit({ windowMs: 15 * 60000, limit: 30 }));
app.use("/api/public", rateLimit({ windowMs: 60000, limit: 45 }));
const paths = {};
for (const [route, methods, summary] of [
  ["/auth/login", ["post"], "Sign in with email/password"],
  ["/auth/refresh", ["post"], "Rotate refresh token"],
  ["/me", ["get"], "Current identity and authorized branches"],
  ["/logout", ["post"], "Revoke user tokens"],
  ["/branches", ["get", "post"], "Tenant owner branch administration"],
  ["/staff", ["get", "post"], "Tenant owner staff administration"],
  ["/staff/{id}", ["patch"], "Update staff permissions and assignments"],
  ["/settings", ["get", "post"], "Branch settings"],
  [
    "/resources/{kind}",
    ["get", "post"],
    "Configuration resources: category/product/override/floor/hall/station/charge/supplier/purchase_item/printer/schedule",
  ],
  ["/resources/{kind}/{id}", ["patch"], "Update or deactivate configuration"],
  ["/menu", ["get"], "Effective branch menu"],
  ["/tables", ["get", "post"], "Tables and active sessions"],
  ["/tables/{id}", ["patch"], "Update table"],
  [
    "/tables/{id}/qr",
    ["post"],
    "Rotate QR token; old link invalid immediately",
  ],
  ["/tables/{id}/session", ["post"], "Open table session with optional PIN"],
  ["/sessions/{id}/transfer", ["post"], "Transfer active session"],
  ["/orders", ["get", "post"], "View or create manual order"],
  ["/orders/{id}/confirm", ["post"], "Confirm QR order"],
  ["/orders/{id}/cancel", ["post"], "Cancel unbilled order with reason"],
  ["/orders/{id}/reassign", ["post"], "Audited order taker reassignment"],
  ["/items/{id}", ["patch"], "Advance station item state"],
  ["/bills", ["get", "post"], "Finalize all unbilled session items"],
  [
    "/payments",
    ["get", "post"],
    "Allocate partial/split bill or document payments",
  ],
  ["/payments/{id}/verify", ["post"], "Verify pending manual non-cash payment"],
  ["/payments/{id}/reject", ["post"], "Reject unverified payment with reason"],
  [
    "/bills/{id}/void",
    ["post"],
    "Void unpaid finalized bill with audited reversal",
  ],
  [
    "/documents/{id}/supplier-refund",
    ["post"],
    "Receive supplier refund against credit balance",
  ],
  ["/shifts/{id}/handover", ["post"], "Audited drawer handover"],
  ["/journals/{id}/reverse", ["post"], "Reverse discretionary cash movement"],
  ["/payments/{id}/refund", ["post"], "Authorized refund with reason"],
  ["/accounts", ["get", "post"], "Financial accounts and ledger balances"],
  ["/receiving-accounts", ["get"], "Minimal POS account choices"],
  ["/cash", ["post"], "Explicit miscellaneous/owner cash movement"],
  ["/transfers", ["post"], "Atomic same/cross-branch transfers"],
  ["/documents", ["get", "post"], "Purchases and expenses"],
  ["/documents/{id}/return", ["post"], "Unpaid purchase return adjustment"],
  ["/shifts", ["get", "post"], "Open cash drawer shift"],
  ["/shifts/{id}/close", ["post"], "Close with physical cash count"],
  ["/shifts/{id}/review", ["post"], "Manager closing review"],
  ["/requests", ["get"], "Waiter/bill requests"],
  ["/requests/{id}", ["post"], "Resolve request"],
  ["/reports", ["get"], "Sales, collections, balances and operational detail"],
  ["/audit", ["get"], "Sensitive action history"],
  ["/events", ["get"], "Persisted invalidation events"],
  ["/print-jobs", ["get", "post"], "Queue bill print or list persisted jobs"],
  ["/print-jobs/{id}", ["patch"], "Report browser dispatch outcome"],
  ["/print-jobs/{id}/reprint", ["post"], "Explicit audited reprint"],
  ["/public/menu", ["get"], "Public table-scoped menu using query token"],
  ["/public/join", ["post"], "Create isolated customer session"],
  ["/public/orders", ["get", "post"], "Create/track own QR orders"],
  ["/public/request", ["post"], "Waiter or bill request"],
  [
    "/media",
    ["post"],
    "Upload validated image multipart file and public field",
  ],
  ["/media/{id}", ["get", "delete"], "Authorized asset read/retire"],
  ["/media/public/{id}", ["get"], "QR-token-scoped public menu image"],
  ["/health", ["get"], "Database health"],
]) {
  paths["/api" + route] = {};
  for (const method of methods) {
    const publicRoute =
      route.startsWith("/public") ||
      route.startsWith("/auth") ||
      route === "/health";
    const parameters = [
      ...Array.from(route.matchAll(/\{(\w+)\}/g), (m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
    ];
    if (!publicRoute)
      parameters.push({
        name: "X-Branch-Id",
        in: "header",
        schema: { type: "string", format: "uuid" },
      });
    if (method !== "get" && !route.startsWith("/auth"))
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string" },
      });
    if (route.startsWith("/public"))
      parameters.push({
        name: route === "/public/menu" ? "token" : "X-Customer-Token",
        in: route === "/public/menu" ? "query" : "header",
        schema: { type: "string" },
      });
    paths["/api" + route][method] = {
      summary,
      security: publicRoute ? [] : [{ bearer: [] }],
      parameters,
      ...(method === "post" || method === "patch"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            },
          }
        : {}),
      responses: {
        200: { description: "Success" },
        400: { description: "Validation failed" },
        401: { description: "Authentication failed" },
        403: { description: "Scope/permission denied" },
        409: { description: "Conflict" },
      },
    };
  }
}
paths["/api/media"].post.requestBody = {
  required: true,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["file"],
        properties: {
          file: { type: "string", format: "binary" },
          public: { type: "string", enum: ["true", "false"] },
        },
      },
    },
  },
};
for (const path of Object.values(paths))
  for (const operation of Object.values(path))
    operation.responses[201] = { description: "Created" };
paths["/api/bills/{id}/history"] = {
  get: {
    summary: "Read immutable bill timeline (tenant and branch scoped)",
    security: [{ bearer: [] }],
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      {
        name: "X-Branch-Id",
        in: "header",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 500 },
      },
    ],
    responses: {
      200: { description: "Paginated timeline" },
      403: { description: "Permission denied" },
      404: { description: "Bill not visible in authorized scope" },
    },
  },
};
SwaggerModule.setup("docs", app, {
  openapi: "3.0.0",
  info: {
    title: "AAS RMS API",
    version: "1.0.0",
    description:
      "All staff writes need a fresh Idempotency-Key and authorized X-Branch-Id. Monetary inputs use integer minor units. See docs/API.md for payloads.",
  },
  paths,
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
});
const io = new Server(app.getHttpServer(), {
  cors: { origin: process.env.WEB_ORIGIN || "http://localhost:5173" },
  maxHttpBufferSize: 10000,
});
io.use(async (socket, next) => {
  try {
    socket.data.user = await ops.authenticate(socket.handshake.auth.token);
    branchAllowed(socket.data.user, socket.handshake.auth.branchId);
    await ops.scoped(
      socket.data.user,
      socket.handshake.auth.branchId,
      async () => ({ ok: true }),
    );
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});
io.on("connection", (socket) => {
  const u = socket.data.user,
    b = socket.handshake.auth.branchId;
  socket.join(scopeRoom(u.tenant_id, b));
  const expiry = setTimeout(() => socket.disconnect(true), 15 * 60 * 1000);
  socket.on("disconnect", () => clearTimeout(expiry));
  socket.emit("refresh", { reason: "reconnect" });
});
// Revalidate assignments and token revocations before sending each payload-free invalidation.
ops.emit = async (tenant, branch) => {
  for (const socket of await io.in(scopeRoom(tenant, branch)).fetchSockets()) {
    try {
      const u = await ops.authenticate(socket.handshake.auth.token);
      branchAllowed(u, branch);
      await ops.scoped(u, branch, async () => ({ ok: true }));
      socket.emit("refresh", { reason: "change" });
    } catch {
      socket.disconnect(true);
    }
  }
};
await app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
async function shutdown() {
  await io.close();
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
