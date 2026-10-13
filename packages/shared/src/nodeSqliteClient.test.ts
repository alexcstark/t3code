import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerWorker({ filename: ":memory:" }));

it.effect("reports a disconnected worker as a connection failure", () => {
  let worker: NodeWorkerThreads.Worker | undefined;
  const postMessage = NodeWorkerThreads.Worker.prototype.postMessage;
  const spy = vi
    .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
    .mockImplementation(function (this: NodeWorkerThreads.Worker, message, transferList) {
      // oxlint-disable-next-line typescript/no-this-alias -- Capture only the worker owned by this test for termination.
      worker = this;
      postMessage.call(this, message, transferList);
    });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    spy.mockRestore();
    const captured = worker;
    assert(captured !== undefined);
    yield* Effect.promise(() => captured.terminate());
    const error = yield* sql`SELECT 1`.pipe(Effect.flip);
    assert.equal(error.reason._tag, "ConnectionError");
  }).pipe(
    Effect.provide(SqliteClient.layerWorker({ filename: ":memory:" })),
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
});

it.effect.each([false, true])(
  "preserves SQLITE_FULL after an automatic rollback (nested=%s)",
  (nested) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value BLOB)`;
      const [pageCount] = yield* sql<{
        page_count: number;
      }>`PRAGMA page_count`;
      assert(pageCount);
      yield* sql.unsafe(`PRAGMA max_page_count = ${pageCount.page_count}`);
      const insert = sql`INSERT INTO entries VALUES (zeroblob(1000000))`;
      const exit = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries VALUES ('rolled back')`;
            yield* nested ? sql.withTransaction(insert) : insert;
          }),
        ),
      );
      assert(exit._tag === "Failure");
      assert.equal(exit.cause.reasons.length, 1);
      const reason = exit.cause.reasons[0];
      assert(reason?._tag === "Fail");
      const error = reason.error;
      assert.equal(error._tag, "SqlError");
      assert.propertyVal(error.reason.cause, "errcode", 13);
      assert.deepEqual(yield* sql`SELECT value FROM entries`, []);

      yield* sql`PRAGMA max_page_count = 1000`;
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES ('recovered')`);
      assert.deepEqual(yield* sql`SELECT value FROM entries`, [{ value: "recovered" }]);
    }).pipe(Effect.provide(SqliteClient.layerWorker({ filename: ":memory:" }))),
);

it.effect("rolls back a failed commit before releasing the connection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`CREATE TABLE parents(id INTEGER PRIMARY KEY)`;
    yield* sql`CREATE TABLE children(parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)`;
    const failed = yield* Effect.exit(sql.withTransaction(sql`INSERT INTO children VALUES (1)`));
    assert.equal(failed._tag, "Failure");
    assert.deepEqual(yield* sql`SELECT parent_id FROM children`, []);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO parents VALUES (1)`;
        yield* sql`INSERT INTO children VALUES (1)`;
      }),
    );
    assert.deepEqual(yield* sql`SELECT parent_id FROM children`, [{ parent_id: 1 }]);
  }).pipe(Effect.provide(SqliteClient.layerWorker({ filename: ":memory:" }))),
);

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps the main thread responsive while SQLite waits for another writer", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 1000`;
      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const write = yield* sql`UPDATE counters SET value = 1 WHERE id = 1`.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      // Releasing this lock requires the main thread to run while SQLite is waiting.
      yield* Effect.sync(() => other.exec("ROLLBACK"));
      yield* Fiber.join(write);
      assert.deepEqual(yield* sql`SELECT value FROM counters`.values, [[1]]);
    }).pipe(Effect.provide(SqliteClient.layerWorker({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps an outside write out of a transaction that rolls back", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE isolated_entries(value TEXT)`;
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const transaction = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO isolated_entries VALUES ('inside')`;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finish);
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const outside = yield* sql`INSERT INTO isolated_entries VALUES ('outside')`.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(finish, undefined);
    assert.equal((yield* Fiber.join(transaction))._tag, "Failure");
    yield* Fiber.join(outside);
    assert.deepEqual(yield* sql`SELECT value FROM isolated_entries`, [{ value: "outside" }]);
  }).pipe(Effect.provide(SqliteClient.layerWorker({ filename: ":memory:" }))),
);

it.effect("rolls back an interrupted transaction before reusing the worker connection", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 1000`;
      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const transaction = yield* sql
        .withTransaction(sql`UPDATE counters SET value = 10 WHERE id = 1`)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const interrupt = yield* Fiber.interrupt(transaction).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.sync(() => other.exec("ROLLBACK"));
      yield* Fiber.join(interrupt);
      const exit = yield* Fiber.await(transaction);
      assert(exit._tag === "Failure");
      assert(Cause.hasInterruptsOnly(exit.cause));
      assert.deepEqual(yield* sql`SELECT value FROM counters`.values, [[0]]);
      yield* sql.withTransaction(sql`UPDATE counters SET value = 1 WHERE id = 1`);
      assert.deepEqual(yield* sql`SELECT value FROM counters`.values, [[1]]);
    }).pipe(Effect.provide(SqliteClient.layerWorker({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves blobs, integer modes, raw results and row transforms across the worker", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE encoded_entries(id INTEGER PRIMARY KEY, payload BLOB)`;
    const payload = new Uint8Array([0, 128, 255]);
    const raw = yield* sql`INSERT INTO encoded_entries(payload) VALUES (${payload})`.raw;
    assert.deepEqual(raw, { changes: 1, lastInsertRowid: 1 });
    const select = sql`SELECT id AS entry_id, payload FROM encoded_entries`;
    assert.deepEqual(yield* select, [{ entryId: 1, payload }]);
    assert.deepEqual(yield* select.values, [[1, payload]]);
    assert.deepEqual(
      yield* select.values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
      [[1n, payload]],
    );
    assert.deepEqual(yield* select, [{ entryId: 1, payload }]);
    assert.deepEqual(yield* sql`SELECT 1 AS repeated, 2 AS repeated`.values, [[1, 2]]);
  }).pipe(
    Effect.provide(
      SqliteClient.layerWorker({
        filename: ":memory:",
        transformResultNames: (name) =>
          name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      }),
    ),
  ),
);

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layerWorker({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layerWorker({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layerWorker({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layerWorker({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);
