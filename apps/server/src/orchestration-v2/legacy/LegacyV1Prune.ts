import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The V1 read model is read only to import a thread's transcript, and
// `transcript_imported_at` is never reset, so an imported thread's rows are dead.
const LEGACY_V1_PROJECTION_TABLES = [
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_turns",
  "projection_thread_proposed_plans",
] as const;
// Bounded batches keep each transaction, and the -wal file, small.
const DELETE_BATCH_SIZE = 5_000;

/** Deletes V1 projection rows of threads whose transcript was imported. Returns the row count. */
export const deleteImportedV1Rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let deletedCount = 0;
  for (const table of LEGACY_V1_PROJECTION_TABLES) {
    while (true) {
      const deleted = yield* sql.unsafe<{ readonly deleted: number }>(
        `DELETE FROM ${table} WHERE rowid IN (
          SELECT rowid FROM ${table}
          WHERE thread_id IN (
            SELECT thread_id FROM orchestration_v2_legacy_imports
            WHERE transcript_imported_at IS NOT NULL
          )
          LIMIT ${DELETE_BATCH_SIZE}
        ) RETURNING 1 AS deleted`,
      );
      deletedCount += deleted.length;
      yield* Effect.yieldNow;
      if (deleted.length < DELETE_BATCH_SIZE) break;
    }
  }
  return deletedCount;
});
