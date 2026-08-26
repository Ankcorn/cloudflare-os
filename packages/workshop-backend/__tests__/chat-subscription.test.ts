// subscribeToChat's change-row replay and the retired-row lifecycle, over the production
// chatChanges collection (liveByChat / retiredByTimestamp indexes) on mock storage.

import { describe, expect, it } from "vitest";
import type { Collection } from "@gadgets/typed-storage";
import type { ChatChangeRecord } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";
import {
  FIXTURE_EPOCH, makeActionStorage, makePreIndexChatChangeStorage,
} from "./fixtures.js";

// Puts one change row; timestamp defaults to FIXTURE_EPOCH + revision.
function putChange(
    storage: { chatChanges: Collection<ChatChangeRecord, string> },
    chatId: number, generation: number, revision: number,
    opts: { retired?: boolean, timestamp?: Date } = {}) {
  storage.chatChanges.put({
    chatId, generation, revision,
    timestamp: opts.timestamp ?? new Date(FIXTURE_EPOCH + revision),
    author: { type: "user", id: "alice@example.com", name: "Alice" },
    change: {},
    source: "user",
    ...(opts.retired ? { retired: true as const } : {}),
  });
}

describe("chat-change index migration", () => {
  it("serves records written before the indexes existed once a rebuild backfills them", () => {
    // Mirrors the version-4 migration: rows predate the index declarations, so each index
    // starts empty until the migration's rebuild() runs.
    let mock = makeMockStorage();
    let legacy = makePreIndexChatChangeStorage(mock);
    putChange(legacy, 1, 0, 1);
    putChange(legacy, 1, 0, 2, { retired: true });
    putChange(legacy, 2, 0, 1, { retired: true });
    putChange(legacy, 2, 0, 2);

    let storage = makeActionStorage(mock);
    storage.chatChanges.liveByChat.rebuild();
    storage.chatChanges.retiredByTimestamp.rebuild();

    // The live index serves exactly the unretired rows, per chat; the retired index serves the
    // retired rows in timestamp order.
    expect([...storage.chatChanges.liveByChat.get(1)].map(r => r.revision)).toEqual([1]);
    expect([...storage.chatChanges.liveByChat.get(2)].map(r => r.revision)).toEqual([2]);
    expect([...storage.chatChanges.retiredByTimestamp.list()]
        .map(r => [r.chatId, r.revision])).toEqual([[2, 1], [1, 2]]);

    // Retiring a backfilled row must not throw on either index's update.
    let row = [...storage.chatChanges.liveByChat.get(1)][0];
    row.retired = true;
    storage.chatChanges.put(row);
    expect([...storage.chatChanges.liveByChat.get(1)]).toEqual([]);
    expect([...storage.chatChanges.retiredByTimestamp.list()].length).toBe(3);
  });
});
