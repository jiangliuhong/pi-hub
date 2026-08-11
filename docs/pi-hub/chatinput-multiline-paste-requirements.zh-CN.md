# ChatInput 多行输入与粘贴修复 — 需求文档

- 状态：待实现（Draft）
- 影响组件：`components/ChatInput.tsx`（upstream pi-web 组件）
- 关联文件：`components/ChatWindow.tsx`、`app/globals.css`、`hooks/useViewportHeight.ts`
- 关联测试：`components/ChatInput.test.mjs`、`components/ChatInput.dormancy.test.mjs`、`hooks/useViewportHeight.test.mjs`
- 适用规则：`AGENTS.md`（upstream pi-web 开发约束）、`AGENTS.local.md`（Pi Hub 扩展约束）
- 目标平台：macOS（浏览器 + Pi Hub Desktop WebView）、iOS（Safari / PWA / Desktop WebView）、普通桌面/移动浏览器

---

## 1. 背景与现象

打开任意 Pi Hub workspace 后，对话输入框（`ChatInput` 内的受控 `<textarea>`）在多行输入/粘贴场景下出现异常：

| 编号 | 现象 |
|------|------|
| SYM-1 | 多行文本在输入框中显示异常（被裁剪、高度不跟随、内容溢出不可见）。 |
| SYM-2 | 粘贴多行文本后，文本不显示或部分内容丢失。 |
| SYM-3 | 同一剪贴板同时包含文本和图片时，文本被丢弃，只留下图片附件。 |
| SYM-4 | 现象在普通浏览器、macOS、iOS、以及 Pi Hub Desktop 内嵌 WebView/iframe 之间表现不一致。 |

---

## 2. 范围与约束

### 2.1 必须遵守的工程规则

- `AGENTS.local.md` §1 / §18：`ChatInput.tsx` 属于 upstream pi-web 文件，**修改必须最小化、局部化**。优先把可测试的纯逻辑抽到**新文件**（例如 `lib/chat-input-paste.ts` 或 `hooks/useAutoResizeTextarea.ts`），事件粘合层保持薄。
- `AGENTS.local.md` §12：不新增非必要依赖；本修复**禁止**新增 npm 依赖。
- `AGENTS.local.md` §16：新逻辑应有不依赖完整浏览器 UI 的测试。
- `AGENTS.md`：不得改变消息发送协议、服务端 API、`AgentSession` 生命周期、SSE/会话行为。

### 2.2 必须保持不变的行为（不变量）

以下既有行为**禁止回归**，实现前需逐条确认未被破坏：

- INV-1 Enter 发送、Shift+Enter 换行（`handleKeyDown` 中的 Enter 分支）。
- INV-2 IME 输入：`isComposingRef` / `lastCompositionEndAtRef` / `COMPOSITION_END_ENTER_GRACE_MS` 的合成期判断，中文/日文/韩文输入回车不误触发发送。
- INV-3 流式状态（`isStreaming`）下的行为：Enter 走 steer / followUp，Esc 中止，输入框占位符切换。
- INV-4 `@` 文件补全、`/` 斜杠命令、`ArrowUp` 历史记录菜单。
- INV-5 草稿持久化（`draft-store` 的 value/images 读写与切换 `draftKey` 的迁移）。
- INV-6 图片附件限制：`MAX_ATTACHED_IMAGES`、`MAX_ATTACHED_IMAGE_BYTES`、`isBase64ImageWithinLimits`、`processImageFiles` 的并发计数（`pendingImageCountRef`）。
- INV-7 移动端 viewport 行为：`hooks/useViewportHeight.ts` 的 `--app-viewport-height`、`app/globals.css` 中 textarea `font-size:16px`（防止 iOS 聚焦缩放）。
- INV-8 图片粘贴的既有处理路径不回归（仅图片时仍走附件流程）。

### 2.3 明确不做的事

- 不记录剪贴板内容（不写入任何日志、localStorage、服务端）。
- 不修改 Pi Hub Desktop（本需求仅约束 Web 侧）。
- 不改变消息发送协议或服务端 API。
- 不引入新的 UI 框架或第三方库。

---

## 3. 根因分析（待实现者在各平台验证）

> 以下为基于当前代码的可疑交互点，作为调查起点，而非已证实的单一根因。
> 实现者需在 macOS Safari/Chrome、iOS Safari/PWA、Pi Hub Desktop WebView 三类环境下逐项复现并确认。

### 3.1 当前相关代码

**粘贴处理（`handlePaste`）：**

```tsx
const handlePaste = useCallback((e: React.ClipboardEvent) => {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  if (!imageItems.length) return;          // 纯文本：不阻止默认行为
  e.preventDefault();                        // 含图片：阻止默认行为
  const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
  processImageFiles(files);                  // 仅处理图片，文本被丢弃
}, [processImageFiles]);
```

**高度重算有两处独立来源：**

```tsx
// 来源 A：onInput（输入/粘贴时同步触发）
const handleInput = useCallback(() => {
  const ta = textareaRef.current;
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}, []);

// 来源 B：value 变更后的 effect
useEffect(() => {
  const ta = textareaRef.current;
  if (!ta) return;
  ta.style.height = "auto";
  if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}, [value]);
```

**textarea 是受控组件：** `value={value}`，`onChange` 内 `setValue(e.target.value)`，样式 `minHeight:24, maxHeight:200, overflow:"auto", resize:"none", rows:1`。

### 3.2 可疑交互点

- **R-1（SYM-3 主因，确定性 bug）**：`handlePaste` 只要检测到任意 `image/*` 项就 `preventDefault()`，随后**只**处理图片。当剪贴板同时携带 `text/plain` 与 `image/*`（部分应用截图/复制富文本的常见情形）时，文本被无条件丢弃。这是确定的逻辑缺陷，不依赖平台。
- **R-2（SYM-1 / SYM-2，平台相关）**：`handleInput` 在 `onInput` 中**同步**执行 `height="auto"` 再读 `scrollHeight`。在部分 WebView/移动端浏览器中，粘贴瞬间布局尚未稳定，`scrollHeight` 可能基于旧内容返回，导致 textarea 停在 `minHeight:24`，多行内容被裁剪（`overflow:auto` 可滚动但视觉上“没显示”）。来源 A（同步）与来源 B（`useEffect([value])` 异步）的时序不一致会放大该问题。
- **R-3（SYM-2，受控组件竞态）**：若实现选择“手动插入文本”（如 `setRangeText` / `document.execCommand('insertText')` / 重建字符串后 `setValue`），必须在**同一渲染周期**内同步更新 React state，否则受控 `value` 会在下一次协调时回退手动插入的文本，表现为“文本已插入但又被 React 覆盖”。纯文本路径当前依赖浏览器默认 + `onChange`，在标准浏览器正确，但在嵌入式 WebView 中默认粘贴可能以 `beforeinput`/composition 形式到达而被受控值回退。
- **R-4（重复插入风险）**：若实现既 `preventDefault()` 又手动插入文本，且未阻止浏览器默认或未在 state 中避免重复累加，会出现文本重复。需保证“默认粘贴”与“手动插入”二选一，互斥。
- **R-5（iOS / 移动端）**：粘贴瞬间同步修改 `style.height` 可能干扰 IME 合成与光标；iOS WKWebView 在受控 textarea + 即时 style 变更下尤其脆弱，需结合 `useViewportHeight` 与 `requestAnimationFrame` 延迟到提交后重算。

---

## 4. 功能需求

### FR-1 纯文本粘贴

| ID | 要求 |
|----|------|
| FR-1.1 | 多行文本必须完整保留，所有 `\n` 换行符不得丢失或被替换为空格。 |
| FR-1.2 | 粘贴必须**正确替换当前选区**（`selectionStart`..`selectionEnd`），不得只追加到末尾。 |
| FR-1.3 | 粘贴后光标位置应位于**插入文本之后**（`selectionStart + inserted.length`）。 |
| FR-1.4 | 粘贴后 React state 必须与 DOM 同步：不得出现“文本已插入但被受控 `value` 覆盖”的情况（R-3）。 |
| FR-1.5 | 单行/空选区粘贴保持与现状一致。 |
| FR-1.6 | 不修改剪贴板原始内容；不读取除粘贴所需 `text/plain` 之外的其它剪贴板类型用于其它目的。 |

### FR-2 文本与图片同时粘贴

| ID | 要求 |
|----|------|
| FR-2.1 | 剪贴板同时包含文本与图片时，**文本不得丢失**，需按 FR-1 规则插入。 |
| FR-2.2 | 图片仍按现有 `processImageFiles` 逻辑作为附件处理（受 INV-6 限制约束）。 |
| FR-2.3 | 不得因“检测到图片”就无条件 `preventDefault()` 并丢弃文本（修复 R-1）。 |
| FR-2.4 | 必须避免浏览器默认文本粘贴与手动插入同时执行导致**文本重复**（修复 R-4）。建议策略：当存在文本时，由实现接管文本插入（`preventDefault` 后手动 `setValue` 并同步光标），图片走附件；当仅图片时保持现状。 |
| FR-2.5 | 仅图片剪贴板的行为与现状完全一致（INV-8）。 |

### FR-3 多行展示与高度

| ID | 要求 |
|----|------|
| FR-3.1 | 输入或粘贴多行文本后，textarea 高度应**自动扩展**以适应内容。 |
| FR-3.2 | 高度上限为 **200px**，超过后通过 textarea 自身滚动（`overflow:auto`，现状已具备）。 |
| FR-3.3 | 删除内容（含清空、`clearInput`、`replaceMessage`、`applyHistoryInput`、`applySlashCommand`、`applyAtCompletion`、`insertText` 等所有改写 value 的路径）后，高度应**收缩恢复**（`value` 为空时回到 `minHeight:24` / `rows:1`）。 |
| FR-3.4 | 高度重算必须对当前所有改写 value 的入口生效，不得只修 `onPaste` 一处而遗漏其它入口。 |
| FR-3.5 | 兼容移动端键盘与 iOS viewport：高度重算不得在合成期（`isComposing`）或布局未稳定时同步触发导致抖动/光标跳动；优先在 state 提交后（`useEffect([value])` 或 `requestAnimationFrame`）重算（缓解 R-2 / R-5）。 |
| FR-3.6 | 不得改变 Enter 发送、Shift+Enter 换行、IME 输入、流式状态下的既有行为（INV-1 / INV-2 / INV-3）。 |

---

## 5. 非功能需求 / 安全

| ID | 要求 |
|----|------|
| NFR-1 | 不记录、不上报、不持久化剪贴板内容。粘贴处理仅读取当前事件 `clipboardData` 用于即时插入。 |
| NFR-2 | 不新增任何 npm 依赖（运行时或开发时）。 |
| NFR-3 | 不修改 Pi Hub Desktop 任何代码或配置。 |
| NFR-4 | 不修改消息发送协议、`/api/agent/*`、`/api/sessions/*` 等服务端 API。 |
| NFR-5 | 对 upstream `ChatInput.tsx` 的改动遵循 `AGENTS.local.md` §18 清单：localized、保留既有行为、不重复 upstream 逻辑、必要时文档化。可测试纯逻辑优先抽到新文件。 |
| NFR-6 | 不引入 `dangerouslySetInnerHTML`、`eval`、动态字符串样式注入等不安全模式。 |

---

## 6. 测试需求

测试遵循仓库既有模式（`node --test` + `jiti`，组件用 `renderToStaticMarkup` SSR，纯函数直接导入）。
为便于在不启动浏览器的情况下测试，**建议把可测逻辑抽为纯函数**（见 §7 实现建议），并新增对应 `*.test.mjs`。

至少覆盖以下用例（每条对应一个 FR / INV）：

| 测试 ID | 覆盖 | 描述 |
|---------|------|------|
| T-1 | FR-1.1 / FR-1.2 | 纯多行文本粘贴：换行符保留，选区被正确替换（非追加到末尾）。 |
| T-2 | FR-1.2 | 文本粘贴到选区：选中区间 `[s,e)` 被替换，前后文本保留。 |
| T-3 | FR-1.3 | 粘贴后光标位置 = `start + inserted.length`。 |
| T-4 | FR-2.1 / FR-2.4 | 文本与图片同时粘贴：文本被插入且**不重复**；图片计入附件（可对纯逻辑函数断言“文本插入分支被调用一次”）。 |
| T-5 | FR-2.5 / INV-8 | 仅图片粘贴：文本插入分支不触发，图片走附件处理（行为不回归）。 |
| T-6 | FR-3.1 / FR-3.3 | 粘贴/输入后高度更新；删除内容后高度恢复（对高度计算纯函数断言：`clampHeight(scrollHeight)` 在大值返回 200，在小/零内容返回最小高度）。 |
| T-7 | INV-2 | IME：合成期内 Enter 不触发发送、不拦截合成（复用既有 `handleKeyDown` 逻辑的等价纯判断，或断言合成态下粘贴不破坏合成）。 |
| T-8 | INV-1 | Enter 发送 / Shift+Enter 换行不回归（既有行为未被改动）。 |
| T-9 | FR-1.4 / R-3 | 受控同步：手动插入文本后，React state 与插入值一致（对“插入并返回新 value + 光标”的纯函数断言返回值正确）。 |
| T-10 | FR-2.3 / R-1 | 含图片时不得无条件丢弃文本：断言“有文本项”时进入文本插入分支。 |

> 注：SSR（`renderToStaticMarkup`）无法触发真实 paste 事件或测量 `scrollHeight`。因此**运行时事件处理与高度测量应尽量薄**，核心逻辑（选区替换、光标计算、高度钳制、文本/图片分支判定）抽为纯函数后单测；事件粘合通过等价纯函数覆盖 + 代码审查保证。

---

## 7. 实现建议（非约束，供参考）

以下方案可在满足 upstream 最小改动与可测性之间取得平衡，实现者可酌情调整：

1. **新增纯逻辑模块** `lib/chat-input-paste.ts`（或类似），导出：
   - `applyPastedText(value, selStart, selEnd, text) => { value, caret }` — 替换选区、保留换行、计算新光标。
   - `classifyClipboard(items) => { hasText, text, imageFiles }` — 区分纯文本 / 含图片 / 仅图片。
   - （可选）`clampTextareaHeight(scrollHeight, min=24, max=200) => number`。
2. **改写 `handlePaste`**：用上述纯函数判定——
   - 仅图片：保持现状（`preventDefault` + `processImageFiles`）。
   - 含文本：`preventDefault` 后用 `applyPastedText` 计算新 value 与光标，`setValue` 后在 `requestAnimationFrame` 内 `setSelectionRange` 并重算高度；图片同时走附件（受 INV-6 限制）。
   - 纯文本：可继续走默认 + `onChange`（标准浏览器正确），或为统一 WebView 行为也由实现接管。需保证不与默认粘贴重复（R-4）。
3. **统一高度重算**：考虑把 `handleInput` 的同步重算与 `useEffect([value])` 合并到单一来源（优先 effect / rAF），消除 R-2 的时序分歧；确保所有改写 value 的入口（含 `clearInput`、`insertText` 等）共享同一重算路径。
4. **抽取高度 hook（可选）** `hooks/useAutoResizeTextarea.ts`，封装 `ref` + `value` 监听 + 高度钳制，便于单测与复用，减少对 upstream 文件的扩散改动。

实现时对照 §3.2 的 R-1..R-5 逐条确认已消除。

---

## 8. 验收标准

满足以下全部条件视为通过：

- AC-1 FR-1.1 ~ FR-1.6 全部成立（macOS / iOS / 普通浏览器）。
- AC-2 FR-2.1 ~ FR-2.5 全部成立，混合粘贴文本不丢失、不重复，仅图片不回归。
- AC-3 FR-3.1 ~ FR-3.6 全部成立，高度扩展/收缩正确，移动端不抖动。
- AC-4 §2.2 所有不变量（INV-1 ~ INV-8）未被破坏。
- AC-5 §6 全部测试用例（T-1 ~ T-10）实现并通过。
- AC-6 §5 所有非功能要求（NFR-1 ~ NFR-6）满足，无新增依赖。
- AC-7 对 `components/ChatInput.tsx` 的改动经 `AGENTS.local.md` §18 清单复核通过（localized、必要、不重复 upstream 逻辑）。

---

## 9. 验证命令

实现完成后需运行并报告结果（无法运行需说明原因）：

```bash
# 与 ChatInput 相关的测试
node --experimental-strip-types --test "components/ChatInput.test.mjs" "components/ChatInput.dormancy.test.mjs"

# 仓库规定测试命令
npm test

# Lint
npm run lint

# Typecheck
npm run typecheck
```

注意：

- 不得运行 `AGENTS.md` 明确禁止的命令（如开发期 `next build`）。
- `npm test` 通过 `package.json` 中 glob 收集 `app/components/hooks/lib/modules/public` 下的 `*.test.mjs`。

---

## 10. 平台兼容性说明（Desktop WebView / iframe）

本需求的现场报告来自 Pi Hub Desktop 内嵌 WebView/iframe（见 `docs/pi-hub/pi-hub-embed-contract-v1.md` 的 iframe 嵌入模型）。需明确：

- 本需求**仅约束 Web 侧**实现，使输入框在标准浏览器、macOS WebView、iOS WKWebView 下表现一致。
- Pi Hub Desktop 侧是否仍需额外 WebView/iframe 兼容处理（如剪贴板权限、安全上下文下的 `clipboardData` 可见性、`beforeinput`/`paste` 事件透传策略），由实现者在三类环境复现后给出结论：
  - 若 Web 侧修复后 Desktop WebView 仍复现，则在交付说明中**明确列出** Desktop 侧仍需处理的项，作为后续 Desktop 任务，不在本需求范围内实现（NFR-3）。
  - 若 Web 侧修复已使 Desktop WebView 行为正常，则在交付说明中注明“无需 Desktop 侧额外改动”。

---

## 11. 交付物

实现者需交付并报告：

- D-1 修改/新增的文件清单（区分 upstream 文件的最小改动与新文件）。
- D-2 根因结论：对 §3.2 的 R-1..R-5 逐条确认是否为实际根因，及在 macOS / iOS / 普通浏览器的复现结果。
- D-3 测试结果：§9 四项命令的输出摘要与通过情况。
- D-4 §10 的 Desktop WebView/iframe 兼容性结论。
- D-5 与 `AGENTS.local.md` §18 upstream 改动清单的对照说明。
