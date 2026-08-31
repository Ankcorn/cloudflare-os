import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { DesignerAssetKind, MarketoClient, RawDesignerAsset } from "./marketo-api";

export type EmailDesignerKind = "designerEmail" | "designerTemplate" | "designerFragment";

export type EmailDesignerAction =
  | { id: number; type: "designerCreate"; asset: EmailDesignerKind; provisionalId: string; body: Record<string, unknown> }
  | { id: number; type: "designerClone"; asset: EmailDesignerKind; provisionalId: string; sourceId: string; name: string; description?: string }
  | { id: number; type: "designerUpdate"; asset: EmailDesignerKind; targetId: string; patch: Record<string, unknown> }
  | { id: number; type: "designerLifecycle"; asset: EmailDesignerKind; targetId: string; operation: "createDraft" | "approve" | "unapprove" | "discard" }
  | { id: number; type: "designerDelete"; asset: EmailDesignerKind; targetId: string };

export type EmailDesignerActionInput = EmailDesignerAction extends infer T
  ? T extends EmailDesignerAction ? Omit<T, "id"> : never
  : never;

export function isEmailDesignerAction(action: { type: string }): action is EmailDesignerAction {
  return action.type.startsWith("designer");
}

function path(kind: EmailDesignerKind): DesignerAssetKind {
  return kind === "designerEmail" ? "email" : kind === "designerTemplate" ? "emailtemplate" : "fragment";
}

function label(kind: EmailDesignerKind): string {
  return kind === "designerEmail" ? "email" : kind === "designerTemplate" ? "email template" : "fragment";
}

function escape(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

export function describeEmailDesignerAction(action: EmailDesignerAction): ActionDescription {
  let name = label(action.asset);
  let target = "targetId" in action ? action.targetId : undefined;
  let base = { awaitDecision: false, implementsRevert: false } as const;
  switch (action.type) {
    case "designerCreate":
      return { ...base, title: `Create Marketo designer ${name}`, description: `Create a new Marketo Email Designer ${name} named **${escape(String(action.body.name ?? ""))}**.` };
    case "designerClone":
      return { ...base, title: `Clone Marketo designer ${name}`, description: `Clone ${name} \`${escape(action.sourceId)}\` as **${escape(action.name)}** in the source asset's current location.` };
    case "designerUpdate":
      return { ...base, title: `Update Marketo designer ${name}`, description: `Update draft fields on ${name} \`${escape(target ?? "")}\`:\n\n    ${escape(JSON.stringify(action.patch))}` };
    case "designerLifecycle": {
      let risk = action.operation === "approve"
        ? action.asset === "designerFragment"
          ? " Publishing this fragment can immediately change every inheriting email or template."
          : " Publishing can propagate the new version to assets that depend on it."
        : action.operation === "discard"
          ? " Draft changes are permanently discarded and cannot be recovered."
          : "";
      return {
        ...base,
        awaitDecision: action.operation === "discard",
        title: `${action.operation} Marketo designer ${name}`,
        description: `${action.operation} ${name} \`${escape(target ?? "")}\`.${risk}`,
      };
    }
    case "designerDelete":
      return {
        ...base,
        title: `Delete Marketo designer ${name}`,
        description: `Permanently delete ${name} \`${escape(target ?? "")}\`. This is irreversible and can break assets that depend on it.`,
      };
  }
}

function createdId(result: RawDesignerAsset[]): string {
  let id = result[0]?.id;
  if (result.length !== 1 || (typeof id !== "string" && typeof id !== "number") || !String(id)) {
    throw new Error("Marketo created the designer asset but did not return exactly one id.");
  }
  return String(id);
}

function assertTargetResult(
  result: RawDesignerAsset[],
  targetId: string,
  operation: string,
  expectedStatus?: string,
): void {
  let returned = result[0];
  if (result.length !== 1 || returned?.id === undefined || String(returned.id) !== targetId) {
    throw new Error(`Marketo returned an invalid result for designer ${operation} on ${targetId}.`);
  }
  if (expectedStatus !== undefined && (returned.status ?? returned.state)?.toLowerCase() !== expectedStatus) {
    throw new Error(`Marketo returned an invalid status for designer ${operation} on ${targetId}.`);
  }
}

export async function executeEmailDesignerAction(
  action: EmailDesignerAction,
  client: MarketoClient,
  resolveDesigner: (id: string) => string,
  resolveAsset: (id: string) => number,
  recordCreation: (provisionalId: string, realId: string, kind: EmailDesignerKind) => void,
): Promise<void> {
  let kind = path(action.asset);
  if (action.type === "designerCreate") {
    recordCreation(
      action.provisionalId,
      createdId(await client.createDesignerAsset(kind, resolvedBody(action.body, resolveDesigner, resolveAsset))),
      action.asset,
    );
    return;
  }
  if (action.type === "designerClone") {
    let result = await client.cloneDesignerAsset(kind, {
      assetId: resolveDesigner(action.sourceId),
      newAsset: { name: action.name, description: action.description },
    });
    recordCreation(action.provisionalId, createdId(result), action.asset);
    return;
  }
  let id = resolveDesigner(action.targetId);
  if (action.type === "designerUpdate") {
    assertTargetResult(
      await client.updateDesignerAsset(kind, id, resolvedBody(action.patch, resolveDesigner, resolveAsset)),
      id,
      "update",
    );
    return;
  }
  if (action.type === "designerDelete") {
    assertTargetResult(await client.deleteDesignerAsset(kind, id), id, "delete");
    return;
  }
  let operation: "approve" | "unapprove" | "discard" | "create_draft" =
    action.operation === "createDraft" ? "create_draft" : action.operation;
  let expectedStatus = action.operation === "approve" || action.operation === "discard" ? "approved" : "draft";
  assertTargetResult(
    await client.transitionDesignerAsset(kind, { contentId: id, action: operation }),
    id,
    action.operation,
    expectedStatus,
  );
}

function resolvedBody(
  body: Record<string, unknown>,
  resolveDesigner: (id: string) => string,
  resolveAsset: (id: string) => number,
): Record<string, unknown> {
  let result = { ...body };
  if (typeof result.templateId === "string" && result.templateId.startsWith("~")) {
    result.templateId = resolveDesigner(result.templateId);
  }
  if (result.appData && typeof result.appData === "object" && !Array.isArray(result.appData)) {
    let appData = Object.fromEntries(Object.entries(result.appData));
    for (let key of ["folderId", "programId"] as const) {
      if (typeof appData[key] === "string" && appData[key].startsWith("~")) {
        appData[key] = String(resolveAsset(appData[key]));
      }
    }
    result.appData = appData;
  }
  return result;
}

function appDataReferences(body: Record<string, unknown>, id: string): boolean {
  let appData = body.appData;
  return Boolean(appData && typeof appData === "object" && !Array.isArray(appData) &&
    (Reflect.get(appData, "folderId") === id || Reflect.get(appData, "programId") === id));
}

/** Whether an action depends on a logical designer, folder, or program ID. */
export function emailDesignerActionReferences(action: EmailDesignerAction, id: string): boolean {
  if ("targetId" in action && action.targetId === id) return true;
  if (action.type === "designerClone" && action.sourceId === id) return true;
  if (action.type === "designerCreate") {
    return action.body.templateId === id || appDataReferences(action.body, id);
  }
  return action.type === "designerUpdate" &&
    (action.patch.templateId === id || appDataReferences(action.patch, id));
}
