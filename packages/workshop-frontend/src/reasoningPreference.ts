const EXPAND_REASONING_BY_DEFAULT_KEY = "expandReasoningByDefault";

export function getStoredReasoningExpandedByDefault(): boolean {
  return localStorage.getItem(EXPAND_REASONING_BY_DEFAULT_KEY) === "true";
}

export function persistReasoningExpandedByDefault(expanded: boolean): void {
  localStorage.setItem(
    EXPAND_REASONING_BY_DEFAULT_KEY,
    expanded ? "true" : "false",
  );
}
