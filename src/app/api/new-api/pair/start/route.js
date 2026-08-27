import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import {
  buildPairingLoginUrl,
  createPairingSession,
  normalizePairUserId,
} from "@/lib/newapi/pairing";
import { getNewApiProviderDefinition } from "@/sse/services/newapiProvider";
import { getNewApiNodeOrigin } from "open-sse/services/newapi/definition.js";
import { resolveRouterOrigin } from "@/lib/newapi/routerOrigin";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * POST /api/new-api/pair/start
 *
 * Opens a short-lived, single-use pairing the universal bridge extension can
 * complete. The provider target — trusted origin, label, provider id — is
 * resolved here from the persisted definition and frozen into the server-side
 * record; the browser never supplies it. `expectedUserId`/`connectionId` pin a
 * reconnect so a different account cannot take over an existing connection.
 *
 * This 9Router's own public origin is resolved here too and travels in the login
 * fragment, so the bridge posts its completion back to *this* deployment rather
 * than assuming localhost — 9Router may be served over HTTPS behind a proxy.
 *
 * The secret travels only in the returned URL's fragment, which browsers never
 * send to the provider's server. Dashboard-authenticated (local-only) route.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

    const node = await getNewApiProviderDefinition(body?.providerId);
    if (!node) {
      return fail(404, "Not a New API provider.");
    }

    const expectedUserId = normalizePairUserId(body?.expectedUserId) || null;
    if (body?.expectedUserId != null && body.expectedUserId !== "" && !expectedUserId) {
      return fail(400, "Invalid account id.");
    }

    // A reconnect target must belong to this provider and to the expected account.
    let connectionId = null;
    if (body?.connectionId) {
      const connection = await getProviderConnectionById(String(body.connectionId));
      if (!connection || connection.provider !== node.id) {
        return fail(404, "Connection not found for this provider.");
      }
      const storedUserId = normalizePairUserId(connection.providerSpecificData?.userId);
      if (expectedUserId && storedUserId && storedUserId !== expectedUserId) {
        return fail(400, "Connection does not belong to that account.");
      }
      connectionId = connection.id;
    }

    const session = createPairingSession({
      providerId: node.id,
      origin: getNewApiNodeOrigin(node),
      label: node.name,
      routerOrigin: await resolveRouterOrigin(request),
      expectedUserId,
      connectionId,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          pairingId: session.pairingId,
          pairSecret: session.pairSecret,
          expiresAt: session.expiresAt,
          routerOrigin: session.routerOrigin,
          loginUrl: buildPairingLoginUrl(session),
        },
      },
      { headers: NO_STORE },
    );
  } catch {
    return fail(500, "Unable to start pairing.");
  }
}
