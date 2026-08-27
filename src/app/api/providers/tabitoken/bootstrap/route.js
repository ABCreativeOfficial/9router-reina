import { NextResponse } from "next/server";
import {
  connectTabiTokenAccount,
  inspectTabiTokenAccount,
  safeConnectionSummary,
} from "@/sse/services/tabitokenBootstrap";

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
 * POST /api/providers/tabitoken/bootstrap
 *
 * Manual TabiToken onboarding: the user supplies management credentials (user id
 * + the token from `/api/user/token`), which the server revalidates against
 * `/api/user/self` before listing tokens or persisting anything. Local-only via
 * dashboardGuard. Never returns a credential.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const managementToken = body?.managementToken;
    const userId = body?.userId;

    const inspection = await inspectTabiTokenAccount({ managementToken, userId });
    if (!inspection.ok) {
      return safeError(inspection, "TabiToken management authentication failed.", 401);
    }

    if (body?.action !== "connect") {
      return NextResponse.json(
        { account: inspection.account, tokens: inspection.tokens, state: inspection.state },
        { headers: NO_STORE },
      );
    }

    const result = await connectTabiTokenAccount({
      managementToken,
      userId,
      tokenId: body?.tokenId,
      name: body?.name,
      inspection,
    });
    if (!result.ok) {
      return safeError(result, "Selected TabiToken token is unavailable.", 400);
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
      { error: "Unable to connect TabiToken account." },
      { status: 500, headers: NO_STORE },
    );
  }
}
