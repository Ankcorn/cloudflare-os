#!/usr/bin/env node

// Generates wrangler.dev.jsonc files for the dev-router and workshop-backend
// workers (with dynamically-discovered gatekeeper service bindings), then
// launches `wrangler dev` with all discovered workers.
//
// Flags:
//   --use-workers-ai-binding   Include the Workers AI binding in
//                               workshop-backend (requires Cloudflare login).

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    });
  } catch {
    return [];
  }
}

const gatekeepers = findGatekeepers(PACKAGES_DIR);

// Helper: "gatekeeper-github" -> "GATEKEEPER_GITHUB"
function bindingName(pkg) {
  return pkg.toUpperCase().replaceAll("-", "_");
}

// ---------------------------------------------------------------------------
// Generate wrangler.dev.jsonc (dev-router with gatekeeper service bindings).
// ---------------------------------------------------------------------------
{
  const srcPath = join(ROOT, "wrangler.jsonc");
  const config = parse(readFileSync(srcPath, "utf8"));

  config.services = config.services || [];
  for (const gk of gatekeepers) {
    config.services.push({ binding: bindingName(gk), service: gk });
  }

  const outPath = join(ROOT, "wrangler.dev.jsonc");
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
      service: gk,
      entrypoint: "GatekeeperVendor",
    });
  }

  if (useWorkersAi) {
    config.ai = { binding: "WORKERS_AI" };
  }

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
  ...gatekeepers.map(gk => join("packages", gk, "wrangler.jsonc")),
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
