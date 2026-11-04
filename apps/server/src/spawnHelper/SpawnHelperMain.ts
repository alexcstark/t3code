// @effect-diagnostics nodeBuiltinImport:off - runs without the Effect runtime, to stay small.
/**
 * The small process that starts children for the server (see SpawnHelper.ts).
 * It imports only Node built-ins so it stays small: on Linux every spawn copies
 * the spawning process's page tables, so this process must never grow.
 */
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

export const SPAWN_HELPER_COMMAND = "__spawn-helper";

export type SpawnHelperRequest =
  | {
      readonly type: "spawn";
      readonly id: number;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: NodeChildProcess.SpawnOptions;
    }
  | { readonly type: "write"; readonly id: number; readonly fd: number; readonly chunk: Uint8Array }
  | { readonly type: "close"; readonly id: number; readonly fd: number }
  | { readonly type: "read"; readonly id: number; readonly fd: number }
  | { readonly type: "destroy"; readonly id: number; readonly fd: number }
  | { readonly type: "kill"; readonly id: number; readonly signal?: NodeJS.Signals | number };

export interface SpawnHelperError {
  readonly message: string;
  readonly code?: string;
  readonly errno?: number;
  readonly syscall?: string;
  readonly path?: string;
}

export type SpawnHelperReply =
  | {
      readonly type: "spawn";
      readonly id: number;
      readonly pid: number | undefined;
      readonly pipes: ReadonlyArray<number>;
    }
  | { readonly type: "data"; readonly id: number; readonly fd: number; readonly chunk: Uint8Array }
  | { readonly type: "end"; readonly id: number; readonly fd: number }
  | {
      readonly type: "written";
      readonly id: number;
      readonly fd: number;
      readonly error?: SpawnHelperError;
    }
  | { readonly type: "error"; readonly id: number; readonly error: SpawnHelperError }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  /** Every pipe has ended; exit can arrive before a child's last output. */
  | { readonly type: "closed"; readonly id: number };

const toHelperError = (cause: unknown): SpawnHelperError => {
  const error = cause instanceof Error ? (cause as NodeJS.ErrnoException) : undefined;
  return {
    message: error?.message ?? String(cause),
    ...(error?.code === undefined ? {} : { code: error.code }),
    ...(error?.errno === undefined ? {} : { errno: error.errno }),
    ...(error?.syscall === undefined ? {} : { syscall: error.syscall }),
    ...(error?.path === undefined ? {} : { path: error.path }),
  };
};

export function runSpawnHelper(): void {
  const send = process.send?.bind(process);
  if (send === undefined) {
    throw new Error("The spawn helper needs an IPC channel to the server.");
  }
  const reply = (message: SpawnHelperReply) => {
    if (process.connected) send(message, undefined, undefined, () => undefined);
  };
  const children = new Map<number, NodeChildProcess.ChildProcess>();
  const pipeOf = (id: number, fd: number) =>
    children.get(id)?.stdio[fd] as NodeStream.Duplex | null | undefined;

  const start = (request: Extract<SpawnHelperRequest, { type: "spawn" }>) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(request.command, [...request.args], request.options);
    } catch (cause) {
      reply({ type: "error", id: request.id, error: toHelperError(cause) });
      return;
    }
    children.set(request.id, child);
    const pipes: Array<number> = [];
    // Relay bytes instead of handing pipes over: a handed-over pipe loses whatever
    // this process already read from it, and the hand-over races a fast exit.
    child.stdio.forEach((stream, fd) => {
      if (stream === null || stream === undefined) return;
      pipes.push(fd);
      // A write to a child that already exited fails; the child's exit reports that.
      stream.on("error", () => undefined);
      if (fd === 0) return;
      const output = stream as NodeStream.Readable;
      // One chunk per descriptor stays in flight until the consumer accepts it.
      output.on("data", (chunk: Uint8Array) => {
        output.pause();
        reply({ type: "data", id: request.id, fd, chunk });
      });
      output.on("end", () => reply({ type: "end", id: request.id, fd }));
    });
    child.on("spawn", () => reply({ type: "spawn", id: request.id, pid: child.pid, pipes }));
    child.on("error", (cause) =>
      reply({ type: "error", id: request.id, error: toHelperError(cause) }),
    );
    child.on("exit", (code, signal) => reply({ type: "exit", id: request.id, code, signal }));
    child.on("close", () => {
      children.delete(request.id);
      reply({ type: "closed", id: request.id });
    });
  };

  process.on("message", (request: SpawnHelperRequest) => {
    switch (request.type) {
      case "spawn":
        start(request);
        return;
      case "write":
      case "close": {
        const pipe = pipeOf(request.id, request.fd);
        const acknowledge = (error?: Error | null) =>
          reply({
            type: "written",
            id: request.id,
            fd: request.fd,
            ...(error ? { error: toHelperError(error) } : {}),
          });
        if (pipe === null || pipe === undefined) {
          acknowledge(new Error("The child pipe is closed."));
        } else if (request.type === "write") {
          pipe.write(request.chunk, acknowledge);
        } else {
          pipe.end(acknowledge);
        }
        return;
      }
      case "read":
        pipeOf(request.id, request.fd)?.resume();
        return;
      case "destroy":
        pipeOf(request.id, request.fd)?.destroy();
        return;
      case "kill":
        children.get(request.id)?.kill(request.signal);
        return;
    }
  });
  // The server owns these children; once it is gone there is nobody to report to.
  process.on("disconnect", () => process.exit(0));
}
