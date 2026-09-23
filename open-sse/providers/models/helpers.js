export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}
