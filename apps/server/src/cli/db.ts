/**
 * `t3 db compact` - deletes history nothing reads any more and shrinks the
 * database file. VACUUM rewrites the whole file under an exclusive lock, so it
 * runs only while the server is stopped; the server's own lock enforces that.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Command } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { compactDatabase } from "../persistence/CompactDatabase.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { acquireServerSingletonLock, releaseServerSingletonLock } from "../serverSingletonLock.ts";
import { baseDirFlag } from "./config.ts";

const formatGigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

const dbCompactCommand = Command.make("compact", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Delete superseded and already-imported history, then shrink the database. Stop the server first.",
  ),
  Command.withHandler(
    Effect.fn("cli.db.compact")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const { stateDir, dbPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      if (!(yield* fs.exists(dbPath))) {
        return yield* Console.log(`No database at ${dbPath}.`);
      }
      const lockPath = `${stateDir}/server.lock`;
      yield* Effect.acquireRelease(
        acquireServerSingletonLock({ lockPath, launcherManaged: false }),
        () => releaseServerSingletonLock(lockPath),
      );

      const sizeBefore = Number((yield* fs.stat(dbPath)).size);
      yield* Console.log(`Compacting ${dbPath} (${formatGigabytes(sizeBefore)}).`);
      const summary = yield* Effect.gen(function* () {
        const summary = yield* compactDatabase;
        const sql = yield* SqlClient.SqlClient;
        yield* Console.log("Shrinking the file. This rewrites it and can take several minutes.");
        yield* sql`VACUUM`;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        return summary;
      }).pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
      const sizeAfter = Number((yield* fs.stat(dbPath)).size);

      yield* Console.log(
        [
          `Deleted ${summary.deletedEventCount} superseded events, ${summary.deletedReceiptCount} command receipts, and ${summary.deletedLegacyRowCount} imported V1 rows.`,
          `Database: ${formatGigabytes(sizeBefore)} -> ${formatGigabytes(sizeAfter)}.`,
        ].join("\n"),
      );
    }, Effect.scoped),
  ),
);

export const dbCommand = Command.make("db").pipe(
  Command.withDescription("Maintain the local server database."),
  Command.withSubcommands([dbCompactCommand]),
);
