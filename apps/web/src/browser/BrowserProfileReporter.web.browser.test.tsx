import { PRIMARY_LOCAL_ENVIRONMENT_ID, type BrowserProfile } from "@t3tools/contracts";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({ report: vi.fn() }));

const connection = Atom.make(
  AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "connected", generation: 1 }),
);
const config = Atom.make({
  environment: { capabilities: { browserProfileReporting: true } },
});

// Browser mocks capture exported constants when the module is imported.
vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: {
      browserProfiles: ReadonlyArray<BrowserProfile>;
      browserDefaultProfileId: string;
    }) => unknown,
  ) => select({ browserProfiles: [], browserDefaultProfileId: "default" }),
  useClientSettingsHydrated: () => true,
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentIds: () => [PRIMARY_LOCAL_ENVIRONMENT_ID],
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => connection },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => config },
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { reportProfiles: undefined } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.report }));

import { BrowserProfileReporter } from "./BrowserProfileReporter";

it("does not report a web client's profiles to any environment", async () => {
  state.report.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using _screen = await render(<BrowserProfileReporter />);
  expect(state.report).not.toHaveBeenCalled();
});
