import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import(new URL("../dist/services/elk/certificate.js", import.meta.url).href);
const {
  normalizeLabel,
  needsExtraInput,
  checkCertificateArgs,
  buildCertificateForm,
  planCertificate,
  certificateFingerprint,
  claimNumbersOf,
  certificateAdapter,
  certificateTestSeams,
  classifyClaimsOutcome,
  expectedFieldValues,
  checkFormState,
} = m;
const { Refusal } = await import(new URL("../dist/services/lms/submissions.js", import.meta.url).href);

const FORMAT = ["Электронный документ", "Документ на бумажном носителе"];
const ORG = ["По месту требования", "Полное наименование организации (указать в дополнительном поле)"];

/** Сырой снимок формы: два автозаполненных поля и два обязательных пустых списка (спека §17). */
function rawForm(overrides = {}) {
  return {
    title: "Справка",
    items: [
      { label: "Образовательная программа", requiredMark: false, kind: "input", disabled: true, value: "Программа", options: null },
      { label: "Факультет", requiredMark: false, kind: "select", disabled: true, value: "Факультет", options: null },
      { label: "Формат получения*", requiredMark: true, kind: "select", disabled: false, value: "", options: FORMAT },
      { label: "Наименование организации *", requiredMark: true, kind: "select", disabled: false, value: "", options: ORG },
    ],
    submitButtons: 1,
    submitDisabled: true,
    requiredLeft: [2],
    ...overrides,
  };
}

const refuses = (fn, re) =>
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Refusal, `ожидался Refusal, получено ${err?.constructor?.name}: ${err?.message}`);
    assert.match(err.message, re);
    return true;
  });

const FULL = { "Формат получения": FORMAT[0], "Наименование организации": ORG[0] };

test("normalizeLabel: звёздочка, двоеточие и пробелы снимаются", () => {
  assert.equal(normalizeLabel("Формат получения*"), "Формат получения");
  assert.equal(normalizeLabel("  * Наименование   организации : "), "Наименование организации");
  assert.equal(normalizeLabel("Курс"), "Курс");
  assert.equal(normalizeLabel("*"), "");
});

test("checkCertificateArgs: serviceId и fields проверяются до обращения к системе", () => {
  checkCertificateArgs({ serviceId: 14605, fields: FULL });
  checkCertificateArgs({ serviceId: 1, fields: {} });
  for (const serviceId of [0, -1, 1.5, Number.NaN, "14605", undefined, 2 ** 60]) {
    refuses(() => checkCertificateArgs({ serviceId, fields: {} }), /serviceId/);
  }
  for (const fields of [null, undefined, [], "x", 5]) refuses(() => checkCertificateArgs({ serviceId: 1, fields }), /fields/);
  refuses(() => checkCertificateArgs({ serviceId: 1, fields: { "Формат получения": 5 } }), /значение/);
  refuses(() => checkCertificateArgs({ serviceId: 1, fields: { "Формат получения": "  " } }), /значение/);
  refuses(() => checkCertificateArgs({ serviceId: 1, fields: { "*": "x" } }), /подпись/);
  // Две подписи, совпадающие после нормализации, — неоднозначно.
  refuses(() => checkCertificateArgs({ serviceId: 1, fields: { "Формат получения": FORMAT[0], "Формат получения*": FORMAT[1] } }), /повтор/);
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`Поле ${i}`, "x"]));
  refuses(() => checkCertificateArgs({ serviceId: 1, fields: many }), /слишком много/);
});

test("buildCertificateForm: поля, обязательность, варианты, активность «Отправить»", () => {
  const form = buildCertificateForm(rawForm());
  assert.equal(form.title, "Справка");
  assert.equal(form.submitDisabled, true);
  assert.equal(form.requiredLeft, 2);
  assert.deepEqual(
    form.fields.map((f) => [f.label, f.required, f.kind, f.disabled, f.value, f.options]),
    [
      ["Образовательная программа", false, "input", true, "Программа", []],
      ["Факультет", false, "select", true, "Факультет", []],
      ["Формат получения", true, "select", false, "", FORMAT],
      ["Наименование организации", true, "select", false, "", ORG],
    ]
  );
  // Звёздочка в подписи без признака requiredMark — тоже обязательное поле.
  const items = rawForm().items.map((it) => (it.label.startsWith("Формат") ? { ...it, requiredMark: false } : it));
  assert.equal(buildCertificateForm(rawForm({ items })).fields[2].required, true);
  // Варианты не прочитаны (проверка структуры до раскрытия списков) — пустой список.
  const noOptions = rawForm({ items: rawForm().items.map((it) => ({ ...it, options: null })) });
  assert.deepEqual(buildCertificateForm(noOptions).fields[2].options, []);
  // Индикатора нет — requiredLeft null.
  assert.equal(buildCertificateForm(rawForm({ requiredLeft: [] })).requiredLeft, null);
});

test("buildCertificateForm: неожиданная форма — отказ, а не догадка", () => {
  refuses(() => buildCertificateForm(rawForm({ items: [] })), /полей формы/);
  refuses(() => buildCertificateForm(rawForm({ submitButtons: 0 })), /«Отправить».*ровно одна.*0/);
  refuses(() => buildCertificateForm(rawForm({ submitButtons: 2 })), /«Отправить».*ровно одна.*2/);
  const withItem = (it) => rawForm({ items: [...rawForm().items, it] });
  refuses(() => buildCertificateForm(withItem({ label: "Дата", requiredMark: false, kind: "unknown", disabled: false, value: "", options: null })), /поле №5: тип поля не поддерживается/);
  refuses(() => buildCertificateForm(withItem({ label: "  ", requiredMark: false, kind: "input", disabled: false, value: "", options: null })), /поле №5: подпись не найдена/);
  refuses(() => buildCertificateForm(withItem({ label: "Факультет:", requiredMark: false, kind: "input", disabled: true, value: "x", options: null })), /подписи полей.*повторяются.*№2.*№5/);
  // Индикатор формы не сходится с распознанными обязательными пустыми полями.
  refuses(() => buildCertificateForm(rawForm({ requiredLeft: [3] })), /обязательн.*не распознан/);
  refuses(() => buildCertificateForm(rawForm({ requiredLeft: [2, 1] })), /индикатор/);
  // В тексте отказа нет значений полей.
  try {
    buildCertificateForm(withItem({ label: "Факультет", requiredMark: false, kind: "input", disabled: true, value: "Секрет", options: null }));
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.ok(!err.message.includes("Секрет") && !err.message.includes("Факультет"));
  }
});

test("planCertificate: выбранные значения, автозаполнение, незаполненные обязательные", () => {
  const form = buildCertificateForm(rawForm());
  const plan = planCertificate(form, { "Формат получения*": ` ${FORMAT[1]} `, "Наименование организации": ORG[0] });
  assert.deepEqual(plan.chosen, [
    { label: "Формат получения", value: FORMAT[1], current: "" },
    { label: "Наименование организации", value: ORG[0], current: "" },
  ]);
  assert.deepEqual(plan.autofilled, [
    { label: "Образовательная программа", value: "Программа" },
    { label: "Факультет", value: "Факультет" },
  ]);
  assert.deepEqual(plan.requiredEmpty, ["Формат получения", "Наименование организации"]);
});

test("planCertificate: предусловия — все обязательные заданы вариантами, лишних подписей нет", () => {
  const form = buildCertificateForm(rawForm());
  try {
    planCertificate(form, { "Формат получения": FORMAT[0] });
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.ok(err instanceof Refusal);
    assert.match(err.message, /не заданы обязательные поля: «Наименование организации»/);
    assert.ok(!err.message.includes("«Формат получения»"));
  }
  refuses(() => planCertificate(form, {}), /«Формат получения», «Наименование организации»/);
  refuses(() => planCertificate(form, { ...FULL, "Формат получения": "Факс" }), /«Формат получения»: значения нет среди вариантов/);
  refuses(() => planCertificate(form, { ...FULL, Паспорт: "1" }), /неизвестные поля формы: «Паспорт»/);
  refuses(() => planCertificate(form, { ...FULL, "Образовательная программа": "Программа" }), /заполняется автоматически/);
  refuses(() => planCertificate(form, { ...FULL, Факультет: "Факультет" }), /заполняется автоматически/);
  // Поле-ввод, доступное для правки: в v1 заполняются только выпадающие списки.
  const withInput = buildCertificateForm(
    rawForm({ items: [...rawForm().items, { label: "Комментарий", requiredMark: false, kind: "input", disabled: false, value: "", options: null }] })
  );
  refuses(() => planCertificate(withInput, { ...FULL, Комментарий: "x" }), /только выпадающие списки/);
  // Обязательное поле-ввод без значения — недостающее, задать его нельзя.
  const reqInput = buildCertificateForm(
    rawForm({ requiredLeft: [3], items: [...rawForm().items, { label: "Телефон*", requiredMark: true, kind: "input", disabled: false, value: "", options: null }] })
  );
  refuses(() => planCertificate(reqInput, FULL), /не заданы обязательные поля: «Телефон»/);
  // Повтор варианта в списке — неоднозначно.
  const dupOpt = buildCertificateForm(
    rawForm({ items: rawForm().items.map((it) => (it.label.startsWith("Формат") ? { ...it, options: [FORMAT[0], FORMAT[0]] } : it)) })
  );
  refuses(() => planCertificate(dupOpt, FULL), /вариант.*повторяется/);
});

test("needsExtraInput: вариант, отсылающий к дополнительному полю, распознаётся без учёта регистра", () => {
  assert.equal(needsExtraInput(ORG[1]), true);
  assert.equal(needsExtraInput("Иное (УКАЗАТЬ В ДОПОЛНИТЕЛЬНОМ ПОЛЕ)"), true);
  assert.equal(needsExtraInput(ORG[0]), false);
  assert.equal(needsExtraInput(FORMAT[0]), false);
  assert.equal(needsExtraInput("Дополнительное соглашение"), false);
});

test("planCertificate: вариант, требующий дополнительного поля, — отказ (v1 не заполняет текстовые поля)", () => {
  const form = buildCertificateForm(rawForm());
  try {
    planCertificate(form, { ...FULL, "Наименование организации": ORG[1] });
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.ok(err instanceof Refusal);
    assert.match(err.message, /^поле №4: выбранный вариант требует заполнить дополнительное поле/);
    // Ни подписи, ни текста варианта в отказе нет.
    assert.ok(!err.message.includes("Наименование") && !err.message.includes("Полное наименование"));
  }
  // Обычный вариант того же списка принимается.
  assert.deepEqual(planCertificate(form, FULL).chosen.map((c) => c.value), [FORMAT[0], ORG[0]]);
  // Такой вариант, уже выбранный самой формой и не заданный в fields, — тоже отказ: дополнительное поле не видно.
  const items = rawForm().items.map((it) => (it.label.startsWith("Наименование") ? { ...it, value: ORG[1] } : it));
  const prefilled = buildCertificateForm(rawForm({ items, requiredLeft: [1] }));
  refuses(() => planCertificate(prefilled, { "Формат получения": FORMAT[0] }), /^поле №4: выбранный вариант требует заполнить дополнительное поле/);
  // Переопределение обычным вариантом снимает отказ.
  assert.equal(planCertificate(prefilled, FULL).chosen.length, 2);
});

test("planCertificate: обязательное поле уже заполнено формой — можно не задавать", () => {
  const items = rawForm().items.map((it) => (it.requiredMark ? { ...it, value: it.options[0] } : it));
  const form = buildCertificateForm(rawForm({ items, requiredLeft: [], submitDisabled: false }));
  const plan = planCertificate(form, {});
  assert.deepEqual(plan.chosen, []);
  assert.deepEqual(plan.requiredEmpty, []);
  assert.equal(plan.autofilled.length, 4);
  // Переопределение заполненного значения другим вариантом — разрешено и видно как current.
  assert.deepEqual(planCertificate(form, { "Формат получения": FORMAT[1] }).chosen, [{ label: "Формат получения", value: FORMAT[1], current: FORMAT[0] }]);
});

test("certificateFingerprint: множество номеров и выбранные значения", () => {
  const base = { claimNumbers: ["A-2", "A-1"], chosen: [{ label: "X", value: "1" }], autofilled: [{ label: "P", value: "p" }] };
  const fp = certificateFingerprint(base);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(certificateFingerprint({ ...base, claimNumbers: ["A-1", "A-2", "A-1"] }), fp, "порядок и повторы номеров не важны");
  assert.notEqual(certificateFingerprint({ ...base, claimNumbers: ["A-1", "A-2", "A-3"] }), fp, "новая заявка");
  assert.notEqual(certificateFingerprint({ ...base, claimNumbers: [] }), fp);
  assert.notEqual(certificateFingerprint({ ...base, chosen: [{ label: "X", value: "2" }] }), fp, "другой вариант");
  assert.notEqual(certificateFingerprint({ ...base, autofilled: [{ label: "P", value: "q" }] }), fp, "другое автозаполнение");
  const two = [{ label: "X", value: "1" }, { label: "Y", value: "2" }];
  assert.equal(certificateFingerprint({ ...base, chosen: two }), certificateFingerprint({ ...base, chosen: [...two].reverse() }), "порядок полей не важен");
  // Склейка не даёт совпадений: «A» + «B-C» ≠ «A-B» + «C».
  assert.notEqual(certificateFingerprint({ ...base, claimNumbers: ["A", "B-C"] }), certificateFingerprint({ ...base, claimNumbers: ["A-B", "C"] }));
});

test("claimNumbersOf: номера заявок из ответа listRequests, нераспознанный номер — отказ", () => {
  assert.deepEqual(claimNumbersOf({ count: 2, requests: [{ num: "B-2" }, { num: " A-1 " }] }), ["A-1", "B-2"]);
  assert.deepEqual(claimNumbersOf({ count: 0, requests: [] }), []);
  refuses(() => claimNumbersOf({ count: 1, requests: [{ num: "" }] }), /номер заявки/);
  refuses(() => claimNumbersOf({ count: 1, requests: [{}] }), /номер заявки/);
  refuses(() => claimNumbersOf({ count: 1 }), /истори/);
});

test("certificateAdapter: цель, операция, сброс заявок; неверные аргументы записи — отказ до точки невозврата", async () => {
  assert.equal(certificateAdapter.op, "elk_order_certificate");
  assert.equal(certificateAdapter.targetOf({ serviceId: 14605, fields: {} }), "service:14605");
  assert.deepEqual(certificateAdapter.invalidates, ["elk.claims"]);
  assert.equal(certificateAdapter.commitDeadlineMs, undefined, "дедлайн коммита — значение раннера по умолчанию");
  // Неверные аргументы — отказ до любого обращения к странице и к истории заявок.
  await assert.rejects(() => certificateAdapter.observe({ serviceId: 0, fields: {} }), /serviceId/);
  let commits = 0;
  await assert.rejects(
    () => certificateAdapter.execute({ serviceId: 0, fields: {} }, {}, { signal: new AbortController().signal, commitPoint: async () => void commits++ }),
    (err) => err instanceof Refusal && /serviceId/.test(err.message)
  );
  assert.equal(commits, 0);
});

const W_MANUAL = /сверьте вручную через elk_list_requests/;

test("classifyClaimsOutcome: ровно один новый номер — подтверждено, номер только в evidence", () => {
  const r = classifyClaimsOutcome(["A-1", "A-2"], ["A-3", "A-1", "A-2"]);
  assert.equal(r.outcome, "confirmed");
  assert.equal(r.evidence.newClaims, 1);
  assert.equal(r.evidence.newClaimNumber, "A-3");
  assert.deepEqual(r.warnings, []);
  // Порядок, повторы и пропавшие старые номера (список усечён) не мешают.
  const r2 = classifyClaimsOutcome(["A-1", "A-2", "A-0"], ["A-2", "A-9", "A-1", "A-9"]);
  assert.equal(r2.outcome, "confirmed");
  assert.equal(r2.evidence.newClaimNumber, "A-9");
});

test("classifyClaimsOutcome: ни одного нового — неизвестно; больше одного — неизвестно с предупреждением, без номеров", () => {
  const none = classifyClaimsOutcome(["A-1"], ["A-1"]);
  assert.equal(none.outcome, "unknown");
  assert.equal(none.evidence.newClaims, 0);
  assert.ok(!("newClaimNumber" in none.evidence));
  const fewer = classifyClaimsOutcome(["A-1", "A-2"], []);
  assert.equal(fewer.outcome, "unknown");
  const two = classifyClaimsOutcome(["A-1"], ["A-1", "B-1", "B-2"]);
  assert.equal(two.outcome, "unknown");
  assert.equal(two.evidence.newClaims, 2);
  assert.ok(two.warnings.some((w) => W_MANUAL.test(w)));
  assert.ok(!JSON.stringify(two).includes("B-1") && !JSON.stringify(two).includes("B-2"), "при неоднозначности номеров в ответе нет");
  // Исход проверки — никогда не «отклонено».
  for (const r of [none, fewer, two]) assert.notEqual(r.outcome, "rejected");
});

/** Снимок страницы формы (без вариантов) в состоянии после заполнения обоих обязательных списков. */
function snapshot(overrides = {}) {
  const raw = rawForm();
  return {
    items: raw.items.map(({ options: _o, ...it }) =>
      it.label.startsWith("Формат") ? { ...it, value: FORMAT[0] } : it.label.startsWith("Наименование") ? { ...it, value: ORG[0] } : it
    ),
    submitButtons: 1,
    submitDisabled: false,
    requiredLeft: [],
    ...overrides,
  };
}

test("expectedFieldValues: значения формы после заполнения — выбранные поверх прочитанных", () => {
  const form = buildCertificateForm(rawForm());
  const plan = planCertificate(form, FULL);
  assert.deepEqual(expectedFieldValues(form, plan), [
    { label: "Образовательная программа", value: "Программа" },
    { label: "Факультет", value: "Факультет" },
    { label: "Формат получения", value: FORMAT[0] },
    { label: "Наименование организации", value: ORG[0] },
  ]);
  // Без выбора — ровно прочитанные значения.
  assert.deepEqual(expectedFieldValues(form, { chosen: [], autofilled: [], requiredEmpty: [] }).map((f) => f.value), ["Программа", "Факультет", "", ""]);
});

test("checkFormState: заполненная форма, совпадающая с ожиданием, проходит", () => {
  const form = buildCertificateForm(rawForm());
  const expected = expectedFieldValues(form, planCertificate(form, FULL));
  checkFormState(expected, snapshot(), "filled");
  // Индикатор «(0)» допустим.
  checkFormState(expected, snapshot({ requiredLeft: [0] }), "filled");
  // До заполнения (страница только открыта): обязательные пусты, «Отправить» неактивна — это норма.
  const loaded = expectedFieldValues(form, { chosen: [], autofilled: [], requiredEmpty: [] });
  checkFormState(loaded, { ...snapshot(), items: rawForm().items.map(({ options: _o, ...it }) => it), submitDisabled: true, requiredLeft: [2] }, "loaded");
});

test("checkFormState: расхождение перед точкой невозврата — отказ без подписей и значений", () => {
  const form = buildCertificateForm(rawForm());
  const expected = expectedFieldValues(form, planCertificate(form, FULL));
  const base = snapshot();
  const extra = { label: "Полное наименование организации", requiredMark: true, kind: "input", disabled: false, value: "" };
  const cases = [
    [{ items: [...base.items, extra] }, /набор полей формы/, "новое поле после выбора"],
    [{ items: base.items.slice(0, 3) }, /набор полей формы/, "поле пропало"],
    [{ items: base.items.map((it, i) => (i === 0 ? { ...it, label: "Другая подпись" } : it)) }, /набор полей формы/, "подпись другая"],
    [{ items: [base.items[1], base.items[0], ...base.items.slice(2)] }, /набор полей формы/, "порядок другой"],
    [{ items: base.items.map((it, i) => (i === 2 ? { ...it, value: FORMAT[1] } : it)) }, /поле №3: значение/, "другой вариант"],
    [{ items: base.items.map((it, i) => (i === 3 ? { ...it, value: "" } : it)) }, /поле №4: значение/, "поле не заполнилось"],
    [{ items: base.items.map((it, i) => (i === 0 ? { ...it, value: "Секрет" } : it)) }, /поле №1: значение/, "автозаполнение изменилось"],
    [{ items: base.items.map((it, i) => (i === 1 ? { ...it, kind: "unknown" } : it)) }, /поле №2: тип поля/, "тип поля"],
    [{ requiredLeft: [1] }, /обязательных полей: 1/, "индикатор обязательных"],
    [{ requiredLeft: [0, 1] }, /обязательных полей/, "индикатор с разными числами"],
    [{ submitDisabled: true }, /«Отправить».*неактивна/, "кнопка неактивна"],
    [{ submitButtons: 2 }, /«Отправить».*ровно одна.*2/, "вторая «Отправить»"],
    [{ submitButtons: 0 }, /«Отправить».*ровно одна.*0/, "нет «Отправить»"],
  ];
  for (const [over, re, what] of cases) {
    try {
      checkFormState(expected, { ...base, ...over }, "filled");
      assert.fail(`ожидался отказ: ${what}`);
    } catch (err) {
      assert.ok(err instanceof Refusal, `${what}: ${err?.message}`);
      assert.match(err.message, re, what);
      assert.match(err.message, /до отправки/, `${what}: сказано, что ничего не отправлено`);
      for (const s of ["Секрет", "Программа", "Формат", "Наименование", "Полное", "Другая", FORMAT[0], FORMAT[1], ORG[0]]) {
        assert.ok(!err.message.includes(s), `${what}: в тексте нет «${s}»`);
      }
    }
  }
  // Обязательное поле пустое при отсутствии индикатора — тоже отказ.
  const emptyRequired = { label: "Телефон*", requiredMark: false, kind: "input", disabled: false, value: "" };
  const withPhone = [...expected, { label: "Телефон", value: "" }];
  refuses(() => checkFormState(withPhone, { ...base, items: [...base.items, emptyRequired] }, "filled"), /обязательн.*не заполнен/);
  // Итоговое значение требует дополнительного поля — отказ.
  const extraExpected = expected.map((f, i) => (i === 3 ? { ...f, value: ORG[1] } : f));
  const extraSnap = { ...base, items: base.items.map((it, i) => (i === 3 ? { ...it, value: ORG[1] } : it)) };
  refuses(() => checkFormState(extraExpected, extraSnap, "filled"), /поле №4: .*дополнительное поле/);
  // На только что открытой странице «Отправить» может быть неактивна, но не может быть двух.
  refuses(() => checkFormState(expected, { ...base, submitButtons: 2 }, "loaded"), /ровно одна/);
});

test("verifyOnly: только чтение, всегда «неизвестно» с предупреждением сверить вручную", async () => {
  const original = certificateTestSeams.listRequests;
  const calls = [];
  try {
    certificateTestSeams.listRequests = async (opts) => {
      calls.push(opts);
      return { count: 3, requests: [{ num: "Z-1" }, { num: "Z-2" }, { num: "Z-3" }] };
    };
    const r = await certificateAdapter.verifyOnly({ serviceId: 1, fields: {} });
    assert.equal(r.outcome, "unknown");
    assert.ok(r.warnings.some((w) => W_MANUAL.test(w)));
    assert.equal(r.evidence.requestsNow, 3);
    assert.ok(!JSON.stringify(r).includes("Z-"), "номеров заявок в ответе проверки нет");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxAgeMs, 0, "свежее чтение мимо кэша");
    // История не прочиталась — всё равно «неизвестно», без исключения и без текста ошибки.
    certificateTestSeams.listRequests = async () => {
      throw new Error("https://lk.hse.ru/api/claims?username=x 500");
    };
    const r2 = await certificateAdapter.verifyOnly({ serviceId: 1, fields: {} });
    assert.equal(r2.outcome, "unknown");
    assert.equal(r2.evidence.requestsNow, null);
    assert.ok(!JSON.stringify(r2).includes("lk.hse.ru"));
    assert.ok(r2.warnings.some((w) => W_MANUAL.test(w)));
  } finally {
    certificateTestSeams.listRequests = original;
  }
});

test("describe: необратимость, поля и варианты; номеров заявок нет", () => {
  const form = buildCertificateForm(rawForm());
  const plan = planCertificate(form, FULL);
  const observed = { serviceId: 1, form, plan, claimNumbers: ["Z-77", "Z-78"] };
  const d = certificateAdapter.describe({ serviceId: 1, fields: FULL }, observed);
  assert.ok(d.warnings.includes("заказ необратим: способа отмены в ЕЛК нет"));
  assert.ok(
    d.warnings.some((w) => /поля, которые появляются после выбора варианта, сухой прогон не видит/.test(w) && /больше/.test(w)),
    "предупреждение о зависимых полях"
  );
  const json = JSON.stringify(d);
  assert.ok(json.includes(ORG[1]) && json.includes("Программа"));
  assert.ok(!json.includes("Z-77") && !json.includes("Z-78"));
  const payload = certificateAdapter.payloadOf({ serviceId: 1, fields: FULL }, observed);
  assert.deepEqual(payload.files, []);
  assert.equal(payload.state, certificateFingerprint({ claimNumbers: observed.claimNumbers, chosen: plan.chosen, autofilled: plan.autofilled }));
});
