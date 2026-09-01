// Environment and resource descriptors for the Marketo gatekeeper.

import type { AvatarImage, SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { z } from "zod";
import type { MarketoCredentials } from "./marketo-api";
import MARKETO_LOGO_SVG from "./marketo-logo.svg";
import { logger } from "./logger";

export type Env = Cloudflare.Env & {
  /** Public base URL this worker is served from, e.g.
   * `https://gadgets.example.com/gatekeeper/marketo`. */
  BASE_URL?: string;

  /** Default Marketo instance endpoint, e.g. `https://123-ABC-456.mktorest.com`. Only a default:
   * it pre-fills the connect form, and each account stores whatever endpoint its credentials
   * actually belong to. It does not affect the advertised resource URL patterns, which are
   * wildcarded across all subscriptions (see {@link ANY_INSTANCE_ORIGIN}). */
  MARKETO_ENDPOINT?: string;

  /** Default LaunchPoint Client ID, pre-filled into the connect form. Optional. */
  MARKETO_CLIENT_ID?: string;

  /**
   * Default LaunchPoint Client Secret, used when the connect form's secret field is left blank.
   * Optional, and deliberately never rendered into the form — a secret that is echoed back in HTML
   * is a secret in every browser cache and history along the way.
   *
   * Configuring this shares one Marketo service with everyone who can reach the connect route, so
   * it suits a single-team deployment and not a multi-tenant one. Store it with
   * `wrangler secret put`, never as a plaintext var.
   */
  MARKETO_CLIENT_SECRET?: string;
};

/** Non-secret values used to seed the connect form. */
export type MarketoConnectDefaults = {
  /** Endpoint origin to pre-fill, or "" when unset or unparseable. */
  endpoint: string;
  /** Client ID to pre-fill, or "" when unset. */
  clientId: string;
  /** Why the secret field may be left blank. Never contains the secret itself. */
  secretSource?: "account" | "deployment";
};

/** Read the optional connect-form defaults out of the environment. */
export function getDefaults(env: Env, existing?: MarketoCredentials): MarketoConnectDefaults {
  if (existing) {
    return { endpoint: existing.endpoint, clientId: existing.clientId, secretSource: "account" };
  }
  let endpoint = "";
  let configuredEndpoint = trimField(env.MARKETO_ENDPOINT);
  if (configuredEndpoint) {
    try {
      endpoint = normalizeEndpoint(configuredEndpoint);
    } catch (error) {
      logger.warn("invalid default endpoint ignored", {
        event: "invalid_default_endpoint",
        error: error instanceof Error ? error.name : typeof error,
      });
      // A malformed default is not worth failing the whole connect page over; the user can still
      // type a good one, and `normalizeEndpoint` will reject a bad one on submit.
    }
  }
  let clientId = trimField(env.MARKETO_CLIENT_ID);
  return {
    endpoint,
    clientId,
    ...(endpoint && clientId && trimField(env.MARKETO_CLIENT_SECRET)
      ? { secretSource: "deployment" as const }
      : {}),
  };
}

/**
 * Origin wildcard the advertised resource patterns are rooted at.
 *
 * The patterns must match every subscription, not one: the Workshop compares the *same* pattern
 * string across the vendor, each connected account, and the admin's disabled-resource list, so a
 * pattern rooted at one account's concrete origin would never line up with the others. Concrete
 * resource URLs still carry the real origin (see the `build*Url` helpers below); only the pattern
 * is wildcarded.
 */
const ANY_INSTANCE_ORIGIN = "https://*.mktorest.com";

/**
 * Normalize a user-supplied Marketo endpoint to a bare origin.
 *
 * Accepts what people actually paste — with or without scheme, with a trailing slash or a stray
 * `/rest` path — and throws on anything that isn't a plausible Marketo host.
 */
export function normalizeEndpoint(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) throw new Error("Marketo endpoint is required.");
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    throw new Error(`"${raw}" is not a valid Marketo endpoint URL.`, { cause: e });
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Marketo endpoint must use https.");
  }
  if (!/^[a-z0-9-]+\.mktorest\.com$/i.test(parsed.host)) {
    throw new Error(
      `"${parsed.host}" is not a Marketo REST host. Expected something like ` +
        "123-ABC-456.mktorest.com (Admin -> Integration -> Web Services -> REST API).",
    );
  }
  return parsed.origin;
}

function trimField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const ConnectCredentialsSchema = z.object({
  endpoint: z.string().trim().optional(),
  clientId: z.string().trim().max(512, "Client ID is too long.").optional(),
  clientSecret: z.string().trim().max(4096, "Client Secret is too long.").optional(),
});

/**
 * Validate and normalize the three fields the connect form submits.
 *
 * A stored or deployment-provided secret is used only with its own endpoint and Client ID. The
 * secret is read directly from storage or `env`; nothing passed to the browser contains it.
 */
export function parseCredentials(
  body: unknown,
  env: Env,
  existing?: MarketoCredentials,
): MarketoCredentials {
  let defaults = getDefaults(env, existing);
  let parsed = ConnectCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid connection details.");
  }
  let endpoint = normalizeEndpoint(parsed.data.endpoint || defaults.endpoint);
  let clientId = parsed.data.clientId || defaults.clientId;
  if (!clientId) throw new Error("Client ID is required.");
  if (existing && (endpoint !== existing.endpoint || clientId !== existing.clientId)) {
    throw new Error(
      "Reconnect must use the existing instance endpoint and Client ID. Disconnect this account " +
        "and create a new connection to use another LaunchPoint service.",
    );
  }

  let clientSecret = parsed.data.clientSecret ?? "";
  if (!clientSecret) {
    if (existing) {
      clientSecret = existing.clientSecret;
    } else if (
      defaults.secretSource === "deployment" &&
      endpoint === defaults.endpoint &&
      clientId === defaults.clientId
    ) {
      clientSecret = trimField(env.MARKETO_CLIENT_SECRET);
    } else if (defaults.secretSource === "deployment") {
      throw new Error(
        "Client Secret is required for a service other than this deployment's default. Restore " +
          "the pre-filled endpoint and Client ID to use the default, or supply the secret that " +
          "goes with the ones you entered.",
      );
    } else {
      throw new Error("Client Secret is required.");
    }
  }
  return { endpoint, clientId, clientSecret };
}

export function getBaseUrl(env: Env): string {
  let baseUrl = env.BASE_URL ?? "http://localhost:8787/gatekeeper/marketo";
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return baseUrl;
}

export function getBasePath(env: Env): string {
  let path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Branding

/** The vendor's home page, shown on the Connectors card. Not the REST endpoint, which is per-account. */
export const MARKETO_HOME_URL = "https://business.adobe.com/products/marketo/adobe-marketo.html";

export const MARKETO_ICON: AvatarImage = {
  url: `data:image/svg+xml;utf8,${encodeURIComponent(MARKETO_LOGO_SVG)}`,
};

// ---------------------------------------------------------------------------
// Resource granularities
//
// Concrete resource URLs are rooted at the origin of the Marketo instance they belong to, so two
// users on different subscriptions never produce colliding URLs, and `parseResourceUrl()` rejects
// a URL that doesn't belong to the account it is presented to. The advertised *patterns* are
// wildcarded (see ANY_INSTANCE_ORIGIN) so that the vendor, every account, and the admin's
// disabled-resource list all name a resource by the identical string. The `/_resource/...` prefix
// keeps the URLs from colliding with any real Marketo UI URL.

/** Whole-instance access: everything the connected service's role permits. */
export const INSTANCE_RESOURCE: SupportedResource = {
  urlPattern: `${ANY_INSTANCE_ORIGIN}/_resource/instance`,
  title: "Marketo Instance",
  description:
    "Full access to the Marketo instance: people, lists, programs, campaigns, activities, " +
    "standard and custom business objects, and all Design Studio assets.",
  icon: MARKETO_ICON,
};

/** A single program: its members, tokens, and membership progression. */
export const PROGRAM_RESOURCE: SupportedResource = {
  urlPattern: `${ANY_INSTANCE_ORIGIN}/_resource/program/:programId`,
  title: "Marketo Program",
  description:
    "Access to one Marketo program: read members and tokens; change membership statuses, metadata, " +
    "tags, and Email Program dates; approve or unapprove Email Programs; and permanently delete the program.",
  icon: MARKETO_ICON,
};

/** A single static list: its membership only. */
export const STATIC_LIST_RESOURCE: SupportedResource = {
  urlPattern: `${ANY_INSTANCE_ORIGIN}/_resource/list/:listId`,
  title: "Marketo Static List",
  description: "Access to one Marketo static list: read, add, and remove its members.",
  icon: MARKETO_ICON,
};

/** Broad Design Studio access without access to people, activities, programs, or campaigns. */
export const DESIGN_STUDIO_RESOURCE: SupportedResource = {
  urlPattern: `${ANY_INSTANCE_ORIGIN}/_resource/design-studio`,
  title: "Marketo Design Studio",
  description:
    "Read and create or clone Design Studio folders, emails, templates, landing pages, forms, " +
    "snippets, and files; mutate their content and metadata; publish drafts, which can propagate " +
    "changes into dependent assets; permanently discard drafts; and permanently delete assets " +
    "and empty folders.",
  icon: MARKETO_ICON,
};

/** Every resource granularity Marketo offers, in picker order. */
export const SUPPORTED_RESOURCES: SupportedResource[] =
  [INSTANCE_RESOURCE, DESIGN_STUDIO_RESOURCE, PROGRAM_RESOURCE, STATIC_LIST_RESOURCE];

/** The kinds of resource a binding can be scoped to. */
export type MarketoResourceKind = "instance" | "design-studio" | "program" | "list";

/** Parse a concrete resource URL into its kind and id. Throws if it isn't one of `origin`'s. */
export function parseResourceUrl(
  origin: string,
  url: string,
): { kind: MarketoResourceKind; id?: number } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error(`Invalid Marketo resource URL "${url}".`, { cause: e });
  }
  if (parsed.origin !== origin) {
    throw new Error(`URL "${url}" does not belong to this Marketo instance (${origin}).`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Unrecognized Marketo resource URL "${url}".`);
  }
  let segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] !== "_resource") {
    throw new Error(`Unrecognized Marketo resource URL "${url}".`);
  }
  switch (segments[1]) {
    case "instance":
      if (segments.length !== 2) throw new Error(`Invalid Marketo instance URL "${url}".`);
      return { kind: "instance" };
    case "design-studio":
      if (segments.length !== 2) throw new Error(`Invalid Marketo Design Studio URL "${url}".`);
      return { kind: "design-studio" };
    case "program": {
      let rawId = segments[2];
      if (segments.length !== 3 || !rawId || !/^[1-9]\d*$/.test(rawId)) {
        throw new Error(`Invalid Marketo program id in "${url}".`);
      }
      let id = Number(rawId);
      if (!Number.isSafeInteger(id)) throw new Error(`Invalid Marketo program id in "${url}".`);
      return { kind: "program", id };
    }
    case "list": {
      let rawId = segments[2];
      if (segments.length !== 3 || !rawId || !/^[1-9]\d*$/.test(rawId)) {
        throw new Error(`Invalid Marketo list id in "${url}".`);
      }
      let id = Number(rawId);
      if (!Number.isSafeInteger(id)) throw new Error(`Invalid Marketo list id in "${url}".`);
      return { kind: "list", id };
    }
    default:
      throw new Error(`Unsupported Marketo resource type "${segments[1]}".`);
  }
}

export function buildProgramUrl(origin: string, programId: number | string): string {
  return `${origin}/_resource/program/${encodeURIComponent(String(programId))}`;
}

export function buildListUrl(origin: string, listId: number | string): string {
  return `${origin}/_resource/list/${encodeURIComponent(String(listId))}`;
}

export function buildInstanceUrl(origin: string): string {
  return `${origin}/_resource/instance`;
}

/** Build the concrete broad Design Studio resource URL for one Marketo instance. */
export function buildDesignStudioUrl(origin: string): string {
  return `${origin}/_resource/design-studio`;
}
