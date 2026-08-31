import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  MarketoError,
  MAX_FILTER_VALUES,
  type MarketoClient,
  type RawBusinessObjectSchema,
  type RawCustomObjectField,
} from "./marketo-api";
import type { BusinessObjectActionInput } from "./business-object-actions";
import type {
  MarketoBusinessObjectAccess,
  MarketoBusinessObjectKind,
  MarketoBusinessObjectMatchBy,
  MarketoBusinessObjectPage,
  MarketoBusinessObjectQuery,
  MarketoBusinessObjectSchema,
  MarketoFieldMetadata,
  MarketoUpsertAction,
} from "./types";

/** Static API constraints that remain known even if describe is permission-blocked. */
export const BUSINESS_OBJECTS: Record<MarketoBusinessObjectKind, {
  idField: string;
  dedupeFields: string[];
  requiredFields: string[];
}> = {
  company: { idField: "id", dedupeFields: ["externalCompanyId"], requiredFields: ["externalCompanyId"] },
  opportunity: {
    idField: "marketoGUID",
    dedupeFields: ["externalOpportunityId"],
    requiredFields: ["externalOpportunityId", "name"],
  },
  opportunityRole: {
    idField: "marketoGUID",
    dedupeFields: ["externalOpportunityId", "leadId", "role"],
    requiredFields: ["externalOpportunityId", "leadId", "role"],
  },
  salesPerson: {
    idField: "id",
    dedupeFields: ["externalSalesPersonId"],
    requiredFields: ["externalSalesPersonId"],
  },
  namedAccount: { idField: "marketoGUID", dedupeFields: ["name"], requiredFields: ["name"] },
};

/** Session plumbing required by a standard business-object handle. */
export type BusinessObjectContext = {
  client(): Promise<MarketoClient>;
  observe(title: string, description: string): Promise<void>;
  submitBusinessObject(action: BusinessObjectActionInput): Promise<void>;
  getBusinessObjectAccess(kind: MarketoBusinessObjectKind): MarketoBusinessObjectAccess;
  setBusinessObjectAccess(kind: MarketoBusinessObjectKind, access: MarketoBusinessObjectAccess): void;
  dispose(): void;
};

function permissionDenied(error: unknown): boolean {
  return error instanceof MarketoError && (error.code === "603" || error.status === 403);
}

function metadata(raw: RawCustomObjectField): MarketoFieldMetadata | undefined {
  if (!raw?.name) return undefined;
  return {
    name: raw.name,
    displayName: raw.displayName ?? raw.name,
    dataType: (raw.dataType ?? "string") as MarketoFieldMetadata["dataType"],
    length: raw.length,
    readOnly: raw.updateable === undefined ? false : !raw.updateable,
    searchable: false,
  };
}

function requireRecords(records: Record<string, unknown>[]): void {
  if (!Array.isArray(records) || records.length === 0) throw new Error("Expected a non-empty array of records.");
  if (records.length > MAX_FILTER_VALUES) throw new Error(`Marketo accepts at most ${MAX_FILTER_VALUES} records per call.`);
  for (let record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Each record must be an object.");
  }
}

function requireKeys(records: Record<string, unknown>[], fields: string[]): void {
  let seen = new Set<string>();
  for (let [index, record] of records.entries()) {
    for (let field of fields) {
      if (record[field] === undefined || record[field] === null || record[field] === "") {
        throw new Error(`Record ${index + 1} requires non-null field \`${field}\`.`);
      }
    }
    let key = JSON.stringify(fields.map(field => record[field]));
    if (seen.has(key)) throw new Error(`Duplicate ${fields.join("+")} key at record ${index + 1}.`);
    seen.add(key);
  }
}

function fieldsFor(kind: MarketoBusinessObjectKind, matchBy: MarketoBusinessObjectMatchBy): string[] {
  let object = BUSINESS_OBJECTS[kind];
  return matchBy === "idField" ? [object.idField] : object.dedupeFields;
}

function sameFilterValue(actual: unknown, requested: unknown): boolean {
  if (actual === requested) return true;
  let scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return scalar(actual) && scalar(requested) && String(actual) === String(requested);
}

@validateRpc()
export class MarketoBusinessObjectImpl extends RpcTarget {
  private disposed = false;

  constructor(
    private readonly ctx: BusinessObjectContext,
    private readonly kind: MarketoBusinessObjectKind,
    private readonly ownsContext = false,
  ) {
    super();
  }

  [Symbol.dispose](): void {
    if (this.ownsContext && !this.disposed) {
      this.disposed = true;
      this.ctx.dispose();
    }
  }

  async describe(): Promise<MarketoBusinessObjectSchema> {
    let known = BUSINESS_OBJECTS[this.kind];
    let access = this.ctx.getBusinessObjectAccess(this.kind);
    if (access === "unavailable") {
      await this.ctx.observe("Marketo opportunity roles unavailable", "Read cached opportunity-role access metadata; no records were read.");
      return this.unavailableSchema();
    }
    let raw: RawBusinessObjectSchema | undefined;
    try {
      raw = await (await this.ctx.client()).describeBusinessObject(this.kind);
    } catch (error) {
      if (this.kind !== "opportunityRole" || !permissionDenied(error)) throw error;
      this.ctx.setBusinessObjectAccess(this.kind, "unavailable");
      await this.ctx.observe("Marketo opportunity roles unavailable", "The connected role cannot describe opportunity roles.");
      return this.unavailableSchema();
    }
    if (!raw) throw new MarketoError(`Marketo did not return the ${this.kind} schema.`);
    if (this.kind !== "namedAccount" && (raw.crmManaged || raw.fields?.some(field => field.crmManaged))) {
      this.ctx.setBusinessObjectAccess(this.kind, "read-only");
      access = "read-only";
    }
    let groups = raw.searchableFields ?? [];
    let searchable = new Set(groups.flat());
    let fields = (raw.fields ?? []).flatMap(field => {
      let normalized = metadata(field);
      return normalized ? [{ ...normalized, searchable: searchable.has(normalized.name) }] : [];
    });
    await this.ctx.observe(`Read Marketo ${this.kind} schema`, `Read ${fields.length} field definition(s) and ${groups.length} searchable field group(s).`);
    return {
      kind: this.kind,
      displayName: raw.displayName ?? raw.name ?? this.kind,
      description: raw.description,
      idField: raw.idField ?? known.idField,
      dedupeFields: raw.dedupeFields ?? known.dedupeFields,
      searchableFieldGroups: groups,
      fields,
      access,
      accessReason: access === "read-only" ? "Native CRM sync manages these records." : undefined,
    };
  }

  async query(query: MarketoBusinessObjectQuery): Promise<MarketoBusinessObjectPage> {
    if (!query?.filter) throw new Error("A business-object filter is required.");
    if (query.maxResults !== undefined && (!Number.isSafeInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > MAX_FILTER_VALUES)) {
      throw new Error(`maxResults must be between 1 and ${MAX_FILTER_VALUES}.`);
    }
    if (this.ctx.getBusinessObjectAccess(this.kind) === "unavailable") throw new Error("Marketo opportunity roles are unavailable to this connection.");
    if ("dedupeKeys" in query.filter) {
      if (BUSINESS_OBJECTS[this.kind].dedupeFields.length === 1) {
        throw new Error("Compound dedupe-key queries are supported only for objects with compound dedupe fields.");
      }
      requireRecords(query.filter.dedupeKeys);
      requireKeys(query.filter.dedupeKeys, BUSINESS_OBJECTS[this.kind].dedupeFields);
    } else {
      if (!query.filter.field?.trim()) throw new Error("A filter field is required.");
      if (!Array.isArray(query.filter.values) || query.filter.values.length === 0) throw new Error("At least one filter value is required.");
      if (query.filter.values.length > MAX_FILTER_VALUES) throw new Error(`Marketo accepts at most ${MAX_FILTER_VALUES} filter values per call.`);
      if (query.filter.values.some(value => value === undefined || value === null)) throw new Error("Filter values cannot be null.");
      if (new Set(query.filter.values.map(value => JSON.stringify(value))).size !== query.filter.values.length) {
        throw new Error("Filter values must not contain duplicates.");
      }
    }
    try {
      let page = await (await this.ctx.client()).queryBusinessObject(this.kind, query);
      let filter = query.filter;
      let matches = "dedupeKeys" in filter
        ? (record: Record<string, unknown>) => filter.dedupeKeys.some(key =>
          BUSINESS_OBJECTS[this.kind].dedupeFields.every(field => sameFilterValue(record[field], key[field])))
        : (record: Record<string, unknown>) => filter.values.some(value =>
          sameFilterValue(record[filter.field], value));
      if (page.result.some(record => !matches(record))) {
        throw new MarketoError(`Marketo returned a ${this.kind} record outside the requested filter.`);
      }
      let count = page.result.length;
      await this.ctx.observe(`Read ${count} Marketo ${this.kind} record(s)`, `Queried one page using ${"dedupeKeys" in query.filter ? "compound dedupe keys" : `field ${query.filter.field}`}; ${count} record(s) returned.`);
      return { records: page.result, moreResult: page.moreResult, nextPageToken: page.nextPageToken };
    } catch (error) {
      if (this.kind === "opportunityRole" && permissionDenied(error)) {
        this.ctx.setBusinessObjectAccess(this.kind, "unavailable");
        throw new Error("Marketo opportunity roles are unavailable to this connection.", { cause: error });
      }
      throw error;
    }
  }

  async upsert(
    records: Record<string, unknown>[],
    options: { action?: MarketoUpsertAction; matchBy?: MarketoBusinessObjectMatchBy } = {},
  ): Promise<void> {
    requireRecords(records);
    this.requireWritable();
    let action = options.action ?? "createOrUpdate";
    if (!["createOnly", "createOrUpdate", "updateOnly"].includes(action)) throw new Error(`Unsupported Marketo upsert action: ${String(action)}.`);
    let matchBy = options.matchBy ?? "dedupeFields";
    if (matchBy === "idField" && action !== "updateOnly") throw new Error("idField matching is available only for updateOnly.");
    let keys = fieldsFor(this.kind, matchBy);
    requireKeys(records, keys);
    if (matchBy === "dedupeFields") requireKeys(records, BUSINESS_OBJECTS[this.kind].requiredFields);
    let changedFields = [...new Set(records.flatMap(record => Object.keys(record)).filter(field => !keys.includes(field)))].toSorted();
    await this.ctx.submitBusinessObject({ type: "businessObjectUpsert", kind: this.kind, records, action, matchBy, changedFields });
  }

  async delete(records: Record<string, unknown>[], options: { matchBy?: MarketoBusinessObjectMatchBy } = {}): Promise<void> {
    requireRecords(records);
    this.requireWritable();
    let matchBy = options.matchBy ?? "dedupeFields";
    let keys = fieldsFor(this.kind, matchBy);
    requireKeys(records, keys);
    for (let record of records) {
      let extra = Object.keys(record).filter(field => !keys.includes(field));
      if (extra.length) throw new Error(`Delete records may contain only ${keys.join(", ")}.`);
    }
    await this.ctx.submitBusinessObject({ type: "businessObjectDelete", kind: this.kind, records, matchBy, changedFields: keys });
  }

  private requireWritable(): void {
    let access = this.ctx.getBusinessObjectAccess(this.kind);
    if (access === "read-only") throw new Error("Native CRM sync manages this Marketo object; writes are read-only.");
    if (access === "unavailable") throw new Error("Marketo opportunity roles are unavailable to this connection.");
  }

  private unavailableSchema(): MarketoBusinessObjectSchema {
    let known = BUSINESS_OBJECTS[this.kind];
    return {
      kind: this.kind,
      displayName: "Opportunity Role",
      idField: known.idField,
      dedupeFields: known.dedupeFields,
      searchableFieldGroups: [known.dedupeFields, [known.idField]],
      fields: [],
      access: "unavailable",
      accessReason: "The connected Marketo role does not permit opportunity-role access.",
    };
  }
}
