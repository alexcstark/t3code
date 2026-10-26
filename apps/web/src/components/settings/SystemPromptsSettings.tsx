import { DEFAULT_SYSTEM_PROMPT_CONTENT, type SystemPrompt } from "@t3tools/contracts";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useScopedSettingsWriteAllowed } from "./useScopedSettings";

export function SystemPromptsSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  return (
    <SystemPromptsLibrary
      key={`${scope.kind}:${connectedEnvironments.map((environment) => environment.environmentId).join(",")}`}
    />
  );
}

function SystemPromptsLibrary() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const prompts = useScopedSettings((settings) => settings.systemPrompts);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "save system prompts");
  const [saving, setSaving] = useState(false);
  const writable = useScopedSettingsWriteAllowed();
  const [editing, setEditing] = useState<SystemPrompt | null>(null);
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.capabilities.systemPrompts === true,
    );
  const canEdit =
    !saving &&
    supported &&
    writable &&
    connectedEnvironments.length === 1 &&
    (scope.kind === "all" || scope.kind === "environment");

  const save = async (systemPrompts: readonly SystemPrompt[]) => {
    const environment = connectedEnvironments[0];
    if (!canEdit || !environment) return;
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId: environment.environmentId,
        input: { patch: { systemPrompts } },
      });
      if (AsyncResult.isSuccess(result)) setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection id="system-prompts" title="System prompts">
      <SettingsRow
        serverScoped
        settingKeys={["systemPrompts"]}
        title="Saved prompts"
        description={
          !supported
            ? "Update this environment’s server to manage system prompts."
            : connectedEnvironments.length > 1
              ? "Select one environment to manage its prompts."
              : "Choose a prompt before sending a new thread’s first message. Editing a saved prompt affects future threads."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() =>
              setEditing({
                id: randomUUID(),
                name: "",
                content: DEFAULT_SYSTEM_PROMPT_CONTENT,
              })
            }
          >
            New prompt
          </Button>
        }
      />
      {prompts.map((prompt) => (
        <SettingsRow
          key={prompt.id}
          serverScoped
          settingKeys={["systemPrompts"]}
          title={prompt.name}
          control={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit}
                onClick={() => setEditing(prompt)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canEdit}
                onClick={() => void save(prompts.filter((entry) => entry.id !== prompt.id))}
              >
                Delete
              </Button>
            </div>
          }
        />
      ))}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Edit system prompt</DialogTitle>
            <DialogDescription>
              Replaces T3’s default orchestration guidance. Provider instructions, mode
              instructions, and tool guidance still apply. An empty prompt removes the default
              guidance.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <DialogPanel>
              <label className="grid gap-2 text-sm">
                Name
                <Input
                  aria-label="Prompt name"
                  disabled={saving}
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                />
              </label>
              <label className="grid gap-2 text-sm">
                Instructions
                <Textarea
                  aria-label="System prompt instructions"
                  disabled={saving}
                  value={editing.content}
                  rows={12}
                  spellCheck={false}
                  onChange={(event) => setEditing({ ...editing, content: event.target.value })}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => setEditing({ ...editing, content: DEFAULT_SYSTEM_PROMPT_CONTENT })}
              >
                Restore T3 default text
              </Button>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" disabled={saving} onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={!canEdit || !editing?.name.trim()}
              onClick={() => {
                if (!editing || !canEdit || !editing.name.trim()) return;
                const saved = { ...editing, name: editing.name.trim() };
                void save(
                  prompts.some((prompt) => prompt.id === saved.id)
                    ? prompts.map((prompt) => (prompt.id === saved.id ? saved : prompt))
                    : [...prompts, saved],
                );
              }}
            >
              Save prompt
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
