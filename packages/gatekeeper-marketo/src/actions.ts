// Side-effecting operations: their stored shape, approver-facing descriptions, and execution.
//
// Nothing here runs until the overseer calls applyAction() — the session only ever *submits*.
// Existing lead-database actions are not simulated. Design Studio actions are overlaid separately.

import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
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

/** A queued Marketo action. `id` is the gatekeeper-assigned approval id. */
type ExistingMarketoAction =
  | {
      id: number;
      type: "upsertPeople";
      records: Record<string, unknown>[];
      upsertAction: string;
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
      personIds: number[];
      tokens?: { name: string; value: string }[];
    }
  | {
      id: number;
      type: "campaignSchedule";
      campaignId: number;
      campaignName: string;
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

const MAX_LISTED_IDS = 20;

function summarizeIds(ids: number[]): string {
  if (ids.length <= MAX_LISTED_IDS) return ids.join(", ");
  return `${ids.slice(0, MAX_LISTED_IDS).join(", ")} … (+${ids.length - MAX_LISTED_IDS} more)`;
}

function escapeMarkdown(value: string): string {
  let controls = new Set("\\`*_{}[]()#+.!|>~-");
  return [...value].map(character => controls.has(character) ? `\\${character}` : character).join("");
}

function fieldTable(fields: Record<string, unknown>): string {
  let entries = Object.entries(fields);
  if (entries.length === 0) return "_(no fields)_";
  return entries
    .map(([key, value]) => `- ${escapeMarkdown(key)}: ${escapeMarkdown(JSON.stringify(value) ?? String(value))}`)
    .join("\n");
}

function recordDetails(records: Record<string, unknown>[]): string {
  return records
    .map((record, index) => `Record ${index + 1}:\n${fieldTable(record)}`)
    .join("\n\n");
}

function tokenDetails(tokens: { name: string; value: string }[]): string {
  return tokens
    .map(token => `- ${escapeMarkdown(token.name)}: ${escapeMarkdown(JSON.stringify(token.value))}`)
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
          `${escapeMarkdown(action.upsertAction)}, matching on ${escapeMarkdown(action.lookupField)}.\n\n` +
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
          `**${escapeMarkdown(action.listName)}** (${action.listId}).\n\nPerson ids: ${summarizeIds(action.personIds)}`,
        implementsRevert: false,
      };

    case "listRemove":
      return {
        ...base,
        title: `Remove ${action.personIds.length} from list "${action.listName}"`,
        description:
          `Remove **${action.personIds.length}** person(s) from static list ` +
          `**${escapeMarkdown(action.listName)}** (${action.listId}).\n\nPerson ids: ${summarizeIds(action.personIds)}\n\n` +
          `Removing someone from a list can stop campaigns that depend on that membership.`,
        implementsRevert: false,
      };

    case "programStatus":
      return {
        ...base,
        title: `Set ${action.personIds.length} to "${action.status}" in "${action.programName}"`,
        description:
          `Set program membership status to **${escapeMarkdown(action.status)}** for **${action.personIds.length}** ` +
          `person(s) in program **${escapeMarkdown(action.programName)}** (${action.programId}).\n\n` +
          `Person ids: ${summarizeIds(action.personIds)}\n\n` +
          `Progression changes can trigger campaigns listening for that status.`,
        implementsRevert: false,
      };

    case "campaignTrigger":
      return {
        ...base,
        title: `Run campaign ${action.campaignId} for ${action.personIds.length} people`,
        description:
          `**Run the smart campaign "${escapeMarkdown(action.campaignName)}" (${action.campaignId}) immediately** ` +
          `against **${action.personIds.length}** person(s).\n\n` +
          `This executes the campaign's real flow steps, which may **send email or SMS to real ` +
          `people**, change field values, and trigger downstream campaigns. It cannot be undone.\n\n` +
          `Person ids: ${summarizeIds(action.personIds)}` +
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
          `**Schedule the smart campaign "${escapeMarkdown(action.campaignName)}" (${action.campaignId})** to run at ` +
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
          `${escapeMarkdown(action.apiName)}.\n\n${recordDetails(action.records)}`,
        implementsRevert: false,
      };

    case "customObjectDelete":
      return {
        ...base,
        title: `Delete ${action.records.length} ${action.apiName} record(s)`,
        description:
          `**Permanently delete ${action.records.length}** record(s) of custom object ` +
          `${escapeMarkdown(action.apiName)} by ${action.deleteBy ?? "dedupeFields"}. This cannot be undone.\n\n` +
          recordDetails(action.records),
        implementsRevert: false,
      };
  }
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

/** Fail unless Marketo reports a complete, non-skipped result. */
export function assertApplied(results: RawSyncResult[], expected = results.length): void {
  if (
    results.length === 0 ||
    results.length !== expected ||
    results.some(result => {
      if (!result || typeof result !== "object") return true;
      return !(
        (Number.isSafeInteger(result.id) && Number(result.id) > 0) ||
        (typeof result.marketoGUID === "string" && result.marketoGUID.length > 0) ||
        (typeof result.status === "string" && result.status.length > 0)
      );
    })
  ) {
    throw new MarketoActionResultError(
      `Marketo accepted the request but returned ${results.length} of ${expected} expected result(s), ` +
        "so its outcome is uncertain.",
      "uncertain",
    );
  }
  let skipped = results.filter(r => r.status === "skipped");
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
