"use client";

/**
 * HostExtensionSlot — renders host-registered controls for a single slot.
 *
 * Pi Hub owns all rendering here. Desktop only declares intent (slot/kind/icon/
 * items) via the protocol; it can never supply HTML/CSS/JS/SVG/URL. Each icon
 * name maps to a Pi Hub-owned SVG below.
 *
 * V1 supports exactly one slot (sidebar.header.after_refresh) and one kind
 * (menu). The component still keys off `slot`/`kind` so future slots/kinds can
 * be added without touching call sites.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { useHostExtensions } from "@/hooks/useHostExtensions";
import type { ValidatedExtension } from "@/modules/host-extensions/host-extension-types";

/**
 * Pi Hub-owned icon glyphs. Adding a new allowlisted icon means adding its SVG
 * here — Desktop cannot contribute icons. Filled currentColor glyphs so they
 * inherit the toolbar button color like every other sidebar icon.
 */
const ICONS: Record<string, ReactNode> = {
  more_horizontal: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="1.6" />
      <circle cx="8" cy="8" r="1.6" />
      <circle cx="13" cy="8" r="1.6" />
    </svg>
  ),
};

/**
 * Render every host extension declared for `slot`. Returns null (renders
 * nothing) when no extensions are registered — which is the normal case in a
 * standalone browser.
 */
export function HostExtensionSlot({ slot }: { slot: string }): ReactNode {
  const { extensions, activate } = useHostExtensions(slot);
  const menus = extensions.filter((e) => e.kind === "menu");
  if (menus.length === 0) return null;
  return menus.map((ext) => (
    <HostMenu key={ext.id} extension={ext} onActivate={activate} />
  ));
}

function HostMenu({
  extension,
  onActivate,
}: {
  extension: ValidatedExtension;
  onActivate: (extensionId: string, itemId: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on Escape and outside click while open (contract §7.12). Selection
  // and slot removal also close it (selection below; removal unmounts us).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleItemClick = (itemId: string) => {
    setOpen(false);
    onActivate(extension.id, itemId);
  };

  const icon = ICONS[extension.icon] ?? ICONS.more_horizontal;
  const ariaLabel =
    extension.ariaLabel || extension.items[0]?.label || extension.id;

  return (
    <div ref={rootRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: open ? "var(--bg-selected)" : "var(--bg-hover)",
          border: `1px solid ${open ? "rgba(37,99,235,0.35)" : "var(--border)"}`,
          color: open ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer",
          borderRadius: 7,
          flexShrink: 0,
          transition: "background 0.12s, color 0.12s, border-color 0.12s",
        }}
        onMouseEnter={(e) => {
          if (open) return;
          e.currentTarget.style.background = "var(--bg-selected)";
          e.currentTarget.style.color = "var(--accent)";
          e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
        }}
        onMouseLeave={(e) => {
          if (open) return;
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text-muted)";
          e.currentTarget.style.borderColor = "var(--border)";
        }}
      >
        {icon}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 160,
            padding: 4,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
            zIndex: 100,
          }}
        >
          {extension.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => handleItemClick(item.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                background: "transparent",
                border: "none",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 12,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
