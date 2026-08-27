import crypto from "node:crypto";

/**
 * GoRouter Chrome-bridge pairing sessions (custom fork feature).
 *
 * A pairing is a short-lived, single-use capability that lets the browser
 * extension hand GoRouter management credentials to this local 9Router without
 * the user copying them by hand. The secret is the only authorization: it is
 * generated with 256 bits of entropy, carried to GoRouter in the URL *fragment*
 * (never sent to GoRouter's server), and stored here only as a SHA-256 hash.
 *
 * Deliberately in-process and DB-free: pairing state is transient and must never
 * outlive the process or reach the provider database. A server restart therefore
 * invalidates pending pairings — the user simply clicks Connect again.
 */

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const BRIDGE_HEADER = "x-9router-bridge";
export const BRIDGE_VERSION = "gorouter-chrome-extension-v1";
export const GOROUTER_LOGIN_ORIGIN = "https://gorouter.app";

/** Terminal states end polling; `pending`/`processing` keep it alive. */
export const PAIRING_STATES = Object.freeze({
  pending: "pending",
  processing: "processing",
  success: "success",
  needsTokenCreation: "needs_token_creation",
  error: "error",
  expired: "expired",
});

const MAX_SESSIONS = 32;
const MAX_ID_LENGTH = 128;
const MAX_SECRET_LENGTH = 256;

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

/** Numeric GoRouter account id, or "" when absent/invalid. */
export function normalizePairUserId(value) {
  const raw = boundedString(String(value ?? ""), 64);
  return /^\d+$/.test(raw) ? raw : "";
}

/**
 * Create a pending pairing.
 * @param {{ expectedUserId?: string|null }} [options]
 * @returns {{ pairingId: string, pairSecret: string, expiresAt: number, expectedUserId: string|null }}
 */
export function createPairingSession({ expectedUserId = null } = {}) {
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

  sessions.set(pairingId, {
    pairSecretHash: hashSecret(pairSecret),
    expectedUserId: normalizedExpected,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    status: PAIRING_STATES.pending,
    connectionId: null,
    errorCode: null,
  });

  return { pairingId, pairSecret, expiresAt: now + PAIRING_TTL_MS, expectedUserId: normalizedExpected };
}

/** Login URL carrying the pairing in the fragment only. */
export function buildPairingLoginUrl({ pairingId, pairSecret, expectedUserId = null }) {
  const fragment = new URLSearchParams({
    "9router_pair_id": pairingId,
    "9router_pair_secret": pairSecret,
  });
  const expected = normalizePairUserId(expectedUserId);
  if (expected) fragment.set("expected_user_id", expected);
  return `${GOROUTER_LOGIN_ORIGIN}/#${fragment.toString()}`;
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
    ...(record.connectionId ? { connectionId: record.connectionId } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };
}

/**
 * Atomically verify a pairing secret and claim the session for completion.
 *
 * Single-use: the first successful claim moves `pending` -> `processing`, so a
 * duplicate extension POST cannot start a second bootstrap. Returns the
 * expected user id (or null) for the caller to enforce.
 *
 * @returns {{ ok: true, expectedUserId: string|null } | { ok: false, reason: string }}
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
  return { ok: true, expectedUserId: record.expectedUserId };
}

/** Mark a claimed pairing finished. `connectionId` only on success. */
export function settlePairingSession(pairingId, status, { connectionId = null, errorCode = null } = {}) {
  const record = sessions.get(boundedString(pairingId, MAX_ID_LENGTH));
  if (!record) return;
  record.status = status;
  record.connectionId = connectionId;
  record.errorCode = errorCode;
  // Terminal records linger one extra TTL so the modal can read the outcome.
  record.expiresAt = Date.now();
}

/** Test-only: drop all pairing state. */
export function __resetPairingSessions() {
  sessions.clear();
}
