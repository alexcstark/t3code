import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

/** Consistent committed reads that do not queue behind the server's writer. */
export class DatabaseReader extends Context.Service<
  DatabaseReader,
  { readonly withTransaction: SqlClient.SqlClient["withTransaction"] }
>()("t3/persistence/DatabaseReader") {}

export const layer = Layer.effect(
  DatabaseReader,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return DatabaseReader.of({
      withTransaction: (effect) => sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly),
    });
  }),
);
