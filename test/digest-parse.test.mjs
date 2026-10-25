import assert from "node:assert/strict";
import { test } from "node:test";

const {
  scanDates,
  parseDateTime,
  combineDateAndTime,
  toLocalIso,
  startOfDay,
  endOfDay,
  isExamType,
  sortItems,
  isActualCourse,
  selectCourses,
} = await import(new URL("../dist/services/digest/parse.js", import.meta.url).href);

// Ожидания строятся в местном времени машины: разбор без пояса идёт в нём же.
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("scanDates: ISO, точки, словесные месяцы — в порядке появления", () => {
  const found = scanDates(
    "с 2026-10-14 по 15.10.2026 10:30, затем 16 октября 2026 г. в 23:59 и 17 October 2026"
  );
  assert.deepEqual(found, [
    local(2026, 10, 14),
    local(2026, 10, 15, 10, 30),
    local(2026, 10, 16, 23, 59),
    local(2026, 10, 17),
  ]);
});

test("scanDates: время с T и секундами, am/pm", () => {
  assert.deepEqual(scanDates("2026-10-14T10:30:00"), [local(2026, 10, 14, 10, 30)]);
  assert.deepEqual(scanDates("14 October 2026, 11:59 pm"), [local(2026, 10, 14, 23, 59)]);
  assert.deepEqual(scanDates("14 October 2026, 12:05 am"), [local(2026, 10, 14, 0, 5)]);
  assert.deepEqual(scanDates("14 October 2026, 12:05 pm"), [local(2026, 10, 14, 12, 5)]);
});

test("scanDates: формат окон СОП — время перед датой, без двойного совпадения", () => {
  assert.deepEqual(scanDates("23:59 25.10.2026 по московскому времени"), [
    local(2026, 10, 25, 23, 59),
  ]);
});

test("scanDates: endOfDayIfNoTime — срок без времени означает конец дня", () => {
  assert.deepEqual(scanDates("до 25.10.2026", { endOfDayIfNoTime: true }), [
    local(2026, 10, 25, 23, 59),
  ]);
  assert.deepEqual(scanDates("до 25.10.2026"), [local(2026, 10, 25)]);
});

test("scanDates: несуществующие даты, неизвестные месяцы и NBSP", () => {
  assert.deepEqual(scanDates("31.02.2026 и 30 брюмера 2026"), []);
  assert.deepEqual(scanDates("15 октября 2026"), [local(2026, 10, 15)]);
  assert.deepEqual(scanDates("нет дат"), []);
});

test("parseDateTime: ISO с поясом читается как момент, без пояса — в местном времени", () => {
  assert.equal(
    parseDateTime("2026-09-17T09:58:51+03:00").getTime(),
    Date.parse("2026-09-17T06:58:51Z")
  );
  assert.equal(parseDateTime(" 2026-09-17T06:58Z ").getTime(), Date.parse("2026-09-17T06:58Z"));
  assert.deepEqual(parseDateTime("2026-09-17T09:58:51"), local(2026, 9, 17, 9, 58));
  assert.equal(parseDateTime("никогда"), null);
});

test("combineDateAndTime: два поля расписания; полная дата во времени важнее", () => {
  assert.deepEqual(combineDateAndTime("2026-10-26", "10:30"), local(2026, 10, 26, 10, 30));
  assert.deepEqual(combineDateAndTime("2026-10-26", "9:00:00"), local(2026, 10, 26, 9, 0));
  assert.deepEqual(combineDateAndTime("2026-10-26", null), local(2026, 10, 26));
  assert.deepEqual(
    combineDateAndTime("2026-10-26", "2026-10-27T12:10:00"),
    local(2026, 10, 27, 12, 10)
  );
  assert.equal(combineDateAndTime("завтра", "10:30"), null);
});

test("toLocalIso: местное время со смещением, момент сохраняется", () => {
  const d = local(2026, 10, 25, 23, 59);
  const iso = toLocalIso(d);
  assert.match(iso, /^2026-10-25T23:59:00[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(iso), d.getTime());
  const utc = new Date("2026-03-01T00:30:00Z");
  assert.equal(Date.parse(toLocalIso(utc)), utc.getTime());
});

test("startOfDay / endOfDay — границы местных суток", () => {
  const d = local(2026, 10, 25, 13, 45);
  assert.deepEqual(startOfDay(d), local(2026, 10, 25));
  assert.deepEqual(endOfDay(d), new Date(2026, 9, 25, 23, 59, 59, 999));
});

test("isExamType: экзамены, зачёты, коллоквиумы; консультация — нет", () => {
  for (const t of ["Экзамен", "зачет", "Дифференцированный зачёт", "Коллоквиум", "Exam"])
    assert.ok(isExamType(t), t);
  for (const t of ["Лекция", "Консультация к экзамену", "", undefined])
    assert.ok(!isExamType(t), String(t));
});

test("sortItems: просроченные первыми, затем по времени, затем без даты; стабильно", () => {
  const item = (title, when, overdue) => ({
    kind: "assignment",
    when,
    title,
    source: "s",
    ...(overdue ? { overdue: true } : {}),
  });
  const input = [
    item("без даты 1", null),
    item("позже", "2026-10-27T10:00:00+03:00"),
    item("просрочено", "2026-10-01T10:00:00+03:00", true),
    item("раньше", "2026-10-26T10:00:00+03:00"),
    item("без даты 2", null),
  ];
  const out = sortItems(input);
  assert.deepEqual(
    out.map((i) => i.title),
    ["просрочено", "раньше", "позже", "без даты 1", "без даты 2"]
  );
  // Вход не меняется.
  assert.equal(input[0].title, "без даты 1");
});

const NOW = local(2026, 10, 25, 12);
const course = (id, over = {}) => ({
  id,
  fullname: `Курс ${id}`,
  shortname: `K${id}`,
  category: "",
  startdate: "2026-09-01T00:00:00.000Z",
  enddate: null,
  progress: null,
  isFavourite: false,
  hidden: false,
  visible: true,
  viewUrl: `https://edu.hse.ru/course/view.php?id=${id}`,
  ...over,
});

test("isActualCourse: без enddate или enddate не прошёл", () => {
  assert.ok(isActualCourse(course(1), NOW));
  assert.ok(isActualCourse(course(1, { enddate: "2026-12-31T00:00:00.000Z" }), NOW));
  assert.ok(isActualCourse(course(1, { enddate: NOW.toISOString() }), NOW));
  assert.ok(!isActualCourse(course(1, { enddate: "2026-06-30T00:00:00.000Z" }), NOW));
});

test("selectCourses: только видимые, не скрытые, актуальные; includeEnded — и завершённые", () => {
  const all = [
    course(1),
    course(2, { enddate: "2026-06-30T00:00:00.000Z" }),
    course(3, { hidden: true }),
    course(4, { visible: false }),
  ];
  assert.deepEqual(
    selectCourses(all, undefined, NOW).map((c) => c.id),
    [1]
  );
  assert.deepEqual(
    selectCourses(all, [], NOW, { includeEnded: true }).map((c) => c.id),
    [1, 2]
  );
});

test("selectCourses: фильтр по id и подстроке названия без учёта регистра", () => {
  const all = [
    course(1, { fullname: "Математический анализ", shortname: "МатАн" }),
    course(2, { fullname: "Физика", shortname: "Phys" }),
    course(3, { fullname: "История", shortname: "Hist" }),
  ];
  assert.deepEqual(
    selectCourses(all, ["анализ", 3], NOW).map((c) => c.id),
    [1, 3]
  );
  assert.deepEqual(
    selectCourses(all, ["PHYS"], NOW).map((c) => c.id),
    [2]
  );
});

test("selectCourses: фильтр не нашёл ничего — ошибка со списком доступных", () => {
  const all = [course(1), course(2, { enddate: "2026-06-30T00:00:00.000Z" })];
  assert.throws(
    () => selectCourses(all, [2], NOW),
    /Ни один актуальный курс не подошёл под фильтр \[2\]\. Доступные курсы: 1 — Курс 1/
  );
  assert.deepEqual(
    selectCourses(all, [2], NOW, { includeEnded: true }).map((c) => c.id),
    [2]
  );
  assert.throws(() => selectCourses([], ["x"], NOW), /Доступные курсы: нет/);
});
