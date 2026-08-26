// subscribeToChat's change-row replay and the retired-row lifecycle, over the production
// chatChanges collection (liveByChat / retiredByTimestamp indexes) on mock storage.

import { describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { Collection } from "@gadgets/typed-storage";
import type {
  AiChatMessage, AiChatMetadata, AiChatSubscriber,
} from "@gadgets/workshop-shared/api";
import type { ChatChangeRecord } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";
import {
  FIXTURE_EPOCH, makeActionStorage, makePreIndexChatChangeStorage, openFakeOverseer,
} from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

// Hand-rolled AiChatSubscriber stub. Collects delivered changes and messages; `changeApplied`
// can be overridden to gate or fail deliveries.
function makeChatSubscriber(
    changeApplied?: (chatId: number, generation: number, revision: number) => Promise<void>) {
  let changes: Array<{ chatId: number, generation: number, revision: number }> = [];
  let messages: AiChatMessage[] = [];
  let disposeCount = 0;
  let subscriber = {
    streamGeneration: async () => {},
    metadata: async (_meta: AiChatMetadata) => {},
    deleted: async () => {},
    message: async (msg: AiChatMessage) => { messages.push(msg); },
    changeApplied: changeApplied ?? (async (chatId: number, generation: number,
                                            revision: number) => {
      changes.push({ chatId, generation, revision });
    }),
    stream: async () => {},
    dup: () => subscriber,
    onRpcBroken: () => {},
    [Symbol.dispose]: () => { ++disposeCount; },
  };
  return {
    subscriber: subscriber as unknown as RpcStub<AiChatSubscriber>,
    changes, messages, disposeCount: () => disposeCount,
  };
}

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

describe("retired-row sweep", () => {
  it("expires aged retired rows at subscribe entry, keeping fresh retired and live rows",
      async () => {
    let storage = makeActionStorage();
    let aged = new Date(Date.now() - 10 * 60_000);
    putChange(storage, 1, 0, 1, { retired: true, timestamp: aged });
    putChange(storage, 1, 0, 2, { retired: true, timestamp: new Date() });
    putChange(storage, 1, 0, 3, { timestamp: aged });  // live rows never expire
    let client = await openFakeOverseer(storage);
    let { subscriber } = makeChatSubscriber();

    using _sub = await client.subscribeToChat(subscriber);
    expect([...storage.chatChanges.list()].map(r => r.revision)).toEqual([2, 3]);
  });
});

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
