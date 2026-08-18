import type { JsonValue } from "@vitest-evals/core";
import type { AgentSession } from "@gadgets/integration-tests/agent-session";
import type { GadgetBindingInfo, WorkpieceId, WorkpieceSummary } from "@gadgets/workshop-shared/api";

/** One deterministic outcome observed by a task verifier. */
export type WorkshopCheckResult = {
  /** Stable check identifier within the task. */
  id: string;
  /** Whether the observable requirement held. */
  pass: boolean;
  /** Optional JSON-safe evidence supporting the result. */
  evidence?: JsonValue;
};

/** One quality dimension assessed from the final rendered outcome. */
export type WorkshopRubricDimension = {
  /** Stable dimension identifier within the task. */
  id: string;
  /** Trusted criterion supplied to the outcome judge. */
  criterion: string;
  /** Positive relative contribution to the quality score. */
  weight: number;
};

/** Branch-aware public capabilities available to deterministic verification. */
export interface WorkshopVerificationContext {
  /** Chat whose provisional branch is under verification. */
  readonly chatId: number;
  /** Workpieces visible after the current turn. */
  readonly workpieces: readonly WorkpieceSummary[];
  /** Connects to a Gadget's provisional server implementation. The caller owns the returned stub. */
  connect: AgentSession["connectToProvisionalGadget"];
  /** Lists bindings including additions provisional to the current chat. */
  listBindings(workpieceId: WorkpieceId): Promise<readonly GadgetBindingInfo[]>;
}

/** One prompt and its outcome verifier in a multi-turn task. */
export type WorkshopEvalTurn = {
  /** User prompt sent to the production Workshop agent. */
  prompt: string;
  /** Verifies the resulting provisional branch without accepting it. */
  verify(context: WorkshopVerificationContext): Promise<readonly WorkshopCheckResult[]>;
};

/** Authored Workshop evaluation case. */
export type WorkshopEvalTask = {
  /** Stable logical task identifier. */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Whether the task belongs to the required or exploratory result set. */
  expectation: "required" | "frontier";
  /** Prompts executed in order within one fresh session. */
  turns: readonly [WorkshopEvalTurn, ...WorkshopEvalTurn[]];
  /** Optional rendered-quality dimensions. */
  rubric?: readonly WorkshopRubricDimension[];
};

/** JSON-safe configuration for one logical task repetition. */
export type WorkshopRunInput = {
  /** Agent model exposed by the in-memory Workshop configuration. */
  model: string;
  /** Zero-based repetition index. */
  trial: number;
  /** Stable identifier shared with judge Gateway metadata. */
  runId: string;
};

/** Content-addressed file emitted by an eval run. */
export type WorkshopArtifact = {
  /** Path relative to the package directory. */
  path: string;
  /** Lowercase SHA-256 digest of the file bytes. */
  sha256: string;
  /** File size in bytes. */
  bytes: number;
  /** Media type when the artifact has one. */
  mimeType?: string;
  /** Original logical name when the stored path is content-addressed. */
  logicalName?: string;
};

/** Render and source artifacts for one final Gadget. */
export type WorkshopGadgetArtifact = {
  /** Workspace-local workpiece ID. */
  id: WorkpieceId;
  /** Final display title. */
  title: string;
  /** Desktop viewport PNG, absent when the Gadget did not render successfully. */
  desktop?: WorkshopArtifact;
  /** Mobile viewport PNG, absent when the Gadget did not render successfully. */
  mobile?: WorkshopArtifact;
  /** PDF render-smoke output, absent when the Gadget did not render successfully. */
  pdf?: WorkshopArtifact;
  /** Accepted source files belonging to this workpiece. */
  source: WorkshopArtifact[];
  /** Bounded render failures keyed by output format. */
  renderErrors: string[];
};

/** Checks and timings collected after one agent turn. */
export type WorkshopTurnResult = {
  /** Zero-based turn index. */
  index: number;
  /** Deterministic checks returned by the turn verifier. */
  checks: WorkshopCheckResult[];
  /** Agent execution wall time. */
  agentDurationMs: number;
  /** Deterministic verification wall time. */
  verificationDurationMs: number;
};

/** Normalized AI Gateway usage for a set of requests. */
export type WorkshopGatewayUsage = {
  /** Whether logs and their provider-reported costs were available after bounded polling. */
  complete: boolean;
  /** Successful request count. */
  successfulRequests: number;
  /** Failed request count. */
  failedRequests: number;
  /** Sum of provider input tokens. */
  inputTokens: number;
  /** Sum of provider output tokens. */
  outputTokens: number;
  /** Sum of input and output tokens. */
  totalTokens: number;
  /** Sum of model request durations. */
  durationMs: number;
  /** Sum of provider-reported cost. */
  costUsd: number;
};

/** JSON-safe outcome returned by the Workshop harness and stored in Vitest metadata. */
export type WorkshopRunOutput = {
  /** Stable task identifier. */
  taskId: string;
  /** Human-readable task title. */
  taskTitle: string;
  /** Required or frontier grouping. */
  expectation: WorkshopEvalTask["expectation"];
  /** Agent model used by the run. */
  model: string;
  /** Zero-based repetition index. */
  trial: number;
  /** Stable run identifier. */
  runId: string;
  /** Workspace identifier used for Gateway log attribution. */
  workspaceId: string;
  /** Chat used for all turns. */
  chatId: number;
  /** Per-turn deterministic results and timings. */
  turns: WorkshopTurnResult[];
  /** Final Gadget artifacts. */
  gadgets: WorkshopGadgetArtifact[];
  /** Whether every deterministic check passed. */
  functionalPassed: boolean;
  /** Errors emitted into canonical chat history. */
  agentErrors: string[];
  /** Agent-only AI Gateway telemetry. */
  agentUsage: WorkshopGatewayUsage;
  /** End-to-end harness wall time. */
  wallDurationMs: number;
  /** Content-addressed canonical transcript diagnostics. */
  diagnostics: WorkshopArtifact;
};
