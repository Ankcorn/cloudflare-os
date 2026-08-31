// Thin wrapper around the Marketo REST API.
//
// REST responses use Marketo's `{requestId, success, result, errors}` envelope; this module
// unwraps it and raises MarketoError so callers never see the envelope. Identity responses use
// their OAuth token shape and are parsed separately.

/** One account's LaunchPoint custom service credentials. */
export type MarketoCredentials = {
  /** Instance base URL, e.g. `https://123-ABC-456.mktorest.com` (no trailing slash). */
  endpoint: string;
  clientId: string;
  clientSecret: string;
};

/**
 * A Marketo API error, including the numeric code from its error envelope.
 *
 * Classification is stored as data rather than computed by getters, deliberately: Cap'n Web
 * serializes an Error's own enumerable properties but not its prototype, and the class itself
 * does not survive the hop — a gadget receives a plain `Error` carrying these fields. A getter
 * would be silently lost in transit.
 */
export class MarketoError extends Error {
  /** Marketo's numeric error code (e.g. `"1003"`), when it sent an error envelope. */
  readonly code: string | undefined;
  /** HTTP status, when the failure was at the HTTP level. */
  readonly status: number | undefined;
  /** The API path that failed — context for a caller that didn't make the request itself. */
  readonly operation: string | undefined;
  /** True when Marketo returned an explicit unsuccessful response envelope. */
  readonly isProviderRejection: boolean;
  /** True for codes meaning the token is expired (602) or invalid (601), per Marketo's docs.
   * Callers should refresh the token and retry once. */
  readonly isAuthError: boolean;
  /** True when Marketo is rejecting due to rate/quota limits. The instance quota is shared with
   * every other integration, so callers should surface this rather than hammering. */
  readonly isRateLimited: boolean;
  /** True when the addressed record or asset does not exist. Marketo says so with `1013` in the
   * lead database and `702` in the asset API, and this is also set when a read that answers
   * "success" with an empty result can only mean the target is missing. */
  readonly isNotFound: boolean;

  constructor(
    message: string,
    options?: {
      code?: string;
      status?: number;
      operation?: string;
      notFound?: boolean;
      providerRejection?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "MarketoError";
    this.code = options?.code;
    this.status = options?.status;
    this.operation = options?.operation;
    this.isProviderRejection = options?.providerRejection === true;
    this.isAuthError =
      this.code === "601" ||
      this.code === "602" ||
      this.code === "invalid_client" ||
      this.code === "unauthorized_client" ||
      this.code === "invalid_grant" ||
      this.status === 401;
    this.isRateLimited = this.code === "606" || this.code === "607" || this.code === "615";
    this.isNotFound =
      options?.notFound === true || this.code === "1013" || this.code === "702" || this.status === 404;
  }
}

/** Marketo's standard response envelope. */
type MarketoEnvelope<T> = {
  requestId?: string;
  success?: boolean;
  result?: T;
  errors?: { code?: string; message?: string }[];
  moreResult?: boolean;
  nextPageToken?: string;
  pageDetails?: unknown;
};

/** One page returned by the new Email Designer filter endpoints. */
export type RawDesignerPage<T> = {
  items?: T[];
  totalItems?: number;
  pageSize?: number;
  currentPage?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oauthErrorCode(value: unknown): string | undefined {
  let code = optionalString(value);
  return code === "invalid_client" || code === "unauthorized_client" || code === "invalid_grant"
    ? code
    : undefined;
}

function marketoErrorCode(value: unknown): string | undefined {
  let code = optionalString(value);
  return code && /^\d{3,6}$/.test(code) ? code : undefined;
}

function providerFailure(message: string, status: number | undefined, code?: string): string {
  let details = [code ? `code ${code}` : undefined, status === undefined ? undefined : `HTTP ${status}`]
    .filter(value => value !== undefined);
  return details.length === 0 ? `${message}.` : `${message} (${details.join("; ")}).`;
}

function parseEnvelope<T>(value: unknown): MarketoEnvelope<T> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.success !== undefined && typeof value.success !== "boolean") return undefined;
  if (value.moreResult !== undefined && typeof value.moreResult !== "boolean") return undefined;
  if (value.errors !== undefined && !Array.isArray(value.errors)) return undefined;

  let errors = Array.isArray(value.errors)
    ? value.errors.filter(isRecord).map(error => ({
        code: optionalString(error.code),
        message: optionalString(error.message) ?? optionalString(error.errorMessage) ?? optionalString(error.dynamicMessage),
      }))
    : undefined;
  return {
    requestId: optionalString(value.requestId),
    success: value.success,
    result: value.result as T | undefined,
    errors,
    moreResult: value.moreResult,
    nextPageToken: optionalString(value.nextPageToken),
    pageDetails: value.pageDetails,
  };
}

/**
 * A page of results plus paging state, normalized to one invariant: `nextPageToken` is present
 * if and only if `moreResult` is true. See `#page()` for why Marketo itself can't be trusted here.
 */
export type MarketoPage<T> = {
  result: T[];
  moreResult: boolean;
  nextPageToken?: string;
};

/** Exactly one of these narrows a listing by name; see {@link nameQuery}. */
type NameFilter = { name?: string; nameContains?: string; pageToken?: string };

/**
 * Build the `name` query parameter for a lead-database listing.
 *
 * Marketo treats `%` as a wildcard even though the API documentation describes exact names only.
 * Wildcard queries omit resources that belong to no program. Campaign queries also match the
 * containing program's name; static-list queries match only the list name. Caller-supplied SQL
 * wildcard characters are rejected because Marketo provides no way to escape them consistently.
 */
function nameQuery(filter: { name?: string; nameContains?: string }): Record<string, string> {
  let { name, nameContains } = filter;
  if (name !== undefined && nameContains !== undefined) {
    throw new Error("Pass either `name` (exact) or `nameContains` (substring), not both.");
  }
  if (name !== undefined) {
    if (!name.trim()) throw new Error("`name` cannot be empty.");
    if (/[%_]/.test(name)) throw new Error("`name` cannot contain Marketo wildcard characters.");
    return { name: name.trim() };
  }
  if (nameContains !== undefined) {
    // `%%` would match every record that has a program, which reads as "everything" while
    // silently omitting the program-less ones. Refuse rather than answer misleadingly.
    if (!nameContains.trim()) throw new Error("`nameContains` cannot be empty.");
    if (/[%_]/.test(nameContains)) {
      throw new Error("`nameContains` cannot contain Marketo wildcard characters.");
    }
    return { name: `%${nameContains.trim()}%` };
  }
  return {};
}

/**
 * A program My Token name in the `{{my.Name}}` form both this API and Marketo's campaign
 * endpoints use.
 *
 * Marketo reports bare names from the program endpoint while templates use the qualified form.
 */
export function qualifyTokenName(name: string): string {
  let trimmed = name.trim();
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) return trimmed;
  return `{{${trimmed.startsWith("my.") ? trimmed : `my.${trimmed}`}}}`;
}

/** `qualifyTokenName` applied to a token override headed for Marketo. */
function qualifyToken(token: { name: string; value: string }): { name: string; value: string } {
  return { name: qualifyTokenName(token.name), value: token.value };
}

/**
 * The rejection reasons carried by a custom-object query result entry, or undefined if the entry
 * is a real record. Marketo reports a rejected filter value as an entry holding only `reasons`;
 * every genuine custom-object record is keyed by `marketoGUID`.
 */
function rejectionReasons(
  record: Record<string, unknown>,
): { code?: string; message?: string }[] | undefined {
  let reasons = record.reasons;
  if (!Array.isArray(reasons) || record.marketoGUID !== undefined) return undefined;
  let parsed = reasons.filter(isRecord).map(reason => ({
    code: optionalString(reason.code),
    message: optionalString(reason.message),
  }));
  return parsed.length === reasons.length ? parsed : undefined;
}

/** Query parameters; array values are repeated (`?id=1&id=2`), which is how Marketo expects
 * multi-valued parameters. */
type Query = Record<string, string | number | boolean | (string | number)[] | undefined>;

type FormValue = string | number | boolean | undefined;

function formBody(values: Record<string, FormValue>): URLSearchParams {
  let form = new URLSearchParams();
  for (let [key, value] of Object.entries(values)) {
    if (value !== undefined) form.set(key, String(value));
  }
  return form;
}

function commaSeparatedFilterValues(values: unknown[]): string {
  let text = values.map(String);
  if (text.some(value => value.includes(","))) {
    throw new Error("Marketo filter values cannot contain commas.");
  }
  return text.join(",");
}

function folderJson(folder: MarketoFolderRef): string {
  return JSON.stringify(folder);
}

function htmlMultipart(field: string, content: string, fileName: string): FormData {
  let form = new FormData();
  form.append(field, new Blob([content], { type: "text/html" }), fileName);
  return form;
}

function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  let params = new URLSearchParams();
  for (let [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (let item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  let encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/** Backoff before retrying Marketo's short-window rate limit (100 calls / 20s). */
const RATE_LIMIT_BACKOFF_MS = [1_000, 3_000, 8_000];
const RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;

/** Marketo rejects activity queries carrying more than this many activity type ids. */
export const MAX_ACTIVITY_TYPE_IDS = 10;

/** The asset API's maximum page size. It defaults to a silent 20 when not asked. */
export const ASSET_PAGE_MAX = 200;

/** Marketo's documented ceiling on `filterValues` for the person and custom-object reads. */
export const MAX_FILTER_VALUES = 300;

/** Bound aggregate filter reads that cannot expose pagination without breaking their public API. */
const MAX_FILTER_RESULTS = 1_000;

/**
 * Request options for a filter-style read, sent as a form body rather than a query string.
 *
 * Marketo supports POST with `?_method=GET` for filters too large for a query string. A plain POST
 * to these paths is a write, so the method override is required.
 */
function filterRead(params: Record<string, string | number>): {
  method: string;
  query: Query;
  form: URLSearchParams;
} {
  let form = new URLSearchParams();
  for (let [key, value] of Object.entries(params)) form.set(key, String(value));
  return { method: "POST", query: { _method: "GET" }, form };
}

/** Marketo formats datetimes as ISO 8601. */
export function toMarketoDate(date: Date): string {
  return date.toISOString();
}

/** Parse a Marketo datetime string, tolerating absent/invalid values. */
export function parseMarketoDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value
    .replace(/Z[+-]00:?00$/i, "Z")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  let parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Supplies a currently-valid bearer token, refreshing when asked. Implemented by the token-cache
 * Durable Object so one token is shared across all callers. */
export type TokenProvider = {
  getToken(forceRefresh?: boolean): Promise<string>;
  credentialsExpired?(): Promise<void>;
};

/**
 * Fetch a fresh access token directly from Marketo's Identity endpoint.
 *
 * Marketo returns the *same* token (with its remaining lifespan) if the current one hasn't
 * expired, so calling this repeatedly is safe but wasteful — prefer a cached TokenProvider.
 */
export async function fetchAccessToken(
  creds: MarketoCredentials,
): Promise<{ accessToken: string; expiresInSeconds: number; scope?: string }> {
  let url =
    `${creds.endpoint}/identity/oauth/token` +
    buildQuery({
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });

  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new MarketoError("Could not reach the Marketo Identity endpoint.");
  }

  let raw: unknown = await response.json().catch(() => undefined);
  let body = isRecord(raw) ? raw : undefined;
  let accessToken = optionalString(body?.access_token);

  if (!response.ok || !accessToken) {
    let code = oauthErrorCode(body?.error);
    throw new MarketoError(providerFailure("Marketo authentication failed", response.status, code), {
      code,
      status: response.status,
    });
  }

  return {
    accessToken,
    expiresInSeconds:
      typeof body?.expires_in === "number" && Number.isFinite(body.expires_in)
        ? body.expires_in
        : 3600,
    scope: optionalString(body?.scope),
  };
}

// ---------------------------------------------------------------------------
// Client

/** Typed client for the subset of the Marketo REST API this gatekeeper exposes. */
export class MarketoClient {
  #endpoint: string;
  #tokens: TokenProvider;

  constructor(endpoint: string, tokens: TokenProvider) {
    while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
    this.#endpoint = endpoint;
    this.#tokens = tokens;
  }

  /** Resolve authentication before a side-effecting request is marked as dispatched. */
  async prepare(): Promise<void> {
    await this.#tokens.getToken();
  }

  /** Perform a REST call, unwrapping Marketo's envelope. Retries once on an expired/invalid
   * token, since tokens can lapse between cache read and use, and backs off on the instance-wide
   * rate limit (100 calls / 20s), which is easy to trip because the quota is shared with every
   * other integration on the instance. */
  async #request<T>(
    path: string,
    options?: {
      method?: string;
      query?: Query;
      body?: unknown;
      form?: URLSearchParams;
      multipart?: FormData;
      appType?: boolean;
      withoutRestPrefix?: boolean;
    },
  ): Promise<MarketoEnvelope<T>> {
    let attempt = async (token: string): Promise<MarketoEnvelope<T>> => {
      let url = `${this.#endpoint}${options?.withoutRestPrefix ? "" : "/rest"}${path}${buildQuery(options?.query)}`;
      let contentType = options?.form
        ? "application/x-www-form-urlencoded"
        : options?.body !== undefined
          ? "application/json"
          : undefined;
      let init: RequestInit = {
        method: options?.method ?? "GET",
        redirect: "error",
        headers: {
          // Marketo is removing `access_token` query-parameter auth on 2026-07-31; the
          // Authorization header is the only supported form going forward.
          Authorization: `Bearer ${token}`,
          ...(options?.appType ? { "x-app-type": "marketo" } : {}),
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        signal: AbortSignal.timeout(60_000),
      };
      if (options?.multipart) init.body = options.multipart;
      else if (options?.form) init.body = options.form.toString();
      else if (options?.body !== undefined) init.body = JSON.stringify(options.body);

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch {
        throw new MarketoError("Could not reach the Marketo API.", {
          operation: path,
        });
      }

      let raw = await response.json().catch(() => undefined);
      if (options?.withoutRestPrefix && response.ok && Array.isArray(raw)) {
        return { result: raw as T };
      }
      let envelope = parseEnvelope<T>(raw);
      if (!envelope) {
        throw new MarketoError(`Marketo returned an unreadable response (HTTP ${response.status})`, {
          status: response.status,
          operation: path,
        });
      }
      if (envelope.success === false) {
        let first = envelope.errors?.[0];
        let code = marketoErrorCode(first?.code);
        throw new MarketoError(providerFailure("Marketo request failed", response.status, code), {
          code,
          status: response.status,
          operation: path,
          providerRejection: true,
        });
      }
      if (!response.ok) {
        throw new MarketoError(`Marketo request failed (HTTP ${response.status})`, {
          status: response.status,
          operation: path,
        });
      }
      return envelope;
    };

    let run = async (): Promise<MarketoEnvelope<T>> => {
      try {
        return await attempt(await this.#tokens.getToken());
      } catch (e) {
        if (e instanceof MarketoError && e.isAuthError) {
          try {
            return await attempt(await this.#tokens.getToken(true));
          } catch (retryError) {
            if (retryError instanceof MarketoError && retryError.isAuthError) {
              await this.#tokens.credentialsExpired?.();
            }
            throw retryError;
          }
        }
        throw e;
      }
    };

    for (let attemptNumber = 0; ; attemptNumber++) {
      try {
        return await run();
      } catch (e) {
        // The short-window rate limit clears in seconds, so a bounded backoff is worth it; the
        // daily quota (which does not) surfaces as a different code and is not retried.
        if (
          e instanceof MarketoError &&
          e.isRateLimited &&
          e.code !== "607" &&
          attemptNumber < RATE_LIMIT_RETRIES
        ) {
          let backoff = RATE_LIMIT_BACKOFF_MS[attemptNumber];
          await new Promise(resolve => setTimeout(resolve, backoff + Math.random() * backoff));
          continue;
        }
        throw e;
      }
    }
  }

  async #result<T>(
    path: string,
    options?: {
      method?: string;
      query?: Query;
      body?: unknown;
      form?: URLSearchParams;
      multipart?: FormData;
    },
  ): Promise<T[]> {
    let envelope = await this.#request<unknown>(path, options);
    if (envelope.result === undefined) return [];
    if (!Array.isArray(envelope.result)) {
      throw new MarketoError("Marketo returned a result with an unexpected shape.", {
        operation: path,
      });
    }
    return envelope.result as T[];
  }

  async #designerResult<T>(
    path: string,
    parse: (value: unknown, label: string) => T,
    options?: { method?: string; query?: Query; body?: unknown },
    requireExplicitSuccess = false,
  ): Promise<T[]> {
    let envelope = await this.#request<unknown>(path, { ...options, appType: true });
    if (requireExplicitSuccess && envelope.success !== true) {
      throw new MarketoError("Marketo returned a designer result without confirming success.", {
        operation: path,
      });
    }
    if (envelope.result === undefined) return [];
    if (!Array.isArray(envelope.result)) {
      throw new MarketoError("Marketo returned a designer result with an unexpected shape.", { operation: path });
    }
    return envelope.result.map((item, index) => {
      try {
        return parse(item, `designer result ${index + 1}`);
      } catch (error) {
        if (error instanceof MarketoError && error.operation === undefined) {
          throw new MarketoError(error.message, { operation: path, cause: error });
        }
        throw error;
      }
    });
  }

  async #designerPage<T>(path: string, query: Query, parse: (value: unknown, label: string) => T): Promise<RawDesignerPage<T>> {
    let envelope = await this.#request<unknown>(path, { query, appType: true });
    if (!isRecord(envelope.result)) {
      throw new MarketoError("Marketo returned a designer page with an unexpected shape.", { operation: path });
    }
    let page = envelope.result;
    if (page.items !== undefined && !Array.isArray(page.items)) {
      throw new MarketoError("Marketo returned designer page items with an unexpected shape.", { operation: path });
    }
    if (page.items && page.items.length > 50) {
      throw new MarketoError("Marketo returned too many designer page items.", { operation: path });
    }
    let pageSize = designerPageNumber(page.pageSize, "pageSize", path);
    if (pageSize === 0 || pageSize !== undefined && pageSize > 50) {
      throw new MarketoError("Marketo returned designer pageSize outside the supported range.", { operation: path });
    }
    return {
      items: page.items?.map((item, index) => parse(item, `designer page item ${index + 1}`)),
      totalItems: designerPageNumber(page.totalItems, "totalItems", path),
      pageSize,
      currentPage: designerPageNumber(page.currentPage, "currentPage", path),
    };
  }

  // -------------------------------------------------------------------------
  // New Email Designer (Asset API v2)

  /** List workspaces. This User Management endpoint requires additional role permissions. */
  async getWorkspaces(): Promise<RawWorkspace[]> {
    let envelope = await this.#request<unknown>("/userservice/management/v1/users/workspaces.json", {
      withoutRestPrefix: true,
    });
    let result = envelope.result;
    if (!Array.isArray(result)) {
      throw new MarketoError("Marketo returned workspaces with an unexpected shape.", {
        operation: "/userservice/management/v1/users/workspaces.json",
      });
    }
    return result.map((item, index) => parseWorkspace(item, `workspace ${index + 1}`));
  }

  async filterDesignerAssets(kind: DesignerAssetKind, query: DesignerFilterQuery): Promise<RawDesignerPage<RawDesignerAsset>> {
    return await this.#designerPage(`/asset/v2/${kind}/filter`, query, parseDesignerAsset);
  }

  async getDesignerAsset(kind: DesignerAssetKind, id: string): Promise<RawDesignerAsset | undefined> {
    let path = `/asset/v2/${kind}/${encodeURIComponent(id)}`;
    let result = await this.#designerResult(path, parseDesignerAsset);
    if (result.length === 0) return undefined;
    if (result.length !== 1 || result[0]?.id === undefined || String(result[0].id) !== id) {
      throw new MarketoError(`Marketo returned the wrong designer asset for exact read ${id}.`, { operation: path });
    }
    return result[0];
  }

  async createDesignerAsset(kind: DesignerAssetKind, body: Record<string, unknown>): Promise<RawDesignerAsset[]> {
    return await this.#designerResult(`/asset/v2/${kind}`, parseDesignerAsset, { method: "POST", body });
  }

  async cloneDesignerAsset(kind: DesignerAssetKind, body: DesignerCloneRequest): Promise<RawDesignerAsset[]> {
    return await this.#designerResult(`/asset/v2/${kind}/clone`, parseDesignerAsset, { method: "POST", body });
  }

  async updateDesignerAsset(kind: DesignerAssetKind, id: string, body: Record<string, unknown>): Promise<RawDesignerAsset[]> {
    return await this.#designerResult(`/asset/v2/${kind}/${encodeURIComponent(id)}/update`, parseDesignerAsset, { method: "POST", body });
  }

  async transitionDesignerAsset(kind: DesignerAssetKind, body: DesignerStateTransition): Promise<RawDesignerAsset[]> {
    return await this.#designerResult(`/asset/v2/${kind}/state/transition`, parseDesignerAsset, { method: "POST", body });
  }

  async deleteDesignerAsset(kind: DesignerAssetKind, id: string): Promise<RawDesignerAsset[]> {
    return await this.#designerResult(`/asset/v2/${kind}/${encodeURIComponent(id)}/delete`, parseDesignerAsset, {
      method: "POST", body: {},
    }, true);
  }

  async getDesignerAssetUsedBy(kind: DesignerAssetKind, body: DesignerUsedByRequest): Promise<RawDesignerUsedByResponse> {
    let envelope = await this.#request<unknown>(`/asset/v2/${kind}/usedby`, {
      method: "POST", body, appType: true,
    });
    let result = envelope.result;
    if (!Array.isArray(result)) {
      throw new MarketoError("Marketo returned used-by results with an unexpected shape.", {
        operation: `/asset/v2/${kind}/usedby`,
      });
    }
    if (result.length > 50) {
      throw new MarketoError("Marketo returned too many used-by results.", {
        operation: `/asset/v2/${kind}/usedby`,
      });
    }
    return {
      result: result.map((item, index) => parseDesignerUsedBy(item, `used-by result ${index + 1}`)),
      pageDetails: envelope.pageDetails === undefined
        ? undefined
        : parseDesignerPageDetails(envelope.pageDetails, `/asset/v2/${kind}/usedby`),
    };
  }

  /**
   * One page, with `moreResult` made trustworthy.
   *
   * Only the activity-stream endpoints (`activities.json`, `leads/changes.json`) actually report
   * `moreResult`. The lead-database endpoints — `lists.json`, `campaigns.json`, list and program
   * membership — omit the field entirely while *always* returning a `nextPageToken`, even on a
   * partial page. Passing either signal through verbatim is a data-loss bug: a caller looping
   * "while moreResult" stops after page one, and a caller looping "while nextPageToken" never
   * stops. So when Marketo doesn't say, the only sound terminal signal is an empty page: an empty
   * result means exhausted, anything else means "ask again".
   *
   * The token is then withheld unless there is more, so callers can rely on the two agreeing.
   */
  async #page<T>(path: string, options?: { method?: string; query?: Query; body?: unknown; form?: URLSearchParams }): Promise<MarketoPage<T>> {
    let envelope = await this.#request<unknown>(path, options);
    let result = envelope.result ?? [];
    if (!Array.isArray(result)) {
      throw new MarketoError("Marketo returned a page with an unexpected shape.", {
        operation: path,
      });
    }
    let moreResult = envelope.moreResult ?? (result.length > 0 && Boolean(envelope.nextPageToken));
    return {
      result: result as T[],
      moreResult,
      nextPageToken: moreResult ? envelope.nextPageToken : undefined,
    };
  }

  async #filterResults<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
    let result: T[] = [];
    let nextPageToken: string | undefined;
    let seenTokens = new Set<string>();
    while (true) {
      let page = await this.#page<T>(path, filterRead({
        ...params,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      }));
      if (result.length + page.result.length > MAX_FILTER_RESULTS) {
        throw new MarketoError(
          `Marketo returned more than ${MAX_FILTER_RESULTS} filtered records; narrow the filter.`,
          { operation: path },
        );
      }
      result.push(...page.result);
      if (!page.moreResult) return result;
      if (page.result.length === 0 || !page.nextPageToken || seenTokens.has(page.nextPageToken)) {
        throw new MarketoError("Marketo returned invalid filter paging state.", { operation: path });
      }
      seenTokens.add(page.nextPageToken);
      nextPageToken = page.nextPageToken;
    }
  }

  // -------------------------------------------------------------------------
  // Design Studio folders

  /** Browse folders, optionally below a folder or program root. */
  async getFolders(options: MarketoFolderBrowseOptions = {}): Promise<RawFolder[]> {
    return await this.#result<RawFolder>("/asset/v1/folders.json", {
      query: {
        root: options.root ? folderJson(options.root) : undefined,
        maxDepth: options.maxDepth,
        maxReturn: options.maxReturn,
        offset: options.offset,
        workSpace: options.workspace,
      },
    });
  }

  /** Find every folder with an exact name. */
  async getFoldersByName(
    name: string,
    options: MarketoFolderNameOptions = {},
  ): Promise<RawFolder[]> {
    return await this.#result<RawFolder>("/asset/v1/folder/byName.json", {
      query: {
        name,
        type: options.type,
        root: options.root ? folderJson(options.root) : undefined,
        workSpace: options.workspace,
      },
    });
  }

  async getFolder(id: number, type: MarketoFolderType = "Folder"): Promise<RawFolder | undefined> {
    let result = await this.#result<RawFolder>(`/asset/v1/folder/${id}.json`, {
      query: { type },
    });
    return result[0];
  }

  /** List the immediate assets recorded in a folder. */
  async getFolderContents(
    id: number,
    options: MarketoFolderContentOptions = {},
  ): Promise<RawFolderContent[]> {
    return await this.#result<RawFolderContent>(`/asset/v1/folder/${id}/content.json`, {
      query: {
        type: options.type ?? "Folder",
        maxReturn: options.maxReturn,
        offset: options.offset,
      },
    });
  }

  async createFolder(input: MarketoCreateFolder): Promise<RawFolder[]> {
    return await this.#result<RawFolder>("/asset/v1/folders.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        parent: folderJson(input.parent),
        description: input.description,
      }),
    });
  }

  async updateFolder(id: number, input: MarketoUpdateFolder): Promise<RawFolder[]> {
    return await this.#result<RawFolder>(`/asset/v1/folder/${id}.json`, {
      method: "POST",
      form: formBody({
        type: "Folder",
        name: input.name,
        description: input.description,
        isArchive: input.isArchive,
      }),
    });
  }

  /** Delete an empty, non-system folder. Programs cannot be deleted through this endpoint. */
  async deleteFolder(id: number): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/folder/${id}/delete.json`, {
      method: "POST",
      form: formBody({ type: "Folder" }),
    });
  }

  // -------------------------------------------------------------------------
  // Emails

  async getEmails(options: MarketoEmailBrowseOptions = {}): Promise<RawEmail[]> {
    return await this.#result<RawEmail>("/asset/v1/emails.json", {
      query: {
        status: options.status,
        folder: options.folder ? folderJson(options.folder) : undefined,
        offset: options.offset,
        maxReturn: options.maxReturn,
        earliestUpdatedAt: options.earliestUpdatedAt,
        latestUpdatedAt: options.latestUpdatedAt,
      },
    });
  }

  async getEmailsByName(
    name: string,
    options: MarketoAssetLookupOptions = {},
  ): Promise<RawEmail[]> {
    return await this.#result<RawEmail>("/asset/v1/email/byName.json", {
      query: {
        name,
        status: options.status,
        folder: options.folder ? folderJson(options.folder) : undefined,
      },
    });
  }

  async getEmail(id: number, status?: MarketoAssetStatus): Promise<RawEmail | undefined> {
    let result = await this.#result<RawEmail>(`/asset/v1/email/${id}.json`, {
      query: { status },
    });
    return result[0];
  }

  async getEmailContent(id: number, status?: MarketoAssetStatus): Promise<RawEmailContent[]> {
    return await this.#result<RawEmailContent>(`/asset/v1/email/${id}/content.json`, {
      query: { status },
    });
  }

  async getEmailFullContent(
    id: number,
    options: MarketoEmailPreviewOptions = {},
  ): Promise<RawRenderedContent | undefined> {
    let result = await this.#result<RawRenderedContent>(`/asset/v1/email/${id}/fullContent.json`, {
      query: { status: options.status, type: options.type, leadId: options.leadId },
    });
    return result[0];
  }

  async createEmail(input: MarketoCreateEmail): Promise<RawEmail[]> {
    return await this.#result<RawEmail>("/asset/v1/emails.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        template: input.template,
        description: input.description,
        subject: input.subject,
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        replyEmail: input.replyEmail,
        operational: input.operational,
        isOpenTrackingDisabled: input.isOpenTrackingDisabled,
        textOnly: input.textOnly,
        autoCopyToText: input.autoCopyToText,
      }),
    });
  }

  async updateEmail(id: number, input: MarketoUpdateEmail): Promise<RawEmail[]> {
    return await this.#result<RawEmail>(`/asset/v1/email/${id}.json`, {
      method: "POST",
      form: formBody(input),
    });
  }

  /** Update email headers and delivery flags without manipulating modules or dynamic content. */
  async updateEmailContent(id: number, input: MarketoUpdateEmailContent): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/email/${id}/content.json`, {
      method: "POST",
      form: formBody({
        subject: input.subject ? JSON.stringify(input.subject) : undefined,
        fromName: input.fromName ? JSON.stringify(input.fromName) : undefined,
        fromEmail: input.fromEmail ? JSON.stringify(input.fromEmail) : undefined,
        replyTO: input.replyEmail ? JSON.stringify(input.replyEmail) : undefined,
        isOpenTrackingDisabled: input.isOpenTrackingDisabled,
      }),
    });
  }

  /** Update one ordinary editable section; module and dynamic-content operations are separate APIs. */
  async updateEmailContentSection(
    id: number,
    htmlId: string,
    input: MarketoUpdateEmailSection,
  ): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(
      `/asset/v1/email/${id}/content/${encodeURIComponent(htmlId)}.json`,
      {
        method: "POST",
        form: formBody({ type: input.type, value: input.value, textValue: input.textValue }),
      },
    );
  }

  /** Replace the HTML of an unlinked Email Editor 1.0 email. */
  async updateEmailFullContent(
    id: number,
    content: string,
    fileName = "email-content.html",
  ): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/email/${id}/fullContent.json`, {
      method: "POST",
      multipart: htmlMultipart("content", content, fileName),
    });
  }

  async cloneEmail(id: number, input: MarketoCloneAsset): Promise<RawEmail[]> {
    return await this.#result<RawEmail>(`/asset/v1/email/${id}/clone.json`, {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  async approveEmail(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("email", id, "approveDraft");
  }

  async unapproveEmail(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("email", id, "unapprove");
  }

  async discardEmailDraft(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("email", id, "discardDraft");
  }

  async deleteEmail(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("email", id, "delete");
  }

  // -------------------------------------------------------------------------
  // Email templates

  async getEmailTemplates(options: MarketoAssetBrowseOptions = {}): Promise<RawEmailTemplate[]> {
    return await this.#result<RawEmailTemplate>("/asset/v1/emailTemplates.json", {
      query: {
        status: options.status,
        folder: options.folder && folderJson(options.folder),
        offset: options.offset,
        maxReturn: options.maxReturn,
      },
    });
  }

  async getEmailTemplatesByName(
    name: string,
    status?: MarketoAssetStatus,
  ): Promise<RawEmailTemplate[]> {
    return await this.#result<RawEmailTemplate>("/asset/v1/emailTemplate/byName.json", {
      query: { name, status },
    });
  }

  async getEmailTemplate(
    id: number,
    status?: MarketoAssetStatus,
  ): Promise<RawEmailTemplate | undefined> {
    let result = await this.#result<RawEmailTemplate>(`/asset/v1/emailTemplate/${id}.json`, {
      query: { status },
    });
    return result[0];
  }

  async getEmailTemplateContent(
    id: number,
    status?: MarketoAssetStatus,
  ): Promise<RawEmailTemplateContent | undefined> {
    let result = await this.#result<RawEmailTemplateContent>(`/asset/v1/emailTemplate/${id}/content`, {
      query: { status },
    });
    return result[0];
  }

  async createEmailTemplate(input: MarketoCreateEmailTemplate): Promise<RawEmailTemplate[]> {
    let multipart = htmlMultipart("content", input.content, input.fileName ?? "template.html");
    multipart.append("name", input.name);
    multipart.append("folder", folderJson(input.folder));
    if (input.description !== undefined) multipart.append("description", input.description);
    return await this.#result<RawEmailTemplate>("/asset/v1/emailTemplates.json", {
      method: "POST",
      multipart,
    });
  }

  async updateEmailTemplate(
    id: number,
    input: MarketoUpdateAssetMetadata,
  ): Promise<RawEmailTemplate[]> {
    return await this.#result<RawEmailTemplate>(`/asset/v1/emailTemplate/${id}.json`, {
      method: "POST",
      form: formBody(input),
    });
  }

  async updateEmailTemplateContent(
    id: number,
    content: string,
    fileName = "template.html",
  ): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/emailTemplate/${id}/content.json`, {
      method: "POST",
      multipart: htmlMultipart("content", content, fileName),
    });
  }

  async cloneEmailTemplate(id: number, input: MarketoCloneAsset): Promise<RawEmailTemplate[]> {
    return await this.#result<RawEmailTemplate>(`/asset/v1/emailTemplate/${id}/clone.json`, {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  async approveEmailTemplate(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("emailTemplate", id, "approveDraft");
  }

  async unapproveEmailTemplate(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("emailTemplate", id, "unapprove");
  }

  async discardEmailTemplateDraft(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("emailTemplate", id, "discardDraft");
  }

  async deleteEmailTemplate(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("emailTemplate", id, "delete");
  }

  // -------------------------------------------------------------------------
  // Landing pages and templates

  async getLandingPages(options: MarketoAssetBrowseOptions = {}): Promise<RawLandingPage[]> {
    return await this.#result<RawLandingPage>("/asset/v1/landingPages.json", {
      query: {
        status: options.status,
        folder: options.folder ? folderJson(options.folder) : undefined,
        offset: options.offset,
        maxReturn: options.maxReturn,
      },
    });
  }

  async getLandingPagesByName(
    name: string,
    options: MarketoNamedBrowseOptions = {},
  ): Promise<RawLandingPage[]> {
    return await this.#result<RawLandingPage>("/asset/v1/landingPage/byName.json", {
      query: { name, status: options.status, offset: options.offset, maxReturn: options.maxReturn },
    });
  }

  async getLandingPage(id: number, status?: MarketoAssetStatus): Promise<RawLandingPage | undefined> {
    let result = await this.#result<RawLandingPage>(`/asset/v1/landingPage/${id}.json`, {
      query: { status },
    });
    return result[0];
  }

  /** Read landing-page sections without exposing section mutation yet. */
  async getLandingPageContent(
    id: number,
    status?: MarketoAssetStatus,
  ): Promise<RawLandingPageContent[]> {
    return await this.#result<RawLandingPageContent>(`/asset/v1/landingPage/${id}/content.json`, {
      query: { status },
    });
  }

  async getLandingPageFullContent(
    id: number,
    options: MarketoLandingPagePreviewOptions = {},
  ): Promise<RawRenderedContent | undefined> {
    let result = await this.#result<RawRenderedContent>(`/asset/v1/landingPage/${id}/fullContent.json`, {
      query: {
        leadId: options.leadId,
        segmentation: options.segmentation ? JSON.stringify(options.segmentation) : undefined,
      },
    });
    return result[0];
  }

  async createLandingPage(input: MarketoCreateLandingPage): Promise<RawLandingPage[]> {
    return await this.#result<RawLandingPage>("/asset/v1/landingPages.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        template: input.template,
        description: input.description,
        title: input.title,
        keywords: input.keywords,
        robots: input.robots,
        formPrefill: input.formPrefill,
        mobileEnabled: input.mobileEnabled,
        customHeadHTML: input.customHeadHTML,
        facebookOgTags: input.facebookOgTags,
        urlPageName: input.urlPageName,
        workspace: input.workspace,
      }),
    });
  }

  async updateLandingPage(id: number, input: MarketoUpdateLandingPage): Promise<RawLandingPage[]> {
    return await this.#result<RawLandingPage>(`/asset/v1/landingPage/${id}.json`, {
      method: "POST",
      form: formBody(input),
    });
  }

  async cloneLandingPage(id: number, input: MarketoCloneLandingPage): Promise<RawLandingPage[]> {
    return await this.#result<RawLandingPage>(`/asset/v1/landingPage/${id}/clone.json`, {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        template: input.template,
        description: input.description,
      }),
    });
  }

  async approveLandingPage(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPage", id, "approveDraft");
  }

  async unapproveLandingPage(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPage", id, "unapprove");
  }

  async discardLandingPageDraft(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPage", id, "discardDraft");
  }

  async deleteLandingPage(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPage", id, "delete");
  }

  async getLandingPageTemplates(
    options: MarketoAssetBrowseOptions = {},
  ): Promise<RawLandingPageTemplate[]> {
    return await this.#result<RawLandingPageTemplate>("/asset/v1/landingPageTemplates.json", {
      query: {
        status: options.status,
        folder: options.folder ? folderJson(options.folder) : undefined,
        offset: options.offset,
        maxReturn: options.maxReturn,
      },
    });
  }

  async getLandingPageTemplatesByName(name: string): Promise<RawLandingPageTemplate[]> {
    return await this.#result<RawLandingPageTemplate>("/asset/v1/landingPageTemplate/byName.json", {
      query: { name },
    });
  }

  async getLandingPageTemplate(
    id: number,
    status?: MarketoAssetStatus,
  ): Promise<RawLandingPageTemplate | undefined> {
    let result = await this.#result<RawLandingPageTemplate>(
      `/asset/v1/landingPageTemplate/${id}.json`,
      { query: { status } },
    );
    return result[0];
  }

  async getLandingPageTemplateContent(
    id: number,
    status?: MarketoAssetStatus,
  ): Promise<RawLandingPageTemplateContent | undefined> {
    let result = await this.#result<RawLandingPageTemplateContent>(
      `/asset/v1/landingPageTemplate/${id}/content.json`,
      { query: { status } },
    );
    return result[0];
  }

  async createLandingPageTemplate(
    input: MarketoCreateLandingPageTemplate,
  ): Promise<RawLandingPageTemplate[]> {
    return await this.#result<RawLandingPageTemplate>("/asset/v1/landingPageTemplates.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
        templateType: input.templateType,
        enableMunchkin: input.enableMunchkin,
      }),
    });
  }

  async updateLandingPageTemplate(
    id: number,
    input: MarketoUpdateLandingPageTemplate,
  ): Promise<RawLandingPageTemplate[]> {
    return await this.#result<RawLandingPageTemplate>(`/asset/v1/landingPageTemplate/${id}.json`, {
      method: "POST",
      form: formBody(input),
    });
  }

  async updateLandingPageTemplateContent(
    id: number,
    content: string,
    fileName = "landing-page-template.html",
  ): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/landingPageTemplate/${id}/content.json`, {
      method: "POST",
      multipart: htmlMultipart("content", content, fileName),
    });
  }

  async cloneLandingPageTemplate(
    id: number,
    input: MarketoCloneAsset,
  ): Promise<RawLandingPageTemplate[]> {
    return await this.#result<RawLandingPageTemplate>(
      `/asset/v1/landingPageTemplate/${id}/clone.json`,
      {
        method: "POST",
        form: formBody({
          name: input.name,
          folder: folderJson(input.folder),
          description: input.description,
        }),
      },
    );
  }

  async approveLandingPageTemplate(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPageTemplate", id, "approveDraft");
  }

  async unapproveLandingPageTemplate(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPageTemplate", id, "unapprove");
  }

  async discardLandingPageTemplateDraft(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPageTemplate", id, "discardDraft");
  }

  async deleteLandingPageTemplate(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("landingPageTemplate", id, "delete");
  }

  // -------------------------------------------------------------------------
  // Forms

  async getForms(options: MarketoAssetBrowseOptions = {}): Promise<RawForm[]> {
    return await this.#result<RawForm>("/asset/v1/forms.json", {
      query: {
        status: options.status,
        folder: options.folder ? folderJson(options.folder) : undefined,
        offset: options.offset,
        maxReturn: options.maxReturn,
      },
    });
  }

  async getFormsByName(name: string, status?: MarketoAssetStatus): Promise<RawForm[]> {
    return await this.#result<RawForm>("/asset/v1/form/byName.json", {
      query: { name, status },
    });
  }

  async getForm(id: number, status?: MarketoAssetStatus): Promise<RawForm | undefined> {
    let result = await this.#result<RawForm>(`/asset/v1/form/${id}.json`, {
      query: { status },
    });
    return result[0];
  }

  /** Read form fields. Field mutation is intentionally not exposed yet. */
  async getFormFields(id: number, status?: MarketoAssetStatus): Promise<RawFormField[]> {
    return await this.#result<RawFormField>(`/asset/v1/form/${id}/fields.json`, {
      query: { status },
    });
  }

  async getFormThankYouPage(
    id: number,
    status?: MarketoAssetStatus,
  ): Promise<RawFormThankYouPage | undefined> {
    let result = await this.#result<RawFormThankYouPage>(`/asset/v1/form/${id}/thankYouPage.json`, {
      query: { status },
    });
    return result[0];
  }

  async createForm(input: MarketoCreateForm): Promise<RawForm[]> {
    return await this.#result<RawForm>("/asset/v1/forms.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
        language: input.language,
        locale: input.locale,
        progressiveProfiling: input.progressiveProfiling,
        theme: input.theme,
        labelPosition: input.labelPosition,
        fontFamily: input.fontFamily,
        fontSize: input.fontSize,
      }),
    });
  }

  async updateForm(id: number, input: MarketoUpdateForm): Promise<RawForm[]> {
    return await this.#result<RawForm>(`/asset/v1/form/${id}.json`, {
      method: "POST",
      form: formBody(input),
    });
  }

  async cloneForm(id: number, input: MarketoCloneAsset): Promise<RawForm[]> {
    return await this.#result<RawForm>(`/asset/v1/form/${id}/clone.json`, {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  async approveForm(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("form", id, "approveDraft");
  }

  async discardFormDraft(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("form", id, "discardDraft");
  }

  async deleteForm(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("form", id, "delete");
  }

  // -------------------------------------------------------------------------
  // Snippets

  async getSnippets(options: MarketoAssetBrowseOptions = {}): Promise<RawSnippet[]> {
    return await this.#result<RawSnippet>("/asset/v1/snippets.json", {
      query: {
        status: options.status,
        folder: options.folder && folderJson(options.folder),
        offset: options.offset,
        maxReturn: options.maxReturn,
      },
    });
  }

  async getSnippet(id: number, status?: MarketoAssetStatus): Promise<RawSnippet | undefined> {
    let result = await this.#result<RawSnippet>(`/asset/v1/snippet/${id}.json`, {
      query: { status },
    });
    return result[0];
  }

  async getSnippetContent(id: number, status?: MarketoAssetStatus): Promise<RawSnippetContent[]> {
    return await this.#result<RawSnippetContent>(`/asset/v1/snippet/${id}/content.json`, {
      query: { status },
    });
  }

  async createSnippet(input: MarketoCreateAsset): Promise<RawSnippet[]> {
    return await this.#result<RawSnippet>("/asset/v1/snippets.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  async updateSnippet(id: number, input: MarketoUpdateAssetMetadata): Promise<RawSnippet[]> {
    return await this.#result<RawSnippet>(`/asset/v1/snippet/${id}.json`, {
      method: "POST",
      form: formBody(input),
    });
  }

  /** Replace the snippet's ordinary HTML or text rendition. */
  async updateSnippetContent(
    id: number,
    type: MarketoSnippetContentType,
    content: string,
  ): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/snippet/${id}/content.json`, {
      method: "POST",
      form: formBody({ type, content }),
    });
  }

  async cloneSnippet(id: number, input: MarketoCloneAsset): Promise<RawSnippet[]> {
    return await this.#result<RawSnippet>(`/asset/v1/snippet/${id}/clone.json`, {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  async approveSnippet(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("snippet", id, "approveDraft");
  }

  async unapproveSnippet(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("snippet", id, "unapprove");
  }

  async discardSnippetDraft(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("snippet", id, "discardDraft");
  }

  async deleteSnippet(id: number): Promise<RawAssetId[]> {
    return await this.#assetLifecycle("snippet", id, "delete");
  }

  // -------------------------------------------------------------------------
  // Files

  async getFiles(options: MarketoFileBrowseOptions = {}): Promise<RawFile[]> {
    return await this.#result<RawFile>("/asset/v1/files.json", {
      query: {
        folder: options.folder ? folderJson(options.folder) : undefined,
        offset: options.offset,
        maxReturn: options.maxReturn,
      },
    });
  }

  async getFilesByName(name: string): Promise<RawFile[]> {
    return await this.#result<RawFile>("/asset/v1/file/byName.json", { query: { name } });
  }

  async getFile(id: number): Promise<RawFile | undefined> {
    let result = await this.#result<RawFile>(`/asset/v1/file/${id}.json`);
    return result[0];
  }

  async createFile(input: MarketoCreateFile): Promise<RawFile[]> {
    let multipart = new FormData();
    multipart.append("file", input.file, input.fileName ?? input.name);
    multipart.append("name", input.name);
    multipart.append("folder", folderJson(input.folder));
    if (input.description !== undefined) multipart.append("description", input.description);
    if (input.insertOnly !== undefined) multipart.append("insertOnly", String(input.insertOnly));
    return await this.#result<RawFile>("/asset/v1/files.json", {
      method: "POST",
      multipart,
    });
  }

  async updateFileContent(id: number, file: Blob, fileName: string): Promise<RawFile[]> {
    let multipart = new FormData();
    multipart.append("file", file, fileName);
    return await this.#result<RawFile>(`/asset/v1/file/${id}/content.json`, {
      method: "POST",
      multipart,
    });
  }

  async #assetLifecycle(
    asset: "email" | "emailTemplate" | "landingPage" | "landingPageTemplate" | "form" | "snippet",
    id: number,
    operation: "approveDraft" | "unapprove" | "discardDraft" | "delete",
  ): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/${asset}/${id}/${operation}.json`, {
      method: "POST",
    });
  }

  // -------------------------------------------------------------------------
  // People

  /** Field metadata for the person/lead object. Instances routinely expose thousands of fields. */
  async describeLeadFields(): Promise<RawLeadField[]> {
    return await this.#result<RawLeadField>("/v1/leads/describe.json");
  }

  /**
   * The person fields that may be used as a lookup/filter field, which `leads/describe.json` does
   * not report. Marketo groups them (a group is a compound key), and always accepts `id` and
   * `email` whether or not it lists them.
   */
  async getSearchablePersonFields(): Promise<Set<string>> {
    let described = await this.#result<{ searchableFields?: string[][] }>(
      "/v1/leads/describe2.json",
    );
    let names = described.flatMap(entry => entry.searchableFields ?? []).flat();
    return new Set(["id", "email", ...names]);
  }

  /** Fetch people whose `filterType` field matches any of `filterValues`. */
  async getLeads(filterType: string, filterValues: string[], fields?: string[]): Promise<RawLead[]> {
    return await this.#filterResults<RawLead>("/v1/leads.json", {
      filterType,
      filterValues: commaSeparatedFilterValues(filterValues),
      ...(fields?.length ? { fields: fields.join(",") } : {}),
    });
  }

  /** Create and/or update people. */
  async syncLeads(
    input: Record<string, unknown>[],
    action: string,
    lookupField: string,
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>("/v1/leads.json", {
      method: "POST",
      body: { action, lookupField, input },
    });
  }

  /** Delete people by id. Irreversible in Marketo. */
  async deleteLeads(ids: number[]): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>("/v1/leads/delete.json", {
      method: "POST",
      body: { input: ids.map(id => ({ id })) },
    });
  }

  // -------------------------------------------------------------------------
  // Static lists

  /** One page of static lists (Marketo caps a page at 300). */
  async getLists(filter: NameFilter = {}): Promise<MarketoPage<RawList>> {
    let { pageToken, ...name } = filter;
    return await this.#page<RawList>("/v1/lists.json", {
      query: {
        batchSize: 300,
        ...nameQuery(name),
        ...(pageToken ? { nextPageToken: pageToken } : {}),
      },
    });
  }

  async getList(listId: number): Promise<RawList | undefined> {
    let result = await this.#result<RawList>(`/v1/lists/${listId}.json`);
    return result[0];
  }

  async getListMembers(listId: number, fields?: string[], nextPageToken?: string): Promise<MarketoPage<RawLead>> {
    return await this.#page<RawLead>(`/v1/lists/${listId}/leads.json`, {
      query: {
        ...(fields?.length ? { fields: fields.join(",") } : {}),
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
  }

  async addLeadsToList(listId: number, ids: number[]): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/lists/${listId}/leads.json`, {
      method: "POST",
      body: { input: ids.map(id => ({ id })) },
    });
  }

  async removeLeadsFromList(listId: number, ids: number[]): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/lists/${listId}/leads.json`, {
      method: "DELETE",
      body: { input: ids.map(id => ({ id })) },
    });
  }

  // -------------------------------------------------------------------------
  // Programs

  /**
   * One bounded page of programs, for a picker's initial browse list.
   *
   * The asset API has no substring search, so callers use this bounded page for browsing and
   * {@link getProgramsByName} or {@link getProgram} for direct lookup.
   */
  async getProgramPage(limit: number): Promise<RawProgram[]> {
    return await this.#result<RawProgram>("/asset/v1/programs.json", {
      query: { maxReturn: Math.min(limit, ASSET_PAGE_MAX), offset: 0 },
    });
  }

  /**
   * Programs whose name matches exactly (Marketo matches case-insensitively). Returns several
   * when an instance reuses a name across folders, which is common; a miss is an empty list.
   *
   * `maxReturn` is explicit because the asset API silently defaults to 20. Program names are not
   * unique, so use the API maximum to avoid hiding valid matches.
   */
  async getProgramsByName(name: string): Promise<RawProgram[]> {
    return await this.#result<RawProgram>("/asset/v1/program/byName.json", {
      query: { name, maxReturn: ASSET_PAGE_MAX },
    });
  }

  async getProgram(programId: number): Promise<RawProgram | undefined> {
    let path = `/asset/v1/program/${programId}.json`;
    let result = await this.#result<unknown>(path);
    if (result.length > 1 || result[0] !== undefined &&
        (!isRecord(result[0]) || result[0].id !== programId)) {
      throw new MarketoError(`Marketo returned the wrong program for exact read ${programId}.`, {
        operation: path,
      });
    }
    let program = result[0];
    if (program === undefined) return undefined;
    let stringFields = [program.name, program.description, program.type, program.channel,
      program.status, program.workspace, program.startDate, program.endDate, program.url,
      program.createdAt, program.updatedAt];
    let folder = program.folder;
    let tags = program.tags;
    if (stringFields.some(value => value !== undefined && typeof value !== "string") ||
        program.headStart !== undefined && typeof program.headStart !== "boolean" ||
        folder !== undefined && (!isRecord(folder) ||
          [folder.type, folder.folderName]
            .some(value => value !== undefined && typeof value !== "string") ||
          folder.value !== undefined && !Number.isSafeInteger(folder.value)) ||
        tags !== undefined && tags !== null && (!Array.isArray(tags) || tags.some(tag =>
          !isRecord(tag) || [tag.tagType, tag.tagValue]
            .some(value => value !== undefined && typeof value !== "string")
        ))) {
      throw new MarketoError("Marketo returned a program with an unexpected shape.", {
        operation: path,
      });
    }
    return program as RawProgram;
  }

  /** Tag definitions and allowed values configured for programs in this instance. */
  async getTagTypes(): Promise<RawTagType[]> {
    return await this.#result<RawTagType>("/asset/v1/tagTypes.json", {
      query: { maxReturn: ASSET_PAGE_MAX },
    });
  }

  /** Create a program in an ordinary Marketing Activities folder. */
  async createProgram(input: MarketoCreateProgram): Promise<RawProgram[]> {
    return await this.#result<RawProgram>("/asset/v1/programs.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        type: input.type,
        channel: input.channel,
        description: input.description,
        tags: input.tags ? JSON.stringify(input.tags) : undefined,
        startDate: input.startDate,
        endDate: input.endDate,
      }),
    });
  }

  /** Clone a program into an ordinary folder in the source workspace. */
  async cloneProgram(programId: number, input: MarketoCloneProgram): Promise<RawProgram[]> {
    return await this.#result<RawProgram>(`/asset/v1/program/${programId}/clone.json`, {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  /** Update mutable program metadata, tags, or Email Program dates. */
  async updateProgram(programId: number, patch: MarketoUpdateProgram): Promise<RawProgram[]> {
    return await this.#result<RawProgram>(`/asset/v1/program/${programId}.json`, {
      method: "POST",
      form: formBody({
        name: patch.name,
        description: patch.description,
        tags: patch.tags ? JSON.stringify(patch.tags) : undefined,
        startDate: patch.startDate,
        endDate: patch.endDate,
      }),
    });
  }

  /** Permanently delete a program. */
  async deleteProgram(programId: number): Promise<RawAssetId[]> {
    return await this.#programLifecycle(programId, "delete");
  }

  /** Approve an Email Program, allowing it to run at its configured start date. */
  async approveProgram(programId: number): Promise<RawAssetId[]> {
    return await this.#programLifecycle(programId, "approve");
  }

  /** Return an approved Email Program to unlocked state. */
  async unapproveProgram(programId: number): Promise<RawAssetId[]> {
    return await this.#programLifecycle(programId, "unapprove");
  }

  async #programLifecycle(
    programId: number,
    operation: "approve" | "unapprove" | "delete",
  ): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/program/${programId}/${operation}.json`, {
      method: "POST",
    });
  }

  /**
   * Program "My Tokens" live on the program's folder. The endpoint answers with one entry per
   * folder, each wrapping the tokens themselves, so the tokens are unwrapped here rather than
   * leaking the folder envelope to callers.
   */
  async getProgramTokens(programId: number): Promise<RawToken[]> {
    let path = `/asset/v1/folder/${programId}/tokens.json`;
    let folders = await this.#result<unknown>(
      path,
      { query: { folderType: "Program" } },
    );
    if (folders.length === 0) return [];
    let envelope = folders[0];
    if (folders.length > 1 || !isRecord(envelope) || !isRecord(envelope.folder) ||
        envelope.folder.type !== "Program" || envelope.folder.value !== programId) {
      throw new MarketoError(`Marketo returned tokens for the wrong program ${programId}.`, {
        operation: path,
      });
    }
    if (!Array.isArray(envelope.tokens)) {
      throw new MarketoError("Marketo returned program tokens with an unexpected shape.", {
        operation: path,
      });
    }
    return envelope.tokens.map((token, index) => {
      if (!isRecord(token) || [token.name, token.type, token.value]
        .some(value => value !== undefined && typeof value !== "string")) {
        throw new MarketoError(`Marketo returned program token ${index + 1} with an unexpected shape.`, {
          operation: path,
        });
      }
      return {
        name: optionalString(token.name),
        type: optionalString(token.type),
        value: optionalString(token.value),
      };
    });
  }

  async getProgramMembers(
    programId: number,
    fields?: string[],
    nextPageToken?: string,
  ): Promise<MarketoPage<RawLead>> {
    let path = `/v1/leads/programs/${programId}.json`;
    let page = await this.#page<RawLead>(path, {
      query: {
        ...(fields?.length ? { fields: fields.join(",") } : {}),
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    if (page.result.some(lead => {
      if (!isRecord(lead) || !isRecord(lead.membership) || lead.membership.id !== programId) {
        return true;
      }
      let membership = lead.membership;
      return [membership.progressionStatus, membership.progressionStatusType,
        membership.membershipDate, membership.updatedAt]
        .some(value => value !== undefined && typeof value !== "string") ||
        [membership.reachedSuccess, membership.acquiredBy, membership.isExhausted]
          .some(value => value !== undefined && typeof value !== "boolean");
    })) {
      throw new MarketoError(`Marketo returned membership for the wrong program ${programId}.`, {
        operation: path,
      });
    }
    return page;
  }

  /**
   * Marketo has two endpoints for this, and they disagree on the field name:
   * `/v1/programs/{id}/members/status.json` takes `statusName`, while this one takes `status`.
   * Sending `statusName` here is silently ignored and fails with "Status not specified".
   */
  async setProgramMemberStatus(
    programId: number,
    ids: number[],
    status: string,
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/leads/programs/${programId}/status.json`, {
      method: "POST",
      body: { status, input: ids.map(id => ({ id })) },
    });
  }

  /** Channel metadata carries the ordered progression statuses available to a program. */
  async getChannels(): Promise<RawChannel[]> {
    return await this.#result<RawChannel>("/asset/v1/channels.json", { query: { maxReturn: 200 } });
  }

  // -------------------------------------------------------------------------
  // Smart campaigns

  /** One page of smart campaigns (Marketo caps a page at 300). */
  async getCampaigns(filter: NameFilter & { requestableOnly?: boolean } = {})
      : Promise<MarketoPage<RawCampaign>> {
    let { pageToken, requestableOnly, ...name } = filter;
    return await this.#page<RawCampaign>("/v1/campaigns.json", {
      query: {
        batchSize: 300,
        ...nameQuery(name),
        // Marketo's spelling of "requestable": active, with a `Campaign is Requested` trigger.
        ...(requestableOnly ? { isTriggerable: "true" } : {}),
        ...(pageToken ? { nextPageToken: pageToken } : {}),
      },
    });
  }

  async getCampaign(campaignId: number): Promise<RawCampaign | undefined> {
    let result = await this.#result<RawCampaign>(`/v1/campaigns/${campaignId}.json`);
    return result[0];
  }

  /** Read a smart campaign through the Asset API, including lifecycle and folder metadata. */
  async getSmartCampaign(campaignId: number): Promise<RawCampaignAsset | undefined> {
    let result = await this.#result<RawCampaignAsset>(`/asset/v1/smartCampaign/${campaignId}.json`);
    return result[0];
  }

  /** Read the smart-list definition attached to a smart campaign. */
  async getCampaignSmartList(campaignId: number): Promise<RawSmartList | undefined> {
    let result = await this.#result<RawSmartList>(
      `/asset/v1/smartCampaign/${campaignId}/smartList.json`,
      { query: { includeRules: true } },
    );
    return result[0];
  }

  /** Create an empty batch smart campaign. */
  async createSmartCampaign(input: {
    name: string;
    folder: MarketoFolderRef;
    description?: string;
  }): Promise<RawCampaignAsset[]> {
    return await this.#result<RawCampaignAsset>("/asset/v1/smartCampaigns.json", {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  /** Clone a smart campaign, preserving its smart-list rules and flow steps. */
  async cloneSmartCampaign(campaignId: number, input: {
    name: string;
    folder: MarketoFolderRef;
    description?: string;
  }): Promise<RawCampaignAsset[]> {
    return await this.#result<RawCampaignAsset>(`/asset/v1/smartCampaign/${campaignId}/clone.json`, {
      method: "POST",
      form: formBody({
        name: input.name,
        folder: folderJson(input.folder),
        description: input.description,
      }),
    });
  }

  /** Rename a smart campaign or update its description. */
  async updateSmartCampaign(
    campaignId: number,
    patch: { name?: string; description?: string },
  ): Promise<RawCampaignAsset[]> {
    return await this.#result<RawCampaignAsset>(`/asset/v1/smartCampaign/${campaignId}.json`, {
      method: "POST",
      form: formBody(patch),
    });
  }

  /** Activate a trigger smart campaign. */
  async activateSmartCampaign(campaignId: number): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/smartCampaign/${campaignId}/activate.json`, {
      method: "POST",
    });
  }

  /** Deactivate a trigger smart campaign. */
  async deactivateSmartCampaign(campaignId: number): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/smartCampaign/${campaignId}/deactivate.json`, {
      method: "POST",
    });
  }

  /** Permanently delete a smart campaign. */
  async deleteSmartCampaign(campaignId: number): Promise<RawAssetId[]> {
    return await this.#result<RawAssetId>(`/asset/v1/smartCampaign/${campaignId}/delete.json`, {
      method: "POST",
    });
  }

  /** Run a campaign's flow immediately. This can send real email/SMS. */
  async triggerCampaign(
    campaignId: number,
    ids: number[],
    tokens?: { name: string; value: string }[],
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/campaigns/${campaignId}/trigger.json`, {
      method: "POST",
      body: {
        input: {
          leads: ids.map(id => ({ id })),
          ...(tokens?.length ? { tokens: tokens.map(qualifyToken) } : {}),
        },
      },
    });
  }

  /** Schedule a campaign's batch run. This can send real email/SMS. */
  async scheduleCampaign(
    campaignId: number,
    runAt: Date,
    tokens?: { name: string; value: string }[],
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/campaigns/${campaignId}/schedule.json`, {
      method: "POST",
      body: {
        input: {
          runAt: toMarketoDate(runAt),
          ...(tokens?.length ? { tokens: tokens.map(qualifyToken) } : {}),
        },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Activities

  async getActivityTypes(): Promise<RawActivityType[]> {
    return await this.#result<RawActivityType>("/v1/activities/types.json");
  }

  /** Marketo requires a paging token anchored at a start time before reading activities. */
  async getPagingToken(sinceDate: Date): Promise<string> {
    let envelope = await this.#request<never>("/v1/activities/pagingtoken.json", {
      query: { sinceDatetime: toMarketoDate(sinceDate) },
    });
    if (!envelope.nextPageToken) {
      throw new MarketoError("Marketo did not return an activities paging token.");
    }
    return envelope.nextPageToken;
  }

  async getActivities(options: {
    nextPageToken: string;
    activityTypeIds?: number[];
    leadIds?: number[];
    batchSize?: number;
  }): Promise<MarketoPage<RawActivity>> {
    return await this.#page<RawActivity>("/v1/activities.json", {
      query: {
        nextPageToken: options.nextPageToken,
        ...(options.activityTypeIds?.length
          ? { activityTypeIds: options.activityTypeIds.join(",") }
          : {}),
        ...(options.leadIds?.length ? { leadIds: options.leadIds.join(",") } : {}),
        ...(options.batchSize ? { batchSize: options.batchSize } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Custom objects

  async listCustomObjects(): Promise<RawCustomObject[]> {
    return await this.#result<RawCustomObject>("/v1/customobjects.json");
  }

  async describeCustomObject(apiName: string): Promise<RawCustomObjectSchema | undefined> {
    let result = await this.#result<RawCustomObjectSchema>(
      `/v1/customobjects/${encodeURIComponent(apiName)}/describe.json`,
    );
    return result[0];
  }

  /** Query custom object records. */
  async queryCustomObject(
    apiName: string,
    filterType: string,
    filterValues: string[],
    fields?: string[],
  ): Promise<Record<string, unknown>[]> {
    let path = `/v1/customobjects/${encodeURIComponent(apiName)}.json`;
    let records = await this.#filterResults<Record<string, unknown>>(path, {
      filterType,
      filterValues: commaSeparatedFilterValues(filterValues),
      ...(fields?.length ? { fields: fields.join(",") } : {}),
    });
    return records.filter(record => {
      // A rejected filter value is not reported as an error: Marketo answers 200 with
      // `success: true` and smuggles `{reasons: [{code, message}]}` into the result array
      // alongside (or instead of) real records. Left alone it would be counted and stored as
      // business data, so it is raised here instead. Real records always carry a marketoGUID.
      let reasons = rejectionReasons(record);
      if (!reasons) return true;
      let code = reasons.map(reason => marketoErrorCode(reason.code)).find(value => value !== undefined);
      throw new MarketoError(providerFailure("Marketo rejected the custom-object query", undefined, code), {
        code,
        operation: path,
      });
    });
  }

  async syncCustomObject(
    apiName: string,
    input: Record<string, unknown>[],
    action = "createOrUpdate",
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/customobjects/${encodeURIComponent(apiName)}.json`, {
      method: "POST",
      body: { action, input },
    });
  }

  async deleteCustomObject(
    apiName: string,
    input: Record<string, unknown>[],
    deleteBy: "dedupeFields" | "idField" = "dedupeFields",
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(
      `/v1/customobjects/${encodeURIComponent(apiName)}/delete.json`,
      { method: "POST", body: { deleteBy, input } },
    );
  }

  // -------------------------------------------------------------------------
  // Standard CRM business objects

  /** Read schema and access metadata for a standard Marketo business object. */
  async describeBusinessObject(kind: MarketoBusinessObjectKind): Promise<RawBusinessObjectSchema | undefined> {
    let result = await this.#result<RawBusinessObjectSchema>(`/v1/${businessObjectPath(kind)}/describe.json`);
    return result[0];
  }

  /** Query one page by simple field values or a compound dedupe key. */
  async queryBusinessObject(
    kind: MarketoBusinessObjectKind,
    request: MarketoBusinessObjectApiQuery,
  ): Promise<MarketoPage<Record<string, unknown>>> {
    let path = `/v1/${businessObjectPath(kind)}.json`;
    let common = {
      ...(request.fields?.length ? { fields: request.fields.join(",") } : {}),
      ...(request.pageToken ? { nextPageToken: request.pageToken } : {}),
      batchSize: request.maxResults ?? MAX_FILTER_VALUES,
    };
    if ("dedupeKeys" in request.filter) {
      return await this.#page(path, {
        method: "POST",
        query: {
          _method: "GET",
          batchSize: request.maxResults ?? MAX_FILTER_VALUES,
          nextPageToken: request.pageToken,
        },
        body: { filterType: "dedupeFields", fields: request.fields, input: request.filter.dedupeKeys },
      });
    }
    return await this.#page(path, filterRead({
      filterType: request.filter.field,
      filterValues: commaSeparatedFilterValues(request.filter.values),
      ...common,
    }));
  }

  /** Create or update standard business-object records. */
  async syncBusinessObject(
    kind: MarketoBusinessObjectKind,
    input: Record<string, unknown>[],
    action: string,
    dedupeBy: "dedupeFields" | "idField",
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/${businessObjectPath(kind)}.json`, {
      method: "POST",
      body: { action, dedupeBy, input },
    });
  }

  /** Permanently delete standard business-object records. */
  async deleteBusinessObject(
    kind: MarketoBusinessObjectKind,
    input: Record<string, unknown>[],
    deleteBy: "dedupeFields" | "idField",
  ): Promise<RawSyncResult[]> {
    return await this.#result<RawSyncResult>(`/v1/${businessObjectPath(kind)}/delete.json`, {
      method: "POST",
      body: { deleteBy, input },
    });
  }

  // -------------------------------------------------------------------------
  // Usage

  async getUsage(): Promise<RawUsage[]> {
    return await this.#result<RawUsage>("/v1/stats/usage.json");
  }
}

// ---------------------------------------------------------------------------
// Raw response shapes (as returned by Marketo, before normalization)

/** Folder discriminator used throughout the Asset API. */
export type MarketoFolderType = "Folder" | "Program";

/** A normalized folder reference accepted by Asset API requests. */
export type MarketoFolderRef = { id: number; type: MarketoFolderType };

/** Version selector accepted by versioned Design Studio assets. */
export type MarketoAssetStatus = "approved" | "draft";

/** Offset-based browse options for versioned Design Studio assets. */
export type MarketoVersionedBrowseOptions = {
  status?: MarketoAssetStatus;
  offset?: number;
  maxReturn?: number;
};

/** Versioned browse options for endpoints that also support a parent-folder filter. */
export type MarketoAssetBrowseOptions = MarketoVersionedBrowseOptions & {
  folder?: MarketoFolderRef;
};

/** Common exact-name lookup options. */
export type MarketoAssetLookupOptions = {
  status?: MarketoAssetStatus;
  folder?: MarketoFolderRef;
};

/** Exact-name lookup options for endpoints that page duplicate names. */
export type MarketoNamedBrowseOptions = {
  status?: MarketoAssetStatus;
  offset?: number;
  maxReturn?: number;
};

/** Folder hierarchy browse options. */
export type MarketoFolderBrowseOptions = {
  root?: MarketoFolderRef;
  maxDepth?: number;
  offset?: number;
  maxReturn?: number;
  workspace?: string;
};

/** Folder exact-name lookup options. */
export type MarketoFolderNameOptions = {
  type?: MarketoFolderType;
  root?: MarketoFolderRef;
  workspace?: string;
};

/** Folder-content browse options. */
export type MarketoFolderContentOptions = {
  type?: MarketoFolderType;
  offset?: number;
  maxReturn?: number;
};

/** Input for creating a Design Studio folder. */
export type MarketoCreateFolder = {
  name: string;
  parent: MarketoFolderRef;
  description?: string;
};

/** Mutable metadata for a folder. */
export type MarketoUpdateFolder = {
  name?: string;
  description?: string;
  isArchive?: boolean;
};

/** Email browse options, including Marketo's update-time filters. */
export type MarketoEmailBrowseOptions = MarketoAssetBrowseOptions & {
  earliestUpdatedAt?: string;
  latestUpdatedAt?: string;
};

/** Email preview options supported by the Email Editor 1.0 full-content endpoint. */
export type MarketoEmailPreviewOptions = {
  status?: MarketoAssetStatus;
  type?: "HTML" | "Text";
  leadId?: number;
};

/** Input for creating an email from a classic email template. */
export type MarketoCreateEmail = {
  name: string;
  folder: MarketoFolderRef;
  template: number;
  description?: string;
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  replyEmail?: string;
  operational?: boolean;
  isOpenTrackingDisabled?: boolean;
  textOnly?: boolean;
  autoCopyToText?: boolean;
};

/** Mutable email metadata. */
export type MarketoUpdateEmail = {
  name?: string;
  description?: string;
  preHeader?: string;
  operational?: boolean;
  published?: boolean;
  textOnly?: boolean;
  webView?: boolean;
  autoCopyToText?: boolean;
};

/** A static email header value. Dynamic content is intentionally not represented yet. */
export type MarketoEmailHeaderValue = { type: "Text"; value: string };

/** Mutable top-level email content fields. */
export type MarketoUpdateEmailContent = {
  subject?: MarketoEmailHeaderValue;
  fromName?: MarketoEmailHeaderValue;
  fromEmail?: MarketoEmailHeaderValue;
  replyEmail?: MarketoEmailHeaderValue;
  isOpenTrackingDisabled?: boolean;
};

/** A simple editable email section update. */
export type MarketoUpdateEmailSection = {
  type: "Text";
  value: string;
  textValue?: string;
};

/** Input shared by asset clone endpoints. */
export type MarketoCloneAsset = {
  name: string;
  folder: MarketoFolderRef;
  description?: string;
};

/** Input shared by simple asset create endpoints. */
export type MarketoCreateAsset = MarketoCloneAsset;

/** Mutable name and description fields shared by simple assets. */
export type MarketoUpdateAssetMetadata = { name?: string; description?: string };

/** A program tag selected from an instance tag definition. */
export type MarketoProgramTag = { tagType: string; tagValue: string };

/** Input accepted by the official Create Program endpoint. */
export type MarketoCreateProgram = {
  name: string;
  folder: MarketoFolderRef;
  type: string;
  channel: string;
  description?: string;
  tags?: MarketoProgramTag[];
  startDate?: string;
  endDate?: string;
};

/** Input accepted by the official Clone Program endpoint. */
export type MarketoCloneProgram = {
  name: string;
  folder: MarketoFolderRef;
  description?: string;
};

/** Mutable fields accepted by the official Update Program endpoint. */
export type MarketoUpdateProgram = {
  name?: string;
  description?: string;
  tags?: MarketoProgramTag[];
  startDate?: string;
  endDate?: string;
};

/** Input for creating a classic email template with multipart HTML. */
export type MarketoCreateEmailTemplate = MarketoCreateAsset & {
  content: string;
  fileName?: string;
};

/** Landing-page full-content preview options. */
export type MarketoLandingPagePreviewOptions = {
  leadId?: number;
  segmentation?: { segmentationId: number; segmentId: number }[];
};

/** Input for creating a landing page. */
export type MarketoCreateLandingPage = {
  name: string;
  folder: MarketoFolderRef;
  template: number;
  description?: string;
  title?: string;
  keywords?: string;
  robots?: string;
  formPrefill?: boolean;
  mobileEnabled?: boolean;
  customHeadHTML?: string;
  facebookOgTags?: string;
  urlPageName?: string;
  workspace?: string;
};

/** Mutable landing-page metadata. */
export type MarketoUpdateLandingPage = {
  name?: string;
  description?: string;
  title?: string;
  keywords?: string;
  robots?: string;
  mobileEnabled?: boolean;
  customHeadHTML?: string;
  facebookOgTags?: string;
  metaTagsDescription?: string;
  styleOverRide?: string;
  urlPageName?: string;
};

/** Input for cloning a landing page; Marketo optionally accepts a replacement template. */
export type MarketoCloneLandingPage = MarketoCloneAsset & { template?: number };

/** Input for creating an initially empty landing-page template. */
export type MarketoCreateLandingPageTemplate = MarketoCreateAsset & {
  templateType?: "guided" | "freeForm";
  enableMunchkin?: boolean;
};

/** Mutable landing-page-template metadata. */
export type MarketoUpdateLandingPageTemplate = MarketoUpdateAssetMetadata & {
  enableMunchkin?: boolean;
};

/** Input for creating a form with basic styling metadata. */
export type MarketoCreateForm = {
  name: string;
  folder: MarketoFolderRef;
  description?: string;
  language?: string;
  locale?: string;
  progressiveProfiling?: boolean;
  theme?: string;
  labelPosition?: string;
  fontFamily?: string;
  fontSize?: string;
};

/** Mutable form metadata; field and follow-up-rule edits are intentionally separate. */
export type MarketoUpdateForm = {
  name?: string;
  description?: string;
  language?: string;
  locale?: string;
  progressiveProfiling?: boolean;
  theme?: string;
  labelPosition?: string;
  fontFamily?: string;
  fontSize?: string;
  customCss?: string;
};

/** Ordinary, non-dynamic snippet content supported by this transport surface. */
export type MarketoSnippetContentType = "HTML" | "Text";

/** File browse options. */
export type MarketoFileBrowseOptions = Omit<MarketoAssetBrowseOptions, "status">;

/** Multipart input for creating or replacing a Marketo file. */
export type MarketoCreateFile = {
  name: string;
  folder: MarketoFolderRef;
  file: Blob;
  fileName?: string;
  description?: string;
  insertOnly?: boolean;
};

/** The common id-only result returned by many mutation endpoints. */
export type RawAssetId = { id?: number };

/** Folder data embedded in an asset response. */
export type RawAssetFolder = {
  id?: number;
  value?: number;
  type?: string;
  name?: string;
  folderName?: string;
};

/** Common fields returned for versioned Design Studio assets. */
export type RawDesignStudioAsset = {
  id?: number;
  name?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  folder?: RawAssetFolder;
  status?: string;
  workspace?: string;
};

export type RawFolder = {
  id?: number;
  name?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  folderId?: RawAssetFolder;
  folderType?: string;
  parent?: RawAssetFolder;
  path?: string;
  isArchive?: boolean;
  isSystem?: boolean;
  accessZoneId?: number;
  workspace?: string;
};

export type RawFolderContent = { id?: number; type?: string };

export type RawEmailHeader = { type?: string; value?: string };

export type RawEmail = RawDesignStudioAsset & {
  subject?: RawEmailHeader | RawEmailHeader[];
  fromName?: RawEmailHeader | RawEmailHeader[];
  fromEmail?: RawEmailHeader | RawEmailHeader[];
  replyEmail?: RawEmailHeader | RawEmailHeader[];
  operational?: boolean;
  textOnly?: boolean;
  publishToMSI?: boolean;
  webView?: boolean;
  template?: number;
  isOpenTrackingDisabled?: boolean;
  version?: number;
  autoCopyToText?: boolean;
  preHeader?: string;
  ccFields?: {
    attributeId?: string;
    objectName?: string;
    displayName?: string;
    apiName?: string;
  }[];
};

export type RawEmailContent = {
  htmlId?: string;
  contentType?: string;
  value?: unknown;
  index?: number;
  parentHtmlId?: string;
  isLocked?: boolean;
};

export type RawRenderedContent = {
  id?: number;
  status?: string;
  content?: string;
};

export type RawEmailTemplate = RawDesignStudioAsset & { version?: number };

export type RawEmailTemplateContent = RawRenderedContent;

export type RawLandingPage = RawDesignStudioAsset & {
  URL?: string;
  computedUrl?: string;
  customHeadHTML?: string;
  facebookOgTags?: string;
  formPrefill?: boolean;
  keywords?: string;
  mobileEnabled?: boolean;
  robots?: string;
  template?: number;
  title?: string;
};

export type RawLandingPageContent = {
  id?: unknown;
  type?: string;
  index?: number;
  content?: unknown;
  formattingOptions?: Record<string, unknown>;
  followupType?: string;
  followupValue?: string;
};

export type RawLandingPageTemplate = RawDesignStudioAsset & {
  templateType?: string;
  enableMunchkin?: boolean;
};

export type RawLandingPageTemplateContent = RawRenderedContent;

export type RawFormThankYouRule = {
  default?: boolean;
  followupType?: string;
  followupValue?: unknown;
  operator?: string;
  subjectField?: string;
  values?: string[];
};

export type RawForm = RawDesignStudioAsset & {
  theme?: string;
  language?: string;
  locale?: string;
  progressiveProfiling?: boolean;
  labelPosition?: string;
  fontFamily?: string;
  fontSize?: string;
  knownVisitor?: { type?: string; template?: string };
  thankYouList?: RawFormThankYouRule[];
  buttonLocation?: number;
  buttonLabel?: string;
  waitingLabel?: string;
};

export type RawFormField = {
  id?: string;
  label?: string;
  dataType?: string;
  defaultValue?: string;
  validationMessage?: unknown;
  rowNumber?: number;
  columnNumber?: number;
  maxLength?: number;
  required?: boolean;
  formPrefill?: boolean;
  fieldWidth?: number;
  labelWidth?: number;
  hintText?: string;
  instructions?: string;
  text?: string;
  fieldMetaData?: unknown;
  visibilityRules?: unknown;
};

export type RawFormThankYouPage = { id?: number; thankYouList?: RawFormThankYouRule[] };

export type RawSnippet = RawDesignStudioAsset;

/** Path segment used by the official Email Designer Asset API v2 endpoints. */
export type DesignerAssetKind = "email" | "emailtemplate" | "fragment";

/** Query accepted by Email Designer filter endpoints. */
export type DesignerFilterQuery = Query & {
  workspaceId: string;
  folderId?: string;
  folderType?: "Folder" | "Program";
  status?: string[];
  pageIndex?: number;
  pageSize?: number;
  name?: string;
  sortKey?: string;
  sortOrder?: "ASC" | "DESC";
  isCreatedByMe?: boolean;
  isModifiedByMe?: boolean;
  templateId?: string;
  fragmentType?: string;
  includeArchived?: boolean;
};

/** Raw workspace returned by the User Management API. */
export type RawWorkspace = {
  id?: string | number;
  name?: string;
  description?: string;
  status?: string;
};

/** Raw Email Designer asset after validation at the Marketo client boundary. */
export type RawDesignerAsset = {
  id?: string | number;
  name?: string;
  description?: string;
  status?: string;
  state?: string;
  appType?: string;
  appData?: {
    editorType?: string;
    workspaceId?: string | number;
    folderId?: string | number;
    programId?: string | number;
    programName?: string;
    programType?: string;
  };
  data?: { html?: { body?: string }; text?: { body?: string; syncFromHtml?: boolean } };
  headers?: {
    subject?: string;
    fromName?: string;
    fromEmail?: string;
    replyEmail?: string;
    preheader?: string;
    ccEmails?: string[];
  };
  settings?: {
    brandedDomain?: string;
    dedicatedIp?: string;
    enableUrlTracking?: boolean;
    isOperational?: boolean;
    isTextOnly?: boolean;
    isWebPageView?: boolean;
    disableOpenTracking?: boolean;
    fragmentType?: string;
    fragmentSubType?: string;
    supportedChannels?: string[];
  };
  templateId?: string | number;
  metadata?: { createdBy?: string; createdAt?: string; modifiedBy?: string; modifiedAt?: string };
};

/** Clone request shared by the three designer asset kinds. */
export type DesignerCloneRequest = { assetId: string; newAsset: { name: string; description?: string } };

/** Lifecycle request shared by the three designer asset kinds. */
export type DesignerStateTransition = {
  contentId: string;
  action: "approve" | "unapprove" | "discard" | "create_draft";
};

/** Used-by request shared by the three designer asset kinds. */
export type DesignerUsedByRequest = { assetId: string; pageIndex?: number; pageSize?: number; type?: string };

/** Raw dependency returned by a designer used-by endpoint. */
export type RawDesignerUsedBy = {
  id?: string | number;
  name?: string;
  channel?: string;
  contentType?: string;
  externalId?: string;
  appData?: { workspaceId?: string | number; folderId?: string | number };
};

/** Raw designer used-by result and paging metadata. */
export type RawDesignerUsedByResponse = {
  result: RawDesignerUsedBy[];
  pageDetails?: RawDesignerPage<never>;
};

function designerShapeError(label: string): MarketoError {
  return new MarketoError(`Marketo returned ${label} with an unexpected shape.`);
}

function designerRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw designerShapeError(label);
  return value;
}

function designerString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw designerShapeError(label);
  return value;
}

function designerBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw designerShapeError(label);
  return value;
}

function designerId(value: unknown, label: string): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw designerShapeError(label);
}

function designerStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw designerShapeError(label);
  return value.slice();
}

function designerPageNumber(value: unknown, label: string, operation?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new MarketoError(`Marketo returned designer page ${label} with an unexpected shape.`, { operation });
  }
  return Number(value);
}

function parseDesignerPageDetails(value: unknown, operation: string): RawDesignerPage<never> {
  let page = designerRecord(value, "designer page details");
  if (page.items !== undefined && (!Array.isArray(page.items) || page.items.length !== 0)) {
    throw new MarketoError("Marketo returned designer page details with unexpected items.", { operation });
  }
  let pageSize = designerPageNumber(page.pageSize, "pageSize", operation);
  if (pageSize === 0 || pageSize !== undefined && pageSize > 50) {
    throw new MarketoError("Marketo returned designer pageSize outside the supported range.", { operation });
  }
  return {
    totalItems: designerPageNumber(page.totalItems, "totalItems", operation),
    pageSize,
    currentPage: designerPageNumber(page.currentPage, "currentPage", operation),
  };
}

function parseWorkspace(value: unknown, label: string): RawWorkspace {
  let item = designerRecord(value, label);
  return {
    id: designerId(item.id, `${label} id`),
    name: designerString(item.name, `${label} name`),
    description: designerString(item.description, `${label} description`),
    status: designerString(item.status, `${label} status`),
  };
}

function parseDesignerAsset(value: unknown, label: string): RawDesignerAsset {
  let item = designerRecord(value, label);
  let appData = item.appData === undefined ? undefined : designerRecord(item.appData, `${label} appData`);
  let data = item.data === undefined ? undefined : designerRecord(item.data, `${label} data`);
  let html = data?.html === undefined ? undefined : designerRecord(data.html, `${label} HTML data`);
  let plain = data?.text === undefined ? undefined : designerRecord(data.text, `${label} text data`);
  let headers = item.headers === undefined ? undefined : designerRecord(item.headers, `${label} headers`);
  let settings = item.settings === undefined ? undefined : designerRecord(item.settings, `${label} settings`);
  let metadata = item.metadata === undefined ? undefined : designerRecord(item.metadata, `${label} metadata`);
  return {
    id: designerId(item.id, `${label} id`),
    name: designerString(item.name, `${label} name`),
    description: designerString(item.description, `${label} description`),
    status: designerString(item.status, `${label} status`),
    state: designerString(item.state, `${label} state`),
    appType: designerString(item.appType, `${label} appType`),
    appData: appData && {
      editorType: designerString(appData.editorType, `${label} editorType`),
      workspaceId: designerId(appData.workspaceId, `${label} workspaceId`),
      folderId: designerId(appData.folderId, `${label} folderId`),
      programId: designerId(appData.programId, `${label} programId`),
      programName: designerString(appData.programName, `${label} programName`),
      programType: designerString(appData.programType, `${label} programType`),
    },
    data: data && {
      html: html && { body: designerString(html.body, `${label} HTML body`) },
      text: plain && {
        body: designerString(plain.body, `${label} text body`),
        syncFromHtml: designerBoolean(plain.syncFromHtml, `${label} syncFromHtml`),
      },
    },
    headers: headers && {
      subject: designerString(headers.subject, `${label} subject`),
      fromName: designerString(headers.fromName, `${label} fromName`),
      fromEmail: designerString(headers.fromEmail, `${label} fromEmail`),
      replyEmail: designerString(headers.replyEmail, `${label} replyEmail`),
      preheader: designerString(headers.preheader, `${label} preheader`),
      ccEmails: designerStrings(headers.ccEmails, `${label} ccEmails`),
    },
    settings: settings && {
      brandedDomain: designerString(settings.brandedDomain, `${label} brandedDomain`),
      dedicatedIp: designerString(settings.dedicatedIp, `${label} dedicatedIp`),
      enableUrlTracking: designerBoolean(settings.enableUrlTracking, `${label} enableUrlTracking`),
      isOperational: designerBoolean(settings.isOperational, `${label} isOperational`),
      isTextOnly: designerBoolean(settings.isTextOnly, `${label} isTextOnly`),
      isWebPageView: designerBoolean(settings.isWebPageView, `${label} isWebPageView`),
      disableOpenTracking: designerBoolean(settings.disableOpenTracking, `${label} disableOpenTracking`),
      fragmentType: designerString(settings.fragmentType, `${label} fragmentType`),
      fragmentSubType: designerString(settings.fragmentSubType, `${label} fragmentSubType`),
      supportedChannels: designerStrings(settings.supportedChannels, `${label} supportedChannels`),
    },
    templateId: designerId(item.templateId, `${label} templateId`),
    metadata: metadata && {
      createdBy: designerString(metadata.createdBy, `${label} createdBy`),
      createdAt: designerString(metadata.createdAt, `${label} createdAt`),
      modifiedBy: designerString(metadata.modifiedBy, `${label} modifiedBy`),
      modifiedAt: designerString(metadata.modifiedAt, `${label} modifiedAt`),
    },
  };
}

function parseDesignerUsedBy(value: unknown, label: string): RawDesignerUsedBy {
  let item = designerRecord(value, label);
  let appData = item.appData === undefined ? undefined : designerRecord(item.appData, `${label} appData`);
  return {
    id: designerId(item.id, `${label} id`),
    name: designerString(item.name, `${label} name`),
    channel: designerString(item.channel, `${label} channel`),
    contentType: designerString(item.contentType, `${label} contentType`),
    externalId: designerString(item.externalId, `${label} externalId`),
    appData: appData && {
      workspaceId: designerId(appData.workspaceId, `${label} workspaceId`),
      folderId: designerId(appData.folderId, `${label} folderId`),
    },
  };
}

export type RawSnippetContent = { type?: string; content?: string };

export type RawFile = {
  id?: number;
  size?: number;
  mimeType?: string;
  url?: string;
  folder?: RawAssetFolder;
  name?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * A person field as returned by `leads/describe.json`. Note there is no per-field `searchable`
 * flag: which fields may be filtered on is reported separately by
 * {@link MarketoClient.getSearchablePersonFields}.
 */
export type RawLeadField = {
  id?: number;
  displayName?: string;
  dataType?: string;
  length?: number;
  rest?: { name?: string; readOnly?: boolean };
  soap?: { name?: string; readOnly?: boolean };
};

export type RawLead = { id?: number } & Record<string, unknown>;

export type RawSyncResult = {
  id?: number;
  status?: string;
  reasons?: { code?: string; message?: string }[];
  marketoGUID?: string;
};

export type RawList = {
  id?: number;
  name?: string;
  programName?: string;
  workspaceName?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type RawProgram = {
  id?: number;
  name?: string;
  description?: string;
  type?: string;
  channel?: string;
  status?: string;
  workspace?: string;
  /** Containing folder. The only reliable way to tell same-named programs apart. */
  folder?: { type?: string; value?: number; folderName?: string };
  tags?: RawProgramTag[] | null;
  startDate?: string;
  endDate?: string;
  headStart?: boolean;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type RawChannel = {
  id?: number;
  name?: string;
  applicableProgramType?: string;
  progressionStatuses?: { name?: string; step?: number }[];
};

/** Program tag returned on a program asset. */
export type RawProgramTag = { tagType?: string; tagValue?: string };

/** Program tag definition returned by Get Tag Types. */
export type RawTagType = {
  id?: number;
  name?: string;
  requiredFor?: string[];
  allowableValues?: string[];
};

export type RawToken = { name?: string; type?: string; value?: string };

export type RawCampaign = {
  id?: number;
  name?: string;
  programName?: string;
  workspaceName?: string;
  active?: boolean;
  isTriggerable?: boolean;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Smart campaign metadata returned by the Asset API. */
export type RawCampaignAsset = {
  id?: number;
  name?: string;
  description?: string;
  type?: string;
  status?: string;
  folder?: { id?: number; value?: number; type?: string };
  workspace?: string;
  isActive?: boolean;
  isRequestable?: boolean;
  smartListId?: number;
  flowId?: number;
  createdAt?: string;
  updatedAt?: string;
};

/** Smart-list definition attached to a campaign. */
export type RawSmartList = {
  id?: number;
  name?: string;
  rules?: {
    filterMatchType?: string;
    triggers?: RawSmartListRule[];
    filters?: RawSmartListRule[];
  };
};

/** Filter or trigger returned within a smart-list definition. */
export type RawSmartListRule = {
  id?: number;
  name?: string;
  ruleType?: string;
  operator?: string;
  conditions?: {
    activityAttributeName?: string;
    fieldName?: string;
    operator?: string;
    values?: unknown[];
    isPrimary?: boolean;
  }[];
};

export type RawActivityType = {
  id?: number;
  name?: string;
  description?: string;
  attributes?: { name?: string; dataType?: string }[];
};

export type RawActivity = {
  id?: number;
  marketoGUID?: string;
  leadId?: number;
  activityDate?: string;
  activityTypeId?: number;
  primaryAttributeValue?: string;
  attributes?: { name?: string; value?: unknown }[];
};

export type RawCustomObject = {
  name?: string;
  displayName?: string;
  description?: string;
  dedupeFields?: string[];
};

export type RawCustomObjectSchema = RawCustomObject & {
  fields?: RawCustomObjectField[];
  searchableFields?: string[][];
};

/** Standard business-object kinds and their endpoint path segments. */
export type MarketoBusinessObjectKind =
  | "company"
  | "opportunity"
  | "opportunityRole"
  | "salesPerson"
  | "namedAccount";

/** Low-level query accepted by the standard business-object endpoints. */
export type MarketoBusinessObjectApiQuery = {
  filter: { field: string; values: unknown[] } | { dedupeKeys: Record<string, unknown>[] };
  fields?: string[];
  pageToken?: string;
  maxResults?: number;
};

/** Raw describe response shared by companies, opportunities, roles, sales people, and named accounts. */
export type RawBusinessObjectSchema = {
  name?: string;
  displayName?: string;
  description?: string;
  idField?: string;
  dedupeFields?: string[];
  searchableFields?: string[][];
  crmManaged?: boolean;
  fields?: RawCustomObjectField[];
};

function businessObjectPath(kind: MarketoBusinessObjectKind): string {
  return ({
    company: "companies",
    opportunity: "opportunities",
    opportunityRole: "opportunities/roles",
    salesPerson: "salespersons",
    namedAccount: "namedaccounts",
  })[kind];
}

/**
 * A custom object's field, which is shaped differently from a person field: the API name sits at
 * the top level rather than under `rest`/`soap`, and writability is stated positively.
 */
export type RawCustomObjectField = {
  name?: string;
  displayName?: string;
  dataType?: string;
  length?: number;
  updateable?: boolean;
  crmManaged?: boolean;
};

export type RawUsage = {
  date?: string;
  total?: number;
  users?: { userId?: string; count?: number }[];
};
