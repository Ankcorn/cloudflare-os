# Sharing

Gadgets supports sharing gadgets with other users. There are two sharing mechanisms:

1. **Collaborators** -- granting other users direct access to a gadget, so they can work on it alongside the owner. (Covered in this file.)
2. **Blueprints** -- sharing a snapshot of a gadget's source code, so others can create independent gadgets from it. (Documented elsewhere.)

This document describes the collaborator system.

## Collaborators

A collaborator is a user who has direct access to a gadget they do not own. Currently all collaborators receive full access: they can edit code, use the AI chat, manage bindings, and interact with the gadget UI -- the same as the owner, with a few exceptions:

- **Cannot delete the gadget.** Only the owner can do this.
- **Use their own AI models.** When a collaborator engages AI chat, the model is resolved from their own account (BYOK billing goes to whoever prompted the AI, not the gadget owner).
- **Use their own connected accounts for bindings.** When a collaborator adds a gatekeeper binding, it connects through that collaborator's third-party accounts, not the owner's. This prevents collaborators from gaining access to the owner's accounts beyond what the gadget's existing bindings already expose.
- **Limited revocation authority.** A collaborator can only remove users that they themselves added (see "Permission graph" below).

### Adding collaborators

There are two ways to grant someone collaborator access:

**Direct add.** The owner or an existing collaborator enters a username (email address) in the Share modal. The system looks up the corresponding user account; if it exists, a collaborator record is created. The target user does not receive an in-product notification -- the sharer is expected to send them a link or tell them out of band.

**Share link.** Any collaborator (or the owner) can create a share link, which encodes a secret key in the URL as a `?share=<key>` query parameter. Anyone who opens this link is automatically added as a collaborator. The share link is one-shot in the sense that the raw key is shown to the creator only once (it is never stored server-side). However, the same link can be reused by multiple people, or the same person multiple times, until it is revoked.

Share key security: the server generates a random 128-bit key and stores only its HMAC-SHA-256 hash (using a fixed domain-separation constant, `SHARE_KEY_HMAC_KEY`). When a user redeems a share link, the client sends the raw key to the server, which computes the hash and looks it up. This means the server cannot reconstruct share links from its stored data, and a database leak does not expose valid share keys.

Share key redemption and gadget opening happen atomically in a single RPC call (`openGadget(id, shareKey)`), which allows subsequent calls to be pipelined on the returned `Overseer` stub without waiting for a separate redemption step.

### Home page behavior

A shared gadget does not appear on a collaborator's home page until they first open it. At that point, a record is created in the collaborator's user account (via `UserDurableObject.recordSharedGadgetOpen()`), storing a cached copy of the gadget's title and the owner's profile. The `lastActive` timestamp is updated each time they open the gadget.

Shared gadgets appear in the same list as owned gadgets on the home page, distinguished by showing the owner's name in the "Owner" column. Collaborators can dismiss a shared gadget from their home page (removing the record from their user account), but this does not revoke their access -- if they open the gadget again via its URL, it reappears.

When a collaborator's access is revoked, the gadget intentionally remains on their home page. The next time they try to open it, the authorization check fails with "Unauthorized", clearly communicating that access was revoked. They can then dismiss it manually. This avoids confusing disappearances.

## Permission graph

The sharing system tracks *how* each collaborator gained access, forming a directed graph of permission edges. This graph is the foundation for transitive revocation.

### Edges

Each collaborator has one or more **permission edges** explaining how they got access. There are two edge types:

- **User edge**: records that a specific sharer (identified by `profile.id`) directly added this collaborator. Includes a timestamp and optional note.
- **Share key edge**: records that this collaborator redeemed a specific share key (identified by `keyId`, the HMAC hash). Includes a timestamp.

A collaborator can accumulate multiple edges -- for example, if they were added directly by Alice and also redeemed a share link created by Bob. The collaborator retains access as long as they have at least one valid edge.

### Share keys in the graph

Share keys are first-class nodes in the permission graph, connected to their creator. A share key is "supported" by its creator: if the creator loses access, the share key is transitively revoked, which in turn removes anyone who gained access solely through that key.

Concretely, revoking a share key or removing its creator triggers the same transitive revocation algorithm described below, treating all edges referencing that key as invalid.

### The owner as root

The owner is the implicit root of the permission graph. The owner is never stored in the collaborators table and cannot be removed. All permission chains must ultimately trace back to the owner (or to someone the owner added, or someone *they* added, etc.) for access to be valid.

## Transitive revocation

When a collaborator is removed or a share key is revoked, the system must determine whether any other collaborators lose access as a consequence. For example: if Alice added Bob, and Bob added Carol, then removing Bob should also remove Carol -- unless the person performing the removal explicitly chooses to keep Carol.

### Algorithm

The transitive revocation algorithm is a **fixed-point reachability computation** implemented in `OverseerClientInterface.#findDependentUsers()`. It determines which collaborators would retain access (are "supported") and which would not, given a hypothetical removal.

Inputs:
- `removedUser` -- a profile ID to treat as removed (excluded from the graph), or null.
- `revokedKeyId` -- a share key ID to treat as revoked, or null.
- `keepUsers` -- a set of profile IDs that are pre-marked as supported regardless of their edges (these are users the caller has chosen to retain).

The algorithm:

1. **Build the candidate set.** Load all collaborators except the removed user.
2. **Collect share key metadata.** Build a map from key ID to creator profile ID, for evaluating share key edges.
3. **Initialize the supported set** with `keepUsers`.
4. **Iterate to fixed point.** Repeatedly scan all unsupported collaborators. A collaborator becomes supported if they have at least one valid edge:
   - A **user edge** is valid if the sharer is the owner or is already in the supported set. Edges pointing to the removed user are skipped.
   - A **share key edge** is valid if the key is not the one being revoked, the key still exists, and the key's creator is the owner or is in the supported set.
   - Once a collaborator is marked supported, that may unlock other collaborators on the next pass (since someone they added now has a valid supporter).
5. **Converge.** The loop terminates when a full pass adds no new members to the supported set.
6. **Return the unsupported set.** Collaborators not in the supported set after convergence are the ones who would lose access.

This algorithm correctly handles arbitrary graph shapes: diamonds (a user reachable via two independent paths), cycles (mutual adds), and deep chains.

### Preview and confirm

Revocation is a two-phase process in the UI:

1. **Preview.** Before actually removing anyone, the frontend calls `previewRemoveCollaborator()` or `previewRevokeShareKey()`, which runs the reachability algorithm and returns the list of users who would lose access. If the list is non-empty, the UI shows a dialog with checkboxes for each affected user.
2. **Confirm.** The user decides which dependents to keep (checked) and which to also remove (unchecked). The frontend then calls `removeCollaborator(profileId, keepUsers)` or `revokeShareKey(keyId, keepUsers)`.

### Applying the removal

Once the caller confirms, `#applyRemoval()` carries out the following steps:

1. **Identify all removed users** (the primary target plus unsupported dependents).
2. **Identify revoked share keys** -- any share key created by a removed user is also revoked, since its creator is no longer a valid supporter.
3. **Delete collaborator records** for all removed users.
4. **Fix up kept users.** For each user in `keepUsers`, remove any edges that pointed through removed users or revoked keys, and add a fresh user edge from the caller.
5. **Clean stale edges** from all remaining collaborators who are not being removed or kept (they may have had secondary edges through a removed user that need pruning, even though they retain access via other edges).
6. **Delete revoked share key records.**

### Non-owner removal

When a non-owner collaborator removes someone they added, the behavior is slightly different. The caller can only remove their own edges from the target. If the target has edges from other sources (e.g., also added by someone else), those edges remain and the target keeps access. Only if removing the caller's edges leaves the target with no remaining edges does full removal (with transitive cleanup) proceed.

## Resource isolation between collaborators

Collaborators share the gadget's code, storage, and AI chat history, but certain resources are scoped to individual users:

- **AI model bindings** resolve from the account of whoever created the binding. This is baked in at binding creation time for AI model gatekeepers (the full `AiModelConfig` including API key is stored in the binding props). For agent spawners, the creating user's DO ID is stored in `AgentSpawnerBindingProps.creatorUserId` so the model can be resolved at trigger time from the correct account.
- **Gatekeeper bindings** connect through the third-party accounts of whoever created them (`OverseerClientInterface.newGatekeeper()` calls `clientUser.getGatekeeperClassFor()` rather than `owner.getGatekeeperClassFor()`).

This means no collaborator implicitly gains access to another user's connected third-party accounts.

## Authorization model

Authorization is currently enforced eagerly: the `open()` method on the Overseer checks whether the caller is the owner or has a record in the collaborators table. The transitive revocation logic in `removeCollaborator()` and `revokeShareKey()` is responsible for eagerly removing anyone who becomes unreachable in the permission graph.

This means correctness depends on the graph cleanup logic being bug-free. A potential future hardening step would be to also compute reachability from the owner at `open()` time as defense-in-depth, ensuring that even if the cleanup has a bug, unreachable users cannot access the gadget.

## Future work

- **Permission levels.** Currently all collaborators get full access. Planned levels include: chat-only (can create chats but not merge to mainline), read-only, UI-only, and UI-read-only.
- **Binding-aware access control.** Prohibit adding collaborators when the gadget holds binding permissions that the collaborator lacks, and conversely prohibit adding sensitive bindings when existing collaborators lack the required permissions.
- **Share key expiration and usage limits.** Including single-use keys.
- **Reachability check in `open()`.** Defense-in-depth against bugs in transitive revocation (also needed if group-based access is added, since group membership changes are external events).
- **Notifications.** Currently there are no in-product notifications for access grants or revocations.
