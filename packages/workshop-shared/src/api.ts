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

import { RpcStub, RpcTarget } from "@cloudflare/jsrpc";
import { ActionDescription, ResourceDescription } from "./gatekeeper.js";

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

// Top-level API exposed to the user after they have authenticated.
export interface AuthenticatedApi extends RpcTarget {
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

  // TODO: Configure adapters
}

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

export type CodeFile = {
  name: string;
  content: string;
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

  description: ActionDescription;
}

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

  // Get/set source code.
  //
  // TODO:
  // - Replace setCodeFile()/deleteCodeFile() with operational transforms stream.
  // - Replace getCode() with some sort of streaming or on-demand interface.
  getCode(): Promise<CodeFile[]>;
  setCodeFile(name: string, content: string): Promise<void>;
  deleteCodeFile(name: string): Promise<void>;

  // Get the Minion's deployed UI code, to be run inside an iframe sandbox.
  //
  // Returns null if the minion has no deployed UI code (e.g. if it's new, or if it's just an AI
  // agent with no code).
  getUiBundle(): Promise<UiBundle | null>;

  // Open an RPC interface to the Minion's server-side Durable Object facet. The frontend may pass
  // this stub into the Minion's iframe sandbox, so that the Minion UI can communicate with its
  // server side. It can also permit the coding agent to make direct calls.
  // @ts-ignore - TODO: Fix type instantiation issue
  connectToMinion(): Promise<RpcStub<any>>;

  // List all the Minion's current gatekeepers.
  listGatekeepers(): Promise<GatekeeperMetadata[]>;

  // Get an existing gatekeeper by binding name.
  getGatekeeper(bindingName: string): Promise<GatekeeperClient<any> | null>;

  // Try to create a new gatekeeper for this URL. A binding name will be automatically assigned.
  newGatekeeper(resourceUrl: string): Promise<GatekeeperClient<any> | null>;

  // List history of actions.
  // TODO: This should be paginated.
  listActions(): Promise<ActionLogEntry[]>;

  // Approve an action that is currently in the "pending" state. The action will be performed on
  // approval.
  approveAction(id: number): Promise<void>;

  // Reject an action that is in the "pending" state. This notifies the gatekeeper that it will not
  // be approved in the future.
  rejectAction(id: number): Promise<void>;

  // TODO:
  // - Agent chat API
  // - View action queue
  //   - Approve actions
  // - Sharing / access control functions
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
