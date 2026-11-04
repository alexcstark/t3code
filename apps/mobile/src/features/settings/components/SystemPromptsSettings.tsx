import { DEFAULT_SYSTEM_PROMPT_CONTENT, type SystemPrompt } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { uuidv4 } from "../../../lib/uuid";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function SystemPromptsSettings(props: {
  readonly prompts: readonly SystemPrompt[];
  readonly disabled: boolean;
  readonly onChange: (prompts: readonly SystemPrompt[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<SystemPrompt | null>(null);
  return (
    <SettingsSection title="System prompts">
      <View className="gap-3 px-4 py-3">
        <AppText className="text-sm text-foreground-muted">
          Choose a saved prompt before a new thread’s first message. Editing or deleting a prompt
          leaves existing threads unchanged. Select one environment to edit its library.
        </AppText>
        <Button
          label="New prompt"
          disabled={props.disabled}
          onPress={() =>
            setEditing({ id: uuidv4(), name: "", content: DEFAULT_SYSTEM_PROMPT_CONTENT })
          }
        />
      </View>
      {props.prompts.map((prompt) => (
        <SettingsRow
          key={prompt.id}
          label={prompt.name}
          icon="text.alignleft"
          disabled={props.disabled}
          onPress={() => setEditing(prompt)}
        />
      ))}
      {editing ? (
        <View className="gap-3 px-4 py-3">
          <AppText className="text-sm text-foreground-muted">
            Replaces T3’s default orchestration guidance. Provider, mode, and tool instructions
            still apply. Leave instructions empty to remove the default guidance.
          </AppText>
          <AppTextInput
            accessibilityLabel="Prompt name"
            placeholder="Prompt name"
            value={editing.name}
            onChangeText={(name) => setEditing({ ...editing, name })}
            editable={!props.disabled}
            className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
          />
          <AppTextInput
            accessibilityLabel="System prompt instructions"
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            value={editing.content}
            onChangeText={(content) => setEditing({ ...editing, content })}
            editable={!props.disabled}
            className="min-h-48 max-h-96 rounded-xl px-3 py-2 text-base text-foreground"
          />
          <Button
            label="Restore T3 default text"
            disabled={props.disabled}
            onPress={() => setEditing({ ...editing, content: DEFAULT_SYSTEM_PROMPT_CONTENT })}
          />
          <Button
            label="Save prompt"
            disabled={props.disabled || !editing.name.trim()}
            onPress={() => {
              const saved = { ...editing, name: editing.name.trim() };
              void props
                .onChange(
                  props.prompts.some((prompt) => prompt.id === saved.id)
                    ? props.prompts.map((prompt) => (prompt.id === saved.id ? saved : prompt))
                    : [...props.prompts, saved],
                )
                .then((saved) => {
                  if (saved) setEditing(null);
                });
            }}
          />
          {props.prompts.some((prompt) => prompt.id === editing.id) ? (
            <Button
              label="Delete prompt"
              tone="danger"
              disabled={props.disabled}
              onPress={() => {
                void props
                  .onChange(props.prompts.filter((prompt) => prompt.id !== editing.id))
                  .then((saved) => {
                    if (saved) setEditing(null);
                  });
              }}
            />
          ) : null}
          <Button label="Cancel" tone="text" onPress={() => setEditing(null)} />
        </View>
      ) : null}
    </SettingsSection>
  );
}
