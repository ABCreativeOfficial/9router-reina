"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";

const POLL_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set(["success", "error", "expired"]);

// Label-parameterized rather than a fixed table: a New API provider's name comes
// from its user-created definition.
const statusTextFor = (label) => ({
  pending: `Waiting for ${label} authentication…`,
  processing: `Completing ${label} connection…`,
  success: `${label} account connected.`,
  error: `${label} pairing failed. Try again.`,
  expired: "Pairing expired. Start again.",
});

const errorTextFor = (label) => ({
  wrong_account: `A different ${label} account is logged in. Log out on ${label}, then retry.`,
  management_auth_failed: `${label} authentication failed.`,
  provider_mismatch: "The browser authenticated against a different provider.",
  provider_missing: `This ${label} provider no longer exists.`,
  router_origin_mismatch: "The pairing was issued for a different 9Router address.",
  connect_failed: "Connection could not be saved.",
});

/**
 * Bridge-first onboarding for any New API provider (custom fork).
 *
 * 9Router mints a short-lived single-use pairing, opens the provider's login page
 * with the secret in the URL fragment, and polls a non-secret status route. The
 * universal 9Router New API Bridge extension captures the management credential
 * inside the provider's own origin, so no token is pasted here and none is ever
 * exposed to this page. A usable inference token is chosen or created server-side.
 *
 * The manual management-token form remains as an advanced fallback for recovery.
 */
export default function NewApiAuthModal({
  isOpen,
  providerId,
  label,
  origin,
  expectedUserId,
  connectionId,
  onSuccess,
  onClose,
}) {
  const [pairing, setPairing] = useState(null);
  const [status, setStatus] = useState(null);
  const [starting, setStarting] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [error, setError] = useState("");
  const [showManual, setShowManual] = useState(false);

  const [managementToken, setManagementToken] = useState("");
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [account, setAccount] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [tokenId, setTokenId] = useState("");
  const [manualLoading, setManualLoading] = useState(false);

  const popupRef = useRef(null);

  const statusText = statusTextFor(label);
  const errorText = errorTextFor(label);

  // Re-seed from the open/target pair without an effect (React's recommended
  // pattern), so a reopened modal never shows the previous pairing's state.
  const sessionKey = `${isOpen}:${providerId}:${expectedUserId || ""}`;
  const [seenKey, setSeenKey] = useState(sessionKey);
  if (sessionKey !== seenKey) {
    setSeenKey(sessionKey);
    setPairing(null);
    setStatus(null);
    setStarting(false);
    setPopupBlocked(false);
    setError("");
    setShowManual(false);
    setManagementToken("");
    setUserId(expectedUserId || "");
    setName("");
    setAccount(null);
    setTokens([]);
    setTokenId("");
  }

  // Poll the non-secret pairing status while a pairing is open.
  useEffect(() => {
    if (!isOpen || !pairing?.pairingId) return;
    if (status && TERMINAL_STATES.has(status)) return;

    let cancelled = false;
    let timer = null;

    const tick = async () => {
      try {
        const response = await fetch(
          `/api/new-api/pair/status?id=${encodeURIComponent(pairing.pairingId)}`,
          { cache: "no-store" },
        );
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        const next = payload?.data?.status;
        if (next) {
          setStatus(next);
          if (payload.data.errorCode) setError(errorTextFor(label)[payload.data.errorCode] || "");
          if (next === "success") {
            // Terminal: the effect's own guard stops it from re-entering, so
            // onSuccess fires exactly once per pairing.
            try { popupRef.current?.close(); } catch { /* popup may already be gone */ }
            onSuccess();
            return;
          }
          if (TERMINAL_STATES.has(next)) return;
        }
      } catch {
        // Transient failure: keep polling until the pairing itself expires.
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOpen, pairing, status, label, onSuccess]);

  const startPairing = async () => {
    setStarting(true);
    setError("");
    setPopupBlocked(false);
    try {
      const response = await fetch("/api/new-api/pair/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          expectedUserId: expectedUserId || null,
          connectionId: connectionId || null,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.loginUrl) {
        setError(payload?.error || `Unable to start ${label} pairing.`);
        return;
      }
      setPairing(payload.data);
      setStatus("pending");
      popupRef.current = window.open(payload.data.loginUrl, "newapi_pair", "width=600,height=760");
      if (!popupRef.current) setPopupBlocked(true);
    } catch {
      setError(`Unable to start ${label} pairing.`);
    } finally {
      setStarting(false);
    }
  };

  const manualRequest = async (action) => {
    setManualLoading(true);
    setError("");
    try {
      const response = await fetch("/api/new-api/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, managementToken, userId, tokenId, name, action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || `Unable to connect the ${label} account.`);
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
    } catch {
      setError(`Unable to connect the ${label} account.`);
    } finally {
      setManualLoading(false);
    }
  };

  const waiting = !!pairing && !!status && !TERMINAL_STATES.has(status);
  const canRetry = !waiting && !starting;

  return (
    <Modal isOpen={isOpen} title={`Connect ${label}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-text-muted">
          <p className="font-medium text-text-main">New API Bridge</p>
          <p className="mt-1">
            Click Connect, then complete the normal login on{" "}
            {origin ? (
              <a href={origin} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                {origin.replace(/^https:\/\//, "")}
              </a>
            ) : label}
            . The 9Router New API Bridge extension finishes the setup — no tokens to copy,
            and an API token is selected or created for you.
          </p>
          {expectedUserId && (
            <p className="mt-1">Reconnecting account {expectedUserId}. Log in with that account.</p>
          )}
        </div>

        {status && (
          <div className="flex items-center gap-2">
            <Badge variant={status === "success" ? "success" : TERMINAL_STATES.has(status) ? "error" : "default"}>
              {status.replace(/_/g, " ")}
            </Badge>
            <span className="text-xs text-text-muted">{statusText[status]}</span>
          </div>
        )}

        <Button onClick={startPairing} disabled={starting || waiting} fullWidth icon="login">
          {starting ? "Starting…" : waiting ? `Waiting for ${label}…` : `Connect ${label}`}
        </Button>

        {popupBlocked && pairing?.loginUrl && (
          <a
            href={pairing.loginUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary underline"
          >
            Popup was blocked. Open {label} manually.
          </a>
        )}

        {status === "expired" && canRetry && (
          <p className="text-xs text-text-muted">The pairing timed out. Click Connect to start a new one.</p>
        )}

        {/* A remotely-served 9Router needs the bridge to post back to this origin
            rather than localhost. Name it, so a silent 5-minute wait is diagnosable. */}
        {waiting && pairing?.routerOrigin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(pairing.routerOrigin) && (
          <p className="text-xs text-text-muted">
            The extension must post back to <code>{pairing.routerOrigin}</code>. If nothing happens,
            use Advanced below.
          </p>
        )}

        <button
          type="button"
          onClick={() => setShowManual((current) => !current)}
          className="self-start text-xs text-text-muted underline hover:text-primary"
        >
          {showManual ? "Hide advanced setup" : "Advanced: enter credentials manually"}
        </button>

        {showManual && (
          <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
            <p className="text-xs text-text-muted">
              Fallback for recovery when the extension is unavailable. Paste your account id and the
              token from <code>/api/user/token</code>; both stay server-side after submission.
            </p>
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
                variant="secondary"
                onClick={() => manualRequest("inspect")}
                disabled={manualLoading || !managementToken.trim() || !userId.trim()}
                fullWidth
              >
                {manualLoading ? "Validating…" : "Validate and Load Tokens"}
              </Button>
            ) : (
              <>
                <div className="rounded-lg bg-sidebar/50 p-3 text-sm">
                  <p className="font-medium">
                    {account.displayName || account.username || `${label} ${account.id}`}
                  </p>
                  <p className="text-xs text-text-muted">Group: {account.group || "default"}</p>
                </div>
                {/* Reconnect keeps the stored name, so only offer this when creating. */}
                {!expectedUserId && (
                  <Input label="Connection Name" value={name} onChange={(event) => setName(event.target.value)} />
                )}
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">API Token</p>
                  {tokens.length === 0 ? (
                    <p className="text-xs text-text-muted">
                      No existing tokens. Connect anyway — one dedicated to 9Router will be created.
                    </p>
                  ) : tokens.map((token) => (
                    <label
                      key={token.id}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/10 p-2 dark:border-white/10"
                    >
                      <input
                        type="radio"
                        name={`${providerId}-token`}
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
                <Button
                  variant="secondary"
                  onClick={() => manualRequest("connect")}
                  disabled={manualLoading}
                  fullWidth
                >
                  {manualLoading ? "Connecting…" : tokenId ? "Use Selected Token" : "Connect (auto token)"}
                </Button>
              </>
            )}
          </div>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}
        <Button variant="ghost" onClick={onClose} fullWidth disabled={starting}>Cancel</Button>
      </div>
    </Modal>
  );
}

NewApiAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerId: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  origin: PropTypes.string,
  expectedUserId: PropTypes.string,
  connectionId: PropTypes.string,
  onSuccess: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
