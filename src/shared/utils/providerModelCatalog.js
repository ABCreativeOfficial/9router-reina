import { getModelKind } from "@/shared/constants/models";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";

/**
 * Single source of truth for "which models does this provider offer" in the dashboard.
 *
 * Both the provider page's Available Models grid and the per-account Model Access modal
 * read from here, so the two lists cannot drift apart. Callers supply the already-fetched
 * data; this module only composes it.
 *
 * @param {object} input
 * @param {object[]} input.staticModels        registry models for the provider
 * @param {object[]} [input.liveModels]        per-connection live catalog (used for Cursor only)
 * @param {boolean}  [input.preferLiveModels]  true when the live catalog replaces the registry
 * @param {object[]} [input.kiloFreeModels]    Kilo free-tier models (kilocode only)
 * @param {object[]} [input.customModels]      rows from /api/models/custom
 * @param {object}   [input.modelAliases]      map from /api/models/alias
 * @param {string}   input.providerStorageAlias alias custom models/aliases are stored under
 * @param {string[]} [input.disabledModelIds]  globally disabled ids for this provider
 * @returns {{
 *   builtInModels: object[],   // registry (or live) models, before disabled split
 *   displayModels: object[],   // built-in + kilo, minus globally disabled
 *   disabledModels: object[],  // built-in + kilo, only globally disabled
 *   customRows: object[],      // custom models + legacy aliases (getProviderCustomModelRows shape)
 *   entries: {id: string, name: string, source: string, disabled: boolean}[] // flat, deduped
 * }}
 */
export function buildProviderModelCatalog({
  staticModels = [],
  liveModels = [],
  preferLiveModels = false,
  kiloFreeModels = [],
  customModels = [],
  modelAliases = {},
  providerStorageAlias,
  disabledModelIds = [],
}) {
  const builtInModels = preferLiveModels && liveModels.length > 0 ? liveModels : staticModels;

  // Non-LLM kinds (embedding, tts, ...) have dedicated pages under media-providers.
  const withKilo = [
    ...builtInModels,
    ...kiloFreeModels.filter((fm) => !builtInModels.some((m) => m.id === fm.id)),
  ].filter((m) => {
    const kind = getModelKind(m);
    return !kind || kind === "llm";
  });

  const disabledSet = new Set(disabledModelIds);
  const displayModels = withKilo.filter((m) => !disabledSet.has(m.id));
  const disabledModels = withKilo.filter((m) => disabledSet.has(m.id));

  const customRows = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    builtInModels,
    type: "llm",
  });

  const entries = [];
  const seen = new Set();
  const push = (id, name, source) => {
    const modelId = String(id ?? "").trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    entries.push({ id: modelId, name: name || modelId, source, disabled: disabledSet.has(modelId) });
  };
  // Custom first, matching the page's ordering.
  for (const row of customRows) push(row.id, row.name || row.alias, row.source);
  for (const m of withKilo) push(m.id, m.name, "builtIn");

  return { builtInModels, displayModels, disabledModels, customRows, entries };
}
