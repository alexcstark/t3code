import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { deleteImportedV1Rows } from "../orchestration-v2/legacy/LegacyV1Prune.ts";

// Removes history nothing can read any more: events superseded by a newer
// copy of the same state, and V1 rows of threads whose transcript was imported
// into V2. Rows are deleted, not the file shrunk; `t3 db compact` follows this
// with VACUUM while the server is stopped.

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

// Thread-state events whose payload is the complete thread: only the
// newest per thread can influence a replay or an afterSequence catch-up.
// thread.created stays out — verify derives the expected thread set from
// it, and it anchors replay ordering.
const SUPERSEDABLE_THREAD_EVENT_TYPES = [
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.auto-settle-set",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.metadata-updated",
  "thread.pull-request-synced",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "thread.visited",
  "thread.marked-unread",
];

const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
const COMPACTION_PAGE_SIZE = 500;

/**
 * Scan newest first to retain the newest state for each entity.
 * Page every event, including non-candidates: filtering before LIMIT could
 * still scan the entire history when superseded events are sparse.
 * turn-item.updated stays intact because replay assigns positions on first write.
 */
export const compactDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bounds = yield* sql<{
    readonly event_sequence: number;
    readonly receipt_row_id: number;
  }>`
    SELECT
      COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
      COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
  `;
  let throughSequence = bounds[0]?.event_sequence ?? 0;
  let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
  const retainedThreadIds = new Set<string>();
  const retainedEntityKeys = new Set<string>();
  let deletedEventCount = 0;
  let deletedReceiptCount = 0;

  while (throughSequence > 0) {
    const rows = yield* sql<{
      readonly sequence: number;
      readonly application_event_version: number;
      readonly aggregate_kind: string;
      readonly stream_id: string;
      readonly event_type: string;
      readonly entity_id: string | null;
      readonly imported_legacy_thread: number;
    }>`
      SELECT
        event.sequence,
        event.application_event_version,
        event.aggregate_kind,
        event.stream_id,
        event.event_type,
        CASE
          WHEN event.application_event_version = 2
            AND event.event_type IN ('message.updated', 'node.updated')
          THEN json_extract(event.payload_json, '$.id')
          ELSE NULL
        END AS entity_id,
        CASE
          WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
          THEN EXISTS (
            SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
            WHERE legacy_import.thread_id = event.stream_id
              AND legacy_import.transcript_imported_at IS NOT NULL
          )
          ELSE 0
        END AS imported_legacy_thread
      FROM orchestration_events AS event
      WHERE event.sequence <= ${throughSequence}
      ORDER BY event.sequence DESC
      LIMIT ${COMPACTION_PAGE_SIZE}
    `;
    const obsolete: number[] = [];
    for (const row of rows) {
      if (row.imported_legacy_thread === 1) {
        obsolete.push(row.sequence);
      } else if (row.application_event_version === 2) {
        if (row.aggregate_kind === "thread" && supersedableThreadEventTypes.has(row.event_type)) {
          if (retainedThreadIds.has(row.stream_id)) obsolete.push(row.sequence);
          else retainedThreadIds.add(row.stream_id);
        } else if (row.event_type === "message.updated" || row.event_type === "node.updated") {
          const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
          if (retainedEntityKeys.has(key)) obsolete.push(row.sequence);
          else retainedEntityKeys.add(key);
        }
      }
    }
    // Yield between bounded pages so other database requests can progress,
    // including when this page has nothing to delete.
    yield* Effect.yieldNow;
    if (obsolete.length > 0) {
      yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
      deletedEventCount += obsolete.length;
      yield* Effect.yieldNow;
    }
    throughSequence = (rows.at(-1)?.sequence ?? 1) - 1;
    if (rows.length < COMPACTION_PAGE_SIZE) break;
  }

  // Legacy receipts are removable only after their thread's v1 import finishes.
  // Page by rowid before checking eligibility, as with event discovery above.
  while (throughReceiptRowId > 0) {
    const rows = yield* sql<{
      readonly row_id: number;
      readonly command_id: string;
      readonly imported_legacy_thread: number;
    }>`
      SELECT
        receipt.rowid AS row_id,
        receipt.command_id,
        CASE
          WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
          THEN EXISTS (
            SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
            WHERE legacy_import.thread_id = receipt.aggregate_id
              AND legacy_import.transcript_imported_at IS NOT NULL
          )
          ELSE 0
        END AS imported_legacy_thread
      FROM orchestration_command_receipts AS receipt
      WHERE receipt.rowid <= ${throughReceiptRowId}
      ORDER BY receipt.rowid DESC
      LIMIT ${COMPACTION_PAGE_SIZE}
    `;
    const obsolete = rows
      .filter((row) => row.imported_legacy_thread === 1)
      .map((row) => row.command_id);
    yield* Effect.yieldNow;
    if (obsolete.length > 0) {
      yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
      deletedReceiptCount += obsolete.length;
      yield* Effect.yieldNow;
    }
    throughReceiptRowId = (rows.at(-1)?.row_id ?? 1) - 1;
    if (rows.length < COMPACTION_PAGE_SIZE) break;
  }

  const deletedLegacyRowCount = yield* deleteImportedV1Rows;

  const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const reclaimableBytes =
    (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

  return { deletedEventCount, deletedReceiptCount, deletedLegacyRowCount, reclaimableBytes };
});
