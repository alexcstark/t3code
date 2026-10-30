import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Messages are the only retained V1 transcript projection. Once imported,
// `transcript_imported_at` is never reset, so these rows are dead.
const DELETE_BATCH_SIZE = 5_000;

/** Deletes V1 messages of threads whose transcript was imported. Returns the row count. */
export const deleteImportedV1Rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let deletedCount = 0;
  while (true) {
    const deleted = yield* sql<{ readonly deleted: number }>`
      DELETE FROM projection_thread_messages WHERE rowid IN (
        SELECT rowid FROM projection_thread_messages
        WHERE thread_id IN (
          SELECT thread_id FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NOT NULL
        )
        LIMIT ${DELETE_BATCH_SIZE}
      ) RETURNING 1 AS deleted
    `;
    deletedCount += deleted.length;
    yield* Effect.yieldNow;
    if (deleted.length < DELETE_BATCH_SIZE) break;
  }
  return deletedCount;
});
