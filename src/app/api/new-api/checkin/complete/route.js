import {
  BRIDGE_HEADER,
  BRIDGE_VERSION,
} from "@/lib/newapi/pairing";
import {
  CHECKIN_STATES,
  claimCheckinSession,
  settleCheckinSession,
} from "@/lib/newapi/checkin";
import { fetchNewApiCheckinStatus, resolveNewApiCheckinConnection } from "@/lib/newapi/checkinService";
import { isAcceptableCompletionOrigin, readRequestOrigin } from "@/lib/newapi/routerOrigin";
import { getNewApiNodeOrigin, normalizeNewApiOrigin } from "open-sse/services/newapi/definition.js";
import { listNewApiProviders } from "@/sse/services/newapiProvider";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function corsHeaders(request) {
  const vary = { Vary: "Origin" };
  const grant = {
    ...vary,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cache-Control, X-9Router-Bridge",
    "Access-Control-Max-Age": "600",
  };
  const raw = (request.headers.get("origin") || "").trim();
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(raw)) {
    return { ...grant, "Access-Control-Allow-Origin": raw };
  }
  const origin = normalizeNewApiOrigin(raw);
  if (!origin.ok) return vary;
  const nodes = await listNewApiProviders().catch(() => []);
  return nodes.some((node) => getNewApiNodeOrigin(node) === origin.origin)
    ? { ...grant, "Access-Control-Allow-Origin": origin.origin }
    : vary;
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: { ...(await corsHeaders(request)), ...NO_STORE } });
}

export async function POST(request) {
  const cors = await corsHeaders(request);
  const fail = (status, error, errorCode) => Response.json(
    { error, ...(errorCode ? { errorCode } : {}) },
    { status, headers: { ...cors, ...NO_STORE } },
  );
  let checkinId = "";

  try {
    if (request.headers.get(BRIDGE_HEADER) !== BRIDGE_VERSION) {
      return fail(400, "Unsupported bridge version.", "bridge_version");
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || "turnstile" in body) {
      return fail(400, "Invalid check-in payload.", "invalid_payload");
    }

    checkinId = typeof body.checkinId === "string" ? body.checkinId : "";
    const claim = claimCheckinSession(checkinId, body.checkinSecret);
    if (!claim.ok) {
      return fail(claim.reason === "in_progress" ? 409 : 403, "Check-in session is no longer valid.", claim.reason);
    }

    if (!isAcceptableCompletionOrigin(claim.routerOrigin, readRequestOrigin(request))) {
      settleCheckinSession(checkinId, CHECKIN_STATES.error, "router_origin_mismatch");
      return fail(403, "Check-in was issued for a different 9Router origin.", "router_origin_mismatch");
    }
    const asserted = normalizeNewApiOrigin(body.providerOrigin);
    if (!asserted.ok || asserted.origin !== claim.providerOrigin) {
      settleCheckinSession(checkinId, CHECKIN_STATES.error, "provider_mismatch");
      return fail(403, "Check-in provider mismatch.", "provider_mismatch");
    }

    const resolved = await resolveNewApiCheckinConnection(claim.connectionId);
    if (!resolved
      || resolved.node.id !== claim.providerId
      || resolved.providerOrigin !== claim.providerOrigin
      || String(resolved.connection.providerSpecificData?.userId || "") !== claim.userId) {
      settleCheckinSession(checkinId, CHECKIN_STATES.error, "connection_mismatch");
      return fail(404, "Check-in connection no longer matches.", "connection_mismatch");
    }

    const status = await fetchNewApiCheckinStatus(resolved);
    if (!status.ok || status.checkin?.checkedInToday !== true) {
      settleCheckinSession(checkinId, CHECKIN_STATES.error, "checkin_not_confirmed");
      return fail(status.ok ? 409 : (status.status || 502), "Provider did not confirm today's check-in.", "checkin_not_confirmed");
    }

    settleCheckinSession(checkinId, CHECKIN_STATES.success);
    return Response.json(
      { success: true, data: { status: "success", checkedInToday: true } },
      { headers: { ...cors, ...NO_STORE } },
    );
  } catch {
    if (checkinId) settleCheckinSession(checkinId, CHECKIN_STATES.error, "checkin_failed");
    return fail(500, "Unable to confirm check-in.", "checkin_failed");
  }
}
