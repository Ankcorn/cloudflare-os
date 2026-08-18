import type { EvalExpectation, EvalTask } from "../src/task.js";
import expenseSplitter from "./expense-splitter.js";
import orgChart from "./org-chart.js";
import readingList from "./reading-list.js";

/**
 * Every authored task.
 *
 * Adding an eval is two steps: write `tasks/<id>.ts` exporting a `defineEvalTask(...)` default, and
 * list it here. `registry.test.ts` fails when a task file is missing from this list, so the two
 * cannot drift.
 */
export const evalTasks: readonly EvalTask[] = [expenseSplitter, orgChart, readingList];

/** The tasks in one result set. */
export function tasksFor(expectation: EvalExpectation): EvalTask[] {
  return evalTasks.filter(task => task.expectation === expectation);
}
