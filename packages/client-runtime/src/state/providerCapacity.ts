import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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

function capacityAccountKey(provider: ServerProvider): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  if (email) return `${provider.driver}:${email}`;
  const fingerprint = provider.usageLimits?.credentialFingerprint;
  return fingerprint ? `${provider.driver}:credential:${fingerprint}` : null;
}

/** Ranks quota headroom conservatively using the least remaining reported window. */
export function rankProviderCapacity(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  readonly environments: readonly ProviderCapacityEnvironment[];
  readonly currentThreadId?: ThreadId | null;
  readonly now: number;
}): readonly ProviderCapacity[] {
  return input.providers
    .map((provider): ProviderCapacity => {
      const key = capacityAccountKey(provider);
      let activeThreadCount = 0;
      let activityKnown = false;
      let missingActivity = false;
      for (const environment of input.environments) {
        const matchingIds = new Set<ServerProvider["instanceId"]>();
        const ambiguousIds = new Set<ServerProvider["instanceId"]>();
        for (const candidate of environment.providers) {
          if (
            environment.environmentId === input.environmentId &&
            candidate.instanceId === provider.instanceId
          ) {
            matchingIds.add(candidate.instanceId);
            continue;
          }
          if (key === null || capacityAccountKey(candidate) !== key) continue;
          if (candidate.auth.workspaceId === provider.auth.workspaceId) {
            matchingIds.add(candidate.instanceId);
          } else if (!candidate.auth.workspaceId || !provider.auth.workspaceId) {
            // A shared login with a missing workspace may draw on this account.
            ambiguousIds.add(candidate.instanceId);
          }
        }
        if (matchingIds.size === 0 && ambiguousIds.size === 0) continue;
        if (environment.threads === null) {
          missingActivity = true;
          continue;
        }
        activityKnown ||= matchingIds.size > 0;
        for (const thread of environment.threads) {
          if (
            (!matchingIds.has(thread.providerInstanceId) &&
              !ambiguousIds.has(thread.providerInstanceId)) ||
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
          ) {
            if (matchingIds.has(thread.providerInstanceId)) activeThreadCount += 1;
            else missingActivity = true;
          }
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

export function scheduleProviderCapacityExpiry(
  capacity: readonly ProviderCapacity[],
  onExpire: () => void,
) {
  let nextReset = Infinity;
  for (const item of capacity) {
    if (item.remainingPercent === null) continue;
    for (const window of item.provider.usageLimits?.windows ?? []) {
      if (window.resetsAt === undefined) continue;
      const resetsAt = Date.parse(window.resetsAt);
      if (resetsAt < nextReset) nextReset = resetsAt;
    }
  }
  if (!Number.isFinite(nextReset)) return;
  return Effect.runCallback(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.min(Math.max(nextReset - now, 0), 2_147_483_647));
      yield* Effect.sync(onExpire);
    }),
  );
}
