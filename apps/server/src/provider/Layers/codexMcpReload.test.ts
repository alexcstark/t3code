import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { refreshCodexMcpCatalog } from "./CodexSessionRuntime.ts";

it.effect("surfaces a hung MCP reload after the bound and still completes", () =>
  Effect.gen(function* () {
    let unavailable = 0;
    const scope = yield* Scope.make();
    const fiber = yield* Effect.forkIn(
      refreshCodexMcpCatalog(
        () => Effect.never,
        () =>
          Effect.sync(() => {
            unavailable += 1;
          }),
      ),
      scope,
    );
    yield* TestClock.adjust("10 seconds");
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(unavailable).toBe(1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("surfaces a failed MCP reload immediately", () =>
  Effect.gen(function* () {
    let unavailable = 0;
    yield* refreshCodexMcpCatalog(
      () => Effect.die("backend down"),
      () =>
        Effect.sync(() => {
          unavailable += 1;
        }),
    );
    expect(unavailable).toBe(1);
  }),
);

it.effect("a healthy reload completes silently", () =>
  Effect.gen(function* () {
    let unavailable = 0;
    yield* refreshCodexMcpCatalog(
      () => Effect.succeed({}),
      () =>
        Effect.sync(() => {
          unavailable += 1;
        }),
    );
    expect(unavailable).toBe(0);
  }),
);
