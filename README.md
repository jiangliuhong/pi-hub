# Pi Web

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **English and Simplified Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Quick Start

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @jarome/pi-hub@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-web` command globally:

```bash
npm install -g @jarome/pi-hub
pi-hub
```

Then open [http://127.0.0.1:30142](http://127.0.0.1:30142). The CLI will try to open the browser automatically after the server is ready. Pi Web listens on `127.0.0.1` by default.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Enable HTTP Basic Auth; the username is always `pi` | Authentication disabled |

For example:

```bash
pi-hub --port 8080              # custom port
pi-hub --hostname 0.0.0.0       # expose on a trusted network
pi-hub -p 8080 -H 0.0.0.0       # combine options
pi-hub --no-open                # do not open the browser automatically

PORT=8080 pi-hub                # environment variable is also supported
PI_HUB_HOSTNAME=0.0.0.0 pi-hub  # explicit network exposure
PI_HUB_ALLOWED_HOSTS=pi-hub.internal pi-hub  # allow an exact proxy/custom hostname
PI_HUB_PASSWORD='a-long-random-password' pi-hub  # require Basic Auth (username: pi)
PI_HUB_NO_OPEN=1 pi-hub         # useful when running as a background service
```

> Environment variables can be prefixed with either `PI_HUB_` (preferred) or `PI_WEB_` (legacy, for backward compatibility with upstream pi-web).

### Machine-readable version and health checks

Pi Hub exposes two stable, JSON-only commands for automation, Desktop hosts, and CI. Neither starts an HTTP server, opens a port, opens a browser, calls a model API, refreshes OAuth, or makes any network request.

```bash
pi-hub --version --json
```

```json
{"schemaVersion":1,"name":"@jarome/pi-hub","version":"0.0.8"}
```

```bash
pi-hub doctor --json --offline
```

```json
{"schemaVersion":1,"status":"healthy","checks":[{"name":"nodeVersion","status":"pass","detail":"24.10.0"},...]}
```

`doctor` writes JSON to **stdout** when healthy and to **stderr** otherwise; the exit code is always the source of truth:

| Exit code | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `0`       | `--version` success, or `doctor` healthy.                               |
| `2`       | Argument/usage error (unknown flag, missing `--json`/`--offline`).      |
| `3`       | `doctor`: blocked — Node too old, or Pi Hub home not writable.          |
| `4`       | `doctor`: degraded — usable, but some checks warn (e.g. no build).      |

Credentials and environment-variable values are never emitted; `doctor` only reports resolved directory paths and booleans for env-var presence. See [docs/pi-hub/pi-hub-cli-contract-v1.md](./docs/pi-hub/pi-hub-cli-contract-v1.md) for the full stable contract.

Set `PI_HUB_PASSWORD` to protect the web interface and every API endpoint with HTTP Basic Auth. The username is always `pi`. Leaving the variable unset or empty disables authentication.

Pi Web can invoke a high-privilege agent. Basic Auth does not encrypt the password in transit, so do not expose plain HTTP to the internet. Use HTTPS through a trusted reverse proxy or a trusted VPN for remote access.
API requests accept loopback names, IP literals, the selected bind hostname, and exact comma-separated names in `PI_HUB_ALLOWED_HOSTS`. Configure that variable when a trusted reverse proxy uses a different external hostname.

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

Basic Auth does not encrypt the password in transit. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_WEB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @jarome/pi-hub@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @jarome/pi-hub@latest
```

## Pi Hub extensions

Pi Hub extends the original Pi Web session workspace with Telegram integration and scheduled task execution. The related implementation can be found in `modules/scheduler/`, `modules/telegram/`, `app/api/scheduler/`, and `app/api/integrations/telegram/`.

### Scheduled tasks

Open **Tasks** from the sidebar, choose a working directory, enter the Agent instruction, and configure when it should run:

- **Daily**: repeat at a selected time and time zone;
- **Once**: run once at a specific date and time;
- **Resume an existing session**: use resume mode to continue an existing session instead of creating a new one, which is useful for scheduled follow-ups to a long-running task.

The task page previews the next execution time in both the selected time zone and UTC so that the schedule can be checked before saving it.

![Pi Hub scheduled task configuration](./docs/screenshots/task-scheduler.png)

### Telegram integration

Pi Hub can store a Telegram Bot Token and use either the official Telegram Bot API service or a self-hosted Bot API Server. After configuration, user pairing and session mapping can connect Telegram users to Pi Hub sessions so that an Agent session can be continued from Telegram.

When a scheduled task runs, Pi Hub can send Telegram notifications for task start, success, failure, and deferred retries. Notifications include the task details and session identifier so that the session can be located and operated again.

![Pi Hub Telegram integration configuration](./docs/screenshots/telegram-integration.png)

Use the TG entry in the main interface to check the Telegram integration status. After a task finishes, the notification entry also shows its execution result.

![Pi Hub task execution result notification](./docs/screenshots/pi-hub-task-notification.png)

## Features

- **Pick work back up**: browse previous pi conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Configure less from the terminal**: manage models, login/API keys, model tests, and skill switches from the web UI.
- **Use the interface in your language**: switch between the supported UI languages from the top bar.

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web preserves the
browser's native context menu. This hook is browser-side and independent of
Pi agent extensions.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://127.0.0.1:30142](http://127.0.0.1:30142).

Common checks:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/
  api/
    agent/          # creates/drives AgentSession and exposes SSE events
    auth/           # OAuth and API key management
    cwd/browse/     # browsable server directory listing
    cwd/validate/   # custom working directory validation
    default-cwd/    # pi default working directory lookup
    files/          # file listing, reading, preview, and watching
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json and test models
    sessions/       # session reads, rename, delete, context, HTML export
    skills/         # skill listing, search, install, enable/disable
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  DirectoryPicker.tsx # browsable and editable working-directory picker
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap
  ChatInput.tsx       # input bar, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
lib/
  directory-browser.ts # directory normalization and safe listing helpers
  http-dispatcher.ts  # HTTP(S) proxy setup for server-side fetch
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary
  file-paths.ts       # path encoding and relative path helpers
  markdown.ts         # Markdown/Mermaid/KaTeX plugin configuration
  pi-types.ts         # pi-related types
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
bin/
  pi-hub.js           # npm CLI entrypoint
instrumentation.ts    # initializes the server HTTP dispatcher
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)
