import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { MarketoClient, RawSyncResult } from "./marketo-api";
import type { MarketoBusinessObjectKind, MarketoBusinessObjectMatchBy, MarketoUpsertAction } from "./types";

/** A persisted standard business-object mutation. */
export type BusinessObjectAction = {
  id: number;
  type: "businessObjectUpsert" | "businessObjectDelete";
  kind: MarketoBusinessObjectKind;
  records: Record<string, unknown>[];
  matchBy: MarketoBusinessObjectMatchBy;
  action?: MarketoUpsertAction;
  changedFields: string[];
};

/** A business-object mutation before the binding assigns its approval id. */
export type BusinessObjectActionInput = Omit<BusinessObjectAction, "id">;

/** Whether an action is a standard business-object mutation. */
export function isBusinessObjectAction(action: { type: string }): action is BusinessObjectAction {
  return action.type === "businessObjectUpsert" || action.type === "businessObjectDelete";
}

function label(kind: MarketoBusinessObjectKind): string {
  return ({
    company: "company",
    opportunity: "opportunity",
    opportunityRole: "opportunity role",
    salesPerson: "sales person",
    namedAccount: "named account",
  })[kind];
}

const MAX_DESCRIBED_RECORDS = 10;
const MAX_KEY_VALUE_LENGTH = 80;

function escapeMarkdown(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}

function keyValue(value: unknown): string {
  let serialized = typeof value === "string"
    ? JSON.stringify(value)
    : typeof value === "number" || typeof value === "boolean" || value === null
      ? String(value)
      : "[complex value]";
  let bounded = serialized.length > MAX_KEY_VALUE_LENGTH
    ? `${serialized.slice(0, MAX_KEY_VALUE_LENGTH)}...`
    : serialized;
  return escapeMarkdown(bounded);
}

function matchFields(action: BusinessObjectAction): string[] {
  if (action.matchBy === "idField") {
    return [action.kind === "opportunity" || action.kind === "opportunityRole" || action.kind === "namedAccount"
      ? "marketoGUID"
      : "id"];
  }
  return ({
    company: ["externalCompanyId"],
    opportunity: ["externalOpportunityId"],
    opportunityRole: ["externalOpportunityId", "leadId", "role"],
    salesPerson: ["externalSalesPersonId"],
    namedAccount: ["name"],
  })[action.kind];
}

function targetDetails(action: BusinessObjectAction): string {
  let keys = matchFields(action);
  let records = action.records.slice(0, MAX_DESCRIBED_RECORDS).map((record, index) =>
    `- Record ${index + 1}: ${keys.map(key => `${escapeMarkdown(key)} = ${keyValue(record[key])}`).join(", ")}`
  );
  if (action.records.length > records.length) records.push(`- ... and ${action.records.length - records.length} more record(s)`);
  return `\n\nTargets:\n${records.join("\n")}`;
}

/** Render a data-minimizing approval description for a business-object mutation. */
export function describeBusinessObjectAction(action: BusinessObjectAction): ActionDescription {
  let object = label(action.kind);
  let count = action.records.length;
  let fields = action.changedFields.length ? action.changedFields.map(field => `\`${escapeMarkdown(field)}\``).join(", ") : "none";
  let operation = action.type === "businessObjectUpsert" ? "Create/update" : "Permanently delete";
  return {
    title: `${operation} ${count} Marketo ${object} record(s)`,
    description:
      `${operation} **${count}** Marketo ${object} record(s), matching by **${action.matchBy}**.\n\n` +
      `${action.type === "businessObjectUpsert" ? "Changed fields" : "Key fields"}: ${fields}. ` +
      "Only bounded match-key values needed to identify targets are shown." +
      targetDetails(action),
    awaitDecision: true,
    implementsRevert: false,
  };
}

/** Execute an approved standard business-object mutation. */
export async function executeBusinessObjectAction(
  action: BusinessObjectAction,
  client: MarketoClient,
): Promise<RawSyncResult[]> {
  if (action.type === "businessObjectDelete") {
    return await client.deleteBusinessObject(action.kind, action.records, action.matchBy);
  }
  if (!action.action) throw new Error("A persisted business-object upsert is missing its action.");
  return await client.syncBusinessObject(action.kind, action.records, action.action, action.matchBy);
}
