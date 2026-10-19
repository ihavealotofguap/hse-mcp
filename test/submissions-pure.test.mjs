import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const m = await import(new URL("../dist/services/lms/submissions.js", import.meta.url).href);
const {
  buildAssignmentView,
  buildEditFormInfo,
  parseEditLimits,
  parseRuDateTime,
  stateFingerprint,
  checkSubmitArgs,
  planSubmission,
  checkDeletePreconditions,
  submitAdapter,
  deleteAdapter,
  sanitizeNavigationError,
  Refusal,
} = m;
const { classifyError } = await import(new URL("../dist/services/writes/runner.js", import.meta.url).href);

const MIB = 1024 * 1024;
const NOW = new Date("2026-10-18T12:00:00Z");
const LIMITS_TEXT =
  "Ответ в виде файла\nМаксимальный размер новых файлов: 5 Мбайт, максимальное количество прикрепленных файлов: 20";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** Сырая страница статуса: строки таблицы, строки текста, кнопки, ссылки на файлы. */
function rawPage({ status = "Ответы на задание еще не представлены", statusClasses = ["cell", "c1"], remaining, lastModified = "-", lines = [], buttons = [], noStatusRow = false } = {}) {
  const rows = [];
  if (!noStatusRow) rows.push({ label: "Состояние ответа на задание", text: status, classes: statusClasses });
  rows.push({ label: "Состояние оценивания", text: "Не оценено", classes: ["submissionnotgraded"] });
  if (remaining !== undefined) rows.push({ label: "Оставшееся время", text: remaining, classes: [] });
  rows.push({ label: "Последнее изменение", text: lastModified, classes: [] });
  return { title: "Задание", rows, lines, buttons, fileLinks: [] };
}

function view(overrides = {}) {
  return {
    cmid: 42,
    title: "Задание",
    state: "none",
    closed: null,
    canAdd: true,
    canEdit: false,
    canDelete: false,
    canFinalize: false,
    dueText: null,
    lastModified: null,
    files: [],
    ...overrides,
  };
}

function form(overrides = {}) {
  return { fileOnly: true, maxBytes: 5 * MIB, maxFiles: 20, managerFiles: [], ...overrides };
}

/** Файл «исходящих»: имя модели может отличаться регистром от имени на диске (`absPath`). */
function outboxFile(name, size, sha256 = SHA_B, diskName = name) {
  return { name, absPath: path.join("outbox", diskName), size, sha256 };
}

/** Отказ с ожидаемым текстом и без имён файлов. */
function assertRefusal(fn, expected, forbidden = []) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, expected);
    for (const word of forbidden) assert.ok(!err.message.includes(word), `в тексте ошибки не должно быть «${word}»`);
    return true;
  });
}

test("parseEditLimits: подпись формы правки из разведки", () => {
  assert.deepEqual(parseEditLimits(LIMITS_TEXT), { maxBytes: 5 * MIB, maxFiles: 20 });
  assert.deepEqual(
    parseEditLimits("Максимальный размер новых файлов: 512 Мбайт, максимальное количество прикрепленных файлов: 1"),
    { maxBytes: 512 * MIB, maxFiles: 1 }
  );
  assert.deepEqual(parseEditLimits("Максимальный размер новых файлов: 1,5 Мбайт"), { maxBytes: Math.floor(1.5 * MIB), maxFiles: null });
  assert.deepEqual(parseEditLimits("Максимальный размер новых файлов: 100 Кбайт"), { maxBytes: 100 * 1024, maxFiles: null });
  assert.deepEqual(parseEditLimits("ничего похожего"), { maxBytes: null, maxFiles: null });
  assert.deepEqual(parseEditLimits("Максимальный размер новых файлов: 5 попугаев"), { maxBytes: null, maxFiles: null });
});

test("parseRuDateTime: дата Moodle по-русски, время МСК", () => {
  assert.equal(parseRuDateTime("среда, 1 октября 2026, 00:00")?.toISOString(), "2026-09-30T21:00:00.000Z");
  assert.equal(parseRuDateTime("15 марта 2027, 23:59")?.toISOString(), "2027-03-15T20:59:00.000Z");
  assert.equal(parseRuDateTime("1 октября 2026")?.toISOString(), "2026-09-30T21:00:00.000Z");
  assert.equal(parseRuDateTime("32 октября 2026, 00:00"), null);
  assert.equal(parseRuDateTime("завтра"), null);
});

test("buildAssignmentView: не сдано, есть «Добавить ответ на задание»", () => {
  const v = buildAssignmentView(rawPage({ buttons: ["Добавить ответ на задание"] }), 42, [], NOW);
  assert.equal(v.cmid, 42);
  assert.equal(v.state, "none");
  assert.equal(v.closed, null);
  assert.equal(v.canAdd, true);
  assert.equal(v.canEdit, false);
  assert.equal(v.lastModified, null);
});

test("buildAssignmentView: отправлено, «Редактировать ответ» и «Удалить ответ»", () => {
  const files = [{ name: "test.txt", size: 5, sha256: SHA_A }];
  const v = buildAssignmentView(
    rawPage({
      status: "Отправлено для оценивания",
      statusClasses: ["submissionstatussubmitted", "cell", "c1"],
      lastModified: "суббота, 18 октября 2026, 06:14",
      buttons: ["Редактировать ответ", "Удалить ответ"],
    }),
    42,
    files,
    NOW
  );
  assert.equal(v.state, "submitted");
  assert.equal(v.canAdd, false);
  assert.equal(v.canEdit, true);
  assert.equal(v.canDelete, true);
  assert.equal(v.canFinalize, false);
  assert.equal(v.closed, null);
  assert.equal(v.lastModified, "суббота, 18 октября 2026, 06:14");
  assert.deepEqual(v.files, files);
});

test("buildAssignmentView: «Отправить на оценку» → canFinalize", () => {
  const v = buildAssignmentView(rawPage({ statusClasses: ["submissiondraft"], buttons: ["Редактировать ответ", "Отправить на оценку"] }), 1, [], NOW);
  assert.equal(v.state, "draft");
  assert.equal(v.canFinalize, true);
});

test("buildAssignmentView: закрытая сдача — вне сайта, просрочено, ещё не открыто, иное", () => {
  const offsite = buildAssignmentView(rawPage({ status: "Ответ на задание должен быть представлен вне сайта" }), 1, [], NOW);
  assert.equal(offsite.closed?.reason, "offsite");
  assert.equal(offsite.canAdd, false);

  const overdue = buildAssignmentView(rawPage({ remaining: "Задание просрочено на: 12 дн. 3 час." }), 1, [], NOW);
  assert.equal(overdue.closed?.reason, "overdue");
  assert.match(overdue.closed.text, /просрочено на: 12 дн\./);

  const notOpen = buildAssignmentView(
    rawPage({ lines: ["Открыто с: среда, 1 октября 2099, 00:00", "Срок сдачи: четверг, 15 октября 2099, 23:59"] }),
    1,
    [],
    NOW
  );
  assert.equal(notOpen.closed?.reason, "not-open");
  assert.equal(notOpen.dueText, "четверг, 15 октября 2099, 23:59");

  const other = buildAssignmentView(rawPage(), 1, [], NOW);
  assert.equal(other.closed?.reason, "other");
});

test("buildAssignmentView: «Открыто с» в прошлом и кнопка на месте — сдача открыта", () => {
  const v = buildAssignmentView(
    rawPage({ lines: ["Открыто с: среда, 1 октября 2025, 00:00"], buttons: ["Добавить ответ на задание"] }),
    1,
    [],
    NOW
  );
  assert.equal(v.closed, null);
  assert.equal(v.dueText, null);
});

test("buildAssignmentView: незнакомый класс статуса или нет строки статуса — unknown", () => {
  assert.equal(buildAssignmentView(rawPage({ statusClasses: ["submissionstatusnew"] }), 1, [], NOW).state, "unknown");
  assert.equal(buildAssignmentView(rawPage({ noStatusRow: true }), 1, [], NOW).state, "unknown");
});

test("buildEditFormInfo: только файл, лимиты, файлы менеджера", () => {
  const info = buildEditFormInfo({ hasFileManager: true, hasTextEditor: false, text: LIMITS_TEXT, managerFiles: ["test.txt"] });
  assert.deepEqual(info, { fileOnly: true, maxBytes: 5 * MIB, maxFiles: 20, managerFiles: ["test.txt"] });
  assert.equal(buildEditFormInfo({ hasFileManager: false, hasTextEditor: false, text: "", managerFiles: [] }).fileOnly, false);
  assert.equal(buildEditFormInfo({ hasFileManager: true, hasTextEditor: true, text: "", managerFiles: [] }).fileOnly, false);
});

test("stateFingerprint: sha256 от {state, files}, не зависит от порядка файлов", () => {
  const f1 = { name: "a.txt", size: 5, sha256: SHA_A };
  const f2 = { name: "b.txt", size: 7, sha256: SHA_B };
  const base = stateFingerprint({ state: "submitted", files: [f1, f2] });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(stateFingerprint({ state: "submitted", files: [f2, f1] }), base);
  assert.notEqual(stateFingerprint({ state: "none", files: [f1, f2] }), base);
  assert.notEqual(stateFingerprint({ state: "submitted", files: [f1, { ...f2, size: 8 }] }), base);
  assert.notEqual(stateFingerprint({ state: "submitted", files: [f1, { ...f2, sha256: SHA_A }] }), base);
  assert.notEqual(stateFingerprint({ state: "submitted", files: [f1] }), base);
});

test("checkSubmitArgs: отказы до любого обращения к системе", () => {
  assertRefusal(() => checkSubmitArgs({ cmid: 1, mode: "draft", files: ["a.txt"], text: "x" }), /^онлайн-текст в v1 не поддерживается$/);
  assertRefusal(() => checkSubmitArgs({ cmid: 1, mode: "draft", files: ["a.txt"], text: "" }), /^онлайн-текст в v1 не поддерживается$/);
  assertRefusal(() => checkSubmitArgs({ cmid: 1, mode: "submit", files: [] }), /^отправка без файлов не поддерживается$/);
  assertRefusal(() => checkSubmitArgs({ cmid: 1, mode: "draft", files: [] }), /^отправка без файлов не поддерживается$/);
  assert.throws(() => checkSubmitArgs({ cmid: 0, mode: "draft", files: ["a.txt"] }), /cmid/);
  assert.throws(() => checkSubmitArgs({ cmid: 1.5, mode: "draft", files: ["a.txt"] }), /cmid/);
  assert.throws(() => checkSubmitArgs({ cmid: 1, mode: "final", files: ["a.txt"] }), /mode/);
  assert.doesNotThrow(() => checkSubmitArgs({ cmid: 1, mode: "submit", files: ["a.txt"] }));
});

test("planSubmission: замена одноимённого, добавление нового", () => {
  const v = view({ state: "submitted", canAdd: false, canEdit: true, files: [{ name: "a.txt", size: 5, sha256: SHA_A }] });
  const plan = planSubmission(v, form(), [outboxFile("a.txt", 12), outboxFile("b.txt", 3)]);
  assert.deepEqual(plan.replace, [{ name: "a.txt", size: 12, currentSize: 5 }]);
  assert.deepEqual(plan.add, [{ name: "b.txt", size: 3 }]);
  assert.equal(plan.total, 2);
});

test("planSubmission: имя — с диска (basename absPath), а не в написании модели", () => {
  const v = view({ state: "submitted", canAdd: false, canEdit: true, files: [{ name: "a.txt", size: 5, sha256: SHA_A }] });
  const plan = planSubmission(v, form({ maxFiles: 1 }), [outboxFile("A.TXT", 12, SHA_B, "a.txt")]);
  assert.deepEqual(plan.replace, [{ name: "a.txt", size: 12, currentSize: 5 }]);
  assert.equal(plan.total, 1);
});

test("planSubmission: отказы предусловий без имён файлов", () => {
  const files = [outboxFile("secret-report.pdf", 10)];
  const hide = ["secret-report"];
  assertRefusal(() => planSubmission(view({ state: "unknown" }), form(), files), /не распознано/, hide);
  for (const reason of ["offsite", "overdue", "not-open", "other"]) {
    assertRefusal(
      () => planSubmission(view({ canAdd: false, closed: { reason, text: "текст страницы" } }), form(), files),
      /./,
      [...hide, "текст страницы"]
    );
  }
  assertRefusal(() => planSubmission(view({ closed: { reason: "offsite", text: "x" } }), form(), files), /вне сайта/, hide);
  assertRefusal(() => planSubmission(view({ closed: { reason: "overdue", text: "x" } }), form(), files), /просрочено/, hide);
  assertRefusal(() => planSubmission(view({ closed: { reason: "not-open", text: "x" } }), form(), files), /не открыт/, hide);
  assertRefusal(() => planSubmission(view({ canAdd: false, canEdit: false }), form(), files), /^нельзя добавить или править ответ$/, hide);
  assertRefusal(() => planSubmission(view(), form({ fileOnly: false }), files), /только .*файл/, hide);
  assertRefusal(
    () => planSubmission(view({ canAdd: false, canEdit: true, state: "submitted", files: [{ name: "old.txt", size: 1, sha256: SHA_A }] }), form({ maxFiles: 1 }), files),
    /не более 1/,
    [...hide, "old.txt"]
  );
  assertRefusal(() => planSubmission(view(), form({ maxBytes: 9 }), files), /№1/, hide);
  assertRefusal(
    () => planSubmission(view({ canEdit: true, state: "submitted", files: [{ name: "Secret-Report.pdf", size: 1, sha256: SHA_A }] }), form(), files),
    /регистр/,
    [...hide, "Secret-Report"]
  );
});

test("planSubmission: лимиты неизвестны — проверку оставляем Moodle", () => {
  const plan = planSubmission(view(), form({ maxBytes: null, maxFiles: null }), [outboxFile("a.txt", 10 * MIB)]);
  assert.equal(plan.total, 1);
});

test("checkDeletePreconditions: нужна кнопка «Удалить ответ» и представленный ответ", () => {
  assertRefusal(() => checkDeletePreconditions(view({ state: "submitted", canDelete: false })), /Удалить ответ/);
  assertRefusal(() => checkDeletePreconditions(view({ state: "none", canDelete: true })), /нечего удалять/);
  assertRefusal(() => checkDeletePreconditions(view({ state: "unknown", canDelete: true })), /не распознано/);
  assert.doesNotThrow(() => checkDeletePreconditions(view({ state: "submitted", canDelete: true })));
});

test("submitAdapter: цель, payload, описание; запись ещё не реализована", async () => {
  const args = { cmid: 42, mode: "draft", files: ["A.TXT", "b.txt"] };
  const v = view({ state: "submitted", canAdd: false, canEdit: true, dueText: "срок", files: [{ name: "a.txt", size: 5, sha256: SHA_A }] });
  const observed = { view: v, form: form(), files: [outboxFile("A.TXT", 12, SHA_B, "a.txt"), outboxFile("b.txt", 3, SHA_A)] };

  assert.equal(submitAdapter.targetOf(args), "assign:42");
  assert.notEqual(submitAdapter.op, deleteAdapter.op);

  const payload = submitAdapter.payloadOf(args, observed);
  assert.deepEqual(payload, {
    mode: "draft",
    files: [
      { name: "a.txt", sha256: SHA_B },
      { name: "b.txt", sha256: SHA_A },
    ],
    state: stateFingerprint(v),
  });

  const { preview, warnings } = submitAdapter.describe(args, observed);
  assert.ok(warnings.includes("сохранение может сразу отправить работу на оценку (у проверенных заданий отдельного шага нет)"));
  assert.ok(warnings.includes("форма правки открывалась и не сохранялась"));
  assert.equal(preview.title, "Задание");
  assert.equal(preview.due, "срок");
  assert.equal(preview.state, "submitted");
  assert.deepEqual(preview.replace, [{ name: "a.txt", size: 12, currentSize: 5 }]);
  assert.deepEqual(preview.add, [{ name: "b.txt", size: 3 }]);

  await assert.rejects(() => submitAdapter.execute(args, observed, { signal: new AbortController().signal, commitPoint: async () => {} }), /не реализовано/);
  await assert.rejects(() => submitAdapter.verifyOnly(args), /не реализовано/);
});

test("submitAdapter.observe: отказ по аргументам до сети", async () => {
  await assert.rejects(() => submitAdapter.observe({ cmid: 42, mode: "draft", files: ["a.txt"], text: "x" }), /^Error: онлайн-текст в v1 не поддерживается$/);
  await assert.rejects(() => submitAdapter.observe({ cmid: 42, mode: "submit", files: [] }), /^Error: отправка без файлов не поддерживается$/);
});

test("deleteAdapter: цель, payload, описание; запись ещё не реализована", async () => {
  const v = view({ state: "submitted", canAdd: false, canEdit: true, canDelete: true, files: [{ name: "a.txt", size: 5, sha256: SHA_A }] });
  const args = { cmid: 7 };
  assert.equal(deleteAdapter.targetOf(args), "assign:7");
  assert.deepEqual(deleteAdapter.payloadOf(args, { view: v }), { files: [], state: stateFingerprint(v) });
  const { preview, warnings } = deleteAdapter.describe(args, { view: v });
  assert.deepEqual(preview.files, [{ name: "a.txt", size: 5 }]);
  assert.equal(preview.state, "submitted");
  assert.ok(warnings.some((w) => /необратим/.test(w)));
  await assert.rejects(() => deleteAdapter.execute(args, { view: v }, { signal: new AbortController().signal, commitPoint: async () => {} }), /не реализовано/);
  await assert.rejects(() => deleteAdapter.verifyOnly(args), /не реализовано/);
  await assert.rejects(() => deleteAdapter.observe({ cmid: -1 }), /cmid/);
});

// Сообщения Playwright `page.goto` несут URL с query (id задания): в ответ тула им попадать нельзя.
const HOST = "edu.example.test";
const GOTO_URL = `https://${HOST}/mod/assign/view.php?id=4242&action=editsubmission`;
const LEAKS = ["?id=", "4242", "http", HOST, "editsubmission"];

function assertClean(err) {
  assert.ok(err instanceof Error);
  for (const s of LEAKS) assert.ok(!err.message.includes(s), `в тексте ошибки не должно быть «${s}»: ${err.message}`);
}

function playwrightError(message, name = "Error") {
  const err = new Error(message);
  err.name = name;
  return err;
}

test("sanitizeNavigationError: сетевая ошибка goto — без URL, класс network", () => {
  const raw = playwrightError(
    `page.goto: net::ERR_NAME_NOT_RESOLVED at ${GOTO_URL}\nCall log:\n  - navigating to "${GOTO_URL}", waiting until "load"`
  );
  assert.equal(classifyError(raw), "network");
  const clean = sanitizeNavigationError(raw);
  assertClean(clean);
  assert.equal(classifyError(clean), "network");
  assert.match(clean.message, /ERR_NAME_NOT_RESOLVED/);
});

test("sanitizeNavigationError: таймаут goto и дедлайн withPage — без URL, класс timeout", () => {
  const gotoTimeout = playwrightError(
    `page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "${GOTO_URL}", waiting until "load"`,
    "TimeoutError"
  );
  const clean = sanitizeNavigationError(gotoTimeout);
  assertClean(clean);
  assert.equal(classifyError(clean), "timeout");

  const deadline = new Error(`${HOST}/mod/assign/view.php не уложилась в 45 с`);
  const cleanDeadline = sanitizeNavigationError(deadline);
  assertClean(cleanDeadline);
  assert.equal(classifyError(cleanDeadline), "timeout");

  const abort = new DOMException(`aborted at ${GOTO_URL}`, "AbortError");
  const cleanAbort = sanitizeNavigationError(abort);
  assertClean(cleanAbort);
  assert.equal(cleanAbort.name, "AbortError");
  assert.equal(classifyError(cleanAbort), "timeout");
});

test("sanitizeNavigationError: вход и отмена сохраняют класс, прочее — нейтральный текст", () => {
  const auth = sanitizeNavigationError(new Error(`HTTP 401 при открытии ${GOTO_URL}`));
  assertClean(auth);
  assert.equal(classifyError(auth), "auth");

  const cancelled = sanitizeNavigationError(new Error("операция отменена"));
  assertClean(cancelled);
  assert.equal(classifyError(cancelled), "cancelled");

  const other = sanitizeNavigationError(new Error(`page.evaluate: Target closed; url ${GOTO_URL}`));
  assertClean(other);
  assert.equal(classifyError(other), "other");
  assert.match(other.message, /страниц/);

  assertClean(sanitizeNavigationError(`строка ${GOTO_URL}`));
});

test("sanitizeNavigationError: собственные отказы модуля проходят без изменений", () => {
  const caught = [];
  for (const fn of [
    () => checkSubmitArgs({ cmid: 1, mode: "draft", files: ["a.txt"], text: "x" }),
    () => planSubmission(view({ canAdd: false, canEdit: false }), form(), []),
    () => checkDeletePreconditions(view({ state: "none" })),
  ]) {
    try {
      fn();
    } catch (err) {
      caught.push(err);
    }
  }
  assert.equal(caught.length, 3);
  for (const err of caught) {
    assert.ok(err instanceof Refusal);
    assert.equal(sanitizeNavigationError(err), err);
  }
  assert.equal(caught[0].message, "онлайн-текст в v1 не поддерживается");
});
