import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseReader from "../persistence/DatabaseReader.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread:projection-reader");

const withThread = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-projection-reader-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    return yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("codex");
      yield* store.apply({
        id: EventId.make("event:projection-reader:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project:projection-reader"),
          title: "Committed",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      return yield* effect;
    }).pipe(Effect.provide(Layer.provideMerge(ProjectionStore.layer, database)));
  }).pipe(Effect.provide(NodeServices.layer));

const changeTitle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_projection_threads
    SET title = 'Changed', payload_json = json_set(payload_json, '$.title', 'Changed')
    WHERE thread_id = ${threadId}`;
});

it.effect("control records and timeline reads complete while a writer is uncommitted", () =>
  withThread(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const write = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* changeTitle;
            yield* Deferred.succeed(writing, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      yield* Effect.gen(function* () {
        assert.equal(
          (yield* store.getThreadRecords(threadId, ["messages"])).thread.title,
          "Committed",
        );
        assert.isUndefined(
          (yield* store.getRuntimeResponseContext(threadId, RuntimeRequestId.make("missing")))
            .request,
        );
        assert.deepEqual(
          (yield* store.getTimelinePage(threadId, { view: "activity", limit: 10 })).items,
          [],
        );
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(write);
      assert.equal((yield* store.getThreadRecords(threadId, [])).thread.title, "Changed");
    }),
  ),
);

it.effect("nested control reads retain their snapshot across a concurrent commit", () =>
  withThread(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* DatabaseReader.DatabaseReader;
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const write = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* changeTitle;
            yield* Deferred.succeed(writing, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      yield* reader
        .withTransaction(
          Effect.gen(function* () {
            assert.equal((yield* store.getThreadRecords(threadId, [])).thread.title, "Committed");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(write);
            assert.equal((yield* store.getThreadRecords(threadId, [])).thread.title, "Committed");
            assert.equal(
              (yield* store.getThreadProviderContext(threadId)).thread.title,
              "Committed",
            );
          }),
        )
        .pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      assert.equal((yield* store.getThreadRecords(threadId, [])).thread.title, "Changed");
    }),
  ),
);

it.effect("control reads inside a write transaction see its writes and preserve rollback", () =>
  withThread(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const exit = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* changeTitle;
            assert.equal((yield* store.getThreadRecords(threadId, [])).thread.title, "Changed");
            assert.equal((yield* store.getThreadProviderContext(threadId)).thread.title, "Changed");
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      assert.equal((yield* store.getThreadRecords(threadId, [])).thread.title, "Committed");
    }),
  ),
);

it.effect("orders selected user messages without parsing excluded assistant history", () =>
  withThread(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      for (const [id, ordinal] of [
        ["z-first", 1],
        ["a-second", 2],
      ] as const) {
        const messageId = MessageId.make(id);
        yield* store.apply({
          id: EventId.make(`event:message:${id}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: id,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:item:${id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${id}`),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            text: id,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });
      }
      // Invalid JSON detects accidental parsing of history excluded by role.
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES ('obsolete-assistant', ${threadId}, 3, 'assistant_message', 'completed', ${DateTime.formatIso(now)}, 'not-json')`;
      const read = (messageIds?: ReadonlyArray<MessageId>) =>
        store.getThreadRecords(threadId, ["messages"], {
          messageRoles: ["user"],
          ...(messageIds === undefined ? {} : { messageIds }),
        });
      assert.deepEqual(
        (yield* read()).messages.map((message) => message.id),
        ["z-first", "a-second"],
      );
      assert.deepEqual(
        (yield* read([MessageId.make("a-second"), MessageId.make("z-first")])).messages.map(
          (message) => message.id,
        ),
        ["z-first", "a-second"],
      );
      assert.deepEqual(
        (yield* read([MessageId.make("a-second")])).messages.map((message) => message.id),
        ["a-second"],
      );
    }),
  ),
);
