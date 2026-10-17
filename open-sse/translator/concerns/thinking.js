// Concern: reasoning_effort ↔ provider-native thinking config.
// Central source of truth for level↔budget maps (web-standard values), the level
// vocabulary, and the capability-driven fit (resolveReasoningLevel) that every
// per-format mapping calls instead of hardcoding its own collapse.
// Provider-specific application lives in thinkingUnified.js.
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

// "ultra" sits above EFFORT_LEVELS (it is a Codex-only tier). It ranks one step
// past "max" so an unsupported ultra resolves to the highest level a model
// actually declares instead of being dropped to a hardcoded mid level.
const LEVEL_RANK = new Map([...EFFORT_LEVELS, "ultra"].map((l, i) => [l, i]));

/**
 * Is `value` a level the wire vocabulary knows (minimal..max, or ultra)?
 * False for pass-through words (`auto`, `off`) and for arbitrary client strings,
 * so a caller can refuse to write a token upstream would reject.
 */
export function isReasoningLevel(value) {
  return LEVEL_RANK.has(typeof value === "string" ? value.trim().toLowerCase() : value);
}

/**
 * Fit a requested effort to what a model actually accepts.
 *
 * `supportedLevels` comes from getThinkingLevels() (capability-declared set, a
 * pattern override, or the format default). Rules:
 *   - supported → returned unchanged, never upgraded or downgraded
 *   - unsupported → nearest supported level; ties prefer the HIGHER one, so a
 *     request is never silently downgraded when both neighbours are equidistant
 *   - "none" never acts as a fallback target (it is a disable switch, not a
 *     level), and no level set at all means "capability unknown" → unchanged
 *
 * This replaces the per-format hardcoded collapses (`xhigh|max → max`,
 * `low|medium → high`, `max|ultra → xhigh`) that threw away levels the upstream
 * accepts natively — live-probed on OpenCode Free, where
 * `deepseek-v4.1-flash-free` takes every level it declares and `big-pickle`
 * rejects the "minimal"/"xhigh" its format default used to offer.
 */
export function resolveReasoningLevel(level, supportedLevels) {
  const raw = typeof level === "string" ? level.trim().toLowerCase() : "";
  if (!raw) return level;
  if (!Array.isArray(supportedLevels) || supportedLevels.length === 0) return level;
  if (supportedLevels.includes(raw)) return raw;

  const target = LEVEL_RANK.get(raw);
  // Not a reasoning level ("auto", an unknown token) — leave it to the caller.
  if (target === undefined) return level;

  const candidates = supportedLevels
    .filter((l) => l !== "none" && LEVEL_RANK.has(l))
    .map((l) => ({ level: l, rank: LEVEL_RANK.get(l) }));
  // Nothing rankable declared (e.g. a format that only names a toggle like
  // "thinking"): there is no level to land on, so the caller decides.
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.rank - target);
    const bestDistance = Math.abs(best.rank - target);
    if (distance < bestDistance || (distance === bestDistance && candidate.rank > best.rank)) {
      best = candidate;
    }
  }
  return best.level;
}

// Gemini thinkingBudget (numeric) → OpenAI reasoning_effort (antigravity reverse map).
export function budgetToEffort(budget) {
  if (!budget || budget <= 0) return null;
  if (budget <= 2048) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}
