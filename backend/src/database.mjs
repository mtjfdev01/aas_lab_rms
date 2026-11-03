import "./env.mjs";
import "reflect-metadata";
import { DataSource } from "typeorm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export class InitialSchema1770000000000 {
  name = "InitialSchema1770000000000";
  async up(q) {
    await q.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    const tables = [
      "branches",
      "users",
      "resources",
      "tables",
      "sessions",
      "customers",
      "orders",
      "order_items",
      "bills",
      "bill_items",
      "accounts",
      "journals",
      "journal_lines",
      "shifts",
      "documents",
      "payments",
      "audit",
      "events",
      "print_jobs",
      "media",
      "idempotency",
    ];
    for (const table of tables) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_boundary ON ${table} FOR ALL TO rms_app USING (tenant_id=tenant_scope() ${["branches", "users"].includes(table) ? "" : "AND (branch_scope() IS NULL OR branch_id=branch_scope()" + (["resources", "audit", "media"].includes(table) ? " OR branch_id IS NULL" : "") + ")"}) WITH CHECK (tenant_id=tenant_scope() ${["branches", "users"].includes(table) ? "" : "AND (branch_scope() IS NULL OR branch_id=branch_scope()" + (["resources", "audit", "media"].includes(table) ? " OR branch_id IS NULL" : "") + ")"})`,
      );
    }
    await q.query("ALTER TABLE tenants ENABLE ROW LEVEL SECURITY");
    await q.query(
      "CREATE POLICY tenant_boundary ON tenants FOR ALL TO rms_app USING (id=tenant_scope()) WITH CHECK (id=tenant_scope())",
    );
    await q.query("GRANT USAGE ON SCHEMA public TO rms_app");
    await q.query(
      "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO rms_app",
    );
    await q.query("REVOKE INSERT, UPDATE ON tenants FROM rms_app");
    await q.query(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rms_app",
    );
    await q.query(
      "GRANT EXECUTE ON FUNCTION auth_lookup(text),qr_lookup(text),customer_lookup(text) TO rms_app",
    );
  }
  async down() {
    throw new Error(
      "Destructive rollback intentionally disabled. Restore a backup.",
    );
  }
}
export class Hardening1770000000001 {
  name = "Hardening1770000000001";
  async up(q) {
    await q.query(
      await readFile(new URL("./hardening.sql", import.meta.url), "utf8"),
    );
  }
  async down() {
    throw new Error(
      "Restore a backup rather than rolling back financial schema",
    );
  }
}
export class Adjustments1770000000002 {
  name = "Adjustments1770000000002";
  async up(q) {
    await q.query(
      await readFile(new URL("./adjustments.sql", import.meta.url), "utf8"),
    );
  }
  async down() {
    throw new Error("Restore a backup");
  }
}
export class ConfigurationConstraints1770000000003 {
  name = "ConfigurationConstraints1770000000003";
  async up(q) {
    await q.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS unique_branch_override ON resources(tenant_id,branch_id,(data->>'productId')) WHERE kind='override'",
    );
  }
  async down() {
    throw new Error("Restore a backup");
  }
}
export class LedgerHardening1770000000004 {
  name = "LedgerHardening1770000000004";
  async up(q) {
    await q.query(
      await readFile(
        new URL("./ledger-hardening.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  async down() {
    throw new Error("Restore a backup");
  }
}
export class BillHistory1770000000005 {
  name = "BillHistory1770000000005";
  async up(q) {
    await q.query(
      await readFile(new URL("./bill-history.sql", import.meta.url), "utf8"),
    );
  }
  async down() {
    throw new Error("Bill history must be retained; restore a backup");
  }
}
export const makeDatabase = (url = process.env.DATABASE_URL) =>
  new DataSource({
    type: "postgres",
    url,
    synchronize: false,
    migrations: [
      InitialSchema1770000000000,
      Hardening1770000000001,
      Adjustments1770000000002,
      ConfigurationConstraints1770000000003,
      LedgerHardening1770000000004,
      BillHistory1770000000005,
    ],
    logging: false,
  });
export const db = makeDatabase();
export async function transaction(scope, fn) {
  return db.transaction(async (em) => {
    await em.query(
      "SELECT set_config('app.tenant',$1,true),set_config('app.branch',$2,true),set_config('app.actor',$3,true)",
      [scope.tenant_id, scope.branch_id || "", scope.id || ""],
    );
    return fn(async (sql, args = []) => {
      const result = await em.query(sql, args);
      return Array.isArray(result) &&
        Array.isArray(result[0]) &&
        typeof result[1] === "number"
        ? result[0]
        : result;
    });
  });
}
if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[2] === "migrate"
) {
  const source = makeDatabase(process.env.MIGRATION_DATABASE_URL);
  await source.initialize();
  await source.runMigrations({ transaction: "all" });
  await source.destroy();
  console.log("Migrations applied");
}
