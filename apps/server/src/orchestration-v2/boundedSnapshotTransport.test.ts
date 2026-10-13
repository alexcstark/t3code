import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EventId,
  MessageId,
  NodeId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadStreamItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import { Etag, HttpRouter } from "effect/http";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";
import * as OrchestrationHttp from "./http.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const decodeBounded = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const decodeStreamItem = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
);
const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

const provider = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: provider, model: "gpt-5.4" };
const projectId = ProjectId.make("project:compact-transport");
const PARENT = ThreadId.make("thread:compact-transport:parent");
const FORK = ThreadId.make("thread:compact-transport:fork");
const LONG = ThreadId.make("thread:compact-transport:long");
const parentRun = RunId.make("run:compact-transport:parent");
const longRun = RunId.make("run:compact-transport:long");

const store = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      streamStoredEventsFrom: () => Stream.empty,
    });
  }),
);

class OrchestrationApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("compact-transport"),
      subject: "compact-transport",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);

function threadCreated(
  id: ThreadId,
  at: DateTime.Utc,
  forkOf?: RunId,
): Extract<OrchestrationV2DomainEvent, { type: "thread.created" }> {
  return {
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId: id,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId,
      title: String(id),
      providerInstanceId: provider,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        forkOf === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
          : { parentThreadId: PARENT, relationshipToParent: "fork", rootThreadId: PARENT },
      forkedFrom: forkOf === undefined ? null : { type: "run", threadId: PARENT, runId: forkOf },
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

function runCreated(
  threadId: ThreadId,
  runId: RunId,
  at: DateTime.Utc,
): OrchestrationV2DomainEvent {
  const rootNodeId = NodeId.make(`node:${runId}`);
  return {
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver: ProviderDriverKind.make("codex"),
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: provider,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function itemUpdated(
  threadId: ThreadId,
  runId: RunId | null,
  key: string,
  ordinal: number,
  at: DateTime.Utc,
  type:
    | "command_execution"
    | "run_interrupt_request"
    | "run_interrupt_result" = "command_execution",
): OrchestrationV2DomainEvent {
  const base = {
    id: TurnItemId.make(`turn-item:${threadId}:${key}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: key,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const payload: OrchestrationV2TurnItem =
    type === "command_execution"
      ? { ...base, type, input: `echo ${key}`, output: `output ${key}`, exitCode: 0 }
      : { ...base, type, message: key };
  return {
    id: EventId.make(`event:${threadId}:${key}`),
    type: "turn-item.updated",
    threadId,
    ...(runId === null ? {} : { runId }),
    occurredAt: at,
    payload,
  };
}

const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const at = yield* DateTime.now;
  const events: OrchestrationV2DomainEvent[] = [
    threadCreated(PARENT, at),
    runCreated(PARENT, parentRun, at),
    ...[1, 2, 3].map((n) => itemUpdated(PARENT, parentRun, `parent-${n}`, n, at)),
    threadCreated(FORK, at, parentRun),
    ...[1, 2, 3, 4].map((n) => itemUpdated(FORK, null, `fork-${n}`, n, at)),
    threadCreated(LONG, at),
    runCreated(LONG, longRun, at),
    // The request sits far outside the recent window; its result is inside it.
    itemUpdated(LONG, longRun, "request", 1, at, "run_interrupt_request"),
    ...Array.from({ length: 90 }, (_, index) =>
      itemUpdated(LONG, longRun, `tool-${index}`, index + 2, at),
    ),
    itemUpdated(LONG, longRun, "result", 92, at, "run_interrupt_result"),
  ];
  for (const event of events) yield* projections.apply(event);
});

// Bounded subscriptions without afterSequence never read the event store, and
// thread routes never touch projects.
const TestLayer = Layer.mergeAll(
  management,
  Layer.effectDiscard(seed),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
).pipe(Layer.provideMerge(store));

const withHttp = <A>(use: (get: (path: string) => Promise<Response>) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Success<typeof TestLayer>>();
    const appLayer = HttpApiBuilder.layer(OrchestrationApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(auth),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(NodeHttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(() =>
          use((path) =>
            handler(
              new Request(`http://environment.test${path}`, {
                headers: {
                  [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
                },
              }),
            ),
          ),
        ),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  });

const firstSnapshot = (input: Parameters<typeof subscribeOrchestrationV2Thread>[0]) =>
  subscribeOrchestrationV2Thread(input).pipe(
    Effect.flatMap((stream) => Stream.runHead(stream)),
    Effect.map((head) => {
      if (head._tag !== "Some" || head.value.kind !== "snapshot") throw new Error("No snapshot");
      // Through the wire codec, as a client receives it.
      const decoded = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(head.value))));
      if (decoded.kind !== "snapshot") throw new Error("No snapshot");
      return { raw: head.value, decoded };
    }),
  );

function itemIds(projection: OrchestrationV2ThreadProjection): string[] {
  return projection.turnItems.map((item) => String(item.id));
}

it.effect("syncs messages independently of pending writes and replays them after commit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-transport-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    const stores = Layer.mergeAll(ProjectionStore.layer, OrchestrationEventStore.layer).pipe(
      Layer.provideMerge(database),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      const at = yield* DateTime.now;
      const created = threadCreated(LONG, at);
      yield* sql.withTransaction(
        events
          .appendAgentEvents({ events: [created] })
          .pipe(Effect.andThen(projections.apply(created))),
      );
      const initial = yield* projections.getThreadSnapshotWindow(LONG, { rowLimit: 75 });
      const changed: OrchestrationV2DomainEvent = {
        ...created,
        id: EventId.make("event:sync-transport:renamed"),
        type: "thread.metadata-updated",
        payload: { ...created.payload, title: "Updated messages" },
      };
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const write = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* events.appendAgentEvents({ events: [changed] });
            yield* projections.apply(changed);
            yield* Deferred.succeed(writing, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      const subscribeFromCached = subscribeOrchestrationV2Thread({
        threadId: LONG,
        afterSequence: initial.snapshotSequence,
        requestCompletionMarker: true,
        acceptBoundedSnapshot: true,
      }).pipe(Effect.flatMap(Stream.runCollect));
      yield* Effect.gen(function* () {
        const snapshot = yield* projections.getThreadSnapshotWindow(LONG, { rowLimit: 75 });
        assert.strictEqual(snapshot.projection.thread.title, String(LONG));
        assert.strictEqual(snapshot.snapshotSequence, initial.snapshotSequence);
        assert.deepStrictEqual(Array.from(yield* subscribeFromCached), [{ kind: "synchronized" }]);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(write);
      const resumed = Array.from(yield* subscribeFromCached);
      assert.strictEqual(resumed.length, 2);
      assert.strictEqual(resumed[0]?.kind, "event");
      if (resumed[0]?.kind === "event") {
        assert.strictEqual(resumed[0].event.type, "thread.metadata-updated");
        if (resumed[0].event.type === "thread.metadata-updated")
          assert.strictEqual(resumed[0].event.payload.title, "Updated messages");
      }
      assert.deepStrictEqual(resumed[1], { kind: "synchronized" });
    }).pipe(Effect.provide(management.pipe(Layer.provideMerge(stores))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(TestLayer)("compact bounded snapshot transport", (it) => {
  it.effect("confirms current cached messages and immediately continues with live updates", () =>
    Effect.gen(function* () {
      const at = yield* DateTime.now;
      const liveEvent = itemUpdated(LONG, longRun, "live", 93, at);
      const items = yield* subscribeOrchestrationV2Thread({
        threadId: LONG,
        afterSequence: 7,
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
              latestAgentSequence: () => Effect.succeed(7),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              streamStoredEventsFrom: () =>
                Stream.make({ sequence: 8, commandId: null, event: liveEvent }),
            }),
          ),
        ),
      );
      assert.deepStrictEqual(
        Array.from(items).map((item) =>
          item.kind === "event" ? { kind: item.kind, sequence: item.sequence } : item,
        ),
        [{ kind: "synchronized" }, { kind: "event", sequence: 8 }],
      );
    }),
  );

  it.effect("replays missed messages before confirming sync without reloading history", () =>
    Effect.gen(function* () {
      const at = yield* DateTime.now;
      const event = itemUpdated(LONG, longRun, "missed", 93, at);
      const items = yield* subscribeOrchestrationV2Thread({
        threadId: LONG,
        afterSequence: 7,
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.provide(
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            latestAgentSequence: () => Effect.succeed(8),
            getAgentReplayStats: () =>
              Effect.succeed({ eventCount: 1, rawPayloadBytes: 512, hasCreateEvent: false }),
            readAgentEvents: () => Stream.make({ sequence: 8, commandId: null, event }),
          }),
        ),
      );
      assert.deepStrictEqual(
        Array.from(items).map((item) =>
          item.kind === "event" ? { kind: item.kind, sequence: item.sequence } : item,
        ),
        [{ kind: "event", sequence: 8 }, { kind: "synchronized" }],
      );
    }),
  );

  describe.each([
    ["fork", FORK],
    ["long run with a retained interrupt request", LONG],
  ])("%s", (_, threadId) => {
    it.effect("HTTP: legacy, ignored and opted-in requests restore to the same snapshot", () =>
      withHttp(async (get) => {
        const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`;
        const legacyBody = await (await get(base)).text();
        const ignoredBody = await (await get(`${base}?compactTurnItems=yes&unknown=1`)).text();
        const compactResponse = await get(`${base}?compactTurnItems=1`);
        assert.strictEqual(compactResponse.status, 200);
        const compactBody = await compactResponse.text();

        // Requests without the exact opt-in get the unchanged representation.
        assert.notInclude(legacyBody, "turnItemsOmitLocalVisible");
        assert.strictEqual(ignoredBody, legacyBody);
        assert.isBelow(compactBody.length, legacyBody.length);

        const legacy = decodeBounded(legacyBody);
        const compact = decodeBounded(compactBody);
        assert.isTrue(compact.turnItemsOmitLocalVisible);
        const { turnItemsOmitLocalVisible: _marker, projection: _p, ...compactRest } = compact;
        const { projection: _legacyProjection, ...legacyRest } = legacy;
        assert.deepStrictEqual(compactRest, legacyRest);
        assert.deepStrictEqual(boundedSnapshotProjection(compact), legacy.projection);
        return { legacy, compact };
      }).pipe(
        Effect.tap(({ legacy }) =>
          Effect.sync(() => {
            if (threadId === FORK) {
              const visibility = legacy.projection.visibleTurnItems.map((row) => row.visibility);
              assert.deepStrictEqual(visibility, [
                "inherited",
                "inherited",
                "inherited",
                "synthetic",
                "local",
                "local",
                "local",
                "local",
              ]);
            } else {
              const ids = itemIds(legacy.projection);
              assert.isTrue(legacy.hasMoreHistory);
              // Window rows first, then the retained request outside the window.
              assert.strictEqual(ids.at(-1), `turn-item:${LONG}:request`);
              assert.isFalse(
                legacy.projection.visibleTurnItems.some((row) => row.sourceItemId === ids.at(-1)),
              );
            }
          }),
        ),
      ),
    );

    it.effect("WS: bounded snapshots stay unchanged unless the client opts in", () =>
      Effect.gen(function* () {
        const legacy = yield* firstSnapshot({ threadId, acceptBoundedSnapshot: true });
        const compact = yield* firstSnapshot({
          threadId,
          acceptBoundedSnapshot: true,
          acceptCompactTurnItems: true,
        });
        // Full snapshots ignore the compact opt-in entirely.
        const full = yield* firstSnapshot({ threadId, acceptCompactTurnItems: true });

        assert.isUndefined(legacy.decoded.turnItemsOmitLocalVisible);
        assert.isUndefined(full.decoded.turnItemsOmitLocalVisible);
        assert.isUndefined(full.decoded.historyCursor);
        assert.isTrue(compact.decoded.turnItemsOmitLocalVisible);
        assert.isBelow(
          compact.decoded.projection.turnItems.length,
          legacy.decoded.projection.turnItems.length,
        );
        assert.deepStrictEqual(
          boundedSnapshotProjection(compact.decoded),
          legacy.decoded.projection,
        );
        assert.deepStrictEqual(
          {
            ...compact.decoded,
            projection: legacy.decoded.projection,
            turnItemsOmitLocalVisible: undefined,
          },
          { ...legacy.decoded, turnItemsOmitLocalVisible: undefined },
        );
      }),
    );
  });
});
