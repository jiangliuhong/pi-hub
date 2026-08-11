# Pi Hub Host Extension Protocol V1

- Status: Desktop side implemented; Pi Hub side implemented
- Protocol version: `1`
- Related requirements: `requirements-v1.md` FR-012 / SR-004
- Related design: `design-v1.md` §14 and §28

## 1. Design goal

Pi Hub provides **fixed extension slots and native control renderers**. Pi Hub Client Desktop owns the declarative button/menu definitions and handles interaction events.

This gives the Desktop-maintained menu a native Pi Hub appearance without allowing Desktop to inject HTML, CSS, JavaScript, or Tauri APIs into remote content.

Initial Desktop extension:

```text
slot: sidebar.header.after_refresh
control: menu
item: 返回列表
```

## 2. Responsibility boundary

### Desktop owns

- which extensions are registered;
- extension IDs and revision;
- labels and allowlisted icon names;
- menu items;
- handling returned interaction events;
- updating or removing its declarations on iframe reload;
- Viewer cleanup and navigation.

### Pi Hub owns

- available slot names;
- schema validation and limits;
- actual DOM rendering;
- native button/menu components;
- light/dark theme styling;
- responsive layout;
- focus, keyboard, Escape and outside-click behavior;
- converting user interaction into protocol events.

Pi Hub must not execute Desktop-provided code. Desktop must not control arbitrary layout or styles.

## 3. Transport and trust

The protocol uses browser `postMessage` between the trusted Desktop App Shell and the untrusted Pi Hub iframe.

Desktop sends registrations with the exact active Pi Hub origin as `targetOrigin`.

Desktop accepts events only when all checks pass:

1. `event.source` is the active Pi Hub iframe's `contentWindow`;
2. `event.origin` exactly equals the active service origin;
3. `channel === "pi-hub-host-extension"`;
4. `protocolVersion === 1`;
5. extension, item and event IDs are explicitly allowlisted.

No payload may contain credentials, cookies, authorization headers, profile data, process state, arbitrary commands, or arbitrary arguments.

## 4. Desktop → Pi Hub registration

Desktop sends this after every iframe `load` event:

```json
{
  "channel": "pi-hub-host-extension",
  "protocolVersion": 1,
  "type": "register_extensions",
  "revision": 1,
  "extensions": [
    {
      "id": "pi-hub-client-menu",
      "slot": "sidebar.header.after_refresh",
      "kind": "menu",
      "icon": "more_horizontal",
      "ariaLabel": "Pi Hub Client 菜单",
      "items": [
        {
          "id": "return_to_services",
          "label": "返回列表"
        }
      ]
    }
  ]
}
```

Registration semantics:

- registrations are in-memory and scoped to the current iframe document;
- the same `id` replaces the previous declaration when `revision` is equal or newer;
- a page reload clears Pi Hub state and Desktop registers again;
- unsupported protocol versions, slots, kinds or icons are ignored;
- invalid declarations must not partially render;
- no extension UI appears in a normal browser unless an embedding host registers it.

## 5. Pi Hub → Desktop event

When the user selects “返回列表”, Pi Hub replies to the validated parent origin:

```json
{
  "channel": "pi-hub-host-extension",
  "protocolVersion": 1,
  "type": "extension_event",
  "extensionId": "pi-hub-client-menu",
  "itemId": "return_to_services",
  "event": "activate"
}
```

Desktop validates the event, closes the current Service View, releases Viewer resources, and navigates to the service list.

## 6. V1 declarative schema

### Allowed slots

```text
sidebar.header.after_refresh
```

### Allowed control kinds

```text
menu
```

### Allowed icons

```text
more_horizontal
```

### Allowed events

```text
activate
```

Recommended Pi Hub limits:

- at most 8 registered extensions;
- at most 8 menu items per extension;
- IDs: ASCII `[a-z0-9._-]`, maximum 64 characters;
- labels and aria labels: maximum 80 Unicode characters;
- reject duplicate extension IDs or item IDs;
- reject unknown fields if they could affect execution or styling.

V1 does not support arbitrary HTML, CSS, URLs, scripts, callbacks, keyboard shortcuts, command arguments, or nested menus.

## 7. Pi Hub implementation work

Implement in `jiangliuhong/pi-hub`:

1. Add a client hook such as `useHostExtensions`.
2. Listen for `register_extensions` messages.
3. Require `event.source === window.parent`.
4. Validate channel, protocol version and the complete declaration schema.
5. Store the validated parent source and origin for event replies.
6. Keep registrations in memory only and clear them on document reload.
7. Add a renderer for `sidebar.header.after_refresh`.
8. Update `components/SessionSidebar.tsx` to render the slot immediately after its refresh button.
9. Render the `menu` kind with Pi Hub's native 32×32 toolbar button and native popover styles.
10. Map `more_horizontal` to a Pi Hub-owned SVG; do not accept SVG or HTML from Desktop.
11. Emit `extension_event` to the validated parent origin when an item activates.
12. Close the menu on Escape, outside click, selection and slot removal.

Do not:

- import or call Tauri APIs;
- evaluate code from registration payloads;
- render raw HTML or CSS;
- use Desktop-provided URLs;
- use `targetOrigin: "*"` for event replies;
- expose Pi Hub credentials, sessions, model data or filesystem access through the protocol;
- allow extensions to invoke Pi Hub server APIs beyond normal user UI behavior.

## 8. Pi Hub tests required

At minimum:

- valid V1 registration renders the menu after the refresh button;
- standalone Pi Hub renders no host extensions;
- wrong source, channel, version, slot, kind or icon is ignored;
- duplicate and over-limit declarations are rejected;
- registration replacement follows revision rules;
- action event uses the validated parent origin;
- one click emits exactly one `activate` event;
- Escape and outside click close the menu;
- light, dark, narrow and resized sidebar layouts remain aligned;
- registration cannot provide HTML, CSS, JavaScript or URL behavior;
- no Tauri object or command is referenced.

## 9. Integration acceptance

1. Open a Direct URL profile in Desktop.
2. Open an SSH Forward profile in Desktop.
3. Confirm Pi Hub renders the Desktop-declared menu after its refresh button.
4. Confirm Desktop has no overlay button.
5. Select “返回列表” and confirm Viewer resources close before navigation.
6. Send the same event from another frame or origin and confirm Desktop ignores it.
7. Send an unknown extension/item/event and confirm Desktop ignores it.
8. Open the same Pi Hub in a normal browser and confirm the menu is absent.
