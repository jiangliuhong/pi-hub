import { join } from "node:path";

/** Keep test servers away from the developer's Hub state and credentials. */
export function isolatedServerEnv(agentDir, inherited = process.env) {
  return {
    ...inherited,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: "",
    PI_HUB_HOME: join(agentDir, "hub"),
    PI_HUB_PASSWORD: "",
    PI_WEB_PASSWORD: "",
    PI_HUB_TELEGRAM_BOT_TOKEN: "",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}
