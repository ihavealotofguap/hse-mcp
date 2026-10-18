import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { signPreview, verifyPreview, tokenIdOf, targetIdOf, loadOrCreateKey, PREVIEW_TTL_MS, writesDir } = await import(
  new URL("../dist/services/writes/token.js", import.meta.url).href
);

const KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-01-01T12:00:00Z");
const minutes = (n) => new Date(NOW.getTime() + n * 60_000);

const payload = () => ({
  op: "lms_submit_assignment",
  target: "target-1",
  mode: "replace",
  files: [
    { name: "a.pdf", sha256: "aa".repeat(32) },
    { name: "b.pdf", sha256: "bb".repeat(32) },
  ],
  state: "state-1",
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-token-"));
}

test("verify(sign(p)) — ok, tokenId из 12 hex совпадает с tokenIdOf", () => {
  const token = signPreview(KEY, payload(), NOW);
  assert.match(token, /^\d+\.[0-9a-f]{64}$/);
  const r = verifyPreview(KEY, token, payload(), NOW);
  assert.equal(r.ok, true);
  assert.match(r.tokenId, /^[0-9a-f]{12}$/);
  assert.equal(r.tokenId, tokenIdOf(token));
  assert.equal(r.issuedAt.getTime(), Math.floor(NOW.getTime() / 1000) * 1000);
});

test("смена op, target, mode, файла или state — mismatch", () => {
  const token = signPreview(KEY, payload(), NOW);
  const variants = {
    op: (p) => (p.op = "lms_other"),
    target: (p) => (p.target = "target-2"),
    mode: (p) => (p.mode = "add"),
    "mode убран": (p) => delete p.mode,
    "имя файла": (p) => (p.files[0].name = "c.pdf"),
    "sha256 файла": (p) => (p.files[1].sha256 = "cc".repeat(32)),
    "файл добавлен": (p) => p.files.push({ name: "c.pdf", sha256: "cc".repeat(32) }),
    "файл убран": (p) => p.files.pop(),
    state: (p) => (p.state = "state-2"),
  };
  for (const [name, change] of Object.entries(variants)) {
    const p = payload();
    change(p);
    assert.deepEqual(verifyPreview(KEY, token, p, NOW), { ok: false, reason: "mismatch" }, name);
  }
});

test("токен submit не подходит к delete", () => {
  const token = signPreview(KEY, { ...payload(), op: "lms_submit_assignment" }, NOW);
  const r = verifyPreview(KEY, token, { ...payload(), op: "lms_delete_submission" }, NOW);
  assert.deepEqual(r, { ok: false, reason: "mismatch" });
});

test("другой ключ — mismatch", () => {
  const token = signPreview(KEY, payload(), NOW);
  assert.deepEqual(verifyPreview(Buffer.alloc(32, 8), token, payload(), NOW), { ok: false, reason: "mismatch" });
});

test("срок: +16 мин — expired, +14 мин — ok", () => {
  assert.equal(PREVIEW_TTL_MS, 15 * 60_000);
  const token = signPreview(KEY, payload(), NOW);
  assert.deepEqual(verifyPreview(KEY, token, payload(), minutes(16)), { ok: false, reason: "expired" });
  assert.equal(verifyPreview(KEY, token, payload(), minutes(14)).ok, true);
});

test("мусор и пустая строка — malformed", () => {
  for (const bad of ["garbage", "1.zz", "", ".", "1.", `.${"a".repeat(64)}`, `x.${"a".repeat(64)}`, `1.${"a".repeat(63)}`]) {
    assert.deepEqual(verifyPreview(KEY, bad, payload(), NOW), { ok: false, reason: "malformed" }, JSON.stringify(bad));
    assert.equal(tokenIdOf(bad), null, JSON.stringify(bad));
  }
});

test("подмена хеша той же длины — mismatch", () => {
  const token = signPreview(KEY, payload(), NOW);
  const [sec, hash] = token.split(".");
  const flipped = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
  assert.equal(flipped.length, hash.length);
  assert.deepEqual(verifyPreview(KEY, `${sec}.${flipped}`, payload(), NOW), { ok: false, reason: "mismatch" });
});

test("подмена времени выпуска в токене — mismatch", () => {
  const token = signPreview(KEY, payload(), NOW);
  const [sec, hash] = token.split(".");
  assert.deepEqual(verifyPreview(KEY, `${Number(sec) + 1}.${hash}`, payload(), NOW), { ok: false, reason: "mismatch" });
});

test("два signPreview с разным now дают разные токены", () => {
  const a = signPreview(KEY, payload(), NOW);
  const b = signPreview(KEY, payload(), new Date(NOW.getTime() + 5000));
  assert.notEqual(a, b);
});

test("каноническая форма не зависит от порядка files и ключей объекта", () => {
  const token = signPreview(KEY, payload(), NOW);
  const p = payload();
  const reordered = {
    state: p.state,
    files: [...p.files].reverse().map((f) => ({ sha256: f.sha256, name: f.name })),
    mode: p.mode,
    target: p.target,
    op: p.op,
  };
  assert.equal(signPreview(KEY, reordered, NOW), token);
  assert.equal(verifyPreview(KEY, token, reordered, NOW).ok, true);
});

test("payload без mode подписывается и проверяется", () => {
  const p = payload();
  delete p.mode;
  const token = signPreview(KEY, p, NOW);
  assert.equal(verifyPreview(KEY, token, p, NOW).ok, true);
});

test("loadOrCreateKey: файл из 64 hex, повторный вызов — тот же ключ", async () => {
  const dir = tmpDir();
  try {
    const a = await loadOrCreateKey(dir);
    assert.equal(a.length, 32);
    assert.match(fs.readFileSync(path.join(dir, "key"), "utf8"), /^[0-9a-f]{64}$/);
    const b = await loadOrCreateKey(dir);
    assert.ok(a.equals(b));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("параллельные первые loadOrCreateKey дают один ключ", async () => {
  const dir = path.join(tmpDir(), "nested", "writes");
  try {
    const keys = await Promise.all(Array.from({ length: 10 }, () => loadOrCreateKey(dir)));
    for (const k of keys) assert.ok(k.equals(keys[0]));
    assert.ok((await loadOrCreateKey(dir)).equals(keys[0]));
  } finally {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
});

test("повреждённый файл ключа — отказ, а не молчаливая замена", async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "key"), "not-a-key");
    await assert.rejects(() => loadOrCreateKey(dir), /key/);
    assert.equal(fs.readFileSync(path.join(dir, "key"), "utf8"), "not-a-key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("targetIdOf: детерминирован, 12 hex, зависит от op, target и ключа", () => {
  const a = targetIdOf(KEY, "lms_submit_assignment", "t1");
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, targetIdOf(KEY, "lms_submit_assignment", "t1"));
  assert.notEqual(a, targetIdOf(KEY, "lms_delete_submission", "t1"));
  assert.notEqual(a, targetIdOf(KEY, "lms_submit_assignment", "t2"));
  assert.notEqual(a, targetIdOf(Buffer.alloc(32, 8), "lms_submit_assignment", "t1"));
});

test("writesDir: HSE_WRITES_DIR переопределяет каталог", () => {
  const saved = process.env.HSE_WRITES_DIR;
  try {
    process.env.HSE_WRITES_DIR = path.join(os.tmpdir(), "hsemcp-writes-x");
    assert.equal(writesDir(), process.env.HSE_WRITES_DIR);
    delete process.env.HSE_WRITES_DIR;
    assert.match(writesDir().replaceAll("\\", "/"), /storage\/writes$/);
  } finally {
    if (saved === undefined) delete process.env.HSE_WRITES_DIR;
    else process.env.HSE_WRITES_DIR = saved;
  }
});
