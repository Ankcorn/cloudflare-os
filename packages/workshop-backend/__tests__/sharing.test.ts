import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  SharingManager,
  SharingStorage,
  CollaboratorRecord,
  ShareKeyRecord,
} from "../src/sharing.js";
import { AiChatAuthorInfo, PermissionEdge, CollaboratorRole } from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): SharingStorage {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      collaborators: collection<CollaboratorRecord>()({
        primaryKey: (record: CollaboratorRecord) => record.profile.id,
      }),
      shareKeys: collection<ShareKeyRecord>()({ primaryKey: "id" }),
    },
  });
}

const OWNER = "owner@example.com";

function makeManager(): { storage: SharingStorage; mgr: SharingManager } {
  let storage = makeStorage();
  return { storage, mgr: new SharingManager(storage, OWNER) };
}

function profile(id: string): AiChatAuthorInfo {
  return { type: "user", id, name: id };
}

function userEdge(sharer: string, role: CollaboratorRole = "build"): PermissionEdge {
  return { type: "user", sharer, created: new Date(), role };
}

function keyEdge(keyId: string, role: CollaboratorRole = "build"): PermissionEdge {
  return { type: "shareKey", keyId, created: new Date(), role };
}

function seedCollaborator(storage: SharingStorage, id: string, addedBy: PermissionEdge[]) {
  storage.collaborators.put({ profile: profile(id), addedBy });
}

function seedKey(
    storage: SharingStorage, id: string, createdBy: string, role: CollaboratorRole = "build") {
  storage.shareKeys.put({ id, created: new Date(), createdBy, role });
}

function ids(list: { profile: AiChatAuthorInfo }[]): string[] {
  return list.map(x => x.profile.id).toSorted();
}

const owner = { profileId: OWNER, isOwner: true };
function collab(id: string) {
  return { profileId: id, isOwner: false };
}

describe("authorization", () => {
  it("isCollaborator reflects the collaborators table", () => {
    let { storage, mgr } = makeManager();
    expect(mgr.isCollaborator("a")).toBe(false);
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    expect(mgr.isCollaborator("a")).toBe(true);
  });

  it("getEffectiveRole returns build for the owner", () => {
    let { mgr } = makeManager();
    expect(mgr.getEffectiveRole(OWNER)).toBe("build");
  });

  it("getEffectiveRole returns undefined for non-collaborators", () => {
    let { mgr } = makeManager();
    expect(mgr.getEffectiveRole("nobody")).toBeUndefined();
  });

  it("getEffectiveRole reflects the granted role", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "build")]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });

  it("hasAnyShares reflects current reachability, not table membership", () => {
    let { storage, mgr } = makeManager();
    expect(mgr.hasAnyShares()).toBe(false);

    // An active share key counts as a share.
    seedKey(storage, "k1", OWNER);
    expect(mgr.hasAnyShares()).toBe(true);

    // A revoked key does not.
    storage.shareKeys.put({ id: "k1", created: new Date(), createdBy: OWNER, revoked: true });
    expect(mgr.hasAnyShares()).toBe(false);

    // A reachable collaborator counts.
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    expect(mgr.hasAnyShares()).toBe(true);

    // A collaborator whose record lingers but is unreachable does not.
    storage.collaborators.put({ profile: profile("a"), addedBy: [] });
    expect(mgr.hasAnyShares()).toBe(false);
  });
});

describe("redeemShareKey", () => {
  it("creates a new collaborator (fetching profile) when the key is valid", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareKey({ caller: owner, role: "build" });

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "newbie",
      fetchProfile: async () => { fetched++; return profile("newbie"); },
    });

    expect(fetched).toBe(1);
    let rec = storage.collaborators.get("newbie")!;
    expect(rec.addedBy).toEqual([expect.objectContaining({ type: "shareKey", role: "build" })]);
  });

  it("stamps the redeemed edge with the key's role", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareKey({ caller: owner, role: "use" });

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    expect(storage.collaborators.get("a")!.addedBy)
        .toEqual([expect.objectContaining({ type: "shareKey", role: "use" })]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
  });

  it("adds a key edge to an existing collaborator without fetching the profile", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareKey({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [userEdge(OWNER)]);

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => { fetched++; return profile("a"); },
    });

    expect(fetched).toBe(0);
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(2);
  });

  it("does not duplicate an edge for the same key", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareKey({ caller: owner, role: "build" });

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
  });

  it("is a no-op for an unknown key", async () => {
    let { storage, mgr } = makeManager();
    // A syntactically-valid raw key (hex) that was never created.
    await mgr.redeemShareKey({
      rawKey: "00112233445566778899aabbccddeeff", profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")).toBeUndefined();
  });
});

describe("addCollaborator", () => {
  it("adds a new collaborator with a user edge from the caller", () => {
    let { storage, mgr } = makeManager();
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build", note: "hi" });
    expect(info.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER, role: "build", note: "hi" }),
    ]);
    expect(info.role).toBe("build");
    expect(storage.collaborators.get("a")).toBeDefined();
  });

  it("records the granted role", () => {
    let { mgr } = makeManager();
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    expect(info.role).toBe("use");
  });

  it("refuses to add the owner", () => {
    let { mgr } = makeManager();
    expect(() => mgr.addCollaborator({ caller: owner, profile: profile(OWNER), role: "build" }))
        .toThrow(/owner/);
  });

  it("forbids granting a role higher than the caller's own", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "build" }))
        .toThrow(/higher than your own/);
    // Granting an equal-or-lower role is fine.
    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "use" }))
        .not.toThrow();
  });

  it("adds a second edge from a different sharer but dedups same sharer", () => {
    let { storage, mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("b"), role: "build" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    mgr.addCollaborator({ caller: collab("b"), profile: profile("a"), role: "build" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });  // dup sharer
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(2);
  });

  it("upgrades (never downgrades) the role of an existing same-sharer edge", () => {
    let { storage, mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
    expect(mgr.getEffectiveRole("a")).toBe("build");

    // A subsequent lower grant does not downgrade the existing edge.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    expect(mgr.getEffectiveRole("a")).toBe("build");
  });
});

describe("computeEffectiveRoles", () => {
  it("propagates roles along a chain", () => {
    let { storage, mgr } = makeManager();
    // owner -> a -> b
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "build")]);
    let roles = mgr.computeEffectiveRoles();
    expect(roles.get("a")).toBe("build");
    expect(roles.get("b")).toBe("build");
  });

  it("bounds a granted role by the sharer's effective role", () => {
    let { storage, mgr } = makeManager();
    // owner -grants use-> a; a -grants build-> b. b is bounded by a's "use".
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "b", [userEdge("a", "build")]);
    expect(mgr.getEffectiveRole("b")).toBe("use");
  });

  it("takes the maximum across multiple paths", () => {
    let { storage, mgr } = makeManager();
    // b is reachable via owner directly (use) and via a (build).
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });

  it("excludes a removed user and drops their sole dependents", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let roles = mgr.computeEffectiveRoles({ removedUser: "a" });
    expect(roles.has("a")).toBe(false);
    expect(roles.has("b")).toBe(false);
  });

  it("cascades share-key revocation through dependent users", () => {
    let { storage, mgr } = makeManager();
    seedKey(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let roles = mgr.computeEffectiveRoles({ revokedKeyId: "k1" });
    expect(roles.has("a")).toBe(false);
    expect(roles.has("b")).toBe(false);
  });
});

describe("previewRemoveCollaborator", () => {
  it("reports a transitively-removed dependent", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let affected = mgr.previewRemoveCollaborator(owner, "a");
    expect(ids(affected)).toEqual(["a", "b"]);
    expect(affected.find(x => x.profile.id === "b")!.newRole).toBe(null);
  });

  it("reports a downgrade rather than a removal", () => {
    let { storage, mgr } = makeManager();
    // b has build via a, but also use directly from the owner. Removing a downgrades b to use.
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    let affected = mgr.previewRemoveCollaborator(owner, "a");
    let b = affected.find(x => x.profile.id === "b")!;
    expect(b.oldRole).toBe("build");
    expect(b.newRole).toBe("use");
  });
});

describe("removeCollaborator", () => {
  it("severs the target's access and lets dependents go dark, but retains records", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = mgr.removeCollaborator(owner, "a", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    // Records are NOT deleted under the lazy model.
    expect(storage.collaborators.get("a")).toBeDefined();
    expect(storage.collaborators.get("b")).toBeDefined();
    // But neither has access anymore.
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    expect(mgr.getEffectiveRole("b")).toBeUndefined();
  });

  it("owner severs ALL incoming edges to the target", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // t is reachable via both the owner and a.
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a")]);

    mgr.removeCollaborator(owner, "t", []);
    expect(storage.collaborators.get("t")!.addedBy).toEqual([]);
    expect(mgr.getEffectiveRole("t")).toBeUndefined();
  });

  it("re-adding a removed intermediary restores their downstream shares (undo)", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // a has shared with five users.
    for (let i = 0; i < 5; i++) seedCollaborator(storage, `d${i}`, [userEdge("a")]);

    mgr.removeCollaborator(owner, "a", []);
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(mgr.getEffectiveRole(`d${i}`)).toBeUndefined();

    // Undo by re-adding a; the five downstream grants were never deleted.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(mgr.getEffectiveRole("a")).toBe("build");
    for (let i = 0; i < 5; i++) expect(mgr.getEffectiveRole(`d${i}`)).toBe("build");
  });

  it("re-roots a kept dependent under the caller", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]);  // b is kept, so not reported
    expect(mgr.getEffectiveRole("b")).toBe("build");
    // b gained a fresh edge from the caller.
    expect(storage.collaborators.get("b")!.addedBy)
        .toContainEqual(expect.objectContaining({ type: "user", sharer: OWNER, role: "build" }));
  });

  it("keeps a downgraded user at their prior role when kept", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);

    let affected = mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]);
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });

  it("downgrades a non-kept user instead of removing them", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);

    let affected = mgr.removeCollaborator(owner, "a", []);
    expect(affected.map(x => x.profile.id).toSorted()).toEqual(["a", "b"]);
    expect(affected.find(x => x.profile.id === "b")!.newRole).toBe("use");
    // b retains access at the lower role; its (now-inert) edge from a is left untouched (lazy).
    expect(mgr.getEffectiveRole("b")).toBe("use");
    expect(storage.collaborators.get("b")!.addedBy).toHaveLength(2);
  });

  it("does not prune now-inert edges from surviving collaborators (lazy)", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // c is supported by the owner directly, but also carries an edge from a.
    seedCollaborator(storage, "c", [userEdge(OWNER), userEdge("a")]);

    mgr.removeCollaborator(owner, "a", []);
    // c keeps full access; the inert edge from a remains in storage.
    expect(mgr.getEffectiveRole("c")).toBe("build");
    expect(storage.collaborators.get("c")!.addedBy).toHaveLength(2);
  });

  it("lets a non-owner remove only their own edge, sparing the target if others remain", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a")]);

    let affected = mgr.removeCollaborator(collab("a"), "t", []);
    expect(affected).toEqual([]);
    expect(storage.collaborators.get("t")!.addedBy)
        .toEqual([expect.objectContaining({ type: "user", sharer: OWNER })]);
  });

  it("forbids a non-owner from removing a user they didn't add", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "t", [userEdge(OWNER)]);
    expect(() => mgr.removeCollaborator(collab("a"), "t", [])).toThrow(/only remove users/);
  });

  it("throws when the target is not a collaborator", () => {
    let { mgr } = makeManager();
    expect(() => mgr.removeCollaborator(owner, "ghost", [])).toThrow(/not a collaborator/);
  });
});

describe("revokeShareKey", () => {
  it("soft-revokes the key and cuts off users supported only by it", () => {
    let { storage, mgr } = makeManager();
    seedKey(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = mgr.revokeShareKey(owner, "k1", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    // The key record is retained but marked revoked.
    expect(storage.shareKeys.get("k1")!.revoked).toBe(true);
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    expect(mgr.getEffectiveRole("b")).toBeUndefined();
  });

  it("does not cascade-revoke keys created by cut-off users (lazy)", () => {
    let { storage, mgr } = makeManager();
    seedKey(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedKey(storage, "k2", "a");  // key created by a
    seedCollaborator(storage, "b", [keyEdge("k2")]);

    mgr.revokeShareKey(owner, "k1", []);
    // k2 is left untouched, but b is unreachable because a (k2's creator) is unreachable.
    expect(storage.shareKeys.get("k2")!.revoked).toBeFalsy();
    expect(mgr.getEffectiveRole("b")).toBeUndefined();

    // Undo: re-add a, and b regains access through k2.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });

  it("a revoked key can no longer be redeemed", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareKey({ caller: owner, role: "build" });
    let keyId = mgr.listShareKeyRecords()[0].id;

    mgr.revokeShareKey(owner, keyId, []);

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids a non-owner from revoking a key they didn't create", () => {
    let { storage, mgr } = makeManager();
    seedKey(storage, "k1", OWNER);
    expect(() => mgr.revokeShareKey(collab("a"), "k1", [])).toThrow(/only revoke/);
  });
});

describe("createShareKey", () => {
  it("persists the granted role", async () => {
    let { mgr } = makeManager();
    let { key } = await mgr.createShareKey({ caller: owner, role: "use" });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    let records = mgr.listShareKeyRecords();
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("use");
  });

  it("forbids creating a key with a higher role than the caller's own", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    expect(() => mgr.createShareKey({ caller: collab("a"), role: "build" }))
        .rejects.toThrow(/higher than your own/);
  });
});

describe("listCollaborators", () => {
  it("includes each collaborator's effective role", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use")]);
    let list = mgr.listCollaborators();
    expect(list.find(x => x.profile.id === "a")!.role).toBe("build");
    expect(list.find(x => x.profile.id === "b")!.role).toBe("use");
  });

  it("omits collaborators who linger in storage but are unreachable", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "dead", []);  // record with no incoming edges
    let list = mgr.listCollaborators();
    expect(ids(list)).toEqual(["a"]);
  });
});

describe("listShareKeyRecords", () => {
  it("omits revoked keys", () => {
    let { storage, mgr } = makeManager();
    seedKey(storage, "k1", OWNER);
    storage.shareKeys.put({ id: "k2", created: new Date(), createdBy: OWNER, revoked: true });
    expect(mgr.listShareKeyRecords().map(r => r.id)).toEqual(["k1"]);
  });
});

describe("updateShareKey", () => {
  it("owner can edit any key's note", () => {
    let { storage, mgr } = makeManager();
    seedKey(storage, "k1", "a");
    mgr.updateShareKey(owner, "k1", "renamed");
    expect(storage.shareKeys.get("k1")!.note).toBe("renamed");
  });

  it("non-owner cannot edit a key they didn't create", () => {
    let { storage, mgr } = makeManager();
    seedKey(storage, "k1", OWNER);
    expect(() => mgr.updateShareKey(collab("a"), "k1", "x")).toThrow(/only edit/);
  });
});
