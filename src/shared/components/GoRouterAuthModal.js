"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";

const POLL_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set(["success", "needs_token_creation", "error", "expired"]);

const STATUS_TEXT = {
  pending: "Waiting for GoRouter authentication…",
  processing: "Completing GoRouter connection…",
  success: "GoRouter account connected.",
  needs_token_creation: "No usable GoRouter API token found. Create one in GoRouter, then connect again.",
  error: "GoRouter pairing failed. Try again.",
  expired: "Pairing expired. Start again.",
};

const ERROR_TEXT = {
  wrong_account: "A different GoRouter account is logged in. Log out on gorouter.app, then retry.",
  management_auth_failed: "GoRouter authentication failed.",
  needs_token_creation: STATUS_TEXT.needs_token_creation,
  connect_failed: "Connection could not be saved.",
};

/**
 * GoRouter onboarding.
 *
 * Primary flow is the Chrome bridge: 9Router mints a short-lived single-use
 * pairing, opens GoRouter login with the secret in the URL fragment, and polls a
 * non-secret status route. The extension does the credential capture inside the
 * GoRouter origin, so no token is pasted here and none is exposed to this page.
 *
 * The manual management-token form remains as an advanced fallback for recovery.
 */
export default function GoRouterAuthModal({ isOpen, expectedUserId, onSuccess, onClose }) {
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

  // Re-seed from the open/target pair without an effect (React's recommended
  // pattern), so a reopened modal never shows the previous pairing's state.
  const sessionKey = `${isOpen}:${expectedUserId || ""}`;
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
    setUserId("");
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
          `/api/providers/gorouter/pair/status?id=${encodeURIComponent(pairing.pairingId)}`,
          { cache: "no-store" },
        );
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        const next = payload?.data?.status;
        if (next) {
          setStatus(next);
          if (payload.data.errorCode) setError(ERROR_TEXT[payload.data.errorCode] || "");
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
  }, [isOpen, pairing, status, onSuccess]);

  const startPairing = async () => {
    setStarting(true);
    setError("");
    setPopupBlocked(false);
    try {
      const response = await fetch("/api/providers/gorouter/pair/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedUserId: expectedUserId || null }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.loginUrl) {
        setError(payload?.error || "Unable to start GoRouter pairing.");
        return;
      }
      setPairing(payload.data);
      setStatus("pending");
      popupRef.current = window.open(payload.data.loginUrl, "gorouter_pair", "width=600,height=760");
      if (!popupRef.current) setPopupBlocked(true);
    } catch {
      setError("Unable to start GoRouter pairing.");
    } finally {
      setStarting(false);
    }
  };

  const manualRequest = async (action) => {
    setManualLoading(true);
    setError("");
    try {
      const response = await fetch("/api/providers/gorouter/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ managementToken, userId, tokenId, name, action }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || "Unable to connect GoRouter account.");
        return;
      }
      if (action === "connect") {
        onSuccess();
        return;
      }
      setAccount(data.account || null);
      setTokens(data.tokens || []);
      const usable = (data.tokens || []).find((token) => token.status === 1);
      setTokenId(usable ? String(usable.id) : "");
      setName((current) => current || data.account?.displayName || "GoRouter");
      if (data.state === "needs_token_creation") setError(STATUS_TEXT.needs_token_creation);
    } catch {
      setError("Unable to connect GoRouter account.");
    } finally {
      setManualLoading(false);
    }
  };

  const waiting = !!pairing && !!status && !TERMINAL_STATES.has(status);
  const canRetry = !waiting && !starting;

  return (
    <Modal isOpen={isOpen} title="Connect GoRouter" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-text-muted">
          <p className="font-medium text-text-main">GoRouter Bridge</p>
          <p className="mt-1">
            Click Connect, then complete the normal GitHub login on gorouter.app. The
            9Router GoRouter Bridge Chrome extension finishes the setup — no tokens to copy.
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
            <span className="text-xs text-text-muted">{STATUS_TEXT[status]}</span>
          </div>
        )}

        <Button onClick={startPairing} disabled={starting || waiting} fullWidth icon="login">
          {starting ? "Starting…" : waiting ? "Waiting for GoRouter…" : "Connect GoRouter"}
        </Button>

        {popupBlocked && pairing?.loginUrl && (
          <a
            href={pairing.loginUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary underline"
          >
            Popup was blocked. Open GoRouter manually.
          </a>
        )}

        {status === "expired" && canRetry && (
          <p className="text-xs text-text-muted">The pairing timed out. Click Connect GoRouter to start a new one.</p>
        )}

        {!waiting && (
          <button
            type="button"
            onClick={() => setShowManual((current) => !current)}
            className="self-start text-xs text-text-muted underline hover:text-primary"
          >
            {showManual ? "Hide advanced setup" : "Advanced: enter credentials manually"}
          </button>
        )}

        {showManual && (
          <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
            <p className="text-xs text-text-muted">
              Fallback for recovery when the extension is unavailable. Credentials stay server-side after submission.
            </p>
            <Input
              label="GoRouter User ID"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="Numeric user ID"
              disabled={!!account}
            />
            <Input
              label="Management Token"
              type="password"
              value={managementToken}
              onChange={(event) => setManagementToken(event.target.value)}
              placeholder="GoRouter user access token"
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
                  <p className="font-medium">{account.displayName || `GoRouter ${account.id}`}</p>
                  <p className="text-xs text-text-muted">Group: {account.group || "default"}</p>
                </div>
                <Input label="Connection Name" value={name} onChange={(event) => setName(event.target.value)} />
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Existing API Token</p>
                  {tokens.length === 0 ? (
                    <p className="text-xs text-text-muted">
                      No existing tokens found. Create one in GoRouter, then validate again.
                    </p>
                  ) : tokens.map((token) => (
                    <label
                      key={token.id}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/10 p-2 dark:border-white/10"
                    >
                      <input
                        type="radio"
                        name="gorouter-token"
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
                  disabled={manualLoading || !tokenId}
                  fullWidth
                >
                  {manualLoading ? "Connecting…" : "Use Selected Token"}
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

GoRouterAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  expectedUserId: PropTypes.string,
  onSuccess: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
