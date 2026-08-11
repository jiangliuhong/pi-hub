import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createBot } = await jiti.import("./telegram-bot-client.ts");

// A token with a valid `<digits>:<secret>` shape; never sent anywhere — the
// `fetch` override intercepts every request.
const TOKEN = "123456789:AABBCCDDEEFFggHHIIJJKK_llmmnnooppqq";
const API_ROOT = "https://tg.example.com";

/** Builds a mock Grammy `fetch` that answers by method (last URL segment). */
function mockFetch(envelopes) {
  return async (url) => {
    const method = new URL(url).pathname.split("/").filter(Boolean).pop();
    const env = envelopes[method] ?? { ok: true, result: true };
    return { json: async () => env };
  };
}

// ---------------------------------------------------------------------------
// Self-hosted / relay servers that reject deleteWebhook
// (400: "webhook delivery state requires downstream support"). Grammy calls
// deleteWebhook unconditionally inside bot.start(), so this must not throw.
// ---------------------------------------------------------------------------

test("createBot tolerates a relay server that rejects deleteWebhook", async () => {
  const bot = createBot({
    token: TOKEN,
    apiRoot: API_ROOT,
    client: {
      fetch: mockFetch({
        deleteWebhook: {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: method deleteWebhook is not supported: webhook delivery state requires downstream support",
        },
        getMe: {
          ok: true,
          result: { id: 42, username: "pibot", first_name: "Pi", is_bot: true },
        },
      }),
    },
  });

  // The transformer rewrites the { ok: false } envelope to success, so this
  // resolves instead of throwing — long polling can then start.
  assert.equal(await bot.api.deleteWebhook(), true);

  // Other methods are unaffected.
  const me = await bot.api.getMe();
  assert.equal(me.id, 42);
  assert.equal(me.username, "pibot");
});

test("createBot passes a genuine deleteWebhook success through unchanged", async () => {
  const bot = createBot({
    token: TOKEN,
    apiRoot: API_ROOT,
    client: {
      fetch: mockFetch({
        deleteWebhook: { ok: true, result: true },
      }),
    },
  });
  assert.equal(await bot.api.deleteWebhook(), true);
});

test("createBot still throws a genuine 400 from deleteWebhook", async () => {
  // A different 400 (e.g. "bad webhook") must still surface — we only swallow
  // the "not supported / no downstream" variant.
  const bot = createBot({
    token: TOKEN,
    apiRoot: API_ROOT,
    client: {
      fetch: mockFetch({
        deleteWebhook: { ok: false, error_code: 400, description: "Bad Request: some other reason" },
      }),
    },
  });
  await assert.rejects(() => bot.api.deleteWebhook());
});

test("createBot still surfaces 4xx from non-deleteWebhook methods", async () => {
  const bot = createBot({
    token: TOKEN,
    apiRoot: API_ROOT,
    client: {
      fetch: mockFetch({
        sendMessage: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
      }),
    },
  });
  await assert.rejects(() => bot.api.sendMessage(123, "hi"));
});
