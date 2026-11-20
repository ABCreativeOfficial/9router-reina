// Bulk-add API-key planner.
//
// Background: the backend upserts apikey connections BY NAME
// (src/lib/db/repos/connectionsRepo.js ~L144: existing = all.find(c =>
// c.authType === "apikey" && c.name === data.name)). A colliding name
// overwrites an existing key instead of inserting a new one. Bulk-add used to
// derive "<base> <lineIndex>" from the paste position, blind to existing
// names, so re-adding keys often silently replaced earlier ones.
//
// A bare key gets the next number ABOVE the highest existing suffix. A
// name|key entry keeps its exact name unless it collides (case-insensitively),
// in which case "name 2", "name 3", etc. are reserved. Every planned name is
// unique, preventing accidental overwrite of existing API-key connections.

/**
 * Parse one pipe-separated bulk line into { baseName, apiKey, providerSpecificData? }.
 * @param {string} line
 * @param {{isCloudflareAi?: boolean, defaultBaseName?: string}} [opts]
 * @returns {{baseName: string, apiKey: string, explicitName: boolean, providerSpecificData?: object}|null}
 */
function parseLine(line, opts = {}) {
  const { isCloudflareAi = false, defaultBaseName = "Key" } = opts;
  if (!isCloudflareAi && /^LLM\|/i.test(line.trim())) {
    return { baseName: "LLM", apiKey: line.trim(), explicitName: false };
  }
  const parts = line.split("|");

  if (isCloudflareAi && parts.length >= 3) {
    // name|apiKey|accountId  (apiKey may itself contain pipes)
    const baseName = parts[0].trim();
    const apiKey = parts.slice(1, -1).join("|").trim();
    const accountId = parts[parts.length - 1].trim();
    return {
      baseName: baseName || defaultBaseName,
      apiKey,
      explicitName: !!baseName,
      providerSpecificData: { accountId },
    };
  }

  if (parts.length >= 2) {
    // name|apiKey  (apiKey may itself contain pipes)
    const baseName = parts[0].trim();
    const apiKey = parts.slice(1).join("|").trim();
    return { baseName: baseName || defaultBaseName, apiKey, explicitName: !!baseName };
  }

  // apiKey only — auto-named "Key N"
  const apiKey = parts[0].trim();
  return { baseName: defaultBaseName, apiKey, explicitName: false };
}

/**
 * Return the largest positive numeric suffix already assigned for this base.
 * Using string comparison avoids accidental regex interpolation of names.
 */
function largestSuffix(base, used) {
  const prefix = `${base.toLowerCase()} `;
  let highest = 0;
  for (const name of used) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(suffix)) continue;
    const number = Number(suffix);
    if (Number.isSafeInteger(number)) highest = Math.max(highest, number);
  }
  return highest;
}

/**
 * Plan a bulk add with stable order and collision-free names.
 *
 * @param {string[]} lines raw paste lines
 * @param {string[]|null|undefined} existingNames connection names already saved
 * @param {{isCloudflareAi?: boolean, defaultBaseName?: string, dedupeKeys?: boolean}} [opts]
 * @returns {{name: string, apiKey: string, skipped: boolean, providerSpecificData?: object}[]}
 */
export function planBulkAdd(lines, existingNames, opts = {}) {
  const { isCloudflareAi = false, defaultBaseName = "Key", dedupeKeys = false } = opts;

  const safeExisting = Array.isArray(existingNames) ? existingNames : [];
  const used = new Set(safeExisting.map((n) => (typeof n === "string" ? n.toLowerCase() : "")));
  const seenKeys = new Set();
  const nextSuffix = new Map();

  const out = [];
  for (const raw of lines) {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line) continue;

    const parsed = parseLine(line, { isCloudflareAi, defaultBaseName });
    if (!parsed || !parsed.apiKey) continue;
    if (dedupeKeys && seenKeys.has(parsed.apiKey)) continue;
    seenKeys.add(parsed.apiKey);

    const base = parsed.baseName;
    let name;
    if (parsed.explicitName && !used.has(base.toLowerCase())) {
      name = base;
    } else {
      const normalizedBase = base.toLowerCase();
      let idx = nextSuffix.get(normalizedBase);
      if (idx === undefined) {
        idx = largestSuffix(base, used) + 1;
        // A repeated manually named key becomes "name 2", not "name 1".
        if (parsed.explicitName) idx = Math.max(idx, 2);
      }
      while (used.has(`${normalizedBase} ${idx}`)) idx++;
      name = `${base} ${idx}`;
      nextSuffix.set(normalizedBase, idx + 1);
    }
    used.add(name.toLowerCase());

    const entry = { name, apiKey: parsed.apiKey, skipped: false };
    if (parsed.providerSpecificData) entry.providerSpecificData = parsed.providerSpecificData;
    out.push(entry);
  }
  return out;
}
