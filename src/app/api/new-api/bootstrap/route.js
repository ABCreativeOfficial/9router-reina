import { NextResponse } from "next/server";
import {
  connectNewApiAccount,
  inspectNewApiAccount,
  safeConnectionSummary,
} from "@/sse/services/newapiBootstrap";
import { resolveNewApiProviderClient } from "@/sse/services/newapiProvider";
import { buildNewApiConnectionData } from "open-sse/services/newapi/definition.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function safeError(result, fallback, status = 400) {
  return NextResponse.json(
    { error: result?.message || fallback, ...(result?.state ? { state: result.state } : {}) },
    {
      status: result?.status >= 400 && result.status < 600 ? result.status : status,
      headers: NO_STORE,
    },
  );
}

/**
 * POST /api/new-api/bootstrap
 *
 * Advanced/manual onboarding for any New API provider: the user supplies their
 * account id and the management token from the deployment's `/api/user/token`,
 * which the server revalidates against `/api/user/self` before listing tokens or
 * persisting anything. The management origin comes from the persisted provider
 * definition, never from this request. Local-only via dashboardGuard.
 *
 * `action: "inspect"` returns masked metadata only; `action: "connect"` persists.
 * Never returns a credential.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_STORE });
    }

    const resolved = await resolveNewApiProviderClient(body.providerId);
    if (!resolved) {
      return NextResponse.json({ error: "Not a New API provider." }, { status: 404, headers: NO_STORE });
    }
    const { client, node } = resolved;

    const managementToken = body.managementToken;
    const userId = body.userId;

    const inspection = await inspectNewApiAccount({ client, managementToken, userId });
    if (!inspection.ok) {
      return safeError(inspection, `${client.label} management authentication failed.`, 401);
    }

    if (body.action !== "connect") {
      return NextResponse.json(
        { account: inspection.account, tokens: inspection.tokens, state: inspection.state },
        { headers: NO_STORE },
      );
    }

    const result = await connectNewApiAccount({
      client,
      providerId: node.id,
      managementToken,
      userId,
      tokenId: body.tokenId,
      name: body.name,
      inspection,
      connectionData: buildNewApiConnectionData(node),
    });
    if (!result.ok) {
      return safeError(result, `Unable to connect the ${client.label} account.`, 400);
    }

    return NextResponse.json(
      {
        success: true,
        connection: safeConnectionSummary(result.connection, result.account),
        models: result.models,
        tokenCreated: result.tokenCreated === true,
      },
      { status: result.created ? 201 : 200, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json(
      { error: "Unable to connect the account." },
      { status: 500, headers: NO_STORE },
    );
  }
}
