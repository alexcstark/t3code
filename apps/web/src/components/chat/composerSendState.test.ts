import { AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createComposerSendState } from "./composerSendState";

const registries: AtomRegistry.AtomRegistry[] = [];
const createState = () => {
  const registry = AtomRegistry.make();
  registries.push(registry);
  return { registry, state: createComposerSendState(registry) };
};

const deferredResponse = () => {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolveResponse, rejectResponse) => {
    resolve = resolveResponse;
    reject = rejectResponse;
  });
  if (!resolve || !reject) throw new Error("Promise executor did not initialize the response");
  return { promise, resolve, reject };
};

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe("composer submission state", () => {
  it("keeps the busy indicator subscribed until the submission response arrives", async () => {
    const { registry, state } = createState();
    const response = deferredResponse();
    const busyStates: boolean[] = [];
    const unsubscribe = registry.subscribe(state.pendingAtom, (pending) =>
      busyStates.push(pending),
    );
    const submission = state.run(async () => {
      state.current = true;
      await response.promise;
    });

    expect(state.current).toBe(true);
    expect(registry.get(state.pendingAtom)).toBe(true);
    expect(busyStates).toEqual([true]);

    // Navigating away drops the subscriber, but the originating request still owns the state.
    unsubscribe();
    expect(registry.get(state.pendingAtom)).toBe(true);
    response.resolve();
    await submission;
    expect(registry.get(state.pendingAtom)).toBe(false);
  });

  it("allows another send after a submission throws", async () => {
    const { registry, state } = createState();
    const response = deferredResponse();
    const submission = state.run(async () => {
      state.current = true;
      await response.promise;
    });
    const rejected = expect(submission).rejects.toThrow("Connection lost");
    response.reject(new Error("Connection lost"));
    await rejected;

    expect(state.current).toBe(false);
    expect(registry.get(state.pendingAtom)).toBe(false);
    await state.run(async () => {
      expect(state.current).toBe(false);
      state.current = true;
    });
    expect(state.current).toBe(false);
  });

  it("does not release a pending send when a duplicate submission is blocked", async () => {
    const { state } = createState();
    const response = deferredResponse();
    const submission = state.run(async () => {
      state.current = true;
      await response.promise;
    });

    await state.run(async () => {
      if (state.current) return;
      throw new Error("The duplicate should be blocked");
    });
    expect(state.current).toBe(true);

    response.resolve();
    await submission;
    expect(state.current).toBe(false);
  });

  it("does not release a newer send when background submissions finish later", async () => {
    const { state } = createState();
    const backgroundResponse = deferredResponse();
    const nextResponse = deferredResponse();
    const background = state.run(async () => {
      state.current = true;
      state.current = false;
      await backgroundResponse.promise;
    });
    const next = state.run(async () => {
      state.current = true;
      await nextResponse.promise;
    });

    backgroundResponse.resolve();
    await background;
    expect(state.current).toBe(true);

    nextResponse.resolve();
    await next;
    expect(state.current).toBe(false);
  });
});
