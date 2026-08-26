import { useAtomValue } from "@effect/atom-react";
import type { ServerProviderRateLimits } from "@t3tools/contracts";

import { primaryServerProvidersAtom } from "../../state/server";

const CODEX_USAGE_WINDOWS = [
  { label: "5h", key: "primary" },
  { label: "7d", key: "secondary" },
] as const;

export interface CodexRemainingUsageWindow {
  readonly label: string;
  readonly remainingPercent: number;
}

export function resolveCodexRemainingUsage(
  rateLimits: ServerProviderRateLimits | undefined,
): readonly CodexRemainingUsageWindow[] {
  if (!rateLimits) return [];

  return CODEX_USAGE_WINDOWS.flatMap(({ label, key }) => {
    const window = rateLimits[key];
    if (!window) return [];

    return [
      {
        label,
        remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      },
    ];
  });
}

export function SidebarCodexUsage() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const codexProvider = providers.find((provider) => provider.driver === "codex");
  const windows = resolveCodexRemainingUsage(codexProvider?.rateLimits);

  if (windows.length === 0) return null;

  return (
    <div
      aria-label="Codex remaining usage"
      className="flex items-center justify-between gap-3 px-2.5 pb-2 text-[11px] tabular-nums"
    >
      <span className="text-sidebar-muted-foreground">Usage</span>
      <span className="flex items-center gap-2 text-sidebar-foreground">
        {windows.map((window) => (
          <span
            key={window.label}
            aria-label={`${window.label} ${window.remainingPercent}% remaining`}
          >
            {window.label} {window.remainingPercent}%
          </span>
        ))}
      </span>
    </div>
  );
}
