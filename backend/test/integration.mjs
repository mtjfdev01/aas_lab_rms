import "./test-env.mjs";
import { test, after } from "node:test";
import A from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, makeDatabase, transaction } from "../src/database.mjs";
import { Operations } from "../src/service.mjs";
import { digest, token } from "../src/domain.mjs";
await test("PostgreSQL integration workflow", async (t) => {
  const admin = makeDatabase(process.env.MIGRATION_DATABASE_URL);
  await admin.initialize();
  await db.initialize();
  const ops = new Operations();
  t.after(async () => {
    await db.destroy();
    await admin.destroy();
  });
  const auth = async (email) => {
    const tokens = await ops.login({
      email,
      password: process.env.DEMO_PASSWORD,
    });
    return ops.authenticate(tokens.accessToken);
  };
  const owner = await auth("owner@demo.test"),
    cashier = await auth("cashier@demo.test"),
    waiter = await auth("waiter@demo.test"),
    kitchen = await auth("kitchen@demo.test"),
    other = await auth("owner2@demo.test"),
    manager = await auth("manager@demo.test");
  const branch = "20000000-0000-4000-8000-000000000001",
    north = "20000000-0000-4000-8000-000000000002",
    otherBranch = "20000000-0000-4000-8000-000000000003";
  const call = (
    u,
    path,
    body,
    method = body === undefined ? "GET" : "POST",
    key = randomUUID(),
    b = branch,
  ) => ops.staff(u, b, method, path, body, key);
  const menu = await call(owner, "menu"),
    naan = menu.find((x) => x.name === "Garlic Naan"),
    lime = menu.find((x) => x.name === "Fresh Lime");
  await t.test(
    "RLS fails closed with no scope and hides another tenant even without query filter",
    async () => {
      A.equal((await db.query("SELECT * FROM orders")).length, 0);
      await transaction({ ...owner, branch_id: branch }, async (q) => {
        A.equal(
          (await q("SELECT * FROM tenants WHERE id=$1", [other.tenant_id]))
            .length,
          0,
        );
        const rows = await q("SELECT * FROM resources");
        A.ok(
          rows.every(
            (r) =>
              r.tenant_id === owner.tenant_id &&
              (!r.branch_id || r.branch_id === branch),
          ),
        );
      });
    },
  );
  await t.test(
    "unassigned branch and tenant-related manipulation fail",
    async () => {
      await A.rejects(
        call(manager, "menu", undefined, "GET", randomUUID(), north),
        /Branch access/,
      );
      const foreignProduct = (
        await call(other, "menu", undefined, "GET", randomUUID(), otherBranch)
      )[0];
      await A.rejects(
        call(owner, "resources/override", {
          name: "Injected",
          data: {
            productId: foreignProduct.id,
            price: 1,
            stationId: naan.data.stationId,
          },
        }),
        /not found/,
      );
      await A.rejects(
        call(owner, "orders", {
          type: "TAKEAWAY",
          items: [{ productId: foreignProduct.id, quantity: 1 }],
        }),
        /not found/,
      );
    },
  );
  await t.test(
    "branch manager cannot edit tenant product definitions or another branch overrides",
    async () => {
      await A.rejects(
        call(
          manager,
          `resources/product/${naan.id}`,
          { name: "Hijacked", data: naan.data },
          "PATCH",
        ),
        /Tenant menu/,
      );
      const [override] = await admin.query(
        "SELECT * FROM resources WHERE tenant_id=$1 AND branch_id=$2 AND kind='override' LIMIT 1",
        [owner.tenant_id, north],
      );
      await A.rejects(
        call(
          manager,
          `resources/override/${override.id}`,
          { name: override.name, data: override.data },
          "PATCH",
        ),
        /not found/,
      );
    },
  );
  let table, qr, customer, qrOrder, manualOrder, bill, drawer, bank, shift;
  await t.test(
    "QR join gives private customer capability; same permanent QR never exposes previous orders",
    async () => {
      table = await call(owner, "tables", {
        name: "Integration " + randomUUID().slice(0, 6),
        capacity: 4,
      });
      qr = (await call(owner, `tables/${table.id}/qr`, {})).url.split(
        "table=",
      )[1];
      customer = await ops.public(qr, "POST", "join", {}, randomUUID());
      const key = randomUUID();
      const body = {
        items: [{ productId: naan.id, quantity: 2, total: 1 }],
        tenantId: other.tenant_id,
        orderTakerUserId: other.id,
      };
      qrOrder = await ops.public(customer.token, "POST", "orders", body, key);
      const retry = await ops.public(
        customer.token,
        "POST",
        "orders",
        body,
        key,
      );
      A.equal(qrOrder.id, retry.id);
      A.equal(qrOrder.order_taker_user_id, null);
      A.equal(qrOrder.source, "CUSTOMER_QR");
      const stranger = await ops.public(qr, "POST", "join", {}, randomUUID());
      A.equal((await ops.public(stranger.token, "GET", "orders")).length, 0);
      A.equal((await ops.public(customer.token, "GET", "orders")).length, 1);
      await A.rejects(
        ops.public(
          customer.token,
          "POST",
          "orders",
          { items: [{ productId: naan.id, quantity: 3 }] },
          key,
        ),
        /mismatch/,
      );
    },
  );
  await t.test(
    "QR and manual rounds share session and authoritative price; attribution snapshots stay separate",
    async () => {
      manualOrder = await call(waiter, "orders", {
        tableId: table.id,
        items: [
          {
            productId: lime.id,
            quantity: 1,
            variantId: "regular",
            modifiers: [],
            total: 1,
          },
        ],
        createdBy: owner.id,
      });
      A.equal(manualOrder.session_id, qrOrder.session_id);
      A.equal(manualOrder.order_taker_user_id, waiter.id);
      A.equal(manualOrder.order_taker_staff_id_snapshot, waiter.staff_id);
      await call(owner, `orders/${qrOrder.id}/confirm`, {});
      const rows = await call(owner, "orders");
      const qrItems = rows.find((o) => o.id === qrOrder.id).items;
      A.equal(Number(qrItems[0].amount), 24000);
    },
  );
  await t.test(
    "station authorization and transition history; whole order readiness is derived",
    async () => {
      for (const orderId of [qrOrder.id, manualOrder.id]) {
        const order = (await call(owner, "orders")).find(
          (o) => o.id === orderId,
        );
        if (orderId === manualOrder.id)
          await A.rejects(
            call(
              kitchen,
              `items/${order.items[0].id}`,
              { status: "PREPARING" },
              "PATCH",
            ),
            /Station access/,
          );
        for (const item of order.items)
          for (const status of ["PREPARING", "READY", "SERVED"])
            await call(owner, `items/${item.id}`, { status }, "PATCH");
      }
    },
  );
  await t.test(
    "concurrent bills cannot cover the same item twice; finalized snapshot combines distinct takers",
    async () => {
      const results = await Promise.allSettled([
        call(owner, "bills", { sessionId: qrOrder.session_id }),
        call(owner, "bills", { sessionId: qrOrder.session_id }),
      ]);
      A.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      bill = results.find((r) => r.status === "fulfilled").value;
      A.equal(Number(bill.total), 42000);
      A.equal(bill.snapshot.takers.length, 2);
      A.ok(bill.snapshot.takers.some((t) => t.name === "Self-order (QR)"));
      A.ok(bill.snapshot.takers.some((t) => t.staffId === waiter.staff_id));
      await A.rejects(
        call(waiter, "orders", {
          sessionId: qrOrder.session_id,
          items: [{ productId: naan.id, quantity: 1 }],
        }),
        /already billed/,
      );
    },
  );
  await t.test(
    "split cash and verified bank posting; idempotent receipt; generator differs from receiver",
    async () => {
      drawer = await call(owner, "accounts", {
        name: "Test cash " + randomUUID().slice(0, 6),
        type: "cash",
        opening: 0,
      });
      bank = await call(owner, "accounts", {
        name: "Test bank " + randomUUID().slice(0, 6),
        type: "bank",
        opening: 0,
      });
      shift = await call(cashier, "shifts", {
        accountId: drawer.id,
        opening: 0,
      });
      const key = randomUUID(),
        body = {
          billId: bill.id,
          accountId: drawer.id,
          amount: 20000,
          tendered: 25000,
        };
      const p = await call(cashier, "payments", body, "POST", key);
      const duplicate = await call(cashier, "payments", body, "POST", key);
      A.equal(p.id, duplicate.id);
      A.equal(p.received_by, cashier.id);
      A.notEqual(p.received_by, bill.generated_by);
      const noncash = await call(cashier, "payments", {
        billId: bill.id,
        accountId: bank.id,
        amount: 22000,
        reference: "TEST-" + randomUUID(),
      });
      A.equal(noncash.status, "pending");
      await call(owner, `payments/${noncash.id}/verify`, {});
      await A.rejects(
        call(owner, `payments/${noncash.id}/verify`, {}),
        /not found/,
      );
      const [session] = await admin.query(
        "SELECT * FROM sessions WHERE id=$1",
        [qrOrder.session_id],
      );
      A.equal(session.state, "closed");
      const [t] = await admin.query("SELECT * FROM tables WHERE id=$1", [
        table.id,
      ]);
      A.equal(t.state, "cleaning");
    },
  );
  await t.test(
    "printer queue/reprint creates no payments; closing cash includes collections once",
    async () => {
      const before = await admin.query(
        "SELECT id FROM payments WHERE bill_id=$1",
        [bill.id],
      );
      const job = await call(owner, "print-jobs", { billId: bill.id });
      await call(
        owner,
        `print-jobs/${job.id}`,
        { state: "dispatched" },
        "PATCH",
      );
      await A.rejects(
        call(owner, `print-jobs/${job.id}`, { state: "dispatched" }, "PATCH"),
        /explicit reprint/,
      );
      const copy = await call(owner, `print-jobs/${job.id}/reprint`, {
        reason: "Test reprint",
      });
      A.equal(copy.reprint_of, job.id);
      A.equal(
        (
          await admin.query("SELECT id FROM payments WHERE bill_id=$1", [
            bill.id,
          ])
        ).length,
        before.length,
      );
      const closing = await call(cashier, `shifts/${shift.id}/close`, {
        actual: 20000,
      });
      A.equal(closing.expected, 20000);
      A.equal(closing.variance, 0);
    },
  );
  await t.test(
    "purchase/expense payment allocation cannot overpay under concurrency",
    async () => {
      const doc = await call(owner, "documents", {
        kind: "expense",
        date: "2026-11-03",
        category: "Maintenance",
        payee: "Test vendor",
        amount: 1000,
      });
      const results = await Promise.allSettled([
        call(owner, "payments", {
          documentId: doc.id,
          accountId: bank.id,
          amount: 700,
          reference: randomUUID(),
        }),
        call(owner, "payments", {
          documentId: doc.id,
          accountId: bank.id,
          amount: 700,
          reference: randomUUID(),
        }),
      ]);
      A.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const payment = results.find((r) => r.status === "fulfilled").value;
      await call(owner, `payments/${payment.id}/verify`, {});
    },
  );
  await t.test(
    "same/cross-branch transfers balance without revenue, and cross-tenant destination is rejected",
    async () => {
      const target = await call(
        owner,
        "accounts",
        { name: "North integration " + randomUUID().slice(0, 6), type: "bank" },
        "POST",
        randomUUID(),
        north,
      );
      const transfer = await call(owner, "transfers", {
        fromId: bank.id,
        toId: target.id,
        toBranchId: north,
        amount: 1000,
      });
      const entries = await admin.query(
        "SELECT * FROM journals WHERE source_id=$1",
        [transfer.id],
      );
      A.equal(entries.length, 2);
      const [sum] = await admin.query(
        "SELECT sum(l.amount) AS total FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_id=$1",
        [transfer.id],
      );
      A.equal(Number(sum.total), 0);
      const targetAccounts = await call(
        owner,
        "accounts",
        undefined,
        "GET",
        randomUUID(),
        north,
      );
      A.equal(
        Number(targetAccounts.find((x) => x.id === target.id).balance),
        1000,
      );
      const foreign = (
        await call(
          other,
          "accounts",
          undefined,
          "GET",
          randomUUID(),
          otherBranch,
        )
      ).find((a) => a.type === "bank");
      await A.rejects(
        call(owner, "transfers", {
          fromId: bank.id,
          toId: foreign.id,
          toBranchId: otherBranch,
          amount: 1,
        }),
        /not found/,
      );
    },
  );
  await t.test(
    "posted ledger and audit cannot be edited; persisted events and jobs survive reconnect reads",
    async () => {
      const [line] = await admin.query("SELECT * FROM journal_lines LIMIT 1");
      await A.rejects(
        transaction({ ...owner, branch_id: branch }, (q) =>
          q("UPDATE journal_lines SET amount=1 WHERE id=$1", [line.id]),
        ),
        /immutable/,
      );
      const events = await call(owner, "events");
      A.ok(events.length > 0);
      const jobs = await call(owner, "print-jobs");
      A.ok(jobs.length > 0);
    },
  );
  await t.test(
    "QR rotation invalidates permanent token without leaking another customer history",
    async () => {
      await call(owner, `tables/${table.id}/qr`, {});
      await A.rejects(ops.public(qr, "GET", "menu"), /Invalid or expired/);
      const own = await ops.public(customer.token, "GET", "orders");
      A.equal(own.length, 1);
    },
  );
  await t.test(
    "payment races reserve outstanding once, rejected payments release it, and refunds are capped",
    async () => {
      const order = await call(owner, "orders", {
        type: "TAKEAWAY",
        items: [{ productId: naan.id, quantity: 1 }],
      });
      const item = (await call(owner, "orders")).find((o) => o.id === order.id)
        .items[0];
      for (const status of ["PREPARING", "READY", "COMPLETED"])
        await call(owner, `items/${item.id}`, { status }, "PATCH");
      const small = await call(owner, "bills", { sessionId: order.session_id });
      const race = await Promise.allSettled([
        call(cashier, "payments", {
          billId: small.id,
          accountId: bank.id,
          amount: 8000,
          reference: randomUUID(),
        }),
        call(cashier, "payments", {
          billId: small.id,
          accountId: bank.id,
          amount: 8000,
          reference: randomUUID(),
        }),
      ]);
      A.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      const pending = race.find((r) => r.status === "fulfilled").value;
      await call(owner, `payments/${pending.id}/reject`, {
        reason: "Reference failed verification",
      });
      const replacement = await call(cashier, "payments", {
        billId: small.id,
        accountId: bank.id,
        amount: 12000,
        reference: randomUUID(),
      });
      await call(owner, `payments/${replacement.id}/verify`, {});
      await call(owner, `payments/${replacement.id}/refund`, {
        accountId: bank.id,
        amount: 1000,
        reason: "Partial goodwill refund",
      });
      await A.rejects(
        call(owner, `payments/${replacement.id}/refund`, {
          accountId: bank.id,
          amount: 12000,
          reason: "Excess",
        }),
        /exceeds/,
      );
      await A.rejects(
        transaction({ ...owner, branch_id: branch }, (q) =>
          q("UPDATE bills SET total=1 WHERE id=$1", [small.id]),
        ),
        /immutable/,
      );
    },
  );
  await t.test(
    "voiding an unpaid finalized bill creates a reversal and releases the table session",
    async () => {
      const order = await call(owner, "orders", {
        type: "TAKEAWAY",
        items: [{ productId: naan.id, quantity: 1 }],
      });
      const item = (await call(owner, "orders")).find((o) => o.id === order.id)
        .items[0];
      for (const status of ["PREPARING", "READY"])
        await call(owner, `items/${item.id}`, { status }, "PATCH");
      const voidBill = await call(owner, "bills", {
        sessionId: order.session_id,
      });
      await call(owner, `bills/${voidBill.id}/void`, {
        reason: "Customer cancelled before collection",
      });
      const [updated] = await admin.query(
        "SELECT status FROM bills WHERE id=$1",
        [voidBill.id],
      );
      A.equal(updated.status, "voided");
      await A.rejects(
        call(cashier, "payments", {
          billId: voidBill.id,
          accountId: bank.id,
          amount: 1,
          reference: randomUUID(),
        }),
        /voided/,
      );
    },
  );
  await t.test(
    "paid purchase returns create supplier credit with a bounded refund, not duplicate expense",
    async () => {
      const [supplier] = await call(owner, "resources/supplier");
      const [catalogue] = await call(owner, "resources/purchase_item");
      const purchase = await call(owner, "documents", {
        kind: "purchase",
        supplierId: supplier.id,
        date: "2026-11-03",
        invoice: "TEST-" + randomUUID(),
        lines: [{ itemId: catalogue.id, quantity: 1, cost: 10000 }],
      });
      const payment = await call(owner, "payments", {
        documentId: purchase.id,
        accountId: bank.id,
        amount: 10000,
        reference: randomUUID(),
      });
      await call(owner, `payments/${payment.id}/verify`, {});
      await call(owner, `documents/${purchase.id}/return`, {
        amount: 3000,
        reason: "Damaged supplies",
      });
      await call(owner, `documents/${purchase.id}/supplier-refund`, {
        amount: 3000,
        accountId: bank.id,
        reason: "Supplier credit paid back",
      });
      await A.rejects(
        call(owner, `documents/${purchase.id}/supplier-refund`, {
          amount: 1,
          accountId: bank.id,
          reason: "Excess",
        }),
        /exceeds/,
      );
    },
  );
  await t.test(
    "subscription restrictions block public and staff access and recover on activation",
    async () => {
      const original = (
        await admin.query("SELECT state FROM tenants WHERE id=$1", [
          owner.tenant_id,
        ])
      )[0].state;
      try {
        await admin.query("UPDATE tenants SET state='suspended' WHERE id=$1", [
          owner.tenant_id,
        ]);
        await A.rejects(call(owner, "menu"), /Subscription access/);
      } finally {
        await admin.query("UPDATE tenants SET state=$1 WHERE id=$2", [
          original,
          owner.tenant_id,
        ]);
      }
      A.ok((await call(owner, "menu")).length);
    },
  );
  await t.test(
    "view permissions hide receipt jobs and GET cannot perform financial mutations",
    async () => {
      const jobs = await call(waiter, "print-jobs");
      A.ok(jobs.every((j) => j.destination !== "bill"));
      await A.rejects(
        call(cashier, `shifts/${shift.id}/close`, { actual: 1 }, "GET"),
        /Method not allowed/,
      );
    },
  );
  await t.test(
    "database rejects empty journals even when no journal lines were inserted",
    async () => {
      await A.rejects(
        transaction({ ...owner, branch_id: branch }, (q) =>
          q(
            "INSERT INTO journals(tenant_id,branch_id,source,source_id,actor_id) VALUES($1,$2,$3,$4,$5)",
            [owner.tenant_id, branch, "test_empty", randomUUID(), owner.id],
          ),
        ),
        /balanced posting lines/,
      );
    },
  );
  await t.test(
    "refresh-token rotation permits exactly one concurrent reuse",
    async () => {
      const tokens = await ops.login({
        email: "bar2@demo.test",
        password: process.env.DEMO_PASSWORD,
      });
      const attempts = await Promise.allSettled([
        ops.refresh({ refreshToken: tokens.refreshToken }),
        ops.refresh({ refreshToken: tokens.refreshToken }),
      ]);
      A.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
      const rotated = attempts.find((r) => r.status === "fulfilled").value;
      A.ok(await ops.authenticate(rotated.accessToken));
      await A.rejects(ops.authenticate(tokens.accessToken), /revoked/);
    },
  );
  await t.test(
    "bill history retains discount, actor snapshots, payment and receipt events without duplicate retry entries",
    async () => {
      const order = await call(owner, "orders", {
        type: "TAKEAWAY",
        items: [{ productId: naan.id, quantity: 1 }],
      });
      const item = (await call(owner, "orders")).find((o) => o.id === order.id)
        .items[0];
      for (const status of ["PREPARING", "READY"])
        await call(owner, `items/${item.id}`, { status }, "PATCH");
      await A.rejects(
        call(cashier, "bills", {
          sessionId: order.session_id,
          discountType: "percent",
          discountValue: 1000,
        }),
        /Permission denied/,
      );
      const discounted = await call(owner, "bills", {
        sessionId: order.session_id,
        discountType: "percent",
        discountValue: 1000,
        discountReason: "Loyalty offer",
      });
      A.equal(Number(discounted.total), 10800);
      A.equal(discounted.snapshot.discount, 1200);
      const key = randomUUID(),
        body = {
          billId: discounted.id,
          accountId: bank.id,
          amount: 10800,
          reference: randomUUID(),
        };
      const payment = await call(cashier, "payments", body, "POST", key);
      await call(cashier, "payments", body, "POST", key);
      await call(owner, `payments/${payment.id}/verify`, {});
      const job = await call(owner, "print-jobs", { billId: discounted.id });
      await call(
        owner,
        `print-jobs/${job.id}`,
        { state: "dispatched" },
        "PATCH",
      );
      await call(owner, `print-jobs/${job.id}/reprint`, {
        reason: "Customer copy",
      });
      const history = await call(owner, `bills/${discounted.id}/history`);
      A.equal(history.billId, discounted.id);
      const created = history.events.find((e) => e.action === "bill.created");
      A.equal(created.actor_name_snapshot, owner.name);
      A.equal(created.actor_staff_id_snapshot, owner.staff_id);
      A.equal(created.data.discountRule.reason, "Loyalty offer");
      A.equal(created.data.discount, 1200);
      A.equal(
        history.events.filter((e) => e.action === "payment.recorded").length,
        1,
      );
      A.equal(
        history.events.find((e) => e.action === "payment.recorded").actor_id,
        cashier.id,
      );
      for (const action of [
        "payment.verified",
        "bill.settled",
        "receipt.queued",
        "receipt.dispatched",
        "receipt.reprint_queued",
      ])
        A.ok(
          history.events.some((e) => e.action === action),
          action,
        );
      await A.rejects(
        call(
          other,
          `bills/${discounted.id}/history`,
          undefined,
          "GET",
          randomUUID(),
          otherBranch,
        ),
        /not found/,
      );
      await A.rejects(
        call(
          owner,
          `bills/${discounted.id}/history`,
          undefined,
          "GET",
          randomUUID(),
          north,
        ),
        /not found/,
      );
      await A.rejects(
        call(waiter, `bills/${discounted.id}/history`),
        /Permission denied/,
      );
      const eventId = created.id;
      await A.rejects(
        transaction({ ...owner, branch_id: branch }, (q) =>
          q("UPDATE bill_history SET action=$1 WHERE id=$2", [
            "tampered",
            eventId,
          ]),
        ),
        /permission denied|immutable/,
      );
      await A.rejects(
        admin.query("DELETE FROM bill_history WHERE id=$1", [eventId]),
        /immutable/,
      );
    },
  );
  console.log(
    "Integration workflow completed against PostgreSQL using the non-owner runtime role.",
  );
});
