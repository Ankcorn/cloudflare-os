import { describe, expect, it } from "vitest";
import type { SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { parseComposerClipboard, serializeComposerClipboard } from "./composerClipboard";
import { slashCommandComposerText } from "../../../../components/chat/composer-tokens";

const compact: SlashCommandChoice = {
  selection: { builtin: true, commandId: "compact" },
  name: "compact",
  description: "Compact this chat.",
  providerLabel: "Workshop",
};

describe("composer clipboard", () => {
  it("copies readable text and round-trips rich skill metadata", () => {
    const logoSlot = "\u2003\u2060\u00a0";
    const commandText = slashCommandComposerText("compact", logoSlot);
    const value = `before ${commandText} after`;
    const copied = serializeComposerClipboard(value, 0, value.length, {
      start: 7,
      length: commandText.length,
      choice: compact,
    }, logoSlot);

    expect(copied?.plainText).toBe("before compact after");
    expect(copied?.commandRange).toEqual({ start: 7, length: commandText.length });
    expect(parseComposerClipboard(copied!.richText)).toEqual({
      version: 1,
      text: "before compact after",
      command: { position: 7, length: 7, choice: compact },
    });
  });

  it("rejects stale command ranges and malformed rich metadata", () => {
    expect(serializeComposerClipboard("compact", 0, 7, {
      start: 0,
      length: 7,
      choice: compact,
    }, "\u2003\u2060\u00a0")).toBeNull();
    expect(parseComposerClipboard("compact")).toBeNull();
    expect(parseComposerClipboard(JSON.stringify({
      version: 1,
      text: "not compact",
      command: { position: 0, length: 7, choice: compact },
    }))).toBeNull();
  });

  it("rejects forged built-in skill metadata", () => {
    expect(parseComposerClipboard(JSON.stringify({
      version: 1,
      text: "delete",
      command: {
        position: 0,
        length: 6,
        choice: {
          selection: { builtin: true, commandId: "compact" },
          name: "delete",
          description: "Delete this chat.",
          providerLabel: "Workshop",
        },
      },
    }))).toBeNull();
  });
});
