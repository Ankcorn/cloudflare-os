import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt, buildWorkersAiJudgeRequest, normalizedQualityScore, outcomeScore,
  parseJudgeResponse, parseJudgement, requestOutcomeJudgement,
} from "./outcome-judge.js";
import type { WorkshopEvalTask, WorkshopRunOutput } from "./task.js";

const task: WorkshopEvalTask = {
  id: "dashboard",
  title: "Dashboard",
  expectation: "required",
  turns: [{ prompt: "Build a polished dashboard", verify: async () => [] }],
  rubric: [
    { id: "hierarchy", criterion: "Clear visual hierarchy", weight: 2 },
    { id: "responsive", criterion: "Works well on mobile", weight: 1 },
  ],
};

const artifact = { path: "output/a.png", sha256: "abc", bytes: 3, mimeType: "image/png" };
const output: WorkshopRunOutput = {
  taskId: task.id,
  taskTitle: task.title,
  expectation: task.expectation,
  model: "agent-model",
  trial: 0,
  runId: "run",
  workspaceId: "workspace",
  chatId: 4,
  turns: [{
    index: 0,
    checks: [{ id: "works", pass: true, evidence: "UNTRUSTED_EVIDENCE" }],
    agentDurationMs: 9_999,
    verificationDurationMs: 8_888,
  }],
  gadgets: [{
    id: 1,
    title: "My Dashboard",
    desktop: artifact,
    mobile: artifact,
    pdf: artifact,
    source: [{ path: "SECRET_SOURCE", sha256: "def", bytes: 10 }],
    renderErrors: [],
  }],
  functionalPassed: true,
  agentErrors: ["SECRET_AGENT_ERROR"],
  agentUsage: {
    complete: true,
    successfulRequests: 1,
    failedRequests: 7,
    inputTokens: 111,
    outputTokens: 222,
    totalTokens: 333,
    durationMs: 444,
    costUsd: 555,
  },
  wallDurationMs: 7_777,
  diagnostics: { path: "SECRET_TRANSCRIPT", sha256: "ghi", bytes: 20 },
};

describe("parseJudgement", () => {
  it("requires every expected rubric ID exactly once", () => {
    const valid = JSON.stringify({
      dimensions: [
        { id: "hierarchy", score: 5, rationale: "Strong" },
        { id: "responsive", score: 3, rationale: "Usable" },
      ],
      summary: "Good result",
    });
    expect(parseJudgement(valid, task).dimensions).toHaveLength(2);

    expect(() => parseJudgement(JSON.stringify({
      dimensions: [
        { id: "hierarchy", score: 5, rationale: "Strong" },
        { id: "hierarchy", score: 3, rationale: "Repeated" },
      ],
      summary: "Bad",
    }), task)).toThrow("duplicate rubric IDs");

    expect(() => parseJudgement(JSON.stringify({
      dimensions: [{ id: "hierarchy", score: 5, rationale: "Strong" }],
      summary: "Incomplete",
    }), task)).toThrow("did not match");
  });

  it("rejects malformed tool arguments", () => {
    expect(() => parseJudgement("not json", task)).toThrow("malformed tool arguments");
    expect(() => parseJudgement(JSON.stringify({ dimensions: [], summary: "" }), task))
        .toThrow("invalid judgement");
  });

  it("rejects malformed or missing forced tool responses", () => {
    expect(() => parseJudgeResponse("not json", task)).toThrow("malformed response");
    expect(() => parseJudgeResponse(JSON.stringify({ choices: [{ message: { tool_calls: [] } }] }), task))
        .toThrow("malformed response");
    expect(() => parseJudgeResponse(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: "other", arguments: "{}" } }] } }],
    }), task)).toThrow("exactly one submit_judgement");
  });
});

describe("outcome scoring", () => {
  it("normalizes and weights 1-5 rubric scores", () => {
    const judgement = parseJudgement(JSON.stringify({
      dimensions: [
        { id: "hierarchy", score: 5, rationale: "Strong" },
        { id: "responsive", score: 1, rationale: "Broken" },
      ],
      summary: "Mixed",
    }), task);
    expect(normalizedQualityScore(task.rubric ?? [], judgement)).toBeCloseTo(2 / 3);
  });

  it("zeros the outcome when deterministic verification failed", () => {
    expect(outcomeScore(false, 0.9)).toBe(0);
    expect(outcomeScore(true, 0.9)).toBe(0.9);
  });
});

describe("judge prompt projection", () => {
  it("includes trusted outcomes and excludes diagnostics and efficiency data", () => {
    const prompt = buildJudgePrompt(task, output);
    expect(prompt).toContain("Build a polished dashboard");
    expect(prompt).toContain("Clear visual hierarchy");
    expect(prompt).toContain("My Dashboard");
    expect(prompt).toContain("works");
    expect(prompt).not.toContain("UNTRUSTED_EVIDENCE");
    expect(prompt).not.toContain("SECRET_SOURCE");
    expect(prompt).not.toContain("SECRET_TRANSCRIPT");
    expect(prompt).not.toContain("SECRET_AGENT_ERROR");
    expect(prompt).not.toContain("9999");
    expect(prompt).not.toContain("555");
  });

  it("uses the documented OpenAI-compatible image_url content shape", () => {
    const request = buildWorkersAiJudgeRequest(task, output, [{
      title: "My Dashboard",
      viewport: "desktop",
      dataUrl: "data:image/png;base64,AAAA",
    }], "judge-model", 42);
    expect(request).toMatchObject({
      model: "judge-model",
      stream: false,
      temperature: 0,
      seed: 42,
      messages: [{ role: "system" }, {
        role: "user",
        content: [
          { type: "text" },
          { type: "text", text: "Rendered evidence: \"My Dashboard\", desktop viewport." },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
      tool_choice: { type: "function", function: { name: "submit_judgement" } },
    });
  });

  it("uses the account AI REST endpoint with Gateway attribution headers", async () => {
    let request: Request | undefined;
    const judgement = JSON.stringify({
      dimensions: [
        { id: "hierarchy", score: 5, rationale: "Strong" },
        { id: "responsive", score: 4, rationale: "Responsive" },
      ],
      summary: "Good",
    });
    await requestOutcomeJudgement(
        task,
        output,
        [],
        { accountId: "account", apiToken: "token", gatewayId: "gateway" },
        "judge-model",
        42,
        (input, init) => {
          request = new Request(input, init);
          return Promise.resolve(Response.json({
            choices: [{
              message: {
                tool_calls: [{
                  function: { name: "submit_judgement", arguments: judgement },
                }],
              },
            }],
          }));
        });

    expect(request?.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer token");
    expect(request?.headers.get("cf-aig-gateway-id")).toBe("gateway");
    expect(request?.headers.get("cf-aig-metadata")).toContain(output.runId);
  });
});
