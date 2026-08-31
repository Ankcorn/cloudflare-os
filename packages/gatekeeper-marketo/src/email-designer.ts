import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  MarketoCreateDesignerEmailInput,
  MarketoCreateDesignerEmailTemplateInput,
  MarketoCreateDesignerFragmentInput,
  MarketoDesignerAssetSummary,
  MarketoDesignerEmailDetail,
  MarketoDesignerEmailPatch,
  MarketoDesignerEmailTemplateDetail,
  MarketoDesignerEmailTemplatePatch,
  MarketoDesignerFragmentDetail,
  MarketoDesignerFragmentPatch,
  MarketoDesignerListOptions,
  MarketoDesignerUsedBy,
} from "./types";
import type { DesignerAssetKind, RawDesignerAsset } from "./marketo-api";
import { parseMarketoDate } from "./marketo-api";
import type { SessionContext } from "./session";
import {
  designerCloneSnapshot,
  updateDesignerCloneSnapshot,
  type DesignerCloneSnapshot,
  type EmailDesignerAction,
  type EmailDesignerActionInput,
  type EmailDesignerKind,
} from "./email-designer-actions";
import type { DesignStudioAssetKind } from "./design-studio-actions";

export type EmailDesignerContext = SessionContext & {
  allocateProvisional(): string;
  logicalKind(id: string): DesignStudioAssetKind | "campaign" | "program" | EmailDesignerKind | undefined;
  pendingDesigner(): EmailDesignerAction[];
  resolveDesignerId(id: string): string | undefined;
  submitDesigner(action: EmailDesignerActionInput): Promise<void>;
};

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ARRAY_ITEMS = 100;
const MAX_DURABLE_PAYLOAD_BYTES = 1280 * 1024;

function path(kind: EmailDesignerKind): DesignerAssetKind {
  return kind === "designerEmail" ? "email" : kind === "designerTemplate" ? "emailtemplate" : "fragment";
}

function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new Error(`${label} is required.`);
  if (new TextEncoder().encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
  return empty ? value : value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label, true);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function only(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  let result = record(value, label);
  let extra = Object.keys(result).find(key => !keys.includes(key));
  if (extra) throw new Error(`${label} contains unsupported field: ${extra}.`);
  return result;
}

function id(
  value: unknown,
  label: string,
  ctx?: EmailDesignerContext,
  kind?: DesignStudioAssetKind | "campaign" | "program" | EmailDesignerKind,
): string {
  let result = text(value, label);
  if (result.length > 512) throw new Error(`${label} is too long.`);
  if (result.startsWith("~") && ctx?.logicalKind(result) !== kind) {
    throw new Error(`${label} ${result} is not a ${kind ?? "designer asset"}.`);
  }
  return result;
}

function stringArray(value: unknown, label: string, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${label} must be a non-empty array.`);
  if (value.length > MAX_ARRAY_ITEMS) throw new Error(`${label} must not contain more than ${MAX_ARRAY_ITEMS} items.`);
  return value.map((item, index) => text(item, `${label} item ${index + 1}`));
}

function durablePayloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function submitDesigner(ctx: EmailDesignerContext, action: EmailDesignerActionInput): Promise<void> {
  if (durablePayloadBytes(action) > MAX_DURABLE_PAYLOAD_BYTES) {
    throw new Error(`The complete action payload must not exceed ${MAX_DURABLE_PAYLOAD_BYTES} bytes.`);
  }
  await ctx.submitDesigner(action);
}

function content(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let input = only(value, "Content", ["html", "text", "syncTextFromHtml"]);
  let html = optionalText(input.html, "HTML content");
  let plain = optionalText(input.text, "Plain-text content");
  if (input.syncTextFromHtml !== undefined && typeof input.syncTextFromHtml !== "boolean") {
    throw new Error("syncTextFromHtml must be a boolean.");
  }
  if (html === undefined && plain === undefined && input.syncTextFromHtml === undefined) throw new Error("Content cannot be empty.");
  return {
    ...(html === undefined ? {} : { html: { body: html } }),
    ...(plain === undefined && input.syncTextFromHtml === undefined ? {} : {
      text: { ...(plain === undefined ? {} : { body: plain }), ...(input.syncTextFromHtml === undefined ? {} : { syncFromHtml: input.syncTextFromHtml }) },
    }),
  };
}

function headers(value: unknown, partial = false): Record<string, unknown> {
  let input = only(value, "Email headers", ["subject", "fromName", "fromEmail", "replyEmail", "preheader", "ccEmails"]);
  let result: Record<string, unknown> = {};
  for (let key of ["subject", "fromName", "fromEmail", "replyEmail", "preheader"] as const) {
    if (input[key] !== undefined) result[key] = optionalText(input[key], key);
  }
  if (!partial && result.subject === undefined) result.subject = text(input.subject, "Email subject");
  let ccEmails = stringArray(input.ccEmails, "ccEmails");
  if (ccEmails !== undefined) result.ccEmails = ccEmails;
  if (partial && Object.keys(result).length === 0) throw new Error("Email headers cannot be empty.");
  return result;
}

function settings(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let keys = ["brandedDomain", "dedicatedIp", "enableUrlTracking", "isOperational", "isTextOnly", "isWebPageView"] as const;
  let input = only(value, "Email settings", keys);
  let result: Record<string, unknown> = {};
  for (let key of keys) {
    let item = input[key];
    if (item === undefined) continue;
    if (key === "brandedDomain" || key === "dedicatedIp") result[key] = text(item, key);
    else if (typeof item === "boolean") result[key] = item;
    else throw new Error(`${key} must be a boolean.`);
  }
  if (Object.keys(result).length === 0) throw new Error("Email settings cannot be empty.");
  return result;
}

function location(value: unknown, allowProgram: boolean, ctx: EmailDesignerContext): Record<string, string> {
  let input = only(value, "Designer location", allowProgram ? ["workspaceId", "folderId", "programId"] : ["workspaceId", "folderId"]);
  let workspaceId = id(input.workspaceId, "workspaceId");
  if (workspaceId.startsWith("~")) throw new Error("workspaceId cannot be provisional.");
  let folderId = input.folderId === undefined ? undefined : id(input.folderId, "folderId", ctx, "folder");
  let programId = input.programId === undefined ? undefined : id(input.programId, "programId", ctx, "program");
  if (allowProgram ? Boolean(folderId) === Boolean(programId) : !folderId) {
    throw new Error(allowProgram ? "Set exactly one of folderId or programId." : "folderId is required.");
  }
  if (folderId) return { workspaceId, folderId };
  if (!programId) throw new Error("programId is required.");
  return { workspaceId, programId };
}

function normalize(
  raw: RawDesignerAsset,
  fallbackId?: string,
  includeCloneSnapshot = false,
): MarketoDesignerAssetSummary & Record<string, unknown> {
  let assetId = raw.id === undefined ? fallbackId : String(raw.id);
  if (!assetId) throw new Error("Marketo returned a designer asset without an id.");
  let result: MarketoDesignerAssetSummary & Record<string, unknown> = {
    id: assetId,
    name: raw.name ?? "",
    description: raw.description,
    status: raw.status ?? raw.state,
    workspaceId: raw.appData?.workspaceId === undefined ? undefined : String(raw.appData.workspaceId),
    folderId: raw.appData?.folderId === undefined ? undefined : String(raw.appData.folderId),
    programId: raw.appData?.programId === undefined ? undefined : String(raw.appData.programId),
    programName: raw.appData?.programName,
    headers: raw.headers,
    content: raw.data && {
      html: raw.data.html?.body,
      text: raw.data.text?.body,
      syncTextFromHtml: raw.data.text?.syncFromHtml,
    },
    settings: raw.settings,
    templateId: raw.templateId === undefined ? undefined : String(raw.templateId),
    fragmentType: raw.settings?.fragmentType,
    fragmentSubType: raw.settings?.fragmentSubType,
    supportedChannels: raw.settings?.supportedChannels ?? [],
    createdBy: raw.metadata?.createdBy,
    createdAt: parseMarketoDate(raw.metadata?.createdAt),
    modifiedBy: raw.metadata?.modifiedBy,
    modifiedAt: parseMarketoDate(raw.metadata?.modifiedAt),
  };
  if (includeCloneSnapshot) {
    result.cloneSnapshot = designerCloneSnapshot(raw as Record<string, unknown>);
  }
  return result;
}

function actions(ctx: EmailDesignerContext, kind: EmailDesignerKind, assetId: string, before = Infinity): EmailDesignerAction[] {
  return ctx.pendingDesigner().filter(action => action.id < before && action.asset === kind && (
    (action.type === "designerCreate" || action.type === "designerClone") && action.provisionalId === assetId ||
    "targetId" in action && same(ctx, action.targetId, assetId)
  ));
}

function same(ctx: EmailDesignerContext, left: string, right: string): boolean {
  if (left === right) return true;
  let resolved = ctx.resolveDesignerId(left);
  return resolved !== undefined && resolved === ctx.resolveDesignerId(right);
}

function mergeDefined(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  let result: Record<string, unknown> =
    base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (let [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function overlay(base: Record<string, unknown>, pending: EmailDesignerAction[]): Record<string, unknown> {
  let result = structuredClone(base);
  for (let action of pending) {
    if (action.type === "designerUpdate") {
      let patch = action.patch;
      if (result.cloneSnapshot) {
        result.cloneSnapshot = updateDesignerCloneSnapshot(
          result.cloneSnapshot as DesignerCloneSnapshot,
          patch,
        );
      }
      if (patch.name !== undefined) result.name = patch.name;
      if (patch.description !== undefined) result.description = patch.description;
      if (patch.data !== undefined) {
        let changed = normalize({ id: "x", data: patch.data as RawDesignerAsset["data"] }).content;
        result.content = mergeDefined(result.content, changed as Record<string, unknown>);
      }
      if (patch.headers !== undefined) {
        result.headers = mergeDefined(result.headers, patch.headers as Record<string, unknown>);
      }
      if (patch.settings !== undefined) {
        let changed = patch.settings as Record<string, unknown>;
        result.settings = mergeDefined(result.settings, changed);
        if (action.asset === "designerFragment") {
          if (changed.fragmentSubType !== undefined) result.fragmentSubType = changed.fragmentSubType;
          if (changed.supportedChannels !== undefined) result.supportedChannels = changed.supportedChannels;
        }
      }
      if (patch.templateId !== undefined) result.templateId = patch.templateId;
    }
    if (action.type === "designerLifecycle") {
      result.status = action.operation === "approve" || action.operation === "discard" ? "approved" : "draft";
    }
    if (action.type === "designerDelete") throw new Error(`Marketo designer asset ${result.id} was deleted.`);
  }
  return result;
}

async function summary(ctx: EmailDesignerContext, kind: EmailDesignerKind, assetId: string, before = Infinity, seen = new Set<string>()): Promise<Record<string, unknown>> {
  if (seen.has(assetId)) throw new Error(`Designer ${kind} ${assetId} has a circular clone dependency.`);
  seen.add(assetId);
  let creation = ctx.pendingDesigner().find(action => action.id < before && action.asset === kind &&
    (action.type === "designerCreate" || action.type === "designerClone") && action.provisionalId === assetId);
  let base: Record<string, unknown>;
  if (creation?.type === "designerCreate") {
    base = normalize({ id: assetId, ...(creation.body as RawDesignerAsset), status: "draft" }, assetId, true);
  } else if (creation?.type === "designerClone") {
    base = { ...(await summary(ctx, kind, creation.sourceId, creation.id, seen)), id: assetId, name: creation.name,
      ...(creation.description === undefined ? {} : { description: creation.description }), status: "draft",
      createdAt: undefined, modifiedAt: undefined };
  } else {
    let physical = ctx.resolveDesignerId(assetId);
    if (physical === undefined) throw new Error(`Designer ${kind} ${assetId} is still pending creation.`);
    let raw = await (await ctx.client()).getDesignerAsset(path(kind), physical);
    if (!raw) throw new Error(`Marketo designer ${kind} ${assetId} was not found.`);
    if (raw.id === undefined || String(raw.id) !== physical) {
      throw new Error(`Marketo returned designer asset ${String(raw.id)} when ${physical} was requested.`);
    }
    base = normalize(raw, assetId, true);
    base.id = assetId;
  }
  return overlay(base, actions(ctx, kind, assetId, before));
}

@validateRpc()
export class MarketoEmailDesignerImpl extends RpcTarget {
  #ctx: EmailDesignerContext;
  constructor(ctx: EmailDesignerContext) { super(); this.#ctx = ctx; }

  async listWorkspaces() {
    let raw = await (await this.#ctx.client()).getWorkspaces();
    let result = raw.flatMap(item => item.id === undefined ? [] : [{ id: String(item.id), name: item.name ?? "", description: item.description, status: item.status }]);
    await this.#ctx.observe("List Marketo workspaces", `Read ${result.length} workspace(s) through User Management.`);
    return result;
  }

  listEmails(workspaceId: string, options: MarketoDesignerListOptions & { templateId?: string } = {}) { return this.#list("designerEmail", workspaceId, options); }
  listEmailTemplates(workspaceId: string, options: MarketoDesignerListOptions = {}) { return this.#list("designerTemplate", workspaceId, options); }
  listFragments(workspaceId: string, options: MarketoDesignerListOptions & { fragmentType?: string } = {}) { return this.#list("designerFragment", workspaceId, options); }

  async #list(kind: EmailDesignerKind, workspaceId: string, options: MarketoDesignerListOptions & { templateId?: string; fragmentType?: string }) {
    let workspace = id(workspaceId, "workspaceId");
    only(options, "Designer list options", ["folderId", "folderType", "name", "status", "pageIndex", "pageSize", "sortKey", "sortOrder", "includeArchived", "isCreatedByMe", "isModifiedByMe", "templateId", "fragmentType"]);
    let pageIndex = options.pageIndex ?? 0;
    let pageSize = options.pageSize ?? 20;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error("pageIndex must be a non-negative integer.");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error("pageSize must be between 1 and 50.");
    let status = stringArray(options.status, "status");
    let client = await this.#ctx.client();
    let raw = await client.filterDesignerAssets(path(kind), {
      workspaceId: workspace, folderId: options.folderId, folderType: options.folderType, name: options.name,
      status, pageIndex, pageSize, sortKey: options.sortKey, sortOrder: options.sortOrder,
      includeArchived: options.includeArchived, isCreatedByMe: options.isCreatedByMe,
      isModifiedByMe: options.isModifiedByMe, templateId: options.templateId, fragmentType: options.fragmentType,
    });
    let items = (raw.items ?? []).map(item => normalize(item));
    await this.#ctx.observe(`List Marketo designer ${kind}`, `Read ${items.length} asset(s) in workspace ${workspace}.`);
    return { items, totalItems: raw.totalItems,
      pageIndex: raw.currentPage ?? pageIndex, pageSize: raw.pageSize ?? pageSize };
  }

  getEmail(assetId: string) { return new MarketoDesignerEmailImpl(this.#ctx, id(assetId, "designer email id", this.#ctx, "designerEmail")); }
  getEmailTemplate(assetId: string) { return new MarketoDesignerEmailTemplateImpl(this.#ctx, id(assetId, "designer template id", this.#ctx, "designerTemplate")); }
  getFragment(assetId: string) { return new MarketoDesignerFragmentImpl(this.#ctx, id(assetId, "designer fragment id", this.#ctx, "designerFragment")); }

  async createEmail(input: MarketoCreateDesignerEmailInput) {
    let value = only(input, "Designer email create input", ["location", "name", "description", "headers", "content", "templateId", "settings"]);
    return await this.#create("designerEmail", {
      name: text(value.name, "Email name"), description: optionalText(value.description, "description"),
      appData: { ...location(value.location, true, this.#ctx), editorType: "email" }, headers: headers(value.headers),
      data: content(value.content), settings: settings(value.settings),
      templateId: value.templateId === undefined ? undefined : id(value.templateId, "templateId", this.#ctx, "designerTemplate"),
    }) as MarketoDesignerEmailImpl;
  }

  async createEmailTemplate(input: MarketoCreateDesignerEmailTemplateInput) {
    let value = only(input, "Designer template create input", ["location", "name", "description", "content"]);
    return await this.#create("designerTemplate", { name: text(value.name, "Template name"), description: optionalText(value.description, "description"),
      appData: { ...location(value.location, false, this.#ctx), editorType: "emailTemplate" }, data: content(value.content) }) as MarketoDesignerEmailTemplateImpl;
  }

  async createFragment(input: MarketoCreateDesignerFragmentInput) {
    let value = only(input, "Designer fragment create input", ["location", "name", "description", "content", "fragmentType", "fragmentSubType", "supportedChannels"]);
    return await this.#create("designerFragment", { name: text(value.name, "Fragment name"), description: optionalText(value.description, "description"),
      appData: { ...location(value.location, false, this.#ctx), editorType: "fragment" }, data: content(value.content), settings: {
        fragmentType: text(value.fragmentType, "fragmentType"), fragmentSubType: optionalText(value.fragmentSubType, "fragmentSubType"),
        supportedChannels: stringArray(value.supportedChannels, "supportedChannels", true),
      } }) as MarketoDesignerFragmentImpl;
  }

  async #create(kind: EmailDesignerKind, body: Record<string, unknown>) {
    let provisionalId = this.#ctx.allocateProvisional();
    await submitDesigner(this.#ctx, { type: "designerCreate", asset: kind, provisionalId, body });
    return designerHandle(this.#ctx, kind, provisionalId);
  }
}

abstract class DesignerAssetImpl extends RpcTarget {
  protected ctx: EmailDesignerContext;
  protected assetId: string;
  protected abstract kind: EmailDesignerKind;
  constructor(ctx: EmailDesignerContext, assetId: string) { super(); this.ctx = ctx; this.assetId = assetId; }

  protected async detail(): Promise<Record<string, unknown>> {
    let result = await summary(this.ctx, this.kind, this.assetId);
    await this.ctx.observe(`Read Marketo designer ${this.kind}`, `Read designer asset ${this.assetId}.`);
    delete result.cloneSnapshot;
    return result;
  }

  protected async submitUpdate(patch: Record<string, unknown>) {
    patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (Object.keys(patch).length === 0) throw new Error("A non-empty update is required.");
    await submitDesigner(this.ctx, { type: "designerUpdate", asset: this.kind, targetId: this.assetId, patch });
  }

  protected async cloneAsset(name: string, description?: string) {
    let provisionalId = this.ctx.allocateProvisional();
    let source = await summary(this.ctx, this.kind, this.assetId);
    let sourceSnapshot = source.cloneSnapshot as DesignerCloneSnapshot | undefined;
    if (!sourceSnapshot) throw new Error("The Marketo designer clone source could not be snapshotted.");
    await this.ctx.observe(`Read Marketo designer ${this.kind} clone source`, `Resolved dependencies for designer asset ${this.assetId}.`);
    await submitDesigner(this.ctx, { type: "designerClone", asset: this.kind, provisionalId, sourceId: this.assetId,
      name: text(name, "Clone name"), description: optionalText(description, "description"), sourceSnapshot });
    return designerHandle(this.ctx, this.kind, provisionalId);
  }

  protected async lifecycle(operation: "createDraft" | "approve" | "unapprove" | "discard") {
    let physical = this.ctx.resolveDesignerId(this.assetId);
    if (physical === undefined) throw new Error(`Designer asset ${this.assetId} is still pending creation.`);
    let raw = await (await this.ctx.client()).getDesignerAsset(path(this.kind), physical);
    if (!raw || String(raw.id) !== physical) throw new Error(`Marketo designer asset ${this.assetId} was not found.`);
    let sourceState: "draft" | "approved" = operation === "approve" || operation === "discard" ? "draft" : "approved";
    let state = raw.associatedStates?.find(item => item.state?.toLowerCase() === sourceState);
    if (!state?.contentId) throw new Error(`Marketo designer asset ${this.assetId} has no ${sourceState} content.`);
    await this.ctx.observe(`Read Marketo designer ${sourceState} state`, `Resolved the content version for designer asset ${this.assetId}.`);
    return await submitDesigner(this.ctx, {
      type: "designerLifecycle", asset: this.kind, targetId: this.assetId, operation,
      contentId: state.contentId, sourceState,
    });
  }

  createDraft() { return this.lifecycle("createDraft"); }
  approve() { return this.lifecycle("approve"); }
  unapprove() { return this.lifecycle("unapprove"); }
  discardDraft() { return this.lifecycle("discard"); }
  delete() { return submitDesigner(this.ctx, { type: "designerDelete", asset: this.kind, targetId: this.assetId }); }

  async getUsedBy(pageIndex = 0, pageSize = 20) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error("pageIndex must be a non-negative integer.");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error("pageSize must be between 1 and 50.");
    let physical = this.ctx.resolveDesignerId(this.assetId);
    if (physical === undefined) throw new Error(`Designer asset ${this.assetId} is still pending creation.`);
    let raw = await (await this.ctx.client()).getDesignerAssetUsedBy(path(this.kind), { assetId: physical, pageIndex, pageSize, type: "all" });
    let items: MarketoDesignerUsedBy[] = raw.result.flatMap(item => item.id === undefined ? [] : [{
      id: String(item.id), name: item.name ?? "", channel: item.channel, contentType: item.contentType,
      workspaceId: item.appData?.workspaceId === undefined ? undefined : String(item.appData.workspaceId),
      folderId: item.appData?.folderId === undefined ? undefined : String(item.appData.folderId),
    }]);
    await this.ctx.observe(`Read dependencies for Marketo designer ${this.kind}`, `Read ${items.length} direct dependency record(s) for ${this.assetId}.`);
    return { items, totalItems: raw.pageDetails?.totalItems, pageIndex: raw.pageDetails?.currentPage ?? pageIndex, pageSize: raw.pageDetails?.pageSize ?? pageSize };
  }
}

@validateRpc()
export class MarketoDesignerEmailImpl extends DesignerAssetImpl {
  protected kind = "designerEmail" as const;
  async describe(): Promise<MarketoDesignerEmailDetail> { return await this.detail() as MarketoDesignerEmailDetail; }
  async update(value: MarketoDesignerEmailPatch) {
    let input = only(value, "Designer email patch", ["name", "description", "headers", "content", "settings", "templateId"]);
    await this.submitUpdate({ name: input.name === undefined ? undefined : text(input.name, "Email name"),
      description: optionalText(input.description, "description"), headers: input.headers === undefined ? undefined : headers(input.headers, true),
      data: content(input.content), settings: settings(input.settings),
      templateId: input.templateId === undefined ? undefined : id(input.templateId, "templateId", this.ctx, "designerTemplate") });
  }
  async clone(name: string, description?: string) { return await this.cloneAsset(name, description) as MarketoDesignerEmailImpl; }
}

@validateRpc()
export class MarketoDesignerEmailTemplateImpl extends DesignerAssetImpl {
  protected kind = "designerTemplate" as const;
  async describe(): Promise<MarketoDesignerEmailTemplateDetail> { return await this.detail() as MarketoDesignerEmailTemplateDetail; }
  async update(value: MarketoDesignerEmailTemplatePatch) {
    let input = only(value, "Designer template patch", ["name", "description", "content"]);
    await this.submitUpdate({ name: input.name === undefined ? undefined : text(input.name, "Template name"),
      description: optionalText(input.description, "description"), data: content(input.content) });
  }
  async clone(name: string, description?: string) { return await this.cloneAsset(name, description) as MarketoDesignerEmailTemplateImpl; }
}

@validateRpc()
export class MarketoDesignerFragmentImpl extends DesignerAssetImpl {
  protected kind = "designerFragment" as const;
  async describe(): Promise<MarketoDesignerFragmentDetail> { return await this.detail() as MarketoDesignerFragmentDetail; }
  async update(value: MarketoDesignerFragmentPatch) {
    let input = only(value, "Designer fragment patch", ["name", "description", "content", "fragmentSubType", "supportedChannels"]);
    let fragmentSubType = optionalText(input.fragmentSubType, "fragmentSubType");
    let supportedChannels = stringArray(input.supportedChannels, "supportedChannels");
    await this.submitUpdate({ name: input.name === undefined ? undefined : text(input.name, "Fragment name"),
      description: optionalText(input.description, "description"), data: content(input.content),
      settings: fragmentSubType === undefined && supportedChannels === undefined ? undefined : {
        ...(fragmentSubType === undefined ? {} : { fragmentSubType }),
        ...(supportedChannels === undefined ? {} : { supportedChannels }),
      } });
  }
  async clone(name: string, description?: string) { return await this.cloneAsset(name, description) as MarketoDesignerFragmentImpl; }
}

function designerHandle(ctx: EmailDesignerContext, kind: EmailDesignerKind, assetId: string): DesignerAssetImpl {
  if (kind === "designerEmail") return new MarketoDesignerEmailImpl(ctx, assetId);
  if (kind === "designerTemplate") return new MarketoDesignerEmailTemplateImpl(ctx, assetId);
  return new MarketoDesignerFragmentImpl(ctx, assetId);
}
