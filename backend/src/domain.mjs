import { createHash, randomBytes } from "node:crypto";
export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const assert = (condition, message, status = 400) => {
  if (!condition) throw new Fault(status, message);
};
export const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
export const id = (v) => {
  assert(uuid(v), "Invalid record identifier");
  return v;
};
export const int = (v, min = 0, max = 100000000) => {
  assert(
    Number.isSafeInteger(v) && v >= min && v <= max,
    "Invalid integer amount or quantity",
  );
  return v;
};
export const str = (v, max = 200) => {
  assert(
    typeof v === "string" && v.trim().length > 0 && v.length <= max,
    "Invalid text",
  );
  return v.trim();
};
export const token = () => randomBytes(32).toString("base64url");
export const digest = (v) => createHash("sha256").update(v).digest("hex");
export const roundRatio = (amount, numerator, denominator = 10000) =>
  Number(
    (BigInt(amount) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) /
      BigInt(denominator),
  );
export const PERMISSIONS = [
  "menu.manage",
  "menu.branch",
  "staff.manage",
  "tables.manage",
  "orders.take",
  "orders.confirm",
  "orders.reassign",
  "orders.view",
  "kitchen.update",
  "orders.serve",
  "orders.cancel",
  "bills.generate",
  "discounts.apply",
  "payments.receive",
  "payments.verify",
  "refunds.approve",
  "finance.manage",
  "finance.transfer",
  "shifts.manage",
  "printers.manage",
  "reports.view",
  "requests.manage",
  "settings.manage",
];
export const ROLES = {
  owner: PERMISSIONS,
  manager: PERMISSIONS.filter((p) => p !== "staff.manage"),
  cashier: [
    "orders.take",
    "orders.view",
    "bills.generate",
    "payments.receive",
    "shifts.manage",
    "requests.manage",
  ],
  waiter: ["orders.take", "orders.view", "orders.serve", "requests.manage"],
  kitchen: ["orders.view", "kitchen.update"],
  bar: ["orders.view", "kitchen.update"],
};
export function permitted(user, permission) {
  assert(
    user && user.permissions.includes(permission),
    "Permission denied",
    403,
  );
}
export function branchAllowed(user, branch) {
  assert(uuid(branch), "Select a branch");
  assert(
    user.role === "owner" || user.branches.includes(branch),
    "Branch access denied",
    403,
  );
  return branch;
}
export function priceItem(product, input) {
  int(input.quantity, 1, 100);
  assert(
    product.active && product.data.available !== false && !product.data.soldOut,
    "Product unavailable",
  );
  let unit = int(product.data.price);
  let variant = null;
  if ((product.data.variants || []).length) {
    variant = product.data.variants.find((v) => v.id === input.variantId);
    assert(variant, "Choose a valid variant");
    unit = int(variant.price);
  } else assert(!input.variantId, "Invalid variant");
  const picked = input.modifiers || [];
  assert(
    Array.isArray(picked) &&
      picked.length <= 30 &&
      new Set(picked).size === picked.length,
    "Invalid modifiers",
  );
  const options = (product.data.modifierGroups || []).flatMap((g) => g.options);
  assert(
    picked.every((v) => options.some((o) => o.id === v)),
    "Unknown modifier",
  );
  const modifiers = [];
  for (const group of product.data.modifierGroups || []) {
    const chosen = group.options.filter((o) => picked.includes(o.id));
    assert(
      chosen.length >= (group.min || 0) && chosen.length <= group.max,
      "Modifier selection limits",
    );
    for (const option of chosen) {
      unit += int(option.price);
      modifiers.push({ ...option });
    }
  }
  int(unit);
  return {
    name: product.name,
    quantity: input.quantity,
    unit,
    total: int(unit * input.quantity),
    variant,
    modifiers,
    notes: typeof input.notes === "string" ? input.notes.slice(0, 500) : "",
    stationId: product.data.stationId || null,
  };
}
export function calculateBill(
  subtotal,
  discount,
  rules,
  type,
  now = new Date(),
) {
  int(subtotal);
  int(discount, 0, subtotal);
  let running = subtotal - discount;
  const charges = [];
  const sorted = [...rules]
    .filter(
      (r) =>
        r.active !== false &&
        (!r.types || r.types.includes(type)) &&
        (!r.effectiveAt || new Date(r.effectiveAt) <= now),
    )
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  for (const r of sorted) {
    assert(["fixed", "percent"].includes(r.mode), "Invalid charge mode");
    int(r.value, 0, r.mode === "percent" ? 10000 : 100000000);
    const base = r.base === "running" ? running : subtotal - discount;
    const amount =
      r.mode === "fixed"
        ? r.value
        : roundRatio(base, r.value, r.inclusive ? 10000 + r.value : 10000);
    charges.push({
      name: r.name,
      kind: r.kind || "charge",
      amount,
      inclusive: !!r.inclusive,
      rule: { ...r },
    });
    if (!r.inclusive) running += amount;
  }
  return { subtotal, discount, charges, total: int(running) };
}
export function transitionItem(from, to, type) {
  const next = {
    CONFIRMED: ["PREPARING"],
    PREPARING: ["READY"],
    READY: [type === "TAKEAWAY" ? "COMPLETED" : "SERVED"],
    SERVED: ["COMPLETED"],
  };
  assert(next[from]?.includes(to), "Invalid item transition");
}
export function aggregate(items) {
  const states = items.filter((x) => x !== "CANCELLED");
  if (!states.length) return "CANCELLED";
  for (const state of [
    "NEW",
    "CONFIRMED",
    "PREPARING",
    "READY",
    "SERVED",
    "COMPLETED",
  ])
    if (states.includes(state)) return state;
  throw new Fault(400, "Unknown item state");
}
export function balanced(lines) {
  assert(lines.length >= 2, "Journal needs two lines");
  let total = 0;
  for (const l of lines) {
    assert(
      Number.isSafeInteger(l.amount) && l.amount !== 0,
      "Invalid journal line",
    );
    total += l.amount;
  }
  assert(total === 0, "Unbalanced journal");
  return true;
}
export const scopeRoom = (tenant, branch) => {
  id(tenant);
  id(branch);
  return `tenant:${tenant}:branch:${branch}`;
};
export function businessDate(date, timeZone = "UTC", cutoff = 0) {
  int(cutoff, 0, 23);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  if (Number(parts.hour) < cutoff) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export function billDiscount(subtotal, input) {
  int(subtotal);
  const type = input.discountType || "fixed";
  assert(["fixed", "percent"].includes(type), "Invalid discount type");
  assert(
    input.discountValue === undefined || !input.discount,
    "Send a single discount value",
  );
  assert(
    type !== "percent" || input.discountValue !== undefined,
    "Percentage discount needs discountValue",
  );
  const value =
    input.discountValue === undefined
      ? int(input.discount || 0)
      : int(input.discountValue, 0, type === "percent" ? 10000 : subtotal);
  if (type === "percent") int(value, 0, 10000);
  else int(value, 0, subtotal);
  const amount = type === "percent" ? roundRatio(subtotal, value) : value;
  const reason = input.discountReason ? str(input.discountReason, 500) : null;
  return { amount, type, value, reason };
}
