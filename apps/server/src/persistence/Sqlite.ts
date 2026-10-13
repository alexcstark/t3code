import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import * as DatabaseReader from "./DatabaseReader.ts";
import * as DatabaseCheckpoint from "./DatabaseCheckpoint.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // NORMAL avoids syncing every commit when the disk is busy. WAL remains
    // corruption-safe, but an OS crash can drop the last few commits.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
  }),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  const writer = Layer.provideMerge(
    layerSetup,
    NodeSqliteClient.layerWorker({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
  const maintenance = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ version: string }>`SELECT sqlite_version() AS version`;
      // SQLite 3.51.3 fixes the concurrent WAL-reset corruption race and
      // supports NOOP checkpoints. Older Node runtimes retain auto-checkpoint.
      // https://sqlite.org/wal.html#walreset
      if (row === undefined || !DatabaseCheckpoint.supportsBackgroundCheckpoint(row.version)) {
        yield* Effect.logWarning("sqlite.background-checkpoint.unavailable", {
          sqliteVersion: row?.version,
        });
        return;
      }
      // Build the checkpointer before disabling the writer's fallback. Migrations
      // keep SQLite's default auto-checkpoint while they run during setup.
      yield* Layer.build(DatabaseCheckpoint.layerFile(dbPath, sql));
      yield* sql`PRAGMA wal_autocheckpoint = 0`;
    }),
  ).pipe(Layer.provide(writer));
  return Layer.mergeAll(
    writer,
    maintenance,
    DatabaseReader.layerFile(dbPath).pipe(Layer.provide(writer)),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
