import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { TerminalShellStatus } from ".";

describe("terminal shell addon", () => {
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
