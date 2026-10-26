import { render } from "../../../test/render";
import { EnvironmentId, DEFAULT_UNIFIED_SETTINGS, type SystemPrompt } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../../index.css";

const state = vi.hoisted(() => ({
  environmentId: "environment-a",
  prompts: [] as readonly SystemPrompt[],
  save: vi.fn(),
}));

vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock(import("../../lib/utils"), async (original) => ({
  ...(await original()),
  randomUUID: () => "new-prompt",
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    connectedEnvironments: [
      {
        environmentId: EnvironmentId.make(state.environmentId),
        serverConfig: { environment: { capabilities: { systemPrompts: true } } },
      },
    ],
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (selector: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector({ ...DEFAULT_UNIFIED_SETTINGS, systemPrompts: state.prompts }),
  useScopedSettingsWriteAllowed: () => true,
}));
// Rows read live environment grants; this suite exercises the editor and persistence outcomes.
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));

import { SystemPromptsSettings } from "./SystemPromptsSettings";

function setup() {
  state.environmentId = "environment-a";
  state.prompts = [{ id: "review", name: "Review", content: "Review only." }];
  state.save.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return render(<SystemPromptsSettings />);
}

it("saves an empty prompt alongside existing presets, then deletes a preset", async () => {
  await using _screen = await setup();
  await userEvent.click(page.getByRole("button", { name: "New prompt" }));
  await userEvent.fill(page.getByRole("textbox", { name: "Prompt name" }), "Empty");
  await userEvent.fill(page.getByRole("textbox", { name: "System prompt instructions" }), "");
  await userEvent.click(page.getByRole("button", { name: "Save prompt" }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.save).toHaveBeenLastCalledWith({
    environmentId: "environment-a",
    input: {
      patch: {
        systemPrompts: [...state.prompts, { id: "new-prompt", name: "Empty", content: "" }],
      },
    },
  });
  await userEvent.click(page.getByRole("button", { name: "Delete", exact: true }));
  await expect.poll(() => state.save.mock.calls.length).toBe(2);
  expect(state.save).toHaveBeenLastCalledWith({
    environmentId: "environment-a",
    input: { patch: { systemPrompts: [] } },
  });
});

it("keeps unsaved edits when saving fails", async () => {
  await using _screen = await setup();
  state.save.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Disconnected"))));
  await userEvent.click(page.getByRole("button", { name: "Edit", exact: true }));
  await userEvent.fill(
    page.getByRole("textbox", { name: "System prompt instructions" }),
    "Keep my edits.",
  );
  await userEvent.click(page.getByRole("button", { name: "Save prompt" }));
  await expect
    .element(page.getByRole("textbox", { name: "System prompt instructions" }))
    .toHaveValue("Keep my edits.");
});

it("discards an open editor when the selected environment changes", async () => {
  await using screen = await setup();
  await userEvent.click(page.getByRole("button", { name: "Edit", exact: true }));
  state.environmentId = "environment-b";
  await screen.rerender(<SystemPromptsSettings />);
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.save).not.toHaveBeenCalled();
});
