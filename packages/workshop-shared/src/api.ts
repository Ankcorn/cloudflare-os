// This file defines the API spoken between the Minions Workshop service and the front-end UI.
//
// The UI is a good old "fat client" SPA. Why not use SSR? Because:
// - Users of this UI are likely to have it open often, maybe even all the time. Startup time is
//   less of a concern than with sites you visit only briefly, and assets are likely to be in cache
//   in any case.
// - The Minions themselves are sandboxed on the client side in addition to the server side. This
//   sandboxing requires running code in the browser. It is not plausible to server-side render
//   a Minion itself.
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
// Minions run inside a sandboxed iframe which has no ability to talk to the outside world at all,
// except postMessage() to the parent frame. Through postMessage() exchanges, the Minion can speak
// RPC to the Workshop. Among other things, through this interface, the Workshop provides the
// Minion a stub pointing to the Minion's server-side Durable Object interface.

import { RpcStub, RpcTarget } from "capnweb";
import { AccountDescription, ActionDescription, ObservationDescription, ResourceDescription, VendorDescription } from "./gatekeeper.js";

// Public API exposed to the internet.
export interface PublicApi extends RpcTarget {
  // Authenticates the user using an auth token (typically stored in localStorage).
  //
  // TODO: Is this right for Cloudflare Access?
  authenticate(token: string): Promise<AuthenticatedApi>;

  // Login with username and password.
  //
  // Returns a token to store in local storage and pass to `authenticate()` in the future.
  //
  // Returns null if login failed (no such user or wrong password).
  //
  // TODO: This should be replaced with something based on an external identify provider.
  login(username: string, password: string): Promise<string | null>;
}

// Subscription callback for AuthenticatedApi.subscribeConnectedAccounts().
export interface ConnenctedAccountsSubscriber {
  add(id: number, description: AccountDescription, vendor: VendorDescription): void;
  remove(id: number): void;

  // Called after add() has been called for all accounts known so far.
  ready(): void;
}

// Top-level API exposed to the user after they have authenticated.
export interface AuthenticatedApi extends RpcTarget {
  // Get profile info for the user who is logged in.
  whoami(): Promise<AiChatAuthorInfo>;

  // Set the user's own display name, seen in chats, etc.
  setOwnDisplayName(name: string): Promise<void>;

  // List the user's configured AI models.
  //
  // Note that the list returned here could be different from a particular minion's Overseer,
  // especially if the minion is owned by someone else.
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

  // Open an existing minion.
  //
  // To allow for pipelining ,this throws an exception if the minion doesn't exist.
  openMinion(id: string): Promise<Overseer>;

  // Create a new minion. It will start out titled "Untitled Minion".
  newMinion(): Promise<Overseer>;

  // List metadata about all the user's Minions. Used to display the front-page listing.
  //
  // TODO: Pagination, sort options.
  listMinions(): Promise<MinionMetadata[]>;

  // List all third-party services that this account can connect to.
  listGatekeeperVendors(): Promise<{id: string, description: VendorDescription}[]>;

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
  subscribeConnectedAccounts(subscriber: RpcStub<ConnenctedAccountsSubscriber>)
      : Promise<RpcStub<{}>>;

  // Remove a connected account, revoking the token.
  disconnectAccount(accountId: number): Promise<void>;

  // TODO:
  // - Recreate token on a connected account.
  // - Edit permissions on a connected account.
}

// Supported AI providers.
type AiModelProvider = "openai" | "anthropic" | "google" | "cloudflare" | "ollama";

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
  "anthropic": {
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-opus-4-5": "Claude Opus 4.5",
  },
  "cloudflare": {
    "@cf/qwen/qwen3-coder-480b-a35b-instruct-fp8": "Qwen 3 Coder 480B (Workers AI)",
    "@cf/moonshotai/kimi-k2-instruct": "Kimi K2 Instruct (Workers AI)",
  },
  "google": {
    "gemini-3-pro-preview": "Gemini 3 Pro",
    "gemini-3-flash-preview": "Gemini 3 Flash",
  },
  "ollama": {
    "qwen3-coder:30b": "Qwen 3 Coder 30B (ollama)",
  },
  "openai": {
    "gpt-5.1-codex": "ChatGPT 5.1 Codex",
    "gpt-5.1-codex-max": "ChatGPT 5.1 Codex Max",
  },
};

// Metadata about a Minion. Includes everything needed to render the Minion list on the front
// page.
export type MinionMetadata = {
  // Unique ID for this Minion, used with `openMinion()`. This is a url-safe base64 value chosen
  // randomly when the Minion is created.
  id: string;

  // Human-readable title. Can be modified.
  title: string;

  // TODO:
  // - owner, shared-with
  // - created / modified / activity times
  // - icon? thumbnail?
}

// Describes the client-side UI code for a Minion. Such code is intended to run inside an iframe
// sandbox with no access to the outside world except through an RPC interface to the Workshop
// and to the Minion's server.
export type UiBundle = {
  // URL from which the main bundle of UI code can be downloaded. This download contains all the
  // Minion's client-side assets. The URL is content-addressed to make it highly cacheable, even
  // across multiple Minions sharing the same implementation (blueprint).
  //
  // TODO: Specify the format of what this URL returns. A raw HTML page doesn't quite work because
  //   the client needs to initialize the sandbox with some platform libraries before loading the
  //   Minion itself.
//  url: string;

  // Returns the raw JS code to execute in the Minion iframe.
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
// * denied: Action was rejected by the user.
export type ActionState = "pending" | "approved" | "rejected";

export type ActionLogEntry = {
  // Sequential ID number for the action. Counts up from when the minion was created.
  id: number;

  // Which binding produced this action?
  bindingName: string;

  createdAt: Date;
  appliedAt?: Date;

  state: ActionState;
} & ({
  type: "action";
  description: ActionDescription;
} | {
  type: "observation";
  description: ObservationDescription;
});

// Interface to a Minion's Overseer, used to display the Minion Workshop shell UI around that
// Minion.
export interface Overseer extends RpcTarget {
  // Get metadata describing this minion.
  getMetadata(): Promise<MinionMetadata>;

  // Change the title.
  setTitle(title: string): Promise<void>;

  // Instruct Minion to delete itself, removing it from the User's minion list and deleting all
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
  updateCode(update: Uint8Array): Promise<void>;

  // Get the Minion's deployed UI code, to be run inside an iframe sandbox.
  //
  // Returns null if the minion has no deployed UI code (e.g. if it's new, or if it's just an AI
  // agent with no code).
  getUiBundle(chatId?: number): Promise<UiBundle | null>;

  // Open an RPC interface to the Minion's server-side Durable Object facet. The frontend may pass
  // this stub into the Minion's iframe sandbox, so that the Minion UI can communicate with its
  // server side. It can also permit the coding agent to make direct calls.
  //
  // If `chatId` is specified, then the minion will include changes currently proposed in the given
  // chat.
  //
  // @ts-ignore - TODO: Fix type instantiation issue
  connectToMinion(chatId?: number): Promise<RpcStub<any>>;

  // List all the Minion's current gatekeepers.
  listGatekeepers(): Promise<GatekeeperMetadata[]>;

  // Get an existing gatekeeper by binding name.
  getGatekeeper(bindingName: string): Promise<GatekeeperClient<any> | null>;

  // Try to create a new gatekeeper for this URL. A binding name will be automatically assigned.
  newGatekeeper(resourceUrl: string): Promise<GatekeeperClient<any> | null>;

  // Create a new gatekeeper for an AI model binding. The model can be any returned by
  // listModels().
  newAiModelGatekeeper(modelId: string): Promise<GatekeeperClient<any>>;

  // List history of actions.
  // TODO: This should be paginated.
  listActions(): Promise<ActionLogEntry[]>;

  // Approve an action that is currently in the "pending" state. The action will be performed on
  // approval.
  approveAction(id: number): Promise<void>;

  // Reject an action that is in the "pending" state. This notifies the gatekeeper that it will not
  // be approved in the future.
  rejectAction(id: number): Promise<void>;

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

  // Subscribe to all new chat messages (across all threads).
  //
  // If `startAt` is given, it must be a date in the past. All messages starting from that date
  // will be sent upfront. This is intended to allow resubscribing after being disconnected. If
  // `startAt` is omitted, only new messages will be sent.
  //
  // Generally, a client should subscribe to chats immediately on loading the minion editor. If
  // the client needs to call any methods like `listChats()` to backfill content, it should make
  // these calls after `subscribeToChat()`, so that there's no chance of missing a message. (It is
  // not necessary to wait for `subscribeToChat()` to return -- only to initate the call before
  // other read calls.)
  subscribeToChat(subscriber: RpcStub<AiChatSubscriber>, startAfter?: Date): Promise<RpcStub<{}>>;

  // Starts a new chat with the given initial message.
  //
  // `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
  // (useful when using chat to talk between humans).
  newChat(initialMessage: string, modelId: string | null): Promise<number>;

  // Send a message to the chat from this client. Sending a message causes the LLM to start
  // running if it isn't already.
  //
  // `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
  // (useful when using chat to talk between humans).
  sendChatMessage(chatId: number, message: string, modelId: string | null): Promise<void>;

  // Update the title of a chat. Usually not needed as a title is generated automatically from
  // the first message.
  setChatTitle(chatId: number, title: string): Promise<void>;

  // Indicates that the user has requested that proposed changes through the given sequence number
  // in the chat thread be merged into the mainline.
  mergeChanges(chatId: number, mergeThrough: number): Promise<void>;

  // Indicates that the user has requested that proposed changes starting from the given sequence
  // number in the chat thread be reverted.
  revertChanges(chatId: number, revertFrom: number): Promise<void>;

  // Delete a chat thread.
  deleteChat(chatId: number): Promise<void>;

  // Request that any ongoing LLM session in the given chat immediately stop.
  //
  // If an LLM is running, the session is canceled subscribers will receive a metadata update
  // reflecting this before `stop()` returns.
  //
  // If no LLM is running, `stop()` does nothing and returns immediately.
  stopAgent(chatId: number): Promise<void>;

  // TODO:
  // - Sharing / access control functions
}

export type AiChatMetadata = {
  id: number,
  title: string,
  started: Date,
  lastActive: Date,

  // If present, an LLM (described by the author info) is currently actively responding to the
  // chat.
  activeAgent?: AiChatAuthorInfo,

  // If true, this chat thread has proposed changes which have not been accepted yet.
  hasProposedChanges?: boolean;
};

export type AiChatAuthorInfo = {
  // Is the author a human or AI?
  type: "user" | "agent";

  // Unique user identifier, e.g. "kenton@cloudflare.com" or "chatgpt-5.1-pro".
  id: string;

  // Display name for author, e.g. "Kenton Varda" or "ChatGPT"
  name: string;

  // TODO: URL of author avatar?
  // avatar: string;
};

export type AiChatMessage = {
  chatId: number;
  sequence: number;
  timestamp: Date;
  author: AiChatAuthorInfo;
} & ({
  // A regular chat message.
  type: "message";
  message: string;

  // If the AI produces any thinking/reasoning text, this is it. This should be hidden by default
  // but the user should have the option to expand it.
  reasoning?: string;

  // Messages from an AI agent can invoke tools.
  toolCalls?: AiToolCall[];
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
})

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
  toolName: "editFile";
  input: {
    filename: string;
    textToReplace: string;
    replacement: string;
  };
} | {
  toolName: "describeBinding";
  input: {
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
  // This actually shouldn't ever appear in logs unless the agent misunderstands the tool.
  toolName: "observeUserChanges";
  input: {};
});

// TODO: Extend AiToolCall for code-mode tool calls.
// - Includes inline audit logs from the action.
// - Actions can be approved or rejected inline.

// Interface implemented by the client to receive callback notifications whenever there is new
// chat activity. Use Overseer.subscribeToChat() to register a subscriber.
export interface AiChatSubscriber {
  // Metadata for the given chat thread has changed, or a new chat thread was created.
  metadata(chat: AiChatMetadata): void;

  // Indicates the chat thread was deleted.
  deleted(chatId: number): void;

  // Adds a message to the chat.
  // TODO: Support streaming tokens into individual messages.
  message(msg: AiChatMessage): void;
}

// Information about one of a Minion's gatekeepers, for the purpose of displaying it in a list.
export type GatekeeperMetadata = {
  bindingName: string;
  resourceTitle: string;
};

export interface GatekeeperClient<Session> extends RpcTarget {
  // Remove this gatekeeper from the Minion.
  remove(): Promise<void>;

  // Get and set the binding name.
  getBindingName(): Promise<string>;
  setBindingName(name: string): Promise<void>;

  // Get the resource description, including the schema of its RPC interface.
  describe(): Promise<ResourceDescription>;

  // Open a direct session to this gatekeeper. Particularly useful when using the AI agent to talk
  // to the resource directly.
  openSession(): Promise<Session>;

  // TODO: Get/set permissions.
}
