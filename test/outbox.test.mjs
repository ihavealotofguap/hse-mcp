import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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
        if (name.length > 0)
          assert.ok(!err.message.includes(name), `имя в тексте ошибки: ${err.message}`);
        for (const token of name.split(/[^A-Za-z0-9]+/)) {
          if (token.length >= 3)
            assert.ok(!err.message.includes(token), `фрагмент «${token}» в тексте: ${err.message}`);
        }
      }
      // Корень диска («/» на Linux и macOS) встречается в любом тексте — проверка имеет смысл только
      // для настоящей папки.
      if (path.parse(opts.dir).root !== opts.dir) {
        assert.ok(!err.message.includes(opts.dir), "путь папки в тексте ошибки");
      }
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
  test(`отказ без имени в тексте: ${JSON.stringify(name.length > 20 ? `${name.slice(0, 5)}…` : name)}`, async () => {
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
    assert.equal(
      (await resolveOutboxFiles(["big.bin"], { dir: s.dir, maxBytes: 2048 }))[0].size,
      2048
    );
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
      fs.symlinkSync(
        path.join("..", "outbox-evil", "secret.txt"),
        path.join(s.dir, "rel.txt"),
        "file"
      );
    } catch {
      t.skip("нет прав на создание симлинка");
      return;
    }
    await assertRefused(["rel.txt"], { dir: s.dir }, /файл №1/i);
  } finally {
    s.cleanup();
  }
});

test("name — имя на диске (basename realpath), а не написание из запроса", async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.dir, "Report.PDF"), "x");
    // на Windows (регистронезависимая ФС) запрос «report.pdf» находит «Report.PDF»; на POSIX имя совпадает буквально
    const asked = process.platform === "win32" ? "report.pdf" : "Report.PDF";
    const [f] = await resolveOutboxFiles([asked], { dir: s.dir });
    assert.equal(f.name, "Report.PDF");
    assert.equal(f.name, path.basename(f.absPath));
  } finally {
    s.cleanup();
  }
});

test("дубликат по realpath: симлинк на файл внутри папки — «тот же файл»", async (t) => {
  const s = setup();
  try {
    try {
      fs.symlinkSync(path.join(s.dir, "a.txt"), path.join(s.dir, "alias.txt"), "file");
    } catch {
      t.skip("нет прав на создание симлинка");
      return;
    }
    await assertRefused(["a.txt", "alias.txt"], { dir: s.dir }, /файл №2: тот же файл, что и №1/i);
  } finally {
    s.cleanup();
  }
});

test("жёсткие ссылки на один файл — разные записи каталога (разные realpath): принимаются как два файла с одним sha256", async (t) => {
  const s = setup();
  try {
    try {
      fs.linkSync(path.join(s.dir, "a.txt"), path.join(s.dir, "hard.txt"));
    } catch {
      t.skip("жёсткие ссылки недоступны");
      return;
    }
    const files = await resolveOutboxFiles(["a.txt", "hard.txt"], { dir: s.dir });
    assert.equal(files.length, 2);
    assert.equal(files[0].sha256, files[1].sha256);
    assert.deepEqual(
      files.map((f) => f.name),
      ["a.txt", "hard.txt"]
    );
  } finally {
    s.cleanup();
  }
});

test("FIFO в папке: отказ без зависания (POSIX)", async (t) => {
  if (process.platform === "win32") return t.skip("FIFO — только POSIX");
  const s = setup();
  try {
    const made = spawnSync("mkfifo", [path.join(s.dir, "pipe")]);
    if (made.status !== 0) return t.skip("mkfifo недоступен");
    let timer;
    const hang = new Promise(
      (_, reject) =>
        (timer = setTimeout(() => reject(new Error("resolveOutboxFiles завис на FIFO")), 3000))
    );
    try {
      await Promise.race([
        assertRefused(["pipe"], { dir: s.dir }, /файл №1: не обычный файл/i),
        hang,
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    s.cleanup();
  }
});

test("папка «исходящих» не должна совпадать с корнем проекта, его storage, содержать их или быть корнем диска", async () => {
  const s = setup();
  try {
    const fakeRoot = path.join(s.root, "proj");
    const storage = path.join(fakeRoot, "storage");
    fs.mkdirSync(path.join(storage, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, ".env"), "HSE_PASSWORD=x");
    fs.writeFileSync(path.join(storage, "hse-session.json"), "{}");
    fs.writeFileSync(path.join(storage, "outbox", "ok.txt"), "ok");

    const refusal = /Папка «исходящих» настроена неверно/;
    // без реквизитов: ни .env, ни hse-session.json по имени не адресуются ни в одном из случаев
    await assertRefused([".env"], { dir: fakeRoot, projectRoot: fakeRoot }, refusal);
    await assertRefused(["hse-session.json"], { dir: storage, projectRoot: fakeRoot }, refusal);
    await assertRefused(["a.txt"], { dir: s.root, projectRoot: fakeRoot }, refusal); // родитель корня проекта
    await assertRefused(
      ["a.txt"],
      { dir: path.parse(s.root).root, projectRoot: fakeRoot },
      refusal
    ); // корень диска
    // обычная подпапка внутри проекта (storage/outbox) допустима
    const files = await resolveOutboxFiles(["ok.txt"], {
      dir: path.join(storage, "outbox"),
      projectRoot: fakeRoot,
    });
    assert.equal(files[0].name, "ok.txt");
    // и папка рядом с проектом
    assert.equal(
      (await resolveOutboxFiles(["a.txt"], { dir: s.dir, projectRoot: fakeRoot }))[0].size,
      5
    );
  } finally {
    s.cleanup();
  }
});

test("внутри storage разрешена только storage/outbox (и её подпапки): storage/writes и прочие — отказ", async () => {
  const s = setup();
  try {
    const fakeRoot = path.join(s.root, "proj");
    const storage = path.join(fakeRoot, "storage");
    for (const sub of ["writes", "hse-sessions", "changes", "outbox", path.join("outbox", "sub")]) {
      fs.mkdirSync(path.join(storage, sub), { recursive: true });
      fs.writeFileSync(path.join(storage, sub, "f.txt"), "data");
    }
    fs.writeFileSync(path.join(storage, "writes", "key"), "secret-key");
    fs.writeFileSync(path.join(storage, "writes", "journal.json"), "[]");

    const refusal = /Папка «исходящих» настроена неверно/;
    await assertRefused(
      ["key"],
      { dir: path.join(storage, "writes"), projectRoot: fakeRoot },
      refusal
    );
    await assertRefused(
      ["journal.json"],
      { dir: path.join(storage, "writes"), projectRoot: fakeRoot },
      refusal
    );
    await assertRefused(
      ["f.txt"],
      { dir: path.join(storage, "hse-sessions"), projectRoot: fakeRoot },
      refusal
    );
    await assertRefused(
      ["f.txt"],
      { dir: path.join(storage, "changes"), projectRoot: fakeRoot },
      refusal
    );
    // сама storage/outbox и её подпапка допустимы
    assert.equal(
      (
        await resolveOutboxFiles(["f.txt"], {
          dir: path.join(storage, "outbox"),
          projectRoot: fakeRoot,
        })
      )[0].size,
      4
    );
    assert.equal(
      (
        await resolveOutboxFiles(["f.txt"], {
          dir: path.join(storage, "outbox", "sub"),
          projectRoot: fakeRoot,
        })
      )[0].size,
      4
    );
    // папка вне проекта и внутри проекта, но вне storage — допустимы
    assert.equal(
      (await resolveOutboxFiles(["a.txt"], { dir: s.dir, projectRoot: fakeRoot }))[0].size,
      5
    );
    fs.mkdirSync(path.join(fakeRoot, "my-outbox"));
    fs.writeFileSync(path.join(fakeRoot, "my-outbox", "f.txt"), "data");
    assert.equal(
      (
        await resolveOutboxFiles(["f.txt"], {
          dir: path.join(fakeRoot, "my-outbox"),
          projectRoot: fakeRoot,
        })
      )[0].size,
      4
    );
  } finally {
    s.cleanup();
  }
});

test("storage — junction наружу: папка внутри цели junction считается лежащей в storage", async (t) => {
  const s = setup();
  try {
    const fakeRoot = path.join(s.root, "proj");
    const realStorage = path.join(s.root, "real-storage");
    fs.mkdirSync(path.join(realStorage, "writes"), { recursive: true });
    fs.mkdirSync(path.join(realStorage, "outbox"), { recursive: true });
    fs.writeFileSync(path.join(realStorage, "writes", "key"), "secret-key");
    fs.writeFileSync(path.join(realStorage, "outbox", "ok.txt"), "ok");
    fs.mkdirSync(fakeRoot);
    try {
      fs.symlinkSync(realStorage, path.join(fakeRoot, "storage"), "junction");
    } catch {
      t.skip("нет прав на создание junction");
      return;
    }
    const refusal = /Папка «исходящих» настроена неверно/;
    // обращение к каталогу напрямую (минуя junction) всё равно раскрывается в тот же storage
    await assertRefused(
      ["key"],
      { dir: path.join(realStorage, "writes"), projectRoot: fakeRoot },
      refusal
    );
    await assertRefused(
      ["key"],
      { dir: path.join(fakeRoot, "storage", "writes"), projectRoot: fakeRoot },
      refusal
    );
    await assertRefused(["key"], { dir: realStorage, projectRoot: fakeRoot }, refusal);
    assert.equal(
      (
        await resolveOutboxFiles(["ok.txt"], {
          dir: path.join(fakeRoot, "storage", "outbox"),
          projectRoot: fakeRoot,
        })
      )[0].size,
      2
    );
    assert.equal(
      (
        await resolveOutboxFiles(["ok.txt"], {
          dir: path.join(realStorage, "outbox"),
          projectRoot: fakeRoot,
        })
      )[0].size,
      2
    );
  } finally {
    s.cleanup();
  }
});

test("isInsideDir: граница по разделителю, регистр, хвостовой разделитель, корень", () => {
  const sep = path.sep;
  const base = process.platform === "win32" ? "C:\\box" : "/box";
  assert.equal(isInsideDir(base, `${base + sep}a.txt`), true);
  assert.equal(isInsideDir(base + sep, `${base + sep}a.txt`), true);
  assert.equal(isInsideDir(base, `${base}-evil${sep}a.txt`), false);
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
