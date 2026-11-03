// Run only on the restaurant's trusted LAN machine. No browser can silently print.
import net from "node:net";
import { randomUUID } from "node:crypto";
const required = [
  "API_URL",
  "BRIDGE_EMAIL",
  "BRIDGE_PASSWORD",
  "BRIDGE_BRANCH_ID",
  "BRIDGE_DESTINATION",
  "PRINTER_HOST",
];
for (const k of required) if (!process.env[k]) throw new Error(`Missing ${k}`);
const base = process.env.API_URL.replace(/\/$/, "");
const address = new URL(base);
if (
  address.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(address.hostname)
)
  throw new Error("Use HTTPS for the remote API");
let access, refresh;
async function login() {
  const r = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.BRIDGE_EMAIL,
      password: process.env.BRIDGE_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error("Bridge sign-in failed");
  const t = await r.json();
  access = t.accessToken;
  refresh = t.refreshToken;
}
async function request(path, body) {
  const send = () =>
    fetch(base + "/" + path, {
      method: body ? "PATCH" : "GET",
      headers: {
        Authorization: "Bearer " + access,
        "X-Branch-Id": process.env.BRIDGE_BRANCH_ID,
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  let r = await send();
  if (r.status === 401) {
    await login();
    r = await send();
  }
  if (!r.ok) throw new Error(`API returned ${r.status}`);
  return r.json();
}
const clean = (v) =>
  String(v ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .slice(0, 1000);
const amount = (v) => (Number(v || 0) / 100).toFixed(2);
function ticket(job) {
  const p = job.payload;
  let lines = [clean(p.indicator), `JOB ${job.id}`];
  if (p.bill) {
    const b = p.bill;
    lines.push(
      clean(b.snapshot.branch),
      clean(b.snapshot.tableName),
      `Bill #${b.number}`,
      new Date(b.created_at).toISOString(),
    );
    for (const t of b.snapshot.takers)
      lines.push(
        t.staffId
          ? `Order taker: ${clean(t.name)} | Staff ID: ${clean(t.staffId)}`
          : "Self-order (QR)",
      );
    for (const i of b.snapshot.items)
      lines.push(`${i.quantity} x ${clean(i.name)} ${amount(i.total)}`);
    lines.push(
      `Subtotal ${amount(b.snapshot.subtotal)}`,
      `Discount ${amount(b.snapshot.discount)}`,
    );
    for (const c of b.snapshot.charges)
      lines.push(
        `${clean(c.name)} ${amount(c.amount)}${c.inclusive ? " included" : ""}`,
      );
    lines.push(`TOTAL ${b.snapshot.currency} ${amount(b.total)}`);
    let paid = 0;
    for (const payment of p.payments) {
      lines.push(
        `${clean(payment.kind)} ${clean(payment.status)} ${amount(payment.amount)}`,
        `Cashier: ${clean(payment.receiver_name)} | ${clean(payment.receiver_staff_id)}`,
      );
      if (payment.status === "verified" && payment.direction === 1)
        paid += Number(payment.amount);
      if (payment.tendered)
        lines.push(
          `Change ${amount(Number(payment.tendered) - Number(payment.amount))}`,
        );
    }
    lines.push(
      `Outstanding ${amount(Math.max(0, Number(b.total) - paid))}`,
      clean(b.snapshot.footer),
    );
  } else {
    const o = p.order;
    lines.push(
      clean(p.branch),
      `Order #${o.number}`,
      clean(p.table),
      clean(p.station),
      clean(o.type),
      o.order_taker_user_id
        ? `Order taker: ${clean(o.order_taker_name_snapshot)} | Staff ID: ${clean(o.order_taker_staff_id_snapshot)}`
        : "Self-order (QR)",
    );
    for (const i of p.items) {
      lines.push(`${i.snapshot.quantity} x ${clean(i.snapshot.name)}`);
      if (i.snapshot.variant) lines.push(clean(i.snapshot.variant.name));
      for (const m of i.snapshot.modifiers) lines.push("+ " + clean(m.name));
      if (i.snapshot.notes) lines.push("NOTE: " + clean(i.snapshot.notes));
    }
  }
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from(lines.join("\n") + "\n\n\n", "utf8"),
    Buffer.from([0x1d, 0x56, 0x00]),
  ]);
}
async function dispatch(job) {
  // Claim transactionally before touching hardware. Another bridge's claim fails.
  try {
    await request("print-jobs/" + job.id, { state: "dispatched" });
  } catch {
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(
        {
          host: process.env.PRINTER_HOST,
          port: Number(process.env.PRINTER_PORT || 9100),
        },
        () => socket.end(ticket(job)),
      );
      socket.setTimeout(5000, () =>
        socket.destroy(new Error("Print transport timeout")),
      );
      socket.on("error", reject);
      socket.on("close", (hadError) => {
        if (!hadError) resolve();
      });
    });
    console.log("Dispatched job", job.id, "(physical output not confirmed)");
  } catch {
    await request("print-jobs/" + job.id, {
      state: "failed",
      error:
        "Ambiguous bridge transport failure; inspect printer before explicit retry",
    });
    console.error("Inspect physical output before retry:", job.id);
  }
}
await login();
console.log(
  "Print bridge running. Destination:",
  process.env.BRIDGE_DESTINATION,
);
while (true) {
  try {
    const jobs = await request("print-jobs");
    for (const j of jobs.filter(
      (j) =>
        j.state === "queued" &&
        j.destination === process.env.BRIDGE_DESTINATION,
    ))
      await dispatch(j);
  } catch {
    console.error(
      "Bridge cannot refresh jobs; will retry polling, not printing.",
    );
  }
  await new Promise((r) => setTimeout(r, 3000));
}
