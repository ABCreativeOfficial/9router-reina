"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useNotificationStore } from "@/store/notificationStore";

const POLL_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set(["success", "error", "expired"]);

function formatReward(reward) {
  if (!reward || !Number.isFinite(Number(reward.value))) return "";
  return `${Number(reward.value).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${reward.unit}`;
}

export default function NewApiCheckin({ connection, onQuotaRefresh }) {
  const notify = useNotificationStore();
  const [state, setState] = useState({ status: "loading" });
  const [session, setSession] = useState(null);
  const popupRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/usage/${connection.id}/newapi-checkin`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to read check-in status.");
      const data = payload.data || {};
      setState({
        ...data,
        status: !data.supported ? "unsupported"
          : !data.enabled ? "disabled"
            : data.checkedInToday ? "checked_in"
              : "available",
      });
    } catch (error) {
      setState({ status: "error", error: error.message });
    }
  }, [connection.id]);

  useEffect(() => {
    const timer = setTimeout(fetchStatus, 0);
    return () => clearTimeout(timer);
  }, [fetchStatus]);

  useEffect(() => {
    if (!session?.checkinId || TERMINAL_STATES.has(state.status)) return;
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        const response = await fetch(`/api/new-api/checkin/status?id=${encodeURIComponent(session.checkinId)}`, {
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({}));
        const next = payload?.data?.status;
        if (!cancelled && next) {
          if (next === "success") {
            try { popupRef.current?.close(); } catch { /* popup may be gone */ }
            await Promise.all([onQuotaRefresh(), fetchStatus()]);
            notify.success("Provider confirmed today's check-in.", "Check-in successful");
            return;
          }
          if (next === "error" || next === "expired") {
            setState({ status: next, error: next === "expired" ? "Verification expired. Retry check-in." : "Verification failed. Retry check-in." });
            return;
          }
        }
      } catch {
        // Temporary polling failures do not invalidate the server-side session.
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchStatus, notify, onQuotaRefresh, session, state.status]);

  const checkin = async () => {
    setState((current) => ({ ...current, status: "loading" }));
    try {
      const response = await fetch(`/api/usage/${connection.id}/newapi-checkin`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Check-in failed.");
      const result = payload.data || {};
      if (result.status === "verification_required") {
        const verification = result.verification;
        if (verification?.protocol !== "newapi-checkin-v2") {
          throw new Error("Unsupported check-in protocol.");
        }
        setSession(verification);
        setState((current) => ({ ...current, status: "verification_required" }));
        window.postMessage({
          source: "9router-newapi-checkin",
          protocol: verification.protocol,
          type: "CHECKIN_SESSION",
          checkinId: verification.checkinId,
          checkinSecret: verification.checkinSecret,
          providerOrigin: verification.providerOrigin,
          routerOrigin: verification.routerOrigin,
          expiresAt: verification.expiresAt,
        }, window.location.origin);
        popupRef.current = window.open(verification.launchUrl, "newapi_checkin", "width=600,height=760");
        if (!popupRef.current) notify.warning("Popup blocked. Allow popups, then retry.", "Verification required");
        return;
      }

      setState((current) => ({ ...current, status: "checked_in", checkedInToday: true }));
      await onQuotaRefresh();
      if (result.status === "success") {
        const reward = formatReward(result.quotaAwarded);
        notify.success(reward ? `Reward added: ${reward}` : "Reward added.", "Check-in successful");
      }
    } catch (error) {
      setState({ status: "error", error: error.message });
      notify.error(error.message, "Check-in failed");
    }
  };

  if (["unsupported", "disabled"].includes(state.status)) return null;
  if (state.status === "loading") return <p className="mt-2 text-[11px] text-text-muted">Daily Check-in: loading…</p>;
  if (state.status === "checked_in") {
    const today = state.records?.find((record) => record.checkinDate === new Date().toISOString().slice(0, 10));
    return (
      <p className="mt-2 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        ✓ Checked in today{today?.reward ? ` · ${formatReward(today.reward)}` : ""}
      </p>
    );
  }
  if (state.status === "verification_required") {
    return <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">Verification required…</p>;
  }
  if (["error", "expired"].includes(state.status)) {
    return (
      <button type="button" onClick={checkin} className="mt-2 text-[11px] text-red-500 underline">
        {state.error || "Check-in unavailable."} Retry
      </button>
    );
  }

  const reward = state.minReward && state.maxReward
    ? `${formatReward(state.minReward)} – ${formatReward(state.maxReward)}`
    : "";
  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-text-primary">Daily Check-in</p>
        {reward && <p className="truncate text-[10px] text-text-muted">Reward: {reward}</p>}
      </div>
      <button type="button" onClick={checkin} className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-white">
        Check in
      </button>
    </div>
  );
}

NewApiCheckin.propTypes = {
  connection: PropTypes.object.isRequired,
  onQuotaRefresh: PropTypes.func.isRequired,
};
