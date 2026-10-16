// Concern: reasoning_effort ↔ provider-native thinking config.
// Central source of truth for level↔budget maps (web-standard values).
// Provider-specific application lives in thinkingUnified.js; this file is maps-only.
//
// It also owns the level VOCABULARY (`isReasoningLevelSuffix`), because a
// trailing `(value)` on a model id is only a thinking suffix when `value` names
// a level from these maps. Anything else inside parens is part of the id itself
// — Codex's `-(fast)` service-tier marker, for example — and stripping it would
// leave a dangling separator (`gpt-6-sol-(fast)` → `gpt-6-sol-`).

// Discrete effort levels, ordered low→high.
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Web-standard level → budget_tokens (Anthropic/Gemini docs).
export const LEVEL_TO_BUDGET = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
};

// Level names that may legitimately appear as a `(value)` suffix. Beyond the
// budget map this covers `ultra` (an OpenAI effort with no budget mapping) and
// the two request directives `auto` / `off`.
const LEVEL_SUFFIX_NAMES = new Set([...Object.keys(LEVEL_TO_BUDGET), "ultra", "auto", "off"]);

/**
 * Is `value` a reasoning-level suffix, i.e. may a trailing `(value)` be stripped
 * from a model id? True for a level name or a numeric token budget; false for
 * anything else, so a non-level marker stays part of the id.
 */
export function isReasoningLevelSuffix(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return false;
  return LEVEL_SUFFIX_NAMES.has(raw) || /^\d+$/.test(raw);
}

/**
 * Strip a trailing `(value)` from a model id, but ONLY when `value` is a real
 * reasoning level. A non-level marker stays part of the id.
 *
 * This is the single implementation every normalizer should use. Stripping
 * unconditionally is what produced dangling separators: `gpt-6-sol-(fast)` lost
 * its `(fast)` tier marker and became `gpt-6-sol-`, which is neither the alias
 * nor a valid model id.
 */
export function stripReasoningLevelSuffix(modelId) {
  const raw = String(modelId ?? "").trim();
  const m = raw.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!m || !isReasoningLevelSuffix(m[2])) return raw;
  return m[1].trim();
}

// Returns budget_tokens for an effort level, or undefined if unknown.
// 0 means "no thinking"; undefined means "effort not recognized".
export function effortToBudget(effort) {
  if (!effort) return undefined;
  return LEVEL_TO_BUDGET[String(effort).toLowerCase()];
}

// OpenAI reasoning_effort → Gemini thinkingLevel (gemini-3 enum: minimal|low|medium|high).
// Gemini 3 cannot fully disable thinking; "none"/"off" map to "minimal".
export function effortToThinkingLevel(effort) {
  const e = String(effort).toLowerCase().trim();
  if (e === "none" || e === "off") return "minimal";
  if (e === "xhigh" || e === "max") return "high";
  return e;
}

// Numeric budget → nearest discrete level (reverse map via thresholds).
// Returns null when budget <= 0 (no reasoning).
// Thresholds are midpoints between LEVEL_TO_BUDGET values: max (128000) is
// reachable, with the xhigh/max boundary at the 32768/128000 midpoint (80384).
export function budgetToLevel(budget) {
  const b = Number(budget);
  if (!b || b <= 0) return null;
  if (b <= 768) return "minimal";
  if (b <= 4096) return "low";
  if (b <= 16384) return "medium";
  if (b <= 28672) return "high";
  if (b <= 80384) return "xhigh";
  return "max";
}

// Gemini thinkingBudget (numeric) → OpenAI reasoning_effort (antigravity reverse map).
export function budgetToEffort(budget) {
  if (!budget || budget <= 0) return null;
  if (budget <= 2048) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}
