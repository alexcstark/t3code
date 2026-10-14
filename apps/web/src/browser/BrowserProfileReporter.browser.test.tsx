import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  EnvironmentId,
  type BrowserProfile,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";

interface ProfileSettings {
  browserProfiles: ReadonlyArray<BrowserProfile>;
  browserDefaultProfileId: string;
}

const state = vi.hoisted(() => ({
  electron: true,
  registry: null as AtomRegistry.AtomRegistry | null,
  configs: null as Atom.Writable<ReadonlyMap<EnvironmentId, ServerConfig>> | null,
  connections: null as Atom.Writable<
    ReadonlyMap<EnvironmentId, AsyncResult.AsyncResult<SupervisorConnectionState>>
  > | null,
  permissions: null as Atom.Writable<ReadonlySet<EnvironmentId>> | null,
  settings: null as Atom.Writable<ProfileSettings> | null,
  hydrated: null as Atom.Writable<boolean> | null,
  report: vi.fn(),
}));

const FIRST = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);
const SECOND = EnvironmentId.make("second");
const ids = [FIRST, SECOND];
const connectionAtoms = Atom.family((id: EnvironmentId) =>
  Atom.make(
    (get) => get(state.connections!).get(id) ?? AsyncResult.initial<SupervisorConnectionState>(),
  ),
);
const configAtoms = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => get(state.configs!).get(id) ?? null),
);
const permissionAtoms = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => get(state.permissions!).has(id)),
);

vi.mock("~/env", () => ({
  get isElectron() {
    return state.electron;
  },
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { stateAtom: (id: EnvironmentId) => connectionAtoms(id) },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: (id: EnvironmentId) => configAtoms(id) },
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentIds: () => ids,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (id: EnvironmentId) => useAtomValue(permissionAtoms(id)),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ProfileSettings) => unknown) =>
    select(useAtomValue(state.settings!)),
  useClientSettingsHydrated: () => useAtomValue(state.hydrated!),
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { reportProfiles: undefined } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.report }));

import { BrowserProfileReporter } from "./BrowserProfileReporter";

function config(environmentId: EnvironmentId): ServerConfig {
  return {
    environment: {
      environmentId,
      label: environmentId,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.46",
      capabilities: {
        repositoryIdentity: true,
        serverBrowser: true,
        browserProfileReporting: true,
      },
    },
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/workspace",
    keybindingsConfigPath: "/settings/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function setup() {
  state.electron = true;
  state.registry = AtomRegistry.make();
  state.configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
    new Map(ids.map((id) => [id, config(id)])),
  );
  state.connections = Atom.make<
    ReadonlyMap<EnvironmentId, AsyncResult.AsyncResult<SupervisorConnectionState>>
  >(
    new Map(
      ids.map((id) => [
        id,
        AsyncResult.success({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          generation: 1,
        } satisfies SupervisorConnectionState),
      ]),
    ),
  );
  state.permissions = Atom.make<ReadonlySet<EnvironmentId>>(new Set(ids));
  state.settings = Atom.make<ProfileSettings>({
    browserProfiles: [],
    browserDefaultProfileId: "default",
  });
  state.hydrated = Atom.make(true);
  state.registry.mount(state.configs);
  state.registry.mount(state.connections);
  state.registry.mount(state.permissions);
  state.registry.mount(state.settings);
  state.registry.mount(state.hydrated);
  state.report.mockReset();
  state.report.mockResolvedValue(AsyncResult.success(undefined));
  const registry = state.registry;
  const stack = new AsyncDisposableStack();
  stack.defer(() => registry.dispose());
  return {
    async render() {
      return stack.use(
        await render(
          <RegistryContext.Provider value={registry}>
            <BrowserProfileReporter />
          </RegistryContext.Provider>,
        ),
      );
    },
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}

describe("browser profile reporting", () => {
  it("does not resend profiles for unrelated server configuration updates", async () => {
    await using app = setup();
    await app.render();
    for (let index = 0; index < 200; index++) {
      await act(() => {
        const configs = new Map(state.registry!.get(state.configs!));
        const previous = configs.get(FIRST)!;
        configs.set(FIRST, { ...previous, cwd: `/workspace/${index}` });
        state.registry!.set(state.configs!, configs);
      });
    }
    expect(state.report).toHaveBeenCalledTimes(1);
  });

  it("reports again only to the environment whose transport was replaced", async () => {
    await using app = setup();
    await app.render();
    await act(() => {
      const connections = new Map(state.registry!.get(state.connections!));
      connections.set(
        FIRST,
        AsyncResult.success({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          generation: 2,
        }),
      );
      state.registry!.set(state.connections!, connections);
    });
    expect(state.report.mock.calls.map(([target]) => target.environmentId)).toEqual([FIRST, FIRST]);
  });

  it("keeps older browser servers free of unsupported profile requests", async () => {
    await using app = setup();
    const current = config(FIRST);
    const older = {
      ...current,
      environment: {
        ...current.environment,
        capabilities: { repositoryIdentity: true, serverBrowser: true },
      },
    };
    state.registry!.set(
      state.configs!,
      new Map([
        [FIRST, older],
        [SECOND, config(SECOND)],
      ]),
    );
    await app.render();
    expect(state.report.mock.calls.map(([target]) => target.environmentId)).toEqual([]);
  });

  it("keeps cached disconnected environments quiet and reports the latest profiles on reconnect", async () => {
    await using app = setup();
    await app.render();
    await act(() => {
      const connections = new Map(state.registry!.get(state.connections!));
      connections.set(
        FIRST,
        AsyncResult.success({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "backoff",
          generation: 1,
        }),
      );
      state.registry!.set(state.connections!, connections);
    });
    state.report.mockClear();
    await act(() =>
      state.registry!.set(state.settings!, {
        browserProfiles: [],
        browserDefaultProfileId: "work",
      }),
    );
    expect(state.report.mock.calls.map(([target]) => target.environmentId)).toEqual([]);
    await act(() => {
      const connections = new Map(state.registry!.get(state.connections!));
      connections.set(
        FIRST,
        AsyncResult.success({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          generation: 2,
        }),
      );
      state.registry!.set(state.connections!, connections);
    });
    expect(state.report.mock.calls.map(([target]) => target.environmentId)).toEqual([FIRST]);
    expect(state.report.mock.lastCall?.[0].input.defaultProfileId).toBe("work");
  });

  it("waits for hydration and grants, then reports changes only to the primary desktop environment", async () => {
    await using app = setup();
    state.registry!.set(state.hydrated!, false);
    state.registry!.set(state.permissions!, new Set<EnvironmentId>());
    await app.render();
    expect(state.report).not.toHaveBeenCalled();
    await act(() => state.registry!.set(state.hydrated!, true));
    expect(state.report).not.toHaveBeenCalled();
    await act(() => state.registry!.set(state.permissions!, new Set(ids)));
    expect(state.report.mock.calls.map(([target]) => target.environmentId)).toEqual([FIRST]);
    await act(() =>
      state.registry!.set(state.settings!, {
        browserProfiles: [],
        browserDefaultProfileId: "work",
      }),
    );
    expect(state.report.mock.calls.map(([target]) => target.environmentId)).toEqual([FIRST, FIRST]);
    expect(state.report.mock.lastCall?.[0].input.defaultProfileId).toBe("work");
  });

  it("does not report a web client's profiles to any environment", async () => {
    await using app = setup();
    state.electron = false;
    await app.render();
    expect(state.report).not.toHaveBeenCalled();
  });
});
