// This file defines the API spoken between the Gadgets Workshop service and the front-end UI.
//
// The UI is a good old "fat client" SPA. Why not use SSR? Because:
// - Users of this UI are likely to have it open often, maybe even all the time. Startup time is
//   less of a concern than with sites you visit only briefly, and assets are likely to be in cache
//   in any case.
// - The Gadgets themselves are sandboxed on the client side in addition to the server side. This
//   sandboxing requires running code in the browser. It is not plausible to server-side render
//   a Gadget itself.
// - By providing a really clean API boundary between client and server, we make it easier to build
//   alternative clients.
// - SPA is just easier to think about.
//
// The entire API between the client and server is an RPC API, using Cloudflare's JavaScript RPC,
// which essentially allows natural JavaScript / TypeScript interfaces to be exposed over the
// network.
//
// The RPC interface operates over a WebSocket, which the client starts immediately at startup and
// keeps open for the entire lifetime of the session, reconnecting if needed.
//
// Gadgets run inside a sandboxed iframe which has no ability to talk to the outside world at all,
// except postMessage() to the parent frame. Through postMessage() exchanges, the Gadget can speak
// RPC to the Workshop. Among other things, through this interface, the Workshop provides the
// Gadget a stub pointing to the Gadget's server-side Durable Object interface.

import { RpcCompatible, RpcStub, RpcTarget } from "capnweb";
import { AccountDescription, ActionDescription, AvatarImage, ObservationDescription, ResourceDescription, ResourceConfiguratorFrame, SupportedResource, VendorDescription, VendorScope, HookDescription } from "./gatekeeper.js";

export const SERVICE_SALT = new Uint8Array([
  0xd9, 0x4e, 0x54, 0x1d, 0x29, 0xc1, 0x03, 0x74, 0x73, 0x7e, 0xb3, 0xe3, 0x34, 0x6d, 0x8f, 0x21
]);

// A pending gatekeeper sign-in attempt, returned by `PublicApi.startGatekeeperLogin()`. Holding this
// stub is the capability to receive the resulting session token; dispose it to abandon the attempt.
export interface LoginAttempt extends RpcTarget {
  // Resolves with a session token (to store and pass to `authenticate()`, same format as `login()`)
  // once the gatekeeper popup completes, or rejects if the attempt fails or is abandoned. Safe to
  // call immediately after `startGatekeeperLogin()`.
  wait(): Promise<string>;
}

// Public API exposed to the internet.
export interface PublicApi extends RpcTarget {
  // Returns deployment-level configuration the client needs at boot (auth mode, available sign-in
  // vendors, whether the Cloudflare limits flow is enabled). Contains no secrets.
  getServerConfig(): Promise<ServerConfig>;

  // Begin a sign-in via an authentication gatekeeper (e.g. "google", "github", "cloudflare").
  // Returns a `url` the client opens in a new tab (the gatekeeper's OAuth popup, which self-closes)
  // and an `attempt` stub whose `wait()` resolves once the popup completes. The vendor must be
  // auth-capable and allowlisted (see ServerConfig.authVendors); throws otherwise.
  //
  // Dispose `attempt` to abandon the sign-in (e.g. the user closed the popup); this cancels the wait
  // server-side.
  startGatekeeperLogin(vendorId: string): Promise<{ url: string; attempt: RpcStub<LoginAttempt> }>;

  // Authenticates the user using an auth token (typically stored in localStorage).
  authenticate(token: string): Promise<AuthenticatedApi>;

  // Like authenticate() but the server is expected to be sitting behind Cloudflare Access, and the
  // client is expected to have already authenticated with Access (before they could load the
  // application in their browser at all). The credentials from the Cloudflare Access session will
  // be used to authenticate the user.
  authenticateFromCfAccess(): Promise<AuthenticatedApi>;

  // Login with username and password.
  //
  // Returns a token to store in local storage and pass to `authenticate()` in the future.
  //
  // Returns null if login failed (no such user or wrong password).
  //
  // `passwordHash` is derived from the user's password as follows:
  //
  //     argon2id({
  //       password,
  //       salt: SERVICE_SALT + encode(username, 'utf8'),
  //       parallelism: 1,
  //       iterations: 3,
  //       memorySize: 64MiB,
  //       hashLength: 32,
  //     });
  //
  // Note that the `passwordHash` itself is NOT stored plaintext by the server -- additional
  // hashing is performed server-side. The overall scheme achieves roughly the same security
  // guarantees as traditional server-side password hashing, but with the added benefit that the
  // server never sees the user's password at all, and also the benefit of performing the expensive
  // hash on the client which tends to have more resources available than a busy server.
  //
  // This API may be disabled when the server uses SSO for authentication.
  login(username: string, passwordHash: Uint8Array): Promise<string | null>;

  // Create a new account. Returns a token to store in local storage and pass to `authenticate()`
  // in the future.
  //
  // Returns null if the username already exists. (Other kinds of errors may throw exceptions.)
  //
  // See login() (above) for an explanation of the password hashing algorithm.
  //
  // This API may be disabled when the server uses SSO for authentication.
  createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null>;

  // Fetch blueprint metadata by ID. Returns null if the blueprint doesn't exist. No
  // authentication required (knowing the ID is sufficient, since a blueprint is "just data").
  getBlueprint(id: string): Promise<BlueprintPublicInfo | null>;

  // Download a blueprint as a `.gadget` archive stream. The archive contains only
  // BlueprintMetadata plus the current blueprint code snapshot, not the full KV record.
  downloadBlueprint(id: string): Promise<ReadableStream<Uint8Array>>;
}

// Subscription callback for AuthenticatedApi.subscribeConnectedAccounts().
export interface ConnectedAccountsSubscriber {
  // If `credentialsValid` is false, the account's credentials are known to be expired, and the
  // UI should call reconnectAccount() to fix this if the user tries to select this account.
  add(id: number, description: AccountDescription, vendor: VendorDescription,
      supportedResources: SupportedResource[], credentialsValid: boolean, vendorId: string): void;
  remove(id: number): void;

  // Called after add() has been called for all accounts known so far.
  ready(): void;
}

// When listing gatekeeper vendors or connected accounts, you can filter to only vendors/accounts
// that support certain features. This type specifies the filter.
export type GatekeeperVendorFilter = {
  // Filter for vendors that can connect to the given resource.
  resourceUrl?: string,
};

// Top-level API exposed to the user after they have authenticated.
export interface AuthenticatedApi extends RpcTarget {
  // Get profile info for the user who is logged in.
  whoami(): Promise<AiChatAuthorInfo>;

  // Set the user's own display name, seen in chats, etc.
  setOwnDisplayName(name: string): Promise<void>;

  // Change the user's password, if using password-based authentication.
  //
  // See `PublicApi.login()` for an explanation of the hashing algorithm.
  changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void>;

  // Whether this account has a password set. False for accounts created via an OAuth provider, in
  // which case the change-password UI should be hidden.
  hasPasswordLogin(): Promise<boolean>;

  // List the user's configured AI models.
  //
  // Note that the list returned here could be different from a particular gadget's Overseer,
  // especially if the gadget is owned by someone else.
  listModels(): Promise<AiChatAuthorInfo[]>;

  // Adds a new model to the user's configured set. The ID must be unique among the user's
  // configured models.
  addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void>;

  // Deletes a configured model.
  deleteModel(id: string): Promise<void>;

  // Set the model to use for simple quick tasks, like generating chat titles. Set null to
  // disable quick model use (e.g. chats will be titled "New Chat").
  setQuickModel(id: string | null): Promise<void>;

  // Get the quick model setting.
  getQuickModel(): Promise<null | string>;

  // Get AI configuration info, including whether AI Gateway mode is active and which providers
  // are available. The frontend uses this to adjust the model management UI.
  getAiConfig(): Promise<AiGatewayInfo>;

  // Get the user's preferred model, chosen during onboarding. Returns null if the user has not
  // set a preference (or explicitly chose "No agent").
  getPreferredModel(): Promise<string | null>;

  // Set the user's preferred model. Pass null to indicate "No agent".
  setPreferredModel(id: string | null): Promise<void>;

  // Returns true if the user has completed the onboarding wizard.
  isOnboardingCompleted(): Promise<boolean>;

  // Mark the onboarding wizard as completed.
  completeOnboarding(): Promise<void>;

  // --- Optional Cloudflare limits / top-up flow (only meaningful when enabled server-side) ---

  // Get the user's current free-tier usage and connected-account balance.
  getCloudflareUsage(): Promise<CloudflareUsageInfo>;

  // List the Cloudflare accounts the connected grant can access. Used to prompt account selection
  // when the user has more than one. Returns an empty array if not connected. Connecting Cloudflare
  // is done via the Cloudflare gatekeeper (connectAccount("cloudflare")) or by signing in with it.
  listCloudflareAccounts(): Promise<CloudflareAccountOption[]>;

  // Select which Cloudflare account to bill. Persists the choice. Throws if the account isn't
  // accessible.
  selectCloudflareAccount(accountId: string): Promise<void>;

  // Upload a user avatar image. The data should be a compressed image (JPEG/PNG), ideally under
  // 50 KB. Pass null to remove the avatar.
  setAvatar(data: Uint8Array | null): Promise<void>;

  // Fetch a user's avatar image by user ID. Returns null if no avatar has been set.
  // Accepts any user ID so that other users' avatars can be displayed (e.g. in chat).
  getAvatar(userId: string): Promise<Uint8Array | null>;

  // Open an existing gadget.
  //
  // If `shareKey` is provided, the server redeems it before opening, adding the caller as a
  // collaborator. If the key is invalid or expired, the call throws an exception. This design
  // allows share-key redemption and gadget opening in a single round trip, and further calls
  // can be pipelined on the returned Overseer.
  //
  // To allow for pipelining, this throws an exception if the gadget doesn't exist.
  openGadget(id: string, shareKey?: string): Promise<RpcStub<Overseer>>;

  // Create a new gadget. It will start out titled "Untitled Gadget".
  //
  // Note: A gadget is considered "provisional" until it has some sort of activity, such as a
  //   chat message or code edit. Provisional gadgets do not appear on the home page and will be
  //   automatically deleted after some time. Note in particular that calling
  //   new*Gatekeeper() will not clear the provisional bit (as long as no binding name is
  //   assigned), so provisional gadgets are useful to allow the user to write an initial chat
  //   message without explicitly creating a new gadget.
  newGadget(): Promise<RpcStub<Overseer>>;

  // List metadata about all the user's Gadgets. Used to display the front-page listing.
  //
  // Provisional gadgets are hidden.
  //
  // TODO: Pagination, sort options.
  listGadgets(): Promise<GadgetMetadataWithTimestamps[]>;

  // List all third-party services that this account can connect to.
  listGatekeeperVendors(filter?: GatekeeperVendorFilter)
      : Promise<{id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]>;

  // Returns the gatekeeper's permission catalog for third-party service at `vendorId`.
  getGatekeeperScopeCatalog(vendorId: string): Promise<VendorScope[]>;

  // Connect this account to a specific account on a third-party service. Returns the URL which
  // should be opened in a new tab in the user's browser to complete the authorization. When the
  // authorization flow completes, the account will be added to the list, which can be observed
  // through subscribeConnectedAccounts().
  connectAccount(vendorId: string): Promise<{url: string}>;

  // Subscribe to the list of third-party accounts connected to the user's account.
  //
  // Dispose the returned stub to cancel the subscription.
  //
  // This is subscription-based because the flow to connect a new account completes in a separate
  // window. When it completes, we want the list of accounts in the Workshop UI to update
  // immediately, to give the user feedback that the account is now connected.
  subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: GatekeeperVendorFilter)
      : Promise<RpcStub<{}>>;

  // Remove a connected account, revoking the token.
  disconnectAccount(accountId: number): Promise<void>;

  // Get the UI used to choose a specific resource from a connected account.
  //
  // `accountId` is the user's connected account that provides this resource.
  // `resourceUrlPattern` is the `urlPattern` associated with the supported resource.
  startResourceConfigurator(
    accountId: number,
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame>;

  // Remove a shared gadget from the user's home page listing. Does NOT revoke the user's
  // access -- if they open the gadget again (e.g., via link), it reappears on their home page.
  dismissSharedGadget(gadgetId: string): Promise<void>;

  // List all blueprints created by the current user (from User DO). Useful for an audit
  // view in Settings.
  listOwnBlueprints(): Promise<BlueprintUserSummary[]>;

  // Return a blueprint created by the current user, or null if it is not owned by this user.
  getOwnBlueprint(blueprintId: string): Promise<BlueprintUserSummary | null>;

  // List the blueprints currently in the user's library. This includes uploaded `.gadget`
  // archives (stored locally) and blueprints saved by reference from other publishers.
  listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]>;

  // Pin a blueprint for quick reuse on the home page. Pinning a public blueprint that isn't
  // already yours or in your library saves it to your library first.
  setBlueprintPinned(blueprintId: string, pinned: boolean): Promise<void>;

  // Returns whether the blueprint is pinned by the current user.
  isBlueprintPinned(blueprintId: string): Promise<boolean>;

  // List the deployment-wide featured blueprints. This is served from a KV snapshot rather
  // than directly from the AdminSettings durable object.
  listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]>;

  // Add a blueprint to the user's library by reference, caching the current public metadata
  // snapshot for list rendering.
  addBlueprintToLibrary(blueprintId: string): Promise<void>;

  // Remove a blueprint from the user's library. If the library entry was uploaded by the
  // current user, this also deletes the backing blueprint content from storage.
  removeBlueprintFromLibrary(blueprintId: string): Promise<void>;

  // Returns info about whether the blueprint is in the user's library.
  // Returns null if not in library, or { uploaded } if it is.
  isBlueprintInLibrary(blueprintId: string): Promise<{ uploaded: boolean } | null>;

  // Returns whether the blueprint is featured in deployment-wide admin settings.
  // Returns null when the caller is not an admin or the blueprint cannot be featured.
  adminIsBlueprintFeatured(blueprintId: string): Promise<boolean | null>;

  // Mark or unmark a blueprint as featured in deployment-wide admin settings.
  // Requires admin rights.
  adminSetBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void>;

  // Create a new gadget from a blueprint. Reads the blueprint from KV, downloads code from
  // R2, creates a new Overseer DO, initializes it with the blueprint's code, and creates
  // gatekeepers from the provided binding assignments.
  //
  // Every required binding in the blueprint must have a corresponding entry in `bindings`,
  // keyed by binding name. Throws if any are missing or if accountId/modelId are invalid.
  //
  // The returned Overseer can be used immediately (pipelining-friendly).
  newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>
  ): Promise<RpcStub<Overseer>>;

  // Delete a blueprint that the user owns. Works even if the source gadget has been deleted
  // (operates on User DO + KV directly).
  deleteOrphanedBlueprint(blueprintId: string): Promise<void>;

  // Import a `.gadget` archive from another Workshop instance. The imported blueprint is stored
  // as a local blueprint owned by the current user.
  importBlueprint(archive: ReadableStream<Uint8Array>): Promise<string>;

  // Re-authenticate a connected account whose credentials have expired (or may be about to
  // expire). Returns the URL to open in a new tab. When the OAuth flow completes, the account
  // is updated and subscribers are notified with credentialsValid: true.
  reconnectAccount(accountId: number): Promise<{url: string}>;

  // TODO:
  // - Edit permissions on a connected account.
}

// A gatekeeper vendor offered as a sign-in method. The login/signup pages render a "Continue with
// ..." button per entry, alongside (never replacing) username/password. Built from auth-capable
// gatekeepers (VendorDescription.providesAuth) that are in the deployment's auth allowlist.
export type AuthVendorInfo = {
  // The gatekeeper vendor id (the GATEKEEPER_<NAME> binding suffix, lowercased), e.g. "google".
  vendorId: string;
  // Display name, logo, and brand color from the gatekeeper's VendorDescription.
  displayName: string;
  logo?: AvatarImage;
  color?: string;
};

// Deployment-level configuration that the client needs at boot to decide what UI to render.
// Returned by `PublicApi.getServerConfig()`. Contains no secrets.
export type ServerConfig = {
  // Auth-capable, allowlisted gatekeeper vendors offered as sign-in methods. Empty when none are
  // configured (password-only).
  authVendors: AuthVendorInfo[];

  // Whether username/password login + signup is available. Defaults to true; an installation can
  // disable it (DISABLE_PASSWORD_AUTH) to be OAuth-only. Forced true if no auth vendor is
  // configured, to avoid locking everyone out.
  passwordAuthEnabled: boolean;

  // Whether the optional Cloudflare free-tier limits + top-up flow is enabled. When false (the
  // default, e.g. self-hosted), usage is unlimited and the credits UI is hidden.
  cloudflareLimitsEnabled: boolean;
};

// Usage + Cloudflare-connection status for the optional limits flow. Returned by
// `AuthenticatedApi.getCloudflareUsage()`.
export type CloudflareUsageInfo = {
  // Whether the limits flow is enabled at all. When false, the rest is informational only.
  cloudflareLimitsEnabled: boolean;
  // When true, the user has unlimited access (limits disabled) and counters are not tracked.
  unlimited: boolean;

  // Free-tier daily usage.
  dailyUsed: number;
  dailyLimit: number;
  remaining: number;
  // ISO timestamp when the daily window resets.
  resetAt?: string;

  // Whether the user has connected a Cloudflare account.
  connected: boolean;
  // The connected account's AI Gateway credit balance (USD), or null if unknown/not connected.
  balance: number | null;
  accountId?: string;
  accountName?: string;
  // True when connected but the user has multiple Cloudflare accounts and must pick which one to
  // bill before usage can proceed. The client should prompt with selectCloudflareAccount().
  needsAccountSelection?: boolean;
};

// A Cloudflare account available to a connected user. Returned by `listCloudflareAccounts()`.
export type CloudflareAccountOption = {
  accountId: string;
  accountName: string;
};

// Supported AI providers.
export type AiModelProvider = "openai" | "anthropic" | "google" | "cloudflare" | "ollama";

// Information about the AI gateway configuration. Returned by `AuthenticatedApi.getAiConfig()`.
export type AiGatewayInfo = {
  enabled: true;
  enabledProviders: AiModelProvider[];
} | {
  enabled: false;
};

// Configuration specifying how to connect to an AI model provider.
export type AiModelConfig = {
  // Which AI provider hosts the model?
  provider: AiModelProvider;

  // Name of the specific model, as specified to the provider's API.
  model: string;

  // Secret API token for the respective provider, for billing purposes.
  apiToken: string;

  // URL of the API. If not specified, use the default for the provider. Overriding the URL is
  // useful in order to use AI proxy products like Cloudflare's AI gateway, or even to use an
  // alternative provider that provides a compatible API.
  apiUrl?: string;
};

// These well-known model identifiers are provided to make the UI simpler. The user can either
// choose one of these or can choose a provider and then specify the model name manually.
//
// This map maps provider name -> model ID -> display name. When the user chooses one of these,
// the model ID should be used both for `AiModelConfig.model` and `AiChatAuthorInfo.id`.
export const SUGGESTED_MODELS: Record<AiModelProvider, Record<string, string>> = {
  "cloudflare": {
    "@cf/moonshotai/kimi-k2.7-code": "Kimi K2.7 Code (Workers AI)",
    "@cf/zai-org/glm-5.2": "GLM 5.2 (Workers AI)",
  },
  "anthropic": {
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-opus-4-6": "Claude Opus 4.6",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
  },
  "openai": {
    "gpt-5.5": "GPT 5.5",
    "gpt-5.4": "GPT 5.4",
  },
  "google": {
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  },
  "ollama": {
  },
};

// Metadata about a Gadget. Includes everything needed to render the Gadget list on the front
// page.
export type GadgetMetadata = {
  // Unique ID for this Gadget, used with `openGadget()`. This is a url-safe base64 value chosen
  // randomly when the Gadget is created.
  id: string;

  // Human-readable title. Can be modified.
  title: string;

  // Total cost of AI inference in dollars, if known.
  totalCost?: number;

  // Whether the user has pinned this gadget to the top of their list.
  pinned?: boolean;

  // Set when the gadget is not owned by the current user. Presence of this field indicates the
  // user is a collaborator, not the owner.
  owner?: AiChatAuthorInfo;

  // The viewing user's effective role for this gadget. The owner is always "build". Used by the
  // frontend to decide whether to render the full editor ("build") or the UI-only shell ("use").
  // Absent implies "build" for backwards compatibility.
  role?: CollaboratorRole;

  // True when the gadget has observed data marked as share-prohibited. Such gadgets can no longer
  // be shared with additional users or links.
  sharingProhibited?: boolean;

  // TODO:
  // - created / modified / activity times
  // - icon? thumbnail?
}

// GadgetMetadata extended with timestamps. These are available when listing gadgets from the
// user's collection, but not from the Overseer (which doesn't track them).
export type GadgetMetadataWithTimestamps = GadgetMetadata & {
  created: Date;
  lastActive: Date;
}

// Describes the client-side UI code for a Gadget. Such code is intended to run inside an iframe
// sandbox with no access to the outside world except through an RPC interface to the Workshop
// and to the Gadget's server.
export type UiBundle = {
  // URL from which the main bundle of UI code can be downloaded. This download contains all the
  // Gadget's client-side assets. The URL is content-addressed to make it highly cacheable, even
  // across multiple Gadgets sharing the same implementation (blueprint).
  //
  // TODO: Specify the format of what this URL returns. A raw HTML page doesn't quite work because
  //   the client needs to initialize the sandbox with some platform libraries before loading the
  //   Gadget itself.
//  url: string;

  // Returns the raw JS code to execute in the Gadget iframe.
  // TODO: For now we just return the code but we should switch to serving over HTTP as described
  //   above, for caching. Or... maybe we should actually serve over RPC, but also employ the
  //   Cache API in the browser? Or some other local storage?
  jsCode: string;

  // Other metadata could be placed here in the future, e.g. to specify what version of support
  // libraries should be loaded.
};

// Represents an incremental update to the code.
export type CodeUpdate = {
  // Version number of the code AFTER this update has been applied.
  version: number;

  // Original timestamp of this update.
  timestamp: Date;

  // Yjs encoded update blob, encoding at least all changes since the previous version that the
  // client is known to already have.
  //
  // All encoded updates use V2 format.
  update: Uint8Array;
}

// Callback interface used to receive code updates from the server.
export interface CodeSubscriber {
  // Called any time the version on the server is newer than what the subscriber has.
  //
  // When the subscriber is multiple versions behind, the server may choose to send multiple
  // incremental updates or one big update. The server may make several calls in rapid succession
  // without waiting for previous calls to return. Cap'n Web guarantees that the calls will be
  // delivered in order, but it is important that the subscriber either applies the updates or
  // places them in some sort of queue synchronously to maintain ordering.
  update(up: CodeUpdate): void;

  // Called the first time the subscriber is up-to-date with the latest version known to the
  // server.
  ready(): void;
}

// Specifies the state of an action in the action log:
// * pending: Action has not been applied yet. It is waiting for approval.
// * approved: Action was approved and applied.
// * rejected: Action was rejected by the user.
export type ActionState = "pending" | "approved" | "rejected";

export type ActionLogEntry = {
  // Sequential ID number for the action. Counts up from when the gadget was created.
  id: number;

  // Which binding produced this action?
  bindingName?: string;   // omitted for capsules
  resourceTitle: string;
  resourceUrl?: string;

  createdAt: Date;
  appliedAt?: Date;

  state: ActionState;
} & ({
  type: "action";
  description: ActionDescription;
} | {
  type: "observation";
  description: ObservationDescription;
} | {
  type: "bindHook";

  description: HookDescription;

  // Hook that was created by this action. `undefined` if it was later deleted.
  hookId?: number;

  // Is the hook currently enabled?
  enabled: boolean;

  // Note that `state` is not meaningful for hooks. Instead of being "approved" or "rejected", they
  // are enabled/disabled, which the user can freely toggle as often as they want.
});

export type BoundHookInfo = {
  id: number;
  bindingName?: string;   // omitted for capsules
  resourceTitle?: string;
  resourceUrl?: string;
  description: HookDescription;
  enabled: boolean;
};

// Configuration for an AI spawner binding. This binding allows the gadget to programmatically
// create new agents, that is, start new agent chat threads, which appear in the gadget's agent
// chat UI as new conversations. Agents created this way don't typically edit the gadget code, but
// rather use the `executeCode` tool to directly invoke the gadget's bindings to perform tasks.
// Each agent can additionally be provide "props" which may include additional RPC stubs
// representing specific resources or callbacks relevant to that agent session.
//
// For example, a gadget that responds to emails might invoke an agent for each email message that
// arrives, with an RPC stub that allows it to reply to that email -- but prohibits the agent from
// seeing or replying to any other email, to guard against prompt injection or information leakage
// between email threads.
export type AgentSpawnerConfig = {
  // Display name for the binding, shown in the binding list.
  displayName: string,

  // Model ID to run, of the gadget owner's available models. Can be `null` to just create a chat
  // that doesn't actually run an agent -- the chat will be notified that the chat needs attention,
  // same as for an agent chat where the agent fails to mark the task complete.
  modelId: string | null,

  // Environment variables (bindings) to inherit from the gadget. If omitted, inherit all. This can
  // be used to restrict agents spawned by this spawner to access only certain bindings /
  // gatekeepers.
  env?: string[],
};

// Interface to a Gadget's Overseer, used to display the Gadget Workshop shell UI around that
// Gadget.
export interface Overseer extends RpcTarget {
  // Get metadata describing this gadget.
  getMetadata(): Promise<GadgetMetadata>;

  // Get metadata describing this gadget and subscribe to changes.
  //
  // `callback` will be called once immediately with the current metadata, then again any time it
  // changes.
  //
  // Disposing the returned `RpcStub` will cancel the subscription.
  subscribeToMetadata(
      callback: RpcStub<(metadata: GadgetMetadata) => void>)
      : Promise<RpcStub<{}>>;

  // Change the title.
  setTitle(title: string): Promise<void>;

  // Pin or unpin this gadget in the user's list.
  setPinned(pinned: boolean): Promise<void>;

  // Instruct Gadget to delete itself, removing it from the User's gadget list and deleting all
  // data. Further method calls will fail.
  //
  // TODO: Implement undelete, maybe using PITR...
  deleteSelf(): Promise<void>;

  // Subscribe to code updates.
  //
  // Code is represented as a Yjs doc. The top-level Y.Doc contains a Y.Map (with empty name) which
  // maps file names to Y.Text instances.
  //
  // `subscriber` will receive updates whenever it becomes out-of-date. `fromVersion` is the
  // version the subscriber already has before the subscription starts. To download the code from
  // scratch, omit the version (or pass zero).
  //
  // Disposing the returned `RpcStub` will cancel the subscription.
  subscribeToCode(subscriber: RpcStub<CodeSubscriber>, fromVersion?: number): Promise<RpcStub<{}>>;

  // Send a Yjs update to the server.
  //
  // If `chatId` is omitted, the update applies to the committed mainline code. If `chatId`
  // is provided, the update is recorded as a live draft edit for that chat's branch.
  updateCode(update: Uint8Array, chatId?: number): Promise<void>;

  // Get the Gadget's deployed UI code, to be run inside an iframe sandbox.
  //
  // Returns null if the gadget has no deployed UI code (e.g. if it's new, or if it's just an AI
  // agent with no code).
  getUiBundle(chatId?: number): Promise<UiBundle | null>;

  // Open an RPC interface to the Gadget's server-side Durable Object facet. The frontend may pass
  // this stub into the Gadget's iframe sandbox, so that the Gadget UI can communicate with its
  // server side. It can also permit the coding agent to make direct calls.
  //
  // If `chatId` is specified, then the gadget will include changes currently proposed in the given
  // chat.
  //
  // @ts-ignore - TODO: Fix type instantiation issue
  connectToGadget(chatId?: number): Promise<RpcStub<any>>;

  // List all the Gadget's current gatekeepers (that have been assigned binding names).
  listGatekeepers(): Promise<GatekeeperMetadata[]>;

  // Get an existing gatekeeper by binding name.
  getGatekeeper(bindingName: string): Promise<GatekeeperClient<any> | null>;

  // Get an existing gatekeeper by ID number. Throws if the ID doesn't exist.
  getGatekeeperById(id: number): Promise<GatekeeperClient<any>>;

  // Try to create a new gatekeeper for this URL.
  //
  // `accountId` is the user's connected account to use to access this resource. To determine an
  // appropriate account, use `subscribeConnectedAccounts()` with a `filter` for this URL, then
  // let the user choose one.
  //
  // The new gatekeeper is not assigned a binding name by default. Call setSuggestedBindingName()
  // on the returned object to assign one.
  newGatekeeper(accountId: number, resourceUrl: string): Promise<GatekeeperClient<any> | null>;

  // Create a new gatekeeper for an AI model binding. The model can be any returned by
  // listModels().
  newAiModelGatekeeper(modelId: string): Promise<GatekeeperClient<any>>;

  // Create a new gatekeeper for an agent spawner binding. This allows the gadget to
  // programmatically spawn AI agents to complete tasks.
  newAgentSpawnerGatekeeper(config: AgentSpawnerConfig): Promise<GatekeeperClient<any>>;

  // List history of actions.
  // TODO: This should be paginated.
  listActions(): Promise<ActionLogEntry[]>;

  // Approve an action that is currently in the "pending" state. The action will be performed on
  // approval.
  approveAction(id: number): Promise<void>;

  // Reject an action that is in the "pending" state. This notifies the gatekeeper that it will not
  // be approved in the future.
  rejectAction(id: number): Promise<void>;

  // List information about bound hooks (which could wake up the gadget asynchronously).
  listHooks(): Promise<BoundHookInfo[]>;

  // Enable the hook with the given ID. Callbacks will begin flowing.
  enableHook(id: number): Promise<void>;

  // Disable the hook with the given ID. Callbacks will stop.
  disableHook(id: number): Promise<void>;

  // Permanently delete the hook. Implies disabling it.
  deleteHook(id: number): Promise<void>;

  // Accept an agent's pending connection request (a "connectionRequest" chat message). The caller
  // is responsible for having actually created the gatekeeper (via newGatekeeper()) and passes the
  // resulting gatekeeper id. The gatekeeper is surfaced to the agent as a chat-scoped capsule (the
  // agent can promote it to a permanent binding via saveCapsuleAsBinding if needed). This marks the
  // request accepted, updates the inline card, and resumes the agent so it can use the resource.
  acceptConnectionRequest(requestId: string, result: {gatekeeperId: number}): Promise<void>;

  // Deny an agent's pending connection request. Updates the inline card. Does NOT resume the agent:
  // the turn stays ended so the user can decide what to tell the agent to do instead.
  denyConnectionRequest(requestId: string): Promise<void>;

  // Subscribe to action adds/updates. Dispose the returned stub to unsubscribe.
  // If `startAfter` is set, replay actions changed after that timestamp.
  subscribeToActions(subscriber: RpcStub<ActionsSubscriber>, startAfter?: Date): Promise<RpcStub<{}>>;

  // List past AI chats.
  listChats(): Promise<AiChatMetadata[]>;

  // List available models. The first listed model should be the default, unless the user has
  // chosen something else.
  listModels(): Promise<AiChatAuthorInfo[]>;

  // Fetch messages in the chat history for the given chat thread.
  //
  // Note that if you plan to subscribe to updates, you should initiate the subscription first,
  // before fetching history. Otherwise, you could theoretically miss a message that is sent
  // between when you fetch the history and when you subscribe.
  //
  // In typical usage, the client subscribes to all chat activity upfront, but only fetches
  // histories if and when the user opens a specific.
  getChatHistory(chatId: number): Promise<AiChatMessage[]>;

  // Fetch a single message from a chat thread.
  getChatMessage(chatId: number, sequence: number): Promise<AiChatMessage | undefined>;

  // Subscribe to all new chat messages (across all threads).
  //
  // If `startAt` is given, it must be a date in the past. All messages starting from that date
  // will be sent upfront. This is intended to allow resubscribing after being disconnected. If
  // `startAt` is omitted, only new messages will be sent.
  //
  // Generally, a client should subscribe to chats immediately on loading the gadget editor. If
  // the client needs to call any methods like `listChats()` to backfill content, it should make
  // these calls after `subscribeToChat()`, so that there's no chance of missing a message. (It is
  // not necessary to wait for `subscribeToChat()` to return -- only to initiate the call before
  // other read calls.)
  subscribeToChat(subscriber: RpcStub<AiChatSubscriber>, startAfter?: Date): Promise<RpcStub<{}>>;

  // Starts a new chat with the given initial message.
  //
  // `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
  // (useful when using chat to talk between humans).
  newChat(initialMessage: string, modelId: string | null,
          capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[]): Promise<number>;

  // Send a message to the chat from this client. Sending a message causes the LLM to start
  // running if it isn't already.
  //
  // `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
  // (useful when using chat to talk between humans).
  sendChatMessage(chatId: number, message: string, modelId: string | null,
                  capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[]): Promise<void>;

  // Upload an attachment for use in a future chat message. This way by the time the user wants to
  // send the message, likely uploading is complete.
  //
  // Pass the returned handle to newChat() or sendChatMessage() to commit the attachment into chat history.
  uploadChatAttachment(attachment: ChatAttachmentUpload): Promise<ChatAttachmentHandle>;

  // Fetch the bytes of a committed chat attachment over RPC. The canonical metadata is already
  // present in the message's ChatAttachmentRef. Images are inlined there, so this is normally used
  // only to download non-image attachments on demand.
  getChatAttachmentContent(chatId: number, id: string): Promise<Uint8Array>;

  // Delete an uploaded attachment that the user explicitly removed before sending the message.
  deleteChatAttachment(id: string): Promise<void>;

  // Update the title of a chat. Usually not needed as a title is generated automatically from
  // the first message.
  setChatTitle(chatId: number, title: string): Promise<void>;

  // Indicates that the user has requested that proposed changes through the given sequence number
  // in the chat thread be merged into the mainline.
  //
  // If `options.includeDraft` is true, any current live draft for the chat is first materialized
  // into one durable `changes` message and included in the merge.
  mergeChanges(
      chatId: number, mergeThrough: number | null,
      options?: { includeDraft?: boolean }): Promise<void>;

  // Indicates that the user has requested that proposed changes starting from the given sequence
  // number in the chat thread be reverted.
  revertChanges(chatId: number, revertFrom: number): Promise<void>;

  // Materialize the current live draft for the chat into one durable `changes` message without
  // merging it into the mainline.
  finalizeChatDraft(chatId: number): Promise<void>;

  // Discard the current live draft for the chat without affecting any durable `changes` messages.
  discardChatDraftChanges(chatId: number): Promise<void>;

  // Delete a chat thread.
  deleteChat(chatId: number): Promise<void>;

  // Request that any ongoing LLM session in the given chat immediately stop.
  //
  // If an LLM is running, the session is canceled subscribers will receive a metadata update
  // reflecting this before `stop()` returns.
  //
  // If no LLM is running, `stop()` does nothing and returns immediately.
  stopAgent(chatId: number): Promise<void>;

  // Retry the agent on the given chat. This starts the agent without adding a new user message.
  // The agent will re-process the existing chat history using the specified model.
  //
  // If an agent is already running, this does nothing.
  retryAgent(chatId: number, modelId: string): Promise<void>;

  // Subscribe to the gadget worker's console logs. This allows the user to observe console logs
  // being produced by the gadget.
  //
  // At present, logs are not stored, so the only way to see them is to be subscribed when they
  // happen.
  //
  // To unsubscribe, dispose the returned stub.
  subscribeToConsoleLogs(subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>>;

  // --- Blueprint management ---

  // List blueprints created from this gadget.
  listBlueprints(): Promise<BlueprintGadgetSummary[]>;

  // Create a new blueprint from the gadget's current committed code.
  // `title` defaults to the gadget's title if omitted.
  //
  // The blueprint is always owned by the gadget owner, regardless of who calls this method.
  //
  // Steps: generate ID, snapshot code, collect binding metadata, store locally, propagate
  // to User DO + KV + R2.
  createBlueprint(title?: string, description?: string, screenshot?: BlueprintScreenshotUpload): Promise<BlueprintGadgetSummary>;

  // Update an existing blueprint. Any combination of metadata and code can be updated
  // atomically in a single call with one propagation pass.
  //
  // - `title` / `description`: if provided, update the respective field.
  // - `updateCode`: if true, snapshot the gadget's current committed code into the
  //   blueprint and increment the blueprint version.
  // - `updateBindings`: if true, refresh the blueprint's connection annotations from
  //   the gadget's current named bindings without changing the code snapshot.
  //
  // At least one option must be provided.
  updateBlueprint(blueprintId: string, options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
    screenshot?: BlueprintScreenshotUpload | null;
  }): Promise<void>;

  // Delete a blueprint. Cleans up KV, R2, User DO, and local storage.
  deleteBlueprint(blueprintId: string): Promise<void>;

  // Retry publishing a blueprint whose `dirty` flag is set (meaning a previous propagation
  // to User DO / KV / R2 failed).
  retryBlueprintPublish(blueprintId: string): Promise<void>;

  // --- Collaborator management ---

  // List all collaborators. Available to owner and all collaborators.
  listCollaborators(): Promise<CollaboratorInfo[]>;

  // Add a collaborator by username/email. The caller must be the owner or an existing
  // collaborator. `role` is the access level to grant; the caller may not grant a role higher
  // than their own effective role. Returns the new collaborator's info, or null if the username
  // doesn't correspond to an existing account.
  addCollaborator(username: string, role: CollaboratorRole,
                  note?: string): Promise<CollaboratorInfo | null>;

  // Remove a collaborator (identified by profile.id).
  //
  // Owner can remove anyone. A non-owner collaborator can only remove their own edge(s)
  // from the target. If the target still has edges from other sources, they keep access
  // and the return is an empty array. If no edges remain, the target is fully removed.
  //
  // When a target is fully removed, `keepUsers` lists the profile.ids of users who would
  // lose access transitively but should be retained. Their PermissionEdges through the
  // removed user are replaced with new edges from the caller. Users reachable only through
  // the removed user who are NOT in `keepUsers` are also removed.
  //
  // Returns the list of users whose access actually changed (removed or downgraded), including
  // the primary target. An empty array means the caller's edge was removed but no one's effective
  // access changed (the target retained their role through other edges).
  removeCollaborator(profileId: string, keepUsers: string[]): Promise<AffectedCollaborator[]>;

  // Preview what would happen if a collaborator were removed. For a non-owner caller,
  // if the target has edges from other sources that would survive, returns an empty array
  // (the target would not actually be affected). Otherwise, returns the list of users whose
  // access would change (lose access or be downgraded to a lower role) as a consequence, so the
  // caller can present checkboxes for which to keep vs. remove.
  previewRemoveCollaborator(profileId: string): Promise<AffectedCollaborator[]>;

  // --- Share key management ---

  // Create a share key. The server generates a random 128-bit key, stores its HMAC-SHA-256
  // hash, and returns the raw key (hex-encoded). The caller constructs a URL from it. The
  // raw key is never stored server-side. `role` is the access level granted to anyone who
  // redeems the key; the caller may not grant a role higher than their own effective role.
  createShareKey(role: CollaboratorRole, note?: string): Promise<{ key: string }>;

  // List active share keys (for management UI).
  listShareKeys(): Promise<ShareKeyInfo[]>;

  // Update share key management metadata. The raw share key is not available after creation;
  // this only edits the stored note used by the management UI.
  updateShareKey(keyId: string, note?: string): Promise<void>;

  // Revoke a share key by its ID (the HMAC hash). Users who gained access through this key may be
  // transitively removed or downgraded. `keepUsers` lists profile.ids of users who should be
  // retained at their prior role with fresh edges from the caller. Returns the list of users
  // whose access actually changed (removed or downgraded).
  revokeShareKey(keyId: string, keepUsers: string[]): Promise<AffectedCollaborator[]>;

  // Preview what would happen if a share key were revoked. Returns the list of users whose access
  // would change (lose access or be downgraded to a lower role) as a consequence, so the caller
  // can present checkboxes for which to keep vs. remove.
  previewRevokeShareKey(keyId: string): Promise<AffectedCollaborator[]>;
}

export type AiChatMetadata = {
  id: number,
  title: string,
  started: Date,
  lastActive: Date,

  // If present, an LLM (described by the author info) is currently actively responding to the
  // chat.
  activeAgent?: AiChatAuthorInfo,

  // If true, this chat thread has proposed changes which have not been accepted yet,
  // including any live draft edits that have not yet been materialized into a durable
  // `changes` message.
  hasProposedChanges?: boolean;

  // If this was started from an agent spawner, the spawner's display name.
  spawnerName?: string;

  // Total tokens in this conversation so far, if known.
  totalTokens?: number;

  // Total cost of this conversation so far, in dollars, if known.
  totalCost?: number;
};

export type AiChatAuthorInfo = {
  // Is the author a human, AI, or Gadget?
  //
  // "gadget" means this is a prompt sent to an agent spawner -- i.e. a gadget spawned an
  // agent programmatically. In this case `id` is the gadget's owner's ID (for accounting purposes)
  // and `name` is the gadget title.
  type: "user" | "agent" | "gadget";

  // Unique user identifier, e.g. "kenton@cloudflare.com" or "gpt-5.1-pro".
  id: string;

  // Display name for author, e.g. "Kenton Varda" or "GPT"
  name: string;

  // Note: the avatar is intentionally not included here to keep this type lightweight (it's
  // embedded in every chat message). Fetch user avatars separately via
  // `AuthenticatedApi.getAvatar(userId)`.
};

export type AiChatMessage = {
  chatId: number;
  sequence: number;
  timestamp: Date;
  author: AiChatAuthorInfo;
} & AiChatMessageBody;

export type AiChatMessageBody = {
  // A regular chat message.
  type: "message";
  message: string;

  // The message may contain "capsules", which are embedded capabilities that reference external
  // resources. See `CapsuleSpecifier` for more.
  capsules?: CapsuleSpecifier[];

  // If the AI produces any thinking/reasoning text, this is it. This should be hidden by default
  // but the user should have the option to expand it.
  reasoning?: string;

  // Messages from an AI agent can invoke tools.
  toolCalls?: AiToolCall[];

  // Attachments that were sent with this message. Actual bytes stored separately.
  attachments?: ChatAttachmentRef[];
} | {
  // Represents changes made to the code by an agent tool call or by a collaborating user as part
  // of a chat. These changes are provisional until they are accepted.
  type: "changes";
  update: Uint8Array;
} | {
  // Indicates that at this point in the chat, the user chose to merge all (non-reverted) changes
  // in this chat up to and including the given sequence number.
  type: "merge";
  mergeThrough: number;

  // Code version at which the merge was applied.
  version: number;
} | {
  // Indicates that at this point in the chat, the user chose to revert all changes starting at the
  // given sequence number through the end of the chat as of that time. These changes are
  // completely erased from the Yjs history. Subsequent changes will be based only on what existed
  // before this point, and any later merge will not include the reverted changes.
  type: "revert";
  revertFrom: number;
} | {
  // Indicates that the agent in this chat performed an action.
  type: "action",
  actionId: number;

  // Denormalized description of the action.
  //
  // This is inlined into the message at the time of query, so it is always present and always
  // current in messages delivered to the client. It is marked optional only because it is not
  // present in messages stored in the chat table on the server side.
  actionLog?: ActionLogEntry;
} | {
  // Indicates that the AI agent accessed the gadget one or more times. This is logged in order
  // to track whether information known to the gadget may have tainted the agent session.
  type: "useGadget";
} | {
  // Indicates that the agent run ended with an error (e.g. LLM API failure, abort, server
  // restart). This is displayed to the user with a "retry" button, but is NOT included in the
  // chat log sent to the LLM so the agent does not react to it.
  type: "error";
  message: string;
  // Optional machine-readable code so the client can react specially (e.g. "usage_limit" opens
  // the "connect Cloudflare / add credits" modal instead of a generic error + retry).
  code?: string;
} | {
  // Indicates that a callback was received on the agent's `self` object. When the agent uses
  // `executeCode`, the executed code receives a `self` parameter. Calling any method on `self`
  // (e.g., `self.onUpdate(data)`) delivers a callback message back to this chat thread and
  // activates the agent to respond.
  type: "agentCallback";

  // The method name that was called on `self`.
  methodName: string;

  // A depth-limited summary string of the arguments for the agent's context window.
  argsSummary: string;
} | {
  // A system-generated nudge message sent to the agent when it tries to end its turn while
  // agent callbacks are still unresolved. This is displayed as a user message to the LLM
  // so it can be prompted to continue.
  type: "agentNudge";
  text: string;
} | {
  // The agent requested that the user connect a gatekeeper (e.g. "I need ClickHouse cluster X").
  // Rendered inline in the chat as an accept/deny card. State is mutated in-place when the user
  // accepts or denies; the message is re-delivered to subscribers so the card updates. On accept the
  // agent is resumed with the outcome (see the history builder in agent.ts); on deny the agent is
  // not resumed (the user drives what happens next).
  type: "connectionRequest";

  // Unique id used by acceptConnectionRequest()/denyConnectionRequest().
  requestId: string;

  // The gatekeeper vendor the agent is requesting (id + denormalized display name).
  vendorId: string;
  vendorName: string;

  // Denormalized vendor logo URL, for the connection card icon.
  vendorLogoUrl?: string;

  // Denormalized human-readable resource type/scope being requested (e.g. "Home Assistant
  // Instance", "Gmail Mailbox"), resolved from the vendor's supported resources at request time.
  resourceTitle?: string;

  // A fully- or partially-specified resource URL, if the agent could infer one. When absent (or
  // incomplete) the accept flow opens the vendor's resource configurator to fill in the gaps.
  resourceUrl?: string;

  // The urlPattern of the supported resource this request resolved to at request time (one of the
  // vendor's SupportedResource.urlPattern values, e.g. "https://github.com/:owner/:repo" or the
  // whole-instance "https://*"). The backend guarantees every connection request resolves to a
  // concrete resource (see resolveRequestedResource), and the accept modal pre-selects exactly this
  // resource — so accepting never opens a blank "create new connection" picker.
  resourceUrlPattern?: string;

  // Why the agent wants this connection. Shown to the user to inform their decision.
  reason: string;

  // Lifecycle state. Starts "pending"; set by the user's accept/deny.
  state: "pending" | "accepted" | "denied";

  // Once accepted, the id of the created gatekeeper. The resource is surfaced to the agent as a
  // chat-scoped capsule (env[N]); the agent can promote it to a permanent binding via
  // saveCapsuleAsBinding if its gadget code needs it.
  gatekeeperId?: number;
};

// Bytes to upload as a chat attachment.
//
// The server stores the bytes and returns the handle to pass when sending the message.
export type ChatAttachmentUpload = {
  mimeType: string;
  content: Uint8Array;
  name?: string;
};

// Handle for an attachment that has been uploaded but not yet sent as part of a message.
//
// Pass this back unchanged when sending the chat message.
export type ChatAttachmentHandle = {
  // Clients must not infer storage paths from this ID or construct handles by hand.
  id: string;
};

// Attachment metadata returned to clients.
//
// For image attachments, `content` carries the full image bytes inline so the client can render
// them in the chat without an extra round trip. For other attachments, fetch the bytes on demand
// via `Overseer.getChatAttachmentContent()`.
export type ChatAttachmentRef = ChatAttachmentHandle & {
  mimeType: string;
  name?: string;
  size: number;

  // Inlined bytes for small image attachments. Present only for images.
  content?: Uint8Array;
};

// Whether attachment bytes can be decoded and inlined into the agent's prompt as text.
export function isTextLikeAttachmentMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return false;
  return mimeType.startsWith("text/") ||
      /\b(json|javascript|typescript|xml|yaml|csv|markdown)\b/.test(mimeType);
}

// Describes a tool call performed by an AI agent as part of a message.
export type AiToolCall = {
  // ID of the original tool call, useful to reproduce the model messages.
  toolCallId: string;

  // If present, this tool observed the code at the given version number.
  //
  // Note that generally once the agent observes code at a particular version, the server tries
  // to stay at that version for the rest of the thread, to avoid confusing the agent.
  observedCodeVersion?: number;

  // If the tool failed, the error.
  error?: string;
} & ({
  toolName: "readFile";
  input: {filename: string};
} | {
  toolName: "writeFile";
  input: {
    filename: string;
    content: string;
  };
} | {
  toolName: "editFile";
  input: {
    filename: string;
    textToReplace: string;
    replacement: string;
  };
} | {
  toolName: "describeBinding";
  input: {
    name: string | number;
  };
} | {
  toolName: "setBindingHook";
  input: {
    bindingName: string;
    entrypoint: string | null;
  };
} | {
  toolName: "saveCapsuleAsBinding";
  input: {
    capsuleId: number;
    bindingName: string;
  };
} | {
  toolName: "executeCode";
  input: {
    code: string;
  };

  // Output, if the code actually ran. (Otherwise, `error` should be present.)
  output?: string;
} | {
  toolName: "giveUp";
  input: {
    error: string;
  };
} | {
  toolName: "webFetch";
  input: {
    url: string;
    // If true, return the raw response body without Markdown conversion.
    raw?: boolean;
  };

  // Output, if the fetch actually completed. (Otherwise, `error` should be present.) This is
  // stored so that the agent's chat history can be replayed without re-issuing the fetch.
  // Formatted as a YAML-frontmatter header followed by the body (see formatWebFetchResult).
  output?: string;
} | {
  // This actually shouldn't ever appear in logs unless the agent misunderstands the tool.
  toolName: "observeUserChanges";
  input: {};
} | {
  // List the resource types a gatekeeper vendor offers, so the agent can construct a resourceUrl
  // for requestConnection. Resource patterns are only surfaced on demand (not in the system prompt).
  toolName: "listConnectableResources";
  input: {
    vendorId: string;
  };
  output?: string;
} | {
  // Ask the user to connect a gatekeeper, pre-configured as much as the agent can manage. Renders
  // an accept/deny card in the chat; non-blocking (the turn ends, and the agent is resumed if the
  // user accepts; on deny the agent is not resumed).
  toolName: "requestConnection";
  input: {
    vendorId: string;
    resourceUrl?: string;
    reason: string;
  };
  output?: string;
});

// TODO: Extend AiToolCall for code-mode tool calls.
// - Includes inline audit logs from the action.
// - Actions can be approved or rejected inline.

// Capsules are resource references that are embedded inline in a chat message. The name comes
// from the fact that they are represented as a pill-shaped inline element, and that they represent
// a capability (in the capability-based security sense).
//
// When the user is typing a chat message and inserts a link into the message, they will be
// prompted to turn the link into a capsule. Doing so implicitly creates a gatekeeper and grants
// the agent permission to use it.
export type CapsuleSpecifier = {
  // Position and length of the text within the chat message which should be replaced by the
  // capsule. The chat message contains some placeholder text which the capsule replaces. This
  // placeholder text exists mostly for ease of debugging -- it is never actually displayed to
  // the user nor the agent. Typically, the placeholder text should be an integer in square
  // brackets, where the integer is the position of the capsule within the message's capsule
  // list, e.g. `[0]`, `[1]`, etc. However, nothing should actually depend on the placeholder
  // text's content; the CapsuleSpecifier itself is all that matters.
  position: number;
  length: number;

  // ID of the gatekeeper, which should have been created using newGatekeeper() or similar.
  gatekeeperId: number;

  // Denormalized resource description from calling GatekeeperClient.describe() at the time of
  // insertion. We store this in the chat message to avoid the need to start up the gatekeeper
  // to ask for it again every time the message is displayed.
  description: ResourceDescription;
};

// One provisional streaming event emitted while an agent step is still in progress.
//
// At most one provisional stream is active per chat at a time. The client should not persist
// these events. Instead, it should display them temporarily and discard them as soon as the
// corresponding durable `message()` and/or `changes` message arrives, or when the agent stops
// running (`activeAgent` becomes unset in the chat metadata).
export type AiChatStreamEvent = {
  type: "textDelta";
  delta: string;
} | {
  type: "reasoningDelta";
  delta: string;
} | {
  type: "toolCallStarted";
  toolCallId: string;
  toolName: AiToolCall["toolName"];
} | {
  // For the executeCode tool specifically, we stream the code as the AI writes it. (For all other
  // tool calls, the tool inputs are not streamed -- though writeFile and editFile separately
  // stream codeUpdate messages.)
  type: "toolCodeDelta";
  toolCallId: string;
  delta: string;
} | {
  // This is a provisional UI lifecycle event. For most tools it means the full tool call input has
  // been received, so the tool is no longer visually "in progress". executeCode does not emit this
  // during streaming; its provisional card is cleared when the final durable message arrives.
  type: "toolCallFinished";
  toolCallId: string;
} | {
  // Indicates which file the agent is currently editing, if any. This is emitted while a
  // writeFile/editFile call is streaming, and set to null when a non-edit tool becomes active.
  type: "setActiveFile";
  filename: string | null;
} | {
  // Streaming write/edit target file, used by the UI before the finalized tool call arrives.
  type: "toolCallTarget";
  toolCallId: string;
  target: string;
} | {
  type: "toolOutputDelta";
  toolCallId: string;
  delta: string;
} | {
  type: "codeReset";
} | {
  type: "codeUpdate";
  update: Uint8Array;
};

// Interface implemented by the client to receive action-log upserts.
export interface ActionsSubscriber {
  entry(record: ActionLogEntry): void;
  ready(): void;
}

// Interface implemented by the client to receive callback notifications whenever there is new
// chat activity. Use Overseer.subscribeToChat() to register a subscriber.
export interface AiChatSubscriber {
  // Sent exactly once, at the start of a subscription, before any other callbacks. Carries an
  // opaque value identifying the current server (Overseer DO) instance. If a resubscribing client
  // sees a different value than on its previous subscription, the DO has fully restarted since
  // then, meaning any in-flight provisional stream content was lost and will be re-streamed from
  // scratch; the client should discard its provisional streaming state. An unchanged value (a
  // plain network reconnect to the same live instance) means provisional state should be kept.
  streamGeneration(generation: number): void;

  // Metadata for the given chat thread has changed, or a new chat thread was created.
  metadata(chat: AiChatMetadata): void;

  // Indicates the chat thread was deleted.
  deleted(chatId: number): void;

  // Adds a message to the chat.
  message(msg: AiChatMessage): void;

  // Delivers one persisted live-draft update for a chat branch. Subscriptions replay all currently
  // stored draft updates for a chat so newly-joined clients can reconstruct the editable branch
  // state without a separate fetch.
  draftUpdate(chatId: number, timestamp: Date, author: AiChatAuthorInfo, update: Uint8Array): void;

  // Indicates that all persisted live-draft updates for the given chat were cleared.
  draftCleared(chatId: number): void;

  // Delivers one provisional streaming event. Clients may ignore event types they don't support.
  stream(chatId: number, event: AiChatStreamEvent): void;
}

// Interface implemented by the client to receive callback notifications about console logs written
// by the gadget.
export interface ConsoleLogSubscriber {
  // Deliver a batch of logs. Often just one log is delivered at a time, but for efficiency they
  // may be batched.
  //
  // If `chatId` is non-null, then the logs were generated while running the version of the gadget
  // code including the changes in the given chat. This can be used to associate the logs with
  // an ongoing agent session and report them to that session.
  event(chatId: number | null, logs: ConsoleLogEvent[]): Promise<void>;
}

export type ConsoleLogEvent = {
  timestamp: Date;

  level: "debug" | "info" | "log" | "warn" | "error";

  // The parameters that were passed to the log function, represented as an array of serializable
  // values.
  message: any[];
}

// Information about one of a Gadget's gatekeepers, for the purpose of displaying it in a list.
export type GatekeeperMetadata = {
  bindingName: string;
  resourceTitle: string;
  vendorId?: string;
};

// =======================================================================================
// Blueprint types
// =======================================================================================

// Describes how a gatekeeper was originally created. Stored on each GatekeeperRecord so that
// bindings can be recreated and blueprint metadata can be derived.
export type GatekeeperCreationSpec = {
  type: "gatekeeper";
  vendorId: string;        // identifies the gatekeeper adapter (e.g. "google")
  resourceUrl: string;
  typeUrlPattern: string;  // URL pattern from the vendor's SupportedResource (not the specific URL)
} | {
  type: "aiModel";
  modelId: string;         // the user's configured model ID
  provider: string;        // provider name (e.g. "anthropic")
  modelName: string;       // model name on the provider's API (e.g. "claude-sonnet-4-6")
} | {
  type: "agentSpawner";
  config: AgentSpawnerConfig;

  // Denormalized from the creating user's model config at binding creation time.
  // Absent when config.modelId is null. Used to populate blueprint suggestedModel
  // without requiring a live lookup.
  modelProvider?: string;
  modelName?: string;
};

// User-provided metadata controlling how a gatekeeper binding should appear in blueprints.
// Stored on each GatekeeperRecord. Optional: when absent, the binding is included in the
// blueprint with a generated title, empty description, and no resource suggestion.
//
// Legacy field `included` may still be present on records written by older versions of
// the workshop. The backend still honors `included: false`, but new writes omit it.
export type BlueprintBindingAnnotation = {
  title: string;           // friendly name shown to people using the blueprint
  description: string;     // explains what resource to connect (may be empty)
  suggestValue?: boolean;  // include the specific URL/model as a suggestion
};

// Describes one binding required by a blueprint. Stored in BlueprintMetadata.bindings as a
// Record keyed by binding name. Consumers identify bindings by their key (the binding name)
// while `title` and `description` provide user-facing text.
export type BlueprintBinding = {
  title: string;        // friendly name shown to people using the blueprint
  description: string;  // explains what resource to connect here (may be empty)
} & ({
  // A regular external-resource gatekeeper binding.
  type: "gatekeeper";

  // Identifies the gatekeeper adapter (currently mapped to the workshop's
  // GATEKEEPER_<name> service binding).
  gatekeeperName: string;

  // URL pattern describing the type of resource this binding accepts.
  typeUrlPattern: string;

  // The specific resource URL from the source gadget (suggestion only).
  resourceUrl?: string;
} | {
  // An AI model binding. The user instantiating the blueprint picks one of their own
  // configured models.
  type: "aiModel";

  // The blueprint creator may suggest a particular model to use, or omit this to leave
  // it up to the recipient.
  suggestedModel?: {provider: string, modelName: string};
} | {
  // An agent spawner binding. The config carries over from the source gadget.
  type: "agentSpawner";

  // The blueprint creator may suggest a particular model to use, or omit this. (The
  // value is `null` if the suggestion is that AgentSpawnerConfig.modelId should be
  // configured as `null`. This is different from `undefined`, which means no suggestion.)
  suggestedModel?: {provider: string, modelName: string} | null;

  // Rest of the agent spawner config for the binding.
  config: Omit<AgentSpawnerConfig, "modelId">;
});

export type BlueprintScreenshotUpload = {
  mimeType: "image/jpeg" | "image/png";
  content: Uint8Array;
};

export const BLUEPRINT_SCREENSHOT_R2_PREFIX = 'screenshots/';
export const BLUEPRINT_SCREENSHOT_PATH_PREFIX = '/blueprint-screenshot/';

export function blueprintScreenshotUrl(id: string, metadata: { screenshot?: true, lastUpdated: Date }): string | undefined {
  return metadata.screenshot ?
      `${BLUEPRINT_SCREENSHOT_PATH_PREFIX}${id}?v=${metadata.lastUpdated.valueOf()}` : undefined;
}

// General metadata about a blueprint. Stored (in slightly different wrapper records) in
// three locations: Gadget DO, User DO, and KV.
export type BlueprintMetadata = {
  title: string;
  description: string;  // longer-form description of what the blueprint does
  author: AiChatAuthorInfo;
  created: Date;

  version: number;       // increments every time the blueprint is updated
  lastUpdated: Date;

  // If present, a screenshot is stored separately from the metadata. The server uses this
  // to decide when to include a derived screenshotUrl.
  screenshot?: true;

  // Key = binding name.
  bindings: Record<string, BlueprintBinding>;
};

// Public view (returned by PublicApi.getBlueprint).
export type BlueprintPublicInfo = {
  id: string;
  metadata: BlueprintMetadata;

  // If present, browser-loadable URL for the public screenshot.
  screenshotUrl?: string;
};

// Gadget-side summary (returned by Overseer.listBlueprints).
export type BlueprintGadgetSummary = {
  id: string;
  title: string;
  description: string;
  version: number;
  codeVersionDate: Date;  // timestamp of the exported code version
  screenshotUrl?: string;
  dirty?: boolean;        // true if last publish failed and needs retry
};

// User-side summary (returned by AuthenticatedApi.listOwnBlueprints and getOwnBlueprint).
export type BlueprintUserSummary = {
  id: string;
  title: string;
  description: string;
  gadgetId: string;       // source gadget (may no longer exist)
  gadgetTitle: string;
  version: number;
  lastUpdated: Date;
  pinned?: boolean;
};

// User-side library summary (returned by AuthenticatedApi.listLibraryBlueprints).
export type BlueprintLibrarySummary = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
  pinned?: boolean;
};

// Binding assignment (input to newGadgetFromBlueprint).
// When instantiating a blueprint, the user provides a Record mapping binding name ->
// assignment. Every required binding in the blueprint must have a corresponding entry.
export type BlueprintBindingAssignment = {
  type: "gatekeeper";
  accountId: number;      // user's connected account ID
  resourceUrl: string;
} | {
  type: "aiModel";
  modelId: string;        // one of the user's configured models
} | {
  type: "agentSpawner";
  modelId: string | null; // model to run, or null for no agent
};

export interface GatekeeperClient<Session extends RpcCompatible<Session>> extends RpcTarget {
  // Remove this gatekeeper from the Gadget.
  remove(): Promise<void>;

  // Get the gatekeeper's numeric ID. These are assigned sequentially for all gatekeepers created
  // in a particular gadget, including those used in capsules in chat threads (which may not have
  // a binding name assigned).
  getId(): Promise<number>;

  // Get and set the binding name. A gatekeeper may not have a binding name if it is referenced
  // only via a capsule in a particular chat thread, but a binding name can be assigned to such
  // a gatekeeper later to promote it to a permanent member of `env`.
  getBindingName(): Promise<string | null>;
  setBindingName(name: string): Promise<void>;

  // If the gatekeeper doesn't already have a binding name set, assign one based on the resource's
  // own suggestion. Return whatever the binding name is now.
  setSuggestedBindingName(): Promise<string>;

  // Get the resource description, including the schema of its RPC interface.
  describe(): Promise<ResourceDescription>;

  // Open a direct session to this gatekeeper. Particularly useful when using the AI agent to talk
  // to the resource directly.
  openSession(): Promise<RpcStub<Session>>;

  // Get the creation spec describing how this gatekeeper was originally created.
  getCreationSpec(): Promise<GatekeeperCreationSpec>;

  // Get the blueprint annotation for this binding, if one has been set.
  getBlueprintAnnotation(): Promise<BlueprintBindingAnnotation | null>;

  // Set the blueprint annotation for this binding. The gatekeeper must have a bindingName
  // assigned (annotations only apply to named bindings).
  setBlueprintAnnotation(annotation: BlueprintBindingAnnotation): Promise<void>;

  // TODO: Get/set permissions.
}

// The level of access a collaborator (or share key) grants.
//
// - "build": full access -- edit code, use and participate in chats, manage bindings, etc. (the
//   same access the owner has, modulo the owner-only exceptions documented in sharing.md).
// - "use": may only render and interact with the gadget's deployed UI (getUiBundle() and
//   connectToGadget() on the mainline code), plus read basic metadata.
//
// Roles are ordered build > use. A collaborator's effective role is the maximum role reachable
// from the owner through their valid permission edges, where each edge grants
// min(edge role, sharer's effective role). The owner is the implicit root at "build".
export type CollaboratorRole = "build" | "use";

// Describes how one user came to have collaborator access.
export type PermissionEdge = {
  created: Date;

  // The role granted by this edge. Absent on edges created before roles were introduced; such
  // edges are treated as "build" for backwards compatibility.
  role?: CollaboratorRole;
} & ({
  // Granted directly by another user.
  type: "user";
  sharer: string;  // profile.id of the person who shared
  note?: string;
} | {
  // Gained by redeeming a share key.
  type: "shareKey";
  keyId: string;   // HMAC-SHA-256 hex of the raw key
});

// Information about a single collaborator, returned by list/add operations.
export type CollaboratorInfo = {
  profile: AiChatAuthorInfo;
  addedBy: PermissionEdge[];

  // The collaborator's effective role (the maximum role reachable from the owner). Absent implies
  // "build" for backwards compatibility.
  role?: CollaboratorRole;
};

// Describes a collaborator whose access would change (or did change) as a result of a removal or
// share key revocation. Used by the preview/confirm flow, which must surface not only users who
// lose access entirely but also users who would be downgraded to a lower role.
export type AffectedCollaborator = {
  profile: AiChatAuthorInfo;
  addedBy: PermissionEdge[];

  // The effective role before the change.
  oldRole: CollaboratorRole;

  // The effective role after the change, or null if the user loses access entirely.
  newRole: CollaboratorRole | null;
};

// Information about a share key, for the management UI.
export type ShareKeyInfo = {
  keyId: string;
  note?: string;
  created: Date;
  createdBy: AiChatAuthorInfo;

  // The role granted to anyone who redeems this key. Absent implies "build" for keys created
  // before roles were introduced.
  role?: CollaboratorRole;
};
