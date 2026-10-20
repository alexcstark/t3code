import { useAtomValue } from "@effect/atom-react";
import {
  providerCapacityActivityLabel,
  rankProviderCapacity,
} from "@t3tools/client-runtime/state/provider-capacity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import type { ProviderGroup } from "../../lib/modelOptions";
import { providerCapacityEnvironmentsAtom } from "../../state/providerCapacity";
import { ChoiceRow } from "./ThreadSettingsRows";

export function ProviderCapacitySection(props: {
  readonly environmentId: EnvironmentId;
  readonly currentThreadId?: ThreadId | null;
  readonly providerGroups: readonly ProviderGroup[];
  readonly onSelectProvider: (providerKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const environments = useAtomValue(providerCapacityEnvironmentsAtom);
  const capacity = useMemo(() => {
    const selectableIds = new Set(
      props.providerGroups
        .filter((group) => group.models.some((model) => !model.isUnavailable && !model.isHidden))
        .map((group) => group.providerKey),
    );
    return rankProviderCapacity({
      environmentId: props.environmentId,
      currentThreadId: props.currentThreadId ?? null,
      providers:
        environments
          .find((environment) => environment.environmentId === props.environmentId)
          ?.providers.filter(
            (provider) =>
              provider.enabled &&
              provider.status === "ready" &&
              selectableIds.has(provider.instanceId),
          ) ?? [],
      environments,
      now,
    });
  }, [environments, now, props.environmentId, props.currentThreadId, props.providerGroups]);
  if (capacity.length === 0) return null;

  return (
    <View className="mx-4 mb-2">
      <MaterialButton
        label={open ? "Hide provider capacity" : "Provider capacity"}
        tone="text"
        onPress={() => {
          setNow(Date.now());
          setOpen((value) => !value);
        }}
      />
      {open ? (
        <>
          <Text className="mb-2 px-4 text-xs text-foreground-muted">
            Most remaining first · activity across your T3 environments
          </Text>
          <View className="overflow-hidden rounded-2xl bg-grouped-card">
            {capacity.map((item, index) => (
              <ChoiceRow
                key={item.provider.instanceId}
                label={
                  props.providerGroups.find(
                    (group) => group.providerKey === item.provider.instanceId,
                  )?.providerLabel ?? String(item.provider.instanceId)
                }
                description={`${item.usageStatus} · ${providerCapacityActivityLabel(item)}`}
                selected={false}
                isLast={index === capacity.length - 1}
                onPress={() => {
                  props.onSelectProvider(item.provider.instanceId);
                  setOpen(false);
                }}
              />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}
