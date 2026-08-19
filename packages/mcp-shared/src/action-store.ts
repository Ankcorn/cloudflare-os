// Durable lifecycle for approval-gated MCP tool calls. The owning facet supplies its isolated SQLite
// database; claims are persisted before external I/O so an interrupted write is never replayed.

import {
  ACTION_INVALIDATED_ERROR_CODE,
  createActionInvalidatedError,
  createActionRestageRequiredError,
  getActionRestageRequiredReason,
} from "@gadgets/workshop-shared/gatekeeper";
import { callMayHaveTakenEffect, type McpClient, type McpToolCallResult } from "./client.js";
import type { McpLog } from "./log.js";
import type { StoredAction } from "./session.js";
import { toCallResult } from "./tools.js";

const MAX_RESULT_BYTES = 128 * 1024;
const MAX_RETAINED_ACTIONS = 100;
const MAX_PENDING_ACTIONS = 50;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const encoder = new TextEncoder();

type ActionRow = {
  id: number;
  tool_name: string;
  args_json: string;
  state: StoredAction["state"];
  submitted_at: number;
  policy_fingerprint: string | null;
  connection_generation: number | null;
  dispatched: number | null;
  claimed_at: number | null;
  retryable: number | null;
  result_json: string | null;
  error: string | null;
};

function fromRow(row: ActionRow): StoredAction {
  return {
    id: row.id,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    state: row.state,
    submittedAt: row.submitted_at,
    policyFingerprint: row.policy_fingerprint ?? undefined,
    connectionGeneration: row.connection_generation ?? undefined,
    dispatched: row.dispatched === null ? undefined : row.dispatched === 1,
    claimedAt: row.claimed_at ?? undefined,
    retryable: row.retryable === null ? undefined : row.retryable === 1,
    result: row.result_json
      ? JSON.parse(row.result_json) as StoredAction["result"]
      : undefined,
    error: row.error ?? undefined,
  };
}

/** Reported when a claim expired: the call was dispatched but its outcome was never observed. */
export const APPLY_OUTCOME_UNKNOWN_MESSAGE =
  "This call was interrupted after it had been sent, so it may or may not have taken effect. " +
  "Check the server before trying it again.";

/** The approved tool or account policy changed before dispatch, so the action must be restaged. */
export class ActionInvalidatedError extends Error {
  /** Stable code retained when this error crosses the gatekeeper RPC boundary. */
  readonly errorCode = ACTION_INVALIDATED_ERROR_CODE;
  /** Human-readable reason stored separately from the serialized discriminator. */
  readonly reason: string;

  constructor(reason: string) {
    super(createActionInvalidatedError(reason).message);
    this.name = "ActionInvalidatedError";
    this.reason = reason;
  }
}

/** Stores queued MCP actions in one facet-local SQLite table. */
export class ActionStore {
  #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL CHECK (json_valid(args_json) AND json_type(args_json) = 'object'),
      state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'rejected', 'failed')),
      submitted_at INTEGER NOT NULL,
      policy_fingerprint TEXT,
      connection_generation INTEGER,
      dispatched INTEGER CHECK (dispatched IS NULL OR dispatched IN (0, 1)),
      claimed_at INTEGER,
      retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error TEXT
    ) STRICT`);
    const columns = new Set(
      sql.exec<{ name: string }>(
        "SELECT name FROM pragma_table_info('mcp_actions')",
      ).toArray().map(column => column.name),
    );
    if (!columns.has("policy_fingerprint")) {
      sql.exec("ALTER TABLE mcp_actions ADD COLUMN policy_fingerprint TEXT");
    }
    if (!columns.has("connection_generation")) {
      sql.exec("ALTER TABLE mcp_actions ADD COLUMN connection_generation INTEGER");
    }
    if (!columns.has("dispatched")) {
      sql.exec("ALTER TABLE mcp_actions ADD COLUMN dispatched INTEGER");
    }
    // A fresh store means a fresh Durable Object activation. Any persisted claim belonged to an
    // interrupted prior activation and must never be replayed because the write may have landed.
    sql.exec(
      `UPDATE mcp_actions SET state = 'failed', retryable = 0, error = ?
       WHERE state = 'applying' AND dispatched IS NOT 0`,
      APPLY_OUTCOME_UNKNOWN_MESSAGE,
    );
    sql.exec(
      `UPDATE mcp_actions SET state = 'failed', retryable = 1,
         error = 'This call was interrupted before it was sent. Try applying it again.'
       WHERE state = 'applying' AND dispatched = 0`,
    );
    this.#prune();
  }

  get(id: number): StoredAction | undefined {
    const row = this.#sql.exec<ActionRow>(
      "SELECT * FROM mcp_actions WHERE id = ?", id).toArray()[0];
    return row && fromRow(row);
  }

  #save(action: StoredAction): void {
    this.#sql.exec(
      `UPDATE mcp_actions SET state = ?, claimed_at = ?, retryable = ?, result_json = ?, error = ?,
         dispatched = ?
       WHERE id = ?`,
      action.state,
      action.claimedAt ?? null,
      action.retryable === undefined ? null : Number(action.retryable),
      action.result === undefined ? null : JSON.stringify(action.result),
      action.error ?? null,
      action.dispatched === undefined ? null : Number(action.dispatched),
      action.id,
    );
  }

  stage(
    toolName: string,
    args: Record<string, unknown>,
    snapshot: { policyFingerprint: string; connectionGeneration: number },
  ): StoredAction {
    let argsJson: string;
    let storedArgs: Record<string, unknown>;
    try {
      argsJson = JSON.stringify(args);
      storedArgs = JSON.parse(argsJson) as Record<string, unknown>;
      if (storedArgs === null || Array.isArray(storedArgs)) throw new Error();
    } catch {
      throw new Error("MCP tool arguments must be JSON-compatible.");
    }
    if (encoder.encode(argsJson).byteLength > MAX_ARGUMENT_BYTES) {
      throw new Error(`MCP tool arguments are too large (maximum ${MAX_ARGUMENT_BYTES} bytes).`);
    }

    const { count } = this.#sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM mcp_actions WHERE state IN ('pending', 'applying')",
    ).one();
    if (count >= MAX_PENDING_ACTIONS) {
      throw new Error(
        `${MAX_PENDING_ACTIONS} calls to this MCP server are already awaiting approval. Wait for ` +
        "them to be approved or rejected before queueing more.");
    }

    const submittedAt = Date.now();
    const { id } = this.#sql.exec<{ id: number }>(
      `INSERT INTO mcp_actions (
         tool_name, args_json, state, submitted_at, policy_fingerprint, connection_generation
       ) VALUES (?, ?, 'pending', ?, ?, ?) RETURNING id`,
       toolName, argsJson, submittedAt, snapshot.policyFingerprint, snapshot.connectionGeneration,
    ).one();
    return { id, toolName, args: storedArgs, state: "pending", submittedAt, ...snapshot };
  }

  discard(id: number): void {
    this.#sql.exec("DELETE FROM mcp_actions WHERE id = ? AND state = 'pending'", id);
  }

  /** Closes an old queued action that cannot be checked against an approval-policy snapshot. */
  markRestageRequired(id: number, reason: string): void {
    const stored = this.get(id);
    if (!stored) throw new Error(`MCP action ${id} is unknown.`);
    stored.state = "failed";
    stored.claimedAt = undefined;
    stored.retryable = false;
    stored.dispatched = false;
    stored.result = undefined;
    stored.error = createActionRestageRequiredError(reason).message;
    this.#save(stored);
    this.#prune();
  }

  async apply(
    id: number,
    call: (fn: (client: McpClient) => Promise<McpToolCallResult>) => Promise<McpToolCallResult>,
    log: McpLog,
  ): Promise<void> {
    const stored = this.get(id);
    if (!stored) throw new Error(`MCP action ${id} is unknown.`);
    if (stored.state === "applied") return;
    if (stored.state === "rejected") throw new Error(`MCP action ${id} was already rejected.`);
    if (stored.state === "failed" && stored.retryable === false) {
      if (stored.dispatched === false) {
        const restageReason = getActionRestageRequiredReason(new Error(stored.error ?? ""));
        if (restageReason !== undefined) throw createActionRestageRequiredError(restageReason);
        throw new ActionInvalidatedError(
          stored.error ?? "This MCP action became invalid before dispatch.");
      }
      throw new Error(stored.error ?? `MCP action ${id} cannot be retried.`);
    }
    if (stored.state === "applying") {
      throw new Error(`MCP action ${id} is already being applied.`);
    }

    stored.state = "applying";
    stored.claimedAt = Date.now();
    stored.dispatched = false;
    stored.error = undefined;
    stored.result = undefined;
    this.#save(stored);

    let result: McpToolCallResult;
    let dispatched = false;
    try {
      result = await call(client => {
        dispatched = true;
        stored.dispatched = true;
        this.#save(stored);
        return client.callTool(stored.toolName, stored.args);
      });
    } catch (err) {
      if (err instanceof ActionInvalidatedError) {
        stored.state = "failed";
        stored.retryable = false;
        stored.dispatched = false;
        stored.error = err.reason;
        this.#save(stored);
        this.#prune();
        log.warn("tool call invalidated before dispatch", {
          event: "action.apply.invalidated", actionId: id, toolName: stored.toolName, error: err,
        });
        throw err;
      }
      const mayHaveLanded = dispatched && callMayHaveTakenEffect(err);
      stored.state = "failed";
      stored.retryable = !mayHaveLanded;
      stored.error = mayHaveLanded
        ? "This call failed after it had been sent, so it may or may not have taken effect. " +
          "Check the server before staging it again."
        : err instanceof Error ? err.message : String(err);
      this.#save(stored);
      this.#prune();
      log.warn("tool call failed", {
        event: mayHaveLanded ? "action.apply.outcome-unknown" : "action.apply.failed",
        actionId: id, toolName: stored.toolName, error: err,
      });
      throw mayHaveLanded ? new Error(stored.error, { cause: err }) : err;
    }

    stored.state = "applied";
    stored.retryable = undefined;
    try {
      const flattened = toCallResult(result);
      const encoded = JSON.stringify(flattened);
      const bytes = encoder.encode(encoded).byteLength;
      stored.result = bytes > MAX_RESULT_BYTES
        ? {
            status: "ok",
            content: [],
            text: `(The server's response was too large to retain: ${bytes} bytes.)`,
            isError: flattened.isError,
          }
        : flattened;
    } catch (err) {
      stored.result = {
        status: "ok",
        content: [],
        text: "(The call succeeded, but its response could not be read back.)",
      };
      log.warn("could not record tool call result", {
        event: "action.result.unreadable", actionId: id, toolName: stored.toolName, error: err,
      });
    }
    this.#save(stored);
    this.#prune();
    log.info("tool call applied", { event: "action.applied", actionId: id, toolName: stored.toolName });
  }

  reject(id: number): void {
    const stored = this.get(id);
    if (!stored || stored.state === "rejected") return;
    if (stored.state !== "pending") {
      throw new Error(stored.state === "applying"
        ? `MCP action ${id} is already being applied.`
        : `MCP action ${id} is already ${stored.state}.`);
    }
    this.#sql.exec("UPDATE mcp_actions SET state = 'rejected' WHERE id = ?", id);
    this.#prune();
  }

  #prune(): void {
    this.#sql.exec(`DELETE FROM mcp_actions WHERE id IN (
      SELECT id FROM mcp_actions
      WHERE state NOT IN ('pending', 'applying')
      ORDER BY id DESC LIMIT -1 OFFSET ${MAX_RETAINED_ACTIONS}
    )`);
  }
}

/** Message returned when a caller asks to revert an MCP action. */
export const REVERT_UNSUPPORTED_MESSAGE =
  "MCP tools do not describe how to undo themselves, so this action cannot be reverted " +
  "automatically. Undo it directly in the target system if needed.";
