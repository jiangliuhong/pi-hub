/**
 * Telegram message strings.
 *
 * Default locale is zh-CN (design doc §14.4 — command descriptions and default
 * responses are Chinese). English is provided as a fallback. Command *names*
 * are always ASCII lowercase (Telegram requirement); only the text varies.
 */

export type Locale = "zh-CN" | "en";

interface Strings {
  notPaired: string;
  start: (botUsername: string) => string;
  help: string;
  pairPrompt: string;
  pairSuccess: (role: string) => string;
  pairInvalid: string;
  pairExpired: string;
  pairAlreadyUsed: string;
  statusBot: (status: string) => string;
  statusDisabled: string;
  privateOnly: string;
  chatNotAllowed: string;
  rateLimited: string;
  featureNotReady: string;
  callbackExpired: string;
  workspaceHeader: string;
  workspaceEmpty: string;
  workspaceSwitched: (name: string) => string;
  workspaceReady: (name: string) => string;
  // /sessions
  sessionsTitle: string;
  sessionsEmpty: string;
  sessionsNoWorkspace: string;
  sessionsSwitched: (name: string) => string;
  sessionsPage: (n: number, total: number) => string;
  sessionsPrev: string;
  sessionsNext: string;
  /** Generic pagination labels, shared by /sessions and /model. */
  pagePrev: string;
  pageNext: string;
  sessionsBusy: string;
  sessionsUnnamed: string;
  // /context
  contextTitle: string;
  contextNoSession: string;
  contextModel: string;
  contextThinking: string;
  contextMessages: string;
  contextUsage: (percent: number, tokens: number, window: number) => string;
  contextCompacting: string;
  contextIdle: string;
  contextAutoCompact: (on: boolean) => string;
  contextDefault: string;
  contextUnknown: string;
  // /model
  modelTitle: string;
  modelCurrent: string;
  modelAvailable: string;
  modelDefault: string;
  modelSwitched: (name: string) => string;
  modelInvalid: string;
  modelBusy: string;
  // /commands
  commandsTitle: string;
  commandsGroupBasic: string;
  commandsGroupSession: string;
  commandsGroupRun: string;
  commandsGroupTask: string;
}

const ZH_CN: Strings = {
  notPaired:
    "你尚未绑定 Pi Hub。\n\n请在 Pi Hub 网页端的「设置 → Telegram 集成」生成配对码，然后发送：\n/pair <6位配对码>",
  start: (botUsername: string) =>
    `已连接到 Pi Hub Bot @${botUsername}。\n\n我是你的移动端 Agent 入口。发送 /help 查看可用命令。`,
  help: [
    "Pi Hub Telegram 命令",
    "",
    "/start — 查看连接状态",
    "/help — 查看帮助",
    "/pair <code> — 使用配对码绑定用户",
    "/status — 查看 Pi Hub 状态",
    "/session — 查看当前 Session",
    "/new — 创建新 Session",
    "/workspace — 切换工作区",
    "/sessions — 浏览历史 Session",
    "/context — 查看当前会话上下文",
    "/model — 查看/切换模型",
    "/commands — 查看命令列表",
    "/abort — 停止当前执行",
    "/retry — 重试上一次 Prompt",
    "/tasks — 查看定时任务",
    "/run <id> — 立即执行任务",
    "/lang — 切换语言",
    "",
    "未配对用户只能使用 /start、/help、/pair。",
  ].join("\n"),
  pairPrompt: "请发送配对码：/pair <6位配对码>",
  pairSuccess: (role: string) =>
    `✅ 绑定成功！你的角色是：${roleLabel(role, "zh-CN")}`,
  pairInvalid: "❌ 配对码无效。",
  pairExpired: "❌ 配对码已过期，请重新生成。",
  pairAlreadyUsed: "❌ 配对码已被使用。",
  statusBot: (status: string) => `Pi Hub 状态：${status}`,
  statusDisabled: "Telegram 集成当前未启用。",
  privateOnly: "出于安全考虑，Pi Hub Bot 当前仅响应私聊。",
  chatNotAllowed: "此会话未授权。请在 Pi Hub 网页端授权该 Chat。",
  rateLimited: "请求过于频繁，请稍后再试。",
  featureNotReady: "该功能将在后续版本提供。",
  callbackExpired: "该按钮已过期，请重新打开菜单。",
  workspaceHeader: "选择工作区（点击切换）：",
  workspaceEmpty: "暂无可用工作区。请先在 Pi Hub 网页端创建一个 Session，然后重试。",
  workspaceSwitched: (name: string) => `✅ 已切换工作区：${name}`,
  workspaceReady: (name: string) => `已切换到工作区「${name}」。现在可以直接发送你的 Prompt 开始对话。`,
  sessionsTitle: "选择 Session（点击切换）：",
  sessionsEmpty: "该工作区暂无 Session。",
  sessionsNoWorkspace: "请先使用 /workspace 选择一个工作区。",
  sessionsSwitched: (name: string) => `✅ 已切换到会话「${name}」`,
  sessionsPage: (n: number, total: number) => `第 ${n}/${total} 页`,
  sessionsPrev: "◀ 上一页",
  sessionsNext: "下一页 ▶",
  pagePrev: "◀ 上一页",
  pageNext: "下一页 ▶",
  sessionsBusy: "当前会话正在执行，无法切换。",
  sessionsUnnamed: "（未命名）",
  contextTitle: "📋 会话上下文",
  contextNoSession: "当前没有绑定的 Session。",
  contextModel: "模型",
  contextThinking: "思考级别",
  contextMessages: "消息数",
  contextUsage: (percent: number, tokens: number, window: number) =>
    `上下文用量：${percent}%（${tokens}/${window}）`,
  contextCompacting: "压缩中",
  contextIdle: "空闲",
  contextAutoCompact: (on: boolean) => `自动压缩：${on ? "开" : "关"}`,
  contextDefault: "默认",
  contextUnknown: "未知",
  modelTitle: "选择模型（点击切换）：",
  modelCurrent: "当前模型",
  modelAvailable: "可用模型",
  modelDefault: "默认（跟随设置）",
  modelSwitched: (name: string) => `✅ 已切换模型：${name}`,
  modelInvalid: "无效的模型标识。请从列表中选择。",
  modelBusy: "当前会话正在执行，无法切换模型。",
  commandsTitle: "📚 命令列表",
  commandsGroupBasic: "基础",
  commandsGroupSession: "会话",
  commandsGroupRun: "运行",
  commandsGroupTask: "任务",
};

const EN: Strings = {
  notPaired:
    "You are not paired with Pi Hub.\n\nGenerate a pairing code in Pi Hub Web → Settings → Telegram, then send:\n/pair <6-digit-code>",
  start: (botUsername: string) =>
    `Connected to Pi Hub Bot @${botUsername}.\n\nI'm your mobile Agent entry point. Send /help for available commands.`,
  help: [
    "Pi Hub Telegram commands",
    "",
    "/start — show connection status",
    "/help — show help",
    "/pair <code> — pair with a Pi Hub code",
    "/status — show Pi Hub status",
    "/session — show current session",
    "/new — create a new session",
    "/workspace — switch workspace",
    "/sessions — browse sessions",
    "/context — show session context",
    "/model — show / switch model",
    "/commands — list commands",
    "/abort — stop the current run",
    "/retry — retry the last prompt",
    "/tasks — list scheduled tasks",
    "/run <id> — run a task now",
    "/lang — switch language",
    "",
    "Unpaired users can only use /start, /help, /pair.",
  ].join("\n"),
  pairPrompt: "Send your pairing code: /pair <6-digit-code>",
  pairSuccess: (role: string) => `✅ Paired successfully! Your role is: ${roleLabel(role, "en")}.`,
  pairInvalid: "❌ Invalid pairing code.",
  pairExpired: "❌ Pairing code expired. Please generate a new one.",
  pairAlreadyUsed: "❌ Pairing code already used.",
  statusBot: (status: string) => `Pi Hub status: ${status}`,
  statusDisabled: "Telegram integration is currently disabled.",
  privateOnly: "For security, the Pi Hub Bot only responds to private chats right now.",
  chatNotAllowed: "This chat is not authorized. Approve it in Pi Hub Web first.",
  rateLimited: "Too many requests. Please slow down.",
  featureNotReady: "This feature will arrive in a later release.",
  callbackExpired: "This button has expired. Please reopen the menu.",
  workspaceHeader: "Select a workspace (tap to switch):",
  workspaceEmpty: "No workspaces available. Create a session in Pi Hub Web first, then retry.",
  workspaceSwitched: (name: string) => `✅ Switched workspace: ${name}`,
  workspaceReady: (name: string) => `Switched to workspace "${name}". You can now send your prompt to start.`,
  sessionsTitle: "Select a session (tap to switch):",
  sessionsEmpty: "No sessions in this workspace.",
  sessionsNoWorkspace: "Please select a workspace first via /workspace.",
  sessionsSwitched: (name: string) => `✅ Switched to session "${name}"`,
  sessionsPage: (n: number, total: number) => `Page ${n}/${total}`,
  sessionsPrev: "◀ Prev",
  sessionsNext: "Next ▶",
  pagePrev: "◀ Prev",
  pageNext: "Next ▶",
  sessionsBusy: "A run is in progress; cannot switch now.",
  sessionsUnnamed: "(unnamed)",
  contextTitle: "📋 Session context",
  contextNoSession: "No session is currently bound.",
  contextModel: "Model",
  contextThinking: "Thinking",
  contextMessages: "Messages",
  contextUsage: (percent: number, tokens: number, window: number) =>
    `Context usage: ${percent}% (${tokens}/${window})`,
  contextCompacting: "compacting",
  contextIdle: "idle",
  contextAutoCompact: (on: boolean) => `Auto-compact: ${on ? "on" : "off"}`,
  contextDefault: "default",
  contextUnknown: "unknown",
  modelTitle: "Select a model (tap to switch):",
  modelCurrent: "Current model",
  modelAvailable: "Available models",
  modelDefault: "default (follows settings)",
  modelSwitched: (name: string) => `✅ Switched model: ${name}`,
  modelInvalid: "Invalid model id. Pick one from the list.",
  modelBusy: "A run is in progress; cannot switch model.",
  commandsTitle: "📚 Command list",
  commandsGroupBasic: "Basic",
  commandsGroupSession: "Session",
  commandsGroupRun: "Run",
  commandsGroupTask: "Task",
};

const CATALOGS: Record<Locale, Strings> = {
  "zh-CN": ZH_CN,
  en: EN,
};

/** Resolves a locale tag to a supported one (falls back to zh-CN). */
export function resolveLocale(tag: string | null | undefined): Locale {
  if (!tag) return "zh-CN";
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en";
  return "zh-CN";
}

export function strings(locale: Locale): Strings {
  return CATALOGS[locale] ?? ZH_CN;
}

function roleLabel(role: string, locale: Locale): string {
  const labels: Record<string, Record<Locale, string>> = {
    owner: { "zh-CN": "所有者", en: "Owner" },
    operator: { "zh-CN": "操作者", en: "Operator" },
    viewer: { "zh-CN": "只读", en: "Viewer" },
  };
  return labels[role]?.[locale] ?? role;
}

/** Bot command list for setMyCommands (§14.4). */
export function commandList(locale: Locale): { command: string; description: string }[] {
  if (locale === "en") {
    return [
      { command: "start", description: "Show connection status" },
      { command: "help", description: "Show help" },
      { command: "pair", description: "Pair with Pi Hub (code)" },
      { command: "status", description: "Show Pi Hub status" },
      { command: "session", description: "Show current session" },
      { command: "new", description: "Create a new session" },
      { command: "workspace", description: "Switch workspace" },
      { command: "sessions", description: "Browse sessions" },
      { command: "context", description: "Show session context" },
      { command: "model", description: "Show / switch model" },
      { command: "commands", description: "List commands" },
      { command: "abort", description: "Stop the current run" },
      { command: "retry", description: "Retry the last prompt" },
      { command: "tasks", description: "List scheduled tasks" },
      { command: "task", description: "Show task detail by id" },
      { command: "run", description: "Run a task by id" },
      { command: "lang", description: "Switch language" },
    ];
  }
  return [
    { command: "start", description: "查看连接状态" },
    { command: "help", description: "查看帮助" },
    { command: "pair", description: "使用配对码绑定用户" },
    { command: "status", description: "查看 Pi Hub 状态" },
    { command: "session", description: "查看当前 Session" },
    { command: "new", description: "创建新 Session" },
    { command: "workspace", description: "切换工作区" },
    { command: "sessions", description: "浏览历史 Session" },
    { command: "context", description: "查看会话上下文" },
    { command: "model", description: "查看 / 切换模型" },
    { command: "commands", description: "查看命令列表" },
    { command: "abort", description: "停止当前执行" },
    { command: "retry", description: "重试上一次 Prompt" },
    { command: "tasks", description: "查看定时任务" },
    { command: "task", description: "查看任务详情" },
    { command: "run", description: "立即执行任务" },
    { command: "lang", description: "切换语言" },
  ];
}
