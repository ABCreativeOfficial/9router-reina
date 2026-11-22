/** Opt-in compatibility contract. No gateway history mutation in default/off mode. */
export function continuitySettings() {
  const mode = String(process.env.KIRO_CONTINUITY_MODE || "off").toLowerCase();
  const active = ["observe", "memory", "replay"].includes(mode) ? mode : "off";
  const persist = /^(1|true|yes)$/i.test(process.env.KIRO_CONTINUITY_PERSIST || "");
  const tokens = (name, fallback, min, max) => {
    const value = Number(process.env[name]);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    mode: active,
    persist,
    contextWindow: 200_000,
    warnTokens: tokens("KIRO_CONTINUITY_WARN_TOKENS", 150_000, 50_000, 198_000),
    stopTokens: tokens("KIRO_CONTINUITY_STOP_TOKENS", 190_000, 100_000, 200_000),
    strictGuard: /^(1|true|yes)$/i.test(process.env.KIRO_CONTINUITY_STRICT_GUARD || ""),
    memoryChars: tokens("KIRO_CONTINUITY_MEMORY_CHARS", 2400, 256, 8192),
    thinkingChars: tokens("KIRO_CONTINUITY_THINKING_CHARS", 1200, 128, 8192),
  };
}
