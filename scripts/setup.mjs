import { readFile, writeFile, access, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
try {
  await access(".env");
  console.log("Keeping your existing .env");
} catch {
  const template = await readFile(".env.example", "utf8");
  await writeFile(
    ".env",
    template
      .replace(
        "replace-with-at-least-32-random-characters",
        randomBytes(48).toString("hex"),
      )
      .replace(/^DEMO_PASSWORD=$/m, "DEMO_PASSWORD=DemoOnly-ChangeMe-2026"),
    { mode: 0o600 },
  );
  console.log(
    "Created local development .env; change demo passwords before any shared deployment.",
  );
}
await chmod("scripts/init-db.sql", 0o644);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
run(npm, ["ci"]);
run("docker", ["compose", "up", "-d", "--wait", "db"]);
run(npm, ["run", "migrate"]);
run(npm, ["run", "seed"]);
run(npm, ["test"]);
console.log(
  "Setup finished. Run npm run dev:api and npm run dev:web in separate terminals. Local demo owner: owner@demo.test; password from DEMO_PASSWORD.",
);
