/**
 * Pi Hub Host Extension Protocol V1 — shared types.
 *
 * Literal unions are duplicated from host-extension-constants.ts on purpose:
 * keeping the type surface free of value-imports lets the constants and type
 * modules evolve independently. validateRegistration() is the single source of
 * truth that ties them together at runtime (it only ever assigns allowlisted
 * values into these literal-typed fields).
 */

/** Shape of the registration payload Desktop sends after every iframe load. */
export type RegisterExtensionsMessage = {
  channel: "pi-hub-host-extension";
  protocolVersion: 1;
  type: "register_extensions";
  revision: number;
  extensions: HostExtensionDeclaration[];
};

export type HostExtensionDeclaration = {
  id: string;
  slot: string;
  kind: string;
  icon: string;
  ariaLabel?: string;
  items: HostExtensionItem[];
};

export type HostExtensionItem = {
  id: string;
  label: string;
};

/** Shape of the event Pi Hub posts back to the validated parent origin. */
export type ExtensionEventMessage = {
  channel: "pi-hub-host-extension";
  protocolVersion: 1;
  type: "extension_event";
  extensionId: string;
  itemId: string;
  event: "activate";
};

/**
 * A declaration that has passed full schema validation. The literal-typed
 * `slot`/`kind`/`icon` fields guarantee renderers only ever see allowlisted
 * values, so no runtime fallback can let an unknown value reach styling.
 */
export type ValidatedExtension = {
  id: string;
  slot: "sidebar.header.after_refresh";
  kind: "menu";
  icon: "more_horizontal";
  ariaLabel: string;
  items: { id: string; label: string }[];
};

/** In-memory registration record kept by the host-extension store. */
export type StoredExtension = {
  declaration: ValidatedExtension;
  revision: number;
  /** Origin of the message that registered/replaced this id — used as the
   *  targetOrigin for event replies. Never "*". */
  parentOrigin: string;
};

export type ValidationResult =
  | { ok: true; revision: number; extensions: ValidatedExtension[] }
  | { ok: false };
