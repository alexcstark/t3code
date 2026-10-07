import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { POWER_RESUME_CHANNEL } from "../ipc/channels.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
    const runEffect = Effect.runPromiseWith(context);
    yield* powerMonitor.onSimpleEvent("resume", () => {
      void runEffect(electronWindow.sendAll(POWER_RESUME_CHANNEL));
    });
  }),
);
