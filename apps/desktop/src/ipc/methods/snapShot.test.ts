import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import {
  listPendingSnapShots,
  setupSnapShot,
  previewSnapShotConfig,
  applySnapShotConfig,
  snapShotRelativeFrame,
} from "./snapShot.ts";

function trustedSnapShotWindow(
  window: {
    readonly webContents: { readonly id: number; readonly getZoomFactor?: () => number };
    readonly getContentBounds?: () => {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly getBounds?: () => {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  },
  extras: ReadonlyArray<typeof window> = [],
) {
  const windows = [window, ...extras];
  return ElectronWindow.ElectronWindow.of({
    forWebContentsId: (webContentsId: number) =>
      Effect.succeed(
        Option.fromNullishOr(windows.find((entry) => entry.webContents.id === webContentsId)),
      ),
  } as ElectronWindow.ElectronWindow["Service"]);
}

describe("window capture IPC", () => {
  const configPreview = {
    id: "12345678-1234-1234-1234-123456789abc",
    path: "/config/niri/config.kdl",
    resolvedPath: "/config/niri/config.kdl",
    before: "binds {}\n",
    after: "binds {\n}\n",
    shortcut: "Ctrl+Shift+2",
    operation: "install" as const,
  };
  it.effect("requires a trusted renderer for both config read and write approval", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const request = { operation: "install" as const, chooseFile: false };
      const untrustedRead = yield* Effect.exit(
        previewSnapShotConfig.handler(request, { sender: { id: 8 } }),
      );
      const untrustedWrite = yield* Effect.exit(
        applySnapShotConfig.handler(configPreview.id, { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(untrustedRead));
      assert(Exit.isFailure(untrustedWrite));
      assert.deepEqual(calls, []);
      yield* previewSnapShotConfig.handler(request, { sender: { id: 7 } });
      assert.deepEqual(calls, ["read"]);
      yield* applySnapShotConfig.handler(configPreview.id, { sender: { id: 7 } });
      assert.deepEqual(calls, ["read", configPreview.id]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            ElectronWindow.ElectronWindow,
            trustedSnapShotWindow({ webContents: { id: 7 } }),
          ),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            previewConfig: () =>
              Effect.sync(() => {
                calls.push("read");
                return configPreview;
              }),
            applyConfig: (id: string) =>
              Effect.sync(() => {
                calls.push(id);
                return { backupPath: null, warning: null };
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
          Layer.succeed(
            ElectronDialog.ElectronDialog,
            {} as ElectronDialog.ElectronDialog["Service"],
          ),
        ),
      ),
    );
  });

  it.effect("allows capture setup from any registered app window", () => {
    const actions: string[] = [];
    return Effect.gen(function* () {
      yield* setupSnapShot.handler("install-extension", { sender: { id: 7 } });
      yield* setupSnapShot.handler("enable-extension", { sender: { id: 9 } });
      assert.deepEqual(actions, ["install-extension", "enable-extension"]);
      const rejected = yield* Effect.exit(
        setupSnapShot.handler("enable-extension", { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(rejected));
      assert.deepEqual(actions, ["install-extension", "enable-extension"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            ElectronWindow.ElectronWindow,
            trustedSnapShotWindow({ webContents: { id: 7 } }, [{ webContents: { id: 9 } }]),
          ),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            setup: (action: string) =>
              Effect.sync(() => {
                actions.push(action);
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
        ),
      ),
    );
  });

  it.effect("lists pending snapshots from a non-main app window", () => {
    const pending = [
      {
        id: "12345678-1234-1234-1234-123456789abc",
        name: "Capture.png",
        mimeType: "image/png" as const,
        sizeBytes: 128,
        source: {
          kind: "snap-shot" as const,
          capturedAt: "2026-08-24T11:00:00.000Z",
          appName: "Editor",
          windowTitle: "main.ts",
        },
      },
    ];
    return Effect.gen(function* () {
      const listed = yield* listPendingSnapShots.handler(undefined, { sender: { id: 9 } });
      assert.deepEqual(listed, pending);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            ElectronWindow.ElectronWindow,
            trustedSnapShotWindow({ webContents: { id: 7 } }, [{ webContents: { id: 9 } }]),
          ),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            listPending: Effect.succeed(pending),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
        ),
      ),
    );
  });
});

it("normalizes Wayland attachment coordinates without trusting Electron's screen origin", () => {
  const frame = { x: 100, y: 300, width: 200, height: 100 };
  const bounds = { x: 0, y: 0, width: 1000, height: 600 };
  assert.deepEqual(snapShotRelativeFrame(frame, bounds, 1.25), {
    x: 0.125,
    y: 0.625,
    width: 0.25,
    height: 125 / 600,
  });
  assert.deepEqual(
    snapShotRelativeFrame(frame, { ...bounds, x: -3840, y: 900 }, 1.25),
    snapShotRelativeFrame(frame, bounds, 1.25),
  );
  assert.isUndefined(snapShotRelativeFrame(frame, { ...bounds, width: 0 }, 1));
});
