import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = path + "/" + entry.name;
    if (entry.isDirectory()) await walk(file);
    else if (/\.(mjs|js)$/.test(file)) files.push(file);
  }
}
for (const path of ["backend/src", "backend/test", "frontend/src", "scripts"])
  await walk(path);
files.push("frontend/vite.config.js");
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`${files.length} JavaScript files passed syntax checks.`);
