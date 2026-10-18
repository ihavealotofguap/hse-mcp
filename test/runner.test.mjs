import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Ключ и журнал — во временном каталоге; задаётся до импорта модулей.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-runner-"));
process.env.HSE_WRITES_DIR = dir;

const { defineWrite, classifyError } = await import(new URL("../dist/services/writes/runner.js", import.meta.url).href);
const { defineResource } = await import(new URL("../dist/resource.js", import.meta.url).href);
const { loadOrCreateKey, signPreview } = await import(new URL("../dist/services/writes/token.js", import.meta.url).href);

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const readJournal = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
};
const tokenIdOf = (token) => token.split(".")[1].slice(0, 12);
const byToken = (token) => readJournal().filter((e) => e.tokenId === tokenIdOf(token));

// Ресурс-шпион для invalidates: кэшируется, сброс виден по числу загрузок.
let spyLoads = 0;
const spyRead = defineResource({
  name: "t.read",
  ttl: 60_000,
  key: () => "k",
  load: async () => {
    spyLoads++;
    return { v: spyLoads };
  },
});

const TARGET_SECRET = "course-777/assign-SECRETTARGET";

// Счётчик одновременных execute по всем фейковым адаптерам.
let active = 0;
let maxActive = 0;

/** Фейковый адаптер в памяти: «система» — Map id → значение; поведение настраивается через `behavior`. */
function makeFake(op) {
  const system = new Map();
  const calls = { observe: 0, execute: 0, verifyOnly: 0 };
  const behavior = {
    throwBefore: false,
    throwAfter: false,
    workMs: 0,
    beforeCommit: null,
    afterCommit: null,
    pageCommit: null,
    swallowCommit: false,
    result: null,
    verifyOutcome: "confirmed",
  };
  const adapter = {
    op,
    invalidates: ["t.read"],
    targetOf: (a) => `${TARGET_SECRET}-${a.id}`,
    async observe(a) {
      calls.observe++;
      return { current: system.get(a.id) ?? "" };
    },
    describe: (a, o) => ({ preview: { from: o.current, to: a.value }, warnings: [] }),
    payloadOf: (a, o) => ({ mode: a.mode ?? "draft", files: [{ name: "answer", sha256: sha(a.value) }], state: o.current }),
    async execute(a, _o, ctx) {
      calls.execute++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        // Как настоящий адаптер (withPage): до любого действия есть асинхронный шаг.
        await sleep(0);
        if (behavior.throwBefore) throw new Error("сбой до точки невозврата");
        behavior.beforeCommit?.();
        const pageCtx = { signal: ctx.signal, commit: behavior.pageCommit ?? (() => {}) };
        try {
          await ctx.commitPoint(pageCtx);
        } catch (err) {
          if (!behavior.swallowCommit) throw err;
        }
        behavior.afterCommit?.();
        if (behavior.workMs) await sleep(behavior.workMs);
        if (behavior.throwAfter) throw new Error("net::ERR_CONNECTION_RESET");
        system.set(a.id, a.value);
        return behavior.result ?? { stage: "verified", outcome: "confirmed", evidence: { matched: true }, warnings: [] };
      } finally {
        active--;
      }
    },
    async verifyOnly(a) {
      calls.verifyOnly++;
      return { outcome: behavior.verifyOutcome, evidence: { matched: system.get(a.id) === a.value }, warnings: [] };
    },
  };
  return { adapter, system, calls, behavior, write: defineWrite(adapter) };
}

const fakeA = makeFake("test_write_a");
const fakeB = makeFake("test_write_b");

test("a. сухой прогон: токен, без execute, журнал пуст; confirm без токена и с чужим токеном — отказ до execute", async () => {
  const args = { id: "a1", value: "ответ-1" };
  const dry = await fakeA.write(args);
  assert.equal(dry.stage, "preview");
  assert.match(dry.previewToken, /^\d+\.[0-9a-f]{64}$/);
  assert.equal(dry.priorUnknown, false);
  assert.deepEqual(dry.preview, { from: "", to: "ответ-1" });
  const ttl = Date.parse(dry.expiresAt) - Number(dry.previewToken.split(".")[0]) * 1000;
  assert.equal(ttl, 15 * 60_000);
  assert.equal(fakeA.calls.execute, 0);
  assert.deepEqual(readJournal(), []);

  // confirm: false — тоже сухой прогон
  assert.equal((await fakeA.write({ ...args, confirm: false })).stage, "preview");

  const observeBefore = fakeA.calls.observe;
  await assert.rejects(
    fakeA.write({ ...args, confirm: true }),
    /^Error: confirm требует previewToken: сначала выполните сухой прогон; ничего не отправлено$/
  );
  assert.equal(fakeA.calls.observe, observeBefore);
  assert.equal(fakeA.calls.execute, 0);

  // изменены данные операции
  await assert.rejects(fakeA.write({ ...args, value: "другой ответ", confirm: true, previewToken: dry.previewToken }), /ничего не отправлено/);
  // другая цель
  await assert.rejects(fakeA.write({ ...args, id: "a2", confirm: true, previewToken: dry.previewToken }), /ничего не отправлено/);
  // другой режим
  await assert.rejects(fakeA.write({ ...args, mode: "submit", confirm: true, previewToken: dry.previewToken }), /ничего не отправлено/);
  // другая операция с теми же данными
  await assert.rejects(fakeB.write({ ...args, confirm: true, previewToken: dry.previewToken }), /ничего не отправлено/);
  // повреждённый токен
  await assert.rejects(fakeA.write({ ...args, confirm: true, previewToken: "abc" }), /ничего не отправлено/);
  // состояние цели изменилось после сухого прогона
  fakeA.system.set("a1", "чужая правка");
  await assert.rejects(fakeA.write({ ...args, confirm: true, previewToken: dry.previewToken }), /ничего не отправлено/);
  fakeA.system.delete("a1");

  assert.equal(fakeA.calls.execute, 0);
  assert.equal(fakeB.calls.execute, 0);
  assert.deepEqual(readJournal(), []);
});

test("b. счастливый путь: confirmed, sent; журнал sending → verified/confirmed; t.read сброшен", async () => {
  await spyRead(undefined);
  await spyRead(undefined);
  const loadsBefore = spyLoads;

  const args = { id: "b1", value: "ответ-b" };
  const dry = await fakeA.write(args);
  const res = await fakeA.write({ ...args, confirm: true, previewToken: dry.previewToken });
  assert.equal(res.outcome, "confirmed");
  assert.equal(res.stage, "verified");
  assert.equal(res.sent, true);
  assert.deepEqual(res.evidence, { matched: true });
  assert.equal(fakeA.calls.execute, 1);
  assert.equal(fakeA.system.get("b1"), "ответ-b");

  const entries = byToken(dry.previewToken);
  assert.deepEqual(entries.map((e) => [e.stage, e.outcome]), [["sending", undefined], ["verified", "confirmed"]]);
  assert.equal(entries[1].op, "test_write_a");
  assert.equal(typeof entries[1].durationMs, "number");
  assert.match(entries[1].targetId, /^[0-9a-f]{12}$/);

  await spyRead(undefined);
  assert.equal(spyLoads, loadsBefore + 1);

  globalThis.__tokenB = dry.previewToken;
});

test("c. тот же токен ещё раз — ответ из журнала, execute и observe не вызываются; чужая операция — отказ", async () => {
  const args = { id: "b1", value: "ответ-b" };
  const observeBefore = fakeA.calls.observe;
  const res = await fakeA.write({ ...args, confirm: true, previewToken: globalThis.__tokenB });
  assert.equal(res.outcome, "confirmed");
  assert.equal(res.sent, true);
  assert.deepEqual(res.evidence, { fromJournal: true });
  assert.equal(fakeA.calls.execute, 1);
  assert.equal(fakeA.calls.observe, observeBefore);
  assert.equal(fakeA.calls.verifyOnly, 0);

  // использованный токен на другой операции: не повтор и не запись
  await assert.rejects(fakeB.write({ ...args, confirm: true, previewToken: globalThis.__tokenB }), /ничего не отправлено/);
  // и на другой цели той же операции
  await assert.rejects(fakeA.write({ ...args, id: "b2", confirm: true, previewToken: globalThis.__tokenB }), /ничего не отправлено/);
  assert.equal(fakeB.calls.execute, 0);
  assert.equal(fakeA.calls.execute, 1);
});

test("d. execute бросает после commitPoint → unknown без исключения; повтор того же токена только читает", async () => {
  const fake = makeFake("test_write_d");
  fake.behavior.throwAfter = true;
  fake.behavior.verifyOutcome = "unknown";
  await spyRead(undefined);
  const loadsBefore = spyLoads;

  const args = { id: "d1", value: "ответ-d" };
  const dry = await fake.write(args);
  const res = await fake.write({ ...args, confirm: true, previewToken: dry.previewToken });
  assert.equal(res.outcome, "unknown");
  assert.equal(res.stage, "sent");
  assert.equal(res.sent, true);
  assert.ok(res.warnings.some((w) => /повторять отправку без проверки запрещено/i.test(w)));
  assert.ok(!JSON.stringify(res).includes("ERR_CONNECTION_RESET"), "текст ошибки в ответ не попадает");
  assert.equal(fake.calls.execute, 1);

  let entries = byToken(dry.previewToken);
  assert.deepEqual(entries.map((e) => e.stage), ["sending", "sent"]);
  assert.equal(entries[1].outcome, "unknown");
  assert.equal(entries[1].errorClass, "network");

  // invalidates срабатывает и при сбое после точки невозврата
  await spyRead(undefined);
  assert.equal(spyLoads, loadsBefore + 1);

  const again = await fake.write({ ...args, confirm: true, previewToken: dry.previewToken });
  assert.equal(fake.calls.verifyOnly, 1);
  assert.equal(fake.calls.execute, 1);
  assert.equal(again.outcome, "unknown");
  assert.equal(again.sent, true);
  entries = byToken(dry.previewToken);
  assert.deepEqual([entries.at(-1).stage, entries.at(-1).outcome], ["verified", "unknown"]);

  globalThis.__fakeD = fake;
  globalThis.__tokenD = dry.previewToken;
});

test("e. execute бросает до commitPoint → исключение, журнал без новых записей", async () => {
  const fake = makeFake("test_write_e");
  fake.behavior.throwBefore = true;
  const args = { id: "e1", value: "ответ-e" };
  const dry = await fake.write(args);
  const before = readJournal().length;
  await assert.rejects(fake.write({ ...args, confirm: true, previewToken: dry.previewToken }), /сбой до точки невозврата; ничего не отправлено/);
  assert.equal(fake.calls.execute, 1);
  assert.equal(readJournal().length, before);
  assert.equal(fake.system.has("e1"), false);
});

test("f. отмена до commitPoint → отказ без журнала; отмена после → ответ приходит, исход в журнале", async () => {
  const fake = makeFake("test_write_f");
  const args = { id: "f1", value: "ответ-f" };

  const ctrl1 = new AbortController();
  fake.behavior.beforeCommit = () => ctrl1.abort();
  const dry1 = await fake.write(args);
  const before = readJournal().length;
  await assert.rejects(fake.write({ ...args, confirm: true, previewToken: dry1.previewToken }, ctrl1.signal), /ничего не отправлено/);
  await sleep(50);
  assert.equal(readJournal().length, before);
  assert.equal(fake.system.has("f1"), false);

  const ctrl2 = new AbortController();
  fake.behavior.beforeCommit = null;
  fake.behavior.afterCommit = () => ctrl2.abort();
  fake.behavior.workMs = 200;
  const dry2 = await fake.write(args);
  const started = Date.now();
  const res = await fake.write({ ...args, confirm: true, previewToken: dry2.previewToken }, ctrl2.signal);
  assert.ok(Date.now() - started >= 190);
  assert.equal(res.outcome, "confirmed");
  assert.equal(res.sent, true);
  assert.equal(fake.system.get("f1"), "ответ-f");
  const entries = byToken(dry2.previewToken);
  assert.deepEqual(entries.map((e) => [e.stage, e.outcome]), [["sending", undefined], ["verified", "confirmed"]]);
});

test("g. два параллельных confirm с одним токеном → execute один раз", async () => {
  const fake = makeFake("test_write_g");
  fake.behavior.workMs = 50;
  const args = { id: "g1", value: "ответ-g" };
  const dry = await fake.write(args);
  const [r1, r2] = await Promise.all([
    fake.write({ ...args, confirm: true, previewToken: dry.previewToken }),
    fake.write({ ...args, confirm: true, previewToken: dry.previewToken }),
  ]);
  assert.equal(fake.calls.execute, 1);
  assert.equal(r1.outcome, "confirmed");
  assert.equal(r2.outcome, "confirmed");
  assert.deepEqual(r2.evidence, { fromJournal: true });
  assert.equal(byToken(dry.previewToken).filter((e) => e.stage === "sending").length, 1);
});

test("одновременно в процессе выполняется не более одной записи", async () => {
  const f1 = makeFake("test_write_q1");
  const f2 = makeFake("test_write_q2");
  f1.behavior.workMs = 60;
  f2.behavior.workMs = 60;
  const a1 = { id: "q1", value: "x" };
  const a2 = { id: "q2", value: "y" };
  const [d1, d2] = await Promise.all([f1.write(a1), f2.write(a2)]);
  maxActive = 0;
  const [r1, r2] = await Promise.all([
    f1.write({ ...a1, confirm: true, previewToken: d1.previewToken }),
    f2.write({ ...a2, confirm: true, previewToken: d2.previewToken }),
  ]);
  assert.equal(r1.outcome, "confirmed");
  assert.equal(r2.outcome, "confirmed");
  assert.equal(maxActive, 1);
});

test("h. после неизвестного исхода: priorUnknown, запись без acknowledgeUnknown — отказ, с ним — проходит", async () => {
  const fake = globalThis.__fakeD;
  fake.behavior.throwAfter = false;
  const args = { id: "d1", value: "ответ-d" };
  // Токен детерминирован по секунде выпуска и payload: в ту же секунду вышел бы токен из (d).
  await sleep(1005 - (Date.now() % 1000));
  const dry = await fake.write(args);
  assert.notEqual(dry.previewToken, globalThis.__tokenD);
  assert.equal(dry.priorUnknown, true);
  assert.ok(dry.warnings.some((w) => /acknowledgeUnknown/.test(w)));

  await assert.rejects(fake.write({ ...args, confirm: true, previewToken: dry.previewToken }), /acknowledgeUnknown: true.*ничего не отправлено/);
  assert.equal(fake.calls.execute, 1);

  const res = await fake.write({ ...args, confirm: true, previewToken: dry.previewToken, acknowledgeUnknown: true });
  assert.equal(res.outcome, "confirmed");
  assert.equal(fake.calls.execute, 2);
});

test("i. просроченный токен → отказ «просрочен» до execute", async () => {
  const fake = makeFake("test_write_i");
  const args = { id: "i1", value: "ответ-i" };
  const key = await loadOrCreateKey(dir);
  const payload = {
    op: "test_write_i",
    target: fake.adapter.targetOf(args),
    mode: "draft",
    files: [{ name: "answer", sha256: sha(args.value) }],
    state: "",
  };
  const old = signPreview(key, payload, new Date(Date.now() - 16 * 60_000));
  await assert.rejects(fake.write({ ...args, confirm: true, previewToken: old }), /просрочен.*ничего не отправлено/);
  assert.equal(fake.calls.execute, 0);
  // тот же payload со свежим временем проходит — значит, причина именно в сроке
  const fresh = signPreview(key, payload);
  assert.equal((await fake.write({ ...args, confirm: true, previewToken: fresh })).outcome, "confirmed");
});

test("стадия и исход из ExecuteResult передаются как есть; unknown от адаптера несёт запрет повтора", async () => {
  const fake = makeFake("test_write_m");
  fake.behavior.result = { stage: "draft-saved", outcome: "rejected", evidence: { draft: true }, warnings: ["w1"] };
  const a1 = { id: "m1", value: "x" };
  const d1 = await fake.write(a1);
  const r1 = await fake.write({ ...a1, confirm: true, previewToken: d1.previewToken });
  assert.equal(r1.stage, "draft-saved");
  assert.equal(r1.outcome, "rejected");
  assert.equal(r1.sent, true);
  assert.deepEqual(r1.evidence, { draft: true });
  assert.deepEqual(r1.warnings, ["w1"]);
  assert.deepEqual(byToken(d1.previewToken).map((e) => [e.stage, e.outcome]), [["sending", undefined], ["verified", "rejected"]]);
  // повтор отклонённого из журнала: sent: false
  const r1again = await fake.write({ ...a1, confirm: true, previewToken: d1.previewToken });
  assert.equal(r1again.outcome, "rejected");
  assert.equal(r1again.sent, false);
  assert.deepEqual(r1again.evidence, { fromJournal: true });

  fake.behavior.result = { stage: "draft-saved", outcome: "unknown", evidence: {}, warnings: [] };
  const a2 = { id: "m2", value: "y" };
  const d2 = await fake.write(a2);
  const r2 = await fake.write({ ...a2, confirm: true, previewToken: d2.previewToken });
  assert.equal(r2.stage, "draft-saved");
  assert.equal(r2.outcome, "unknown");
  assert.ok(r2.warnings.some((w) => /повторять отправку без проверки запрещено/i.test(w)));
  assert.deepEqual(byToken(d2.previewToken).at(-1).outcome, "unknown");
});

test("адаптер проглотил отказ точки невозврата → unknown, а не confirmed", async () => {
  const fake = makeFake("test_write_s");
  fake.behavior.pageCommit = () => {
    throw new Error("страница уже закрыта");
  };
  fake.behavior.swallowCommit = true;
  const args = { id: "s1", value: "x" };
  const dry = await fake.write(args);
  const res = await fake.write({ ...args, confirm: true, previewToken: dry.previewToken });
  assert.equal(res.outcome, "unknown");
  assert.equal(res.sent, true);
  assert.equal(byToken(dry.previewToken).at(-1).outcome, "unknown");
});

test("j. журнал: только разрешённые ключи, строки цели и данных в файле нет", async () => {
  const raw = fs.readFileSync(path.join(dir, "journal.json"), "utf8");
  const list = JSON.parse(raw);
  assert.ok(list.length > 0);
  const allowed = new Set(["at", "op", "tokenId", "targetId", "stage", "outcome", "durationMs", "errorClass"]);
  for (const e of list) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `лишний ключ ${k}`);
  assert.ok(!raw.includes("SECRETTARGET"));
  assert.ok(!raw.includes(TARGET_SECRET));
  assert.ok(!raw.includes("ответ-"));
  assert.ok(!raw.includes(globalThis.__tokenB));
});

test("classifyError", () => {
  const cases = [
    [new Error("writes.x не уложился в 45 с"), "timeout"],
    [new Error("lk.hse.ru/x не уложилась в 20 с после точки невозврата"), "timeout"],
    [new DOMException("This operation was aborted", "AbortError"), "timeout"],
    [Object.assign(new Error("Timeout 30000ms exceeded."), { name: "TimeoutError" }), "timeout"],
    [new Error("операция отменена"), "cancelled"],
    [new Error("net::ERR_CONNECTION_RESET at https://example.test"), "network"],
    [new Error("ERR_TIMED_OUT"), "network"],
    [new TypeError("fetch failed"), "network"],
    [new Error("HTTP 401"), "auth"],
    [new Error("требуется вход в систему"), "auth"],
    [new Error("что-то другое"), "other"],
    ["строка", "other"],
    [undefined, "other"],
  ];
  for (const [err, expected] of cases) assert.equal(classifyError(err), expected, String(err?.message ?? err));
});
