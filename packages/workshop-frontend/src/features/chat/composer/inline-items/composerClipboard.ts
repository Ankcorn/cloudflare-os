import type { SlashCommandChoice, SlashCommandId } from "@gadgets/workshop-shared/api";
import {
  serializeComposerSelection,
  slashCommandComposerText,
  type ComposerRange,
} from "../../../../components/chat/composer-tokens";

export const COMPOSER_CLIPBOARD_TYPE = "application/x-gadgets-composer+json";

type ComposerClipboardPayload = {
  version: 1;
  text: string;
  command: {
    position: number;
    length: number;
    choice: SlashCommandChoice;
  };
};

const readSlashCommandId = (value: unknown): SlashCommandId | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.builtin === true) {
    return record.commandId === "compact" ? { builtin: true, commandId: "compact" } : undefined;
  }
  if (record.builtin !== undefined || !Number.isInteger(record.gatekeeperId) ||
      typeof record.commandId !== "string" || !record.commandId) {
    return undefined;
  }
  return { gatekeeperId: record.gatekeeperId as number, commandId: record.commandId };
};

const readSlashCommandChoice = (value: unknown): SlashCommandChoice | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const selection = readSlashCommandId(record.selection);
  if (!selection || typeof record.name !== "string" || !record.name ||
      "builtin" in selection && record.name !== selection.commandId ||
      typeof record.description !== "string" || typeof record.providerLabel !== "string" ||
      record.resourceLabel !== undefined && typeof record.resourceLabel !== "string") {
    return undefined;
  }
  return {
    selection,
    name: record.name,
    description: record.description,
    providerLabel: record.providerLabel,
    ...(record.resourceLabel !== undefined && { resourceLabel: record.resourceLabel as string }),
  };
};

export function serializeComposerClipboard(
  value: string,
  start: number,
  end: number,
  command: ComposerRange & { choice: SlashCommandChoice },
  logoSlot: string,
): { plainText: string; richText: string; commandRange: ComposerRange } | null {
  const commandText = slashCommandComposerText(command.choice.name, logoSlot);
  if (value.slice(command.start, command.start + command.length) !== commandText ||
      command.start + command.length <= start || command.start >= end) {
    return null;
  }
  const plainText = serializeComposerSelection(value, start, end, [{
    start: command.start,
    length: command.length,
    text: command.choice.name,
  }]);
  const position = Math.max(0, command.start - start);
  const payload: ComposerClipboardPayload = {
    version: 1,
    text: plainText,
    command: { position, length: command.choice.name.length, choice: command.choice },
  };
  return {
    plainText,
    richText: JSON.stringify(payload),
    commandRange: { start: command.start, length: command.length },
  };
}

export function parseComposerClipboard(value: string): ComposerClipboardPayload | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.text !== "string" ||
        !record.command || typeof record.command !== "object") {
      return null;
    }
    const command = record.command as Record<string, unknown>;
    const choice = readSlashCommandChoice(command.choice);
    if (!choice || !Number.isInteger(command.position) || !Number.isInteger(command.length)) {
      return null;
    }
    const position = command.position as number;
    const length = command.length as number;
    if (position < 0 || length !== choice.name.length ||
        record.text.slice(position, position + length) !== choice.name) {
      return null;
    }
    return { version: 1, text: record.text, command: { position, length, choice } };
  } catch {
    return null;
  }
}
