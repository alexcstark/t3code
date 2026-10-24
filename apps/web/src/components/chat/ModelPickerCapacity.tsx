import { useAtomValue } from "@effect/atom-react";
import {
  providerCapacityActivityLabel,
  rankProviderCapacity,
  scheduleProviderCapacityExpiry,
} from "@t3tools/client-runtime/state/provider-capacity";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useReducer } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { providerCapacityEnvironmentsAtom } from "../../state/providerCapacity";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** The picker's opening pane. Capacity is per provider account; selecting one opens its models. */
export function ModelPickerCapacity(props: {
  readonly environmentId: EnvironmentId;
  readonly currentThreadId?: ThreadId | null;
  readonly entries: readonly ProviderInstanceEntry[];
  readonly onSelectInstance: (instanceId: ProviderInstanceId) => void;
}) {
  const [capacityNow, refreshCapacityNow] = useReducer(
    (_previous: number) => Date.now(),
    undefined,
    Date.now,
  );
  const environments = useAtomValue(providerCapacityEnvironmentsAtom);
  const capacity = rankProviderCapacity({
    environmentId: props.environmentId,
    currentThreadId: props.currentThreadId ?? null,
    providers: props.entries.map((entry) => entry.snapshot),
    environments,
    now: capacityNow,
  });
  useEffect(() => scheduleProviderCapacityExpiry(capacity, refreshCapacityNow), [capacity]);
  if (capacity.length === 0) return null;

  return (
    <div className="min-h-0 overflow-y-auto overscroll-contain p-1">
      <div className="flex items-center gap-2 px-2 pt-1 text-xs font-medium">
        <GaugeIcon className="size-3.5" aria-hidden="true" />
        Provider capacity
      </div>
      <p className="px-2 pb-1 text-3xs text-muted-foreground">
        Most remaining first · activity across your T3 environments
      </p>
      {capacity.map((item) => {
        const displayName =
          props.entries.find((entry) => entry.instanceId === item.provider.instanceId)
            ?.displayName ?? String(item.provider.instanceId);
        return (
          <Tooltip key={item.provider.instanceId}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="default"
                  className="w-full"
                  onClick={() => props.onSelectInstance(item.provider.instanceId)}
                />
              }
            >
              <ProviderInstanceIcon
                driverKind={item.provider.driver}
                displayName={displayName}
                accentColor={item.provider.accentColor}
                acpRegistryIconUrl={item.provider.iconUrl}
                className="size-4"
                iconClassName="size-4"
              />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-xs">{displayName}</span>
                <span className="block text-3xs font-normal text-muted-foreground">
                  {providerCapacityActivityLabel(item)}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums">
                {item.remainingPercent === null ? "Unknown" : `${item.remainingPercent}% left`}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="left">
              {item.usageStatus}. {providerCapacityActivityLabel(item)}.
              {item.provider.usageLimits
                ? ` Last checked ${new Date(item.provider.usageLimits.checkedAt).toLocaleString()}.`
                : ""}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
