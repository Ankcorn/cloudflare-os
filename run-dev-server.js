#!/usr/bin/env node

// Generates dev-only wrangler.dev.jsonc files for dynamic service bindings,
// then launches `wrangler dev` with all discovered workers.
//
// Flags:
//   --use-workers-ai-binding   Include the Workers AI binding in
//                               workshop-backend (requires Cloudflare login).

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(ROOT, "packages");

const useWorkersAi = process.argv.includes("--use-workers-ai-binding");

// ---------------------------------------------------------------------------
// Discover gatekeeper packages.
// ---------------------------------------------------------------------------
function findGatekeepers(parentDir) {
  try {
    return readdirSync(parentDir)
        .filter(name => name.startsWith("gatekeeper-"))
        .filter(name => {
      try {
        return statSync(join(parentDir, name, "wrangler.jsonc")).isFile();
      } catch {
        return false;
      }
    })
        .map(name => ({ name, dir: join(parentDir, name) }));
  } catch {
    return [];
  }
}

const gatekeepers = findGatekeepers(PACKAGES_DIR);
const configuratorUiWatchers = [];

for (const gk of gatekeepers) {
  const configuratorUiPath = join(gk.dir, "src", "configurator");
  if (!existsSync(configuratorUiPath)) continue;

  execFileSync(process.execPath, [
    join(ROOT, "scripts", "build-gatekeeper-configurator.mjs"),
    gk.dir,
    "--quiet",
  ], {
    stdio: "inherit",
    cwd: ROOT,
  });

  const watcher = spawn(process.execPath, [
    join(ROOT, "scripts", "build-gatekeeper-configurator.mjs"),
    gk.dir,
    "--watch",
    "--quiet",
  ], {
    stdio: "inherit",
    cwd: ROOT,
  });
  watcher.on("exit", (code, signal) => {
    if (stoppingConfiguratorUiWatchers) return;
    console.error(
        `configurator UI watcher for ${gk.name} exited unexpectedly ` +
        `(code=${code}, signal=${signal}).`);
  });
  configuratorUiWatchers.push(watcher);
}

let stoppingConfiguratorUiWatchers = false;
function stopConfiguratorUiWatchers() {
  stoppingConfiguratorUiWatchers = true;
  for (const watcher of configuratorUiWatchers) watcher.kill();
}

process.on("exit", stopConfiguratorUiWatchers);
process.on("SIGINT", () => {
  stopConfiguratorUiWatchers();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopConfiguratorUiWatchers();
  process.exit(143);
});

// Helper: "gatekeeper-github" -> "GATEKEEPER_GITHUB"
function bindingName(gk) {
  return gk.name.toUpperCase().replaceAll("-", "_");
}

// ---------------------------------------------------------------------------
// Generate wrangler.dev.jsonc (dev-router with gatekeeper service bindings).
// ---------------------------------------------------------------------------
{
  const srcPath = join(ROOT, "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));

  config.services = config.services || [];
  for (const gk of gatekeepers) {
    config.services.push({ binding: bindingName(gk), service: gk.name });
  }

  const outPath = join(ROOT, "wrangler.dev.jsonc");
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Generate gatekeeper wrangler.dev.jsonc files. The checked-in wrangler.jsonc
// already points at the capnweb-validate output; dev only needs an explicit cwd
// because this script starts a multi-config Wrangler process from the repo root.
// ---------------------------------------------------------------------------
for (const gk of gatekeepers) {
  const srcPath = join(gk.dir, "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));
  config.build = { ...config.build, cwd: gk.dir };

  const outPath = join(gk.dir, "wrangler.dev.jsonc");
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Generate packages/workshop-backend/wrangler.dev.jsonc (with gatekeeper
// service bindings using the GatekeeperVendor entrypoint).
// ---------------------------------------------------------------------------
{
  const srcPath = join(ROOT, "packages", "workshop-backend", "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));

  config.services = config.services || [];

  // For local testing, create an account named "admin" to test admin features.
  config.vars = config.vars || {};
  config.vars.ADMINS = ["admin"];

  for (const gk of gatekeepers) {
    config.services.push({
      binding: bindingName(gk),
      service: gk.name,
      entrypoint: "GatekeeperVendor",
    });
  }

  if (useWorkersAi) {
    config.ai = { binding: "WORKERS_AI" };
  }

  const backendDir = join(ROOT, "packages", "workshop-backend");
  config.build = { ...config.build, cwd: backendDir };

  const outPath = join(ROOT, "packages", "workshop-backend", "wrangler.dev.jsonc");
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`generated: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Build the wrangler dev command and exec it.
// ---------------------------------------------------------------------------

const configs = [
  "wrangler.dev.jsonc",
  join("packages", "workshop-backend", "wrangler.dev.jsonc"),
  ...gatekeepers.map(gk => join(gk.dir, "wrangler.dev.jsonc")),
];

const args = configs.flatMap(c => ["-c", c]);
console.log(`\nStarting: wrangler dev ${args.join(" ")}\n`);

try {
  execFileSync("pnpm", ["exec", "wrangler", "dev", ...args],
      { stdio: "inherit", cwd: ROOT });
} catch (e) {
  // wrangler was killed or exited with an error; the output was already shown
  // via stdio: "inherit", so just propagate the exit code.
  process.exit(e.status ?? 1);
}
