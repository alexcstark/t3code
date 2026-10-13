import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseReader from "./DatabaseReader.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-message-sync-" });
    return yield* effect.pipe(
      Effect.provide(SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"))),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("keeps messages and their cursor consistent across a concurrent commit", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* DatabaseReader.DatabaseReader;
      yield* sql`CREATE TABLE sync_messages(body TEXT, sequence INTEGER)`;
      yield* sql`INSERT INTO sync_messages VALUES ('cached', 7)`;
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const write = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE sync_messages SET body = 'new', sequence = 8`;
            yield* Deferred.succeed(writing, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(writing);

      yield* Effect.gen(function* () {
        const snapshot = yield* reader.withTransaction(
          Effect.gen(function* () {
            const messages = yield* sql`SELECT body FROM sync_messages`;
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(write);
            const cursor = yield* sql`SELECT sequence FROM sync_messages`;
            return { messages, cursor };
          }),
        );
        assert.deepStrictEqual(snapshot, {
          messages: [{ body: "cached" }],
          cursor: [{ sequence: 7 }],
        });
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));

      yield* Fiber.join(write);
      assert.deepStrictEqual(
        yield* reader.withTransaction(sql`SELECT body, sequence FROM sync_messages`),
        [{ body: "new", sequence: 8 }],
      );
    }),
  ),
);

it.effect("rejects accidental writes through the committed snapshot reader", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* DatabaseReader.DatabaseReader;
      yield* sql`CREATE TABLE sync_messages(body TEXT)`;
      yield* sql`INSERT INTO sync_messages VALUES ('before')`;
      const result = yield* reader
        .withTransaction(sql`UPDATE sync_messages SET body = 'changed'`)
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(yield* sql`SELECT body FROM sync_messages`, [{ body: "before" }]);
    }),
  ),
);

it.effect("reads within a command see that command's writes and roll back with it", () =>
  withDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reader = yield* DatabaseReader.DatabaseReader;
      yield* sql`CREATE TABLE sync_messages(body TEXT)`;
      yield* sql`INSERT INTO sync_messages VALUES ('before')`;
      const exit = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE sync_messages SET body = 'uncommitted'`;
            assert.deepStrictEqual(
              yield* reader.withTransaction(sql`SELECT body FROM sync_messages`),
              [{ body: "uncommitted" }],
            );
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.exit);
      assert.strictEqual(exit._tag, "Failure");
      assert.deepStrictEqual(yield* reader.withTransaction(sql`SELECT body FROM sync_messages`), [
        { body: "before" },
      ]);
    }),
  ),
);
