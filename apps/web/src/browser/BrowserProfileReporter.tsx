import { useAtomValue } from "@effect/atom-react";
import {
  AuthPreviewOperateScope,
  type BrowserProfile,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { useEnvironmentIds } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const selectProfiles = (settings: { readonly browserProfiles: ReadonlyArray<BrowserProfile> }) =>
  settings.browserProfiles;
const selectDefaultProfileId = (settings: { readonly browserDefaultProfileId: string }) =>
  settings.browserDefaultProfileId;

/**
 * Tells each environment that hosts browser tabs which profiles this client
 * has, so agents can open tabs under them. Profiles live in client settings;
 * the server keeps only the latest report in memory. Report once per transport
 * generation or profile change, independently of unrelated server settings.
 */
export function BrowserProfileReporter() {
  const hydrated = useClientSettingsHydrated();
  const profiles = useClientSettings(selectProfiles);
  const defaultProfileId = useClientSettings(selectDefaultProfileId);
  const environmentIds = useEnvironmentIds();

  if (!hydrated) return null;
  return environmentIds.map((environmentId) => (
    <EnvironmentBrowserProfileReporter
      key={environmentId}
      environmentId={environmentId}
      profiles={profiles}
      defaultProfileId={defaultProfileId}
    />
  ));
}

function EnvironmentBrowserProfileReporter({
  environmentId,
  profiles,
  defaultProfileId,
}: {
  environmentId: EnvironmentId;
  profiles: ReadonlyArray<BrowserProfile>;
  defaultProfileId: string;
}) {
  const state = useAtomValue(environmentCatalog.stateAtom(environmentId));
  const connection = Option.getOrNull(AsyncResult.value(state));
  const generation =
    state._tag !== "Failure" && connection?.phase === "connected" ? connection.generation : null;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.browserProfileReporting === true;
  const operable = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const report = useAtomCommand(previewEnvironment.reportProfiles, { reportFailure: false });

  useEffect(() => {
    if (generation === null || !supported || !operable) return;
    void report({ environmentId, input: { profiles, defaultProfileId } });
  }, [defaultProfileId, environmentId, generation, operable, profiles, report, supported]);

  return null;
}
