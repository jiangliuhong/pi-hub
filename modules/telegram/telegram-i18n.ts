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
      { command: "abort", description: "Stop the current run" },
      { command: "retry", description: "Retry the last prompt" },
      { command: "tasks", description: "List scheduled tasks" },
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
    { command: "abort", description: "停止当前执行" },
    { command: "retry", description: "重试上一次 Prompt" },
    { command: "tasks", description: "查看定时任务" },
    { command: "run", description: "立即执行任务" },
    { command: "lang", description: "切换语言" },
  ];
}
