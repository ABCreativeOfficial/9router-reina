import crypto from "node:crypto";

export const CHECKIN_TTL_MS = 5 * 60 * 1000;
export const CHECKIN_PROTOCOL = "newapi-checkin-v2";

export const CHECKIN_STATES = Object.freeze({
  pending: "pending",
  processing: "processing",
  success: "success",
  error: "error",
  expired: "expired",
});

const MAX_SESSIONS = 32;
const MAX_ID_LENGTH = 128;
const MAX_SECRET_LENGTH = 256;
const sessions = new Map();

function boundedString(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : "";
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function sweep(now = Date.now()) {
  for (const [id, record] of sessions) {
    if (now >= record.expiresAt + CHECKIN_TTL_MS) sessions.delete(id);
  }
}

export function createCheckinSession({
  connectionId,
  providerId,
  providerOrigin,
  providerLabel,
  routerOrigin,
  userId,
}) {
  sweep();
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) sessions.delete(oldest[0]);
  }

  const checkinId = crypto.randomBytes(16).toString("base64url");
  const checkinSecret = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const record = {
    checkinSecretHash: hashSecret(checkinSecret),
    connectionId,
    providerId,
    providerOrigin,
    providerLabel: boundedString(providerLabel, 100) || "New API",
    routerOrigin,
    userId,
    createdAt: now,
    expiresAt: now + CHECKIN_TTL_MS,
    protocol: CHECKIN_PROTOCOL,
    status: CHECKIN_STATES.pending,
    errorCode: null,
  };
  sessions.set(checkinId, record);

  return {
    checkinId,
    checkinSecret,
    expiresAt: record.expiresAt,
    connectionId,
    providerId,
    providerOrigin,
    providerLabel: record.providerLabel,
    routerOrigin,
  };
}

export function buildCheckinLaunchUrl(session) {
  const fragment = new URLSearchParams({
    "9router_checkin_protocol": CHECKIN_PROTOCOL,
    "9router_checkin_id": session.checkinId,
    "9router_provider_label": session.providerLabel,
    "9router_router_origin": session.routerOrigin,
  });
  return `${session.providerOrigin}/#${fragment.toString()}`;
}

export function readCheckinStatus(checkinId) {
  const id = boundedString(checkinId, MAX_ID_LENGTH);
  if (!id) return { status: CHECKIN_STATES.expired };
  sweep();
  const record = sessions.get(id);
  if (!record) return { status: CHECKIN_STATES.expired };
  if ((record.status === CHECKIN_STATES.pending || record.status === CHECKIN_STATES.processing)
    && Date.now() >= record.expiresAt) {
    record.status = CHECKIN_STATES.expired;
  }
  return {
    status: record.status,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  };
}

function validateCheckinSession(checkinId, checkinSecret, requiredStatus) {
  const id = boundedString(checkinId, MAX_ID_LENGTH);
  const secret = boundedString(checkinSecret, MAX_SECRET_LENGTH);
  if (!id || !secret) return { ok: false, reason: "invalid_checkin" };

  sweep();
  const record = sessions.get(id);
  if (!record) return { ok: false, reason: "invalid_checkin" };
  if (Date.now() >= record.expiresAt) {
    record.status = CHECKIN_STATES.expired;
    return { ok: false, reason: "expired" };
  }
  if (record.protocol !== CHECKIN_PROTOCOL) return { ok: false, reason: "unsupported_protocol" };

  const supplied = hashSecret(secret);
  if (supplied.length !== record.checkinSecretHash.length
    || !crypto.timingSafeEqual(supplied, record.checkinSecretHash)) {
    return { ok: false, reason: "invalid_checkin" };
  }
  if (record.status !== requiredStatus) {
    return { ok: false, reason: "invalid_state" };
  }
  return { ok: true, id, record };
}

function safeClaim(record) {
  return {
    connectionId: record.connectionId,
    providerId: record.providerId,
    providerOrigin: record.providerOrigin,
    providerLabel: record.providerLabel,
    routerOrigin: record.routerOrigin,
    userId: record.userId,
  };
}

/** Validate a pending v2 lease without consuming it. */
export function readCheckinSession(checkinId, checkinSecret) {
  const validation = validateCheckinSession(checkinId, checkinSecret, CHECKIN_STATES.pending);
  if (!validation.ok) {
    const record = sessions.get(boundedString(checkinId, MAX_ID_LENGTH));
    if (validation.reason === "invalid_state" && record?.status === CHECKIN_STATES.processing) {
      return { ok: false, reason: "credential_already_issued" };
    }
    return validation;
  }
  return { ok: true, ...safeClaim(validation.record) };
}

/** Atomically lease the target credential once: pending -> processing. */
export function claimCheckinCredential(checkinId, checkinSecret) {
  const validation = validateCheckinSession(checkinId, checkinSecret, CHECKIN_STATES.pending);
  if (!validation.ok) {
    const record = sessions.get(boundedString(checkinId, MAX_ID_LENGTH));
    if (validation.reason === "invalid_state" && record?.status === CHECKIN_STATES.processing) {
      return { ok: false, reason: "credential_already_issued" };
    }
    return validation;
  }
  validation.record.status = CHECKIN_STATES.processing;
  return { ok: true, ...safeClaim(validation.record) };
}

/** Validate completion without changing state; only processing may complete. */
export function validateCheckinCompletion(checkinId, checkinSecret) {
  const validation = validateCheckinSession(checkinId, checkinSecret, CHECKIN_STATES.processing);
  return validation.ok ? { ok: true, ...safeClaim(validation.record) } : validation;
}

export function settleCheckinSession(checkinId, status, errorCode = null) {
  const record = sessions.get(boundedString(checkinId, MAX_ID_LENGTH));
  if (!record) return;
  record.status = status;
  record.errorCode = errorCode;
  // Keep terminal state readable through the original polling deadline.
}

export function __resetCheckinSessions() {
  sessions.clear();
}

export function __getCheckinSessionForTest(checkinId) {
  return sessions.get(checkinId);
}
