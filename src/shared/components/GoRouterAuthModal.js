"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";

const LOGIN_URL = "https://gorouter.app/login";

export default function GoRouterAuthModal({ isOpen, onSuccess, onClose }) {
  const [managementToken, setManagementToken] = useState("");
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [account, setAccount] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [tokenId, setTokenId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setManagementToken("");
    setUserId("");
    setName("");
    setAccount(null);
    setTokens([]);
    setTokenId("");
    setError("");
  };

  const close = () => {
    reset();
    onClose();
  };

  const request = async (action) => {
    setLoading(true);
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
        reset();
        onSuccess();
        return;
      }
      setAccount(data.account || null);
      setTokens(data.tokens || []);
      const usable = (data.tokens || []).find((token) => token.status === 1);
      setTokenId(usable ? String(usable.id) : "");
      setName((current) => current || data.account?.displayName || "GoRouter");
    } catch {
      setError("Unable to connect GoRouter account.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect GoRouter" onClose={close}>
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-text-muted">
          <p>GoRouter owns the GitHub OAuth callback, so 9Router cannot receive it directly.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li><a href={LOGIN_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline">Log in to GoRouter with GitHub</a>.</li>
            <li>Obtain your GoRouter user access token and user ID.</li>
            <li>Paste them below. They stay server-side after submission.</li>
          </ol>
        </div>

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
            onClick={() => request("inspect")}
            disabled={loading || !managementToken.trim() || !userId.trim()}
            fullWidth
          >
            {loading ? "Validating..." : "Validate and Load Tokens"}
          </Button>
        ) : (
          <>
            <div className="rounded-lg bg-sidebar/50 p-3 text-sm">
              <p className="font-medium">{account.displayName || `GoRouter ${account.id}`}</p>
              <p className="text-xs text-text-muted">Group: {account.group || "default"}</p>
            </div>
            <Input
              label="Connection Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Existing API Token</p>
              {tokens.length === 0 ? (
                <p className="text-xs text-text-muted">No existing tokens found. Create one in GoRouter, then validate again.</p>
              ) : tokens.map((token) => (
                <label key={token.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/10 p-2 dark:border-white/10">
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
                    <span className="block truncate font-mono text-xs text-text-muted">{token.maskedKey || "masked"}</span>
                  </span>
                  {token.status === 1 ? <Badge variant="success">active</Badge> : <Badge variant="error">inactive</Badge>}
                </label>
              ))}
            </div>
            <Button
              onClick={() => request("connect")}
              disabled={loading || !tokenId}
              fullWidth
            >
              {loading ? "Connecting..." : "Use Selected Token"}
            </Button>
          </>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}
        <Button variant="ghost" onClick={close} fullWidth disabled={loading}>Cancel</Button>
      </div>
    </Modal>
  );
}

GoRouterAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
