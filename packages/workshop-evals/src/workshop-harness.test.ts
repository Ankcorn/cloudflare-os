import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { canonicalTranscript } from "./workshop-harness.js";

const user: AiChatAuthorInfo = { type: "user", id: "user", name: "User" };
const agent: AiChatAuthorInfo = { type: "agent", id: "model", name: "Agent" };

describe("canonicalTranscript", () => {
  it("keeps user, assistant, and linked tool events with sequence metadata", () => {
    const history: AiChatMessage[] = [
      {
        chatId: 1, sequence: 1, timestamp: new Date("2026-08-17T00:00:00Z"), author: user,
        type: "message", message: "Build it",
      },
      {
        chatId: 1, sequence: 2, timestamp: new Date("2026-08-17T00:00:01Z"), author: agent,
        type: "message", message: "Working",
        reasoning: "SECRET_REASONING",
        toolCalls: [{
          toolCallId: "call-1",
          toolName: "executeCode",
          input: { code: "return 1" },
          output: "1",
        }],
      },
    ];

    const events = canonicalTranscript(history);

    expect(events).toEqual([
      {
        type: "message", role: "user", content: "Build it",
        metadata: { sequence: 1, timestamp: "2026-08-17T00:00:00.000Z" },
      },
      {
        type: "message", role: "assistant", content: "Working",
        metadata: { sequence: 2, timestamp: "2026-08-17T00:00:01.000Z" },
      },
      {
        type: "tool_call", id: "call-1", name: "executeCode",
        arguments: { code: "return 1" },
        metadata: { sequence: 2, timestamp: "2026-08-17T00:00:01.000Z" },
      },
      {
        type: "tool_result", toolCallId: "call-1", name: "executeCode", content: "1",
        metadata: { sequence: 2, timestamp: "2026-08-17T00:00:01.000Z" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("SECRET_REASONING");
  });

  it("omits Yjs lifecycle messages and records tool failures", () => {
    const history: AiChatMessage[] = [
      {
        chatId: 1, sequence: 1, timestamp: new Date(), author: agent,
        type: "changes", update: new Uint8Array([1]),
      },
      {
        chatId: 1, sequence: 2, timestamp: new Date("2026-08-17T00:00:00Z"), author: agent,
        type: "message", message: "",
        toolCalls: [{
          toolCallId: "call-2",
          toolName: "readFile",
          input: { filename: "missing.ts" },
          error: "not found",
        }],
      },
    ];

    expect(canonicalTranscript(history)).toEqual([
      {
        type: "tool_call", id: "call-2", name: "readFile",
        arguments: { filename: "missing.ts" },
        metadata: { sequence: 2, timestamp: "2026-08-17T00:00:00.000Z" },
      },
      {
        type: "tool_result", toolCallId: "call-2", name: "readFile",
        error: { name: "Error", message: "not found" },
        metadata: { sequence: 2, timestamp: "2026-08-17T00:00:00.000Z" },
      },
    ]);
  });
});
