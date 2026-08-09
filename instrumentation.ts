export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Pi Hub scheduler bootstrap. Idempotent (guarded by globalThis) and wrapped
  // so a migration/DB failure keeps the web server running with a reported
  // scheduler error state (design doc §9.3). Must not block the request path.
  //
  // A Telegram-aware notifier is injected so task success/failure events flow
  // into the Telegram notification outbox (§18.1). The notifier lazily
  // resolves the live Telegram store, so it works whether Telegram starts
  // before or after the scheduler — and stays a no-op when Telegram is off.
  await import("@/modules/scheduler")
    .then(async (m) => {
      const { TelegramTaskNotifier, getTelegramRuntime } = await import("@/modules/telegram");
      const notifier = new TelegramTaskNotifier({
        resolveStore: () => getTelegramRuntime()?.getStore() ?? null,
        resolvePublicUrl: () => getTelegramRuntime()?.getSettings()?.publicUrl ?? null,
        resolveProjectRoot: async (cwd) => {
          const { resolveProject } = await import("@/lib/worktree");
          return (await resolveProject(cwd)).projectRoot;
        },
      });
      return m.startSchedulerRuntime({ notifier });
    })
    .catch((error) => {
      console.error("[pi-hub:scheduler] init failed", error);
    });

  // Pi Hub Telegram runtime bootstrap (telegram-integration-design §7.1).
  // Idempotent and fully failure-isolated — a missing token, 409 conflict, or
  // network error is captured into the runtime status, never thrown here, so
  // the web server always starts. Telegram is optional (AGENTS.local.md §7).
  await import("@/modules/telegram")
    .then((m) => m.startTelegramRuntime())
    .catch((error) => {
      console.error("[pi-hub:telegram] init failed", error);
    });
}
