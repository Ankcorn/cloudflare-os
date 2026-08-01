// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import {
  buildChatDisplayEntries, computeMessageStates, type CompactionBoundary,
} from "./ChatInterface";

const AUTHOR = { type: "agent", id: "test-model", name: "Test" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AUTHOR, ...body };
}

function changes(sequence: number, update: Uint8Array): AiChatMessage {
  return message(sequence, { type: "changes", update });
}

function merge(sequence: number, mergeThrough: number): AiChatMessage {
  return message(sequence, { type: "merge", mergeThrough, version: 1 });
}

function revert(sequence: number, revertFrom: number): AiChatMessage {
  return message(sequence, { type: "revert", revertFrom });
}

function boundary(to: number, proposedChanges?: Uint8Array): CompactionBoundary {
  return { to, summary: "Earlier work", proposedChanges };
}

const PRE_BOUNDARY = new Uint8Array([1, 2, 3]);
const LOADED = new Uint8Array([4, 5, 6]);
const OLDER = new Uint8Array([7, 8, 9]);

describe("computeMessageStates compaction seeding", () => {
  it("counts the boundary's proposed changes as one entry below the oldest loaded message", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([
      { sequence: 9, update: PRE_BOUNDARY },
      { sequence: 10, update: LOADED },
    ]);
  });

  it("ignores a boundary that carries no proposed changes", () => {
    const { activeChanges } = computeMessageStates([changes(10, LOADED)], boundary(10));

    expect(activeChanges).toEqual([{ sequence: 10, update: LOADED }]);
  });

  // Accepting changes must clear the compacted prefix's update too, or the chat keeps reporting
  // proposed changes that the user already accepted.
  it("resolves the boundary entry when a merge reaches across it", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED), merge(11, 10), changes(12, OLDER)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([{ sequence: 12, update: OLDER }]);
  });

  it("keeps the boundary entry when a revert stops above it", () => {
    const { activeChanges } = computeMessageStates(
      [changes(10, LOADED), revert(11, 10)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([{ sequence: 9, update: PRE_BOUNDARY }]);
  });

  // The boundary's update is the merge of the "changes" messages before it, so it must drop out the
  // moment those messages load -- otherwise the same edits are counted twice.
  it("drops the boundary entry once the messages before it have loaded", () => {
    const { activeChanges } = computeMessageStates(
      [changes(5, OLDER), changes(10, LOADED)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(activeChanges).toEqual([
      { sequence: 5, update: OLDER },
      { sequence: 10, update: LOADED },
    ]);
  });

  it("leaves loaded messages' change status alone", () => {
    const { changeStatus } = computeMessageStates(
      [changes(10, LOADED), merge(11, 10)],
      boundary(10, PRE_BOUNDARY),
    );

    expect(changeStatus.get(10)).toBe("merged");
  });
});

describe("built-in slash commands in the transcript", () => {
  // `/compact` carries no prompt and gets no provider reply, so a bubble for it would be empty. The
  // compaction boundary is what shows the user their command took effect.
  it("shows no entry for a built-in command", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "slashCommand", request: {id: {builtin: true, commandId: "compact"}, args: ""}}),
    ], new Map());

    expect(entries).toEqual([]);
  });

  // A gatekeeper command still shows: it expands to a prompt the user should be able to read.
  it("still shows a gatekeeper command", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "slashCommand", request: {id: {gatekeeperId: 2, commandId: "deploy"}, args: "prod"}}),
    ], new Map());

    expect(entries).toHaveLength(1);
  });
});

describe("compaction boundary placement", () => {
  const boundary = (to: number): CompactionBoundary => ({to, summary: `summary ${to}`});

  // The marker belongs where the cut fell, not above the thread: once earlier messages are loaded
  // around it, a marker pinned to the top would claim they had been summarized away.
  it("marks the cut between the messages it separates", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "message", message: "before"}),
      message(2, {type: "message", message: "before"}),
      message(3, {type: "message", message: "after"}),
    ], new Map(), [boundary(3)]);

    expect(entries.map(entry =>
      entry.type === "compactionBoundary" ? `|${entry.boundary.to}` : entry.type)).toEqual(
      ["message", "message", "|3", "message"]);
  });

  // A thread compacted more than once shows every cut the loaded history covers.
  it("marks each loaded boundary", () => {
    const entries = buildChatDisplayEntries([
      message(1, {type: "message", message: "a"}),
      message(4, {type: "message", message: "b"}),
      message(7, {type: "message", message: "c"}),
    ], new Map(), [boundary(4), boundary(7)]);

    expect(entries.map(entry =>
      entry.type === "compactionBoundary" ? `|${entry.boundary.to}` : entry.type)).toEqual(
      ["message", "|4", "message", "|7", "message"]);
  });

  // Nothing older is loaded, so the marker sits at the top -- the case a fresh page hits.
  it("marks the top when the whole page is post-boundary", () => {
    const entries = buildChatDisplayEntries([
      message(5, {type: "message", message: "tail"}),
    ], new Map(), [boundary(5)]);

    expect(entries[0].type).toBe("compactionBoundary");
  });
});
