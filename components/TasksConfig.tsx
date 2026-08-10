"use client";

/**
 * TasksConfig — Pi Hub scheduled-task control center.
 *
 * Backed by the real scheduler API (`/api/tasks`, `/api/task-runs`,
 * `/api/scheduler/*`). The view structure (dashboard / new / edit / detail /
 * runs) mirrors the V1 UI design doc; data access goes through
 * `lib/scheduler-client.ts`. The modal shell and styling match the upstream
 * ModelsConfig/SkillsConfig pattern (zIndex 1000, 78vh, CSS variables).
 *
 * Design reference: docs/pi-hub/scheduled-execution-ui-design.zh-CN.md
 * Extension rules: AGENTS.local.md (extend, don't modify upstream).
 */

import { useCallback, useEffect, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { displayCwd, getRecentProjects } from "@/lib/projects";
import type { SessionInfo } from "@/lib/types";
import {
  createTask,
  deleteTask,
  getSchedulerStatus,
  getTask,
  listRuns,
  listTasks,
  previewSchedule,
  triggerRun,
  updateTask,
  type CreateTaskPayload,
  type PreviewResultDto,
  type ResumeTargetDto,
  type RetryOnRateLimitDto,
  type RunSummaryDto,
  type ScheduleDto,
  type SchedulerStatusDto,
  type TaskDto,
  type UpdateTaskPayload,
} from "@/lib/scheduler-client";

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

type View =
  | { name: "dashboard" }
  | { name: "new" }
  | { name: "edit"; task: TaskDto }
  | { name: "detail"; task: TaskDto }
  | { name: "runs"; task: TaskDto };

// ---------------------------------------------------------------------------
// Small shared presentational helpers
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-dim)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function secondaryButtonStyle(disabled?: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
    opacity: disabled ? 0.5 : 1,
  };
}

function primaryButtonStyle(disabled?: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
    fontWeight: 600,
    opacity: disabled ? 0.5 : 1,
  };
}

function dangerButtonStyle(disabled?: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 6,
    color: "#ef4444",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
    opacity: disabled ? 0.5 : 1,
  };
}

const TASK_STATUS_COLORS: Record<TaskDto["status"], string> = {
  active: "#16a34a",
  paused: "#d97706",
  completed: "var(--text-dim)",
};

const RUN_STATUS_COLORS: Record<RunSummaryDto["status"], string> = {
  success: "#16a34a",
  failed: "#ef4444",
  running: "#4ade80",
  queued: "var(--text-dim)",
  cancelled: "var(--text-dim)",
  interrupted: "#d97706",
  skipped: "var(--text-dim)",
  missed: "#ef4444",
};

function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Formats an ISO instant in a specific IANA timezone (client-side, display only). */
function formatZonedDateTime(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `${get("month")}-${get("day")} ${hour}:${get("minute")}`;
  } catch {
    return formatDateTime(iso);
  }
}

function formatRelativeNext(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return formatDateTime(iso);
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d (${formatDateTime(iso)})`;
}

function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** Human-readable schedule label for list/detail views (daily / cron / once). */
function scheduleLabel(
  task: TaskDto,
  t: (key: string) => string,
): string {
  const s = task.schedule;
  if (s.type === "daily") {
    return `${t("task.type.everyDay")} ${s.time ?? ""}`;
  }
  if (s.type === "cron") {
    return `${t("task.type.cron")}: ${s.cronExpression ?? ""}`;
  }
  return `${t("task.type.oneTime")} ${s.localDateTime ?? ""}`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TasksConfig({
  onClose,
  activeCwd,
}: {
  onClose: () => void;
  activeCwd?: string | null;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();

  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerStatusDto | null>(null);
  // Pi's already-loaded workspaces, derived from /api/sessions the same way the
  // home sidebar does it (deduped by projectRoot, sorted by recent activity).
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [homeDir, setHomeDir] = useState<string>("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "dashboard" });
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [taskList, status] = await Promise.all([
        listTasks(),
        getSchedulerStatus().catch(() => null),
      ]);
      setTasks(taskList.items);
      setScheduler(status);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load Pi's loaded workspaces + home dir once (not tied to task refresh).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sessionsRes, homeRes] = await Promise.all([
          fetch("/api/sessions"),
          fetch("/api/home"),
        ]);
        const sessionsData = (await sessionsRes.json().catch(() => ({}))) as {
          sessions?: SessionInfo[];
        };
        const homeData = (await homeRes.json().catch(() => ({}))) as {
          home?: string;
        };
        if (cancelled) return;
        setWorkspaces(
          sessionsData.sessions ? getRecentProjects(sessionsData.sessions) : [],
        );
        setSessions(sessionsData.sessions ?? []);
        setHomeDir(homeData.home ?? "");
      } catch {
        // Non-fatal — the picker just shows fewer options.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll every 5s while a run is active so the UI reflects progress.
  useEffect(() => {
    const hasActiveRun = scheduler ? scheduler.runningRuns > 0 : false;
    if (!hasActiveRun) return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [scheduler, refresh]);

  // ----- API-backed mutations -----

  async function mutate(
    id: string,
    fn: () => Promise<unknown>,
    after?: () => void,
  ) {
    setBusyId(id);
    try {
      await fn();
      await refresh();
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setOpenMenuId(null);
    }
  }

  const handleRunNow = (id: string) =>
    void mutate(id, () => triggerRun(id));

  const handleTogglePause = (task: TaskDto) =>
    void mutate(
      task.id,
      () =>
        updateTask(task.id, {
          status: task.status === "paused" ? "active" : "paused",
          revision: task.revision,
        }),
    );

  const handleDuplicate = async (task: TaskDto) => {
    setOpenMenuId(null);
    try {
      await createTask({
        name: `${task.name} (copy)`,
        cwd: task.cwd,
        prompt: task.prompt,
        schedule: task.schedule,
        execution: { ...task.execution, notifyOnSuccess: false },
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = (id: string) =>
    void mutate(id, () => deleteTask(id), () => {
      setDeleteConfirmId(null);
      setView({ name: "dashboard" });
    });

  async function handleCreate(payload: CreateTaskPayload) {
    try {
      const created = await createTask(payload);
      await refresh();
      setView({ name: "detail", task: created });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleUpdate(task: TaskDto, payload: UpdateTaskPayload) {
    try {
      const updated = await updateTask(task.id, payload);
      await refresh();
      setView({ name: "detail", task: updated });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function openDetail(task: TaskDto) {
    try {
      const fresh = await getTask(task.id);
      setView({ name: "detail", task: fresh });
    } catch {
      setView({ name: "detail", task });
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "78vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <Header
          title={t("task.title")}
          showBack={view.name !== "dashboard"}
          onBack={() => setView({ name: "dashboard" })}
          onClose={onClose}
        />

        {error && (
          <div
            style={{
              padding: "8px 18px",
              background: "rgba(239,68,68,0.08)",
              borderBottom: "1px solid var(--border)",
              color: "#ef4444",
              fontSize: 12,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>{error}</span>
            <button
              onClick={() => {
                setError(null);
                void refresh();
              }}
              style={secondaryButtonStyle()}
            >
              {t("task.load.retry")}
            </button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
              {t("task.load.loading")}
            </div>
          ) : view.name === "dashboard" ? (
            <DashboardView
              tasks={tasks}
              scheduler={scheduler}
              openMenuId={openMenuId}
              deleteConfirmId={deleteConfirmId}
              busyId={busyId}
              onToggleOpenMenu={(id) =>
                setOpenMenuId((cur) => (cur === id ? null : id))
              }
              onRunNow={(task) => handleRunNow(task.id)}
              onTogglePause={handleTogglePause}
              onDuplicate={handleDuplicate}
              onViewRuns={(task) => setView({ name: "runs", task })}
              onEdit={(task) => {
                setOpenMenuId(null);
                setView({ name: "edit", task });
              }}
              onRequestDelete={(id) => {
                setOpenMenuId(null);
                setDeleteConfirmId(id);
              }}
              onConfirmDelete={(id) => handleDelete(id)}
              onCancelDelete={() => setDeleteConfirmId(null)}
              onOpenDetail={openDetail}
              onNew={() => setView({ name: "new" })}
            />
          ) : view.name === "new" ? (
            <CreateTaskView
              workspaces={workspaces}
              homeDir={homeDir}
              sessions={sessions}
              defaultCwd={activeCwd ?? undefined}
              onCancel={() => setView({ name: "dashboard" })}
              onCreate={handleCreate}
            />
          ) : view.name === "edit" ? (
            <CreateTaskView
              key={view.task.id}
              editing={view.task}
              workspaces={workspaces}
              homeDir={homeDir}
              sessions={sessions}
              onCancel={() => setView({ name: "detail", task: view.task })}
              onSave={(payload) => handleUpdate(view.task, payload)}
            />
          ) : view.name === "detail" ? (
            <DetailView
              task={view.task}
              onViewRuns={() => setView({ name: "runs", task: view.task })}
              onRunNow={() => handleRunNow(view.task.id)}
              onTogglePause={() => handleTogglePause(view.task)}
            />
          ) : (
            <RunsView task={view.task} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  title,
  showBack,
  onBack,
  onClose,
}: {
  title: string;
  showBack: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 18px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {showBack && (
          <button
            onClick={onBack}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 16,
              padding: "2px 6px",
              marginRight: 2,
            }}
            title="Back"
          >
            ‹
          </button>
        )}
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
          {title}
        </span>
      </div>
      <button
        onClick={onClose}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 20,
          lineHeight: 1,
          padding: "2px 6px",
        }}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function DashboardView({
  tasks,
  scheduler,
  openMenuId,
  deleteConfirmId,
  busyId,
  onToggleOpenMenu,
  onRunNow,
  onTogglePause,
  onDuplicate,
  onViewRuns,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onOpenDetail,
  onNew,
}: {
  tasks: TaskDto[];
  scheduler: SchedulerStatusDto | null;
  openMenuId: string | null;
  deleteConfirmId: string | null;
  busyId: string | null;
  onToggleOpenMenu: (id: string) => void;
  onRunNow: (task: TaskDto) => void;
  onTogglePause: (task: TaskDto) => void;
  onDuplicate: (task: TaskDto) => void;
  onViewRuns: (task: TaskDto) => void;
  onEdit: (task: TaskDto) => void;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onOpenDetail: (task: TaskDto) => void;
  onNew: () => void;
}) {
  const { t } = useI18n();

  return (
    <div>
      <SchedulerCard scheduler={scheduler} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "20px 0 10px",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {t("task.title")}
        </span>
        <button onClick={onNew} style={primaryButtonStyle()}>
          + {t("task.new")}
        </button>
      </div>

      {tasks.length === 0 ? (
        <EmptyState onCreate={onNew} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              menuOpen={openMenuId === task.id}
              deleteConfirmOpen={deleteConfirmId === task.id}
              busy={busyId === task.id}
              onToggleMenu={() => onToggleOpenMenu(task.id)}
              onOpenDetail={() => onOpenDetail(task)}
              onRunNow={() => onRunNow(task)}
              onTogglePause={() => onTogglePause(task)}
              onDuplicate={() => onDuplicate(task)}
              onViewRuns={() => onViewRuns(task)}
              onEdit={() => onEdit(task)}
              onRequestDelete={() => onRequestDelete(task.id)}
              onConfirmDelete={() => onConfirmDelete(task.id)}
              onCancelDelete={onCancelDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SchedulerCard({ scheduler }: { scheduler: SchedulerStatusDto | null }) {
  const { t } = useI18n();
  if (!scheduler) {
    return (
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 14,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          fontSize: 12,
        }}
      >
        <SectionTitle>{t("task.scheduler")}</SectionTitle>
        {t("task.error.body")}
      </div>
    );
  }
  const isError = Boolean(scheduler.error);
  const isOffline = !scheduler.running;
  const statusColor = isError
    ? "#ef4444"
    : isOffline
      ? "var(--text-dim)"
      : scheduler.leader
        ? "#16a34a"
        : "#d97706";
  const statusLabel = isError
    ? t("task.scheduler.statusError")
    : isOffline
      ? t("task.scheduler.statusOffline")
      : scheduler.leader
        ? t("task.scheduler.statusRunning")
        : t("task.scheduler.statusStandby");

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 14,
        background: "var(--bg-panel)",
      }}
    >
      <SectionTitle>{t("task.scheduler")}</SectionTitle>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <StatusDot color={statusColor} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          {statusLabel}
        </span>
        {scheduler.error && (
          <span style={{ fontSize: 11, color: "#ef4444", marginLeft: 6 }}>
            {scheduler.error}
          </span>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 10,
        }}
      >
        <SchedulerMetric label={t("task.scheduler.running")} value={scheduler.runningRuns} />
        <SchedulerMetric label={t("task.scheduler.queued")} value={scheduler.queuedRuns} />
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>
        {t("task.scheduler.lastTick")}: {formatDateTime(scheduler.lastTickAt)}
      </div>
    </div>
  );
}

function SchedulerMetric({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? "var(--text)" }}>
        {value}
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        border: "1px dashed var(--border)",
        borderRadius: 8,
        padding: "40px 20px",
        textAlign: "center",
        color: "var(--text-muted)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
        {t("task.empty.title")}
      </div>
      <div style={{ fontSize: 12, marginBottom: 16 }}>{t("task.empty.body")}</div>
      <button onClick={onCreate} style={primaryButtonStyle()}>
        {t("task.empty.create")}
      </button>
    </div>
  );
}

function TaskRow({
  task,
  menuOpen,
  deleteConfirmOpen,
  busy,
  onToggleMenu,
  onOpenDetail,
  onRunNow,
  onTogglePause,
  onDuplicate,
  onViewRuns,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  task: TaskDto;
  menuOpen: boolean;
  deleteConfirmOpen: boolean;
  busy: boolean;
  onToggleMenu: () => void;
  onOpenDetail: () => void;
  onRunNow: () => void;
  onTogglePause: () => void;
  onDuplicate: () => void;
  onViewRuns: () => void;
  onEdit: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const { t } = useI18n();
  const label = scheduleLabel(task, t);

  return (
    <div
      style={{
        position: "relative",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        background: "var(--bg-panel)",
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div
          style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
          onClick={onOpenDetail}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <StatusDot color={TASK_STATUS_COLORS[task.status]} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
              {task.name}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2, fontFamily: task.schedule.type === "cron" ? "var(--font-mono)" : "inherit" }}>
            {label} · {task.schedule.timezone}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {task.status === "completed"
              ? t("task.status.completed")
              : `${t("task.column.nextRun")}: ${formatRelativeNext(task.nextRunAt)}`}
          </div>
        </div>

        <div style={{ position: "relative", flexShrink: 0 }}>
          <button
            onClick={onToggleMenu}
            disabled={busy}
            title={t("task.column.actions")}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: busy ? "default" : "pointer",
              fontSize: 16,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ⋮
          </button>
          {menuOpen && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                minWidth: 150,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                zIndex: 10,
                overflow: "hidden",
              }}
            >
              <MenuItem onClick={onRunNow} label={t("task.action.runNow")} />
              <MenuItem
                onClick={onTogglePause}
                label={
                  task.status === "paused"
                    ? t("task.action.resume")
                    : t("task.action.pause")
                }
              />
              <MenuItem onClick={onEdit} label={t("task.action.edit")} />
              <MenuItem onClick={onDuplicate} label={t("task.action.duplicate")} />
              <MenuItem onClick={onViewRuns} label={t("task.action.viewRuns")} />
              <div style={{ height: 1, background: "var(--border)" }} />
              <MenuItem onClick={onRequestDelete} label={t("task.action.delete")} danger />
            </div>
          )}
        </div>
      </div>

      {deleteConfirmOpen && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: "rgba(239,68,68,0.06)",
            border: "1px solid rgba(239,68,68,0.2)",
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
            {t("task.deleteConfirm.title")}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
            {t("task.deleteConfirm.body")}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={onCancelDelete} style={secondaryButtonStyle()}>
              {t("task.action.cancel")}
            </button>
            <button onClick={onConfirmDelete} style={dangerButtonStyle()}>
              {t("task.action.delete")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  label,
  danger,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "7px 12px",
        fontSize: 12,
        color: danger ? "#ef4444" : "var(--text)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "none";
      }}
    >
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit task view
// ---------------------------------------------------------------------------

function CreateTaskView({
  editing,
  workspaces,
  homeDir,
  defaultCwd,
  sessions,
  onCancel,
  onCreate,
  onSave,
}: {
  editing?: TaskDto;
  workspaces: string[];
  homeDir: string;
  defaultCwd?: string;
  sessions: SessionInfo[];
  onCancel: () => void;
  onCreate?: (payload: CreateTaskPayload) => Promise<void>;
  onSave?: (payload: UpdateTaskPayload) => Promise<void>;
}) {
  const { t } = useI18n();
  const isEditing = Boolean(editing);

  const [name, setName] = useState(editing?.name ?? "");
  const [cwd, setCwd] = useState(editing?.cwd ?? defaultCwd ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  const [scheduleType, setScheduleType] = useState<"daily" | "cron" | "once">(
    editing?.schedule.type ?? "daily",
  );
  const [time, setTime] = useState(editing?.schedule.time ?? "08:00");
  const [cronExpression, setCronExpression] = useState(
    editing?.schedule.cronExpression ?? "*/30 * * * *",
  );
  const [localDateTime, setLocalDateTime] = useState(
    editing?.schedule.localDateTime ?? "",
  );
  const [timezone, setTimezone] = useState(editing?.schedule.timezone ?? "Asia/Singapore");
  const [provider, setProvider] = useState(editing?.execution.provider ?? "");
  const [modelId, setModelId] = useState(editing?.execution.modelId ?? "");
  const [thinking, setThinking] = useState(editing?.execution.thinkingLevel ?? "");
  const [tools, setTools] = useState<string[]>(editing?.execution.toolNames ?? []);
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    editing?.execution.timeoutSeconds ?? 7200,
  );
  // Telegram completion-notification preferences for this task.
  const [notifySuccess, setNotifySuccess] = useState(
    editing?.execution.notifyOnSuccess ?? false,
  );
  const [notifyFailure, setNotifyFailure] = useState(
    editing?.execution.notifyOnFailure ?? true,
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<PreviewResultDto | null>(null);

  // Resume mode (continue an existing session, e.g. after a rate-limit hit).
  const [resumeMode, setResumeMode] = useState<boolean>(Boolean(editing?.resume));
  const [resumeSessionId, setResumeSessionId] = useState<string>(
    editing?.resume?.sessionId ?? "",
  );
  const [overrideModel, setOverrideModel] = useState<boolean>(
    Boolean(editing?.resume?.provider && editing?.resume?.modelId),
  );
  // Rate-limit auto-reschedule policy (resume §11).
  const [retryEnabled, setRetryEnabled] = useState<boolean>(
    Boolean(editing?.retryOnRateLimit?.enabled),
  );
  const [retryInterval, setRetryInterval] = useState<number>(
    editing?.retryOnRateLimit?.intervalMinutes ?? 300,
  );
  const [retryMaxAttempts, setRetryMaxAttempts] = useState<number>(
    editing?.retryOnRateLimit?.maxAttempts ?? 3,
  );

  const selectedSession = sessions.find((s) => s.id === resumeSessionId);
  // When editing a resume task whose session no longer appears in the loaded
  // list, fall back to the stored sessionFile so the target isn't lost.
  const resumeSessionPath =
    selectedSession?.path ?? editing?.resume?.sessionFile ?? "";

  // Keep cwd in sync with the resumed session (resume mode owns the cwd).
  useEffect(() => {
    if (resumeMode && selectedSession) {
      setCwd(selectedSession.cwd);
    }
  }, [resumeMode, selectedSession]);

  const AVAILABLE_TOOLS = ["Read", "Bash", "Edit", "Write"];
  const TIMEZONES = [
    "Asia/Singapore",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Europe/London",
    "America/New_York",
    "UTC",
  ];

  const canSubmit = Boolean(
    name.trim() &&
      prompt.trim() &&
      (resumeMode ? Boolean(selectedSession || editing?.resume) : cwd.trim()),
  );

  const scheduleDto: ScheduleDto =
    scheduleType === "daily"
      ? { type: "daily", time, timezone }
      : scheduleType === "cron"
        ? { type: "cron", cronExpression, timezone }
        : { type: "once", localDateTime: localDateTime || new Date().toISOString().slice(0, 16), timezone };

  // Live preview of the next run.
  useEffect(() => {
    let cancelled = false;
    previewSchedule(scheduleDto)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleType, time, cronExpression, localDateTime, timezone]);

  function toggleTool(tool: string) {
    setTools((prev) =>
      prev.includes(tool) ? prev.filter((x) => x !== tool) : [...prev, tool],
    );
  }

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const execution = {
      provider: provider.trim() || null,
      modelId: modelId.trim() || null,
      thinkingLevel: thinking.trim() || null,
      toolNames: tools,
      timeoutSeconds,
      notifyOnSuccess: notifySuccess,
      notifyOnFailure: notifyFailure,
    };
    // Resolve resume target (continue an existing session).
    let resume: ResumeTargetDto | null = null;
    if (resumeMode) {
      const base = selectedSession
        ? { sessionFile: selectedSession.path, sessionId: selectedSession.id }
        : editing?.resume
          ? {
              sessionFile: editing.resume.sessionFile,
              sessionId: editing.resume.sessionId,
            }
          : null;
      if (base) {
        resume =
          overrideModel && provider.trim() && modelId.trim()
            ? { ...base, provider: provider.trim(), modelId: modelId.trim() }
            : base;
      }
    }
    const retryOnRateLimit: RetryOnRateLimitDto | null = retryEnabled
      ? {
          enabled: true,
          intervalMinutes: retryInterval,
          maxAttempts: retryMaxAttempts,
        }
      : null;
    const finalCwd =
      resumeMode && selectedSession ? selectedSession.cwd : cwd.trim();
    try {
      if (isEditing && editing && onSave) {
        await onSave({
          name: name.trim(),
          cwd: finalCwd,
          prompt: prompt.trim(),
          schedule: scheduleDto,
          execution,
          resume,
          retryOnRateLimit,
          revision: editing.revision,
        });
      } else if (onCreate) {
        await onCreate({
          name: name.trim(),
          cwd: finalCwd,
          prompt: prompt.trim(),
          schedule: scheduleDto,
          execution,
          resume,
          retryOnRateLimit,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 560 }}>
      <FormSection>
        <SectionTitle>{t("task.create.name")}</SectionTitle>
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("task.create.namePlaceholder")}
        />
        <div style={{ height: 12 }} />
        <SectionTitle>{t("task.create.cwd")}</SectionTitle>
        {resumeMode ? (
          <input
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", opacity: 0.7 }}
            value={displayCwd(cwd, homeDir)}
            readOnly
            title={t("task.resume.cwdLocked")}
          />
        ) : (
          <select
            style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            value={workspaces.includes(cwd) ? cwd : ""}
            onChange={(e) => setCwd(e.target.value)}
          >
            {cwd && !workspaces.includes(cwd) ? (
              <option value={cwd}>{displayCwd(cwd, homeDir)}</option>
            ) : (
              <option value="" disabled>
                {t("task.create.cwdPlaceholder")}
              </option>
            )}
            {workspaces.map((ws) => (
              <option key={ws} value={ws}>
                {displayCwd(ws, homeDir)}
              </option>
            ))}
          </select>
        )}
      </FormSection>

      <FormSection>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text)" }}>
          <input
            type="checkbox"
            checked={resumeMode}
            onChange={(e) => setResumeMode(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          {t("task.resume.enable")}
        </label>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
          {t("task.resume.hint")}
        </div>
        {resumeMode && (
          <div style={{ marginTop: 10 }}>
            <FieldCaption>{t("task.resume.selectSession")}</FieldCaption>
            <select
              style={{ ...inputStyle, marginTop: 4 }}
              value={resumeSessionId}
              onChange={(e) => setResumeSessionId(e.target.value)}
            >
              <option value="" disabled>
                {t("task.resume.selectPlaceholder")}
              </option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {(s.name || s.firstMessage?.slice(0, 40) || s.id.slice(0, 8)) +
                    " · " +
                    displayCwd(s.cwd, homeDir)}
                </option>
              ))}
            </select>
            {resumeMode && !selectedSession && editing?.resume && (
              <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4 }}>
                {t("task.resume.sessionMissing")}
              </div>
            )}
            {resumeMode && resumeSessionPath && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  marginTop: 4,
                  fontFamily: "var(--font-mono)",
                  wordBreak: "break-all",
                }}
              >
                {resumeSessionPath}
              </div>
            )}
          </div>
        )}
      </FormSection>

      <FormSection>
        <SectionTitle>{t("task.create.instruction")}</SectionTitle>
        <textarea
          style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "var(--font-mono)" }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </FormSection>

      <FormSection>
        <SectionTitle>{t("task.create.schedule")}</SectionTitle>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
          <RadioOption
            checked={scheduleType === "daily"}
            onClick={() => setScheduleType("daily")}
            label={t("task.type.everyDay")}
          />
          <RadioOption
            checked={scheduleType === "cron"}
            onClick={() => setScheduleType("cron")}
            label={t("task.type.cron")}
          />
          <RadioOption
            checked={scheduleType === "once"}
            onClick={() => setScheduleType("once")}
            label={t("task.type.oneTime")}
          />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {scheduleType === "once" && (
            <label style={fieldLabelStyle}>
              <FieldCaption>{t("task.create.date")}</FieldCaption>
              <input
                type="datetime-local"
                style={inputStyle}
                value={localDateTime}
                onChange={(e) => setLocalDateTime(e.target.value)}
              />
            </label>
          )}
          {scheduleType === "daily" && (
            <label style={fieldLabelStyle}>
              <FieldCaption>{t("task.create.time")}</FieldCaption>
              <input
                type="time"
                style={inputStyle}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
          )}
          {scheduleType === "cron" && (
            <label style={{ ...fieldLabelStyle, flexBasis: "100%" }}>
              <FieldCaption>{t("task.create.cronExpression")}</FieldCaption>
              <input
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="*/15 9-18 * * 1-5"
                spellCheck={false}
              />
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                {t("task.create.cronHint")}
              </span>
            </label>
          )}
          <label style={fieldLabelStyle}>
            <FieldCaption>{t("task.create.timezone")}</FieldCaption>
            <select style={inputStyle} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
            {t("task.create.preview")}
          </div>
          {preview ? (
            <>
              <div>{preview.localDisplay}</div>
              <div style={{ color: "var(--text-dim)" }}>{preview.utcDisplay}</div>
              {preview.nextRuns && preview.nextRuns.length > 1 && (
                <div style={{ marginTop: 4, color: "var(--text-dim)" }}>
                  {t("task.create.upcoming")}: {preview.nextRuns.map((iso) => formatZonedDateTime(iso, timezone)).join("  ·  ")}
                </div>
              )}
              {scheduleType === "cron" && cronExpression.trim() === "* * * * *" && (
                <div style={{ marginTop: 4, color: "#f59e0b" }}>
                  {t("task.create.cronEveryMinuteWarn")}
                </div>
              )}
            </>
          ) : (
            "—"
          )}
        </div>
      </FormSection>

      <FormSection>
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            padding: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ display: "inline-block", transform: advancedOpen ? "rotate(90deg)" : "none" }}>
            ›
          </span>
          {t("task.create.agentConfig")}
        </button>

        {advancedOpen && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <label style={fieldLabelStyle}>
                <FieldCaption>Provider</FieldCaption>
                <input style={inputStyle} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="default" />
              </label>
              <label style={fieldLabelStyle}>
                <FieldCaption>Model ID</FieldCaption>
                <input style={inputStyle} value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="default" />
              </label>
              <label style={fieldLabelStyle}>
                <FieldCaption>{t("task.create.thinking")}</FieldCaption>
                <input style={inputStyle} value={thinking} onChange={(e) => setThinking(e.target.value)} placeholder="default" />
              </label>
            </div>
            <label style={fieldLabelStyle}>
              <FieldCaption>{t("task.create.timeout")}</FieldCaption>
              <input
                type="number"
                min={60}
                max={86400}
                style={inputStyle}
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 7200)}
              />
            </label>
            <div>
              <FieldCaption>{t("task.create.tools")}</FieldCaption>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                {AVAILABLE_TOOLS.map((tool) => (
                  <CheckboxOption
                    key={tool}
                    checked={tools.includes(tool)}
                    onClick={() => toggleTool(tool)}
                    label={tool}
                  />
                ))}
              </div>
            </div>
            <div>
              <FieldCaption>{t("task.create.notifyTitle")}</FieldCaption>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
                <CheckboxOption
                  checked={notifySuccess}
                  onClick={() => setNotifySuccess((v) => !v)}
                  label={t("task.create.notifySuccess")}
                />
                <CheckboxOption
                  checked={notifyFailure}
                  onClick={() => setNotifyFailure((v) => !v)}
                  label={t("task.create.notifyFailure")}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                {t("task.create.notifyHint")}
              </div>
            </div>
            <div>
              <CheckboxOption
                checked={retryEnabled}
                onClick={() => setRetryEnabled((v) => !v)}
                label={t("task.retry.enable")}
              />
              {retryEnabled && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                  <label style={fieldLabelStyle}>
                    <FieldCaption>{t("task.retry.interval")}</FieldCaption>
                    <input
                      type="number"
                      min={1}
                      style={inputStyle}
                      value={retryInterval}
                      onChange={(e) => setRetryInterval(Number(e.target.value) || 300)}
                    />
                  </label>
                  <label style={fieldLabelStyle}>
                    <FieldCaption>{t("task.retry.maxAttempts")}</FieldCaption>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      style={inputStyle}
                      value={retryMaxAttempts}
                      onChange={(e) => setRetryMaxAttempts(Number(e.target.value) || 3)}
                    />
                  </label>
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                {t("task.retry.hint")}
              </div>
            </div>
            {resumeMode && (
              <div>
                <CheckboxOption
                  checked={overrideModel}
                  onClick={() => setOverrideModel((v) => !v)}
                  label={t("task.resume.overrideModel")}
                />
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                  {t("task.resume.overrideModelHint")}
                </div>
              </div>
            )}
          </div>
        )}
      </FormSection>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
        <button onClick={onCancel} style={secondaryButtonStyle()}>
          {t("task.action.back")}
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
          style={primaryButtonStyle(!canSubmit || submitting)}
        >
          {submitting ? "…" : isEditing ? t("task.action.edit") : t("task.create.create")}
        </button>
      </div>
    </div>
  );
}

function FormSection({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 14,
        background: "var(--bg)",
      }}
    >
      {children}
    </div>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: 1,
  minWidth: 120,
};

function FieldCaption({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{children}</span>;
}

function RadioOption({
  checked,
  onClick,
  label,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text)" }}>
      <input type="radio" checked={checked} onChange={onClick} style={{ cursor: "pointer" }} />
      {label}
    </label>
  );
}

function CheckboxOption({
  checked,
  onClick,
  label,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text)" }}>
      <input type="checkbox" checked={checked} onChange={onClick} style={{ cursor: "pointer" }} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Task Detail
// ---------------------------------------------------------------------------

function DetailView({
  task,
  onViewRuns,
  onRunNow,
  onTogglePause,
}: {
  task: TaskDto;
  onViewRuns: () => void;
  onRunNow: () => void;
  onTogglePause: () => void;
}) {
  const { t } = useI18n();
  const label = scheduleLabel(task, t);

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <StatusDot color={TASK_STATUS_COLORS[task.status]} />
        <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{task.name}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {task.status === "active"
            ? t("task.status.active")
            : task.status === "paused"
              ? t("task.status.paused")
              : t("task.status.completed")}
        </span>
      </div>

      <DetailField label={t("task.detail.schedule")} value={`${label} · ${task.schedule.timezone}`} mono={task.schedule.type === "cron"} />
      <DetailField label={t("task.detail.nextRun")} value={formatRelativeNext(task.nextRunAt)} />
      <DetailField label={t("task.detail.workspace")} value={task.cwd} mono />
      <DetailField
        label={t("task.detail.agent")}
        value={
          task.execution.provider && task.execution.modelId
            ? `${task.execution.provider}/${task.execution.modelId}`
            : "default"
        }
      />
      {task.resume && (
        <DetailField label={t("task.detail.mode")} value={t("task.resume.modeOn")} />
      )}
      {task.retryOnRateLimit?.enabled && (
        <DetailField
          label={t("task.detail.retry")}
          value={`${task.attemptCount} / ${task.retryOnRateLimit.maxAttempts}`}
        />
      )}
      {task.lastRun && (
        <DetailField
          label={t("task.column.lastResult")}
          value={`${task.lastRun.status} · ${formatDateTime(task.lastRun.finishedAt)}`}
        />
      )}

      <div style={{ marginTop: 14 }}>
        <SectionTitle>{t("task.detail.prompt")}</SectionTitle>
        <pre
          style={{
            margin: 0,
            padding: 10,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {task.prompt}
        </pre>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
        <button onClick={onRunNow} style={primaryButtonStyle()}>
          {t("task.action.runNow")}
        </button>
        <button onClick={onTogglePause} style={secondaryButtonStyle()}>
          {task.status === "paused" ? t("task.action.resume") : t("task.action.pause")}
        </button>
        <button onClick={onViewRuns} style={secondaryButtonStyle()}>
          {t("task.action.viewRuns")}
        </button>
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ width: 110, flexShrink: 0, fontSize: 11, color: "var(--text-dim)", paddingTop: 2 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text)",
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run History
// ---------------------------------------------------------------------------

function RunsView({ task }: { task: TaskDto }) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<RunSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listRuns(task.id);
      setRuns(result.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while any run is queued/running.
  useEffect(() => {
    const hasActive = runs.some(
      (r) => r.status === "queued" || r.status === "running",
    );
    if (!hasActive) return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [runs, load]);

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>
        {t("task.runs.title")} — {task.name}
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
          {t("task.load.loading")}
        </div>
      ) : error ? (
        <div style={{ padding: 24, textAlign: "center", color: "#ef4444", fontSize: 12 }}>
          {error}
        </div>
      ) : runs.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
          {t("task.runs.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              expanded={expandedRunId === run.id}
              onToggle={() =>
                setExpandedRunId((cur) => (cur === run.id ? null : run.id))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run,
  expanded,
  onToggle,
}: {
  run: RunSummaryDto;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const statusLabel =
    run.status === "success"
      ? t("task.runs.success")
      : run.status === "failed"
        ? t("task.runs.failed")
        : run.status === "running"
          ? t("task.runs.running")
          : run.status === "queued"
            ? t("task.runs.queued")
            : run.status === "cancelled"
              ? t("task.runs.cancelled")
              : run.status === "interrupted"
                ? t("task.runs.interrupted")
                : run.status === "skipped"
                  ? t("task.runs.skipped")
                  : t("task.runs.missed");

  const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const duration = finishedAt != null && startedAt != null ? finishedAt - startedAt : null;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
        overflow: "hidden",
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <StatusDot color={RUN_STATUS_COLORS[run.status]} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{statusLabel}</span>
        {run.errorCode && (
          <span style={{ fontSize: 11, color: "#ef4444" }}>{run.errorCode}</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {formatDateTime(run.startedAt ?? run.queuedAt)}
        </span>
        {duration != null && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{formatDuration(duration)}</span>
        )}
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{expanded ? "−" : "+"}</span>
      </div>

      {expanded && (
        <div
          style={{
            padding: "0 12px 12px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <DetailField label={t("task.detail.trigger")} value={run.triggerType === "manual" ? t("task.runs.triggerManual") : t("task.runs.triggerScheduled")} />
          <DetailField label={t("task.runs.started")} value={formatDateTime(run.startedAt)} />
          <DetailField label={t("task.runs.finished")} value={formatDateTime(run.finishedAt)} />
          <DetailField label={t("task.runs.session")} value={run.sessionId ?? "—"} mono />
          {run.errorMessage && (
            <div style={{ marginTop: 4 }}>
              <SectionTitle>{t("task.error.taskFailed")}</SectionTitle>
              <div
                style={{
                  padding: 8,
                  background: "rgba(239,68,68,0.06)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "#ef4444",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {run.errorMessage}
              </div>
            </div>
          )}
          {run.sessionId && (
            <div style={{ marginTop: 4 }}>
              <a
                href={`/?session=${encodeURIComponent(run.sessionId)}`}
                style={secondaryButtonStyle()}
              >
                {t("task.runs.openSession")}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
