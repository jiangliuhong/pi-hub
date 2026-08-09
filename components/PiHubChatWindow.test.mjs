import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatWindow = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInput = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const piHubChatWindow = readFileSync(new URL("./PiHubChatWindow.tsx", import.meta.url), "utf8");

test("keeps Pi Hub notification integration outside upstream chat components", () => {
  assert.doesNotMatch(chatWindow, /telegram/i);
  assert.doesNotMatch(chatInput, /telegram/i);
  assert.match(piHubChatWindow, /useTelegramNotify/);
  assert.match(piHubChatWindow, /onPromptFinished=\{handlePromptFinished\}/);
  assert.match(piHubChatWindow, /inputExtraControls=\{telegramControl\}/);
});
