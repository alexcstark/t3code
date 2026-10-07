import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isProcessAlive } from "./serverRuntimeState.ts";

export const ServerSingletonLockState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  startedAt: Schema.String,
});
type ServerSingletonLockState = typeof ServerSingletonLockState.Type;

export class ServerSingletonLockConflict extends Schema.TaggedError<ServerSingletonLockConflict>()(
  "ServerSingletonLockConflict",
  {
    lockPath: Schema.String,
    holderPid: Schema.Int,
    reason: Schema.Literals(["already_running", "unmanaged_server_during_update"]),
  },
) {
  override get message(): string {
    const base =
      this.reason === "already_running"
        ? `Another T3 server (pid ${this.holderPid}) is already running against this home.`
        : `An unmanaged T3 server (pid ${this.holderPid}) is running against this home; stop it before updating.`;
    return `${base} Stop it, or remove ${this.lockPath} if it is stale.`;
  }
}

const encodeLockState = Schema.encodeSync(Schema.fromJsonString(ServerSingletonLockState));
const decodeLockState = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSingletonLockState));

const readHolder = (lockPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* Effect.option(fs.readFileString(lockPath));
    if (Option.isNone(contents)) return undefined;
    // An undecodable lock is not proof of a live holder; treat it as stale.
    const state = yield* Effect.option(decodeLockState(contents.value));
    return Option.isSome(state) ? state.value.pid : undefined;
  });

const writeOurs = (lockPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const startedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const state: ServerSingletonLockState = { version: 1, pid: process.pid, startedAt };
    const file = yield* fs.open(lockPath, { flag: "wx", mode: 0o600 });
    yield* file.writeAll(new TextEncoder().encode(`${encodeLockState(state)}\n`));
  }).pipe(Effect.scoped);

const isAlreadyExists = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  (cause as { readonly reason?: { readonly _tag?: string } }).reason?._tag === "AlreadyExists";

const conflictFor = (lockPath: string, holderPid: number, launcherManaged: boolean) =>
  new ServerSingletonLockConflict({
    lockPath,
    holderPid,
    reason: launcherManaged ? "unmanaged_server_during_update" : "already_running",
  });

/**
 * One server per home. Two servers over one base-dir split every piece of
 * in-memory state (thread projections, MCP credential registry) while sharing
 * the sqlite file, and an update trial migrating the schema under a still
 * running orphan is what strands sessions with `No conversation found`.
 *
 * The service launcher serializes its own active/trial children itself, so
 * launcher-managed children never take the lock — but they refuse to start
 * when some other, unmanaged server holds it, because a version trial would
 * migrate the database out from under that server.
 */
export const acquireServerSingletonLock = (input: {
  readonly lockPath: string;
  readonly launcherManaged: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const created = yield* Effect.exit(writeOurs(input.lockPath));
    if (Exit.isSuccess(created)) return;
    const cause = Cause.squash(created.cause);
    if (!isAlreadyExists(cause)) return yield* Effect.die(cause);

    const holderPid = yield* readHolder(input.lockPath);
    if (holderPid !== undefined && isProcessAlive(holderPid)) {
      return yield* conflictFor(input.lockPath, holderPid, input.launcherManaged);
    }
    // Stale holder (crashed server, or an undecodable file left behind):
    // reclaim once; a concurrent winner makes the retry fail as occupied.
    yield* fs.remove(input.lockPath, { force: true });
    const retried = yield* Effect.exit(writeOurs(input.lockPath));
    if (Exit.isSuccess(retried)) return;
    const retryCause = Cause.squash(retried.cause);
    if (!isAlreadyExists(retryCause)) return yield* Effect.die(retryCause);
    const winnerPid = yield* readHolder(input.lockPath);
    if (winnerPid !== undefined && isProcessAlive(winnerPid)) {
      return yield* conflictFor(input.lockPath, winnerPid, input.launcherManaged);
    }
    return yield* Effect.die(retryCause);
  });

/**
 * Releases the lock only when it is still ours, so a lock reclaimed by a
 * successor after our death is never deleted by our own shutdown.
 */
export const releaseServerSingletonLock = (lockPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const holderPid = yield* readHolder(lockPath);
    if (holderPid === process.pid) {
      yield* fs.remove(lockPath, { force: true });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to release server singleton lock", { cause, lockPath }),
    ),
  );

/** Exposed for tests. */
export const __testing = {
  /** Runs `body` with a fresh lock path in a temp directory. */
  withTempLockPath: <A, E, R>(body: (lockPath: string) => Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-singleton-lock-" });
        return yield* body(path.join(dir, "server.lock"));
      }),
    ),
  /** Writes a lock state as if a server with `pid` had started. */
  writeLockState: (lockPath: string, pid: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state: ServerSingletonLockState = {
        version: 1,
        pid,
        startedAt: "2026-09-09T00:00:00.000Z",
      };
      yield* fs.writeFileString(lockPath, `${encodeLockState(state)}\n`);
    }),
};
