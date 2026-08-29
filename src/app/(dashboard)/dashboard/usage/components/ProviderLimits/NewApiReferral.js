"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useNotificationStore } from "@/store/notificationStore";

function formatAmount(amount) {
  if (!amount || !Number.isFinite(Number(amount.value)) || !amount.unit) return "Unavailable";
  return `${Number(amount.value).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${amount.unit}`;
}

export default function NewApiReferral({ connection, onQuotaRefresh, footer = false, onReferralCodeChange = null }) {
  const notify = useNotificationStore();
  const [state, setState] = useState({ status: "loading" });
  const transferInFlight = useRef(false);

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

  // The copy action lives in the card header, so publish the code upward
  // instead of rendering a second control inside this section.
  useEffect(() => {
    if (!onReferralCodeChange) return;
    onReferralCodeChange(state.status === "ready" ? state.affCode || "" : "");
  }, [onReferralCodeChange, state.affCode, state.status]);

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
      ? <div className="border-t border-black/10 px-3 py-2 text-[10px] text-text-muted dark:border-white/10">Referral rewards · loading…</div>
      : <p className="mt-2 text-[11px] text-text-muted">Referral Rewards: loading…</p>;
  }
  if (state.status === "error") {
    return footer ? (
      <div className="flex items-center justify-between gap-2 border-t border-black/10 px-3 py-2 text-[10px] dark:border-white/10">
        <span className="truncate text-red-500">Referral rewards unavailable</span>
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
      <div className="border-t border-black/10 px-3 py-2 dark:border-white/10">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="text-[11px] font-medium text-text-primary">Referral rewards</span>
          <span className="text-[10px] text-text-muted">No rewards yet</span>
        </div>
      </div>
    );
  }

  if (footer) {
    return (
      <div className="border-t border-black/10 px-3 py-2 dark:border-white/10">
        <p className="text-[11px] font-medium text-text-primary">Referral rewards</p>
        <div className="mt-1.5 grid grid-cols-3 gap-2 text-[10px]">
          <div><p className="text-text-muted">Pending</p><p className="font-medium tabular-nums text-text-primary">{formatAmount(state.pending)}</p></div>
          <div><p className="text-text-muted">Earned</p><p className="font-medium tabular-nums text-text-primary">{formatAmount(state.totalEarned)}</p></div>
          <div><p className="text-text-muted">Invites</p><p className="font-medium tabular-nums text-text-primary">{state.invites ?? 0}</p></div>
        </div>
        <div className="mt-1.5 flex justify-end">
          <button type="button" onClick={transferAll} disabled={state.transferring} className="flex h-7 shrink-0 items-center rounded-md border border-primary/30 bg-primary/5 px-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:opacity-50">
            {state.transferring ? "Transferring…" : "Transfer All →"}
          </button>
        </div>
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
  onReferralCodeChange: PropTypes.func,
};
