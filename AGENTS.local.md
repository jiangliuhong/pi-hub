# Pi Hub Extension Rules

This repository is a long-term fork of `agegr/pi-web`.

The existing `AGENTS.md` is inherited from upstream pi-web and must remain unchanged whenever possible. This file defines additional development rules for Pi Hub enhancements.

The primary engineering goal is:

> Extend instead of modify.

Pi Hub must remain easy to synchronize with upstream `pi-web` releases with minimal merge conflicts.

## Approved Product-Level Differences

The following differences are intentional parts of the Pi Hub product identity
and are not upstream-compatibility regressions:

- the npm package is published as `@jarome/pi-hub`;
- the supported CLI command is `pi-hub` (additional commands may be added later);
- Pi Hub uses port `30142` for `dev`, `start`, and their LAN variants;
- release and publishing automation belongs to Pi Hub and must keep the Pi Hub
  package identity;
- user-facing product metadata and installation documentation may use the
  Pi Hub name and repository URLs.

These exceptions do not permit unrelated rewrites of upstream runtime, Chat,
Session, API, or UI behavior. Keep product branding changes mechanical and
localized. For local development, the Pi Hub quick start is:

```bash
npm run dev   # port 30142
```

---

## 1. Upstream Compatibility

Upstream compatibility has higher priority than implementing a feature in the shortest possible way.

When adding Pi Hub functionality:

- Prefer adding new files over editing upstream files.
- Prefer adding new modules over rewriting existing modules.
- Prefer composition and adapters over invasive changes.
- Do not refactor upstream code only for style or architecture preferences.
- Do not rename or move upstream files or directories unless strictly necessary.
- Do not change existing pi-web behavior unless the feature explicitly requires it.
- Keep existing APIs backward compatible.
- Avoid changes to upstream data formats and runtime behavior.

Before modifying an existing upstream file, first determine whether the feature can be implemented through a new module, adapter, wrapper, route, component, hook, or configuration layer.

If an upstream file must be modified, keep the patch as small and localized as possible.

---

## 2. Preserve Upstream AGENTS.md

`AGENTS.md` belongs to the upstream pi-web development context.

Rules:

- Do not rewrite `AGENTS.md` with Pi Hub-specific rules.
- Do not remove upstream architecture notes from `AGENTS.md`.
- Pi Hub-specific development rules belong in `AGENTS.local.md`.
- When upstream updates `AGENTS.md`, prefer accepting the upstream version unless Pi Hub has a documented compatibility reason not to.

Developers and coding agents must read both files before making architectural changes:

- `AGENTS.md`
- `AGENTS.local.md`

---

## 3. Extension Boundary

New Pi Hub capabilities should be isolated from upstream pi-web code.

Prefer placing new domain functionality under:

```text
modules/
```

Example:

```text
modules/
├── automation/
├── scheduler/
├── telegram/
├── notifications/
└── task-runner/
```

Each module should own its domain logic and expose a small public interface to the rest of the application.

Do not scatter scheduler, Telegram, automation, or notification logic throughout existing pi-web components.

---

## 4. Shared Agent Execution Pipeline

Pi Hub must not introduce a second independent Pi execution implementation.

All execution entry points should ultimately reuse the existing pi-web / Pi AgentSession execution pipeline whenever practical.

Expected model:

```text
Manual Chat ─────────┐
Scheduled Task ──────┤
One-time Task ───────┤──> Shared Agent Execution Layer ──> Pi Runtime
Telegram Command ────┤
Future API Trigger ──┘
```

Rules:

- Do not duplicate AgentSession lifecycle logic.
- Do not independently reimplement Pi session creation if existing pi-web abstractions can be reused.
- Keep session behavior consistent between manual and automated execution.
- Preserve existing `lib/rpc-manager.ts` lifecycle semantics unless absolutely required.
- Be especially careful around session registry, fork behavior, streaming state, SSE reconciliation, and idle cleanup described in upstream `AGENTS.md`.

If an adapter is required, create a Pi Hub execution service that wraps the existing upstream execution primitives rather than replacing them.

---

## 5. Scheduler Architecture

Scheduled execution must be independent from the browser lifecycle.

Closing the browser must not stop scheduled tasks.

The scheduler must support at least:

- recurring tasks, such as daily or cron-based execution;
- one-time tasks scheduled for a specific time;
- enable / disable;
- manual execution;
- execution status;
- execution history;
- failure recording.

Scheduler code must not live inside Chat UI components or React hooks intended for browser interaction.

Prefer:

```text
modules/scheduler/
├── scheduler-service.ts
├── scheduler-store.ts
├── scheduler-types.ts
└── scheduler-runner.ts
```

The exact file names may change, but the domain boundary should remain clear.

---

## 6. Task Runner

Scheduling and execution are separate responsibilities.

The scheduler decides **when** a task should run.

The task runner decides **how** the configured Agent task is executed.

Keep these responsibilities separate so that future execution engines can be added without redesigning the scheduler.

Possible future executors include:

- Pi
- Codex
- Claude Code

Do not add abstractions for unsupported executors prematurely, but avoid tightly coupling the task schema to Pi internals where unnecessary.

---

## 7. Telegram / TelePi Integration

Telegram must be treated as an external transport and interaction channel, not as part of the Chat UI.

Preferred architecture:

```text
Telegram / TelePi
       │
       ▼
Telegram Adapter
       │
       ▼
Pi Hub Application Services
       │
       ▼
Shared Agent Execution Layer
       │
       ▼
Pi Runtime
```

Rules:

- Do not put Telegram-specific logic into `ChatWindow`, `ChatInput`, or other upstream chat components.
- Keep Telegram API details inside the Telegram module.
- Convert Telegram input into application-level commands before invoking Agent execution.
- Convert Agent/task results into notification messages through the Telegram adapter.
- Telegram integration must remain optional and configurable.
- Pi Hub should continue working normally when Telegram is disabled or unavailable.

When possible, integrate with TelePi through a clear adapter boundary rather than copying TelePi internals directly into unrelated modules.

---

## 8. Data Storage

Do not modify Pi's existing session storage format for Pi Hub automation features.

Existing Pi data under locations such as:

```text
~/.pi/agent/
```

must remain owned by Pi / pi-web behavior.

Pi Hub-specific persistent data should use:

```text
~/.pi/hub/
```

Recommended layout:

```text
~/.pi/hub/
├── app.db
├── config.json
└── logs/
```

The exact internal layout may evolve, but Pi Hub-specific state must not be stored under `~/.pi-web/`.

Automation-related persistence may include:

- tasks;
- task schedules;
- task runs;
- execution status;
- notification history;
- Pi Hub configuration.

Do not store secrets in task logs or execution history.

---

## 9. Configuration

New configuration must use Pi Hub-specific namespaces and must not silently change upstream Pi settings.

Examples:

```text
scheduler.*
telegram.*
automation.*
notifications.*
```

Rules:

- Reuse upstream settings only when the setting genuinely belongs to Pi itself.
- Keep Pi Hub configuration separate from Pi model/auth/session configuration where possible.
- Never expose API keys, tokens, OAuth credentials, or Telegram bot tokens through client-side APIs.
- Never return raw secrets from status endpoints.

---

## 10. API Rules

Prefer adding new endpoints instead of modifying existing upstream endpoints.

Examples:

```text
/api/tasks
/api/tasks/[id]
/api/tasks/[id]/run
/api/task-runs
/api/scheduler
/api/telegram
```

Avoid changing existing endpoints such as:

```text
/api/agent/*
/api/sessions/*
/api/models/*
```

unless there is no reasonable extension path.

If an upstream API must be modified:

- preserve existing request behavior;
- preserve existing response fields;
- prefer additive fields;
- document the Pi Hub-specific behavior;
- keep the change minimal.

---

## 11. Frontend Rules

Existing pi-web Chat and Session behavior should remain functionally equivalent to upstream.

Prefer adding new pages and components rather than redesigning existing ones.

Possible Pi Hub pages include:

```text
/tasks
/automation
/task-runs
/settings/integrations
```

Rules:

- Do not rewrite existing Chat UI merely to make new features visually consistent.
- Reuse existing design tokens and CSS variables.
- Reuse existing layout components where this can be done with a small integration patch.
- Keep navigation integration changes minimal.
- New feature-specific UI should live in new components wherever possible.

---

## 12. Dependencies

Keep new dependencies minimal.

Before adding a dependency:

1. Check whether the existing project or Node.js runtime already provides the required capability.
2. Prefer small, well-maintained libraries.
3. Avoid introducing a new framework for a single feature.
4. Consider whether the dependency will complicate upstream merges or deployment.

Do not replace upstream libraries only because another library is preferred.

---

## 13. Long-running Tasks

Agent tasks may run longer than a single HTTP request or browser session.

Therefore:

- Do not make scheduled execution depend on an open SSE connection.
- Do not make task lifecycle depend on the browser staying connected.
- Persist enough execution state to recover task status after process restart where practical.
- Treat browser SSE as an observation mechanism, not as the owner of the task lifecycle.

Long-running execution should be observable from the Web UI through persisted run state and/or existing Pi session state.

---

## 14. Concurrency

Agent concurrency must be explicit.

Do not allow unlimited scheduled Agent executions by accident.

For the first implementation, prefer a conservative concurrency model if necessary, such as a small global concurrency limit.

Any concurrency behavior must define:

- what happens when multiple tasks become due simultaneously;
- whether the same task can overlap with itself;
- how duplicate execution is prevented;
- how task state is recovered after failure or restart.

---

## 15. Error Handling and Observability

Automation features must provide enough information to understand failures without requiring server debugging for normal cases.

At minimum, task runs should distinguish states such as:

```text
pending
running
success
failed
cancelled
```

Persist useful failure summaries while avoiding credentials or other secrets.

Server logs may contain additional diagnostic context.

---

## 16. Testing and Validation

Before completing a Pi Hub enhancement:

- run the existing upstream validation commands defined in `AGENTS.md`;
- ensure existing Chat / Session behavior still works;
- test the new feature independently;
- test the integration boundary with Agent execution;
- verify that no Pi session format was unintentionally changed.

Do not run commands explicitly prohibited by upstream `AGENTS.md`.

When practical, new domain logic should have tests that do not require launching the complete browser UI.

---

## 17. Upstream Synchronization Rules

Assume upstream `agegr/pi-web` will continue to change.

Every change should be evaluated for future merge cost.

Before implementing a feature, ask:

1. Can this be implemented entirely in new files?
2. If not, what is the smallest upstream integration point?
3. Can the integration point be reduced to an import, registration call, route, or navigation item?
4. Will this patch be easy to reapply if upstream rewrites the surrounding file?

When synchronizing upstream:

1. Fetch the latest upstream changes.
2. Review upstream changes before resolving conflicts.
3. Prefer upstream implementations for existing pi-web functionality.
4. Reapply Pi Hub integration as a minimal extension.
5. Never resolve conflicts by blindly keeping the Pi Hub version of an upstream file.
6. Run the upstream validation commands after synchronization.
7. Validate Pi Hub-specific scheduler and Telegram functionality after the merge.

---

## 18. Upstream File Modification Checklist

Before editing an existing upstream file, confirm all of the following:

- The requirement cannot reasonably be implemented in a new file.
- The change is required for Pi Hub functionality.
- The patch is localized.
- Existing upstream behavior is preserved.
- The change does not duplicate upstream logic.
- The change is documented when its purpose is not obvious.

If these conditions are not met, redesign the implementation as an extension.

---

## 19. Feature Development Priority

When choosing between two valid implementations, prefer them in this order:

1. No upstream file changes.
2. One small upstream integration change plus isolated new modules.
3. A few localized upstream changes.
4. Broad upstream refactoring only as a last resort.

Ease of future upstream synchronization is a core product requirement of Pi Hub.

---

## 20. Core Principle

Pi Hub is not intended to become an unrelated rewrite of pi-web.

It should remain recognizable as pi-web plus a clean enhancement layer for automation, scheduling, Telegram integration, and future Agent management capabilities.

Whenever there is uncertainty, choose the implementation that keeps the upstream boundary clearer and future merges simpler.
