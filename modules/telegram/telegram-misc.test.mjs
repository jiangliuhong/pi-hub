import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  resolveLocalFile,
  buildHttpFileUrl,
  shouldFetchOverHttp,
} = await jiti.import("./telegram-files.ts");
const {
  generatePairingCode,
  hashPairingCode,
  verifyPairingCode,
} = await jiti.import("./telegram-pairing.ts");
const { classifyGrammyError, isValidBotTokenShape } = await jiti.import("./telegram-bot-client.ts");

const code = (c) => (err) => err && err.code === c;

// ---------------------------------------------------------------------------
// Local-mode file resolution
// ---------------------------------------------------------------------------

test("resolveLocalFile: returns realpath + size for a contained file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tgroot-"));
  try {
    const file = join(dir, "photos", "file_1.jpg");
    mkdirSync(join(dir, "photos"), { recursive: true });
    writeFileSync(file, Buffer.from("hello"));
    const r = resolveLocalFile(file, dir);
    assert.equal(r.size, 5);
    assert.ok(r.path.startsWith(realpathSync(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveLocalFile: rejects a path outside the root", () => {
  const dir = mkdtempSync(join(tmpdir(), "tgroot-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  try {
    assert.throws(() => resolveLocalFile(join(outside, "x"), dir), code("TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveLocalFile: rejects a symlink that escapes the root", () => {
  const dir = mkdtempSync(join(tmpdir(), "tgroot-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  try {
    writeFileSync(join(outside, "secret"), "x");
    // Create a symlink inside `dir` pointing outside.
    symlinkSync(join(outside, "secret"), join(dir, "escape"));
    assert.throws(
      () => resolveLocalFile(join(dir, "escape"), dir),
      code("TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveLocalFile: rejects non-absolute paths", () => {
  assert.throws(() => resolveLocalFile("relative.jpg", "/var/lib/x"), code("TELEGRAM_LOCAL_FILE_UNAVAILABLE"));
});

test("resolveLocalFile: rejects oversize files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tgroot-"));
  try {
    writeFileSync(join(dir, "big"), Buffer.alloc(10));
    assert.throws(
      () => resolveLocalFile(join(dir, "big"), dir, 5),
      code("TELEGRAM_FILE_TOO_LARGE"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldFetchOverHttp: relative path → http; absolute path → local", () => {
  assert.equal(shouldFetchOverHttp("photos/file_1.jpg"), true);
  assert.equal(shouldFetchOverHttp("/var/lib/telegram-bot-api/x"), false);
});

test("buildHttpFileUrl: uses configured apiRoot", () => {
  const url = buildHttpFileUrl("https://tg.example.com", "BOT:TOK", "photos/f.jpg");
  assert.equal(url, "https://tg.example.com/file/botBOT:TOK/photos/f.jpg");
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

test("generatePairingCode: 6 digits", () => {
  const c = generatePairingCode();
  assert.equal(c.length, 6);
  assert.match(c, /^\d{6}$/);
});

test("verifyPairingCode: round-trip + wrong code rejected (constant time)", () => {
  const plaintext = "123456";
  const hash = hashPairingCode(plaintext);
  assert.equal(verifyPairingCode(plaintext, hash), true);
  assert.equal(verifyPairingCode("000000", hash), false);
  assert.equal(verifyPairingCode(plaintext, "garbage"), false);
});

test("hashPairingCode: produces unique hashes (random salt)", () => {
  const a = hashPairingCode("111111");
  const b = hashPairingCode("111111");
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Bot token shape + error classification
// ---------------------------------------------------------------------------

test("isValidBotTokenShape: accepts valid, rejects malformed", () => {
  assert.equal(isValidBotTokenShape("123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxx"), true);
  assert.equal(isValidBotTokenShape("not-a-token"), false);
  assert.equal(isValidBotTokenShape(""), false);
  assert.equal(isValidBotTokenShape("12345"), false);
});

test("classifyGrammyError: 409 → TOKEN_IN_USE", () => {
  const err = { error_code: 409, description: "Conflict: terminated by other getUpdates request", message: "" };
  const e = classifyGrammyError(err, "123:abc");
  assert.equal(e.code, "TELEGRAM_TOKEN_IN_USE");
});

test("classifyGrammyError: 401 → TOKEN_INVALID", () => {
  const err = { error_code: 401, description: "Unauthorized", message: "" };
  const e = classifyGrammyError(err, "123:abc");
  assert.equal(e.code, "TELEGRAM_TOKEN_INVALID");
});

test("classifyGrammyError: 429 → RATE_LIMITED with retry_after", () => {
  const err = { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 }, message: "" };
  const e = classifyGrammyError(err, "123:abc");
  assert.equal(e.code, "TELEGRAM_RATE_LIMITED");
  assert.match(e.message, /30/);
});

test("classifyGrammyError: connection error → UNREACHABLE", () => {
  const err = new Error("fetch failed: ECONNREFUSED");
  const e = classifyGrammyError(err, "123:abc");
  assert.equal(e.code, "TELEGRAM_API_ROOT_UNREACHABLE");
});

test("classifyGrammyError: TLS error → TLS_ERROR", () => {
  const err = new Error("self-signed certificate in certificate chain");
  const e = classifyGrammyError(err, "123:abc");
  assert.equal(e.code, "TELEGRAM_TLS_ERROR");
});

test("classifyGrammyError: scrubs the token out of the message", () => {
  const token = "123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const err = new Error(`request to bot${token}/getMe failed: ECONNREFUSED`);
  const e = classifyGrammyError(err, token);
  assert.ok(!e.message.includes(token), "token leaked into classified error message");
});
