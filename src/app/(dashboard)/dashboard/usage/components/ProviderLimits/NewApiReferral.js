"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useNotificationStore } from "@/store/notificationStore";

function formatAmount(amount) {
  if (!amount || !Number.isFinite(Number(amount.value)) || !amount.unit) return "Unavailable";
  return `${Number(amount.value).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${amount.unit}`;
}

export default function NewApiReferral({ connection, onQuotaRefresh, footer = false }) {
  const notify = useNotificationStore();
  const [state, setState] = useState({ status: "loading" });
  const [copyState, setCopyState] = useState("idle");
  const transferInFlight = useRef(false);
  const copyResetTimer = useRef(null);

  const fetchReferral = useCallback(async () => {
    try {
      const response = await fetch(`/api/usage/${connection.id}/newapi-referral`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to read referral rewards.");
      const referral = payload.data || {};
      const next = referral.supported ? { status: "ready", ...referral } : { status: "unsupported" };
      setState(next);
      return next;
    } catch (error) {
      const next = { status: "error", error: error.message };
      setState(next);
      return next;
    }
  }, [connection.id]);

  useEffect(() => {
    const timer = setTimeout(fetchReferral, 0);
    return () => clearTimeout(timer);
  }, [fetchReferral]);

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  const copyReferralCode = async () => {
    if (!state.affCode) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(state.affCode);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = state.affCode;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copied) throw new Error("Copy failed");
      }
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopyState("idle"), 1800);
  };

  const referralCode = state.affCode ? (
    <button
      type="button"
      onClick={copyReferralCode}
      aria-label="Copy referral code"
      className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 dark:hover:bg-white/5"
    >
      <span className="max-w-32 truncate">{copyState === "copied" ? "Copied" : state.affCode}</span>
      <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
        {copyState === "copied" ? "check" : copyState === "failed" ? "error" : "content_copy"}
      </span>
    </button>
  ) : null;

  const transferAll = async () => {
    if (transferInFlight.current) return;
    transferInFlight.current = true;
    setState((current) => ({ ...current, transferring: true }));
    try {
      const response = await fetch(`/api/usage/${connection.id}/newapi-referral`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Referral transfer failed.");
      const result = payload.data || {};
      if (result.referral?.supported) setState({ status: "ready", ...result.referral, transferring: false });
      else await fetchReferral();

      if (result.transferred) {
        await onQuotaRefresh();
        const amount = formatAmount(result.transferredAmount);
        notify.success(
          amount === "Unavailable" ? "Referral rewards transferred to balance." : `Transferred ${amount} to balance.`,
          "Referral transfer complete",
        );
      }
    } catch (error) {
      setState((current) => ({ ...current, transferring: false, error: error.message }));
      notify.error(error.message, "Referral transfer failed");
    } finally {
      transferInFlight.current = false;
    }
  };

  if (state.status === "unsupported") return null;
  if (state.status === "loading") {
    return footer
      ? <div className="border-t border-black/10 px-3 py-3 text-[11px] text-text-muted dark:border-white/10">Referral · loading…</div>
      : <p className="mt-2 text-[11px] text-text-muted">Referral Rewards: loading…</p>;
  }
  if (state.status === "error") {
    return footer ? (
      <div className="flex items-center justify-between gap-3 border-t border-black/10 px-3 py-3 text-[11px] dark:border-white/10">
        <span className="truncate text-red-500">Referral unavailable</span>
        <button type="button" onClick={fetchReferral} className="shrink-0 font-medium text-primary underline">Retry</button>
      </div>
    ) : (
      <button type="button" onClick={fetchReferral} className="mt-2 text-[11px] text-red-500 underline">
        {state.error} Retry
      </button>
    );
  }

  if (footer && !state.canTransfer) {
    return (
      <div className="border-t border-black/10 px-3 py-4 dark:border-white/10">
        <p className="text-[11px] font-medium text-text-primary">Referral rewards</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-text-muted">No rewards yet</span>
          {referralCode}
        </div>
        {copyState === "failed" && <p className="mt-1 text-[10px] text-red-500">Copy failed. Try again.</p>}
      </div>
    );
  }

  if (footer) {
    return (
      <div className="border-t border-black/10 px-3 py-4 dark:border-white/10">
        <p className="text-[11px] font-medium text-text-primary">Referral rewards</p>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[10px] sm:grid-cols-3">
          <div><p className="text-text-muted">Pending</p><p className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">{formatAmount(state.pending)}</p></div>
          <div><p className="text-text-muted">Earned</p><p className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">{formatAmount(state.totalEarned)}</p></div>
          <div><p className="text-text-muted">Invites</p><p className="mt-0.5 text-sm font-semibold tabular-nums text-text-primary">{state.invites ?? 0}</p></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {referralCode || <span />}
          <button type="button" onClick={transferAll} disabled={state.transferring} className="min-h-8 rounded-md border border-primary/25 bg-primary/5 px-3 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:opacity-50">
            {state.transferring ? "Transferring…" : "Transfer All →"}
          </button>
        </div>
        {copyState === "failed" && <p className="mt-1 text-[10px] text-red-500">Copy failed. Try again.</p>}
        {state.error && <p className="mt-1 text-[10px] text-red-500">{state.error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-black/10 bg-black/[0.02] p-2.5 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-text-primary">Referral Rewards</p>
        {state.affCode && <span className="text-[10px] text-text-muted">Code: {state.affCode}</span>}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
        <div><p className="text-text-muted">Pending</p><p className="font-medium text-text-primary">{formatAmount(state.pending)}</p></div>
        <div><p className="text-text-muted">Total Earned</p><p className="font-medium text-text-primary">{formatAmount(state.totalEarned)}</p></div>
        <div><p className="text-text-muted">Invites</p><p className="font-medium text-text-primary">{state.invites ?? 0}</p></div>
      </div>
      <button type="button" onClick={transferAll} disabled={!state.canTransfer || state.transferring} className="mt-2 w-full rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50">
        {state.transferring ? "Transferring…" : state.canTransfer ? "Transfer All to Balance" : "Nothing to transfer"}
      </button>
      {state.error && <p className="mt-1 text-[10px] text-red-500">{state.error}</p>}
    </div>
  );
}

NewApiReferral.propTypes = {
  connection: PropTypes.object.isRequired,
  onQuotaRefresh: PropTypes.func.isRequired,
  footer: PropTypes.bool,
};
