import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  MarketoCreateEmailInput,
  MarketoCreateEmailTemplateInput,
  MarketoCreateFileInput,
  MarketoCreateFormInput,
  MarketoCreateLandingPageInput,
  MarketoCreateLandingPageTemplateInput,
  MarketoCreateSnippetInput,
  MarketoDesignStudioFolder,
  MarketoDesignStudioFolderRef,
  MarketoDesignStudioFileListOptions,
  MarketoDesignStudioFolderListOptions,
  MarketoDesignStudioFolderSummary,
  MarketoDesignStudioListOptions,
  MarketoDesignStudioMetadataPatch,
  MarketoEmailContentSection,
  MarketoEmailContentUpdate,
  MarketoEmail,
  MarketoEmailMetadataPatch,
  MarketoEmailSummary,
  MarketoEmailTemplateSummary,
  MarketoEmailTemplate,
  MarketoFile,
  MarketoFileSummary,
  MarketoFormField,
  MarketoFormMetadataPatch,
  MarketoFormSummary,
  MarketoForm,
  MarketoLandingPageContentSection,
  MarketoLandingPageSummary,
  MarketoLandingPage,
  MarketoLandingPageTemplateSummary,
  MarketoLandingPageTemplate,
  MarketoSnippetContent,
  MarketoSnippetSummary,
  MarketoSnippet,
} from "./types";
import type {
  MarketoAssetStatus,
  MarketoClient,
  MarketoFolderRef,
  RawDesignStudioAsset,
  RawEmailContent,
  RawFile,
  RawFolder,
  RawFormField,
  RawLandingPageContent,
} from "./marketo-api";
import { ASSET_PAGE_MAX, parseMarketoDate } from "./marketo-api";
import type {
  DesignStudioAction,
  DesignStudioActionInput,
  DesignStudioAssetKind,
  DesignStudioCreateInput,
  DesignStudioLifecycleSnapshot,
  DesignStudioMetadata,
} from "./design-studio-actions";
import { retainSessionContext, type SessionContext } from "./session";
import { MarketoEmailDesignerImpl, type EmailDesignerContext } from "./email-designer";

type Summary = {
  id: string;
  name: string;
  description?: string;
  status?: string;
  workspaceName?: string;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
};

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DURABLE_PAYLOAD_BYTES = 1280 * 1024;
const MAX_FOLDER_DEPTH = 20;
const DEFAULT_FOLDER_DEPTH = 2;
const MAX_WORKSPACE_LENGTH = 100;
const MAX_CLASSIC_DEPENDENTS = 1_000;

export type DesignStudioContext = SessionContext & {
  allocateProvisional(): string;
  logicalKind(id: string): DesignStudioAssetKind | "campaign" | "program" | "designerEmail" | "designerTemplate" | "designerFragment" | undefined;
  pending(): DesignStudioAction[];
  resolveId(id: string): number | undefined;
  submitDesign(action: DesignStudioActionInput): Promise<void>;
};

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  let result = value.trim();
  if (new TextEncoder().encode(result).byteLength > MAX_TEXT_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
  return result;
}

function normalizeMimeType(value: unknown): string {
  let mimeType = requiredText(value, "MIME type");
  return requiredText(new Blob([], { type: mimeType }).type, "MIME type");
}

function requireContent(value: unknown, label = "content"): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} cannot be empty.`);
  if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function requireFile(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new Error("File data must be a non-empty Uint8Array.");
  }
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`File data must not exceed ${MAX_FILE_BYTES} bytes.`);
  return data;
}

async function sha256(data: Uint8Array): Promise<string> {
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function allowInput(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  let input = inputRecord(value, label);
  let unknown = Object.keys(input).filter(key => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported field: ${unknown[0]}.`);
  return input;
}

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
  let value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new Error(`${key} must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  let value = input[key];
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${key} must be a boolean.`);
  return value as boolean | undefined;
}

function metadataPatch(value: unknown, keys: readonly string[]): DesignStudioMetadata {
  let input = allowInput(value, "Metadata patch", keys);
  let patch = Object.fromEntries(keys.flatMap(key => {
    let item = optionalText(input, key);
    return item === undefined ? [] : [[key, item]];
  }));
  if (Object.keys(patch).length === 0) throw new Error("A non-empty metadata patch is required.");
  return patch;
}

function basicMetadataPatch(value: unknown): DesignStudioMetadata {
  return metadataPatch(value, ["name", "description"]);
}

function createInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  return allowInput(value, "Create input", keys);
}

function folderOptions(options: MarketoDesignStudioFolderListOptions): { maxDepth?: number; workspace?: string } {
  let maxDepth = options.maxDepth;
  if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_FOLDER_DEPTH)) {
    throw new Error(`maxDepth must be an integer between 1 and ${MAX_FOLDER_DEPTH}.`);
  }
  let workspace = options.workspace;
  if (workspace !== undefined) {
    if (typeof workspace !== "string" || !workspace.trim() || workspace.length > MAX_WORKSPACE_LENGTH) {
      throw new Error(`workspace must be a non-empty string of at most ${MAX_WORKSPACE_LENGTH} characters.`);
    }
    workspace = workspace.trim();
  }
  return { maxDepth, workspace };
}

function durablePayloadBytes(value: unknown): number {
  if (typeof value === "string") {
    let bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > MAX_TEXT_BYTES) {
      throw new Error(`Textual action values must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes.`);
    }
    return bytes;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_FILE_BYTES) throw new Error(`File data must not exceed ${MAX_FILE_BYTES} bytes.`);
    return value.byteLength;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + durablePayloadBytes(item), 0);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((total, [key, item]) =>
      total + new TextEncoder().encode(key).byteLength + durablePayloadBytes(item), 0);
  }
  return 8;
}

async function submitDesign(ctx: DesignStudioContext, action: DesignStudioActionInput): Promise<void> {
  assertDurablePayload(action);
  await ctx.submitDesign(action);
}

function assertDurablePayload(value: unknown): void {
  if (durablePayloadBytes(value) > MAX_DURABLE_PAYLOAD_BYTES) {
    throw new Error(`The complete action payload must not exceed ${MAX_DURABLE_PAYLOAD_BYTES} bytes.`);
  }
}

function logicalId(value: unknown): string {
  if (typeof value !== "string" || (!/^~[1-9]\d*$/.test(value) && !/^[1-9]\d*$/.test(value))) {
    throw new Error("A numeric or provisional (~N) Design Studio id is required.");
  }
  return value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textualContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let parts = value.map(textualContent).filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join("");
  }
  if (!value || typeof value !== "object") return undefined;
  let record = recordValue(value);
  return textualContent(record.value ?? record.content ?? record.html ?? record.text);
}

/** Return only editable static sections from Marketo's mixed classic-email content response. */
export function emailSections(raw: { htmlId?: string; contentType?: string; value?: unknown; isLocked?: boolean }[]): MarketoEmailContentSection[] {
  return raw.flatMap(item => {
    let id = textValue(item.htmlId);
    if (!id || item.isLocked || item.contentType && item.contentType.toLowerCase() !== "text") return [];
    let values = Array.isArray(item.value) ? item.value : [item];
    let section: MarketoEmailContentSection = { id };
    for (let value of values) {
      let record = recordValue(value);
      let rawType = textValue(record.type) ?? textValue(record.contentType) ?? item.contentType;
      let content = textualContent(record.value ?? record.content ?? (value === item ? item.value : value));
      let plainText = textualContent(record.textValue);
      if (plainText !== undefined) {
        section.html = content;
        section.text = plainText;
      } else if (rawType?.toLowerCase() === "html") {
        section.html = content;
      } else if (rawType?.toLowerCase() === "text") {
        section.text = content;
      }
    }
    return section.html !== undefined || section.text !== undefined ? [section] : [];
  });
}

function definedFields(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap(field =>
    value[field] === undefined ? [] : [[field, structuredClone(value[field])]]));
}

function replaceTextualValue(value: unknown, content: string | undefined): unknown {
  if (content === undefined) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return content;
  let record = recordValue(value);
  for (let key of ["value", "content", "html", "text"]) {
    if (record[key] !== undefined) return { ...record, [key]: replaceTextualValue(record[key], content) };
  }
  return content;
}

function canonicalEmailContent(
  raw: RawEmailContent[],
  sections: MarketoEmailContentSection[],
): Record<string, unknown>[] {
  return raw.map(item => {
    let result = definedFields(item as Record<string, unknown>, [
      "htmlId", "contentType", "value", "index", "parentHtmlId", "isLocked",
    ]);
    let section = sections.find(candidate => candidate.id === item.htmlId);
    if (!section) return result;
    let values = Array.isArray(item.value) ? item.value : [item.value];
    let normalizedValues = values.map(value => {
      let record = recordValue(value);
      let type = textValue(record.type) ?? textValue(record.contentType) ?? item.contentType;
      let normalized = { ...record };
      if (record.textValue !== undefined) {
        normalized.textValue = replaceTextualValue(record.textValue, section.text);
        return replaceTextualValue(normalized, section.html);
      }
      return replaceTextualValue(normalized, type?.toLowerCase() === "text" ? section.text : section.html);
    });
    result.value = Array.isArray(item.value) ? normalizedValues : normalizedValues[0];
    return result;
  }).toSorted((left, right) =>
    Number(left.index ?? Number.MAX_SAFE_INTEGER) - Number(right.index ?? Number.MAX_SAFE_INTEGER) ||
    String(left.htmlId ?? "").localeCompare(String(right.htmlId ?? "")));
}

function canonicalLandingPageContent(raw: RawLandingPageContent[]): Record<string, unknown>[] {
  return raw.map(item => definedFields(item as Record<string, unknown>, [
    "id", "type", "index", "content", "formattingOptions", "followupType", "followupValue",
  ])).toSorted((left, right) =>
    Number(left.index ?? Number.MAX_SAFE_INTEGER) - Number(right.index ?? Number.MAX_SAFE_INTEGER) ||
    String(left.id ?? "").localeCompare(String(right.id ?? "")));
}

function canonicalFormFields(raw: RawFormField[]): Record<string, unknown>[] {
  return raw.map(field => definedFields(field as Record<string, unknown>, [
    "id", "label", "dataType", "defaultValue", "validationMessage", "rowNumber", "columnNumber",
    "maxLength", "required", "formPrefill", "fieldWidth", "labelWidth", "hintText", "instructions",
    "text", "fieldMetaData", "visibilityRules",
  ])).toSorted((left, right) =>
    Number(left.rowNumber ?? Number.MAX_SAFE_INTEGER) - Number(right.rowNumber ?? Number.MAX_SAFE_INTEGER) ||
    Number(left.columnNumber ?? Number.MAX_SAFE_INTEGER) - Number(right.columnNumber ?? Number.MAX_SAFE_INTEGER) ||
    String(left.id ?? "").localeCompare(String(right.id ?? "")));
}

function headerValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(item => headerValue(item)).find(item => item !== undefined);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (textValue(Reflect.get(value, "type"))?.toLowerCase() !== "text") return undefined;
  return textValue(Reflect.get(value, "value"));
}

function readId(raw: unknown): number {
  let id = recordValue(raw).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Marketo returned an asset with an invalid id.");
  }
  return id;
}

function baseSummary(raw: unknown): Summary {
  let value = recordValue(raw);
  return {
    id: String(readId(raw)),
    name: textValue(value.name) ?? "",
    description: textValue(value.description),
    status: textValue(value.status),
    workspaceName: textValue(value.workspace),
    createdAt: parseMarketoDate(value.createdAt),
    updatedAt: parseMarketoDate(value.updatedAt),
  };
}

function normalize(kind: DesignStudioAssetKind, raw: unknown): Summary {
  let value = recordValue(raw);
  let summary = baseSummary(raw);
  if (kind === "email") {
    let headers = Object.fromEntries(Object.entries({
      subject: headerValue(value.subject),
      fromName: headerValue(value.fromName),
      fromEmail: headerValue(value.fromEmail),
      replyEmail: headerValue(value.replyEmail),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return {
      ...summary,
      ...headers,
      preHeader: textValue(value.preHeader),
      settings: Object.fromEntries([
        "operational", "textOnly", "publishToMSI", "webView", "template",
        "isOpenTrackingDisabled", "autoCopyToText", "ccFields",
      ].flatMap(key => value[key] === undefined ? [] : [[key, value[key]]])),
    };
  }
  if (kind === "landingPage") {
    return {
      ...summary,
      url: textValue(value.computedUrl) ?? textValue(value.URL) ?? textValue(value.url),
      settings: Object.fromEntries([
        "customHeadHTML", "facebookOgTags", "formPrefill", "keywords", "mobileEnabled",
        "robots", "template", "title",
      ].flatMap(key => value[key] === undefined ? [] : [[key, value[key]]])),
    };
  }
  if (kind === "form") {
    return {
      ...summary,
      locale: textValue(value.locale),
      language: textValue(value.language),
      settings: Object.fromEntries([
        "theme", "progressiveProfiling", "labelPosition", "fontFamily", "fontSize",
        "knownVisitor", "thankYouList", "buttonLocation", "buttonLabel", "waitingLabel",
      ].flatMap(key => value[key] === undefined ? [] : [[key, value[key]]])),
    };
  }
  if (kind === "landingPageTemplate") {
    return {
      ...summary,
      settings: Object.fromEntries([
        ["templateType", value.templateType], ["enableMunchkin", value.enableMunchkin],
      ].filter((entry): entry is [string, unknown] => entry[1] !== undefined)),
    };
  }
  if (kind === "file") {
    return { ...summary, url: textValue(value.url), mimeType: textValue(value.mimeType), size: numberValue(value.size) };
  }
  return summary;
}

function lifecycleMetadata(summary: Summary): Record<string, unknown> {
  let {
    id: _id,
    status: _status,
    workspaceName: _workspaceName,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    url: _url,
    ...publishable
  } = summary;
  return publishable;
}

function formSummary(summary: Summary): MarketoFormSummary {
  return Object.fromEntries([
    "id", "name", "description", "status", "workspaceName", "createdAt", "updatedAt", "locale", "language",
  ].flatMap(key => summary[key] === undefined ? [] : [[key, summary[key]]])) as MarketoFormSummary;
}

function normalizeFolder(raw: unknown): Summary {
  let value = recordValue(raw);
  let parent = recordValue(value.parent);
  let folderId = recordValue(value.folderId);
  let rawType = value.folderId === undefined ? textValue(value.folderType) : textValue(folderId.type);
  let normalizedType = rawType?.toLowerCase();
  if (normalizedType !== "folder" && normalizedType !== "program") {
    throw new Error("Marketo returned a folder with an invalid type.");
  }
  let type = normalizedType;
  return {
    id: String(readId(raw)),
    name: textValue(value.name) ?? "",
    description: textValue(value.description),
    type,
    parentId: parent.id === undefined ? undefined : String(parent.id),
    path: textValue(value.path),
    workspaceName: textValue(value.workspace),
    createdAt: parseMarketoDate(value.createdAt),
    updatedAt: parseMarketoDate(value.updatedAt),
  };
}

function creationSummary(action: Extract<DesignStudioAction, { type: "designCreate" | "designClone" }>): Summary {
  let input = action.type === "designCreate" ? action.input : undefined;
  let summary: Summary = {
    id: action.provisionalId,
    name: action.type === "designCreate" ? action.input.name : action.name,
    description: input?.description,
    status: action.asset === "folder" || action.asset === "file" ? undefined : "draft",
  };
  if (action.asset === "folder") return { ...summary, type: "folder", parentId: action.parent.id };
  if (action.asset === "email" && input) return { ...summary, subject: input.subject, fromName: input.fromName, fromEmail: input.fromEmail, replyEmail: input.replyEmail };
  if (action.asset === "form" && input) return { ...summary, locale: input.locale, language: input.language };
  if (action.asset === "file" && input) return { ...summary, mimeType: input.mimeType, size: input.data?.byteLength };
  return summary;
}

function actionsFor(
  ctx: DesignStudioContext,
  kind: DesignStudioAssetKind,
  id: string,
  pending = ctx.pending(),
): DesignStudioAction[] {
  return pending.filter(action => {
    if ((action.type === "designCreate" || action.type === "designClone") && action.provisionalId === id) return action.asset === kind;
    return "targetId" in action && sameLogicalId(ctx, action.targetId, id) && (action.type === "designDeleteFolder" ? kind === "folder" : action.asset === kind);
  });
}

function assertNotDeleted(ctx: DesignStudioContext, kind: DesignStudioAssetKind, id: string): void {
  let deleted = actionsFor(ctx, kind, id).some(action =>
    action.type === "designDeleteFolder" || action.type === "designLifecycle" && action.operation === "delete"
  );
  if (deleted) throw new Error(`Marketo ${kind} ${id} was deleted.`);
}

function sameLogicalId(ctx: DesignStudioContext, first: string, second: string): boolean {
  if (first === second) return true;
  let firstReal = ctx.resolveId(first);
  return firstReal !== undefined && firstReal === ctx.resolveId(second);
}

function beforeAction(ctx: DesignStudioContext, actionId: number): DesignStudioContext {
  return { ...ctx, pending: () => ctx.pending().filter(action => action.id < actionId) };
}

function overlaySummary(summary: Summary, actions: DesignStudioAction[]): Summary | null {
  let result = { ...summary };
  for (let action of actions) {
    if (action.type === "designMetadata") Object.assign(result, action.patch);
    if (action.type === "designLifecycle") {
      if (action.operation === "delete") return null;
      if (action.operation === "approve") result.status = "approved";
      if (action.operation === "unapprove") result.status = "draft";
      if (action.operation === "discardDraft") result.status = "approved";
    }
    if (action.type === "designDeleteFolder") return null;
    if (action.type === "designContent" && action.asset === "file" && action.data) {
      result.size = action.data.byteLength;
      result.mimeType = action.mimeType;
    }
  }
  return result;
}

function findCreation(ctx: DesignStudioContext, kind: DesignStudioAssetKind, id: string, pending = ctx.pending()) {
  return pending.find((action): action is Extract<DesignStudioAction, { type: "designCreate" | "designClone" }> =>
    (action.type === "designCreate" || action.type === "designClone") && action.asset === kind && action.provisionalId === id
  );
}

function physicalId(ctx: DesignStudioContext, id: string): number {
  let resolved = ctx.resolveId(id);
  if (resolved !== undefined) return resolved;
  throw new Error(`Design Studio asset ${id} is still pending creation.`);
}

function logicalFolder(
  ctx: DesignStudioContext,
  folder: MarketoDesignStudioFolderRef,
): { id: string; type: "Folder" | "Program" } {
  if (!folder || typeof folder !== "object" || Array.isArray(folder)) throw new Error("A destination folder is required.");
  if (folder.type !== "folder" && folder.type !== "program") throw new Error("Folder type must be folder or program.");
  let id = logicalId(folder.id);
  let kind = id.startsWith("~") ? ctx.logicalKind(id) : undefined;
  let expected = folder.type === "program" ? "program" : "folder";
  if (kind !== undefined && kind !== expected) {
    throw new Error(folder.type === "folder"
      ? `Provisional Marketo asset ${id} is not an ordinary folder.`
      : `Provisional Marketo asset ${id} is not a program.`);
  }
  if (expected === "folder") assertNotDeleted(ctx, "folder", id);
  return { id, type: folder.type === "program" ? "Program" : "Folder" };
}

/** Resolve a folder's workspace through pending folder creations without trusting its claimed type. */
export async function resolveDesignStudioFolderWorkspace(
  ctx: DesignStudioContext,
  folder: { id: string; type: "Folder" | "Program" },
  seen = new Set<string>(),
): Promise<string> {
  let key = `${folder.type}:${folder.id}`;
  if (seen.has(key)) throw new Error(`Marketo folder ${folder.id} has a circular pending parent.`);
  seen.add(key);
  if (folder.type === "Folder") {
    let creation = findCreation(ctx, "folder", folder.id);
    if (creation?.type === "designCreate") {
      return await resolveDesignStudioFolderWorkspace(ctx, creation.parent, seen);
    }
  }
  let physical = ctx.resolveId(folder.id);
  if (physical === undefined) {
    throw new Error(`Marketo ${folder.type.toLowerCase()} ${folder.id} is still pending creation and its workspace cannot be resolved.`);
  }
  let raw = await (await ctx.client()).getFolder(physical, folder.type);
  if (!raw || readId(raw) !== physical) throw new Error(`Marketo ${folder.type.toLowerCase()} ${folder.id} was not found.`);
  let summary = normalizeFolder(raw);
  if (summary.type !== folder.type.toLowerCase()) {
    throw new Error(`Marketo asset ${folder.id} is not a ${folder.type.toLowerCase()}.`);
  }
  if (!summary.workspaceName) throw new Error(`Marketo ${folder.type.toLowerCase()} ${folder.id} has no workspace.`);
  await ctx.observe(
    "Validate Marketo destination workspace",
    `Read the workspace of Marketo ${folder.type.toLowerCase()} \`${folder.id}\`.`,
  );
  return summary.workspaceName;
}

const MAX_PAGE_TOKEN_IDS = 1_000;

type PageState = {
  offset: number;
  skip: number;
  batchSize: number;
  scope: string;
  pending?: string[];
  masked?: string[];
};

function validTokenIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PAGE_TOKEN_IDS &&
    value.every(id => typeof id === "string" && /^(?:[1-9]\d*|~[1-9]\d*)$/.test(id) && id.length <= 64) &&
    new Set(value).size === value.length;
}

async function paging(
  ctx: DesignStudioContext,
  options: { pageToken?: string; maxResults?: number },
  scope: string,
): Promise<PageState & { maxReturn: number }> {
  let state: PageState | undefined;
  if (options.pageToken !== undefined) {
    try {
      if (!ctx.consumePageCursor) throw new Error();
      let value = await ctx.consumePageCursor(options.pageToken, scope) as Partial<PageState>;
      if (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0 ||
          typeof value.skip !== "number" || !Number.isSafeInteger(value.skip) || value.skip < 0 ||
          typeof value.batchSize !== "number" || !Number.isSafeInteger(value.batchSize) ||
            value.batchSize < 1 || value.batchSize > ASSET_PAGE_MAX ||
          value.scope !== scope ||
          value.pending !== undefined && !validTokenIds(value.pending) ||
          value.masked !== undefined && !validTokenIds(value.masked)) {
        throw new Error();
      }
      state = {
        offset: value.offset,
        skip: value.skip,
        batchSize: value.batchSize,
        scope: value.scope,
        pending: value.pending,
        masked: value.masked,
      };
    } catch {
      throw new Error("Invalid Design Studio page token.");
    }
  }
  let maxReturn = options.maxResults ?? ASSET_PAGE_MAX;
  if (!Number.isSafeInteger(maxReturn) || maxReturn < 1 || maxReturn > ASSET_PAGE_MAX) {
    throw new Error(`maxResults must be between 1 and ${ASSET_PAGE_MAX}.`);
  }
  return { ...(state ?? { offset: 0, skip: 0, batchSize: maxReturn, scope }), maxReturn };
}

async function pageToken(ctx: DesignStudioContext, state: PageState): Promise<string> {
  if (state.pending !== undefined && !validTokenIds(state.pending) ||
      state.masked !== undefined && !validTokenIds(state.masked)) {
    throw new Error("Too many pending Design Studio changes to create a page token.");
  }
  if (!ctx.issuePageCursor) throw new Error("Design Studio pagination is unavailable in this session.");
  return await ctx.issuePageCursor(state, state.scope);
}

async function pageItems(
  ctx: DesignStudioContext,
  candidates: Summary[],
  remainingCandidates: string[],
  upstream: Summary[],
  upstreamCount: number,
  upstreamHasMore: boolean,
  state: PageState,
  maskedIds: Set<string>,
  maxReturn: number,
): Promise<{ items: Summary[]; nextPageToken?: string }> {
  let items = candidates.slice(0, maxReturn);
  let available = upstream.filter(item => !maskedIds.has(item.id));
  let fromUpstream = available.slice(state.skip, state.skip + maxReturn - items.length);
  items.push(...fromUpstream);
  let skip = state.skip + fromUpstream.length;
  let offset = state.offset;
  if (skip >= available.length && upstreamHasMore) {
    offset += upstreamCount;
    skip = 0;
  }
  let hasMore = remainingCandidates.length > 0 || skip < available.length || upstreamHasMore;
  return {
    items,
    nextPageToken: hasMore
      ? await pageToken(ctx, {
          offset,
          skip,
          batchSize: state.batchSize,
          scope: state.scope,
          pending: remainingCandidates,
          masked: state.masked,
        })
      : undefined,
  };
}

function pendingFolderBatch(
  ctx: DesignStudioContext,
  ids: string[],
  maxReturn: number,
  pending: DesignStudioAction[],
): string[] {
  let batch: string[] = [];
  let includesRead = false;
  for (let id of ids) {
    let actions = actionsFor(ctx, "folder", id, pending);
    let needsRead = !findCreation(ctx, "folder", id, pending) &&
      !actions.some(action => action.type === "designDeleteFolder");
    if (needsRead && includesRead) break;
    batch.push(id);
    includesRead ||= needsRead;
    if (batch.length >= maxReturn) break;
  }
  return batch;
}

function resolvedMask(ctx: DesignStudioContext, ids: string[] | undefined): Set<string> {
  let result = new Set<string>();
  for (let id of ids ?? []) {
    let resolved = ctx.resolveId(id);
    if (resolved !== undefined) result.add(String(resolved));
  }
  return result;
}

function matches(summary: Summary, options: MarketoDesignStudioListOptions): boolean {
  if (options.name !== undefined && summary.name.toLocaleLowerCase() !== requiredText(options.name, "name").toLocaleLowerCase()) return false;
  return options.status === undefined || summary.status?.toLocaleLowerCase() === options.status.toLocaleLowerCase();
}

@validateRpc()
export class MarketoDesignStudioImpl extends RpcTarget {
  #ctx: DesignStudioContext;
  #ownsContext: boolean;
  #disposed = false;

  constructor(ctx: DesignStudioContext, ownsContext = false) {
    super();
    this.#ctx = ctx;
    this.#ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.#ownsContext && !this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

  getEmailDesigner(): MarketoEmailDesignerImpl {
    return new MarketoEmailDesignerImpl(
      retainSessionContext(this.#ctx as DesignStudioContext & EmailDesignerContext),
      true,
    );
  }

  async listFolders(options: MarketoDesignStudioFolderListOptions = {}) {
    let validated = folderOptions(options);
    let root = options.root ? logicalFolder(this.#ctx, options.root) : undefined;
    let name = options.name === undefined ? undefined : requiredText(options.name, "name");
    let scope = JSON.stringify(["folder", name?.toLocaleLowerCase(), root, validated.maxDepth, validated.workspace]);
    let state = await paging(this.#ctx, options, scope);
    let { offset, maxReturn, batchSize } = state;
    let client = await this.#ctx.client();
    let pending = this.#ctx.pending();
    let physicalRoot = root ? this.#ctx.resolveId(root.id) : undefined;
    let rootRef = root && physicalRoot !== undefined ? { id: physicalRoot, type: root.type } : undefined;
    let browse = options.name === undefined || validated.maxDepth !== undefined;
    let raw: RawFolder[];
    let upstreamCount = 0;
    let upstreamHasMore = false;
    if (root && physicalRoot === undefined) {
      raw = [];
    } else if (browse) {
      let page = await folderBrowsePage(
        client,
        rootRef,
        root ? (validated.maxDepth ?? DEFAULT_FOLDER_DEPTH) + 1 : validated.maxDepth,
        validated.workspace,
        offset,
        batchSize,
      );
      raw = page.raw;
      upstreamCount = page.consumed;
      upstreamHasMore = page.hasMore;
    } else {
      let types = ["Folder", "Program"] as const;
      let pages = await Promise.all(types.map(type => client.getFoldersByName(name ?? "", {
        type, root: rootRef, workspace: validated.workspace,
      })));
      raw = pages.flatMap((page, index) => page.filter(item => normalizeFolder(item).type === types[index]!.toLowerCase()));
      upstreamCount = raw.length;
    }
    if (physicalRoot !== undefined) raw = raw.filter(item => readId(item) !== physicalRoot);
    let upstream = raw.map(item => normalizeFolder(item))
      .map(item => overlaySummary(item, actionsFor(this.#ctx, "folder", item.id, pending))).filter(notNull)
      .filter(item => name === undefined || item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      .filter(item => validated.workspace === undefined || item.workspaceName === validated.workspace);
    let candidateIds = (state.pending ?? pendingFolderIds(this.#ctx, root, validated.maxDepth, pending))
      .filter(id => !root || !sameLogicalId(this.#ctx, id, root.id));
    let candidateBatch = pendingFolderBatch(this.#ctx, candidateIds, maxReturn, pending);
    let candidates = await pendingFolderSummaries(
      this.#ctx, client, candidateBatch, root, physicalRoot, validated.maxDepth, validated.workspace, pending,
    );
    candidates = candidates
      .filter(item => options.name === undefined || item.name.toLocaleLowerCase() === options.name.trim().toLocaleLowerCase());
    let pageState = state.masked === undefined ? {
      ...state,
      masked: candidateIds,
    } : state;
    let result = await pageItems(
      this.#ctx,
      candidates,
      candidateIds.slice(candidateBatch.length),
      upstream,
      upstreamCount,
      upstreamHasMore,
      pageState,
      resolvedMask(this.#ctx, pageState.masked),
      maxReturn,
    );
    await this.#ctx.observe("List Marketo Design Studio folders", `Read ${result.items.length} Design Studio folder(s).`);
    return result;
  }

  getFolder(id: string, type: "folder" | "program") {
    if (type !== "folder" && type !== "program") throw new Error("Folder type must be folder or program.");
    let validatedId = logicalId(id);
    return new MarketoDesignStudioFolderImpl(retainSessionContext(this.#ctx), validatedId, type, true);
  }
  async #create(kind: DesignStudioAssetKind, destination: MarketoDesignStudioFolderRef, input: DesignStudioCreateInput) {
    let parent = logicalFolder(this.#ctx, destination);
    if ((kind === "emailTemplate" || kind === "file") && parent.type !== "Folder") {
      throw new Error(`Marketo ${kind === "file" ? "file" : "email-template"} destination must be an ordinary folder.`);
    }
    assertDurablePayload({ parent, input });
    let provisionalId = this.#ctx.allocateProvisional();
    await submitDesign(this.#ctx, { type: "designCreate", asset: kind, provisionalId, parent, input });
    return handle(this.#ctx, kind, provisionalId, kind === "folder" ? "folder" : undefined, true);
  }
  async createFolder(destination: MarketoDesignStudioFolderRef, name: string, description?: string): Promise<MarketoDesignStudioFolder> {
    let metadata = { description };
    return await this.#create("folder", destination, {
      name: requiredText(name, "Folder name"), description: optionalText(metadata, "description"),
    }) as MarketoDesignStudioFolderImpl;
  }
  async createEmail(destination: MarketoDesignStudioFolderRef, input: MarketoCreateEmailInput): Promise<MarketoEmail> {
    let value = createInput(input, ["name", "templateId", "subject", "fromName", "fromEmail", "replyEmail", "description"]);
    let templateId = logicalId(value.templateId);
    assertNotDeleted(this.#ctx, "emailTemplate", templateId);
    return await this.#create("email", destination, {
      name: requiredText(value.name, "Email name"), description: optionalText(value, "description"),
      subject: requiredText(value.subject, "subject"), fromName: requiredText(value.fromName, "fromName"),
      fromEmail: requiredText(value.fromEmail, "fromEmail"), replyEmail: requiredText(value.replyEmail, "replyEmail"),
      templateId,
    }) as MarketoEmailImpl;
  }
  async createEmailTemplate(destination: MarketoDesignStudioFolderRef, input: MarketoCreateEmailTemplateInput): Promise<MarketoEmailTemplate> {
    let value = createInput(input, ["name", "content", "description"]);
    return await this.#create("emailTemplate", destination, {
      name: requiredText(value.name, "Template name"), content: requireContent(value.content),
      description: optionalText(value, "description"),
    }) as MarketoEmailTemplateImpl;
  }
  async createLandingPage(destination: MarketoDesignStudioFolderRef, input: MarketoCreateLandingPageInput): Promise<MarketoLandingPage> {
    let value = createInput(input, ["name", "templateId", "description"]);
    let templateId = logicalId(value.templateId);
    assertNotDeleted(this.#ctx, "landingPageTemplate", templateId);
    return await this.#create("landingPage", destination, {
      name: requiredText(value.name, "Landing page name"), description: optionalText(value, "description"),
      templateId,
    }) as MarketoLandingPageImpl;
  }
  async createLandingPageTemplate(destination: MarketoDesignStudioFolderRef, input: MarketoCreateLandingPageTemplateInput): Promise<MarketoLandingPageTemplate> {
    let value = createInput(input, ["name", "description", "templateType", "enableMunchkin"]);
    let templateType = value.templateType;
    if (templateType !== undefined && templateType !== "guided" && templateType !== "freeForm") {
      throw new Error("templateType must be guided or freeForm.");
    }
    return await this.#create("landingPageTemplate", destination, {
      name: requiredText(value.name, "Template name"), description: optionalText(value, "description"),
      templateType, enableMunchkin: optionalBoolean(value, "enableMunchkin"),
    }) as MarketoLandingPageTemplateImpl;
  }
  async createForm(destination: MarketoDesignStudioFolderRef, input: MarketoCreateFormInput): Promise<MarketoForm> {
    let value = createInput(input, ["name", "description", "locale", "language"]);
    return await this.#create("form", destination, {
      name: requiredText(value.name, "Form name"), description: optionalText(value, "description"),
      locale: optionalText(value, "locale"), language: optionalText(value, "language"),
    }) as MarketoFormImpl;
  }
  async createSnippet(destination: MarketoDesignStudioFolderRef, input: MarketoCreateSnippetInput): Promise<MarketoSnippet> {
    let value = createInput(input, ["name", "description", "html", "text"]);
    let html = value.html === undefined ? undefined : requireContent(value.html, "HTML content");
    let text = value.text === undefined ? undefined : requireContent(value.text, "Text content");
    return await this.#create("snippet", destination, {
      name: requiredText(value.name, "Snippet name"), description: optionalText(value, "description"), html, text,
    }) as MarketoSnippetImpl;
  }
  async createFile(destination: MarketoDesignStudioFolderRef, input: MarketoCreateFileInput): Promise<MarketoFile> {
    let value = createInput(input, ["name", "mimeType", "data", "description"]);
    let data = requireFile(value.data);
    let digest = await sha256(data);
    return await this.#create("file", destination, {
      name: requiredText(value.name, "File name"), description: optionalText(value, "description"),
      mimeType: normalizeMimeType(value.mimeType), data, sha256: digest,
    }) as MarketoFileImpl;
  }
  async #clone(kind: Exclude<DesignStudioAssetKind, "folder" | "file">, sourceId: string, name: string, destination: MarketoDesignStudioFolderRef) {
    let source = logicalId(sourceId);
    assertNotDeleted(this.#ctx, kind, source);
    let parent = logicalFolder(this.#ctx, destination);
    if (kind === "emailTemplate" && parent.type !== "Folder") {
      throw new Error("Marketo email-template destination must be an ordinary folder.");
    }
    let cloneName = requiredText(name, "Clone name");
    assertDurablePayload({ source, parent, name: cloneName });
    let provisionalId = this.#ctx.allocateProvisional();
    await submitDesign(this.#ctx, {
      type: "designClone", asset: kind, provisionalId, sourceId: source, parent, name: cloneName,
    });
    return handle(this.#ctx, kind, provisionalId, undefined, true);
  }
  async cloneEmail(sourceId: string, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoEmail> { return await this.#clone("email", sourceId, name, destination) as MarketoEmailImpl; }
  async cloneEmailTemplate(sourceId: string, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoEmailTemplate> { return await this.#clone("emailTemplate", sourceId, name, destination) as MarketoEmailTemplateImpl; }
  async cloneLandingPage(sourceId: string, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoLandingPage> { return await this.#clone("landingPage", sourceId, name, destination) as MarketoLandingPageImpl; }
  async cloneLandingPageTemplate(sourceId: string, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoLandingPageTemplate> { return await this.#clone("landingPageTemplate", sourceId, name, destination) as MarketoLandingPageTemplateImpl; }
  async cloneForm(sourceId: string, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoForm> { return await this.#clone("form", sourceId, name, destination) as MarketoFormImpl; }
  async cloneSnippet(sourceId: string, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoSnippet> { return await this.#clone("snippet", sourceId, name, destination) as MarketoSnippetImpl; }
  listEmails(options?: MarketoDesignStudioListOptions) { return this.#list("email", options); }
  getEmail(id: string) { let value = logicalId(id); return new MarketoEmailImpl(retainSessionContext(this.#ctx), value, undefined, true); }
  listEmailTemplates(options?: MarketoDesignStudioListOptions) { return this.#list("emailTemplate", options); }
  getEmailTemplate(id: string) { let value = logicalId(id); return new MarketoEmailTemplateImpl(retainSessionContext(this.#ctx), value, undefined, true); }
  listLandingPages(options?: MarketoDesignStudioListOptions) { return this.#list("landingPage", options); }
  getLandingPage(id: string) { let value = logicalId(id); return new MarketoLandingPageImpl(retainSessionContext(this.#ctx), value, undefined, true); }
  listLandingPageTemplates(options?: MarketoDesignStudioListOptions) { return this.#list("landingPageTemplate", options); }
  getLandingPageTemplate(id: string) { let value = logicalId(id); return new MarketoLandingPageTemplateImpl(retainSessionContext(this.#ctx), value, undefined, true); }
  listForms(options?: MarketoDesignStudioListOptions) { return this.#list("form", options); }
  getForm(id: string) { let value = logicalId(id); return new MarketoFormImpl(retainSessionContext(this.#ctx), value, undefined, true); }
  listSnippets(options?: MarketoDesignStudioListOptions) { return this.#list("snippet", options); }
  getSnippet(id: string) { let value = logicalId(id); return new MarketoSnippetImpl(retainSessionContext(this.#ctx), value, undefined, true); }
  listFiles(options: MarketoDesignStudioFileListOptions = {}) {
    if ("status" in options && options.status !== undefined) {
      throw new Error("status is not supported when listing Design Studio files.");
    }
    return this.#list("file", options);
  }
  getFile(id: string) { let value = logicalId(id); return new MarketoFileImpl(retainSessionContext(this.#ctx), value, undefined, true); }

  async #list(kind: Exclude<DesignStudioAssetKind, "folder">, options: MarketoDesignStudioListOptions = {}) {
    let upstreamPaged = options.name === undefined || kind === "landingPage" || kind === "snippet" ||
      kind === "landingPageTemplate" && options.status !== undefined;
    let logicalParent = options.folder ? logicalFolder(this.#ctx, options.folder) : undefined;
    let name = options.name === undefined ? undefined : requiredText(options.name, "name");
    let status = statusValue(options.status);
    let scope = JSON.stringify([kind, name?.toLocaleLowerCase(), status, logicalParent]);
    let state = await paging(this.#ctx, options, scope);
    let { offset, maxReturn, batchSize } = state;
    let physicalParent = logicalParent ? this.#ctx.resolveId(logicalParent.id) : undefined;
    let folder = logicalParent && physicalParent !== undefined ? { id: physicalParent, type: logicalParent.type } : undefined;
    let client = await this.#ctx.client();
    let pending = this.#ctx.pending();
    let raw: (RawDesignStudioAsset | RawFile)[];
    if (logicalParent && physicalParent === undefined) raw = [];
    else if (name !== undefined) raw = await listByName(client, kind, name, status, folder, offset, batchSize);
    else raw = await listAssets(client, kind, status, folder, offset, batchSize);
    let upstreamCount = raw.length;
    let upstreamHasMore = upstreamPaged && upstreamCount === batchSize;
    if (physicalParent !== undefined) {
      raw = raw.filter(item => {
        let rawFolder = recordValue(recordValue(item).folder);
        let id = rawFolder.id ?? rawFolder.value;
        return id === physicalParent && textValue(rawFolder.type)?.toLowerCase() === logicalParent?.type.toLowerCase();
      });
    }
    let upstream = raw.map(item => normalize(kind, item))
      .map(item => overlaySummary(item, actionsFor(this.#ctx, kind, item.id, pending))).filter(notNull)
      .filter(item => matches(item, options));
    let candidateIds = state.pending ?? pendingAssetIds(this.#ctx, kind, logicalParent, pending);
    let candidateBatch = candidateIds.slice(0, maxReturn);
    let candidates = await pendingAssetSummaries(
      this.#ctx, client, kind, candidateBatch, logicalParent, physicalParent, pending,
    );
    candidates = candidates.filter(item => matches(item, options));
    let pageState = state.masked === undefined ? {
      ...state,
      masked: candidateIds,
    } : state;
    let result = await pageItems(
      this.#ctx,
      candidates,
      candidateIds.slice(candidateBatch.length),
      upstream,
      upstreamCount,
      upstreamHasMore,
      pageState,
      resolvedMask(this.#ctx, pageState.masked),
      maxReturn,
    );
    if (kind === "form") result.items = result.items.map(formSummary);
    await this.#ctx.observe(`List Marketo ${kind} assets`, `Read ${result.items.length} Design Studio ${kind} asset(s).`);
    return result;
  }
}

function notNull<T>(value: T | null): value is T { return value !== null; }

async function folderBrowsePage(
  client: MarketoClient,
  root: MarketoFolderRef | undefined,
  maxDepth: number | undefined,
  workspace: string | undefined,
  offset: number,
  maxReturn: number,
): Promise<{ raw: RawFolder[]; consumed: number; hasMore: boolean }> {
  let raw: RawFolder[] = [];
  let consumed = 0;
  let hasMore = false;
  let attempts = root ? 2 : 1;
  while (attempts-- > 0 && raw.length < maxReturn) {
    let requested = maxReturn - raw.length;
    let page = await client.getFolders({ root, maxDepth, workspace, offset: offset + consumed, maxReturn: requested });
    consumed += page.length;
    raw.push(...(root ? page.filter(item => readId(item) !== root.id) : page));
    hasMore = page.length === requested;
    if (!hasMore) break;
  }
  return { raw, consumed, hasMore };
}

function statusValue(status: string | undefined): MarketoAssetStatus | undefined {
  if (status === undefined) return undefined;
  if (status !== "draft" && status !== "approved") throw new Error("status must be draft or approved.");
  return status;
}

async function listAssets(client: MarketoClient, kind: Exclude<DesignStudioAssetKind, "folder">, status: MarketoAssetStatus | undefined, folder: MarketoFolderRef | undefined, offset: number, maxReturn: number) {
  switch (kind) {
    case "email": return await client.getEmails({ status, folder, offset, maxReturn });
    case "emailTemplate": return await client.getEmailTemplates({ status, folder, offset, maxReturn });
    case "landingPage": return await client.getLandingPages({ status, folder, offset, maxReturn });
    case "landingPageTemplate": return await client.getLandingPageTemplates({ status, folder, offset, maxReturn });
    case "form": return await client.getForms({ status, folder, offset, maxReturn });
    case "snippet": return await client.getSnippets({ status, folder, offset, maxReturn });
    case "file": return await client.getFiles({ folder, offset, maxReturn });
  }
}

async function listByName(client: MarketoClient, kind: Exclude<DesignStudioAssetKind, "folder">, name: string, status: MarketoAssetStatus | undefined, folder: MarketoFolderRef | undefined, offset: number, maxReturn: number) {
  switch (kind) {
    case "email": return await client.getEmailsByName(name, { status, folder });
    case "emailTemplate": return await client.getEmailTemplatesByName(name, status);
    case "landingPage": return await client.getLandingPagesByName(name, { status, offset, maxReturn });
    case "landingPageTemplate": return status === undefined
      ? await client.getLandingPageTemplatesByName(name)
      : await client.getLandingPageTemplates({ status, folder, offset, maxReturn });
    case "form": return await client.getFormsByName(name, status);
    case "snippet": return (await client.getSnippets({ status, folder, offset, maxReturn })).filter(item => item.name?.toLocaleLowerCase() === name.toLocaleLowerCase());
    case "file": return await client.getFilesByName(name);
  }
}

function pendingAssetIds(
  ctx: DesignStudioContext,
  kind: Exclude<DesignStudioAssetKind, "folder">,
  parent: { id: string; type: "Folder" | "Program" } | undefined,
  pending: DesignStudioAction[],
): string[] {
  let ids: string[] = [];
  for (let action of pending) {
    if ((action.type === "designCreate" || action.type === "designClone") && action.asset === kind &&
        (!parent || sameLogicalId(ctx, action.parent.id, parent.id) && action.parent.type === parent.type)) {
      pushLogicalId(ctx, ids, action.provisionalId);
    } else if ("targetId" in action && action.type !== "designDeleteFolder" && action.asset === kind) {
      pushLogicalId(ctx, ids, action.targetId);
    }
  }
  return ids;
}

function pushLogicalId(ctx: DesignStudioContext, ids: string[], id: string): boolean {
  if (ids.some(existing => sameLogicalId(ctx, existing, id))) return false;
  ids.push(id);
  return true;
}

function pendingFolderCreationIds(
  ctx: DesignStudioContext,
  root: { id: string; type: "Folder" | "Program" } | undefined,
  maxDepth: number | undefined,
  pending: DesignStudioAction[],
): string[] {
  let creations = pending.filter((action): action is Extract<DesignStudioAction, { type: "designCreate" }> =>
    action.type === "designCreate" && action.asset === "folder"
  );
  if (!root) {
    let ids: string[] = [];
    for (let creation of creations) pushLogicalId(ctx, ids, creation.provisionalId);
    return ids;
  }

  let ids: string[] = [];
  let visited = [root.id];
  let queue = [{ id: root.id, depth: 0 }];
  while (queue.length > 0) {
    let current = queue.shift();
    if (!current) break;
    if (current.depth >= (maxDepth ?? DEFAULT_FOLDER_DEPTH)) continue;
    for (let creation of creations) {
      if (!sameLogicalId(ctx, creation.parent.id, current.id) ||
          !pushLogicalId(ctx, visited, creation.provisionalId)) continue;
      pushLogicalId(ctx, ids, creation.provisionalId);
      queue.push({ id: creation.provisionalId, depth: current.depth + 1 });
    }
  }
  return ids;
}

function pendingFolderIds(
  ctx: DesignStudioContext,
  root: { id: string; type: "Folder" | "Program" } | undefined,
  maxDepth: number | undefined,
  pending: DesignStudioAction[],
): string[] {
  let ids = pendingFolderCreationIds(ctx, root, maxDepth, pending);
  for (let action of pending) {
    if (action.type === "designMetadata" && action.asset === "folder" || action.type === "designDeleteFolder") {
      pushLogicalId(ctx, ids, action.targetId);
    }
  }
  return ids;
}

async function pendingFolderSummaries(
  ctx: DesignStudioContext,
  client: MarketoClient,
  ids: string[],
  root: { id: string; type: "Folder" | "Program" } | undefined,
  physicalRoot: number | undefined,
  maxDepth: number | undefined,
  workspace: string | undefined,
  pending: DesignStudioAction[],
): Promise<Summary[]> {
  let eligibleCreations = pendingFolderCreationIds(ctx, root, maxDepth, pending);
  let workspaceReads = new Map<string, Promise<string | undefined>>();
  let inheritedWorkspace = (id: string, type: "Folder" | "Program"): Promise<string | undefined> => {
    let key = `${type}:${id}`;
    let existing = workspaceReads.get(key);
    if (existing) return existing;
    let read = (async () => {
      let creation = findCreation(ctx, "folder", id, pending);
      if (creation) return await inheritedWorkspace(creation.parent.id, creation.parent.type);
      let physical = ctx.resolveId(id);
      if (physical === undefined) return undefined;
      let raw = await client.getFolder(physical, type);
      if (!raw) return undefined;
      if (readId(raw) !== physical) {
        throw new Error(`Marketo returned asset ${readId(raw)} when ${physical} was requested.`);
      }
      return normalizeFolder(raw).workspaceName;
    })();
    workspaceReads.set(key, read);
    return read;
  };
  let summaries = await Promise.all(ids.map(async id => {
    let creation = findCreation(ctx, "folder", id, pending);
    if (creation) {
      if (root && !eligibleCreations.some(candidate => sameLogicalId(ctx, candidate, id))) {
        return undefined;
      }
      let summary = creationSummary(creation);
      if (workspace !== undefined) {
        summary.workspaceName = await inheritedWorkspace(creation.parent.id, creation.parent.type);
        if (summary.workspaceName !== workspace) return undefined;
      }
      return summary;
    }
    if (actionsFor(ctx, "folder", id, pending).some(action => action.type === "designDeleteFolder")) {
      return undefined;
    }
    let physical = ctx.resolveId(id);
    if (physical === undefined) return undefined;
    let raw = await client.getFolder(physical, "Folder");
    if (!raw) return undefined;
    if (readId(raw) !== physical) throw new Error(`Marketo returned asset ${readId(raw)} when ${physical} was requested.`);
    let summary = normalizeFolder(raw);
    if (workspace !== undefined && summary.workspaceName !== workspace) return undefined;
    if (root) {
      if (physicalRoot === undefined) return undefined;
      let current = raw;
      let withinRoot = false;
      for (let depth = 1; depth <= (maxDepth ?? DEFAULT_FOLDER_DEPTH); depth++) {
        let parent = recordValue(recordValue(current).parent);
        if (parent.id === physicalRoot) {
          withinRoot = true;
          break;
        }
        if (typeof parent.id !== "number" || !Number.isSafeInteger(parent.id) || parent.id <= 0) break;
        let parentType: "Program" | "Folder" = textValue(parent.type)?.toLowerCase() === "program" ? "Program" : "Folder";
        let ancestor = await client.getFolder(parent.id, parentType);
        if (!ancestor) break;
        if (readId(ancestor) !== parent.id) {
          throw new Error(`Marketo returned asset ${readId(ancestor)} when ${parent.id} was requested.`);
        }
        current = ancestor;
      }
      if (!withinRoot) return undefined;
    }
    return { ...summary, id };
  }));
  return summaries.filter((item): item is Summary => item !== undefined)
    .map(item => overlaySummary(item, actionsFor(ctx, "folder", item.id, pending))).filter(notNull);
}

async function pendingAssetSummaries(
  ctx: DesignStudioContext,
  client: MarketoClient,
  kind: Exclude<DesignStudioAssetKind, "folder">,
  ids: string[],
  parent: { id: string; type: "Folder" | "Program" } | undefined,
  physicalParent: number | undefined,
  pending: DesignStudioAction[],
): Promise<Summary[]> {
  let summaries = await Promise.all(ids.map(async id => {
    let creation = findCreation(ctx, kind, id, pending);
    if (creation) {
      if (parent && (!sameLogicalId(ctx, creation.parent.id, parent.id) || creation.parent.type !== parent.type)) {
        return undefined;
      }
      return creation.type === "designClone"
        ? await simulatedSummary(ctx, kind, id, undefined, pending)
        : creationSummary(creation);
    }
    if (parent && physicalParent === undefined) return undefined;
    let physical = ctx.resolveId(id);
    if (physical === undefined) return undefined;
    let raw = await readAsset(client, kind, physical);
    if (!raw) return undefined;
    if (readId(raw) !== physical) throw new Error(`Marketo returned asset ${readId(raw)} when ${physical} was requested.`);
    if (parent && physicalParent !== undefined) {
      let rawFolder = recordValue(recordValue(raw).folder);
      let folderId = rawFolder.id ?? rawFolder.value;
      if (folderId !== physicalParent || textValue(rawFolder.type)?.toLowerCase() !== parent.type.toLowerCase()) {
        return undefined;
      }
    }
    return { ...normalize(kind, raw), id };
  }));
  return summaries.filter((item): item is Summary => item !== undefined)
    .map(item => overlaySummary(item, actionsFor(ctx, kind, item.id, pending))).filter(notNull);
}

abstract class AssetImpl extends RpcTarget {
  protected ctx: DesignStudioContext;
  protected id: string;
  protected abstract kind: DesignStudioAssetKind;
  protected folderType?: "folder" | "program";
  private ownsContext: boolean;
  private disposed = false;
  constructor(ctx: DesignStudioContext, id: string, folderType?: "folder" | "program", ownsContext = false) {
    super(); this.ctx = ctx; this.id = id; this.folderType = folderType; this.ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.ownsContext && !this.disposed) {
      this.disposed = true;
      this.ctx.dispose();
    }
  }

  protected assertReadable(): void {
    assertNotDeleted(this.ctx, this.kind, this.id);
  }

  protected async summary(): Promise<Summary> {
    this.assertReadable();
    let summary = await simulatedSummary(this.ctx, this.kind, this.id, this.folderType);
    await this.ctx.observe(`Read Marketo ${this.kind} ${this.id}`, `Read Design Studio ${this.kind} \`${this.id}\`.`);
    return summary;
  }

  protected async metadata(patch: DesignStudioMetadata): Promise<void> {
    this.assertReadable();
    await submitDesign(this.ctx, { type: "designMetadata", asset: this.kind, targetId: this.id, patch });
  }

  protected async lifecycle(operation: "approve" | "unapprove" | "discardDraft" | "delete"): Promise<void> {
    this.assertReadable();
    await this.ctx.assertCurrent?.();
    if (this.kind === "folder" || this.kind === "file") throw new Error("This asset has no approval lifecycle.");
    if (this.id.startsWith("~") && this.ctx.logicalKind(this.id) !== this.kind) {
      throw new Error(`Provisional Marketo asset ${this.id} is not a ${this.kind}.`);
    }
    let pending = [...this.ctx.pending()];
    let snapshotCtx = { ...this.ctx, pending: () => pending };
    let resolvedId = this.ctx.resolveId(this.id);
    let metadata = await simulatedSummary(snapshotCtx, this.kind, this.id, this.folderType, pending);
    let status = metadata.status?.toLocaleLowerCase();
    if (operation === "approve" && status !== "draft" && status !== "approved with draft") {
      throw new Error(`Marketo ${this.kind} ${this.id} has no draft to approve.`);
    }
    if (operation === "unapprove" && status !== "approved" && status !== "approved with draft") {
      throw new Error(`Marketo ${this.kind} ${this.id} is not approved.`);
    }
    let snapshot: DesignStudioLifecycleSnapshot = {
      metadata: lifecycleMetadata(metadata),
      content: await handle(snapshotCtx, this.kind, this.id, this.folderType).lifecycleSnapshotContent(),
      affectedDependents: await readClassicDependents(
        await this.ctx.client(), this.kind, resolvedId, operation,
      ),
    };
    await submitDesign(this.ctx, {
      type: "designLifecycle", asset: this.kind, targetId: this.id, operation, snapshot,
    });
  }

  protected async lifecycleSnapshotContent(): Promise<unknown> { return await this.publishableContent(); }
  protected abstract publishableContent(): Promise<unknown>;
}

async function simulatedSummary(
  ctx: DesignStudioContext,
  kind: DesignStudioAssetKind,
  id: string,
  folderType?: "folder" | "program",
  pending = ctx.pending(),
): Promise<Summary> {
  let creation = findCreation(ctx, kind, id, pending);
  let summary: Summary;
  if (creation?.type === "designClone") {
    assertAcyclicCloneSource(ctx, kind, id, pending);
    let source = await simulatedSummary(beforeAction(ctx, creation.id), kind, creation.sourceId);
    for (let field of ["id", "name", "status", "workspaceName", "createdAt", "updatedAt", "url"]) {
      delete source[field];
    }
    let workspaceName = await destinationWorkspace(ctx, creation.parent, pending);
    summary = {
      ...source,
      id: creation.provisionalId,
      name: creation.name,
      status: "draft",
      ...(workspaceName === undefined ? {} : { workspaceName }),
    };
  } else if (creation) summary = creationSummary(creation);
  else {
    let deleted = actionsFor(ctx, kind, id, pending).some(action =>
      action.type === "designDeleteFolder" || action.type === "designLifecycle" && action.operation === "delete"
    );
    if (deleted) throw new Error(`Marketo ${kind} ${id} was deleted.`);
    let physical = physicalId(ctx, id);
    let raw = await readAsset(await ctx.client(), kind, physical, folderType);
    if (!raw) throw new Error(`Marketo ${kind} ${id} was not found.`);
    let returned = readId(raw);
    if (returned !== physical) throw new Error(`Marketo returned asset ${returned} when ${physical} was requested.`);
    summary = kind === "folder" ? normalizeFolder(raw) : normalize(kind, raw);
    summary.id = id;
  }
  let overlaid = overlaySummary(summary, actionsFor(ctx, kind, id, pending));
  if (!overlaid) throw new Error(`Marketo ${kind} ${id} was deleted.`);
  return overlaid;
}

async function destinationWorkspace(
  ctx: DesignStudioContext,
  parent: { id: string; type: "Folder" | "Program" },
  pending: DesignStudioAction[],
): Promise<string | undefined> {
  if (parent.type === "Folder") {
    let creation = findCreation(ctx, "folder", parent.id, pending);
    if (creation) return await destinationWorkspace(ctx, creation.parent, pending);
  }
  let physical = ctx.resolveId(parent.id);
  if (physical === undefined) return undefined;
  let client = await ctx.client();
  if (typeof client.getFolder !== "function") return undefined;
  let raw = await client.getFolder(physical, parent.type);
  if (!raw) return undefined;
  if (readId(raw) !== physical) {
    throw new Error(`Marketo returned asset ${readId(raw)} when ${physical} was requested.`);
  }
  return normalizeFolder(raw).workspaceName;
}

async function readAsset(client: MarketoClient, kind: DesignStudioAssetKind, id: number, folderType?: "folder" | "program") {
  switch (kind) {
    case "folder": return await client.getFolder(id, folderType === "program" ? "Program" : "Folder");
    case "email": return await client.getEmail(id);
    case "emailTemplate": return await client.getEmailTemplate(id);
    case "landingPage": return await client.getLandingPage(id);
    case "landingPageTemplate": return await client.getLandingPageTemplate(id);
    case "form": return await client.getForm(id);
    case "snippet": return await client.getSnippet(id);
    case "file": return await client.getFile(id);
  }
}

/** Read the publishable classic asset state stored with a lifecycle approval. */
export async function readDesignStudioLifecycleSnapshot(
  client: MarketoClient,
  kind: Exclude<DesignStudioAssetKind, "folder" | "file">,
  id: number,
  operation: "approve" | "unapprove" | "discardDraft" | "delete",
): Promise<DesignStudioLifecycleSnapshot> {
  let raw = await readAsset(client, kind, id);
  if (!raw || readId(raw) !== id) throw new Error(`Marketo ${kind} ${id} was not found.`);
  let content: unknown;
  if (kind === "email") {
    let rawContent = await client.getEmailContent(id);
    content = canonicalEmailContent(rawContent, emailSections(rawContent));
  } else if (kind === "emailTemplate" || kind === "landingPageTemplate") {
    let response = kind === "emailTemplate"
      ? await client.getEmailTemplateContent(id)
      : await client.getLandingPageTemplateContent(id);
    if (!response || readId(response) !== id || typeof response.content !== "string") {
      throw new Error(`Marketo returned invalid ${kind} content for ${id}.`);
    }
    content = response.content;
  } else if (kind === "landingPage") {
    content = canonicalLandingPageContent(await client.getLandingPageContent(id));
  } else if (kind === "form") {
    content = canonicalFormFields(await client.getFormFields(id));
  } else {
    let result: MarketoSnippetContent = {};
    for (let item of await client.getSnippetContent(id)) {
      if (item.type?.toLowerCase() === "html") result.html = textValue(item.content);
      if (item.type?.toLowerCase() === "text") result.text = textValue(item.content);
    }
    content = result;
  }
  return {
    metadata: lifecycleMetadata(normalize(kind, raw)),
    content,
    affectedDependents: await readClassicDependents(client, kind, id, operation),
  };
}

async function readClassicDependents(
  client: MarketoClient,
  kind: Exclude<DesignStudioAssetKind, "folder" | "file">,
  id: number | undefined,
  operation: "approve" | "unapprove" | "discardDraft" | "delete",
): Promise<Record<string, unknown>[] | null> {
  if (operation !== "approve" && operation !== "delete") return null;
  if (kind !== "emailTemplate" && kind !== "form") return null;
  if (id === undefined) return [];

  let dependents: Record<string, unknown>[] = [];
  let identities = new Map<string, string>();
  let pageSignatures = new Set<string>();
  for (let offset = 0; ; offset += ASSET_PAGE_MAX) {
    let page = kind === "emailTemplate"
      ? await client.getEmailTemplateUsedBy(id, { offset, maxReturn: ASSET_PAGE_MAX })
      : await client.getFormUsedBy(id, { offset, maxReturn: ASSET_PAGE_MAX });
    let signature = JSON.stringify(page);
    if (page.length > 0 && pageSignatures.has(signature)) {
      throw new Error("Marketo repeated a classic used-by page.");
    }
    pageSignatures.add(signature);
    for (let dependent of page) {
      let identity = `${dependent.type.toLocaleLowerCase()}\0${dependent.id}`;
      let previous = identities.get(identity);
      let current = JSON.stringify(dependent);
      if (previous !== undefined) {
        if (previous !== current) throw new Error("Marketo changed a dependency across classic used-by pages.");
        continue;
      }
      if (dependents.length === MAX_CLASSIC_DEPENDENTS) {
        throw new Error(`Classic lifecycle dependencies cannot exceed ${MAX_CLASSIC_DEPENDENTS} records.`);
      }
      identities.set(identity, current);
      dependents.push(dependent);
    }
    if (page.length < ASSET_PAGE_MAX) {
      return dependents.toSorted((left, right) =>
        String(left.type).localeCompare(String(right.type)) || Number(left.id) - Number(right.id));
    }
    if (offset >= MAX_CLASSIC_DEPENDENTS) {
      throw new Error("Marketo classic used-by paging did not terminate within the dependency limit.");
    }
  }
}

function handle(
  ctx: DesignStudioContext,
  kind: DesignStudioAssetKind,
  id: string,
  folderType?: "folder" | "program",
  ownsContext = false,
): AssetImpl {
  if (ownsContext) retainSessionContext(ctx);
  switch (kind) {
    case "folder": return new MarketoDesignStudioFolderImpl(ctx, id, folderType ?? "folder", ownsContext);
    case "email": return new MarketoEmailImpl(ctx, id, undefined, ownsContext);
    case "emailTemplate": return new MarketoEmailTemplateImpl(ctx, id, undefined, ownsContext);
    case "landingPage": return new MarketoLandingPageImpl(ctx, id, undefined, ownsContext);
    case "landingPageTemplate": return new MarketoLandingPageTemplateImpl(ctx, id, undefined, ownsContext);
    case "form": return new MarketoFormImpl(ctx, id, undefined, ownsContext);
    case "snippet": return new MarketoSnippetImpl(ctx, id, undefined, ownsContext);
    case "file": return new MarketoFileImpl(ctx, id, undefined, ownsContext);
  }
}

function assertAcyclicCloneSource(
  ctx: DesignStudioContext,
  kind: DesignStudioAssetKind,
  id: string,
  pending = ctx.pending(),
): void {
  let visited: string[] = [];
  let current = id;
  while (true) {
    if (!pushLogicalId(ctx, visited, current)) {
      throw new Error(`Marketo ${kind} clone source cycle detected at ${current}.`);
    }
    let creation = findCreation(ctx, kind, current, pending);
    if (creation?.type !== "designClone") return;
    current = creation.sourceId;
  }
}

@validateRpc()
export class MarketoDesignStudioFolderImpl extends AssetImpl {
  protected kind = "folder" as const;
  protected async publishableContent(): Promise<unknown> { return undefined; }
  async describe(): Promise<MarketoDesignStudioFolderSummary> {
    return await this.summary() as MarketoDesignStudioFolderSummary;
  }
  async updateMetadata(patch: MarketoDesignStudioMetadataPatch): Promise<void> {
    let sanitized = basicMetadataPatch(patch);
    if ((await this.describe()).type === "program") throw new Error("Program folders cannot be edited through Design Studio.");
    await this.metadata(sanitized);
  }
  async delete(): Promise<void> {
    if ((await this.describe()).type === "program") throw new Error("Program folders cannot be deleted through Design Studio.");
    this.assertReadable();
    await submitDesign(this.ctx, { type: "designDeleteFolder", targetId: this.id });
  }
}

@validateRpc()
export class MarketoEmailImpl extends AssetImpl {
  protected kind = "email" as const;
  protected async publishableContent(): Promise<unknown> { return await this.getContent(); }
  protected async lifecycleSnapshotContent(): Promise<unknown> {
    let creation = findCreation(this.ctx, this.kind, this.id);
    let raw = creation?.type === "designCreate" ? [] : creation?.type === "designClone"
      ? await new MarketoEmailImpl(beforeAction(this.ctx, creation.id), creation.sourceId)
        .lifecycleSnapshotContent() as RawEmailContent[]
      : await (await this.ctx.client()).getEmailContent(physicalId(this.ctx, this.id));
    return canonicalEmailContent(raw, await this.getContent());
  }
  async describe(): Promise<MarketoEmailSummary> { return await this.summary() as MarketoEmailSummary; }
  async getContent(): Promise<MarketoEmailContentSection[]> {
    this.assertReadable();
    let creation = findCreation(this.ctx, this.kind, this.id);
    let sourceId = creation?.type === "designClone" ? creation.sourceId : this.id;
    if (creation?.type === "designClone") assertAcyclicCloneSource(this.ctx, this.kind, this.id);
    let sections = creation?.type === "designCreate" ? [] : creation?.type === "designClone"
      ? await new MarketoEmailImpl(beforeAction(this.ctx, creation.id), sourceId).getContent()
      : emailSections(await (await this.ctx.client()).getEmailContent(physicalId(this.ctx, sourceId)));
    for (let action of actionsFor(this.ctx, this.kind, this.id)) if (action.type === "designContent" && action.sectionId) {
      let section = sections.find(item => item.id === action.sectionId);
      if (section) {
        if (action.html !== undefined) section.html = action.html;
        if (action.text !== undefined) section.text = action.text;
      }
    }
    await this.ctx.observe(`Read Marketo email content ${this.id}`, `Read ${sections.length} static email section(s).`); return sections;
  }
  updateMetadata(patch: MarketoEmailMetadataPatch) {
    return this.metadata(metadataPatch(patch, ["name", "description", "preHeader", "subject", "fromName", "fromEmail", "replyEmail"]));
  }
  async updateContent(sectionId: string, update: MarketoEmailContentUpdate): Promise<void> {
    this.assertReadable();
    allowInput(update, "Email content update", ["html", "text"]);
    let html = requireContent(update.html, "HTML content");
    let text = update.text === undefined ? undefined : requireContent(update.text, "Text content");
    let id = requiredText(sectionId, "Section id");
    if (!(await this.getContent()).some(section => section.id === id)) {
      throw new Error(`Email section \`${id}\` is not editable static Text content.`);
    }
    await submitDesign(this.ctx, { type: "designContent", asset: this.kind, targetId: this.id,
      sectionId: id, html, text });
  }
  approve() { return this.lifecycle("approve"); } unapprove() { return this.lifecycle("unapprove"); } discardDraft() { return this.lifecycle("discardDraft"); } delete() { return this.lifecycle("delete"); }
}

abstract class TemplateImpl extends AssetImpl {
  protected async publishableContent(): Promise<unknown> { return await this.getContent(); }
  async getContent(): Promise<string> {
    this.assertReadable();
    let creation = findCreation(this.ctx, this.kind, this.id);
    let content = creation?.type === "designCreate"
      ? (this.kind === "landingPageTemplate" ? creation.input.content ?? "" : creation.input.content)
      : undefined;
    if (content === undefined) {
      let source = creation?.type === "designClone" ? creation.sourceId : this.id;
      if (creation?.type === "designClone") {
        assertAcyclicCloneSource(this.ctx, this.kind, this.id);
        let sourceCtx = beforeAction(this.ctx, creation.id);
        content = await (this.kind === "emailTemplate"
          ? new MarketoEmailTemplateImpl(sourceCtx, source)
          : new MarketoLandingPageTemplateImpl(sourceCtx, source)).getContent();
      } else {
        let client = await this.ctx.client(); let id = physicalId(this.ctx, source);
        let response = this.kind === "emailTemplate"
          ? await client.getEmailTemplateContent(id)
          : await client.getLandingPageTemplateContent(id);
        if (!response) throw new Error(`Marketo did not return template content for ${id}.`);
        if (readId(response) !== id) {
          throw new Error(`Marketo returned template content ${readId(response)} when ${id} was requested.`);
        }
        if (typeof response.content !== "string") {
          throw new Error(`Marketo returned template content ${id} without a valid content field.`);
        }
        content = response.content;
      }
    }
    for (let action of actionsFor(this.ctx, this.kind, this.id)) if (action.type === "designContent") content = action.content;
    await this.ctx.observe(`Read Marketo template content ${this.id}`, `Read static template content for \`${this.id}\`.`);
    return content ?? "";
  }
  updateMetadata(patch: MarketoDesignStudioMetadataPatch) { return this.metadata(basicMetadataPatch(patch)); }
  updateContent(content: string) {
    this.assertReadable();
    return submitDesign(this.ctx, { type: "designContent", asset: this.kind as "emailTemplate" | "landingPageTemplate", targetId: this.id, content: requireContent(content) });
  }
  approve() { return this.lifecycle("approve"); } unapprove() { return this.lifecycle("unapprove"); } discardDraft() { return this.lifecycle("discardDraft"); } delete() { return this.lifecycle("delete"); }
}

@validateRpc()
export class MarketoEmailTemplateImpl extends TemplateImpl {
  protected kind = "emailTemplate" as const;
  async describe(): Promise<MarketoEmailTemplateSummary> { return await this.summary() as MarketoEmailTemplateSummary; }
}

@validateRpc()
export class MarketoLandingPageImpl extends AssetImpl {
  protected kind = "landingPage" as const;
  protected async publishableContent(): Promise<unknown> { return await this.getContent(); }
  protected async lifecycleSnapshotContent(): Promise<unknown> {
    let creation = findCreation(this.ctx, this.kind, this.id);
    if (creation?.type === "designCreate") return [];
    if (creation?.type === "designClone") {
      return await new MarketoLandingPageImpl(beforeAction(this.ctx, creation.id), creation.sourceId)
        .lifecycleSnapshotContent();
    }
    return canonicalLandingPageContent(
      await (await this.ctx.client()).getLandingPageContent(physicalId(this.ctx, this.id)),
    );
  }
  async describe(): Promise<MarketoLandingPageSummary> { return await this.summary() as MarketoLandingPageSummary; }
  async getContent(): Promise<MarketoLandingPageContentSection[]> {
    this.assertReadable();
    let creation = findCreation(this.ctx, this.kind, this.id); let source = creation?.type === "designClone" ? creation.sourceId : this.id;
    if (creation?.type === "designClone") assertAcyclicCloneSource(this.ctx, this.kind, this.id);
    let sections = creation?.type === "designCreate" ? [] : creation?.type === "designClone"
      ? await new MarketoLandingPageImpl(beforeAction(this.ctx, creation.id), source).getContent()
      : (await (await this.ctx.client()).getLandingPageContent(physicalId(this.ctx, source)))
        .map(item => ({ id: String(item.id ?? ""), type: textValue(item.type) ?? "", content: textualContent(item.content) })).filter(item => item.id);
    await this.ctx.observe(`Read Marketo landing page content ${this.id}`, `Read ${sections.length} landing-page section(s).`); return sections;
  }
  updateMetadata(patch: MarketoDesignStudioMetadataPatch) { return this.metadata(basicMetadataPatch(patch)); }
  approve() { return this.lifecycle("approve"); } unapprove() { return this.lifecycle("unapprove"); } discardDraft() { return this.lifecycle("discardDraft"); } delete() { return this.lifecycle("delete"); }
}

@validateRpc()
export class MarketoLandingPageTemplateImpl extends TemplateImpl {
  protected kind = "landingPageTemplate" as const;
  async describe(): Promise<MarketoLandingPageTemplateSummary> { return await this.summary() as MarketoLandingPageTemplateSummary; }
}

@validateRpc()
export class MarketoFormImpl extends AssetImpl {
  protected kind = "form" as const;
  protected async publishableContent(): Promise<unknown> { return await this.getFields(); }
  protected async lifecycleSnapshotContent(): Promise<unknown> {
    let creation = findCreation(this.ctx, this.kind, this.id);
    if (creation?.type === "designCreate") return [];
    if (creation?.type === "designClone") {
      return await new MarketoFormImpl(beforeAction(this.ctx, creation.id), creation.sourceId)
        .lifecycleSnapshotContent();
    }
    return canonicalFormFields(await (await this.ctx.client()).getFormFields(physicalId(this.ctx, this.id)));
  }
  async describe(): Promise<MarketoFormSummary> { return formSummary(await this.summary()); }
  async getFields(): Promise<MarketoFormField[]> {
    this.assertReadable();
    let creation = findCreation(this.ctx, this.kind, this.id); let source = creation?.type === "designClone" ? creation.sourceId : this.id;
    if (creation?.type === "designClone") assertAcyclicCloneSource(this.ctx, this.kind, this.id);
    let fields = creation?.type === "designCreate" ? [] : creation?.type === "designClone"
      ? await new MarketoFormImpl(beforeAction(this.ctx, creation.id), source).getFields()
      : (await (await this.ctx.client()).getFormFields(physicalId(this.ctx, source)))
        .map(field => ({ id: textValue(field.id) ?? "", label: textValue(field.label), dataType: textValue(field.dataType), required: typeof field.required === "boolean" ? field.required : undefined, hintText: textValue(field.hintText) })).filter(field => field.id);
    await this.ctx.observe(`Read Marketo form fields ${this.id}`, `Read ${fields.length} form field(s).`); return fields;
  }
  updateMetadata(patch: MarketoFormMetadataPatch) {
    return this.metadata(metadataPatch(patch, ["name", "description", "locale", "language"]));
  }
  approve() { return this.lifecycle("approve"); } discardDraft() { return this.lifecycle("discardDraft"); } delete() { return this.lifecycle("delete"); }
}

@validateRpc()
export class MarketoSnippetImpl extends AssetImpl {
  protected kind = "snippet" as const;
  protected async publishableContent(): Promise<unknown> { return await this.getContent(); }
  async describe(): Promise<MarketoSnippetSummary> { return await this.summary() as MarketoSnippetSummary; }
  async getContent(): Promise<MarketoSnippetContent> {
    this.assertReadable();
    let creation = findCreation(this.ctx, this.kind, this.id); let result: MarketoSnippetContent = creation?.type === "designCreate" ? { html: creation.input.html, text: creation.input.text } : {};
    if (creation?.type !== "designCreate") {
      let source = creation?.type === "designClone" ? creation.sourceId : this.id;
      if (creation?.type === "designClone") {
        assertAcyclicCloneSource(this.ctx, this.kind, this.id);
        result = await new MarketoSnippetImpl(beforeAction(this.ctx, creation.id), source).getContent();
      } else {
        for (let item of await (await this.ctx.client()).getSnippetContent(physicalId(this.ctx, source))) {
          if (item.type?.toLowerCase() === "html") result.html = textValue(item.content);
          if (item.type?.toLowerCase() === "text") result.text = textValue(item.content);
        }
      }
    }
    for (let action of actionsFor(this.ctx, this.kind, this.id)) if (action.type === "designContent") { if (action.html !== undefined) result.html = action.html; if (action.text !== undefined) result.text = action.text; }
    await this.ctx.observe(`Read Marketo snippet content ${this.id}`, `Read static snippet content for \`${this.id}\`.`); return result;
  }
  updateMetadata(patch: MarketoDesignStudioMetadataPatch) { return this.metadata(basicMetadataPatch(patch)); }
  updateContent(content: MarketoSnippetContent) {
    this.assertReadable();
    allowInput(content, "Snippet content update", ["html", "text"]);
    let html = content.html === undefined ? undefined : requireContent(content.html, "HTML content");
    let text = content.text === undefined ? undefined : requireContent(content.text, "Text content");
    if (html === undefined && text === undefined) throw new Error("At least one snippet rendition is required.");
    return submitDesign(this.ctx, { type: "designContent", asset: this.kind, targetId: this.id, html, text });
  }
  approve() { return this.lifecycle("approve"); } unapprove() { return this.lifecycle("unapprove"); } discardDraft() { return this.lifecycle("discardDraft"); } delete() { return this.lifecycle("delete"); }
}

@validateRpc()
export class MarketoFileImpl extends AssetImpl {
  protected kind = "file" as const;
  protected async publishableContent(): Promise<unknown> { return undefined; }
  async describe(): Promise<MarketoFileSummary> { return await this.summary() as MarketoFileSummary; }
  async updateContent(data: Uint8Array, mimeType: string) {
    this.assertReadable();
    let file = requireFile(data);
    let digest = await sha256(file);
    let fileName = (await this.describe()).name;
    await submitDesign(this.ctx, { type: "designContent", asset: this.kind, targetId: this.id,
      data: file, mimeType: normalizeMimeType(mimeType), sha256: digest, fileName });
  }
}
