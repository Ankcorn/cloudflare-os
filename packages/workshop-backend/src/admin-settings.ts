import { BlueprintPublicInfo } from '@gadgets/workshop-shared/api';
import { DurableObject } from 'cloudflare:workers';
import { collection, createTypedStorage } from '@gadgets/typed-storage';
import { FEATURED_BLUEPRINTS_KEY, isReservedBlueprintKey, parseBlueprintKvRecord, serializeFeaturedBlueprints } from './blueprint-archive.js';
import { UserDurableObject } from './user.js';

function makeAdminSettingsStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      // Mirror of the currently-featured blueprint public records. The user DO owns the
      // authoritative featured bit; this DO keeps the publishable deployment-wide copy.
      featuredBlueprints: collection<BlueprintPublicInfo>()({
        primaryKey: 'id',
      }),
    },
    singletons: {},
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

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeAdminSettingsStorage(ctx.storage);
    this.users = this.ctx.exports.UserDurableObject;
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
}
