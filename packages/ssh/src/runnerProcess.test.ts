import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeNet from "node:net";

import { remoteStateKey } from "./command.ts";
import { buildRemoteStopScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

const Started = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  args: Schema.Array(Schema.String),
});
const decodeStarted = Schema.decodeUnknownSync(Schema.fromJsonString(Started));

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote runner process ownership",
  () => {
    it.live("keeps the server PID and graceful shutdown through the node-script runner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-" });
        const bin = path.join(fixture, "bin");
        const cliPath = path.join(fixture, "installed cli.mjs");
        yield* fs.makeDirectory(bin);
        yield* fs.symlink(process.execPath, path.join(bin, "node"));
        yield* fs.writeFileString(
          cliPath,
          `#!/usr/bin/env node
import * as net from "node:net";
const server = net.createServer((socket) => {
  socket.end();
  server.close();
});
process.on("SIGTERM", () => server.close(() => {
  process.stdout.write("graceful shutdown\\n");
}));
server.listen(Number(process.env.T3_TEST_PORT ?? 0), "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    args: process.argv.slice(2),
  }) + "\\n");
});
`,
        );
        yield* fs.chmod(cliPath, 0o700);

        const runServer = (port = 0) =>
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-s", "--", "serve", "a path with spaces"], {
                cwd: fixture,
                env: {
                  PATH: bin,
                  T3_TEST_PORT: String(port),
                },
                detached: false,
                stdin: Stream.make(
                  new TextEncoder().encode(buildRemoteT3RunnerScript({ nodeScriptPath: cliPath })),
                ),
              }),
            );
            const ready = yield* Deferred.make<typeof Started.Type>();
            const stdout: string[] = [];
            const output = yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.gen(function* () {
                  stdout.push(line);
                  if (stdout.length === 1) {
                    yield* Deferred.succeed(ready, decodeStarted(line));
                  }
                }),
              ),
              Effect.forkScoped,
            );
            const stderr = yield* child.stderr.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.forkScoped,
            );
            const receipt = yield* Effect.raceFirst(
              Deferred.await(ready),
              Fiber.join(output).pipe(
                Effect.flatMap(() => Fiber.join(stderr)),
                Effect.flatMap((message) =>
                  Effect.die(new Error(`Runner exited before listening: ${message}`)),
                ),
              ),
            );
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (yield* child.isRunning) {
                  yield* Effect.callback<void>((resume) => {
                    const connection = NodeNet.connect(receipt.port, "127.0.0.1");
                    connection.on("error", () => undefined);
                    connection.once("close", () => resume(Effect.void));
                    return Effect.sync(() => connection.destroy());
                  });
                  yield* child.exitCode;
                }
              }).pipe(Effect.orDie),
            );
            assert.equal(receipt.pid, child.pid);
            assert.deepEqual(receipt.args, ["serve", "a path with spaces"]);
            yield* child.kill({ killSignal: "SIGTERM" });
            assert.equal(yield* child.exitCode, 0);
            yield* Fiber.join(output);
            assert.include(stdout, "graceful shutdown");
            return receipt.port;
          }).pipe(Effect.scoped);

        const port = yield* runServer();
        assert.equal(yield* runServer(port), port);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote stop process ownership",
  () => {
    it.live.each(["graceful", "timeout", "external", "reused-pid", "legacy"] as const)(
      "confirms the stop result for a %s server",
      (mode) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stop-" });
          const signalPath = path.join(fixture, "signals");
          const child = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `import * as fs from "node:fs";
import * as net from "node:net";
const server = net.createServer((socket) => socket.end());
let signals = 0;
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[2], String(++signals));
  if (process.argv[1] !== "timeout" || signals > 1) server.close();
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ pid: process.pid, port: server.address().port, args: [] }) + "\\n");
});
`,
                mode,
                signalPath,
              ],
              { cwd: fixture, detached: false },
            ),
          );
          yield* Effect.addFinalizer(() =>
            child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore),
          );
          const started = decodeStarted(
            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.take(1),
              Stream.mkString,
            ),
          );
          assert.equal(started.pid, child.pid);
          const platform = yield* HostProcess.Platform;
          const token =
            platform === "linux"
              ? (yield* fs.readFileString(`/proc/${child.pid}/stat`))
                  .replace(/^.*\) /u, "")
                  .split(" ")[19]
              : yield* spawner
                  .spawn(
                    ChildProcess.make("ps", ["-o", "lstart=", "-p", String(child.pid)], {
                      env: { LC_ALL: "C" },
                    }),
                  )
                  .pipe(
                    Effect.flatMap((process) =>
                      process.stdout.pipe(Stream.decodeText(), Stream.mkString),
                    ),
                    Effect.map((output) => output.replace(/\n+$/u, "")),
                  );
          const savedState = {
            pid: `${child.pid}\n`,
            port: `${started.port}\n`,
            managed: mode === "external" ? "external\n" : "managed\n",
            ...(mode === "legacy"
              ? {}
              : { "start-token": mode === "reused-pid" ? "different-process\n" : `${token}\n` }),
          };
          const target = {
            alias: "fixture",
            hostname: "fixture",
            username: null,
            port: null,
          };
          const stateRoot = path.join(fixture, ".t3", "ssh-launch");
          const stateKey = yield* remoteStateKey(target);
          const legacyStateDir = path.join(stateRoot, stateKey);
          yield* fs.makeDirectory(legacyStateDir, { recursive: true });
          for (const [name, contents] of Object.entries(savedState)) {
            yield* fs.writeFileString(path.join(legacyStateDir, name), contents);
          }
          const script = buildRemoteStopScript(stateKey);
          const runStop = Effect.fn("test.remoteStop")(function* () {
            const stop = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-s"], {
                cwd: fixture,
                env: { HOME: fixture },
                stdin: Stream.make(new TextEncoder().encode(script)),
              }),
            );
            return yield* Effect.all(
              {
                stdout: stop.stdout.pipe(Stream.decodeText(), Stream.mkString),
                stderr: stop.stderr.pipe(Stream.decodeText(), Stream.mkString),
                exitCode: stop.exitCode,
              },
              { concurrency: "unbounded" },
            );
          }, Effect.scoped);
          const result = yield* runStop();
          if (mode === "external" || mode === "reused-pid" || mode === "legacy") {
            // An external server is never signaled by the stop script.
            assert.isTrue(yield* child.isRunning);
            yield* Effect.callback<void, Error>((resume) => {
              const connection = NodeNet.connect(started.port, "127.0.0.1");
              connection.once("error", (error) => resume(Effect.fail(error)));
              connection.once("close", () => resume(Effect.void));
              return Effect.sync(() => connection.destroy());
            });
          }
          if (mode === "timeout") {
            assert.equal(result.exitCode, 1);
            assert.include(result.stderr, "Its ownership files were kept.");
            assert.isTrue(yield* child.isRunning);
            for (const [name, contents] of Object.entries(savedState)) {
              assert.equal(yield* fs.readFileString(path.join(legacyStateDir, name)), contents);
            }
            const retry = yield* runStop();
            assert.equal(retry.exitCode, 0, retry.stderr);
          } else {
            assert.equal(result.exitCode, 0, result.stderr);
            assert.equal(result.stdout, '{"stopped":true}\n');
            assert.equal(result.stderr, "");
          }
          for (const name of Object.keys(savedState)) {
            assert.isFalse(yield* fs.exists(path.join(legacyStateDir, name)));
          }
          if (mode === "external" || mode === "reused-pid" || mode === "legacy") {
            assert.isFalse(yield* fs.exists(signalPath));
          } else if (mode === "timeout") {
            assert.isFalse(yield* child.isRunning);
            assert.equal(yield* fs.readFileString(signalPath), "2");
          } else {
            assert.equal(yield* child.exitCode, 0);
            assert.equal(yield* fs.readFileString(signalPath), "1");
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
