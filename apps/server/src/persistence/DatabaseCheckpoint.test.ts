// @effect-diagnostics nodeBuiltinImport:off -- Inspect the database file independently of its WAL.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import * as DatabaseCheckpoint from "./DatabaseCheckpoint.ts";

it.effect("commits before deferred maintenance runs and later persists the WAL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const makeCheckpoint = DatabaseCheckpoint.makeFileCheckpoint(filename).pipe(
      Effect.map((checkpoint) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(checkpoint),
          Effect.andThen(Deferred.succeed(completed, undefined)),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`PRAGMA synchronous = NORMAL`;
      yield* sql`PRAGMA wal_autocheckpoint = 0`;
      yield* sql`CREATE TABLE entries(value BLOB)`;
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(started);
        // Cross the normal auto-checkpoint threshold while maintenance cannot
        // progress. These commits and reads must finish before it is released.
        yield* sql.withTransaction(sql`INSERT INTO entries VALUES (zeroblob(5000000))`);
        yield* sql.withTransaction(sql`INSERT INTO entries VALUES (x'01')`);
        assert.deepEqual(yield* sql`SELECT count(*) AS count FROM entries`, [{ count: 2 }]);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(completed);
        const persisted = yield* Effect.acquireRelease(
          Effect.sync(
            () => new NodeSqlite.DatabaseSync(`file:${filename}?immutable=1`, { readOnly: true }),
          ),
          (database) => Effect.sync(() => database.close()),
        );
        assert.deepEqual(persisted.prepare("SELECT count(*) AS count FROM entries").all(), [
          { count: 2 },
        ]);
      }).pipe(
        Effect.provide(DatabaseCheckpoint.layerWith(makeCheckpoint)),
        Effect.ensuring(Deferred.succeed(release, undefined)),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerWorker({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries a failed checkpoint on the next tick without overlapping maintenance", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    let attempts = 0;
    const checkpoint = Effect.suspend(() => {
      attempts++;
      return attempts === 1
        ? Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.fail("disk unavailable")))
        : Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Deferred.succeed(completed, undefined)),
          );
    });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(failed);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      assert.equal(attempts, 2);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(completed);
    }).pipe(
      Effect.provide(DatabaseCheckpoint.layerWith(Effect.succeed(checkpoint))),
      Effect.ensuring(Deferred.succeed(release, undefined)),
    );
  }),
);

it.effect("preserves a pinned reader snapshot and checkpoints newer commits after it closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-reader-" });
    const filename = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`PRAGMA wal_autocheckpoint = 0`;
      yield* sql`CREATE TABLE entries(value BLOB)`;
      yield* sql`INSERT INTO entries VALUES (zeroblob(5000000))`;
      const checkpoint = yield* DatabaseCheckpoint.makeFileCheckpoint(filename);
      yield* checkpoint;
      yield* sql`INSERT INTO entries VALUES (zeroblob(2500000))`;
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename, { readOnly: true })),
        (database) => Effect.sync(() => database.close()),
      );
      reader.exec("BEGIN");
      assert.deepEqual(reader.prepare("SELECT count(*) AS count FROM entries").all(), [
        { count: 2 },
      ]);
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (zeroblob(2500000))`);
      // The reader permits only a partial copy. Retry the remainder after it
      // closes even though fewer than 1000 frames remain outstanding.
      yield* checkpoint;
      assert.deepEqual(reader.prepare("SELECT count(*) AS count FROM entries").all(), [
        { count: 2 },
      ]);
      assert.deepEqual(yield* sql`SELECT count(*) AS count FROM entries`, [{ count: 3 }]);
      reader.exec("COMMIT");
      yield* checkpoint;
      const persisted = yield* Effect.acquireRelease(
        Effect.sync(
          () => new NodeSqlite.DatabaseSync(`file:${filename}?immutable=1`, { readOnly: true }),
        ),
        (database) => Effect.sync(() => database.close()),
      );
      assert.deepEqual(persisted.prepare("SELECT count(*) AS count FROM entries").all(), [
        { count: 3 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerWorker({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.each([
  ["3.44.6", false],
  ["3.50.7", false],
  ["3.51.2", false],
  ["3.51.3", true],
  ["3.53.4", true],
] as const)("uses concurrent checkpointing only on compatible SQLite %s", (version, expected) => {
  assert.equal(DatabaseCheckpoint.supportsBackgroundCheckpoint(version), expected);
});

it.effect("restores automatic maintenance if the checkpoint worker disconnects", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA wal_autocheckpoint = 0`;
    const error = new SqlError({
      reason: new ConnectionError({ cause: { exitCode: 1 }, message: "worker exited" }),
    });
    const exit = yield* DatabaseCheckpoint.handleCheckpointError(sql)(error).pipe(Effect.exit);
    assert.equal(exit._tag, "Failure");
    assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`, [{ wal_autocheckpoint: 1000 }]);
    yield* sql`CREATE TABLE recovered(value TEXT)`;
    yield* sql`INSERT INTO recovered VALUES ('committed')`;
    assert.deepEqual(yield* sql`SELECT value FROM recovered`, [{ value: "committed" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerWorker({ filename: ":memory:" }))),
);
