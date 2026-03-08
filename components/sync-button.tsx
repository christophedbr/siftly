"use client";

import { useState, useEffect } from "react";
import { RefreshCw, Link2, Loader2, CheckCircle } from "lucide-react";

interface LiveConfig {
  hasCredentials: boolean;
  syncInterval: string;
  lastSync: string | null;
  schedulerRunning: boolean;
}

export default function SyncButton() {
  const [config, setConfig] = useState<LiveConfig | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
  } | null>(null);

  useEffect(() => {
    fetch("/api/import/live")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setConfig(data);
      })
      .catch(() => {});
  }, []);

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    try {
      const res = await fetch("/api/import/live/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      setResult({ imported: data.imported ?? 0, skipped: data.skipped ?? 0 });
      if (data.imported > 0) {
        // Refresh the page after a short delay to show updated stats
        setTimeout(() => window.location.reload(), 2000);
      }
    } catch {
      setResult(null);
    } finally {
      setSyncing(false);
    }
  }

  // Still loading config
  if (config === null) return null;

  // No credentials — show "Connect X" linking to import page
  if (!config.hasCredentials) {
    return (
      <a
        href="/import"
        className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl transition-colors border border-zinc-700"
      >
        <Link2 size={15} />
        Connect X
      </a>
    );
  }

  // Show result briefly
  if (result && result.imported > 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-emerald-600/20 text-emerald-300 rounded-xl border border-emerald-500/30">
        <CheckCircle size={15} />+{result.imported} new
      </div>
    );
  }

  // Credentials saved — show sync button
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
