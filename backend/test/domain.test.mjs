import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceItem,
  calculateBill,
  transitionItem,
  aggregate,
  balanced,
  branchAllowed,
  permitted,
  scopeRoom,
  businessDate,
  ROLES,
} from "../src/domain.mjs";
const tenant = "10000000-0000-4000-8000-000000000001",
  branch = "20000000-0000-4000-8000-000000000001",
  other = "20000000-0000-4000-8000-000000000002";
const product = {
  name: "Tea",
  active: true,
  data: {
    price: 100,
    available: true,
    variants: [{ id: "large", price: 175 }],
    modifierGroups: [
      { name: "Milk", min: 1, max: 1, options: [{ id: "oat", price: 25 }] },
    ],
  },
};
test("server prices variants/modifiers; ignores submitted totals", () => {
  const p = priceItem(product, {
    quantity: 2,
    variantId: "large",
    modifiers: ["oat"],
    total: 1,
  });
  assert.equal(p.total, 400);
  assert.equal(p.unit, 200);
});
test("rejects missing, foreign and duplicate modifiers and invalid quantities", () => {
  for (const input of [
    { quantity: 0, variantId: "large", modifiers: ["oat"] },
    { quantity: 2, variantId: "small", modifiers: ["oat"] },
    { quantity: 2, variantId: "large", modifiers: [] },
    { quantity: 2, variantId: "large", modifiers: ["foreign"] },
    { quantity: 2, variantId: "large", modifiers: ["oat", "oat"] },
  ])
    assert.throws(() => priceItem(product, input));
});
test("sold out or inactive cannot be ordered", () => {
  assert.throws(() =>
    priceItem({ ...product, active: false }, { quantity: 1 }),
  );
  assert.throws(() =>
    priceItem(
      { ...product, data: { ...product.data, soldOut: true } },
      { quantity: 1 },
    ),
  );
});
test("integer rounding and charge sequence snapshot", () => {
  const b = calculateBill(
    10001,
    1,
    [
      { name: "Service", mode: "percent", value: 1000, sequence: 1 },
      {
        name: "Tax",
        mode: "percent",
        value: 500,
        base: "running",
        sequence: 2,
      },
    ],
    "DINE_IN",
  );
  assert.equal(b.total, 11550);
  assert.deepEqual(
    b.charges.map((c) => c.amount),
    [1000, 550],
  );
});
test("inclusive taxes do not increase total; type/effective date filters", () => {
  const b = calculateBill(
    11000,
    0,
    [
      { name: "VAT", mode: "percent", value: 1000, inclusive: true },
      { name: "Packaging", mode: "fixed", value: 100, types: ["TAKEAWAY"] },
      { name: "Future", mode: "fixed", value: 200, effectiveAt: "2099-01-01" },
    ],
    "DINE_IN",
  );
  assert.equal(b.total, 11000);
  assert.equal(b.charges[0].amount, 1000);
  assert.equal(b.charges.length, 1);
});
test("bad financial values cannot post", () => {
  assert.throws(() => calculateBill(100, 101, [], "DINE_IN"));
  assert.throws(() => balanced([{ amount: 100 }, { amount: -99 }]));
  assert.throws(() => balanced([{ amount: 0 }, { amount: 0 }]));
  assert.ok(balanced([{ amount: 100 }, { amount: -100 }]));
});
test("aggregate readiness waits for every active required item", () => {
  assert.equal(aggregate(["READY", "PREPARING"]), "PREPARING");
  assert.equal(aggregate(["READY", "CANCELLED"]), "READY");
  assert.equal(aggregate(["CANCELLED"]), "CANCELLED");
});
test("transitions reject skipping preparation; takeaway skips served", () => {
  assert.throws(() => transitionItem("CONFIRMED", "READY", "DINE_IN"));
  transitionItem("READY", "COMPLETED", "TAKEAWAY");
  assert.throws(() => transitionItem("READY", "COMPLETED", "DINE_IN"));
  transitionItem("READY", "SERVED", "DINE_IN");
});
test("branch users cannot elevate using another branch identifier", () => {
  const waiter = {
    role: "waiter",
    branches: [branch],
    permissions: ROLES.waiter,
  };
  assert.equal(branchAllowed(waiter, branch), branch);
  assert.throws(() => branchAllowed(waiter, other));
  assert.throws(() => permitted(waiter, "payments.receive"));
});
test("rooms contain both tenant and branch identity", () => {
  assert.equal(scopeRoom(tenant, branch), `tenant:${tenant}:branch:${branch}`);
  assert.throws(() => scopeRoom("untrusted", branch));
});
test("business day uses timezone and cutoff across midnight", () => {
  assert.equal(
    businessDate(new Date("2026-11-03T21:00:00Z"), "Asia/Karachi", 4),
    "2026-11-03",
  );
  assert.equal(
    businessDate(new Date("2026-11-04T00:00:00Z"), "Asia/Karachi", 4),
    "2026-11-04",
  );
});

test("bill discounts support fixed minor units and rounded percentage basis points", async () => {
  const { billDiscount } = await import("../src/domain.mjs");
  assert.equal(
    billDiscount(10005, { discountType: "percent", discountValue: 1000 })
      .amount,
    1001,
  );
  assert.equal(
    billDiscount(10005, { discountType: "fixed", discountValue: 500 }).amount,
    500,
  );
  assert.equal(billDiscount(10005, { discount: 700 }).amount, 700);
});
test("bill discounts reject excess, fractional minor units and ambiguous amounts", async () => {
  const { billDiscount } = await import("../src/domain.mjs");
  for (const input of [
    { discountType: "percent", discountValue: 10001 },
    { discountType: "fixed", discountValue: 101 },
    { discountType: "fixed", discountValue: -1 },
    { discountType: "percent", discountValue: 0.5 },
    { discount: 1, discountValue: 2 },
    { discountType: "unknown", discountValue: 0 },
  ])
    assert.throws(() => billDiscount(100, input));
});
