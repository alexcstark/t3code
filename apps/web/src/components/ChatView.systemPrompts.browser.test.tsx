import { createMemoryHistory } from "@tanstack/react-router";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import "~/index.css";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { draftFanoutSelectionsAtom } from "./chat/chatViewSend";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  installFakeEnvironment,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));
class LaunchRefused extends Schema.TaggedError<LaunchRefused>()("LaunchRefused", {}) {}

it("sends the saved prompt to every model selected for a new draft", async () => {
  using _environment = installFakeEnvironment([], { requiredWorktreeBootstrap: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-system-prompt-fanout");
  const threadId = ThreadId.make("thread-system-prompt-fanout");
  const systemPrompt = { id: "review", name: "Review", content: "Review only." };
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId,
    branch: "main",
    envMode: "worktree",
    systemPrompt,
  });
  store.setPrompt(draftId, "Review this project");
  appAtomRegistry.set(
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, threadId))),
    [
      { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    ],
  );
  const launches: OrchestrationV2ThreadLaunchInput[] = [];
  using _launch = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    (input: OrchestrationV2ThreadLaunchInput) => {
      launches.push(input);
      return Effect.fail(new LaunchRefused());
    },
  );
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(launches).toHaveLength(2));
  expect(launches.map((input) => input.systemPrompt)).toEqual([systemPrompt, systemPrompt]);
});
