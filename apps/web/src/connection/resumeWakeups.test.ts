import { describe, expect, it } from "@effect/vitest";

import { subscribeResumeReconnectWakeups } from "./resumeWakeups";

describe("subscribeResumeReconnectWakeups", () => {
  it("replaces the session on desktop OS resume", () => {
    const emitted: number[] = [];
    let resumeListener: (() => void) | undefined;
    const unsubscribe = subscribeResumeReconnectWakeups(() => emitted.push(1), {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      onPowerResume: (listener) => {
        resumeListener = listener;
        return () => {
          resumeListener = undefined;
        };
      },
      now: () => 10_000,
    });

    resumeListener?.();
    expect(emitted).toEqual([1]);
    unsubscribe();
    expect(resumeListener).toBeUndefined();
  });

  it("replaces the session when a frozen page resumes", () => {
    const emitted: number[] = [];
    const listeners = new Map<string, () => void>();
    subscribeResumeReconnectWakeups(() => emitted.push(1), {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      removeEventListener: () => undefined,
      now: () => 10_000,
    });

    listeners.get("resume")?.();
    expect(emitted).toEqual([1]);
  });

  it("does not replace twice for a burst of resume signals", () => {
    const emitted: number[] = [];
    let at = 10_000;
    let resumeListener: (() => void) | undefined;
    subscribeResumeReconnectWakeups(() => emitted.push(at), {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      onPowerResume: (listener) => {
        resumeListener = listener;
        return () => undefined;
      },
      now: () => at,
    });

    resumeListener?.();
    at = 10_500;
    resumeListener?.();
    at = 11_000;
    resumeListener?.();
    expect(emitted).toEqual([10_000, 11_000]);
  });
});
