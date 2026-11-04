import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export class HostStallRefresh extends Context.Service<
  HostStallRefresh,
  {
    readonly note: (environmentId: EnvironmentId, detectedAt: string) => Effect.Effect<void>;
    readonly changes: (environmentId: EnvironmentId) => Stream.Stream<string>;
  }
>()("@t3tools/client-runtime/connection/hostStallRefresh") {}

export const layer = Layer.effect(
  HostStallRefresh,
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<{
      readonly environmentId: EnvironmentId;
      readonly detectedAt: string;
    }>();
    return HostStallRefresh.of({
      note: Effect.fn("HostStallRefresh.note")(function* (environmentId, detectedAt) {
        yield* PubSub.publish(events, { environmentId, detectedAt });
      }),
      changes: (environmentId) =>
        Stream.fromPubSub(events).pipe(
          Stream.filter((event) => event.environmentId === environmentId),
          Stream.map((event) => event.detectedAt),
        ),
    });
  }),
);

/** Emits after `arm` runs, so a resubscribe sees the flag. `Stream.never` when the service is absent. */
export function reloadOnHostStall(
  stalls: Option.Option<HostStallRefresh["Service"]>,
  environmentId: EnvironmentId,
  arm: Effect.Effect<void>,
): Stream.Stream<void> {
  return Option.match(stalls, {
    onNone: () => Stream.never,
    onSome: (service) => service.changes(environmentId).pipe(Stream.mapEffect(() => arm)),
  });
}
