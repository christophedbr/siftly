/**
 * Triggers the categorization pipeline after bookmark imports.
 *
 * Uses an internal fetch to POST /api/categorize so it goes through
 * the same after() + progress tracking as manual triggers.
 * Debounces rapid-fire imports (e.g. bookmarklet sending multiple batches).
 */

let _pendingTrigger: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 3000; // wait 3s after last import before triggering

/**
 * Schedule a categorization pipeline run. Debounced so multiple rapid
 * imports (bookmarklet, bulk file) only trigger one pipeline run.
 */
export function triggerCategorizePipeline(): void {
  if (_pendingTrigger) clearTimeout(_pendingTrigger);

  _pendingTrigger = setTimeout(async () => {
    _pendingTrigger = null;
    try {
      // Use internal fetch to trigger the pipeline endpoint
      const baseUrl =
        process.env.NEXT_PUBLIC_BASE_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
        "http://localhost:3000";

      const res = await fetch(`${baseUrl}/api/categorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (res.ok) {
        console.log("[auto-pipeline] Categorization triggered after import");
      } else {
        const data = await res.json().catch(() => ({}));
        // 409 = already running, that's fine
        if (res.status !== 409) {
          console.warn("[auto-pipeline] Failed to trigger:", data);
        }
      }
    } catch (err) {
      console.error(
        "[auto-pipeline] Error triggering categorization:",
        err instanceof Error ? err.message : err,
      );
    }
  }, DEBOUNCE_MS);
}
