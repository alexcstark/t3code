import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { remainingPercent, usageAccountKeyResolver } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { EnvironmentShellState } from "./shell.ts";

type CapacityThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "providerInstanceId" | "status" | "activityRunStatus"
>;

export interface ProviderCapacityEnvironment {
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  /** Only a live shell can establish that an account is idle. */
  readonly threads: readonly CapacityThread[] | null;
}

export interface ProviderCapacity {
  readonly provider: ServerProvider;
  readonly remainingPercent: number | null;
  readonly limitingWindow: string | null;
  readonly usageStatus: string;
  readonly activeThreadCount: number;
  readonly activityKnown: boolean;
}

/** Reads existing config and shell streams; never probes providers or loads thread histories. */
export function createProviderCapacityEnvironmentsAtom(input: {
  readonly presentationsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  return Atom.make((get): readonly ProviderCapacityEnvironment[] =>
    [...get(input.presentationsAtom)].map(([environmentId, presentation]) => {
      const shell =
        presentation.connection.phase === "connected"
          ? get(input.shellStateValueAtom(environmentId))
          : null;
      return {
        environmentId,
        providers: presentation.serverConfig?.providers ?? [],
        threads:
          shell?.status === "live" && Option.isNone(shell.error)
            ? (Option.getOrNull(shell.snapshot)?.threads ?? null)
            : null,
      };
    }),
  );
}

/** Ranks quota headroom conservatively using the least remaining reported window. */
export function rankProviderCapacity(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  readonly environments: readonly ProviderCapacityEnvironment[];
  readonly currentThreadId?: ThreadId | null;
  readonly now: number;
}): readonly ProviderCapacity[] {
  const accountKey = usageAccountKeyResolver(
    [...input.providers, ...input.environments.flatMap((environment) => environment.providers)]
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        ...provider.auth,
        driver: provider.driver,
        usageLimits: provider.usageLimits,
      })),
  );
  const keyFor = (provider: ServerProvider) =>
    accountKey({ ...provider.auth, driver: provider.driver, usageLimits: provider.usageLimits });

  return input.providers
    .map((provider): ProviderCapacity => {
      const key = keyFor(provider);
      let activeThreadCount = 0;
      let activityKnown = false;
      let missingActivity = false;
      for (const environment of input.environments) {
        const matchingIds = new Set(
          environment.providers
            .filter(
              (candidate) =>
                (environment.environmentId === input.environmentId &&
                  candidate.instanceId === provider.instanceId) ||
                (key !== null && keyFor(candidate) === key),
            )
            .map((candidate) => candidate.instanceId),
        );
        if (matchingIds.size === 0) continue;
        if (environment.threads === null) {
          missingActivity = true;
          continue;
        }
        activityKnown = true;
        for (const thread of environment.threads) {
          if (
            !matchingIds.has(thread.providerInstanceId) ||
            (environment.environmentId === input.environmentId &&
              thread.id === input.currentThreadId)
          )
            continue;
          const status = thread.activityRunStatus ?? thread.status;
          if (
            status === "preparing" ||
            status === "starting" ||
            status === "running" ||
            status === "waiting"
          )
            activeThreadCount += 1;
        }
      }
      const limits = provider.usageLimits;
      const expired = limits?.windows.some(
        (window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= input.now,
      );
      const limiting =
        limits && !limits.unavailable && !expired
          ? [...limits.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]
          : undefined;
      return {
        provider,
        remainingPercent: limiting ? remainingPercent(limiting) : null,
        limitingWindow: limiting?.label ?? null,
        usageStatus: limiting
          ? `${remainingPercent(limiting)}% left · ${limiting.label}`
          : expired
            ? "Usage needs refresh"
            : limits?.unavailable?.reason === "probeFailed"
              ? "Usage unavailable"
              : "Usage not reported",
        activeThreadCount,
        activityKnown: activityKnown && !missingActivity,
      };
    })
    .sort(
      (a, b) =>
        (b.remainingPercent ?? -1) - (a.remainingPercent ?? -1) ||
        a.activeThreadCount - b.activeThreadCount,
    );
}

export function providerCapacityActivityLabel(capacity: ProviderCapacity): string {
  if (capacity.activeThreadCount > 0) {
    return `${capacity.activeThreadCount}${capacity.activityKnown ? "" : "+"} running elsewhere`;
  }
  return capacity.activityKnown ? "Idle in T3" : "Activity unknown";
}
