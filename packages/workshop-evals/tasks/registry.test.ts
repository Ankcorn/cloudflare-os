import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evalTasks, tasksFor } from "./index.js";

const TASKS_DIR = dirname(fileURLToPath(import.meta.url));

describe("task registry", () => {
  it("lists every task file", async () => {
    const files = (await readdir(TASKS_DIR))
        .filter(name => name.endsWith(".ts") && name !== "index.ts" && !name.endsWith(".test.ts"))
        .map(name => name.replace(/\.ts$/, ""))
        .toSorted();
    expect(evalTasks.map(task => task.id).toSorted()).toEqual(files);
  });

  it("gives every task a unique ID", () => {
    expect(new Set(evalTasks.map(task => task.id)).size).toBe(evalTasks.length);
  });

  it("partitions tasks by expectation", () => {
    expect(tasksFor("required").length + tasksFor("frontier").length).toBe(evalTasks.length);
  });
});
