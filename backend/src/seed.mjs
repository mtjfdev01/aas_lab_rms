import "./env.mjs";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { makeDatabase, db } from "./database.mjs";
import { ROLES, digest } from "./domain.mjs";
import { Operations } from "./service.mjs";
const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12)
  throw new Error(
    "Set DEMO_PASSWORD to a development-only password of at least 12 characters",
  );
if (process.env.NODE_ENV === "production")
  throw new Error("Demo seed is disabled in production");
const owner = makeDatabase(process.env.MIGRATION_DATABASE_URL);
await owner.initialize();
const ids = {
  tenants: [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
  ],
  branches: [
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000003",
  ],
};
const hash = await bcrypt.hash(password, 12);
await owner.transaction(async (em) => {
  const q = (sql, args = []) => em.query(sql, args);
  for (let t = 0; t < 2; t++) {
    const tenant = ids.tenants[t];
    await q(
      "INSERT INTO tenants(id,name,state) VALUES($1,$2,'active') ON CONFLICT(id) DO NOTHING",
      [tenant, t ? "Second Restaurant" : "AAS Demo Restaurant"],
    );
    const branches = t ? [ids.branches[2]] : ids.branches.slice(0, 2);
    for (const [index, branch] of branches.entries()) {
      await q(
        "INSERT INTO branches(id,tenant_id,name,settings) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
        [
          branch,
          tenant,
          t ? "Other tenant branch" : index ? "North Branch" : "Central Branch",
          JSON.stringify({
            requirePin: false,
            requireReference: true,
            verifyNonCash: true,
            receiptFooter: "Thank you for dining with us.",
          }),
        ],
      );
    }
    for (const [index, role] of Object.keys(ROLES).entries()) {
      const email = `${role}${t ? "2" : ""}@demo.test`;
      await q(
        "INSERT INTO users(tenant_id,email,name,staff_id,password_hash,role,permissions,branches) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(email) DO NOTHING",
        [
          tenant,
          email,
          `${t ? "Second " : "Demo "}${role}`,
          `EMP-${String(index + 1).padStart(3, "0")}`,
          hash,
          role,
          JSON.stringify(ROLES[role]),
          JSON.stringify(role === "manager" ? branches.slice(0, 1) : branches),
        ],
      );
    }
    let [category] = await q(
      "SELECT * FROM resources WHERE tenant_id=$1 AND kind='category' LIMIT 1",
      [tenant],
    );
    if (!category)
      [category] = await q(
        "INSERT INTO resources(tenant_id,kind,name) VALUES($1,'category','House favourites') RETURNING *",
        [tenant],
      );
    let products = await q(
      "SELECT * FROM resources WHERE tenant_id=$1 AND kind='product'",
      [tenant],
    );
    if (!products.length) {
      for (const [name, price] of [
        ["Chicken Karahi", 120000],
        ["Fresh Lime", 18000],
        ["Garlic Naan", 12000],
      ]) {
        const [p] = await q(
          "INSERT INTO resources(tenant_id,kind,name,data) VALUES($1,'product',$2,$3) RETURNING *",
          [
            tenant,
            name,
            JSON.stringify({
              price,
              categoryId: category.id,
              available: true,
              description:
                name === "Chicken Karahi"
                  ? "House spices, fresh ginger and tomatoes"
                  : "Freshly prepared to order",
              variants:
                name === "Fresh Lime"
                  ? [
                      { id: "regular", name: "Regular", price },
                      { id: "large", name: "Large", price: 25000 },
                    ]
                  : [],
              modifierGroups:
                name === "Chicken Karahi"
                  ? [
                      {
                        name: "Spice level",
                        min: 1,
                        max: 1,
                        options: [
                          { id: "mild", name: "Mild", price: 0 },
                          { id: "hot", name: "Hot", price: 0 },
                        ],
                      },
                    ]
                  : [],
            }),
          ],
        );
        products.push(p);
      }
    }
    for (const branch of branches) {
      let stations = await q(
        "SELECT * FROM resources WHERE tenant_id=$1 AND branch_id=$2 AND kind='station' ORDER BY name",
        [tenant, branch],
      );
      if (!stations.length) {
        for (const name of ["Kitchen", "Bar"]) {
          const [station] = await q(
            "INSERT INTO resources(tenant_id,branch_id,kind,name) VALUES($1,$2,'station',$3) RETURNING *",
            [tenant, branch, name],
          );
          stations.push(station);
        }
      }
      for (const p of products) {
        if (
          !(
            await q(
              "SELECT id FROM resources WHERE tenant_id=$1 AND branch_id=$2 AND kind='override' AND data->>'productId'=$3",
              [tenant, branch, p.id],
            )
          ).length
        )
          await q(
            "INSERT INTO resources(tenant_id,branch_id,kind,name,data) VALUES($1,$2,'override',$3,$4)",
            [
              tenant,
              branch,
              p.name,
              JSON.stringify({
                productId: p.id,
                price: p.data.price,
                stationId: stations.find(
                  (s) =>
                    s.name === (p.name === "Fresh Lime" ? "Bar" : "Kitchen"),
                ).id,
                available: true,
              }),
            ],
          );
      }
      for (let n = 1; n <= 4; n++)
        if (
          !(
            await q(
              "SELECT id FROM tables WHERE tenant_id=$1 AND branch_id=$2 AND name=$3",
              [tenant, branch, `Table ${n}`],
            )
          ).length
        )
          await q(
            "INSERT INTO tables(tenant_id,branch_id,name,capacity,qr_hash) VALUES($1,$2,$3,4,$4)",
            [tenant, branch, `Table ${n}`, digest(randomUUID() + randomUUID())],
          );
      for (const [name, type] of [
        ["Main cash drawer", "cash"],
        ["Business bank", "bank"],
      ])
        if (
          !(
            await q(
              "SELECT id FROM accounts WHERE tenant_id=$1 AND branch_id=$2 AND name=$3",
              [tenant, branch, name],
            )
          ).length
        )
          await q(
            "INSERT INTO accounts(tenant_id,branch_id,name,type,currency) VALUES($1,$2,$3,$4,'PKR')",
            [tenant, branch, name, type],
          );
      for (const [kind, name, data] of [
        ["supplier", "Fresh Foods Supply", { phone: "000-0000000" }],
        ["purchase_item", "Flour", { unit: "kg" }],
        [
          "printer",
          "Kitchen printer",
          {
            width: 80,
            destination: "kitchen",
            stationId: stations.find((s) => s.name === "Kitchen").id,
          },
        ],
        ["printer", "Receipt printer", { width: 80, destination: "bill" }],
      ])
        if (
          !(
            await q(
              "SELECT id FROM resources WHERE tenant_id=$1 AND branch_id=$2 AND kind=$3 AND name=$4",
              [tenant, branch, kind, name],
            )
          ).length
        )
          await q(
            "INSERT INTO resources(tenant_id,branch_id,kind,name,data) VALUES($1,$2,$3,$4,$5)",
            [tenant, branch, kind, name, JSON.stringify(data)],
          );
    }
    for (const role of ["kitchen", "bar"])
      await q(
        "UPDATE users SET station_ids=$1 WHERE tenant_id=$2 AND role=$3",
        [
          JSON.stringify(
            (
              await q(
                "SELECT id FROM resources WHERE tenant_id=$1 AND kind='station' AND name=$2",
                [tenant, role === "bar" ? "Bar" : "Kitchen"],
              )
            ).map((r) => r.id),
          ),
          tenant,
          role,
        ],
      );
  }
});
await db.initialize();
const ops = new Operations();
const [user] = await owner.query(
  "SELECT * FROM users WHERE email='owner@demo.test'",
);
const branch = ids.branches[0];
let count = await owner.query("SELECT id FROM orders WHERE tenant_id=$1", [
  user.tenant_id,
]);
if (!count.length) {
  const [table] = await owner.query(
    "SELECT id FROM tables WHERE tenant_id=$1 AND branch_id=$2 ORDER BY name LIMIT 1",
    [user.tenant_id, branch],
  );
  const [product] = await owner.query(
    "SELECT * FROM resources WHERE tenant_id=$1 AND kind='product' AND name='Garlic Naan'",
    [user.tenant_id],
  );
  await ops.staff(
    user,
    branch,
    "POST",
    "orders",
    { tableId: table.id, items: [{ productId: product.id, quantity: 2 }] },
    randomUUID(),
  );
  const [supplier] = await owner.query(
    "SELECT * FROM resources WHERE tenant_id=$1 AND branch_id=$2 AND kind='supplier'",
    [user.tenant_id, branch],
  );
  const [item] = await owner.query(
    "SELECT * FROM resources WHERE tenant_id=$1 AND branch_id=$2 AND kind='purchase_item'",
    [user.tenant_id, branch],
  );
  await ops.staff(
    user,
    branch,
    "POST",
    "documents",
    {
      kind: "purchase",
      date: "2026-11-03",
      supplierId: supplier.id,
      invoice: "DEMO-001",
      lines: [{ itemId: item.id, quantity: 10, cost: 15000 }],
    },
    randomUUID(),
  );
  await ops.staff(
    user,
    branch,
    "POST",
    "documents",
    {
      kind: "expense",
      date: "2026-11-03",
      category: "Internet",
      payee: "Demo provider",
      amount: 500000,
    },
    randomUUID(),
  );
}
await owner.destroy();
await db.destroy();
console.log(
  "Demo seed ready. Login: owner@demo.test (password from DEMO_PASSWORD). Other roles: manager, cashier, waiter, kitchen, bar @demo.test. Second tenant: owner2@demo.test and equivalent roles.",
);
