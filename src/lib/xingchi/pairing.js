import crypto from "node:crypto";

export const PAIR_PROTOCOL = "xingchi-pair-v1";
export const PAIR_TTL_MS = 5 * 60 * 1000;
// Shared in-process even when Next.js bundles routes separately or hot-reloads.
const sessions = globalThis.__xingchiHybridPairs ??= new Map();

function hash(secret) { return crypto.createHash("sha256").update(secret).digest(); }
function sweep() {
  for (const [id, item] of sessions) if (Date.now() > item.expiresAt + PAIR_TTL_MS) sessions.delete(id);
}

export function startPairing(accountId, routerOrigin) {
  sweep();
  if (sessions.size >= 64) throw new Error("Too many pending pairings. Try again shortly.");
  const pairingId = crypto.randomBytes(16).toString("base64url");
  const secret = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + PAIR_TTL_MS;
  sessions.set(pairingId, { accountId, routerOrigin, secretHash: hash(secret), status: "pending", expiresAt });
  return { protocol: PAIR_PROTOCOL, pairingId, pairingSecret: secret, routerOrigin, expiresAt,
    providerOrigin: "https://xingchiapi.com" };
}

export function statusPairing(id) {
  const record = sessions.get(id);
  return !record || Date.now() >= record.expiresAt ? "expired" : record.status;
}

export function claimPairing(id, secret, requestOrigin) {
  sweep();
  const record = sessions.get(id);
  if (!record || Date.now() >= record.expiresAt || record.status !== "pending"
    || typeof secret !== "string" || secret.length > 256) return null;
  const supplied = hash(secret);
  // Reverse proxies sometimes forward HTTPS requests with an HTTP scheme.
  // Keep the exact hostname+port target, but permit a scheme-only difference.
  let sameHost = false;
  try { sameHost = new URL(record.routerOrigin).host === new URL(requestOrigin).host; }
  catch { /* reject malformed origin */ }
  if (!crypto.timingSafeEqual(supplied, record.secretHash) || !sameHost) return null;
  record.status = "processing";
  return { ...record };
}

export function endPairing(id, success) {
  const record = sessions.get(id);
  if (record?.status === "processing") record.status = success ? "success" : "error";
}
