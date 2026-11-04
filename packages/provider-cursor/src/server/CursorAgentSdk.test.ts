import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentOptions, ListRunsOptions } from "@cursor/sdk";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  let completedRuns = 0;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const store = {
    dispose: vi.fn(async () => {
      closeExecutionOrder.push("store.dispose");
    }),
  } as never;
  const storeOpen = vi.fn(async () => store);
  const listMessages = vi.fn(async () => []);
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async (_agentId: string, options: ListRunsOptions) => {
    runOperations.push("agent.listRuns");
    const runs = [
      ...Array.from({ length: completedRuns }, (_, index) => ({
        id: `run-completed-${index}`,
        status: "finished",
      })),
      ...(staleRunActive ? [{ id: "run-stale", status: "running" }] : []),
    ];
    const offset = Number(options.cursor ?? 0);
    const nextOffset = offset + (options.limit ?? 50);
    return {
      items: runs.slice(offset, nextOffset),
      ...(nextOffset < runs.length ? { nextCursor: String(nextOffset) } : {}),
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    store,
    storeOpen,
    listMessages,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
      completedRuns = 0;
    },
    setCompletedRuns: (count: number) => {
      completedRuns = count;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({
    Agent: {
      create: cursorSdkMock.create,
      resume: cursorSdkMock.resume,
      listRuns: cursorSdkMock.listRuns,
      cancelRun: cursorSdkMock.cancelRun,
      messages: {
        list: cursorSdkMock.listMessages,
      },
    },
    createAgentPlatform: vi.fn(),
  }),
  loadCursorSqlite: () => ({ SqliteLocalAgentStore: { open: cursorSdkMock.storeOpen } }),
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("constructs without loading and reports first-use load failures as runner errors", () =>
    Effect.gen(function* () {
      const failure = new Error("missing SDK chunk");
      const load = vi.fn(() => {
        throw failure;
      });
      const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined).pipe(
        Effect.provideService(CursorSdk.CursorSdk, {
          load,
          loadSqlite: () => {
            throw new Error("unused SQLite");
          },
        }),
      );
      assert.strictEqual(load.mock.calls.length, 0);
      const result = yield* runner
        .open({
          operation: "create",
          options: {},
          threadId: ThreadId.make("lazy-load"),
          providerSessionId: ProviderSessionId.make("lazy-load"),
        })
        .pipe(Effect.exit);
      assert(Exit.isFailure(result));
      assert.deepStrictEqual(
        Cause.squash(result.cause),
        new CursorAgentSdk.CursorAgentSdkRunnerError({
          method: "agent.create",
          cause: failure,
        }),
      );
      assert.strictEqual(load.mock.calls.length, 1);
    }),
  );

  it.effect.each([0, 120])(
    "retries a resumed send after %s completed runs and an abandoned local run",
    (completedRuns) =>
      Effect.gen(function* () {
        cursorSdkMock.runOperations.length = 0;
        cursorSdkMock.listRuns.mockClear();
        cursorSdkMock.cancelRun.mockClear();
        cursorSdkMock.setStaleRunActive(true);
        cursorSdkMock.setCompletedRuns(completedRuns);

        const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        const session = yield* runner.open({
          operation: "resume",
          agentId: "agent-cursor-agent-sdk-test",
          options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
          threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
          providerSessionId: ProviderSessionId.make(
            "provider-session-cursor-agent-sdk-stale-run-test",
          ),
        });
        assert.deepStrictEqual(cursorSdkMock.runOperations, []);
        const run = yield* session.send({ message: "continue" });
        yield* run.wait;

        assert.deepStrictEqual(cursorSdkMock.runOperations, [
          "run.start",
          ...Array.from({ length: completedRuns === 0 ? 1 : 2 }, () => "agent.listRuns"),
          "agent.cancelRun",
          "run.start",
        ]);
        assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
          "agent-cursor-agent-sdk-test",
          { runtime: "local", cwd: process.cwd(), store: cursorSdkMock.store, limit: 100 },
        ]);
        assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
          "run-stale",
          {
            runtime: "local",
            cwd: process.cwd(),
            store: cursorSdkMock.store,
          },
        ]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["owned", "provided"] as const)(
    "closes an agent and releases only its %s store",
    (ownership) =>
      Effect.gen(function* () {
        cursorSdkMock.storeOpen.mockClear();
        cursorSdkMock.agentClose.mockClear();
        cursorSdkMock.closeExecutionOrder.length = 0;
        cursorSdkMock.setAgentCloseFailure(undefined);

        const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        const session = yield* runner.open({
          operation: "create",
          options: {
            model: { id: "default" },
            mode: "agent",
            local: {
              cwd: process.cwd(),
              ...(ownership === "provided" ? { store: cursorSdkMock.store } : {}),
            },
          },
          threadId: ThreadId.make("thread-cursor-agent-sdk-close-order-test"),
          providerSessionId: ProviderSessionId.make(
            "provider-session-cursor-agent-sdk-close-order-test",
          ),
        });

        assert.strictEqual(
          (cursorSdkMock.create.mock.lastCall as unknown as [AgentOptions])[0].local?.store,
          cursorSdkMock.store,
        );
        assert.equal(cursorSdkMock.storeOpen.mock.calls.length, ownership === "owned" ? 1 : 0);
        yield* session.listMessages;
        assert.deepStrictEqual(cursorSdkMock.listMessages.mock.lastCall, [
          "agent-cursor-agent-sdk-test",
          { runtime: "local", cwd: process.cwd(), store: cursorSdkMock.store },
        ]);
        cursorSdkMock.closeExecutionOrder.length = 0;
        yield* session.close;

        assert.deepStrictEqual(cursorSdkMock.closeExecutionOrder, [
          "protocol:agent.close",
          "sdk:agent.close",
          ...(ownership === "owned" ? ["store.dispose"] : []),
        ]);
        assert.equal(cursorSdkMock.agentClose.mock.calls.length, 1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["agent.close", "agent.create", "agent.resume"] as const)(
    "releases the owned store when %s fails",
    (method) =>
      Effect.gen(function* () {
        cursorSdkMock.agentClose.mockClear();
        cursorSdkMock.closeExecutionOrder.length = 0;
        const failure = new Error("agent operation failed");
        cursorSdkMock.setAgentCloseFailure(method === "agent.close" ? failure : undefined);
        if (method === "agent.create") cursorSdkMock.create.mockRejectedValueOnce(failure);
        if (method === "agent.resume") cursorSdkMock.resume.mockRejectedValueOnce(failure);
        const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        const open = runner.open({
          operation: method === "agent.resume" ? "resume" : "create",
          agentId: "agent-cursor-agent-sdk-test",
          options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
          threadId: ThreadId.make("thread-cursor-agent-sdk-close-failure-test"),
          providerSessionId: ProviderSessionId.make(
            "provider-session-cursor-agent-sdk-close-failure-test",
          ),
        });
        const error = yield* Effect.flip(
          method === "agent.close"
            ? Effect.flatMap(open, (session) => session.close)
            : Effect.asVoid(open),
        );
        assert.instanceOf(error, CursorAgentSdk.CursorAgentSdkRunnerError);
        assert.equal(error.method, method);
        assert.strictEqual(error.cause, failure);
        assert.deepStrictEqual(cursorSdkMock.closeExecutionOrder, [
          ...(method === "agent.close" ? ["protocol:agent.close", "sdk:agent.close"] : []),
          "store.dispose",
        ]);
        assert.equal(cursorSdkMock.agentClose.mock.calls.length, method === "agent.close" ? 1 : 0);
        cursorSdkMock.setAgentCloseFailure(undefined);
      }).pipe(Effect.provide(layerTest)),
  );
});
