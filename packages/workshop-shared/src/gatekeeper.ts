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

// Describes a type of resource that a vendor can provide access to. Each entry represents a
// category of resource (e.g. "Jira Issue", "Gmail Mailbox") rather than a specific instance.
export type SupportedResource = {
  // URLPattern string for matching URLs, e.g. "https://jira.cfdata.org/*"
  urlPattern: string;

  // Human-readable title for this resource type, e.g. "Jira Issue"
  title: string;

  // Short description of what this resource provides.
  description: string;
}

// The root interface of an Adapter, as provided to the Gadget Workshop.
//
// An installation of the Gadget Workshop is provided with a set of Adapters to allow it to
// interface with other services.
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
  // A typical implementation might create a short-lived Durable Object to manage the authorization
  // flow, storing the callback in its storage, then directing the user to a URL that interacts
  // with said object. Once the user completes the flow, the DO invokes the callback and deletes
  // itself. The DO might also set an alarm to delete itself after some timeout if the user fails
  // to complete the flow.
  connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{url: string}>;

  // Get the list of resource types this vendor supports. Each entry describes a category of
  // resource the vendor can provide access to, along with a URL pattern for matching.
  //
  // TODO: How does the Gadget Workshop know when the supported URLs have changed, without polling?
  getSupportedResources(): Promise<SupportedResource[]>;

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
  complete(user: Fetcher<GatekeeperUser>): Promise<void>;

  // Note: If the authorization flow fails, the error can be displayed directly to the user, and
  // the callback can be discarded.

  // TODO:
  // - Allow replacing the grant?
  // - Notify of revocation?
  // - Or maybe these should be system-level features?
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
  // ID.
  getGatekeeperClassFor(url: string): Promise<DurableObjectClass<Gatekeeper<any>>>;

  // Revoke this account connection. The GatekeeperUser, and all Gatekeepers created through it,
  // become broken.
  revoke(): Promise<void>;

  // TODO:
  // - Description of user account (name, email, avatar, etc.) to display in an account
  //   chooser / settings dialog.
  // - Query whether account has scope to access a particular URL.

  // TODO:
  // - Some way to check if the grant is expired/revoked? (Or is that a system-level feature?)
}

// Interface exposed by a Gatekeeper instance implementing a specific resource binding on a
// specific Gadget.
//
// The Gatekeeper executes as a Durable Object Facet, where it is a child of the Overseer. This
// interface is exposed to the Overseer, not directly to the Gadget.
export interface Gatekeeper<
    Session, Action = any, RevertInfo = any, Hook extends WorkerEntrypoint = WorkerEntrypoint>
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
  startSession(approvalQueue: RpcStub<ApprovalQueue<Action>>): Promise<Session>;

  // ---------------------------------------------------------------------------
  // Callbacks invoked by the overseer to apply (or reject) actions that were previously queued
  // for approval via the ApprovalCallback.
  //
  // The type `Action` is an arbitrary type defined by the gatekeeper to represent the actions
  // it has queued for approval. It is passed to the Overseer via the ApprovalCallback, and will
  // be passed back verbatim to these methods. The gatekeeper might choose to define `Action` to
  // fully describe the action, or it might simply be an ID pointing into the gatekeeper's own
  // storage; this is entirely up to the gatekeeper to decide.
  //
  // TODO(someday): If we make it possible to persist RPC stubs, then `Action` could become an
  //   RPC interface, and these methods could be methods on that interface instead of on
  //   `Gatekeeper`.

  // Action was approved. This call should apply the action (or schedule it to be applied).
  //
  // If this throws an exception, the user will be informed that the action failed and given the
  // opportunity to retry or discard.
  //
  // Depending on policy conditions, an action may be approved and applied automatically. However,
  // the gatekeeper is nevertheless expected to submit all actions for approval; there is no mode
  // in which it's OK to skip the check.
  //
  // If `revertInfo` is provided, this is an arbitrary value which the overseer should pass back to
  // the gatekeeper if `revertAction()` is later called to attempt to revert this action.
  applyAction(action: Action): Promise<void | {revertInfo?: RevertInfo}>;

  // Indicates that an action was rejected by the user. The gatekeeper should clean up any
  // associated storage.
  //
  // If the returned `restart` flag is true, rejecting this action requires restarting the Gadget.
  // This is sometimes needed by gatekeepers that simulate actions as if they had been approved --
  // the session may be in a state that is difficult to roll back without confusing the Gadget.
  // The Overseer will take care of the restart, possibly after rejecting other actions.
  rejectAction(action: Action): Promise<void | {restart?: boolean}>;

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
  revertAction(action: Action, revertInfo: RevertInfo):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}>;

  // If the gatekeeper offers a hook, set the hook. Setting to `null` disables the hook.
  //
  // If the gatekeeper doesn't offer a hook, this does nothing.
  setHook(hook: Fetcher<Hook> | null): Promise<void>;
}

// Used by a gatekeeper to request an action that has side effects (is not read-only). Any such
// action may be subject to human-in-the-loop approval and audit logging. Whether or not review is
// actually required, the gatekeeper must still submit all actions and wait for apply() to be
// called before applying them.
export interface ApprovalQueue<Action> extends RpcTarget {
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
  // `Action` is an arbitrary type defined by the gatekeeper, which describes the action to be
  // performed. The value `action` will be passed back to the Gatekeeper's applyAction() or
  // rejectAction() when the action is later approved or rejected.
  //
  // `description` describes the action in a way that can direct UI representation and policy
  // enforcement details.
  //
  // TODO: It would be nice if we can link this with the output gate so that if the submission
  //   does not complete, any SQL writes performed just before submit() are rolled back...
  submitAction(action: Action, description: ActionDescription): Promise<void>;
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
