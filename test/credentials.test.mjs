import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

const {
  lookupPassword,
  dotenvPermissionWarning,
  permissionWarningForMode,
  loadKeyStore,
  KEYCHAIN_SERVICE,
  DOTENV_PASSWORD_WARNING,
  captureCredentialInputs,
} = await import(new URL("../dist/credentials.js", import.meta.url).href);
const { restrictFile, restrictDir, windowsAccount } = await import(
  new URL("../dist/fs-secure.js", import.meta.url).href
);
const { runCli, createLineReader, readSecretFrom, createStdinIo } = await import(
  new URL("../dist/cli/credentials.js", import.meta.url).href
);

// Подставные значения: настоящих паролей и адресов в тестах нет.
const SECRET = "s3cret-test-value";
const EMAIL = "fake.student@edu.hse.example";
const isWin = process.platform === "win32";

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getPassword: (a) => data.get(a) ?? null,
    setPassword: (a, p) => void data.set(a, p),
    deletePassword: (a) => data.delete(a),
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-cred-"));
}

// --- lookupPassword -----------------------------------------------------------------------------

test("lookupPassword: env побеждает хранилище и .env", () => {
  const r = lookupPassword({
    env: { HSE_PASSWORD: "from-env" },
    dotenv: { HSE_PASSWORD: "from-dotenv" },
    account: EMAIL,
    store: fakeStore({ [EMAIL]: "from-store" }),
  });
  assert.deepEqual(r, { password: "from-env", source: "env" });
});

test("lookupPassword: хранилище побеждает .env", () => {
  const r = lookupPassword({
    env: {},
    dotenv: { HSE_PASSWORD: "from-dotenv" },
    account: EMAIL,
    store: fakeStore({ [EMAIL]: "from-store" }),
  });
  assert.deepEqual(r, { password: "from-store", source: "keychain" });
});

test("lookupPassword: пустая запись в хранилище для этой учётной записи — откат на .env", () => {
  const r = lookupPassword({
    env: {},
    dotenv: { HSE_PASSWORD: "from-dotenv" },
    account: EMAIL,
    store: fakeStore({ "other@example": "x" }),
  });
  assert.deepEqual(r, { password: "from-dotenv", source: "dotenv" });
});

test("lookupPassword: store === null — берётся .env", () => {
  const r = lookupPassword({
    env: {},
    dotenv: { HSE_PASSWORD: "from-dotenv" },
    account: EMAIL,
    store: null,
  });
  assert.deepEqual(r, { password: "from-dotenv", source: "dotenv" });
});

test("lookupPassword: нигде нет — { password: null, source: 'none' }", () => {
  assert.deepEqual(lookupPassword({ env: {}, dotenv: {}, account: EMAIL, store: fakeStore() }), {
    password: null,
    source: "none",
  });
  assert.deepEqual(lookupPassword({ env: {}, dotenv: {}, account: EMAIL, store: null }), {
    password: null,
    source: "none",
  });
});

test("lookupPassword: пустые строки не считаются паролем", () => {
  const r = lookupPassword({
    env: { HSE_PASSWORD: "" },
    dotenv: { HSE_PASSWORD: "" },
    account: EMAIL,
    store: fakeStore({ [EMAIL]: "" }),
  });
  assert.deepEqual(r, { password: null, source: "none" });
});

test("lookupPassword: без учётной записи хранилище не опрашивается", () => {
  const store = {
    getPassword: () => assert.fail("не должно вызываться"),
    setPassword: () => {},
    deletePassword: () => false,
  };
  const r = lookupPassword({ env: {}, dotenv: { HSE_PASSWORD: "d" }, account: "", store });
  assert.equal(r.source, "dotenv");
});

// --- предупреждения о правах .env ----------------------------------------------------------------

test("permissionWarningForMode: 0o644 на POSIX — строка без значений, 0o600 и win32 — null", () => {
  const w = permissionWarningForMode(0o100644, "linux");
  assert.equal(typeof w, "string");
  assert.ok(w.length > 0);
  assert.ok(!w.includes(SECRET) && !w.includes(EMAIL));
  assert.equal(permissionWarningForMode(0o100600, "linux"), null);
  assert.equal(permissionWarningForMode(0o100644, "win32"), null);
});

test("dotenvPermissionWarning: файл с режимом 0o644 — строка без пути и значений", (t) => {
  if (isWin) return t.skip("режимы POSIX на Windows не применяются");
  const dir = tmpDir();
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `HSE_PASSWORD=${SECRET}\n`);
  fs.chmodSync(file, 0o644);
  const w = dotenvPermissionWarning(file, "linux");
  assert.equal(typeof w, "string");
  assert.ok(!w.includes(SECRET));
  assert.ok(!w.includes(dir));
  fs.chmodSync(file, 0o600);
  assert.equal(dotenvPermissionWarning(file, "linux"), null);
});

test("dotenvPermissionWarning: win32 — null; несуществующий файл — null", () => {
  const dir = tmpDir();
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `HSE_PASSWORD=${SECRET}\n`);
  assert.equal(dotenvPermissionWarning(file, "win32"), null);
  assert.equal(dotenvPermissionWarning(path.join(dir, "missing"), "linux"), null);
});

test("предупреждение про .env не содержит значений", () => {
  assert.ok(DOTENV_PASSWORD_WARNING.includes("credentials:set"));
  assert.ok(!DOTENV_PASSWORD_WARNING.includes(SECRET) && !DOTENV_PASSWORD_WARNING.includes(EMAIL));
});

// --- restrictFile -------------------------------------------------------------------------------

test("restrictFile: на POSIX режим 0o600", (t) => {
  if (isWin) return t.skip("режимы POSIX на Windows не применяются");
  const dir = tmpDir();
  const file = path.join(dir, "secret");
  fs.writeFileSync(file, "x", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  restrictFile(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("restrictFile: на Windows снимает унаследованные права (нет записей (I))", (t) => {
  if (!isWin) return t.skip("проверка icacls только для Windows");
  const dir = tmpDir();
  const file = path.join(dir, "secret");
  fs.writeFileSync(file, "x");
  restrictFile(file);
  const acl = execFileSync("icacls", [file], { encoding: "latin1" });
  assert.ok(!acl.includes("(I)"), "остались унаследованные записи");
  assert.equal(fs.readFileSync(file, "utf8"), "x");
});

test("restrictFile: не бросает на отсутствующем файле, файл остаётся читаемым владельцу", () => {
  const dir = tmpDir();
  assert.doesNotThrow(() => restrictFile(path.join(dir, "missing")));
  const file = path.join(dir, "secret");
  fs.writeFileSync(file, "content");
  assert.doesNotThrow(() => restrictFile(file));
  assert.equal(fs.readFileSync(file, "utf8"), "content");
});

// --- loadKeyStore -------------------------------------------------------------------------------

test("loadKeyStore: модуля нет (импорт отклонён) — null", async () => {
  const store = await loadKeyStore(
    () => Promise.reject(new Error("Cannot find package")),
    "win32",
    {}
  );
  assert.equal(store, null);
});

test("loadKeyStore: модуль без Entry — null", async () => {
  assert.equal(await loadKeyStore(async () => ({}), "win32", {}), null);
});

test("loadKeyStore: оборачивает Entry со службой hsemcp и учётной записью", async () => {
  const calls = [];
  class FakeEntry {
    constructor(service, account, options) {
      calls.push({ service, account, options });
      this.account = account;
    }
    getPassword() {
      return this.account === EMAIL ? SECRET : null;
    }
    setPassword() {}
    deleteCredential() {
      return true;
    }
  }
  const store = await loadKeyStore(async () => ({ Entry: FakeEntry }), "win32", {});
  assert.ok(store);
  assert.equal(store.getPassword(EMAIL), SECRET);
  assert.equal(store.getPassword("other"), null);
  assert.equal(store.deletePassword(EMAIL), true);
  assert.equal(calls[0].service, KEYCHAIN_SERVICE);
  assert.equal(calls[0].service, "hsemcp");
  assert.equal(calls[0].options, undefined);
});

test("loadKeyStore: на Linux запись создаётся с secret-service; недоступен — null", async () => {
  const seen = [];
  class FakeEntry {
    constructor(_service, _account, options) {
      seen.push(options);
    }
    getPassword() {
      return null;
    }
    setPassword() {}
    deleteCredential() {
      return false;
    }
  }
  const store = await loadKeyStore(async () => ({ Entry: FakeEntry }), "linux", {});
  assert.ok(store);
  store.getPassword(EMAIL);
  assert.ok(seen.length >= 1);
  for (const o of seen) assert.deepEqual(o, { linux: { store: "secret-service" } });

  class BrokenEntry {
    constructor() {
      throw new Error("secret service is not available");
    }
  }
  assert.equal(await loadKeyStore(async () => ({ Entry: BrokenEntry }), "linux", {}), null);
});

test("loadKeyStore: getPassword глотает ошибку хранилища (откат на .env), set/delete — нет", async () => {
  class LockedEntry {
    getPassword() {
      throw new Error(`locked ${SECRET}`);
    }
    setPassword() {
      throw new Error("locked");
    }
    deleteCredential() {
      throw new Error("locked");
    }
  }
  const store = await loadKeyStore(async () => ({ Entry: LockedEntry }), "win32", {});
  assert.equal(store.getPassword(EMAIL), null);
  assert.throws(() => store.setPassword(EMAIL, SECRET));
  assert.throws(() => store.deletePassword(EMAIL));
});

test("откат: модуля нет → lookupPassword берёт .env", async () => {
  const store = await loadKeyStore(
    () => Promise.reject(new Error("MODULE_NOT_FOUND")),
    "win32",
    {}
  );
  const r = lookupPassword({ env: {}, dotenv: { HSE_PASSWORD: "d" }, account: EMAIL, store });
  assert.deepEqual(r, { password: "d", source: "dotenv" });
});

// --- CLI ----------------------------------------------------------------------------------------

function cliDeps(over = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: {
      env: {},
      dotenv: {},
      dotenvFile: null,
      store: fakeStore(),
      email: EMAIL,
      readSecret: async () => SECRET,
      readLine: async () => EMAIL,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      ...over,
    },
  };
}

function assertNoLeak(lines) {
  const text = lines.join("\n");
  assert.ok(!text.includes(SECRET), "в выводе есть пароль");
  assert.ok(!text.includes(EMAIL), "в выводе есть email");
}

test("CLI status: печатает только источник для каждого случая", async () => {
  const cases = [
    [{ env: { HSE_PASSWORD: SECRET } }, "env"],
    [{ store: fakeStore({ [EMAIL]: SECRET }) }, "keychain"],
    [{ dotenv: { HSE_PASSWORD: SECRET } }, "dotenv"],
    [{}, "none"],
  ];
  for (const [over, source] of cases) {
    const { deps, out, err } = cliDeps(over);
    const code = await runCli(["status"], deps);
    assert.equal(code, 0);
    assert.equal(out.length, 1);
    assert.match(out[0], new RegExp(`\\b${source}\\b`));
    assertNoLeak(out);
    assertNoLeak(err);
  }
});

test("CLI status: источник dotenv — предупреждение в stderr без значений", async () => {
  const { deps, err } = cliDeps({ dotenv: { HSE_PASSWORD: SECRET } });
  await runCli(["status"], deps);
  assert.ok(err.length >= 1);
  assert.ok(err.join("\n").includes("credentials:set"));
  assertNoLeak(err);
});

test("CLI status: без email хранилище не спрашивается", async () => {
  const { deps, out } = cliDeps({ email: null, dotenv: { HSE_PASSWORD: SECRET } });
  assert.equal(await runCli(["status"], deps), 0);
  assert.match(out[0], /dotenv/);
});

test("CLI set: пишет в хранилище, выводит подтверждение без значений", async () => {
  const store = fakeStore();
  const { deps, out, err } = cliDeps({ store });
  assert.equal(await runCli(["set"], deps), 0);
  assert.equal(store.data.get(EMAIL), SECRET);
  assertNoLeak(out);
  assertNoLeak(err);
});

test("CLI set: email берётся из запроса, если его нет в окружении", async () => {
  const store = fakeStore();
  const { deps, out, err } = cliDeps({ store, email: null });
  assert.equal(await runCli(["set"], deps), 0);
  assert.equal(store.data.get(EMAIL), SECRET);
  assertNoLeak(out);
  assertNoLeak(err);
});

test("CLI set: хранилища нет — код 1, пароль не записан и не выведен", async () => {
  const { deps, out, err } = cliDeps({ store: null });
  assert.equal(await runCli(["set"], deps), 1);
  assertNoLeak(out);
  assertNoLeak(err);
});

test("CLI set: ошибка хранилища с секретом в тексте не попадает в вывод", async () => {
  const store = {
    getPassword: () => null,
    setPassword: () => {
      throw new Error(`failed for ${EMAIL} with ${SECRET}`);
    },
    deletePassword: () => false,
  };
  const { deps, out, err } = cliDeps({ store });
  assert.equal(await runCli(["set"], deps), 1);
  assertNoLeak(out);
  assertNoLeak(err);
});

test("CLI set: пустой пароль отклоняется", async () => {
  const store = fakeStore();
  const { deps } = cliDeps({ store, readSecret: async () => "" });
  assert.equal(await runCli(["set"], deps), 1);
  assert.equal(store.data.size, 0);
});

test("CLI clear: удаляет запись; повторный вызов — не ошибка", async () => {
  const store = fakeStore({ [EMAIL]: SECRET });
  const { deps, out, err } = cliDeps({ store });
  assert.equal(await runCli(["clear"], deps), 0);
  assert.equal(store.data.size, 0);
  assert.equal(await runCli(["clear"], deps), 0);
  assertNoLeak(out);
  assertNoLeak(err);
});

test("CLI: неизвестная или пустая подкоманда — код 2 и подсказка", async () => {
  for (const argv of [[], ["bogus"]]) {
    const { deps, out, err } = cliDeps();
    assert.equal(await runCli(argv, deps), 2);
    assert.ok(err.length + out.length > 0);
  }
});

// --- HSE_DISABLE_KEYCHAIN ------------------------------------------------------------------------

test("loadKeyStore: HSE_DISABLE_KEYCHAIN=true — null, пакет даже не загружается", async () => {
  for (const value of ["true", " TRUE "]) {
    let imported = false;
    const store = await loadKeyStore(
      async () => {
        imported = true;
        return { Entry: class {} };
      },
      "linux",
      { HSE_DISABLE_KEYCHAIN: value }
    );
    assert.equal(store, null);
    assert.equal(imported, false);
  }
});

test("loadKeyStore: другое значение HSE_DISABLE_KEYCHAIN не отключает хранилище", async () => {
  class FakeEntry {
    getPassword() {
      return null;
    }
    setPassword() {}
    deleteCredential() {
      return false;
    }
  }
  const store = await loadKeyStore(async () => ({ Entry: FakeEntry }), "win32", {
    HSE_DISABLE_KEYCHAIN: "false",
  });
  assert.ok(store);
});

// --- снимок окружения до применения .env ---------------------------------------------------------

test("captureCredentialInputs: пароль из .env — источник dotenv, а не env", () => {
  const dir = tmpDir();
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `HSE_EMAIL=${EMAIL}\nHSE_PASSWORD=${SECRET}\n`);
  const env = {};
  const inputs = captureCredentialInputs(file, env);
  // .env по-прежнему применяется к окружению (как раньше), но снимок «до» его не содержит.
  assert.equal(env.HSE_PASSWORD, SECRET);
  assert.equal(inputs.envAtStart.HSE_PASSWORD, undefined);
  const r = lookupPassword({
    env: inputs.envAtStart,
    dotenv: inputs.dotenv,
    account: EMAIL,
    store: null,
  });
  assert.deepEqual(r, { password: SECRET, source: "dotenv" });
});

test("captureCredentialInputs: пароль из окружения процесса — источник env и приоритет над .env", () => {
  const dir = tmpDir();
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `HSE_PASSWORD=from-dotenv\n`);
  const env = { HSE_PASSWORD: SECRET };
  const inputs = captureCredentialInputs(file, env);
  assert.equal(env.HSE_PASSWORD, SECRET);
  const r = lookupPassword({
    env: inputs.envAtStart,
    dotenv: inputs.dotenv,
    account: EMAIL,
    store: null,
  });
  assert.deepEqual(r, { password: SECRET, source: "env" });
});

test("captureCredentialInputs: нет .env — пустой набор, без ошибки", () => {
  const inputs = captureCredentialInputs(path.join(tmpDir(), "missing"), {});
  assert.deepEqual(inputs.dotenv, {});
});

// --- права на каталог и учётная запись Windows ---------------------------------------------------

test("windowsAccount: DOMAIN\\USER, без домена — USER, без пользователя — null", () => {
  assert.equal(windowsAccount({ USERDOMAIN: "PC", USERNAME: "student" }), "PC\\student");
  assert.equal(windowsAccount({ USERNAME: "student" }), "student");
  assert.equal(windowsAccount({ USERDOMAIN: "PC" }), null);
  assert.equal(windowsAccount({}), null);
});

test("restrictDir: на POSIX режим 0o700", (t) => {
  if (isWin) return t.skip("режимы POSIX на Windows не применяются");
  const dir = path.join(tmpDir(), "storage");
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  restrictDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("restrictDir: на Windows новые файлы наследуют единственную запись владельца, доступ сохраняется", (t) => {
  if (!isWin) return t.skip("проверка icacls только для Windows");
  // Права родителя задаём сами: storage наследует запись владельца и чтение для группы «Пользователи»
  // (SID S-1-5-32-545). Иначе результат зависит от временного каталога: на раннерах GitHub у новой
  // папки явные записи SYSTEM и Administrators, а /inheritance:r снимает только унаследованные.
  const parent = tmpDir();
  execFileSync(
    "icacls",
    [
      parent,
      "/inheritance:r",
      "/grant:r",
      `${windowsAccount()}:(OI)(CI)(F)`,
      "*S-1-5-32-545:(OI)(CI)(RX)",
    ],
    { stdio: "ignore" }
  );
  const dir = path.join(parent, "storage");
  fs.mkdirSync(dir);
  restrictDir(dir);
  const file = path.join(dir, "new");
  fs.writeFileSync(file, "x");
  const acl = execFileSync("icacls", [file], { encoding: "latin1" });
  const dirAcl = [parent, dir]
    .map((d) => execFileSync("icacls", [d], { encoding: "latin1" }))
    .join("");
  assert.equal(
    (acl.match(/:\(/g) ?? []).length,
    1,
    `ожидалась одна запись доступа (учётная запись ${windowsAccount()}):\n${acl}\nкаталог:\n${dirAcl}`
  );
  fs.writeFileSync(file, "y");
  assert.equal(fs.readFileSync(file, "utf8"), "y");
  fs.rmSync(dir, { recursive: true });
});

test("restrictDir: не бросает на отсутствующем каталоге", () => {
  assert.doesNotThrow(() => restrictDir(path.join(tmpDir(), "missing")));
});

// --- чтение строк в CLI --------------------------------------------------------------------------

test("createLineReader: читает строки из канала, пустую строку и конец без перевода строки", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createLineReader(input, output);
  input.write("first\n\nlast");
  input.end();
  assert.equal(await reader.readLine("a: "), "first");
  assert.equal(await reader.readLine("b: "), "");
  assert.equal(await reader.readLine("c: "), "last");
  // EOF: дальше пусто, а не зависание.
  assert.equal(await reader.readLine("d: "), "");
  reader.close();
  assert.match(output.read()?.toString() ?? "", /a: /);
});

test("createLineReader: строки, пришедшие одним куском, не теряются между вызовами", async () => {
  const input = new PassThrough();
  const reader = createLineReader(input, new PassThrough());
  input.write("one\ntwo\n");
  assert.equal(await reader.readLine(""), "one");
  assert.equal(await reader.readLine(""), "two");
  reader.close();
});

test("createLineReader: строка, пришедшая позже запроса, возвращается как есть", async () => {
  const input = new PassThrough();
  const reader = createLineReader(input, new PassThrough());
  const pending = reader.readLine("");
  setTimeout(() => input.write("late\n"), 20);
  assert.equal(await pending, "late");
  reader.close();
});

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (mode) => void input.rawModes.push(mode);
  return input;
}

test("createStdinIo: на терминале общий читатель не создаётся, пароль читается посимвольно", async () => {
  const input = fakeTty();
  const output = new PassThrough();
  const io = createStdinIo(input, output);
  assert.equal(input.listenerCount("data"), 0);
  const pending = io.readSecret("Пароль: ");
  // Только наш обработчик посимвольного ввода: постоянного readline на потоке нет.
  assert.equal(input.listenerCount("data"), 1);
  input.write(`${SECRET}\r`);
  assert.equal(await pending, SECRET);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
  assert.ok(!(output.read()?.toString() ?? "").includes(SECRET));
});

test("createStdinIo: на терминале строка читается отдельным читателем и он закрывается", async () => {
  const input = fakeTty();
  const io = createStdinIo(input, new PassThrough());
  const pending = io.readLine("Email: ");
  setTimeout(() => input.write("someone\n"), 10);
  assert.equal(await pending, "someone");
  assert.equal(input.listenerCount("data"), 0);
});

test("createStdinIo: не терминал — общий читатель создаётся лениво и один на процесс", async () => {
  const input = new PassThrough();
  const io = createStdinIo(input, new PassThrough());
  assert.equal(input.listenerCount("data"), 0);
  input.write("a@x\nsecret-line\n");
  assert.equal(await io.readLine(""), "a@x");
  assert.equal(await io.readSecret(""), "secret-line");
});

test("readSecretFrom: не терминал — предупреждение без значений и строка из потока", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createLineReader(input, output);
  input.write(`${SECRET}\n`);
  const value = await readSecretFrom(input, output, reader, "Пароль: ");
  assert.equal(value, SECRET);
  const printed = output.read()?.toString() ?? "";
  assert.match(printed, /видно|отображ/i);
  assert.ok(!printed.includes(SECRET));
  reader.close();
});
