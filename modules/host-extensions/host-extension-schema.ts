/**
 * Pi Hub Host Extension Protocol V1 — pure validation and registry logic.
 *
 * This module is deliberately DOM/React free so it can be unit tested without a
 * browser (contract §8). The hook (hooks/useHostExtensions.ts) owns the only
 * window/postMessage surface and calls into these pure helpers.
 */

import {
  ALLOWED_ICONS,
  ALLOWED_KINDS,
  ALLOWED_SLOTS,
  CHANNEL,
  ID_PATTERN,
  MAX_EXTENSIONS,
  MAX_ID_LENGTH,
  MAX_ITEMS_PER_EXTENSION,
  MAX_LABEL_LENGTH,
  PROTOCOL_VERSION,
} from "./host-extension-constants";
import type {
  StoredExtension,
  ValidatedExtension,
  ValidationResult,
} from "./host-extension-types";

const SLOTS = ALLOWED_SLOTS as readonly string[];
const KINDS = ALLOWED_KINDS as readonly string[];
const ICONS = ALLOWED_ICONS as readonly string[];

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** Length by Unicode code point so emoji/CJK count as one char each. */
function unicodeLength(s: string): number {
  return Array.from(s).length;
}

function isValidId(v: unknown): v is string {
  return (
    isString(v) &&
    v.length >= 1 &&
    v.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(v)
  );
}

function isValidLabel(v: unknown): v is string {
  if (!isString(v)) return false;
  const len = unicodeLength(v);
  return len >= 1 && len <= MAX_LABEL_LENGTH;
}

function validateItem(
  raw: unknown,
): { id: string; label: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!isValidId(obj.id)) return null;
  if (!isValidLabel(obj.label)) return null;
  return { id: obj.id, label: obj.label };
}

/**
 * Validate a single extension declaration.
 *
 * Returns null when anything is unsupported/invalid — callers ignore nulls so
 * invalid declarations never partially render (contract §4). Unknown fields are
 * simply not read, so they can never affect execution or styling (contract §6).
 */
function validateExtension(raw: unknown): ValidatedExtension | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (!isValidId(obj.id)) return null;
  if (!isString(obj.slot) || !SLOTS.includes(obj.slot)) return null;
  if (!isString(obj.kind) || !KINDS.includes(obj.kind)) return null;
  if (!isString(obj.icon) || !ICONS.includes(obj.icon)) return null;

  const ariaLabel = isString(obj.ariaLabel) ? obj.ariaLabel : "";
  if (ariaLabel.length > 0 && unicodeLength(ariaLabel) > MAX_LABEL_LENGTH) {
    return null;
  }

  if (!Array.isArray(obj.items)) return null;
  if (obj.items.length < 1 || obj.items.length > MAX_ITEMS_PER_EXTENSION) {
    return null;
  }

  const items: { id: string; label: string }[] = [];
  const seenItemIds = new Set<string>();
  for (const it of obj.items) {
    const v = validateItem(it);
    if (!v) return null;
    if (seenItemIds.has(v.id)) return null; // reject duplicate item ids
    seenItemIds.add(v.id);
    items.push(v);
  }

  return {
    id: obj.id,
    slot: obj.slot as ValidatedExtension["slot"],
    kind: obj.kind as ValidatedExtension["kind"],
    icon: obj.icon as ValidatedExtension["icon"],
    ariaLabel,
    items,
  };
}

/**
 * Validate a full register_extensions message envelope + payload.
 *
 * Checks channel, protocolVersion, type, revision and every extension. A
 * duplicate extension id within the batch rejects the whole message (contract
 * §6). Individual unsupported extensions are dropped (ignored) rather than
 * invalidating their siblings.
 */
export function validateRegistration(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object") return { ok: false };
  const obj = raw as Record<string, unknown>;

  if (obj.channel !== CHANNEL) return { ok: false };
  if (obj.protocolVersion !== PROTOCOL_VERSION) return { ok: false };
  if (obj.type !== "register_extensions") return { ok: false };

  const revision = obj.revision;
  if (
    typeof revision !== "number" ||
    !Number.isFinite(revision) ||
    revision < 0
  ) {
    return { ok: false };
  }

  const extsRaw = obj.extensions;
  if (!Array.isArray(extsRaw)) return { ok: false };
  if (extsRaw.length < 1 || extsRaw.length > MAX_EXTENSIONS) {
    return { ok: false };
  }

  const validated: ValidatedExtension[] = [];
  const seenIds = new Set<string>();
  for (const e of extsRaw) {
    const v = validateExtension(e);
    if (!v) continue; // ignore unsupported/invalid; never partially render
    if (seenIds.has(v.id)) return { ok: false }; // reject duplicate ids
    seenIds.add(v.id);
    validated.push(v);
  }

  if (validated.length === 0) return { ok: false };
  return { ok: true, revision, extensions: validated };
}

/**
 * Merge a validated, incoming batch into the current registry.
 *
 * Per-id replacement: an id is replaced only when its stored revision is equal
 * to or older than the incoming revision (contract §4). Entries not present in
 * the incoming batch are preserved (merge semantics, not full-replace).
 *
 * Pure: returns `{ changed, next }` without touching any external state.
 */
export function mergeRegistrations(
  current: StoredExtension[],
  incoming: ValidatedExtension[],
  revision: number,
  parentOrigin: string,
): { changed: boolean; next: StoredExtension[] } {
  let changed = false;
  const next = current.slice();

  for (const ext of incoming) {
    const idx = next.findIndex((s) => s.declaration.id === ext.id);
    if (idx === -1) {
      next.push({ declaration: ext, revision, parentOrigin });
      changed = true;
      continue;
    }
    if (next[idx].revision <= revision) {
      next[idx] = { declaration: ext, revision, parentOrigin };
      changed = true;
    }
  }

  return { changed, next: changed ? next : current };
}

/**
 * Resolve the origin Pi Hub must use when replying to an item activation.
 * Returns null when the id pair is unknown, so the hook can drop the event.
 * The returned origin is always the validated registration source — never "*".
 */
export function selectReplyTarget(
  store: StoredExtension[],
  extensionId: string,
  itemId: string,
): string | null {
  const entry = store.find((s) => s.declaration.id === extensionId);
  if (!entry) return null;
  if (!entry.declaration.items.some((i) => i.id === itemId)) return null;
  return entry.parentOrigin;
}
