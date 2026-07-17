import type {SlashCommandChoice} from "@gadgets/workshop-shared/api";

export type ParsedSlashCommandInput = {
  // Text between `/` and the first whitespace, lowercased for matching.
  query: string;
  // Index just after the command token.
  tokenEnd: number;
  // Index where the trailing message begins (after whitespace).
  tailStart: number;
  // Trailing message text.
  tail: string;
};

// Parses a leading `/command` from composer input. `//` is treated as a literal leading slash, not
// a command.
export function parseSlashCommandInput(input: string): ParsedSlashCommandInput | null {
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  let tokenEnd = 1;
  while (tokenEnd < input.length && !/\s/.test(input[tokenEnd])) {
    tokenEnd++;
  }
  let query = input.slice(1, tokenEnd).toLowerCase();
  let tailStart = tokenEnd;
  while (tailStart < input.length && /\s/.test(input[tailStart])) tailStart++;
  return {
    query,
    tokenEnd,
    tailStart,
    tail: input.slice(tailStart),
  };
}

// Entries whose name exactly equals the parsed token.
export function exactSlashCommandMatches(
    commands: SlashCommandChoice[], parsed: ParsedSlashCommandInput): SlashCommandChoice[] {
  return commands.filter(command => command.name.toLowerCase() === parsed.query);
}

// Filters a loaded catalog for display in the picker.
export function filterSlashCommandCatalog(
    catalog: SlashCommandChoice[], query: string): SlashCommandChoice[] {
  query = query.toLowerCase();
  let matches = catalog.filter(choice => !query ||
    choice.name.toLowerCase().includes(query) ||
    choice.description.toLowerCase().includes(query) ||
    choice.providerLabel.toLowerCase().includes(query) ||
    choice.resourceLabel?.toLowerCase().includes(query));
  return matches;
}
