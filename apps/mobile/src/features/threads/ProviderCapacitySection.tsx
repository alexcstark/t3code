import { useAtomValue } from "@effect/atom-react";
import {
  providerCapacityActivityLabel,
  rankProviderCapacity,
  scheduleProviderCapacityExpiry,
  type ProviderCapacity,
} from "@t3tools/client-runtime/state/provider-capacity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useReducer } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { ProviderGroup } from "../../lib/modelOptions";
import { providerCapacityEnvironmentsAtom } from "../../state/providerCapacity";
import { ChoiceRow } from "./ThreadSettingsRows";

const NO_CAPACITY: readonly ProviderCapacity[] = [];

/** Ranks the environment's ready providers that still offer a selectable model. */
export function useProviderCapacity(input: {
  readonly environmentId: EnvironmentId | null;
  readonly currentThreadId?: ThreadId | null;
  readonly providerGroups: readonly ProviderGroup[];
}): readonly ProviderCapacity[] {
  const [capacityNow, refreshCapacityNow] = useReducer(
    (_previous: number) => Date.now(),
    undefined,
    Date.now,
  );
  const environments = useAtomValue(providerCapacityEnvironmentsAtom);
  const selectableIds = new Set(
    input.providerGroups
      .filter((group) => group.models.some((model) => !model.isUnavailable && !model.isHidden))
      .map((group) => group.providerKey),
  );
  const capacity =
    input.environmentId === null
      ? NO_CAPACITY
      : rankProviderCapacity({
          environmentId: input.environmentId,
          currentThreadId: input.currentThreadId ?? null,
          providers:
            environments
              .find((environment) => environment.environmentId === input.environmentId)
              ?.providers.filter(
                (provider) =>
                  provider.enabled &&
                  provider.status === "ready" &&
                  selectableIds.has(provider.instanceId),
              ) ?? [],
          environments,
          now: capacityNow,
        });
  useEffect(() => scheduleProviderCapacityExpiry(capacity, refreshCapacityNow), [capacity]);
  return capacity;
}

/** The thread settings opening view; selecting a provider narrows the catalog to its models. */
export function ProviderCapacitySection(props: {
  readonly capacity: readonly ProviderCapacity[];
  readonly providerGroups: readonly ProviderGroup[];
  readonly onSelectProvider: (providerKey: string) => void;
}) {
  return (
    <View className="mx-4 mb-2">
      <Text className="px-1 pb-1 pt-2 text-sm font-t3-medium text-foreground-muted">
        Provider capacity
      </Text>
      <Text className="mb-2 px-1 text-xs text-foreground-muted">
        Most remaining first · activity across your T3 environments
      </Text>
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {props.capacity.map((item, index) => (
          <ChoiceRow
            key={item.provider.instanceId}
            label={
              props.providerGroups.find((group) => group.providerKey === item.provider.instanceId)
                ?.providerLabel ?? String(item.provider.instanceId)
            }
            description={`${item.usageStatus} · ${providerCapacityActivityLabel(item)}`}
            selected={false}
            isLast={index === props.capacity.length - 1}
            onPress={() => props.onSelectProvider(item.provider.instanceId)}
          />
        ))}
      </View>
    </View>
  );
}
