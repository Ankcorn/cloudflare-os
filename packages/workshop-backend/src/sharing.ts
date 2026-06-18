// Collaborator authorization, sharing, and permission-graph logic for a Gadget's Overseer.
//
// This module owns all manipulation of the `collaborators` and `shareKeys` storage collections
// and the permission graph that links them. It deliberately performs no RPC: anything that
// requires talking to a User DO (resolving a profile from a username, fetching the owner's
// profile, notifying a user that a gadget was opened, etc.) stays in the Overseer, which passes
// resolved values (or, where laziness matters, a callback) into this module.
//
// LAZY REVOCATION MODEL: Access is determined by reachability from the owner in the permission
// graph, recomputed live at every open() (see `getEffectiveRole`). Revocation is therefore lazy:
// removing a collaborator only severs the edges granting *them* access, and revoking a share key
// only sets its `revoked` flag. Nothing cascades, no records are deleted, and downstream edges are
// never touched -- users who lose their only path to the owner simply become unreachable and are
// denied at open() time. Because the graph is never destructively pruned, revocation is reversible:
// re-adding a removed collaborator restores them and, transitively, everyone they had shared with.
// (Records and revoked keys accumulate in storage; a future GC could reclaim long-dead entries.)
//
// NOTE: The `prohibitAllSharing` policy flag intentionally does NOT live here. It is a broader
// "is this gadget allowed to communicate with anyone other than the owner?" policy (it also
// gates gatekeeper writes and web fetches) and is expected to grow into a separate policy engine.
// The Overseer enforces that flag; this module only exposes `hasAnyShares()` so the policy can
// ask about the current sharing state.

import { AiChatAuthorInfo, CollaboratorInfo, PermissionEdge, CollaboratorRole, AffectedCollaborator }
    from "@gadgets/workshop-shared/api";
import { Collection } from "@gadgets/typed-storage";

// Roles are totally ordered: build > use. Higher rank means strictly more access.
function roleRank(role: CollaboratorRole): number {
  return role === "build" ? 2 : 1;
}

// Edges and share keys created before roles were introduced lack a `role` field; treat them as
// "build" for backwards compatibility.
function edgeGrantedRole(edge: PermissionEdge): CollaboratorRole {
  return edge.role ?? "build";
}

function maxRole(a: CollaboratorRole, b: CollaboratorRole): CollaboratorRole {
  return roleRank(a) >= roleRank(b) ? a : b;
}

function minRole(a: CollaboratorRole, b: CollaboratorRole): CollaboratorRole {
  return roleRank(a) <= roleRank(b) ? a : b;
}

// Fixed 256-bit key used to domain-separate share key hashes from other hashes in the system.
// Not secret -- it only provides personalization.
const SHARE_KEY_HMAC_KEY = new Uint8Array([
  0x09, 0x2a, 0x64, 0x37, 0xae, 0x8a, 0xce, 0x43,
  0x03, 0x81, 0x17, 0xed, 0x5b, 0x0c, 0x4a, 0xca,
  0x82, 0x23, 0x41, 0x11, 0x0b, 0x28, 0x48, 0x8f,
  0x57, 0x53, 0x25, 0x2a, 0xda, 0xa0, 0xbf, 0xd7,
]);

// Compute the storage ID (HMAC-SHA-256 hex) for a raw share key. The raw key is never stored
// server-side; only this hash is.
async function hashShareKey(rawKey: string): Promise<string> {
  let hmacKey = await crypto.subtle.importKey(
      "raw", SHARE_KEY_HMAC_KEY, { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]);
  let sig = new Uint8Array(await crypto.subtle.sign(
      "HMAC", hmacKey, Uint8Array.fromHex(rawKey)));
  return sig.toHex();
}

// Each gadget stores its collaborator list.
export type CollaboratorRecord = {
  // Denormalized profile snapshot for display without hitting the user's DO.
  profile: AiChatAuthorInfo;

  // How this collaborator got access. Multiple edges are possible.
  addedBy: PermissionEdge[];
};

// Share keys table. The actual key is never stored server-side; only its HMAC hash.
export type ShareKeyRecord = {
  id: string;        // HMAC-SHA-256 hex of the raw key
  note?: string;
  created: Date;
  createdBy: string; // profile.id of the creator

  // The role granted to anyone who redeems this key. Absent on keys created before roles were
  // introduced; treated as "build".
  role?: CollaboratorRole;

  // Soft-revocation flag. Revoking a key sets this rather than deleting the record, so that the
  // permission graph keeps its `shareKey` edges intact (no dangling references) and access could
  // be restored in the future. A revoked key contributes nothing to the permission graph and
  // cannot be redeemed.
  revoked?: boolean;
};

// The slice of Overseer storage this module operates on. Satisfied by the real OverseerStorage
// and easily constructed over a Map-backed mock DurableObjectStorage in tests.
export interface SharingStorage {
  collaborators: Collection<CollaboratorRecord>;
  shareKeys: Collection<ShareKeyRecord>;
}

// Per-session caller identity. Mirrors the fields the OverseerClientInterface holds for the
// connected client.
export interface SharingCaller {
  // The caller's profile.id (username/email).
  profileId: string;
  // True if the caller is the gadget owner. The owner can manage anyone's collaborator edges
  // and share keys; non-owners are restricted to edges/keys they created themselves.
  isOwner: boolean;
}

export class SharingManager {
  // `ownerProfileId` is stable for the lifetime of a gadget, so it's supplied once at
  // construction rather than per call.
  constructor(private storage: SharingStorage, private ownerProfileId: string) {}

  // ---------------------------------------------------------------------------------------
  // Sharing-state queries

  // True if anyone other than the owner can currently access the gadget. Used by the Overseer's
  // `prohibitAllSharing` policy to decide whether a sensitive observation must be blocked.
  //
  // Because removed collaborators and revoked keys linger in storage (the lazy revocation model;
  // see the module header and removeCollaborator/revokeShareKey), this must reflect *current*
  // reachability, not mere table membership: a collaborator with a live path from the owner, or
  // an un-revoked share key that anyone could still redeem.
  hasAnyShares(): boolean {
    if (this.computeEffectiveRoles().size > 0) return true;
    for (let keyRecord of this.storage.shareKeys.list()) {
      if (!keyRecord.revoked) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------
  // Authorization (used by Overseer.open())

  // True if `profileId` currently has a collaborator record. This only checks membership; use
  // `getEffectiveRole()` to determine the actual access level (and whether the record is still
  // reachable from the owner in the permission graph).
  isCollaborator(profileId: string): boolean {
    return this.storage.collaborators.get(profileId) !== undefined;
  }

  // The effective role of `profileId` -- the maximum role reachable from the owner through valid
  // permission edges -- or undefined if the user has no access. The owner always has "build".
  getEffectiveRole(profileId: string): CollaboratorRole | undefined {
    if (profileId === this.ownerProfileId) return "build";
    return this.computeEffectiveRoles().get(profileId);
  }

  // Redeem a raw share key on behalf of a user opening the gadget. If the key exists, ensures the
  // user is a collaborator with a `shareKey` edge for it (adding the edge if missing, or creating
  // the collaborator record if they're new). Does nothing if the key is unknown.
  //
  // The raw key is hashed internally; the plaintext is never stored. `fetchProfile` is invoked
  // (an RPC, in production) only when a brand-new collaborator must be created, so existing
  // collaborators are redeemed without any RPC.
  //
  // A revoked key behaves like an unknown key (it cannot be redeemed).
  async redeemShareKey(opts: {
    rawKey: string;
    profileId: string;
    fetchProfile: () => Promise<AiChatAuthorInfo>;
  }): Promise<void> {
    let keyId = await hashShareKey(opts.rawKey);
    let keyRecord = this.storage.shareKeys.get(keyId);
    if (!keyRecord || keyRecord.revoked) return;

    let role = keyRecord.role ?? "build";

    let existing = this.storage.collaborators.get(opts.profileId);
    if (existing) {
      // User is already a collaborator. Only add an edge if they don't already have one for this
      // exact key.
      let alreadyHasEdge = existing.addedBy.some(
          e => e.type === "shareKey" && e.keyId === keyId);
      if (!alreadyHasEdge) {
        existing.addedBy.push({
          type: "shareKey",
          keyId,
          created: new Date(),
          role,
        });
        this.storage.collaborators.put(existing);
      }
    } else {
      // New collaborator -- need full profile from their user DO.
      let profile = await opts.fetchProfile();
      this.storage.collaborators.put({
        profile,
        addedBy: [{
          type: "shareKey",
          keyId,
          created: new Date(),
          role,
        }],
      });
    }
  }

  // ---------------------------------------------------------------------------------------
  // Collaborator management

  // List currently-active collaborators -- those with a live path from the owner. Under the lazy
  // revocation model, removed collaborators linger in storage with no reachable role; they are
  // omitted here (they reappear if re-added).
  listCollaborators(): CollaboratorInfo[] {
    let roles = this.computeEffectiveRoles();
    let result: CollaboratorInfo[] = [];
    for (let record of this.storage.collaborators.list()) {
      let role = roles.get(record.profile.id);
      if (!role) continue;  // not currently reachable from the owner
      result.push({
        profile: record.profile,
        addedBy: record.addedBy,
        role,
      });
    }
    return result;
  }

  // Add a collaborator with a `user` edge from the caller, granting `role`. The caller is
  // responsible for resolving `profile` (via RPC) and for any policy checks (e.g.
  // `prohibitAllSharing`). The caller may not grant a role higher than their own effective role.
  addCollaborator(opts: {
    caller: SharingCaller;
    profile: AiChatAuthorInfo;
    role: CollaboratorRole;
    note?: string;
  }): CollaboratorInfo {
    // Don't add the owner as a collaborator.
    if (opts.profile.id === this.ownerProfileId) {
      throw new Error("Cannot add the gadget owner as a collaborator.");
    }

    let callerRole = this.#requireCallerRole(opts.caller);
    if (roleRank(opts.role) > roleRank(callerRole)) {
      throw new Error("You cannot grant a role higher than your own.");
    }

    let existing = this.storage.collaborators.get(opts.profile.id);
    let edge: PermissionEdge = {
      type: "user",
      sharer: opts.caller.profileId,
      created: new Date(),
      role: opts.role,
      note: opts.note,
    };

    if (existing) {
      // Already a collaborator -- add an edge if they don't have one from this sharer, otherwise
      // upgrade the existing edge's role (never silently downgrade).
      let existingEdge = existing.addedBy.find(
          e => e.type === "user" && e.sharer === opts.caller.profileId);
      if (existingEdge && existingEdge.type === "user") {
        existingEdge.role = maxRole(edgeGrantedRole(existingEdge), opts.role);
        if (opts.note !== undefined) existingEdge.note = opts.note;
      } else {
        existing.addedBy.push(edge);
      }
      this.storage.collaborators.put(existing);
      return {
        profile: existing.profile,
        addedBy: existing.addedBy,
        role: this.computeEffectiveRoles().get(existing.profile.id) ?? opts.role,
      };
    }

    let record: CollaboratorRecord = {
      profile: opts.profile,
      addedBy: [edge],
    };
    this.storage.collaborators.put(record);
    return {
      profile: record.profile,
      addedBy: record.addedBy,
      role: this.computeEffectiveRoles().get(record.profile.id) ?? opts.role,
    };
  }

  previewRemoveCollaborator(caller: SharingCaller, profileId: string): AffectedCollaborator[] {
    let target = this.storage.collaborators.get(profileId);
    if (!target) return [];

    let baseline = this.computeEffectiveRoles();
    let modified = caller.isOwner
        ? this.computeEffectiveRoles({ removedUser: profileId })
        : this.computeEffectiveRoles({
            removedEdge: { target: profileId, sharer: caller.profileId } });

    return this.#computeAffected(baseline, modified);
  }

  // Remove a collaborator by severing the edges that grant them access. This is a *lazy* removal:
  // nothing cascades and no records are deleted. The target's record (and crucially, any edges
  // where the target is the *sharer* of access to others) is left intact, and dependents who lose
  // their only path to the owner simply become unreachable -- they are denied at open() time, not
  // pruned here. This makes the removal trivially reversible: re-adding the target (see
  // addCollaborator) restores the target and, transitively, everyone they had shared with.
  //
  //   - The owner severs *all* incoming edges to the target (owner-removal means "gone now").
  //   - A non-owner severs only their own `user` edge to the target; if the target retains other
  //     edges, they keep access (possibly at a lower role).
  //
  // `keepUsers` is optional re-root sugar: any listed dependent who would otherwise lose access or
  // be downgraded is granted a fresh edge from the caller at their prior role (see
  // `#reRootKeptUsers`). Returns the collaborators whose access actually changed (removed or
  // downgraded), excluding kept users.
  removeCollaborator(
      caller: SharingCaller, profileId: string, keepUsers: string[]): AffectedCollaborator[] {
    let target = this.storage.collaborators.get(profileId);
    if (!target) {
      throw new Error("User is not a collaborator.");
    }

    // Permission check: owner can remove anyone; collaborators can only remove users
    // they themselves added.
    if (!caller.isOwner) {
      let hasEdgeFromCaller = target.addedBy.some(
          e => e.type === "user" && e.sharer === caller.profileId);
      if (!hasEdgeFromCaller) {
        throw new Error("You can only remove users that you added.");
      }
    }

    let baseline = this.computeEffectiveRoles();

    // Sever the edges that grant the target access. The record is retained even if it becomes
    // empty, so the target's own outgoing grants survive and the removal can be undone.
    if (caller.isOwner) {
      target.addedBy = [];
    } else {
      target.addedBy = target.addedBy.filter(
          e => !(e.type === "user" && e.sharer === caller.profileId));
    }
    this.storage.collaborators.put(target);

    this.#reRootKeptUsers(caller, baseline, new Set(keepUsers));

    return this.#computeAffected(baseline, this.computeEffectiveRoles());
  }

  // ---------------------------------------------------------------------------------------
  // Share key management

  async createShareKey(
      opts: { caller: SharingCaller; role: CollaboratorRole; note?: string })
      : Promise<{ key: string }> {
    let callerRole = this.#requireCallerRole(opts.caller);
    if (roleRank(opts.role) > roleRank(callerRole)) {
      throw new Error("You cannot grant a role higher than your own.");
    }

    let rawBytes = new Uint8Array(16);
    crypto.getRandomValues(rawBytes);
    let key = rawBytes.toHex();
    let keyId = await hashShareKey(key);

    this.storage.shareKeys.put({
      id: keyId,
      note: opts.note,
      created: new Date(),
      createdBy: opts.caller.profileId,
      role: opts.role,
    });
    return { key };
  }

  // Active (non-revoked) share key records, in storage order. The Overseer maps each `createdBy`
  // profile.id to a display profile (which may require RPC) to produce `ShareKeyInfo`s; see
  // `getCreatorProfile`. Revoked keys linger in storage but are omitted here.
  listShareKeyRecords(): ShareKeyRecord[] {
    return [...this.storage.shareKeys.list()].filter(record => !record.revoked);
  }

  // Resolve the display profile for a share key's creator using only locally-available data
  // (the collaborator table). Returns undefined if the creator is neither a current collaborator
  // nor matched here (e.g. the owner), in which case the Overseer resolves it via RPC. The final
  // fallback (a bare profile from the id) is also the Overseer's responsibility.
  getCreatorProfile(createdBy: string): AiChatAuthorInfo | undefined {
    return this.storage.collaborators.get(createdBy)?.profile;
  }

  updateShareKey(caller: SharingCaller, keyId: string, note?: string): void {
    let keyRecord = this.storage.shareKeys.get(keyId);
    if (!keyRecord) {
      throw new Error("Share key not found.");
    }

    // Permission check: owner can edit any key; collaborators can only edit keys they created.
    if (!caller.isOwner && keyRecord.createdBy !== caller.profileId) {
      throw new Error("You can only edit share keys that you created.");
    }

    keyRecord.note = note === undefined ? undefined : note.slice(0, 500);
    this.storage.shareKeys.put(keyRecord);
  }

  previewRevokeShareKey(caller: SharingCaller, keyId: string): AffectedCollaborator[] {
    let keyRecord = this.storage.shareKeys.get(keyId);
    if (!keyRecord) return [];

    // Permission check: owner can revoke any key; collaborators can only revoke
    // keys they themselves created.
    if (!caller.isOwner && keyRecord.createdBy !== caller.profileId) {
      throw new Error("You can only revoke share keys that you created.");
    }

    let baseline = this.computeEffectiveRoles();
    let modified = this.computeEffectiveRoles({ revokedKeyId: keyId });
    return this.#computeAffected(baseline, modified);
  }

  // Revoke a share key by soft-revoking it (setting the `revoked` flag) rather than deleting it.
  // This is the lazy counterpart to removeCollaborator: the key record and every `shareKey` edge
  // referencing it stay intact (no dangling references), but the key contributes nothing to the
  // permission graph and can no longer be redeemed. Users who relied solely on it become
  // unreachable and are denied at open() time.
  //
  // `keepUsers` is optional re-root sugar, identical to removeCollaborator. Returns the
  // collaborators whose access actually changed (removed or downgraded), excluding kept users.
  revokeShareKey(
      caller: SharingCaller, keyId: string, keepUsers: string[]): AffectedCollaborator[] {
    let keyRecord = this.storage.shareKeys.get(keyId);
    if (!keyRecord) {
      throw new Error("Share key not found.");
    }

    // Permission check: owner can revoke any key; collaborators can only revoke
    // keys they themselves created.
    if (!caller.isOwner && keyRecord.createdBy !== caller.profileId) {
      throw new Error("You can only revoke share keys that you created.");
    }

    let baseline = this.computeEffectiveRoles();

    keyRecord.revoked = true;
    this.storage.shareKeys.put(keyRecord);

    this.#reRootKeptUsers(caller, baseline, new Set(keepUsers));

    return this.#computeAffected(baseline, this.computeEffectiveRoles());
  }

  // ---------------------------------------------------------------------------------------
  // Permission-graph engine

  // Compute the effective role of every collaborator -- the maximum role reachable from the owner
  // through valid permission edges. A collaborator absent from the returned map has no access.
  //
  // The owner is the implicit root at "build". Each edge grants min(edge role, sharer's effective
  // role):
  //   - A "user" edge's sharer is the owner (effective "build") or another collaborator.
  //   - A "shareKey" edge's "sharer" is the key's creator; the edge grants the key's role bounded
  //     by the creator's effective role.
  //
  // Optional modifications model a hypothetical change, used by the preview methods:
  //   - `removedUser`: a profileId treated as removed (excluded from the graph entirely).
  //   - `removedEdge`: a single user edge (target ← sharer) treated as removed.
  //   - `revokedKeyId`: a key treated as revoked (its edges contribute nothing).
  computeEffectiveRoles(opts: {
    removedUser?: string | null;
    removedEdge?: { target: string; sharer: string } | null;
    revokedKeyId?: string | null;
  } = {}): Map<string, CollaboratorRole> {
    let removedUser = opts.removedUser ?? null;
    let removedEdge = opts.removedEdge ?? null;
    let revokedKeyId = opts.revokedKeyId ?? null;

    // Map keyId → {creator, role}, excluding revoked keys (the persisted `revoked` flag, and the
    // hypothetical `revokedKeyId` used by preview).
    let keyInfo = new Map<string, { creator: string; role: CollaboratorRole }>();
    for (let keyRecord of this.storage.shareKeys.list()) {
      if (keyRecord.id === revokedKeyId || keyRecord.revoked) continue;
      keyInfo.set(keyRecord.id, {
        creator: keyRecord.createdBy,
        role: keyRecord.role ?? "build",
      });
    }

    // All collaborators except the removed user.
    let allCollabs = new Map<string, CollaboratorRecord>();
    for (let record of this.storage.collaborators.list()) {
      if (record.profile.id !== removedUser) {
        allCollabs.set(record.profile.id, record);
      }
    }

    // Roles known so far.
    let eff = new Map<string, CollaboratorRole>();

    // Effective role of a potential sharer (the owner is the root at "build").
    let sharerRole = (id: string): CollaboratorRole | undefined =>
        id === this.ownerProfileId ? "build" : eff.get(id);

    // Fixed-point iteration. Roles only increase, so this converges.
    let changed = true;
    while (changed) {
      changed = false;
      for (let [id, record] of allCollabs) {
        let best: CollaboratorRole | undefined = eff.get(id);
        for (let edge of record.addedBy) {
          let granted: CollaboratorRole | undefined;
          if (edge.type === "shareKey") {
            let info = keyInfo.get(edge.keyId);
            if (!info) continue;  // key revoked or no longer exists
            let creatorRole = sharerRole(info.creator);
            if (!creatorRole) continue;
            granted = minRole(info.role, creatorRole);
          } else {
            // Skip the specifically-removed edge.
            if (removedEdge && id === removedEdge.target &&
                edge.sharer === removedEdge.sharer) {
              continue;
            }
            if (edge.sharer === removedUser) continue;
            let upstream = sharerRole(edge.sharer);
            if (!upstream) continue;
            granted = minRole(edgeGrantedRole(edge), upstream);
          }
          if (granted && (!best || roleRank(granted) > roleRank(best))) {
            best = granted;
          }
        }
        if (best && best !== eff.get(id)) {
          eff.set(id, best);
          changed = true;
        }
      }
    }

    return eff;
  }

  // The caller's effective role, throwing if the caller has no access at all (which should not
  // happen for an authorized session).
  #requireCallerRole(caller: SharingCaller): CollaboratorRole {
    if (caller.isOwner) return "build";
    let role = this.computeEffectiveRoles().get(caller.profileId);
    if (!role) {
      throw new Error("You do not have permission to share this gadget.");
    }
    return role;
  }

  // Diff two effective-role maps, returning the collaborators whose access changed. A user is
  // affected if they had access in `baseline` and either lost it (newRole null) or were downgraded
  // (newRole lower than oldRole) in `modified`. Profiles/edges are read from current storage.
  #computeAffected(
      baseline: Map<string, CollaboratorRole>,
      modified: Map<string, CollaboratorRole>): AffectedCollaborator[] {
    let result: AffectedCollaborator[] = [];
    for (let [id, oldRole] of baseline) {
      let newRole = modified.get(id) ?? null;
      if (newRole !== null && roleRank(newRole) >= roleRank(oldRole)) {
        continue;  // unchanged or (shouldn't happen) upgraded
      }
      let record = this.storage.collaborators.get(id);
      if (!record) continue;
      result.push({
        profile: record.profile,
        addedBy: record.addedBy,
        oldRole,
        newRole,
      });
    }
    return result;
  }

  // Optional re-root sugar for removeCollaborator/revokeShareKey. Must be called *after* the
  // edge/key has already been severed in storage. `baseline` is the effective-role map from before
  // the severance. For each kept user who would otherwise lose access or be downgraded, append a
  // fresh `user` edge from the caller at their prior role (bounded by what the caller can grant),
  // so they retain their access independently of the severed path.
  #reRootKeptUsers(
      caller: SharingCaller, baseline: Map<string, CollaboratorRole>, keepSet: Set<string>): void {
    if (keepSet.size === 0) return;

    let callerRole = this.#requireCallerRole(caller);
    let afterSever = this.computeEffectiveRoles();

    for (let id of keepSet) {
      let prior = baseline.get(id);
      if (!prior) continue;  // had no access to begin with -- nothing to keep

      let now = afterSever.get(id);
      if (now && roleRank(now) >= roleRank(prior)) continue;  // not dropped -- no edge needed

      let record = this.storage.collaborators.get(id);
      if (!record) continue;

      record.addedBy.push({
        type: "user",
        sharer: caller.profileId,
        created: new Date(),
        role: minRole(prior, callerRole),
      });
      this.storage.collaborators.put(record);
    }
  }
}
