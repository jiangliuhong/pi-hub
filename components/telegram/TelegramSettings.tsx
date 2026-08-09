"use client";

/**
 * TelegramSettings — Pi Hub Telegram integration control center.
 *
 * Covers Phase-1 of the integration design (§20 Web management page): bot
 * token configuration + validation, connection test, runtime status, pairing
 * code issuance, user whitelist, conversation mapping, and self-hosted Bot API
 * Server endpoint configuration + migration (open-source Bot API Server §8).
 *
 * The modal shell and styling match the upstream ModelsConfig/SkillsConfig and
 * Pi Hub TasksConfig pattern (zIndex 1000, CSS variables) so it looks native
 * without touching upstream chat components (AGENTS.local.md §11).
 *
 * Design reference: docs/pi-hub/telegram-integration-design.zh-CN.md §20
 * Design reference: docs/pi-hub/telegram-open-source-bot-api-server-design.zh-CN.md §8
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import {
  deleteTelegramConversation,
  deleteTelegramToken,
  deleteTelegramUser,
  getTelegramConfig,
  getTelegramStatus,
  issuePairingCode,
  listTelegramConversations,
  listTelegramUsers,
  migrateBotApiServer,
  restartTelegramRuntime,
  saveTelegramToken,
  testTelegramConnection,
  updateTelegramConfig,
  updateTelegramUser,
  type PairingCodeResult,
  type TelegramConfigDto,
  type TelegramConversationDto,
  type TelegramStatusDto,
  type TelegramUserDto,
  type TestResult,
} from "@/lib/telegram-client";

interface Props {
  onClose: () => void;
}

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

const card: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 14,
  background: "var(--bg-panel)",
  marginBottom: 12,
};

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

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <strong
      style={{
        display: "block",
        fontSize: 13,
        fontWeight: 600,
        color: "var(--text)",
        marginBottom: 8,
      }}
    >
      {children}
    </strong>
  );
}

const STATUS_LABEL: Record<TelegramStatusDto["runtime"]["status"], string> = {
  disabled: "未启用",
  starting: "启动中",
  running: "运行中",
  standby: "待机",
  stopping: "停止中",
  error: "错误",
};

export function TelegramSettings({ onClose }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<TelegramStatusDto | null>(null);
  const [config, setConfig] = useState<TelegramConfigDto | null>(null);
  const [users, setUsers] = useState<TelegramUserDto[]>([]);
  const [conversations, setConversations] = useState<TelegramConversationDto[]>([]);
  const [tab, setTab] = useState<"setup" | "users" | "conversations">("setup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingCodeResult | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, c, u, conv] = await Promise.all([
        getTelegramStatus(),
        getTelegramConfig(),
        listTelegramUsers(),
        listTelegramConversations(),
      ]);
      setStatus(s);
      setConfig(c);
      setUsers(u.items);
      setConversations(conv.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

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
      role="dialog"
      aria-modal="true"
      aria-label={t("common.telegram")}
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
        <Header onClose={onClose} />
        <Tabs tab={tab} setTab={setTab} />
        <div style={{ overflow: "auto", padding: 20, flex: 1 }}>
          {error && <Banner kind="error">{error}</Banner>}
          {!config || !status ? (
            <div style={{ color: "var(--text-muted)", padding: 24, textAlign: "center" }}>
              加载中…
            </div>
          ) : tab === "setup" ? (
            <SetupTab
              status={status}
              config={config}
              pairing={pairing}
              testResult={testResult}
              busy={busy}
              onRefresh={refresh}
              onBusy={setBusy}
              onError={setError}
              onPairing={setPairing}
              onTest={setTestResult}
              onConfigChange={(next) => setConfig(next)}
            />
          ) : tab === "users" ? (
            <UsersTab users={users} busy={busy} onBusy={setBusy} onError={setError} onChanged={refresh} />
          ) : (
            <ConversationsTab
              conversations={conversations}
              busy={busy}
              onBusy={setBusy}
              onError={setError}
              onChanged={refresh}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
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
      <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
        {t("common.telegram")} · {t("common.integrations")}
      </span>
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

function Tabs({
  tab,
  setTab,
}: {
  tab: "setup" | "users" | "conversations";
  setTab: (t: "setup" | "users" | "conversations") => void;
}) {
  const items: { key: typeof tab; label: string }[] = [
    { key: "setup", label: "配置与状态" },
    { key: "users", label: "用户配对" },
    { key: "conversations", label: "会话映射" },
  ];
  return (
    <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => setTab(it.key)}
          style={{
            flex: 1,
            padding: "10px 8px",
            background: "transparent",
            border: "none",
            borderBottom: tab === it.key ? "2px solid var(--accent)" : "2px solid transparent",
            color: tab === it.key ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: tab === it.key ? 600 : 400,
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Banner({ kind, children }: { kind: "error" | "success" | "warn"; children: React.ReactNode }) {
  const bg =
    kind === "error"
      ? "rgba(239,68,68,0.08)"
      : kind === "success"
        ? "rgba(22,163,74,0.1)"
        : "rgba(217,119,6,0.1)";
  const color = kind === "error" ? "#ef4444" : kind === "success" ? "#16a34a" : "#d97706";
  return (
    <div style={{ background: bg, color, padding: "8px 10px", borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
      {children}
    </div>
  );
}

/**
 * RecoveryCountdown — shown inside the error Banner when the backend has
 * scheduled an auto-recovery retry (nextRecoveryAt !== null). Driven by a
 * local 1s tick so the countdown stays smooth regardless of the 5s status
 * polling cadence. The data source of truth is the backend: it only sets
 * nextRecoveryAt for transient errors (409/network/TLS), so we don't need to
 * re-classify the error code here.
 */
function RecoveryCountdown({
  nextRecoveryAt,
  recoveryAttempt,
}: {
  nextRecoveryAt: string;
  recoveryAttempt: number;
}) {
  const target = new Date(nextRecoveryAt).getTime();
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.round((target - Date.now()) / 1000)));
  useEffect(() => {
    setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000)));
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [target]);

  // Backoff caps at 5min from attempt 8 onward (4000 * 2^7 = 512000 > 300000).
  const capped = recoveryAttempt >= 8;
  return (
    <div style={{ marginTop: 6, color: "#d97706" }}>
      {remaining > 0
        ? `自动恢复中（第 ${recoveryAttempt} 次重试），将在 ${remaining}s 后重试…`
        : `自动恢复中（第 ${recoveryAttempt} 次重试），正在重试…`}
      {capped && <div style={{ marginTop: 2 }}>已退避到上限，每 5 分钟重试一次。</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup tab: token, status, bot api server, test, pairing
// ---------------------------------------------------------------------------

function SetupTab(props: {
  status: TelegramStatusDto;
  config: TelegramConfigDto;
  pairing: PairingCodeResult | null;
  testResult: TestResult | null;
  busy: boolean;
  onRefresh: () => void;
  onBusy: (b: boolean) => void;
  onError: (e: string | null) => void;
  onPairing: (p: PairingCodeResult | null) => void;
  onTest: (t: TestResult | null) => void;
  onConfigChange: (c: TelegramConfigDto) => void;
}) {
  const { status, config, pairing, testResult, busy, onRefresh, onBusy, onError, onPairing, onTest, onConfigChange } =
    props;
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [selfHostedRoot, setSelfHostedRoot] = useState(config.botApi.mode === "self-hosted" ? config.botApi.apiRoot : "");
  const selfHostedInputRef = useRef<HTMLInputElement>(null);
  const [editingSelfHosted, setEditingSelfHosted] = useState(false);
  const [migrateRoot, setMigrateRoot] = useState("");
  const [testApiRoot, setTestApiRoot] = useState("");
  const [confirmMigrate, setConfirmMigrate] = useState(false);

  const doSaveToken = async () => {
    onBusy(true);
    onError(null);
    try {
      await saveTelegramToken(tokenInput.trim());
      setTokenInput("");
      await restartTelegramRuntime();
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doDeleteToken = async () => {
    onBusy(true);
    onError(null);
    try {
      await deleteTelegramToken();
      await restartTelegramRuntime();
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doTest = async () => {
    onBusy(true);
    onError(null);
    onTest(null);
    try {
      const res = await testTelegramConnection({
        ...(testApiRoot.trim() ? { apiRoot: testApiRoot.trim() } : {}),
        localMode: config.botApi.localMode,
        ...(config.botApi.localFileRoot ? { localFileRoot: config.botApi.localFileRoot } : {}),
      });
      onTest(res);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doRestart = async () => {
    onBusy(true);
    try {
      await restartTelegramRuntime();
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doSetEnabled = async (enabled: boolean) => {
    onBusy(true);
    onError(null);
    try {
      const next = await updateTelegramConfig({ enabled });
      onConfigChange(next);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doIssuePairing = async () => {
    onBusy(true);
    onError(null);
    try {
      const p = await issuePairingCode({});
      onPairing(p);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doToggleAllowAllWorkspaces = async (allowAll: boolean) => {
    onBusy(true);
    onError(null);
    try {
      const next = await updateTelegramConfig({ allowAllWorkspaceNotifications: allowAll });
      onConfigChange(next);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doSaveBotApi = async () => {
    onBusy(true);
    onError(null);
    try {
      const next = await updateTelegramConfig({
        botApi: {
          mode: "self-hosted",
          apiRoot: selfHostedRoot.trim(),
          localMode: config.botApi.localMode,
          localFileRoot: config.botApi.localFileRoot,
        },
      });
      onConfigChange(next);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doSwitchSelfHosted = () => {
    // Mode is only persisted once an address is saved. Reveal the self-hosted
    // form so the user can fill it in, then focus the address input.
    setEditingSelfHosted(true);
    requestAnimationFrame(() => selfHostedInputRef.current?.focus());
  };

  const doSwitchOfficial = async () => {
    setEditingSelfHosted(false);
    onBusy(true);
    onError(null);
    try {
      const next = await updateTelegramConfig({
        botApi: { mode: "official", apiRoot: "https://api.telegram.org", localMode: false, localFileRoot: null },
      });
      onConfigChange(next);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  const doMigrate = async () => {
    onBusy(true);
    onError(null);
    setConfirmMigrate(false);
    try {
      await migrateBotApiServer(migrateRoot.trim());
      setMigrateRoot("");
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };

  return (
    <div>
      {/* Status card */}
      <div style={card}>
        <Row label="状态">
          <StatusBadge status={status.runtime.status} />
          {status.runtime.botUsername && (
            <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
              @{status.runtime.botUsername} · Leader: {status.runtime.leader ? "是" : "否"}
            </span>
          )}
        </Row>
        <Row label="启用">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => doSetEnabled(e.target.checked)}
            disabled={busy}
          />
          <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
            {config.enabled ? "已启用，Bot 正在接收消息" : "未启用，Bot 不会接收消息"}
          </span>
        </Row>
        <Row label="Token 来源">
          {status.tokenSource === "environment"
            ? "环境变量（只读）"
            : status.tokenSource === "local"
              ? "本地密钥文件"
              : "未配置"}
        </Row>
        <Row label="已授权用户">{status.userCount}</Row>
        <Row label="活动会话">{status.conversationCount}</Row>
        {status.runtime.errorCode && (
          <Banner kind="error">
            {status.runtime.errorCode}
            {status.runtime.error ? `：${status.runtime.error}` : ""}
            {status.runtime.nextRecoveryAt && (
              <RecoveryCountdown
                nextRecoveryAt={status.runtime.nextRecoveryAt}
                recoveryAttempt={status.runtime.recoveryAttempt}
              />
            )}
            <div style={{ marginTop: 6 }}>
              <button style={secondaryButtonStyle(busy)} onClick={doRestart} disabled={busy}>
                重新启动
              </button>
            </div>
          </Banner>
        )}
      </div>

      {/* Token card */}
      <div style={card}>
        <CardTitle>Bot Token</CardTitle>
        {status.tokenManagedByEnv ? (
          <Banner kind="warn">Bot Token 由环境变量 PI_HUB_TELEGRAM_BOT_TOKEN 管理，无法在此修改。</Banner>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                style={inputStyle}
                type={showToken ? "text" : "password"}
                placeholder="123456789:AA..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              <button style={secondaryButtonStyle()} onClick={() => setShowToken((v) => !v)}>
                {showToken ? "隐藏" : "显示"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={primaryButtonStyle(busy || !tokenInput.trim())}
                onClick={doSaveToken}
                disabled={busy || !tokenInput.trim()}
              >
                保存
              </button>
              {status.tokenSource === "local" && (
                <button style={secondaryButtonStyle(busy)} onClick={doDeleteToken} disabled={busy}>
                  清除
                </button>
              )}
              <button
                style={secondaryButtonStyle(busy || !status.configured)}
                onClick={doTest}
                disabled={busy || !status.configured}
              >
                测试连接
              </button>
            </div>
            {testResult && (
              <Banner kind="success">
                连接成功：@{testResult.bot.username} · {testResult.apiRoot}
                {testResult.localMode ? " · Local Mode" : ""}
              </Banner>
            )}
          </>
        )}
      </div>

      {/* Bot API Server card */}
      <div style={card}>
        <CardTitle>Telegram Bot API 服务</CardTitle>
        <div style={{ marginBottom: 8 }}>
          <label style={{ marginRight: 16, fontSize: 12 }}>
            <input
              type="radio"
              checked={config.botApi.mode === "official"}
              onChange={doSwitchOfficial}
              disabled={busy}
            />{" "}
            Telegram 官方服务
          </label>
          <label style={{ fontSize: 12 }}>
            <input
              type="radio"
              checked={config.botApi.mode === "self-hosted"}
              onChange={doSwitchSelfHosted}
              disabled={busy}
            />{" "}
            自建 Bot API Server
          </label>
        </div>
        {config.botApi.mode === "official" && !editingSelfHosted ? (
          <input style={inputStyle} value="https://api.telegram.org" readOnly />
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                ref={selfHostedInputRef}
                style={inputStyle}
                placeholder="https://tg-api.example.com"
                value={selfHostedRoot}
                onChange={(e) => setSelfHostedRoot(e.target.value)}
              />
              <button
                style={secondaryButtonStyle(busy || !selfHostedRoot.trim())}
                onClick={doSaveBotApi}
                disabled={busy || !selfHostedRoot.trim()}
              >
                保存地址
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                style={inputStyle}
                placeholder="（可选）测试另一个地址"
                value={testApiRoot}
                onChange={(e) => setTestApiRoot(e.target.value)}
              />
              <button style={secondaryButtonStyle(busy)} onClick={doTest} disabled={busy}>
                测试
              </button>
            </div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0" }}>
              切换服务地址不会自动调用 logOut。从 Telegram 官方云迁移到自建服务时，请使用下方的迁移功能。
            </p>
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
              <strong style={{ fontSize: 12, display: "block", marginBottom: 6 }}>从官方服务迁移</strong>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={inputStyle}
                  placeholder="https://tg-api.example.com"
                  value={migrateRoot}
                  onChange={(e) => setMigrateRoot(e.target.value)}
                />
                <button
                  style={primaryButtonStyle(busy || !migrateRoot.trim() || !status.configured)}
                  onClick={() => setConfirmMigrate(true)}
                  disabled={busy || !migrateRoot.trim() || !status.configured}
                >
                  迁移
                </button>
              </div>
              {confirmMigrate && (
                <div style={{ marginTop: 8 }}>
                  <Banner kind="warn">
                    此操作会在 Telegram 官方 Bot API 服务上调用 logOut。完成后，该 Bot 将由配置的自建 Bot API Server
                    接管。请确认自建服务已经启动。
                  </Banner>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={primaryButtonStyle(busy)} onClick={doMigrate} disabled={busy}>
                      确认迁移
                    </button>
                    <button style={secondaryButtonStyle(busy)} onClick={() => setConfirmMigrate(false)} disabled={busy}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Notification settings card */}
      <div style={card}>
        <CardTitle>通知设置</CardTitle>
        <Row label="允许所有工作空间">
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={config.allowAllWorkspaceNotifications}
              onChange={(e) => doToggleAllowAllWorkspaces(e.target.checked)}
              disabled={busy}
            />
            <span>
              开启后，任务完成通知会发送给所有已授权的会话，不再校验产生 Session 的工作目录与会话绑定的工作空间是否一致。
            </span>
          </label>
        </Row>
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0" }}>
          默认开启：通知会发送给所有已授权会话（与机器人最初的行为一致）。关闭后，仅当产生 Session
          的工作目录与会话绑定的工作空间一致时才发送通知，按目录精确匹配（同一仓库的工作树目录会被视为不同工作空间）。
        </p>
      </div>

      {/* Pairing card */}
      <div style={card}>
        <CardTitle>用户配对</CardTitle>
        <button style={primaryButtonStyle(busy)} onClick={doIssuePairing} disabled={busy}>
          生成配对码
        </button>
        {pairing && (
          <div style={{ marginTop: 8 }}>
            <Banner kind="success">
              配对码：<code style={{ fontSize: 16, fontWeight: "bold" }}>{pairing.code}</code>
              <br />
              角色：{pairing.role} · 过期时间：{new Date(pairing.expiresAt).toLocaleString()}
              <br />
              请在 Telegram 中向 Bot 发送：<code>/pair {pairing.code}</code>
            </Banner>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)", minWidth: 90 }}>{label}</span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: TelegramStatusDto["runtime"]["status"] }) {
  const color =
    status === "running"
      ? "#16a34a"
      : status === "error"
        ? "#ef4444"
        : status === "standby"
          ? "#d97706"
          : "var(--text-muted)";
  return (
    <span style={{ padding: "2px 8px", borderRadius: 10, background: `${color}22`, color, fontSize: 11 }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------

function UsersTab({
  users,
  busy,
  onBusy,
  onError,
  onChanged,
}: {
  users: TelegramUserDto[];
  busy: boolean;
  onBusy: (b: boolean) => void;
  onError: (e: string | null) => void;
  onChanged: () => void;
}) {
  if (users.length === 0) {
    return <EmptyState>尚未有用户配对。请在「配置与状态」中生成配对码。</EmptyState>;
  }
  return (
    <div style={card}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={th}>User ID</th>
            <th style={th}>Username</th>
            <th style={th}>角色</th>
            <th style={th}>启用</th>
            <th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <UserRow key={u.telegramUserId} u={u} busy={busy} onBusy={onBusy} onError={onError} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({
  u,
  busy,
  onBusy,
  onError,
  onChanged,
}: {
  u: TelegramUserDto;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onError: (e: string | null) => void;
  onChanged: () => void;
}) {
  const [role, setRole] = useState(u.role);
  const setEnabled = async (enabled: boolean) => {
    onBusy(true);
    onError(null);
    try {
      await updateTelegramUser(u.telegramUserId, { enabled });
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };
  const saveRole = async () => {
    onBusy(true);
    onError(null);
    try {
      await updateTelegramUser(u.telegramUserId, { role });
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };
  const remove = async () => {
    onBusy(true);
    onError(null);
    try {
      await deleteTelegramUser(u.telegramUserId);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  };
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={td}>{u.telegramUserId}</td>
      <td style={td}>{u.username ? `@${u.username}` : u.displayName ?? "—"}</td>
      <td style={td}>
        <select style={inputStyle} value={role} onChange={(e) => setRole(e.target.value as typeof role)} disabled={busy}>
          <option value="owner">owner</option>
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
        </select>
        {role !== u.role && (
          <button
            style={{ ...secondaryButtonStyle(busy), marginLeft: 4, padding: "2px 6px", fontSize: 12 }}
            onClick={saveRole}
            disabled={busy}
          >
            保存
          </button>
        )}
      </td>
      <td style={td}>
        <input type="checkbox" checked={u.enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
      </td>
      <td style={td}>
        <button
          style={{ ...secondaryButtonStyle(busy), padding: "2px 6px", fontSize: 12 }}
          onClick={remove}
          disabled={busy}
        >
          删除
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Conversations tab
// ---------------------------------------------------------------------------

function ConversationsTab({
  conversations,
  busy,
  onBusy,
  onError,
  onChanged,
}: {
  conversations: TelegramConversationDto[];
  busy: boolean;
  onBusy: (b: boolean) => void;
  onError: (e: string | null) => void;
  onChanged: () => void;
}) {
  if (conversations.length === 0) {
    return <EmptyState>尚无 Telegram 会话。在 Telegram 中向 Bot 发送消息后将自动创建。</EmptyState>;
  }
  return (
    <div style={card}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={th}>Chat</th>
            <th style={th}>Session</th>
            <th style={th}>状态</th>
            <th style={th}>更新时间</th>
            <th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {conversations.map((c) => (
            <tr key={`${c.chatId}-${c.threadId}`} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={td}>
                {c.chatId}
                {c.threadId ? ` · topic ${c.threadId}` : ""}
              </td>
              <td style={td}>{c.activeSessionId ? c.activeSessionId.slice(0, 8) : "—"}</td>
              <td style={td}>{c.state}</td>
              <td style={td}>{new Date(c.updatedAt).toLocaleString()}</td>
              <td style={td}>
                <button
                  style={{ ...secondaryButtonStyle(busy), padding: "2px 6px", fontSize: 12 }}
                  disabled={busy}
                  onClick={async () => {
                    onBusy(true);
                    onError(null);
                    try {
                      await deleteTelegramConversation(`${c.chatId}::${c.threadId}`);
                      await onChanged();
                    } catch (e) {
                      onError(e instanceof Error ? e.message : String(e));
                    } finally {
                      onBusy(false);
                    }
                  }}
                >
                  解除绑定
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--text-muted)", padding: 24, textAlign: "center", fontSize: 12 }}>{children}</div>;
}

const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 500, fontSize: 11 };
const td: React.CSSProperties = { padding: "6px 8px", verticalAlign: "middle" };
