/**
 * Pi Hub Host Extension Protocol V1 — constants.
 *
 * See docs/pi-hub/pi-hub-embed-contract-v1.md.
 *
 * Everything here is a closed whitelist: Pi Hub only ever renders controls,
 * slots, icons and events that are explicitly listed. Unknown values must be
 * ignored (never partially rendered) and must never reach execution or styling.
 */

/** postMessage channel shared by Desktop registrations and Pi Hub events. */
export const CHANNEL = "pi-hub-host-extension";

/** Protocol version this Pi Hub build understands. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Slots Pi Hub knows how to render, in the order the contract declares them.
 * V1 ships exactly one slot, rendered right after the sidebar refresh button.
 */
export const ALLOWED_SLOTS = ["sidebar.header.after_refresh"] as const;

/** Control kinds Pi Hub can render natively. */
export const ALLOWED_KINDS = ["menu"] as const;

/**
 * Icon names Pi Hub recognises. Each maps to a Pi Hub-owned SVG inside
 * HostExtensionSlot.tsx — Desktop never supplies SVG/HTML/CSS.
 */
export const ALLOWED_ICONS = ["more_horizontal"] as const;

/** Events Pi Hub may emit back to the host. */
export const ALLOWED_EVENTS = ["activate"] as const;

// --- Recommended limits (contract §6) --------------------------------------

export const MAX_EXTENSIONS = 8;
export const MAX_ITEMS_PER_EXTENSION = 8;
export const MAX_ID_LENGTH = 64;
export const MAX_LABEL_LENGTH = 80;

/** ASCII [a-z0-9._-], 1..MAX_ID_LENGTH characters. */
export const ID_PATTERN = /^[a-z0-9._-]+$/;
