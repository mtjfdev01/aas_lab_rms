import "../src/env.mjs";
if (
  !process.env.DATABASE_URL ||
  !process.env.MIGRATION_DATABASE_URL ||
  !process.env.DEMO_PASSWORD
)
  throw new Error(
    "Integration tests require local migrated/seeded PostgreSQL and DEMO_PASSWORD. Never run against production.",
  );
if (process.env.NODE_ENV === "production")
  throw new Error("Integration tests are disabled in production");
