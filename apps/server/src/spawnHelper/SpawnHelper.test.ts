// @effect-diagnostics nodeBuiltinImport:off -- exercises the real subprocess adapter boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";

import * as ProcessRunner from "../processRunner.ts";
import * as SpawnHelper from "./SpawnHelper.ts";
import { SPAWN_HELPER_COMMAND } from "./SpawnHelperMain.ts";

const launch = {
  command: process.execPath,
  args: [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), SPAWN_HELPER_COMMAND],
};

// The real entry and fast path the server uses, run by this Node.
const layer = ProcessRunner.layer.pipe(
  Layer.provideMerge(SpawnHelper.layerFromLaunch(launch)),
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

  it.live.each(["completion", "helper death"] as const)(
    "bounds unread output and waits for child input writes through %s",
    (ending) =>
      Effect.promise(async () => {
        const helper = SpawnHelper.makeHelperSpawn(launch);
        try {
          const child = helper.spawn(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              `
          import { Socket } from "node:net";
          process.stdout.write(Buffer.alloc(1024 * 1024));
          const side = new Socket({ fd: 4 });
          side.write("side");
          side.unref();
          process.stderr.write(String(process.ppid));
          const gate = new Socket({ fd: 3 });
          gate.once("data", () => {
            gate.destroy();
            process.stdin.pipe(process.stdout);
          });
        `,
            ],
            { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], detached: false },
          );
          await NodeEvents.EventEmitter.once(child, "spawn");
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
          const [ready] = await NodeEvents.EventEmitter.once(child.stderr!, "data");
          let written = false;
          const input = new Promise<Error | null>((resolve) => {
            child.stdin!.write(Buffer.alloc(1024 * 1024), (error) => {
              written = true;
              resolve(error ?? null);
            });
          });
          const probe = helper.spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
          await NodeEvents.EventEmitter.once(probe, "exit");
          expect(child.stdout!.readableLength).toBeLessThanOrEqual(64 * 1024);
          expect(written).toBe(false);
          const consume = async (stream: import("node:stream").Readable) => {
            let bytes = 0;
            for await (const chunk of stream) bytes += chunk.length;
            return bytes;
          };
          const output = Promise.allSettled([
            consume(child.stdout!),
            consume(child.stdio[4] as import("node:stream").Readable),
          ]);
          const exited = NodeEvents.EventEmitter.once(child, "exit");
          if (ending === "completion") {
            child.stdin!.end();
            (child.stdio[3] as import("node:stream").Writable).end("go");
            expect(await input).toBeNull();
            expect(await output).toEqual([
              { status: "fulfilled", value: 2 * 1024 * 1024 },
              { status: "fulfilled", value: 4 },
            ]);
            await exited;
            expect(child.exitCode).toBe(0);
            expect(child.signalCode).toBeNull();
          } else {
            process.kill(Number(String(ready)), "SIGKILL");
            expect(await input).toBeInstanceOf(Error);
            expect((await output).map((result) => result.status)).toEqual(["rejected", "rejected"]);
            await exited;
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBe("SIGKILL");
            expect(child.stdio[4]?.destroyed).toBe(true);
            const lateWrite = await new Promise<Error | null>((resolve) => {
              child.stdin!.write("late", (error) => resolve(error ?? null));
            });
            expect(lateWrite).toBeInstanceOf(Error);
          }
        } finally {
          helper.stop();
        }
      }),
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

  it.live.each([
    { command: "/nonexistent/spawn-helper", args: [] },
    { command: process.execPath, args: ["--eval", "process.exit(1)"] },
  ])("spawns directly after a helper cannot start: $command $args", (brokenLaunch) =>
    Effect.gen(function* () {
      yield* run({ command: "sh", args: ["-c", "echo first"] }).pipe(Effect.exit);
      const result = yield* run({ command: "sh", args: ["-c", "echo $PPID"] });
      expect(Number(result.stdout.trim())).toBe(process.pid);
    }).pipe(
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provideMerge(SpawnHelper.layerFromLaunch(brokenLaunch)),
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
