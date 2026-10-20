// @effect-diagnostics nodeBuiltinImport:off -- This controller is also serialized into the native writer worker.

/** Shared WAL admission and checkpoint ownership for direct and worker connections. */
export function createSqliteCheckpointController(
  load: (id: "node:worker_threads") => typeof import("node:worker_threads"),
  input: {
    readonly filename: string;
    readonly writer: import("node:sqlite").DatabaseSync;
    readonly source: string;
    readonly frames: number;
    readonly backpressureFrames: number;
    readonly idleMs: number;
    readonly warn: (reason: string) => void;
  },
) {
  const threads: typeof import("node:worker_threads") = load("node:worker_threads");
  const { filename, writer, warn } = input;
  const readSafeSqliteInteger = (value: unknown) => {
    const number = typeof value === "bigint" ? Number(value) : value;
    return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
  };
  if (typeof writer.isTransaction !== "boolean" || typeof writer.setAuthorizer !== "function") {
    warn("Node SQLite lacks transaction-state or statement-authorizer support");
    return undefined;
  }
  const version = String(writer.prepare("SELECT sqlite_version() AS version").get()?.version);
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  // NOOP and the concurrent WAL safety fixes are both required before offloading checkpoints.
  if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
    warn(`SQLite ${version} has no safe concurrent WAL checkpoint`);
    return undefined;
  }
  const frames = writer.prepare("PRAGMA wal_checkpoint(NOOP)");
  const sizeLimit = writer.prepare("PRAGMA journal_size_limit");
  let worker: import("node:worker_threads").Worker;
  try {
    worker = new threads.Worker(input.source, {
      eval: true,
      workerData: {
        filename,
        frames: input.frames,
        backpressureFrames: input.backpressureFrames,
        idleMs: input.idleMs,
      },
    });
  } catch (cause) {
    warn(String(cause));
    return undefined;
  }
  let stopped = false;
  let generation = 0;
  let nextId = 0;
  let inFlight: number | undefined;
  let checkAgain = false;
  let blocked = false;
  let log = 0;
  let checkpointed = 0;
  let unknown = false;
  let truncate: { id: number; acknowledged: boolean } | undefined;
  type Waiter = { resume: () => void; cancelled: boolean };
  const waiters: Array<Waiter> = [];
  let elected: Waiter | undefined;
  const gated = () =>
    !stopped &&
    !writer.isTransaction &&
    (unknown || blocked || truncate !== undefined || log >= input.backpressureFrames);
  const wake = () => {
    if (!gated() && elected === undefined) {
      elected = waiters.shift();
      elected?.resume();
    }
    if (waiters.length === 0 && elected === undefined) worker.unref();
  };
  const release = (waiter: Waiter) => {
    waiter.cancelled = true;
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    if (elected === waiter) elected = undefined;
    wake();
  };
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    truncate = undefined;
    try {
      writer.exec(`PRAGMA wal_autocheckpoint = ${input.frames};`);
    } catch {}
    wake();
    warn(reason);
  };
  const send = (message: unknown) => {
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage(message);
    } catch (cause) {
      handBack(String(cause));
    }
  };
  const acknowledge = () => {
    if (truncate === undefined || truncate.acknowledged || stopped || writer.isTransaction) return;
    truncate.acknowledged = true;
    send({ type: "truncate", truncateId: truncate.id });
  };
  const observe = () => {
    try {
      const state = frames.get();
      const nextLog = readSafeSqliteInteger(state?.log);
      const nextCheckpointed = readSafeSqliteInteger(state?.checkpointed);
      if (nextLog === undefined || nextCheckpointed === undefined)
        throw new Error("Invalid WAL frame counts");
      log = nextLog;
      checkpointed = nextCheckpointed;
      unknown = false;
    } catch {
      unknown = true;
    }
  };
  const request = (force = false) => {
    if (stopped || writer.isTransaction) return;
    if (truncate !== undefined) {
      acknowledge();
      return;
    }
    if (inFlight !== undefined) {
      checkAgain = true;
      return;
    }
    if (!force && !gated() && log - checkpointed < input.frames) return;
    inFlight = ++nextId;
    try {
      send({
        type: "check",
        id: inFlight,
        generation,
        journalSizeLimit: readSafeSqliteInteger(sizeLimit.get()?.journal_size_limit),
        force: force || gated(),
      });
    } catch (cause) {
      handBack(String(cause));
    }
  };
  const check = () => {
    if (stopped || writer.isTransaction) return;
    generation++;
    observe();
    request();
    wake();
  };
  worker.on("error", (cause) => handBack(cause.message));
  worker.on("exit", (code) => handBack(`exited with code ${code}`));
  worker.on("message", (message: unknown) => {
    if (stopped || typeof message !== "object" || message === null || !("type" in message)) return;
    if (
      message.type === "truncate-request" &&
      "truncateId" in message &&
      typeof message.truncateId === "number"
    ) {
      truncate = { id: message.truncateId, acknowledged: false };
      blocked = true;
      acknowledge();
      return;
    }
    if (message.type !== "checkpoint") return;
    const completedTruncate =
      truncate !== undefined && "truncateId" in message && message.truncateId === truncate.id;
    if (completedTruncate) truncate = undefined;
    // An acknowledged truncate excludes new writer mutations, so its result is current.
    if (
      (completedTruncate || ("generation" in message && message.generation === generation)) &&
      "log" in message &&
      typeof message.log === "number" &&
      "checkpointed" in message &&
      typeof message.checkpointed === "number" &&
      "blocked" in message &&
      typeof message.blocked === "boolean"
    ) {
      log = message.log;
      checkpointed = message.checkpointed;
      blocked = message.blocked;
      unknown = false;
    }
    // Even a stale snapshot must retire its request so a newer check can run.
    if ("id" in message && message.id === inFlight) inFlight = undefined;
    if (checkAgain && inFlight === undefined) {
      checkAgain = false;
      request(true);
    }
    wake();
  });
  const close = () => {
    stopped = true;
    truncate = undefined;
    wake();
    return worker.terminate();
  };
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    observe();
    worker.unref();
  } catch (cause) {
    void close();
    throw cause;
  }

  return {
    check,
    ready: () => !gated(),
    acquire: (resume: () => void) => {
      const waiter: Waiter = { resume, cancelled: false };
      waiters.push(waiter);
      worker.ref();
      request(true);
      wake();
      return () => release(waiter);
    },
    close,
  };
}
