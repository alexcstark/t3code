/**
 * Automated threads: threads with a scheduled task bound to them, across every
 * connected environment. They live on the Automations page instead of the
 * sidebar thread list, because each run re-sorts them to the top.
 *
 * @module state/automations
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentAutomations {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly error: boolean;
  /** Null until the environment's live task list has answered. */
  readonly tasks: readonly ScheduledTask[] | null;
}

export const environmentAutomationsAtom = Atom.make((get): readonly EnvironmentAutomations[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const environments: EnvironmentAutomations[] = [];
  for (const [environmentId, presentation] of presentations) {
    const connected =
      presentation.connection.phase === "connected" && presentation.serverConfig !== null;
    const label = presentation.entry.target.label;
    if (!connected) {
      environments.push({ environmentId, label, connected, error: false, tasks: null });
      continue;
    }
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    environments.push({
      environmentId,
      label,
      connected,
      error: result._tag === "Failure",
      tasks: Option.getOrNull(AsyncResult.value(result))?.tasks ?? null,
    });
  }
  return environments;
}).pipe(Atom.withLabel("web-automations:environments"));

// A sorted, joined string so that task runs, which rewrite lastRunAt and
// nextRunAt on every tick, do not wake the sidebar unless the set changes.
const automatedThreadKeysAtom = Atom.make((get): string =>
  get(environmentAutomationsAtom)
    .flatMap(({ environmentId, tasks }) =>
      (tasks ?? []).flatMap((task) =>
        task.threadId === null ? [] : [`${environmentId}:${task.threadId}`],
      ),
    )
    .toSorted()
    .join("\n"),
).pipe(Atom.withLabel("web-automations:thread-keys"));

export function useEnvironmentAutomations() {
  return useAtomValue(environmentAutomationsAtom);
}

/** Scoped thread keys (`environmentId:threadId`) of every automated thread. */
export function useAutomatedThreadKeys(): ReadonlySet<string> {
  const joined = useAtomValue(automatedThreadKeysAtom);
  return useMemo(() => new Set(joined === "" ? [] : joined.split("\n")), [joined]);
}
