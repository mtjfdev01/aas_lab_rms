import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, transaction } from "./database.mjs";
import {
  Fault,
  assert,
  id,
  int,
  str,
  token,
  digest,
  ROLES,
  PERMISSIONS,
  permitted,
  branchAllowed,
  priceItem,
  calculateBill,
  billDiscount,
  transitionItem,
  aggregate,
  balanced,
  businessDate,
} from "./domain.mjs";
const one = async (q, sql, args = []) => {
  const rows = await q(sql, args);
  assert(rows.length, "Record not found", 404);
  return rows[0];
};
const json = (v) => JSON.stringify(v);
const PUBLIC_FIELDS =
  "id,name,staff_id,role,permissions,branches,station_ids,active";
const KINDS = [
  "category",
  "product",
  "override",
  "floor",
  "hall",
  "station",
  "charge",
  "supplier",
  "purchase_item",
  "printer",
  "schedule",
];
const TENANT_KINDS = ["category", "product"];
const STAFF_ROUTES = [
  [
    /^(me|menu|access-options|branch-staff|receiving-accounts|reports|events|audit)$/,
    ["GET"],
  ],
  [/^(logout|password|cash|transfers)$/, ["POST"]],
  [
    /^(branches|settings|staff|tables|orders|bills|accounts|payments|documents|shifts|print-jobs)$/,
    ["GET", "POST"],
  ],
  [/^(staff|items|tables)\/[^/]+$/, ["PATCH"]],
  [/^resources\/[^/]+$/, ["GET", "POST"]],
  [/^resources\/[^/]+\/[^/]+$/, ["PATCH"]],
  [/^tables\/[^/]+\/(qr|session)$/, ["POST"]],
  [/^sessions\/[^/]+\/transfer$/, ["POST"]],
  [/^orders\/[^/]+\/(confirm|cancel|reassign)$/, ["POST"]],
  [/^bills\/[^/]+\/void$/, ["POST"]],
  [/^bills\/[^/]+\/history$/, ["GET"]],
  [/^payments\/[^/]+\/(verify|reject|refund)$/, ["POST"]],
  [/^documents\/[^/]+\/(return|supplier-refund)$/, ["POST"]],
  [/^journals\/[^/]+\/reverse$/, ["POST"]],
  [/^shifts\/[^/]+\/(close|review|handover)$/, ["POST"]],
  [/^requests$/, ["GET"]],
  [/^requests\/[^/]+$/, ["POST"]],
  [/^print-jobs\/[^/]+$/, ["PATCH"]],
  [/^print-jobs\/[^/]+\/reprint$/, ["POST"]],
];
export class Operations {
  constructor() {
    assert(
      process.env.JWT_SECRET?.length >= 32,
      "JWT_SECRET must contain at least 32 characters",
      500,
    );
    this.emit = () => {};
  }
  async login(body) {
    const email = str(body.email).toLowerCase();
    const [user] = await db.query("SELECT * FROM auth_lookup($1)", [email]);
    assert(
      user &&
        (await bcrypt.compare(String(body.password || ""), user.password_hash)),
      "Invalid credentials",
      401,
    );
    return this.tokens(user);
  }
  tokens(user) {
    const claims = {
      sub: user.id,
      email: user.email,
      version: user.token_version,
    };
    return {
      accessToken: jwt.sign(
        { ...claims, type: "access" },
        process.env.JWT_SECRET,
        { expiresIn: "15m", issuer: "aas-rms", audience: "aas-staff" },
      ),
      refreshToken: jwt.sign(
        { ...claims, type: "refresh" },
        process.env.JWT_SECRET,
        { expiresIn: "7d", issuer: "aas-rms", audience: "aas-staff" },
      ),
    };
  }
  async authenticate(raw, type = "access") {
    let claims;
    try {
      claims = jwt.verify(raw, process.env.JWT_SECRET, {
        issuer: "aas-rms",
        audience: "aas-staff",
        algorithms: ["HS256"],
      });
    } catch {
      throw new Fault(401, "Session expired");
    }
    assert(claims.type === type, "Invalid token type", 401);
    const [u] = await db.query("SELECT * FROM auth_lookup($1)", [claims.email]);
    assert(
      u && u.id === claims.sub && u.token_version === claims.version,
      "Session revoked",
      401,
    );
    delete u.password_hash;
    return u;
  }
  async refresh(body) {
    const u = await this.authenticate(body.refreshToken, "refresh");
    const version = await transaction(u, async (q) => {
      const [updated] = await q(
        "UPDATE users SET token_version=token_version+1 WHERE id=$1 AND token_version=$2 RETURNING token_version",
        [u.id, u.token_version],
      );
      assert(updated, "Refresh token already consumed", 401);
      return updated.token_version;
    });
    u.token_version = version;
    return this.tokens(u);
  }
  async audit(q, s, action, target, data = {}) {
    await q(
      "INSERT INTO audit(tenant_id,branch_id,actor_id,action,target_id,data) VALUES($1,$2,$3,$4,$5,$6)",
      [
        s.tenant_id,
        s.branch_id || null,
        s.id || null,
        action,
        target || null,
        json(data),
      ],
    );
  }
  async scoped(user, branch, fn, { write = false, key, body, path } = {}) {
    if (branch) branchAllowed(user, branch);
    const scope = { ...user, branch_id: branch || null };
    const result = await transaction(scope, async (q) => {
      const tenant = await one(q, "SELECT * FROM tenants WHERE id=$1", [
        user.tenant_id,
      ]);
      assert(
        process.env.SUBSCRIPTION_ENFORCED === "false" ||
          ["active", "trial"].includes(tenant.state),
        "Subscription access restricted",
        403,
      );
      if (branch) await one(q, "SELECT id FROM branches WHERE id=$1", [branch]);
      if (write) {
        await q("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${user.tenant_id}:write`,
        ]);
      }
      const hash = digest(json({ path, body, branch }));
      if (write) {
        str(key, 128);
        const existing = (
          await q("SELECT * FROM idempotency WHERE actor=$1 AND key=$2", [
            user.id,
            key,
          ])
        )[0];
        if (existing) {
          assert(
            existing.hash === hash,
            "Idempotency key reused with different input",
            409,
          );
          return existing.response;
        }
      }
      const data = await fn(q, scope, tenant);
      if (write) {
        assert(branch, "Mutation needs a branch");
        await q(
          "INSERT INTO idempotency(tenant_id,branch_id,actor,key,hash,response) VALUES($1,$2,$3,$4,$5,$6)",
          [user.tenant_id, branch, user.id, key, hash, json(data ?? {})],
        );
        await q(
          "INSERT INTO events(tenant_id,branch_id,type) VALUES($1,$2,$3)",
          [user.tenant_id, branch, path],
        );
      }
      return data;
    });
    if (write)
      Promise.resolve(this.emit(user.tenant_id, branch)).catch(() => {});
    return result;
  }
  async resource(q, s, recordId, kind) {
    const r = await one(q, "SELECT * FROM resources WHERE id=$1 AND kind=$2", [
      id(recordId),
      kind,
    ]);
    assert(
      !r.branch_id || r.branch_id === s.branch_id,
      "Related record belongs to another branch",
      403,
    );
    return r;
  }
  async product(q, s, productId) {
    const p = await this.resource(q, s, productId, "product");
    const [override] = await q(
      "SELECT * FROM resources WHERE kind='override' AND branch_id=$1 AND data->>'productId'=$2 AND active",
      [s.branch_id, p.id],
    );
    if (override) p.data = { ...p.data, ...override.data };
    return p;
  }
  async validateResource(q, s, kind, body) {
    assert(KINDS.includes(kind), "Unknown resource");
    str(body.name);
    assert(
      body.active === undefined || typeof body.active === "boolean",
      "Invalid active flag",
    );
    const d = body.data || {};
    assert(
      d && typeof d === "object" && !Array.isArray(d),
      "Invalid resource data",
    );
    if (d.displayOrder !== undefined) int(d.displayOrder, 0, 1000000);
    if (kind === "product" || kind === "override") {
      for (const key of ["available", "soldOut"])
        assert(
          d[key] === undefined || typeof d[key] === "boolean",
          "Availability must be boolean",
        );
      assert(
        d.variants === undefined ||
          (Array.isArray(d.variants) && d.variants.length <= 50),
        "Invalid variants",
      );
      assert(
        d.modifierGroups === undefined ||
          (Array.isArray(d.modifierGroups) && d.modifierGroups.length <= 20),
        "Invalid modifier groups",
      );
      if (kind === "override")
        await this.resource(q, s, d.productId, "product");
      if (kind === "product" || d.price !== undefined) int(d.price);
      if (d.categoryId) await this.resource(q, s, d.categoryId, "category");
      if (d.stationId) await this.resource(q, s, d.stationId, "station");
      assert(
        !d.stationId || kind === "override",
        "Assign branch stations through branch overrides",
      );
      for (const v of d.variants || []) {
        str(v.id);
        str(v.name);
        int(v.price);
      }
      const optionIds = [];
      for (const g of d.modifierGroups || []) {
        str(g.name);
        int(g.min || 0, 0, 30);
        int(g.max, 0, 30);
        assert(
          (g.min || 0) <= g.max &&
            Array.isArray(g.options) &&
            g.max <= g.options.length &&
            g.options.length <= 50,
          "Invalid modifier limits",
        );
        for (const o of g.options) {
          str(o.id);
          str(o.name);
          int(o.price);
          optionIds.push(o.id);
        }
      }
      assert(
        new Set(optionIds).size === optionIds.length,
        "Duplicate modifier identifiers",
      );
      assert(
        new Set((d.variants || []).map((v) => v.id)).size ===
          (d.variants || []).length,
        "Duplicate variants",
      );
      if (d.imageId)
        await one(q, "SELECT id FROM media WHERE id=$1 AND public", [
          id(d.imageId),
        ]);
    }
    if (kind === "hall" && d.floorId)
      await this.resource(q, s, d.floorId, "floor");
    if (kind === "charge") {
      str(d.name || body.name);
      assert(["percent", "fixed"].includes(d.mode), "Invalid charge mode");
      int(d.value, 0, d.mode === "percent" ? 10000 : 100000000);
      assert(
        ["items", "running"].includes(d.base || "items"),
        "Invalid calculation base",
      );
      if (d.types)
        assert(
          Array.isArray(d.types) &&
            d.types.every((t) => ["DINE_IN", "TAKEAWAY"].includes(t)),
          "Invalid order types",
        );
      if (d.effectiveAt)
        assert(
          !Number.isNaN(Date.parse(d.effectiveAt)),
          "Invalid effective date",
        );
      int(d.sequence || 0, 0, 1000);
    }
    if (kind === "printer") {
      assert([58, 80].includes(d.width), "Printer width must be 58 or 80");
      assert(
        ["bill", "kitchen", "bar"].includes(d.destination),
        "Invalid print destination",
      );
      if (d.stationId) await this.resource(q, s, d.stationId, "station");
    }
    if (kind === "schedule") {
      const u = await one(
        q,
        "SELECT branches,role FROM users WHERE id=$1 AND active",
        [id(d.userId)],
      );
      assert(
        u.role === "owner" || u.branches.includes(s.branch_id),
        "Staff not assigned to branch",
      );
      assert(
        Date.parse(d.endsAt) > Date.parse(d.startsAt),
        "Invalid schedule dates",
      );
    }
    return d;
  }
  resourcePermission(kind) {
    return ["product", "category"].includes(kind)
      ? "menu.manage"
      : kind === "override"
        ? "menu.branch"
        : ["floor", "hall"].includes(kind)
          ? "tables.manage"
          : kind === "printer"
            ? "printers.manage"
            : kind === "schedule"
              ? "staff.manage"
              : ["supplier", "purchase_item"].includes(kind)
                ? "finance.manage"
                : "settings.manage";
  }
  async journal(q, s, source, sourceId, lines, reverses = null) {
    balanced(lines);
    for (const l of lines)
      await one(q, "SELECT id FROM accounts WHERE id=$1", [id(l.account)]);
    const j = await one(
      q,
      "INSERT INTO journals(tenant_id,branch_id,source,source_id,actor_id,reverses) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [s.tenant_id, s.branch_id, source, sourceId, s.id, reverses],
    );
    for (const l of lines)
      await q(
        "INSERT INTO journal_lines(tenant_id,branch_id,journal_id,account_id,amount) VALUES($1,$2,$3,$4,$5)",
        [s.tenant_id, s.branch_id, j.id, l.account, l.amount],
      );
    return j;
  }
  async systemAccount(q, s, type) {
    let [a] = await q(
      "SELECT * FROM accounts WHERE branch_id=$1 AND type=$2 LIMIT 1",
      [s.branch_id, type],
    );
    if (!a) {
      const b = await one(q, "SELECT currency FROM branches WHERE id=$1", [
        s.branch_id,
      ]);
      a = await one(
        q,
        "INSERT INTO accounts(tenant_id,branch_id,name,type,currency) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [s.tenant_id, s.branch_id, type.toUpperCase(), type, b.currency],
      );
    }
    return a;
  }
  async financialAccount(q, s, accountId) {
    const a = await one(q, "SELECT * FROM accounts WHERE id=$1 AND active", [
      id(accountId),
    ]);
    assert(
      a.branch_id === s.branch_id &&
        ["cash", "bank", "wallet", "card"].includes(a.type),
      "Invalid receiving/paying account",
    );
    return a;
  }
  async eventJob(q, s, order, indicator = "NEW") {
    const branch = await one(q, "SELECT name FROM branches WHERE id=$1", [
      s.branch_id,
    ]);
    const [table] = await q(
      "SELECT t.name FROM sessions s JOIN tables t ON t.id=s.table_id WHERE s.id=$1",
      [order.session_id],
    );
    const items = await q("SELECT * FROM order_items WHERE order_id=$1", [
      order.id,
    ]);
    const grouped = new Map();
    for (const i of items) {
      const k = i.station_id || "unassigned";
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(i);
    }
    for (const [station, lines] of grouped) {
      const [stationDetails] = await q(
        "SELECT name FROM resources WHERE id=$1 AND kind='station'",
        [station],
      );
      const [printer] = await q(
        "SELECT name,data FROM resources WHERE kind='printer' AND active AND data->>'stationId'=$1 ORDER BY name LIMIT 1",
        [station],
      );
      await q(
        "INSERT INTO print_jobs(tenant_id,branch_id,destination,source_id,payload,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          s.tenant_id,
          s.branch_id,
          station,
          order.id,
          json({
            indicator,
            order,
            items: lines,
            branch: branch.name,
            table: table?.name || "Takeaway",
            station: stationDetails?.name || "Unassigned",
            printer: printer ? { name: printer.name, ...printer.data } : null,
          }),
          s.id || null,
        ],
      );
    }
  }
  async openSession(q, s, tableId, pin) {
    const t = await one(q, "SELECT * FROM tables WHERE id=$1 FOR UPDATE", [
      id(tableId),
    ]);
    assert(t.branch_id === s.branch_id, "Table belongs to another branch", 403);
    const [existing] = await q(
      "SELECT * FROM sessions WHERE table_id=$1 AND state='open'",
      [t.id],
    );
    if (existing) return existing;
    assert(!["reserved", "cleaning"].includes(t.state), "Table unavailable");
    const session = await one(
      q,
      "INSERT INTO sessions(tenant_id,branch_id,table_id,pin_hash) VALUES($1,$2,$3,$4) RETURNING *",
      [s.tenant_id, s.branch_id, t.id, pin ? digest(str(pin, 12)) : null],
    );
    await q("UPDATE tables SET state='occupied' WHERE id=$1", [t.id]);
    return session;
  }
  async createOrder(q, s, input, customer) {
    assert(
      !input.type || ["DINE_IN", "TAKEAWAY"].includes(input.type),
      "Invalid order type",
    );
    assert(
      Array.isArray(input.items) &&
        input.items.length > 0 &&
        input.items.length <= 100,
      "Choose 1–100 items",
    );
    let session;
    let type = "DINE_IN";
    if (customer) {
      session = await one(
        q,
        "SELECT * FROM sessions WHERE id=$1 AND state='open' FOR UPDATE",
        [customer.session_id],
      );
    } else if (input.sessionId) {
      session = await one(
        q,
        "SELECT * FROM sessions WHERE id=$1 AND state='open' FOR UPDATE",
        [id(input.sessionId)],
      );
      type = session.table_id ? "DINE_IN" : "TAKEAWAY";
    } else if (input.type === "TAKEAWAY") {
      type = "TAKEAWAY";
      session = await one(
        q,
        "INSERT INTO sessions(tenant_id,branch_id) VALUES($1,$2) RETURNING *",
        [s.tenant_id, s.branch_id],
      );
    } else session = await this.openSession(q, s, input.tableId);
    assert(session.branch_id === s.branch_id, "Session branch mismatch", 403);
    const alreadyBilled = (
      await q("SELECT 1 FROM bills WHERE session_id=$1", [session.id])
    ).length;
    assert(
      !alreadyBilled,
      "Session already billed; settle and start a new session",
      409,
    );
    const branch = await one(q, "SELECT * FROM branches WHERE id=$1", [
      s.branch_id,
    ]);
    const status = customer ? "NEW" : "CONFIRMED";
    const order = await one(
      q,
      "INSERT INTO orders(tenant_id,branch_id,session_id,customer_id,source,type,status,created_by,order_taker_user_id,order_taker_name_snapshot,order_taker_staff_id_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [
        s.tenant_id,
        s.branch_id,
        session.id,
        customer?.id || null,
        customer ? "CUSTOMER_QR" : "STAFF_MANUAL",
        type,
        status,
        s.id || null,
        customer ? null : s.id,
        customer ? null : s.name,
        customer ? null : s.staff_id,
      ],
    );
    if (session.table_id) {
      const table = await one(q, "SELECT waiter_id FROM tables WHERE id=$1", [
        session.table_id,
      ]);
      if (table.waiter_id) {
        await q("UPDATE orders SET assigned_waiter_user_id=$1 WHERE id=$2", [
          table.waiter_id,
          order.id,
        ]);
        order.assigned_waiter_user_id = table.waiter_id;
      }
    }
    for (const inputItem of input.items) {
      const p = await this.product(q, s, inputItem.productId);
      const snapshot = priceItem(p, inputItem);
      assert(snapshot.stationId, "Product has no branch preparation station");
      await this.resource(q, s, snapshot.stationId, "station");
      await q(
        "INSERT INTO order_items(tenant_id,branch_id,order_id,product_id,station_id,status,snapshot,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          s.tenant_id,
          s.branch_id,
          order.id,
          p.id,
          snapshot.stationId,
          status,
          json(snapshot),
          snapshot.total,
        ],
      );
    }
    await this.audit(q, s, "order.created", order.id, { source: order.source });
    if (status === "CONFIRMED")
      await this.eventJob(
        q,
        s,
        order,
        (
          await q("SELECT 1 FROM orders WHERE session_id=$1 AND id<>$2", [
            session.id,
            order.id,
          ])
        ).length
          ? "ADDITION"
          : "NEW",
      );
    return order;
  }
  async closeSettled(q, s, sessionId) {
    const outstanding = await q(
      "SELECT b.id FROM bills b WHERE session_id=$1 AND status<>'voided' AND total>COALESCE((SELECT sum(p.amount*p.direction) FROM payments p WHERE p.bill_id=b.id AND status='verified'),0)",
      [sessionId],
    );
    const unbilled = await q(
      "SELECT i.id FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.session_id=$1 AND i.status<>'CANCELLED' AND NOT EXISTS(SELECT 1 FROM bill_items bi WHERE bi.item_id=i.id)",
      [sessionId],
    );
    if (!outstanding.length && !unbilled.length) {
      await q(
        "UPDATE bills SET status='settled' WHERE session_id=$1 AND status<>'voided'",
        [sessionId],
      );
      const session = await one(
        q,
        "UPDATE sessions SET state='closed' WHERE id=$1 RETURNING *",
        [sessionId],
      );
      if (session.table_id)
        await q("UPDATE tables SET state='cleaning' WHERE id=$1", [
          session.table_id,
        ]);
    }
  }
  async staff(user, branch, method, path, body = {}, key) {
    const route = STAFF_ROUTES.find(([pattern]) => pattern.test(path));
    assert(route, "Endpoint not found", 404);
    assert(route[1].includes(method), "Method not allowed", 405);
    const page = Number(body.page || 1),
      limit = Number(body.limit || 200);
    int(page, 1, 100000);
    int(limit, 1, 500);
    const offset = (page - 1) * limit;
    const write = method !== "GET";
    const parts = path.split("/").filter(Boolean);
    const [area, a, b] = parts;
    return this.scoped(
      user,
      branch,
      async (q, s, tenant) => {
        if (area === "me" && !write) {
          const branches = await q("SELECT * FROM branches ORDER BY name");
          return {
            user,
            tenant,
            branches: branches.filter(
              (x) => user.role === "owner" || user.branches.includes(x.id),
            ),
          };
        }
        if (area === "logout") {
          await q(
            "UPDATE users SET token_version=token_version+1 WHERE id=$1",
            [s.id],
          );
          return { ok: true };
        }
        if (area === "password") {
          const [current] = await q("SELECT * FROM auth_lookup($1)", [s.email]);
          assert(
            await bcrypt.compare(
              String(body.oldPassword || ""),
              current.password_hash,
            ),
            "Current password is incorrect",
            403,
          );
          assert(
            String(body.newPassword || "").length >= 12,
            "New password needs 12+ characters",
          );
          await q(
            "UPDATE users SET password_hash=$1,token_version=token_version+1 WHERE id=$2",
            [await bcrypt.hash(body.newPassword, 12), s.id],
          );
          await this.audit(q, s, "password.changed", s.id);
          return { ok: true };
        }
        if (area === "access-options") {
          permitted(s, "staff.manage");
          assert(s.role === "owner", "Owner access required", 403);
          await q("SELECT set_config('app.branch','',true)");
          const stations = await q(
            "SELECT id,name,branch_id FROM resources WHERE kind='station' AND active ORDER BY name",
          );
          await q("SELECT set_config('app.branch',$1,true)", [
            s.branch_id || "",
          ]);
          return { roles: ROLES, permissions: PERMISSIONS, stations };
        }
        if (area === "branches") {
          permitted(s, "staff.manage");
          assert(s.role === "owner", "Only tenant owner manages branches", 403);
          if (!write) return q("SELECT * FROM branches");
          str(body.name);
          assert(
            /^[A-Z]{3}$/.test(body.currency || "PKR"),
            "Currency needs an uppercase ISO code",
          );
          try {
            new Intl.DateTimeFormat("en", { timeZone: body.timezone || "UTC" });
          } catch {
            assert(false, "Invalid timezone");
          }
          const row = await one(
            q,
            "INSERT INTO branches(tenant_id,name,currency,timezone,cutoff) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [
              s.tenant_id,
              body.name,
              str(body.currency || "PKR", 3),
              body.timezone || "UTC",
              int(body.cutoff || 0, 0, 23),
            ],
          );
          await this.audit(q, s, "branch.created", row.id);
          return row;
        }
        if (area === "settings") {
          if (!write)
            return one(q, "SELECT * FROM branches WHERE id=$1", [s.branch_id]);
          permitted(s, "settings.manage");
          const settings = {
            requirePin: !!body.requirePin,
            requireReference: body.requireReference !== false,
            verifyNonCash: body.verifyNonCash !== false,
            receiptFooter:
              typeof body.receiptFooter === "string"
                ? body.receiptFooter.slice(0, 300)
                : "",
          };
          const timezone = body.timezone || "UTC";
          try {
            new Intl.DateTimeFormat("en", { timeZone: timezone });
          } catch {
            assert(false, "Invalid timezone");
          }
          const row = await one(
            q,
            "UPDATE branches SET settings=$1,timezone=$2,cutoff=$3 WHERE id=$4 RETURNING *",
            [
              json(settings),
              timezone,
              int(body.cutoff || 0, 0, 23),
              s.branch_id,
            ],
          );
          await this.audit(q, s, "settings.changed", s.branch_id);
          return row;
        }
        if (area === "staff") {
          permitted(s, "staff.manage");
          assert(
            s.role === "owner",
            "Staff administration requires tenant owner",
            403,
          );
          if (!write)
            return q(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY staff_id`);
          const role = str(body.role);
          assert(ROLES[role], "Invalid role");
          const branches = body.branches || [];
          assert(
            Array.isArray(branches) && branches.length <= 100,
            "Invalid branch assignments",
          );
          assert(
            body.stationIds === undefined ||
              (Array.isArray(body.stationIds) && body.stationIds.length <= 200),
            "Invalid station assignments",
          );
          for (const v of branches)
            await one(q, "SELECT id FROM branches WHERE id=$1", [id(v)]);
          const permissions = body.permissions || ROLES[role];
          assert(
            Array.isArray(permissions) &&
              permissions.every((v) => PERMISSIONS.includes(v)),
            "Invalid permission",
          );
          await q("SELECT set_config('app.branch','',true)");
          for (const v of body.stationIds || []) {
            const station = await one(
              q,
              "SELECT id,branch_id FROM resources WHERE id=$1 AND kind='station'",
              [id(v)],
            );
            assert(
              branches.includes(station.branch_id),
              "Station must belong to an assigned branch",
            );
          }
          await q("SELECT set_config('app.branch',$1,true)", [
            s.branch_id || "",
          ]);
          const fields = [
            s.tenant_id,
            str(body.name),
            str(body.staffId),
            role,
            json(permissions),
            json(branches),
            json(body.stationIds || []),
          ];
          let row;
          if (a) {
            assert(a !== s.id, "Use another owner to edit your access");
            const existing = await one(
              q,
              "SELECT staff_id FROM users WHERE id=$1",
              [id(a)],
            );
            assert(
              existing.staff_id === body.staffId,
              "Staff ID is immutable after creation",
            );
            row = await one(
              q,
              `UPDATE users SET name=$2,staff_id=$3,role=$4,permissions=$5,branches=$6,station_ids=$7,active=$8,token_version=token_version+1 WHERE tenant_id=$1 AND id=$9 RETURNING ${PUBLIC_FIELDS}`,
              [...fields, body.active !== false, id(a)],
            );
          } else {
            assert(
              String(body.password || "").length >= 12,
              "Password needs at least 12 characters",
            );
            row = await one(
              q,
              `INSERT INTO users(tenant_id,name,staff_id,role,permissions,branches,station_ids,email,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${PUBLIC_FIELDS}`,
              [
                ...fields,
                str(body.email).toLowerCase(),
                await bcrypt.hash(body.password, 12),
              ],
            );
          }
          if (a && body.password) {
            assert(
              String(body.password).length >= 12,
              "Password needs 12+ characters",
            );
            await q("UPDATE users SET password_hash=$1 WHERE id=$2", [
              await bcrypt.hash(body.password, 12),
              row.id,
            ]);
          }
          await this.audit(q, s, "staff.changed", row.id);
          return row;
        }
        assert(s.branch_id, "Select a branch");
        if (area === "resources") {
          assert(KINDS.includes(a), "Unknown resource");
          if (!write) {
            if (["supplier", "purchase_item"].includes(a))
              permitted(s, "finance.manage");
            if (a === "schedule") permitted(s, "staff.manage");
            return q(
              "SELECT * FROM resources WHERE kind=$1 ORDER BY name,id LIMIT $2 OFFSET $3",
              [a, limit, offset],
            );
          }
          permitted(s, this.resourcePermission(a));
          if (TENANT_KINDS.includes(a))
            assert(
              s.role === "owner",
              "Tenant menu changes require owner; use branch overrides",
              403,
            );
          const data = await this.validateResource(q, s, a, body);
          let row;
          if (b) {
            const old = await this.resource(q, s, b, a);
            if (!old.branch_id)
              assert(
                s.role === "owner",
                "Tenant definition requires owner",
                403,
              );
            row = await one(
              q,
              "UPDATE resources SET name=$1,data=$2,active=$3 WHERE id=$4 RETURNING *",
              [body.name, json(data), body.active !== false, old.id],
            );
            await this.audit(q, s, "resource.updated", row.id, {
              before: old,
              after: row,
            });
          } else {
            if (a === "override")
              assert(
                !(
                  await q(
                    "SELECT id FROM resources WHERE kind='override' AND branch_id=$1 AND data->>'productId'=$2",
                    [s.branch_id, data.productId],
                  )
                ).length,
                "Branch override exists",
                409,
              );
            row = await one(
              q,
              "INSERT INTO resources(tenant_id,branch_id,kind,name,data) VALUES($1,$2,$3,$4,$5) RETURNING *",
              [
                s.tenant_id,
                TENANT_KINDS.includes(a) ? null : s.branch_id,
                a,
                body.name,
                json(data),
              ],
            );
            await this.audit(q, s, "resource.created", row.id);
          }
          return row;
        }
        if (area === "menu" && !write) {
          const products = await q(
            "SELECT id FROM resources WHERE kind='product' AND active ORDER BY COALESCE((data->>'displayOrder')::integer,0),name",
          );
          const result = [];
          for (const p of products) result.push(await this.product(q, s, p.id));
          return result;
        }
        if (area === "tables") {
          if (!write)
            return q(
              "SELECT t.*,s.id AS session_id FROM tables t LEFT JOIN sessions s ON s.table_id=t.id AND s.state='open' ORDER BY t.name",
            );
          permitted(s, "tables.manage");
          if (b === "qr") {
            const raw = token();
            await one(
              q,
              "UPDATE tables SET qr_hash=$1 WHERE id=$2 RETURNING id",
              [digest(raw), id(a)],
            );
            await this.audit(q, s, "table.qr_rotated", a);
            return { url: `${process.env.PUBLIC_WEB_URL}/?table=${raw}` };
          }
          if (b === "session") {
            const session = await this.openSession(q, s, a, body.pin);
            return { id: session.id };
          }
          if (body.hallId) await this.resource(q, s, body.hallId, "hall");
          if (body.waiterId) {
            const u = await one(
              q,
              "SELECT * FROM users WHERE id=$1 AND active",
              [id(body.waiterId)],
            );
            branchAllowed(u, s.branch_id);
          }
          const data = [
            str(body.name),
            int(body.capacity || 2, 1, 100),
            body.hallId || null,
            body.waiterId || null,
          ];
          let row;
          if (a) {
            assert(
              ["available", "reserved", "cleaning", "occupied"].includes(
                body.state,
              ),
              "Invalid table state",
            );
            const t = await one(q, "SELECT * FROM tables WHERE id=$1", [id(a)]);
            const open = (
              await q(
                "SELECT id FROM sessions WHERE table_id=$1 AND state='open'",
                [t.id],
              )
            ).length;
            assert(
              open ? body.state === "occupied" : body.state !== "occupied",
              "State conflicts with active session",
            );
            row = await one(
              q,
              "UPDATE tables SET name=$1,capacity=$2,hall_id=$3,waiter_id=$4,state=$5 WHERE id=$6 RETURNING *",
              [...data, body.state, t.id],
            );
          } else
            row = await one(
              q,
              "INSERT INTO tables(tenant_id,branch_id,name,capacity,hall_id,waiter_id,qr_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
              [s.tenant_id, s.branch_id, ...data, digest(token())],
            );
          delete row.qr_hash;
          await this.audit(q, s, "table.changed", row.id);
          return row;
        }
        if (area === "sessions" && b === "transfer") {
          permitted(s, "tables.manage");
          const session = await one(
            q,
            "SELECT * FROM sessions WHERE id=$1 AND state='open' FOR UPDATE",
            [id(a)],
          );
          const target = await one(
            q,
            "SELECT * FROM tables WHERE id=$1 AND state='available' FOR UPDATE",
            [id(body.tableId)],
          );
          assert(
            !(
              await q(
                "SELECT 1 FROM sessions WHERE table_id=$1 AND state='open'",
                [target.id],
              )
            ).length,
            "Target table occupied",
          );
          await q("UPDATE sessions SET table_id=$1 WHERE id=$2", [
            target.id,
            session.id,
          ]);
          if (session.table_id)
            await q("UPDATE tables SET state='cleaning' WHERE id=$1", [
              session.table_id,
            ]);
          await q("UPDATE tables SET state='occupied' WHERE id=$1", [
            target.id,
          ]);
          await this.audit(q, s, "session.transferred", session.id, {
            from: session.table_id,
            to: target.id,
          });
          return { ok: true };
        }
        if (area === "orders") {
          if (!write) {
            permitted(s, "orders.view");
            let rows = await q(
              "SELECT * FROM orders ORDER BY created_at DESC,id LIMIT $1 OFFSET $2",
              [limit, offset],
            );
            for (const order of rows) {
              order.items = await q(
                "SELECT * FROM order_items WHERE order_id=$1",
                [order.id],
              );
              if (["kitchen", "bar"].includes(s.role)) {
                order.items = order.items.filter((i) =>
                  s.station_ids.includes(i.station_id),
                );
              }
            }
            return rows.filter(
              (o) => !["kitchen", "bar"].includes(s.role) || o.items.length,
            );
          }
          if (!a) {
            permitted(s, "orders.take");
            return this.createOrder(q, s, body);
          }
          const order = await one(
            q,
            "SELECT * FROM orders WHERE id=$1 FOR UPDATE",
            [id(a)],
          );
          if (b === "confirm") {
            permitted(s, "orders.confirm");
            assert(order.status === "NEW", "Order already handled");
            await q(
              "UPDATE order_items SET status='CONFIRMED' WHERE order_id=$1",
              [order.id],
            );
            const updated = await one(
              q,
              "UPDATE orders SET status='CONFIRMED',confirmed_by=$1 WHERE id=$2 RETURNING *",
              [s.id, order.id],
            );
            await this.eventJob(q, s, updated);
            await this.audit(q, s, "order.confirmed", order.id);
            return updated;
          }
          if (b === "reassign") {
            permitted(s, "orders.reassign");
            const u = await one(
              q,
              "SELECT * FROM users WHERE id=$1 AND active",
              [id(body.userId)],
            );
            branchAllowed(u, s.branch_id);
            await q(
              "UPDATE orders SET order_taker_user_id=$1,order_taker_name_snapshot=$2,order_taker_staff_id_snapshot=$3 WHERE id=$4",
              [u.id, u.name, u.staff_id, order.id],
            );
            await this.audit(q, s, "order.taker_reassigned", order.id, {
              before: order.order_taker_user_id,
              after: u.id,
            });
            return { ok: true };
          }
          if (b === "cancel") {
            permitted(s, "orders.cancel");
            const reason = str(body.reason, 500);
            assert(
              !(
                await q(
                  "SELECT 1 FROM bill_items bi JOIN order_items i ON i.id=bi.item_id WHERE i.order_id=$1",
                  [order.id],
                )
              ).length,
              "Billed orders require a refund",
            );
            assert(order.status !== "CANCELLED", "Already cancelled");
            await q(
              "UPDATE order_items SET status='CANCELLED' WHERE order_id=$1",
              [order.id],
            );
            await q("UPDATE orders SET status='CANCELLED' WHERE id=$1", [
              order.id,
            ]);
            await this.audit(q, s, "order.cancelled", order.id, { reason });
            await this.eventJob(
              q,
              s,
              { ...order, status: "CANCELLED" },
              "CANCELLATION",
            );
            return { ok: true };
          }
          throw new Fault(404, "Unknown order action");
        }
        if (area === "items") {
          const item = await one(
            q,
            "SELECT * FROM order_items WHERE id=$1 FOR UPDATE",
            [id(a)],
          );
          const o = await one(
            q,
            "SELECT * FROM orders WHERE id=$1 FOR UPDATE",
            [item.order_id],
          );
          const to = str(body.status);
          if (["PREPARING", "READY"].includes(to)) {
            permitted(s, "kitchen.update");
            if (!["owner", "manager"].includes(s.role))
              assert(
                s.station_ids.includes(item.station_id),
                "Station access denied",
                403,
              );
          } else permitted(s, "orders.serve");
          transitionItem(item.status, to, o.type);
          await q("UPDATE order_items SET status=$1 WHERE id=$2", [
            to,
            item.id,
          ]);
          const states = await q(
            "SELECT status FROM order_items WHERE order_id=$1",
            [o.id],
          );
          const status = aggregate(states.map((x) => x.status));
          await q("UPDATE orders SET status=$1 WHERE id=$2", [status, o.id]);
          await this.audit(q, s, "item.transition", item.id, {
            from: item.status,
            to,
          });
          return { status };
        }
        if (area === "bills") {
          permitted(s, "bills.generate");
          if (!write && b === "history") {
            const bill = await one(q, "SELECT id FROM bills WHERE id=$1", [
              id(a),
            ]);
            const [count] = await q(
              "SELECT count(*) AS total FROM bill_history WHERE bill_id=$1",
              [bill.id],
            );
            const events = await q(
              "SELECT * FROM bill_history WHERE bill_id=$1 ORDER BY created_at,sequence LIMIT $2 OFFSET $3",
              [bill.id, limit, offset],
            );
            return {
              billId: bill.id,
              total: Number(count.total),
              page,
              limit,
              events,
            };
          }
          if (!write) {
            const bills = await q(
              "SELECT * FROM bills ORDER BY created_at DESC,id LIMIT $1 OFFSET $2",
              [limit, offset],
            );
            for (const bill of bills)
              bill.payments = await q(
                "SELECT p.*,u.name AS receiver_name,u.staff_id AS receiver_staff_id FROM payments p JOIN users u ON u.id=p.received_by WHERE bill_id=$1 ORDER BY created_at",
                [bill.id],
              );
            return bills;
          }
          if (b === "void") {
            permitted(s, "refunds.approve");
            const bill = await one(
              q,
              "SELECT * FROM bills WHERE id=$1 AND status='finalized' FOR UPDATE",
              [id(a)],
            );
            const reason = str(body.reason, 500);
            assert(
              !(
                await q(
                  "SELECT 1 FROM payments WHERE bill_id=$1 AND status<>'rejected'",
                  [bill.id],
                )
              ).length,
              "Paid or pending bills require payment adjustment before voiding",
            );
            const [original] = await q(
              "SELECT * FROM journals WHERE source='bill' AND source_id=$1",
              [bill.id],
            );
            if (original) {
              const lines = await q(
                "SELECT account_id,amount FROM journal_lines WHERE journal_id=$1",
                [original.id],
              );
              await this.journal(
                q,
                s,
                "bill_void",
                bill.id,
                lines.map((l) => ({
                  account: l.account_id,
                  amount: -Number(l.amount),
                })),
                original.id,
              );
            }
            await q("UPDATE bills SET status='voided' WHERE id=$1", [bill.id]);
            await q(
              "UPDATE order_items SET status='CANCELLED' WHERE id IN (SELECT item_id FROM bill_items WHERE bill_id=$1)",
              [bill.id],
            );
            const orders = await q("SELECT * FROM orders WHERE session_id=$1", [
              bill.session_id,
            ]);
            for (const o of orders) {
              await q("UPDATE orders SET status='CANCELLED' WHERE id=$1", [
                o.id,
              ]);
              await this.eventJob(
                q,
                s,
                { ...o, status: "CANCELLED" },
                "CANCELLATION",
              );
            }
            await this.audit(q, s, "bill.voided", bill.id, { reason });
            await this.closeSettled(q, s, bill.session_id);
            return { ok: true };
          }
          assert(!a, "Unknown bill action");
          const session = await one(
            q,
            "SELECT * FROM sessions WHERE id=$1 AND state='open' FOR UPDATE",
            [id(body.sessionId)],
          );
          const orders = await q("SELECT * FROM orders WHERE session_id=$1", [
            session.id,
          ]);
          assert(
            orders.length &&
              orders.every(
                (o) => !["NEW", "CONFIRMED", "PREPARING"].includes(o.status),
              ),
            "Confirm and prepare all orders before billing",
          );
          const items = await q(
            "SELECT i.* FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.session_id=$1 AND i.status<>'CANCELLED' AND NOT EXISTS(SELECT 1 FROM bill_items bi WHERE bi.item_id=i.id) ORDER BY i.id FOR UPDATE OF i",
            [session.id],
          );
          assert(items.length, "No unbilled items", 409);
          const discountRule = billDiscount(
            items.reduce((sum, i) => sum + Number(i.amount), 0),
            body,
          );
          const discount = discountRule.amount;
          if (discount) permitted(s, "discounts.apply");
          const rules = await q(
            "SELECT id,data,name FROM resources WHERE kind='charge' AND active AND branch_id=$1",
            [s.branch_id],
          );
          const waived = body.waivedChargeIds || [];
          assert(
            Array.isArray(waived) &&
              new Set(waived).size === waived.length &&
              waived.every((v) => rules.some((r) => r.id === v)),
            "Invalid charge waiver",
          );
          if (waived.length) {
            permitted(s, "discounts.apply");
            str(body.waiverReason, 500);
          }
          const breakdown = calculateBill(
            items.reduce((sum, i) => sum + Number(i.amount), 0),
            discount,
            rules
              .filter((r) => !waived.includes(r.id))
              .map((r) => ({ ...r.data, name: r.name })),
            orders[0].type,
          );
          const takers = [
            ...new Map(
              orders.map((o) => [
                o.order_taker_user_id || "qr",
                o.order_taker_user_id
                  ? {
                      name: o.order_taker_name_snapshot,
                      staffId: o.order_taker_staff_id_snapshot,
                    }
                  : { name: "Self-order (QR)", staffId: null },
              ]),
            ).values(),
          ];
          const branchDetails = await one(
            q,
            "SELECT * FROM branches WHERE id=$1",
            [s.branch_id],
          );
          const snapshot = {
            ...breakdown,
            items: items.map((i) => i.snapshot),
            takers,
            tableId: session.table_id,
            tableName: session.table_id
              ? (
                  await one(q, "SELECT name FROM tables WHERE id=$1", [
                    session.table_id,
                  ])
                ).name
              : "Takeaway",
            currency: branchDetails.currency,
            branch: branchDetails.name,
            footer: branchDetails.settings.receiptFooter || "",
            generator: { name: s.name, staffId: s.staff_id },
            discountApprover: discount ? s.id : null,
            discountRule: {
              ...discountRule,
              approvedBy: discount ? s.id : null,
            },
            waivedCharges: rules.filter((r) => waived.includes(r.id)),
            waiverReason: body.waiverReason || null,
            waiverApprover: waived.length ? s.id : null,
          };
          const bill = await one(
            q,
            "INSERT INTO bills(tenant_id,branch_id,session_id,snapshot,total,generated_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              s.tenant_id,
              s.branch_id,
              session.id,
              json(snapshot),
              breakdown.total,
              s.id,
            ],
          );
          for (const item of items)
            await q("INSERT INTO bill_items VALUES($1,$2,$3,$4)", [
              s.tenant_id,
              s.branch_id,
              bill.id,
              item.id,
            ]);
          if (bill.total > 0) {
            const receivable = await this.systemAccount(q, s, "receivable");
            const revenue = await this.systemAccount(q, s, "revenue");
            await this.journal(q, s, "bill", bill.id, [
              { account: receivable.id, amount: Number(bill.total) },
              { account: revenue.id, amount: -Number(bill.total) },
            ]);
          }
          await this.audit(q, s, "bill.finalized", bill.id, { discount });
          if (Number(bill.total) === 0)
            await this.closeSettled(q, s, session.id);
          return bill;
        }
        if (area === "branch-staff") {
          assert(
            ["shifts.manage", "tables.manage", "orders.reassign"].some((p) =>
              s.permissions.includes(p),
            ),
            "Permission denied",
            403,
          );
          return q(
            "SELECT id,name,staff_id,role FROM users WHERE active AND (role='owner' OR branches ? $1) ORDER BY name",
            [s.branch_id],
          );
        }
        if (area === "receiving-accounts") {
          permitted(s, "payments.receive");
          return q(
            "SELECT id,name,type,currency FROM accounts WHERE active AND type IN ('cash','bank','wallet','card') AND branch_id=$1",
            [s.branch_id],
          );
        }
        if (area === "accounts") {
          permitted(s, "finance.manage");
          if (!write)
            return q(
              "SELECT a.*,COALESCE((SELECT sum(l.amount) FROM journal_lines l WHERE l.account_id=a.id),0) AS balance FROM accounts a WHERE branch_id=$1 ORDER BY a.name",
              [s.branch_id],
            );
          assert(
            ["cash", "bank", "wallet", "card"].includes(body.type),
            "Invalid account type",
          );
          const branch = await one(q, "SELECT * FROM branches WHERE id=$1", [
            s.branch_id,
          ]);
          const account = await one(
            q,
            "INSERT INTO accounts(tenant_id,branch_id,name,type,currency,reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              s.tenant_id,
              s.branch_id,
              str(body.name),
              body.type,
              branch.currency,
              body.reference ? str(body.reference, 50) : null,
            ],
          );
          const opening = int(body.opening || 0);
          if (opening) {
            const equity = await this.systemAccount(q, s, "equity");
            await this.journal(q, s, "opening", account.id, [
              { account: account.id, amount: opening },
              { account: equity.id, amount: -opening },
            ]);
          }
          await this.audit(q, s, "account.created", account.id);
          return account;
        }
        if (area === "payments") {
          if (!write) {
            assert(
              ["reports.view", "payments.verify", "finance.manage"].some((p) =>
                s.permissions.includes(p),
              ),
              "Permission denied",
              403,
            );
            return q(
              "SELECT * FROM payments ORDER BY created_at DESC,id LIMIT $1 OFFSET $2",
              [limit, offset],
            );
          }
          if (b === "reject") {
            permitted(s, "payments.verify");
            const reason = str(body.reason, 500);
            const p = await one(
              q,
              "UPDATE payments SET status='rejected',note=$1 WHERE id=$2 AND status='pending' RETURNING *",
              [reason, id(a)],
            );
            await this.audit(q, s, "payment.rejected", p.id, { reason });
            return { ok: true };
          }
          if (b === "verify") {
            permitted(s, "payments.verify");
            const payment = await one(
              q,
              "SELECT * FROM payments WHERE id=$1 AND status='pending' FOR UPDATE",
              [id(a)],
            );
            await this.postPayment(q, s, payment);
            await q(
              "UPDATE payments SET status='verified',verified_by=$1,verified_at=now() WHERE id=$2",
              [s.id, payment.id],
            );
            if (payment.bill_id) {
              const bill = await one(q, "SELECT * FROM bills WHERE id=$1", [
                payment.bill_id,
              ]);
              await this.closeSettled(q, s, bill.session_id);
            }
            await this.audit(q, s, "payment.verified", payment.id);
            return { ok: true };
          }
          if (b === "refund") {
            permitted(s, "refunds.approve");
            const original = await one(
              q,
              "SELECT * FROM payments WHERE id=$1 AND status='verified' AND direction=1 AND bill_id IS NOT NULL FOR UPDATE",
              [id(a)],
            );
            const reason = str(body.reason, 500);
            const amount = int(body.amount, 1);
            const [{ sum }] = await q(
              "SELECT COALESCE(sum(amount),0) AS sum FROM payments WHERE refund_of=$1",
              [original.id],
            );
            assert(
              amount <= Number(original.amount) - Number(sum),
              "Refund exceeds original payment",
            );
            const account = await this.financialAccount(q, s, body.accountId);
            const shift = await this.paymentShift(q, s, account);
            const refund = await one(
              q,
              "INSERT INTO payments(tenant_id,branch_id,bill_id,account_id,shift_id,amount,direction,kind,note,received_by,verified_by,verified_at,status,refund_of) VALUES($1,$2,$3,$4,$5,$6,-1,'refund',$7,$8,$8,now(),'verified',$9) RETURNING *",
              [
                s.tenant_id,
                s.branch_id,
                original.bill_id,
                account.id,
                shift?.id || null,
                amount,
                reason,
                s.id,
                original.id,
              ],
            );
            // Reverse the sale via a revenue adjustment, not a new collection or silent bill edit.
            const revenue = await this.systemAccount(q, s, "revenue");
            await this.journal(q, s, "refund", refund.id, [
              { account: account.id, amount: -amount },
              { account: revenue.id, amount },
            ]);
            await this.audit(q, s, "payment.refunded", refund.id, {
              reason,
              original: original.id,
            });
            return refund;
          }
          permitted(s, "payments.receive");
          return this.receivePayment(q, s, body);
        }
        if (area === "documents") {
          permitted(s, "finance.manage");
          if (!write)
            return q(
              "SELECT d.*,COALESCE((SELECT sum(p.amount*p.direction) FROM payments p WHERE p.document_id=d.id AND p.status='verified'),0) AS paid,COALESCE((SELECT sum((a.data->>'amount')::bigint) FROM audit a WHERE a.action='purchase.return' AND a.target_id=d.id),0) AS returned FROM documents d ORDER BY d.created_at DESC,d.id LIMIT $1 OFFSET $2",
              [limit, offset],
            );
          if (b === "supplier-refund") {
            const doc = await one(
              q,
              "SELECT * FROM documents WHERE id=$1 AND kind='purchase' FOR UPDATE",
              [id(a)],
            );
            const amount = int(body.amount, 1);
            const reason = str(body.reason, 500);
            const [{ paid }] = await q(
              "SELECT COALESCE(sum(amount*direction),0) AS paid FROM payments WHERE document_id=$1 AND status='verified'",
              [doc.id],
            );
            const [{ returned }] = await q(
              "SELECT COALESCE(sum((data->>'amount')::bigint),0) AS returned FROM audit WHERE action='purchase.return' AND target_id=$1",
              [doc.id],
            );
            assert(
              amount <= Number(paid) - Number(doc.total) + Number(returned),
              "Refund exceeds supplier credit",
            );
            const account = await this.financialAccount(q, s, body.accountId);
            const shift = await this.paymentShift(q, s, account);
            const payment = await one(
              q,
              "INSERT INTO payments(tenant_id,branch_id,document_id,account_id,shift_id,amount,direction,kind,reference,note,received_by,status) VALUES($1,$2,$3,$4,$5,$6,-1,'supplier_refund',$7,$8,$9,'verified') RETURNING *",
              [
                s.tenant_id,
                s.branch_id,
                doc.id,
                account.id,
                shift?.id || null,
                amount,
                body.reference || null,
                reason,
                s.id,
              ],
            );
            const payable = await this.systemAccount(q, s, "payable");
            await this.journal(q, s, "supplier_refund", payment.id, [
              { account: account.id, amount },
              { account: payable.id, amount: -amount },
            ]);
            await this.audit(q, s, "supplier.refund", payment.id, { reason });
            return payment;
          }
          if (b === "return") {
            const doc = await one(
              q,
              "SELECT * FROM documents WHERE id=$1 AND kind='purchase' FOR UPDATE",
              [id(a)],
            );
            const amount = int(body.amount, 1);
            const [{ sum }] = await q(
              "SELECT COALESCE(sum((data->>'amount')::bigint),0) AS sum FROM audit WHERE action='purchase.return' AND target_id=$1",
              [doc.id],
            );
            const [{ paid }] = await q(
              "SELECT COALESCE(sum(amount),0) AS paid FROM payments WHERE document_id=$1",
              [doc.id],
            );
            assert(
              amount <= Number(doc.total) - Number(sum),
              "Return exceeds remaining purchase value",
            );
            const payable = await this.systemAccount(q, s, "payable");
            const expense = await this.systemAccount(q, s, "expense");
            await this.journal(q, s, "purchase_return", randomUUID(), [
              { account: payable.id, amount },
              { account: expense.id, amount: -amount },
            ]);
            await this.audit(q, s, "purchase.return", doc.id, {
              amount,
              reason: str(body.reason, 500),
            });
            return { ok: true };
          }
          assert(
            ["purchase", "expense"].includes(body.kind),
            "Invalid document kind",
          );
          let total;
          const data = {
            date: str(body.date, 30),
            note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
            payee: body.payee || "",
            category: body.category || "",
          };
          assert(!Number.isNaN(Date.parse(data.date)), "Invalid document date");
          if (body.attachmentId) {
            const m = await one(
              q,
              "SELECT id FROM media WHERE id=$1 AND NOT public",
              [id(body.attachmentId)],
            );
            data.attachmentId = m.id;
          }
          if (body.kind === "purchase") {
            await this.resource(q, s, body.supplierId, "supplier");
            assert(
              Array.isArray(body.lines) &&
                body.lines.length &&
                body.lines.length <= 100,
              "Purchase lines required",
            );
            data.lines = [];
            total = 0;
            for (const line of body.lines) {
              const item = await this.resource(
                q,
                s,
                line.itemId,
                "purchase_item",
              );
              const quantity = int(line.quantity, 1, 100000);
              const cost = int(line.cost);
              total += quantity * cost;
              data.lines.push({
                itemId: item.id,
                name: item.name,
                unit: item.data.unit || "unit",
                quantity,
                cost,
              });
            }
            const discount = int(body.discount || 0, 0, total);
            const tax = int(body.tax || 0);
            const charges = int(body.charges || 0);
            data.discount = discount;
            data.tax = tax;
            data.charges = charges;
            total = total - discount + tax + charges;
          } else total = int(body.amount, 1);
          int(total, 1);
          const doc = await one(
            q,
            "INSERT INTO documents(tenant_id,branch_id,kind,supplier_id,invoice,data,total,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              s.tenant_id,
              s.branch_id,
              body.kind,
              body.kind === "purchase" ? body.supplierId : null,
              body.invoice ? str(body.invoice) : null,
              json(data),
              total,
              s.id,
            ],
          );
          const expense = await this.systemAccount(q, s, "expense");
          const payable = await this.systemAccount(q, s, "payable");
          await this.journal(q, s, body.kind, doc.id, [
            { account: expense.id, amount: total },
            { account: payable.id, amount: -total },
          ]);
          await this.audit(q, s, "document.created", doc.id);
          return doc;
        }
        if (area === "cash") {
          permitted(s, "finance.manage");
          const amount = int(body.amount, 1);
          assert(
            [
              "owner_funding",
              "owner_withdrawal",
              "misc_receipt",
              "misc_expense",
            ].includes(body.kind),
            "Use source document payments for sales, suppliers and expenses",
          );
          const account = await this.financialAccount(q, s, body.accountId);
          const incoming = ["owner_funding", "misc_receipt"].includes(
            body.kind,
          );
          const counter = await this.systemAccount(
            q,
            s,
            body.kind.startsWith("owner_")
              ? "equity"
              : incoming
                ? "revenue"
                : "expense",
          );
          const movement = randomUUID();
          await this.journal(q, s, body.kind, movement, [
            { account: account.id, amount: incoming ? amount : -amount },
            { account: counter.id, amount: incoming ? -amount : amount },
          ]);
          await this.audit(q, s, "cash.movement", movement, {
            kind: body.kind,
            amount,
            reason: str(body.reason),
            note: typeof body.note === "string" ? body.note.slice(0, 500) : "",
          });
          return { id: movement };
        }
        if (area === "journals" && b === "reverse") {
          permitted(s, "finance.manage");
          const reason = str(body.reason, 500);
          const original = await one(
            q,
            "SELECT * FROM journals WHERE id=$1 FOR UPDATE",
            [id(a)],
          );
          assert(
            [
              "owner_funding",
              "owner_withdrawal",
              "misc_receipt",
              "misc_expense",
            ].includes(original.source),
            "Use source-document adjustment for this journal",
          );
          assert(
            !(
              await q("SELECT 1 FROM journals WHERE reverses=$1", [original.id])
            ).length,
            "Already reversed",
            409,
          );
          const lines = await q(
            "SELECT account_id,amount FROM journal_lines WHERE journal_id=$1",
            [original.id],
          );
          const reversal = await this.journal(
            q,
            s,
            "cash_reversal",
            randomUUID(),
            lines.map((l) => ({
              account: l.account_id,
              amount: -Number(l.amount),
            })),
            original.id,
          );
          await this.audit(q, s, "cash.reversed", reversal.id, { reason });
          return reversal;
        }
        if (area === "transfers") {
          permitted(s, "finance.transfer");
          const from = await this.financialAccount(q, s, body.fromId);
          const amount = int(body.amount, 1);
          assert(from.id !== body.toId, "Choose distinct accounts");
          const targetBranch = body.toBranchId || s.branch_id;
          branchAllowed(s, targetBranch);
          let to;
          if (targetBranch === s.branch_id)
            to = await this.financialAccount(q, s, body.toId);
          else {
            assert(
              s.role === "owner",
              "Cross-branch transfers require owner",
              403,
            );
            await q("SELECT set_config('app.branch','',true)");
            to = await one(
              q,
              "SELECT * FROM accounts WHERE id=$1 AND branch_id=$2 AND active",
              [id(body.toId), id(targetBranch)],
            );
            assert(
              ["cash", "bank", "wallet", "card"].includes(to.type),
              "Invalid target account",
            );
          }
          assert(from.currency === to.currency, "Currencies must match");
          const transfer = randomUUID();
          if (targetBranch === s.branch_id)
            await this.journal(q, s, "transfer", transfer, [
              { account: from.id, amount: -amount },
              { account: to.id, amount },
            ]);
          else {
            await q("SELECT set_config('app.branch',$1,true)", [s.branch_id]);
            const sourceClearing = await this.systemAccount(q, s, "clearing");
            await this.journal(q, s, "transfer_out", transfer, [
              { account: from.id, amount: -amount },
              { account: sourceClearing.id, amount },
            ]);
            const targetScope = { ...s, branch_id: targetBranch };
            await q("SELECT set_config('app.branch',$1,true)", [targetBranch]);
            const targetClearing = await this.systemAccount(
              q,
              targetScope,
              "clearing",
            );
            await this.journal(q, targetScope, "transfer_in", transfer, [
              { account: to.id, amount },
              { account: targetClearing.id, amount: -amount },
            ]);
            await this.audit(
              q,
              targetScope,
              "account.transfer_received",
              transfer,
              { from: from.id, to: to.id, amount },
            );
          }
          await q("SELECT set_config('app.branch',$1,true)", [s.branch_id]);
          await this.audit(q, s, "account.transfer", transfer, {
            from: from.id,
            to: to.id,
            amount,
          });
          return { id: transfer };
        }
        if (area === "shifts") {
          permitted(s, "shifts.manage");
          if (!write)
            return q("SELECT * FROM shifts ORDER BY opened_at DESC LIMIT 100");
          if (b === "handover") {
            const shift = await one(
              q,
              "SELECT * FROM shifts WHERE id=$1 AND closed_at IS NULL FOR UPDATE",
              [id(a)],
            );
            assert(
              ["owner", "manager"].includes(s.role) || shift.user_id === s.id,
              "Shift access denied",
              403,
            );
            const next = await one(
              q,
              "SELECT * FROM users WHERE id=$1 AND active",
              [id(body.userId)],
            );
            branchAllowed(next, s.branch_id);
            permitted(next, "payments.receive");
            await q("UPDATE shifts SET user_id=$1 WHERE id=$2", [
              next.id,
              shift.id,
            ]);
            await this.audit(q, s, "shift.handover", shift.id, {
              from: shift.user_id,
              to: next.id,
            });
            return { ok: true };
          }
          if (b === "close") {
            const shift = await one(
              q,
              "SELECT * FROM shifts WHERE id=$1 AND closed_at IS NULL FOR UPDATE",
              [id(a)],
            );
            assert(
              s.role === "owner" ||
                s.role === "manager" ||
                shift.user_id === s.id,
              "Shift access denied",
              403,
            );
            const [{ balance }] = await q(
              "SELECT COALESCE(sum(amount),0) AS balance FROM journal_lines WHERE account_id=$1",
              [shift.account_id],
            );
            const expected = Number(balance);
            const actual = int(body.actual);
            await q(
              "UPDATE shifts SET closed_at=now(),actual=$1,expected=$2,variance=$1::bigint-$2::bigint,note=$3 WHERE id=$4",
              [actual, expected, body.note || null, shift.id],
            );
            await this.audit(q, s, "shift.closed", shift.id, {
              expected,
              actual,
              variance: actual - expected,
            });
            return { expected, actual, variance: actual - expected };
          }
          if (b === "review") {
            permitted(s, "finance.manage");
            const shift = await one(
              q,
              "UPDATE shifts SET reviewed_by=$1 WHERE id=$2 AND closed_at IS NOT NULL RETURNING *",
              [s.id, id(a)],
            );
            await this.audit(q, s, "shift.reviewed", shift.id);
            return shift;
          }
          const account = await this.financialAccount(q, s, body.accountId);
          assert(account.type === "cash", "Shift requires cash drawer");
          const [{ balance }] = await q(
            "SELECT COALESCE(sum(amount),0) AS balance FROM journal_lines WHERE account_id=$1",
            [account.id],
          );
          const opening = int(body.opening);
          assert(
            opening === Number(balance),
            "Opening count differs from ledger; record an explicit cash adjustment first",
          );
          const shift = await one(
            q,
            "INSERT INTO shifts(tenant_id,branch_id,account_id,user_id,opening) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [s.tenant_id, s.branch_id, account.id, s.id, opening],
          );
          await this.audit(q, s, "shift.opened", shift.id);
          return shift;
        }
        if (area === "requests") {
          permitted(s, "requests.manage");
          if (!write)
            return q(
              "SELECT * FROM resources WHERE kind='request' ORDER BY created_at DESC LIMIT 200",
            );
          const r = await one(
            q,
            "UPDATE resources SET active=false WHERE id=$1 AND kind='request' RETURNING *",
            [id(a)],
          );
          await this.audit(q, s, "request.resolved", r.id);
          return r;
        }
        if (area === "print-jobs") {
          permitted(s, "orders.view");
          if (!write) {
            let jobs = await q(
              "SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 100",
            );
            if (["kitchen", "bar"].includes(s.role))
              jobs = jobs.filter((j) => s.station_ids.includes(j.destination));
            return jobs.filter(
              (j) =>
                j.destination !== "bill" ||
                s.permissions.includes("bills.generate"),
            );
          }
          if (!a) {
            permitted(s, "bills.generate");
            const bill = await one(q, "SELECT * FROM bills WHERE id=$1", [
              id(body.billId),
            ]);
            const payments = await q(
              "SELECT p.*,u.name AS receiver_name,u.staff_id AS receiver_staff_id FROM payments p JOIN users u ON u.id=p.received_by WHERE bill_id=$1",
              [bill.id],
            );
            return one(
              q,
              "INSERT INTO print_jobs(tenant_id,branch_id,destination,source_id,payload,created_by) VALUES($1,$2,'bill',$3,$4,$5) RETURNING *",
              [
                s.tenant_id,
                s.branch_id,
                bill.id,
                json({
                  bill,
                  payments,
                  indicator: "ORIGINAL",
                  printer:
                    (
                      await q(
                        "SELECT data FROM resources WHERE kind='printer' AND active AND data->>'destination'='bill' ORDER BY name LIMIT 1",
                      )
                    )[0]?.data || null,
                }),
                s.id,
              ],
            );
          }
          const job = await one(
            q,
            "SELECT * FROM print_jobs WHERE id=$1 FOR UPDATE",
            [id(a)],
          );
          if (job.destination === "bill") permitted(s, "bills.generate");
          else if (["kitchen", "bar"].includes(s.role))
            assert(
              s.station_ids.includes(job.destination),
              "Station access denied",
              403,
            );
          if (b === "reprint") {
            str(body.reason, 500);
            const copy = await one(
              q,
              "INSERT INTO print_jobs(tenant_id,branch_id,destination,source_id,payload,created_by,reprint_of) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
              [
                s.tenant_id,
                s.branch_id,
                job.destination,
                job.source_id,
                json({ ...job.payload, indicator: "REPRINT" }),
                s.id,
                job.id,
              ],
            );
            await this.audit(q, s, "print.reprint", copy.id, {
              reason: body.reason,
              reprintedBy: s.id,
            });
            return copy;
          }
          assert(
            ["dispatched", "failed"].includes(body.state),
            "Dispatch outcome required",
          );
          assert(
            job.state === "queued" ||
              job.state === "failed" ||
              (job.state === "dispatched" && body.state === "failed"),
            "Dispatched job requires explicit reprint",
            409,
          );
          await q(
            "UPDATE print_jobs SET state=$1,attempts=attempts+1,error=$2 WHERE id=$3",
            [
              body.state,
              typeof body.error === "string" ? body.error.slice(0, 300) : null,
              job.id,
            ],
          );
          await this.audit(q, s, "print.dispatch", job.id, {
            state: body.state,
          });
          return { ok: true };
        }
        if (area === "reports") {
          permitted(s, "reports.view");
          const branch = await one(q, "SELECT * FROM branches WHERE id=$1", [
            s.branch_id,
          ]);
          const bills = await q(
            "SELECT * FROM bills ORDER BY created_at DESC LIMIT 5000",
          );
          const payments = await q(
            "SELECT * FROM payments ORDER BY created_at DESC LIMIT 5000",
          );
          const docs = await q(
            "SELECT * FROM documents ORDER BY created_at DESC LIMIT 5000",
          );
          const orders = await q(
            "SELECT * FROM orders ORDER BY created_at DESC LIMIT 5000",
          );
          const date = body.date;
          const onDay = (r) =>
            !date ||
            businessDate(
              new Date(r.created_at),
              branch.timezone,
              branch.cutoff,
            ) === date;
          const sales = bills
            .filter((r) => onDay(r) && r.status !== "voided")
            .reduce((sum, r) => sum + Number(r.total), 0);
          const collections = payments
            .filter(
              (r) =>
                onDay(r) &&
                r.bill_id &&
                r.status === "verified" &&
                r.direction === 1,
            )
            .reduce((sum, r) => sum + Number(r.amount), 0);
          const refunds = payments
            .filter((r) => onDay(r) && r.bill_id && r.direction === -1)
            .reduce((sum, r) => sum + Number(r.amount), 0);
          const topItems = await q(
            "SELECT i.snapshot->>'name' AS name,sum((i.snapshot->>'quantity')::int) AS quantity,sum(i.amount) AS total FROM order_items i JOIN bill_items bi ON bi.item_id=i.id GROUP BY i.snapshot->>'name' ORDER BY total DESC LIMIT 20",
          );
          return {
            sales,
            collections,
            refunds,
            netSales: sales - refunds,
            purchases: docs
              .filter((r) => r.kind === "purchase" && onDay(r))
              .reduce((n, r) => n + Number(r.total), 0),
            expenses: docs
              .filter((r) => r.kind === "expense" && onDay(r))
              .reduce((n, r) => n + Number(r.total), 0),
            basis:
              "Sales at finalized billing; collections at verified payment. Purchases expensed when recognized; no inventory valuation or complete profit calculation.",
            timezone: branch.timezone,
            cutoff: branch.cutoff,
            bills: bills.filter(onDay),
            payments: payments.filter(onDay),
            orders: orders.filter(onDay),
            topItems,
            accounts: await q(
              "SELECT a.*,COALESCE((SELECT sum(l.amount) FROM journal_lines l WHERE l.account_id=a.id),0) AS balance FROM accounts a",
            ),
            journals: await q(
              "SELECT * FROM journals ORDER BY created_at DESC LIMIT 300",
            ),
            shifts: await q(
              "SELECT * FROM shifts ORDER BY opened_at DESC LIMIT 100",
            ),
          };
        }
        if (area === "events") {
          permitted(s, "orders.view");
          return q("SELECT * FROM events ORDER BY created_at DESC LIMIT 100");
        }
        if (area === "audit") {
          permitted(s, "reports.view");
          return q("SELECT * FROM audit ORDER BY created_at DESC LIMIT 300");
        }
        throw new Fault(404, "Endpoint not found");
      },
      { write, key, body, path },
    );
  }
  async paymentShift(q, s, account) {
    if (account.type !== "cash") return null;
    const shift = await one(
      q,
      "SELECT * FROM shifts WHERE account_id=$1 AND closed_at IS NULL FOR UPDATE",
      [account.id],
    );
    assert(
      shift.user_id === s.id,
      "Cash drawer belongs to another cashier",
      403,
    );
    return shift;
  }
  async receivePayment(q, s, body) {
    const bill = body.billId
      ? await one(q, "SELECT * FROM bills WHERE id=$1 FOR UPDATE", [
          id(body.billId),
        ])
      : null;
    const doc = body.documentId
      ? await one(q, "SELECT * FROM documents WHERE id=$1 FOR UPDATE", [
          id(body.documentId),
        ])
      : null;
    assert(!!bill !== !!doc, "Choose one bill or document");
    if (doc) permitted(s, "finance.manage");
    if (bill) assert(bill.status !== "voided", "Bill has been voided");
    const amount = int(body.amount, 1);
    const [sum] = await q(
      `SELECT COALESCE(sum(amount*direction),0) AS paid FROM payments WHERE ${bill ? "bill_id" : "document_id"}=$1 AND status<>'rejected' ${bill ? "AND direction=1" : ""}`,
      [(bill || doc).id],
    );
    let returned = 0;
    if (doc) {
      const [r] = await q(
        "SELECT COALESCE(sum((data->>'amount')::bigint),0) AS value FROM audit WHERE action='purchase.return' AND target_id=$1",
        [doc.id],
      );
      returned = Number(r.value);
    }
    assert(
      amount <= Number((bill || doc).total) - returned - Number(sum.paid),
      "Payment exceeds outstanding balance",
      409,
    );
    const account = await this.financialAccount(q, s, body.accountId);
    const branch = await one(q, "SELECT settings FROM branches WHERE id=$1", [
      s.branch_id,
    ]);
    if (account.type !== "cash" && branch.settings.requireReference !== false)
      str(body.reference);
    const shift = await this.paymentShift(q, s, account);
    const pending =
      account.type !== "cash" && branch.settings.verifyNonCash !== false;
    const tendered =
      body.tendered === undefined ? null : int(body.tendered, amount);
    if (account.type !== "cash")
      assert(tendered === null, "Tender/change applies only to cash");
    const paidAt = body.paidAt || new Date().toISOString();
    assert(!Number.isNaN(Date.parse(paidAt)), "Invalid payment date");
    const payment = await one(
      q,
      "INSERT INTO payments(tenant_id,branch_id,bill_id,document_id,account_id,shift_id,amount,direction,kind,reference,note,tendered,received_by,status,paid_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
      [
        s.tenant_id,
        s.branch_id,
        bill?.id || null,
        doc?.id || null,
        account.id,
        shift?.id || null,
        amount,
        bill ? "sale" : "supplier_expense",
        body.reference || null,
        body.note || null,
        tendered,
        s.id,
        pending ? "pending" : "verified",
        paidAt,
      ],
    );
    if (!pending) {
      await this.postPayment(q, s, payment);
      if (bill) await this.closeSettled(q, s, bill.session_id);
    }
    await this.audit(q, s, "payment.recorded", payment.id, {
      status: payment.status,
    });
    return payment;
  }
  async postPayment(q, s, p) {
    const counter = await this.systemAccount(
      q,
      s,
      p.bill_id ? "receivable" : "payable",
    );
    const direction = p.bill_id ? 1 : -1;
    await this.journal(q, s, "payment", p.id, [
      { account: p.account_id, amount: direction * Number(p.amount) },
      { account: counter.id, amount: -direction * Number(p.amount) },
    ]);
  }
  async publicScope(raw, isCustomer = false) {
    assert(
      typeof raw === "string" && raw.length >= 30 && raw.length <= 100,
      "Invalid public token",
      401,
    );
    const [r] = await db.query(
      isCustomer
        ? "SELECT * FROM customer_lookup($1)"
        : "SELECT * FROM qr_lookup($1)",
      [digest(raw)],
    );
    assert(r, "Invalid or expired QR/customer session", 404);
    return r;
  }
  async public(raw, method, path, body, key) {
    const isCustomer = !["menu", "join"].includes(path);
    const reference = await this.publicScope(raw, isCustomer);
    const s = {
      tenant_id: reference.tenant_id,
      branch_id: reference.branch_id,
    };
    const result = await transaction(s, async (q) => {
      const t = await one(q, "SELECT * FROM tenants WHERE id=$1", [
        s.tenant_id,
      ]);
      assert(
        process.env.SUBSCRIPTION_ENFORCED === "false" ||
          ["trial", "active"].includes(t.state),
        "Restaurant unavailable",
        403,
      );
      const branch = await one(q, "SELECT * FROM branches WHERE id=$1", [
        s.branch_id,
      ]);
      if (method === "GET" && path === "menu") {
        const table = await one(
          q,
          "SELECT name,state FROM tables WHERE id=$1",
          [reference.table_id],
        );
        const list = await q(
          "SELECT id FROM resources WHERE kind='product' AND active ORDER BY name",
        );
        const products = [];
        for (const r of list) {
          const p = await this.product(q, s, r.id);
          products.push({
            id: p.id,
            name: p.name,
            data: {
              price: p.data.price,
              categoryId: p.data.categoryId,
              description: p.data.description,
              variants: p.data.variants,
              modifierGroups: p.data.modifierGroups,
              available: p.data.available !== false && !p.data.soldOut,
              imageId: p.data.imageId,
            },
          });
        }
        return {
          branch: {
            name: branch.name,
            currency: branch.currency,
            requirePin: !!branch.settings.requirePin,
          },
          table,
          products,
          categories: await q(
            "SELECT id,name FROM resources WHERE kind='category' AND active ORDER BY name",
          ),
        };
      }
      if (method === "GET" && path === "orders") {
        const orders = await q(
          "SELECT id,number,status,type,created_at FROM orders WHERE customer_id=$1 ORDER BY created_at",
          [reference.id],
        );
        for (const o of orders)
          o.items = await q(
            "SELECT id,status,snapshot FROM order_items WHERE order_id=$1",
            [o.id],
          );
        return orders;
      }
      assert(method === "POST", "Method not allowed", 405);
      str(key, 128);
      await q("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${s.tenant_id}:write`,
      ]);
      const actor = `customer:${isCustomer ? reference.id : reference.table_id}`;
      const hash = digest(json({ path, body }));
      const [cached] = await q(
        "SELECT * FROM idempotency WHERE actor=$1 AND key=$2",
        [actor, key],
      );
      if (cached) {
        assert(cached.hash === hash, "Idempotency key input mismatch", 409);
        return cached.response;
      }
      let response;
      if (path === "join") {
        const table = await one(
          q,
          "SELECT * FROM tables WHERE id=$1 FOR UPDATE",
          [reference.table_id],
        );
        assert(
          table.state !== "reserved" && table.state !== "cleaning",
          "Table unavailable",
        );
        let session = (
          await q("SELECT * FROM sessions WHERE table_id=$1 AND state='open'", [
            table.id,
          ])
        )[0];
        if (branch.settings.requirePin) {
          assert(
            session?.pin_hash &&
              typeof body.pin === "string" &&
              digest(body.pin) === session.pin_hash,
            "Ask staff for the current session PIN",
            403,
          );
        } else session = session || (await this.openSession(q, s, table.id));
        const rawToken = token();
        const c = await one(
          q,
          "INSERT INTO customers(tenant_id,branch_id,session_id,token_hash) VALUES($1,$2,$3,$4) RETURNING id",
          [s.tenant_id, s.branch_id, session.id, digest(rawToken)],
        );
        response = { token: rawToken, customerId: c.id };
      } else if (path === "orders") {
        response = await this.createOrder(q, s, body, reference);
      } else if (path === "request") {
        assert(["waiter", "bill"].includes(body.type), "Invalid request");
        await one(q, "SELECT id FROM sessions WHERE id=$1 AND state='open'", [
          reference.session_id,
        ]);
        response = await one(
          q,
          "INSERT INTO resources(tenant_id,branch_id,kind,name,data) VALUES($1,$2,'request',$3,$4) RETURNING id",
          [
            s.tenant_id,
            s.branch_id,
            body.type,
            json({ sessionId: reference.session_id, customerId: reference.id }),
          ],
        );
      } else throw new Fault(404, "Public endpoint not found");
      await q(
        "INSERT INTO idempotency(tenant_id,branch_id,actor,key,hash,response) VALUES($1,$2,$3,$4,$5,$6)",
        [s.tenant_id, s.branch_id, actor, key, hash, json(response)],
      );
      await q("INSERT INTO events(tenant_id,branch_id,type) VALUES($1,$2,$3)", [
        s.tenant_id,
        s.branch_id,
        `public.${path}`,
      ]);
      return response;
    });
    if (method === "POST")
      Promise.resolve(this.emit(s.tenant_id, s.branch_id)).catch(() => {});
    return result;
  }
}
