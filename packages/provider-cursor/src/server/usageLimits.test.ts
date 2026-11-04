import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

it.layer(NodeServices.layer)("Cursor usage limits", (it) => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("reports the billing-cycle length so pace can be computed", () => {
    const planUsage = { totalPercentUsed: 40, autoPercentUsed: 30, apiPercentUsed: 20 };
    const durations = (billingCycleStart: string | number | undefined, billingCycleEnd: string) =>
      cursorUsageResponseToLimits(
        { billingCycleStart, billingCycleEnd, planUsage },
        checkedAt,
      ).windows.map((window) => window.windowDurationMins);
    expect(durations("1794045847072", "1796637847072")).toEqual([43_200, 43_200, 43_200]);
    expect(durations(1_796_637_847_072, "1799316247072")).toEqual([44_640, 44_640, 44_640]);
  });

  it("omits the cycle length when the start is missing or invalid", () => {
    for (const billingCycleStart of [undefined, "", "0", "not-a-number", "1796637847072"]) {
      expect(
        cursorUsageResponseToLimits(
          {
            billingCycleStart,
            billingCycleEnd: "1796637847072",
            planUsage: { totalPercentUsed: 40 },
          },
          checkedAt,
        ).windows,
      ).toEqual([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 40,
          resetsAt: "2026-12-07T10:04:07.072Z",
        },
      ]);
    }
  });

  it("retains unified totals for account aggregation", () => {
    const windows = cursorUsageResponseToLimits(
      { planUsage: { totalPercentUsed: 1.77, autoPercentUsed: 1.77 } },
      checkedAt,
    ).windows;
    expect(windows.map((window) => window.id)).toEqual(["autoPercentUsed", "totalPercentUsed"]);
    expect(
      cursorUsageResponseToLimits(
        { planUsage: { totalPercentUsed: 100, apiPercentUsed: 100 } },
        checkedAt,
      ).windows.map((window) => window.id),
    ).toEqual(["apiPercentUsed", "totalPercentUsed"]);
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it.effect("requires explicit credentials and accepts an auth token", () =>
    Effect.gen(function* () {
      for (const token of [undefined, "explicit-token"]) {
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          token ? { CURSOR_AUTH_TOKEN: token } : {},
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(token).toBe("explicit-token");
              expect(request.headers.authorization).toBe("Bearer explicit-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 10 } }),
                ),
              );
            }),
          ),
        );
        if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
        else expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect("reports failed requests without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_AUTH_TOKEN: "private-token" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("private response", { status: 401 }),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("exchanges an API key to read its account limits", () =>
    Effect.gen(function* () {
      const requests: Array<readonly [string, string | undefined]> = [];
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_API_KEY: "api-key" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push([request.url, request.headers.authorization]);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/auth/exchange_user_api_key")
                    ? { accessToken: "api-key-access-token" }
                    : { planUsage: { totalPercentUsed: 37 } },
                ),
              ),
            );
          }),
        ),
      );
      expect(requests).toEqual([
        ["https://api2.cursor.sh/auth/exchange_user_api_key", "Bearer api-key"],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          "Bearer api-key-access-token",
        ],
      ]);
      expect(limits.windows[0]?.usedPercent).toBe(37);
    }),
  );

  it.effect("does not send an API key to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", { CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000", CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example", CURSOR_API_KEY: "api-key" }],
        ["https://cursor-proxy.example", { CURSOR_API_KEY: "api-key" }],
      ] as const) {
        const limits = yield* readCursorUsageLimits({ apiEndpoint }, environment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send an API key to a proxy")),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );
  it.effect("reads each instance's usage login file and picks up refreshed credentials", () =>
    Effect.provide(NodeServices.layer)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const client = HttpClient.make((request) => {
          const usedPercent = {
            "Bearer personal-token": 1.3,
            "Bearer work-token": 87.3,
            "Bearer refreshed-work-token": 88,
          }[request.headers.authorization ?? ""];
          expect(usedPercent).toBeDefined();
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ planUsage: { totalPercentUsed: usedPercent } }),
            ),
          );
        });
        for (const [name, token, usedPercent] of [
          ["personal", "personal-token", 1.3],
          ["work", "work-token", 87.3],
          ["work", "refreshed-work-token", 88],
        ] as const) {
          const authFile = path.join(directory, `${name}.json`);
          yield* fs.writeFileString(authFile, JSON.stringify({ accessToken: token }));
          const limits = yield* readCursorUsageLimits(
            { apiEndpoint: "" },
            {
              CURSOR_API_KEY: "sdk-browser-key",
              CURSOR_USAGE_AUTH_FILE: authFile,
              AGENT_CLI_CREDENTIAL_STORE: "memory",
            },
          ).pipe(Effect.provideService(HttpClient.HttpClient, client));
          expect(limits.windows[0]?.usedPercent).toBe(usedPercent);
        }
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("does not fall back to another login when the configured usage file is invalid", () =>
    Effect.provide(NodeServices.layer)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "cursor"));
        yield* fs.writeFileString(
          path.join(directory, "cursor", "auth.json"),
          JSON.stringify({ accessToken: "unrelated-account-token" }),
        );
        const authFile = path.join(directory, "usage-login.json");
        for (const contents of [undefined, "invalid json", "{}", '{"accessToken":"  "}']) {
          if (contents !== undefined) yield* fs.writeFileString(authFile, contents);
          const limits = yield* readCursorUsageLimits(
            { apiEndpoint: "" },
            { CURSOR_USAGE_AUTH_FILE: authFile, XDG_CONFIG_HOME: directory },
          ).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not request another account's usage")),
            ),
          );
          expect(limits.windows).toEqual([]);
          expect(limits.unavailable?.reason).toBe(
            contents === undefined || contents === "invalid json" ? "probeFailed" : "unsupported",
          );
        }
      }).pipe(Effect.scoped),
    ),
  );
});
