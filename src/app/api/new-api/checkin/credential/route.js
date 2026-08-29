import {
  BRIDGE_HEADER,
  BRIDGE_VERSION,
} from "@/lib/newapi/pairing";
import {
  claimCheckinCredential,
  readCheckinSession,
} from "@/lib/newapi/checkin";
import { resolveNewApiCheckinConnection } from "@/lib/newapi/checkinService";
import { isAcceptableCompletionOrigin, readRequestOrigin } from "@/lib/newapi/routerOrigin";
import { normalizeNewApiOrigin } from "open-sse/services/newapi/definition.js";

export const dynamic = "force-dynamic";

const NO_CACHE = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  Vary: "Origin",
};
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function corsHeaders(request) {
  const origin = (request.headers.get("origin") || "").trim();
  if (!EXTENSION_ORIGIN.test(origin)) return NO_CACHE;
  return {
    ...NO_CACHE,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cache-Control, X-9Router-Bridge",
    "Access-Control-Max-Age": "600",
  };
}

export function OPTIONS(request) {
  const origin = (request.headers.get("origin") || "").trim();
  return new Response(null, {
    status: EXTENSION_ORIGIN.test(origin) ? 204 : 403,
    headers: corsHeaders(request),
  });
}

export async function POST(request) {
  const headers = corsHeaders(request);
  const fail = (status, error, errorCode) => Response.json(
    { error, ...(errorCode ? { errorCode } : {}) },
    { status, headers },
  );
  let checkinId = "";

  try {
    const requestOrigin = (request.headers.get("origin") || "").trim();
    if (!EXTENSION_ORIGIN.test(requestOrigin)) {
      return fail(403, "Chrome extension origin required.", "extension_origin_required");
    }
    if (request.headers.get(BRIDGE_HEADER) !== BRIDGE_VERSION) {
      return fail(400, "Unsupported bridge version.", "bridge_version");
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object"
      || Object.keys(body).some((key) => !["checkinId", "checkinSecret", "providerOrigin"].includes(key))) {
      return fail(400, "Invalid credential request.", "invalid_payload");
    }
    checkinId = typeof body.checkinId === "string" ? body.checkinId : "";
    if (!checkinId || typeof body.checkinSecret !== "string" || typeof body.providerOrigin !== "string") {
      return fail(400, "Invalid credential request.", "invalid_payload");
    }

    const asserted = normalizeNewApiOrigin(body.providerOrigin);
    if (!asserted.ok) return fail(400, "Invalid provider origin.", "provider_mismatch");

    const session = readCheckinSession(checkinId, body.checkinSecret);
    if (!session.ok) {
      const status = session.reason === "credential_already_issued" ? 409 : 403;
      return fail(status, "Credential lease is no longer available.", session.reason);
    }
    if (asserted.origin !== session.providerOrigin) {
      return fail(403, "Check-in provider mismatch.", "provider_mismatch");
    }
    if (!isAcceptableCompletionOrigin(session.routerOrigin, readRequestOrigin(request))) {
      return fail(403, "Check-in was issued for a different 9Router origin.", "router_origin_mismatch");
    }

    const resolved = await resolveNewApiCheckinConnection(session.connectionId);
    if (!resolved
      || resolved.node.id !== session.providerId
      || resolved.providerOrigin !== session.providerOrigin
      || String(resolved.connection.providerSpecificData?.userId || "") !== session.userId) {
      return fail(404, "Check-in connection no longer matches.", "connection_mismatch");
    }

    const claim = claimCheckinCredential(checkinId, body.checkinSecret);
    if (!claim.ok) {
      const status = claim.reason === "credential_already_issued" ? 409 : 403;
      return fail(status, "Credential lease is no longer available.", claim.reason);
    }

    return Response.json({
      success: true,
      data: {
        providerOrigin: claim.providerOrigin,
        userId: claim.userId,
        managementToken: resolved.connection.accessToken,
      },
    }, { headers });
  } catch {
    return fail(500, "Unable to lease check-in credential.", "credential_failed");
  }
}
