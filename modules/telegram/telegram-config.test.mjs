import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  normalizeApiRoot,
  isOfficialApiRoot,
  buildFileApiRoot,
  buildTelegramFileUrl,
  coerceBotApiConfig,
  normalizeLocalFileRoot,
  maskToken,
  scrubToken,
  DEFAULT_TELEGRAM_API_ROOT,
} = await jiti.import("./telegram-config.ts");

const code = (c) => (err) => err && err.code === c;

// ---------------------------------------------------------------------------
// apiRoot normalization & validation
// ---------------------------------------------------------------------------

test("normalizeApiRoot: strips trailing slash and whitespace", () => {
  assert.equal(normalizeApiRoot("  https://tg.example.com/  "), "https://tg.example.com");
  assert.equal(normalizeApiRoot("https://tg.example.com///"), "https://tg.example.com");
});

test("normalizeApiRoot: keeps a subpath", () => {
  assert.equal(normalizeApiRoot("https://example.com/telegram-api"), "https://example.com/telegram-api");
});

test("normalizeApiRoot: accepts http for internal networks", () => {
  assert.equal(normalizeApiRoot("http://127.0.0.1:8081"), "http://127.0.0.1:8081");
  assert.equal(normalizeApiRoot("http://telegram-bot-api:8081"), "http://telegram-bot-api:8081");
});

test("normalizeApiRoot: rejects empty", () => {
  assert.throws(() => normalizeApiRoot(""), code("TELEGRAM_API_ROOT_INVALID"));
  assert.throws(() => normalizeApiRoot("   "), code("TELEGRAM_API_ROOT_INVALID"));
});

test("normalizeApiRoot: rejects non-http schemes", () => {
  assert.throws(() => normalizeApiRoot("ftp://x.example.com"), code("TELEGRAM_API_ROOT_INVALID"));
  assert.throws(() => normalizeApiRoot("file:///etc"), code("TELEGRAM_API_ROOT_INVALID"));
});

test("normalizeApiRoot: rejects embedded credentials", () => {
  assert.throws(() => normalizeApiRoot("https://user:pass@tg.example.com"), code("TELEGRAM_API_ROOT_INVALID"));
});

test("normalizeApiRoot: rejects a URL that contains a bot token", () => {
  assert.throws(
    () => normalizeApiRoot("https://tg.example.com/bot123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
    code("TELEGRAM_API_ROOT_INVALID"),
  );
});

test("normalizeApiRoot: rejects malformed URLs", () => {
  assert.throws(() => normalizeApiRoot("not-a-url"), code("TELEGRAM_API_ROOT_INVALID"));
});

test("isOfficialApiRoot: true for the default", () => {
  assert.equal(isOfficialApiRoot(DEFAULT_TELEGRAM_API_ROOT), true);
  assert.equal(isOfficialApiRoot("https://api.telegram.org/"), true);
  assert.equal(isOfficialApiRoot("https://tg.example.com"), false);
});

// ---------------------------------------------------------------------------
// File URL building (no api.telegram.org hard-coding)
// ---------------------------------------------------------------------------

test("buildFileApiRoot: appends /file to apiRoot", () => {
  assert.equal(buildFileApiRoot("https://tg.example.com"), "https://tg.example.com/file");
  assert.equal(buildFileApiRoot("https://api.telegram.org/"), "https://api.telegram.org/file");
});

test("buildTelegramFileUrl: builds the full self-hosted download URL", () => {
  const url = buildTelegramFileUrl("https://tg.example.com", "BOT:TOKEN", "photos/file_1.jpg");
  assert.equal(url, "https://tg.example.com/file/botBOT:TOKEN/photos/file_1.jpg");
});

test("buildTelegramFileUrl: uses self-hosted domain, never api.telegram.org", () => {
  const url = buildTelegramFileUrl("http://telegram-bot-api:8081", "123:abc", "docs/x.pdf");
  assert.ok(url.startsWith("http://telegram-bot-api:8081/file/bot123:abc/"));
  assert.ok(!url.includes("api.telegram.org"));
});

test("buildTelegramFileUrl: requires a token", () => {
  assert.throws(() => buildTelegramFileUrl("https://tg.example.com", "", "f.jpg"), code("TELEGRAM_TOKEN_MISSING"));
});

// ---------------------------------------------------------------------------
// Bot API config coercion
// ---------------------------------------------------------------------------

test("coerceBotApiConfig: switching to official resets apiRoot", () => {
  const current = { mode: "self-hosted", apiRoot: "https://tg.example.com", localMode: true, localFileRoot: "/data" };
  const next = coerceBotApiConfig({ mode: "official" }, current);
  assert.equal(next.mode, "official");
  assert.equal(next.apiRoot, DEFAULT_TELEGRAM_API_ROOT);
  assert.equal(next.localMode, false); // official ignores localMode
  assert.equal(next.localFileRoot, null);
});

test("coerceBotApiConfig: self-hosted normalizes apiRoot and keeps local mode fields", () => {
  const current = { mode: "official", apiRoot: DEFAULT_TELEGRAM_API_ROOT, localMode: false, localFileRoot: null };
  const next = coerceBotApiConfig(
    { mode: "self-hosted", apiRoot: "https://tg.example.com/", localMode: true, localFileRoot: "/var/lib/telegram-bot-api" },
    current,
  );
  assert.equal(next.mode, "self-hosted");
  assert.equal(next.apiRoot, "https://tg.example.com");
  assert.equal(next.localMode, true);
  assert.equal(next.localFileRoot, "/var/lib/telegram-bot-api");
});

test("coerceBotApiConfig: clears localFileRoot when localMode disabled", () => {
  const current = { mode: "self-hosted", apiRoot: "https://tg.example.com", localMode: true, localFileRoot: "/data" };
  const next = coerceBotApiConfig({ localMode: false }, current);
  assert.equal(next.localMode, false);
  assert.equal(next.localFileRoot, null);
});

// ---------------------------------------------------------------------------
// Local file root validation
// ---------------------------------------------------------------------------

test("normalizeLocalFileRoot: requires absolute path", () => {
  assert.throws(() => normalizeLocalFileRoot("relative/path"), code("TELEGRAM_API_ROOT_INVALID"));
  assert.throws(() => normalizeLocalFileRoot("../etc"), code("TELEGRAM_API_ROOT_INVALID"));
});

test("normalizeLocalFileRoot: strips trailing slash", () => {
  assert.equal(normalizeLocalFileRoot("/var/lib/telegram-bot-api/"), "/var/lib/telegram-bot-api");
});

test("normalizeLocalFileRoot: null/empty returns null", () => {
  assert.equal(normalizeLocalFileRoot(null), null);
  assert.equal(normalizeLocalFileRoot(""), null);
  assert.equal(normalizeLocalFileRoot("   "), null);
});

// ---------------------------------------------------------------------------
// Token masking & scrubbing
// ---------------------------------------------------------------------------

test("maskToken: redacts the secret segment", () => {
  assert.equal(maskToken("123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxx"), "1234…<redacted>");
  assert.equal(maskToken(""), "<empty>");
  assert.equal(maskToken("no-colon-here"), "<redacted>");
});

test("scrubToken: removes the token from an error string", () => {
  const token = "123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const msg = `request to https://api.telegram.org/bot${token}/getMe failed`;
  assert.ok(!scrubToken(msg, token).includes(token));
  assert.ok(scrubToken(msg, token).includes("<token>"));
});
