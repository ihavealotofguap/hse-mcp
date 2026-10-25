import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

const { resolveDataDir, dataDir } = await import(
  new URL("../dist/data-dir.js", import.meta.url).href
);
const { projectRoot } = await import(new URL("../dist/project-root.js", import.meta.url).href);

const root = path.resolve("/opt/hsemcp");
const home = path.resolve("/home/student");
const args = (over = {}) => ({
  env: {},
  platform: "linux",
  root,
  home,
  exists: () => false,
  ...over,
});

test("HSE_DATA_DIR: абсолютный как есть, относительный — от корня проекта, пробелы не считаются", () => {
  const abs = path.resolve("/srv/hse-data");
  assert.equal(resolveDataDir(args({ env: { HSE_DATA_DIR: abs } })), abs);
  assert.equal(resolveDataDir(args({ env: { HSE_DATA_DIR: "data" } })), path.join(root, "data"));
  assert.equal(
    resolveDataDir(args({ env: { HSE_DATA_DIR: "  " } })),
    path.join(home, ".local", "share", "hsemcp")
  );
});

test("клон репозитория или существующий storage/ — storage/ в корне проекта, как раньше", () => {
  const git = path.join(root, ".git");
  const storage = path.join(root, "storage");
  assert.equal(resolveDataDir(args({ exists: (p) => p === git })), storage);
  assert.equal(resolveDataDir(args({ exists: (p) => p === storage, platform: "win32" })), storage);
});

test("пакет без .git — каталог пользователя по платформе", () => {
  assert.equal(
    resolveDataDir(
      args({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" } })
    ),
    path.join("C:\\Users\\s\\AppData\\Local", "hsemcp")
  );
  assert.equal(
    resolveDataDir(args({ platform: "win32" })),
    path.join(home, "AppData", "Local", "hsemcp")
  );
  assert.equal(
    resolveDataDir(args({ platform: "darwin" })),
    path.join(home, "Library", "Application Support", "hsemcp")
  );
  assert.equal(
    resolveDataDir(args({ env: { XDG_DATA_HOME: "/xdg" } })),
    path.join("/xdg", "hsemcp")
  );
});

test("в клоне (тесты идут из него) каталог данных — storage/ проекта", () => {
  const saved = process.env.HSE_DATA_DIR;
  delete process.env.HSE_DATA_DIR;
  try {
    assert.equal(dataDir(), path.join(projectRoot, "storage"));
  } finally {
    if (saved !== undefined) process.env.HSE_DATA_DIR = saved;
  }
});
