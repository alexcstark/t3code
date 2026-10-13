import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

/** Consistent committed reads that do not queue behind the server's writer. */
export class DatabaseReader extends Context.Service<
  DatabaseReader,
  { readonly withTransaction: SqlClient.SqlClient["withTransaction"] }
>()("t3/persistence/DatabaseReader") {}

export const layerFile = (filename: string) =>
  Layer.effect(
    DatabaseReader,
    Effect.gen(function* () {
      const writer = yield* SqlClient.SqlClient;
      const readerContext = yield* Layer.build(
        NodeSqliteClient.layerWorker({
          filename,
          readonly: true,
          spanAttributes: { "db.connection.role": "reader" },
        }),
      );
      const reader = Context.get(readerContext, SqlClient.SqlClient);
      yield* reader`PRAGMA busy_timeout = 5000`;
      return DatabaseReader.of({
        withTransaction: (effect) =>
          Effect.serviceOption(writer.transactionService).pipe(
            Effect.flatMap((transaction) => {
              // Nested snapshots reuse their reader lease; reads inside a
              // command must see that command's uncommitted changes.
              if (Option.isSome(transaction)) return writer.withTransaction(effect);
              return reader.withTransaction(
                Effect.flatMap(Effect.serviceOption(reader.transactionService), (connection) =>
                  // Statements captured by stores use the writer's transaction
                  // tag. Route those statements onto this read-only snapshot.
                  Effect.provideService(
                    effect,
                    writer.transactionService,
                    Option.getOrThrow(connection),
                  ),
                ),
              );
            }),
          ),
      });
    }),
  );
