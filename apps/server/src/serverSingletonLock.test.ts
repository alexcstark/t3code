import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import {
  acquireServerSingletonLock,
  releaseServerSingletonLock,
  ServerSingletonLockConflict,
  __testing,
} from "./serverSingletonLock.ts";

const conflictFrom = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as E) : undefined;

const withNodeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

/** A pid no host allocates in practice; stands in for a crashed holder. */
const DEAD_PID = 999_999_999;

it.effect("a second server on the same home refuses with the holder pid", () =>
  withNodeServices(
    __testing.withTempLockPath((lockPath) =>
      Effect.gen(function* () {
        yield* acquireServerSingletonLock({ lockPath, launcherManaged: false });
        const second = yield* Effect.exit(
          acquireServerSingletonLock({ lockPath, launcherManaged: false }),
        );
        expect(Exit.isFailure(second)).toBe(true);
        const error = conflictFrom(second);
        expect(error).toBeInstanceOf(ServerSingletonLockConflict);
        expect((error as ServerSingletonLockConflict).holderPid).toBe(process.pid);
        expect((error as ServerSingletonLockConflict).reason).toBe("already_running");
        yield* releaseServerSingletonLock(lockPath);
      }),
    ),
  ),
);

it.effect("a stale lock from a dead server is reclaimed", () =>
  withNodeServices(
    __testing.withTempLockPath((lockPath) =>
      Effect.gen(function* () {
        yield* __testing.writeLockState(lockPath, DEAD_PID);
        const acquired = yield* Effect.exit(
          acquireServerSingletonLock({ lockPath, launcherManaged: false }),
        );
        expect(Exit.isSuccess(acquired)).toBe(true);
        yield* releaseServerSingletonLock(lockPath);
      }),
    ),
  ),
);

it.effect("a launcher-managed child refuses when an unmanaged server holds the home", () =>
  withNodeServices(
    __testing.withTempLockPath((lockPath) =>
      Effect.gen(function* () {
        yield* acquireServerSingletonLock({ lockPath, launcherManaged: false });
        const trial = yield* Effect.exit(
          acquireServerSingletonLock({ lockPath, launcherManaged: true }),
        );
        expect(Exit.isFailure(trial)).toBe(true);
        const error = conflictFrom(trial);
        expect(error).toBeInstanceOf(ServerSingletonLockConflict);
        expect((error as ServerSingletonLockConflict).reason).toBe(
          "unmanaged_server_during_update",
        );
        yield* releaseServerSingletonLock(lockPath);
      }),
    ),
  ),
);

it.effect("release keeps a successor's lock intact", () =>
  withNodeServices(
    __testing.withTempLockPath((lockPath) =>
      Effect.gen(function* () {
        yield* __testing.writeLockState(lockPath, DEAD_PID);
        yield* releaseServerSingletonLock(lockPath);
        const fs = yield* FileSystem.FileSystem;
        const stillHeld = yield* Effect.option(fs.readFileString(lockPath));
        expect(stillHeld).toBeDefined();
      }),
    ),
  ),
);
