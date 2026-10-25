import assert from "node:assert/strict";
import { test } from "node:test";

const ex = await import(new URL("../dist/services/changes/extractors.js", import.meta.url).href);
const { utcMinute } = await import(
  new URL("../dist/services/changes/normalize.js", import.meta.url).href
);
const { formatLocalDate, addDays } = await import(
  new URL("../dist/date-utils.js", import.meta.url).href
);
const { singleExtractors, gradesExtractor, INBOX_LMS_LIMIT, INBOX_NOTIFICATIONS_LIMIT } = ex;

// Полдень местного времени: границы окон считаются от локальной полуночи машины.
const NOW = new Date(2026, 9, 25, 12, 0, 0);
const OPTS = { maxAgeMs: 60_000 };
const ctx = { now: NOW, opts: OPTS };

const fail = (name) => () => {
  throw new Error(`${name} не должен вызываться`);
};
const deps = (over = {}) => ({
  listActionEvents: fail("listActionEvents"),
  listMessages: fail("listMessages"),
  listGradeItems: fail("listGradeItems"),
  getCourseEvaluationTable: fail("getCourseEvaluationTable"),
  getSchedule: fail("getSchedule"),
  getNotifications: fail("getNotifications"),
  listRequests: fail("listRequests"),
  ...over,
});
const extractor = (source, d) => singleExtractors(d).find((e) => e.source === source);

const event = (over = {}) => ({
  id: 101,
  name: "  Домашнее  задание 1 ",
  module: "assign",
  course: "Матан",
  courseId: 7,
  due: "2026-10-30T20:59:00.000Z",
  overdue: false,
  actionable: true,
  actionName: "Добавить ответ",
  url: "https://edu.hse.ru/mod/assign/view.php?id=1",
  ...over,
});

test("шесть источников с областями и флагами сравнения", () => {
  const all = singleExtractors(deps());
  assert.deepEqual(
    all.map((e) => [e.source, e.scope]),
    [
      ["lms_calendar", "deadlines"],
      ["elk_windows", "deadlines"],
      ["elk_schedule", "schedule"],
      ["lms_messages", "inbox"],
      ["elk_notifications", "inbox"],
      ["elk_claims", "claims"],
    ]
  );
  const flags = Object.fromEntries(all.map((e) => [e.source, e.flags]));
  assert.deepEqual(flags.lms_calendar, { detectOverdue: true });
  assert.deepEqual(flags.elk_schedule, { mergeMoves: true });
  assert.deepEqual(flags.lms_messages, {
    emitChanged: false,
    emitRemoved: false,
    carryMissing: false,
  });
  assert.deepEqual(flags.elk_claims, { emitRemoved: false });
});

test("lms_calendar: события → факты со стабильным id и UTC-сроком", async () => {
  let args;
  const e = extractor(
    "lms_calendar",
    deps({
      listActionEvents: async (from, to, opts) => {
        args = { from, to, opts };
        return {
          events: [
            event(),
            event({ id: 102, module: "quiz", name: "Тест", course: "" }),
            event({ id: 103, module: "forum", name: "Форум" }),
          ],
          truncated: false,
        };
      },
    })
  );
  const res = await e.run(ctx);
  assert.equal(args.opts, OPTS);
  assert.deepEqual(args.from, addDays(new Date(2026, 9, 25), -ex.CALENDAR_LOOKBACK_DAYS));
  assert.deepEqual(args.to, new Date(2026, 9, 25 + ex.CALENDAR_HORIZON_DAYS, 23, 59, 59, 999));
  assert.deepEqual(res.facts[0], {
    id: "101",
    scope: "deadlines",
    kind: "assignment",
    title: "Домашнее задание 1",
    course: "Матан",
    attrs: { due: "2026-10-30T20:59Z", name: "Домашнее задание 1" },
    at: "2026-10-30T20:59Z",
  });
  assert.equal(res.facts[1].kind, "quiz");
  assert.equal("course" in res.facts[1], false);
  assert.equal(res.facts[2].kind, "lms_activity");
  assert.deepEqual(res.coverage, { from: utcMinute(args.from), to: utcMinute(args.to) });
  assert.equal(res.truncated, false);
  assert.deepEqual(res.warnings, []);
});

test("lms_calendar: усечение сужает покрытие до минуты перед последним сроком", async () => {
  const e = extractor(
    "lms_calendar",
    deps({
      listActionEvents: async () => ({
        events: [
          event({ id: 1, due: "2026-10-30T20:59:00.000Z" }),
          event({ id: 2, due: "2026-11-02T00:00:00.000Z" }),
        ],
        truncated: true,
      }),
    })
  );
  const res = await e.run(ctx);
  assert.equal(res.truncated, true);
  assert.equal(res.coverage.to, "2026-11-01T23:59Z");
  assert.match(res.warnings[0], /усечён/);
});

test("lms_calendar: порядок ответа не влияет на суффиксы дубликатов", async () => {
  const a = event({ id: 5, name: "А", due: "2026-10-30T20:59:00.000Z" });
  const b = event({ id: 5, name: "Б", due: "2026-10-30T20:59:00.000Z" });
  const runWith = (events) =>
    extractor(
      "lms_calendar",
      deps({ listActionEvents: async () => ({ events, truncated: false }) })
    )
      .run(ctx)
      .then((r) => r.facts.map((f) => `${f.id}=${f.title}`));
  assert.deepEqual(await runWith([a, b]), ["5=А", "5#2=Б"]);
  assert.deepEqual(await runWith([b, a]), ["5=А", "5#2=Б"]);
});

test("lms_calendar: нераспознанные сроки — предупреждение; все нераспознаны — ошибка", async () => {
  const partial = await extractor(
    "lms_calendar",
    deps({
      listActionEvents: async () => ({
        events: [event(), event({ id: 2, due: "когда-нибудь" })],
        truncated: false,
      }),
    })
  ).run(ctx);
  assert.equal(partial.facts.length, 1);
  assert.deepEqual(partial.warnings, ["событий календаря LMS без распознанной даты пропущено: 1"]);

  await assert.rejects(
    extractor(
      "lms_calendar",
      deps({
        listActionEvents: async () => ({ events: [event({ due: "мусор" })], truncated: false }),
      })
    ).run(ctx),
    /не удалось разобрать даты элементов: 1 из 1/
  );

  const empty = await extractor(
    "lms_calendar",
    deps({ listActionEvents: async () => ({ events: [], truncated: false }) })
  ).run(ctx);
  assert.deepEqual(empty.facts, []);
});

test("elk_windows: id — период, срок и статус нормализованы", async () => {
  const e = extractor(
    "elk_windows",
    deps({
      getCourseEvaluationTable: async () => ({
        found: true,
        rows: [
          {
            "#": "1",
            Период: " 1 модуль 2026/2027 ",
            "Дата начала": "00:00 01.10.2026 по московскому времени",
            "Дата окончания": "23:59 25.10.2026 по московскому времени",
            Статус: "Анкета доступна",
          },
          { "#": "2", Период: "", Статус: "?" },
        ],
      }),
    })
  );
  const res = await e.run(ctx);
  assert.deepEqual(res.facts, [
    {
      id: "1 модуль 2026/2027",
      scope: "deadlines",
      kind: "elk_window",
      title: "Оценка курсов (СОП): 1 модуль 2026/2027",
      attrs: { end: "2026-10-25T23:59", status: "Анкета доступна" },
    },
  ]);
  assert.deepEqual(res.warnings, ["строк СОП без периода пропущено: 1"]);
});

test("elk_windows: таблица не найдена или ни одной строки с периодом — ошибка источника", async () => {
  await assert.rejects(
    extractor(
      "elk_windows",
      deps({ getCourseEvaluationTable: async () => ({ found: false, rows: [] }) })
    ).run(ctx),
    /таблица окон СОП не найдена/
  );
  await assert.rejects(
    extractor(
      "elk_windows",
      deps({ getCourseEvaluationTable: async () => ({ found: true, rows: [{ "#": "1" }] }) })
    ).run(ctx),
    /не удалось найти период/
  );
  const none = await extractor(
    "elk_windows",
    deps({ getCourseEvaluationTable: async () => ({ found: true, rows: [] }) })
  ).run(ctx);
  assert.deepEqual(none, { facts: [], warnings: [] });
});

const lessonRow = (over = {}) => ({
  auditorium: " R205 ",
  building: "Покровский б-р, 11",
  name: "Матанализ",
  lesson_type: "Лекция",
  begin_time: "10:30",
  end_time: "11:50",
  lecturer: "Иванов И. И.",
  parent_schedule: "",
  ...over,
});

test("elk_schedule: занятия → факты, id из даты, времени, названия и типа", async () => {
  let args;
  const e = extractor(
    "elk_schedule",
    deps({
      getSchedule: async (from, to, opts) => {
        args = { from, to, opts };
        return [
          {
            date: "2026-10-26",
            lessons: [lessonRow(), lessonRow({ name: "Алгебра", lesson_type: "Экзамен" })],
          },
          { date: "2026-10-27", lessons: [lessonRow({ begin_time: "" })] },
          { date: "кривая дата", lessons: [lessonRow()] },
          { date: "2026-10-28", lessons: null },
        ];
      },
    })
  );
  const res = await e.run(ctx);
  assert.equal(args.opts, OPTS);
  assert.deepEqual(args.from, new Date(2026, 9, 25));
  assert.deepEqual(args.to, addDays(new Date(2026, 9, 25), ex.SCHEDULE_HORIZON_DAYS));
  const byId = Object.fromEntries(res.facts.map((f) => [f.id, f]));
  assert.deepEqual(byId["2026-10-26|10:30|Матанализ|Лекция"], {
    id: "2026-10-26|10:30|Матанализ|Лекция",
    scope: "schedule",
    kind: "lesson",
    title: "Матанализ",
    attrs: { auditorium: "R205", building: "Покровский б-р, 11", end: "2026-10-26T11:50" },
    at: "2026-10-26T10:30",
    matchKey: "Матанализ|Лекция",
  });
  assert.equal(byId["2026-10-26|10:30|Алгебра|Экзамен"].kind, "exam");
  // Пустое время начала — полночь (дата распознана).
  assert.ok(byId["2026-10-27|00:00|Матанализ|Лекция"]);
  assert.deepEqual(res.coverage, {
    from: `${formatLocalDate(args.from, "-")}T00:00`,
    to: `${formatLocalDate(args.to, "-")}T23:59`,
  });
  assert.deepEqual(res.warnings, ["занятий расписания ЕЛК без распознанной даты пропущено: 1"]);
});

const message = (over = {}) => ({
  id: 9,
  subject: " Перенос  семинара ",
  course: "Матан",
  sender: "Петров",
  time: "2026-10-24T08:15:30.000Z",
  unread: true,
  starred: false,
  numAttachments: 0,
  ...over,
});

test("lms_messages: письма → факты; покрытие без нижней границы, пока лимит не достигнут", async () => {
  let limit;
  const res = await extractor(
    "lms_messages",
    deps({
      listMessages: async (n) => {
        limit = n;
        return [message(), message({ id: 10, course: "", time: "сломано" })];
      },
    })
  ).run(ctx);
  assert.equal(limit, INBOX_LMS_LIMIT);
  assert.deepEqual(res.facts, [
    {
      id: "9",
      scope: "inbox",
      kind: "lms_message",
      title: "Перенос семинара",
      course: "Матан",
      attrs: { subject: "Перенос семинара" },
      at: "2026-10-24T08:15Z",
    },
  ]);
  assert.deepEqual(res.coverage, { from: null, to: null });
  assert.deepEqual(res.warnings, ["писем LMS без распознанной даты пропущено: 1"]);
});

test("lms_messages: выборка упёрлась в лимит — нижняя граница по самому старому письму", async () => {
  const messages = Array.from({ length: INBOX_LMS_LIMIT }, (_, i) =>
    message({ id: i + 1, time: new Date(Date.UTC(2026, 9, 1 + (i % 20), 10)).toISOString() })
  );
  const res = await extractor("lms_messages", deps({ listMessages: async () => messages })).run(
    ctx
  );
  assert.deepEqual(res.coverage, { from: "2026-10-01T10:00Z", to: null });
});

test("lms_messages: все даты нераспознаны — ошибка источника", async () => {
  await assert.rejects(
    extractor("lms_messages", deps({ listMessages: async () => [message({ time: "x" })] })).run(
      ctx
    ),
    /не удалось разобрать даты/
  );
});

const notification = (over = {}) => ({
  id: 3,
  title: " Новое  уведомление ",
  text: "текст",
  isImportant: false,
  isRead: false,
  date: "2026-10-24",
  ...over,
});

test("elk_notifications: дата сводится к суткам как записана, с поясом и без", async () => {
  let limit;
  const res = await extractor(
    "elk_notifications",
    deps({
      getNotifications: async (n) => {
        limit = n;
        return {
          count: 4,
          notifications: [
            notification(),
            notification({ id: 4, date: "2026-10-23T23:30:00+03:00" }),
            notification({ id: 5, date: "2026-10-22T22:30:00Z" }),
            notification({ id: 6, date: "вчера" }),
          ],
        };
      },
    })
  ).run(ctx);
  assert.equal(limit, INBOX_NOTIFICATIONS_LIMIT);
  assert.deepEqual(
    res.facts.map((f) => [f.id, f.at]),
    [
      ["3", "2026-10-24"],
      ["4", "2026-10-23"],
      ["5", "2026-10-22"],
    ]
  );
  assert.deepEqual(res.facts[0].attrs, { title: "Новое уведомление" });
  assert.equal(res.facts[0].kind, "notification");
  assert.deepEqual(res.coverage, { from: null, to: null });
  assert.deepEqual(res.warnings, ["уведомлений ЕЛК без распознанной даты пропущено: 1"]);
});

test("elk_notifications: count больше выданного — нижняя граница по самому старому", async () => {
  const res = await extractor(
    "elk_notifications",
    deps({
      getNotifications: async () => ({
        count: 300,
        notifications: [
          notification({ id: 1, date: "2026-10-24" }),
          notification({ id: 2, date: "2026-10-20" }),
        ],
      }),
    })
  ).run(ctx);
  assert.deepEqual(res.coverage, { from: "2026-10-20", to: null });
});

const claim = (over = {}) => ({
  num: " 2026-001 ",
  text: "Прошу выдать справку",
  service: "Справка об обучении",
  executorFio: "Сидоров",
  createdByEmail: "student@edu.hse.ru",
  createdByFio: "Студент",
  stateName: "В работе",
  active: true,
  created: "2026-10-20",
  updated: "2026-10-21",
  url: null,
  ...over,
});

test("elk_claims: id — номер, без свободного текста и ФИО; без номера — пропуск", async () => {
  let limit;
  const res = await extractor(
    "elk_claims",
    deps({
      listRequests: async (n) => {
        limit = n;
        return {
          count: 3,
          requests: [
            claim(),
            claim({ num: " ", active: false }),
            claim({ num: "7", active: false, stateName: "Выполнена" }),
          ],
        };
      },
    })
  ).run(ctx);
  assert.equal(limit, ex.CLAIMS_LIMIT);
  assert.deepEqual(res.facts, [
    {
      id: "2026-001",
      scope: "claims",
      kind: "elk_claim",
      title: "Справка об обучении",
      attrs: { active: "1", state: "В работе" },
    },
    {
      id: "7",
      scope: "claims",
      kind: "elk_claim",
      title: "Справка об обучении",
      attrs: { active: "0", state: "Выполнена" },
    },
  ]);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.warnings, ["заявок без номера пропущено: 1"]);
  const text = JSON.stringify(res.facts);
  for (const secret of ["Прошу", "Сидоров", "student@", "Студент"])
    assert.ok(!text.includes(secret), secret);
});

test("elk_claims: count больше выданного — усечение", async () => {
  const res = await extractor(
    "elk_claims",
    deps({ listRequests: async () => ({ count: 900, requests: [claim()] }) })
  ).run(ctx);
  assert.equal(res.truncated, true);
  assert.match(res.warnings[0], /усечён/);
});

const course = { id: 42, fullname: " Матанализ ", shortname: "МА" };
const gradeRow = (name, path, grade, isCategory = false) => ({
  name,
  level: path.length + 1,
  path,
  isCategory,
  grade,
});

test("lms_grades: элементы журнала → факты, пустая оценка — null, категории пропускаются", async () => {
  let asked;
  const e = gradesExtractor(
    course,
    deps({
      listGradeItems: async (id, opts) => {
        asked = { id, opts };
        return {
          found: true,
          recognized: true,
          rows: [
            gradeRow("Матанализ", [], null, true),
            gradeRow("ДЗ 1", ["Матанализ"], "8,00"),
            gradeRow("ДЗ 2", ["Матанализ"], "-"),
            gradeRow(" Итого  за курс ", [], "8,00"),
          ],
        };
      },
    })
  );
  assert.equal(e.source, "lms_grades:42");
  assert.equal(e.scope, "grades");
  assert.deepEqual(e.flags, { emitRemoved: false, carryMissing: false, silentEmptyGrade: true });
  const res = await e.run(ctx);
  assert.deepEqual(asked, { id: 42, opts: OPTS });
  assert.deepEqual(res.facts, [
    // Порядок — по id (`stableDedupe`), а не по ответу.
    {
      id: "42||Итого за курс",
      scope: "grades",
      kind: "grade_item",
      title: "Итого за курс",
      course: "Матанализ",
      attrs: { grade: "8,00" },
    },
    {
      id: "42|Матанализ|ДЗ 1",
      scope: "grades",
      kind: "grade_item",
      title: "ДЗ 1",
      course: "Матанализ",
      attrs: { grade: "8,00" },
    },
    {
      id: "42|Матанализ|ДЗ 2",
      scope: "grades",
      kind: "grade_item",
      title: "ДЗ 2",
      course: "Матанализ",
      attrs: {},
    },
  ]);
});

test("lms_grades: нераспознанная таблица — ошибка, а не пустая выдача", async () => {
  for (const table of [
    { found: false, recognized: false, rows: [] },
    { found: true, recognized: false, rows: [] },
  ]) {
    await assert.rejects(
      gradesExtractor(course, deps({ listGradeItems: async () => table })).run(ctx),
      /unsupported grade table/
    );
  }
});
