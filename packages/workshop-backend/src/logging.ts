import { createLogger } from "@gadgets/backend-utils/context-logger";

/** Structured fields emitted by the Workshop backend. */
export type WorkshopLogFields = {
  accountId: number;
  actionId: number | string;
  autoProvisioned: boolean;
  callbackInitiated: boolean;
  chatId: number;
  durationMs: number;
  eventName: string;
  executionId: string;
  gadgetId: string;
  gatekeeperId: number | string;
  modelId: string;
  observerId: string;
  operation: string;
  outcome: "ok" | "error" | "usage_limit" | "callbacks_stalled" | "no_email" | "signups_disabled";
  path: string;
  resourceTitle: string;
  size: number;
  status: number;
  statusCode: number;
  statusText: string;
  toolCallId: string;
  toolName: string;
  vendorId: string;
};

/** Creates a logger restricted to the Workshop backend's field vocabulary. */
export function createWorkshopLogger(component: string) {
  return createLogger<WorkshopLogFields>({ component });
}
