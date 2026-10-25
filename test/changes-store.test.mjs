import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const store = await import(new URL("../dist/services/changes/store.js", import.meta.url).href);
const { getChanges, resetChanges } = await import(
  new URL("../dist/services/changes/client.js", import.meta.url).href
);
const {
  emptyState,
  loadState,
  saveState,
  pruneJournal,
  pruneGradeBaselines,
  JOURNAL_MAX_EVENTS,
  JOURNAL_MAX_AGE_MS,
} = store;

const base = fs.mkdtempSync(path.join(os.tmpdir(), "hse-mcp-changes-"));
let counter = 0;
const tmpDir = () => fs.mkdtempSync(path.join(base, `case${counter++}-`));
const stateFile = (dir) => path.join(dir, "state.json");
const readState = (dir) => JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = new Date("2026-10-25T09:00:00.000Z");

const ev = (seq, scope, at) => ({
  seq,
  at: at.toISOString(),
  scope,
  source: "src",
  type: "added",
  id: String(seq),
  kind: "k",
  title: `t${seq}`,
});

test("константы журнала: 30 дней и 500 событий", () => {
  assert.equal(JOURNAL_MAX_AGE_MS, 30 * DAY);
  assert.equal(JOURNAL_MAX_EVENTS, 500);
});

test("pruneJournal: старше 30 дней уходит, только если подтверждено всеми курсорами", () => {
  const old = new Date(NOW.getTime() - 31 * DAY);
  const recent = new Date(NOW.getTime() - 29 * DAY);
  const s = emptyState();
  s.journal = [
    ev(1, "deadlines", old),
    ev(2, "inbox", old),
    ev(3, "deadlines", old),
    ev(4, "deadlines", recent),
  ];
  // inbox подтверждён до 2, deadlines — до 4: min(seen) = 2.
  s.seen = { deadlines: 4, inbox: 2 };
  pruneJournal(s, NOW);
  assert.deepEqual(
    s.journal.map((e) => e.seq),
    [3, 4]
  );
  assert.deepEqual(s.lost, {});
});

test("pruneJournal: событие области без курсора по возрасту не срезается", () => {
  const old = new Date(NOW.getTime() - 60 * DAY);
  const s = emptyState();
  s.journal = [ev(1, "claims", old), ev(2, "deadlines", old)];
  s.seen = { deadlines: 5 };
  pruneJournal(s, NOW);
  assert.deepEqual(
    s.journal.map((e) => e.seq),
    [1]
  );
});

test("pruneJournal: потолок 500 срезает старейшие, невыданные считаются в lost", () => {
  const s = emptyState();
  const at = new Date(NOW.getTime() - DAY);
  s.journal = Array.from({ length: JOURNAL_MAX_EVENTS + 5 }, (_, i) =>
    ev(i + 1, i % 2 === 0 ? "deadlines" : "inbox", at)
  );
  // Подтверждено deadlines до 3: срезаемые 1 и 3 не потеряны, 2, 4, 5 — потеряны.
  s.seen = { deadlines: 3, inbox: 0 };
  pruneJournal(s, NOW);
  assert.equal(s.journal.length, JOURNAL_MAX_EVENTS);
  assert.equal(s.journal[0].seq, 6);
  assert.deepEqual(s.lost, { inbox: 2, deadlines: 1 });
});

test("pruneGradeBaselines: базы оценок старше 90 дней удаляются, остальные — нет", () => {
  const s = emptyState();
  const old = new Date(NOW.getTime() - 91 * DAY).toISOString();
  s.baselines = {
    "lms_grades:1": { takenAt: old, facts: {} },
    "lms_grades:2": { takenAt: NOW.toISOString(), facts: {} },
    lms_calendar: { takenAt: old, facts: {} },
  };
  pruneGradeBaselines(s, NOW);
  assert.deepEqual(Object.keys(s.baselines).sort(), ["lms_calendar", "lms_grades:2"]);
});

test("loadState/saveState: нет файла, запись, чтение, отказ при чужом rev", async () => {
  const dir = tmpDir();
  assert.equal((await loadState(dir)).kind, "missing");
  const s = emptyState();
  s.rev = 1;
  assert.deepEqual(await saveState(dir, s, null), { ok: true });
  const loaded = await loadState(dir);
  assert.equal(loaded.kind, "ok");
  assert.deepEqual(loaded.state, s);
  // На диске rev 1, а вызывающий читал 0 — запись отклоняется.
  const res = await saveState(dir, { ...s, rev: 2 }, 0);
  assert.equal(res.ok, false);
  assert.match(res.error, /rev не совпал/);
  assert.equal(readState(dir).rev, 1);
});

test("loadState: повреждённый файл — в карантин; более новая версия — не трогается", async () => {
  const dir = tmpDir();
  fs.writeFileSync(stateFile(dir), "{ не json");
  const corrupt = await loadState(dir);
  assert.equal(corrupt.kind, "corrupt");
  assert.ok(!fs.existsSync(stateFile(dir)));
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("state.json.corrupt-")).length, 1);

  const newer = JSON.stringify({ version: 999 });
  fs.writeFileSync(stateFile(dir), newer);
  const res = await loadState(dir);
  assert.equal(res.kind, "newer");
  assert.equal(fs.readFileSync(stateFile(dir), "utf8"), newer);
});

// --- Курсор и журнал через getChanges с внедрённым источником ---

const fact = (id, over = {}) => ({
  id,
  scope: "deadlines",
  kind: "assignment",
  title: `Задание ${id}`,
  attrs: { name: `Задание ${id}` },
  ...over,
});

/** Источник области deadlines, чей ответ задаёт тест. */
function fakeSource() {
  const box = { facts: [], fail: null };
  return {
    box,
    extractor: {
      source: "lms_calendar",
      scope: "deadlines",
      flags: {},
      run: async () => {
        if (box.fail) throw new Error(box.fail);
        return { facts: box.facts };
      },
    },
  };
}

function harness() {
  const dir = tmpDir();
  const src = fakeSource();
  let clock = NOW.getTime();
  const call = (opts = {}) =>
    getChanges(opts, {
      dir,
      now: () => new Date(clock),
      single: [src.extractor],
      sourceTimeoutMs: 5_000,
    });
  const tick = (ms = 60_000) => {
    clock += ms;
  };
  return { dir, box: src.box, call, tick };
}

test("первый вызов — база без событий; следующий выдаёт события", async () => {
  const h = harness();
  h.box.facts = [fact("1")];
  const first = await h.call();
  assert.equal(first.persisted, true);
  assert.deepEqual(first.changes, []);
  assert.equal(first.ackSeq, null);
  assert.equal(first.scopes.deadlines.status, "baseline");
  assert.equal(first.sources.lms_calendar.status, "ok");

  h.tick();
  h.box.facts = [fact("1"), fact("2")];
  const second = await h.call();
  assert.equal(second.scopes.deadlines.status, "ok");
  assert.deepEqual(
    second.changes.map((c) => [c.seq, c.type, c.title]),
    [[1, "added", "Задание 2"]]
  );
  assert.equal(second.ackSeq, 1);
  assert.equal(second.omitted, 0);
  assert.deepEqual(second.gap, { lostEvents: 0 });
});

test("курсор двигает только ack: без него события повторяются", async () => {
  const h = harness();
  await h.call();
  h.tick();
  h.box.facts = [fact("a")];
  const r1 = await h.call();
  assert.equal(r1.changes.length, 1);

  // Ответ «не дошёл» — повтор без ack: событие на месте, новых нет.
  h.tick();
  const r2 = await h.call();
  assert.deepEqual(
    r2.changes.map((c) => c.seq),
    [r1.ackSeq]
  );
  assert.equal(r2.ackSeq, r1.ackSeq);

  // Новое событие и ack прошлого ответа: прежнее подтверждено, новое выдано.
  h.tick();
  h.box.facts = [fact("a"), fact("b")];
  const r3 = await h.call({ ack: r2.ackSeq });
  assert.deepEqual(
    r3.changes.map((c) => c.title),
    ["Задание b"]
  );
  // Событие, выданное этим же ответом, курсор не сдвинуло.
  h.tick();
  const r4 = await h.call();
  assert.deepEqual(
    r4.changes.map((c) => c.seq),
    [r3.ackSeq]
  );
  h.tick();
  const r5 = await h.call({ ack: r4.ackSeq });
  assert.deepEqual(r5.changes, []);
  assert.equal(r5.ackSeq, null);
});

test("ack больше выданного или неизвестный — игнорируется с предупреждением", async () => {
  const h = harness();
  await h.call();
  h.tick();
  h.box.facts = [fact("a")];
  const r1 = await h.call();
  h.tick();
  const tooBig = await h.call({ ack: 99 });
  assert.equal(tooBig.changes.length, 1);
  assert.ok(tooBig.warnings.some((w) => /ack 99 больше любого выданного seq/.test(w)));
  // seq 0 не был ackSeq ни одного ответа.
  const unknown = await h.call({ ack: 0 });
  assert.equal(unknown.changes.length, 1);
  assert.ok(unknown.warnings.some((w) => /не совпадает ни с одним/.test(w)));
  assert.equal(r1.ackSeq, 1);
});

test("отказ источника — статус error, база и курсор не тронуты", async () => {
  const h = harness();
  h.box.facts = [fact("1")];
  await h.call();
  const before = readState(h.dir).baselines;
  h.tick();
  h.box.fail = "сеть упала";
  const res = await h.call();
  assert.equal(res.sources.lms_calendar.status, "error");
  assert.equal(res.sources.lms_calendar.error, "сеть упала");
  assert.equal(res.scopes.deadlines.status, "error");
  assert.deepEqual(res.changes, []);
  assert.deepEqual(readState(h.dir).baselines, before);
  // Источник вернулся с теми же фактами — ложных событий нет.
  h.tick();
  h.box.fail = null;
  assert.deepEqual((await h.call()).changes, []);
});

test("журнал: больше 500 событий за раз — срез старейших и gap.lostEvents один раз", async () => {
  const h = harness();
  await h.call();
  h.tick();
  const n = JOURNAL_MAX_EVENTS + 10;
  h.box.facts = Array.from({ length: n }, (_, i) => fact(String(i).padStart(4, "0")));
  const res = await h.call();
  assert.deepEqual(res.gap, { lostEvents: 10 });
  // Потолок ответа — 200, остаток в omitted.
  assert.equal(res.changes.length, 200);
  assert.equal(res.omitted, JOURNAL_MAX_EVENTS - 200);
  assert.equal(res.changes[0].seq, 11);
  const state = readState(h.dir);
  assert.equal(state.journal.length, JOURNAL_MAX_EVENTS);
  assert.equal(state.nextSeq, n + 1);
  h.tick();
  const again = await h.call();
  assert.deepEqual(again.gap, { lostEvents: 0 });
});

test("журнал: подтверждённые события старше 30 дней уходят", async () => {
  const h = harness();
  await h.call();
  h.tick();
  h.box.facts = [fact("a")];
  const r1 = await h.call();
  h.tick(31 * DAY);
  await h.call({ ack: r1.ackSeq });
  assert.deepEqual(readState(h.dir).journal, []);
});

test("журнал: неподтверждённые события старше 30 дней не теряются", async () => {
  const h = harness();
  await h.call();
  h.tick();
  h.box.facts = [fact("a")];
  await h.call();
  h.tick(31 * DAY);
  const res = await h.call();
  assert.equal(res.changes.length, 1);
  assert.equal(readState(h.dir).journal.length, 1);
});

test("since: журнал за период, ackSeq = null, курсор не трогается", async () => {
  const h = harness();
  await h.call();
  h.tick();
  h.box.facts = [fact("a")];
  const r1 = await h.call();
  await h.call({ ack: r1.ackSeq });
  const res = await h.call({ since: "1d" });
  assert.equal(res.changes.length, 1);
  assert.equal(res.ackSeq, null);
  await assert.rejects(h.call({ since: "вчера" }), /Некорректное значение since/);
});

test("persisted: false — у ответа ackSeq и seq событий равны null, база на диске прежняя", async () => {
  const h = harness();
  await h.call();
  const before = fs.readFileSync(stateFile(h.dir), "utf8");
  // Временный файл записи занят каталогом — запись state.json не удаётся.
  const tmp = `${stateFile(h.dir)}.${process.pid}.tmp`;
  fs.mkdirSync(tmp);
  h.tick();
  h.box.facts = [fact("a"), fact("b")];
  const res = await h.call();
  assert.equal(res.persisted, false);
  assert.equal(res.ackSeq, null);
  assert.equal(res.changes.length, 2);
  for (const c of res.changes) assert.equal(c.seq, null);
  assert.ok(res.warnings.some((w) => /не удалось записать state\.json/.test(w)));
  assert.equal(fs.readFileSync(stateFile(h.dir), "utf8"), before);

  // Запись снова возможна — те же события выдаются с номерами.
  fs.rmdirSync(tmp);
  h.tick();
  const ok = await h.call();
  assert.equal(ok.persisted, true);
  assert.deepEqual(
    ok.changes.map((c) => c.seq),
    [1, 2]
  );
  assert.equal(ok.ackSeq, 2);
});

test("resetChanges: требует confirm, стирает область, nextSeq не сбрасывает", async () => {
  const h = harness();
  await h.call();
  h.tick();
  h.box.facts = [fact("a")];
  await h.call();
  await assert.rejects(resetChanges({}, { dir: h.dir }), /confirm: true/);
  const res = await resetChanges({ scope: "deadlines", confirm: true }, { dir: h.dir });
  assert.deepEqual(res.reset, ["deadlines"]);
  assert.equal(res.removedBaselines, 1);
  assert.equal(res.removedEvents, 1);
  const state = readState(h.dir);
  assert.equal(state.nextSeq, 2);
  assert.equal(state.seen.deadlines, 1);
  // После сброса — снова первый запуск: база без событий.
  h.tick();
  const after = await h.call();
  assert.equal(after.scopes.deadlines.status, "baseline");
  assert.deepEqual(after.changes, []);
});
