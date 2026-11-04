// @effect-diagnostics nodeBuiltinImport:off - this module is the spawner Effect's ChildProcess runs on.
// Linux fork copies the server's page tables on its main thread. A small helper
// keeps spawn cost independent of server memory; macOS and Windows do not need it.
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

type Send = (request: SpawnHelperRequest) => void;

// V8 collects lazily; keep the helper's page tables small across many spawns.
const HELPER_HEAP_LIMITS = "--max-old-space-size=96 --max-semi-space-size=2";

const makePipe = (id: number, fd: number, send: Send) => {
  let waitingForRead = false;
  let pendingWrite: ((error?: Error | null) => void) | undefined;
  const acknowledge = (error?: Error) => {
    const callback = pendingWrite;
    pendingWrite = undefined;
    callback?.(error);
  };
  const stream = new NodeStream.Duplex({
    read() {
      if (!waitingForRead) return;
      waitingForRead = false;
      send({ type: "read", id, fd });
    },
    write(chunk: Uint8Array, _encoding, callback) {
      pendingWrite = callback;
      send({ type: "write", id, fd, chunk });
    },
    final(callback) {
      pendingWrite = callback;
      send({ type: "close", id, fd });
    },
    destroy(error, callback) {
      acknowledge(error ?? new Error("The child pipe is closed."));
      send({ type: "destroy", id, fd });
      callback(error);
    },
  });
  // An interrupted writer may have already detached its error listener.
  stream.on("error", () => undefined);
  return {
    stream,
    acknowledge,
    output(chunk: Uint8Array | null) {
      if (stream.destroyed) return;
      if (chunk === null) {
        stream.push(null);
      } else if (stream.push(chunk)) {
        send({ type: "read", id, fd });
      } else {
        waitingForRead = true;
      }
    },
    fail(error: Error) {
      stream.destroy(error);
    },
  };
};

/** A child the helper started, with the ChildProcess members Effect's spawner reads. */
class HelperChild extends NodeEvents.EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin: NodeChildProcess.ChildProcess["stdin"] = null;
  stdout: NodeChildProcess.ChildProcess["stdout"] = null;
  stderr: NodeChildProcess.ChildProcess["stderr"] = null;
  readonly stdio: NodeChildProcess.ChildProcess["stdio"] = [null, null, null, undefined, undefined];
  referenced = true;
  private readonly pipes = new Map<number, ReturnType<typeof makePipe>>();
  private readonly id: number;
  private readonly send: Send;
  private readonly onReferenceChange: () => void;
  private readonly detached: boolean;

  constructor(id: number, send: Send, onReferenceChange: () => void, detached: boolean) {
    super();
    this.id = id;
    this.send = send;
    this.onReferenceChange = onReferenceChange;
    this.detached = detached;
  }

  started(pid: number | undefined, fds: ReadonlyArray<number>) {
    this.pid = pid;
    for (const fd of fds) {
      const pipe = makePipe(this.id, fd, this.send);
      // Nothing ever reads back from the child's stdin.
      if (fd === 0) pipe.output(null);
      this.pipes.set(fd, pipe);
      this.stdio[fd] = pipe.stream;
      if (fd === 0) this.stdin = pipe.stream;
      if (fd === 1) this.stdout = pipe.stream;
      if (fd === 2) this.stderr = pipe.stream;
    }
    this.emit("spawn");
  }

  output(fd: number, chunk: Uint8Array | null) {
    this.pipes.get(fd)?.output(chunk);
  }

  written(fd: number, error?: SpawnHelperError) {
    this.pipes.get(fd)?.acknowledge(error ? toError(error) : undefined);
  }

  exited(code: number | null, signal: NodeJS.Signals | null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  fail() {
    const error = new Error("The spawn helper exited before completing the process.");
    if (this.pid === undefined) {
      this.emit("error", error);
      return;
    }
    if (this.detached || (this.exitCode === null && this.signalCode === null)) {
      try {
        process.kill(this.detached ? -this.pid : this.pid, "SIGKILL");
      } catch {
        // The process or its group has already exited.
      }
    }
    for (const pipe of this.pipes.values()) pipe.fail(error);
    if (this.exitCode === null && this.signalCode === null) this.exited(null, "SIGKILL");
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

export const makeHelperSpawn = (launch: SpawnHelperLaunch) => {
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
      case "written":
        child.written(reply.fd, reply.error);
        return;
      case "exit":
        child.exited(reply.code, reply.signal);
        return;
      case "closed":
        settle(reply.id);
        return;
    }
  };

  const failInFlight = () => {
    const stranded = [...children.values()];
    children.clear();
    updateKeepAlive();
    for (const child of stranded) child.fail();
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
    let replied = false;
    started.on("message", (reply: SpawnHelperReply) => {
      replied = true;
      onReply(reply);
    });
    started.on("exit", () => {
      if (helper !== started) return;
      helper = undefined;
      if (!replied) launchFailed = true;
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
    // Parent-local handles and AbortSignals cannot cross the IPC serialization boundary.
    const stdio = options.stdio;
    if (
      options.signal !== undefined ||
      options.cwd instanceof URL ||
      (Array.isArray(stdio) &&
        stdio.some(
          (fd) =>
            fd !== null && fd !== undefined && fd !== "pipe" && fd !== "ignore" && fd !== "inherit",
        ))
    ) {
      return NodeChildProcess.spawn(command, [...args], options);
    }
    const target = launchFailed ? undefined : (helper ?? start());
    if (target === undefined || !target.connected)
      return NodeChildProcess.spawn(command, [...args], options);
    const send: Send = (request) => {
      if (!target.connected) return;
      target.send(request, undefined, undefined, (error) => {
        if (!error || helper !== target) return;
        helper = undefined;
        launchFailed = true;
        if (target.connected) target.disconnect();
        failInFlight();
      });
    };
    const id = ++nextId;
    const child = new HelperChild(id, send, updateKeepAlive, options.detached === true);
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
    failInFlight();
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
