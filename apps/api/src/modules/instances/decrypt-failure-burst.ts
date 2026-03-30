const DECRYPT_FAILURE_SIGNAL_PATTERN = /bad mac|failed to decrypt|decrypt message/i;
const GENERIC_DECRYPT_FAILURE_SIGNAL_KEY = "decrypt_failure:generic";

export const DECRYPT_FAILURE_BURST_WINDOW_MS = 30_000;
export const DECRYPT_FAILURE_BURST_THRESHOLD = 4;
export const DECRYPT_FAILURE_SIGNAL_COALESCE_WINDOW_MS = 1_500;

export interface RecordDecryptFailureSignalResult {
  failureCount: number;
  matched: boolean;
  shouldRecover: boolean;
}

interface CreateDecryptFailureBurstDetectorOptions {
  burstThreshold?: number;
  burstWindowMs?: number;
  coalesceWindowMs?: number;
  now?: () => number;
}

interface DecryptFailureBurstDetector {
  recordSignal: (message: string, context?: Record<string, unknown>) => RecordDecryptFailureSignalResult;
  reset: () => void;
}

const normalizeContextValue = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const buildSignalKey = (context?: Record<string, unknown>): string => {
  const identifiers = [
    context?.externalMessageId,
    context?.messageId,
    context?.id,
    context?.remoteJid,
    context?.participant,
    context?.jid
  ]
    .map(normalizeContextValue)
    .filter((value): value is string => value !== null);

  if (identifiers.length === 0) {
    return GENERIC_DECRYPT_FAILURE_SIGNAL_KEY;
  }

  return `decrypt_failure:${identifiers.join("|")}`;
};

const buildErrorText = (message: string, context?: Record<string, unknown>): string =>
  [message, context?.error, context?.err, context?.reason]
    .map(normalizeContextValue)
    .filter((value): value is string => value !== null)
    .join(" ");

export const createDecryptFailureBurstDetector = (
  options: CreateDecryptFailureBurstDetectorOptions = {}
): DecryptFailureBurstDetector => {
  const burstThreshold = options.burstThreshold ?? DECRYPT_FAILURE_BURST_THRESHOLD;
  const burstWindowMs = options.burstWindowMs ?? DECRYPT_FAILURE_BURST_WINDOW_MS;
  const coalesceWindowMs = options.coalesceWindowMs ?? DECRYPT_FAILURE_SIGNAL_COALESCE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const recentFailureTimestamps: number[] = [];
  let lastCountedSignalAt = Number.NEGATIVE_INFINITY;
  let lastCountedSignalKey = GENERIC_DECRYPT_FAILURE_SIGNAL_KEY;

  const reset = (): void => {
    recentFailureTimestamps.length = 0;
    lastCountedSignalAt = Number.NEGATIVE_INFINITY;
    lastCountedSignalKey = GENERIC_DECRYPT_FAILURE_SIGNAL_KEY;
  };

  const pruneOldFailures = (currentTime: number): void => {
    while (
      recentFailureTimestamps.length > 0 &&
      currentTime - recentFailureTimestamps[0]! > burstWindowMs
    ) {
      recentFailureTimestamps.shift();
    }
  };

  const recordSignal = (message: string, context?: Record<string, unknown>): RecordDecryptFailureSignalResult => {
    const errorText = buildErrorText(message, context);

    if (!DECRYPT_FAILURE_SIGNAL_PATTERN.test(errorText)) {
      return {
        failureCount: recentFailureTimestamps.length,
        matched: false,
        shouldRecover: false
      };
    }

    const currentTime = now();
    pruneOldFailures(currentTime);

    const signalKey = buildSignalKey(context);
    const withinCoalesceWindow = currentTime - lastCountedSignalAt <= coalesceWindowMs;
    const lastSignalWasGeneric = lastCountedSignalKey === GENERIC_DECRYPT_FAILURE_SIGNAL_KEY;
    const currentSignalIsGeneric = signalKey === GENERIC_DECRYPT_FAILURE_SIGNAL_KEY;

    if (
      withinCoalesceWindow &&
      (signalKey === lastCountedSignalKey || lastSignalWasGeneric || currentSignalIsGeneric)
    ) {
      if (!currentSignalIsGeneric) {
        lastCountedSignalKey = signalKey;
      }

      return {
        failureCount: recentFailureTimestamps.length,
        matched: true,
        shouldRecover: false
      };
    }

    recentFailureTimestamps.push(currentTime);
    lastCountedSignalAt = currentTime;
    lastCountedSignalKey = signalKey;

    const failureCount = recentFailureTimestamps.length;
    if (failureCount < burstThreshold) {
      return {
        failureCount,
        matched: true,
        shouldRecover: false
      };
    }

    reset();

    return {
      failureCount,
      matched: true,
      shouldRecover: true
    };
  };

  return {
    recordSignal,
    reset
  };
};
