// Deployment-wide admin configuration: a single object owned by the AdminSettings durable object and
// mirrored to one reserved BLUEPRINTS KV key, so the per-(re)connect getServerConfig() path and the
// agent can resolve it with a single cheap KV get.
//
// This covers the "soft" deployment customizations only (branding, agent instructions, and which
// gatekeeper connectors/resources are offered). Authentication/authorization config (sign-in
// providers, password login) is deliberately NOT here — it stays env-var driven so it can't be
// changed by a compromised admin session. Everything here is enabled by default; the admin UI opts
// things *out*.

import { AmbientGatekeeperMode, BannerConfig, DEFAULT_BANNER_COLOR, isAmbientGatekeeperMode, isBannerColor } from "@gadgets/workshop-shared/api";
import { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_CONFIG_KEY } from "./blueprint-archive.js";

export type AdminConfig = {
  // Whether new account signups are allowed (default true). Note: this is an access toggle, not
  // authentication config — which auth providers exist and whether password login is on stay
  // env-driven (see auth/config.ts).
  signupsEnabled: boolean;
  // Site name shown next to the top-bar logo, or "" to use the default ("gadgets").
  siteName: string;
  // Extra instructions appended to the agent system prompt.
  instanceInstructions: string;
  // Centered top-bar notice. Markdown.
  announcement: string;
  // Full-width banner (text + accent color).
  banner: BannerConfig;
  // Accent (brand) color hex, or "" for the default theme.
  accentColor: string;
  // Disabled gatekeeper resources: vendorId -> disabled resource urlPatterns.
  disabledResources: Record<string, string[]>;
  // Fully-disabled gatekeeper vendor ids.
  disabledGatekeepers: string[];
  // Per-vendor provisioning mode for auto-provisioning ("ambient") gatekeepers (e.g. the Context
  // Library). Absent ⇒ the default ("optional", see provisioning-policy.ts). Only meaningful for
  // vendors that declare autoProvisionsAccount.
  ambientGatekeeperModes: Record<string, AmbientGatekeeperMode>;
};

export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  signupsEnabled: true,
  siteName: "",
  instanceInstructions: "",
  announcement: "",
  banner: { text: "", color: DEFAULT_BANNER_COLOR },
  accentColor: "",
  disabledResources: {},
  disabledGatekeepers: [],
  ambientGatekeeperModes: {},
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parseAdminConfig(raw: string | null): AdminConfig {
  if (!raw) return { ...DEFAULT_ADMIN_CONFIG };
  try {
    let p = JSON.parse(raw) as Partial<AdminConfig>;
    let disabledResources: Record<string, string[]> = {};
    if (p.disabledResources && typeof p.disabledResources === "object") {
      for (let [vendorId, patterns] of Object.entries(p.disabledResources)) {
        let list = strings(patterns);
        if (list.length > 0) disabledResources[vendorId] = list;
      }
    }
    let ambientGatekeeperModes: Record<string, AmbientGatekeeperMode> = {};
    if (p.ambientGatekeeperModes && typeof p.ambientGatekeeperModes === "object") {
      for (let [vendorId, mode] of Object.entries(p.ambientGatekeeperModes)) {
        if (isAmbientGatekeeperMode(mode)) ambientGatekeeperModes[vendorId.toLowerCase()] = mode;
      }
    }
    return {
      signupsEnabled: typeof p.signupsEnabled === "boolean" ? p.signupsEnabled : true,
      siteName: typeof p.siteName === "string" ? p.siteName : "",
      instanceInstructions: typeof p.instanceInstructions === "string" ? p.instanceInstructions : "",
      announcement: typeof p.announcement === "string" ? p.announcement : "",
      banner: {
        text: typeof p.banner?.text === "string" ? p.banner.text : "",
        color: isBannerColor(p.banner?.color) ? p.banner!.color : DEFAULT_BANNER_COLOR,
      },
      accentColor: typeof p.accentColor === "string" ? p.accentColor : "",
      disabledResources,
      disabledGatekeepers: strings(p.disabledGatekeepers).map(v => v.toLowerCase()),
      ambientGatekeeperModes,
    };
  } catch {
    return { ...DEFAULT_ADMIN_CONFIG };
  }
}

export function serializeAdminConfig(config: AdminConfig): string {
  return JSON.stringify(config);
}

// Read the admin config from the KV mirror. Cheap enough for the hot path (a single KV get).
export async function readAdminConfig(env: Cloudflare.Env): Promise<AdminConfig> {
  return parseAdminConfig(await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY));
}

// --- Resource-disable helpers ---

export function isResourceDisabled(
    config: AdminConfig, vendorId: string, urlPattern: string): boolean {
  return config.disabledResources[vendorId]?.includes(urlPattern) ?? false;
}

export function filterEnabledResources(
    config: AdminConfig, vendorId: string, resources: SupportedResource[]): SupportedResource[] {
  let disabled = config.disabledResources[vendorId];
  if (!disabled || disabled.length === 0) return resources;
  return resources.filter(r => !disabled.includes(r.urlPattern));
}

// --- Agent system-prompt instructions ---

// Wrap the admin instructions in a clearly-delimited block for the system prompt, or "" when unset.
// Callers are responsible for separating this from the preceding prompt with a blank line.
export function formatInstanceInstructions(instructions: string): string {
  let trimmed = instructions.trim();
  if (!trimmed) return "";
  return `# Deployment-specific instructions\n\n` +
      `The administrator of this deployment has provided the following additional instructions. ` +
      `Follow them unless they conflict with the user's safety or the instructions above.\n\n` +
      `<deployment_instructions>\n${trimmed}\n</deployment_instructions>`;
}
