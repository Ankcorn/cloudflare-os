import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { markdownCode, markdownJsonCodeBlock, markdownText } from "./approval-markdown";
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

/** Validate persisted business-object discriminants before dispatch preparation. */
export function validateBusinessObjectActionForDispatch(action: BusinessObjectAction): void {
  if (action.kind !== "company" && action.kind !== "opportunity" && action.kind !== "opportunityRole" &&
      action.kind !== "salesPerson" && action.kind !== "namedAccount") {
    throw new Error("Unknown persisted Marketo business-object kind.");
  }
  if (action.matchBy !== "dedupeFields" && action.matchBy !== "idField") {
    throw new Error("Unknown persisted Marketo business-object matching mode.");
  }
  if (action.type === "businessObjectUpsert" && action.action !== "createOnly" &&
      action.action !== "updateOnly" && action.action !== "createOrUpdate") {
    throw new Error("Unknown persisted Marketo business-object upsert action.");
  }
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
  return `\n\nTargets and submitted values:\n\n${action.records.map((record, index) =>
    `Record ${index + 1} (${keys.map(key => markdownText(key)).join(" + ")}):\n\n${markdownJsonCodeBlock(record)}`
  ).join("\n\n")}`;
}

/** Render every target and submitted value for a business-object mutation. */
export function describeBusinessObjectAction(action: BusinessObjectAction): ActionDescription {
  let object = label(action.kind);
  let count = action.records.length;
  let fields = action.changedFields.length ? action.changedFields.map(markdownCode).join(", ") : "none";
  let operation = action.type === "businessObjectUpsert" ? "Create/update" : "Permanently delete";
  let executionMode = action.type === "businessObjectUpsert"
    ? `\n\nExecution mode: **${action.action}**.`
    : "";
  return {
    title: `${operation} ${count} Marketo ${object} record(s)`,
    description:
      `${operation} **${count}** Marketo ${object} record(s).${executionMode}\n\n` +
      `Object type: **${action.kind}**.\n\nMatching mode: **${action.matchBy}**.\n\n` +
      `${action.type === "businessObjectUpsert" ? "Changed fields" : "Key fields"}: ${fields}.` +
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
  switch (action.type) {
    case "businessObjectDelete":
      validateBusinessObjectActionForDispatch(action);
      return await client.deleteBusinessObject(action.kind, action.records, action.matchBy);
    case "businessObjectUpsert":
      validateBusinessObjectActionForDispatch(action);
      if (!action.action) throw new Error("A persisted business-object upsert is missing its action.");
      return await client.syncBusinessObject(action.kind, action.records, action.action, action.matchBy);
    default:
      throw new Error("Unknown persisted Marketo business-object action type.");
  }
}
