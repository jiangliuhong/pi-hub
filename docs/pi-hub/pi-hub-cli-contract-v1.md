# Pi Hub CLI Contract V1

- Status: implemented
- Contract versions: `version.schemaVersion = 1`, `doctor.schemaVersion = 1`
- Related code: `bin/pi-hub.js`, `bin/cli-dispatch.js`, `bin/version.js`, `bin/doctor.js`
- Related tests: `lib/version.test.mjs`, `lib/cli-dispatch.test.mjs`, `lib/doctor.test.mjs`

## 1. Goal

Provide a **stable, machine-readable CLI surface** so that downstream tools (Desktop hosts, package managers, CI, watchdogs) can inspect Pi Hub's version and health **without starting an HTTP server, opening a port, opening a browser, entering an interactive mode, calling a model API, refreshing OAuth, or making any network request**.

The two contracts in this document are **independent**: each has its own `schemaVersion`. A breaking change to one does not affect the other.

## 2. Non-varying invariants (apply to both commands)

- Argument parsing happens **before** the Next.js child process is spawned. `bin/cli-dispatch.js` is the first thing `bin/pi-hub.js` runs, and `cli-dispatch.js` never imports `child_process`.
- **stdout contains only the JSON document** terminated by a single newline. No log prefix, no banner, no progress text. Output is written with `process.stdout.write` (never `console.log`) so future loggers cannot intercept it.
- **stderr** is used only for human-facing usage/error messages and for doctor output when the status is not `healthy` (see §6). Downstream JSON parsers must read **stdout**.
- **No credentials, tokens, or environment-variable values** are ever emitted. Doctor reports resolved directory paths (the primary useful output) and booleans for env-var presence only.
- No shell string concatenation is used to build commands; the existing server launch uses `spawn(execPath, [args])` with `shell: false`.
- The version is read from the **installed package's** `package.json` (resolved via `__dirname`, not `process.cwd()`), so it always reflects the `@jarome/pi-hub` package being invoked.

## 3. `pi-hub --version --json`

### Invocation

```bash
pi-hub --version --json
# positional form is also accepted:
pi-hub version --json
```

### Output (stdout, stable field order)

```json
{"schemaVersion":1,"name":"@jarome/pi-hub","version":"0.0.8"}
```

| Field          | Type   | Meaning                                                       |
| -------------- | ------ | ------------------------------------------------------------- |
| `schemaVersion`| number | Always `1` for this contract. Bump only on a breaking change. |
| `name`         | string | The `name` field of the invoked package's `package.json`.     |
| `version`      | string | The `version` field of the invoked package's `package.json`.  |

### Semantics

- `--json` is accepted and is currently the **only** stable machine-readable form. Plain `pi-hub --version` (without `--json`) emits the **same** single-line JSON for now; a future human-readable form, if added, will be opt-in and will not change `--json` output.
- Exit code `0` on success.
- Exit code `2` if any other flag is present (e.g. `--version --bogus`).

### Backward compatibility

Adding fields is allowed without bumping `schemaVersion` (consumers must ignore unknown fields). Removing, renaming, or changing the meaning of `schemaVersion` / `name` / `version` requires bumping `schemaVersion`.

## 4. `pi-hub doctor --json --offline`

### Invocation

```bash
pi-hub doctor --json --offline
```

Both `--json` and `--offline` are **required**. The contract guarantees a single, stable, network-free, machine-readable result.

### Output (stable top-level field order)

On `healthy`, JSON is written to **stdout**. On `degraded` / `blocked`, JSON is written to **stderr** (so a stdout JSON parser sees nothing on failure and the exit code is the source of truth). The shape is identical either way:

```json
{
  "schemaVersion": 1,
  "status": "healthy",
  "checks": [
    { "name": "nodeVersion", "status": "pass", "detail": "24.10.0" },
    { "name": "piHubHome", "status": "pass", "detail": "/home/user/.pi/hub (writable: true)" },
    { "name": "piAgentHome", "status": "pass", "detail": "/home/user/.pi/agent (exists: true)" },
    { "name": "buildArtifacts", "status": "pass", "detail": "/opt/pi-hub/.next (exists: true)" },
    { "name": "envReport", "status": "pass", "detail": { "PI_HUB_HOME": false, "PI_HUB_HOSTNAME": false, "PI_HUB_PASSWORD": true, "PI_HUB_TELEGRAM_BOT_TOKEN": false, "PI_CODING_AGENT_DIR": false } },
    { "name": "telegramTokenSource", "status": "pass", "detail": "env" }
  ]
}
```

| Field          | Type   | Meaning                                            |
| -------------- | ------ | -------------------------------------------------- |
| `schemaVersion`| number | Always `1` for this contract.                      |
| `status`       | string | One of `healthy`, `degraded`, `blocked`.           |
| `checks`       | array  | Ordered list of individual checks (see §5).        |

### Exit codes

| Code | Status    | Meaning                                                                |
| ---- | --------- | ---------------------------------------------------------------------- |
| `0`  | healthy   | All checks pass.                                                       |
| `2`  | —         | Argument/usage error (missing `--json`/`--offline`, unknown flag).     |
| `3`  | blocked   | A blocking check failed (Node too old, or hub home not writable).      |
| `4`  | degraded  | No blocking failure, but ≥ 1 warning (missing build artifacts, etc.). |

> Exit code `1` is intentionally **not** used by the contract, so that usage/health errors remain distinguishable from uncaught runtime crashes (which Node exits with `1`).

### Backward compatibility

Adding new checks to `checks[]` is allowed without bumping `schemaVersion`. Removing a check, renaming a check `name`, or changing a check `status`'s exit-code mapping requires bumping `schemaVersion`.

## 5. Doctor checks (minimal, offline)

All checks are synchronous, read-only, and touch **only the local filesystem and `process.env`**. No HTTP, no spawn, no DB, no OAuth.

| # | `name`                | `status` values   | Blocking? | What it reports                                                                 |
| - | --------------------- | ----------------- | --------- | ------------------------------------------------------------------------------- |
| 1 | `nodeVersion`         | `pass` / `fail`   | yes       | Current Node version; `fail` if `< 22.19.0`.                                     |
| 2 | `piHubHome`           | `pass` / `fail`   | yes       | Resolved `$PI_HUB_HOME` or `~/.pi/hub`; writable check. `fail` if unwritable.  |
| 3 | `piAgentHome`         | `pass` / `warn`   | no        | Resolved `$PI_CODING_AGENT_DIR` or `~/.pi/agent`; `warn` if absent.             |
| 4 | `buildArtifacts`      | `pass` / `warn`   | no        | `<pkgDir>/.next`; `warn` if absent (dev checkout without a build).             |
| 5 | `envReport`           | `pass`            | no        | Object of `{ <ENV_NAME>: boolean }` — presence only, never values.             |
| 6 | `telegramTokenSource` | `pass` / `warn`   | no        | One of `env`, `file`, `unset`; the token itself is never reported.             |

### Aggregation

- `blocked` if any check is `fail`.
- else `degraded` if any check is `warn`.
- else `healthy`.

## 6. stdout / stderr routing

| Command                  | Success           | Failure                                              |
| ------------------------ | ----------------- | ---------------------------------------------------- |
| `--version --json`       | stdout: JSON      | stderr: usage message; exit `2`                      |
| `doctor --json --offline`| stdout: JSON (`healthy`) | stderr: JSON (`degraded`/`blocked`) **and** stderr: usage message on arg errors; exit per §4 |

Doctor intentionally writes the non-healthy JSON to stderr so that `pi-hub doctor --json --offline | jq` succeeds only when healthy and the exit code carries the rest of the signal.

## 7. Secret handling

- `envReport.detail` is always `{ "<ENV_NAME>": true | false }`. **Values are never emitted.**
- `telegramTokenSource.detail` is one of the strings `env` / `file` / `unset`. **The token is never emitted.**
- Resolved directory paths (`piHubHome`, `piAgentHome`, `buildArtifacts`) **are** emitted, because they are the primary useful output of doctor and are not credentials.
- The automated test suite (`lib/doctor.test.mjs`) injects known credential strings into the environment and asserts they do not appear anywhere in the serialized JSON.

## 8. Test coverage

The following are asserted by the automated test suite (run with `npm test`):

- `--version --json` output is valid JSON with stable key order.
- `name` and `version` match the invoked `package.json`.
- The version command does not start an HTTP server (subprocess exits within a timeout, proving no port was opened).
- `doctor --json --offline` makes no outgoing HTTP/HTTPS/NET/`child_process` calls (asserted via a child-process probe that traps those modules).
- Unknown arguments return a non-zero exit code.
- stdout is a single clean JSON line with no log noise.
- Credentials injected via environment variables do not appear in doctor output.

## 9. Implementation notes for upstream-sync safety

- All new code lives in new `bin/*.js` files; the patch to `bin/pi-hub.js` is a small, localized insertion before the existing `spawn` block.
- `bin/pi-web-options.js` (the upstream server-launch arg parser) is **unchanged**; the server launch path keeps its lenient `strict: false` parsing for backward compatibility.
- `AGENTS.md` (upstream) is unchanged; Pi Hub-specific rules already live in `AGENTS.local.md`, which anticipates that "additional commands may be added later".
