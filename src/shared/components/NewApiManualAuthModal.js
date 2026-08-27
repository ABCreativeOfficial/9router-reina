"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";

/**
 * Manual onboarding for a New API deployment (custom fork).
 *
 * The user supplies their account id and the management token from the
 * deployment's `/api/user/token`, which the server revalidates against
 * `/api/user/self` before listing tokens or persisting anything. Credentials stay
 * server-side after submission and no key is ever returned to this page.
 *
 * GoRouter has its own bridge-first modal; this is the generic manual path used
 * by deployments without a browser bridge.
 */
export default function NewApiManualAuthModal({
  isOpen,
  provider,
  label,
  website,
  expectedUserId,
  onSuccess,
  onClose,
}) {
  const [managementToken, setManagementToken] = useState("");
  const [userId, setUserId] = useState(expectedUserId || "");
  const [name, setName] = useState("");
  const [account, setAccount] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [tokenId, setTokenId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Re-seed from the open/target pair without an effect (React's recommended
  // pattern), so a reopened modal never shows the previous attempt's state.
  const sessionKey = `${isOpen}:${expectedUserId || ""}`;
  const [seenKey, setSeenKey] = useState(sessionKey);
  if (sessionKey !== seenKey) {
    setSeenKey(sessionKey);
    setManagementToken("");
    setUserId(expectedUserId || "");
    setName("");
    setAccount(null);
    setTokens([]);
    setTokenId("");
    setError("");
  }

  const request = async (action) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${provider}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ managementToken, userId, tokenId, name, action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || `Unable to connect ${label} account.`);
        return;
      }
      if (action === "connect") {
        onSuccess();
        return;
      }
      // Reconnect is pinned to one account: the server rejects a mismatch, but
      // flag it here too rather than letting the user pick a wrong token first.
      if (expectedUserId && String(data.account?.id) !== String(expectedUserId)) {
        setError(`Wrong ${label} account. Expected account ${expectedUserId}.`);
        return;
      }
      setAccount(data.account || null);
      setTokens(data.tokens || []);
      const usable = (data.tokens || []).find((token) => token.status === 1);
      setTokenId(usable ? String(usable.id) : "");
      setName((current) => current || data.account?.displayName || label);
      if (data.state === "needs_token_creation") {
        setError(`No usable ${label} API token found. Create one in ${label}, then validate again.`);
      }
    } catch {
      setError(`Unable to connect ${label} account.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={`Connect ${label}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-text-muted">
          <p>
            Log in to {website ? (
              <a href={website} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                {label}
              </a>
            ) : label}, then paste your account id and the token from its
            {" "}<code>/api/user/token</code> endpoint. Both stay server-side after submission.
          </p>
          {expectedUserId && (
            <p className="mt-1">Reconnecting account {expectedUserId}. Use that account&apos;s credentials.</p>
          )}
        </div>

        <Input
          label={`${label} User ID`}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="Numeric user ID"
          disabled={!!account || !!expectedUserId}
        />
        <Input
          label="Management Token"
          type="password"
          value={managementToken}
          onChange={(event) => setManagementToken(event.target.value)}
          placeholder="User access token"
          disabled={!!account}
        />

        {!account ? (
          <Button
            onClick={() => request("inspect")}
            disabled={loading || !managementToken.trim() || !userId.trim()}
            fullWidth
          >
            {loading ? "Validating…" : "Validate and Load Tokens"}
          </Button>
        ) : (
          <>
            <div className="rounded-lg bg-sidebar/50 p-3 text-sm">
              <p className="font-medium">{account.displayName || account.username || `${label} ${account.id}`}</p>
              <p className="text-xs text-text-muted">Group: {account.group || "default"}</p>
            </div>
            {/* Reconnect keeps the stored name, so only offer this when creating. */}
            {!expectedUserId && (
              <Input label="Connection Name" value={name} onChange={(event) => setName(event.target.value)} />
            )}
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Existing API Token</p>
              {tokens.length === 0 ? (
                <p className="text-xs text-text-muted">
                  No existing tokens found. Create one in {label}, then validate again.
                </p>
              ) : tokens.map((token) => (
                <label
                  key={token.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/10 p-2 dark:border-white/10"
                >
                  <input
                    type="radio"
                    name={`${provider}-token`}
                    value={token.id}
                    checked={tokenId === String(token.id)}
                    onChange={(event) => setTokenId(event.target.value)}
                    disabled={token.status !== 1}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{token.name}</span>
                    <span className="block truncate font-mono text-xs text-text-muted">
                      {token.maskedKey || "masked"}
                    </span>
                  </span>
                  {token.status === 1
                    ? <Badge variant="success">active</Badge>
                    : <Badge variant="error">inactive</Badge>}
                </label>
              ))}
            </div>
            <Button onClick={() => request("connect")} disabled={loading || !tokenId} fullWidth>
              {loading ? "Connecting…" : "Use Selected Token"}
            </Button>
          </>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}
        <Button variant="ghost" onClick={onClose} fullWidth disabled={loading}>Cancel</Button>
      </div>
    </Modal>
  );
}

NewApiManualAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  website: PropTypes.string,
  expectedUserId: PropTypes.string,
  onSuccess: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
