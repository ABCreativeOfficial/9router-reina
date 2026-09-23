/**
 * Codex model capability contract — single source of truth for the `codex`
 * provider (alias `cx`).
 *
 * Everything that needs to know "what can this Codex model do" reads this table:
 * the registry model list, the reasoning-level picker, virtual-alias generation,
 * alias validation, the per-model default effort, and Fast (service tier) support.
 *
 * Source of truth for the values is the official OpenAI Codex catalog:
 *   https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json
 * Only entries with `visibility: "list"` AND `supported_in_api: true` are public
 * chat models. `codex-auto-review` is kept because the official catalog ships it
 * (with `visibility: "hide"`), and Codex CLI sends that bare id on its own; it is
 * internal-only and never appears in a public model list.
 *
 * The wire contract mirrors official Codex (codex-rs):
 *   body.model                = canonical slug (never a virtual suffix)
 *   body.reasoning.effort     = explicit effort, else the model's default
 *   body.service_tier         = "priority" when Fast is selected (ServiceTier::Fast.request_value())
 *
 * Keep this table in sync when the official catalog changes: the drift test in
 * tests/unit/codex-model-sync.test.js pins the public ids and their reasoning sets.
 */

/** Official catalog snapshot used for this table. */
export const CODEX_CATALOG_SOURCE = "openai/codex codex-rs/models-manager/models.json";

/** Highest official Codex CLI version this fork identifies as. */
export const CODEX_CLI_VERSION = "0.156.0";

/** Virtual-alias markers. `fast` is a service tier, never a reasoning level. */
export const CODEX_FAST_MARKER = "fast";
export const CODEX_FAST_SUFFIX = `-(${CODEX_FAST_MARKER})`;

/**
 * Public chat models (official `visibility: "list"` + `supported_in_api: true`).
 * `defaultReasoning` mirrors `default_reasoning_level`; `reasoning` mirrors
 * `supported_reasoning_levels`; `fast` mirrors a `priority` service tier.
 */
export const CODEX_MODEL_CAPABILITIES = {
  "gpt-6-astra": {
    name: "GPT 6 Astra",
    displayName: "GPT-6-Astra",
    defaultReasoning: "low",
    reasoning: ["low", "medium", "high", "xhigh", "max", "ultra"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: true,
  },
  "gpt-6-sol": {
    name: "GPT 6 Sol",
    displayName: "GPT-6-Sol",
    defaultReasoning: "medium",
    reasoning: ["low", "medium", "high", "xhigh", "max", "ultra"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: true,
  },
  "gpt-6-luna": {
    name: "GPT 6 Luna",
    displayName: "GPT-6-Luna",
    defaultReasoning: "medium",
    // Official catalog stops at `max` — `ultra` is not offered for Luna.
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: true,
  },
  "gpt-5.6-sol": {
    name: "GPT 5.6 Sol",
    displayName: "GPT-5.6-Sol",
    defaultReasoning: "low",
    reasoning: ["low", "medium", "high", "xhigh", "max", "ultra"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: true,
  },
  "gpt-5.6-terra": {
    name: "GPT 5.6 Terra",
    displayName: "GPT-5.6-Terra",
    defaultReasoning: "medium",
    reasoning: ["low", "medium", "high", "xhigh", "max", "ultra"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: true,
  },
  "gpt-5.6-luna": {
    name: "GPT 5.6 Luna",
    displayName: "GPT-5.6-Luna",
    defaultReasoning: "medium",
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: true,
  },
  "gpt-5.5": {
    name: "GPT 5.5",
    displayName: "GPT-5.5",
    defaultReasoning: "medium",
    // Official catalog stops at `xhigh` — no `max`, no `ultra`.
    reasoning: ["low", "medium", "high", "xhigh"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: true,
  },
};

/**
 * Internal-only model ids that are intentionally NOT part of the public list.
 * `codex-auto-review` ships in the official catalog with `visibility: "hide"`;
 * Codex CLI sends it bare, so it must stay routable to the codex provider.
 */
export const CODEX_INTERNAL_MODEL_CAPABILITIES = {
  "codex-auto-review": {
    name: "Codex Auto Review",
    defaultReasoning: "medium",
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    fast: true,
    contextWindow: 272000,
    maxOutput: 128000,
    vision: false,
  },
};

/** Public chat model ids, in official catalog order. */
export const CODEX_PUBLIC_MODEL_IDS = Object.keys(CODEX_MODEL_CAPABILITIES);

/** Every id the capability table knows, public or internal. */
export const CODEX_KNOWN_MODEL_IDS = [
  ...CODEX_PUBLIC_MODEL_IDS,
  ...Object.keys(CODEX_INTERNAL_MODEL_CAPABILITIES),
];

/** Capability entry for any known Codex model id, or null. */
export function getCodexModelCapabilities(modelId) {
  if (typeof modelId !== "string" || !modelId) return null;
  return CODEX_MODEL_CAPABILITIES[modelId]
    || CODEX_INTERNAL_MODEL_CAPABILITIES[modelId]
    || null;
}

/**
 * Longest canonical base match for an arbitrary id.
 *
 * Model names contain many `-`, so a naive `split("-")` cannot find the base.
 * Matching against the known-id list longest-first makes `gpt-6-sol` win over a
 * hypothetical `gpt-6`, and keeps `gpt-5.6-luna` distinct from `gpt-5.6`.
 *
 * @returns {{ base: string, rest: string } | null} `rest` is what followed the base
 *          ("" for a bare canonical id), or null when no known id is a prefix.
 */
export function matchCodexBaseModel(modelId) {
  if (typeof modelId !== "string" || !modelId) return null;
  const candidates = [...CODEX_KNOWN_MODEL_IDS].sort((a, b) => b.length - a.length);
  for (const base of candidates) {
    if (modelId === base) return { base, rest: "" };
    if (modelId.startsWith(`${base}-`)) return { base, rest: modelId.slice(base.length + 1) };
  }
  return null;
}

/**
 * Parse a Codex model reference into its canonical wire form.
 *
 * Accepted shapes (provider must already be codex — this parser is Codex-only):
 *   <base>                     canonical model, official default reasoning
 *   <base>-<effort>            explicit reasoning override
 *   <base>-(fast)              Fast service tier at the official default effort
 *   <base>-<effort>-(fast)     both
 *
 * The legacy `(level)` suffix handled by the shared thinking pipeline keeps
 * working (it is parsed there); this parser owns only the dash-form aliases.
 *
 * @returns {{ ok: true, model: string, reasoningEffort: string|null, fast: boolean }
 *          | { ok: false, reason: string, model: string }}
 */
export function parseCodexModelReference(modelId) {
  if (typeof modelId !== "string" || !modelId.trim()) {
    return { ok: false, reason: "Codex model id is required.", model: modelId };
  }

  let working = modelId.trim();
  let fast = false;
  if (working.endsWith(CODEX_FAST_SUFFIX)) {
    fast = true;
    working = working.slice(0, -CODEX_FAST_SUFFIX.length);
  }

  const match = matchCodexBaseModel(working);
  if (!match) {
    // Not a known Codex model — leave it alone so passthrough/aliases still work.
    return { ok: true, model: working, reasoningEffort: null, fast, unknown: true };
  }

  const caps = getCodexModelCapabilities(match.base);
  if (!match.rest) {
    return { ok: true, model: match.base, reasoningEffort: null, fast };
  }

  const effort = match.rest;
  if (!caps.reasoning.includes(effort)) {
    return {
      ok: false,
      model: match.base,
      reason: `Unsupported Codex reasoning alias "${effort}" for ${match.base}. Supported: ${caps.reasoning.join(", ")}.`,
    };
  }
  return { ok: true, model: match.base, reasoningEffort: effort, fast };
}

/** Official default reasoning level for a canonical Codex model id. */
export function getCodexDefaultReasoning(modelId) {
  return getCodexModelCapabilities(modelId)?.defaultReasoning || null;
}

/** Does this canonical Codex model support the Fast service tier? */
export function supportsCodexFast(modelId) {
  return getCodexModelCapabilities(modelId)?.fast === true;
}

/**
 * Public selectable model ids: canonical slugs plus their generated virtual
 * aliases. Invalid combinations are never generated — a model that does not
 * support `ultra` gets no `-ultra` entry.
 */
export function listCodexPublicModelIds() {
  const ids = [];
  for (const [base, caps] of Object.entries(CODEX_MODEL_CAPABILITIES)) {
    ids.push(base);
    if (caps.fast) ids.push(`${base}${CODEX_FAST_SUFFIX}`);
    for (const effort of caps.reasoning) {
      ids.push(`${base}-${effort}`);
      if (caps.fast) ids.push(`${base}-${effort}${CODEX_FAST_SUFFIX}`);
    }
  }
  return ids;
}
