// A partial live response must never replace Xingchi's durable seed catalog.
// IDs from /v1/models can add or enrich entries, but cannot remove seed models.
export function mergeXingchiModelCatalog(staticModels = [], liveModels = []) {
  const merged = new Map();
  for (const entry of staticModels) {
    if (entry?.id) merged.set(entry.id, { ...entry });
  }
  for (const entry of liveModels) {
    if (!entry?.id) continue;
    const seed = merged.get(entry.id);
    // Prefer the curated name/limits for known models; live metadata may fill
    // missing values. For newly discovered IDs, keep the upstream display name.
    merged.set(entry.id, seed ? { ...entry, ...seed } : { ...entry });
  }
  return [...merged.values()];
}
