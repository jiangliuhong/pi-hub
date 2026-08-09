import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve Pi's optional custom session directory using the same precedence as
 * the Pi CLI. An undefined result means that the SDK default directory should
 * be used (the per-cwd directories below ~/.pi/agent/sessions).
 */
export function getConfiguredSessionDir(cwd = process.cwd()): string | undefined {
  const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (envDir) return expandTilde(envDir);

  return SettingsManager.create(cwd, getAgentDir()).getSessionDir();
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
