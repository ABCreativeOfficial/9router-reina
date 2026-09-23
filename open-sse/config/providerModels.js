import { PROVIDERS } from "./providers.js";
import REGISTRY from "../providers/registry/index.js";
// PROVIDER_MODELS now built from providers/registry (transport + models co-located)
import { PROVIDER_MODELS } from "../providers/index.js";
import { modelQuotaFamily, modelStrip, modelTargetFormat, modelSupportedFormats, modelIsInternal, normalizeModelId } from "../providers/models/schema.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { FORMATS } from "../translator/formats.js";
export { PROVIDER_MODELS };


// Helper functions
export function getProviderModels(aliasOrId) {
  return PROVIDER_MODELS[aliasOrId] || [];
}

export function getDefaultModel(aliasOrId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return models?.[0]?.id || null;
}

// Providers whose registry uses dots in version numbers (e.g. "claude-sonnet-4.5").
// For these, we tolerate clients sending dashes ("claude-sonnet-4-5") by normalizing
// digit-hyphen-digit to digit-dot-digit before lookup. Other providers are left untouched.
const DOT_VERSION_PROVIDERS = new Set(["kr", "kiro"]);

// Find a registry entry by id. For Kiro models, tolerates dash/dot version separators
// ("claude-sonnet-4-5" ~= "claude-sonnet-4.5"). Other providers use exact match only.
// The raw id wins over the "(level)"-stripped one: Codex virtual aliases such as
// `gpt-6-sol-ultra-(fast)` are registered verbatim and would otherwise be reduced to
// `gpt-6-sol-ultra-` and never match.
function findModel(models, modelId, aliasOrId) {
  if (!models) return undefined;
  const strippedId = typeof modelId === "string"
    ? modelId.replace(/\([^()]+\)\s*$/, "").trim()
    : modelId;
  const found = models.find(m => m.id === modelId) || models.find(m => m.id === strippedId);
  if (found) return found;
  if (!DOT_VERSION_PROVIDERS.has(aliasOrId)) return undefined;
  const normalized = normalizeModelId(strippedId);
  if (normalized === strippedId) return undefined;
  return models.find(m => m.id === normalized);
}

export function isValidModel(aliasOrId, modelId, passthroughProviders = new Set()) {
  if (passthroughProviders.has(aliasOrId)) return true;
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return false;
  return !!findModel(models, modelId, aliasOrId);
}

export function findModelName(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return modelId;
  const found = findModel(models, modelId, aliasOrId);
  return found?.name || modelId;
}

export function getModelTargetFormat(aliasOrId, modelId) {
  if ((!aliasOrId || aliasOrId === "oc" || aliasOrId === "opencode" || aliasOrId === "ocg" || aliasOrId === "opencode-go" || aliasOrId === "ocz" || aliasOrId === "opencode-zen") && isMuseSparkModel(modelId)) {
    return FORMATS.OPENAI_RESPONSES;
  }
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  return modelTargetFormat(findModel(models, modelId, aliasOrId));
}

// Declared upstream formats for a model (registry `supportedFormats`). Drives the
// per-model guard on the sourceFormat-matched transport; null when undeclared.
export function getModelSupportedFormats(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  return modelSupportedFormats(findModel(models, modelId, aliasOrId));
}

export function getModelType(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = findModel(models, modelId, aliasOrId);
  return found?.kind || found?.type || null;
}

// Exact registry hit by literal id, no suffix stripping.
function findModelExact(models, modelId) {
  if (!models || typeof modelId !== "string") return undefined;
  return models.find(m => m.id === modelId);
}

export function getModelUpstreamId(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  // A literal registry hit wins and is returned verbatim: Codex virtual aliases such
  // as `gpt-6-sol-ultra-(fast)` are registered as their own ids, and their trailing
  // parentheses are part of the alias name — re-appending them would leak a virtual
  // marker into the upstream slug.
  const exact = findModelExact(models, modelId);
  if (exact) return exact.upstreamModelId || exact.id;

  // Otherwise treat a trailing "(level)" as the shared thinking suffix: look the
  // base id up and re-append the suffix so downstream applyThinking still sees it
  // (body.model is stripped separately).
  const sufMatch = typeof modelId === "string" ? modelId.match(/\([^()]+\)\s*$/) : null;
  const suffix = sufMatch ? sufMatch[0] : "";
  const baseId = suffix ? modelId.slice(0, sufMatch.index).trim() : modelId;
  const found = suffix ? findModel(models, baseId, aliasOrId) : undefined;
  const resolvedId = found?.upstreamModelId || found?.id;
  if (resolvedId) {
    const presetMatch = resolvedId.match(/\([^()]+\)\s*$/);
    const presetSuffix = presetMatch?.[0] || "";
    const resolvedBase = presetSuffix ? resolvedId.slice(0, presetMatch.index).trim() : resolvedId;
    return resolvedBase + (suffix || presetSuffix);
  }
  return baseId + suffix;
}

export function getModelQuotaFamily(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return modelQuotaFamily(findModel(models, modelId, aliasOrId));
}

// OAuth short aliases — derived from registry `alias` (single source). everything else: alias = id.
// vertex/vertex-partner keep alias=id (kept via the `|| id` fallback in consumers).
export const OAUTH_ALIASES = Object.fromEntries(
  REGISTRY.filter(r => r.alias && r.alias !== r.id).map(r => [r.id, r.alias])
);

// Derived from PROVIDERS — no need to maintain manually
export const PROVIDER_ID_TO_ALIAS = Object.fromEntries(
  Object.keys(PROVIDERS).map(id => [id, OAUTH_ALIASES[id] || id])
);

export function getModelsByProviderId(providerId) {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return PROVIDER_MODELS[alias] || [];
}

/**
 * Public model list for a provider: the registry minus internal-only entries.
 * Use this for anything a client or the dashboard can pick from; use
 * getModelsByProviderId() when every routable id is needed.
 */
export function getPublicModelsByProviderId(providerId) {
  return getModelsByProviderId(providerId).filter((model) => !modelIsInternal(model));
}

// Get strip list for a model entry (explicit opt-in only)
// Returns array of content types to strip, e.g. ["image", "audio"]
export function getModelStrip(alias, modelId) {
  return modelStrip(findModel(PROVIDER_MODELS[alias], modelId, alias));
}
