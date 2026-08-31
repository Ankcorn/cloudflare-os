// The capability objects handed to a Gadget.
//
// Every read authorizes an observation before returning data; every write submits an action and
// returns without touching Marketo. Handles are deliberately narrow: a program- or list-scoped
// binding only ever receives the corresponding object, never the whole-instance session.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import {
  ASSET_PAGE_MAX,
  MarketoError,
  MAX_ACTIVITY_TYPE_IDS,
  MAX_FILTER_VALUES,
  parseMarketoDate,
  qualifyTokenName,
  type MarketoClient,
  type MarketoPage,
  type RawActivity,
  type RawCampaign,
  type RawCampaignAsset,
  type RawChannel,
  type RawCustomObjectField,
  type RawLead,
  type RawList,
  type RawProgram,
  type RawProgramTag,
  type RawSmartListRule,
  type RawTagType,
  type RawLeadField,
} from "./marketo-api";
import type { MarketoActionInput } from "./actions";
import {
  MarketoBusinessObjectImpl,
  type BusinessObjectContext,
} from "./business-objects";
import type { CampaignAction, CampaignActionInput } from "./campaign-actions";
import type { ProgramAction, ProgramActionInput } from "./program-actions";
import { MarketoDesignStudioImpl, type DesignStudioContext } from "./design-studio";
import type {
  MarketoActivity,
  MarketoActivityPage,
  MarketoActivityQuery,
  MarketoActivityType,
  MarketoAssetFolderRef,
  MarketoApiUsage,
  MarketoCustomObjectSchema,
  MarketoCustomObjectSummary,
  MarketoFieldMetadata,
  MarketoCloneProgramInput,
  MarketoCreateProgramInput,
  MarketoNameFilter,
  MarketoPersonInput,
  MarketoPersonLookup,
  MarketoPersonRecord,
  MarketoProgramChannel,
  MarketoProgramId,
  MarketoProgramMembership,
  MarketoProgramSummary,
  MarketoProgramTag,
  MarketoProgramTagType,
  MarketoSmartCampaignSummary,
  MarketoSmartListRule,
  MarketoSmartListRules,
  MarketoStaticListSummary,
  MarketoToken,
  MarketoUpsertAction,
  MarketoBusinessObjectKind,
} from "./types";

/** Fields returned when the caller doesn't ask for specific ones. Kept small on purpose: the
 * instance exposes thousands of fields and dumping them all is both slow and a data-exposure
 * risk. */
const DEFAULT_PERSON_FIELDS = [
  "id",
  "email",
  "firstName",
  "lastName",
  "company",
  "createdAt",
  "updatedAt",
];

/** Plumbing every session object needs. */
export type SessionContext = {
  /** Resolve a client for each operation so revocation takes effect on existing sessions. */
  client(): Promise<MarketoClient>;
  /** Authorize a read. Must be awaited before returning any data to the caller. */
  observe(title: string, description: string): Promise<void>;
  /** Queue a write for approval. Resolves once submitted, not once applied. */
  submit(action: MarketoActionInput): Promise<void>;
  /** Acquire another owner before handing this context to an independently-lived capability. */
  retain(): void;
  /** Release one owner. The ApprovalQueue stub is disposed with the final owner. */
  dispose(): void;
};

/** Acquire and return a context for an independently-lived child capability. */
export function retainSessionContext<T extends SessionContext>(ctx: T): T {
  ctx.retain();
  return ctx;
}

// ---------------------------------------------------------------------------
// Normalization

/** Map a raw program to the summary shape handed to callers. */
function normalizeProgram(program: RawProgram, fallbackId = -1): MarketoProgramSummary {
  return {
    id: program.id ?? fallbackId,
    name: program.name ?? "",
    description: program.description,
    type: program.type,
    channel: program.channel,
    status: program.status,
    tags: program.tags?.flatMap(normalizeProgramTag) ?? undefined,
    startDate: parseMarketoDate(program.startDate),
    endDate: parseMarketoDate(program.endDate),
    workspaceName: program.workspace,
    folderName: program.folder?.folderName,
    createdAt: parseMarketoDate(program.createdAt),
    updatedAt: parseMarketoDate(program.updatedAt),
};
}

function normalizeProgramTag(tag: RawProgramTag): MarketoProgramTag[] {
  return tag.tagType && tag.tagValue !== undefined
    ? [{ type: tag.tagType, value: tag.tagValue }]
    : [];
}

function normalizeList(list: RawList, fallbackId = -1): MarketoStaticListSummary {
  return {
    id: list.id ?? fallbackId,
    name: list.name ?? "",
    programName: list.programName,
    workspaceName: list.workspaceName,
    createdAt: parseMarketoDate(list.createdAt),
    updatedAt: parseMarketoDate(list.updatedAt),
  };
}

function normalizeCampaign(
  campaign: RawCampaign & RawCampaignAsset,
  fallbackId = "-1",
): MarketoSmartCampaignSummary {
  let folderId = campaign.folder?.id ?? campaign.folder?.value;
  let folderType = campaign.folder?.type?.toLowerCase();
  return {
    id: campaign.id ?? fallbackId,
    name: campaign.name ?? "",
    description: campaign.description,
    type: campaign.type,
    status: campaign.status,
    programName: campaign.programName,
    folder: folderId !== undefined && (folderType === "folder" || folderType === "program")
      ? { id: String(folderId), type: folderType }
      : undefined,
    workspaceName: campaign.workspaceName ?? campaign.workspace,
    active: campaign.active ?? campaign.isActive,
    requestable: campaign.isTriggerable ?? campaign.isRequestable,
    createdAt: parseMarketoDate(campaign.createdAt),
    updatedAt: parseMarketoDate(campaign.updatedAt),
  };
}

function normalizeSmartListRule(rule: RawSmartListRule): MarketoSmartListRule {
  return {
    id: rule.id,
    name: rule.name ?? "",
    type: rule.ruleType,
    operator: rule.operator,
    conditions: rule.conditions?.map(condition => ({
      name: condition.activityAttributeName ?? condition.fieldName,
      operator: condition.operator,
      values: condition.values,
      primary: condition.isPrimary,
    })),
  };
}

/** Campaign-specific access to the binding's provisional-id and pending-action state. */
export type CampaignContext = DesignStudioContext & {
  pendingCampaign(): CampaignAction[];
  submitCampaign(action: CampaignActionInput): Promise<void>;
  pendingProgram(): ProgramAction[];
  submitProgram(action: ProgramActionInput): Promise<void>;
};

type WholeInstanceContext = CampaignContext & BusinessObjectContext;

/**
 * Shape a page of summaries the way every other paged read here does: the items under their own
 * key, plus `moreResult`/`nextPageToken`. Each page fetch is one upstream data request; the first
 * activity page also acquires a paging token, but no call fans out into a whole-instance scan.
 */
function pageOf<K extends string, T>(
  key: K,
  page: MarketoPage<unknown>,
  items: T[],
): { moreResult: boolean; nextPageToken?: string } & Record<K, T[]> {
  return {
    [key]: items,
    moreResult: page.moreResult,
    nextPageToken: page.nextPageToken,
  } as { moreResult: boolean; nextPageToken?: string } & Record<K, T[]>;
}

function sameManagedId(ctx: CampaignContext, left: string, right: string): boolean {
  if (left === right) return true;
  let resolved = ctx.resolveId(left);
  return resolved !== undefined && resolved === ctx.resolveId(right);
}

function overlayProgram(
  ctx: CampaignContext,
  summary: MarketoProgramSummary,
  actions: ProgramAction[],
): MarketoProgramSummary | null {
  let result = { ...summary };
  for (let action of actions) {
    if (!("targetId" in action) || !sameManagedId(ctx, action.targetId, String(summary.id))) continue;
    if (action.type === "programUpdate") {
      Object.assign(result,
        action.patch.name === undefined ? {} : { name: action.patch.name },
        action.patch.description === undefined ? {} : { description: action.patch.description },
        action.patch.tags === undefined ? {} : {
          tags: action.patch.tags.map(tag => ({ type: tag.tagType, value: tag.tagValue })),
        },
        action.patch.startDate === undefined ? {} : { startDate: parseMarketoDate(action.patch.startDate) },
        action.patch.endDate === undefined ? {} : { endDate: parseMarketoDate(action.patch.endDate) },
      );
    }
    if (action.type === "programLifecycle") {
      if (action.operation === "delete") return null;
      if (action.operation === "unapprove") result.status = "unlocked";
    }
  }
  return result;
}

function overlayCampaign(
  ctx: CampaignContext,
  summary: MarketoSmartCampaignSummary,
  actions: CampaignAction[],
): MarketoSmartCampaignSummary | null {
  let result = { ...summary };
  for (let action of actions) {
    if (!("targetId" in action) || !sameManagedId(ctx, action.targetId, String(summary.id))) continue;
    if (action.type === "campaignMetadata") Object.assign(result, action.patch);
    if (action.type === "campaignLifecycle") {
      if (action.operation === "delete") return null;
      if (action.operation === "deactivate") Object.assign(result, { active: false, status: "Inactive" });
    }
  }
  return result;
}

function managedCandidateIds<T extends ProgramAction | CampaignAction>(actions: T[]): string[] {
  let ids = actions.flatMap(action => {
    if (action.type === "programCreate" || action.type === "programClone" ||
        action.type === "campaignCreate" || action.type === "campaignClone") {
      return [action.provisionalId];
    }
    return "targetId" in action ? [action.targetId] : [];
  });
  return [...new Set(ids)];
}

function isProgramName(summary: MarketoProgramSummary, name: string): boolean {
  return summary.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0;
}

function isCampaignMatch(
  summary: MarketoSmartCampaignSummary,
  filter: MarketoNameFilter & { requestableOnly?: boolean },
): boolean {
  if (filter.requestableOnly && !summary.requestable) return false;
  let name = summary.name.toLocaleLowerCase();
  if (filter.name !== undefined && name !== filter.name.trim().toLocaleLowerCase()) return false;
  if (filter.nameContains !== undefined && !name.includes(filter.nameContains.trim().toLocaleLowerCase())) return false;
  return true;
}

const CAMPAIGN_PAGE_SIZE = 300;
const CAMPAIGN_TOKEN_PREFIX = "gk-campaign:";
const CAMPAIGN_TOKEN_MAX_LENGTH = 16_384;

type CampaignPageState = {
  actionIds: number[];
  candidateIds: string[];
  maskedIds: string[];
  upstreamToken?: string;
  skip: number;
  scope: string;
};

function campaignScope(filter: MarketoNameFilter & { requestableOnly?: boolean }): string {
  return JSON.stringify({
    name: filter.name,
    nameContains: filter.nameContains,
    requestableOnly: filter.requestableOnly === true,
  });
}

function campaignPageState(
  filter: MarketoNameFilter & { requestableOnly?: boolean },
  actions: CampaignAction[],
): CampaignPageState {
  if (filter.pageToken === undefined) {
    return {
      actionIds: actions.map(action => action.id),
      candidateIds: managedCandidateIds(actions),
      maskedIds: managedCandidateIds(actions),
      skip: 0,
      scope: campaignScope(filter),
    };
  }
  try {
    if (filter.pageToken.length > CAMPAIGN_TOKEN_MAX_LENGTH ||
        !filter.pageToken.startsWith(CAMPAIGN_TOKEN_PREFIX)) throw new Error();
    let encoded = filter.pageToken.slice(CAMPAIGN_TOKEN_PREFIX.length)
      .replace(/-/g, "+").replace(/_/g, "/");
    let bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
      character => character.charCodeAt(0));
    let state = JSON.parse(new TextDecoder().decode(bytes)) as CampaignPageState;
    if (!Array.isArray(state.actionIds) || state.actionIds.length > 100 ||
        state.actionIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(state.actionIds).size !== state.actionIds.length ||
        !Array.isArray(state.candidateIds) || state.candidateIds.length > 100 ||
        state.candidateIds.some(id => typeof id !== "string" || !/^(?:[1-9]\d*|~[1-9]\d*)$/.test(id)) ||
        new Set(state.candidateIds).size !== state.candidateIds.length ||
        !Array.isArray(state.maskedIds) || state.maskedIds.length > 100 ||
        state.maskedIds.some(id => typeof id !== "string" || !/^(?:[1-9]\d*|~[1-9]\d*)$/.test(id)) ||
        new Set(state.maskedIds).size !== state.maskedIds.length ||
        !Number.isSafeInteger(state.skip) || state.skip < 0 || state.skip > CAMPAIGN_PAGE_SIZE ||
        state.upstreamToken !== undefined && typeof state.upstreamToken !== "string" ||
        state.scope !== campaignScope(filter)) throw new Error();
    return state;
  } catch {
    throw new Error("Invalid Marketo smart campaign page token.");
  }
}

function campaignPageToken(state: CampaignPageState): string {
  let bytes = new TextEncoder().encode(JSON.stringify(state));
  let token = CAMPAIGN_TOKEN_PREFIX + btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (token.length > CAMPAIGN_TOKEN_MAX_LENGTH) {
    throw new Error("Too many pending Marketo campaign changes to create a page token.");
  }
  return token;
}

/**
 * Normalize a person field. The API name lives under `rest`/`soap`; a field with neither cannot be
 * addressed by any call we expose, so it is dropped by the caller rather than reported nameless.
 */
function normalizePersonField(
  raw: RawLeadField,
  searchable: ReadonlySet<string>,
): MarketoFieldMetadata | undefined {
  let name = raw.rest?.name ?? raw.soap?.name;
  if (!name) return undefined;
  return {
    name,
    displayName: raw.displayName ?? name,
    dataType: (raw.dataType ?? "string") as MarketoFieldMetadata["dataType"],
    length: raw.length,
    readOnly: Boolean(raw.rest?.readOnly ?? raw.soap?.readOnly ?? false),
    searchable: searchable.has(name),
  };
}

/**
 * Normalize a custom object field, whose shape differs from a person field's: the API name is at
 * the top level and writability is stated positively as `updateable`.
 */
function normalizeCustomObjectField(
  raw: RawCustomObjectField,
  searchable: ReadonlySet<string>,
): MarketoFieldMetadata | undefined {
  if (!raw.name) return undefined;
  return {
    name: raw.name,
    displayName: raw.displayName ?? raw.name,
    dataType: (raw.dataType ?? "string") as MarketoFieldMetadata["dataType"],
    length: raw.length,
    readOnly: raw.updateable === undefined ? false : !raw.updateable,
    searchable: searchable.has(raw.name),
  };
}

/** Marketo's raw membership block, as returned nested in a program member record. */
type RawProgramMembership = {
  id: number;
  progressionStatus?: string;
  progressionStatusType?: string;
  reachedSuccess?: boolean;
  acquiredBy?: boolean;
  isExhausted?: boolean;
  membershipDate?: string;
  updatedAt?: string;
};

/** Drops Marketo's repeated program id and gives the status its documented name. */
function normalizeMembership(raw: RawProgramMembership): MarketoProgramMembership {
  return {
    status: raw.progressionStatus,
    statusType: raw.progressionStatusType,
    reachedSuccess: raw.reachedSuccess,
    acquiredBy: raw.acquiredBy,
    isExhausted: raw.isExhausted,
    membershipDate: parseMarketoDate(raw.membershipDate),
    updatedAt: parseMarketoDate(raw.updatedAt),
  };
}

function personId(raw: RawLead): number {
  if (!Number.isSafeInteger(raw.id) || Number(raw.id) <= 0) {
    throw new MarketoError("Marketo returned a person with an invalid id.");
  }
  return Number(raw.id);
}

function normalizeLead(raw: RawLead, fields: readonly string[]): MarketoPersonRecord {
  let result: MarketoPersonRecord = { id: personId(raw) };
  for (let field of fields) {
    if (field !== "id" && Object.hasOwn(raw, field)) result[field] = raw[field];
  }
  return result;
}

function parsePersonId(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  let parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function matchesPersonLookup(lead: RawLead, lookup: MarketoPersonLookup): boolean {
  if (lookup.field === "id") return personId(lead) === parsePersonId(lookup.value);
  return Object.hasOwn(lead, lookup.field) && String(lead[lookup.field]) === lookup.value;
}

function normalizeActivity(raw: RawActivity): MarketoActivity {
  let attributes: Record<string, unknown> | undefined;
  if (raw.attributes?.length) {
    attributes = {};
    for (let attr of raw.attributes) {
      if (attr.name) attributes[attr.name] = attr.value;
    }
  }
  let guid = typeof raw.marketoGUID === "string" && raw.marketoGUID.trim() ? raw.marketoGUID : undefined;
  return {
    id: guid ?? raw.id!,
    activityTypeId: raw.activityTypeId!,
    personId: raw.leadId!,
    date: parseMarketoDate(raw.activityDate)!,
    primaryAttributeValue: raw.primaryAttributeValue,
    attributes,
  };
}

function validateActivityQuery(query: MarketoActivityQuery): void {
  if (!(query?.sinceDate instanceof Date) || Number.isNaN(query.sinceDate.getTime())) {
    throw new Error("query.sinceDate is required and must be a valid Date.");
  }
  if (!query.activityTypeIds?.length) {
    throw new Error(
      "query.activityTypeIds is required — Marketo cannot return all activity types at once. " +
        "Call getActivityTypes() and pass the ids you need.",
    );
  }
  if (query.activityTypeIds.length > MAX_ACTIVITY_TYPE_IDS) {
    throw new Error(
      `Marketo allows at most ${MAX_ACTIVITY_TYPE_IDS} activityTypeIds per query; ` +
        `${query.activityTypeIds.length} were given.`,
    );
  }
  if (query.activityTypeIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("query.activityTypeIds must contain only positive numeric Marketo activity type ids.");
  }
}

function validateActivity(raw: RawActivity, requestedTypeIds: Set<number>): void {
  let hasGuid = typeof raw.marketoGUID === "string" && Boolean(raw.marketoGUID.trim());
  if (!hasGuid && (!Number.isSafeInteger(raw.id) || raw.id! <= 0)) {
    throw new MarketoError("Marketo returned an activity without a valid positive numeric id or GUID.");
  }
  if (!Number.isSafeInteger(raw.activityTypeId) || raw.activityTypeId! <= 0) {
    throw new MarketoError("Marketo returned an activity with an invalid activity type id.");
  }
  if (!requestedTypeIds.has(raw.activityTypeId!)) {
    throw new MarketoError("Marketo returned an activity type outside the requested query set.");
  }
  if (!Number.isSafeInteger(raw.leadId) || raw.leadId! <= 0) {
    throw new MarketoError("Marketo returned an activity with an invalid lead id.");
  }
  if (!parseMarketoDate(raw.activityDate)) {
    throw new MarketoError("Marketo returned an activity with an invalid activity date.");
  }
}

/** Resolve a page of activities, optionally scoped to specific people. */
async function readActivities(
  ctx: SessionContext,
  query: MarketoActivityQuery,
  pageToken: string | undefined,
  leadIds: number[] | undefined,
  scopeLabel: string,
): Promise<MarketoActivityPage> {
  validateActivityQuery(query);

  let client = await ctx.client();
  let token = pageToken ?? (await client.getPagingToken(query.sinceDate));
  let page = await client.getActivities({
    nextPageToken: token,
    activityTypeIds: query.activityTypeIds,
    leadIds,
    batchSize: query.maxResults,
  });
  let requestedTypeIds = new Set(query.activityTypeIds);
  for (let activity of page.result) validateActivity(activity, requestedTypeIds);
  if (leadIds && page.result.some(activity => !leadIds.includes(activity.leadId ?? -1))) {
    throw new MarketoError("Marketo returned an activity outside the requested person scope.", {
      operation: "/v1/activities.json",
    });
  }
  await ctx.observe(
    `Read ${page.result.length} Marketo activities`,
    `Read **${page.result.length}** activity record(s) ${scopeLabel} since ` +
      `${query.sinceDate.toISOString()}.`,
  );
  return {
    activities: page.result.map(normalizeActivity),
    moreResult: page.moreResult,
    nextPageToken: page.nextPageToken,
  };
}

// ---------------------------------------------------------------------------
// Person

@validateRpc()
export class MarketoPersonImpl extends RpcTarget {
  #ctx: SessionContext;
  #lookup: MarketoPersonLookup;
  #ownsContext: boolean;
  #disposed = false;

  constructor(ctx: SessionContext, lookup: MarketoPersonLookup, ownsContext = false) {
    super();
    this.#ctx = ctx;
    this.#lookup = lookup;
    this.#ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.#ownsContext && !this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

  async #resolveId(): Promise<number | undefined> {
    if (this.#lookup.field === "id") {
      let parsed = parsePersonId(this.#lookup.value);
      if (parsed !== undefined) return parsed;
      throw new Error("A person id lookup must be a canonical positive base-10 safe integer.");
    }
    await this.#ctx.observe(
      "Resolve a Marketo person",
      `Look up a Marketo person by \`${this.#lookup.field}\`.`,
    );
    let leads = await (await this.#ctx.client()).getLeads(
      this.#lookup.field,
      [this.#lookup.value],
      ["id", this.#lookup.field],
    );
    for (let lead of leads) personId(lead);
    let id = leads.find(lead => matchesPersonLookup(lead, this.#lookup))?.id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }

  async read(fields?: string[]): Promise<MarketoPersonRecord | null> {
    let requested = fields?.length ? [...new Set(["id", ...fields])] : DEFAULT_PERSON_FIELDS;
    if (this.#lookup.field === "id" && parsePersonId(this.#lookup.value) === undefined) {
      throw new Error("A person id lookup must be a canonical positive base-10 safe integer.");
    }
    let wireFields = [...new Set([...requested, this.#lookup.field])];
    let leads = await (await this.#ctx.client()).getLeads(
      this.#lookup.field,
      [this.#lookup.value],
      wireFields,
    );
    for (let candidate of leads) personId(candidate);
    let lead = leads.find(candidate => matchesPersonLookup(candidate, this.#lookup));
    await this.#ctx.observe(
      lead ? `Read Marketo person ${lead.id}` : "Read Marketo person (no match)",
      lead
        ? `Read fields \`${requested.join("`, `")}\` for person \`${lead.id}\` ` +
            `(matched \`${this.#lookup.field}\` = \`${this.#lookup.value}\`).`
        : `No Marketo person matched \`${this.#lookup.field}\` = \`${this.#lookup.value}\`.`,
    );
    return lead ? normalizeLead(lead, requested) : null;
  }

  async update(fields: MarketoPersonInput): Promise<void> {
    requireRecord(fields, "fields");
    if (Object.hasOwn(fields, "id")) {
      throw new Error("Person id cannot be changed through update().");
    }
    let personId = await this.#resolveId();
    if (personId === undefined) {
      throw new Error(
        `No Marketo person matches ${this.#lookup.field} = "${this.#lookup.value}"; nothing to update.`,
      );
    }
    await this.#ctx.submit({ type: "updatePerson", personId, fields });
  }

  async getActivities(
    query: MarketoActivityQuery,
    pageToken?: string,
  ): Promise<MarketoActivityPage> {
    validateActivityQuery(query);
    let personId = await this.#resolveId();
    if (personId === undefined) {
      throw new Error(
        `No Marketo person matches ${this.#lookup.field} = "${this.#lookup.value}".`,
      );
    }
    return await readActivities(this.#ctx, query, pageToken, [personId], `for person \`${personId}\``);
  }

  async delete(): Promise<void> {
    let personId = await this.#resolveId();
    if (personId === undefined) {
      throw new Error(
        `No Marketo person matches ${this.#lookup.field} = "${this.#lookup.value}"; nothing to delete.`,
      );
    }
    await this.#ctx.submit({ type: "deletePerson", personId });
  }
}

// ---------------------------------------------------------------------------
// Static list

@validateRpc()
export class MarketoStaticListImpl extends RpcTarget {
  #ctx: SessionContext;
  #listId: number;
  #ownsContext: boolean;
  #disposed = false;

  constructor(ctx: SessionContext, listId: number, ownsContext = false) {
    super();
    this.#ctx = ctx;
    this.#listId = listId;
    this.#ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.#ownsContext && !this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

  async #name(): Promise<string> {
    await this.#ctx.observe(
      "Read a Marketo list for an action",
      `Read the name of static list \`${this.#listId}\` before submitting an action.`,
    );
    let list = await (await this.#ctx.client()).getList(this.#listId);
    return list?.name ?? `list ${this.#listId}`;
  }

  async describe(): Promise<MarketoStaticListSummary> {
    let list = await (await this.#ctx.client()).getList(this.#listId);
    if (!list) throw notFound("static list", this.#listId);
    await this.#ctx.observe(
      `Read Marketo list "${list.name ?? this.#listId}"`,
      `Read metadata for static list **${list.name ?? this.#listId}** (\`${this.#listId}\`).`,
    );
    return normalizeList(list, this.#listId);
  }

  async getMembers(
    fields?: string[],
    pageToken?: string,
  ): Promise<{ members: MarketoPersonRecord[]; moreResult: boolean; nextPageToken?: string }> {
    let requested = fields?.length ? [...new Set(["id", ...fields])] : DEFAULT_PERSON_FIELDS;
    let page = await onHandle("static list", this.#listId, async () => {
      return await (await this.#ctx.client()).getListMembers(this.#listId, requested, pageToken);
    });
    await this.#ctx.observe(
      `Read ${page.result.length} members of Marketo list ${this.#listId}`,
      `Read **${page.result.length}** member record(s) from static list \`${this.#listId}\`, ` +
        `fields \`${requested.join("`, `")}\`.`,
    );
    return {
      members: page.result.map(lead => normalizeLead(lead, requested)),
      moreResult: page.moreResult,
      nextPageToken: page.nextPageToken,
    };
  }

  async addMembers(personIds: number[]): Promise<void> {
    requireIds(personIds);
    await this.#ctx.submit({
      type: "listAdd",
      listId: this.#listId,
      listName: await this.#name(),
      personIds,
    });
  }

  async removeMembers(personIds: number[]): Promise<void> {
    requireIds(personIds);
    await this.#ctx.submit({
      type: "listRemove",
      listId: this.#listId,
      listName: await this.#name(),
      personIds,
    });
  }
}

/**
 * Report a missing target identically however it was discovered.
 *
 * Marketo's own wording depends on which endpoint happened to be called: asking a nonexistent
 * program for its members says "Program '9' not found", but asking for its tokens says "Folder
 * not found" — naming a thing the caller never mentioned, because My Tokens live on the program's
 * folder. Rather than spend a call confirming the target exists first, the upstream failure is
 * relabelled here. Classification is by error code (see `MarketoError.isNotFound`), never by
 * message text.
 */
async function onHandle<T>(label: string, id: number | string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (e instanceof MarketoError && e.isNotFound) {
      throw notFound(label, id, e);
    }
    throw e;
  }
}

/** The canonical "no such thing" error for a handle whose target turned out not to exist. */
function notFound(label: string, id: number | string, cause?: MarketoError): MarketoError {
  return new MarketoError(`Marketo ${label} ${id} was not found.`, {
    code: cause?.code,
    operation: cause?.operation,
    notFound: true,
    cause,
  });
}

/** Marketo documents this ceiling for filter-value reads. Refuse before the request so callers
 * learn the limit directly rather than receiving a generic upstream rejection. */
function requireFilterValueCount(values: string[], label: string): void {
  if (values.length > MAX_FILTER_VALUES) {
    throw new Error(
      `Marketo accepts at most ${MAX_FILTER_VALUES} ${label} values per call; ` +
        `${values.length} were given. Split them into batches.`,
    );
  }
}

function requireIds(personIds: number[]): void {
  if (!Array.isArray(personIds) || personIds.length === 0) {
    throw new Error("Expected a non-empty array of Marketo person ids.");
  }
  if (personIds.length > MAX_FILTER_VALUES) {
    throw new Error(`Marketo accepts at most ${MAX_FILTER_VALUES} person ids per call.`);
  }
  for (let id of personIds) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid Marketo person id: ${JSON.stringify(id)}`);
    }
  }
}

const MAX_CAMPAIGN_INPUTS = 100;
const MIN_SCHEDULE_DELAY_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_DELAY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Program

@validateRpc()
export class MarketoProgramImpl extends RpcTarget {
  #ctx: CampaignContext;
  #programId: string;
  #ownsContext: boolean;
  #channels: Promise<RawChannel[]> | undefined;
  #disposed = false;

  constructor(ctx: SessionContext | CampaignContext, programId: number | string, ownsContext = false) {
    super();
    this.#ctx = managementContext(ctx);
    this.#programId = requireLogicalId(String(programId), "program");
    this.#ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.#ownsContext && !this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

  #sameProgram(left: string, right: string): boolean {
    if (left === right) return true;
    let leftId = this.#ctx.resolveId(left);
    return leftId !== undefined && leftId === this.#ctx.resolveId(right);
  }

  #actions(id = this.#programId, beforeId = Number.POSITIVE_INFINITY): ProgramAction[] {
    return this.#ctx.pendingProgram().filter(action =>
      action.id < beforeId && "targetId" in action && this.#sameProgram(action.targetId, id)
    );
  }

  async #summary(
    id = this.#programId,
    seen = new Set<string>(),
    beforeId = Number.POSITIVE_INFINITY,
  ): Promise<MarketoProgramSummary> {
    if (seen.has(id)) throw new Error(`Program ${id} has a circular clone dependency.`);
    seen.add(id);
    let creation = this.#ctx.pendingProgram().find(action =>
      action.id < beforeId &&
      (action.type === "programCreate" || action.type === "programClone") && action.provisionalId === id
    );
    let summary: MarketoProgramSummary;
    if (creation?.type === "programCreate") {
      summary = {
        id,
        name: creation.input.name,
        description: creation.input.description,
        type: creation.input.type,
        channel: creation.input.channel,
        status: creation.input.type === "Email" ? "unlocked" : "",
        tags: creation.input.tags?.map(tag => ({ type: tag.tagType, value: tag.tagValue })),
        startDate: parseMarketoDate(creation.input.startDate),
        endDate: parseMarketoDate(creation.input.endDate),
      };
    } else if (creation?.type === "programClone") {
      let source = await this.#summary(creation.sourceId, seen, creation.id);
      summary = {
        ...source,
        id,
        name: creation.name,
        description: creation.description ?? source.description,
        status: source.type === "Email" ? "unlocked" : source.status,
        folderName: undefined,
        workspaceName: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      };
    } else {
      let physicalId = this.#ctx.resolveId(id);
      if (physicalId === undefined) throw notFound("program", id);
      let program = await (await this.#ctx.client()).getProgram(physicalId);
      if (!program) throw notFound("program", id);
      summary = normalizeProgram(program, physicalId);
    }

    for (let action of this.#actions(id, beforeId)) {
      if (action.type === "programUpdate") {
        summary = {
          ...summary,
          ...(action.patch.name === undefined ? {} : { name: action.patch.name }),
          ...(action.patch.description === undefined ? {} : { description: action.patch.description }),
          ...(action.patch.tags === undefined ? {} : {
            tags: action.patch.tags.map(tag => ({ type: tag.tagType, value: tag.tagValue })),
          }),
          ...(action.patch.startDate === undefined ? {} : { startDate: parseMarketoDate(action.patch.startDate) }),
          ...(action.patch.endDate === undefined ? {} : { endDate: parseMarketoDate(action.patch.endDate) }),
        };
      }
      if (action.type === "programLifecycle") {
        if (action.operation === "delete") throw notFound("program", id);
        if (action.operation === "unapprove") summary = { ...summary, status: "unlocked" };
      }
    }

    // Progression statuses live on the program's channel, not the program itself.
    let statuses: string[] | undefined;
    if (summary.channel) {
      this.#channels ??= this.#ctx.client().then(client => client.getChannels()).catch(e => {
        this.#channels = undefined;
        throw e;
      });
      let channels = await this.#channels;
      let channel = channels.find(c => c.name === summary.channel);
      statuses = channel?.progressionStatuses
        ?.map(s => s.name)
        .filter((n): n is string => Boolean(n));
    }

    return { ...summary, statuses };
  }

  async describe(): Promise<MarketoProgramSummary> {
    let summary = await this.#summary();
    await this.#ctx.observe("Read a Marketo program", `Read metadata for program \`${this.#programId}\`.`);
    return summary;
  }

  async getTokens(): Promise<MarketoToken[]> {
    this.#rejectPendingDeletion();
    let pendingCreation = this.#pendingCreation();
    if (pendingCreation?.type === "programClone") {
      throw new Error(`Program ${this.#programId} is pending cloning; its tokens are not readable until creation finishes.`);
    }
    if (pendingCreation) {
      await this.#ctx.observe(
        `Read 0 tokens from pending Marketo program ${this.#programId}`,
        `Program \`${this.#programId}\` is pending creation and has no My Tokens yet.`,
      );
      return [];
    }
    let raw = await onHandle("program", this.#programId, async () => {
      return await (await this.#ctx.client()).getProgramTokens(requireResolvedId(this.#ctx, this.#programId, "Program"));
    });
    this.#rejectPendingDeletion();
    // A token without a name can't be referenced as {{my.*}}, so it is of no use to a caller.
    // Marketo reports names bare here; they are qualified once on the way out so that what a
    // caller reads is the form they would paste into a template. The campaign endpoints accept
    // either form, so this is presentation, not a requirement.
    let tokens = raw
      .filter((token): token is typeof token & { name: string } => Boolean(token.name))
      .map(token => ({
        name: qualifyTokenName(token.name),
        type: token.type ?? "",
        value: token.value ?? "",
      }));
    await this.#ctx.observe(
      `Read ${tokens.length} tokens from Marketo program ${this.#programId}`,
      `Read **${tokens.length}** My Token(s) from program \`${this.#programId}\`: ` +
        `${tokens.map(t => `\`${t.name}\``).join(", ") || "_none_"}.`,
    );
    return tokens;
  }

  async getMembers(
    fields?: string[],
    pageToken?: string,
  ): Promise<{
    members: (MarketoPersonRecord & { membership: MarketoProgramMembership })[];
    moreResult: boolean;
    nextPageToken?: string;
  }> {
    this.#rejectPendingDeletion();
    let requested = fields?.length ? [...new Set(["id", ...fields])] : DEFAULT_PERSON_FIELDS;
    let pendingCreation = this.#pendingCreation();
    if (pendingCreation?.type === "programClone") {
      throw new Error(`Program ${this.#programId} is pending cloning; its members are not readable until creation finishes.`);
    }
    if (pendingCreation) {
      await this.#ctx.observe(
        `Read 0 members of pending Marketo program ${this.#programId}`,
        `Program \`${this.#programId}\` is pending creation and has no members yet.`,
      );
      return { members: [], moreResult: false };
    }
    let page = await onHandle("program", this.#programId, async () => {
      return await (await this.#ctx.client()).getProgramMembers(
        requireResolvedId(this.#ctx, this.#programId, "Program"),
        requested,
        pageToken,
      );
    });
    this.#rejectPendingDeletion();
    await this.#ctx.observe(
      `Read ${page.result.length} members of Marketo program ${this.#programId}`,
      `Read **${page.result.length}** member record(s) from program \`${this.#programId}\`.`,
    );
    return {
      members: page.result.map(lead => {
        // Marketo nests membership inside the person record; replace it with the normalized shape
        // rather than passing the raw one through alongside.
        let { membership, ...person } = lead as RawLead & { membership: RawProgramMembership };
        return { ...normalizeLead(person, requested), membership: normalizeMembership(membership) };
      }),
      moreResult: page.moreResult,
      nextPageToken: page.nextPageToken,
    };
  }

  #pendingCreation(): Extract<ProgramAction, { type: "programCreate" | "programClone" }> | undefined {
    return this.#ctx.pendingProgram().find((action): action is Extract<
      ProgramAction,
      { type: "programCreate" | "programClone" }
    > =>
      (action.type === "programCreate" || action.type === "programClone") &&
      action.provisionalId === this.#programId
    );
  }

  #rejectPendingDeletion(): void {
    if (this.#actions().some(action =>
      action.type === "programLifecycle" && action.operation === "delete")) {
      throw notFound("program", this.#programId);
    }
  }

  async setMemberStatus(personIds: number[], status: string): Promise<void> {
    requireIds(personIds);
    if (!status?.trim()) throw new Error("A program membership status is required.");

    let summary = await this.describe();
    if (summary.statuses?.length && !summary.statuses.includes(status)) {
      throw new Error(
        `"${status}" is not a valid status for program "${summary.name}". ` +
          `Valid statuses: ${summary.statuses.join(", ")}.`,
      );
    }

    await this.#ctx.submit({
      type: "programStatus",
      programId: requireResolvedId(this.#ctx, this.#programId, "Program"),
      programName: summary.name,
      personIds,
      status,
    });
  }

  async updateMetadata(patch: { name?: string; description?: string }): Promise<void> {
    requireOnlyKeys(patch, "Program metadata patch", ["name", "description"], ["type", "channel"]);
    let name = patch.name === undefined ? undefined : requireText(patch.name, "Program name", 255);
    let description = patch.description === undefined
      ? undefined
      : requireText(patch.description, "Program description", 2_000, true);
    if (name === undefined && description === undefined) throw new Error("Set name or description.");
    let summary = await this.describe();
    await this.#ctx.submitProgram({
      type: "programUpdate", targetId: this.#programId, programName: summary.name,
      patch: { name, description },
    });
  }

  async updateTags(tags: MarketoProgramTag[]): Promise<void> {
    let summary = await this.describe();
    let validated = await validateProgramTags(this.#ctx, summary.type, tags);
    await this.#ctx.submitProgram({
      type: "programUpdate", targetId: this.#programId, programName: summary.name,
      patch: { tags: validated },
    });
  }

  async updateDates(startDate: Date, endDate: Date): Promise<void> {
    let summary = await this.describe();
    if (summary.type !== "Email") throw new Error("Only Email Programs have start and end dates.");
    let dates = requireProgramDates(startDate, endDate);
    await this.#ctx.submitProgram({
      type: "programUpdate", targetId: this.#programId, programName: summary.name, patch: dates,
    });
  }

  async approve(): Promise<void> {
    let summary = await this.describe();
    if (summary.type !== "Email") throw new Error("Only Email Programs can be approved.");
    if (!summary.startDate || !summary.endDate) throw new Error("Set both Email Program dates before approval.");
    await this.#ctx.submitProgram({
      type: "programLifecycle", targetId: this.#programId, programName: summary.name,
      programType: summary.type, operation: "approve",
      startDate: summary.startDate.toISOString(), endDate: summary.endDate.toISOString(),
    });
  }

  async unapprove(): Promise<void> {
    let summary = await this.describe();
    if (summary.type !== "Email") throw new Error("Only Email Programs can be unapproved.");
    await this.#ctx.submitProgram({
      type: "programLifecycle", targetId: this.#programId, programName: summary.name,
      programType: summary.type, operation: "unapprove",
    });
  }

  async delete(): Promise<void> {
    let summary = await this.describe();
    await this.#ctx.submitProgram({
      type: "programLifecycle", targetId: this.#programId, programName: summary.name,
      programType: summary.type, operation: "delete",
    });
  }
}

// ---------------------------------------------------------------------------
// Smart campaign

@validateRpc()
export class MarketoSmartCampaignImpl extends RpcTarget {
  #ctx: CampaignContext;
  #campaignId: string;
  #ownsContext: boolean;
  #disposed = false;

  constructor(ctx: SessionContext | CampaignContext, campaignId: string | number, ownsContext = false) {
    super();
    this.#ctx = managementContext(ctx);
    this.#campaignId = requireLogicalId(String(campaignId), "campaign");
    this.#ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.#ownsContext && !this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

  #sameCampaign(left: string, right: string): boolean {
    if (left === right) return true;
    let leftId = this.#ctx.resolveId(left);
    return leftId !== undefined && leftId === this.#ctx.resolveId(right);
  }

  #actions(id = this.#campaignId, beforeId = Number.POSITIVE_INFINITY): CampaignAction[] {
    return this.#ctx.pendingCampaign().filter(action =>
      action.id < beforeId && "targetId" in action && this.#sameCampaign(action.targetId, id)
    );
  }

  #rejectPendingDeletion(): void {
    if (this.#actions().some(action =>
      action.type === "campaignLifecycle" && action.operation === "delete")) {
      throw new Error(`Smart campaign ${this.#campaignId} has a pending deletion.`);
    }
  }

  async #summary(
    id = this.#campaignId,
    seen = new Set<string>(),
    beforeId = Number.POSITIVE_INFINITY,
  ): Promise<MarketoSmartCampaignSummary> {
    if (seen.has(id)) throw new Error(`Smart campaign ${id} has a circular clone dependency.`);
    seen.add(id);
    let creation = this.#ctx.pendingCampaign().find(action =>
      action.id < beforeId &&
      (action.type === "campaignCreate" || action.type === "campaignClone") && action.provisionalId === id
    );
    let summary: MarketoSmartCampaignSummary;
    if (creation?.type === "campaignCreate") {
      summary = {
        id,
        name: creation.name,
        description: creation.description,
        type: "batch",
        status: "Never Run",
        folder: { id: creation.parent.id, type: creation.parent.type === "Folder" ? "folder" : "program" },
        active: false,
        requestable: false,
      };
    } else if (creation?.type === "campaignClone") {
      let source = await this.#summary(creation.sourceId, seen, creation.id);
      summary = {
        ...source,
        id,
        name: creation.name,
        description: creation.description ?? source.description,
        status: source.type?.toLowerCase() === "trigger" ? "Inactive" : "Never Run",
        folder: { id: creation.parent.id, type: creation.parent.type === "Folder" ? "folder" : "program" },
        active: false,
        requestable: false,
        createdAt: undefined,
        updatedAt: undefined,
      };
    } else {
      let physicalId = this.#ctx.resolveId(id);
      if (physicalId === undefined) throw notFound("smart campaign", id);
      let campaign = await (await this.#ctx.client()).getSmartCampaign(physicalId);
      if (!campaign) throw notFound("smart campaign", id);
      if (campaign.id !== physicalId) {
        throw new MarketoError(`Marketo returned the wrong smart campaign for exact read ${physicalId}.`);
      }
      summary = normalizeCampaign(campaign, id);
    }

    for (let action of this.#actions(id, beforeId)) {
      if (action.type === "campaignMetadata") {
        summary = {
          ...summary,
          ...(action.patch.name === undefined ? {} : { name: action.patch.name }),
          ...(action.patch.description === undefined ? {} : { description: action.patch.description }),
        };
      }
      if (action.type === "campaignLifecycle") {
        if (action.operation === "delete") throw notFound("smart campaign", id);
        summary = {
          ...summary,
          active: action.operation === "activate",
          status: action.operation === "activate" ? "Active" : "Inactive",
        };
      }
    }
    return summary;
  }

  async #campaign(): Promise<RawCampaign> {
    let physicalId = this.#ctx.resolveId(this.#campaignId);
    if (physicalId === undefined) {
      throw new Error(`Smart campaign ${this.#campaignId} is still pending creation.`);
    }
    let campaign = await (await this.#ctx.client()).getCampaign(physicalId);
    if (!campaign) throw notFound("smart campaign", this.#campaignId);
    if (campaign.id !== physicalId) {
      throw new MarketoError(`Marketo returned the wrong campaign for exact read ${physicalId}.`);
    }
    await this.#ctx.observe(
      "Read a Marketo smart campaign",
      `Read metadata for smart campaign \`${this.#campaignId}\`.`,
    );
    return campaign;
  }

  async describe(): Promise<MarketoSmartCampaignSummary> {
    let summary = await this.#summary();
    await this.#ctx.observe(
      "Read a Marketo smart campaign",
      `Read metadata for smart campaign \`${this.#campaignId}\`.`,
    );
    return summary;
  }

  async readSmartListRules(): Promise<MarketoSmartListRules> {
    await this.#summary();
    let rules = await this.#smartListRules(this.#campaignId, new Set(), Number.POSITIVE_INFINITY);
    await this.#ctx.observe(
      "Read a Marketo smart campaign's smart-list rules",
      `Read ${rules.triggers.length} trigger(s) and ${rules.filters.length} filter(s) for smart campaign \`${this.#campaignId}\`.`,
    );
    return rules;
  }

  async #smartListRules(
    id: string,
    seen: Set<string>,
    beforeId: number,
  ): Promise<MarketoSmartListRules> {
    if (seen.has(id)) throw new Error(`Smart campaign ${id} has a circular clone dependency.`);
    seen.add(id);
    let creation = this.#ctx.pendingCampaign().find(action =>
      action.id < beforeId &&
      (action.type === "campaignCreate" || action.type === "campaignClone") &&
      action.provisionalId === id
    );
    if (creation?.type === "campaignCreate") {
      return { triggers: [], filters: [] };
    }
    if (creation?.type === "campaignClone") {
      return await this.#smartListRules(creation.sourceId, seen, creation.id);
    }
    let physicalId = this.#ctx.resolveId(id);
    if (physicalId === undefined) throw new Error(`Smart campaign ${id} is still pending creation.`);
    let campaign = await (await this.#ctx.client()).getSmartCampaign(physicalId);
    if (!campaign) throw notFound("smart campaign", id);
    if (campaign.id !== physicalId || !Number.isSafeInteger(campaign.smartListId) || campaign.smartListId! <= 0) {
      throw new MarketoError(`Marketo returned invalid smart-list identity for campaign ${physicalId}.`);
    }
    let smartList = await (await this.#ctx.client()).getCampaignSmartList(
      physicalId,
      campaign.smartListId,
    );
    if (!smartList) throw notFound("smart list for campaign", id);
    if (!Number.isSafeInteger(smartList.id) || smartList.id! <= 0 || smartList.id !== campaign.smartListId) {
      throw new MarketoError(`Marketo returned the wrong smart list for campaign ${physicalId}.`);
    }
    return {
      filterMatchType: smartList.rules?.filterMatchType,
      triggers: smartList.rules?.triggers?.map(normalizeSmartListRule) ?? [],
      filters: smartList.rules?.filters?.map(normalizeSmartListRule) ?? [],
    };
  }

  async updateMetadata(patch: { name?: string; description?: string }): Promise<void> {
    if (!patch || typeof patch !== "object") throw new Error("A metadata patch is required.");
    let name = patch.name === undefined ? undefined : requireText(patch.name, "Campaign name", 255);
    let description = patch.description === undefined
      ? undefined
      : requireText(patch.description, "Campaign description", 2_000, true);
    if (name === undefined && description === undefined) throw new Error("Set name or description.");
    let summary = await this.describe();
    await this.#ctx.submitCampaign({
      type: "campaignMetadata",
      targetId: this.#campaignId,
      campaignName: summary.name,
      patch: { name, description },
    });
  }

  async activate(): Promise<void> {
    let summary = await this.describe();
    if (summary.type?.toLowerCase() !== "trigger") {
      throw new Error(`Smart campaign "${summary.name}" is not a trigger campaign, so it cannot be activated.`);
    }
    if (summary.active) throw new Error(`Smart campaign "${summary.name}" is already active.`);
    if ((await this.readSmartListRules()).triggers.length === 0) {
      throw new Error(`Smart campaign "${summary.name}" has no trigger, so it cannot be activated.`);
    }
    await this.#ctx.submitCampaign({
      type: "campaignLifecycle",
      targetId: this.#campaignId,
      campaignName: summary.name,
      campaignType: summary.type,
      operation: "activate",
    });
  }

  async deactivate(): Promise<void> {
    let summary = await this.describe();
    if (summary.type?.toLowerCase() !== "trigger") {
      throw new Error(`Smart campaign "${summary.name}" is not a trigger campaign, so it cannot be deactivated.`);
    }
    if (!summary.active) throw new Error(`Smart campaign "${summary.name}" is already inactive.`);
    await this.#ctx.submitCampaign({
      type: "campaignLifecycle",
      targetId: this.#campaignId,
      campaignName: summary.name,
      campaignType: summary.type,
      operation: "deactivate",
    });
  }

  async delete(): Promise<void> {
    let summary = await this.describe();
    await this.#ctx.submitCampaign({
      type: "campaignLifecycle",
      targetId: this.#campaignId,
      campaignName: summary.name,
      campaignType: summary.type,
      operation: "delete",
    });
  }

  async requestCampaign(
    personIds: number[],
    tokens?: { name: string; value: string }[],
  ): Promise<void> {
    requireIds(personIds);
    requireTokens(tokens);
    if (personIds.length > MAX_CAMPAIGN_INPUTS) {
      throw new Error(`Marketo campaign requests accept at most ${MAX_CAMPAIGN_INPUTS} people.`);
    }
    this.#rejectPendingDeletion();
    let campaign = await this.#campaign();
    let summary = normalizeCampaign(campaign, this.#campaignId);
    if (campaign.isTriggerable !== true) {
      throw new Error(
        `Smart campaign "${summary.name}" (${summary.id}) is not configured with a ` +
          `"Campaign is Requested" Web Service API trigger.`,
      );
    }
    this.#rejectPendingDeletion();
    await this.#ctx.submit({
      type: "campaignTrigger",
      campaignId: requireResolvedCampaignId(this.#ctx, this.#campaignId),
      campaignName: summary.name,
      personIds,
      tokens,
    });
  }

  async schedule(runAt: Date, tokens?: { name: string; value: string }[]): Promise<void> {
    if (!(runAt instanceof Date) || Number.isNaN(runAt.getTime())) {
      throw new Error("A valid run time is required to schedule a campaign.");
    }
    requireTokens(tokens);
    let delay = runAt.getTime() - Date.now();
    if (delay < MIN_SCHEDULE_DELAY_MS || delay > MAX_SCHEDULE_DELAY_MS) {
      throw new Error("Marketo campaign schedules must be between 5 minutes and 2 years from now.");
    }
    this.#rejectPendingDeletion();
    let campaign = await this.#campaign();
    let summary = normalizeCampaign(campaign, this.#campaignId);
    if (campaign.type?.toLowerCase() !== "batch") {
      throw new Error(
        `Smart campaign "${summary.name}" (${summary.id}) is not a batch campaign, so it cannot ` +
          `be scheduled.`,
      );
    }
    this.#rejectPendingDeletion();
    await this.#ctx.submit({
      type: "campaignSchedule",
      campaignId: requireResolvedCampaignId(this.#ctx, this.#campaignId),
      campaignName: summary.name,
      runAt: runAt.toISOString(),
      tokens,
    });
  }
}

// ---------------------------------------------------------------------------
// Custom object

@validateRpc()
export class MarketoCustomObjectImpl extends RpcTarget {
  #ctx: SessionContext;
  #apiName: string;
  #ownsContext: boolean;
  #disposed = false;

  constructor(ctx: SessionContext, apiName: string, ownsContext = false) {
    super();
    this.#ctx = ctx;
    this.#apiName = apiName;
    this.#ownsContext = ownsContext;
  }

  [Symbol.dispose](): void {
    if (this.#ownsContext && !this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

  async describe(): Promise<MarketoCustomObjectSchema> {
    let schema = await (await this.#ctx.client()).describeCustomObject(this.#apiName);
    if (!schema) throw notFound("custom object", `"${this.#apiName}"`);
    await this.#ctx.observe(
      `Read schema of Marketo custom object \`${this.#apiName}\``,
      `Read the field schema of custom object \`${this.#apiName}\`.`,
    );
    let searchableFieldGroups = schema.searchableFields ?? [];
    let searchableFields = [...new Set(searchableFieldGroups.flatMap(group =>
      group.length === 1 ? group : []))];
    let searchable = new Set(searchableFields);
    return {
      apiName: schema.name ?? this.#apiName,
      displayName: schema.displayName ?? this.#apiName,
      description: schema.description,
      dedupeFields: schema.dedupeFields,
      fields: (schema.fields ?? [])
        .map(field => normalizeCustomObjectField(field, searchable))
        .filter((field): field is MarketoFieldMetadata => field !== undefined),
      searchableFields,
      searchableFieldGroups,
    };
  }

  async query(
    field: string,
    values: string[],
    fields?: string[],
  ): Promise<Record<string, unknown>[]> {
    if (!field) throw new Error("A filter field is required.");
    if (!values?.length) throw new Error("At least one filter value is required.");
    requireFilterValueCount(values, "filter");
    let records = await (await this.#ctx.client()).queryCustomObject(
      this.#apiName,
      field,
      values,
      fields,
    );
    let requested = new Set(values.map(String));
    if (records.some(record => !isRequestedFilterValue(record[field], requested))) {
      throw new MarketoError("Marketo returned a custom-object record outside the requested filter.");
    }
    await this.#ctx.observe(
      `Read ${records.length} \`${this.#apiName}\` record(s)`,
      `Queried custom object \`${this.#apiName}\` where \`${field}\` matches ` +
        `${values.length} value(s); **${records.length}** record(s) returned.`,
    );
    return records;
  }

  async queryByDedupeKeys(
    keys: Record<string, unknown>[],
    fields?: string[],
  ): Promise<Record<string, unknown>[]> {
    requireRecords(keys);
    let client = await this.#ctx.client();
    let schema = await client.describeCustomObject(this.#apiName);
    if (!schema) throw notFound("custom object", `"${this.#apiName}"`);
    let dedupeFields = schema.dedupeFields ?? [];
    let isSearchable = dedupeFields.length > 1 && (schema.searchableFields ?? []).some(group =>
      group.length === dedupeFields.length && group.every((field, index) => field === dedupeFields[index]));
    if (!isSearchable) {
      throw new Error("This custom object does not expose a searchable compound dedupe key.");
    }
    let seen = new Set<string>();
    let input = keys.map((key, index) => {
      let values = dedupeFields.map(field => {
        let value = key[field];
        if (value === undefined || value === null || value === "") {
          throw new Error(`Dedupe key ${index + 1} requires non-null field \`${field}\`.`);
        }
        return value;
      });
      let signature = JSON.stringify(values);
      if (seen.has(signature)) throw new Error(`Duplicate dedupe key at entry ${index + 1}.`);
      seen.add(signature);
      return Object.fromEntries(dedupeFields.map((field, fieldIndex) => [field, values[fieldIndex]]));
    });
    let records = await client.queryCustomObjectByDedupeKeys(
      this.#apiName,
      input,
      fields,
    );
    if (records.some(record => !input.some(key => dedupeFields.every(field =>
      sameFilterValue(record[field], key[field]))))) {
      throw new MarketoError("Marketo returned a custom-object record outside the requested dedupe keys.");
    }
    await this.#ctx.observe(
      `Read ${records.length} \`${this.#apiName}\` record(s)`,
      `Queried custom object \`${this.#apiName}\` by ${keys.length} compound dedupe key(s); ` +
        `**${records.length}** record(s) returned.`,
    );
    return records;
  }

  async createOrUpdate(records: Record<string, unknown>[]): Promise<void> {
    requireRecords(records);
    await this.#ctx.submit({ type: "customObjectUpsert", apiName: this.#apiName, records });
  }

  async delete(records: Record<string, unknown>[]): Promise<void> {
    requireRecords(records);
    let guidRecords = records.filter(record => Object.hasOwn(record, "marketoGUID"));
    if (guidRecords.length > 0 && guidRecords.length !== records.length) {
      throw new Error("Delete custom objects entirely by marketoGUID or entirely by dedupe fields.");
    }
    let deleteBy: "idField" | "dedupeFields" =
      guidRecords.length === records.length ? "idField" : "dedupeFields";
    if (deleteBy === "idField") {
      records = records.map(record => {
        if (typeof record.marketoGUID !== "string" || !record.marketoGUID.trim()) {
          throw new Error("Each marketoGUID must be a non-empty string.");
        }
        return { marketoGUID: record.marketoGUID };
      });
    }
    await this.#ctx.submit({ type: "customObjectDelete", apiName: this.#apiName, records, deleteBy });
  }
}

function sameFilterValue(actual: unknown, requested: unknown): boolean {
  if (actual === requested) return true;
  let scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return scalar(actual) && scalar(requested) && String(actual) === String(requested);
}

function isRequestedFilterValue(actual: unknown, requested: Set<string>): boolean {
  return (typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean") &&
    requested.has(String(actual));
}

function requireRecords(records: Record<string, unknown>[]): void {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Expected a non-empty array of records.");
  }
  if (records.length > MAX_FILTER_VALUES) {
    throw new Error(`Marketo accepts at most ${MAX_FILTER_VALUES} records per call.`);
  }
  for (let record of records) requireRecord(record, "record");
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
}

function requireTokens(tokens: { name: string; value: string }[] | undefined): void {
  if (tokens === undefined) return;
  if (!Array.isArray(tokens)) throw new Error("Campaign tokens must be an array.");
  if (tokens.length > MAX_CAMPAIGN_INPUTS) {
    throw new Error(`Marketo campaigns accept at most ${MAX_CAMPAIGN_INPUTS} token overrides.`);
  }
  for (let token of tokens) {
    if (!token || typeof token.name !== "string" || token.name !== token.name.trim() ||
        !token.name.startsWith("{{my.") || !token.name.endsWith("}}")) {
      throw new Error("Each campaign token name must use the {{my.*}} form.");
    }
    let name = token.name.slice(5, -2);
    if (!name || name !== name.trim() || [...name].some(character => {
      let code = character.codePointAt(0)!;
      return character === "{" || character === "}" || code <= 0x1f ||
        code >= 0x7f && code <= 0x9f || code === 0x2028 || code === 0x2029;
    })) {
      throw new Error("Each campaign token name must contain a non-whitespace single-line name.");
    }
    if (typeof token.value !== "string") {
      throw new Error(`Campaign token "${token.name}" requires a string value.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Whole-instance session

@validateRpc()
export class MarketoSessionImpl extends RpcTarget {
  #ctx: WholeInstanceContext;
  #disposed = false;

  constructor(ctx: SessionContext | CampaignContext | WholeInstanceContext) {
    super();
    this.#ctx = managementContext(ctx);
  }

  getBusinessObject(kind: MarketoBusinessObjectKind): MarketoBusinessObjectImpl {
    if (!["company", "opportunity", "opportunityRole", "salesPerson", "namedAccount"].includes(kind)) {
      throw new Error(`Unsupported Marketo business object: ${String(kind)}.`);
    }
    return new MarketoBusinessObjectImpl(retainSessionContext(this.#ctx), kind, true);
  }

  [Symbol.dispose](): void {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#ctx.dispose();
    }
  }

  async describePersonFields(): Promise<MarketoFieldMetadata[]> {
    // Which fields may be filtered on is a separate call: leads/describe.json never reports it.
    let client = await this.#ctx.client();
    let [raw, searchable] = await Promise.all([
      client.describeLeadFields(),
      client.getSearchablePersonFields(),
    ]);
    let fields = raw
      .map(field => normalizePersonField(field, searchable))
      .filter((field): field is MarketoFieldMetadata => field !== undefined);
    await this.#ctx.observe(
      `Read Marketo person field schema (${fields.length} fields)`,
      `Read metadata for **${fields.length}** person field(s). No person data was read.`,
    );
    return fields;
  }

  getPerson(lookup: MarketoPersonLookup): MarketoPersonImpl {
    if (!lookup?.field || lookup.value === undefined || lookup.value === null) {
      throw new Error("A lookup { field, value } is required.");
    }
    let validatedLookup = { field: lookup.field, value: String(lookup.value) };
    return new MarketoPersonImpl(
      retainSessionContext(this.#ctx),
      validatedLookup,
      true,
    );
  }

  async findPeople(
    field: string,
    values: string[],
    fields?: string[],
  ): Promise<MarketoPersonRecord[]> {
    if (!field) throw new Error("A search field is required.");
    if (!values?.length) throw new Error("At least one search value is required.");
    requireFilterValueCount(values, "search");
    let requested = fields?.length ? [...new Set(["id", ...fields])] : DEFAULT_PERSON_FIELDS;
    let leads = await (await this.#ctx.client()).getLeads(field, values, requested);
    await this.#ctx.observe(
      `Found ${leads.length} Marketo people by ${field}`,
      `Searched people where \`${field}\` matches ${values.length} value(s); ` +
        `**${leads.length}** record(s) returned with fields \`${requested.join("`, `")}\`.`,
    );
    return leads.map(lead => normalizeLead(lead, requested));
  }

  async createOrUpdatePeople(
    records: MarketoPersonInput[],
    options?: { action?: MarketoUpsertAction; lookupField?: string },
  ): Promise<void> {
    requireRecords(records);
    let upsertAction = options?.action ?? "createOrUpdate";
    if (!["createOrUpdate", "updateOnly", "createOnly"].includes(upsertAction)) {
      throw new Error(`Unsupported Marketo upsert action: ${String(upsertAction)}.`);
    }
    let lookupField = options?.lookupField?.trim() || "email";
    await this.#ctx.submit({ type: "upsertPeople", records, upsertAction, lookupField });
  }

  async listStaticLists(filter: MarketoNameFilter = {}): Promise<{
    lists: MarketoStaticListSummary[];
    moreResult: boolean;
    nextPageToken?: string;
  }> {
    let page = await (await this.#ctx.client()).getLists(filter);
    await this.#ctx.observe(
      `Listed ${page.result.length} Marketo static lists${describeNameFilter(filter)}`,
      `Read the names and ids of **${page.result.length}** static list(s)${describeNameFilter(filter)}.`,
    );
    return pageOf("lists", page, page.result.map(list => normalizeList(list)));
  }

  getStaticList(id: number): MarketoStaticListImpl {
    let validatedId = requireId(id, "list");
    return new MarketoStaticListImpl(retainSessionContext(this.#ctx), validatedId, true);
  }

  async findProgramsByName(name: string): Promise<MarketoProgramSummary[]> {
    if (!name?.trim()) throw new Error("A program name is required.");
    let searchedName = name.trim();
    let actions = this.#ctx.pendingProgram();
    let programs = await (await this.#ctx.client()).getProgramsByName(searchedName);
    if (programs.length >= ASSET_PAGE_MAX) {
      // A full page means Marketo had more to give. Returning it would look like a complete
      // answer to a method whose whole purpose is disambiguating between same-named programs,
      // and the one the caller wants could be the one cut off.
      throw new Error(
        `"${name}" matches at least ${ASSET_PAGE_MAX} Marketo programs, more than can be ` +
          `listed in one request. Use getProgram(id) if you know the id, or a more specific name.`,
      );
    }
    let candidateIds = managedCandidateIds(actions);
    let deleted = (id: string) => actions.some(action =>
      action.type === "programLifecycle" && action.operation === "delete" &&
      sameManagedId(this.#ctx, action.targetId, id)
    );
    let candidates = (await Promise.all(candidateIds.map(async id => {
      if (deleted(id)) return null;
      return await new MarketoProgramImpl(this.#ctx, id).describe();
    }))).filter((program): program is MarketoProgramSummary =>
      program !== null && isProgramName(program, searchedName));
    let identity = (id: string | number) => String(this.#ctx.resolveId(String(id)) ?? id);
    let seen = new Set(candidates.map(program => identity(program.id)));
    let merged = [...candidates];
    for (let raw of programs) {
      let summary = overlayProgram(this.#ctx, normalizeProgram(raw), actions);
      if (!summary || !isProgramName(summary, searchedName) || seen.has(identity(summary.id))) continue;
      seen.add(identity(summary.id));
      merged.push(summary);
    }
    await this.#ctx.observe(
      `Looked up Marketo programs named "${name}"`,
      `Looked up programs named \`${name}\`: **${merged.length}** match(es).`,
    );
    return merged;
  }

  getProgram(id: MarketoProgramId): MarketoProgramImpl {
    let validatedId = requireLogicalId(String(id), "program");
    return new MarketoProgramImpl(
      retainSessionContext(this.#ctx),
      validatedId,
      true,
    );
  }

  async getChannels(): Promise<MarketoProgramChannel[]> {
    let channels = await (await this.#ctx.client()).getChannels();
    let result = channels.flatMap(channel => channel.name ? [{
      name: channel.name,
      programType: channel.applicableProgramType,
      statuses: channel.progressionStatuses?.flatMap(status => status.name ? [status.name] : []) ?? [],
    }] : []);
    await this.#ctx.observe("List Marketo program channels", `Read ${result.length} program channel(s).`);
    return result;
  }

  async getTagTypes(): Promise<MarketoProgramTagType[]> {
    let definitions: RawTagType[] = await (await this.#ctx.client()).getTagTypes();
    let result = definitions.flatMap(tag => tag.tagType ? [{
      name: tag.tagType,
      applicableProgramTypes: parseTagList(tag.applicableProgramTypes).map(programTypeName),
      required: tag.required === true,
      values: parseTagList(tag.allowableValues),
    }] : []);
    await this.#ctx.observe("List Marketo program tag types", `Read ${result.length} program tag type(s).`);
    return result;
  }

  async createProgram(
    destination: MarketoAssetFolderRef,
    input: MarketoCreateProgramInput,
  ): Promise<MarketoProgramImpl> {
    let parentId = requireProgramFolder(this.#ctx, destination);
    requireOnlyKeys(input, "Program create input", [
      "name", "type", "channel", "description", "tags", "startDate", "endDate",
    ]);
    let name = requireText(input.name, "Program name", 255);
    let type = requireText(input.type, "Program type", 100);
    let channel = requireText(input.channel, "Program channel", 100);
    let description = input.description === undefined
      ? undefined
      : requireText(input.description, "Program description", 2_000, true);
    let channels = await this.getChannels();
    let selected = channels.find(candidate => candidate.name === channel);
    if (!selected) throw new Error(`Unknown Marketo program channel: ${channel}.`);
    if (selected.programType && selected.programType !== type) {
      throw new Error(`Channel "${channel}" applies to ${selected.programType} programs, not ${type}.`);
    }
    let tags = await validateProgramTags(this.#ctx, type, input.tags ?? []);
    let dates = input.startDate === undefined && input.endDate === undefined
      ? {}
      : requireProgramDates(input.startDate, input.endDate);
    if (type !== "Email" && (input.startDate !== undefined || input.endDate !== undefined)) {
      throw new Error("Only Email Programs have start and end dates.");
    }
    let provisionalId = this.#ctx.allocateProvisional();
    await this.#ctx.submitProgram({
      type: "programCreate",
      provisionalId,
      parentId,
      input: { name, type, channel, description, tags, ...dates },
    });
    return new MarketoProgramImpl(retainSessionContext(this.#ctx), provisionalId, true);
  }

  async cloneProgram(
    sourceId: MarketoProgramId,
    destination: MarketoAssetFolderRef,
    input: MarketoCloneProgramInput,
  ): Promise<MarketoProgramImpl> {
    let source = requireLogicalId(String(sourceId), "program");
    let parentId = requireProgramFolder(this.#ctx, destination);
    requireOnlyKeys(input, "Program clone input", ["name", "description"]);
    let name = requireText(input.name, "Program name", 255);
    let description = input.description === undefined
      ? undefined
      : requireText(input.description, "Program description", 2_000, true);
    await new MarketoProgramImpl(this.#ctx, source).describe();
    let provisionalId = this.#ctx.allocateProvisional();
    await this.#ctx.submitProgram({
      type: "programClone", provisionalId, sourceId: source, parentId, name, description,
    });
    return new MarketoProgramImpl(retainSessionContext(this.#ctx), provisionalId, true);
  }

  async listSmartCampaigns(filter: MarketoNameFilter & { requestableOnly?: boolean } = {}): Promise<{
    campaigns: MarketoSmartCampaignSummary[];
    moreResult: boolean;
    nextPageToken?: string;
  }> {
    let allActions = this.#ctx.pendingCampaign();
    let state = campaignPageState(filter, allActions);
    let actions = allActions.filter(action => state.actionIds.includes(action.id));
    let listingCtx: CampaignContext = { ...this.#ctx, pendingCampaign: () => actions };
    let { pageToken: _pageToken, ...requestedFilter } = filter;
    let page = await (await this.#ctx.client()).getCampaigns({
      ...requestedFilter,
      ...(state.upstreamToken === undefined ? {} : { pageToken: state.upstreamToken }),
    });
    let deleted = (id: string) => actions.some(action =>
      action.type === "campaignLifecycle" && action.operation === "delete" &&
      sameManagedId(listingCtx, action.targetId, id)
    );
    let candidates = (await Promise.all(state.candidateIds.map(async id => {
      if (deleted(id)) return null;
      return await new MarketoSmartCampaignImpl(listingCtx, id).describe();
    }))).filter((campaign): campaign is MarketoSmartCampaignSummary =>
      campaign !== null && isCampaignMatch(campaign, filter));
    let identity = (id: string | number) => String(listingCtx.resolveId(String(id)) ?? id);
    let masked = new Set(state.maskedIds.map(identity));
    let upstream = page.result.flatMap(raw => {
      let summary = overlayCampaign(listingCtx, normalizeCampaign(raw), actions);
      return summary && isCampaignMatch(summary, filter) && !masked.has(identity(summary.id)) ? [summary] : [];
    });
    let campaigns = [...candidates];
    let available = upstream.slice(state.skip);
    let taken = available.slice(0, CAMPAIGN_PAGE_SIZE - campaigns.length);
    campaigns.push(...taken);
    let skip = state.skip + taken.length;
    let upstreamToken = state.upstreamToken;
    if (skip >= upstream.length && page.moreResult) {
      upstreamToken = page.nextPageToken;
      skip = 0;
    }
    let hasMore = skip < upstream.length || page.moreResult;
    let nextPageToken = hasMore
      ? campaignPageToken({ ...state, candidateIds: [], upstreamToken, skip })
      : undefined;
    let scope = describeNameFilter(filter) + (filter.requestableOnly ? ", requestable only" : "");
    await this.#ctx.observe(
      `Listed ${campaigns.length} Marketo smart campaigns${scope}`,
      `Read the names and ids of **${campaigns.length}** smart campaign(s)${scope}.`,
    );
    return { campaigns, moreResult: hasMore, nextPageToken };
  }

  getSmartCampaign(id: string | number): MarketoSmartCampaignImpl {
    let validatedId = requireLogicalId(String(id), "campaign");
    return new MarketoSmartCampaignImpl(
      retainSessionContext(this.#ctx),
      validatedId,
      true,
    );
  }

  async createSmartCampaign(
    destination: MarketoAssetFolderRef,
    input: { name: string; description?: string },
  ): Promise<MarketoSmartCampaignImpl> {
    let parent = requireAssetFolder(this.#ctx, destination);
    let name = requireText(input?.name, "Campaign name", 255);
    let description = input?.description === undefined
      ? undefined
      : requireText(input.description, "Campaign description", 2_000, true);
    let provisionalId = this.#ctx.allocateProvisional();
    await this.#ctx.submitCampaign({
      type: "campaignCreate",
      provisionalId,
      parent,
      name,
      description,
    });
    return new MarketoSmartCampaignImpl(retainSessionContext(this.#ctx), provisionalId, true);
  }

  async cloneSmartCampaign(
    sourceId: string | number,
    destination: MarketoAssetFolderRef,
    input: { name: string; description?: string },
  ): Promise<MarketoSmartCampaignImpl> {
    let source = requireLogicalId(String(sourceId), "campaign");
    let parent = requireAssetFolder(this.#ctx, destination);
    let name = requireText(input?.name, "Campaign name", 255);
    let description = input?.description === undefined
      ? undefined
      : requireText(input.description, "Campaign description", 2_000, true);
    await new MarketoSmartCampaignImpl(this.#ctx, source).describe();
    let provisionalId = this.#ctx.allocateProvisional();
    await this.#ctx.submitCampaign({
      type: "campaignClone",
      provisionalId,
      sourceId: source,
      parent,
      name,
      description,
    });
    return new MarketoSmartCampaignImpl(retainSessionContext(this.#ctx), provisionalId, true);
  }

  async getActivityTypes(): Promise<MarketoActivityType[]> {
    let types = await (await this.#ctx.client()).getActivityTypes();
    await this.#ctx.observe(
      `Listed ${types.length} Marketo activity types`,
      `Read metadata for **${types.length}** activity type(s).`,
    );
    return types.map(type => ({
      id: type.id ?? -1,
      name: type.name ?? "",
      description: type.description,
      attributes: type.attributes?.map(attr => ({
        name: attr.name ?? "",
        dataType: (attr.dataType ?? "string") as MarketoFieldMetadata["dataType"],
      })),
    }));
  }

  async getActivities(
    query: MarketoActivityQuery,
    pageToken?: string,
  ): Promise<MarketoActivityPage> {
    return await readActivities(this.#ctx, query, pageToken, undefined, "across the instance");
  }

  async listCustomObjects(): Promise<MarketoCustomObjectSummary[]> {
    let objects = await (await this.#ctx.client()).listCustomObjects();
    await this.#ctx.observe(
      `Listed ${objects.length} Marketo custom objects`,
      `Read the names of **${objects.length}** custom object type(s).`,
    );
    return objects.map(object => ({
      apiName: object.name ?? "",
      displayName: object.displayName ?? object.name ?? "",
      description: object.description,
      dedupeFields: object.dedupeFields,
    }));
  }

  getCustomObject(apiName: string): MarketoCustomObjectImpl {
    if (!apiName?.trim()) throw new Error("A custom object API name is required.");
    return new MarketoCustomObjectImpl(retainSessionContext(this.#ctx), apiName, true);
  }

  getDesignStudio(): MarketoDesignStudioImpl {
    return new MarketoDesignStudioImpl(retainSessionContext(this.#ctx), true);
  }

  async getApiUsage(): Promise<MarketoApiUsage> {
    let usage = await (await this.#ctx.client()).getUsage();
    let today = usage[0];
    await this.#ctx.observe(
      "Read Marketo API usage",
      `Read today's instance-wide API call totals (**${today?.total ?? 0}** calls).`,
    );
    return {
      date: today?.date ?? new Date().toISOString().slice(0, 10),
      total: today?.total ?? 0,
      users: today?.users
        ?.filter((u): u is typeof u & { userId: string } => Boolean(u.userId))
        .map(u => ({ userId: u.userId, count: u.count ?? 0 })),
    };
  }
}

function requireId(id: number, label: string): number {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`A positive numeric Marketo ${label} id is required.`);
  }
  return id;
}

function managementContext(ctx: SessionContext | CampaignContext | WholeInstanceContext): WholeInstanceContext {
  if ("submitCampaign" in ctx) {
    let business = ctx as Partial<BusinessObjectContext>;
    if (business.submitBusinessObject && business.getBusinessObjectAccess && business.setBusinessObjectAccess) {
      return ctx as WholeInstanceContext;
    }
    let campaign = ctx as CampaignContext;
    return {
      ...campaign,
      submitBusinessObject: async action => await campaign.submit(action),
      getBusinessObjectAccess: () => "read-write",
      setBusinessObjectAccess: () => {},
    };
  }
  return {
    ...ctx,
    allocateProvisional: () => { throw new Error("Asset management is unavailable in this session."); },
    pending: () => [],
    resolveId: id => /^[1-9]\d*$/.test(id) ? Number(id) : undefined,
    submitDesign: async () => { throw new Error("Design Studio is unavailable in this session."); },
    logicalKind: () => undefined,
    pendingCampaign: () => [],
    submitCampaign: async () => { throw new Error("Campaign management is unavailable in this session."); },
    pendingProgram: () => [],
    submitProgram: async () => { throw new Error("Program management is unavailable in this session."); },
    submitBusinessObject: async action => await ctx.submit(action),
    getBusinessObjectAccess: () => "read-write",
    setBusinessObjectAccess: () => {},
  };
}

function requireResolvedId(ctx: CampaignContext, id: string, label: string): number {
  let resolved = ctx.resolveId(id);
  if (resolved === undefined) throw new Error(`${label} ${id} is still pending creation.`);
  return resolved;
}

function requireOnlyKeys(
  value: unknown,
  label: string,
  allowed: readonly string[],
  immutable: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (let key of Object.keys(value)) {
    if (immutable.includes(key)) throw new Error(`Program ${key} is immutable.`);
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field: ${key}.`);
  }
}

function requireProgramDates(startDate: unknown, endDate: unknown): { startDate: string; endDate: string } {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime()) ||
      !(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    throw new Error("Program startDate and endDate must both be valid Dates.");
  }
  if (endDate.getTime() <= startDate.getTime()) throw new Error("Program endDate must be after startDate.");
  return { startDate: startDate.toISOString(), endDate: endDate.toISOString() };
}

async function validateProgramTags(
  ctx: CampaignContext,
  programType: string | undefined,
  value: unknown,
): Promise<{ tagType: string; tagValue: string }[]> {
  if (!Array.isArray(value)) throw new Error("Program tags must be an array.");
  let tags = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Program tag ${index + 1} must be an object.`);
    }
    let record = item as Record<string, unknown>;
    requireOnlyKeys(record, `Program tag ${index + 1}`, ["type", "value"]);
    return {
      tagType: requireText(record.type, `Program tag ${index + 1} type`, 255),
      tagValue: requireText(record.value, `Program tag ${index + 1} value`, 255),
    };
  });
  if (new Set(tags.map(tag => tag.tagType)).size !== tags.length) {
    throw new Error("A program tag type may be set only once.");
  }
  let definitions = await (await ctx.client()).getTagTypes();
  await ctx.observe("Read Marketo program tag definitions", `Read ${definitions.length} program tag definition(s) for validation.`);
  for (let tag of tags) {
    let definition = definitions.find(candidate => candidate.tagType === tag.tagType);
    if (!definition) throw new Error(`Unknown Marketo program tag type: ${tag.tagType}.`);
    let applicable = parseTagList(definition.applicableProgramTypes).map(programTypeName);
    if (programType && !applicable.includes(programType)) {
      throw new Error(`Program tag "${tag.tagType}" does not apply to ${programType} programs.`);
    }
    let allowable = parseTagList(definition.allowableValues);
    if (allowable.length && !allowable.includes(tag.tagValue)) {
      throw new Error(`"${tag.tagValue}" is not allowed for program tag "${tag.tagType}".`);
    }
  }
  let present = new Set(tags.map(tag => tag.tagType));
  let missing = definitions.find(definition => definition.tagType && definition.required &&
    parseTagList(definition.applicableProgramTypes).map(programTypeName).includes(programType ?? "") &&
    !present.has(definition.tagType));
  if (missing) throw new Error(`Required program tag is missing: ${missing.tagType}.`);
  return tags;
}

function parseTagList(value: string | undefined): string[] {
  if (value === undefined || value === "[]") return [];
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new MarketoError("Marketo returned malformed program tag metadata.");
  }
  return value.slice(1, -1).split(",").map(item => item.trim()).filter(Boolean);
}

function programTypeName(value: string): string {
  return ({
    program: "Default",
    email_batch: "Email",
    nurture: "Engagement",
    event: "Event",
    webinar: "EventWithWebinar",
  } as Record<string, string>)[value] ?? value;
}

function requireLogicalId(id: unknown, label: string): string {
  if (typeof id !== "string" || !/^([1-9]\d*|~[1-9]\d*)$/.test(id)) {
    throw new Error(`A numeric or provisional (~N) Marketo ${label} id is required.`);
  }
  return id;
}

function requireResolvedCampaignId(ctx: CampaignContext, id: string): number {
  return requireResolvedId(ctx, id, "Smart campaign");
}

function requireProgramFolder(ctx: CampaignContext, value: MarketoAssetFolderRef): string {
  if (!value || value.type !== "folder") throw new Error("Program destination must be an ordinary folder.");
  let id = requireLogicalId(value.id, "folder");
  if (id.startsWith("~") && ctx.logicalKind(id) !== "folder") {
    throw new Error(`Provisional Marketo asset ${id} is not an ordinary folder.`);
  }
  return id;
}

function requireAssetFolder(
  ctx: CampaignContext,
  value: MarketoAssetFolderRef,
): { id: string; type: "Folder" | "Program" } {
  if (!value || (value.type !== "folder" && value.type !== "program")) {
    throw new Error("A Marketo folder or program destination is required.");
  }
  let id = requireLogicalId(value.id, value.type);
  if (id.startsWith("~")) {
    let kind = ctx.logicalKind(id);
    if (kind !== value.type) {
      throw new Error(value.type === "folder"
        ? `Provisional Marketo asset ${id} is not an ordinary folder.`
        : `Provisional Marketo asset ${id} is not a program.`);
    }
  }
  return {
    id,
    type: value.type === "folder" ? "Folder" : "Program",
  };
}

function requireText(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  let trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters.`);
  return trimmed;
}

/**
 * The filter, rendered for the observation log so the user sees what was searched for rather than
 * a bare count. Substring searches say so, because their results can be incomplete.
 */
function describeNameFilter(filter: MarketoNameFilter): string {
  // Trimmed to match what was actually sent upstream.
  if (filter.name !== undefined) return ` named "${filter.name.trim()}"`;
  if (filter.nameContains !== undefined) {
    return ` whose name contains "${filter.nameContains.trim()}"`;
  }
  return "";
}

function escapeObservationText(value: string): string {
  let controls = new Set("\\`*_{}[]()#+.!|>~-");
  return [...value.replace(/[\r\n]+/g, " ")]
    .map(character => controls.has(character) ? `\\${character}` : character)
    .join("");
}

/** Build the plumbing shared by every object in one session. */
export function makeSessionContext(options: {
  client(): Promise<MarketoClient>;
  approvalQueue: RpcStub<ApprovalQueue>;
  submit(action: MarketoActionInput): Promise<void>;
}): SessionContext {
  let owners = 1;
  return {
    client: options.client,
    observe: async (title, description) => {
      await options.approvalQueue.authorizeObservation({
        title: escapeObservationText(title),
        description: escapeObservationText(description),
      });
    },
    submit: options.submit,
    retain: () => {
      if (owners === 0) throw new Error("Cannot retain a disposed Marketo session context.");
      owners++;
    },
    dispose: () => {
      if (owners === 0) throw new Error("Marketo session context was released too many times.");
      if (--owners === 0) options.approvalQueue[Symbol.dispose]();
    },
  };
}
