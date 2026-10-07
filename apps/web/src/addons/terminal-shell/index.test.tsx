import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TerminalShellStatus, terminalShellRootProps } from ".";

describe("terminal shell addon", () => {
  it("exposes a stable host hook for its scoped styles", () => {
    expect(terminalShellRootProps["data-terminal-shell"]).toBe("true");
    expect(terminalShellRootProps.className).toContain("terminal-shell");
  });

  it("renders ready status without working-only controls", () => {
    const markup = renderToStaticMarkup(
      <TerminalShellStatus activeTerminalCount={0} isWorking={false} workingStepLabel={null} />,
    );

    expect(markup).toContain("Ready");
    expect(markup).not.toContain("esc to interrupt");
    expect(markup).not.toContain("terminal active");
  });

  it("renders working status and pluralizes active terminals", () => {
    const markup = renderToStaticMarkup(
      <TerminalShellStatus activeTerminalCount={2} isWorking workingStepLabel="Running command" />,
    );

    expect(markup).toContain('data-terminal-shell-status-state="working"');
    expect(markup).toContain("Running command");
    expect(markup).toContain("esc to interrupt");
    expect(markup).toContain("2 terminals active");
  });
});
