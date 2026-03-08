"use client";

import { useState, useEffect } from "react";
import { RefreshCw, Loader2, CheckCircle, AlertCircle } from "lucide-react";

export default function SyncButton() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sync")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setConfigured(data.configured);
      })
      .catch(() => setConfigured(false));
  }, []);

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      setResult({ imported: data.imported ?? 0, skipped: data.skipped ?? 0 });
      if (data.imported > 0) {
        setTimeout(() => window.location.reload(), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  // Still loading
  if (configured === null) return null;

  // Not configured
  if (!configured) return null;

  // Error state
  if (error) {
    return (
      <button
        onClick={() => setError(null)}
        className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-red-600/20 text-red-300 rounded-xl border border-red-500/30"
        title={error}
      >
        <AlertCircle size={15} />
        Retry
      </button>
    );
  }

  // Success state
  if (result) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-emerald-600/20 text-emerald-300 rounded-xl border border-emerald-500/30">
        <CheckCircle size={15} />
        {result.imported > 0 ? `+${result.imported} new` : "Up to date"}
      </div>
    );
  }

  // Ready to sync
  return (
    <button
      onClick={handleSync}
      disabled={syncing}
      className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 text-zinc-300 rounded-xl transition-colors border border-zinc-700"
    >
      {syncing ? (
        <>
          <Loader2 size={15} className="animate-spin" />
          Syncing...
        </>
      ) : (
        <>
          <RefreshCw size={15} />
          Sync X
        </>
      )}
    </button>
  );
}
