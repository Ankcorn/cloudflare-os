import { RpcStub } from "capnweb";
import { GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, SUGGESTED_MODELS, ConnectedAccountsSubscriber, GatekeeperVendorFilter, GadgetMetadata, BlueprintMetadata, BlueprintLibrarySummary, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX } from '@gadgets/workshop-shared/api';
import { Gatekeeper, GatekeeperUser, GatekeeperVendor, AccountDescription, VendorDescription, VendorScope, GatekeeperConnectCallback, SupportedResource, ResourceConfiguratorFrame } from "@gadgets/workshop-shared/gatekeeper";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { getAiGatewayConfig } from "./ai-gateway.js";
import { utcDayKey, nextUtcMidnightIso, DailyQuotaResult } from "./ai-gateway-billing/limits/config.js";
import type { AdminSettings } from "./admin-settings.js";
import { isReservedBlueprintKey, readBlueprintKvRecord } from "./blueprint-archive.js";

type ConnectedAccountRecord = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  description: AccountDescription;
  vendorId: string;   // Derived from the GATEKEEPER_ binding name (e.g. "google", "email").
  credentialExpiresAt?: Date;    // When credentials are expected to expire, if known.
  credentialsExpired?: boolean;  // Set true by async notification from gatekeeper.
};

function areCredentialsValid(record: ConnectedAccountRecord): boolean {
  if (record.credentialsExpired) return false;
  if (record.credentialExpiresAt && record.credentialExpiresAt.valueOf() < Date.now()) return false;
  return true;
}

// Vendor id of the Cloudflare gatekeeper (the suffix of GATEKEEPER_CLOUDFLARE, lowercased). The AI
// Gateway billing flow is Cloudflare-specific, so several places key off this literal.
export const CLOUDFLARE_VENDOR_ID = "cloudflare";

export type UserAiModelRecord = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: UserAiModelRecord;
  quickModel?: AiModelConfig;
}

type LoginSessionRecord = {
  tokenId: string,  // sha256 hash of token, hex-formatted
  created: Date,
}

// Blueprint record stored in the user's `blueprints` collection.
type BlueprintUserRecord = {
  id: string;
  metadata: BlueprintMetadata;
  gadgetId?: string;
  // Source of truth for whether the blueprint is featured deployment-wide.
  featured?: boolean;
};

type LibraryBlueprintRecord = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
};

type GadgetRecord = GadgetMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // GadgetMetadata).
};

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

// AI Gateway billing state for the optional top-up flow: which Cloudflare account to bill and a
// cached credit balance. The OAuth tokens themselves live in the connected Cloudflare *gatekeeper*
// account (vendorId "cloudflare"); billing reads a usable token from there via getUsableAccessToken.
type CloudflareBilling = {
  // Selected account, once chosen (auto-selected when the grant sees exactly one).
  accountId?: string;
  accountName?: string;
  // Cached credit balance (USD) and when it was last fetched (unix ms).
  creditsRemaining?: number | null;
  creditsUpdatedAt?: number;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

function makeUserStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      aiModels: collection<UserAiModelRecord>()({
        primaryKey: record => record.profile.id,
      }),
      gadgets: collection<GadgetRecord>()({
        primaryKey: "id"
      }),
      connectedAccounts: collection<ConnectedAccountRecord>()({
        primaryKey: "id"
      }),
      sessions: collection<LoginSessionRecord>()({
        primaryKey: "tokenId",
      }),
      blueprints: collection<BlueprintUserRecord>()({
        primaryKey: "id",
      }),
      libraryBlueprints: collection<LibraryBlueprintRecord>()({
        primaryKey: "id",
      }),
    },
    singletons: {
      // AI Gateway billing state (selected account + cached balance) for the optional top-up flow;
      // null until a Cloudflare account is connected and resolved.
      cloudflareBilling: <CloudflareBilling | null>null,

      created: false,
      profile: <AiChatAuthorInfo>{
        type: "user",
        name: "User",
        id: "user@example.com",
      },
      quickModel: <string | null>null,
      preferredModel: <string | null>null,
      onboardingCompleted: false,
      nextAccountId: 0,
      pinnedBlueprints: <string[]>[],

      // Per-user free-tier daily LLM-call counter (only used when ENABLE_CLOUDFLARE_LIMITS is on).
      // Stores the current UTC day and the calls made that day; a stale `day` implicitly resets the
      // count. Folds the former standalone RateLimitDO into the user object.
      dailyLlmCount: <{ day: string; count: number } | null>null,

      // `passwordHash` value as passed to `login()`, but with an extra round of SHA-256 applied.
      //
      // null = password disabled (e.g. because some other auth mechanism is used)
      passwordHashHash: <Uint8Array | null>null,
    }
  });
}

type UserStorage = ReturnType<typeof makeUserStorage>;

async function checkGatekeeperVendorFilter(
    vendor: Service<GatekeeperVendor> | Service<GatekeeperUser>,
    filter: GatekeeperVendorFilter): Promise<boolean> {
  try {
    if (filter.resourceUrl) {
      let resources = await vendor.getSupportedResources();
      let matched = false;
      for (let resource of resources) {
        if (typeof resource.urlPattern !== "string") {
          // Guard against gatekeepers returning a non-string urlPattern for now.
          //
          // TODO: Consider whether this is the API we want for getSupportedResources(). Is URLPattern
          //   even the right thing?
          throw new Error("Gatekeeper returned non-string urlPattern from getSupportedResources()");
        }

        if (new URLPattern(resource.urlPattern).test(filter.resourceUrl)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    return true;
  } catch (err) {
    // This function is called when iterating over several gatekeepers to filter them. If one of
    // them throws we don't want to block the whole list, so instead log the error and assume this
    // gatekeeper should be filtered.
    console.error(err);
    return false;
  }
}

// Durable Object that stores information about a user.
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private vendors: Map<string, Service<GatekeeperVendor>>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    // Migrate data created prior to the minions -> gadgets rename.
    // TODO(cleanup): Eventually remove this, very few people ever used it as "minions".
    for (let [key, value] of [...ctx.storage.kv.list({prefix: "minions:"})]) {
      let newKey = "gadgets:" + key.slice("minions:".length);
      ctx.storage.kv.put(newKey, value);
      ctx.storage.kv.delete(key);
    }

    this.storage = makeUserStorage(ctx.storage);
    this.adminSettings = this.ctx.exports.AdminSettings;

    this.vendors = new Map;

    for (let bindingName in env) {
      if (bindingName.startsWith("GATEKEEPER_")) {
        let vendorId = bindingName.slice("GATEKEEPER_".length).toLowerCase();
        this.vendors.set(vendorId, (<any>this.env)[bindingName]);
      }
    }
  }

  async authenticate(token: string): Promise<void> {
    let tokenBytes = Uint8Array.fromBase64(token);
    let hash = await crypto.subtle.digest('SHA-256', tokenBytes);
    let tokenId = new Uint8Array(hash).toHex();
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw new Error("invalid session token");
    }
  }

  // Returns true when this login created the account on first use.
  async authenticateFromCfAccess(email: string): Promise<boolean> {
    if (!this.storage.created.get()) {
      // Create on first use.
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
      return true;
    }

    return false;
  }

  async #newSessionToken(): Promise<string> {
    let sessionToken = new Uint8Array(32);
    crypto.getRandomValues(sessionToken);

    let tokenId = new Uint8Array(await crypto.subtle.digest('SHA-256', sessionToken)).toHex();
    this.storage.sessions.put({ tokenId, created: new Date() });

    return sessionToken.toBase64();
  }

  async login(passwordHash: Uint8Array): Promise<string | null> {
    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));

    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      return null;
    }

    if (!bytesEqual(passwordHashHash, actualHashHash)) {
      return null;
    }

    return this.#newSessionToken();
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.storage.created.get()) {
      return null;
    }

    // Do a little migration here for old data.
    // TODO(soon): Delete this.
    for (let gadget of [...this.storage.gadgets.list()]) {
      if (!gadget.created || !gadget.lastActive) {
        if (!gadget.created) {
          gadget.created = new Date("2026-01-01");
        }
        if (!gadget.lastActive) {
          gadget.lastActive = new Date("2026-01-01");;
        }
        this.storage.gadgets.put(gadget);
      }
    }

    this.storage.created.put(true);
    this.storage.profile.put({
      type: "user",
      name: displayName,
      id: username,
    });

    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));
    this.storage.passwordHashHash.put(passwordHashHash);

    return this.#newSessionToken();
  }

  // Log in via an authentication gatekeeper, creating the account on first use. The user DO is keyed
  // by the verified email (this DO's id derives from idFromName(email)), so `email` is also used as
  // the profile id and the initial display name is the email's local-part — consistent with the
  // Cloudflare Access flow. Password login is left disabled for these accounts. Returns the session
  // secret to store client-side.
  //
  // The profile is written only on first sign-in. We intentionally do NOT refresh the display name
  // on later logins: once set, the name is the user's to change (via setOwnDisplayName), so we don't
  // clobber a customized name with the email local-part.
  async loginOrCreateViaGatekeeper(email: string): Promise<string> {
    if (!this.storage.created.get()) {
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
    }
    return this.#newSessionToken();
  }

  // Whether this account has a password set (false for gatekeeper sign-in accounts).
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  async changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      throw new Error("This account does not use password login.");
    }

    let oldHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', oldHash));
    if (!bytesEqual(oldHashHash, actualHashHash)) {
      throw new Error("Incorrect password.");
    }

    let newHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', newHash));
    this.storage.passwordHashHash.put(newHashHash);
  }

  async whoami(): Promise<AiChatAuthorInfo> {
    return this.storage.profile.get();
  }

  // Like whoami(), but returns null if the account was never initialized.
  async whoamiIfExists(): Promise<AiChatAuthorInfo | null> {
    if (!this.storage.created.get()) {
      return null;
    }
    return this.storage.profile.get();
  }

  // Called by the overseer every time a collaborator opens a shared gadget.
  // Creates the record on first open; updates lastActive on subsequent opens.
  async recordSharedGadgetOpen(
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo
  ): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && !record.owner) {
      throw new Error("User owns this Gadget; it's not shared with them.");
    }
    let now = new Date();
    if (record) {
      // Already tracked -- update lastActive and cached fields.
      record.lastActive = now;
      record.title = title;
      record.owner = ownerProfile;
      this.storage.gadgets.put(record);
    } else {
      // First time opening this shared gadget.
      this.storage.gadgets.put({
        id: gadgetId,
        title,
        owner: ownerProfile,
        created: now,
        lastActive: now,
      });
    }
  }

  // Removes a shared gadget from the user's home page listing. Does not revoke access.
  async dismissSharedGadget(gadgetId: string): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && record.owner) {
      this.storage.gadgets.delete(gadgetId);
    }
  }

  async setOwnDisplayName(name: string): Promise<void> {
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    let result: AiChatAuthorInfo[] = [];

    // When AI Gateway mode is active, include all suggested models for enabled providers.
    let gwConfig = getAiGatewayConfig(this.env);
    let gwModelIds = new Set<string>();
    if (gwConfig) {
      for (let entry of gwConfig.getModelList()) {
        result.push(entry);
        gwModelIds.add(entry.id);
      }
    }

    // Also include user-configured models, skipping any that duplicate a gateway model.
    for (let model of this.storage.aiModels.list()) {
      if (!gwModelIds.has(model.profile.id)) {
        result.push(model.profile);
      }
    }
    return result;
  }

  async addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig && !gwConfig.providers.has(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }

    profile.type = "agent";
    this.storage.aiModels.put({profile, config});
  }

  async deleteModel(id: string): Promise<void> {
    // In AI Gateway mode, don't allow deleting built-in suggested models.
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
        if (gwConfig.providers.has(provider) && id in models) {
          throw new Error(`Cannot delete built-in model "${models[id]}".`);
        }
      }
    }

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    this.storage.quickModel.put(id);
  }

  async getQuickModel(): Promise<null | string> {
    let result = this.storage.quickModel.get();
    if (result && this.storage.aiModels.get(result)) {
      return result;
    } else {
      return null;
    }
  }

  async getPreferredModel(): Promise<string | null> {
    return this.storage.preferredModel.get();
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      // Validate that the model exists in the user's configured models or as a gateway model.
      let gwConfig = getAiGatewayConfig(this.env);
      let exists = !!this.storage.aiModels.get(id) || !!gwConfig?.resolveModel(id);
      if (!exists) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get();
  }

  async completeOnboarding(): Promise<void> {
    this.storage.onboardingCompleted.put(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Cloudflare account connection (optional top-up flow).
  // ---------------------------------------------------------------------------------------------

  // Return the connected Cloudflare *gatekeeper* account stub, if any. The AI Gateway billing flow
  // narrows it to CloudflareGatekeeperUser to obtain a usable access token. Null if the user hasn't
  // connected (or signed in with) Cloudflare.
  async getCloudflareGatekeeperAccount(): Promise<Fetcher<CloudflareGatekeeperUser> | null> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try { rec = this.storage.connectedAccounts.get(id); } catch { continue; }
      if (rec && rec.vendorId === CLOUDFLARE_VENDOR_ID) {
        return rec.account as unknown as Fetcher<CloudflareGatekeeperUser>;
      }
    }
    return null;
  }

  // The AI Gateway billing state (selected account + cached balance), or null if unset.
  async getCloudflareBilling(): Promise<CloudflareBilling | null> {
    return this.storage.cloudflareBilling.get();
  }

  // Update the cached credit balance for the billed account.
  async updateCloudflareCredits(creditsRemaining: number | null): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.creditsRemaining = creditsRemaining;
    record.creditsUpdatedAt = Date.now();
    this.storage.cloudflareBilling.put(record);
  }

  // Persist which Cloudflare account to bill. Clears the cached credit balance (it belonged to the
  // old account).
  async setCloudflareAccountSelection(accountId: string, accountName?: string): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.accountId = accountId;
    record.accountName = accountName;
    record.creditsRemaining = undefined;
    record.creditsUpdatedAt = undefined;
    this.storage.cloudflareBilling.put(record);
  }

  // ---------------------------------------------------------------------------------------------
  // Free-tier daily LLM-call counter (folded in from the former standalone RateLimitDO). Only used
  // when ENABLE_CLOUDFLARE_LIMITS is on. Single-threaded DO execution makes the read-modify-write
  // race-free; the window resets at UTC midnight when the stored day no longer matches.
  // ---------------------------------------------------------------------------------------------

  #dailyUsed(day: string): number {
    let record = this.storage.dailyLlmCount.get();
    return record && record.day === day ? record.count : 0;
  }

  // Read the current daily quota state without counting a call.
  async checkDailyLlmCount(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    return { withinLimits: used < limit, remaining: Math.max(0, limit - used), limit, used,
             resetAt: nextUtcMidnightIso() };
  }

  // Atomically check the daily limit and, if within it, count one call. `withinLimits` is the
  // pre-count decision; `used`/`remaining` reflect the state AFTER counting. No-ops once exhausted,
  // so a blocked request never counts.
  async consumeDailyLlmCall(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    if (used >= limit) {
      return { withinLimits: false, remaining: 0, limit, used, resetAt: nextUtcMidnightIso() };
    }
    let newUsed = used + 1;
    this.storage.dailyLlmCount.put({ day, count: newUsed });
    return { withinLimits: true, remaining: Math.max(0, limit - newUsed), limit, used: newUsed,
             resetAt: nextUtcMidnightIso() };
  }

  // DO NOT MAKE PUBLIC -- returns API keys.
  async getChatContext(modelId: string | null): Promise<UserChatContext> {
    let gwConfig = getAiGatewayConfig(this.env);

    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      // In AI Gateway mode, resolve gateway models first.
      if (gwConfig) {
        result.aiModel = gwConfig.resolveModel(modelId);
      }
      if (!result.aiModel) {
        result.aiModel = this.storage.aiModels.get(modelId);
      }
      if (!result.aiModel) throw new Error(`No such model: ${modelId}`);
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    if (gwConfig) {
      // In AI Gateway mode, always use the hardcoded quick model.
      result.quickModel = gwConfig.getQuickModelConfig();
    } else {
      let quickModelId = this.storage.quickModel.get();
      if (quickModelId) {
        let quickModel = this.storage.aiModels.get(quickModelId);
        if (quickModel) {
          result.quickModel = quickModel.config;
        }
      }
    }
    return result;
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    let result: GadgetMetadataWithTimestamps[] = [];
    for (let gadget of this.storage.gadgets.list()) {
      if (isFullyCreated(gadget)) {
        result.push(gadget);
      }
    }
    return result;
  }

  async updateTitle(gadgetId: string, title: string) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such gadget belonging to user.");
    }
    record.title = title;
    this.storage.gadgets.put(record);
  }

  async updatePinned(gadgetId: string, pinned: boolean) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such gadget belonging to user.");
    }
    record.pinned = pinned;
    this.storage.gadgets.put(record);
  }

  async getGadget(id: string): Promise<GadgetMetadata | null> {
    return this.storage.gadgets.get(id) || null;
  }

  async newGadget(id: string, title: string): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created});
  }

  async setGadgetLastActive(id: string, time: Date, totalCost: number | undefined): Promise<void> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget) {
      gadget.lastActive = time;
      if (totalCost) {
        gadget.totalCost = totalCost;
      }
      this.storage.gadgets.put(gadget);
    }
  }

  async deleteGadget(id: string): Promise<void> {
    this.storage.gadgets.delete(id);
  }

  // --- Blueprint methods (called by Overseer during propagation) ---

  async updateBlueprint(id: string, metadata: BlueprintMetadata, gadgetId: string): Promise<boolean> {
    let existing = this.storage.blueprints.get(id);
    // Preserve the featured bit across metadata-only/code updates.
    let featured = existing?.featured === true;
    this.storage.blueprints.put({id, metadata, gadgetId, featured});
    return featured;
  }

  async importBlueprint(id: string, metadata: BlueprintMetadata): Promise<void> {
    this.storage.libraryBlueprints.put({
      id,
      metadata,
      addedAt: new Date(),
      uploaded: true,
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
    this.storage.blueprints.delete(id);
    this.storage.pinnedBlueprints.put(
      this.storage.pinnedBlueprints.get().filter(existing => existing !== id));
  }

  isBlueprintPinned(id: string): boolean {
    return this.storage.pinnedBlueprints.get().includes(id);
  }

  async setBlueprintPinned(id: string, pinned: boolean): Promise<void> {
    let pinnedBlueprints = this.storage.pinnedBlueprints.get().filter(existing => existing !== id);

    if (pinned) {
      if (!this.storage.blueprints.get(id) && !this.storage.libraryBlueprints.get(id)) {
        await this.addBlueprintToLibrary(id);
      }
      pinnedBlueprints.unshift(id);
    }

    this.storage.pinnedBlueprints.put(pinnedBlueprints);
  }

  async addBlueprintToLibrary(id: string): Promise<void> {
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) {
      throw new Error("Blueprint not found.");
    }

    let existing = this.storage.libraryBlueprints.get(id);
    if (existing) {
      existing.metadata = kvRecord.metadata;
      this.storage.libraryBlueprints.put(existing);
      return;
    }

    this.storage.libraryBlueprints.put({
      id,
      metadata: kvRecord.metadata,
      addedAt: new Date(),
      uploaded: false,
    });
  }

  async removeBlueprintFromLibrary(id: string): Promise<void> {
    let record = this.storage.libraryBlueprints.get(id);
    if (!record) {
      return;
    }

    if (record.uploaded) {
      await this.deleteOwnedBlueprint(id);
    } else {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
  }

  async isBlueprintInLibrary(id: string): Promise<{ uploaded: boolean } | null> {
    const record = this.storage.libraryBlueprints.get(id);
    if (!record) return null;
    return { uploaded: record.uploaded };
  }

  async deleteOwnedBlueprint(id: string): Promise<void> {
    if (isReservedBlueprintKey(id)) {
      throw new Error("Blueprint not found.");
    }

    let publishedRecord = this.storage.blueprints.get(id);
    let libraryRecord = this.storage.libraryBlueprints.get(id);
    let uploadedRecord = libraryRecord?.uploaded ? libraryRecord : undefined;
    let kvRecord = await readBlueprintKvRecord(this.env, id);

    if (!publishedRecord && !uploadedRecord && !kvRecord) {
      throw new Error("Blueprint not found.");
    }

    if (kvRecord) {
      if (kvRecord.ownerId !== this.ctx.id.toString()) {
        throw new Error("You don't own this blueprint.");
      }

      // Delete all R2 objects with the blueprint ID prefix.
      for (let v = 1; v <= kvRecord.metadata.version; v++) {
        await this.env.BLUEPRINT_CONTENT.delete(`${id}/${v}`);
      }
      await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);

      // Delete from KV.
      await this.env.BLUEPRINTS.delete(id);
    }

    if (publishedRecord?.featured === true) {
      await this.adminSettings.getByName("").deleteFeaturedBlueprint(id);
    }

    if (publishedRecord) {
      this.storage.blueprints.delete(id);
    }
    if (uploadedRecord) {
      this.storage.libraryBlueprints.delete(id);
    }
    await this.setBlueprintPinned(id, false);
  }

  async isBlueprintFeatured(id: string): Promise<boolean | null> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      return null;
    }

    return record.featured === true;
  }

  async setBlueprintFeatured(id: string, featured: boolean): Promise<void> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      throw new Error("No such blueprint.");
    }

    record.featured = featured;
    this.storage.blueprints.put(record);
  }

  getBlueprint(id: string): BlueprintUserSummary | null {
    let record = this.storage.blueprints.get(id);
    return record ? this.blueprintSummary(record, new Set(this.storage.pinnedBlueprints.get())) : null;
  }

  async listBlueprints(): Promise<BlueprintUserSummary[]> {
    let result: BlueprintUserSummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.blueprints.list()) {
      result.push(this.blueprintSummary(record, pinnedBlueprintIds));
    }
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  private blueprintSummary(record: BlueprintUserRecord, pinnedBlueprintIds: Set<string>): BlueprintUserSummary {
    let gadget = record.gadgetId ? this.storage.gadgets.get(record.gadgetId) : undefined;
    return {
      id: record.id,
      title: record.metadata.title,
      description: record.metadata.description,
      gadgetId: record.gadgetId ?? "",
      gadgetTitle: record.gadgetId ? (gadget?.title ?? "Deleted Gadget") : "Imported Blueprint",
      version: record.metadata.version,
      lastUpdated: record.metadata.lastUpdated,
      pinned: pinnedBlueprintIds.has(record.id) || undefined,
    };
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    let result: BlueprintLibrarySummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.libraryBlueprints.list()) {
      result.push({
        id: record.id,
        metadata: record.metadata,
        addedAt: record.addedAt,
        uploaded: record.uploaded,
        pinned: pinnedBlueprintIds.has(record.id) || undefined,
      });
    }
    result.sort((a, b) => b.addedAt.valueOf() - a.addedAt.valueOf());
    return result;
  }

  async listGatekeeperVendors(filter: GatekeeperVendorFilter = {})
      : Promise<{id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]> {
    let options = {
      userId: this.storage.profile.get().id
    };

    let promises: Promise<{id: string, description: VendorDescription, supportedResources: SupportedResource[]}|null>[] = [];

    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        if (filter && !(await checkGatekeeperVendorFilter(vendor, filter))) {
          return null;
        }

        let [description, supportedResources] = await Promise.all([
          vendor.describe(),
          vendor.getSupportedResources(options),
        ]);
        if (supportedResources.length == 0) {
          return null;
        }

        return {id, description, supportedResources};
      })());
    }

    return (await Promise.all(promises)).filter(value => value !== null);
  }

  async getGatekeeperScopeCatalog(vendorId: string): Promise<VendorScope[]> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }

    return await vendor.getScopeCatalog();
  }

  async connectAccount(vendorId: string): Promise<{url: string}> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }

    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);

    let props = {
      userId: this.ctx.id.toString(),
      accountId,
      vendorId,
    };

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({props});

    let {url} = await vendor.connectAccount(callback);
    return {url};
  }

  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: GatekeeperVendorFilter)
      : Promise<RpcStub<{}>> {
    let connectedAccounts = this.storage.connectedAccounts;
    let vendors = this.vendors;

    subscriber = subscriber.dup();  // keep stub after return

    let seenIds = new Set<number>();
    let vendorDescriptions = new Map<string, Promise<VendorDescription>>();

    async function notifyAdd(record: ConnectedAccountRecord) {
      if (filter && !(await checkGatekeeperVendorFilter(record.account, filter))) {
        return;
      }

      let vendor = vendors.get(record.vendorId);
      if (!vendor) {
        console.error("No such service for connected account", record.id, record.vendorId);
        return;
      }

      let vendorDescription: VendorDescription;
      try {
        let vendorDescriptionPromise = vendorDescriptions.get(record.vendorId);
        if (!vendorDescriptionPromise) {
          vendorDescriptionPromise = vendor.describe().catch(err => {
            vendorDescriptions.delete(record.vendorId);
            throw err;
          });
          vendorDescriptions.set(record.vendorId, vendorDescriptionPromise);
        }
        vendorDescription = await vendorDescriptionPromise;
      } catch (err) {
        console.error("Failed to describe connected account", record.id, err);
        return;
      }

      let supportedResources: SupportedResource[] = [];
      try {
        supportedResources = await record.account.getSupportedResources();
      } catch (err) {
        console.error("Failed to get supported resources for connected account", record.id, err);
      }

      let credentialsValid = areCredentialsValid(record);

      seenIds.add(record.id);
      subscriber.add(record.id, record.description, vendorDescription,
          supportedResources, credentialsValid, record.vendorId).catch(unsubscribe)
    }

    let dbSubscriber = {
      async add(record: ConnectedAccountRecord) {
        await notifyAdd(record);
      },
      async update(oldRecord: ConnectedAccountRecord, newRecord: ConnectedAccountRecord) {
        await notifyAdd(newRecord);
      },
      remove(record: ConnectedAccountRecord): void {
        if (seenIds.has(record.id)) {
          subscriber.remove(record.id);
          seenIds.delete(record.id);
        }
      }
    }

    let unsubscribe = () => {
      connectedAccounts.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    let promises: Promise<void>[] = [];

    // We enumerate connected accounts by id rather than via `connectedAccounts.list()` so that a
    // single corrupt/unreadable record doesn't poison the iterator and prevent us from surfacing
    // any of the others. The most common cause of a record failing to load is that the
    // GatekeeperUser stub it holds points at a Worker binding that no longer exists in the
    // current deployment config (e.g. a gatekeeper that was removed from wrangler.jsonc since
    // the account was originally connected). In that case workerd throws
    // "Stub refers to a service that doesn't exist: ..." when deserializing the stored value.
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let record: ConnectedAccountRecord | undefined;
      try {
        record = connectedAccounts.get(id);
      } catch (err) {
        console.error(
            `Skipping connected account #${id}: failed to load. The gatekeeper Worker ` +
            `binding it was connected to may no longer exist in this deployment.`, err);
        continue;
      }
      if (!record) continue;
      promises.push((async () => {
        await notifyAdd(record);
      })());
    }

    connectedAccounts.subscribe(dbSubscriber);

    await Promise.all(promises);

    subscriber.ready().catch(unsubscribe);

    return new RpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
        subscriber[Symbol.dispose]();
      }
    });
  }

  async disconnectAccount(accountId: number): Promise<void> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (account) {
      await account.account.revoke();
      this.storage.connectedAccounts.delete(accountId);
      // Disconnecting the Cloudflare account also clears the AI Gateway billing state (selected
      // account + cached balance), which is meaningless without the underlying grant.
      if (account.vendorId === CLOUDFLARE_VENDOR_ID) {
        this.storage.cloudflareBilling.put(null);
      }
    }
  }

  async reconnectAccount(accountId: number): Promise<{url: string}> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.reconnect();
  }

  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.startResourceConfigurator(resourceUrlPattern);
  }

  // Persist a connected gatekeeper account that was established during sign-in (rather than via the
  // usual logged-in connectAccount flow). Used for providers like Cloudflare where signing in also
  // links the account for AI Gateway billing: the login callback resolves this user by verified
  // email, then calls here to store the full-scope grant.
  async linkConnectedAccountFromLogin(
      account: Fetcher<GatekeeperUser>, vendorId: string, expiresAt?: Date): Promise<void> {
    let description = await account.describe();
    let uniqueName = description.uniqueName;

    // A repeated sign-in is a re-authorization, so the *fresh* grant is the one we want. If this
    // identity is already connected for this vendor, refresh that record in place rather than letting
    // putConnectedAccount's dedup discard the new grant: keeping the stale record would leave billing
    // broken whenever the old token had expired or was rotated out by this very re-auth — the
    // opposite of what signing in again should accomplish.
    if (uniqueName) {
      let existing = this.#findConnectedAccountByIdentity(vendorId, uniqueName);
      if (existing) {
        // Drop the now-stale grant (a separate gatekeeper-side object from the fresh one), then point
        // the existing record — keeping its id, so UI references stay stable — at the fresh grant.
        try {
          await existing.account.revoke();
        } catch (err) {
          console.error(
              `Failed to revoke stale grant for account #${existing.id}; replacing anyway.`, err);
        }
        existing.account = account;
        existing.description = description;
        existing.credentialExpiresAt = expiresAt;
        existing.credentialsExpired = false;
        this.storage.connectedAccounts.put(existing);
        return;
      }
    }

    let id = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(id + 1);
    this.storage.connectedAccounts.put({
      id,
      account,
      description,
      vendorId,
      credentialExpiresAt: expiresAt,
    });
  }

  // Find an existing connected account for the given vendor + identity (uniqueName), excluding
  // `excludeId`. Skips records that fail to load, for the same reasons as subscribeConnectedAccounts():
  // a single corrupt record (e.g. one referencing a Worker binding that no longer exists) must not
  // poison the scan and prevent the user from connecting any new account.
  #findConnectedAccountByIdentity(vendorId: string, uniqueName: string, excludeId?: number)
      : ConnectedAccountRecord | undefined {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      if (id === excludeId) continue;
      let existing: ConnectedAccountRecord | undefined;
      try {
        existing = this.storage.connectedAccounts.get(id);
      } catch (err) {
        console.error(
            `Skipping connected account #${id} during identity lookup: failed to load. The ` +
            `gatekeeper Worker binding it was connected to may no longer exist in this ` +
            `deployment.`, err);
        continue;
      }
      if (!existing) continue;
      if (existing.vendorId === vendorId && existing.description.uniqueName === uniqueName) {
        return existing;
      }
    }
    return undefined;
  }

  async putConnectedAccount(record: ConnectedAccountRecord) {
    let uniqueName = record.description.uniqueName;
    if (uniqueName &&
        this.#findConnectedAccountByIdentity(record.vendorId, uniqueName, record.id)) {
      // OAuth providers often return the currently logged-in identity when the user tries to add
      // another account. Avoid showing duplicate account rows: keep the existing record stable for
      // any UI references, and revoke the newly-created duplicate grant.
      await record.account.revoke();
      return;
    }

    this.storage.connectedAccounts.put(record);
  }

  async markCredentialsExpired(accountId: number) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    if (!record.credentialsExpired) {
      record.credentialsExpired = true;
      this.storage.connectedAccounts.put(record);
    }
  }

  async markCredentialsRestored(accountId: number, expiresAt?: Date) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    // Re-fetch description since the user may have re-authed with different info.
    record.description = await record.account.describe();
    record.credentialsExpired = false;
    record.credentialExpiresAt = expiresAt;
    this.storage.connectedAccounts.put(record);
  }

  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, vendorId: string,
                  typeUrlPattern: string}> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    let {class: cls, resource} = await account.account.getGatekeeperClassFor(url);

    return {class: cls, vendorId: account.vendorId, typeUrlPattern: resource.urlPattern};
  }

}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorId: string;
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  #getUserStub() {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    return this.ctx.exports.UserDurableObject.get(userId);
  }

  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();

    await userStub.putConnectedAccount({
      id: this.ctx.props.accountId,
      account,
      description: await account.describe(),
      vendorId: this.ctx.props.vendorId,
      credentialExpiresAt: expiresAt,
    });
  }

  async credentialsExpired(): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsExpired(this.ctx.props.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsRestored(this.ctx.props.accountId, expiresAt);
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}
