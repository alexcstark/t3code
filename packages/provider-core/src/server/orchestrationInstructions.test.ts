import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it.each([true, false])(
    "replaces orchestration guidance with a saved prompt, MCP=%s",
    (hasT3Mcp) => {
      const systemPrompt = "Use the team's review checklist.";
      assert.equal(t3OrchestrationSystemPrompt(hasT3Mcp, false, systemPrompt), systemPrompt);
      assert.equal(t3OrchestrationSystemPrompt(hasT3Mcp, false, ""), "");
      const injected = t3OrchestrationPrompt({
        prompt: "Review this change.",
        hasT3Mcp,
        hasDeviceTools: false,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
        systemPrompt,
      });
      assert.include(injected, systemPrompt);
      assert.notInclude(injected, "Use `delegate_task`");
      assert.equal(
        t3OrchestrationPrompt({
          prompt: "Continue.",
          hasT3Mcp,
          hasDeviceTools: false,
          orchestrationDelivered: true,
          deviceInstructionsDelivered: false,
          systemPrompt,
        }),
        "Continue.",
      );
    },
  );

  it("keeps ACP mode and browser instructions when replacing the orchestration prompt", () => {
    const previousState = {
      interactionMode: "plan" as const,
      hasT3Mcp: true,
      hasDeviceTools: false,
      systemPrompt: "",
    };
    const disabled = t3AcpPromptWithInstructions({ prompt: "Review.", state: previousState });
    assert.include(disabled, "T3 Code interaction mode: Plan");
    assert.include(disabled, "T3 Code collaborative browser");
    assert.notInclude(disabled, "Use `delegate_task`");

    const changed = t3AcpPromptWithInstructions({
      prompt: "Review.",
      state: { ...previousState, systemPrompt: "Use the review checklist." },
      previousState,
    });
    assert.include(changed, "Use the review checklist.");
    assert.notInclude(changed, "Use `delegate_task`");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});
