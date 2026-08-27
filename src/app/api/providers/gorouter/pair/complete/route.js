import { NextResponse } from "next/server";
import {
  BRIDGE_HEADER,
  BRIDGE_VERSION,
  PAIRING_STATES,
  claimPairingSession,
  normalizePairUserId,
  settlePairingSession,
} from "@/lib/gorouter/pairing";
import {
  connectGoRouterAccount,
  inspectGoRouterAccount,
} from "@/sse/services/gorouterBootstrap";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_TOKEN_LENGTH = 8192;

// The bridge posts cross-origin from the GoRouter page context, so the browser
// sends a preflight for the JSON content type. These headers only make the
// transport possible — authorization is the pairing secret, never the origin.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://gorouter.app",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control, X-9Router-Bridge",
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...NO_STORE } });
}

function fail(status, error, errorCode) {
  return NextResponse.json(
    { error, ...(errorCode ? { errorCode } : {}) },
    { status, headers: { ...CORS_HEADERS, ...NO_STORE } },
  );
}

/**
 * POST /api/providers/gorouter/pair/complete
 *
 * The Chrome bridge posts the GoRouter management credentials it obtained inside
 * the GoRouter origin. The one-time pairing secret is the authorization — the
 * bridge header is only a protocol marker, and Origin/CORS are never trusted as
 * a boundary. Claiming the pairing flips it to `processing` atomically, so a
 * duplicate POST cannot start a second bootstrap or create a second connection.
 *
 * Never logs the body and never returns a credential.
 */
export async function POST(request) {
  let pairingId = null;
  try {
    if (request.headers.get(BRIDGE_HEADER) !== BRIDGE_VERSION) {
      return fail(400, "Unsupported GoRouter bridge version.", "bridge_version");
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return fail(400, "Invalid pairing payload.", "invalid_payload");
    }

    pairingId = typeof body.pairingId === "string" ? body.pairingId : "";
    const managementToken = typeof body.managementToken === "string" ? body.managementToken.trim() : "";
    const userId = normalizePairUserId(body.userId);
    if (!managementToken || managementToken.length > MAX_TOKEN_LENGTH || !userId) {
      return fail(400, "Invalid pairing payload.", "invalid_payload");
    }

    const claim = claimPairingSession(pairingId, body.pairSecret);
    if (!claim.ok) {
      const status = claim.reason === "in_progress" ? 409 : 403;
      const message = claim.reason === "expired"
        ? "Pairing expired."
        : claim.reason === "in_progress"
          ? "Pairing already in progress."
          : "Pairing is no longer valid.";
      return fail(status, message, claim.reason);
    }

    // Reconnect: the pairing was opened for one specific account.
    if (claim.expectedUserId && claim.expectedUserId !== userId) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "wrong_account" });
      return fail(403, "Wrong GoRouter account.", "wrong_account");
    }

    const inspection = await inspectGoRouterAccount({ managementToken, userId });
    if (!inspection.ok) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "management_auth_failed" });
      return fail(inspection.status || 401, inspection.message, "management_auth_failed");
    }

    // The server-validated account id is canonical; it must match what was sent.
    if (inspection.account.id !== userId) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "wrong_account" });
      return fail(403, "Wrong GoRouter account.", "wrong_account");
    }

    if (inspection.state === "needs_token_creation") {
      settlePairingSession(pairingId, PAIRING_STATES.needsTokenCreation);
      return fail(409, "No suitable existing GoRouter inference token.", "needs_token_creation");
    }

    const preferred = inspection.tokens.find((token) => token.status === 1);
    const result = await connectGoRouterAccount({
      managementToken,
      userId,
      tokenId: preferred.id,
      inspection,
    });
    if (!result.ok) {
      const errorCode = result.state === "needs_token_creation" ? "needs_token_creation" : "connect_failed";
      settlePairingSession(
        pairingId,
        result.state === "needs_token_creation" ? PAIRING_STATES.needsTokenCreation : PAIRING_STATES.error,
        { errorCode },
      );
      return fail(result.status || 502, result.message, errorCode);
    }

    settlePairingSession(pairingId, PAIRING_STATES.success, { connectionId: result.connection.id });
    return NextResponse.json(
      { success: true, data: { connectionId: result.connection.id } },
      { headers: { ...CORS_HEADERS, ...NO_STORE } },
    );
  } catch {
    if (pairingId) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "connect_failed" });
    }
    return fail(500, "Connection could not be saved.", "connect_failed");
  }
}
