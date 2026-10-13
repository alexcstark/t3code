import { Atom, type AtomRegistry } from "effect/reactivity";

/** One submission state for both the send guard and the composer's busy indicator. */
export function createComposerSendState(registry: AtomRegistry.AtomRegistry) {
  const pendingAtom = Atom.make(false).pipe(Atom.keepAlive);
  let generation = 0;

  return {
    pendingAtom,
    get current() {
      return registry.get(pendingAtom);
    },
    set current(pending: boolean) {
      if (pending) generation += 1;
      registry.set(pendingAtom, pending);
    },
    async run<A>(submit: () => Promise<A>): Promise<A> {
      const previousGeneration = generation;
      let submittedGeneration = previousGeneration;
      try {
        let request: Promise<A>;
        try {
          request = submit();
        } finally {
          submittedGeneration = generation;
        }
        return await request;
      } finally {
        // Background submissions can release the composer before they finish.
        // Their eventual completion must not release a newer submission.
        if (submittedGeneration !== previousGeneration && generation === submittedGeneration) {
          registry.set(pendingAtom, false);
        }
      }
    },
  };
}
