// This file defines the API that the AI Gadgets Workshop uses to talk to Adapters. Each Adapter
// provides connectivity to some external service which AI Gadgets can then manipulate. Each
// installation of the Gadgets Workshop may have access to different adapters, typically based on
// the set of internal services used at the particular company.
//
// For instance, there might be adapters for Google Workspace, GitHub, Jira, etc.
//
// Adapters provide access to resources. For instance, a Google Workspace adapter might provide
// access to Google Docs, Spreadsheets, Gmail mailboxes, etc. Each Google Doc, for example, is a
// separate "resource". Adapters are designed to provide object-oriented, capability-based access
// to such resources, enabling the Gadget Workshop to grant a particular Gadget fine-grained
// access to just the things the user wants that Gadget to access.
//
// Each adapter is deployed as a completely independent Workers application from the Gadgets
// Workshop itself, and is provided to the Workshop as a service binding. The Workshop communicates
// with the adapter over JavaScript RPC. The types in this file define that RPC interface. The
// `Adapter` type is the root interface implemented by the service binding.

import type { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";

// A small image used to identify a vendor, account, or resource type in the UI.
export type AvatarImage = {
  url: string;
}

// Describes a connected GatekeeperVendor, for display purposes.
export type VendorDescription = {
  // Human-readable name of the service, e.g. "Google", "GitHub", etc.
  displayName: string;

  // URL of the service's home page.
  url: string;

  // Logo for the service.
  logo?: AvatarImage;

  // Background color used behind the logo in connector UI.
  color?: string;

  // Short tagline shown beneath the name on cards on the Connectors page.
  // E.g., "Draft replies, edit docs, and analyze data"
  tagline?: string;

  // 2-3 sentence description of what this Gatekeeper does and enables users to build.
  // This is shown in detail modals on the Connectors page.
  // E.g. "Connect your Google account to give Gadgets access to Gmail, Google Docs, and BigQuery.
  // Build agents that triage email, draft and edit documents, or run analytics queries on your data."
  description?: string;

  // True if this vendor can authenticate a user for sign-in: i.e. its connect flow yields a
  // provider-verified email (via GatekeeperUser.getAuthenticatedEmail()). The Workshop may offer
  // such a vendor as a login method, subject to its own auth allowlist. Defaults to false.
  providesAuth?: boolean;
}

// Describes a single permission/scope that a gatekeeper will request during the connect flow.
// These are shown in the "Permissions" section of the connect modal so the user can review
// what they're granting before being redirected to the provider.
export type VendorScope = {
  // Label shown to the user (e.g. "Read and label emails").
  displayName: string;

  // Why this scope/permission is requested. Shown under `displayName`.
  rationale: string;
}

// Describes a connected user account on an external service, for display purposes.
export type AccountDescription = {
  // User's display name, e.g. "John Doe". This is a non-unique name that is human-readable.
  displayName?: string;

  // Unique, canonical name for this user account. Typically this is what the user would type into
  // the login form when logging in. This may an email address or a Unix-style username.
  uniqueName?: string;

  // User's avatar image.
  avatar: AvatarImage;

  // A list of strings describing what sort of access has been authorized through this connection.
  // This is similar to OAuth scopes, but may or may not literally map to underlying OAuth scopes.
  // Each string is a phrase like: "Read and send emails"
  scope: string[];
}

// Describes metadata about a specific instance of a resource. Returned by Gatekeeper.describe().
export type ResourceDescription = {
  // The resource's canonical URL. This can differ from the one passed to `newGatekeeper()`, if the
  // resource has more than one possible URL. Visiting this URL in a browser should actually open
  // the resource's natural UI.
  url: string;

  // Metadata for display.
  title: string;
  snippet: string;

  // TODO: Other display metadata? Thumbnail, icon, etc?

  // When the binding is first created, it will be given this name (but the user can change it).
  // This is just a convenience so that the user doesn't have to type their own name, although
  // they are free to rename it.
  //
  // This name should usually be based on the binding's type, not the specific resource title,
  // since the coding agent will be able to see the name and the user may or may not intend to
  // reveal the resource title to the agent, or may intend the same Gadget to be connected to
  // different resources (of the same type) at different times.
  suggestedBindingName: string;

  // TODO: Metadata about whether the gatekeeper itself has sufficient authorization to interact
  //   with this resource, and what the user should do if it doesn't. E.g. if the user's OAuth
  //   grant doesn't cover the necessary scopes, this could direct the user to expand their grant.

  // TypeScript type name. Must be the name of one of the exports returned by this gatekeeper's
  // `getTypeScriptTypes()` method.
  tsType: string;

  // Some resources implement the ability for the client to subscribe to events. The application
  // implements a "hook", which is a WorkerEntrypoint that implements the TypeScript interface
  // named by `hookTsType` (which must be one of the exports from `getTypescriptTypes()`).
  hookTsType?: string;
}

// Describes a kind of resource that a vendor can provide access to (e.g. "Jira Issue", "Gmail
// Mailbox") rather than a specific instance.
export type SupportedResource = {
  // URLPattern string for matching URLs, e.g. "https://jira.cfdata.org/*"
  urlPattern: string;

  // Human-readable title for this resource type, e.g. "Jira Issue"
  title: string;

  // Short description of what this resource provides.
  description: string;

  // Optional icon for display in Workshop UI.
  icon?: AvatarImage;
}

// RPC interface exposed by the resource selection/configuration iframe to Workshop.
export interface ResourceConfiguratorIframe extends RpcTarget {
  // Return the resource URL chosen by iframe. Workshop calls this when user selects
  // `Add connection`.
  collectResourceUrl(): Promise<string>;

  // Tell the iframe where it sits in parent viewport. This is used by some configuration UIs
  // to determine height of dropdowns.
  //
  // `iframeTop` is the iframe's top edge in the parent viewport.
  // `viewportHeight` is the visible height of the parent window.
  updateViewport(iframeTop: number, viewportHeight: number): void;

  // Tell the iframe that the parent window was resized. This is used by some configuration UIs
  // to close open autocomplete dropdowns.
  windowResized(): void;
}

// RPC interface exposed by Workshop to the selection/configuration iframe.
export interface ResourceConfiguratorHost extends RpcTarget {
  gatekeeper: RpcStub<RpcTarget>;

  // Update the parent's iframe sizing to match content in selection/configuration UI.
  // This lets iframe behave like part of the modal while still rendering floating UI naturally.
  //
  // `layoutHeight` is the height reserved for the configuration UI in the connections modal.
  // `height` is the full iframe height, which may be larger when floating UI like autocomplete
  // dropdowns need to render over the modal footer without pushing layout down.
  resize(height: number, layoutHeight: number): void;

  // Tell Workshop whether the current selection is ready to submit.
  // Workshop uses this to determine whether `Add connection` button should be enabled/disabled.
  setSelectionReady(ready: boolean): void;

  // Forward scroll gestures from iframe to parent.
  // Otherwise, when the cursor is over the configuration UI, scroll gestures are swallowed by the iframe
  // when user expects the connections modal to scroll.
  forwardScroll(deltaX: number, deltaY: number): void;
}

export type ResourceConfiguratorFrame = {
  // Complete HTML for the resource selection/configuration UI. Workshop hosts it in a sandboxed iframe.
  iframeHtml: string;

  // Capability exposed to the iframe for any RPCs needed by UI.
  ui: RpcStub<RpcTarget>;
}

// The root interface of an Adapter, as provided to the Gadget Workshop.
//
// An installation of the Gadget Workshop is provided with a set of Adapters to allow it to
// interface with other services.
// Options for GatekeeperVendor.connectAccount(). `scopes` selects the access tier (see that method).
export type GatekeeperConnectOptions = {
  scopes?: "auth" | "full";
};

export interface GatekeeperVendor extends WorkerEntrypoint {
  // Get display info for the service, suitable for display to a user.
  describe(): Promise<VendorDescription>;

  // Start the auth flow to connect to the user's remote account. Returns the URL which the user
  // should open in their browser in order to complete the flow. This URL will be opened in a new
  // tab; when it completes, it should close itself using window.close().
  //
  // When the flow completes, `callback.complete()` should be called to add the connection to the
  // user's list of authorizations. (`callback` can be stored.)
  //
  // A typical implementation creates a UserAccount Durable Object to manage the authorization
  // flow, storing the callback in its storage, then directing the user to a URL that references
  // the DO. Once the user completes the flow, the DO invokes the callback. The DO should set an
  // alarm to delete itself after some timeout if the user fails to complete the flow.
  //
  // SECURITY: The returned URL must include a cryptographic nonce (in addition to the DO ID) to
  // prevent replay attacks. The nonce should be stored in the DO and verified when the user visits
  // the URL. See gatekeeper-google for a reference implementation.
  //
  // `options.scopes` selects how much access to request (default "full"):
  //   - "full": the gatekeeper's full capability scopes (repos, docs, etc.). The resulting
  //     connection is persisted as a usable connected account.
  //   - "auth": only the minimal scopes needed to verify the user's email for sign-in. The grant is
  //     transient — after `complete()` lets the caller read getAuthenticatedEmail(), the gatekeeper
  //     discards it. Vendors without `providesAuth` ignore this and always use their full scopes.
  connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                 options?: GatekeeperConnectOptions): Promise<{url: string}>;

  // Get the list of resource types this vendor supports. Each entry describes a category of
  // resource the vendor can provide access to, along with a URL pattern for matching.
  //
  // `options.userId` specifies the user ID (usually, email address) of the user who is driving the
  // query, which the gatekeeper can consider in deciding what resources are available. If it
  // returns an empty list, then the gatekeeper will be totally hidden from the user.
  //
  // TODO: Providing the user ID here is a temporary hack to enable a hidden internal gatekeeper.
  //   Later on we should come up with a better way to manage which users see which gatekeepers.
  //
  // TODO: How does the Gadget Workshop know when the supported URLs have changed, without polling?
  getSupportedResources(options?: {userId?: string}): Promise<SupportedResource[]>;

  // Returns the catalog of permissions this vendor will request during the connect flow.
  // The workshop displays this in the connect modal so the user can review what they're granting
  // before being redirected to the gatekeeper's consent screen.
  //
  // For vendors that don't have granular permissions, return an empty array.
  getScopeCatalog(): Promise<VendorScope[]>;

  // Returns TypeScript source code defining all types covering APIs defined by this Gatekeeper.
  // The returned string is the content of a `.d.ts` file. All types refereced by
  // `ResourceDescription` must be exported by this file. The types should ideally have complete
  // JSDoc comments describing them.
  //
  // The Gadgets system will parse this file to construct a type database, which will be made
  // available to the coding agent in a way that supports progressive discovery.
  //
  // TODO: Define exactly what global types and imports are available. I suppose capnweb should be
  // importable, but is anything else needed?
  // TODO: How does the Gadget Workshop know when the types have changed, without polling?
  // TODO: Should we somehow distinguish stable vs. unstable types? Unstable are safe to use in
  //   one-off situations only.
  getTypeScriptTypes(): Promise<string>;
}

export interface GatekeeperConnectCallback extends WorkerEntrypoint {
  // Indicates the connection completed successfully.
  //
  // `expiresAt`, if provided, indicates when the credentials are expected to expire. This allows
  // the Workshop to proactively show the account as expired in the UI without waiting for an
  // operation to fail. If not provided, the system relies on the gatekeeper calling
  // `credentialsExpired()` when a failure is detected.
  complete(user: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void>;

  // Note: If the authorization flow fails, the error can be displayed directly to the user, and
  // the callback can be discarded.

  // Called when the gatekeeper discovers that credentials have expired or been revoked (e.g., a
  // token refresh fails with an authorization error). The Workshop records this and notifies
  // subscribers so the UI can reflect the expired state.
  //
  // The gatekeeper should avoid calling this repeatedly -- once is sufficient. Subsequent calls
  // are harmless but redundant.
  credentialsExpired(): Promise<void>;

  // Called when credentials have been restored (e.g., after a reconnect flow completes).
  // `expiresAt` is the new expected expiration date, if known.
  credentialsRestored(expiresAt?: Date): Promise<void>;
}

// RPC interface to an Adapter. This is a privileged interface exposed to the Gadget Workshop UI
// itself, not to Gadgets nor AI agents.
//
// The Adapter is already specialized for a particular human user of the Gadget Workshop. The
// Adapter capability itself represents permission to access all of the user's data that is
// available through it, so needs to be guarded carefully. Hence, only the Workshop itself should
// ever have direct access to an Adapter object.
export interface GatekeeperUser extends WorkerEntrypoint {
  // Get display info for an account, suitable for display to a user.
  describe(): Promise<AccountDescription>;

  // Typically returns the same as GatekeeperVendor.getSupportedResources(), though an
  // implementation could choose to return a narrower set if the specific account does not support
  // every resource that the vendor supports generally.
  getSupportedResources(): Promise<SupportedResource[]>;

  // Get a Durable Object class that can implement a gatekeeper for the given resource. This class
  // can be used to instantiate a Facet which implements the Gatekeeper interface.
  //
  // Note that the Overseer of a Gadget will call this immediately when the user pastes in a URL,
  // *before* the user has actually chosen to grant the Gadget any permissions on the resource.
  // Permissions are requested by instantiating the Gatekeeper and calling setPermissions() on it,
  // usually after first calling describe() to find out what the resource can do.
  //
  // The returned class is imbued (via `ctx.props`) with the user's credentials and the resource
  // ID. The returned `resource` indicates which SupportedResource matched the URL.
  getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }>;

  // Get the UI used to choose a specific resource.
  // `resourceUrlPattern` is the `urlPattern` associated with the supported resource.
  startResourceConfigurator(
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame>;

  // Revoke this account connection. The GatekeeperUser, and all Gatekeepers created through it,
  // become broken.
  revoke(): Promise<void>;

  // Start the flow to refresh/replace credentials on this account. Returns the URL for the user
  // to visit in a new tab to complete re-authentication. When the flow completes, the
  // GatekeeperConnectCallback (provided during the original connectAccount() flow) will be
  // notified via credentialsRestored(). The existing account Fetcher and all gatekeeper bindings
  // created through it continue to work with the new credentials.
  //
  // SECURITY: As with connectAccount(), the returned URL must include a cryptographic nonce to
  // prevent replay attacks.
  reconnect(): Promise<{url: string}>;

  // For vendors that advertise `providesAuth`, returns the account's email address for use as the
  // user's sign-in identity. The email MUST be verified by the provider (e.g. Google
  // `email_verified`, a GitHub primary+verified email, or a Cloudflare account email) — the
  // Workshop keys accounts by email, so an unverified address would allow account takeover.
  // Returns null when the account has no verified email or the vendor does not support auth.
  getAuthenticatedEmail(): Promise<string | null>;

  // TODO:
  // - Query whether account has scope to access a particular URL.
}

// Interface exposed by a Gatekeeper instance implementing a specific resource binding on a
// specific Gadget.
//
// The Gatekeeper executes as a Durable Object Facet, where it is a child of the Overseer. This
// interface is exposed to the Overseer, not directly to the Gadget.
export interface Gatekeeper<Session, Hook extends WorkerEntrypoint = WorkerEntrypoint>
    extends DurableObject {
  // Get more info on the specific resource without actually granting access. This information is
  // to be presented to the user in the UI, before the user actually confirms they want to grant
  // access.
  describe(): Promise<ResourceDescription>;

  // Returns the a subset of the type definitions returned by
  // GatekeeperVendor.getTypeScriptTypes(), specifically covering types used by this Gatekeeper.
  // This allows the agent to be provided with only types relevant to them rather than the entire
  // API space of the vendor, which may support many kinds of resources.
  getTypeScriptTypes(): Promise<string>;

  // Get the capability representing this resource's RPC interface which will be provided to the
  // Gadget.
  //
  // Every operation performed through this session must be submitted to the approval queue.
  // Observations (read-only operations) must be authorized before data is returned to the caller.
  // Side-effecting actions must not actually be performed until they are approved.
  //
  // It is suggested that the gatekeeper "simulate" actions that have not been approved yet, that
  // is, the `Session` interface should reflect the state of the resource as if all actions had
  // been applied. This allows the Gadget to keep working, potentially queuing up additional
  // dependent actions. That said, there is no strict requirement that a gatekeeper does such
  // simulation -- it is really up to the gatekeeper author to decide what is appropriate for the
  // particular API.
  startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session>;

  // ---------------------------------------------------------------------------
  // Callbacks invoked by the overseer to apply (or reject) actions that were previously queued
  // for approval via the ApprovalQueue.
  //
  // Each action is identified by a sequential integer action ID, assigned by the gatekeeper when
  // it submits the action for approval. The action ID is passed back to these methods so the
  // gatekeeper can look up the action details in its own storage.

  // Action was approved. This call should apply the action (or schedule it to be applied).
  //
  // If this throws an exception, the user will be informed that the action failed and given the
  // opportunity to retry or discard.
  //
  // Depending on policy conditions, an action may be approved and applied automatically. However,
  // the gatekeeper is nevertheless expected to submit all actions for approval; there is no mode
  // in which it's OK to skip the check.
  applyAction(action: number): Promise<void>;

  // Indicates that an action was rejected by the user. The gatekeeper should clean up any
  // associated storage.
  //
  // If the returned `restart` flag is true, rejecting this action requires restarting the Gadget.
  // This is sometimes needed by gatekeepers that simulate actions as if they had been approved --
  // the session may be in a state that is difficult to roll back without confusing the Gadget.
  // The Overseer will take care of the restart, possibly after rejecting other actions.
  rejectAction(action: number): Promise<void | {restart?: boolean}>;

  // Attempts to revert an action that was already applied.
  //
  // Gatekeepers are not required to implement this. If unimplemented, the user will be instructed
  // that they need to perform the revert manually based on the action description. High-quality
  // gatekeepers should almost always implement this, though.
  //
  // If the returned `message` is non-null, it is Markdown to be displayed to the user. This may
  // be used, for example:
  // - To give the user additional instructions on how to complete the revert, if not all of it
  //   could be done automatically.
  // - To explain to the user why a revert is not possible, e.g. if other stacked modifications
  //   have been made on top which must be reverted first. (`canRetry` may be true in this case.)
  //
  // `canRetry` should be true if the revert failed (for a reason described in `message`), but
  // it could make sense to retry later. In this case the UI will continue to give the user the
  // option to revert.
  //
  // `restart` has the same meaning as for `rejectAction()`.
  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}>;

  // If the gatekeeper offers a hook, set the hook. Setting to `null` disables the hook.
  //
  // If the gatekeeper doesn't offer a hook, this does nothing.
  setHook(hook: Fetcher<HookInitiator<Hook>> | null): Promise<void>;
}

// Used by a gatekeeper to request an action that has side effects (is not read-only). Any such
// action may be subject to human-in-the-loop approval and audit logging. Whether or not review is
// actually required, the gatekeeper must still submit all actions and wait for apply() to be
// called before applying them.
export interface ApprovalQueue extends RpcTarget {
  // TODO: Method to indicate that the gadget tried to perform an action that the gatekeeper itself
  //   hasn't been authorized to do (e.g. the user hasn't authorized the right OAuth scopes). The
  //   system should direct the user to the right UI to authorize the action.

  // Check whether the gadget should be permitted to make an observation (that is, to read some
  // data from an external service). The gatekeeper calls this on every read operation, and must
  // wait for the response before returning anything to the gadget. The method will return normally
  // if the operation is permitted, or throw an exception if not; the exception should propagate
  // through to the gadget.
  //
  // In many cases, the gatekeeper should actually call this *after* fetching the data from the
  // remote service, so that the description can include details about the actual data. As long
  // as the operation is strictly read-only, and the call is made before actually returning any
  // data to the gadget, this is OK.
  authorizeObservation(description: ObservationDescription): Promise<void>;

  // Submit an action for approval.
  //
  // Unlike `authorizeObservation()`, `submitAction()` is fully asynchronous. It returns
  // immediately (that is, the returned Promise resolves quickly), but the action may not actually
  // be carried out until much later. It's intended that the user might not approve actions until
  // hours or days later, but this shouldn't cause any problems.
  //
  // `action` is a sequential integer action ID assigned by the gatekeeper. It will be passed back
  // to the Gatekeeper's applyAction() or rejectAction() when the action is later approved or
  // rejected.
  //
  // `description` describes the action in a way that can direct UI representation and policy
  // enforcement details.
  //
  // TODO: It would be nice if we can link this with the output gate so that if the submission
  //   does not complete, any SQL writes performed just before submit() are rolled back...
  submitAction(action: number, description: ActionDescription): Promise<void>;
}

// Callback the Gatekeeper uses to invoke a hook when the corresponding event arrives, including
// recording the actions / observations.
export interface HookInitiator<Hook extends WorkerEntrypoint> extends WorkerEntrypoint {
  // Indicates that the hook is about to be invoked.
  //
  // This returns an ApprovalQueue which the gatekeeper may use to register observations and
  // actions resulting from this hook invocation. Most (but not necessarily all) hooks involve an
  // observation. Some hooks may pass callbacks or interpret the return value in a way that causes
  // side effects, which should be registered as actions.
  startHook(): Promise<{hook: Fetcher<Hook>, approvalQueue: ApprovalQueue}>;
}

export type ObservationDescription = {
  // Brief one-line summary of the observation, like an email subject line, to display in a list.
  title: string;

  // A complete description of the action to be taken, in Markdown-formatted natural language.
  // This will be displayed to the approver. It must include all details that might be relevant to
  // consider before approving.
  description: string;

  // ----------------------------------------------------------------------------
  // Policy hints
  //
  // TODO: Define policy hints that might allow a policy engine to make better decisions. A policy
  // engine might want to know things like:
  // - Does the observation include free-form content (that could include prompt injection
  //   attacks)?
  // - Who are the users who may have contributed to such free-from content (to judge if they are
  //   prompt injection risks).
  // - If this content may contain secrets, who are the users that are allowed to view it? This
  //   can help detect situations where the gadget could leak information.

  // If true, then this observation contains sensitive information that MUST NOT be shared with
  // ANYONE except the account owner. This means:
  // - If the gadget is shared already, authorizeObservation() must throw an exception to block
  //   the observation.
  // - All future sharing of the gadget is prohibited.
  // - Once observed, the gadget goes into "lockdown mode" where it can no longer perform any
  //   actions, only make observations. This prevents the gadget from leaking data through other
  //   gatekeepers.
  //
  // TODO(someday): This was added as a stopgap in order to be able to make certain sensitive data
  //   sources available to internal users. In the longer-term, it should be possible to share
  //   sensitive data as long as the recipients also have access to that same data, but this
  //   requires a more complex policy framework to compute.
  prohibitAllSharing?: boolean;
}

// Describes an action submitted to the action approval queue. This contains all the information
// needed to:
// - Decide whether the action needs to be approved and who can approve it.
// - Display the action to the approver for review.
// - Store the action in an audit log.
export type ActionDescription = {
  // Brief one-line summary of the action, like an email subject line, to display in a list.
  title: string;

  // A complete description of the action to be taken, in Markdown-formatted natural language.
  // This will be displayed to the approver. It must include all details that might be relevant to
  // consider before approving.
  description: string;

  // Does the Gatekeeper implement `revertAction()` for this action?
  //
  // It is recommended that all actions implement automatic revert. But, if an action is not able
  // to do so, it should at least use this flag to let the UI know not to offer the option to the
  // user.
  //
  // Note that this being true doesn't necessarily mean that reverting will always work. E.g. by
  // the time the user tries to revert, too many other changes may have been made, making it hard
  // to revert cleanly.
  implementsRevert: boolean;

  // ----------------------------------------------------------------------------
  // Policy hints
  //
  // TODO: Define policy hints that might allow a policy engine to make better decisions. A policy
  // engine might want to know things like:
  // - Which human users are allowed to perform this action directly? Can be used to detect if
  //   the gadget might be influenced by humans to perform actions that said humans couldn't
  //   perform directly.
  // - Which human users might observe the effects of this action? Can be used to track possibility
  //   of leaking secrets.
  // - Is this action reversible? Does reversing require manual intervention or is it fully
  //   automatic?
  // - Does this action strictly create content to be viewed (e.g. creating a Jira ticket), or does
  //   it actively manipulate the world (e.g. flipping a light switch, or deploying a release)?
  // - Does this action include writing free-form content (e.g. text), or only boolean/numeric
  //   content (e.g. flipping a light switch)? Affects the risk of data leaks.
  // - Does this action modify existing content or only create new content? The former is somewhat
  //   riskier since it could damage existing information whereas posting new content is at worst
  //   an annoyance.
}
