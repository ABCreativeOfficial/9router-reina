import { NextResponse } from "next/server";
import {
  connectGoRouterAccount,
  inspectGoRouterAccount,
  safeConnectionSummary,
} from "@/sse/services/gorouterBootstrap";

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
 * POST /api/providers/gorouter/bootstrap
 *
 * Advanced/manual GoRouter onboarding: the user supplies management credentials
 * directly. The Chrome-bridge pairing routes converge on the same service, so
 * every validation gate lives in one place. Local-only via dashboardGuard.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const managementToken = body?.managementToken;
    const userId = body?.userId;

    const inspection = await inspectGoRouterAccount({ managementToken, userId });
    if (!inspection.ok) {
      return safeError(inspection, "GoRouter management authentication failed.", 401);
    }

    if (body?.action !== "connect") {
      return NextResponse.json(
        { account: inspection.account, tokens: inspection.tokens, state: inspection.state },
        { headers: NO_STORE },
      );
    }

    const result = await connectGoRouterAccount({
      managementToken,
      userId,
      tokenId: body?.tokenId,
      name: body?.name,
      inspection,
    });
    if (!result.ok) {
      return safeError(result, "Selected GoRouter token is unavailable.", 400);
    }

    return NextResponse.json(
      {
        success: true,
        connection: safeConnectionSummary(result.connection, result.account),
        models: result.models,
      },
      { status: result.created ? 201 : 200, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json(
      { error: "Unable to connect GoRouter account." },
      { status: 500, headers: NO_STORE },
    );
  }
}
