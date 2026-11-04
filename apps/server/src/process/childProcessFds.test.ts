import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Headless Chrome speaks CDP over fd 3/4. On Linux, a child that exits with
// unread input on an extra fd resets that socket after our writer is done,
// which crashed the whole server until the platform-node-shared patch.
it.layer(NodeServices.layer)("child process extra fds", (it) => {
  it.effect("a child exiting with unread input on fd 3 does not crash the server", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          ["-e", "process.stdin.once('data', () => process.exit(0))"],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
            additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } },
          },
        ),
      );

      yield* Stream.run(Stream.make(new Uint8Array(1024).fill(1)), child.getInputFd(3));
      yield* Stream.run(Stream.make(new Uint8Array([1])), child.stdin);
      expect(yield* child.exitCode).toBe(0);
      yield* Stream.runDrain(child.getOutputFd(4));
    }).pipe(Effect.scoped),
  );
});
