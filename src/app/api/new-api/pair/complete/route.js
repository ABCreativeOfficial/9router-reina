import { NextResponse } from "next/server";
import {
  BRIDGE_HEADER,
  BRIDGE_VERSION,
  PAIRING_STATES,
  claimPairingSession,
  normalizePairUserId,
  settlePairingSession,
} from "@/lib/newapi/pairing";
import {
  connectNewApiAccount,
  inspectNewApiAccount,
} from "@/sse/services/newapiBootstrap";
import {
  getNewApiProviderDefinition,
  listNewApiProviders,
  resolveNewApiProviderClient,
} from "@/sse/services/newapiProvider";
import {
  buildNewApiConnectionData,
  getNewApiNodeOrigin,
  normalizeNewApiOrigin,
} from "open-sse/services/newapi/definition.js";
import { isAcceptableCompletionOrigin, readRequestOrigin } from "@/lib/newapi/routerOrigin";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_TOKEN_LENGTH = 8192;

/**
 * CORS for the MV3 extension.
 *
 * The bridge posts cross-origin from the provider's page context, so the browser
 * sends a preflight for the JSON content type. A preflight carries no body, so
 * the pairing cannot be resolved yet — instead the request `Origin` is echoed
 * only when it exactly matches the trusted origin of some persisted New API
 * definition. These headers make the transport possible; authorization is always
 * the one-time pairing secret, never the origin.
 */
async function corsHeaders(request) {
  // The response headers depend on Origin either way, so Vary is unconditional.
  const vary = { Vary: "Origin" };
  const grant = {
    ...vary,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cache-Control, X-9Router-Bridge",
    "Access-Control-Max-Age": "600",
  };

  const raw = (request.headers.get("origin") || "").trim();
  // An MV3 service worker posts from its own extension origin rather than the
  // provider page. Echo an exact chrome-extension id — safe because CORS is
  // transport here, and the pairing secret remains the only authorization.
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(raw)) {
    return { ...grant, "Access-Control-Allow-Origin": raw };
  }

  const origin = normalizeNewApiOrigin(raw);
  if (!origin.ok) return vary;
  const nodes = await listNewApiProviders().catch(() => []);
  if (!nodes.some((node) => getNewApiNodeOrigin(node) === origin.origin)) return vary;
  return { ...grant, "Access-Control-Allow-Origin": origin.origin };
}

export async function OPTIONS(request) {
  const cors = await corsHeaders(request);
  return new Response(null, { status: 204, headers: { ...cors, ...NO_STORE } });
}

/**
 * POST /api/new-api/pair/complete
 *
 * The universal bridge posts the management credentials it obtained inside the
 * provider's own origin. The one-time pairing secret is the authorization — the
 * bridge header is only a protocol marker, and Origin/CORS are never trusted as
 * a boundary. Claiming the pairing flips it to `processing` atomically, so a
 * duplicate POST cannot start a second bootstrap or create a second connection.
 *
 * `providerOrigin` in the body is an *assertion* from the extension: it must match
 * the origin frozen into the pairing record, and it never selects the target. The
 * completion's own arrival origin is likewise checked against the router origin
 * `start` handed to the bridge, so a pairing minted for one deployment cannot be
 * settled against another.
 *
 * Never logs the body and never returns a credential.
 */
export async function POST(request) {
  const cors = await corsHeaders(request);
  const fail = (status, error, errorCode) => NextResponse.json(
    { error, ...(errorCode ? { errorCode } : {}) },
    {
      // The upstream status rides along from the management client, and New API
      // reports business errors as 200 + {success:false} — so clamp, or a failed
      // pairing would answer the bridge with a 2xx.
      status: status >= 400 && status < 600 ? status : 502,
      headers: { ...cors, ...NO_STORE },
    },
  );

  let pairingId = null;
  try {
    if (request.headers.get(BRIDGE_HEADER) !== BRIDGE_VERSION) {
      return fail(400, "Unsupported bridge version.", "bridge_version");
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

    // The router origin is part of the handshake: `start` froze the origin it told
    // the bridge to post to. A completion whose host is neither that one nor
    // loopback came from a different deployment. This is a misconfiguration check,
    // not a trust boundary — the arrival origin is header-derived. The real
    // boundary is the one-time secret plus the in-process pairing map, which
    // already proves the completion reached the process that minted it.
    if (!isAcceptableCompletionOrigin(claim.routerOrigin, readRequestOrigin(request))) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "router_origin_mismatch" });
      return fail(403, "Pairing was issued for a different 9Router origin.", "router_origin_mismatch");
    }

    // The extension asserts which origin it captured from; it must be the one the
    // pairing was opened for. A mismatch means the credentials belong to another
    // deployment and must never be persisted against this provider.
    const asserted = normalizeNewApiOrigin(body.providerOrigin);
    if (!asserted.ok || asserted.origin !== claim.origin) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "provider_mismatch" });
      return fail(403, "Pairing provider mismatch.", "provider_mismatch");
    }

    // Reconnect: the pairing was opened for one specific account.
    if (claim.expectedUserId && claim.expectedUserId !== userId) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "wrong_account" });
      return fail(403, "Wrong account.", "wrong_account");
    }

    const resolved = await resolveNewApiProviderClient(claim.providerId);
    if (!resolved) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "provider_missing" });
      return fail(404, "New API provider no longer exists.", "provider_missing");
    }
    const { client, node } = resolved;

    const inspection = await inspectNewApiAccount({ client, managementToken, userId });
    if (!inspection.ok) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "management_auth_failed" });
      return fail(inspection.status || 401, inspection.message, "management_auth_failed");
    }

    // The server-validated account id is canonical; it must match what was sent.
    if (inspection.account.id !== userId) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "wrong_account" });
      return fail(403, "Wrong account.", "wrong_account");
    }

    const result = await connectNewApiAccount({
      client,
      providerId: node.id,
      managementToken,
      userId,
      inspection,
      connectionData: buildNewApiConnectionData(node),
    });
    if (!result.ok) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "connect_failed" });
      return fail(result.status || 502, result.message, "connect_failed");
    }

    settlePairingSession(pairingId, PAIRING_STATES.success, { connectionId: result.connection.id });
    return NextResponse.json(
      { success: true, data: { connectionId: result.connection.id } },
      { headers: { ...cors, ...NO_STORE } },
    );
  } catch {
    if (pairingId) {
      settlePairingSession(pairingId, PAIRING_STATES.error, { errorCode: "connect_failed" });
    }
    return fail(500, "Connection could not be saved.", "connect_failed");
  }
}

// Re-exported for the route's own tests: proves the definition lookup is the only
// path to a management target.
export const __test__ = { getNewApiProviderDefinition };
