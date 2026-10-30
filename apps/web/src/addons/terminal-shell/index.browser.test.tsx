import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { TerminalShellStatus } from ".";

describe("terminal shell addon", () => {
  it("ages the last update, resets on progress, and stops ticking when ready", async () => {
    await using screen = await render(
      <TerminalShellStatus
        activeTerminalCount={0}
        activityState="ready"
        canInterrupt={false}
        workingStepLabel={null}
      />,
    );
    using _timers = fakeTimers();
    vi.setSystemTime("2026-10-14T12:00:45.000Z");
    const initialTimerCount = vi.getTimerCount();
    await screen.rerender(
      <TerminalShellStatus
        activeTerminalCount={0}
        activityState="working"
        canInterrupt
        workingStepLabel="Checking tests"
        lastAgentUpdateAt="2026-10-14T12:00:00.000Z"
      />,
    );
    expect(screen.container.textContent).toContain("last update 45s ago");
    await act(() => vi.advanceTimersByTime(20000));
    expect(screen.container.textContent).toContain("last update 1m 5s ago");

    await screen.rerender(
      <TerminalShellStatus
        activeTerminalCount={0}
        activityState="working"
        canInterrupt
        workingStepLabel="Checking tests"
        lastAgentUpdateAt="2026-10-14T12:01:05.000Z"
      />,
    );
    expect(screen.container.textContent).toContain("last update 0s ago");
    await act(() => vi.advanceTimersByTime(3000));
    expect(screen.container.textContent).toContain("last update 3s ago");

    await screen.rerender(
      <TerminalShellStatus
        activeTerminalCount={0}
        activityState="ready"
        canInterrupt={false}
        workingStepLabel={null}
        lastAgentUpdateAt="2026-10-14T12:01:05.000Z"
      />,
    );
    expect(screen.container.textContent).toBe("Ready");
    expect(vi.getTimerCount()).toBe(initialTimerCount);
  });

  it("shows ready status without a stop hint", async () => {
    await using screen = await render(
      <TerminalShellStatus
        activeTerminalCount={0}
        activityState="ready"
        canInterrupt={false}
        workingStepLabel={null}
      />,
    );
    await expect.element(screen.getByText("Ready")).toBeVisible();
    await expect.element(screen.getByText("esc to interrupt")).not.toBeInTheDocument();
  });
  it("shows the current step, stop hint, and active terminal count", async () => {
    await using screen = await render(
      <TerminalShellStatus
        activeTerminalCount={2}
        activityState="working"
        canInterrupt
        workingStepLabel="Running command"
      />,
    );
    await expect.element(screen.getByText("Running command")).toBeVisible();
    await expect.element(screen.getByText("esc to interrupt")).toBeVisible();
    await expect.element(screen.getByText("2 terminals active")).toBeVisible();
  });
});
