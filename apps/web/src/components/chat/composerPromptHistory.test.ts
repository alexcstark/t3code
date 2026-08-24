import { describe, expect, it } from "vite-plus/test";

import {
  createComposerPromptHistoryState,
  moveComposerPromptHistory,
  recordComposerPrompt,
} from "./composerPromptHistory";

describe("composer prompt history", () => {
  it("cycles older and newer prompts and restores the current draft", () => {
    let history = createComposerPromptHistoryState(["first", "second"]);

    let moved = moveComposerPromptHistory(history, "up", "draft");
    expect(moved?.value).toBe("second");
    history = moved?.state ?? history;

    moved = moveComposerPromptHistory(history, "up", "second");
    expect(moved?.value).toBe("first");
    history = moved?.state ?? history;

    moved = moveComposerPromptHistory(history, "down", "first");
    expect(moved?.value).toBe("second");
    history = moved?.state ?? history;

    moved = moveComposerPromptHistory(history, "down", "second");
    expect(moved?.value).toBe("draft");
    expect(moved?.state.index).toBeNull();
  });

  it("keeps the oldest prompt selected when moving up past the beginning", () => {
    const history = createComposerPromptHistoryState(["first"]);
    const moved = moveComposerPromptHistory(
      moveComposerPromptHistory(history, "up", "draft")?.state ?? history,
      "up",
      "first",
    );

    expect(moved?.value).toBe("first");
    expect(moved?.state.index).toBe(0);
  });

  it("does not add empty prompts", () => {
    let history = createComposerPromptHistoryState();
    history = recordComposerPrompt(history, "  ");
    expect(history.entries).toEqual([]);

    history = recordComposerPrompt(history, "first");
    history = recordComposerPrompt(history, "second");
    expect(history.entries).toEqual(["first", "second"]);
  });
});
