import { useNavigation } from "@react-navigation/native";
import { DEFAULT_SYSTEM_PROMPT_CONTENT, type SystemPrompt } from "@t3tools/contracts";
import { useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/ui/Button";

import { AppText } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";

export function ThreadSystemPromptPicker(props: {
  readonly selected: SystemPrompt | null;
  readonly prompts: readonly SystemPrompt[];
  readonly disabled: boolean;
  readonly onChange?: (prompt: SystemPrompt | null) => void;
}) {
  const navigation = useNavigation();
  const [viewing, setViewing] = useState(false);
  const insets = useSafeAreaInsets();
  const prompts =
    props.selected && !props.prompts.some((prompt) => prompt.id === props.selected?.id)
      ? [...props.prompts, props.selected]
      : props.prompts;
  return (
    <>
      <Menu
        accessibilityLabel="System prompt"
        title="System prompt"
        actions={[
          ...(props.onChange
            ? [
                {
                  id: "default",
                  title: "T3 default",
                  state: props.selected === null ? ("on" as const) : ("off" as const),
                  attributes: { disabled: props.disabled },
                },
                ...prompts.map((prompt) => ({
                  id: prompt.id,
                  title: prompt.name,
                  state: prompt.id === props.selected?.id ? ("on" as const) : ("off" as const),
                  attributes: { disabled: props.disabled },
                })),
              ]
            : []),
          { id: "view", title: "View prompt" },
          ...(props.onChange ? [{ id: "manage", title: "Manage prompts" }] : []),
        ]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "view") {
            setViewing(true);
          } else if (nativeEvent.event === "manage") {
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironmentNewThreads" },
            });
          } else if (!props.disabled && props.onChange) {
            if (nativeEvent.event === "default") props.onChange(null);
            else {
              const prompt = prompts.find((entry) => entry.id === nativeEvent.event);
              if (prompt) props.onChange(prompt);
            }
          }
        }}
      >
        <View className="min-h-10 justify-center px-3 py-2">
          <AppText numberOfLines={1} className="text-sm text-foreground-muted">
            System prompt: {props.selected?.name ?? "T3 default"}
          </AppText>
        </View>
      </Menu>
      <Modal
        visible={viewing}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setViewing(false)}
      >
        <View
          className="flex-1 bg-sheet-solid"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        >
          <View className="flex-row items-center justify-between px-4 py-3">
            <AppText className="flex-1 text-lg text-foreground">
              {props.selected?.name ?? "T3 default"}
            </AppText>
            <Button label="Done" tone="text" onPress={() => setViewing(false)} />
          </View>
          <ScrollView contentContainerClassName="px-4 pb-6">
            <AppText selectable className="text-sm text-foreground">
              {props.selected?.content ?? DEFAULT_SYSTEM_PROMPT_CONTENT}
            </AppText>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
