import assert from "node:assert/strict";
import { test } from "node:test";

const {
  normText,
  normOrNull,
  utcMinute,
  mskNaive,
  sopNaive,
  isEmptyGrade,
  canonicalAttrs,
  fingerprint,
  dedupeIds,
} = await import(new URL("../dist/services/changes/normalize.js", import.meta.url).href);

test("normText: NFC, схлопывание пробелов, trim; null и undefined — пустая строка", () => {
  assert.equal(normText("  Матан\n\t  лекция  "), "Матан лекция");
  assert.equal(normText(" а  б "), "а б");
  // «й» из «и» + комбинируемой краткой приводится к одному символу.
  assert.equal(normText("й"), "й");
  assert.equal(normText(null), "");
  assert.equal(normText(undefined), "");
  assert.equal(normText(42), "42");
  // Регистр не меняется.
  assert.equal(normText("ABC"), "ABC");
});

test("normOrNull: пустое после нормализации — null", () => {
  assert.equal(normOrNull("  "), null);
  assert.equal(normOrNull(null), null);
  assert.equal(normOrNull(" x "), "x");
});

test("utcMinute: Date, миллисекунды и строки с поясом → UTC без секунд", () => {
  assert.equal(utcMinute(new Date("2026-10-25T20:59:59.999Z")), "2026-10-25T20:59Z");
  assert.equal(utcMinute(Date.UTC(2026, 0, 2, 3, 4, 5)), "2026-01-02T03:04Z");
  assert.equal(utcMinute("2026-10-25T23:59:00+03:00"), "2026-10-25T20:59Z");
  assert.equal(utcMinute("2026-10-25T23:59:00+0300"), "2026-10-25T20:59Z");
  assert.equal(utcMinute("2026-10-25T10:00:00.000Z"), "2026-10-25T10:00Z");
  assert.equal(utcMinute("Sun, 25 Oct 2026 10:00:00 GMT"), "2026-10-25T10:00Z");
});

test("utcMinute: строка без пояса и нераспознанное значение — null", () => {
  // Наивные строки `Date` прочитал бы в поясе машины.
  assert.equal(utcMinute("2026-10-25T10:00"), null);
  assert.equal(utcMinute("2026-10-25"), null);
  assert.equal(utcMinute("25.10.2026 10:00"), null);
  assert.equal(utcMinute("мусор Z"), null);
  assert.equal(utcMinute(new Date(Number.NaN)), null);
  assert.equal(utcMinute(Number.NaN), null);
});

test("mskNaive: дата + время ЕЛК → наивное ГГГГ-ММ-ДДTЧЧ:мм", () => {
  assert.equal(mskNaive("2026-10-26", "9:30"), "2026-10-26T09:30");
  assert.equal(mskNaive("2026-10-26", "10:30:00"), "2026-10-26T10:30");
  assert.equal(mskNaive(" 2026-10-26T00:00:00 ", "18:10"), "2026-10-26T18:10");
  assert.equal(mskNaive("2026-10-26"), "2026-10-26T00:00");
  assert.equal(mskNaive("2026-10-26", null), "2026-10-26T00:00");
  assert.equal(mskNaive("26.10.2026", "9:30"), null);
});

test("sopNaive: формат окон СОП; без времени — конец дня", () => {
  assert.equal(sopNaive("23:59 25.10.2026 по московскому времени"), "2026-10-25T23:59");
  assert.equal(sopNaive("9:00 1.11.2026"), "2026-11-01T09:00");
  assert.equal(sopNaive("5.1.2027"), "2027-01-05T23:59");
  assert.equal(sopNaive("скоро"), null);
});

test("isEmptyGrade: пусто и прочерки", () => {
  for (const v of [null, undefined, "", "  ", "-", "–", "—", " - "]) assert.ok(isEmptyGrade(v), v);
  for (const v of ["0", "0,00", "8", "Зачтено"]) assert.ok(!isEmptyGrade(v), v);
});

test("canonicalAttrs: ключи по алфавиту, значения нормализованы, пустые отброшены", () => {
  const out = canonicalAttrs({ z: " b  c ", a: "1", empty: "", none: null, undef: undefined });
  assert.deepEqual(out, { a: "1", z: "b c" });
  assert.deepEqual(Object.keys(out), ["a", "z"]);
});

test("fingerprint: не зависит от порядка ключей; null, undefined, '' и отсутствие равны", () => {
  assert.equal(fingerprint({ a: "1", b: "2" }), fingerprint({ b: "2", a: "1" }));
  assert.equal(fingerprint({ a: "1", b: null }), fingerprint({ a: "1" }));
  assert.equal(fingerprint({ a: "1", b: "" }), fingerprint({ a: "1", b: undefined }));
  assert.equal(fingerprint({ a: " 1 " }), fingerprint({ a: "1" }));
  assert.notEqual(fingerprint({ a: "1" }), fingerprint({ a: "2" }));
});

test("dedupeIds: повторы получают #n, занятые суффиксы пропускаются", () => {
  const ids = (items) => dedupeIds(items.map((id) => ({ id }))).map((x) => x.id);
  assert.deepEqual(ids(["a", "b"]), ["a", "b"]);
  assert.deepEqual(ids(["a", "a", "a"]), ["a", "a#2", "a#3"]);
  // Настоящий id `a#2` уже занят — повтор `a` получает `a#3`.
  assert.deepEqual(ids(["a", "a", "a#2"]), ["a", "a#3", "a#2"]);
  assert.deepEqual(ids(["a#2", "a", "a"]), ["a#2", "a", "a#3"]);
});

test("dedupeIds: вход не мутируется, остальные поля сохраняются", () => {
  const input = [
    { id: "x", v: 1 },
    { id: "x", v: 2 },
  ];
  const out = dedupeIds(input);
  assert.deepEqual(out, [
    { id: "x", v: 1 },
    { id: "x#2", v: 2 },
  ]);
  assert.equal(input[1].id, "x");
});
