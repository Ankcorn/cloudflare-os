@0xa3f931ec3db1bf31;

interface Gatekeeper(T) {
  # Interface exposed by a Gatekeeper instance implementing a specific resource binding on a
  # specific Minion.

  startSession (level :Level, approvalQueue :ApprovalQueue) -> (cap :T);
  # Get the capability representing this resource's RPC interface which will be provided to the
  # Minion. Any actions perform through this capability should use `approvalQueue` for approval.

  checkSafeUser (user :UserId) -> (level :SafeUserLevel);
  # Checks whether the given user is able to perform actions equivalent to those provided by this
  # capability.
  #
  # This is used to prevent privilege escalation through a minion: If a user does not independently
  # have the ability to do everything the Minion can do, then the user cannot be allowed to
  # interact with the Minion itself.

  enum SafeUserLevel {
    none @0;
    # The user does not have permissions equivalent to this capability at all.

    read @1;
    # The user has permissions equivalent to this capability's read-only mode, but not the full
    # access mode.

    full @2;
    # The user has permissions equivalent to this capability's full-access mode.
  }

  getInfluencers () -> (writers :List(UserId));
  # Get the list of all users who are able to modify the data readable through this capability,
  # that is, people who can influence what the Minion sees.
  #
  # For a Minion to perform a dangerous unsupervised write action, all influencers must have
  # permission to perform said write action. This prevents an attacker from using prompt injection
  # to trick a Minion into performing actions on another capability which the attacker is unable
  # to perform directly.
  #
  # This check only applies to "dangerous" write actions, that is, actions which could destroy data
  # or create big problems, as opposed to actions which merely create new information. Typically,
  # dangerous writes are not permitted unsupervised anyway, so the influencer check is rarely
  # needed.
}

interface ApprovalQueue {
  # Used by a gatekeeper to request an action that has side effects (is not read-only). Any such
  # action may be subject to human-in-the-loop approval and audit logging. Whether or not review is
  # actually required, the gatekeeper must still submit all actions and wait for apply() to be
  # called before applying them.

  submit(description :ActionDescription, callback :Callback);
  # Submit an action for approval.

  interface Callback {
    # Callback which signals when a supervised action has been approved and should be performed.

    apply();
    # Action was approved. This callback should apply the action (or schedule it to be applied).
    #
    # If this throws an exception, the user will be informed that the action failed and given the
    # opportunity to retry or discard.
    #
    # If apply() is never called and the callback is deleted, then the action can be assumed to
    # have been denied. (Note that callbacks are persistent -- denial should only be assumed when
    # all persistent references are gone.)
    #
    # Depending on policy conditions, an action may be approved automatically. However, the
    # gatekeeper is nevertheless expected to submit all actions for approval; there is no mode in
    # which it's OK to skip the check.

    simulate();
    # Called in place of `apply()` to indicate that the action should not applied because we are
    # running in simulated test mode. The gatekeeper should behave as if the action did apply, but
    # should not actually modify any external resource.
    #
    # Gatekeepers are not required to implement this. If unimplemented, the callback will simply be
    # dropped without any other calls.

    revert() -> (message :Text, canRetry :Bool = false)
    # Attempt to revert an action that was already applied.
    #
    # Gatekeepers are not required to implement this. If unimplemented, the user will be instructed
    # that they need to perform the revert manually based on the action description. High-quality
    # gatekeepers should almost always implement this, though.
    #
    # If the returned `message` is non-null, it is Markdown to be displayed to the user. This may
    # be used, for example:
    # - To give the user additional instructions on how to complete the revert, if not all of it
    #   could be done automatically.
    # - To explain to the user why a revert is not possible, e.g. if other stacked modifications
    #   have been made on top which must be reverted first. (`canRetry` may be true in this case.)
    #
    # `canRetry` should be true if the revert failed (for a reason described in `message`), but
    # it could make sense to retry later. In this case the UI will continue to give the user the
    # option to revert.
  }
}

struct ActionDescription {
  # Describes an action submitted to the action approval queue. This contains all the information
  # needed to:
  # - Decide whether the action needs to be approved and who can approve it.
  # - Display the action to the approver for review.
  # - Store the action in an audit log.

  title @0 :Text;
  # Brief one-line summary of the action, like an email subject line, to display in a list.

  description @1 :Text;
  # A complete description of the action to be taken, in Markdown-formatted natural language.
  # This will be displayed to the approver. It must include all details that might be relevant to
  # consider before approving.

  # ----------------------------------------------------------------------------
  # Policy hints
  #
  # These fields are meant to be consumed by policies which govern when auto-approval is allowed,
  # who needs to approve, etc.

  observers @2 :List(UserId);
  # Who is known to be able to observe this action?
  #
  # This is used to guard against data leaks. If the Minion has access to information that one or
  # more observers don't have access to, then this action may be flagged as a data leak risk.

  subscopes @3 :List(Text);
  # Specifies the "subscope" of the action, which specifies a subset of the target resource which
  # may be affected by the action. The items in the list are identifiers meant to be used by policy
  # code which decides whether human approval is needed; these identifiers are generally not shown
  # to humans.
  #
  # For example:
  # - An action which affects gmail, but only modifies labels, may have the scope "label".
  # - An action which updates a ticket, but only to change the status, may have the scope "status".

  isAppendOnly @4 :Bool;
  # If true, the action only creates new data; it does not modify existing data.
  #
  # This is relevant to policy decisions since creating new data can often be presumed to be less
  # harmful than modifying existing data. The worst the action can do is spam people.
  #
  # Examples:
  # - Posting a new ticket (vs. modifying an existing one).
  # - Adding comments to a doc (vs. editing a doc).
  # - Sending a message to a chat room.

  isReversible @5 :Bool;
  # Can this action normally be reversed?
  #
  # It's strongly recommended that all actions be reversible. Non-reversible actions will be
  # called out strongly in the approval UI, may not allow batch approval.

  hasRevertMethod @6 :Bool;
  # Does the action callback implement a revert() method?
  #
  # This doesn't necessarily mean the revert() method is expected to work fully automatically
  # (see `isRevertUsuallyAutomatic`), but the existence of a revert method may significantly
  # affect the UI presentation.

  isRevertUsuallyAutomatic @7 :Bool;
  # Is the revert() method usually able to fully revert without human help?
  #
  # This is just a hint. For example, automatic revert is typically not possible after further
  # changes have been stacked on top of the change, even if `isRevertUsuallyAutomatic` is true.
}
