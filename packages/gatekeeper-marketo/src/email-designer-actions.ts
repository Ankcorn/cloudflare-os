import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { markdownCode, markdownJsonCodeBlock } from "./approval-markdown";
import {
  MarketoResponseValidationError,
  type DesignerAssetKind,
  type MarketoClient,
  type RawDesignerAsset,
} from "./marketo-api";
import type { MarketoDesignerUsedBy } from "./types";

export type EmailDesignerKind = "designerEmail" | "designerTemplate" | "designerFragment";

const INHERITED_CLONE_FIELDS = [
  "templateId", "appType", "appData", "data", "headers", "settings",
] as const;
const REQUEST_ONLY_SETTINGS = new Set(["brandedDomain", "dedicatedIp"]);
const SOURCE_COMPARISON_FIELDS = [
  "templateId", "appType", "appData", "data", "headers", "settings",
  "contentId", "associatedStates", "state", "status",
] as const;
const DELETE_COMPARISON_FIELDS = [
  "name", "description", ...SOURCE_COMPARISON_FIELDS,
] as const;
type DesignerCloneField = typeof SOURCE_COMPARISON_FIELDS[number];
type DesignerDeleteField = typeof DELETE_COMPARISON_FIELDS[number];
type DesignerSnapshotValue = { present: false } | { present: true; value: unknown };

/** Clone-relevant Email Designer source state captured when approval is submitted. */
export type DesignerCloneSnapshot = { [K in DesignerCloneField]: DesignerSnapshotValue };

/** Complete Email Designer target state captured for irreversible deletion review. */
export type DesignerDeleteSnapshot = { [K in DesignerDeleteField]: DesignerSnapshotValue };

export type EmailDesignerAction =
  | { id: number; type: "designerCreate"; asset: EmailDesignerKind; provisionalId: string; body: Record<string, unknown> }
  | { id: number; type: "designerClone"; asset: EmailDesignerKind; provisionalId: string; sourceId: string; name: string; description?: string; sourceSnapshot: DesignerCloneSnapshot }
  | { id: number; type: "designerUpdate"; asset: EmailDesignerKind; targetId: string; patch: Record<string, unknown> }
  | { id: number; type: "designerLifecycle"; asset: EmailDesignerKind; targetId: string; operation: "createDraft" | "approve" | "unapprove" | "discard"; contentId: string; sourceState: "draft" | "approved"; sourceSnapshot: DesignerCloneSnapshot; affectedDependents: MarketoDesignerUsedBy[] }
  | { id: number; type: "designerDelete"; asset: EmailDesignerKind; targetId: string; targetSnapshot: DesignerDeleteSnapshot; affectedDependents: MarketoDesignerUsedBy[] };

export type EmailDesignerActionInput = EmailDesignerAction extends infer T
  ? T extends EmailDesignerAction ? Omit<T, "id"> : never
  : never;

export function isEmailDesignerAction(action: { type: string }): action is EmailDesignerAction {
  switch (action.type) {
    case "designerCreate":
    case "designerClone":
    case "designerUpdate":
    case "designerLifecycle":
    case "designerDelete":
      return true;
    default:
      return false;
  }
}

/** A designer preflight failure proves that no mutating request was sent. */
export class DesignerPreDispatchError extends Error {}

function path(kind: EmailDesignerKind): DesignerAssetKind {
  switch (kind) {
    case "designerEmail": return "email";
    case "designerTemplate": return "emailtemplate";
    case "designerFragment": return "fragment";
    default: throw new Error("Unknown persisted Marketo Email Designer asset type.");
  }
}

function label(kind: EmailDesignerKind): string {
  return kind === "designerEmail" ? "email" : kind === "designerTemplate" ? "email template" : "fragment";
}

/** Validate persisted Email Designer discriminants before dispatch preparation. */
export function validateEmailDesignerActionForDispatch(action: EmailDesignerAction): void {
  path(action.asset);
  if (action.type === "designerDelete" &&
      (!validDesignerDeleteSnapshot(action.targetSnapshot) ||
        !validDesignerDependents(action.affectedDependents))) {
    throw new Error("A persisted Marketo designer delete is missing its complete review state.");
  }
  if (action.type !== "designerLifecycle") return;
  if (action.sourceState !== "draft" && action.sourceState !== "approved") {
    throw new Error("Unknown persisted Marketo Email Designer source state.");
  }
  switch (action.operation) {
    case "createDraft":
    case "approve":
    case "unapprove":
    case "discard":
      return;
    default:
      throw new Error("Unknown persisted Marketo Email Designer lifecycle operation.");
  }
}

function validDesignerSnapshot(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return fields.every(field => {
    let item = Reflect.get(value, field);
    return Boolean(item && typeof item === "object" && !Array.isArray(item) &&
      typeof Reflect.get(item as object, "present") === "boolean" &&
      (!Reflect.get(item as object, "present") || Object.hasOwn(item as object, "value")));
  });
}

/** Whether a persisted delete snapshot contains every required review field. */
export function validDesignerDeleteSnapshot(value: unknown): value is DesignerDeleteSnapshot {
  if (!validDesignerSnapshot(value, DELETE_COMPARISON_FIELDS)) return false;
  let name = Reflect.get(value as object, "name") as object;
  return Reflect.get(name, "present") === true && typeof Reflect.get(name, "value") === "string";
}

/** Whether a persisted dependency review contains complete, normalized records. */
export function validDesignerDependents(value: unknown): value is MarketoDesignerUsedBy[] {
  return Array.isArray(value) && value.every(dependent =>
    dependent && typeof dependent === "object" && typeof dependent.id === "string" &&
    typeof dependent.name === "string" &&
    [dependent.channel, dependent.contentType, dependent.workspaceId, dependent.folderId]
      .every(item => item === undefined || typeof item === "string"));
}

function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).toSorted().flatMap(key => {
      let item = Reflect.get(value, key);
      return item === undefined ? [] : [[key, jsonValue(item)]];
    }));
  }
  return value;
}

/** Convert a persisted clone snapshot back to its clone-relevant source fields. */
export function designerCloneSnapshotRecord(snapshot: DesignerCloneSnapshot): Record<DesignerCloneField, unknown> {
  return Object.fromEntries(SOURCE_COMPARISON_FIELDS.map(field => [
    field,
    snapshot[field].present ? snapshot[field].value : undefined,
  ])) as Record<DesignerCloneField, unknown>;
}

function mergeDefinedRecords(base: unknown, patch: unknown): Record<string, unknown> {
  let result: Record<string, unknown> =
    base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return result;
  for (let [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function mergeDesignerData(base: unknown, patch: unknown): Record<string, unknown> {
  let result = mergeDefinedRecords(base, patch);
  for (let channel of ["html", "text"] as const) {
    let value = patch && typeof patch === "object" && !Array.isArray(patch)
      ? Reflect.get(patch, channel)
      : undefined;
    if (value !== undefined) {
      result[channel] = mergeDefinedRecords(
        base && typeof base === "object" && !Array.isArray(base) ? Reflect.get(base, channel) : undefined,
        value,
      );
    }
  }
  return result;
}

/** Build a stable, JSON-safe snapshot while preserving absent top-level fields. */
export function designerCloneSnapshot(source: Record<string, unknown>): DesignerCloneSnapshot {
  let normalized: Record<string, unknown> = {
    ...source,
    templateId: source.templateId === undefined ? undefined : String(source.templateId),
    appData: source.appData && typeof source.appData === "object" && !Array.isArray(source.appData)
      ? {
          ...source.appData as object,
          workspaceId: Reflect.get(source.appData, "workspaceId") === undefined
            ? undefined : String(Reflect.get(source.appData, "workspaceId")),
          folderId: Reflect.get(source.appData, "folderId") === undefined
            ? undefined : String(Reflect.get(source.appData, "folderId")),
          programId: Reflect.get(source.appData, "programId") === undefined
            ? undefined : String(Reflect.get(source.appData, "programId")),
        }
      : source.appData,
  };
  return Object.fromEntries(SOURCE_COMPARISON_FIELDS.map(field => [
    field,
    normalized[field] === undefined
      ? { present: false }
      : { present: true, value: jsonValue(normalized[field]) },
  ])) as DesignerCloneSnapshot;
}

/** Build a stable, complete snapshot for irreversible deletion review. */
export function designerDeleteSnapshot(source: Record<string, unknown>): DesignerDeleteSnapshot {
  let clone = designerCloneSnapshot(source);
  return Object.fromEntries(DELETE_COMPARISON_FIELDS.map(field => {
    if (field in clone) return [field, clone[field as DesignerCloneField]];
    return [field, source[field] === undefined
      ? { present: false }
      : { present: true, value: jsonValue(source[field]) }];
  })) as DesignerDeleteSnapshot;
}

/** Convert a persisted delete snapshot back to its complete target fields. */
export function designerDeleteSnapshotRecord(
  snapshot: DesignerDeleteSnapshot,
): Record<DesignerDeleteField, unknown> {
  return Object.fromEntries(DELETE_COMPARISON_FIELDS.map(field => [
    field,
    snapshot[field].present ? snapshot[field].value : undefined,
  ])) as Record<DesignerDeleteField, unknown>;
}

/** Resolve provisional references captured inside a deletion review snapshot. */
export function resolveDesignerDeleteSnapshot(
  snapshot: DesignerDeleteSnapshot,
  resolveDesigner: (id: string) => string,
  resolveAsset: (id: string) => number | string,
): DesignerDeleteSnapshot {
  return designerDeleteSnapshot(resolvedBody(
    designerDeleteSnapshotRecord(snapshot),
    resolveDesigner,
    resolveAsset,
  ));
}

/** Apply a simulated target mutation to an irreversible deletion snapshot. */
export function updateDesignerDeleteSnapshot(
  snapshot: DesignerDeleteSnapshot,
  patch: Record<string, unknown>,
): DesignerDeleteSnapshot {
  let target = designerDeleteSnapshotRecord(snapshot);
  for (let field of DELETE_COMPARISON_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === "data") {
      target[field] = mergeDesignerData(target[field], patch[field]);
    } else if (["appData", "headers", "settings"].includes(field)) {
      target[field] = mergeDefinedRecords(target[field], patch[field]);
    } else {
      target[field] = patch[field];
    }
  }
  return designerDeleteSnapshot(target);
}

/** Whether a current target still exactly matches its approved deletion snapshot. */
export function matchesDesignerDeleteSnapshot(
  target: Record<string, unknown>,
  snapshot: DesignerDeleteSnapshot,
): boolean {
  return JSON.stringify(designerDeleteSnapshot(target)) === JSON.stringify(snapshot);
}

/** Resolve provisional asset references captured inside a clone snapshot. */
export function resolveDesignerCloneSnapshot(
  snapshot: DesignerCloneSnapshot,
  resolveDesigner: (id: string) => string,
  resolveAsset: (id: string) => number | string,
): DesignerCloneSnapshot {
  return designerCloneSnapshot(resolvedBody(designerCloneSnapshotRecord(snapshot), resolveDesigner, resolveAsset));
}

/** Apply a simulated designer update to an approval snapshot. */
export function updateDesignerCloneSnapshot(
  snapshot: DesignerCloneSnapshot,
  patch: Record<string, unknown>,
): DesignerCloneSnapshot {
  let source = designerCloneSnapshotRecord(snapshot);
  for (let field of SOURCE_COMPARISON_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === "data") {
      source[field] = mergeDesignerData(source[field], patch[field]);
    } else if (["appData", "headers", "settings"].includes(field)) {
      source[field] = mergeDefinedRecords(source[field], patch[field]);
    } else {
      source[field] = patch[field];
    }
  }
  return designerCloneSnapshot(source);
}

/** Whether an exact source read still matches the approved clone snapshot. */
export function matchesDesignerCloneSnapshot(
  source: Record<string, unknown>,
  snapshot: DesignerCloneSnapshot,
): boolean {
  return JSON.stringify(designerCloneSnapshot(source)) === JSON.stringify(snapshot);
}

/** Whether clone-inherited configuration matches an approved source snapshot. */
export function matchesDesignerCloneConfiguration(
  asset: Record<string, unknown>,
  sourceSnapshot: DesignerCloneSnapshot,
): boolean {
  let createdSnapshot = designerCloneSnapshot(asset);
  return INHERITED_CLONE_FIELDS.every(field =>
    JSON.stringify(postflightSnapshotValue(field, createdSnapshot[field])) ===
      JSON.stringify(postflightSnapshotValue(field, sourceSnapshot[field])));
}

function postflightSnapshotValue(field: string, snapshot: DesignerSnapshotValue): DesignerSnapshotValue {
  if (field !== "settings" || !snapshot.present || !snapshot.value ||
      typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) return snapshot;
  let settings = Object.fromEntries(Object.entries(snapshot.value).filter(([key]) => !REQUEST_ONLY_SETTINGS.has(key)));
  return Object.keys(settings).length === 0 ? { present: false } : { present: true, value: settings };
}

function postflightApproved(approved: Record<string, unknown>): Record<string, unknown> {
  let settings = approved.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return approved;
  let result = { ...approved };
  let observable = Object.fromEntries(Object.entries(settings).filter(([key]) => !REQUEST_ONLY_SETTINGS.has(key)));
  if (Object.keys(observable).length === 0) delete result.settings;
  else result.settings = observable;
  return result;
}

function createDescription(action: Extract<EmailDesignerAction, { type: "designerCreate" }>, name: string): string {
  let body = action.body;
  return [
    `Create a new Marketo Email Designer ${name} with these exact values:`,
    "",
    "Name:",
    "",
    markdownJsonCodeBlock(body.name),
    "",
    "Description:",
    "",
    markdownJsonCodeBlock(body.description),
    "",
    "Destination (workspace and folder or program):",
    "",
    markdownJsonCodeBlock(body.appData),
    "",
    "Template ID:",
    "",
    markdownJsonCodeBlock(body.templateId),
    "",
    "Content:",
    "",
    markdownJsonCodeBlock(body.data),
    "",
    "Delivery headers:",
    "",
    markdownJsonCodeBlock(body.headers),
    "",
    "Delivery or fragment settings:",
    "",
    markdownJsonCodeBlock(body.settings),
  ].join("\n");
}

function cloneDescription(action: Extract<EmailDesignerAction, { type: "designerClone" }>, name: string): string {
  let inherited = designerCloneSnapshotRecord(action.sourceSnapshot);
  return [
    `Clone Marketo Email Designer ${name} ${markdownCode(action.sourceId)} with these exact values:`,
    "",
    "Name:",
    "",
    markdownJsonCodeBlock(action.name),
    "",
    "Explicit description:",
    "",
    markdownJsonCodeBlock(action.description),
    "",
    "Inherited destination (workspace and folder or program):",
    "",
    markdownJsonCodeBlock(inherited.appData),
    "",
    "Inherited template ID:",
    "",
    markdownJsonCodeBlock(inherited.templateId),
    "",
    "Inherited application type:",
    "",
    markdownJsonCodeBlock(inherited.appType),
    "",
    "Inherited content:",
    "",
    markdownJsonCodeBlock(inherited.data),
    "",
    "Inherited delivery headers:",
    "",
    markdownJsonCodeBlock(inherited.headers),
    "",
    "Inherited delivery or fragment settings:",
    "",
    markdownJsonCodeBlock(inherited.settings),
  ].join("\n");
}

export function describeEmailDesignerAction(action: EmailDesignerAction): ActionDescription {
  let name = label(action.asset);
  let target = "targetId" in action ? action.targetId : undefined;
  let base = { awaitDecision: false, implementsRevert: false } as const;
  switch (action.type) {
    case "designerCreate":
      return { ...base, awaitDecision: true, title: `Create Marketo designer ${name}`, description: createDescription(action, name) };
    case "designerClone":
      return { ...base, awaitDecision: true, title: `Clone Marketo designer ${name}`, description: cloneDescription(action, name) };
    case "designerUpdate":
      return { ...base, title: `Update Marketo designer ${name}`, description: `Update draft fields on ${name} ${markdownCode(target ?? "")}:\n\n${markdownJsonCodeBlock(action.patch)}` };
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
        awaitDecision: action.operation === "createDraft" || action.operation === "discard",
        title: `${action.operation} Marketo designer ${name}`,
        description: `${action.operation} ${name} ${markdownCode(target ?? "")} using its snapshotted ` +
          `${action.sourceState} content ${markdownCode(action.contentId)}.${risk}\n\n` +
          `Complete publishable content, headers, and settings:\n\n${markdownJsonCodeBlock(designerCloneSnapshotRecord(action.sourceSnapshot))}\n\n` +
          `Affected dependents:\n\n${markdownJsonCodeBlock(action.affectedDependents)}`,
      };
    }
    case "designerDelete":
      return {
        ...base,
        title: `Delete Marketo designer ${name}`,
        description: `Permanently delete ${name} ${markdownCode(target ?? "")}. This is irreversible and can break assets that depend on it.\n\n` +
          `Complete target review snapshot (name, destination, lifecycle state, content, headers, and settings):\n\n` +
          `${markdownJsonCodeBlock(action.targetSnapshot)}\n\n` +
          `Affected dependents:\n\n${markdownJsonCodeBlock(action.affectedDependents)}`,
      };
  }
}

function createdId(result: RawDesignerAsset[]): string {
  let id = result[0]?.id;
  if (result.length !== 1 || (typeof id !== "string" && typeof id !== "number") || !String(id)) {
    throw new MarketoResponseValidationError(
      "Marketo created the designer asset but did not return exactly one id.",
    );
  }
  return String(id);
}

function assertTargetResult(
  result: RawDesignerAsset[],
  targetId: string,
  operation: string,
  expectedStatus?: string,
  contentIdentity = false,
): void {
  let returned = result[0];
  let returnedId = contentIdentity ? returned?.contentId : returned?.id;
  if (result.length !== 1 || returnedId === undefined || String(returnedId) !== targetId) {
    throw new Error(`Marketo returned an invalid result for designer ${operation} on ${targetId}.`);
  }
  if (expectedStatus !== undefined && (returned.status ?? returned.state)?.toLowerCase() !== expectedStatus) {
    throw new Error(`Marketo returned an invalid status for designer ${operation} on ${targetId}.`);
  }
}

function containsApproved(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((item, index) => containsApproved(actual[index], item));
  }
  if (expected && typeof expected === "object") {
    return Boolean(actual && typeof actual === "object" && !Array.isArray(actual)) &&
      Object.entries(expected).every(([key, value]) => containsApproved(Reflect.get(actual as object, key), value));
  }
  return actual === expected;
}

async function verifyCreation(
  client: MarketoClient,
  kind: DesignerAssetKind,
  id: string,
  approved: Record<string, unknown>,
  inherited?: DesignerCloneSnapshot,
): Promise<void> {
  let created = await client.getDesignerAsset(kind, id);
  let comparable = created && {
    ...created,
    templateId: created.templateId === undefined ? undefined : String(created.templateId),
    appData: created.appData && {
      ...created.appData,
      workspaceId: created.appData.workspaceId === undefined ? undefined : String(created.appData.workspaceId),
      folderId: created.appData.folderId === undefined ? undefined : String(created.appData.folderId),
      programId: created.appData.programId === undefined ? undefined : String(created.appData.programId),
    },
  };
  if (!created || String(created.id) !== id || !containsApproved(comparable, postflightApproved(approved)) ||
      inherited && !matchesDesignerCloneConfiguration(created as Record<string, unknown>, inherited)) {
    throw new Error(`Marketo could not verify the created designer asset ${id} against the approved request.`);
  }
}

export async function executeEmailDesignerAction(
  action: EmailDesignerAction,
  client: MarketoClient,
  resolveDesigner: (id: string) => string,
  resolveAsset: (id: string) => number,
  recordCreation: (provisionalId: string, realId: string, kind: EmailDesignerKind) => void,
  recordCandidate: (realId: string) => void = () => {},
): Promise<void> {
  switch (action.type) {
    case "designerCreate":
    case "designerClone":
    case "designerUpdate":
    case "designerLifecycle":
    case "designerDelete":
      break;
    default:
      throw new Error("Unknown persisted Marketo Email Designer action type.");
  }
  validateEmailDesignerActionForDispatch(action);
  let kind = path(action.asset);
  if (action.type === "designerCreate") {
    let body = resolvedBody(action.body, resolveDesigner, resolveAsset);
    let id = createdId(await client.createDesignerAsset(kind, body));
    recordCandidate(id);
    await verifyCreation(client, kind, id, body);
    recordCreation(action.provisionalId, id, action.asset);
    return;
  }
  if (action.type === "designerClone") {
    let sourceId = resolveDesigner(action.sourceId);
    let sourceSnapshot = resolveDesignerCloneSnapshot(action.sourceSnapshot, resolveDesigner, resolveAsset);
    let result = await client.cloneDesignerAsset(kind, {
      assetId: sourceId,
      newAsset: { name: action.name, description: action.description },
    });
    let created = createdId(result);
    recordCandidate(created);
    await verifyCreation(client, kind, created, {
      name: action.name,
      description: action.description,
    }, sourceSnapshot);
    recordCreation(action.provisionalId, created, action.asset);
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
    let result = await client.deleteDesignerAsset(kind, id);
    if (result.length > 0) assertTargetResult(result, id, "delete");
    return;
  }
  let operation: "approve" | "unapprove" | "discard" | "create_draft";
  let expectedStatus: "approved" | "draft";
  switch (action.operation) {
    case "createDraft": operation = "create_draft"; expectedStatus = "draft"; break;
    case "approve": operation = "approve"; expectedStatus = "approved"; break;
    case "unapprove": operation = "unapprove"; expectedStatus = "draft"; break;
    case "discard": operation = "discard"; expectedStatus = "approved"; break;
    default: throw new Error("Unknown persisted Marketo Email Designer lifecycle operation.");
  }
  assertTargetResult(
    await client.transitionDesignerAsset(kind, { contentId: action.contentId, action: operation }),
    action.contentId,
    action.operation,
    expectedStatus,
    true,
  );
}

function resolvedBody(
  body: Record<string, unknown>,
  resolveDesigner: (id: string) => string,
  resolveAsset: (id: string) => number | string,
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
  if (action.type === "designerClone") {
    let source = designerCloneSnapshotRecord(action.sourceSnapshot);
    return Boolean(action.sourceId === id || source.templateId === id ||
      source.appData && typeof source.appData === "object" &&
      (Reflect.get(source.appData, "folderId") === id || Reflect.get(source.appData, "programId") === id));
  }
  if (action.type === "designerCreate") {
    return action.body.templateId === id || appDataReferences(action.body, id);
  }
  return action.type === "designerUpdate" &&
    (action.patch.templateId === id || appDataReferences(action.patch, id));
}
