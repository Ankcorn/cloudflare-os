#!/usr/bin/env node

import { executeWorkshop, interrupt, runCli } from "./cli.js";

const controller = new AbortController();
process.once("SIGINT", () => interrupt(controller, process.stdin));

let prompt = "";
process.stdin.setEncoding("utf8");
try {
  for await (const chunk of process.stdin) prompt += chunk;
} catch (error) {
  if (!controller.signal.aborted) throw error;
}

process.exitCode = await runCli(
    process.argv.slice(2),
    process.env,
    prompt,
    controller.signal,
    {
      execute: executeWorkshop,
      now: Date.now,
      stdout: text => process.stdout.write(text),
      stderr: text => process.stderr.write(text),
    });
