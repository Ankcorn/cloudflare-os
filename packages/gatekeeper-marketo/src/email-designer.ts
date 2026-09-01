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
import { retainSessionContext, type SessionContext } from "./session";
import {
  designerCloneSnapshot,
  designerCloneSnapshotRecord,
  resolveDesignerCloneSnapshot,
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
  resolveAssetId?(id: string): number | undefined;
  resolveDesignerId(id: string): string | undefined;
  submitDesigner(action: EmailDesignerActionInput): Promise<void>;
};

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ARRAY_ITEMS = 100;
const MAX_DURABLE_PAYLOAD_BYTES = 1280 * 1024;
const DESIGNER_PAGE_SIZE = 50;
const MAX_SORTED_DESIGNER_ITEMS = 1_000;
const MAX_SIMULATED_USED_BY_ITEMS = 1_000;

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

function listSummary(item: Record<string, unknown>): MarketoDesignerAssetSummary {
  return {
    id: String(item.id),
    name: String(item.name ?? ""),
    description: item.description as string | undefined,
    status: item.status as string | undefined,
    workspaceId: item.workspaceId as string | undefined,
    folderId: item.folderId as string | undefined,
    createdBy: item.createdBy as string | undefined,
    createdAt: item.createdAt as Date | undefined,
    modifiedBy: item.modifiedBy as string | undefined,
    modifiedAt: item.modifiedAt as Date | undefined,
  };
}

function usedBySummary(item: Record<string, unknown>): MarketoDesignerUsedBy {
  return {
    id: String(item.id),
    name: String(item.name ?? ""),
    channel: item.channel as string | undefined,
    contentType: item.contentType as string | undefined,
    workspaceId: item.workspaceId as string | undefined,
    folderId: item.folderId as string | undefined,
  };
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
      let state = action.operation === "approve" || action.operation === "discard" ? "approved" : "draft";
      result.status = state;
      if (result.cloneSnapshot && (action.operation === "approve" || action.operation === "unapprove")) {
        result.cloneSnapshot = updateDesignerCloneSnapshot(
          result.cloneSnapshot as DesignerCloneSnapshot,
          {
            status: state,
            state,
            associatedStates: [{ contentId: action.contentId, state }],
          },
        );
      }
    }
    if (action.type === "designerDelete") throw new Error(`Marketo designer asset ${result.id} was deleted.`);
  }
  return result;
}

function matchesList(
  item: Record<string, unknown>,
  workspaceId: string,
  options: MarketoDesignerListOptions & { templateId?: string; fragmentType?: string },
): boolean {
  if (item.workspaceId !== workspaceId) return false;
  if (options.folderId !== undefined) {
    let location = options.folderType === "Program" ? item.programId : item.folderId;
    if (location !== options.folderId) return false;
  }
  if (options.name !== undefined && item.name !== options.name) return false;
  if (options.status !== undefined && !options.status.includes(String(item.status))) return false;
  if (!options.includeArchived && String(item.status).toLowerCase() === "archived") return false;
  if (options.templateId !== undefined && item.templateId !== options.templateId) return false;
  if (options.fragmentType !== undefined && item.fragmentType !== options.fragmentType) return false;
  return true;
}

function compareDesignerItems(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  sortKey: string,
  sortOrder: "ASC" | "DESC" | undefined,
): number {
  let direction = sortOrder === "DESC" ? -1 : 1;
  let a = left[sortKey];
  let b = right[sortKey];
  if (a === b) return String(left.id).localeCompare(String(right.id)) * direction;
  if (a === undefined) return direction;
  if (b === undefined) return -direction;
  let first = a instanceof Date ? a.getTime() : a;
  let second = b instanceof Date ? b.getTime() : b;
  if (typeof first === "number" && typeof second === "number") return (first - second) * direction;
  return String(first).localeCompare(String(second)) * direction;
}

async function summary(ctx: EmailDesignerContext, kind: EmailDesignerKind, assetId: string, before = Infinity): Promise<Record<string, unknown>> {
  let creation = ctx.pendingDesigner().find(action => action.id < before && action.asset === kind &&
    (action.type === "designerCreate" || action.type === "designerClone") && action.provisionalId === assetId);
  let base: Record<string, unknown>;
  if (creation?.type === "designerCreate") {
    base = normalize({ id: assetId, ...(creation.body as RawDesignerAsset), status: "draft" }, assetId, true);
  } else if (creation?.type === "designerClone") {
    let resolved = resolveDesignerCloneSnapshot(
      creation.sourceSnapshot,
      value => ctx.resolveDesignerId(value) ?? value,
      value => ctx.resolveAssetId?.(value) ?? value,
    );
    base = normalize({
      id: assetId,
      ...designerCloneSnapshotRecord(resolved) as RawDesignerAsset,
      name: creation.name,
      ...(creation.description === undefined ? {} : { description: creation.description }),
      status: "draft",
    }, assetId, true);
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
  #ownsContext: boolean;
  #disposed = false;
  constructor(ctx: EmailDesignerContext, ownsContext = false) {
    super(); this.#ctx = ctx; this.#ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.#ownsContext && !this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

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
    let query = {
      workspaceId: workspace, folderId: options.folderId, folderType: options.folderType, name: options.name,
      status, sortKey: options.sortKey, sortOrder: options.sortOrder,
      includeArchived: options.includeArchived, isCreatedByMe: options.isCreatedByMe,
      isModifiedByMe: options.isModifiedByMe, templateId: options.templateId, fragmentType: options.fragmentType,
    };
    let pending = this.#ctx.pendingDesigner().filter(action => action.asset === kind);
    if (pending.length === 0) {
      let raw = await client.filterDesignerAssets(path(kind), { ...query, pageIndex, pageSize });
      let items = (raw.items ?? []).map(item => normalize(item));
      if (raw.currentPage !== pageIndex) {
        throw new Error(`Marketo returned designer page ${String(raw.currentPage)} when page ${pageIndex} was requested.`);
      }
      if (items.some(item => !matchesList(item, workspace, { ...options, status }))) {
        throw new Error("Marketo returned a designer asset outside the requested list filters.");
      }
      await this.#ctx.observe(`List Marketo designer ${kind}`, `Read ${items.length} asset(s) in workspace ${workspace}.`);
      return { items: items.map(listSummary), totalItems: raw.totalItems,
        pageIndex: raw.currentPage, pageSize: raw.pageSize ?? pageSize };
    }

    let candidateIds: string[] = [];
    for (let action of pending) {
      let candidate = action.type === "designerCreate" || action.type === "designerClone"
        ? action.provisionalId
        : action.targetId;
      if (!candidateIds.some(existing => same(this.#ctx, existing, candidate))) candidateIds.push(candidate);
    }
    if (options.sortKey !== undefined && candidateIds.length > MAX_SORTED_DESIGNER_ITEMS) {
      throw new Error(`Sorted pending Designer lists cannot exceed ${MAX_SORTED_DESIGNER_ITEMS} assets.`);
    }
    let candidates = new Map<string, {
      logicalId: string;
      item: Record<string, unknown> | null;
      isCreation: boolean;
      originalMatches: boolean;
    }>();
    for (let candidateId of candidateIds) {
      let key = this.#ctx.resolveDesignerId(candidateId) ?? candidateId;
      let isCreation = pending.some(action =>
        (action.type === "designerCreate" || action.type === "designerClone") && same(this.#ctx, action.provisionalId, candidateId));
      let first = actions(this.#ctx, kind, candidateId)[0];
      let original = isCreation || !first ? undefined : await summary(this.#ctx, kind, candidateId, first.id);
      let originalMatches = original === undefined ? false : matchesList(original, workspace, { ...options, status });
      if (actions(this.#ctx, kind, candidateId).some(action => action.type === "designerDelete")) {
        candidates.set(key, { logicalId: candidateId, item: null, isCreation, originalMatches });
      } else {
        candidates.set(key, {
          logicalId: candidateId,
          item: await summary(this.#ctx, kind, candidateId),
          isCreation,
          originalMatches,
        });
      }
    }

    let matchingCandidates = [...candidates.entries()].filter(([, candidate]) =>
      candidate.item && matchesList(candidate.item, workspace, { ...options, status }));
    let seen = new Set<string>();
    let encounteredCandidates = new Set<string>();
    let merged: Record<string, unknown>[] = [];
    let upstreamTotal: number | undefined;
    let exhausted = false;
    let upstreamPage = 0;
    let end = (pageIndex + 1) * pageSize;
    while (!exhausted && (options.sortKey !== undefined || merged.length < end)) {
      let requestedPage = upstreamPage++;
      let raw = await client.filterDesignerAssets(path(kind), {
        ...query, pageIndex: requestedPage, pageSize: DESIGNER_PAGE_SIZE,
      });
      if (raw.currentPage !== requestedPage) {
        throw new Error(`Marketo returned designer page ${String(raw.currentPage)} when page ${requestedPage} was requested.`);
      }
      upstreamTotal ??= raw.totalItems;
      if (options.sortKey !== undefined && raw.totalItems !== undefined &&
          raw.totalItems > MAX_SORTED_DESIGNER_ITEMS) {
        throw new Error(`Sorted pending Designer lists cannot exceed ${MAX_SORTED_DESIGNER_ITEMS} assets.`);
      }
      let page = raw.items ?? [];
      let seenBefore = seen.size;
      for (let item of page) {
        let normalized = normalize(item);
        if (!matchesList(normalized, workspace, { ...options, status })) {
          throw new Error("Marketo returned a designer asset outside the requested list filters.");
        }
        let assetId = item.id === undefined ? undefined : String(item.id);
        if (!assetId) throw new Error("Marketo returned a designer asset without an id.");
        let key = this.#ctx.resolveDesignerId(assetId) ?? assetId;
        if (seen.has(key)) continue;
        seen.add(key);
        let candidate = candidates.get(key);
        if (candidate) {
          encounteredCandidates.add(key);
          if (options.sortKey === undefined && candidate.item &&
              matchesList(candidate.item, workspace, { ...options, status })) merged.push(candidate.item);
        } else {
          merged.push(normalized);
        }
      }
      if (options.sortKey !== undefined && seen.size > MAX_SORTED_DESIGNER_ITEMS) {
        throw new Error(`Sorted pending Designer lists cannot exceed ${MAX_SORTED_DESIGNER_ITEMS} assets.`);
      }
      let effectivePageSize = raw.pageSize && raw.pageSize > 0 ? raw.pageSize : DESIGNER_PAGE_SIZE;
      if (page.length >= effectivePageSize && seen.size === seenBefore) {
        throw new Error("Marketo returned invalid designer paging state.");
      }
      exhausted = page.length < effectivePageSize || page.length === 0 ||
        raw.totalItems !== undefined && seen.size >= raw.totalItems;
    }
    if (options.sortKey !== undefined) {
      merged.push(...matchingCandidates.flatMap(([key, candidate]) =>
        candidate.isCreation || !options.isCreatedByMe || encounteredCandidates.has(key) ? [candidate.item!] : []));
      if (merged.length > MAX_SORTED_DESIGNER_ITEMS) {
        throw new Error(`Sorted pending Designer lists cannot exceed ${MAX_SORTED_DESIGNER_ITEMS} assets.`);
      }
      merged.sort((left, right) => compareDesignerItems(left, right, options.sortKey!, options.sortOrder));
    } else if (exhausted) {
      for (let [key, candidate] of matchingCandidates) {
        if (!encounteredCandidates.has(key) && (candidate.isCreation || !options.isCreatedByMe)) {
          merged.push(candidate.item!);
        }
      }
    }
    let totalItems = options.isCreatedByMe || options.isModifiedByMe ? undefined : upstreamTotal;
    if (totalItems !== undefined) {
      for (let [key, candidate] of candidates) {
        let resolvedCreation = candidate.isCreation && key !== candidate.logicalId;
        let finalMatches = Boolean(candidate.item && matchesList(candidate.item, workspace, { ...options, status }));
        if (!resolvedCreation) totalItems += Number(finalMatches) - Number(candidate.originalMatches);
      }
    }
    let items = merged.slice(pageIndex * pageSize, end).map(listSummary);
    await this.#ctx.observe(`List Marketo designer ${kind}`, `Read ${items.length} asset(s) in workspace ${workspace}.`);
    return { items, totalItems, pageIndex, pageSize };
  }

  getEmail(assetId: string) { let value = id(assetId, "designer email id", this.#ctx, "designerEmail"); return new MarketoDesignerEmailImpl(retainSessionContext(this.#ctx), value, true); }
  getEmailTemplate(assetId: string) { let value = id(assetId, "designer template id", this.#ctx, "designerTemplate"); return new MarketoDesignerEmailTemplateImpl(retainSessionContext(this.#ctx), value, true); }
  getFragment(assetId: string) { let value = id(assetId, "designer fragment id", this.#ctx, "designerFragment"); return new MarketoDesignerFragmentImpl(retainSessionContext(this.#ctx), value, true); }

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
    return designerHandle(this.#ctx, kind, provisionalId, true);
  }
}

abstract class DesignerAssetImpl extends RpcTarget {
  protected ctx: EmailDesignerContext;
  protected assetId: string;
  protected abstract kind: EmailDesignerKind;
  private ownsContext: boolean;
  private disposed = false;
  constructor(ctx: EmailDesignerContext, assetId: string, ownsContext = false) {
    super(); this.ctx = ctx; this.assetId = assetId; this.ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.ownsContext && !this.disposed) {
      this.disposed = true;
      this.ctx.dispose();
    }
  }

  protected async detail(): Promise<Record<string, unknown>> {
    let result = await summary(this.ctx, this.kind, this.assetId);
    await this.ctx.observe(`Read Marketo designer ${this.kind}`, `Read designer asset ${this.assetId}.`);
    delete result.cloneSnapshot;
    return result;
  }

  private assertNotDeleted(): void {
    if (actions(this.ctx, this.kind, this.assetId).some(action => action.type === "designerDelete")) {
      throw new Error(`Marketo designer asset ${this.assetId} was deleted.`);
    }
  }

  protected async submitUpdate(patch: Record<string, unknown>) {
    this.assertNotDeleted();
    patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (Object.keys(patch).length === 0) throw new Error("A non-empty update is required.");
    await submitDesigner(this.ctx, { type: "designerUpdate", asset: this.kind, targetId: this.assetId, patch });
  }

  protected async cloneAsset(name: string, description?: string) {
    this.assertNotDeleted();
    let provisionalId = this.ctx.allocateProvisional();
    let source = await summary(this.ctx, this.kind, this.assetId);
    let sourceSnapshot = source.cloneSnapshot as DesignerCloneSnapshot | undefined;
    if (!sourceSnapshot) throw new Error("The Marketo designer clone source could not be snapshotted.");
    await this.ctx.observe(`Read Marketo designer ${this.kind} clone source`, `Resolved dependencies for designer asset ${this.assetId}.`);
    await submitDesigner(this.ctx, { type: "designerClone", asset: this.kind, provisionalId, sourceId: this.assetId,
      name: text(name, "Clone name"), description: optionalText(description, "description"), sourceSnapshot });
    return designerHandle(this.ctx, this.kind, provisionalId, true);
  }

  protected async lifecycle(operation: "createDraft" | "approve" | "unapprove" | "discard") {
    this.assertNotDeleted();
    let sourceState: "draft" | "approved" = operation === "approve" || operation === "discard" ? "draft" : "approved";
    let prior = actions(this.ctx, this.kind, this.assetId)
      .filter((action): action is Extract<EmailDesignerAction, { type: "designerLifecycle" }> =>
        action.type === "designerLifecycle")
      .at(-1);
    if (prior) {
      let pendingState = prior.operation === "approve" || prior.operation === "discard" ? "approved" : "draft";
      if (pendingState !== sourceState) {
        throw new Error(`Designer asset ${this.assetId} has a pending ${pendingState} state, not ${sourceState} content.`);
      }
      if (prior.operation === "approve" || prior.operation === "unapprove") {
        return await submitDesigner(this.ctx, {
          type: "designerLifecycle", asset: this.kind, targetId: this.assetId, operation,
          contentId: prior.contentId, sourceState,
        });
      }
      throw new Error(`Designer asset ${this.assetId} has a pending lifecycle change that must be decided first.`);
    }
    let physical = this.ctx.resolveDesignerId(this.assetId);
    if (physical === undefined) throw new Error(`Designer asset ${this.assetId} is still pending creation.`);
    let raw = await (await this.ctx.client()).getDesignerAsset(path(this.kind), physical);
    if (!raw || String(raw.id) !== physical) throw new Error(`Marketo designer asset ${this.assetId} was not found.`);
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
  delete() {
    this.assertNotDeleted();
    return submitDesigner(this.ctx, { type: "designerDelete", asset: this.kind, targetId: this.assetId });
  }

  async getUsedBy(pageIndex = 0, pageSize = 20) {
    this.assertNotDeleted();
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error("pageIndex must be a non-negative integer.");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error("pageSize must be between 1 and 50.");
    let physical = this.ctx.resolveDesignerId(this.assetId);
    let affected = this.kind === "designerTemplate" ? this.ctx.pendingDesigner().filter(action =>
      action.asset === "designerEmail" && (
        action.type === "designerCreate" || action.type === "designerClone" || action.type === "designerDelete" ||
        action.type === "designerUpdate" && action.patch.templateId !== undefined
      )) : [];
    let client = await this.ctx.client();
    if (affected.length === 0) {
      if (physical === undefined) throw new Error(`Designer asset ${this.assetId} is still pending creation.`);
      let raw = await client.getDesignerAssetUsedBy(path(this.kind), { assetId: physical, pageIndex, pageSize, type: "all" });
      if (raw.pageDetails?.currentPage !== pageIndex + 1 || raw.pageDetails.pageSize !== pageSize) {
        throw new Error(`Marketo returned used-by page ${String(raw.pageDetails?.currentPage)} with page size ${String(raw.pageDetails?.pageSize)} when page ${pageIndex} with page size ${pageSize} was requested.`);
      }
      let items = raw.result.flatMap(item => item.id === undefined ? [] : [usedBySummary({
        ...item,
        workspaceId: item.appData?.workspaceId === undefined ? undefined : String(item.appData.workspaceId),
        folderId: item.appData?.folderId === undefined ? undefined : String(item.appData.folderId),
      })]);
      await this.ctx.observe(`Read dependencies for Marketo designer ${this.kind}`, `Read ${items.length} direct dependency record(s) for ${this.assetId}.`);
      return { items, totalItems: raw.pageDetails.totalItems, pageIndex, pageSize };
    }

    let items: MarketoDesignerUsedBy[] = [];
    if (physical !== undefined) {
      let providerCount = 0;
      let pageFingerprints = new Set<string>();
      for (let providerPage = 0; ; providerPage++) {
        let raw = await client.getDesignerAssetUsedBy(path(this.kind), {
          assetId: physical, pageIndex: providerPage, pageSize: DESIGNER_PAGE_SIZE, type: "all",
        });
        if (raw.pageDetails?.currentPage !== providerPage + 1 || raw.pageDetails.pageSize !== DESIGNER_PAGE_SIZE) {
          throw new Error(`Marketo returned used-by page ${String(raw.pageDetails?.currentPage)} with page size ${String(raw.pageDetails?.pageSize)} when page ${providerPage} with page size ${DESIGNER_PAGE_SIZE} was requested.`);
        }
        if (raw.pageDetails.totalItems !== undefined &&
            raw.pageDetails.totalItems > MAX_SIMULATED_USED_BY_ITEMS) {
          throw new Error(`Pending Designer used-by simulation cannot exceed ${MAX_SIMULATED_USED_BY_ITEMS} provider records.`);
        }
        let fingerprint = JSON.stringify(raw.result);
        if (raw.result.length === DESIGNER_PAGE_SIZE && pageFingerprints.has(fingerprint)) {
          throw new Error("Marketo returned a repeated full used-by page.");
        }
        pageFingerprints.add(fingerprint);
        if (providerCount + raw.result.length > MAX_SIMULATED_USED_BY_ITEMS) {
          throw new Error(`Pending Designer used-by simulation cannot exceed ${MAX_SIMULATED_USED_BY_ITEMS} provider records.`);
        }
        items.push(...raw.result.flatMap(item => item.id === undefined ? [] : [usedBySummary({
          ...item,
          workspaceId: item.appData?.workspaceId === undefined ? undefined : String(item.appData.workspaceId),
          folderId: item.appData?.folderId === undefined ? undefined : String(item.appData.folderId),
        })]));
        providerCount += raw.result.length;
        if (raw.result.length < DESIGNER_PAGE_SIZE ||
            raw.pageDetails.totalItems !== undefined && providerCount >= raw.pageDetails.totalItems) break;
        if (providerCount >= MAX_SIMULATED_USED_BY_ITEMS) {
          throw new Error(`Pending Designer used-by simulation cannot exceed ${MAX_SIMULATED_USED_BY_ITEMS} provider records.`);
        }
      }
    }

    let candidateIds: string[] = [];
    for (let action of affected) {
      let candidate = action.type === "designerCreate" || action.type === "designerClone"
        ? action.provisionalId
        : action.targetId;
      if (!candidateIds.some(existing => same(this.ctx, existing, candidate))) candidateIds.push(candidate);
    }
    for (let candidateId of candidateIds) {
      let candidateActions = actions(this.ctx, "designerEmail", candidateId);
      let first = affected.find(action =>
        action.asset === "designerEmail" && (action.type === "designerCreate" || action.type === "designerClone"
          ? same(this.ctx, action.provisionalId, candidateId)
          : same(this.ctx, action.targetId, candidateId)));
      if (!first) continue;
      let isCreation = candidateActions.some(action =>
        action.type === "designerCreate" || action.type === "designerClone");
      let original = isCreation ? undefined : await summary(this.ctx, "designerEmail", candidateId, first.id);
      let deleted = candidateActions.some(action => action.type === "designerDelete");
      let final = deleted ? undefined : await summary(this.ctx, "designerEmail", candidateId);
      let originalMatches = original?.templateId !== undefined && same(this.ctx, String(original.templateId), this.assetId);
      let finalMatches = final?.templateId !== undefined && same(this.ctx, String(final.templateId), this.assetId);
      let physicalCandidate = this.ctx.resolveDesignerId(candidateId);
      if (originalMatches || finalMatches || (isCreation && physicalCandidate !== undefined)) {
        items = items.filter(item => item.id !== candidateId && item.id !== physicalCandidate);
      }
      if (finalMatches && final) items.push(usedBySummary(final));
    }
    if (items.length > MAX_SIMULATED_USED_BY_ITEMS) {
      throw new Error(`Pending Designer used-by simulation cannot exceed ${MAX_SIMULATED_USED_BY_ITEMS} records.`);
    }

    let totalItems = items.length;
    items = items.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    await this.ctx.observe(`Read dependencies for Marketo designer ${this.kind}`, `Read ${items.length} direct dependency record(s) for ${this.assetId}.`);
    return { items, totalItems, pageIndex, pageSize };
  }
}

@validateRpc()
export class MarketoDesignerEmailImpl extends DesignerAssetImpl {
  protected kind = "designerEmail" as const;
  async describe(): Promise<MarketoDesignerEmailDetail> { return await this.detail() as MarketoDesignerEmailDetail; }
  async update(value: MarketoDesignerEmailPatch) {
    let input = only(value, "Designer email patch", ["name", "description", "headers", "content", "settings", "templateId"]);
    if (input.templateId !== undefined && input.content !== undefined) {
      throw new Error("templateId and content cannot be updated together because applying a template overwrites email content.");
    }
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

function designerHandle(
  ctx: EmailDesignerContext,
  kind: EmailDesignerKind,
  assetId: string,
  ownsContext = false,
): DesignerAssetImpl {
  if (ownsContext) retainSessionContext(ctx);
  if (kind === "designerEmail") return new MarketoDesignerEmailImpl(ctx, assetId, ownsContext);
  if (kind === "designerTemplate") return new MarketoDesignerEmailTemplateImpl(ctx, assetId, ownsContext);
  return new MarketoDesignerFragmentImpl(ctx, assetId, ownsContext);
}
