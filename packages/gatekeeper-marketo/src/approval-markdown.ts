/** Escape arbitrary text for literal display in an approval's Markdown description. */
export function markdownText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}

/** Render arbitrary text as an inline Markdown code span without changing its contents. */
export function markdownCode(value: string): string {
  let longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  let delimiter = "`".repeat(longestRun + 1);
  let padding = (/^`|`$|^ | $/.test(value) && !/^ +$/.test(value)) ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

/** Render text as an indented Markdown code block, where HTML and Markdown stay literal. */
export function markdownCodeBlock(value: string): string {
  return value.split("\n").map(line => `    ${line}`).join("\n");
}

/** Render an arbitrary JSON-compatible value as a safe, complete Markdown code block. */
export function markdownJsonCodeBlock(value: unknown): string {
  let serialized = value === undefined ? "(none)" : JSON.stringify(value, null, 2);
  return markdownCodeBlock(serialized ?? String(value));
}
