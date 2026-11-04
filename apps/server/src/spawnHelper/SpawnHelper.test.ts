import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeURL from "node:url";

import * as ProcessRunner from "../processRunner.ts";
import * as SpawnHelper from "./SpawnHelper.ts";
import { SPAWN_HELPER_COMMAND } from "./SpawnHelperMain.ts";

// The real entry and fast path the server uses, run by this Node.
const layer = ProcessRunner.layer.pipe(
  Layer.provideMerge(
    SpawnHelper.layerFromLaunch({
      command: process.execPath,
      args: [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), SPAWN_HELPER_COMMAND],
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const run = (input: ProcessRunner.ProcessRunInput) =>
  Effect.flatMap(ProcessRunner.ProcessRunner, (runner) => runner.run(input));

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SpawnHelper", () => {
  it.live("starts children in the helper and returns their output and exit code", () =>
    Effect.gen(function* () {
      const result = yield* run({
        command: "sh",
        args: ["-c", "echo $PPID; echo problem >&2; exit 3"],
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toBe("problem\n");
      const parentPid = Number(result.stdout.trim());
      expect(parentPid).toBeGreaterThan(0);
      expect(parentPid).not.toBe(process.pid);
    }).pipe(Effect.provide(layer)),
  );

  it.live("writes stdin through to the child", () =>
    Effect.gen(function* () {
      const result = yield* run({ command: "cat", args: [], stdin: "through the helper" });
      expect(result.stdout).toBe("through the helper");
    }).pipe(Effect.provide(layer)),
  );

  it.live("relays every byte from many children started at once", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        Array.from({ length: 40 }, (_, index) => index),
        (index) => run({ command: "sh", args: ["-c", `printf 'child-${index}'; exit 0`] }),
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result.stdout)).toEqual(
        Array.from({ length: 40 }, (_, index) => `child-${index}`),
      );
      const large = yield* run({
        command: "head",
        args: ["-c", "1048576", "/dev/zero"],
        maxOutputBytes: 2 * 1024 * 1024,
      });
      expect(large.stdout.length).toBe(1048576);
    }).pipe(Effect.provide(layer)),
  );

  it.live("kills a child that outlives its timeout", () =>
    Effect.gen(function* () {
      const result = yield* run({
        command: "sleep",
        args: ["30"],
        timeout: "200 millis",
        timeoutBehavior: "timedOutResult",
      });
      expect(result.timedOut).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.live("spawns directly when the helper cannot launch", () =>
    Effect.gen(function* () {
      const result = yield* run({ command: "sh", args: ["-c", "echo $PPID"] });
      expect(Number(result.stdout.trim())).toBe(process.pid);
    }).pipe(
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provideMerge(
            SpawnHelper.layerFromLaunch({ command: "/nonexistent/spawn-helper", args: [] }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("ends in-flight children when the helper dies, then starts a new helper", () =>
    Effect.gen(function* () {
      const helperPid = yield* Deferred.make<number>();
      const stranded = yield* run({
        command: "sh",
        args: ["-c", "echo $PPID; exec sleep 30"],
        onStdoutChunk: (chunk) =>
          Deferred.doneUnsafe(
            helperPid,
            Effect.succeed(Number(new TextDecoder().decode(chunk).trim())),
          ),
      }).pipe(Effect.forkChild);
      process.kill(yield* Deferred.await(helperPid), "SIGKILL");
      yield* Fiber.join(stranded).pipe(Effect.exit);

      const result = yield* run({ command: "sh", args: ["-c", "echo $PPID"] });
      expect(Number(result.stdout.trim())).not.toBe(yield* Deferred.await(helperPid));
    }).pipe(Effect.provide(layer)),
  );
});
