import { useAtomValue } from "@effect/atom-react";
import {
  providerCapacityActivityLabel,
  rankProviderCapacity,
} from "@t3tools/client-runtime/state/provider-capacity";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, GaugeIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { providerCapacityEnvironmentsAtom } from "../../state/providerCapacity";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** Capacity is per provider account; selecting one opens its existing model list. */
export function ModelPickerCapacity(props: {
  readonly environmentId: EnvironmentId;
  readonly currentThreadId?: ThreadId | null;
  readonly entries: readonly ProviderInstanceEntry[];
  readonly onSelectInstance: (instanceId: ProviderInstanceId) => void;
}) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(Date.now);
  const environments = useAtomValue(providerCapacityEnvironmentsAtom);
  const capacity = useMemo(
    () =>
      rankProviderCapacity({
        environmentId: props.environmentId,
        currentThreadId: props.currentThreadId ?? null,
        providers: props.entries.map((entry) => entry.snapshot),
        environments,
        now,
      }),
    [environments, now, props.environmentId, props.currentThreadId, props.entries],
  );
  if (capacity.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border/70">
      <Collapsible
        open={open}
        onOpenChange={(value) => {
          setNow(Date.now());
          setOpen(value);
        }}
      >
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="w-full" />}>
          <GaugeIcon aria-hidden="true" />
          <span className="flex-1 text-left">Provider capacity</span>
          <ChevronDownIcon className={open ? "size-3 rotate-180" : "size-3"} aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <p className="px-3 pb-1 text-3xs text-muted-foreground">
            Most remaining first · activity across your T3 environments
          </p>
          <div className="max-h-32 overflow-y-auto overscroll-contain px-1 pb-1">
            {capacity.map((item) => (
              <Tooltip key={item.provider.instanceId}>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="default"
                      className="w-full"
                      onClick={() => {
                        props.onSelectInstance(item.provider.instanceId);
                        setOpen(false);
                      }}
                    />
                  }
                >
                  <ProviderInstanceIcon
                    driverKind={item.provider.driver}
                    displayName={
                      props.entries.find((entry) => entry.instanceId === item.provider.instanceId)
                        ?.displayName ?? String(item.provider.instanceId)
                    }
                    accentColor={item.provider.accentColor}
                    acpRegistryIconUrl={item.provider.iconUrl}
                    className="size-4"
                    iconClassName="size-4"
                  />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs">
                      {props.entries.find((entry) => entry.instanceId === item.provider.instanceId)
                        ?.displayName ?? item.provider.instanceId}
                    </span>
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
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
