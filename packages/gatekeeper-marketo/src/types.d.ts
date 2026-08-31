// =============================================================================
// Marketo gatekeeper — capability API
//
// These types are the agent-facing documentation for the Marketo gatekeeper. They
// describe a capability-based, object-oriented view of a Marketo instance: the root
// `MarketoSession` hands out narrow handles (`MarketoPerson`, `MarketoStaticList`,
// `MarketoProgram`, `MarketoSmartCampaign`, `MarketoCustomObject`) rather than taking
// resource IDs on every call, so authority can be limited by limiting which handles a
// caller can reach.
//
// PAGING. For results containing both `moreResult` and `nextPageToken`, continue while
// `moreResult` is true and pass `nextPageToken` back as `pageToken`. A page may be empty
// while `moreResult` is still true (see MarketoActivityPage).
// =============================================================================

// -----------------------------------------------------------------------------
// People — field metadata & records
// -----------------------------------------------------------------------------

/** Marketo data type of a person/custom-object field, as reported by describe. */
export type MarketoFieldDataType =
  | "string"
  | "text"
  | "boolean"
  | "integer"
  | "float"
  | "currency"
  | "date"
  | "datetime"
  | "email"
  | "phone"
  | "url"
  | "reference"
  | "score"
  | "formula"
  | (string & {});

/** Metadata describing a single person field. Marketo instances routinely have
 * thousands of fields, so use this to discover the field name to request or
 * write, rather than guessing. */
export type MarketoFieldMetadata = {
  /** Field name used in `fields`, filters, and record writes
   * (e.g. `email`, `firstName`, `industry`). */
  name: string;
  /** Human-readable label shown in the Marketo UI (e.g. "Industry"). */
  displayName: string;
  /** Field value type. */
  dataType: MarketoFieldDataType;
  /** Maximum length for string-like fields, when reported. */
  length?: number;
  /** True if the field cannot be written. */
  readOnly: boolean;
  /** True if this field may be used as a lookup/dedupe key in `getPerson` /
   * `findPeople` / upsert `lookupField`. */
  searchable: boolean;
};

/** A person record. Only the fields explicitly requested (plus `id`) are present;
 * absent keys were not requested, not that the value is empty. */
export type MarketoPersonRecord = {
  /** Marketo person (lead) id — the stable numeric identifier. */
  id: number;
  /** Requested fields, keyed by field name. */
  [field: string]: unknown;
};

/** A person's progression through one program, reported alongside each program member. */
export type MarketoProgramMembership = {
  /** Progression status, one of the program channel's statuses (e.g. `Member`, `Sent`, `Engaged`). */
  status?: string;
  /** The status's type. Matches `status` for most channels. */
  statusType?: string;
  /** Whether the person reached the program's success step. */
  reachedSuccess?: boolean;
  /** Whether this program is credited with acquiring the person. */
  acquiredBy?: boolean;
  /** Whether the person exhausted the program's content (engagement programs). */
  isExhausted?: boolean;
  /** When the person became a member of the program. */
  membershipDate?: Date;
  /** When the membership last changed. */
  updatedAt?: Date;
};

/** Identifies a person by a searchable field value. Use `describePersonFields()`
 * to find which fields are `searchable`. `email` and `id` are always usable. */
export type MarketoPersonLookup = {
  /** Searchable field name to match on (e.g. `email`, `id`, or a dedupe field). */
  field: string;
  /** Value to match. */
  value: string;
};

/** Controls how an upsert reconciles each incoming record against existing people. */
export type MarketoUpsertAction =
  /** Update the matched person; create if none matches. (Default.) */
  | "createOrUpdate"
  /** Only update matched people; skip records with no match. */
  | "updateOnly"
  /** Only create; skip records that already match an existing person. */
  | "createOnly";

/** One incoming record for an upsert. Keys are Marketo field names; include the
 * `lookupField` value so Marketo can match an existing person. */
export type MarketoPersonInput = {
  [field: string]: unknown;
};

// -----------------------------------------------------------------------------
// Lists, programs, campaigns
// -----------------------------------------------------------------------------

/**
 * How to narrow `listSmartCampaigns` or `listStaticLists`. Pass `name` or `nameContains`, never
 * both.
 *
 * Prefer `name` when the full name is known. `nameContains` cannot see campaigns or lists that
 * belong to no program, so an empty result does not prove that nothing matches.
 *
 * For campaigns the substring is also matched against the *program's* name, so a hit need not
 * contain the term in its own name. `%` and `_` are not supported in substring filters.
 *
 * Programs support neither form — see {@link MarketoSession.findProgramsByName}.
 */
export type MarketoNameFilter = {
  /** Exact name, matched case-insensitively. */
  name?: string;
  /** Substring of the name. Cannot see records that belong to no program. */
  nameContains?: string;
  /** Continuation token from a previous page. */
  pageToken?: string;
};

/** Summary of a Marketo static list. */
export type MarketoStaticListSummary = {
  id: number;
  name: string;
  /** Program the list belongs to, if any. */
  programName?: string;
  /** Workspace the list lives in. */
  workspaceName?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

/** Summary of a Marketo program. */
export type MarketoProgramSummary = {
  /** Numeric Marketo id, or an opaque provisional id while creation is pending. */
  id: MarketoProgramId;
  /** Program name shown in Marketing Activities. */
  name: string;
  /** Optional program description. */
  description?: string;
  /** Program type, e.g. "Default", "Event", "Email", "Nurture". */
  type?: string;
  /** Channel configured on the program. */
  channel?: string;
  /** Program lifecycle status, including `unlocked` for an editable Email Program. */
  status?: string;
  /** Configured program tags. */
  tags?: MarketoProgramTag[];
  /** Scheduled Email Program start, when configured. */
  startDate?: Date;
  /** Scheduled Email Program end, when configured. */
  endDate?: Date;
  /** Workspace containing the program. */
  workspaceName?: string;
  /** Containing folder. Program names are not unique, so this is usually what
   * distinguishes several programs returned for the same name. */
  folderName?: string;
  /** Program-level statuses available for membership progression, in order. */
  statuses?: string[];
  /** When Marketo created the program. */
  createdAt?: Date;
  /** When Marketo last changed the program. */
  updatedAt?: Date;
};

/** A numeric Marketo program id or an opaque provisional id returned by create or clone. */
export type MarketoProgramId = number | MarketoAssetId;

/** A selected value for one configured Marketo program tag type. */
export type MarketoProgramTag = {
  /** Tag type name as returned by {@link MarketoSession.getTagTypes}. */
  type: string;
  /** Allowed value selected for the tag type. */
  value: string;
};

/** A channel available when creating programs. */
export type MarketoProgramChannel = {
  /** Channel name to pass to {@link MarketoSession.createProgram}. */
  name: string;
  /** Program type to which this channel applies. */
  programType?: string;
  /** Ordered member progression statuses configured on the channel. */
  statuses: string[];
};

/** One configured program tag definition. */
export type MarketoProgramTagType = {
  /** Tag type name. */
  name: string;
  /** Program types to which this tag applies. */
  applicableProgramTypes: string[];
  /** Whether Marketo requires the tag on applicable programs. */
  required: boolean;
  /** Values the instance permits for this tag. */
  values: string[];
};

/** Values accepted when creating a program. */
export type MarketoCreateProgramInput = {
  /** Globally unique program name, at most 255 characters. */
  name: string;
  /** Marketo program type, such as `Default`, `Event`, `EventWithWebinar`, `Engagement`, or `Email`. */
  type: string;
  /** Applicable channel name discovered through {@link MarketoSession.getChannels}. */
  channel: string;
  /** Optional program description. */
  description?: string;
  /** Program tags. Include all required tags and use values permitted by their definitions. */
  tags?: MarketoProgramTag[];
  /** Email Program start date. Must be supplied together with `endDate`. */
  startDate?: Date;
  /** Email Program end date. Must be supplied together with `startDate` and be later. */
  endDate?: Date;
};

/** Values accepted when cloning a program. */
export type MarketoCloneProgramInput = {
  /** Globally unique name for the clone, at most 255 characters. */
  name: string;
  /** Optional replacement description; omitted to retain the source description. */
  description?: string;
};

/** A program "My Token" (`{{my.*}}`) usable when triggering/scheduling campaigns. */
export type MarketoToken = {
  /** Fully-qualified token name, e.g. `{{my.Event Date}}` — the form the campaign
   * methods expect, so a token read here can be passed straight back to them. */
  name: string;
  /** Token type, e.g. `text`, `date`, `number`, `rich text`. */
  type: string;
  /** Current token value. */
  value: string;
};

/** A numeric Marketo smart-campaign id or an opaque provisional id returned by create or clone. */
export type MarketoSmartCampaignId = number | MarketoAssetId;

/** Summary of a Marketo smart campaign. */
export type MarketoSmartCampaignSummary = {
  /** Numeric Marketo id, or a provisional string for a newly-created or cloned campaign. */
  id: MarketoSmartCampaignId;
  name: string;
  description?: string;
  /** Marketo campaign kind, normally `batch` or `trigger`. */
  type?: string;
  /** Marketo lifecycle status, such as `Inactive` or `Never Run`. */
  status?: string;
  /** Program the campaign belongs to, if any. */
  programName?: string;
  /** Folder or program containing this campaign. */
  folder?: MarketoAssetFolderRef;
  workspaceName?: string;
  /** True if the campaign is currently active. */
  active?: boolean;
  /** True if the campaign has a "Campaign is Requested" trigger, i.e. it can be
   * invoked via `requestCampaign()`. */
  requestable?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

/** A condition nested inside a Marketo smart-list filter or trigger. */
export type MarketoSmartListCondition = {
  name?: string;
  operator?: string;
  values?: unknown[];
  primary?: boolean;
};

/** One filter or trigger in a campaign's smart-list definition. */
export type MarketoSmartListRule = {
  id?: number;
  name: string;
  type?: string;
  operator?: string;
  conditions?: MarketoSmartListCondition[];
};

/** Read-only smart-list rules that select who enters a smart campaign. */
export type MarketoSmartListRules = {
  /** Whether all, any, or custom filter logic must match. */
  filterMatchType?: string;
  triggers: MarketoSmartListRule[];
  filters: MarketoSmartListRule[];
};

/** Values accepted when creating an empty smart campaign. */
export type MarketoCreateSmartCampaignInput = {
  name: string;
  description?: string;
};

/** Values accepted when cloning a configured smart campaign. */
export type MarketoCloneSmartCampaignInput = {
  name: string;
  description?: string;
};

// -----------------------------------------------------------------------------
// Activities
// -----------------------------------------------------------------------------

/** Metadata for a Marketo activity type (e.g. "Fill Out Form", "Click Email"). */
export type MarketoActivityType = {
  id: number;
  name: string;
  description?: string;
  /** Descriptions of the attributes each activity of this type carries. */
  attributes?: { name: string; dataType: MarketoFieldDataType }[];
};

/** A single recorded activity for a person. */
export type MarketoActivity = {
  /** Valid non-empty Marketo GUID when provided, otherwise the positive numeric activity id. */
  id: number | string;
  /** Activity type id — resolve via `getActivityTypes()`. */
  activityTypeId: number;
  /** Person the activity belongs to. */
  personId: number;
  /** When the activity occurred. */
  date: Date;
  /** The primary attribute value for the activity type (e.g. the form name). */
  primaryAttributeValue?: string;
  /** Additional typed attributes recorded with the activity. */
  attributes?: Record<string, unknown>;
};

/** Filter for reading activities. Marketo requires both a start time and an explicit set of
 * activity types — there is no "all activities" query. */
export type MarketoActivityQuery = {
  /** Return activities at or after this instant. Required by Marketo. */
  sinceDate: Date;
  /**
   * Activity types to read, from `getActivityTypes()`. Required, and Marketo rejects more than
   * **10** per query — pick the types you actually need rather than querying broadly.
   */
  activityTypeIds: number[];
  /** Max activities to return in this page (Marketo caps page size). */
  maxResults?: number;
};

/**
 * One page of activities. Pass `nextPageToken` back as `pageToken` to continue.
 *
 * A page can contain no matching activities while `moreResult` is still true. Keep following
 * `nextPageToken` while `moreResult` is true; stopping at the first empty page can miss data.
 */
export type MarketoActivityPage = {
  activities: MarketoActivity[];
  /** True if more of the activity stream remains, not necessarily that more matches exist. */
  moreResult: boolean;
  /** Opaque token for the next page, when `moreResult` is true. */
  nextPageToken?: string;
};

// -----------------------------------------------------------------------------
// Standard and custom business objects
// -----------------------------------------------------------------------------

/** A standard Marketo CRM business-object collection exposed by the whole-instance session. */
export type MarketoBusinessObjectKind =
  | "company"
  | "opportunity"
  | "opportunityRole"
  | "salesPerson"
  | "namedAccount";

/** Whether the connected instance and role permit operations on a business object. */
export type MarketoBusinessObjectAccess = "read-write" | "read-only" | "unavailable";

/** Select records by the object dedupe key or its Marketo-generated id. */
export type MarketoBusinessObjectMatchBy = "dedupeFields" | "idField";

/** Full schema and effective access for one standard business-object collection. */
export type MarketoBusinessObjectSchema = {
  /** Collection kind used to obtain this handle. */
  kind: MarketoBusinessObjectKind;
  /** Human-readable object name reported by Marketo. */
  displayName: string;
  /** Object description, when configured. */
  description?: string;
  /** Marketo-generated primary key field. */
  idField: string;
  /** Fields forming the insert and default update/delete dedupe key. */
  dedupeFields: string[];
  /** Searchable fields, preserving compound groups exactly as Marketo reports them. */
  searchableFieldGroups: string[][];
  /** Fields available on this object. */
  fields: MarketoFieldMetadata[];
  /** Effective access. Native CRM sync makes all kinds except named accounts read-only. */
  access: MarketoBusinessObjectAccess;
  /** Human-readable reason when access is not read-write. */
  accessReason?: string;
};

/** Filter for one bounded business-object query page. */
export type MarketoBusinessObjectQuery = {
  /** Match one searchable field, or complete compound dedupe keys where supported. */
  filter:
    | { field: string; values: unknown[] }
    | { dedupeKeys: Record<string, unknown>[] };
  /** Fields to return. Marketo always includes its identifying fields. */
  fields?: string[];
  /** Continuation token from the preceding query page. */
  pageToken?: string;
  /** Requested page size, from 1 through Marketo's maximum of 300. */
  maxResults?: number;
};

/** One page of standard business-object records. */
export type MarketoBusinessObjectPage = {
  records: Record<string, unknown>[];
  moreResult: boolean;
  nextPageToken?: string;
};

/** Summary of a Marketo custom object type. */
export type MarketoCustomObjectSummary = {
  /** API name used to address the object (e.g. `car_c`). */
  apiName: string;
  displayName: string;
  description?: string;
  /** Field names that form the object's dedupe key. */
  dedupeFields?: string[];
};

/** Full schema of a custom object type. */
export type MarketoCustomObjectSchema = MarketoCustomObjectSummary & {
  /** All fields on the object. */
  fields: MarketoFieldMetadata[];
  /** Fields usable as filters in `query()`. */
  searchableFields: string[];
};

// -----------------------------------------------------------------------------
// Marketo assets and Design Studio
// -----------------------------------------------------------------------------

/**
 * Opaque identifier for a Marketo asset.
 *
 * Existing Marketo assets normally use their numeric Marketo id rendered as a string. A handle
 * returned by a create or clone operation can instead carry a provisional string id. Treat ids as opaque: retain the handle returned by the
 * operation rather than parsing an id or assuming it is numeric.
 */
export type MarketoAssetId = string;

/** A reference to a Marketo folder or program folder. */
export type MarketoAssetFolderRef = {
  /** Opaque folder id. */
  id: MarketoAssetId;
  /** Whether this container is an ordinary folder or a program. */
  type: "folder" | "program";
};

/** Opaque identifier for a Design Studio asset. */
export type MarketoDesignStudioId = MarketoAssetId;

/** A reference to a Design Studio folder or program folder. */
export type MarketoDesignStudioFolderRef = MarketoAssetFolderRef;

/** Draft lifecycle state reported for a Design Studio asset. */
export type MarketoDesignStudioStatus = "draft" | "approved" | (string & {});

/** One page returned by a Design Studio listing operation. */
export type MarketoDesignStudioPage<T> = {
  /** Assets in this page. */
  items: T[];
  /** Opaque continuation token to pass to the same listing operation. */
  nextPageToken?: string;
};

/** Common controls for listing Design Studio assets. */
export type MarketoDesignStudioListOptions = {
  /** Exact asset name to match. Name matching follows Marketo's case-insensitive rules. */
  name?: string;
  /** Limit results to this folder, including program folders when Marketo permits them. */
  folder?: MarketoDesignStudioFolderRef;
  /** Return only assets with this lifecycle status. */
  status?: MarketoDesignStudioStatus;
  /** Opaque continuation token from the preceding page. */
  pageToken?: string;
  /** Requested page size. Marketo may enforce a smaller service limit. */
  maxResults?: number;
};

/** Controls Design Studio file listings, which do not support lifecycle status filters. */
export type MarketoDesignStudioFileListOptions = Omit<MarketoDesignStudioListOptions, "status">;

/** Controls folder hierarchy discovery in Design Studio. */
export type MarketoDesignStudioFolderListOptions = {
  /** Exact folder name to match. Name matching follows Marketo's case-insensitive rules. */
  name?: string;
  /** Limit traversal to descendants of this folder or program folder. */
  root?: MarketoDesignStudioFolderRef;
  /** Maximum number of hierarchy levels below `root` to return, from 1 through 20. */
  maxDepth?: number;
  /** Limit results to one workspace (1-100 non-whitespace characters). */
  workspace?: string;
  /** Opaque continuation token from the preceding page. */
  pageToken?: string;
  /** Requested page size. Marketo may enforce a smaller service limit. */
  maxResults?: number;
};

/** Basic metadata shared by Design Studio assets. */
export type MarketoDesignStudioAssetSummary = {
  /** Opaque id. It may be provisional for a newly-created asset. */
  id: MarketoDesignStudioId;
  /** Asset name as shown in Marketo. */
  name: string;
  /** Optional description maintained with the asset. */
  description?: string;
  /** Current draft lifecycle state. */
  status?: MarketoDesignStudioStatus;
  /** Workspace containing the asset, when Marketo reports it. */
  workspaceName?: string;
  /** When Marketo created the asset. */
  createdAt?: Date;
  /** When Marketo last changed the asset. */
  updatedAt?: Date;
};

/** Metadata for a Design Studio folder or program folder. */
export type MarketoDesignStudioFolderSummary = MarketoDesignStudioAssetSummary & {
  /** Whether this container is an ordinary Design Studio folder or a program. */
  type: "folder" | "program";
  /** Parent folder's opaque id, when this is not a root folder. */
  parentId?: MarketoDesignStudioId;
  /** Human-readable folder path, when Marketo reports it. */
  path?: string;
};

/** Metadata for a Marketo email. */
export type MarketoEmailSummary = MarketoDesignStudioAssetSummary & {
  /** Email subject line. */
  subject?: string;
  /** Display name used in the From header. */
  fromName?: string;
  /** Address used in the From header. */
  fromEmail?: string;
  /** Address used in the Reply-To header. */
  replyEmail?: string;
  /** Preview text shown by supporting mail clients. */
  preHeader?: string;
};

/** Metadata for a Marketo email template. */
export type MarketoEmailTemplateSummary = MarketoDesignStudioAssetSummary;

/** Metadata for a Marketo landing page. */
export type MarketoLandingPageSummary = MarketoDesignStudioAssetSummary & {
  /** Public landing-page URL generated by Marketo, when available. */
  url?: string;
};

/** Metadata for a Marketo landing-page template. */
export type MarketoLandingPageTemplateSummary = MarketoDesignStudioAssetSummary;

/** Metadata for a Marketo form. */
export type MarketoFormSummary = MarketoDesignStudioAssetSummary & {
  /** Locale configured for the form, when available. */
  locale?: string;
  /** Language configured for the form, when available. */
  language?: string;
};

/** Read-only description of one field on a Marketo form. */
export type MarketoFormField = {
  /** Form-local field identifier. */
  id: string;
  /** Label displayed to a person filling out the form. */
  label?: string;
  /** Marketo field/control type. */
  dataType?: string;
  /** Whether the form requires a value. */
  required?: boolean;
  /** Optional hint text displayed with the field. */
  hintText?: string;
};

/** Metadata for a Marketo snippet. */
export type MarketoSnippetSummary = MarketoDesignStudioAssetSummary;

/** Static HTML and plain-text renditions of a Marketo snippet. */
export type MarketoSnippetContent = {
  /** HTML rendition, when one exists. */
  html?: string;
  /** Plain-text rendition, when one exists. */
  text?: string;
};

/** Metadata for a file stored in Design Studio. */
export type MarketoFileSummary = MarketoDesignStudioAssetSummary & {
  /** Public file URL assigned by Marketo. */
  url?: string;
  /** MIME type reported for the file. */
  mimeType?: string;
  /** File size in bytes, when Marketo reports it. */
  size?: number;
};

/** A static editable region returned from an email's content tree. */
export type MarketoEmailContentSection = {
  /** Marketo's identifier for the editable region. */
  id: string;
  /** Current HTML for this region, when Marketo reports it. */
  html?: string;
  /** Current plain-text rendition for this region, when Marketo reports it. */
  text?: string;
};

/** Replacement for one writable static email section. */
export type MarketoEmailContentUpdate = {
  /** Exact replacement HTML. Limited to 512 KiB as UTF-8. */
  html: string;
  /** Optional exact replacement plain text. Limited to 512 KiB as UTF-8. */
  text?: string;
};

/** A static element returned from a landing page's content tree. */
export type MarketoLandingPageContentSection = {
  /** Marketo's identifier for the page element. */
  id: string;
  /** Element kind reported by Marketo, such as `text`, `html`, `image`, or `form`. */
  type: string;
  /** Current element content or referenced asset value. */
  content?: string;
};

/** Metadata accepted when creating an email. */
export type MarketoCreateEmailInput = {
  /** Name for the new email. */
  name: string;
  /** ID of the email template on which to base the email. */
  templateId: MarketoDesignStudioId;
  /** Email subject line. */
  subject: string;
  /** Display name used in the From header. */
  fromName: string;
  /** Address used in the From header. */
  fromEmail: string;
  /** Address used in the Reply-To header. */
  replyEmail: string;
  /** Optional asset description. */
  description?: string;
};

/** Writable metadata on an existing email. */
export type MarketoEmailMetadataPatch = {
  /** Replacement asset name. */
  name?: string;
  /** Replacement description. */
  description?: string;
  /** Replacement subject line. */
  subject?: string;
  /** Replacement From display name. */
  fromName?: string;
  /** Replacement From address. */
  fromEmail?: string;
  /** Replacement Reply-To address. */
  replyEmail?: string;
  /** Replacement preview text. */
  preHeader?: string;
};

/** Basic writable metadata shared by Design Studio assets. */
export type MarketoDesignStudioMetadataPatch = {
  /** Replacement asset name. */
  name?: string;
  /** Replacement asset description. */
  description?: string;
};

/** Metadata accepted when creating an email template. */
export type MarketoCreateEmailTemplateInput = {
  /** Name for the new template. */
  name: string;
  /** Initial HTML template source. Limited to 512 KiB as UTF-8. */
  content: string;
  /** Optional asset description. */
  description?: string;
};

/** Metadata accepted when creating a landing page. */
export type MarketoCreateLandingPageInput = {
  /** Name for the new landing page. */
  name: string;
  /** ID of the landing-page template on which to base the page. */
  templateId: MarketoDesignStudioId;
  /** Optional asset description. */
  description?: string;
};

/** Metadata accepted when creating a landing-page template. */
export type MarketoCreateLandingPageTemplateInput = {
  /** Name for the new template. */
  name: string;
  /** Optional asset description. */
  description?: string;
  /** Editor model for the initially empty template. */
  templateType?: "guided" | "freeForm";
  /** Whether the generated page includes Marketo's Munchkin tracking script. */
  enableMunchkin?: boolean;
};

/** Metadata accepted when creating a form. */
export type MarketoCreateFormInput = {
  /** Name for the new form. */
  name: string;
  /** Optional asset description. */
  description?: string;
  /** Optional locale, such as `en_US`. */
  locale?: string;
  /** Optional language, such as `English`. */
  language?: string;
};

/** Basic writable metadata on an existing form. */
export type MarketoFormMetadataPatch = {
  /** Replacement asset name. */
  name?: string;
  /** Replacement description. */
  description?: string;
  /** Replacement locale. */
  locale?: string;
  /** Replacement language. */
  language?: string;
};

/** Metadata accepted when creating a snippet. */
export type MarketoCreateSnippetInput = {
  /** Name for the new snippet. */
  name: string;
  /** Optional asset description. */
  description?: string;
  /** Initial HTML content. Limited to 512 KiB as UTF-8. */
  html?: string;
  /** Initial plain-text content. Limited to 512 KiB as UTF-8. */
  text?: string;
};

/** Metadata and bytes accepted when creating a Design Studio file. */
export type MarketoCreateFileInput = {
  /** File name, including its extension. */
  name: string;
  /** MIME type of `data`. */
  mimeType: string;
  /** Raw file bytes, limited to 1 MiB. */
  data: Uint8Array;
  /** Optional asset description. */
  description?: string;
};

// -----------------------------------------------------------------------------
// New Email Designer
// -----------------------------------------------------------------------------

/** Opaque ID of an email created with Marketo's new Email Designer. */
export type MarketoDesignerEmailId = string;

/** Opaque ID of a template created with Marketo's new Email Designer. */
export type MarketoDesignerEmailTemplateId = string;

/** Opaque ID of a reusable fragment created with Marketo's new Email Designer. */
export type MarketoDesignerFragmentId = string;

/** A Marketo workspace visible to the connected account. */
export type MarketoWorkspace = {
  /** Opaque workspace ID. */
  id: string;
  /** Workspace display name. */
  name: string;
  /** Optional workspace description. */
  description?: string;
  /** Workspace lifecycle status. */
  status?: string;
};

/** Folder or program location for a designer email. */
export type MarketoDesignerEmailLocation =
  | { workspaceId: string; folderId: string; programId?: never }
  | { workspaceId: string; programId: string; folderId?: never };

/** Folder location for a designer template or fragment. */
export type MarketoDesignerFolderLocation = { workspaceId: string; folderId: string };

/** Common optional filters for Email Designer lists. */
export type MarketoDesignerListOptions = {
  /** Restrict results to one folder. */
  folderId?: string;
  /** Interpret `folderId` as an ordinary folder or program. */
  folderType?: "Folder" | "Program";
  /** Exact name filter. */
  name?: string;
  /** Lifecycle states to include. */
  status?: string[];
  /** Zero-based page index. */
  pageIndex?: number;
  /** Page size from 1 through 50. */
  pageSize?: number;
  /** Sort field supported by Marketo. */
  sortKey?: string;
  /** Sort direction. */
  sortOrder?: "ASC" | "DESC";
  /** Include archived assets. */
  includeArchived?: boolean;
  /** Return only assets created by the connected Marketo API user. */
  isCreatedByMe?: boolean;
  /** Return only assets last modified by the connected Marketo API user. */
  isModifiedByMe?: boolean;
};

/** One page from an Email Designer list or dependency read. */
export type MarketoDesignerPage<T> = {
  /** Items in this page. */
  items: T[];
  /** Total matching items reported by Marketo. */
  totalItems?: number;
  /** Current zero-based page index. */
  pageIndex?: number;
  /** Effective page size. */
  pageSize?: number;
};

/** HTML and plain-text representations used by designer assets. */
export type MarketoDesignerContent = {
  /** Complete HTML body. */
  html?: string;
  /** Complete plain-text body. */
  text?: string;
  /** Whether Marketo should regenerate plain text from HTML. */
  syncTextFromHtml?: boolean;
};

/** Delivery headers on a designer email. */
export type MarketoDesignerEmailHeaders = {
  /** Required email subject. */
  subject: string;
  /** From display name. */
  fromName?: string;
  /** From address. */
  fromEmail?: string;
  /** Reply-To address. */
  replyEmail?: string;
  /** Inbox preview text. */
  preheader?: string;
  /** Static CC addresses. */
  ccEmails?: string[];
};

/** Delivery settings for an Email Designer email. */
export type MarketoDesignerEmailSettings = {
  brandedDomain?: string;
  dedicatedIp?: string;
  enableUrlTracking?: boolean;
  isOperational?: boolean;
  isTextOnly?: boolean;
  isWebPageView?: boolean;
};

/** Common metadata for an Email Designer asset. */
export type MarketoDesignerAssetSummary = {
  /** Opaque asset ID, which may initially be provisional. */
  id: string;
  name: string;
  description?: string;
  status?: string;
  workspaceId?: string;
  folderId?: string;
  createdBy?: string;
  createdAt?: Date;
  modifiedBy?: string;
  modifiedAt?: Date;
};

/** Full designer email, including content, headers, and settings. */
export type MarketoDesignerEmailDetail = MarketoDesignerAssetSummary & {
  headers?: MarketoDesignerEmailHeaders;
  content?: MarketoDesignerContent;
  settings?: MarketoDesignerEmailSettings;
  templateId?: MarketoDesignerEmailTemplateId;
  programId?: string;
  programName?: string;
};

/** Full designer email template. */
export type MarketoDesignerEmailTemplateDetail = MarketoDesignerAssetSummary & {
  content?: MarketoDesignerContent;
};

/** Full reusable designer fragment. */
export type MarketoDesignerFragmentDetail = MarketoDesignerAssetSummary & {
  content?: MarketoDesignerContent;
  /** Immutable fragment category. */
  fragmentType: string;
  fragmentSubType?: string;
  supportedChannels: string[];
};

/** Asset that directly depends on an Email Designer asset. */
export type MarketoDesignerUsedBy = {
  id: string;
  name: string;
  channel?: string;
  contentType?: string;
  workspaceId?: string;
  folderId?: string;
};

/** Values used to create a designer email. */
export type MarketoCreateDesignerEmailInput = {
  location: MarketoDesignerEmailLocation;
  name: string;
  description?: string;
  headers: MarketoDesignerEmailHeaders;
  content?: MarketoDesignerContent;
  templateId?: MarketoDesignerEmailTemplateId;
  settings?: MarketoDesignerEmailSettings;
};

/** Values used to create a designer email template. */
export type MarketoCreateDesignerEmailTemplateInput = {
  location: MarketoDesignerFolderLocation;
  name: string;
  description?: string;
  content?: MarketoDesignerContent;
};

/** Values used to create a designer fragment. Fragment type cannot be changed later. */
export type MarketoCreateDesignerFragmentInput = {
  location: MarketoDesignerFolderLocation;
  name: string;
  description?: string;
  content?: MarketoDesignerContent;
  fragmentType: string;
  fragmentSubType?: string;
  supportedChannels: string[];
};

/** Mutable fields of a designer email. */
export type MarketoDesignerEmailPatch = {
  name?: string;
  description?: string;
  headers?: Partial<MarketoDesignerEmailHeaders>;
  content?: MarketoDesignerContent;
  settings?: MarketoDesignerEmailSettings;
  templateId?: MarketoDesignerEmailTemplateId;
};

/** Mutable fields of a designer template. */
export type MarketoDesignerEmailTemplatePatch = {
  name?: string;
  description?: string;
  content?: MarketoDesignerContent;
};

/** Mutable fragment fields. `fragmentType` cannot be changed. */
export type MarketoDesignerFragmentPatch = {
  name?: string;
  description?: string;
  content?: MarketoDesignerContent;
  fragmentSubType?: string;
  supportedChannels?: string[];
};

// -----------------------------------------------------------------------------
// API usage
// -----------------------------------------------------------------------------

/**
 * Calls used today, instance-wide. Marketo reports no limit, remaining balance, or reset time, so
 * the subscription's daily headroom cannot be computed from this value. The total is shared with
 * every other integration on the instance.
 */
export type MarketoApiUsage = {
  /** Date the totals cover (instance time zone). */
  date: string;
  /** Total API calls made against the instance today, by all integrations. */
  total: number;
  /** Per-Marketo-API-user breakdown, when available. */
  users?: { userId: string; count: number }[];
};

// =============================================================================
// Capability interfaces
// =============================================================================

/**
 * Root handle for a Marketo instance.
 *
 * This is the broadest connection: it can read the field schema, look up and query
 * people, and open handles to lists, programs, campaigns, and custom objects. Narrower
 * grants (a single program or static list) expose the corresponding sub-interface only.
 */
export interface MarketoSession {
  /**
   * Open a standard CRM business-object collection. Available only on a whole-instance grant.
   * Call `describe()` before writing to discover effective native-CRM and role access.
   */
  getBusinessObject(kind: MarketoBusinessObjectKind): MarketoBusinessObject;

  /**
   * List metadata for every person field on the instance.
   *
   * Instances commonly have thousands of fields. Use this to discover the
   * `name` to request in `fields` or to write, and to see which fields are
   * `searchable` (usable as a lookup key).
   */
  describePersonFields(): Promise<MarketoFieldMetadata[]>;

  /**
   * Look up a single person by a searchable field.
   *
   * Returns a handle even if no person currently matches; reads on the handle report
   * the miss. `email` and `id` are always valid lookup fields.
   *
   * Only `id` is guaranteed unique. Marketo instances routinely hold several people sharing an
   * email address, and this resolves to whichever Marketo returns first — stable in practice but
   * not defined. Use `findPeople` when duplicates matter: it returns all of them.
   */
  getPerson(lookup: MarketoPersonLookup): MarketoPerson;

  /**
   * Find people whose `field` equals one of `values` (at most 300 per call, Marketo's
   * limit). `field` must be searchable. Only the requested `fields` (plus `id`) are
   * returned; if omitted, a small default set is used.
   *
   * `values` must be non-empty and individual values cannot contain commas; an empty list throws
   * rather than returning `[]`. The complete result is limited to 1,000 records; narrow the
   * filter when more records match.
   */
  findPeople(
    field: string,
    values: string[],
    fields?: string[],
  ): Promise<MarketoPersonRecord[]>;

  /**
   * Create and/or update people in bulk.
   *
   * `lookupField` (default `email`) selects how each record matches an existing person. Read the
   * records afterward to learn the assigned ids and final values.
   */
  createOrUpdatePeople(
    records: MarketoPersonInput[],
    options?: { action?: MarketoUpsertAction; lookupField?: string },
  ): Promise<void>;

  /**
   * Read a page of the instance's static lists (300 per page). Pass `pageToken` from a prior page
   * to continue, while `moreResult` is true.
   *
   * Narrow with `name` (exact, case-insensitive) or `nameContains` (substring) — never both.
   * **`nameContains` cannot see lists that belong to no program**, so it may report nothing for a
   * list that exists; see {@link MarketoNameFilter}.
   */
  listStaticLists(filter?: MarketoNameFilter): Promise<{
    lists: MarketoStaticListSummary[];
    moreResult: boolean;
    nextPageToken?: string;
  }>;
  /** Open a handle to one static list by id. */
  getStaticList(id: number): MarketoStaticList;

  /**
   * Find programs by exact name (Marketo matches case-insensitively, and ignores
   * surrounding whitespace on the name you pass).
   *
    * Only exact-name lookup is supported. Use the name supplied by the user or address a program
    * directly with `getProgram(id)`.
   *
   * Returns every match, because program names are NOT unique — the same name is
   * routinely reused across folders. Disambiguate on `folderName`, or ask the user, rather than
   * assuming the first result. An unknown name returns an empty array.
   *
   * A name matching 200 or more programs throws rather than returning a partial result; use
   * `getProgram(id)` instead.
   */
  findProgramsByName(name: string): Promise<MarketoProgramSummary[]>;
  /** Open a handle to one program by numeric or provisional id. */
  getProgram(id: MarketoProgramId): MarketoProgram;

  /** Discover channels and their applicable program types before creating a program. */
  getChannels(): Promise<MarketoProgramChannel[]>;

  /** Discover program tag definitions, required program types, and allowed values. */
  getTagTypes(): Promise<MarketoProgramTagType[]>;

  /** Create a program in an ordinary folder; the returned handle may initially have a provisional id. */
  createProgram(
    destination: MarketoAssetFolderRef,
    input: MarketoCreateProgramInput,
  ): Promise<MarketoProgram>;

  /** Clone a program into an ordinary folder; the returned handle may initially have a provisional id. */
  cloneProgram(
    sourceId: MarketoProgramId,
    destination: MarketoAssetFolderRef,
    input: MarketoCloneProgramInput,
  ): Promise<MarketoProgram>;

  /**
   * Read a page of the instance's smart campaigns (300 per page). Pass `pageToken` from a prior
   * page to continue, while `moreResult` is true.
   *
   * Narrow with `name` (exact, case-insensitive) or `nameContains` (substring) — never both — and
   * with `requestableOnly` to see only the campaigns {@link MarketoSmartCampaign.requestCampaign}
   * can run.
   *
   * **`nameContains` cannot see campaigns that belong to no program**, and it matches a campaign's
   * *program* name as well as its own, so hits need not contain the term in their name. Use `name`
   * when the full name is known; see {@link MarketoNameFilter}.
   */
  listSmartCampaigns(filter?: MarketoNameFilter & { requestableOnly?: boolean }): Promise<{
    campaigns: MarketoSmartCampaignSummary[];
    moreResult: boolean;
    nextPageToken?: string;
  }>;
  /** Open a handle to one smart campaign by id. */
  getSmartCampaign(id: MarketoSmartCampaignId): MarketoSmartCampaign;

  /**
   * Create an empty batch smart campaign; the returned handle may initially have a provisional id.
   *
   * A newly-created campaign has no flow steps or smart-list rules and must be configured in
   * Marketo before it can run. Prefer
   * {@link cloneSmartCampaign} when an existing campaign is a suitable template.
   */
  createSmartCampaign(
    destination: MarketoAssetFolderRef,
    input: MarketoCreateSmartCampaignInput,
  ): Promise<MarketoSmartCampaign>;

  /** Clone a configured smart campaign, including its flow and smart-list rules; the returned handle may initially have a provisional id. */
  cloneSmartCampaign(
    sourceId: MarketoSmartCampaignId,
    destination: MarketoAssetFolderRef,
    input: MarketoCloneSmartCampaignInput,
  ): Promise<MarketoSmartCampaign>;

  /** List activity types defined on the instance. */
  getActivityTypes(): Promise<MarketoActivityType[]>;
  /**
   * Read a page of activities across the instance. Provide `pageToken` (from a prior
   * page's `nextPageToken`) to continue paging.
   */
  getActivities(query: MarketoActivityQuery, pageToken?: string): Promise<MarketoActivityPage>;

  /** List custom object types on the instance. */
  listCustomObjects(): Promise<MarketoCustomObjectSummary[]>;
  /** Open a handle to one custom object type by API name. */
  getCustomObject(apiName: string): MarketoCustomObject;

  /**
   * Open the instance's Design Studio capability.
   *
   * Use this broad entry point to discover and manage folders, emails, templates, landing pages,
   * forms, snippets, and files. A separately granted `MarketoDesignStudio` binding exposes the
   * same capability without granting access to people, activities, programs, or campaigns.
   */
  getDesignStudio(): MarketoDesignStudio;

  /** Read today's instance-wide API call count. Usage only — Marketo does not expose the
   * daily limit or the remaining balance. */
  getApiUsage(): Promise<MarketoApiUsage>;
}

/**
 * Broad capability for Marketo Design Studio.
 *
 * Listing methods return metadata; call the corresponding `get*()` method to obtain a handle for
 * one asset. Create and clone methods return handles whose opaque ids may initially be provisional.
 * Keep and use those handles in subsequent calls instead of trying to recover a numeric id.
 * A single create or update request is limited to 1.25 MiB in total. Individual textual values
 * are limited to 512 KiB of UTF-8 and files to 1 MiB.
 *
 * Email test sends are not supported. Static email sections, template source, and snippet content
 * can be changed. Dynamic or segmented content, landing-page elements, and form fields cannot be
 * edited through this interface.
 */
export interface MarketoDesignStudio {
  /** Open the new Email Designer capability for emails, templates, and fragments. */
  getEmailDesigner(): MarketoEmailDesigner;

  /** List folders and program folders visible to the connected account. */
  listFolders(
    options?: MarketoDesignStudioFolderListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoDesignStudioFolderSummary>>;
  /** Open a folder or program-folder handle by id and container type. */
  getFolder(id: MarketoDesignStudioId, type: "folder" | "program"): MarketoDesignStudioFolder;

  /** Create a folder in `destination`; the returned handle may initially have a provisional id. */
  createFolder(destination: MarketoDesignStudioFolderRef, name: string, description?: string): Promise<MarketoDesignStudioFolder>;
  /** Create an email from a template; the returned handle may initially have a provisional id. */
  createEmail(destination: MarketoDesignStudioFolderRef, input: MarketoCreateEmailInput): Promise<MarketoEmail>;
  /** Create an email template; the returned handle may initially have a provisional id. */
  createEmailTemplate(destination: MarketoDesignStudioFolderRef, input: MarketoCreateEmailTemplateInput): Promise<MarketoEmailTemplate>;
  /** Create a landing page from a template; the returned handle may initially have a provisional id. */
  createLandingPage(destination: MarketoDesignStudioFolderRef, input: MarketoCreateLandingPageInput): Promise<MarketoLandingPage>;
  /** Create an initially empty landing-page template; the returned handle may initially have a provisional id. */
  createLandingPageTemplate(destination: MarketoDesignStudioFolderRef, input: MarketoCreateLandingPageTemplateInput): Promise<MarketoLandingPageTemplate>;
  /** Create a form; the returned handle may initially have a provisional id. */
  createForm(destination: MarketoDesignStudioFolderRef, input: MarketoCreateFormInput): Promise<MarketoForm>;
  /** Create a snippet; the returned handle may initially have a provisional id. */
  createSnippet(destination: MarketoDesignStudioFolderRef, input: MarketoCreateSnippetInput): Promise<MarketoSnippet>;
  /** Upload a file with insert-only semantics; the returned handle may initially have a provisional id. */
  createFile(destination: MarketoDesignStudioFolderRef, input: MarketoCreateFileInput): Promise<MarketoFile>;

  /** Clone an email by id; the returned handle may initially have a provisional id. */
  cloneEmail(sourceId: MarketoDesignStudioId, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoEmail>;
  /** Clone an email template by id; the returned handle may initially have a provisional id. */
  cloneEmailTemplate(sourceId: MarketoDesignStudioId, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoEmailTemplate>;
  /** Clone a landing page by id; the returned handle may initially have a provisional id. */
  cloneLandingPage(sourceId: MarketoDesignStudioId, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoLandingPage>;
  /** Clone a landing-page template by id; the returned handle may initially have a provisional id. */
  cloneLandingPageTemplate(sourceId: MarketoDesignStudioId, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoLandingPageTemplate>;
  /** Clone a form by id; the returned handle may initially have a provisional id. */
  cloneForm(sourceId: MarketoDesignStudioId, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoForm>;
  /** Clone a snippet by id; the returned handle may initially have a provisional id. */
  cloneSnippet(sourceId: MarketoDesignStudioId, name: string, destination: MarketoDesignStudioFolderRef): Promise<MarketoSnippet>;

  /** List emails, optionally narrowed by exact name, folder, or lifecycle status. */
  listEmails(
    options?: MarketoDesignStudioListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoEmailSummary>>;
  /** Open an email handle by opaque id. */
  getEmail(id: MarketoDesignStudioId): MarketoEmail;

  /** List email templates, optionally narrowed by exact name, folder, or lifecycle status. */
  listEmailTemplates(
    options?: MarketoDesignStudioListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoEmailTemplateSummary>>;
  /** Open an email-template handle by opaque id. */
  getEmailTemplate(id: MarketoDesignStudioId): MarketoEmailTemplate;

  /** List landing pages, optionally narrowed by exact name, folder, or lifecycle status. */
  listLandingPages(
    options?: MarketoDesignStudioListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoLandingPageSummary>>;
  /** Open a landing-page handle by opaque id. */
  getLandingPage(id: MarketoDesignStudioId): MarketoLandingPage;

  /** List landing-page templates, optionally narrowed by name, folder, or lifecycle status. */
  listLandingPageTemplates(
    options?: MarketoDesignStudioListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoLandingPageTemplateSummary>>;
  /** Open a landing-page-template handle by opaque id. */
  getLandingPageTemplate(id: MarketoDesignStudioId): MarketoLandingPageTemplate;

  /** List forms, optionally narrowed by exact name, folder, or lifecycle status. */
  listForms(
    options?: MarketoDesignStudioListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoFormSummary>>;
  /** Open a form handle by opaque id. */
  getForm(id: MarketoDesignStudioId): MarketoForm;

  /** List snippets, optionally narrowed by exact name, folder, or lifecycle status. */
  listSnippets(
    options?: MarketoDesignStudioListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoSnippetSummary>>;
  /** Open a snippet handle by opaque id. */
  getSnippet(id: MarketoDesignStudioId): MarketoSnippet;

  /** List files, optionally narrowed by exact name or folder. */
  listFiles(
    options?: MarketoDesignStudioFileListOptions,
  ): Promise<MarketoDesignStudioPage<MarketoFileSummary>>;
  /** Open a file handle by opaque id. */
  getFile(id: MarketoDesignStudioId): MarketoFile;
}

/**
 * Marketo's new Email Designer capability. IDs are opaque and are not interchangeable with
 * classic Design Studio, program, or campaign IDs.
 */
export interface MarketoEmailDesigner {
  /**
   * Discover workspaces visible to the connected account.
   *
   * Requires both `Access Users` and `Access User Management Api` permissions. Callers that
   * already know a workspace ID can skip it.
   */
  listWorkspaces(): Promise<MarketoWorkspace[]>;
  /** List designer emails in the required workspace. */
  listEmails(workspaceId: string, options?: MarketoDesignerListOptions & { templateId?: string }): Promise<MarketoDesignerPage<MarketoDesignerAssetSummary>>;
  /** Open a designer email handle by opaque ID. */
  getEmail(id: MarketoDesignerEmailId): MarketoDesignerEmail;
  /** Create a designer email; the returned handle may initially have a provisional id. */
  createEmail(input: MarketoCreateDesignerEmailInput): Promise<MarketoDesignerEmail>;

  /** List designer email templates in the required workspace. */
  listEmailTemplates(workspaceId: string, options?: MarketoDesignerListOptions): Promise<MarketoDesignerPage<MarketoDesignerAssetSummary>>;
  /** Open a designer template handle by opaque ID. */
  getEmailTemplate(id: MarketoDesignerEmailTemplateId): MarketoDesignerEmailTemplate;
  /** Create a designer email template; the returned handle may initially have a provisional id. */
  createEmailTemplate(input: MarketoCreateDesignerEmailTemplateInput): Promise<MarketoDesignerEmailTemplate>;

  /** List reusable fragments in the required workspace. */
  listFragments(workspaceId: string, options?: MarketoDesignerListOptions & { fragmentType?: string }): Promise<MarketoDesignerPage<MarketoDesignerAssetSummary>>;
  /** Open a designer fragment handle by opaque ID. */
  getFragment(id: MarketoDesignerFragmentId): MarketoDesignerFragment;
  /** Create a reusable fragment; the returned handle may initially have a provisional id. */
  createFragment(input: MarketoCreateDesignerFragmentInput): Promise<MarketoDesignerFragment>;
}

/** Lifecycle shared by designer emails, templates, and fragments. */
export interface MarketoDesignerApprovableAsset {
  /** Create an editable draft from the approved asset. */
  createDraft(): Promise<void>;
  /** Publish the draft. Publishing can propagate changes to dependent assets. */
  approve(): Promise<void>;
  /** Return an approved asset to an unapproved state. */
  unapprove(): Promise<void>;
  /** Permanently discard draft changes and restore the approved version. */
  discardDraft(): Promise<void>;
}

/** Handle to one new-designer email. Sending or activating email is not exposed. */
export interface MarketoDesignerEmail extends MarketoDesignerApprovableAsset {
  /** Read full metadata, content, headers, and settings. */
  describe(): Promise<MarketoDesignerEmailDetail>;
  /** Update draft metadata, content, headers, settings, or template. */
  update(patch: MarketoDesignerEmailPatch): Promise<void>;
  /** Clone in the source asset's current location. */
  clone(name: string, description?: string): Promise<MarketoDesignerEmail>;
  /** Read assets that depend on this email. */
  getUsedBy(pageIndex?: number, pageSize?: number): Promise<MarketoDesignerPage<MarketoDesignerUsedBy>>;
  /** Permanently delete this email. Dependencies can break. */
  delete(): Promise<void>;
}

/** Handle to one new-designer email template. */
export interface MarketoDesignerEmailTemplate extends MarketoDesignerApprovableAsset {
  /** Read full template metadata and content. */
  describe(): Promise<MarketoDesignerEmailTemplateDetail>;
  /** Update draft metadata or content. */
  update(patch: MarketoDesignerEmailTemplatePatch): Promise<void>;
  /** Clone in the source template's current location. */
  clone(name: string, description?: string): Promise<MarketoDesignerEmailTemplate>;
  /** Read assets that depend on this template. */
  getUsedBy(pageIndex?: number, pageSize?: number): Promise<MarketoDesignerPage<MarketoDesignerUsedBy>>;
  /** Permanently delete this template. Dependent emails can break. */
  delete(): Promise<void>;
}

/** Handle to one reusable new-designer fragment. */
export interface MarketoDesignerFragment extends MarketoDesignerApprovableAsset {
  /** Read full fragment metadata, content, and immutable type. */
  describe(): Promise<MarketoDesignerFragmentDetail>;
  /** Update draft metadata, content, subtype, or channels. Fragment type remains immutable. */
  update(patch: MarketoDesignerFragmentPatch): Promise<void>;
  /** Clone in the source fragment's current location. */
  clone(name: string, description?: string): Promise<MarketoDesignerFragment>;
  /** Read assets that depend on this fragment. */
  getUsedBy(pageIndex?: number, pageSize?: number): Promise<MarketoDesignerPage<MarketoDesignerUsedBy>>;
  /** Permanently delete this fragment. Inheriting assets can break. */
  delete(): Promise<void>;
}

/** Draft lifecycle operations shared by Design Studio assets. */
export interface MarketoApprovableDesignStudioAsset {
  /** Approve the current draft. */
  approve(): Promise<void>;
  /** Return an approved asset to draft state. */
  unapprove(): Promise<void>;
  /** Discard the current draft and restore the approved version. */
  discardDraft(): Promise<void>;
}

/**
 * Handle to one folder or program folder.
 *
 * Use {@link MarketoDesignStudio} to create or clone assets. This folder handle reads and manages
 * only the folder itself.
 */
export interface MarketoDesignStudioFolder {
  /** Read this container's metadata. */
  describe(): Promise<MarketoDesignStudioFolderSummary>;
  /** Update this ordinary folder's name or description. Program folders cannot be edited. */
  updateMetadata(patch: MarketoDesignStudioMetadataPatch): Promise<void>;
  /** Delete this empty ordinary folder. Marketo does not allow deleting program folders. */
  delete(): Promise<void>;
}

/** Handle to one Marketo email. */
export interface MarketoEmail extends MarketoApprovableDesignStudioAsset {
  /** Read this email's metadata and lifecycle status. */
  describe(): Promise<MarketoEmailSummary>;
  /** Read writable static HTML and text regions. Dynamic, segmented, snippet, and module regions are omitted. */
  getContent(): Promise<MarketoEmailContentSection[]>;
  /** Update basic delivery and asset metadata. */
  updateMetadata(patch: MarketoEmailMetadataPatch): Promise<void>;
  /** Replace one static editable region. Dynamic-content editing is not supported. */
  updateContent(sectionId: string, update: MarketoEmailContentUpdate): Promise<void>;
  /** Permanently delete this email. */
  delete(): Promise<void>;
}

/** Handle to one Marketo email template. */
export interface MarketoEmailTemplate extends MarketoApprovableDesignStudioAsset {
  /** Read this template's metadata and lifecycle status. */
  describe(): Promise<MarketoEmailTemplateSummary>;
  /** Read the template's HTML source. Template modules are not exposed separately. */
  getContent(): Promise<string>;
  /** Update the template's name or description. */
  updateMetadata(patch: MarketoDesignStudioMetadataPatch): Promise<void>;
  /** Replace the template's HTML source. Limited to 512 KiB as UTF-8. */
  updateContent(content: string): Promise<void>;
  /** Permanently delete this template. */
  delete(): Promise<void>;
}

/** Handle to one Marketo landing page. */
export interface MarketoLandingPage extends MarketoApprovableDesignStudioAsset {
  /** Read this landing page's metadata, public URL, and lifecycle status. */
  describe(): Promise<MarketoLandingPageSummary>;
  /** Read the page's static elements. Content cannot be edited through this interface. */
  getContent(): Promise<MarketoLandingPageContentSection[]>;
  /** Update the page's name or description. */
  updateMetadata(patch: MarketoDesignStudioMetadataPatch): Promise<void>;
  /** Permanently delete this landing page. */
  delete(): Promise<void>;
}

/** Handle to one Marketo landing-page template. */
export interface MarketoLandingPageTemplate extends MarketoApprovableDesignStudioAsset {
  /** Read this template's metadata and lifecycle status. */
  describe(): Promise<MarketoLandingPageTemplateSummary>;
  /** Read the template's HTML source. */
  getContent(): Promise<string>;
  /** Update the template's name or description. */
  updateMetadata(patch: MarketoDesignStudioMetadataPatch): Promise<void>;
  /** Replace the template's HTML source. Limited to 512 KiB as UTF-8. */
  updateContent(content: string): Promise<void>;
  /** Permanently delete this template. */
  delete(): Promise<void>;
}

/**
 * Handle to one Marketo form.
 *
 * Form field definitions are readable but not editable. Visibility rules, progressive profiling,
 * and follow-up behavior are not exposed.
 */
export interface MarketoForm {
  /** Read this form's basic metadata and lifecycle status. */
  describe(): Promise<MarketoFormSummary>;
  /** Read the form's field definitions. */
  getFields(): Promise<MarketoFormField[]>;
  /** Update basic form metadata. Form fields and behavior are not changed. */
  updateMetadata(patch: MarketoFormMetadataPatch): Promise<void>;
  /** Approve the current form draft. */
  approve(): Promise<void>;
  /** Discard the current form draft and restore the approved version. */
  discardDraft(): Promise<void>;
  /** Permanently delete this form. */
  delete(): Promise<void>;
}

/** Handle to one Marketo snippet. */
export interface MarketoSnippet extends MarketoApprovableDesignStudioAsset {
  /** Read this snippet's metadata and lifecycle status. */
  describe(): Promise<MarketoSnippetSummary>;
  /** Read the snippet's HTML and plain-text variants. */
  getContent(): Promise<MarketoSnippetContent>;
  /** Update the snippet's name or description. */
  updateMetadata(patch: MarketoDesignStudioMetadataPatch): Promise<void>;
  /** Replace either or both static content variants. Each is limited to 512 KiB as UTF-8. */
  updateContent(content: MarketoSnippetContent): Promise<void>;
  /** Permanently delete this snippet. */
  delete(): Promise<void>;
}

/** Handle to one file stored in Marketo Design Studio. Files have no draft lifecycle. */
export interface MarketoFile {
  /** Read this file's metadata and public URL. */
  describe(): Promise<MarketoFileSummary>;
  /** Replace the file bytes while retaining the same file handle. Limited to 1 MiB. */
  updateContent(data: Uint8Array, mimeType: string): Promise<void>;
}

/**
 * Handle to a single person (lead).
 *
 * The handle represents the person selected by the lookup passed to `MarketoSession.getPerson()`.
 */
export interface MarketoPerson {
  /**
   * Read this person's fields. Only the requested `fields` (plus `id`) are returned;
   * if omitted, a small default set is used. Resolves to `null` if no person matches.
   */
  read(fields?: string[]): Promise<MarketoPersonRecord | null>;

  /**
   * Update this person's fields. Keys are Marketo field
   * names. `id` cannot be changed; Marketo rejects other fields that are not writable.
   */
  update(fields: MarketoPersonInput): Promise<void>;

  /** Read a page of this person's activities. */
  getActivities(query: MarketoActivityQuery, pageToken?: string): Promise<MarketoActivityPage>;

  /** Permanently delete this person. */
  delete(): Promise<void>;
}

/**
 * Handle to a single static list. Grants read access to its membership and the
 * ability to add/remove members — but not to the rest of the instance.
 */
export interface MarketoStaticList {
  /** Read this list's metadata. */
  describe(): Promise<MarketoStaticListSummary>;

  /** Read a page of member records. Only the requested `fields` (plus `id`) are
   * returned. Pass `pageToken` from a prior page to continue, while `moreResult` is true. */
  getMembers(
    fields?: string[],
    pageToken?: string,
  ): Promise<{ members: MarketoPersonRecord[]; moreResult: boolean; nextPageToken?: string }>;

  /** Add people (by id) to this list. */
  addMembers(personIds: number[]): Promise<void>;

  /** Remove people (by id) from this list. */
  removeMembers(personIds: number[]): Promise<void>;
}

/**
 * Handle to a single program. Grants read and mutation access only to this program; creating or
 * cloning programs elsewhere requires the broad {@link MarketoSession} capability.
 */
export interface MarketoProgram {
  /** Read this program's metadata (including the ordered `statuses`). */
  describe(): Promise<MarketoProgramSummary>;

  /** Read the program's "My Tokens" (`{{my.*}}`). */
  getTokens(): Promise<MarketoToken[]>;

  /** Read a page of program members, each with their `membership` in this program. Pass
   * `pageToken` from a prior page to continue, while `moreResult` is true. */
  getMembers(
    fields?: string[],
    pageToken?: string,
  ): Promise<{
    members: (MarketoPersonRecord & { membership: MarketoProgramMembership })[];
    moreResult: boolean;
    nextPageToken?: string;
  }>;

  /**
   * Set the progression status of people (by id) within this program. When Marketo reports the
   * program's `statuses`, `status` must match one of them.
   */
  setMemberStatus(personIds: number[], status: string): Promise<void>;

  /** Rename this program or change its description. */
  updateMetadata(patch: { name?: string; description?: string }): Promise<void>;

  /** Replace this program's tags. Include all required tags and use allowed values. */
  updateTags(tags: MarketoProgramTag[]): Promise<void>;

  /** Set both dates on an Email Program. */
  updateDates(startDate: Date, endDate: Date): Promise<void>;

  /** Permanently delete this program. */
  delete(): Promise<void>;

  /** Approve this Email Program. It may send its configured email at the program start date. */
  approve(): Promise<void>;

  /** Unapprove this Email Program so it will not run as scheduled. */
  unapprove(): Promise<void>;
}

/**
 * Handle to a single smart campaign.
 *
 * Triggering or scheduling a campaign runs its flow against real people and can send
 * real email or SMS messages.
 */
export interface MarketoSmartCampaign {
  /** Read this campaign's metadata (including whether it is `requestable`). */
  describe(): Promise<MarketoSmartCampaignSummary>;

  /** Read the filters and triggers selecting who enters this campaign. Rules are read-only. */
  readSmartListRules(): Promise<MarketoSmartListRules>;

  /** Rename the campaign or change its description. */
  updateMetadata(patch: { name?: string; description?: string }): Promise<void>;

  /** Activate this trigger campaign. Future matching people may enter its flow; activation may fail if the flow is invalid. */
  activate(): Promise<void>;

  /** Deactivate this trigger campaign. */
  deactivate(): Promise<void>;

  /** Permanently delete this campaign. */
  delete(): Promise<void>;

  /**
   * Run this campaign's flow immediately against up to 100 people (by id).
   * The campaign must have a "Campaign is Requested" trigger (`requestable: true`);
   * calling this on a campaign that is not requestable throws immediately. `tokens` overrides
   * program My Tokens for this run; a token
   * `name` may be given qualified (`{{my.Discount}}`) or bare (`Discount`), and must name a
   * token that exists on the campaign's program.
   *
   * Unlike the person-writing methods, this is all-or-nothing: if any id does not exist Marketo
   * rejects the whole request and nobody is run through the flow, rather than skipping the
   * unknown ids and proceeding with the rest.
   */
  requestCampaign(
    personIds: number[],
    tokens?: { name: string; value: string }[],
  ): Promise<void>;

  /**
   * Schedule this campaign's batch run. Scheduling is available only for batch campaigns;
   * `runAt` must be between 5 minutes and 2 years in the future. `tokens` overrides up to 100 My
   * Tokens for the run, named either qualified (`{{my.Discount}}`) or bare (`Discount`).
   */
  schedule(
    runAt: Date,
    tokens?: { name: string; value: string }[],
  ): Promise<void>;
}

/**
 * Handle to a single custom object type. Grants read/query access to its records and
 * the ability to write and delete them.
 */
export interface MarketoCustomObject {
  /** Read this custom object's schema. */
  describe(): Promise<MarketoCustomObjectSchema>;

  /**
   * Query records whose `field` equals one of `values`. `field` must be searchable
   * (see `describe().searchableFields`). Only requested `fields` are returned.
   *
   * Pass values as strings formatted for the field's declared data type. Marketo treats invalid
   * representations as errors rather than as "no match": querying an
   * `integer` field for `"abc"`, or for a number above 2147483647, is an error, not an empty
   * result. Check the field's `dataType` in `describe()` and format accordingly. A well-typed
   * value that matches nothing returns `[]`. Individual values cannot contain commas because
   * Marketo reserves commas as its filter-value delimiter. The complete result is limited to
   * 1,000 records; narrow the filter when more records match.
   */
  query(
    field: string,
    values: string[],
    fields?: string[],
  ): Promise<Record<string, unknown>[]>;

  /** Create or update records. */
  createOrUpdate(records: Record<string, unknown>[]): Promise<void>;

  /**
   * Delete records by complete dedupe keys, or by providing a non-empty `marketoGUID` on every
   * record. A batch cannot mix the two modes.
   */
  delete(records: Record<string, unknown>[]): Promise<void>;
}

/** Whole-collection access to one standard Marketo CRM business-object kind. */
export interface MarketoBusinessObject {
  /** Read field, key, searchable-group, and effective access metadata. */
  describe(): Promise<MarketoBusinessObjectSchema>;

  /**
   * Query one bounded page by field values or complete compound dedupe keys. Individual field
   * values cannot contain commas because Marketo reserves commas as its filter-value delimiter.
   */
  query(query: MarketoBusinessObjectQuery): Promise<MarketoBusinessObjectPage>;

  /**
   * Create or update at most 300 records.
   * `idField` matching is valid only with `updateOnly`.
   */
  upsert(
    records: Record<string, unknown>[],
    options?: { action?: MarketoUpsertAction; matchBy?: MarketoBusinessObjectMatchBy },
  ): Promise<void>;

  /** Permanently delete at most 300 records by complete dedupe or id keys. */
  delete(
    records: Record<string, unknown>[],
    options?: { matchBy?: MarketoBusinessObjectMatchBy },
  ): Promise<void>;
}
