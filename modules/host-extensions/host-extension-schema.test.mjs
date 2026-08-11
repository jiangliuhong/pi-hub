import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

let cached;
async function load() {
  cached ??= jiti.import("./host-extension-schema.ts");
  return cached;
}

// Convenience builder matching the contract's example registration.
function baseMessage(overrides = {}) {
  return {
    channel: "pi-hub-host-extension",
    protocolVersion: 1,
    type: "register_extensions",
    revision: 1,
    extensions: [
      {
        id: "pi-hub-client-menu",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        ariaLabel: "Pi Hub Client 菜单",
        items: [{ id: "return_to_services", label: "返回列表" }],
      },
    ],
    ...overrides,
  };
}

test("valid V1 registration parses into validated extensions", async () => {
  const { validateRegistration } = await load();
  const r = validateRegistration(baseMessage());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.revision, 1);
  assert.equal(r.extensions.length, 1);
  const ext = r.extensions[0];
  assert.equal(ext.id, "pi-hub-client-menu");
  assert.equal(ext.kind, "menu");
  assert.equal(ext.icon, "more_horizontal");
  assert.deepEqual(ext.items, [{ id: "return_to_services", label: "返回列表" }]);
});

test("wrong channel / version / type are rejected", async () => {
  const { validateRegistration } = await load();
  assert.equal(validateRegistration(baseMessage({ channel: "nope" })).ok, false);
  assert.equal(
    validateRegistration(baseMessage({ protocolVersion: 2 })).ok,
    false,
  );
  assert.equal(
    validateRegistration(baseMessage({ type: "something_else" })).ok,
    false,
  );
});

test("unsupported slot / kind / icon drop the extension", async () => {
  const { validateRegistration } = await load();
  const badSlot = baseMessage({
    extensions: [
      {
        id: "a",
        slot: "sidebar.footer",
        kind: "menu",
        icon: "more_horizontal",
        items: [{ id: "i", label: "L" }],
      },
    ],
  });
  assert.equal(validateRegistration(badSlot).ok, false);

  const badKind = baseMessage({
    extensions: [
      {
        id: "a",
        slot: "sidebar.header.after_refresh",
        kind: "button",
        icon: "more_horizontal",
        items: [{ id: "i", label: "L" }],
      },
    ],
  });
  assert.equal(validateRegistration(badKind).ok, false);

  const badIcon = baseMessage({
    extensions: [
      {
        id: "a",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "sparkles",
        items: [{ id: "i", label: "L" }],
      },
    ],
  });
  assert.equal(validateRegistration(badIcon).ok, false);
});

test("duplicate extension id rejects the whole batch", async () => {
  const { validateRegistration } = await load();
  const msg = baseMessage({
    extensions: [
      {
        id: "dup",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        items: [{ id: "i", label: "L" }],
      },
      {
        id: "dup",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        items: [{ id: "j", label: "M" }],
      },
    ],
  });
  assert.equal(validateRegistration(msg).ok, false);
});

test("duplicate item id drops the extension", async () => {
  const { validateRegistration } = await load();
  const msg = baseMessage({
    extensions: [
      {
        id: "a",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        items: [
          { id: "dup", label: "L" },
          { id: "dup", label: "M" },
        ],
      },
    ],
  });
  assert.equal(validateRegistration(msg).ok, false);
});

test("over-limit extensions and items are rejected", async () => {
  const { validateRegistration } = await load();
  const many = Array.from({ length: 9 }, (_, i) => ({
    id: `ext${i}`,
    slot: "sidebar.header.after_refresh",
    kind: "menu",
    icon: "more_horizontal",
    items: [{ id: "i", label: "L" }],
  }));
  assert.equal(
    validateRegistration(baseMessage({ extensions: many })).ok,
    false,
  );

  const manyItems = Array.from({ length: 9 }, (_, i) => ({
    id: `i${i}`,
    label: "L",
  }));
  const msg = baseMessage({
    extensions: [
      {
        id: "a",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        items: manyItems,
      },
    ],
  });
  assert.equal(validateRegistration(msg).ok, false);
});

test("bad ids and oversized labels are rejected", async () => {
  const { validateRegistration } = await load();
  const badId = baseMessage({
    extensions: [
      {
        id: "UPPER CASE",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        items: [{ id: "i", label: "L" }],
      },
    ],
  });
  assert.equal(validateRegistration(badId).ok, false);

  const longLabel = "x".repeat(81);
  const badLabel = baseMessage({
    extensions: [
      {
        id: "a",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        items: [{ id: "i", label: longLabel }],
      },
    ],
  });
  assert.equal(validateRegistration(badLabel).ok, false);
});

test("unknown payload fields (html/css/script/url) are ignored, not executed", async () => {
  const { validateRegistration } = await load();
  const msg = baseMessage({
    extensions: [
      {
        id: "a",
        slot: "sidebar.header.after_refresh",
        kind: "menu",
        icon: "more_horizontal",
        items: [{ id: "i", label: "L" }],
        // Desktop MUST NOT be able to inject anything; these are silently
        // unread and never reach rendering or execution.
        html: "<script>window.__pwned=1</script>",
        css: "* { color: red }",
        script: "alert(1)",
        url: "javascript:alert(1)",
        onClick: "() => {}",
      },
    ],
  });
  const r = validateRegistration(msg);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Only allowlisted fields survive onto the validated extension.
  assert.deepEqual(Object.keys(r.extensions[0]).sort(), [
    "ariaLabel",
    "icon",
    "id",
    "items",
    "kind",
    "slot",
  ]);
});

test("revision replacement: equal or newer replaces, older does not", async () => {
  const { mergeRegistrations, validateRegistration } = await load();
  const mk = (rev) => {
    const r = validateRegistration(baseMessage({ revision: rev }));
    assert.equal(r.ok, true);
    return r.ok ? { extensions: r.extensions, revision: r.revision } : null;
  };

  let store = [];
  const first = mk(1);
  let res = mergeRegistrations(store, first.extensions, first.revision, "https://desktop.app");
  assert.equal(res.changed, true);
  store = res.next;
  assert.equal(store.length, 1);
  assert.equal(store[0].parentOrigin, "https://desktop.app");

  // Equal revision also replaces (origin can update).
  const same = mk(1);
  res = mergeRegistrations(store, same.extensions, same.revision, "https://desktop.app:2");
  assert.equal(res.changed, true);
  assert.equal(res.next[0].parentOrigin, "https://desktop.app:2");
  store = res.next;

  // Older revision is ignored.
  const older = mk(0);
  res = mergeRegistrations(store, older.extensions, older.revision, "https://evil.example");
  assert.equal(res.changed, false);
  assert.equal(res.next[0].parentOrigin, "https://desktop.app:2");
});

test("reply target uses the validated registration origin, never wildcard", async () => {
  const { mergeRegistrations, validateRegistration, selectReplyTarget } = await load();
  const r = validateRegistration(baseMessage());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const store = mergeRegistrations(
    [],
    r.extensions,
    r.revision,
    "https://desktop.app",
  ).next;

  assert.equal(
    selectReplyTarget(store, "pi-hub-client-menu", "return_to_services"),
    "https://desktop.app",
  );
  // Unknown extension / item → null (hook drops the event).
  assert.equal(selectReplyTarget(store, "nope", "return_to_services"), null);
  assert.equal(selectReplyTarget(store, "pi-hub-client-menu", "nope"), null);
});
