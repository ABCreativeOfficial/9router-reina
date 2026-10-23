// CodeBuddy-only context policy. No global token-saver or provider defaults change.
export const CODEBUDDY_CONTEXT = Object.freeze({
  upstreamCode: 11115,
  marker: "codebuddy-intl context_length_exceeded",
  requestMarker: "codebuddy-intl context_overflow request-scoped",
  enabled: false,
  contextLimit: null,
  triggerThreshold: 0.95,
  safetyMargin: 0.05,
  outputReserveTokens: 4096,
  fallbackCompression: false,
  preferNativeCompaction: true,
  keepRecentTurns: 2,
  maxRecoveryRetries: 1,
});

const USER_CONFIG_KEYS = [
  "enabled", "contextLimit", "triggerThreshold", "safetyMargin", "outputReserveTokens",
  "fallbackCompression", "preferNativeCompaction", "keepRecentTurns",
];

const INTERNAL_CONFIG_KEYS = ["maxRecoveryRetries"];

export function normalizeCodeBuddyContext(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context must be an object");
  const fields = {
    upstreamCode: (v) => v === CODEBUDDY_CONTEXT.upstreamCode,
    marker: (v) => v === CODEBUDDY_CONTEXT.marker,
    requestMarker: (v) => v === CODEBUDDY_CONTEXT.requestMarker,
    enabled: (v) => typeof v === "boolean",
    contextLimit: (v) => v === null || (Number.isSafeInteger(v) && v >= 32768 && v <= 1048576),
    triggerThreshold: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 1,
    safetyMargin: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 0.3,
    outputReserveTokens: (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1048576,
    fallbackCompression: (v) => typeof v === "boolean",
    preferNativeCompaction: (v) => typeof v === "boolean",
    keepRecentTurns: (v) => Number.isSafeInteger(v) && v >= 1 && v <= 20,
    maxRecoveryRetries: (v) => v === 1,
  };
  const out = {};
  for (const [key, test] of Object.entries(fields)) {
    const candidate = value[key] === undefined ? CODEBUDDY_CONTEXT[key] : value[key];
    if (!test(candidate)) throw new Error(`Invalid context.${key}`);
    out[key] = candidate;
  }
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) throw new Error(`Unknown context option: ${key}`);
  return Object.fromEntries(USER_CONFIG_KEYS.map((key) => [key, out[key]]));
}

export function normalizeCodeBuddyContextPolicy(value = {}) {
  return { ...normalizeCodeBuddyContext(value), maxRecoveryRetries: CODEBUDDY_CONTEXT.maxRecoveryRetries };
}
