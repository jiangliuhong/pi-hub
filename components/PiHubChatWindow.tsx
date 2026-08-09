"use client";

import { useCallback } from "react";

import { useI18n } from "@/hooks/useI18n";
import type { PromptFinishedInfo } from "@/hooks/useAgentSession";
import { useTelegramNotify } from "@/hooks/useTelegramNotify";
import { notifyTelegramManualRun } from "@/lib/telegram-client";

import { ChatWindow, type ChatWindowProps } from "./ChatWindow";

type Props = Omit<ChatWindowProps, "inputExtraControls" | "onPromptFinished">;

/** Pi Hub integration wrapper around the upstream-compatible chat surface. */
export function PiHubChatWindow(props: Props) {
  const { t } = useI18n();
  const {
    notifyEnabled,
    notifyEnabledRef,
    onNotifyToggle,
    telegramConfigured,
  } = useTelegramNotify();

  const handlePromptFinished = useCallback((info: PromptFinishedInfo) => {
    if (!notifyEnabledRef.current || !info.sessionId) return;
    void notifyTelegramManualRun({
      sessionId: info.sessionId,
      runId: info.runId,
      runSource: "web",
      status: info.status,
      prompt: info.userPrompt ?? undefined,
      errorMessage: info.errorMessage ?? undefined,
      startedAt: info.startedAt ?? undefined,
      finishedAt: info.finishedAt,
    }).catch((error) => {
      console.warn(
        "Telegram notify-run failed",
        error instanceof Error ? error.message : error,
      );
    });
  }, [notifyEnabledRef]);

  const telegramControl = telegramConfigured ? (
    <button
      type="button"
      onClick={onNotifyToggle}
      title={notifyEnabled ? t("chat.disableTelegramNotify") : t("chat.enableTelegramNotify")}
      aria-label={notifyEnabled ? t("chat.disableTelegramNotify") : t("chat.enableTelegramNotify")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        padding: 0,
        background: "none",
        border: "none",
        borderRadius: 9,
        color: notifyEnabled ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        opacity: notifyEnabled ? 1 : 0.55,
        transition: "background 0.12s, color 0.12s, opacity 0.12s",
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "var(--bg-hover)";
        event.currentTarget.style.color = "var(--text)";
        event.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "none";
        event.currentTarget.style.color = notifyEnabled ? "var(--accent)" : "var(--text-dim)";
        event.currentTarget.style.opacity = notifyEnabled ? "1" : "0.55";
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill={notifyEnabled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="22" y1="2" x2="11" y2="13" />
        <polygon points="22 2 15 22 11 13 2 9 22 2" />
      </svg>
    </button>
  ) : null;

  return (
    <ChatWindow
      {...props}
      onPromptFinished={handlePromptFinished}
      inputExtraControls={telegramControl}
    />
  );
}
