import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const m = await import(new URL("../dist/services/lms/submissions/index.js", import.meta.url).href);
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
  sameFileSet,
  expectedManagerFiles,
  compareFiles,
  classifySubmitOutcome,
  classifyDeleteOutcome,
  prepareUpload,
} = m;
const { Refusal, sanitizeCommitError, sanitizeNavigationError } = await import(
  new URL("../dist/services/writes/errors.js", import.meta.url).href
);
const { classifyError } = await import(
  new URL("../dist/services/writes/runner.js", import.meta.url).href
);

const MIB = 1024 * 1024;
const NOW = new Date("2026-10-18T12:00:00Z");
const LIMITS_TEXT =
  "Ответ в виде файла\nМаксимальный размер новых файлов: 5 Мбайт, максимальное количество прикрепленных файлов: 20";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** Сырая страница статуса: строки таблицы, строки текста, кнопки, ссылки на файлы. */
function rawPage({
  status = "Ответы на задание еще не представлены",
  statusClasses = ["cell", "c1"],
  remaining,
  lastModified = "-",
  lines = [],
  buttons = [],
  noStatusRow = false,
} = {}) {
  const rows = [];
  if (!noStatusRow)
    rows.push({ label: "Состояние ответа на задание", text: status, classes: statusClasses });
  rows.push({
    label: "Состояние оценивания",
    text: "Не оценено",
    classes: ["submissionnotgraded"],
  });
  if (remaining !== undefined)
    rows.push({ label: "Оставшееся время", text: remaining, classes: [] });
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
    for (const word of forbidden)
      assert.ok(!err.message.includes(word), `в тексте ошибки не должно быть «${word}»`);
    return true;
  });
}

test("parseEditLimits: подпись формы правки из разведки", () => {
  assert.deepEqual(parseEditLimits(LIMITS_TEXT), { maxBytes: 5 * MIB, maxFiles: 20 });
  assert.deepEqual(
    parseEditLimits(
      "Максимальный размер новых файлов: 512 Мбайт, максимальное количество прикрепленных файлов: 1"
    ),
    { maxBytes: 512 * MIB, maxFiles: 1 }
  );
  assert.deepEqual(parseEditLimits("Максимальный размер новых файлов: 1,5 Мбайт"), {
    maxBytes: Math.floor(1.5 * MIB),
    maxFiles: null,
  });
  assert.deepEqual(parseEditLimits("Максимальный размер новых файлов: 100 Кбайт"), {
    maxBytes: 100 * 1024,
    maxFiles: null,
  });
  assert.deepEqual(parseEditLimits("ничего похожего"), { maxBytes: null, maxFiles: null });
  assert.deepEqual(parseEditLimits("Максимальный размер новых файлов: 5 попугаев"), {
    maxBytes: null,
    maxFiles: null,
  });
});

test("parseRuDateTime: дата Moodle по-русски, время МСК", () => {
  assert.equal(
    parseRuDateTime("среда, 1 октября 2026, 00:00")?.toISOString(),
    "2026-09-30T21:00:00.000Z"
  );
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
  const v = buildAssignmentView(
    rawPage({
      statusClasses: ["submissiondraft"],
      buttons: ["Редактировать ответ", "Отправить на оценку"],
    }),
    1,
    [],
    NOW
  );
  assert.equal(v.state, "draft");
  assert.equal(v.canFinalize, true);
});

test("buildAssignmentView: закрытая сдача — вне сайта, просрочено, ещё не открыто, иное", () => {
  const offsite = buildAssignmentView(
    rawPage({ status: "Ответ на задание должен быть представлен вне сайта" }),
    1,
    [],
    NOW
  );
  assert.equal(offsite.closed?.reason, "offsite");
  assert.equal(offsite.canAdd, false);

  const overdue = buildAssignmentView(
    rawPage({ remaining: "Задание просрочено на: 12 дн. 3 час." }),
    1,
    [],
    NOW
  );
  assert.equal(overdue.closed?.reason, "overdue");
  assert.match(overdue.closed.text, /просрочено на: 12 дн\./);

  const notOpen = buildAssignmentView(
    rawPage({
      lines: [
        "Открыто с: среда, 1 октября 2099, 00:00",
        "Срок сдачи: четверг, 15 октября 2099, 23:59",
      ],
    }),
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
    rawPage({
      lines: ["Открыто с: среда, 1 октября 2025, 00:00"],
      buttons: ["Добавить ответ на задание"],
    }),
    1,
    [],
    NOW
  );
  assert.equal(v.closed, null);
  assert.equal(v.dueText, null);
});

test("buildAssignmentView: незнакомый класс статуса или нет строки статуса — unknown", () => {
  assert.equal(
    buildAssignmentView(rawPage({ statusClasses: ["submissionstatusnew"] }), 1, [], NOW).state,
    "unknown"
  );
  assert.equal(buildAssignmentView(rawPage({ noStatusRow: true }), 1, [], NOW).state, "unknown");
});

test("buildEditFormInfo: только файл, лимиты, файлы менеджера", () => {
  const info = buildEditFormInfo({
    hasFileManager: true,
    hasTextEditor: false,
    text: LIMITS_TEXT,
    managerFiles: ["test.txt"],
  });
  assert.deepEqual(info, {
    fileOnly: true,
    maxBytes: 5 * MIB,
    maxFiles: 20,
    managerFiles: ["test.txt"],
  });
  assert.equal(
    buildEditFormInfo({ hasFileManager: false, hasTextEditor: false, text: "", managerFiles: [] })
      .fileOnly,
    false
  );
  assert.equal(
    buildEditFormInfo({ hasFileManager: true, hasTextEditor: true, text: "", managerFiles: [] })
      .fileOnly,
    false
  );
});

test("stateFingerprint: sha256 от {state, files}, не зависит от порядка файлов", () => {
  const f1 = { name: "a.txt", size: 5, sha256: SHA_A };
  const f2 = { name: "b.txt", size: 7, sha256: SHA_B };
  const base = stateFingerprint({ state: "submitted", files: [f1, f2] });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(stateFingerprint({ state: "submitted", files: [f2, f1] }), base);
  assert.notEqual(stateFingerprint({ state: "none", files: [f1, f2] }), base);
  assert.notEqual(stateFingerprint({ state: "submitted", files: [f1, { ...f2, size: 8 }] }), base);
  assert.notEqual(
    stateFingerprint({ state: "submitted", files: [f1, { ...f2, sha256: SHA_A }] }),
    base
  );
  assert.notEqual(stateFingerprint({ state: "submitted", files: [f1] }), base);
});

test("checkSubmitArgs: отказы до любого обращения к системе", () => {
  assertRefusal(
    () => checkSubmitArgs({ cmid: 1, mode: "draft", files: ["a.txt"], text: "x" }),
    /^онлайн-текст в v1 не поддерживается$/
  );
  assertRefusal(
    () => checkSubmitArgs({ cmid: 1, mode: "draft", files: ["a.txt"], text: "" }),
    /^онлайн-текст в v1 не поддерживается$/
  );
  assertRefusal(
    () => checkSubmitArgs({ cmid: 1, mode: "submit", files: [] }),
    /^отправка без файлов не поддерживается$/
  );
  assertRefusal(
    () => checkSubmitArgs({ cmid: 1, mode: "draft", files: [] }),
    /^отправка без файлов не поддерживается$/
  );
  assert.throws(() => checkSubmitArgs({ cmid: 0, mode: "draft", files: ["a.txt"] }), /cmid/);
  assert.throws(() => checkSubmitArgs({ cmid: 1.5, mode: "draft", files: ["a.txt"] }), /cmid/);
  assert.throws(() => checkSubmitArgs({ cmid: 1, mode: "final", files: ["a.txt"] }), /mode/);
  assert.doesNotThrow(() => checkSubmitArgs({ cmid: 1, mode: "submit", files: ["a.txt"] }));
});

test("planSubmission: замена одноимённого, добавление нового", () => {
  const v = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    files: [{ name: "a.txt", size: 5, sha256: SHA_A }],
  });
  const plan = planSubmission(v, form(), [outboxFile("a.txt", 12), outboxFile("b.txt", 3)]);
  assert.deepEqual(plan.replace, [{ name: "a.txt", size: 12, currentSize: 5 }]);
  assert.deepEqual(plan.add, [{ name: "b.txt", size: 3 }]);
  assert.equal(plan.total, 2);
});

test("planSubmission: имя — с диска (basename absPath), а не в написании модели", () => {
  const v = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    files: [{ name: "a.txt", size: 5, sha256: SHA_A }],
  });
  const plan = planSubmission(v, form({ maxFiles: 1 }), [outboxFile("A.TXT", 12, SHA_B, "a.txt")]);
  assert.deepEqual(plan.replace, [{ name: "a.txt", size: 12, currentSize: 5 }]);
  assert.equal(plan.total, 1);
});

test("planSubmission: отказы предусловий без имён файлов", () => {
  const files = [outboxFile("secret-report.pdf", 10)];
  const hide = ["secret-report"];
  assertRefusal(
    () => planSubmission(view({ state: "unknown" }), form(), files),
    /не распознано/,
    hide
  );
  for (const reason of ["offsite", "overdue", "not-open", "other"]) {
    assertRefusal(
      () =>
        planSubmission(
          view({ canAdd: false, closed: { reason, text: "текст страницы" } }),
          form(),
          files
        ),
      /./,
      [...hide, "текст страницы"]
    );
  }
  assertRefusal(
    () => planSubmission(view({ closed: { reason: "offsite", text: "x" } }), form(), files),
    /вне сайта/,
    hide
  );
  assertRefusal(
    () => planSubmission(view({ closed: { reason: "overdue", text: "x" } }), form(), files),
    /просрочено/,
    hide
  );
  assertRefusal(
    () => planSubmission(view({ closed: { reason: "not-open", text: "x" } }), form(), files),
    /не открыт/,
    hide
  );
  assertRefusal(
    () => planSubmission(view({ canAdd: false, canEdit: false }), form(), files),
    /^нельзя добавить или править ответ$/,
    hide
  );
  assertRefusal(
    () => planSubmission(view(), form({ fileOnly: false }), files),
    /только .*файл/,
    hide
  );
  assertRefusal(
    () =>
      planSubmission(
        view({
          canAdd: false,
          canEdit: true,
          state: "submitted",
          files: [{ name: "old.txt", size: 1, sha256: SHA_A }],
        }),
        form({ maxFiles: 1 }),
        files
      ),
    /не более 1/,
    [...hide, "old.txt"]
  );
  assertRefusal(() => planSubmission(view(), form({ maxBytes: 9 }), files), /№1/, hide);
  assertRefusal(
    () =>
      planSubmission(
        view({
          canEdit: true,
          state: "submitted",
          files: [{ name: "Secret-Report.pdf", size: 1, sha256: SHA_A }],
        }),
        form(),
        files
      ),
    /регистр/,
    [...hide, "Secret-Report"]
  );
});

test("planSubmission: лимиты неизвестны — проверку оставляем Moodle", () => {
  const plan = planSubmission(view(), form({ maxBytes: null, maxFiles: null }), [
    outboxFile("a.txt", 10 * MIB),
  ]);
  assert.equal(plan.total, 1);
});

test("checkDeletePreconditions: нужна кнопка «Удалить ответ» и представленный ответ", () => {
  assertRefusal(
    () => checkDeletePreconditions(view({ state: "submitted", canDelete: false })),
    /Удалить ответ/
  );
  assertRefusal(
    () => checkDeletePreconditions(view({ state: "none", canDelete: true })),
    /нечего удалять/
  );
  assertRefusal(
    () => checkDeletePreconditions(view({ state: "unknown", canDelete: true })),
    /не распознано/
  );
  assert.doesNotThrow(() =>
    checkDeletePreconditions(view({ state: "submitted", canDelete: true }))
  );
});

test("submitAdapter: цель, payload, описание; запись отказывает по аргументам до сети", async () => {
  const args = { cmid: 42, mode: "draft", files: ["A.TXT", "b.txt"] };
  const v = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    dueText: "срок",
    files: [{ name: "a.txt", size: 5, sha256: SHA_A }],
  });
  const observed = {
    view: v,
    form: form(),
    files: [outboxFile("A.TXT", 12, SHA_B, "a.txt"), outboxFile("b.txt", 3, SHA_A)],
  };

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
  assert.ok(
    warnings.includes(
      "сохранение может сразу отправить работу на оценку (у проверенных заданий отдельного шага нет)"
    )
  );
  assert.ok(warnings.includes("форма правки открывалась и не сохранялась"));
  assert.equal(preview.title, "Задание");
  assert.equal(preview.due, "срок");
  assert.equal(preview.state, "submitted");
  assert.deepEqual(preview.replace, [{ name: "a.txt", size: 12, currentSize: 5 }]);
  assert.deepEqual(preview.add, [{ name: "b.txt", size: 3 }]);

  let commits = 0;
  const ctx = { signal: new AbortController().signal, commitPoint: async () => void commits++ };
  await assert.rejects(
    () => submitAdapter.execute({ ...args, text: "x" }, observed, ctx),
    /^Error: онлайн-текст в v1 не поддерживается$/
  );
  await assert.rejects(() => submitAdapter.execute({ ...args, cmid: 0 }, observed, ctx), /cmid/);
  await assert.rejects(
    () => submitAdapter.verifyOnly({ ...args, files: [] }),
    /^Error: отправка без файлов не поддерживается$/
  );
  assert.equal(commits, 0);
});

test("submitAdapter.observe: отказ по аргументам до сети", async () => {
  await assert.rejects(
    () => submitAdapter.observe({ cmid: 42, mode: "draft", files: ["a.txt"], text: "x" }),
    /^Error: онлайн-текст в v1 не поддерживается$/
  );
  await assert.rejects(
    () => submitAdapter.observe({ cmid: 42, mode: "submit", files: [] }),
    /^Error: отправка без файлов не поддерживается$/
  );
});

test("deleteAdapter: цель, payload, описание; запись отказывает по аргументам до сети", async () => {
  const v = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    canDelete: true,
    files: [{ name: "a.txt", size: 5, sha256: SHA_A }],
  });
  const args = { cmid: 7 };
  assert.equal(deleteAdapter.targetOf(args), "assign:7");
  assert.deepEqual(deleteAdapter.payloadOf(args, { view: v }), {
    files: [],
    state: stateFingerprint(v),
  });
  const { preview, warnings } = deleteAdapter.describe(args, { view: v });
  assert.deepEqual(preview.files, [{ name: "a.txt", size: 5 }]);
  assert.equal(preview.state, "submitted");
  assert.ok(warnings.some((w) => /необратим/.test(w)));
  let commits = 0;
  const ctx = { signal: new AbortController().signal, commitPoint: async () => void commits++ };
  await assert.rejects(() => deleteAdapter.execute({ cmid: -1 }, { view: v }, ctx), /cmid/);
  await assert.rejects(() => deleteAdapter.verifyOnly({ cmid: 1.5 }), /cmid/);
  await assert.rejects(() => deleteAdapter.observe({ cmid: -1 }), /cmid/);
  assert.equal(commits, 0);
});

test("sameFileSet: множества имён без учёта регистра и с учётом повторов", () => {
  assert.equal(sameFileSet([], []), true);
  assert.equal(sameFileSet(["a.txt", "B.pdf"], ["b.pdf", "A.TXT"]), true);
  assert.equal(sameFileSet(["a.txt"], ["a.txt", "b.txt"]), false);
  assert.equal(sameFileSet(["a.txt", "Новая папка"], ["a.txt"]), false);
  assert.equal(sameFileSet(["a.txt", "A.txt"], ["a.txt", "b.txt"]), false);
  assert.equal(sameFileSet(["a (1).txt"], ["a.txt"]), false);
});

test("expectedManagerFiles: существующие ∪ новые, одноимённый заменяется", () => {
  assert.deepEqual(expectedManagerFiles([], ["a.txt"]), ["a.txt"]);
  assert.deepEqual(expectedManagerFiles(["a.txt", "b.txt"], ["A.TXT", "c.txt"]), [
    "a.txt",
    "b.txt",
    "c.txt",
  ]);
  assert.deepEqual(expectedManagerFiles(["a.txt"], []), ["a.txt"]);
});

test("compareFiles: имя на месте ровно один раз и sha256 совпал", () => {
  const actual = [
    { name: "a.txt", size: 5, sha256: SHA_A },
    { name: "b.txt", size: 3, sha256: SHA_B },
  ];
  assert.deepEqual(compareFiles([{ name: "a.txt", sha256: SHA_A }], actual), {
    namesMatch: true,
    contentMatch: true,
  });
  assert.deepEqual(compareFiles([{ name: "A.TXT", sha256: SHA_A }], actual), {
    namesMatch: true,
    contentMatch: true,
  });
  assert.deepEqual(compareFiles([{ name: "a.txt", sha256: SHA_B }], actual), {
    namesMatch: true,
    contentMatch: false,
  });
  assert.deepEqual(compareFiles([{ name: "c.txt", sha256: SHA_A }], actual), {
    namesMatch: false,
    contentMatch: false,
  });
  // Два файла, совпадающие по имени без учёта регистра, — неоднозначно.
  const twice = [...actual, { name: "A.txt", size: 5, sha256: SHA_A }];
  assert.deepEqual(compareFiles([{ name: "a.txt", sha256: SHA_A }], twice), {
    namesMatch: false,
    contentMatch: false,
  });
  assert.deepEqual(compareFiles([], actual), { namesMatch: true, contentMatch: true });
});

const SUBMITTED_ON_SAVE = /отправлена на оценку сразу при сохранении/;
const fileA = { name: "a.txt", size: 5, sha256: SHA_A };
const fileOld = { name: "a.txt", size: 3, sha256: SHA_B };

test("classifySubmitOutcome: draft → submitted подтверждается с предупреждением", () => {
  const after = view({ state: "submitted", canAdd: false, canEdit: true, files: [fileA] });
  const r = classifySubmitOutcome({
    mode: "draft",
    expected: [{ name: "a.txt", sha256: SHA_A }],
    after,
    expectedTotal: 1,
  });
  assert.equal(r.outcome, "confirmed");
  assert.equal(r.stage, "verified");
  assert.ok(r.warnings.some((w) => SUBMITTED_ON_SAVE.test(w)));
  assert.deepEqual(r.evidence, {
    state: "submitted",
    files: 1,
    namesMatch: true,
    contentMatch: true,
    errorShown: false,
  });

  const submit = classifySubmitOutcome({
    mode: "submit",
    expected: [{ name: "a.txt", sha256: SHA_A }],
    after,
  });
  assert.equal(submit.outcome, "confirmed");
  assert.ok(!submit.warnings.some((w) => SUBMITTED_ON_SAVE.test(w)));
});

test("classifySubmitOutcome: черновик — confirmed для draft, unknown/draft-saved для submit", () => {
  const after = view({ state: "draft", canAdd: false, canEdit: true, files: [fileA] });
  const draft = classifySubmitOutcome({
    mode: "draft",
    expected: [{ name: "a.txt", sha256: SHA_A }],
    after,
  });
  assert.equal(draft.outcome, "confirmed");
  assert.equal(draft.stage, "verified");
  const submit = classifySubmitOutcome({
    mode: "submit",
    expected: [{ name: "a.txt", sha256: SHA_A }],
    after,
  });
  assert.equal(submit.outcome, "unknown");
  assert.equal(submit.stage, "draft-saved");
});

test("classifySubmitOutcome: нераспознанное или пустое состояние — unknown даже при совпавших файлах", () => {
  for (const state of ["unknown", "none"]) {
    for (const mode of ["draft", "submit"]) {
      const r = classifySubmitOutcome({
        mode,
        expected: [{ name: "a.txt", sha256: SHA_A }],
        after: view({ state, files: [fileA] }),
      });
      assert.equal(r.outcome, "unknown", `${state}/${mode}`);
    }
  }
});

test("classifySubmitOutcome: расхождение файлов — не confirmed; rejected только при ошибке и неизменном состоянии", () => {
  const before = view({ state: "submitted", canAdd: false, canEdit: true, files: [fileOld] });
  const expected = [{ name: "a.txt", sha256: SHA_A }];
  // sha256 не совпал, ошибки нет.
  assert.equal(
    classifySubmitOutcome({ mode: "draft", expected, after: before, before }).outcome,
    "unknown"
  );
  // Явная ошибка Moodle и состояние прежнее.
  const rejected = classifySubmitOutcome({
    mode: "draft",
    expected,
    after: before,
    before,
    errorShown: true,
  });
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.evidence.errorShown, true);
  // Явная ошибка, но состояние изменилось.
  const changed = view({
    ...before,
    lastModified: "позже",
    files: [{ name: "a.txt", size: 4, sha256: "c".repeat(64) }],
  });
  assert.equal(
    classifySubmitOutcome({ mode: "draft", expected, after: changed, before, errorShown: true })
      .outcome,
    "unknown"
  );
  // Без «до» (проверка повтора) rejected не бывает.
  assert.equal(
    classifySubmitOutcome({ mode: "draft", expected, after: before, errorShown: true }).outcome,
    "unknown"
  );
  // Пропал существующий файл: присланный на месте, но файлов меньше ожидаемого.
  const after = view({ state: "submitted", files: [fileA] });
  assert.equal(
    classifySubmitOutcome({ mode: "submit", expected, after, expectedTotal: 2 }).outcome,
    "unknown"
  );
});

test("classifySubmitOutcome: evidence без имён файлов", () => {
  const after = view({
    state: "submitted",
    files: [{ name: "secret-report.pdf", size: 5, sha256: SHA_A }],
  });
  const r = classifySubmitOutcome({
    mode: "draft",
    expected: [{ name: "secret-report.pdf", sha256: SHA_A }],
    after,
  });
  assert.ok(!JSON.stringify(r).includes("secret-report"));
});

test("classifyDeleteOutcome: none + «Добавить ответ» → confirmed; rejected только с «до» и ошибкой", () => {
  const before = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    canDelete: true,
    files: [fileA],
  });
  const gone = view({ state: "none", canAdd: true, files: [] });
  const ok = classifyDeleteOutcome({ after: gone, before });
  assert.equal(ok.outcome, "confirmed");
  assert.equal(ok.stage, "verified");
  assert.deepEqual(ok.evidence, { state: "none", files: 0, canAdd: true, errorShown: false });
  assert.equal(classifyDeleteOutcome({ after: gone }).outcome, "confirmed");

  assert.equal(
    classifyDeleteOutcome({
      after: view({ state: "none", canAdd: false, closed: { reason: "other", text: "" } }),
      before,
    }).outcome,
    "unknown"
  );
  assert.equal(classifyDeleteOutcome({ after: before, before }).outcome, "unknown");
  assert.equal(
    classifyDeleteOutcome({ after: before, before, errorShown: true }).outcome,
    "rejected"
  );
  assert.equal(classifyDeleteOutcome({ after: before, errorShown: true }).outcome, "unknown");
  assert.equal(
    classifyDeleteOutcome({ after: view({ state: "unknown" }), before, errorShown: true }).outcome,
    "unknown"
  );
});

// --- prepareUpload: отправляются байты, покрытые токеном, а не путь ---

const UPLOAD_PREFIX = "hsemcp-upload-";
const uploadTmpDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(UPLOAD_PREFIX));
const sha256Of = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Временная папка «исходящих» с одним файлом; возвращает OutboxFile «как из observe». */
function withOutboxFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-upload-test-"));
  const absPath = path.join(dir, name);
  fs.writeFileSync(absPath, content);
  const file = { name, absPath, size: Buffer.byteLength(content), sha256: sha256Of(content) };
  return Promise.resolve(fn(file, absPath, dir)).finally(() =>
    fs.rmSync(dir, { recursive: true, force: true })
  );
}

async function assertUploadRefusal(promise, n, file, dir) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Refusal, "отказ модуля, а не ошибка ввода-вывода");
    assert.match(err.message, new RegExp(`файл №${n} изменился после сухого прогона`));
    for (const s of [path.basename(file.absPath), "secret-report", dir, os.tmpdir()]) {
      assert.ok(!err.message.includes(s), `в тексте ошибки не должно быть «${s}»: ${err.message}`);
    }
    return true;
  });
}

test("prepareUpload: совпало — буфер под именем с диска", async () => {
  await withOutboxFile("secret-report.pdf", "%PDF-1.4 test\n", async (file) => {
    const prepared = await prepareUpload(file, 1);
    try {
      assert.equal(typeof prepared.files, "object");
      assert.equal(prepared.files.name, "secret-report.pdf");
      assert.equal(prepared.files.mimeType, "application/pdf");
      assert.ok(Buffer.isBuffer(prepared.files.buffer));
      assert.equal(sha256Of(prepared.files.buffer), file.sha256);
    } finally {
      await prepared.cleanup();
    }
  });
});

test("prepareUpload: то же имя и размер, другое содержимое — отказ без имени и пути", async () => {
  await withOutboxFile("secret-report.pdf", "AAAA", async (file, absPath, dir) => {
    fs.writeFileSync(absPath, "BBBB");
    await assertUploadRefusal(prepareUpload(file, 2), 2, file, dir);
  });
});

test("prepareUpload: размер изменился — отказ", async () => {
  await withOutboxFile("secret-report.pdf", "AAAA", async (file, absPath, dir) => {
    fs.writeFileSync(absPath, "AAAAA");
    await assertUploadRefusal(prepareUpload(file, 3), 3, file, dir);
  });
});

test("prepareUpload: файла нет — отказ без имени и пути", async () => {
  await withOutboxFile("secret-report.pdf", "AAAA", async (file, absPath, dir) => {
    fs.rmSync(absPath);
    await assertUploadRefusal(prepareUpload(file, 1), 1, file, dir);
  });
});

test("prepareUpload: выше предела буфера — копия во временной папке, проверена и убрана", async () => {
  await withOutboxFile("secret-report.pdf", "large enough", async (file, _absPath, dir) => {
    const before = uploadTmpDirs().length;
    const prepared = await prepareUpload(file, 1, { maxBuffer: 4 });
    let copy;
    try {
      assert.equal(typeof prepared.files, "string");
      copy = prepared.files;
      assert.equal(path.basename(copy), "secret-report.pdf");
      assert.ok(!copy.startsWith(dir), "копия не в папке «исходящих»");
      assert.equal(sha256Of(fs.readFileSync(copy)), file.sha256);
    } finally {
      await prepared.cleanup();
    }
    assert.ok(!fs.existsSync(path.dirname(copy)), "временная папка удалена");
    assert.equal(uploadTmpDirs().length, before);
  });
});

test("prepareUpload: копия с изменённым содержимым — отказ и временная папка убрана", async () => {
  await withOutboxFile("secret-report.pdf", "AAAAAAAA", async (file, absPath, dir) => {
    fs.writeFileSync(absPath, "BBBBBBBB");
    const before = uploadTmpDirs().length;
    await assertUploadRefusal(prepareUpload(file, 4, { maxBuffer: 4 }), 4, file, dir);
    assert.equal(uploadTmpDirs().length, before);
  });
});

// Сообщения Playwright `page.goto` несут URL с query (id задания): в ответ тула им попадать нельзя.
const HOST = "edu.example.test";
const GOTO_URL = `https://${HOST}/mod/assign/view.php?id=4242&action=editsubmission`;
const LEAKS = ["?id=", "4242", "http", HOST, "editsubmission"];

function assertClean(err) {
  assert.ok(err instanceof Error);
  for (const s of LEAKS)
    assert.ok(!err.message.includes(s), `в тексте ошибки не должно быть «${s}»: ${err.message}`);
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

// --- H2: усиление разбора, проверок форм и проверки после сохранения ---

const { checkButtonForm } = m;
const SHA_C = "c".repeat(64);

test("buildAssignmentView: два класса статуса сразу (отправлено и черновик/новый) — unknown", () => {
  for (const second of ["submissiondraft", "submissionstatusdraft", "submissionstatusnew"]) {
    const v = buildAssignmentView(
      rawPage({
        statusClasses: ["submissionstatussubmitted", second, "cell"],
        buttons: ["Редактировать ответ"],
      }),
      1,
      [],
      NOW
    );
    assert.equal(v.state, "unknown", second);
  }
  assert.equal(
    buildAssignmentView(
      rawPage({ statusClasses: ["submissiondraft", "submissionstatusnew"] }),
      1,
      [],
      NOW
    ).state,
    "unknown"
  );
  assert.equal(
    buildAssignmentView(
      rawPage({ statusClasses: ["submissionstatussubmitted", "cell", "c1"] }),
      1,
      [],
      NOW
    ).state,
    "submitted"
  );
});

test("buildAssignmentView и planSubmission: одноимённые файлы ответа (вложенные папки) — не схлопываются, отказ", () => {
  const dup = [
    { name: "secret-report.pdf", size: 5, sha256: SHA_A },
    { name: "Secret-Report.PDF", size: 7, sha256: SHA_B },
  ];
  const v = buildAssignmentView(
    rawPage({ statusClasses: ["submissionstatussubmitted"], buttons: ["Редактировать ответ"] }),
    1,
    dup,
    NOW
  );
  assert.equal(v.state, "unknown");
  assertRefusal(
    () =>
      planSubmission(
        view({ state: "submitted", canAdd: false, canEdit: true, files: dup }),
        form(),
        [outboxFile("b.txt", 3)]
      ),
    /одинаков/,
    ["secret-report", "Secret-Report"]
  );
  assertRefusal(() => checkDeletePreconditions(v), /не распознано/);
});

test("planSubmission: присланный файл крупнее предела проверки (64 Мбайт) — отказ до записи", () => {
  const big = form({ maxBytes: 512 * MIB });
  const atLimit = planSubmission(view(), big, [outboxFile("secret-report.pdf", 64 * MIB)]);
  assert.equal(atLimit.total, 1);
  assert.equal(
    planSubmission(view(), form({ maxBytes: null }), [outboxFile("secret-report.pdf", 64 * MIB)])
      .total,
    1
  );
  assertRefusal(
    () =>
      planSubmission(view(), big, [
        outboxFile("a.txt", 3),
        outboxFile("secret-report.pdf", 64 * MIB + 1),
      ]),
    /^файл №2 больше 64 Мбайт: результат отправки нельзя будет проверить$/,
    ["secret-report", "outbox", "a.txt"]
  );
  assertRefusal(
    () =>
      planSubmission(view(), form({ maxBytes: null }), [
        outboxFile("secret-report.pdf", 64 * MIB + 1),
      ]),
    /^файл №1 больше 64 Мбайт: результат отправки нельзя будет проверить$/,
    ["secret-report", "outbox"]
  );
});

test("buildAssignmentView: «просрочено» при кнопке «Добавить ответ» — по-прежнему отказ (решение владельца не принято)", () => {
  const v = buildAssignmentView(
    rawPage({
      remaining: "Задание просрочено на: 1 дн. 2 час.",
      buttons: ["Добавить ответ на задание"],
    }),
    1,
    [],
    NOW
  );
  assert.equal(v.closed?.reason, "overdue");
  assert.equal(v.canAdd, true);
  assertRefusal(() => planSubmission(v, form(), [outboxFile("a.txt", 3)]), /просрочено/);
});

test("submitAdapter.describe: условные предупреждения — уже отправлено, перезапись, лимит неизвестен", () => {
  const base = [
    "сохранение может сразу отправить работу на оценку (у проверенных заданий отдельного шага нет)",
    "форма правки открывалась и не сохранялась",
  ];
  const args = { cmid: 42, mode: "draft", files: ["b.txt"] };
  const plain = submitAdapter.describe(args, {
    view: view(),
    form: form(),
    files: [outboxFile("b.txt", 3)],
  });
  assert.deepEqual(plain.warnings, base);
  assert.equal(plain.preview.action, "новый ответ");

  const submitted = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    files: [{ name: "a.txt", size: 5, sha256: SHA_A }],
  });
  const edit = submitAdapter.describe(args, {
    view: submitted,
    form: form(),
    files: [outboxFile("b.txt", 3)],
  });
  assert.equal(edit.warnings.length, 3);
  assert.ok(edit.warnings.some((w) => /уже отправлен на оценку/.test(w)));
  assert.equal(edit.preview.action, "правка ответа");

  const over = submitAdapter.describe(args, {
    view: submitted,
    form: form(),
    files: [outboxFile("a.txt", 3)],
  });
  assert.ok(over.warnings.some((w) => /одноимённые файлы ответа будут перезаписаны/.test(w)));

  for (const limits of [{ maxBytes: null }, { maxFiles: null }]) {
    const unknown = submitAdapter.describe(args, {
      view: view(),
      form: form(limits),
      files: [outboxFile("b.txt", 3)],
    });
    assert.deepEqual(unknown.warnings.slice(0, 2), base);
    assert.ok(
      unknown.warnings.some((w) => /лимит размера или числа файлов на форме не найден/.test(w))
    );
    assert.equal(unknown.warnings.length, 3);
  }
});

test("classifySubmitOutcome: нетронутые файлы ответа сверяются с «до» по sha256", () => {
  const sent = { name: "a.txt", size: 4, sha256: SHA_B };
  const keep = { name: "n.txt", size: 2, sha256: SHA_A };
  const before = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    lastModified: "вчера",
    files: [fileOld, keep],
  });
  const expected = [{ name: "a.txt", sha256: SHA_B }];
  const ok = classifySubmitOutcome({
    mode: "submit",
    expected,
    before,
    expectedTotal: 2,
    after: view({ ...before, lastModified: "сегодня", files: [sent, keep] }),
  });
  assert.equal(ok.outcome, "confirmed");
  assert.equal(ok.evidence.untouchedMatch, true);
  assert.equal(ok.evidence.lastModifiedChanged, true);

  // Нетронутый файл изменился.
  const changed = classifySubmitOutcome({
    mode: "submit",
    expected,
    before,
    expectedTotal: 2,
    after: view({ ...before, lastModified: "сегодня", files: [sent, { ...keep, sha256: SHA_C }] }),
  });
  assert.equal(changed.outcome, "unknown");
  assert.equal(changed.evidence.untouchedMatch, false);

  // Нетронутый файл пропал, вместо него другой (число совпало).
  const swapped = classifySubmitOutcome({
    mode: "submit",
    expected,
    before,
    expectedTotal: 2,
    after: view({ ...before, files: [sent, { ...keep, name: "x.txt" }] }),
  });
  assert.equal(swapped.outcome, "unknown");
  assert.equal(swapped.evidence.untouchedMatch, false);
  assert.ok(!JSON.stringify(swapped).includes("n.txt"));

  // Проверка повтора (без «до»): прежнее, более слабое сравнение и прежний вид evidence.
  const replay = classifySubmitOutcome({
    mode: "submit",
    expected,
    after: view({ ...before, files: [sent, { ...keep, sha256: SHA_C }] }),
  });
  assert.equal(replay.outcome, "confirmed");
  assert.equal("untouchedMatch" in replay.evidence, false);
});

test("classifySubmitOutcome: «Последнее изменение» — в evidence, но не единственный признак", () => {
  const before = view({
    state: "submitted",
    canAdd: false,
    canEdit: true,
    lastModified: "вчера",
    files: [fileOld],
  });
  const expected = [{ name: "a.txt", sha256: SHA_A }];
  // Время изменилось, а байты не те — не confirmed.
  const r = classifySubmitOutcome({
    mode: "submit",
    expected,
    before,
    after: view({ ...before, lastModified: "сегодня" }),
  });
  assert.equal(r.outcome, "unknown");
  assert.equal(r.evidence.lastModifiedChanged, true);
  // Байты совпали, время прежнее — подтверждено (время не обязательное условие), признак false.
  const same = classifySubmitOutcome({
    mode: "submit",
    expected,
    before,
    after: view({ ...before, files: [fileA] }),
  });
  assert.equal(same.outcome, "confirmed");
  assert.equal(same.evidence.lastModifiedChanged, false);
});

test("prepareUpload: сбой временной папки — отказ «не удалось подготовить» без пути", async () => {
  await withOutboxFile("secret-report.pdf", "large enough", async (file, _absPath, dir) => {
    const bogus = path.join(os.tmpdir(), "no-such-dir-h2", "deeper");
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = bogus;
    try {
      await assert.rejects(prepareUpload(file, 3, { maxBuffer: 4 }), (err) => {
        assert.ok(err instanceof Refusal);
        assert.match(err.message, /^не удалось подготовить файл №3 к отправке/);
        for (const s of [bogus, "no-such-dir-h2", dir, "secret-report"])
          assert.ok(!err.message.includes(s), err.message);
        return true;
      });
    } finally {
      for (const [k, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
    }
  });
});

test("prepareUpload: сбой копирования — «не удалось подготовить», а не «изменился»", async () => {
  await withOutboxFile("secret-report.pdf", "large enough", async (file, absPath, dir) => {
    fs.rmSync(absPath);
    const before = uploadTmpDirs().length;
    await assert.rejects(prepareUpload(file, 2, { maxBuffer: 4 }), (err) => {
      assert.ok(err instanceof Refusal);
      assert.match(err.message, /^не удалось подготовить файл №2 к отправке/);
      assert.doesNotMatch(err.message, /изменился/);
      for (const s of [dir, os.tmpdir(), "secret-report"])
        assert.ok(!err.message.includes(s), err.message);
      return true;
    });
    assert.equal(uploadTmpDirs().length, before);
  });
});

test("sanitizeCommitError: отказ точки невозврата — свой текст по классу, без путей; readPage его не переписывает", () => {
  const journal = new Error(
    "EISDIR: illegal operation on a directory, open 'C:\\Users\\x\\storage\\writes\\journal.json.1.tmp'"
  );
  const j = sanitizeCommitError(journal);
  assert.match(j.message, /журнал/);
  assert.doesNotMatch(j.message, /не удалось открыть или прочитать/);
  for (const s of ["storage", "C:\\", "journal.json", "EISDIR"])
    assert.ok(!j.message.includes(s), j.message);
  assert.equal(classifyError(j), "other");
  assert.equal(sanitizeNavigationError(j), j);

  const deadline = sanitizeCommitError(
    new Error("writes.lms_submit_assignment не уложился в 45 с")
  );
  assert.equal(classifyError(deadline), "timeout");
  const abort = sanitizeCommitError(new DOMException("aborted", "TimeoutError"));
  assert.equal(classifyError(abort), "timeout");
  assert.equal(abort.name, "TimeoutError");
  const cancelled = sanitizeCommitError(new Error("операция отменена"));
  assert.equal(classifyError(cancelled), "cancelled");
  assert.equal(sanitizeNavigationError(cancelled), cancelled);

  const done = sanitizeCommitError(
    new Error("writes.x: вызов уже завершён, точка невозврата недоступна")
  );
  assert.match(done.message, /точка невозврата недоступна/);
  assert.doesNotMatch(done.message, /журнал/);
  assert.equal(classifyError(done), "other");
});

/** Форма кнопки «как из страницы»: метод, путь адреса, скрытые поля. */
function buttonForm(method, fields, over = {}) {
  return {
    hasForm: true,
    method,
    actionPath: "/mod/assign/view.php",
    fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
    ...over,
  };
}
const SAVE_FIELDS = {
  lastmodified: "1",
  id: "42",
  userid: "9",
  action: "savesubmission",
  _qf__mod_assign_submission_form: "1",
  files_filemanager: "123",
  sesskey: "k",
};
const DELETE_FIELDS = { id: "42", action: "removesubmissionconfirm" };
const CONTINUE_FIELDS = { id: "42", action: "removesubmission", userid: "9", sesskey: "k" };
const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

test("checkButtonForm: «Сохранить» — POST на view.php, id = cmid, поля формы правки из §17", () => {
  assert.doesNotThrow(() => checkButtonForm(buttonForm("post", SAVE_FIELDS), "save", 42));
  const dupId = buttonForm("post", SAVE_FIELDS);
  dupId.fields.push({ name: "id", value: "42" });
  const bad = [
    buttonForm("get", SAVE_FIELDS),
    buttonForm("post", SAVE_FIELDS, { actionPath: "/mod/assign/other.php" }),
    buttonForm("post", SAVE_FIELDS, { actionPath: null }),
    buttonForm("post", SAVE_FIELDS, { hasForm: false }),
    buttonForm("post", { ...SAVE_FIELDS, id: "43" }),
    buttonForm("post", { ...SAVE_FIELDS, action: "" }),
    buttonForm("post", without(SAVE_FIELDS, "files_filemanager")),
    buttonForm("post", without(SAVE_FIELDS, "_qf__mod_assign_submission_form")),
    buttonForm("post", without(SAVE_FIELDS, "id")),
    dupId,
  ];
  for (const raw of bad)
    assertRefusal(() => checkButtonForm(raw, "save", 42), /Сохранить.*до отправки/, [
      "42",
      "43",
      "savesubmission",
    ]);
});

test("checkButtonForm: «Удалить ответ» — GET на removesubmissionconfirm; «Продолжить» — POST с полями §17", () => {
  assert.doesNotThrow(() => checkButtonForm(buttonForm("get", DELETE_FIELDS), "delete", 42));
  for (const raw of [
    buttonForm("post", DELETE_FIELDS),
    buttonForm("get", { ...DELETE_FIELDS, action: "removesubmission" }),
    buttonForm("get", { ...DELETE_FIELDS, id: "7" }),
    buttonForm("get", { id: "42" }),
  ]) {
    assertRefusal(() => checkButtonForm(raw, "delete", 42), /Удалить ответ/, [
      "42",
      "removesubmission",
    ]);
  }
  assert.doesNotThrow(() => checkButtonForm(buttonForm("post", CONTINUE_FIELDS), "continue", 42));
  for (const raw of [
    buttonForm("get", CONTINUE_FIELDS),
    buttonForm("post", without(CONTINUE_FIELDS, "sesskey")),
    buttonForm("post", without(CONTINUE_FIELDS, "userid")),
    buttonForm("post", { ...CONTINUE_FIELDS, id: "7" }),
    buttonForm("post", CONTINUE_FIELDS, { actionPath: "/login/logout.php" }),
  ]) {
    assertRefusal(() => checkButtonForm(raw, "continue", 42), /Продолжить/, ["42", "sesskey"]);
  }
});

test("submitAdapter.observe: файл крупнее предела проверки отклоняется до хеширования и до открытия страницы", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-outbox-big-"));
  const saved = process.env.HSE_OUTBOX_DIR;
  process.env.HSE_OUTBOX_DIR = dir;
  // Браузер не должен стартовать ни при каких условиях: запуск отклоняется и считается.
  const { chromium } = await import("playwright");
  const realLaunch = chromium.launch;
  let launches = 0;
  chromium.launch = async () => {
    launches++;
    throw new Error("запуск браузера отключён в тесте");
  };
  try {
    const fd = fs.openSync(path.join(dir, "big.bin"), "w");
    fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); // разреженный: байты не пишутся
    fs.closeSync(fd);
    const t0 = Date.now();
    await assert.rejects(
      () => submitAdapter.observe({ cmid: 1, mode: "draft", files: ["big.bin"] }),
      (err) =>
        /^Файл №1: размер больше допустимых \d+ байт$/.test(err.message) &&
        !err.message.includes("big.bin") &&
        !err.message.includes(dir)
    );
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(launches, 0, "страница не открывалась");
  } finally {
    chromium.launch = realLaunch;
    if (saved === undefined) delete process.env.HSE_OUTBOX_DIR;
    else process.env.HSE_OUTBOX_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
