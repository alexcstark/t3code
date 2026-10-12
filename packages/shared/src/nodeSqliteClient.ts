/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeWorkerThreads from "node:worker_threads";

import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

// Runs in a worker thread so that disk waits (fsync, cold page reads, busy
// timeouts) block only this thread, never the server's event loop. Plain
// CommonJS with Node built-ins only: it is passed to `new Worker` as source, so
// it needs no bundle entry and works the same in the executable and in tests.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const toError = (cause) => ({
  message: cause && cause.message !== undefined ? String(cause.message) : String(cause),
  errcode: cause ? cause.errcode : undefined,
  errstr: cause ? cause.errstr : undefined,
  code: cause ? cause.code : undefined,
});
let db;
try {
  db = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readOnly,
    allowExtension: workerData.allowExtension,
  });
  parentPort.postMessage({ id: 0, ok: true, rows: [], inTransaction: false });
} catch (cause) {
  parentPort.postMessage({ id: 0, ok: false, operation: "open", error: toError(cause), inTransaction: false });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement !== undefined) {
    statements.delete(sql);
  } else {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  }
  statements.set(sql, statement);
  return statement;
};
parentPort.on("message", (request) => {
  const { id } = request;
  if (request.close) {
    try { db.close(); } catch {}
    parentPort.postMessage({ id, ok: true, rows: [], inTransaction: false });
    return;
  }
  let statement;
  try {
    // Transaction-control cleanup is idempotent: SQLITE_FULL can roll back the
    // entire transaction, including its savepoints. Preserve that original
    // failure when cleanup finds no transaction left.
    if (request.rollback && !db.isTransaction) {
      parentPort.postMessage({ id, ok: true, rows: [], inTransaction: false });
      return;
    }
    statement = prepare(request.sql, request.cached);
  } catch (cause) {
    parentPort.postMessage({ id, ok: false, operation: "prepare", error: toError(cause), inTransaction: db.isTransaction });
    return;
  }
  try {
    const hasRows = statement.columns().length > 0;
    let rows;
    if (request.mode === "values") {
      if (hasRows) {
        statement.setReturnArrays(true);
        try { rows = statement.all(...request.params); } finally { statement.setReturnArrays(false); }
      } else {
        statement.run(...request.params);
        rows = [];
      }
    } else {
      statement.setReadBigInts(request.safeIntegers);
      if (hasRows) rows = statement.all(...request.params);
      else {
        const result = statement.run(...request.params);
        rows = request.mode === "raw" ? result : [];
      }
    }
    parentPort.postMessage({ id, ok: true, rows, inTransaction: db.isTransaction });
  } catch (cause) {
    parentPort.postMessage({ id, ok: false, operation: "execute", error: toError(cause), inTransaction: db.isTransaction });
  }
});
`;

type WorkerRequest =
  | {
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly mode: "rows" | "raw" | "values";
      readonly cached: boolean;
      readonly safeIntegers?: boolean;
      readonly rollback?: boolean;
    }
  | { readonly close: true };

type WorkerReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly rows: unknown;
      readonly inTransaction: boolean;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly operation: "open" | "prepare" | "execute";
      readonly error: {
        readonly message: string;
        readonly errcode?: number;
        readonly errstr?: string;
        readonly code?: string;
      };
      readonly inTransaction: boolean;
    };

const OPERATION_MESSAGES = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const replyError = (reply: Extract<WorkerReply, { ok: false }>) => {
  const { message, ...details } = reply.error;
  const cause = Object.assign(new Error(message), details);
  return new SqlError({
    reason: classifyError(cause, OPERATION_MESSAGES[reply.operation], reply.operation),
  });
};

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const pending = new Map<number, (reply: WorkerReply) => void>();
    let nextId = 1;
    let inTransaction = false;
    let crashed: Error | undefined;

    const worker = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        filename: options.filename,
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
        prepareCacheSize: options.prepareCacheSize ?? 200,
      },
    });
    // The worker posts the open result as message 0 before reading requests.
    const openReply = new Promise<WorkerReply>((resolve) => worker.once("message", resolve));
    const settle = (reply: WorkerReply) => {
      const resolve = pending.get(reply.id);
      if (resolve === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      inTransaction = reply.inTransaction;
      resolve(reply);
    };
    const fail = (cause: Error) => {
      crashed = cause;
      for (const id of [...pending.keys()]) {
        settle({
          id,
          ok: false,
          operation: "execute",
          error: { message: `SQLite worker stopped: ${cause.message}` },
          inTransaction: false,
        });
      }
    };
    worker.on("message", settle);
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`exited with code ${code}`)));

    const send = (request: WorkerRequest) =>
      Effect.callback<WorkerReply>((resume) => {
        const id = nextId++;
        if (crashed !== undefined) {
          resume(
            Effect.succeed({
              id,
              ok: false,
              operation: "execute",
              error: { message: `SQLite worker stopped: ${crashed.message}` },
              inTransaction: false,
            }),
          );
          return;
        }
        if (pending.size === 0) worker.ref();
        pending.set(id, (reply) => resume(Effect.succeed(reply)));
        worker.postMessage({ ...request, id });
      });

    const query = (request: Extract<WorkerRequest, { sql: string }>) =>
      Effect.flatMap(send(request), (reply) =>
        reply.ok
          ? Effect.succeed(reply.rows as ReadonlyArray<any>)
          : Effect.fail(replyError(reply)),
      );

    const opened = yield* Effect.promise(() => openReply);
    // Holds the process open only while a query is in flight.
    worker.unref();
    if (!opened.ok) {
      yield* Effect.promise(() => worker.terminate());
      return yield* replyError(opened);
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (crashed === undefined) yield* send({ close: true });
        yield* Effect.promise(() => worker.terminate());
      }),
    );

    const run = (
      sql: string,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "raw",
      cached = true,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) =>
        query({
          sql,
          params,
          mode,
          cached,
          safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
        }),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>, cached: boolean) =>
      query({ sql, params, mode: "values", cached }) as Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        SqlError
      >;

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform
          ? Effect.map(run(sql, params, "rows"), rowTransform)
          : run(sql, params, "rows");
      },
      executeRaw(sql, params) {
        return run(sql, params, "raw");
      },
      executeValues(sql, params) {
        return runValues(sql, params, true);
      },
      executeValuesUnprepared(sql, params) {
        return runValues(sql, params ?? [], false);
      },
      executeUnprepared(sql, params, rowTransform) {
        const rollback = sql === "ROLLBACK" || sql.startsWith("ROLLBACK TO SAVEPOINT ");
        const effect = Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) =>
          query({
            sql,
            params: params ?? [],
            mode: "rows",
            cached: false,
            rollback,
            safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
          }),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    return { connection, isTransaction: () => inTransaction };
  });

  const semaphore = yield* Semaphore.make(1);
  const { connection, isTransaction } = yield* makeConnection;
  const acquirers = Client.makeSqliteAcquirers({
    connection: Effect.succeed(connection),
    semaphore,
    isTransaction,
  });

  return yield* Client.make({
    ...acquirers,
    compiler,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
