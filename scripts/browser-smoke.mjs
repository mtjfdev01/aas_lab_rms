import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.getByLabel("Email address").fill("owner@demo.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.DEMO_PASSWORD || "DemoOnly-ChangeMe-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  for (const name of [
    "New order",
    "Orders",
    "Kitchen & bar",
    "Tables & QR",
    "Billing",
    "Menu & setup",
    "Accounts",
    "Purchases & expenses",
    "Cashier shifts",
    "Print queue",
    "Reports",
    "Staff & branches",
    "Settings",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await page.waitForTimeout(180);
    assert.equal(
      await page.locator('[role="alert"]').count(),
      0,
      `Unexpected error on ${name}: ${await page.locator('[role="alert"]').allTextContents()}`,
    );
  }
  await page.getByRole("button", { name: "Billing", exact: true }).click();
  await page
    .getByRole("button", { name: "History", exact: true })
    .first()
    .click();
  const historyDialog = page.getByRole("dialog");
  await historyDialog.getByText("Bill created", { exact: true }).waitFor();
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({
    path: "docs/screenshots/bill-history.png",
    fullPage: true,
  });
  await historyDialog.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Generate bill", exact: true })
    .click();
  const billDialog = page.getByRole("dialog");
  await billDialog.getByLabel("Discount type").selectOption("percent");
  await billDialog.getByLabel("Discount percentage (0–100)").fill("12.50");
  await billDialog.getByLabel("Discount type").selectOption("fixed");
  await billDialog.getByLabel("Discount amount (PKR)").fill("25.50");
  await billDialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.waitForTimeout(300);
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({
    path: "docs/screenshots/desktop.png",
    fullPage: true,
  });
  const result = await page.evaluate(async () => {
    const headers = {
      Authorization: "Bearer " + sessionStorage.getItem("rms.access"),
      "X-Branch-Id": sessionStorage.getItem("rms.branch"),
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    };
    const r = await fetch("/api/tables", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Browser table " + Date.now(),
        capacity: 2,
      }),
    });
    const table = await r.json();
    headers["Idempotency-Key"] = crypto.randomUUID();
    const q = await fetch(`/api/tables/${table.id}/qr`, {
      method: "POST",
      headers,
      body: "{}",
    });
    return q.json();
  });
  assert.ok(result.url);
  const customer = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  customer.on("pageerror", (e) => errors.push(e.message));
  await customer.goto(result.url.replace("localhost", "127.0.0.1"));
  await customer.getByRole("button", { name: "Continue", exact: true }).click();
  await customer.getByLabel("Search menu").waitFor();
  await customer.getByRole("button", { name: /Garlic Naan/ }).click();
  await customer
    .getByRole("button", { name: "Add to order", exact: true })
    .click();
  await customer
    .getByRole("button", { name: "Place order", exact: true })
    .click();
  await customer
    .getByText("Order received. Staff will confirm it shortly.")
    .waitFor();
  await customer.getByRole("heading", { name: /Order #/ }).waitFor();
  await customer.screenshot({
    path: "docs/screenshots/customer-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Orders", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "docs/screenshots/staff-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: owner login, 13 operational screens, responsive staff view, bill history and fixed/percentage discount controls, real QR join/order/own-order tracking; no browser exceptions.",
  );
} finally {
  await browser.close();
}
