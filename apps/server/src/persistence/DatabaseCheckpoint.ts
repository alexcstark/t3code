import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const CHECKPOINT_INTERVAL = "1 second";
const CHECKPOINT_PAGES = 1000;

/** Older SQLite versions have a WAL-reset race when checkpointing concurrently. */
export const supportsBackgroundCheckpoint = (version: string) => {
  const [major, minor, patch] = version.split(".").map(Number);
  return (
    major !== undefined &&
    minor !== undefined &&
    patch !== undefined &&
    (major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))))
  );
};

/** Capture a separate connection so checkpoint fsync never leases the writer. */
export const makeFileCheckpoint = (filename: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      NodeSqliteClient.layerWorker({
        filename,
        spanAttributes: { "db.connection.role": "checkpoint" },
      }),
    );
    const checkpoint = Context.get(context, SqlClient.SqlClient);
    yield* checkpoint`PRAGMA busy_timeout = 0`;
    yield* checkpoint`PRAGMA synchronous = NORMAL`;
    yield* checkpoint`PRAGMA wal_autocheckpoint = 0`;
    let retryPending = false;

    // PASSIVE copies only frames safe for current readers and never waits for
    // their locks. A pinned snapshot is retried on the next tick.
    // @effect-diagnostics-next-line returnEffectInGen:off -- Return the maintenance effect with its connection captured.
    return Effect.gen(function* () {
      // File size includes reused frames. NOOP reports actual pending frames
      // without copying or syncing, and idle checks do not fill the trace log.
      const [wal] = yield* checkpoint<{ log: number; checkpointed: number }>`
        PRAGMA wal_checkpoint(NOOP)
      `.pipe(Effect.withTracerEnabled(false));
      if (wal === undefined || wal.log <= wal.checkpointed) {
        retryPending = false;
        return;
      }
      if (!retryPending && wal.log - wal.checkpointed < CHECKPOINT_PAGES) return;
      yield* Effect.gen(function* () {
        const [result] = yield* checkpoint<{
          busy: number;
          log: number;
          checkpointed: number;
        }>`PRAGMA wal_checkpoint(PASSIVE)`;
        if (result !== undefined) {
          retryPending = result.busy !== 0 || result.log > result.checkpointed;
          yield* Effect.annotateCurrentSpan({
            "sqlite.wal.busy": result.busy,
            "sqlite.wal.frames": result.log,
            "sqlite.wal.checkpointed": result.checkpointed,
          });
        }
      }).pipe(Effect.withSpan("sqlite.checkpoint"));
    });
  });

export const layerWith = <E, R>(
  makeCheckpoint: Effect.Effect<Effect.Effect<void, E>, E, R | Scope.Scope>,
  onFailure: (error: E) => Effect.Effect<void> = (error) =>
    Effect.logWarning("sqlite.checkpoint.failed", { error }),
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const checkpoint = yield* makeCheckpoint;
      yield* Effect.sleep(CHECKPOINT_INTERVAL).pipe(
        Effect.andThen(checkpoint.pipe(Effect.catch(onFailure))),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );

export const handleCheckpointError = (writer: SqlClient.SqlClient) => (error: SqlError) => {
  // Another process may already be checkpointing. Retry on the next tick.
  if (error.reason._tag === "LockTimeoutError") return Effect.void;
  if (error.reason._tag !== "ConnectionError") {
    return Effect.logWarning("sqlite.checkpoint.failed", { error });
  }
  // A dead worker cannot recover by retrying its connection. Restore SQLite's
  // automatic maintenance before stopping this fiber, so WAL growth stays bounded.
  return writer`PRAGMA wal_autocheckpoint = 1000`.pipe(
    Effect.orDie,
    Effect.andThen(Effect.logWarning("sqlite.background-checkpoint.disconnected", { error })),
    Effect.andThen(Effect.interrupt),
  );
};

export const layerFile = (filename: string, writer: SqlClient.SqlClient) =>
  layerWith(makeFileCheckpoint(filename), handleCheckpointError(writer));
