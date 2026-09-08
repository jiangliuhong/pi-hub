# Pi Web

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/jiangliuhong/pi-hub/main/docs/screenshot2.png)

## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Quick Start

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @jarome/pi-hub@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30142](http://127.0.0.1:30142). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-hub` command globally:

```bash
npm install -g @jarome/pi-hub@latest
pi-hub
```

To update, stop the running process with `Ctrl+C` and run the same install command again. To uninstall, run `npm uninstall -g @jarome/pi-hub`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_HUB_NO_OPEN=1` disables automatic browser opening. Run `pi-hub --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30142` |
| `--hostname <host>`, `-H <host>`, or `PI_HUB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_HUB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_HUB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_HUB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_HUB_PASSWORD` | Enable HTTP Basic Auth; the username is always `pi` | Authentication disabled |
| `PI_HUB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |

For example:

```bash
pi-hub --help
pi-hub -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. On a trusted LAN, require a long random password:

```bash
PI_HUB_PASSWORD='a-long-random-password' pi-hub --hostname 0.0.0.0
```

Basic Auth does not encrypt the password in transit. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_HUB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

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

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-hub:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-hub:session-row-contextmenu", (event) => {
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

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

```js
const liveness = globalThis[Symbol.for("@jarome/pi-hub/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30142](http://127.0.0.1:30142). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)

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
