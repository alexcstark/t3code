const RESUME_RECONNECT_DEBOUNCE_MS = 1_000;

export function subscribeResumeReconnectWakeups(
  emit: () => void,
  options: {
    readonly addEventListener?: (type: string, listener: () => void) => void;
    readonly removeEventListener?: (type: string, listener: () => void) => void;
    readonly onPowerResume?: ((listener: () => void) => () => void) | undefined;
    readonly now?: () => number;
    readonly debounceMs?: number;
  } = {},
): () => void {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? RESUME_RECONNECT_DEBOUNCE_MS;
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  const trigger = () => {
    const at = now();
    if (at - lastEmittedAt < debounceMs) {
      return;
    }
    lastEmittedAt = at;
    emit();
  };

  const addEventListener = options.addEventListener;
  const removeEventListener = options.removeEventListener;
  if (addEventListener !== undefined) {
    addEventListener("resume", trigger);
  } else if (typeof document !== "undefined") {
    document.addEventListener("resume", trigger);
  }
  const unsubscribePower = options.onPowerResume?.(trigger);

  return () => {
    if (removeEventListener !== undefined) {
      removeEventListener("resume", trigger);
    } else if (typeof document !== "undefined") {
      document.removeEventListener("resume", trigger);
    }
    unsubscribePower?.();
  };
}
