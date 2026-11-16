import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  emitThreadEvent,
  installFakeEnvironment,
  runningRun,
  threadWithHistory,
  userItem,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
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

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it.each(["follow-up", "queued message"])(
  "brings a submitted %s above the composer after reading earlier messages",
  async (submission) => {
    await page.viewport(1400, 900);
    const thread = threadWithHistory(`thread-submit-scroll-${submission}`, 20);
    using _environment = installFakeEnvironment([thread]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      followUpBehavior: "queue",
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 1400px;";
    await using app = await render(<AppRoot router={router} />, {
      container,
      // AppRoot brings its own router.
      router: false,
    });
    await expect
      .element(page.getByText(`Answer 19 for ${thread.id}.`, { exact: false }))
      .toBeVisible();
    if (submission === "queued message") {
      const live = runningRun(thread.id, "live-submit-scroll", 21, "live-submit-scroll-user");
      await act(async () => {
        await emitThreadEvent(thread.id, { type: "run.created", payload: live });
        await emitThreadEvent(thread.id, {
          type: "turn-item.updated",
          payload: userItem(thread.id, live.id, "live-submit-scroll-user", 40, "Working turn"),
        });
      });
      await expect
        .element(page.getByRole("button", { name: "Stop generation", exact: true }))
        .toBeVisible();
    }
    const viewport = app.container.querySelector<HTMLElement>(".messages-timeline-scroll");
    if (!viewport) throw new Error("Missing timeline viewport");
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
    });
    await act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
      viewport.scrollTop = 0;
    });
    await expect
      .element(page.getByRole("button", { name: "Scroll to end", exact: true }))
      .toBeVisible();

    const editor = page.getByTestId("composer-editor");
    await userEvent.click(editor);
    await userEvent.type(editor, "Continue after reading history");
    await expect.element(editor).toHaveTextContent("Continue after reading history");
    await userEvent.keyboard("{Enter}");
    const sent = page.getByText("Continue after reading history", { exact: true });
    await vi.waitFor(() => {
      const message = sent.element().getBoundingClientRect();
      expect(message.top).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
      expect(message.bottom).toBeLessThanOrEqual(
        page
          .getByRole("region", { name: "Message input", exact: true })
          .element()
          .getBoundingClientRect().top,
      );
    });
    await expect
      .element(page.getByRole("button", { name: "Scroll to end", exact: true }))
      .not.toBeInTheDocument();
  },
);
