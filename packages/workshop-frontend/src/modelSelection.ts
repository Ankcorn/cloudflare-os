import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

// Sentinel used for UI values and localStorage so an explicit null choice can persist.
export const ADD_NEW_MODEL_OPTION_VALUE = "__gadgets_add_new_model__";
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or if there are none, return "add new model", to
  // encourage the user to add one.
  return models[0]?.id ?? ADD_NEW_MODEL_OPTION_VALUE;
}

export function persistSelectedModel(modelId: string | null): void {
  if (modelId === ADD_NEW_MODEL_OPTION_VALUE) {
    // If the user selected "add new model", don't store this. Hopefully, they will go configure
    // a model, and when they come back, we want to default to their first real model.
    localStorage.removeItem(LAST_SELECTED_MODEL_KEY);
    return;
  }

  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}

export function isAddNewModelSelection(modelId: string | null): boolean {
  return modelId === ADD_NEW_MODEL_OPTION_VALUE;
}
