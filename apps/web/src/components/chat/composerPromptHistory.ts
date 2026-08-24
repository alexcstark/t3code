export const COMPOSER_PROMPT_HISTORY_LIMIT = 50;

export type ComposerPromptHistoryState = {
  entries: string[];
  index: number | null;
  draft: string | null;
};

export type ComposerPromptHistoryDirection = "up" | "down";

export function createComposerPromptHistoryState(
  entries: ReadonlyArray<string> = [],
): ComposerPromptHistoryState {
  return {
    entries: entries
      .filter((entry) => entry.trim().length > 0)
      .slice(-COMPOSER_PROMPT_HISTORY_LIMIT),
    index: null,
    draft: null,
  };
}

export function resetComposerPromptHistoryNavigation(
  state: ComposerPromptHistoryState,
): ComposerPromptHistoryState {
  if (state.index === null && state.draft === null) return state;
  return { ...state, index: null, draft: null };
}

export function recordComposerPrompt(
  state: ComposerPromptHistoryState,
  prompt: string,
): ComposerPromptHistoryState {
  if (prompt.trim().length === 0) return resetComposerPromptHistoryNavigation(state);
  return {
    entries: [...state.entries, prompt].slice(-COMPOSER_PROMPT_HISTORY_LIMIT),
    index: null,
    draft: null,
  };
}

export function moveComposerPromptHistory(
  state: ComposerPromptHistoryState,
  direction: ComposerPromptHistoryDirection,
  currentValue: string,
): { value: string; state: ComposerPromptHistoryState } | null {
  if (state.entries.length === 0) return null;

  if (direction === "up") {
    const nextIndex =
      state.index === null ? state.entries.length - 1 : Math.max(0, state.index - 1);
    const nextValue = state.entries[nextIndex];
    if (nextValue === undefined) return null;
    return {
      value: nextValue,
      state: {
        entries: state.entries,
        index: nextIndex,
        draft: state.index === null ? currentValue : state.draft,
      },
    };
  }

  if (state.index === null) return null;
  if (state.index < state.entries.length - 1) {
    const nextIndex = state.index + 1;
    return {
      value: state.entries[nextIndex] ?? "",
      state: { ...state, index: nextIndex },
    };
  }

  return {
    value: state.draft ?? "",
    state: { ...state, index: null, draft: null },
  };
}
