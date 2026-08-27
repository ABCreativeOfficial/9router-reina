import crypto from "node:crypto";

/**
 * Generic New API browser-bridge pairing sessions (custom fork feature).
 *
 * A pairing is a short-lived, single-use capability that lets the universal
 * 9Router New API Bridge extension hand a deployment's management credentials to
 * this local 9Router without the user copying them by hand. The secret is the
 * only authorization: 256 bits of entropy, carried to the provider in the URL
 * *fragment* (never sent to the provider's server), and stored here only as a
 * SHA-256 hash.
 *
 * The provider target is resolved server-side at `start` and frozen into the
 * record. Completion may only *assert* an origin, which is compared against the
 * frozen one — a browser can never retarget a pairing at another host.
 *
 * The *router* origin is likewise part of the handshake rather than an assumption:
 * `start` resolves this deployment's own public origin, freezes it into the record,
 * and emits it in the login fragment so the bridge knows where to complete. 9Router
 * may be served over HTTPS behind a proxy or tunnel, so nothing here assumes
 * localhost.
 *
 * Deliberately in-process and DB-free: pairing state is transient and must never
 * outlive the process or reach the provider database. A server restart therefore
 * invalidates pending pairings — the user simply clicks Connect again.
 */

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const BRIDGE_HEADER = "x-9router-bridge";
export const BRIDGE_VERSION = "newapi-chrome-extension-v1";
export const PAIR_PROTOCOL = "newapi-v1";

/** Terminal states end polling; `pending`/`processing` keep it alive. */
export const PAIRING_STATES = Object.freeze({
  pending: "pending",
  processing: "processing",
  success: "success",
  error: "error",
  expired: "expired",
});

const MAX_SESSIONS = 32;
const MAX_ID_LENGTH = 128;
const MAX_SECRET_LENGTH = 256;
const MAX_LABEL_LENGTH = 100;

/** pairingId -> record. Never serialized, never logged. */
const sessions = new Map();

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function isExpired(record, now) {
  return now >= record.expiresAt;
}

function sweep(now = Date.now()) {
  for (const [id, record] of sessions) {
    // Records linger one extra TTL past their deadline so a lapsed pairing still
    // reads as `expired` (and a settled one still reports its outcome) instead of
    // vanishing into an indistinguishable "unknown id".
    if (now >= record.expiresAt + PAIRING_TTL_MS) sessions.delete(id);
  }
}

function boundedString(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : "";
}

/** Numeric New API account id, or "" when absent/invalid. */
export function normalizePairUserId(value) {
  const raw = boundedString(String(value ?? ""), 64);
  return /^\d+$/.test(raw) ? raw : "";
}

/**
 * Create a pending pairing for one already-resolved provider definition.
 *
 * @param {object} params
 * @param {string} params.providerId    the dynamic provider id (trusted, server-resolved)
 * @param {string} params.origin        the definition's trusted https origin
 * @param {string} params.label         display label for the login URL
 * @param {string} params.routerOrigin  this 9Router's own public origin (handshake)
 * @param {string|null} [params.expectedUserId]  pin reconnect to one account
 * @param {string|null} [params.connectionId]    the row reconnect must update
 */
export function createPairingSession({
  providerId,
  origin,
  label,
  routerOrigin = "",
  expectedUserId = null,
  connectionId = null,
}) {
  sweep();
  if (sessions.size >= MAX_SESSIONS) {
    // Oldest-first eviction; pairings are seconds-lived so this only trips on abuse.
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) sessions.delete(oldest[0]);
  }

  const pairingId = crypto.randomBytes(16).toString("base64url");
  const pairSecret = crypto.randomBytes(32).toString("base64url"); // 256 bits
  const now = Date.now();
  const normalizedExpected = normalizePairUserId(expectedUserId) || null;
  const normalizedLabel = boundedString(label, MAX_LABEL_LENGTH) || "New API";

  sessions.set(pairingId, {
    pairSecretHash: hashSecret(pairSecret),
    providerId,
    origin,
    label: normalizedLabel,
    routerOrigin: routerOrigin || "",
    expectedUserId: normalizedExpected,
    connectionId: connectionId || null,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    status: PAIRING_STATES.pending,
    resultConnectionId: null,
    errorCode: null,
  });

  return {
    pairingId,
    pairSecret,
    expiresAt: now + PAIRING_TTL_MS,
    providerId,
    origin,
    label: normalizedLabel,
    routerOrigin: routerOrigin || "",
    expectedUserId: normalizedExpected,
  };
}

/**
 * Login URL carrying the pairing in the fragment only.
 *
 * `9router_pair_protocol=newapi-v1` selects the universal extension's generic
 * completion route, and `9router_router_origin` tells it which 9Router to post to
 * — so a remote HTTPS deployment works without the extension guessing localhost.
 * Optional compatibility overrides are emitted only when a definition genuinely
 * differs from the New API defaults.
 */
export function buildPairingLoginUrl({
  pairingId,
  pairSecret,
  origin,
  providerId,
  label,
  routerOrigin = "",
  expectedUserId = null,
  overrides = null,
}) {
  const fragment = new URLSearchParams({
    "9router_pair_protocol": PAIR_PROTOCOL,
    "9router_pair_id": pairingId,
    "9router_pair_secret": pairSecret,
    "9router_provider_id": providerId,
    "9router_provider_label": label,
  });
  if (routerOrigin) fragment.set("9router_router_origin", routerOrigin);
  const expected = normalizePairUserId(expectedUserId);
  if (expected) fragment.set("expected_user_id", expected);
  for (const [key, value] of Object.entries(overrides || {})) {
    // The extension constrains these to relative /api/... paths on its own origin.
    if (typeof value === "string" && value.startsWith("/api/")) fragment.set(key, value);
  }
  return `${origin}/#${fragment.toString()}`;
}

/** Non-secret state for the polling UI. */
export function readPairingStatus(pairingId) {
  const id = boundedString(pairingId, MAX_ID_LENGTH);
  if (!id) return { status: PAIRING_STATES.expired };
  sweep();
  const record = sessions.get(id);
  if (!record) return { status: PAIRING_STATES.expired };
  if (record.status === PAIRING_STATES.pending && isExpired(record, Date.now())) {
    record.status = PAIRING_STATES.expired;
  }
  return {
    status: record.status,
    ...(record.resultConnectionId ? { connectionId: record.resultConnectionId } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };
}

/**
 * Atomically verify a pairing secret and claim the session for completion.
 *
 * Single-use: the first successful claim moves `pending` -> `processing`, so a
 * duplicate extension POST cannot start a second bootstrap. Returns the frozen
 * provider target plus the expectations for the caller to enforce.
 *
 * @returns {{ ok: true, providerId: string, origin: string, label: string,
 *             routerOrigin: string, expectedUserId: string|null,
 *             connectionId: string|null }
 *          | { ok: false, reason: string }}
 */
export function claimPairingSession(pairingId, pairSecret) {
  const id = boundedString(pairingId, MAX_ID_LENGTH);
  const secret = boundedString(pairSecret, MAX_SECRET_LENGTH);
  if (!id || !secret) return { ok: false, reason: "invalid_pairing" };

  sweep();
  const record = sessions.get(id);
  if (!record) return { ok: false, reason: "invalid_pairing" };
  if (isExpired(record, Date.now())) {
    record.status = PAIRING_STATES.expired;
    return { ok: false, reason: "expired" };
  }
  if (record.status !== PAIRING_STATES.pending) {
    return { ok: false, reason: record.status === PAIRING_STATES.processing ? "in_progress" : "already_used" };
  }

  const supplied = Buffer.from(hashSecret(secret), "hex");
  const stored = Buffer.from(record.pairSecretHash, "hex");
  if (supplied.length !== stored.length || !crypto.timingSafeEqual(supplied, stored)) {
    return { ok: false, reason: "invalid_pairing" };
  }

  record.status = PAIRING_STATES.processing;
  return {
    ok: true,
    providerId: record.providerId,
    origin: record.origin,
    label: record.label,
    routerOrigin: record.routerOrigin || "",
    expectedUserId: record.expectedUserId,
    connectionId: record.connectionId,
  };
}

/** Mark a claimed pairing finished. `connectionId` only on success. */
export function settlePairingSession(pairingId, status, { connectionId = null, errorCode = null } = {}) {
  const record = sessions.get(boundedString(pairingId, MAX_ID_LENGTH));
  if (!record) return;
  record.status = status;
  record.resultConnectionId = connectionId;
  record.errorCode = errorCode;
  // Terminal records linger one extra TTL so the modal can read the outcome.
  record.expiresAt = Date.now();
}

/** Test-only: drop all pairing state. */
export function __resetPairingSessions() {
  sessions.clear();
}
