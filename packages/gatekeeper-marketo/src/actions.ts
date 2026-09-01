// Side-effecting operations: their stored shape, approver-facing descriptions, and execution.
//
// Nothing here runs until the overseer calls applyAction() — the session only ever *submits*.
// Existing lead-database actions are not simulated. Design Studio actions are overlaid separately.

import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { markdownText } from "./approval-markdown";
import type { MarketoClient, RawSyncResult } from "./marketo-api";
import {
  describeDesignStudioAction,
  isDesignStudioAction,
  type DesignStudioAction,
} from "./design-studio-actions";
import {
  describeCampaignAction,
  isCampaignAction,
  type CampaignAction,
} from "./campaign-actions";
import {
  describeProgramAction,
  isProgramAction,
  type ProgramAction,
} from "./program-actions";
import {
  describeEmailDesignerAction,
  isEmailDesignerAction,
  type EmailDesignerAction,
} from "./email-designer-actions";
import {
  describeBusinessObjectAction,
  isBusinessObjectAction,
  type BusinessObjectAction,
} from "./business-object-actions";
import type { MarketoUpsertAction } from "./types";

/** A queued Marketo action. `id` is the gatekeeper-assigned approval id. */
type ExistingMarketoAction =
  | {
      id: number;
      type: "upsertPeople";
      records: Record<string, unknown>[];
      upsertAction: MarketoUpsertAction;
      lookupField: string;
    }
  | { id: number; type: "updatePerson"; personId: number; fields: Record<string, unknown> }
  | { id: number; type: "deletePerson"; personId: number }
  | { id: number; type: "listAdd"; listId: number; listName: string; personIds: number[] }
  | { id: number; type: "listRemove"; listId: number; listName: string; personIds: number[] }
  | {
      id: number;
      type: "programStatus";
      programId: number;
      programName: string;
      personIds: number[];
      status: string;
    }
  | {
      id: number;
      type: "campaignTrigger";
      campaignId: number;
      campaignName: string;
      /** Owning Program, or null when the campaign is not contained by a Program. */
      programId: string | null;
      personIds: number[];
      tokens?: { name: string; value: string }[];
    }
  | {
      id: number;
      type: "campaignSchedule";
      campaignId: number;
      campaignName: string;
      /** Owning Program, or null when the campaign is not contained by a Program. */
      programId: string | null;
      /** ISO 8601; Date isn't stable across DO storage round-trips. */
      runAt: string;
      tokens?: { name: string; value: string }[];
    }
  | { id: number; type: "customObjectUpsert"; apiName: string; records: Record<string, unknown>[] }
  | {
      id: number;
      type: "customObjectDelete";
      apiName: string;
      records: Record<string, unknown>[];
      deleteBy: "dedupeFields" | "idField";
    };

/** Every action persisted by a Marketo binding. */
export type MarketoAction = ExistingMarketoAction | DesignStudioAction | CampaignAction | ProgramAction | EmailDesignerAction | BusinessObjectAction;

/** An action as a session submits it: every variant minus the gatekeeper-assigned `id`.
 * Distributes over the union so each variant keeps its own discriminated shape. */
export type MarketoActionInput = MarketoAction extends infer T
  ? T extends MarketoAction
    ? Omit<T, "id">
    : never
  : never;

/** Maximum UTF-8 size of the complete approval description submitted to the Workshop. */
export const MAX_APPROVAL_DESCRIPTION_BYTES = 128 * 1024;

/** Validate the restrictions Marketo places on person upserts matched by lead id. */
export function validatePeopleUpsertLookup(
  records: Record<string, unknown>[],
  action: MarketoUpsertAction,
  lookupField: string,
): void {
  if (lookupField === "id") {
    if (action !== "updateOnly") {
      throw new Error("Marketo person id matching is available only for updateOnly.");
    }
    if (records.some(record =>
      typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0)) {
      throw new Error("Each record matched by id must contain a positive safe integer id.");
    }
    return;
  }
  if (records.some(record => !Object.hasOwn(record, lookupField) ||
      record[lookupField] === undefined || record[lookupField] === null || record[lookupField] === "")) {
    throw new Error(`Each person record must contain a non-null \`${lookupField}\` lookup field.`);
  }
}

function fieldTable(fields: Record<string, unknown>): string {
  let entries = Object.entries(fields);
  if (entries.length === 0) return "_(no fields)_";
  return entries
    .map(([key, value]) => `- ${markdownText(key)}: ${markdownText(JSON.stringify(value) ?? String(value))}`)
    .join("\n");
}

function recordDetails(records: Record<string, unknown>[]): string {
  return records
    .map((record, index) => `Record ${index + 1}:\n${fieldTable(record)}`)
    .join("\n\n");
}

function tokenDetails(tokens: { name: string; value: string }[]): string {
  return tokens
    .map(token => `- ${markdownText(token.name)}: ${markdownText(JSON.stringify(token.value))}`)
    .join("\n");
}

/** Render the approver-facing description for an action. */
export function describeAction(action: MarketoAction): ActionDescription {
  if (isDesignStudioAction(action)) return describeDesignStudioAction(action);
  if (isCampaignAction(action)) return describeCampaignAction(action);
  if (isProgramAction(action)) return describeProgramAction(action);
  if (isEmailDesignerAction(action)) return describeEmailDesignerAction(action);
  if (isBusinessObjectAction(action)) return describeBusinessObjectAction(action);
  // Not simulated: always ask the agent to wait for the verdict.
  let base = { awaitDecision: true } as const;

  switch (action.type) {
    case "upsertPeople":
      return {
        ...base,
        title: `Create/update ${action.records.length} ${action.records.length === 1 ? "person" : "people"} in Marketo`,
        description:
          `Write **${action.records.length}** person record(s) to Marketo using ` +
          `${markdownText(action.upsertAction)}, matching on ${markdownText(action.lookupField)}.\n\n` +
          recordDetails(action.records),
        implementsRevert: false,
      };

    case "updatePerson":
      return {
        ...base,
        title: `Update Marketo person ${action.personId}`,
        description:
          `Update person ${action.personId} in Marketo:\n\n${fieldTable(action.fields)}`,
        implementsRevert: false,
      };

    case "deletePerson":
      return {
        ...base,
        title: `Delete Marketo person ${action.personId}`,
        description:
          `**Permanently delete** person ${action.personId} from Marketo. ` +
          `Marketo does not support undoing this; the record and its activity history are lost.`,
        implementsRevert: false,
      };

    case "listAdd":
      return {
        ...base,
        title: `Add ${action.personIds.length} to list "${action.listName}"`,
        description:
          `Add **${action.personIds.length}** person(s) to static list ` +
          `**${markdownText(action.listName)}** (${action.listId}).\n\nPerson ids: ${action.personIds.join(", ")}`,
        implementsRevert: false,
      };

    case "listRemove":
      return {
        ...base,
        title: `Remove ${action.personIds.length} from list "${action.listName}"`,
        description:
          `Remove **${action.personIds.length}** person(s) from static list ` +
          `**${markdownText(action.listName)}** (${action.listId}).\n\nPerson ids: ${action.personIds.join(", ")}\n\n` +
          `Removing someone from a list can stop campaigns that depend on that membership.`,
        implementsRevert: false,
      };

    case "programStatus":
      return {
        ...base,
        title: `Set ${action.personIds.length} to "${action.status}" in program ${action.programId}`,
        description:
          `Set program membership status to **${markdownText(action.status)}** for **${action.personIds.length}** ` +
          `person(s) in program ${action.programId}.\n\n` +
          `Person ids: ${action.personIds.join(", ")}\n\n` +
          `Progression changes can trigger campaigns listening for that status.`,
        implementsRevert: false,
      };

    case "campaignTrigger":
      return {
        ...base,
        title: `Run campaign ${action.campaignId} for ${action.personIds.length} people`,
        description:
          `**Run the smart campaign "${markdownText(action.campaignName)}" (${action.campaignId}) immediately** ` +
          `against **${action.personIds.length}** person(s).\n\n` +
          `This executes the campaign's real flow steps, which may **send email or SMS to real ` +
          `people**, change field values, and trigger downstream campaigns. It cannot be undone.\n\n` +
          `Person ids: ${action.personIds.join(", ")}` +
          (action.tokens?.length
            ? `\n\nToken overrides:\n${tokenDetails(action.tokens)}`
            : ""),
        implementsRevert: false,
      };

    case "campaignSchedule":
      return {
        ...base,
        title: `Schedule campaign ${action.campaignId}`,
        description:
          `**Schedule the smart campaign "${markdownText(action.campaignName)}" (${action.campaignId})** to run at ` +
          `**${action.runAt}**.\n\n` +
          `When it runs it executes the campaign's real flow steps against its smart list, which may ` +
          `**send email or SMS to real people**. It cannot be undone from here once scheduled.` +
          (action.tokens?.length
            ? `\n\nToken overrides:\n${tokenDetails(action.tokens)}`
            : ""),
        implementsRevert: false,
      };

    case "customObjectUpsert":
      return {
        ...base,
        title: `Write ${action.records.length} ${action.apiName} record(s)`,
        description:
          `Create or update **${action.records.length}** record(s) of custom object ` +
          `${markdownText(action.apiName)}.\n\n${recordDetails(action.records)}`,
        implementsRevert: false,
      };

    case "customObjectDelete":
      return {
        ...base,
        title: `Delete ${action.records.length} ${action.apiName} record(s)`,
        description:
          `**Permanently delete ${action.records.length}** record(s) of custom object ` +
          `${markdownText(action.apiName)} by ${action.deleteBy ?? "dedupeFields"}. This cannot be undone.\n\n` +
          recordDetails(action.records),
        implementsRevert: false,
      };
  }
}

/** Render an approval and reject it rather than submitting an incomplete oversized description. */
export function describeActionForSubmission(action: MarketoAction): ActionDescription {
  let description = describeAction(action);
  let bytes = new TextEncoder().encode(description.description).byteLength;
  if (bytes > MAX_APPROVAL_DESCRIPTION_BYTES) {
    throw new Error(
      `The complete Marketo approval description must not exceed ${MAX_APPROVAL_DESCRIPTION_BYTES} UTF-8 bytes; split the action into smaller batches or payloads.`,
    );
  }
  return description;
}

/** Perform the action against Marketo. Throws on failure so the overseer can offer a retry. */
export async function executeAction(
  action: ExistingMarketoAction,
  client: MarketoClient,
): Promise<RawSyncResult[]> {
  switch (action.type) {
    case "upsertPeople":
      return await client.syncLeads(action.records, action.upsertAction, action.lookupField);

    case "updatePerson":
      return await client.syncLeads(
        [{ ...action.fields, id: action.personId }],
        "updateOnly",
        "id",
      );

    case "deletePerson":
      return await client.deleteLeads([action.personId]);

    case "listAdd":
      return await client.addLeadsToList(action.listId, action.personIds);

    case "listRemove":
      return await client.removeLeadsFromList(action.listId, action.personIds);

    case "programStatus":
      return await client.setProgramMemberStatus(
        action.programId,
        action.personIds,
        action.status,
      );

    case "campaignTrigger":
      return await client.triggerCampaign(action.campaignId, action.personIds, action.tokens);

    case "campaignSchedule":
      return await client.scheduleCampaign(
        action.campaignId,
        new Date(action.runAt),
        action.tokens,
      );

    case "customObjectUpsert":
      return await client.syncCustomObject(action.apiName, action.records);

    case "customObjectDelete":
      return await client.deleteCustomObject(action.apiName, action.records, action.deleteBy ?? "dedupeFields");

    default:
      throw new Error("Unknown persisted Marketo action type.");
  }
}

/** A non-successful per-record outcome and whether repeating the full request is safe. */
export class MarketoActionResultError extends Error {
  readonly disposition: "none" | "partial" | "uncertain";

  constructor(message: string, disposition: "none" | "partial" | "uncertain") {
    super(message);
    this.name = "MarketoActionResultError";
    this.disposition = disposition;
  }
}

const MIN_SCHEDULE_DELAY_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_DELAY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Revalidate approved inputs immediately before dispatch. */
export function validateActionForDispatch(action: MarketoAction, now = Date.now()): void {
  if (isDesignStudioAction(action) || isCampaignAction(action) || isProgramAction(action) ||
      isEmailDesignerAction(action) || isBusinessObjectAction(action)) return;
  switch (action.type) {
    case "upsertPeople":
      validatePeopleUpsertLookup(action.records, action.upsertAction, action.lookupField);
      return;
    case "campaignTrigger":
    case "campaignSchedule": {
      if (!Object.hasOwn(action, "programId") || action.programId !== null && typeof action.programId !== "string") {
        throw new Error("A persisted Marketo campaign action is missing its reviewed parent ownership.");
      }
      if (action.type === "campaignSchedule") {
        let delay = new Date(action.runAt).getTime() - now;
        if (!Number.isFinite(delay) || delay < MIN_SCHEDULE_DELAY_MS || delay > MAX_SCHEDULE_DELAY_MS) {
          throw new Error("The approved Marketo campaign run time is no longer between 5 minutes and 2 years from dispatch.");
        }
      }
      return;
    }
    case "updatePerson":
    case "deletePerson":
    case "listAdd":
    case "listRemove":
    case "programStatus":
    case "customObjectUpsert":
    case "customObjectDelete":
      return;
    default:
      throw new Error("Unknown persisted Marketo action type.");
  }
}

function identityError(action: MarketoAction): never {
  throw new MarketoActionResultError(
    `Marketo returned a result that does not identify the approved target for ${action.type}, so its outcome is uncertain.`,
    "uncertain",
  );
}

function resultStatus(result: RawSyncResult): string {
  if (typeof result.status !== "string" || result.status.length === 0) {
    throw new MarketoActionResultError(
      "Marketo returned a per-record result without a status, so its outcome is uncertain.",
      "uncertain",
    );
  }
  return result.status.toLowerCase();
}

function hasSubmittedRecordSequence(action: MarketoAction): boolean {
  return action.type === "customObjectUpsert" || action.type === "customObjectDelete" ||
    action.type === "businessObjectUpsert" || action.type === "businessObjectDelete";
}

function assertResultSequence(action: MarketoAction, results: RawSyncResult[]): void {
  if (!hasSubmittedRecordSequence(action)) return;
  let expected = expectedActionResults(action);
  let sequences = new Set<number>();
  if (results.length !== expected || results.some(result => {
    let seq = result.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq >= expected ||
        sequences.has(seq)) return true;
    sequences.add(seq);
    return false;
  })) {
    throw new MarketoActionResultError(
      "Marketo returned invalid submitted-record sequence indexes, so its outcome is uncertain.",
      "uncertain",
    );
  }
}

const UPSERT_RESULT_STATUSES: Record<MarketoUpsertAction, string[]> = {
  createOnly: ["created", "skipped"],
  updateOnly: ["updated", "skipped"],
  createOrUpdate: ["created", "updated", "skipped"],
};

/** Correlate result identities and endpoint statuses with the approved request where Marketo supplies them. */
export function assertActionResultIdentity(action: MarketoAction, results: RawSyncResult[]): void {
  assertResultSequence(action, results);
  let expected: (number | string | undefined)[] | undefined;
  let identity: "id" | "marketoGUID" = "id";
  let statuses: string[] | undefined;
  switch (action.type) {
    case "updatePerson": expected = [action.personId]; statuses = ["updated", "skipped"]; break;
    case "deletePerson": expected = [action.personId]; statuses = ["deleted", "skipped"]; break;
    case "listAdd": expected = action.personIds; statuses = ["added", "skipped"]; break;
    case "listRemove": expected = action.personIds; statuses = ["removed", "skipped"]; break;
    case "programStatus":
      expected = action.personIds;
      // The legacy endpoint can return the progression label or the newer generic outcome.
      statuses = [action.status.toLowerCase(), "updated", "skipped"];
      break;
    case "campaignTrigger": expected = [action.campaignId]; statuses = ["triggered", "queued", "skipped"]; break;
    case "campaignSchedule": expected = [action.campaignId]; statuses = ["scheduled", "queued", "skipped"]; break;
    case "upsertPeople":
      statuses = UPSERT_RESULT_STATUSES[action.upsertAction];
      if (action.lookupField === "id") expected = action.records.map(record => record.id as number | undefined);
      break;
    case "customObjectUpsert":
      statuses = UPSERT_RESULT_STATUSES.createOrUpdate;
      if (action.records.every(record => typeof record.marketoGUID === "string")) {
        identity = "marketoGUID";
        expected = action.records.map(record => record.marketoGUID as string);
      }
      break;
    case "customObjectDelete":
      statuses = ["deleted", "skipped"];
      if (action.deleteBy === "idField") {
        identity = "marketoGUID";
        expected = action.records.map(record => record.marketoGUID as string | undefined);
      }
      break;
    case "businessObjectUpsert": {
      if (!action.action) identityError(action);
      statuses = UPSERT_RESULT_STATUSES[action.action];
      if (action.matchBy === "idField") {
        identity = action.kind === "company" || action.kind === "salesPerson" ? "id" : "marketoGUID";
        expected = action.records.map(record => record[identity] as number | string | undefined);
      }
      break;
    }
    case "businessObjectDelete": {
      statuses = ["deleted", "skipped"];
      if (action.matchBy === "idField") {
        identity = action.kind === "company" || action.kind === "salesPerson" ? "id" : "marketoGUID";
        expected = action.records.map(record => record[identity] as number | string | undefined);
      }
      break;
    }
  }
  for (let [index, result] of results.entries()) {
    let submittedIndex = hasSubmittedRecordSequence(action) ? result.seq! : index;
    let status = (action.type === "campaignTrigger" || action.type === "campaignSchedule") &&
        result.status === undefined
      ? undefined
      : resultStatus(result);
    if (statuses && status !== undefined && !statuses.includes(status)) identityError(action);
    // Marketo commonly omits identity fields for skipped rows. The endpoint's result correlation
    // still identifies the input, and no target mutation was reported for that row.
    if (expected && status !== "skipped" && result[identity] !== expected[submittedIndex]) identityError(action);
  }
}

function assertResultShapes(
  results: unknown[],
  expected: number,
  requireStatus: boolean,
): asserts results is RawSyncResult[] {
  if (
    results.length === 0 ||
    results.length !== expected ||
    results.some(result => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return true;
      let value = result as Record<string, unknown>;
      if (value.id !== undefined && (!Number.isSafeInteger(value.id) || Number(value.id) <= 0)) return true;
      if (value.marketoGUID !== undefined &&
          (typeof value.marketoGUID !== "string" || value.marketoGUID.length === 0)) return true;
      if (value.status !== undefined && (typeof value.status !== "string" || value.status.length === 0)) return true;
      if (value.status === undefined && (requireStatus || value.reasons !== undefined)) {
        return true;
      }
      if (value.reasons !== undefined && (
        !Array.isArray(value.reasons) ||
        value.reasons.some(reason => {
          if (!reason || typeof reason !== "object" || Array.isArray(reason)) return true;
          let detail = reason as Record<string, unknown>;
          return detail.code !== undefined && typeof detail.code !== "string" ||
            detail.message !== undefined && typeof detail.message !== "string";
        })
      )) return true;
      return !(
        (Number.isSafeInteger(value.id) && Number(value.id) > 0) ||
        (typeof value.marketoGUID === "string" && value.marketoGUID.length > 0) ||
        (typeof value.status === "string" && value.status.length > 0)
      );
    })
  ) {
    throw new MarketoActionResultError(
      `Marketo accepted the request but returned ${results.length} of ${expected} expected result(s), ` +
        "so its outcome is uncertain.",
      "uncertain",
    );
  }
}

/** Validate the single campaign request/schedule result, including its campaign identity. */
export function assertCampaignRequestResults(
  action: Extract<MarketoAction, { type: "campaignTrigger" | "campaignSchedule" }>,
  results: unknown[],
): void {
  assertResultShapes(results, 1, false);
  assertActionResultIdentity(action, results);
  if (results[0].status !== undefined) assertApplied(results, 1);
}

/** Number of per-record outcomes expected from an action. */
export function expectedActionResults(action: MarketoAction): number {
  if (isDesignStudioAction(action)) return 1;
  if (isCampaignAction(action)) return 1;
  if (isProgramAction(action)) return 1;
  if (isEmailDesignerAction(action)) return 1;
  if (isBusinessObjectAction(action)) return action.records.length;
  switch (action.type) {
    case "upsertPeople":
    case "customObjectUpsert":
    case "customObjectDelete":
      return action.records.length;
    case "listAdd":
    case "listRemove":
    case "programStatus":
      return action.personIds.length;
    case "updatePerson":
    case "deletePerson":
    case "campaignTrigger":
    case "campaignSchedule":
      return 1;
  }
}

/** Validate the per-record outcomes returned for an action. */
export function assertActionResults(
  action: MarketoAction,
  results: unknown[],
): asserts results is RawSyncResult[] {
  assertResultShapes(results, expectedActionResults(action), true);
  assertResultSequence(action, results);
}

/** Fail unless Marketo reports a complete, non-skipped result. */
export function assertApplied(results: unknown[], expected = results.length): void {
  assertResultShapes(results, expected, true);
  let skipped = results.filter(r => resultStatus(r) === "skipped");
  if (skipped.length === 0) return;
  let codes = [
    ...new Set(skipped.flatMap(r => (r.reasons ?? [])
      .map(reason => reason.code)
      .filter((code): code is string => typeof code === "string" && /^\d{3,6}$/.test(code)))),
  ];
  let detail = codes.length > 0 ? ` (Marketo code${codes.length === 1 ? "" : "s"}: ${codes.join(", ")})` : "";
  let partial = skipped.length < results.length;
  throw new MarketoActionResultError(
    partial
      ? `Marketo applied ${results.length - skipped.length} of ${results.length} record(s) and declined ${skipped.length}` +
          `${detail}.`
      : `Marketo declined all ${results.length} record(s), so nothing was changed` +
          `${detail}.`,
    partial ? "partial" : "none",
  );
}
