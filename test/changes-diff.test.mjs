import assert from "node:assert/strict";
import { test } from "node:test";

const { diffSource } = await import(
  new URL("../dist/services/changes/diff.js", import.meta.url).href
);

const T0 = new Date("2026-10-20T09:00:00.000Z");
const T1 = new Date("2026-10-25T09:00:00.000Z");

/** Факт календаря: ось — срок в UTC. */
const deadline = (id, due, over = {}) => ({
  id,
  scope: "deadlines",
  kind: "assignment",
  title: `Задание ${id}`,
  attrs: { due, name: `Задание ${id}` },
  at: due,
  ...over,
});

/** Занятие расписания: наивное МСК, ключ склейки — название|тип. */
const lesson = (start, name, over = {}) => ({
  id: `${start.slice(0, 10)}|${start.slice(11)}|${name}|Лекция`,
  scope: "schedule",
  kind: "lesson",
  title: name,
  attrs: { auditorium: "R205" },
  at: start,
  matchKey: `${name}|Лекция`,
  ...over,
});

const base = (facts, coverage, takenAt = T0) => {
  const out = diffSource({
    source: "lms_calendar",
    scope: "deadlines",
    baseline: null,
    facts,
    coverage,
    takenAt,
  });
  return out.baseline;
};

const run = (baseline, facts, extra = {}) =>
  diffSource({
    source: "lms_calendar",
    scope: "deadlines",
    baseline,
    facts,
    takenAt: T1,
    ...extra,
  });

const types = (events) => events.map((e) => `${e.type}:${e.id}`).sort();

test("первый запуск: база без событий, статус baseline", () => {
  const cov = { from: "2026-10-01T00:00Z", to: "2026-12-01T00:00Z" };
  const out = diffSource({
    source: "lms_calendar",
    scope: "deadlines",
    baseline: null,
    facts: [deadline("1", "2026-10-30T20:59Z")],
    coverage: cov,
    takenAt: T0,
  });
  assert.equal(out.status, "baseline");
  assert.deepEqual(out.events, []);
  assert.equal(out.baseline.takenAt, T0.toISOString());
  assert.deepEqual(out.baseline.coverage, cov);
  assert.deepEqual(Object.keys(out.baseline.facts), ["1"]);
});

test("added / changed / removed внутри общего покрытия", () => {
  const cov = { from: "2026-10-01T00:00Z", to: "2026-12-01T00:00Z" };
  const b = base([deadline("1", "2026-10-30T20:59Z"), deadline("2", "2026-11-05T20:59Z")], cov);
  const out = run(b, [deadline("1", "2026-10-31T20:59Z"), deadline("3", "2026-11-10T20:59Z")], {
    coverage: cov,
  });
  assert.equal(out.status, "ok");
  assert.deepEqual(types(out.events), ["added:3", "changed:1", "removed:2"]);
  const changed = out.events.find((e) => e.type === "changed");
  assert.deepEqual(changed.fields, [
    { field: "due", from: "2026-10-30T20:59Z", to: "2026-10-31T20:59Z" },
  ]);
  for (const e of out.events) {
    assert.equal(e.source, "lms_calendar");
    assert.equal(e.scope, "deadlines");
    assert.equal(e.seq, undefined);
  }
  // Удалённый не переносится, новый и изменённый — в базе.
  assert.deepEqual(Object.keys(out.baseline.facts).sort(), ["1", "3"]);
  assert.equal(out.baseline.facts["1"].attrs.due, "2026-10-31T20:59Z");
  assert.equal(out.baseline.takenAt, T1.toISOString());
});

test("changed: пустое, null и отсутствие ключа равны; пробелы не изменение", () => {
  const b = base([deadline("1", "2026-10-30T20:59Z", { attrs: { due: "x", note: "" } })]);
  const out = run(b, [deadline("1", "2026-10-30T20:59Z", { attrs: { due: " x ", note: null } })]);
  assert.deepEqual(out.events, []);
});

test("changed: добавленное и стёртое поле — from/to null", () => {
  const b = base([deadline("1", "2026-10-30T20:59Z", { attrs: { a: "1" } })]);
  const out = run(b, [deadline("1", "2026-10-30T20:59Z", { attrs: { b: "2" } })]);
  assert.deepEqual(out.events[0].fields, [
    { field: "a", from: "1", to: null },
    { field: "b", from: null, to: "2" },
  ]);
});

test("emitChanged: false — изменение полей не событие, но база обновляется", () => {
  const b = base([deadline("1", "2026-10-30T20:59Z")]);
  const out = run(b, [deadline("1", "2026-10-31T20:59Z")], { emitChanged: false });
  assert.deepEqual(out.events, []);
  assert.equal(out.baseline.facts["1"].attrs.due, "2026-10-31T20:59Z");
});

test("скользящее окно: added и removed только в пересечении старого и нового покрытий", () => {
  const b = base(
    [
      deadline("old-edge", "2026-10-02T10:00Z"),
      deadline("mid-gone", "2026-11-01T10:00Z"),
      deadline("past-new-low", "2026-10-12T10:00Z"),
    ],
    { from: "2026-10-01T00:00Z", to: "2026-11-30T00:00Z" }
  );
  // Окно сдвинулось на 10 дней вперёд.
  const out = run(
    b,
    [
      deadline("past-new-low", "2026-10-12T10:00Z"),
      // Новое в пересечении — added.
      deadline("mid-new", "2026-11-15T10:00Z"),
      // Новое за старой верхней границей — окно просто «доросло»: события нет.
      deadline("tail-new", "2026-12-05T10:00Z"),
    ],
    { coverage: { from: "2026-10-11T00:00Z", to: "2026-12-10T00:00Z" } }
  );
  assert.deepEqual(types(out.events), ["added:mid-new", "removed:mid-gone"]);
  // Ушедший ниже новой нижней границы забыт без события, «дорос» — в базе.
  assert.deepEqual(Object.keys(out.baseline.facts).sort(), ["mid-new", "past-new-low", "tail-new"]);
  assert.deepEqual(out.baseline.coverage, { from: "2026-10-11T00:00Z", to: "2026-12-10T00:00Z" });
});

test("скользящее окно: пропавший за новой верхней границей факт переносится без события", () => {
  const b = base([deadline("far", "2026-11-28T10:00Z")], {
    from: "2026-10-01T00:00Z",
    to: "2026-11-30T00:00Z",
  });
  // Новое покрытие уже (например, усечённое): факт вне него — не «пропал».
  const out = run(b, [], { coverage: { from: "2026-10-01T00:00Z", to: "2026-11-20T00:00Z" } });
  assert.deepEqual(out.events, []);
  assert.ok(out.baseline.facts.far);
});

test("факт без оси (at не задан) всегда внутри окна", () => {
  const b = base([deadline("w", "x", { at: undefined })], {
    from: "2026-10-01T00:00Z",
    to: "2026-10-02T00:00Z",
  });
  const out = run(b, [deadline("n", "y", { at: undefined })], {
    coverage: { from: "2026-10-05T00:00Z", to: "2026-10-06T00:00Z" },
  });
  assert.deepEqual(types(out.events), ["added:n", "removed:w"]);
});

test("покрытие без границ (null) — не ограничено", () => {
  const b = base([deadline("1", "2020-01-01T00:00Z")], { from: null, to: null });
  const out = run(b, [deadline("2", "2030-01-01T00:00Z")], { coverage: { from: null, to: null } });
  assert.deepEqual(types(out.events), ["added:2", "removed:1"]);
});

test("усечение (truncated): removed не вычисляется, отсутствующее переносится", () => {
  const cov = { from: "2026-10-01T00:00Z", to: "2026-12-01T00:00Z" };
  const b = base([deadline("1", "2026-10-30T20:59Z"), deadline("2", "2026-11-05T20:59Z")], cov);
  const out = run(b, [deadline("1", "2026-10-30T20:59Z"), deadline("3", "2026-10-31T20:59Z")], {
    coverage: cov,
    truncated: true,
  });
  assert.deepEqual(types(out.events), ["added:3"]);
  assert.deepEqual(Object.keys(out.baseline.facts).sort(), ["1", "2", "3"]);
});

test("усечение при carryMissing: false — отсутствующее не переносится и не событие", () => {
  const b = base([deadline("1", "2026-10-30T20:59Z"), deadline("2", "2026-11-05T20:59Z")]);
  const out = run(b, [deadline("1", "2026-10-30T20:59Z")], {
    truncated: true,
    carryMissing: false,
  });
  assert.deepEqual(out.events, []);
  assert.deepEqual(Object.keys(out.baseline.facts), ["1"]);
});

test("emitRemoved: false — пропавшее переносится без события (заявки)", () => {
  const b = base([deadline("1", "x", { at: undefined }), deadline("2", "y", { at: undefined })]);
  const out = run(b, [deadline("1", "x", { at: undefined })], { emitRemoved: false });
  assert.deepEqual(out.events, []);
  assert.deepEqual(Object.keys(out.baseline.facts).sort(), ["1", "2"]);
});

test("carryMissing: false и пустой ответ над непустой базой — база целиком, без событий", () => {
  const cov = { from: "2026-10-01T00:00Z", to: null };
  const b = base([deadline("1", "2026-10-30T20:59Z")], cov);
  const out = run(b, [], {
    carryMissing: false,
    emitRemoved: false,
    coverage: { from: null, to: null },
  });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.events, []);
  assert.deepEqual(Object.keys(out.baseline.facts), ["1"]);
  // Покрытие и факты — прежние, момент — новый.
  assert.deepEqual(out.baseline.coverage, cov);
  assert.equal(out.baseline.takenAt, T1.toISOString());
});

test("carryMissing: false и непустой ответ — пропавшие не переносятся", () => {
  const b = base([deadline("1", "x", { at: undefined }), deadline("2", "y", { at: undefined })]);
  const out = run(b, [deadline("2", "y", { at: undefined })], {
    carryMissing: false,
    emitRemoved: false,
  });
  assert.deepEqual(out.events, []);
  assert.deepEqual(Object.keys(out.baseline.facts), ["2"]);
});

test("overdue: срок пересёк «сейчас» между снимками — событие с cause clock", () => {
  const b = base([
    deadline("crossed", "2026-10-22T20:59Z"),
    deadline("future", "2026-10-30T20:59Z"),
    deadline("long-ago", "2026-10-10T20:59Z"),
    deadline("exactly-now", "2026-10-25T09:00Z"),
    deadline("exactly-prev", "2026-10-20T09:00Z"),
  ]);
  const out = run(
    b,
    Object.values(b.facts).map((f) => ({ ...f })),
    { detectOverdue: true }
  );
  assert.deepEqual(types(out.events), ["overdue:crossed", "overdue:exactly-now"]);
  for (const e of out.events) assert.equal(e.cause, "clock");
});

test("overdue: только при detectOverdue и только для UTC-срока вида …Z", () => {
  const b = base([
    deadline("naive", "2026-10-22T20:59"),
    deadline("seconds", "2026-10-22T20:59:00Z"),
    deadline("ok", "2026-10-22T20:59Z"),
  ]);
  const facts = Object.values(b.facts);
  assert.deepEqual(run(b, facts).events, []);
  assert.deepEqual(types(run(b, facts, { detectOverdue: true }).events), ["overdue:ok"]);
});

test("overdue: новый (added) уже просроченный факт overdue не даёт; пропавший — тоже", () => {
  const b = base([deadline("gone", "2026-10-22T20:59Z")]);
  const out = run(b, [deadline("new", "2026-10-22T20:59Z")], { detectOverdue: true });
  assert.deepEqual(types(out.events), ["added:new", "removed:gone"]);
});

test("changed и overdue одновременно", () => {
  const b = base([
    deadline("1", "2026-10-22T20:59Z", { attrs: { due: "2026-10-22T20:59Z", name: "А" } }),
  ]);
  const out = run(
    b,
    [deadline("1", "2026-10-22T20:59Z", { attrs: { due: "2026-10-22T20:59Z", name: "Б" } })],
    { detectOverdue: true }
  );
  assert.deepEqual(types(out.events), ["changed:1", "overdue:1"]);
});

test("silentEmptyGrade: новый элемент с пустой оценкой — не событие, но в базе", () => {
  const g = (id, grade) => ({
    id,
    scope: "grades",
    kind: "grade_item",
    title: id,
    course: "Матан",
    attrs: grade === null ? {} : { grade },
  });
  const b = base([g("a", "5")]);
  const out = run(b, [g("a", "5"), g("b", null), g("c", "—"), g("d", "7")], {
    silentEmptyGrade: true,
  });
  assert.deepEqual(types(out.events), ["added:d"]);
  assert.equal(out.events[0].course, "Матан");
  assert.deepEqual(Object.keys(out.baseline.facts).sort(), ["a", "b", "c", "d"]);
});

test("повторяющиеся id во входе не теряются (суффикс #n)", () => {
  const b = base([deadline("1", "2026-10-30T20:59Z")]);
  const out = run(b, [deadline("1", "2026-10-30T20:59Z"), deadline("1", "2026-10-31T20:59Z")]);
  assert.deepEqual(types(out.events), ["added:1#2"]);
  assert.deepEqual(Object.keys(out.baseline.facts).sort(), ["1", "1#2"]);
});

test("mergeMoves: removed + added с одним ключом склейки → moved", () => {
  const cov = { from: "2026-10-25T00:00", to: "2026-11-08T23:59" };
  const b = diffSource({
    source: "elk_schedule",
    scope: "schedule",
    baseline: null,
    facts: [lesson("2026-10-27T10:00", "Матан"), lesson("2026-10-28T12:00", "Физика")],
    coverage: cov,
    takenAt: T0,
  }).baseline;
  const out = diffSource({
    source: "elk_schedule",
    scope: "schedule",
    baseline: b,
    facts: [
      lesson("2026-10-29T13:00", "Матан", { attrs: { auditorium: "R301" } }),
      lesson("2026-10-28T12:00", "Физика"),
    ],
    coverage: cov,
    takenAt: T1,
    mergeMoves: true,
  });
  assert.equal(out.events.length, 1);
  const [moved] = out.events;
  assert.equal(moved.type, "moved");
  assert.equal(moved.id, "2026-10-29|13:00|Матан|Лекция");
  assert.equal(moved.source, "elk_schedule");
  assert.deepEqual(moved.fields, [
    { field: "start", from: "2026-10-27T10:00", to: "2026-10-29T13:00" },
    { field: "auditorium", from: "R205", to: "R301" },
  ]);
});

test("mergeMoves: неоднозначная склейка не выполняется; без флага — removed + added", () => {
  const cov = { from: "2026-10-25T00:00", to: "2026-11-08T23:59" };
  const b = diffSource({
    source: "elk_schedule",
    scope: "schedule",
    baseline: null,
    facts: [lesson("2026-10-27T10:00", "Матан"), lesson("2026-10-27T12:00", "Матан")],
    coverage: cov,
    takenAt: T0,
  }).baseline;
  const facts = [lesson("2026-10-29T10:00", "Матан"), lesson("2026-10-29T12:00", "Матан")];
  const common = {
    source: "elk_schedule",
    scope: "schedule",
    baseline: b,
    facts,
    coverage: cov,
    takenAt: T1,
  };
  const ambiguous = diffSource({ ...common, mergeMoves: true });
  assert.deepEqual(ambiguous.events.map((e) => e.type).sort(), [
    "added",
    "added",
    "removed",
    "removed",
  ]);
  // Один removed и один added без флага склейки тоже не склеиваются.
  const single = diffSource({
    ...common,
    facts: [lesson("2026-10-29T10:00", "Матан"), lesson("2026-10-27T12:00", "Матан")],
  });
  assert.deepEqual(single.events.map((e) => e.type).sort(), ["added", "removed"]);
});

test("mergeMoves: перенос за пределы пересечения окон — не moved и не removed", () => {
  const b = diffSource({
    source: "elk_schedule",
    scope: "schedule",
    baseline: null,
    facts: [lesson("2026-10-27T10:00", "Матан")],
    coverage: { from: "2026-10-25T00:00", to: "2026-11-08T23:59" },
    takenAt: T0,
  }).baseline;
  const out = diffSource({
    source: "elk_schedule",
    scope: "schedule",
    baseline: b,
    // Новое занятие — за старой верхней границей: added не выпускается, removed склеивать не с чем.
    facts: [lesson("2026-11-10T10:00", "Матан")],
    coverage: { from: "2026-10-25T00:00", to: "2026-11-12T23:59" },
    takenAt: T1,
    mergeMoves: true,
  });
  assert.deepEqual(types(out.events), ["removed:2026-10-27|10:00|Матан|Лекция"]);
});

test("diffSource не мутирует вход и базу", () => {
  const b = base([deadline("1", "2026-10-30T20:59Z"), deadline("2", "2026-11-05T20:59Z")]);
  const snapshot = structuredClone(b);
  const facts = [deadline("1", "2026-10-31T20:59Z")];
  const factsSnapshot = structuredClone(facts);
  run(b, facts, { detectOverdue: true, mergeMoves: true });
  assert.deepEqual(b, snapshot);
  assert.deepEqual(facts, factsSnapshot);
});
