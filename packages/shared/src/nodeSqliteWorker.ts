// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This native worker runs outside the Effect runtime.
import type * as NodeSqlite from "node:sqlite";
import type { createSqliteCheckpointController } from "./nodeSqliteCheckpoint.ts";

export interface SqliteWorkerConfig {
  readonly filename: string;
  readonly readonly: boolean;
  readonly allowExtension: boolean;
  readonly prepareCacheSize: number;
  readonly prepareCacheTTL: number;
  readonly checkpointSource?: string;
}

export type SqliteWorkerRequest =
  | { readonly id: number; readonly operation: "open" }
  | { readonly id: number; readonly operation: "close" }
  | { readonly id: number; readonly operation: "resume"; readonly token: number }
  | { readonly id: number; readonly operation: "cancel"; readonly token: number }
  | {
      readonly id: number;
      readonly operation: "execute";
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly mode: "rows" | "values" | "raw";
      readonly cached: boolean;
      readonly safeIntegers: boolean;
    };

export type SqliteWorkerResponse =
  | { readonly _tag: "Warning"; readonly reason: string }
  | { readonly id: number; readonly _tag: "Waiting" | "Ready"; readonly isTransaction: boolean }
  | {
      readonly id: number;
      readonly _tag: "Success";
      readonly isTransaction: boolean;
      readonly rows: ReadonlyArray<Record<string, NodeSqlite.SQLOutputValue>>;
      readonly values: ReadonlyArray<ReadonlyArray<NodeSqlite.SQLOutputValue>>;
      readonly raw: NodeSqlite.StatementResultingChanges | undefined;
    }
  | {
      readonly id: number;
      readonly _tag: "Failure";
      readonly isTransaction: boolean;
      readonly operation: string;
      readonly cause: unknown;
    };

/**
 * Serialized into the worker so development, Electron archives and the single
 * executable all run the same code without locating a sibling worker file.
 * Keep every runtime dependency inside this function; injected require prevents
 * bundlers from replacing it with a helper outside the serialized function.
 */
export function sqliteWorkerMain(
  load: NodeJS.Require,
  createCheckpoint: typeof createSqliteCheckpointController,
): void {
  const sqlite: typeof import("node:sqlite") = load("node:sqlite");
  const threads: typeof import("node:worker_threads") = load("node:worker_threads");
  const port = threads.parentPort;
  if (port === null) throw new Error("SQLite worker requires a parent port");
  const config: SqliteWorkerConfig = threads.workerData;
  let database: NodeSqlite.DatabaseSync | undefined;
  let checkpoint: ReturnType<typeof createSqliteCheckpointController>;
  type Classification = { backpressure: boolean; check: boolean };
  let activeClassification: Classification | undefined;
  const withClassification = <A>(classification: Classification, use: () => A): A => {
    const previous = activeClassification;
    activeClassification = classification;
    try {
      return use();
    } finally {
      activeClassification = previous;
    }
  };
  const mutatingPragmasWithValues = new Set([
    "application_id",
    "auto_vacuum",
    "journal_mode",
    "schema_version",
    "user_version",
  ]);
  const mutatesPragma = (name: string | null, value: string | null) => {
    const pragma = name?.toLowerCase();
    if (pragma === undefined) return false;
    if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
    if (pragma === "wal_checkpoint") return value?.toLowerCase() !== "noop";
    return value !== null && mutatingPragmasWithValues.has(pragma);
  };
  type Execute = Extract<SqliteWorkerRequest, { operation: "execute" }>;
  const admissions = new Map<number, { request: Execute; release: () => void; ready: boolean }>();
  const statements = new Map<
    string,
    {
      statement: NodeSqlite.StatementSync;
      hasRows: boolean;
      expiresAt: number;
      classification: Classification;
    }
  >();

  port.on("message", async (input: SqliteWorkerRequest) => {
    if (input.operation === "cancel") {
      admissions.get(input.token)?.release();
      admissions.delete(input.token);
      return;
    }
    let request = input;
    let admitted: (() => void) | undefined;
    let operation: string = request.operation;
    const succeed = (
      rows: ReadonlyArray<Record<string, NodeSqlite.SQLOutputValue>> = [],
      values: ReadonlyArray<ReadonlyArray<NodeSqlite.SQLOutputValue>> = [],
      raw?: NodeSqlite.StatementResultingChanges,
    ) => {
      const response: SqliteWorkerResponse = {
        id: request.id,
        _tag: "Success",
        isTransaction: database?.isTransaction ?? false,
        rows,
        values,
        raw,
      };
      port.postMessage(response);
    };
    try {
      if (request.operation === "resume") {
        const pending = admissions.get(request.token);
        if (pending === undefined || !pending.ready) throw new Error("Unknown SQLite admission");
        admissions.delete(request.token);
        admitted = pending.release;
        request = { ...pending.request, id: request.id };
      }
      if (request.operation === "open") {
        database = new sqlite.DatabaseSync(config.filename, {
          readOnly: config.readonly,
          allowExtension: config.allowExtension,
        });
        if (config.checkpointSource !== undefined) {
          checkpoint = createCheckpoint(load, {
            filename: config.filename,
            writer: database,
            source: config.checkpointSource,
            frames: 1000,
            backpressureFrames: 10000,
            idleMs: 100,
            warn: (reason) => port.postMessage({ _tag: "Warning", reason }),
          });
          if (checkpoint !== undefined) {
            database.setAuthorizer((actionCode, action, argument) => {
              const classification = activeClassification;
              const constants = sqlite.constants;
              if (classification === undefined) return constants.SQLITE_OK;
              if (actionCode === constants.SQLITE_TRANSACTION) {
                classification.backpressure ||= action === "BEGIN";
                classification.check ||= action === "COMMIT" || action === "ROLLBACK";
              } else if (actionCode === constants.SQLITE_SAVEPOINT) {
                classification.backpressure ||= action === "BEGIN";
                classification.check = true;
              } else if (
                actionCode === constants.SQLITE_PRAGMA &&
                mutatesPragma(action, argument)
              ) {
                classification.backpressure = true;
                classification.check = true;
              } else if (
                actionCode !== constants.SQLITE_READ &&
                actionCode !== constants.SQLITE_SELECT &&
                actionCode !== constants.SQLITE_FUNCTION &&
                actionCode !== constants.SQLITE_RECURSIVE &&
                actionCode !== constants.SQLITE_PRAGMA
              ) {
                classification.backpressure = true;
                classification.check = true;
              }
              return constants.SQLITE_OK;
            });
          }
        }
        succeed();
        return;
      }
      if (request.operation === "close") {
        await checkpoint?.close();
        database?.close();
        database = undefined;
        statements.clear();
        succeed();
        port.close();
        return;
      }
      if (database === undefined) throw new Error("SQLite database is not open");
      const query = request;
      // SQLITE_FULL can roll back the transaction and all of its savepoints.
      // Cleanup must preserve that failure rather than report a second rollback error.
      if (
        !database.isTransaction &&
        (query.sql === "ROLLBACK" || query.sql.startsWith("ROLLBACK TO SAVEPOINT "))
      ) {
        succeed();
        return;
      }
      operation = "prepare";
      let entry = query.cached ? statements.get(query.sql) : undefined;
      if (entry !== undefined && entry.expiresAt <= Date.now()) {
        statements.delete(query.sql);
        entry = undefined;
      }
      if (entry === undefined) {
        const classification = { backpressure: false, check: false };
        const db = database;
        const statement = withClassification(classification, () => db.prepare(query.sql));
        entry = {
          statement,
          classification,
          hasRows: statement.columns().length > 0,
          expiresAt: Date.now() + config.prepareCacheTTL,
        };
      }
      if (query.cached && config.prepareCacheSize > 0) {
        statements.delete(query.sql);
        statements.set(query.sql, entry);
        if (statements.size > config.prepareCacheSize) {
          const oldest = statements.keys().next().value;
          if (oldest !== undefined) statements.delete(oldest);
        }
      }
      if (checkpoint !== undefined && entry.classification.backpressure && !checkpoint.ready()) {
        // No SQL runs until the parent resumes this token. It may cancel while
        // a pinned snapshot holds admission without interrupting native SQLite.
        admitted?.();
        admitted = undefined;
        const token = request.id;
        const pending = { request: query, release: () => {}, ready: false };
        admissions.set(token, pending);
        port.postMessage({ id: token, _tag: "Waiting", isTransaction: database.isTransaction });
        pending.release = checkpoint.acquire(() => {
          pending.ready = true;
          port.postMessage({
            id: token,
            _tag: "Ready",
            isTransaction: database?.isTransaction ?? false,
          });
        });
        return;
      }
      operation = "execute";
      const { statement, hasRows, classification } = entry;
      statement.setReadBigInts(query.safeIntegers);
      statement.setReturnArrays(query.mode === "values");
      // SqlConnection's bind parameters are unknown; native SQLite validates them.
      const params = query.params as ReadonlyArray<NodeSqlite.SQLInputValue>;
      try {
        withClassification(classification, () => {
          if (hasRows) {
            const rows = statement.all(...params);
            if (query.mode === "values") {
              // Node's types still describe named rows after setReturnArrays(true).
              succeed(
                [],
                rows as unknown as ReadonlyArray<ReadonlyArray<NodeSqlite.SQLOutputValue>>,
              );
            } else {
              succeed(rows);
            }
          } else {
            const result = statement.run(...params);
            succeed([], [], query.mode === "raw" ? result : undefined);
          }
        });
      } finally {
        // OR FAIL can commit earlier rows despite the statement throwing.
        if (classification.check) checkpoint?.check();
      }
    } catch (cause) {
      const response: SqliteWorkerResponse = {
        id: request.id,
        _tag: "Failure",
        isTransaction: database?.isTransaction ?? false,
        operation,
        // Structured cloning Error drops SQLite's custom code/errcode/errstr fields.
        cause:
          cause instanceof Error
            ? { ...cause, name: cause.name, message: cause.message, stack: cause.stack }
            : cause,
      };
      port.postMessage(response);
    } finally {
      admitted?.();
    }
  });
}
