import { type ClientActivityReportInput, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  observeBackgroundActivitySubscription,
  reportClientActivity,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
} from "./backgroundActivityReporter.ts";

describe("background activity reporting", () => {
  it.effect("skips a disconnected session and resumes reports after reconnecting", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("activity-report-test");
      const input: ClientActivityReportInput = {
        environmentId,
        clientId: "activity-test-client",
        clientKind: "desktop-renderer",
        visible: true,
        focused: true,
        recentlyInteracted: true,
        appState: "active",
        scopes: [{ type: "provider-status" }],
        ttlMs: 45_000,
        observedAt: DateTime.makeUnsafe(10_000),
      };
      const reports: ClientActivityReportInput[] = [];
      const client = {
        [WS_METHODS.serverReportClientActivity]: (report: ClientActivityReportInput) =>
          Effect.sync(() => {
            reports.push(report);
          }),
      } as unknown as WsRpcProtocolClient;
      const connectedSession: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Activity test",
          httpBaseUrl: "http://activity.test",
          wsBaseUrl: "ws://activity.test",
        }),
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session,
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const report = reportClientActivity(input).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      yield* report;
      expect(reports).toEqual([]);
      yield* SubscriptionRef.set(session, Option.some(connectedSession));
      yield* report;
      expect(reports).toEqual([input]);
      yield* SubscriptionRef.set(session, Option.none());
      yield* report;
      expect(reports).toEqual([input]);
      yield* SubscriptionRef.set(session, Option.some(connectedSession));
      yield* report;
      expect(reports).toEqual([input, input]);
    }),
  );
});

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const releasePassive = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd, includeRemote: false },
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* releasePassive;
      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});
