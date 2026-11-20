"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseXingchiCsv } from "@/shared/utils/xingchiCsv.js";

const PENDING_PROTOCOL = "xingchi-pair-v1";

export default function XingchiHybridManager() {
  const [accounts, setAccounts] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [csvText, setCsvText] = useState("");
  const [pending, setPending] = useState(null);
  const polling = useRef(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/xingchi/accounts", { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load Xingchi accounts.");
    const payload = await response.json();
    setAccounts(payload.accounts || []);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => { void refresh().catch((error) => setMessage(error.message)); }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, refresh]);
  useEffect(() => () => { if (polling.current) clearInterval(polling.current); }, []);

  const doRequest = async (path, method, body) => {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Request failed.");
    return result;
  };

  const importCsv = async () => {
    setBusy("import"); setMessage("");
    try {
      const entries = parseXingchiCsv(csvText);
      if (!entries.length) throw new Error("CSV has no accounts. Expected email,api_key,key_name columns.");
      const result = await doRequest("/api/xingchi/accounts", "POST", { accounts: entries });
      await refresh();
      setMessage(`Imported ${result.accounts.length} accounts (${result.accounts.filter((a) => a.keyImported).length} new API keys).${result.errors.length ? ` ${result.errors.length} key(s) skipped due to existing names.` : ""}`);
      setCsvText("");
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const beginPair = async (account) => {
    setMessage(""); setBusy(account.id);
    // Open immediately during the click gesture, avoiding popup blockers.
    const tab = window.open("https://xingchiapi.com/", "_blank");
    try {
      const { pairing } = await doRequest("/api/xingchi/pair/start", "POST", { accountId: account.id });
      setPending(pairing);
      let acknowledged = false;
      const onAck = (event) => {
        if (event.source === window && event.origin === window.location.origin
          && event.data?.source === "9router-xingchi-extension" && event.data?.protocol === PENDING_PROTOCOL
          && event.data?.pairingId === pairing.pairingId) {
          acknowledged = event.data.type === "PAIR_ACCEPTED";
        }
      };
      window.addEventListener("message", onAck);
      window.postMessage({ source: "9router-xingchi", protocol: PENDING_PROTOCOL, type: "PAIR_SESSION",
        pairingId: pairing.pairingId, pairingSecret: pairing.pairingSecret, routerOrigin: pairing.routerOrigin,
        providerOrigin: pairing.providerOrigin, accountEmail: pairing.accountEmail, expiresAt: pairing.expiresAt }, window.location.origin);
      if (!tab) setMessage("Popup blocked. Open xingchiapi.com in another tab, then click the extension icon.");
      else setMessage(`Sign in to ${pairing.accountEmail} on Xingchi, then click the extension icon → Pair session.`);
      setTimeout(() => {
        window.removeEventListener("message", onAck);
        if (!acknowledged) setMessage("9Router Bridge was not detected on this dashboard tab. Install/update the extension and refresh 9Router before pairing.");
      }, 2000);
      if (polling.current) clearInterval(polling.current);
      polling.current = setInterval(async () => {
        try {
          const response = await fetch(`/api/xingchi/pair/status?id=${encodeURIComponent(pairing.pairingId)}`, { cache: "no-store" });
          const data = await response.json();
          if (["success", "expired", "error"].includes(data.status)) {
            clearInterval(polling.current); polling.current = null;
            setPending(null);
            if (data.status === "success") { setMessage(`${pairing.accountEmail} paired successfully.`); await refresh(); }
            else setMessage(`Pairing ${data.status}. Retry to generate a new session.`);
          }
        } catch { /* retry until the pairing expires */ }
      }, 1500);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  const modify = async (account, action) => {
    setBusy(account.id); setMessage("");
    try {
      if (action === "checkin") {
        const result = await doRequest(`/api/xingchi/accounts/${account.id}/checkin`, "POST");
        setMessage(`${account.email}: ${result.result.status === "already_claimed" ? "Already checked in today" : "Check-in successful"}.`);
      } else if (action === "toggle") {
        await doRequest(`/api/xingchi/accounts/${account.id}`, "PATCH", { autoCheckin: !account.autoCheckin });
      } else if (action === "delete") {
        if (!window.confirm(`Remove paired session and account ${account.email}? API keys in Connections will remain.`)) return;
        await doRequest(`/api/xingchi/accounts/${account.id}`, "DELETE");
      }
      await refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(""); }
  };

  return (
    <div className="rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text-primary">Xingchi Daily Check-in · Hybrid Bridge</p>
          <p className="mt-0.5 text-[11px] text-text-muted">Pair each login once in Chrome; 9Router can check in without separate browser profiles.</p>
        </div>
        <button type="button" className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-primary" onClick={() => setIsOpen(!isOpen)}>{isOpen ? "Hide" : "Manage"}</button>
      </div>
      {isOpen && (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-black/10 p-3 dark:border-white/10">
            <label htmlFor="xingchi-csv" className="block text-xs font-semibold">Import CSV (email → name → API key)</label>
            <p className="mt-1 text-[11px] text-text-muted">CSV from the Xingchi onboarding extension: email,password,api_key,group_id,key_name,… Passwords are ignored and never stored in 9Router.</p>
            <input aria-label="Choose Xingchi CSV" type="file" accept=".csv,text/csv" className="mt-2 block w-full text-xs text-text-muted"
              onChange={async (event) => { const file = event.target.files?.[0]; if (file) { if (file.size > 200000) setMessage("CSV file is too large (200 KB max)."); else setCsvText(await file.text()); } }} />
            <textarea id="xingchi-csv" value={csvText} onChange={(event) => setCsvText(event.target.value)} rows={3}
              placeholder={'email,name,api_key\nuser@example.com,Team Account,sk-...'}
              className="mt-2 w-full rounded-lg border border-black/10 bg-transparent p-2 text-xs text-text-primary dark:border-white/10" />
            <button type="button" disabled={!csvText.trim() || !!busy} onClick={importCsv}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Import accounts + keys</button>
          </div>
          {accounts.length === 0 && <p className="text-xs text-text-muted">No Xingchi accounts imported yet.</p>}
          {accounts.map((account) => (
            <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/10 p-2.5 text-xs dark:border-white/10">
              <div className="min-w-0">
                <div className="font-semibold text-text-primary">{account.name || account.email}</div>
                <div className="text-text-muted">{account.email} · {account.paired ? "Paired" : "Not paired"}{account.lastClaimDate ? ` · Last: ${account.lastClaimDate}` : ""}</div>
                {account.lastError && <div className="max-w-[350px] truncate text-red-500" title={account.lastError}>{account.lastError}</div>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" disabled={!!busy} onClick={() => beginPair(account)} className="rounded-md border border-primary/30 px-2 py-1 text-primary disabled:opacity-50">{account.paired ? "Re-pair" : "Pair in Chrome"}</button>
                <button type="button" disabled={!!busy || !account.paired} onClick={() => modify(account, "checkin")} className="rounded-md border border-border-subtle px-2 py-1 disabled:opacity-50">Check in</button>
                <label className="flex items-center gap-1 text-text-muted" title="Auto check-in every 15 minutes when eligible; OFF by default. Requires a refresh token."><input type="checkbox" checked={account.autoCheckin === true} disabled={!!busy || !account.paired || !account.renewable} onChange={() => modify(account, "toggle")} /> Auto</label>
                <button type="button" disabled={!!busy} onClick={() => modify(account, "delete")} className="text-red-500 disabled:opacity-50">Remove</button>
              </div>
            </div>
          ))}
          {pending && <p className="text-xs text-amber-600">Pairing active until {new Date(pending.expiresAt).toLocaleTimeString()}. Finish inside the bridge popup on Xingchi.</p>}
          {message && <p role="status" className="text-xs text-text-primary">{message}</p>}
        </div>
      )}
    </div>
  );
}
