interface Gatekeeper<Session, Action = any, RevertInfo = any> {
  // Interface exposed by a Gatekeeper instance implementing a specific resource binding on a
  // specific Minion.

  startSession(approvalQueue: ApprovalQueue<Action>, props: SessionProperties): Promise<Session>;
  // Get the capability representing this resource's RPC interface which will be provided to the
  // Minion.
  //
  // Any side-effecting actions performed during this session must be submitted to the approval
  // queue. Actions must not actually be performed until they are approved. Read-only actions can
  // be executed immediately, without approval.
  //
  // It is suggested that the gatekeeper "simulate" actions that have not been approved yet, that
  // is, the `Session` interface should reflect the state of the resource as if all actions had
  // been applied. This allows the Minion to keep working, potentially queuing up additional
  // dependent actions. That said, there is no strict requirement that a gatekeeper does such
  // simulation -- it is really up to the gatekeeper author to decide what is appropriate for the
  // particular API.

  checkUserPermissions(user: UserId): {level: SafeUserLevel};
  // Checks whether the given user is able to perform actions equivalent to those provided by this
  // capability.
  //
  // This is used to prevent privilege escalation through a minion: If a user does not independently
  // have the ability to do everything the Minion can do, then the user cannot be allowed to
  // interact with the Minion itself.

  getInfluencers(): Promise<UserId[]>;
  // Get the list of all users who are able to modify the data readable through this capability,
  // that is, people who can influence what the Minion sees.
  //
  // This is used to track who might be able to influence the Minion's behavior indirectly, e.g.
  // through propmt injection or otherwise tricking it into taking inappropriate actions. If the
  // Minion is able to perform actions that one or more of its influencers could not perform
  // directly, additional scrutiny may be needed. E.g. policies may require human review in this
  // case, and/or explicitly prohibit actions that are deemed dangerous.

  // ---------------------------------------------------------------------------
  // Callbacks invoked by the overseer to apply (or reject) actions that were previously queued
  // for approval via the ApprovalCallback.
  //
  // The type `Action` is an arbitrary type defined by the gatekeeper to represent the actions
  // it has queued for approval. It is passed to the Overseer via the ApprovalCallback, and will
  // be passed back verbatim to these methods. The gatekeeper might choose to define `Action` to
  // fully describe the action, or it might simply be an ID pointing into the gatekeeper's own
  // storage; this is entirely up to the gatekeeper to decide.

  applyAction(action: Action): Promise<void | {revertInfo?: RevertInfo}>;
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

  rejectAction(action: Action): Promise<void | {restart?: boolean}>;
  // Indicates that an action was rejected by the user. The gatekeeper should clean up any
  // associated storage.
  //
  // If the returned `restart` flag is true, rejecting this action requires restarting the Minion.
  // This is sometimes needed by gatekeepers that simulate actions as if they had been approved --
  // the session may be in a state that is difficult to roll back without confusing the Minion.
  // The Overseer will take care of the restart, possibly after rejecting other actions.

  revertAction(action: Action, revertInfo: RevertInfo):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}>;
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
}

type SessionProperties = {
  // Information passed to a gatekeeper when a session starts.

  readOnly :boolean;
  // If true, hints that `approvalQueue` will reject all actions, because the Minion is executing
  // in read-only mode. The gatekeeper does not strictly need to pay attention to this flag since
  // the approval queue will enforce the policy, but it may be convenient to know in advance
  // when writes will be rejected as an optimization.
}

enum SafeUserLevel {
  // Represents the level of access that a user has on a resource, given all applicable
  // permissions. When a user accesses a Minion, we must verify that the user has direct permission
  // to do everything the Minion can do.

  none,
  // The user does not have permissions equivalent to this capability at all.

  readOnly,
  // The user has permissions equivalent to this capability's read-only mode, but not the full
  // access mode. The Minion can run in read-only mode if it supports this.

  full,
  // The user has permissions equivalent to this capability's full-access mode.
}

type UserId = {
  // Identifies a user.
  //
  // All users are identified by email address. This is the most natural identifier as essentially
  // all services understand it, and we need to understand a user's permissions across multiple
  // services.
  //
  // That said, we wrap it in an object just in case we want to extend this someday...

  email: string
}

interface ApprovalQueue<Action> {
  // Used by a gatekeeper to request an action that has side effects (is not read-only). Any such
  // action may be subject to human-in-the-loop approval and audit logging. Whether or not review is
  // actually required, the gatekeeper must still submit all actions and wait for apply() to be
  // called before applying them.

  submit(action: Action, description: ActionDescription): Promise<void>;
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
}

type ActionDescription = {
  // Describes an action submitted to the action approval queue. This contains all the information
  // needed to:
  // - Decide whether the action needs to be approved and who can approve it.
  // - Display the action to the approver for review.
  // - Store the action in an audit log.

  title: Text;
  // Brief one-line summary of the action, like an email subject line, to display in a list.

  description: string;
  // A complete description of the action to be taken, in Markdown-formatted natural language.
  // This will be displayed to the approver. It must include all details that might be relevant to
  // consider before approving.

  // ----------------------------------------------------------------------------
  // Policy hints
  //
  // These fields are meant to be consumed by policies which govern when auto-approval is allowed,
  // who needs to approve, etc.

  observers: UserId[];
  // Who is known to be able to observe this action?
  //
  // This is used to guard against data leaks. If the Minion has access to information that one or
  // more observers don't have access to, then this action may be flagged as a data leak risk.

  subscopes: string[];
  // Specifies the "subscope" of the action, which specifies a subset of the target resource which
  // may be affected by the action. The items in the list are identifiers meant to be used by policy
  // code which decides whether human approval is needed; these identifiers are generally not shown
  // to humans.
  //
  // For example:
  // - An action which affects gmail, but only modifies labels, may have the scope "label".
  // - An action which updates a ticket, but only to change the status, may have the scope "status".

  isAppendOnly: boolean;
  // If true, the action only creates new data; it does not modify existing data.
  //
  // This is relevant to policy decisions since creating new data can often be presumed to be less
  // harmful than modifying existing data. The worst the action can do is spam people.
  //
  // Examples:
  // - Posting a new ticket (vs. modifying an existing one).
  // - Adding comments to a doc (vs. editing a doc).
  // - Sending a message to a chat room.

  isReversible: boolean;
  // Can this action normally be reversed?
  //
  // It's strongly recommended that all actions be reversible. Non-reversible actions will be
  // called out strongly in the approval UI, may not allow batch approval.

  hasRevertMethod: boolean;
  // Does the action callback implement a revert() method?
  //
  // This doesn't necessarily mean the revert() method is expected to work fully automatically
  // (see `isRevertUsuallyAutomatic`), but the existence of a revert method may significantly
  // affect the UI presentation.

  isRevertUsuallyAutomatic: boolean;
  // Is the revert() method usually able to fully revert without human help?
  //
  // This is just a hint. For example, automatic revert is typically not possible after further
  // changes have been stacked on top of the change, even if `isRevertUsuallyAutomatic` is true.
}
