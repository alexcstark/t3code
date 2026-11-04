// @effect-diagnostics nodeBuiltinImport:off - this module is the spawner Effect's ChildProcess runs on.
/**
 * Linux `fork()` copies the forking process's page tables, so a spawn from the server
 * costs time in proportion to the server's memory, all of it on the main thread (about
 * 21 ms per GB, measured). A large server spending most of a second in fork stalls
 * every request. Children start in a small helper process instead, and their output
 * is relayed back over IPC, so spawn cost stays flat however large the server grows.
 * libuv uses posix_spawn on macOS and Windows has no fork, so only Linux needs this.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import {
  SPAWN_HELPER_COMMAND,
  type SpawnHelperError,
  type SpawnHelperReply,
  type SpawnHelperRequest,
} from "./SpawnHelperMain.ts";

export interface SpawnHelperLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

type Send = (request: SpawnHelperRequest, onSent?: () => void) => void;

// V8 collects lazily, so an uncapped helper drifts upward and every spawn costs more.
// Measured: capped, it holds about 70 MB over thousands of spawns.
const HELPER_HEAP_LIMITS = "--max-old-space-size=96 --max-semi-space-size=2";

/** One of a child's pipes: writes go to the helper, the helper's relayed output reads back. */
const makePipe = (id: number, fd: number, send: Send) =>
  new NodeStream.Duplex({
    read() {},
    write(chunk: Uint8Array, _encoding, callback) {
      send({ type: "write", id, fd, chunk }, () => callback());
    },
    final(callback) {
      send({ type: "close", id, fd }, () => callback());
    },
  });

/** A child the helper started, with the ChildProcess members Effect's spawner reads. */
class HelperChild extends NodeEvents.EventEmitter {
  pid: number | undefined = undefined;
  stdin: NodeChildProcess.ChildProcess["stdin"] = null;
  stdout: NodeChildProcess.ChildProcess["stdout"] = null;
  stderr: NodeChildProcess.ChildProcess["stderr"] = null;
  readonly stdio: NodeChildProcess.ChildProcess["stdio"] = [null, null, null, undefined, undefined];
  referenced = true;
  private readonly pipes = new Map<number, NodeStream.Duplex>();
  private readonly id: number;
  private readonly send: Send;
  private readonly onReferenceChange: () => void;

  constructor(id: number, send: Send, onReferenceChange: () => void) {
    super();
    this.id = id;
    this.send = send;
    this.onReferenceChange = onReferenceChange;
  }

  started(pid: number | undefined, fds: ReadonlyArray<number>) {
    this.pid = pid;
    for (const fd of fds) {
      const pipe = makePipe(this.id, fd, this.send);
      // Nothing ever reads back from the child's stdin.
      if (fd === 0) pipe.push(null);
      this.pipes.set(fd, pipe);
      this.stdio[fd] = pipe;
      if (fd === 0) this.stdin = pipe;
      if (fd === 1) this.stdout = pipe;
      if (fd === 2) this.stderr = pipe;
    }
    this.emit("spawn");
  }

  output(fd: number, chunk: Uint8Array | null) {
    this.pipes.get(fd)?.push(chunk);
  }

  kill(signal?: NodeJS.Signals | number) {
    this.send({ type: "kill", id: this.id, ...(signal === undefined ? {} : { signal }) });
    return true;
  }

  ref() {
    this.referenced = true;
    this.onReferenceChange();
  }

  unref() {
    this.referenced = false;
    this.onReferenceChange();
  }
}

const toError = (helperError: SpawnHelperError) =>
  Object.assign(new Error(helperError.message), helperError);

const makeHelperSpawn = (launch: SpawnHelperLaunch) => {
  let helper: NodeChildProcess.ChildProcess | undefined;
  // A helper that cannot launch would take every spawn down with it; spawn directly instead.
  let launchFailed = false;
  let nextId = 0;
  const children = new Map<number, HelperChild>();

  // An idle helper must not keep the server alive; a referenced child must.
  const updateKeepAlive = () =>
    [...children.values()].some((child) => child.referenced)
      ? helper?.channel?.ref()
      : helper?.channel?.unref();

  const settle = (id: number) => {
    children.delete(id);
    updateKeepAlive();
  };

  const onReply = (reply: SpawnHelperReply) => {
    const child = children.get(reply.id);
    if (child === undefined) return;
    switch (reply.type) {
      case "spawn":
        child.started(reply.pid, reply.pipes);
        return;
      case "data":
        child.output(reply.fd, reply.chunk);
        return;
      case "end":
        child.output(reply.fd, null);
        return;
      case "error":
        // A child that never started sends nothing more.
        if (child.pid === undefined) settle(reply.id);
        child.emit("error", toError(reply.error));
        return;
      case "exit":
        child.emit("exit", reply.code, reply.signal);
        return;
      case "closed":
        settle(reply.id);
        return;
    }
  };

  // Children outlive a dead helper, but nothing relays them anymore, so end them
  // and say so rather than leave callers waiting forever.
  const failInFlight = () => {
    for (const [id, child] of children) {
      settle(id);
      if (child.pid === undefined) {
        child.emit("error", new Error("The spawn helper exited before starting the process."));
        continue;
      }
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      for (const fd of [1, 2]) child.output(fd, null);
      child.emit("exit", null, "SIGKILL");
    }
  };

  const start = () => {
    const started = NodeChildProcess.spawn(launch.command, [...launch.args], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      serialization: "advanced",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, HELPER_HEAP_LIMITS].filter(Boolean).join(" "),
      },
    });
    // Send failures show up as a closed channel, and the helper's death as "exit".
    started.on("error", () => undefined);
    // A launch failure is known now, but its "error" event comes a tick later.
    if (started.pid === undefined) {
      launchFailed = true;
      return undefined;
    }
    started.on("message", onReply);
    started.on("exit", () => {
      if (helper === started) helper = undefined;
      failInFlight();
    });
    started.unref();
    helper = started;
    updateKeepAlive();
    return started;
  };

  const spawn = (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => {
    const target = launchFailed ? undefined : (helper ?? start());
    if (target === undefined) return NodeChildProcess.spawn(command, [...args], options);
    const send: Send = (request, onSent) => {
      if (target.connected) target.send(request, undefined, undefined, () => onSent?.());
      else onSent?.();
    };
    const id = ++nextId;
    const child = new HelperChild(id, send, updateKeepAlive);
    children.set(id, child);
    updateKeepAlive();
    // The helper's environment and directory are a snapshot from its start; children
    // get the server's current ones, as a local spawn would.
    const resolved = {
      ...options,
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
    };
    send({ type: "spawn", id, command, args, options: resolved });
    return child;
  };

  const stop = () => {
    const running = helper;
    helper = undefined;
    if (running?.connected) running.disconnect();
  };

  return { start, spawn, stop };
};

/** A ChildProcessSpawner whose children start in a helper process launched by `launch`. */
export const layerFromLaunch = (launch: SpawnHelperLaunch) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => {
        const helper = makeHelperSpawn(launch);
        // Start now, while the server is still small: this is the one costly fork.
        helper.start();
        return helper;
      }),
      (helper) => Effect.sync(helper.stop),
    ).pipe(Effect.map((helper) => NodeChildProcessSpawner.layerWithSpawn(helper.spawn))),
  );

/** On Linux, spawns through a helper started from this same executable; elsewhere, nothing. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") return Layer.empty;
    const invocation = yield* resolveSelfInvocation();
    return layerFromLaunch({
      command: invocation.command,
      args: selfInvocationArgs(invocation, [SPAWN_HELPER_COMMAND]),
    });
  }),
);
