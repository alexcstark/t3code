// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { TerminalShellStatus, terminalShellRootProps } from ".";

describe("terminal shell addon", () => {
  it("ages the last agent update live, resets on progress, and stops when ready", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-14T12:00:45.000Z");
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <TerminalShellStatus
            activeTerminalCount={0}
            activityState="working"
            canInterrupt
            workingStepLabel="Checking tests"
            lastAgentUpdateAt="2026-10-14T12:00:00.000Z"
          />,
        ),
      );
      expect(container.textContent).toContain("last update 45s ago");
      act(() => vi.advanceTimersByTime(20_000));
      expect(container.textContent).toContain("last update 1m 5s ago");

      act(() =>
        root.render(
          <TerminalShellStatus
            activeTerminalCount={0}
            activityState="working"
            canInterrupt
            workingStepLabel="Checking tests"
            lastAgentUpdateAt="2026-10-14T12:01:05.000Z"
          />,
        ),
      );
      expect(container.textContent).toContain("last update 0s ago");
      act(() => vi.advanceTimersByTime(3_000));
      expect(container.textContent).toContain("last update 3s ago");

      act(() =>
        root.render(
          <TerminalShellStatus
            activeTerminalCount={0}
            activityState="ready"
            canInterrupt={false}
            workingStepLabel={null}
            lastAgentUpdateAt="2026-10-14T12:01:05.000Z"
          />,
        ),
      );
      expect(container.textContent).toBe("Ready");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("exposes a stable host hook for its scoped styles", () => {
    expect(terminalShellRootProps["data-terminal-shell"]).toBe("true");
    expect(terminalShellRootProps.className).toContain("terminal-shell");
  });

  it("renders ready status without working-only controls", () => {
    const markup = renderToStaticMarkup(
      <TerminalShellStatus
        activeTerminalCount={0}
        activityState="ready"
        canInterrupt={false}
        workingStepLabel={null}
      />,
    );

    expect(markup).toContain("Ready");
    expect(markup).not.toContain("esc to interrupt");
    expect(markup).not.toContain("terminal active");
  });

  it("renders working status and pluralizes active terminals", () => {
    const markup = renderToStaticMarkup(
      <TerminalShellStatus
        activeTerminalCount={2}
        activityState="working"
        canInterrupt
        workingStepLabel="Running command"
      />,
    );

    expect(markup).toContain('data-terminal-shell-status-state="working"');
    expect(markup).toContain("Running command");
    expect(markup).toContain("esc to interrupt");
    expect(markup).toContain("2 terminals active");
  });
});
