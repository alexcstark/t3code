import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { POWER_RESUME_CHANNEL } from "../ipc/channels.ts";
import * as DesktopPowerResume from "./DesktopPowerResume.ts";

describe("DesktopPowerResume", () => {
  it.effect("broadcasts OS resume to every renderer", () =>
    Effect.gen(function* () {
      const notified = yield* Deferred.make<string>();
      let resumeListener: (() => void) | undefined;
      yield* Layer.build(
        DesktopPowerResume.layer.pipe(
          Layer.provide(
            Layer.succeed(ElectronPowerMonitor.ElectronPowerMonitor, {
              isOnBatteryPower: Effect.succeed(false),
              getSystemIdleTime: Effect.succeed(0),
              getSystemIdleState: () => Effect.succeed("active"),
              getCurrentThermalState: Effect.succeed("nominal"),
              onSimpleEvent: (eventName, listener) =>
                Effect.sync(() => {
                  if (eventName === "resume") {
                    resumeListener = listener;
                  }
                }).pipe(Effect.asVoid),
              onThermalStateChange: () => Effect.void,
              onSpeedLimitChange: () => Effect.void,
            } satisfies ElectronPowerMonitor.ElectronPowerMonitor["Service"]),
          ),
          Layer.provide(
            Layer.succeed(ElectronWindow.ElectronWindow, {
              create: () => Effect.die("unexpected window creation"),
              main: Effect.die("unexpected main window read"),
              currentMainOrFirst: Effect.die("unexpected current window read"),
              focusedMainOrFirst: Effect.die("unexpected focused window read"),
              setMain: () => Effect.void,
              clearMain: () => Effect.void,
              prepareReveal: () => Effect.succeed(false),
              reveal: () => Effect.void,
              sendAll: (channel) => Deferred.succeed(notified, channel).pipe(Effect.asVoid),
              destroyAll: Effect.void,
              syncAllAppearance: () => Effect.void,
            } satisfies ElectronWindow.ElectronWindow["Service"]),
          ),
        ),
      );

      assert.ok(resumeListener);
      resumeListener();
      assert.equal(yield* Deferred.await(notified), POWER_RESUME_CHANNEL);
    }),
  );
});
