/**
 * Automatic New API inference-token selection (custom fork).
 *
 * Pure policy: given the token metadata `client.listTokens()` returns, decide
 * which candidates could serve inference and in what order to try them. The
 * caller does the I/O (key retrieval, validation, creation) — keeping this
 * module side-effect free is what makes the ordering rules testable.
 *
 * Metadata is treated as a filter, never as proof: upstream writes the
 * `expired`/`exhausted` statuses lazily (and not at all when its Redis cache is
 * enabled), so a token can still read `status: 1` while already unusable. Every
 * candidate is therefore still validated against the inference surface before it
 * is persisted.
 */

const NEVER_EXPIRES = -1;

/** Deterministic name for an auto-created token; the suffix makes re-listing exact. */
export function buildAutoTokenName(randomSuffix) {
  const suffix = String(randomSuffix || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `9Router Auto ${suffix || "1"}`;
}

/**
 * Could this token plausibly serve inference?
 *
 * Excludes: not-enabled status, a lapsed `expired_time`, and a finite quota that
 * is already spent. A model-limited token is NOT excluded — a restricted token is
 * still a valid credential, and 9Router has its own per-account model policy.
 *
 * @param {object} token   from client.listTokens()
 * @param {{ activeStatus?: number, now?: number }} [options] `now` in unix seconds
 */
export function isUsableNewApiToken(token, { activeStatus = 1, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!token || token.status !== activeStatus) return false;

  // -1 (and any non-numeric/absent value) means no expiry to enforce.
  if (Number.isFinite(token.expiredTime) && token.expiredTime !== NEVER_EXPIRES) {
    if (token.expiredTime <= now) return false;
  }

  // Only a *reliable* finite balance disqualifies a token.
  if (!token.unlimitedQuota && Number.isFinite(token.remainQuota) && token.remainQuota <= 0) {
    return false;
  }

  return true;
}

/**
 * Usable tokens, newest real use first.
 *
 * `accessed_time` desc → `created_time` desc → `id` desc. A missing or invalid
 * timestamp sorts last within its tier rather than winning as 0, so a never-used
 * token cannot outrank one that is demonstrably live.
 */
export function sortNewApiTokenCandidates(tokens, options = {}) {
  const usable = (tokens || []).filter((token) => isUsableNewApiToken(token, options));
  const rank = (value) => (Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY);
  return usable.sort((a, b) => (
    rank(b.accessedTime) - rank(a.accessedTime)
    || rank(b.createdTime) - rank(a.createdTime)
    || b.id - a.id
  ));
}
