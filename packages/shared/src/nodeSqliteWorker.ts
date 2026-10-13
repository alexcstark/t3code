// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This native worker runs outside the Effect runtime.
import type * as NodeSqlite from "node:sqlite";

export interface SqliteWorkerConfig {
  readonly filename: string;
  readonly readonly: boolean;
  readonly allowExtension: boolean;
  readonly prepareCacheSize: number;
  readonly prepareCacheTTL: number;
}

export type SqliteWorkerRequest =
  | { readonly id: number; readonly operation: "open" }
  | { readonly id: number; readonly operation: "close" }
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
export function sqliteWorkerMain(load: NodeJS.Require): void {
  const sqlite: typeof import("node:sqlite") = load("node:sqlite");
  const threads: typeof import("node:worker_threads") = load("node:worker_threads");
  const port = threads.parentPort;
  if (port === null) throw new Error("SQLite worker requires a parent port");
  const config: SqliteWorkerConfig = threads.workerData;
  let database: NodeSqlite.DatabaseSync | undefined;
  const statements = new Map<
    string,
    { statement: NodeSqlite.StatementSync; hasRows: boolean; expiresAt: number }
  >();

  port.on("message", (request: SqliteWorkerRequest) => {
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
      if (request.operation === "open") {
        database = new sqlite.DatabaseSync(config.filename, {
          readOnly: config.readonly,
          allowExtension: config.allowExtension,
        });
        succeed();
        return;
      }
      if (request.operation === "close") {
        database?.close();
        database = undefined;
        statements.clear();
        succeed();
        port.close();
        return;
      }
      if (database === undefined) throw new Error("SQLite database is not open");
      // SQLITE_FULL can roll back the transaction and all of its savepoints.
      // Cleanup must preserve that failure rather than report a second rollback error.
      if (
        !database.isTransaction &&
        (request.sql === "ROLLBACK" || request.sql.startsWith("ROLLBACK TO SAVEPOINT "))
      ) {
        succeed();
        return;
      }
      operation = "prepare";
      let entry = request.cached ? statements.get(request.sql) : undefined;
      if (entry !== undefined && entry.expiresAt <= Date.now()) {
        statements.delete(request.sql);
        entry = undefined;
      }
      if (entry === undefined) {
        const statement = database.prepare(request.sql);
        entry = {
          statement,
          hasRows: statement.columns().length > 0,
          expiresAt: Date.now() + config.prepareCacheTTL,
        };
      }
      if (request.cached && config.prepareCacheSize > 0) {
        statements.delete(request.sql);
        statements.set(request.sql, entry);
        if (statements.size > config.prepareCacheSize) {
          const oldest = statements.keys().next().value;
          if (oldest !== undefined) statements.delete(oldest);
        }
      }
      operation = "execute";
      const { statement, hasRows } = entry;
      statement.setReadBigInts(request.safeIntegers);
      statement.setReturnArrays(request.mode === "values");
      // SqlConnection's bind parameters are unknown; native SQLite validates them.
      const params = request.params as ReadonlyArray<NodeSqlite.SQLInputValue>;
      if (hasRows) {
        const rows = statement.all(...params);
        if (request.mode === "values") {
          // Node's types still describe named rows after setReturnArrays(true).
          succeed([], rows as unknown as ReadonlyArray<ReadonlyArray<NodeSqlite.SQLOutputValue>>);
        } else {
          succeed(rows);
        }
      } else {
        const result = statement.run(...params);
        succeed([], [], request.mode === "raw" ? result : undefined);
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
    }
  });
}
