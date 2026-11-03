import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const base = "http://127.0.0.1:3001/platform-api";
const r = await fetch(base + "/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: process.env.PLATFORM_ADMIN_EMAIL || "admin@platform.test",
    password:
      process.env.PLATFORM_ADMIN_PASSWORD || "DemoPlatform-ChangeMe-2026",
  }),
});
assert.equal(r.status, 200);
const { token } = await r.json();
const headers = {
  Authorization: "Bearer " + token,
  "Content-Type": "application/json",
};
const tenants = await (await fetch(base + "/tenants", { headers })).json();
assert.ok(tenants.length >= 2);
const target = tenants.find((t) => t.name === "Second Restaurant");
const support = await fetch(base + `/tenants/${target.id}/support`, {
  method: "POST",
  headers,
  body: JSON.stringify({ reason: "Automated isolation smoke test" }),
});
assert.equal(support.status, 200);
const data = await support.json();
assert.equal(data.branches.length, 1);
assert.ok(data.orders.every((o) => o.branch_id === data.branches[0].id));
const audit = await (await fetch(base + "/audit", { headers })).json();
assert.ok(
  audit.some((a) => a.action === "support.read" && a.tenant_id === target.id),
);
const staff = await (
  await fetch("http://127.0.0.1:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "owner@demo.test",
      password: process.env.DEMO_PASSWORD || "DemoOnly-ChangeMe-2026",
    }),
  })
).json();
assert.equal(
  (
    await fetch(base + "/tenants", {
      headers: { Authorization: "Bearer " + staff.accessToken },
    })
  ).status,
  401,
);
assert.equal(
  (
    await fetch("http://127.0.0.1:3000/api/me", {
      headers: { Authorization: "Bearer " + token },
    })
  ).status,
  401,
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5173/?platform=1");
  await page
    .getByLabel("Administrator email")
    .fill(process.env.PLATFORM_ADMIN_EMAIL || "admin@platform.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.PLATFORM_ADMIN_PASSWORD || "DemoPlatform-ChangeMe-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Restaurant businesses" }).waitFor();
  await page.getByText("AAS Demo Restaurant", { exact: true }).waitFor();
  assert.equal(await page.locator('[role="alert"]').count(), 0);
  console.log(
    "PASS: separate platform authentication, tenant list, audited scoped support read, staff/platform token separation and platform browser login.",
  );
} finally {
  await browser.close();
}
