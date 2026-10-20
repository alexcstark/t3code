import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  providerCapacityActivityLabel,
  rankProviderCapacity,
  scheduleProviderCapacityExpiry,
  type ProviderCapacityEnvironment,
} from "./providerCapacity.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const now = Date.parse("2026-10-20T12:00:00Z");

function window(usedPercent: number, kind: ServerProviderUsageWindow["kind"] = "session") {
  return { id: kind, kind, label: kind, usedPercent };
}

function provider(
  id: string,
  windows: readonly ServerProviderUsageWindow[] = [],
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-20T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-10-20T12:00:00Z", windows },
    ...overrides,
  };
}

function thread(
  id: string,
  provider: ServerProvider,
  status: "preparing" | "starting" | "running" | "waiting" | "idle" | "completed" = "running",
) {
  return { id: ThreadId.make(id), providerInstanceId: provider.instanceId, status };
}

function rank(
  providers: readonly ServerProvider[],
  environments: readonly ProviderCapacityEnvironment[] = [
    { environmentId: local, providers, threads: [] },
  ],
  currentThreadId: ThreadId | null = null,
) {
  return rankProviderCapacity({
    environmentId: local,
    providers,
    environments,
    currentThreadId,
    now,
  });
}

describe("provider capacity", () => {
  it("ranks the least remaining window instead of hiding an exhausted weekly allowance", () => {
    const highSession = provider("high-session", [window(5), window(99, "weekly")]);
    const balanced = provider("balanced", [window(30), window(40, "weekly")]);
    const exhausted = provider("exhausted", [window(100)]);
    const unknown = provider("unknown");
    expect(
      rank([highSession, unknown, exhausted, balanced]).map((item) => [
        item.provider.instanceId,
        item.remainingPercent,
        item.limitingWindow,
      ]),
    ).toEqual([
      ["balanced", 60, "weekly"],
      ["high-session", 1, "weekly"],
      ["exhausted", 0, "session"],
      ["unknown", null, null],
    ]);
  });

  it("breaks quota ties using other running threads and excludes this thread and settled work", () => {
    const busy = provider("busy", [window(20)]);
    const idle = provider("idle", [window(20)]);
    const rows = rank(
      [busy, idle],
      [
        {
          environmentId: local,
          providers: [busy, idle],
          threads: [
            thread("current", idle),
            thread("old-idle", idle, "idle"),
            thread("completed", idle, "completed"),
            thread("preparing", busy, "preparing"),
            thread("starting", busy, "starting"),
            thread("running", busy),
            { ...thread("suspended", busy, "waiting"), activityRunStatus: "waiting" },
          ],
        },
      ],
      ThreadId.make("current"),
    );
    expect(rows.map((item) => [item.provider.instanceId, item.activeThreadCount])).toEqual([
      ["idle", 0],
      ["busy", 4],
    ]);
    expect(rows.map(providerCapacityActivityLabel)).toEqual(["Idle in T3", "4 running elsewhere"]);
  });

  it("counts shared logins across instances and environments without mixing different workspaces", () => {
    const work = provider("work", [window(10)], {
      auth: { status: "authenticated", email: "user@example.com", workspaceId: "work" },
    });
    const alias = provider("alias", [], {
      auth: { status: "authenticated", email: "USER@example.com", workspaceId: "work" },
    });
    const personal = provider("personal", [], {
      auth: { status: "authenticated", email: "user@example.com", workspaceId: "personal" },
    });
    const [capacity] = rank(
      [work],
      [
        { environmentId: local, providers: [work, alias], threads: [thread("local", alias)] },
        {
          environmentId: remote,
          providers: [alias, personal],
          threads: [thread("remote", alias), thread("personal", personal)],
        },
      ],
    );
    expect(capacity).toMatchObject({ activeThreadCount: 2, activityKnown: true });
  });

  describe.each(
    [
      { direction: "known-to-missing", workspaceId: "work", otherWorkspaceId: undefined },
      { direction: "missing-to-known", workspaceId: undefined, otherWorkspaceId: "work" },
    ].flatMap((direction) =>
      (["email", "fingerprint"] as const).map((identity) => ({ ...direction, identity })),
    ),
  )(
    "$direction workspace activity using $identity",
    ({ workspaceId, otherWorkspaceId, identity }) => {
      const selected = provider("selected", [], {
        auth: {
          status: "authenticated",
          email: identity === "email" ? "user@example.com" : undefined,
          workspaceId,
        },
        usageLimits: {
          checkedAt: "2026-10-20T12:00:00Z",
          windows: [],
          credentialFingerprint: identity === "fingerprint" ? "same-credential" : undefined,
        },
      });
      const confirmed = { ...selected, instanceId: ProviderInstanceId.make("confirmed") };
      const ambiguous = {
        ...selected,
        auth: { ...selected.auth, workspaceId: otherWorkspaceId },
      };
      const currentThreadId = ThreadId.make("current");

      it.each([
        { activity: "running", status: "running", activityKnown: false },
        { activity: "unavailable", status: null, activityKnown: false },
        { activity: "idle", status: "idle", activityKnown: true },
      ] as const)(
        "preserves known counts when ambiguous activity is $activity",
        ({ status, activityKnown }) => {
          const environments: ProviderCapacityEnvironment[] = [
            {
              environmentId: local,
              providers: [selected, confirmed],
              threads: [thread("current", selected)],
            },
            {
              environmentId: remote,
              providers: [ambiguous],
              threads: status === null ? null : [thread("current", ambiguous, status)],
            },
          ];
          const rows = rank([selected], environments, currentThreadId);
          expect(rows[0]).toMatchObject({ activeThreadCount: 0, activityKnown });
          expect(rows.map(providerCapacityActivityLabel)).toEqual([
            activityKnown ? "Idle in T3" : "Activity unknown",
          ]);

          environments[0] = {
            environmentId: local,
            providers: [selected, confirmed],
            threads: [thread("current", selected), thread("known", confirmed)],
          };
          const partial = rank([selected], environments, currentThreadId);
          expect(partial[0]).toMatchObject({ activeThreadCount: 1, activityKnown });
          expect(partial.map(providerCapacityActivityLabel)).toEqual([
            activityKnown ? "1 running elsewhere" : "1+ running elsewhere",
          ]);
        },
      );

      it("handles local workspace ambiguity and excludes the current thread", () => {
        const alias = { ...ambiguous, instanceId: ProviderInstanceId.make("alias") };
        const threads = [thread("current", alias), thread("known", selected)];
        const environments = [{ environmentId: local, providers: [selected, alias], threads }];
        const rows = rank([selected], environments, currentThreadId);
        expect(rows[0]).toMatchObject({ activeThreadCount: 1, activityKnown: true });
        expect(rows.map(providerCapacityActivityLabel)).toEqual(["1 running elsewhere"]);

        threads.push(thread("ambiguous", alias));
        const partial = rank([selected], environments, currentThreadId);
        expect(partial[0]).toMatchObject({ activeThreadCount: 1, activityKnown: false });
        expect(partial.map(providerCapacityActivityLabel)).toEqual(["1+ running elsewhere"]);
      });
    },
  );

  it.each([undefined, "work"])(
    "recognizes identical credentials in workspace %s without email",
    (workspaceId) => {
      const first = provider("first", [], {
        auth: { status: "authenticated", workspaceId },
        usageLimits: {
          checkedAt: "2026-10-20T12:00:00Z",
          windows: [],
          credentialFingerprint: "same-credential",
        },
      });
      const second = { ...first, instanceId: ProviderInstanceId.make("second") };
      const rows = rank(
        [first],
        [{ environmentId: local, providers: [first, second], threads: [thread("other", second)] }],
      );
      expect(rows[0]).toMatchObject({ activeThreadCount: 1, activityKnown: true });
    },
  );

  it("keeps identical instance names on different environments independent without shared identity", () => {
    const first = provider("codex");
    const rows = rank(
      [first],
      [
        { environmentId: local, providers: [first], threads: [] },
        { environmentId: remote, providers: [first], threads: [thread("remote", first)] },
      ],
    );
    expect(rows[0]?.activeThreadCount).toBe(0);
    expect(rows.map(providerCapacityActivityLabel)).toEqual(["Idle in T3"]);
  });

  it("never claims idle when a matching environment has no live activity", () => {
    const shared = provider("shared", [], {
      auth: { status: "authenticated", email: "user@example.com" },
    });
    const rows = rank(
      [shared],
      [
        { environmentId: local, providers: [shared], threads: [] },
        { environmentId: remote, providers: [shared], threads: null },
      ],
    );
    expect(rows.map(providerCapacityActivityLabel)).toEqual(["Activity unknown"]);
    const partial = rank(
      [shared],
      [
        { environmentId: local, providers: [shared], threads: [thread("running", shared)] },
        { environmentId: remote, providers: [shared], threads: null },
      ],
    );
    expect(partial.map(providerCapacityActivityLabel)).toEqual(["1+ running elsewhere"]);
  });

  it.each([
    { reason: "unsupported", windows: [window(0)] },
    { reason: "probeFailed", windows: [window(0)] },
  ] as const)(
    "does not rank unavailable $reason quota as spare capacity",
    ({ reason, windows }) => {
      const limits: ServerProviderUsageLimits = {
        checkedAt: "2026-10-20T12:00:00Z",
        windows,
        unavailable: { reason },
      };
      expect(
        rank([provider("unavailable", [], { usageLimits: limits })])[0]?.remainingPercent,
      ).toBeNull();
    },
  );

  it("requires a fresh reading after a reset instead of assuming the window refilled", () => {
    const expired = provider("expired", [{ ...window(0), resetsAt: "2026-10-20T11:00:00Z" }]);
    expect(rank([expired])[0]?.usageStatus).toBe("Usage needs refresh");
    expect(rank([expired])[0]?.remainingPercent).toBeNull();
  });
});

describe("provider capacity expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => vi.useRealTimers());

  function readCapacity(providers: readonly ServerProvider[]) {
    return rankProviderCapacity({
      environmentId: local,
      providers,
      environments: [],
      now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });
  }

  it("invalidates and reranks at the first reset, including a non-limiting window", async () => {
    const providers = [
      provider("first", [
        { ...window(90), resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 2_000)) },
        { ...window(20, "weekly"), resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1_000)) },
      ]),
      provider("second", [window(95)]),
    ];
    let capacity = readCapacity(providers);
    const expire = vi.fn(() => {
      capacity = readCapacity(providers);
    });
    scheduleProviderCapacityExpiry(capacity, expire);
    expect(capacity.map((item) => item.remainingPercent)).toEqual([10, 5]);

    await vi.advanceTimersByTimeAsync(999);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(capacity.map((item) => [item.provider.instanceId, item.remainingPercent])).toEqual([
      ["second", 5],
      ["first", null],
    ]);
    expect(capacity[1]?.usageStatus).toBe("Usage needs refresh");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expire).toHaveBeenCalledOnce();
  });

  it("cancels the previous deadline when a fresh quota reading replaces it", async () => {
    const old = provider("account", [
      { ...window(90), resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1_000)) },
    ]);
    const expire = vi.fn();
    const cancel = scheduleProviderCapacityExpiry(readCapacity([old]), expire);
    await vi.advanceTimersByTimeAsync(500);
    cancel?.();

    const fresh = provider("account", [
      { ...window(30), resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 4_000)) },
    ]);
    let capacity = readCapacity([fresh]);
    const expireFresh = vi.fn(() => {
      capacity = readCapacity([fresh]);
    });
    scheduleProviderCapacityExpiry(capacity, expireFresh);
    await vi.advanceTimersByTimeAsync(500);
    expect(expire).not.toHaveBeenCalled();
    expect(expireFresh).not.toHaveBeenCalled();
    expect(capacity[0]?.remainingPercent).toBe(70);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(expireFresh).toHaveBeenCalledOnce();
    expect(capacity[0]?.remainingPercent).toBeNull();
  });

  it("does not schedule wakeups for unknown, expired, unavailable or undated quotas", async () => {
    const providers = [
      provider("unknown"),
      provider("expired", [
        { ...window(20), resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
      ]),
      provider("unavailable", [], {
        usageLimits: {
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          windows: [
            { ...window(20), resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1_000)) },
          ],
          unavailable: { reason: "probeFailed" },
        },
      }),
      provider("undated", [window(20)]),
    ];
    const expire = vi.fn();
    scheduleProviderCapacityExpiry(readCapacity(providers), expire);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires immediately if the reset passes between calculating and scheduling", async () => {
    const providers = [
      provider("account", [
        { ...window(20), resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1_000)) },
      ]),
    ];
    let capacity = readCapacity(providers);
    expect(capacity[0]?.remainingPercent).toBe(80);
    vi.setSystemTime(now + 2_000);
    scheduleProviderCapacityExpiry(capacity, () => {
      capacity = readCapacity(providers);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(capacity[0]?.remainingPercent).toBeNull();
  });
});
