import { getAccount, listAccounts, saveAccount, sealTokens, unsealTokens } from "./hybridStore.js";

const BASE_URL = "https://xingchiapi.com/api/v1";
const inFlight = globalThis.__xingchiHybridCheckinJobs ??= new Map();
const REQUEST_TIMEOUT_MS = 15_000;

async function api(path, token, method = "GET", body, fetchFn = fetch) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}`, "x-user-ui-request": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchFn(`${BASE_URL}${path}`, {
    method, headers, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await response.json().catch(() => null);
  return { ok: response.ok && parsed?.code === 0, status: response.status, data: parsed?.data, code: parsed?.code };
}

export async function validateXingchiSession(accessToken, fetchFn = fetch) {
  const result = await api("/auth/me", accessToken, "GET", undefined, fetchFn);
  if (!result.ok || typeof result.data?.email !== "string") throw new Error("Xingchi login session is no longer valid.");
  return result.data;
}

export async function refreshXingchiSession(refreshToken, fetchFn = fetch) {
  const result = await api("/auth/refresh", refreshToken, "POST", { refresh_token: refreshToken }, fetchFn);
  if (!result.ok || typeof result.data?.access_token !== "string") {
    throw new Error("Xingchi refresh token expired. Pair the account again in Chrome.");
  }
  return { accessToken: result.data.access_token,
    refreshToken: typeof result.data.refresh_token === "string" ? result.data.refresh_token : refreshToken };
}

/** Refresh in a per-account critical section: rotating refresh tokens must never be reused concurrently. */
async function guarded(id, job) {
  if (inFlight.has(id)) return inFlight.get(id);
  const pending = job().finally(() => inFlight.delete(id));
  inFlight.set(id, pending);
  return pending;
}

function xingchiToday() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function readCurrentCheckinStatus(id, fetchFn) {
  let account = await getAccount(id);
  if (!account?.sealed) throw new Error("Account is not paired. Open Xingchi in Chrome and pair first.");
  const tokens = unsealTokens(id, account.sealed);
  if (!tokens?.accessToken) throw new Error("Stored session missing. Pair again.");
  const getStatus = (token) => api("/user/checkin?timezone=Asia%2FShanghai", token, "GET", undefined, fetchFn);
  let response = await getStatus(tokens.accessToken);
  if ((response.status === 401 || response.code === "INVALID_TOKEN") && tokens.refreshToken) {
    const refreshed = await refreshXingchiSession(tokens.refreshToken, fetchFn);
    const identity = await validateXingchiSession(refreshed.accessToken, fetchFn);
    if (identity.email?.trim().toLowerCase() !== account.email) {
      throw new Error("Refreshed session identity differs from paired account.");
    }
    account = await saveAccount({ ...account, sealed: sealTokens(id, refreshed), status: "paired" });
    response = await getStatus(refreshed.accessToken);
  }
  if (!response.ok) throw new Error(`Could not read Xingchi check-in status (${response.status}).`);
  return { account, status: response.data || {} };
}

/** A read-only, up-to-date status probe. Never claims a reward. */
export async function getCheckinStatus(id, { fetchFn = fetch } = {}) {
  return guarded(id, async () => {
    const { account, status } = await readCurrentCheckinStatus(id, fetchFn);
    const checkedInToday = status.claimed_today === true;
    const today = status.today || xingchiToday();
    const nextClaimAt = checkedInToday
      ? status.next_claim_at || new Date(Date.parse(`${today}T16:00:00Z`)).toISOString()
      : null;
    await saveAccount({ ...account, status: "paired", claimedToday: checkedInToday,
      checkinEnabled: status.enabled !== false,
      lastClaimDate: checkedInToday ? today : account.lastClaimDate ?? null,
      nextClaimAt,
      lastStatusAt: new Date().toISOString(), lastError: null });
    return { checkedInToday, enabled: status.enabled !== false,
      nextClaimAt, today };
  });
}

export async function checkinAccount(id, { manual = false, fetchFn = fetch } = {}) {
  return guarded(id, async () => {
    let account = await getAccount(id);
    if (!account?.sealed) throw new Error("Account is not paired. Open Xingchi in Chrome and pair first.");
    if (!manual && account.autoCheckin !== true) return { skipped: "disabled" };
    if (!manual && account.nextClaimAt && Date.parse(account.nextClaimAt) > Date.now()) return { skipped: "waiting_for_reset" };
    const current = await readCurrentCheckinStatus(id, fetchFn);
    account = current.account;
    const alreadyClaimed = current.status.claimed_today === true;
    if (!alreadyClaimed && current.status.enabled === false) {
      await saveAccount({ ...account, checkinEnabled: false, claimedToday: false,
        lastStatusAt: new Date().toISOString(), lastError: null });
      return { skipped: "provider_disabled" };
    }

    const latest = unsealTokens(id, account.sealed);
    const result = alreadyClaimed
      ? { ok: true, data: { status: current.status } }
      : await api("/user/checkin?timezone=Asia%2FShanghai", latest.accessToken, "POST", undefined, fetchFn);
    if (!result.ok) throw new Error(`Xingchi check-in failed (${result.status}).`);
    const claimed = result.data?.status || result.data || {};
    if (claimed.claimed_today !== true) throw new Error("Xingchi did not confirm today's check-in.");
    const today = xingchiToday();
    // midnight of the *next* Shanghai calendar date, independent of server TZ
    const nextClaimAt = claimed.next_claim_at || new Date(Date.parse(`${today}T16:00:00Z`)).toISOString();
    await saveAccount({ ...account, status: "paired", claimedToday: true, checkinEnabled: true,
      lastClaimDate: claimed.today || today, lastStatusAt: new Date().toISOString(),
      nextClaimAt, lastReward: alreadyClaimed ? account.lastReward ?? null : result.data?.amount ?? null,
      lastCheckinAt: new Date().toISOString(), lastError: null });
    return { status: alreadyClaimed ? "already_claimed" : "success", nextClaimAt,
      amount: alreadyClaimed ? null : result.data?.amount ?? null };
  });
}

export async function runAutoCheckins() {
  for (const account of await listAccounts()) {
    if (!account.autoCheckin || !account.sealed) continue;
    try { await checkinAccount(account.id); }
    catch (error) {
      const latest = await getAccount(account.id);
      if (latest) await saveAccount({ ...latest, lastError: error.message, lastAttemptAt: new Date().toISOString() });
    }
  }
}

const globalScheduler = globalThis.__xingchiHybridScheduler ??= { timer: null, running: false };
export function startXingchiCheckinScheduler() {
  if (globalScheduler.timer) return;
  const tick = async () => {
    if (globalScheduler.running) return;
    globalScheduler.running = true;
    try { await runAutoCheckins(); } catch (error) { console.warn("[Xingchi check-in] background error:", error.message); }
    finally { globalScheduler.running = false; }
  };
  globalScheduler.timer = setInterval(() => { void tick(); }, 15 * 60 * 1000);
  globalScheduler.timer.unref?.();
  setTimeout(() => { void tick(); }, 30_000).unref?.();
}
