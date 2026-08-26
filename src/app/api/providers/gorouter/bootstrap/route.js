import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import {
  fetchGoRouterModels,
  listGoRouterTokens,
  retrieveGoRouterTokenKey,
  validateGoRouterInferenceKey,
  validateGoRouterManagementCredentials,
} from "open-sse/services/gorouter.js";

export const dynamic = "force-dynamic";

function cleanName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const name = value.trim();
  return name && name.length <= 200 ? name : fallback;
}

function safeError(result, fallback, status = 400) {
  return NextResponse.json(
    { error: result?.message || fallback },
    { status: result?.status >= 400 && result.status < 600 ? result.status : status },
  );
}

export async function POST(request) {
  try {
    const body = await request.json();
    const managementToken = body?.managementToken;
    const userId = body?.userId;
    const validation = await validateGoRouterManagementCredentials(managementToken, userId);
    if (!validation.ok) {
      return safeError(validation, "GoRouter management authentication failed.", 401);
    }

    const listed = await listGoRouterTokens(managementToken, userId);
    if (!listed.ok) {
      return safeError(listed, "Unable to retrieve GoRouter API tokens.", 502);
    }

    if (body?.action !== "connect") {
      return NextResponse.json({
        account: validation.account,
        tokens: listed.tokens,
      });
    }

    const tokenId = Number(body?.tokenId);
    const selected = listed.tokens.find((token) => token.id === tokenId);
    if (!selected || selected.status !== 1) {
      return NextResponse.json(
        { error: "Selected GoRouter token is unavailable." },
        { status: 400 },
      );
    }

    const [keyResult, modelsResult] = await Promise.all([
      retrieveGoRouterTokenKey(managementToken, userId, tokenId),
      fetchGoRouterModels(managementToken, userId),
    ]);
    if (!keyResult.ok) {
      return safeError(keyResult, "Selected GoRouter token is unavailable.", 502);
    }
    if (!modelsResult.ok) {
      return safeError(modelsResult, "GoRouter model list could not be fetched.", 502);
    }
    const inferenceValidation = await validateGoRouterInferenceKey(keyResult.apiKey);
    if (!inferenceValidation.ok) {
      return safeError(inferenceValidation, "Selected GoRouter token is unavailable.", 502);
    }

    const fallbackName = selected.name || validation.account.displayName || `GoRouter ${validation.account.id}`;
    const connection = await createProviderConnection({
      provider: "gorouter",
      authType: "apikey",
      name: cleanName(body?.name, fallbackName),
      apiKey: keyResult.apiKey,
      accessToken: String(managementToken).trim(),
      providerSpecificData: {
        userId: validation.account.id,
      },
      isActive: true,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        authType: connection.authType,
        providerSpecificData: { userId: validation.account.id },
      },
      models: modelsResult.models,
    }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Unable to connect GoRouter account." }, { status: 500 });
  }
}
