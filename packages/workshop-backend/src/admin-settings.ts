import { AdminApi, AdminResourceVendor, AdminSettingsView, AmbientGatekeeperMode, BannerColor, BlueprintPublicInfo, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_SITE_NAME_LENGTH, isAmbientGatekeeperMode, isBannerColor, isHexColor } from '@gadgets/workshop-shared/api';
import { GatekeeperVendor } from '@gadgets/workshop-shared/gatekeeper';
import { DurableObject } from 'cloudflare:workers';
import { RpcTarget } from 'capnweb';
import { validateRpc } from 'capnweb-validate';
import { collection, createTypedStorage } from '@gadgets/typed-storage';
import { createWorkshopLogger } from "./logging";
import { ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, isReservedBlueprintKey, parseBlueprintKvRecord, serializeFeaturedBlueprints } from './blueprint-archive.js';
import { AdminConfig, DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from './admin-config.js';
import { ambientGatekeeperMode, DEFAULT_AMBIENT_GATEKEEPER_MODE } from './provisioning-policy.js';
import { buildGatekeeperVendorMap } from './auth/auth-vendors.js';
import { UserDurableObject } from './user.js';

const logger = createWorkshopLogger("workshop.admin.settings");

function makeAdminSettingsStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      // Mirror of the currently-featured blueprint public records. The user DO owns the
      // authoritative featured bit; this DO keeps the publishable deployment-wide copy.
      featuredBlueprints: collection<BlueprintPublicInfo>()({
        primaryKey: 'id',
      }),
    },
    singletons: {
      // Authoritative deployment admin config. Mirrored to BLUEPRINTS KV (ADMIN_CONFIG_KEY) so the
      // connect/login/agent hot paths can read it without touching this singleton DO.
      adminConfig: DEFAULT_ADMIN_CONFIG as AdminConfig,
    },
  });
}

type AdminSettingsStorage = ReturnType<typeof makeAdminSettingsStorage>;

// Deployment-wide admin settings singleton.
//
// This durable object is always addressed as `getByName("")`. It contains settings that only
// admins may modify. Settings modified through this DO are published to KV so that user requests
// do not have to access the AdminSettings DO directly (which they could otherwise overload), but
// having a singleton DO writing to KV avoids race conditions when updating KV.
export class AdminSettings extends DurableObject<Cloudflare.Env> {
  private storage: AdminSettingsStorage;
  private users: DurableObjectNamespace<UserDurableObject>;
  // Every bound gatekeeper, keyed by vendor id. Deployment-global (from env bindings), so admin
  // resource listing needs no user context.
  private vendors: Map<string, Service<GatekeeperVendor>>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeAdminSettingsStorage(ctx.storage);
    this.users = this.ctx.exports.UserDurableObject;
    this.vendors = buildGatekeeperVendorMap(env);
  }

  async #writeFeaturedSnapshot(): Promise<void> {
    let featured = [...this.storage.featuredBlueprints.list()];
    await this.env.BLUEPRINTS.put(FEATURED_BLUEPRINTS_KEY, serializeFeaturedBlueprints(featured));
  }

  // Reconcile the mirrored featured list to match the authoritative bit stored in the owner
  // User DO, while also refreshing stale metadata snapshots for featured entries.
  async #syncFeaturedMirror(publicInfo: BlueprintPublicInfo, featured: boolean): Promise<void> {
    let existing = this.storage.featuredBlueprints.get(publicInfo.id);
    let changed = false;

    if (!featured) {
      if (existing) {
        this.storage.featuredBlueprints.delete(publicInfo.id);
        changed = true;
      }
    } else if (
      !existing ||
      existing.metadata.version !== publicInfo.metadata.version ||
      existing.metadata.lastUpdated.valueOf() !== publicInfo.metadata.lastUpdated.valueOf()
    ) {
      this.storage.featuredBlueprints.put(publicInfo);
      changed = true;
    }

    if (changed) {
      await this.#writeFeaturedSnapshot();
    }
  }

  async #getOwnerBlueprint(blueprintId: string): Promise<{
    owner: DurableObjectStub<UserDurableObject>;
    publicInfo: BlueprintPublicInfo;
    featureable: boolean;
  }> {
    if (isReservedBlueprintKey(blueprintId)) {
      throw new Error('Blueprint not found.');
    }

    let raw = await this.env.BLUEPRINTS.get(blueprintId);
    if (!raw) {
      throw new Error('Blueprint not found.');
    }

    let kvRecord = parseBlueprintKvRecord(raw);
    let owner = this.users.get(this.users.idFromString(kvRecord.ownerId));

    return {
      owner,
      publicInfo: {
        id: blueprintId,
        metadata: kvRecord.metadata,
      },
      featureable: !!kvRecord.gadgetId,
    };
  }

  async isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable) {
      return null;
    }

    let featured = await owner.isBlueprintFeatured(blueprintId);
    if (featured === null) {
      return null;
    }

    // Heal partial failures before answering so admin reads never observe disagreement.
    await this.#syncFeaturedMirror(publicInfo, featured);
    return featured;
  }

  async setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    let { owner, publicInfo, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable) {
      throw new Error('Blueprint not featureable.');
    }

    await owner.setBlueprintFeatured(blueprintId, featured);
    await this.#syncFeaturedMirror(publicInfo, featured);
  }

  async syncFeaturedBlueprint(publicInfo: BlueprintPublicInfo): Promise<void> {
    // Overseer propagation calls this after blueprint updates so the mirror keeps up with the
    // latest published metadata, but only while the owner-side featured bit stays enabled.
    await this.#syncFeaturedMirror(publicInfo, true);
  }

  async deleteFeaturedBlueprint(blueprintId: string): Promise<void> {
    if (this.storage.featuredBlueprints.get(blueprintId)) {
      this.storage.featuredBlueprints.delete(blueprintId);
      await this.#writeFeaturedSnapshot();
    }
  }

  // --- Deployment admin config ---

  getAdminConfig(): AdminConfig {
    return this.storage.adminConfig.get();
  }

  // Merge a partial update into the admin config and mirror it to KV. Callers (AdminApiImpl) validate
  // scalar values; this just persists atomically.
  async updateAdminConfig(patch: Partial<AdminConfig>): Promise<void> {
    // Merge over DEFAULT_ADMIN_CONFIG so a config persisted before a field was added gets that field
    // backfilled on the next write (rather than carrying the stale shape forward).
    let next = { ...DEFAULT_ADMIN_CONFIG, ...this.storage.adminConfig.get(), ...patch };
    this.storage.adminConfig.put(next);
    await this.env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig(next));
  }

  // Read all admin-managed settings for the admin UI in one call: the stored config plus the live
  // resource catalog (every bound gatekeeper's resource types annotated with their enabled state).
  //
  // `adminUserId` is the requesting admin's user id (email/username), forwarded to each gatekeeper's
  // getSupportedResources(). Most gatekeepers ignore it, but RBAC-gated ones (e.g. the internal GTM
  // Data gatekeeper) only reveal their resources to users with the right permission — so without it
  // they'd be hidden from the admin Gatekeepers tab.
  async getSettings(adminUserId: string): Promise<AdminSettingsView> {
    // Fill in any fields missing from a config persisted before they were added (e.g.
    // ambientGatekeeperModes), so reads are robust without requiring a prior write.
    let config = { ...DEFAULT_ADMIN_CONFIG, ...this.storage.adminConfig.get() };
    return {
      signupsEnabled: config.signupsEnabled,
      siteName: config.siteName,
      instanceInstructions: config.instanceInstructions,
      announcement: config.announcement,
      banner: config.banner,
      accentColor: config.accentColor,
      resourceVendors: await this.#listResourceConfig(config, adminUserId),
    };
  }

  // Enable/disable a single gatekeeper resource type atomically (read-modify-write within the DO).
  async setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let map = { ...this.storage.adminConfig.get().disabledResources };
    let disabled = new Set(map[vendorId] ?? []);
    if (enabled) disabled.delete(urlPattern); else disabled.add(urlPattern);
    if (disabled.size === 0) delete map[vendorId]; else map[vendorId] = [...disabled];
    await this.updateAdminConfig({ disabledResources: map });
  }

  // Set a gatekeeper's availability atomically (read-modify-write within the DO). Routes by kind: an
  // auto-provisioning ("ambient") gatekeeper stores its three-state mode in ambientGatekeeperModes
  // (default stored as absence); an ordinary gatekeeper stores a binary enabled/disabled in
  // disabledGatekeepers and rejects the ambient-only 'optional'.
  async setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let vendor = this.vendors.get(vendorId);
    let autoProvisions = !!vendor && (await vendor.describe()).autoProvisionsAccount === true;
    if (autoProvisions) {
      let modes = { ...this.storage.adminConfig.get().ambientGatekeeperModes };
      if (mode === DEFAULT_AMBIENT_GATEKEEPER_MODE) delete modes[vendorId]; else modes[vendorId] = mode;
      await this.updateAdminConfig({ ambientGatekeeperModes: modes });
    } else {
      if (mode === "optional") {
        throw new Error(`"${vendorId}" is not an auto-provisioning gatekeeper; use 'enabled' or 'disabled'.`);
      }
      let disabled = new Set(this.storage.adminConfig.get().disabledGatekeepers);
      if (mode === "enabled") disabled.delete(vendorId); else disabled.add(vendorId);
      await this.updateAdminConfig({ disabledGatekeepers: [...disabled] });
    }
  }

  // Admin view of every bound gatekeeper's resource types, annotated with their enabled state.
  // Unlike the user-facing listGatekeeperVendors, this does NOT hide disabled resources (so admins
  // can re-enable them). `adminUserId` is forwarded to getSupportedResources() so RBAC-gated
  // gatekeepers still surface for an admin who has access to them.
  async #listResourceConfig(config: AdminConfig, adminUserId: string): Promise<AdminResourceVendor[]> {
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<AdminResourceVendor | null>[] = [];
    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources({ userId: adminUserId }),
          ]);
          if (description.autoProvisionsAccount) {
            // Auto-provisioning ("ambient") gatekeeper: a three-state mode, no resources to toggle.
            let mode = ambientGatekeeperMode(config, id);
            return {
              vendorId: id,
              displayName: description.displayName,
              logo: description.logo,
              autoProvisions: true,
              ambientMode: mode,
            };
          }
          if (supportedResources.length === 0) {
            // Nothing to toggle for this gatekeeper.
            return null;
          }
          let disabled = new Set(config.disabledResources[id] ?? []);
          return {
            vendorId: id,
            displayName: description.displayName,
            logo: description.logo,
            autoProvisions: false,
            enabled: !disabledGatekeeperSet.has(id),
            resources: supportedResources.map(r => ({
              urlPattern: r.urlPattern,
              title: r.title,
              description: r.description,
              icon: r.icon,
              enabled: !disabled.has(r.urlPattern),
            })),
          };
        } catch (err) {
          logger.warn("failed to read resource config for gatekeeper", {
            event: "gatekeeper.resource.config.read.failed", gatekeeperId: id, error: err,
          });
          return null;
        }
      })());
    }

    let vendors = (await Promise.all(promises)).filter((v): v is AdminResourceVendor => v !== null);
    // Show auto-provisioned ("ambient") gatekeepers first; preserve the existing order otherwise.
    vendors.sort((a, b) => Number(b.autoProvisions) - Number(a.autoProvisions));
    return vendors;
  }
}

// Capability for managing deployment-wide admin settings, obtained via
// AuthenticatedApi.getAdminApi() (which is null for non-admins). The admin access check happens once
// when the capability is minted in server.ts, so these methods don't re-check. This is a thin
// validation+forwarding facade over the AdminSettings DO — fully user-independent — so a disabled
// gatekeeper/resource can't be re-enabled via a crafted request, and the client never receives a
// stub to the DO's internal methods. Covers branding, agent instructions, signups, and gatekeeper
// connector/resource availability; authentication config stays env-var driven.
@validateRpc()
export class AdminApiImpl extends RpcTarget implements AdminApi {
  // `adminUserId` is the requesting admin's identity, forwarded to gatekeepers when listing the
  // resource catalog (some are RBAC-gated per user). It's plain data — not a user-DO dependency.
  constructor(private admin: DurableObjectStub<AdminSettings>, private adminUserId: string) {
    super();
  }

  getSettings(): Promise<AdminSettingsView> {
    return this.admin.getSettings(this.adminUserId);
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await this.admin.updateAdminConfig({ signupsEnabled: enabled });
  }

  async setSiteName(name: string): Promise<void> {
    if (name.length > MAX_SITE_NAME_LENGTH) {
      throw new Error(`Site name too long (max ${MAX_SITE_NAME_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ siteName: name });
  }

  async setInstanceInstructions(text: string): Promise<void> {
    if (text.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH) {
      throw new Error(`Instructions too long (max ${MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ instanceInstructions: text });
  }

  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    return this.admin.setResourceEnabled(vendorId, urlPattern, enabled);
  }

  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    if (!isAmbientGatekeeperMode(mode)) {
      throw new Error(`Invalid gatekeeper mode: ${mode}`);
    }
    return this.admin.setGatekeeperMode(vendorId, mode);
  }

  async setAnnouncement(text: string): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Announcement too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ announcement: text });
  }

  async setBanner(text: string, color: BannerColor): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Banner too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    if (!isBannerColor(color)) {
      throw new Error(`Invalid banner color: ${color}`);
    }
    await this.admin.updateAdminConfig({ banner: { text, color } });
  }

  async setAccentColor(color: string): Promise<void> {
    if (color !== "" && !isHexColor(color)) {
      throw new Error(`Invalid accent color: ${color}`);
    }
    await this.admin.updateAdminConfig({ accentColor: color });
  }

  isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    return this.admin.isBlueprintFeatured(blueprintId);
  }

  setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    return this.admin.setBlueprintFeatured(blueprintId, featured);
  }
}
