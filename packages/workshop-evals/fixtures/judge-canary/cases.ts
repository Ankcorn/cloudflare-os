import type { WorkshopCheckResult, WorkshopRubricDimension } from "../../src/task.js";

export type JudgeCanaryFixture = {
  id: string;
  title: string;
  prompt: string;
  image: string;
  checks: readonly WorkshopCheckResult[];
  rubric: readonly WorkshopRubricDimension[];
  expectedScore: readonly [minimum: number, maximum: number];
  expectedDimensions: Readonly<Record<string, readonly [minimum: number, maximum: number]>>;
};

const VISUAL_QUALITY = {
  id: "visual-quality",
  criterion: "Visual polish, hierarchy, legibility, spacing, and coherence in the rendered UI.",
  weight: 1,
} as const;

const TASK_COMPLETION = {
  id: "task-completion",
  criterion: "Observable completeness and successful operation of the requested application.",
  weight: 1,
} as const;

export const JUDGE_CANARY_FIXTURES: readonly JudgeCanaryFixture[] = [{
  id: "strong",
  title: "Strong project dashboard",
  prompt: "Build a polished project dashboard with progress, tasks, and an upcoming milestone.",
  image: "strong.png",
  checks: [
    { id: "project-data-visible", pass: true, evidence: { projectCount: 3 } },
    { id: "milestone-visible", pass: true, evidence: { title: "Prototype review" } },
  ],
  rubric: [VISUAL_QUALITY, TASK_COMPLETION],
  expectedScore: [0.75, 1],
  expectedDimensions: { "visual-quality": [3, 5], "task-completion": [4, 5] },
}, {
  id: "middling",
  title: "Middling task dashboard",
  prompt: "Build a team task dashboard with navigation, completion totals, and recent tasks.",
  image: "middling.png",
  checks: [
    { id: "completion-total-visible", pass: true, evidence: { completed: 18, total: 30 } },
    { id: "recent-tasks-visible", pass: true, evidence: { count: 2 } },
  ],
  rubric: [VISUAL_QUALITY, TASK_COMPLETION],
  expectedScore: [0.375, 0.75],
  expectedDimensions: { "visual-quality": [2, 4], "task-completion": [4, 5] },
}, {
  id: "broken-ui",
  title: "Broken dashboard UI",
  prompt: "Build a polished, legible analytics dashboard with summary cards, a chart, and a table.",
  image: "broken-ui.png",
  checks: [
    { id: "summary-values-present", pass: false, evidence: { displayedValue: "?" } },
    { id: "table-readable", pass: false, evidence: { clipped: true } },
  ],
  rubric: [VISUAL_QUALITY, TASK_COMPLETION],
  expectedScore: [0, 0.25],
  expectedDimensions: { "visual-quality": [1, 2], "task-completion": [1, 2] },
}, {
  id: "broken-functional",
  title: "Polished but nonfunctional inventory",
  prompt: "Build an inventory manager where users can add products and see them in the product list.",
  image: "broken-functional.png",
  checks: [
    { id: "product-create", pass: false, evidence: { error: "Could not save product" } },
    { id: "created-product-visible", pass: false, evidence: { productCount: 0 } },
  ],
  rubric: [VISUAL_QUALITY, TASK_COMPLETION],
  expectedScore: [0.25, 0.625],
  expectedDimensions: { "visual-quality": [3, 5], "task-completion": [1, 2] },
}];
