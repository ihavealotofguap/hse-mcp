import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { resolveOutboxFiles, isInsideDir } = await import(
  new URL("../dist/services/writes/outbox.js", import.meta.url).href
);
const { config } = await import(new URL("../dist/config.js", import.meta.url).href);
const { projectRoot } = await import(new URL("../dist/project-root.js", import.meta.url).href);

const A_CONTENT = "hello"; // 5 байт
const BIG = Buffer.alloc(2048, 7);

/** Папка «исходящих» + соседняя внешняя папка; возвращает пути и уборку. */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-outbox-"));
  const dir = path.join(root, "outbox");
  const outside = path.join(root, "outbox-evil");
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, "sub"));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(dir, "a.txt"), A_CONTENT);
  fs.writeFileSync(path.join(dir, "empty.txt"), "");
  fs.writeFileSync(path.join(dir, "big.bin"), BIG);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  return { root, dir, outside, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Отказ: бросает, а текст не содержит имени файла и его осмысленных фрагментов. */
async function assertRefused(names, opts, hint) {
  await assert.rejects(
    () => resolveOutboxFiles(names, opts),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length > 0);
      for (const name of names) {
        if (name.length > 0) assert.ok(!err.message.includes(name), `имя в тексте ошибки: ${err.message}`);
        for (const token of name.split(/[^A-Za-z0-9]+/)) {
          if (token.length >= 3) assert.ok(!err.message.includes(token), `фрагмент «${token}» в тексте: ${err.message}`);
        }
      }
      assert.ok(!err.message.includes(opts.dir), "путь папки в тексте ошибки");
      if (hint) assert.match(err.message, hint);
      return true;
    }
  );
}

test("корректные имена: size и sha256 верны, absPath внутри папки", async () => {
  const s = setup();
  try {
    const files = await resolveOutboxFiles(["a.txt", "big.bin"], { dir: s.dir });
    assert.equal(files.length, 2);
    assert.equal(files[0].name, "a.txt");
    assert.equal(files[0].size, 5);
    assert.equal(files[0].sha256, sha(Buffer.from(A_CONTENT)));
    assert.equal(files[1].name, "big.bin");
    assert.equal(files[1].size, 2048);
    assert.equal(files[1].sha256, sha(BIG));
    for (const f of files) {
      assert.ok(path.isAbsolute(f.absPath));
      assert.ok(isInsideDir(fs.realpathSync.native(s.dir), f.absPath));
      assert.deepEqual(fs.readFileSync(f.absPath), fs.readFileSync(path.join(s.dir, f.name)));
    }
  } finally {
    s.cleanup();
  }
});

test("папка с другим регистром и хвостовым разделителем принимается", async () => {
  const s = setup();
  try {
    const odd = process.platform === "win32" ? (s.dir + path.sep).toUpperCase() : s.dir + path.sep;
    const files = await resolveOutboxFiles(["a.txt"], { dir: odd });
    assert.equal(files[0].size, 5);
  } finally {
    s.cleanup();
  }
});

test("относительная папка с .. внутри принимается (нормализуется)", async () => {
  const s = setup();
  try {
    const files = await resolveOutboxFiles(["a.txt"], { dir: path.join(s.dir, "sub", "..") });
    assert.equal(files[0].name, "a.txt");
  } finally {
    s.cleanup();
  }
});

const BAD_NAMES = [
  ["..\\x", /файл №1/i],
  ["../x", /файл №1/i],
  ["C:\\x.txt", /файл №1/i],
  ["a/b.txt", /файл №1/i],
  ["a:b", /файл №1/i],
  ["a.txt:stream", /файл №1/i],
  ["", /файл №1/i],
  ["..", /файл №1/i],
  [".", /файл №1/i],
  ["a\0b", /файл №1/i],
  ["a.txt.", /файл №1/i],
  ["a.txt ", /файл №1/i],
  ["CON", /файл №1/i],
  ["nul.txt", /файл №1/i],
  ["Com1.log", /файл №1/i],
  ["lpt9", /файл №1/i],
  ["a*.txt", /файл №1/i],
  ["x".repeat(300), /файл №1/i],
  ["sub", /файл №1/i],
  ["empty.txt", /файл №1/i],
  ["missing.txt", /файл №1/i],
];

for (const [name, hint] of BAD_NAMES) {
  test(`отказ без имени в тексте: ${JSON.stringify(name.length > 20 ? name.slice(0, 5) + "…" : name)}`, async () => {
    const s = setup();
    try {
      await assertRefused([name], { dir: s.dir }, hint);
    } finally {
      s.cleanup();
    }
  });
}

test("номер файла в отказе соответствует позиции", async () => {
  const s = setup();
  try {
    await assertRefused(["a.txt", "big.bin", "missing.txt"], { dir: s.dir }, /файл №3/i);
  } finally {
    s.cleanup();
  }
});

test("пустой список, дубликаты, больше maxFiles", async () => {
  const s = setup();
  try {
    await assertRefused([], { dir: s.dir });
    await assertRefused(["a.txt", "a.txt"], { dir: s.dir }, /файл №2/i);
    if (process.platform === "win32") await assertRefused(["a.txt", "A.TXT"], { dir: s.dir });
    const eleven = Array.from({ length: 11 }, (_, i) => `f${i}.txt`);
    await assertRefused(eleven, { dir: s.dir });
    // 11 существующих файлов — всё равно отказ по числу
    for (const n of eleven) fs.writeFileSync(path.join(s.dir, n), "x");
    await assertRefused(eleven, { dir: s.dir });
    const ten = eleven.slice(0, 10);
    assert.equal((await resolveOutboxFiles(ten, { dir: s.dir })).length, 10);
    await assertRefused(ten, { dir: s.dir, maxFiles: 3 });
  } finally {
    s.cleanup();
  }
});

test("maxBytes: файл больше лимита — отказ, не больше — принят", async () => {
  const s = setup();
  try {
    await assertRefused(["big.bin"], { dir: s.dir, maxBytes: 1024 }, /файл №1/i);
    assert.equal((await resolveOutboxFiles(["big.bin"], { dir: s.dir, maxBytes: 2048 }))[0].size, 2048);
  } finally {
    s.cleanup();
  }
});

test("несуществующая папка — отказ без пути", async () => {
  const s = setup();
  try {
    await assertRefused(["a.txt"], { dir: path.join(s.root, "no-such-dir") });
  } finally {
    s.cleanup();
  }
});

test("junction наружу: отказ", async (t) => {
  const s = setup();
  try {
    try {
      fs.symlinkSync(s.outside, path.join(s.dir, "jn"), "junction");
    } catch {
      t.skip("нет прав на создание junction");
      return;
    }
    await assertRefused(["jn"], { dir: s.dir }, /файл №1/i);
  } finally {
    s.cleanup();
  }
});

test("симлинк на внешний файл: отказ", async (t) => {
  const s = setup();
  try {
    try {
      fs.symlinkSync(path.join(s.outside, "secret.txt"), path.join(s.dir, "link.txt"), "file");
    } catch {
      t.skip("нет прав на создание симлинка");
      return;
    }
    await assertRefused(["link.txt"], { dir: s.dir }, /файл №1/i);
  } finally {
    s.cleanup();
  }
});

test("симлинк на файл в соседней папке с общим префиксом: отказ", async (t) => {
  const s = setup();
  try {
    try {
      fs.symlinkSync(path.join("..", "outbox-evil", "secret.txt"), path.join(s.dir, "rel.txt"), "file");
    } catch {
      t.skip("нет прав на создание симлинка");
      return;
    }
    await assertRefused(["rel.txt"], { dir: s.dir }, /файл №1/i);
  } finally {
    s.cleanup();
  }
});

test("isInsideDir: граница по разделителю, регистр, хвостовой разделитель, корень", () => {
  const sep = path.sep;
  const base = process.platform === "win32" ? "C:\\box" : "/box";
  assert.equal(isInsideDir(base, base + sep + "a.txt"), true);
  assert.equal(isInsideDir(base + sep, base + sep + "a.txt"), true);
  assert.equal(isInsideDir(base, base + "-evil" + sep + "a.txt"), false);
  assert.equal(isInsideDir(base, base), false);
  assert.equal(isInsideDir(base, path.dirname(base)), false);
  if (process.platform === "win32") {
    assert.equal(isInsideDir("C:\\Box", "c:\\BOX\\a.txt"), true);
    assert.equal(isInsideDir("\\\\?\\C:\\box", "C:\\box\\a.txt"), true);
    assert.equal(isInsideDir("C:\\box", "\\\\?\\c:\\box\\a.txt"), true);
    assert.equal(isInsideDir("C:\\", "C:\\a.txt"), true);
    assert.equal(isInsideDir("C:\\box", "D:\\box\\a.txt"), false);
  } else {
    assert.equal(isInsideDir("/", "/a.txt"), true);
    assert.equal(isInsideDir("/Box", "/box/a.txt"), false);
  }
});

test("config.outboxDir: по умолчанию storage/outbox, HSE_OUTBOX_DIR абсолютный и относительный", () => {
  const saved = process.env.HSE_OUTBOX_DIR;
  try {
    delete process.env.HSE_OUTBOX_DIR;
    assert.equal(config.outboxDir, path.join(projectRoot, "storage", "outbox"));
    process.env.HSE_OUTBOX_DIR = "   ";
    assert.equal(config.outboxDir, path.join(projectRoot, "storage", "outbox"));
    const abs = path.join(os.tmpdir(), "hsemcp-outbox-abs");
    process.env.HSE_OUTBOX_DIR = abs;
    assert.equal(config.outboxDir, abs);
    process.env.HSE_OUTBOX_DIR = "my-outbox";
    assert.equal(config.outboxDir, path.join(projectRoot, "my-outbox"));
  } finally {
    if (saved === undefined) delete process.env.HSE_OUTBOX_DIR;
    else process.env.HSE_OUTBOX_DIR = saved;
  }
});
