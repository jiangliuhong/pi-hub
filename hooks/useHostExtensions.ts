"use client";

/**
 * useHostExtensions — Pi Hub Host Extension Protocol V1 client hook.
 *
 * This is the ONLY place in the app that touches window/postMessage for host
 * extensions. It is deliberately tiny: it validates incoming registrations via
 * the pure schema helpers, keeps an in-memory registry, and posts activation
 * events back to the validated parent origin. Allowing logic to leak out of
 * here would risk accepting messages from the wrong source/origin.
 *
 * Security invariants (contract §3 / §7):
 *  - only act on messages whose source is exactly window.parent;
 *  - ignore everything when not embedded (window.parent === window), so a
 *    standalone browser never renders host extensions;
 *  - reply with targetOrigin = the registration's origin, never "*";
 *  - never import or call Tauri / evaluate payload code.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  CHANNEL,
  PROTOCOL_VERSION,
} from "@/modules/host-extensions/host-extension-constants";
import {
  mergeRegistrations,
  selectReplyTarget,
  validateRegistration,
} from "@/modules/host-extensions/host-extension-schema";
import type { StoredExtension, ValidatedExtension } from "@/modules/host-extensions/host-extension-types";

// --- module-level singleton store ------------------------------------------

let store: StoredExtension[] = [];
const listeners = new Set<() => void>();
let initialized = false;
// Stable empty array returned by getServerSnapshot so SSR and first client
// paint render no extensions (store is also empty until a registration arrives).
const EMPTY_STORE: StoredExtension[] = [];

function notify(): void {
  for (const l of listeners) l();
}

function applyRegistrations(
  incoming: ValidatedExtension[],
  revision: number,
  parentOrigin: string,
): void {
  const { changed, next } = mergeRegistrations(
    store,
    incoming,
    revision,
    parentOrigin,
  );
  if (changed) {
    store = next;
    notify();
  }
}

function handleMessage(ev: MessageEvent): void {
  if (typeof window === "undefined") return;
  // Standalone browser: window.parent === window. Render nothing.
  if (window.parent === window) return;
  // Only the direct parent (the Desktop host) may register extensions.
  if (ev.source !== window.parent) return;

  const data = ev.data;
  if (!data || typeof data !== "object") return;

  const result = validateRegistration(data);
  if (!result.ok) return;

  // ev.origin is the validated source origin; use it for event replies.
  applyRegistrations(result.extensions, result.revision, ev.origin);
}

function ensureInit(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("message", handleMessage);
}

function subscribe(cb: () => void): () => void {
  ensureInit();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): StoredExtension[] {
  // Returns the live store array reference, which is reassigned to a new
  // array on every change so useSyncExternalStore detects the difference.
  return store;
}

function getServerSnapshot(): StoredExtension[] {
  return EMPTY_STORE;
}

/**
 * Post a single `activate` event for the given extension/item pair to the
 * validated parent origin. Drops silently when not embedded or when the id
 * pair is unknown (so stale/foreign ids can never trigger a reply).
 */
function sendActivate(extensionId: string, itemId: string): void {
  if (typeof window === "undefined") return;
  const parent = window.parent;
  if (!parent || parent === window) return;

  const origin = selectReplyTarget(store, extensionId, itemId);
  if (!origin) return; // unknown id pair — ignore

  const message = {
    channel: CHANNEL,
    protocolVersion: PROTOCOL_VERSION,
    type: "extension_event",
    extensionId,
    itemId,
    event: "activate",
  } as const;

  // Never use targetOrigin "*" — reply only to the validated host origin.
  parent.postMessage(message, origin);
}

// --- public hook ------------------------------------------------------------

/**
 * Returns the validated extensions registered for `slot`, plus an `activate`
 * callback the renderer calls when the user selects an item.
 *
 * Renders nothing on the server or in a standalone browser (store stays empty
 * and no listener is attached until a real embedded registration arrives).
 */
export function useHostExtensions(slot: string): {
  extensions: ValidatedExtension[];
  activate: (extensionId: string, itemId: string) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const extensions = useMemo<ValidatedExtension[]>(
    () =>
      snapshot
        .filter((s) => s.declaration.slot === slot)
        .map((s) => s.declaration),
    [snapshot, slot],
  );
  const activate = useCallback(
    (extensionId: string, itemId: string) => sendActivate(extensionId, itemId),
    [],
  );
  return { extensions, activate };
}
