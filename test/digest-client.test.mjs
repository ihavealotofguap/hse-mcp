import assert from "node:assert/strict";
import { test } from "node:test";

const { buildDigest, getToday, getWeek, getDeadlines } = await import(
  new URL("../dist/services/digest/client.js", import.meta.url).href
);
const { pickDeadlineEvents, actionEventToItem, windowToItem } = await import(
  new URL("../dist/services/digest/sources.js", import.meta.url).href
);
const { toLocalIso, startOfDay, endOfDay } = await import(
  new URL("../dist/services/digest/parse.js", import.meta.url).href
);

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const iso = (...args) => toLocalIso(local(...args));
// Воскресенье, полдень местного времени.
const NOW = local(2026, 10, 25, 12);

const item = (kind, title, when, over = {}) => ({ kind, when, title, source: "test", ...over });

/** Коллекторы с заданными ответами; неуказанные возвращают пусто. Вызовы записываются. */
function collectors(over = {}) {
  const calls = [];
  const wrap = (name) => async (arg) => {
    calls.push({ name, arg });
    const v = over[name];
    if (typeof v === "function") return v(arg);
    return Array.isArray(v) || v === undefined ? { items: v ?? [] } : v;
  };
  const names = [
    "elkSchedule",
    "lmsDeadlines",
    "lmsMessages",
    "elkNotifications",
    "elkClaims",
    "elkTasks",
    "elkWindows",
  ];
  return { src: Object.fromEntries(names.map((n) => [n, wrap(n)])), calls };
}

const plan = (over = {}) => ({
  now: NOW,
  window: { from: startOfDay(NOW), to: endOfDay(local(2026, 10, 26)) },
  schedule: {
    range: { from: startOfDay(NOW), to: endOfDay(local(2026, 10, 26)) },
    lessonsUntil: endOfDay(NOW),
    examsUntil: endOfDay(local(2026, 10, 26)),
  },
  deadlinesUntil: endOfDay(local(2026, 10, 26)),
  includeUndated: false,
  include: { lmsMessages: true, notifications: true, claims: true, tasks: true },
  ...over,
});

test("buildDigest: отказ источника — статус error в sources, остальное собрано", async () => {
  const { src } = collectors({
    elkSchedule: () => {
      throw new Error("ЕЛК не ответил");
    },
    lmsDeadlines: [item("assignment", "ДЗ", iso(2026, 10, 26, 23, 59))],
    lmsMessages: { items: [item("lms_message", "Письмо", null)], warnings: ["частично"] },
  });
  const res = await buildDigest(plan(), src);
  assert.deepEqual(Object.keys(res.sources).sort(), [
    "elk_claims",
    "elk_notifications",
    "elk_schedule",
    "elk_tasks",
    "elk_windows",
    "lms_deadlines",
    "lms_messages",
  ]);
  assert.equal(res.sources.elk_schedule.status, "error");
  assert.equal(res.sources.elk_schedule.error, "ЕЛК не ответил");
  assert.equal(res.sources.lms_deadlines.status, "ok");
  assert.deepEqual(res.sources.lms_messages.warnings, ["частично"]);
  assert.deepEqual(
    res.items.map((i) => i.title),
    ["ДЗ", "Письмо"]
  );
  assert.equal(res.generatedAt, toLocalIso(NOW));
  assert.deepEqual(res.window, {
    from: toLocalIso(startOfDay(NOW)),
    to: toLocalIso(endOfDay(local(2026, 10, 26))),
  });
});

test("buildDigest: отказали все источники — пустая сводка, а не исключение", async () => {
  const boom = () => Promise.reject(new Error("нет сети"));
  const { src } = collectors(
    Object.fromEntries(
      [
        "elkSchedule",
        "lmsDeadlines",
        "lmsMessages",
        "elkNotifications",
        "elkClaims",
        "elkTasks",
        "elkWindows",
      ].map((n) => [n, boom])
    )
  );
  const res = await buildDigest(plan(), src);
  assert.deepEqual(res.items, []);
  for (const s of Object.values(res.sources)) assert.equal(s.status, "error");
});

test("buildDigest: зависший источник — ошибка по таймауту", async () => {
  const { src } = collectors({ elkWindows: () => new Promise(() => {}) });
  const res = await buildDigest(plan({ sourceTimeoutMs: 20 }), src);
  assert.equal(res.sources.elk_windows.status, "error");
  assert.match(res.sources.elk_windows.error, /не ответил/);
  assert.equal(res.sources.elk_schedule.status, "ok");
});

test("buildDigest: выключенные источники не вызываются и не попадают в sources", async () => {
  const { src, calls } = collectors();
  const res = await buildDigest(
    plan({ include: { lmsMessages: false, notifications: false, claims: true, tasks: false } }),
    src
  );
  assert.deepEqual(Object.keys(res.sources).sort(), [
    "elk_claims",
    "elk_schedule",
    "elk_windows",
    "lms_deadlines",
  ]);
  assert.deepEqual(calls.map((c) => c.name).sort(), [
    "elkClaims",
    "elkSchedule",
    "elkWindows",
    "lmsDeadlines",
  ]);
});

test("buildDigest: аргументы коллекторов из плана", async () => {
  const { src, calls } = collectors();
  const p = plan({ courses: ["анализ"] });
  await buildDigest(p, src);
  const arg = (name) => calls.find((c) => c.name === name).arg;
  assert.equal(arg("elkSchedule"), p.schedule.range);
  assert.deepEqual(arg("lmsDeadlines"), {
    range: { from: startOfDay(NOW), to: p.deadlinesUntil },
    now: NOW,
    courses: ["анализ"],
  });
  assert.equal(arg("elkWindows"), NOW);
});

test("buildDigest: отбор по окнам и сортировка", async () => {
  const { src } = collectors({
    elkSchedule: [
      item("lesson", "Вчерашняя лекция", iso(2026, 10, 24, 10)),
      item("lesson", "Лекция сегодня", iso(2026, 10, 25, 15)),
      item("lesson", "Лекция завтра", iso(2026, 10, 26, 10)),
      item("lesson", "Лекция без времени", null),
      item("exam", "Экзамен завтра", iso(2026, 10, 26, 9)),
      item("exam", "Экзамен через неделю", iso(2026, 11, 1, 9)),
    ],
    lmsDeadlines: [
      item("assignment", "Просрочено", iso(2026, 9, 1, 23, 59), { overdue: true }),
      item("assignment", "Завтра", iso(2026, 10, 26, 23, 59)),
      item("lms_activity", "Через неделю", iso(2026, 11, 1, 23, 59)),
    ],
    elkWindows: [item("elk_window", "Окно без даты", null)],
    elkTasks: [item("elk_task", "Задача", null)],
  });
  const res = await buildDigest(plan(), src);
  assert.deepEqual(
    res.items.map((i) => i.title),
    ["Просрочено", "Лекция сегодня", "Экзамен завтра", "Завтра", "Лекция без времени", "Задача"]
  );
});

test("buildDigest: includeUndated — дедлайны без даты; lessonsUntil null — без занятий", async () => {
  const { src } = collectors({
    elkSchedule: [
      item("lesson", "Лекция", iso(2026, 10, 25, 15)),
      item("exam", "Зачёт", iso(2026, 10, 26, 9)),
    ],
    elkWindows: [item("elk_window", "Окно без даты", null)],
  });
  const p = plan({ includeUndated: true });
  p.schedule.lessonsUntil = null;
  const res = await buildDigest(p, src);
  assert.deepEqual(
    res.items.map((i) => i.title),
    ["Зачёт", "Окно без даты"]
  );
});

// --- Три сводки поверх одних и тех же коллекторов ---

const overdueOld = item("assignment", "Просрочено давно", iso(2026, 9, 1, 23, 59), {
  overdue: true,
});
const overdueRecent = item("lms_activity", "Тест вчера", iso(2026, 10, 24, 23, 59), {
  overdue: true,
});
const digestSources = () =>
  collectors({
    elkSchedule: (range) => ({
      items: [
        item("lesson", "Лекция сегодня", iso(2026, 10, 25, 15)),
        item("lesson", "Лекция в среду", iso(2026, 10, 28, 10)),
        item("exam", "Экзамен в пятницу", iso(2026, 10, 30, 9)),
        item("exam", "Экзамен через 10 дней", iso(2026, 11, 4, 9)),
      ].filter((i) => Date.parse(i.when) <= range.to.getTime()),
    }),
    lmsDeadlines: [
      overdueOld,
      overdueRecent,
      item("assignment", "Завтра", iso(2026, 10, 26, 23, 59)),
      item("assignment", "В субботу", iso(2026, 10, 31, 23, 59)),
      item("assignment", "Через 12 дней", iso(2026, 11, 6, 23, 59)),
      item("assignment", "Без даты", null),
    ],
    lmsMessages: [item("lms_message", "Письмо", null, { unread: true })],
    elkNotifications: [item("notification", "Уведомление", null, { unread: true })],
    elkClaims: [item("elk_claim", "Заявка", null)],
  });

test("просроченные несданные видны во всех трёх сводках и идут первыми", async () => {
  for (const [name, call] of [
    ["my_today", (src) => getToday(NOW, src)],
    ["my_week", (src) => getWeek(NOW, src)],
    ["my_deadlines", (src) => getDeadlines({}, NOW, src)],
    ["my_deadlines days=1", (src) => getDeadlines({ days: 1 }, NOW, src)],
  ]) {
    const { src } = digestSources();
    const res = await call(src);
    assert.deepEqual(
      res.items.slice(0, 2).map((i) => i.title),
      ["Просрочено давно", "Тест вчера"],
      name
    );
  }
});

test("my_today: занятия сегодня, дедлайны и экзамены до конца завтра, почта и заявки", async () => {
  const { src, calls } = digestSources();
  const res = await getToday(NOW, src);
  assert.deepEqual(
    res.items.map((i) => i.title),
    [
      "Просрочено давно",
      "Тест вчера",
      "Лекция сегодня",
      "Завтра",
      "Письмо",
      "Уведомление",
      "Заявка",
    ]
  );
  assert.deepEqual(res.window, {
    from: toLocalIso(startOfDay(NOW)),
    to: toLocalIso(endOfDay(local(2026, 10, 26))),
  });
  assert.equal(calls.length, 7);
});

test("my_week: 7 дней, без почты, уведомлений, заявок и задач", async () => {
  const { src, calls } = digestSources();
  const res = await getWeek(NOW, src);
  assert.deepEqual(
    res.items.map((i) => i.title),
    [
      "Просрочено давно",
      "Тест вчера",
      "Лекция сегодня",
      "Завтра",
      "Лекция в среду",
      "Экзамен в пятницу",
      "В субботу",
    ]
  );
  assert.equal(res.window.to, toLocalIso(endOfDay(local(2026, 10, 31))));
  assert.deepEqual(calls.map((c) => c.name).sort(), ["elkSchedule", "elkWindows", "lmsDeadlines"]);
  assert.deepEqual(Object.keys(res.sources).sort(), [
    "elk_schedule",
    "elk_windows",
    "lms_deadlines",
  ]);
});

test("my_deadlines: горизонт days, экзамены без занятий, дедлайны без даты в конце", async () => {
  const { src, calls } = digestSources();
  const res = await getDeadlines({ days: 14, courses: [7] }, NOW, src);
  assert.deepEqual(
    res.items.map((i) => i.title),
    [
      "Просрочено давно",
      "Тест вчера",
      "Завтра",
      "Экзамен в пятницу",
      "В субботу",
      "Экзамен через 10 дней",
      "Через 12 дней",
      "Без даты",
      "Заявка",
    ]
  );
  assert.deepEqual(calls.find((c) => c.name === "lmsDeadlines").arg.courses, [7]);
  assert.equal(res.window.to, toLocalIso(endOfDay(local(2026, 11, 8))));
  assert.ok(!("lms_messages" in res.sources));
  assert.ok("elk_tasks" in res.sources);

  const short = await getDeadlines({ days: 3 }, NOW, digestSources().src);
  assert.deepEqual(
    short.items.map((i) => i.title),
    ["Просрочено давно", "Тест вчера", "Завтра", "Без даты", "Заявка"]
  );
});

// --- Отбор событий календаря по курсам ---

const course = (id, over = {}) => ({
  id,
  fullname: `Курс ${id}`,
  shortname: `K${id}`,
  category: "",
  startdate: "2026-01-01T00:00:00.000Z",
  enddate: null,
  progress: null,
  isFavourite: false,
  hidden: false,
  visible: true,
  viewUrl: "",
  ...over,
});
const calEvent = (id, courseId, overdue, over = {}) => ({
  id,
  name: `Событие ${id}`,
  module: "assign",
  course: `Курс ${courseId}`,
  courseId,
  due: overdue ? "2026-06-01T20:59:00.000Z" : "2026-10-30T20:59:00.000Z",
  overdue,
  actionable: !overdue,
  actionName: "Добавить ответ",
  url: null,
  ...over,
});

test("актуальные курсы отсекают только будущие дедлайны: просроченное — у любых курсов", () => {
  const ended = course(2, { enddate: "2026-06-30T00:00:00.000Z" });
  const picked = pickDeadlineEvents(
    [
      calEvent(1, 1, false),
      calEvent(2, 1, true),
      calEvent(3, 2, false),
      calEvent(4, 2, true),
      calEvent(5, 9, true),
      calEvent(6, null, true),
    ],
    [course(1), ended],
    NOW
  );
  // 3 — будущий дедлайн завершённого курса; 5 — курс не среди кандидатов; 6 — без курса.
  assert.deepEqual(
    picked.map((e) => e.id),
    [1, 2, 4]
  );
});

test("actionEventToItem: overdue-флаг Moodle, actionable в отбор не входит", () => {
  const it = actionEventToItem(
    calEvent(4, 2, true, { url: "https://edu.hse.ru/mod/assign/view.php?id=4" })
  );
  assert.equal(it.kind, "assignment");
  assert.equal(it.overdue, true);
  assert.equal(it.source, "lms_deadlines");
  assert.equal(Date.parse(it.when), Date.parse("2026-06-01T20:59:00.000Z"));
  assert.deepEqual(it.raw, { module: "assign", action: "Добавить ответ", actionable: false });
  const quiz = actionEventToItem(calEvent(5, 1, false, { module: "quiz", course: "" }));
  assert.equal(quiz.kind, "lms_activity");
  assert.equal("overdue" in quiz, false);
  assert.equal("course" in quiz, false);
  assert.equal("url" in quiz, false);
});

test("windowToItem: открытое окно — элемент, закрытое и прошедшее — null", () => {
  const row = (over = {}) => ({
    "#": "1",
    Период: "1 модуль",
    "Дата начала": "00:00 01.10.2026 по московскому времени",
    "Дата окончания": "23:59 31.10.2026 по московскому времени",
    Статус: "Анкета доступна",
    ...over,
  });
  const open = windowToItem(row(), NOW);
  assert.equal(open.kind, "elk_window");
  assert.equal(open.title, "Оценка курсов (СОП): 1 модуль");
  assert.equal(open.when, iso(2026, 10, 31, 23, 59));
  assert.equal(windowToItem(row({ Статус: "Анкета заполнена" }), NOW), null);
  assert.ok(windowToItem(row({ Статус: "Анкета не заполнена" }), NOW));
  assert.equal(
    windowToItem(row({ "Дата окончания": "23:59 20.10.2026 по московскому времени" }), NOW),
    null
  );
  const undated = windowToItem({ Период: "весна", Статус: "Анкета доступна" }, NOW);
  assert.equal(undated.when, null);
});
