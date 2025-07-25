// This file defines the API that the AI Minions Workshop uses to talk to Adapters. Each Adapter
// provides connectivity to some external service which AI Minions can then manipulate. Each
// installation of the Minions Workshop may have access to different adapters, typically based on
// the set of internal services used at the particular company.
//
// For instance, there might be adapters for Google Workspace, GitHub, Jira, etc.
//
// Adapters provide access to resources. For instance, a Google Workspace adapter might provide
// access to Google Docs, Spreadsheets, Gmail mailboxes, etc. Each Google Doc, for example, is a
// separate "resource". Adapters are designed to provide object-oriented, capability-based access
// to such resources, enabling the Minion Workshop to grant a particular Minion fine-grained
// access to just the things the user wants that Minion to access.
//
// Each adapter is deployed as a completely independent Workers application from the Minions
// Workshop itself, and is provided to the Workshop as a service binding. The Workshop communicates
// with the adapter over JavaScript RPC. The types in this file define that RPC interface. The
// `Adapter` type is the root interface implemented by the service binding.

// =======================================================================================
// Some basic types, not specific to adapters.

// This type is actually provided by the Workers Runtime. It is the type of an "actor class binding"
// for use with Durable Object Facets, implemented in this PR:
//     https://github.com/cloudflare/workerd/pull/4123
//
// This is essentially a reference to some code implemented in an entirely different Worker. It
// can be bound with some metadata which will be delivered to that other worker whenever the code
// is invoked.
//
// This is similar to a Workers service binding, except that the caller additionally provides the
// callee with a sqlite database where it can store some state. The interface to this storage is
// exactly the same as in a Durable Object implementation, hence the class on the callee side
// implements `DurableObject`, even though it is not directly a member of a Durable Object
// namespace.
interface DurableObjectClass<T> {}

// Represents some text which is to be presented to the human user, so may need localization.
type Prose = {
  text: string;

  // TODO: Expand to support localization.
};

// Identifies a user.
type UserId = {
  // All users are identified by email address. This is the most natural identifier as essentially
  // all services understand it, and we need to understand a user's permissions across multiple
  // services.
  email: string;

  // The email canonicalization style used by this email's domain, e.g. whether or not '.'s are
  // ignored. If this field is not present, then no attempt has been made to determine the style.
  // If present but "unknown", then an attempt was made but the host's email infrastructure
  // couldn't be determined. (It's usually possible to tell which service a host uses by examining
  // MX records.)
  //
  // TODO: Think more about how this would actually be used.
  canonicalization?: "unknown" | "gmail" | "hotmail";
}

// =======================================================================================
// Schema types
//
// These types are used by adapters to describe their own functionality.

// Describes the capabilities of an adapter.
type AdapterSchema = {
  // Human-readable label and summary of what this adapter provides access to.
  title: Prose;
  summary: Prose;

  // All resource types implemented by this adapter.
  resources: ResourceSchema[];
}

// Describes a resource type implemented by an adapter.
//
// For example, a Google Sheet might be a resource provided by the Google adapter. A
// ResourceSchema would describe the common properties of all Google Sheets.
type ResourceSchema = {
  // Stable identifier for this resource, uniquely identifying it among resources exposed by the
  // adapter. Alphanumeric camelCase only.
  name: string;

  // Human-readable label and summary of what this resource represents.
  title: Prose;
  summary: Prose;

  // URL patterns which this adapter recognizes as pointing to resources of this type. Any URL
  // matching the pattern can be passed to `UserAdapter.newGatekeeper()`.
  //
  // These strings are in the format accepted by the URLPattern API.
  urlPatterns: string[];

  parent?: string;
  children: string[];

  // The set of permissions that a Minion might be granted on this resource.
  permissions: PermissionSchema[];

  apiType: string;
  apiTsUrl: string;
};

// Describes a permission that applies to a resource.
//
// For example, permission to read the content of a Google Sheet would be a permission, probably
// just called "read".
type PermissionSchema = {
  // Stable identifier for this permission. Alphanumeric camelCase only.
  name: string;

  // Human-readable label and summary of what this permission represents.
  title: Prose;
  description: Prose;

  // "property" permissions allow a Minion to read a property of the resource, but do not permit
  // it to modify the resource in any observable way.
  //
  // "action" permissions allow the Minion to perform an action on the resource, changing it in
  // some way. Any action may be subject to human approval before it takes effect.
  type: "action" | "property";
}

// Describes metadata about a specific instance of a resource. Returned by Gatekeeper.describe().
type ResourceDescription = {
  // The resource's canonical URL. This can differ from the one passed to `newGatekeeper()`, if the
  // resource has more than one possible URL. Visiting this URL in a browser should actually open
  // the resource's natural UI.
  url: string;

  // Does this resource actually exist?
  //
  // If this is not present, then the adapter does not know yet whether the resource exists,
  // presumably because of missing authorization; `authRedirect` should be used to request
  // authorization.
  //
  // If this is present, but false, then this Gatekeeper points to a resource that does not exist.
  // This can happen in particular if the user was not yet authorized at the time the facet was
  // constructed, and after authorization, it was discovered that the resource doesn't exist.
  exists?: boolean;

  // Metadata for display, if the adapter has authorization to receive it. May be missing if the
  // adapter itself needs additional authorization, in which `authRedirect` can be used to request
  // authorization. This is meant to be displayed to the user in the UI in order to confirm that
  // this is the resource they intend to connect to.
  title?: Prose;
  snippet?: Prose;

  // TODO: Other display metadata? Thumbnail, icon, etc?

  // The `ResourceSchema` which this resource implements. Note that the schema itself must not
  // contain details about the specific resource, only the class of resource. This schema may be
  // shared with the AI agent before any actual access to the resource has been granted; the agent
  // may use this to decide what access it needs to request.
  //
  // TODO: Should this be the URL of a schema instead?
  schema: ResourceSchema;

  // Permissions which the user is known to have on this resource, if they were to access the
  // resource directly.
  //
  // This may include permissions that are not actually available through the adapter (see
  // `adapterPermissions`).
  userPermissions: PermissionSet;

  // Permissions which this adapter is able to implement on this resource. This is always strictly
  // a subset of `userPermissions`.
  //
  // This list may differ from `userPermissions` in cases where the adapter itself has not been
  // authorized by the user to provide this access. This can happen, for example, when the adapter
  // is an OAuth client to an external service, and its OAuth grant does not include the necessary
  // "scopes". If `authRedirect` is present, the Overseer can redirect the user there to request
  // the additional permissions.
  adapterPermissions: PermissionSet;

  // URL to which the user can be redirected in order to request additional permissions, if the ones
  // listed in `adapterPermissions` are insufficient, or if `title`, `snippet`, etc. are missing.
  //
  // If this is not present, it is not possible to request any additional permissions.
  authRedirect?: AuthRedirect;
}

// Represents a list of permissions.
//
// (This is an object rather than just `string[]` to support future extension.)
type PermissionSet = {
  // List of permission names.
  permissions: string[];
}

// Sometimes the Adapter itself needs to request direct authorization from the user in order to
// access resources. For example, the Adapter might be an OAuth client to a third-party service,
// and it may not have requested access to everything initially. In that case, if the user tries
// to request any permissions that the Adapter does not yet have permission to implement, the user
// may need to visit an authorization UI to fix this. `AuthRedirect` describes the action the user
// should take.
//
// (This is an object rather than just `string` to support future extension.)
type AuthRedirect = {
  // URL to which the user can be redirected in order to request additional permissions on a
  // particular resource.
  //
  // When redirecting, the system may add a query parameter `&permissions=bar,baz` to specify what
  // additional permissions the user needs.
  url: string;
}

// =======================================================================================

// The root interface of an Adapter, as provided to the Minion Workshop.
//
// An installation of the Minion Workshop is provided with a set of Adapters to allow it to
// interface with other services.
interface Adapter {
  // Get this adapter's full schema.
  describe(): Promise<AdapterSchema>;

  // Creates an instance of the adapter for a specific user.
  //
  // Or, rather, returns a DurableObjectClass which can be instantiated as a facet on the Durable
  // Object representing the user's account in the Minion Workshop.
  //
  // `id` is the user ID as understood by the Workshop itself. However, it is expected that the
  // Adapter will need to separately authenticate the user with respect to the external service
  // which it represents, e.g. through a OAuth flow. It is not strictly necessary that the user
  // authenticate with a matching email address, but some adapters may use the address as a hint.
  newUser(id: UserId): Promise<DurableObjectClass<UserAdapter>>;
}

// RPC interface to an Adapter. This is a privileged interface exposed to the Minion Workshop UI
// itself, not to Minions nor AI agents.
//
// The Adapter is already specialized for a particular human user of the Minion Workshop. The
// Adapter capability itself represents permission to access all of the user's data that is
// available through it, so needs to be guarded carefully. Hence, only the Workshop itself should
// ever have direct access to an Adapter object.
interface UserAdapter {
  // Get a Durable Object class that can implement a gatekeeper for the given resource. This class
  // can be used to instantiate a Facet which implements the Gatekeeper interface.
  //
  // Note that the Overseer of a Minion will call this immediately when the user pastes in a URL,
  // *before* the user has actually chosen to grant the Minion any permissions on the resource.
  // Permissions are requested by instantiating the Gatekeeper and calling setPermissions() on it,
  // usually after first calling describe() to find out what the resource can do.
  //
  // The returned class is imbued (via `ctx.props`) with the user's credentials and the resource
  // ID.
  newGatekeeper(url: string): Promise<DurableObjectClass<Gatekeeper<any>>>;
}

// Interface exposed by a Gatekeeper instance implementing a specific resource binding on a
// specific Minion.
//
// The Gatekeeper executes as a Durable Object Facet, where it is a child of the Overseer. This
// interface is exposed to the Overseer, not directly to the Minion.
interface Gatekeeper<Session, Action = any, RevertInfo = any> {
  // Get more info on the specific resource without actually granting access. This information is
  // to be presented to the user in the UI, before the user actually confirms they want to grant
  // access.
  describe(): Promise<ResourceDescription>;

  // Get the capability representing this resource's RPC interface which will be provided to the
  // Minion.
  //
  // The Gatekeeper is responsible for enforcing permissions. The session must throw if any calls
  // are made that are not permitted by `permissions`. (The Overseer will ensure that these are
  // a subset of `adapterPermissions` as returned by `describe()`, and also a subset of the
  // permissions possessed by the Minion's users per `checkUserPermissions()`.)
  //
  // Any side-effecting actions performed during this session must be submitted to the approval
  // queue. Actions must not actually be performed until they are approved. Read-only operations
  // can be executed immediately, without approval (provided they are covered by `permissions`).
  //
  // It is suggested that the gatekeeper "simulate" actions that have not been approved yet, that
  // is, the `Session` interface should reflect the state of the resource as if all actions had
  // been applied. This allows the Minion to keep working, potentially queuing up additional
  // dependent actions. That said, there is no strict requirement that a gatekeeper does such
  // simulation -- it is really up to the gatekeeper author to decide what is appropriate for the
  // particular API.
  startSession(permissions: PermissionSet, approvalQueue: ApprovalQueue<Action>): Promise<Session>;

  // Checks what permissions the given user has on the resource pointed to by this capability.
  //
  // This is used to prevent privilege escalation through a minion: If a user does not independently
  // have the ability to do everything the Minion can do, then either the user cannot be allowed to
  // interact with the Minion itself, or the Minion's permissions must be reduced to match the
  // user's.
  checkUserPermissions(user: UserId): Promise<PermissionSet>;

  // Get the list of all users who are able to modify the data readable through this capability,
  // that is, people who can influence what the Minion sees.
  //
  // This is used to track who might be able to influence the Minion's behavior indirectly, e.g.
  // through propmt injection or otherwise tricking it into taking inappropriate actions. If the
  // Minion is able to perform actions that one or more of its influencers could not perform
  // directly, additional scrutiny may be needed. E.g. policies may require human review in this
  // case, and/or explicitly prohibit actions that are deemed dangerous.
  getInfluencers(): Promise<UserId[]>;

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
  // If the returned `restart` flag is true, rejecting this action requires restarting the Minion.
  // This is sometimes needed by gatekeepers that simulate actions as if they had been approved --
  // the session may be in a state that is difficult to roll back without confusing the Minion.
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
}

// Used by a gatekeeper to request an action that has side effects (is not read-only). Any such
// action may be subject to human-in-the-loop approval and audit logging. Whether or not review is
// actually required, the gatekeeper must still submit all actions and wait for apply() to be
// called before applying them.
interface ApprovalQueue<Action> {
  // Submit an action for approval.
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
  submit(action: Action, description: ActionDescription): Promise<void>;
}

// Describes an action submitted to the action approval queue. This contains all the information
// needed to:
// - Decide whether the action needs to be approved and who can approve it.
// - Display the action to the approver for review.
// - Store the action in an audit log.
type ActionDescription = {
  // Brief one-line summary of the action, like an email subject line, to display in a list.
  title: Text;

  // A complete description of the action to be taken, in Markdown-formatted natural language.
  // This will be displayed to the approver. It must include all details that might be relevant to
  // consider before approving.
  description: string;

  // ----------------------------------------------------------------------------
  // Policy hints
  //
  // These fields are meant to be consumed by policies which govern when auto-approval is allowed,
  // who needs to approve, etc.

  // Who is known to be able to observe this action?
  //
  // This is used to guard against data leaks. If the Minion has access to information that one or
  // more observers don't have access to, then this action may be flagged as a data leak risk.
  //
  // TODO: How do we represent "the entire company" or "the entire internet" here?
  observers: UserId[];

  // Specifies the subset of properties of the resource which this action affects. These should
  // match the names of "property"-type permissions in the resource's schema. Only users who have
  // permission to read one or more of these properties will be able to observe the action's
  // effects.
  //
  // This can be used by policies that need to determine who exactly can observe a Minion's
  // actions, to control risk of data leaks. Policies might also use the property list directly
  // to evalutae risk. For example, you might write a policy that says that changing labels on
  // an email is not risky and can be auto-approved, whereas authoring an email can never be
  // auto-approved.
  affectedProperties: string[];

  // If true, this action is inserting "arbitrary content" into the resource, e.g. blocks of text,
  // which could contain arbitrary information leaks.
  //
  // If false, then the observable effects of this action do not contain arbitrary text. For
  // example, the action might be toggling a flag on or off. It's theoretically possible to leak
  // information through this as a covert channel, e.g. by encoding information in morse code.
  // However, policies that aim to address only accidental leaks (rather than malicious ones) may
  // reasonably ignore covert channels as a threat.
  hasArbitraryContent: boolean;

  // If true, the action only creates new data; it does not modify existing data.
  //
  // This is relevant to policy decisions since creating new data can often be presumed to be less
  // harmful than modifying existing data. The worst the action can do is spam people.
  //
  // Examples:
  // - Posting a new ticket (vs. modifying an existing one).
  // - Adding comments to a doc (vs. editing a doc).
  // - Sending a message to a chat room.
  isAppendOnly: boolean;

  // Can this action normally be reversed?
  //
  // It's strongly recommended that all actions be reversible. Non-reversible actions will be
  // called out strongly in the approval UI, may not allow batch approval.
  isReversible: boolean;

  // Does the Gatekeeper implement `revertAction()` for this action?
  //
  // This doesn't necessarily mean the revert() method is expected to work fully automatically
  // (see `isRevertUsuallyAutomatic`), but the existence of a revert method may significantly
  // affect the UI presentation.
  implementsRevert: boolean;

  // Is the revert() method usually able to fully revert without human help?
  //
  // This is just a hint. For example, automatic revert is typically not possible after further
  // changes have been stacked on top of the change, even if `isRevertUsuallyAutomatic` is true.
  isRevertUsuallyAutomatic: boolean;
}
