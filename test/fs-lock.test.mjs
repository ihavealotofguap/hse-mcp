import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { withFileLock, writeFileAtomic } = await import(new URL("../dist/fs-lock.js", import.meta.url).href);
const { withStateLock, loadState, saveState, emptyState } = await import(
  new URL("../dist/services/changes/store.js", import.meta.url).href
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-fslock-"));
}

test("20 параллельных withFileLock не теряют инкременты", async () => {
  const dir = tmpDir();
  try {
    const lock = path.join(dir, "counter.lock");
    const counter = path.join(dir, "counter.txt");
    await writeFileAtomic(counter, "0");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withFileLock(lock, async () => {
          const n = Number(fs.readFileSync(counter, "utf8"));
          await new Promise((resolve) => setTimeout(resolve, 2));
          await writeFileAtomic(counter, String(n + 1));
        })
      )
    );
    assert.equal(fs.readFileSync(counter, "utf8"), "20");
    assert.equal(fs.existsSync(lock), false, "lock-файл снят");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("устаревшая (> 30 с) блокировка снимается", async () => {
  const dir = tmpDir();
  try {
    const lock = path.join(dir, "stale.lock");
    fs.writeFileSync(lock, "чужой токен");
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(lock, old, old);
    const result = await withFileLock(lock, async () => "прошло", { waitMs: 3000 });
    assert.equal(result, "прошло");
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("свежая чужая блокировка не снимается: вызов ждёт и бросает по таймауту", async () => {
  const dir = tmpDir();
  try {
    const lock = path.join(dir, "busy.lock");
    fs.writeFileSync(lock, "чужой токен");
    let ran = false;
    await assert.rejects(
      withFileLock(
        lock,
        async () => {
          ran = true;
        },
        { waitMs: 200 }
      ),
      /занят другим процессом/
    );
    assert.equal(ran, false);
    assert.equal(fs.readFileSync(lock, "utf8"), "чужой токен", "чужая блокировка на месте");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic не оставляет *.tmp и заменяет содержимое", async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "data.json");
    await writeFileAtomic(file, "один");
    await writeFileAtomic(file, "два");
    assert.equal(fs.readFileSync(file, "utf8"), "два");
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic при ошибке не оставляет tmp", async () => {
  const dir = tmpDir();
  try {
    const target = path.join(dir, "target");
    fs.mkdirSync(target); // rename файла поверх каталога не удаётся
    await assert.rejects(writeFileAtomic(target, "x"));
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changes: 10 withStateLock с loadState/saveState не ломают state.json", async () => {
  const dir = tmpDir();
  try {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withStateLock(dir, async () => {
          const loaded = await loadState(dir);
          const state = loaded.kind === "ok" ? loaded.state : emptyState();
          const expected = loaded.kind === "ok" ? state.rev : null;
          state.rev += 1;
          const saved = await saveState(dir, state, expected);
          assert.equal(saved.ok, true);
        })
      )
    );
    const after = await loadState(dir);
    assert.equal(after.kind, "ok");
    assert.equal(after.state.rev, 10, "rev не регрессирует");
    assert.equal(fs.existsSync(path.join(dir, "state.json.lock")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
