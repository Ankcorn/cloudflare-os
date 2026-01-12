import { RpcStub } from "capnweb";
import { GadgetMetadata, AiChatAuthorInfo, AiModelConfig, ConnenctedAccountsSubscriber, GatekeeperVendorFilter } from '@gadgets/workshop-shared/api';
import { Gatekeeper, GatekeeperUser, GatekeeperVendor, AccountDescription, VendorDescription, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";

type ConnectedAccountRecord = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  vendorDescription: VendorDescription;
  description: AccountDescription;
};

type UserAiModelRecord = {
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
      gadgets: collection<GadgetMetadata>()({
        primaryKey: "id"
      }),
      connectedAccounts: collection<ConnectedAccountRecord>()({
        primaryKey: "id"
      }),
      sessions: collection<LoginSessionRecord>()({
        primaryKey: "tokenId",
      }),
    },
    singletons: {
      created: false,
      profile: <AiChatAuthorInfo>{
        type: "user",
        name: "User",
        id: "user@example.com",
      },
      quickModel: <string | null>null,
      nextAccountId: 0,

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
      let patterns = await vendor.getSupportedUrls();
      let matched = false;
      for (let pattern of patterns) {
        if (typeof pattern !== "string") {
          // Guard against gatekeepers returning a non-string pattern for now.
          //
          // TODO: Consider whether this is the API we want for getSupportedUrls(). Is URLPattern
          //   even the right thing?
          throw new Error("Gatekeeper returned non-string pattern from getSupportedUrls()");
        }

        if (new URLPattern(pattern).test(filter.resourceUrl)) {
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

  async setOwnDisplayName(name: string): Promise<void> {
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    let result: AiChatAuthorInfo[] = [];
    for (let model of this.storage.aiModels.list()) {
      result.push(model.profile);
    }
    return result;
  }

  async addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    profile.type = "agent";
    this.storage.aiModels.put({profile, config});
  }

  async deleteModel(id: string): Promise<void> {
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

  // DO NOT MAKE PUBLIC -- returns API keys.
  async getChatContext(modelId: string | null): Promise<UserChatContext> {
    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      result.aiModel = this.storage.aiModels.get(modelId);
      if (!result.aiModel) throw new Error(`No such model: ${modelId}`);
    }
    let quickModelId = this.storage.quickModel.get();
    if (quickModelId) {
      let quickModel = this.storage.aiModels.get(quickModelId);
      if (quickModel) {
        result.quickModel = quickModel.config;
      }
    }
    return result;
  }

  async listGadgets(): Promise<GadgetMetadata[]> {
    return [...this.storage.gadgets.list()];
  }

  async updateTitle(gadgetId: string, title: string) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such gadget belonging to user.");
    }
    record.title = title;
    this.storage.gadgets.put(record);
  }

  async getGadget(id: string): Promise<GadgetMetadata | null> {
    return this.storage.gadgets.get(id) || null;
  }

  async newGadget(id: string, title: string): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created, lastActive: created});
  }

  async setGadgetLastActive(id: string, time: Date): Promise<void> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget) {
      gadget.lastActive = time;
      this.storage.gadgets.put(gadget);
    }
  }

  async deleteGadget(id: string): Promise<void> {
    this.storage.gadgets.delete(id);
  }

  async listGatekeeperVendors(filter: GatekeeperVendorFilter = {})
      : Promise<{id: string, description: VendorDescription}[]> {
    let promises: Promise<{id: string, description: VendorDescription}|null>[] = [];

    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        if (filter && !(await checkGatekeeperVendorFilter(vendor, filter))) {
          return null;
        }

        return {id, description: await vendor.describe()};
      })());
    }

    return (await Promise.all(promises)).filter(value => value !== null);
  }

  async connectAccount(vendorId: string): Promise<{url: string}> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }

    let vendorDescription = await vendor.describe();

    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);

    let props = {
      userId: this.ctx.id.toString(),
      accountId,
      vendorDescription,
    };

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({props});

    let {url} = await vendor.connectAccount(callback);
    return {url};
  }

  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnenctedAccountsSubscriber>, filter?: GatekeeperVendorFilter)
      : Promise<RpcStub<{}>> {
    let connectedAccounts = this.storage.connectedAccounts;

    subscriber = subscriber.dup();  // keep stub after return

    let seenIds = new Set<number>();

    let dbSubscriber = {
      async add(record: ConnectedAccountRecord) {
        if (filter && !(await checkGatekeeperVendorFilter(record.account, filter))) {
          return;
        }

        seenIds.add(record.id);
        subscriber.add(record.id, record.description, record.vendorDescription)
            .catch(err => { connectedAccounts.unsubscribe(dbSubscriber) });
      },
      update(oldRecord: ConnectedAccountRecord, newRecord: ConnectedAccountRecord): void {
        // Never happens.
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

    for (let record of connectedAccounts.list()) {
      promises.push((async () => {
        if (filter && !(await checkGatekeeperVendorFilter(record.account, filter))) {
          return;
        }

        seenIds.add(record.id);
        subscriber.add(record.id, record.description, record.vendorDescription).catch(unsubscribe);
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
    }
  }

  async putConnectedAccount(record: ConnectedAccountRecord) {
    this.storage.connectedAccounts.put(record);
  }

  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<DurableObjectClass<Gatekeeper<any>>> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    return await account.account.getGatekeeperClassFor(url);
  }
}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorDescription: VendorDescription;
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  async complete(account: Fetcher<GatekeeperUser>): Promise<void> {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    let userStub = this.ctx.exports.UserDurableObject.get(userId);

    await userStub.putConnectedAccount({
      id: this.ctx.props.accountId,
      account,
      description: await account.describe(),
      vendorDescription: this.ctx.props.vendorDescription
    });
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}
