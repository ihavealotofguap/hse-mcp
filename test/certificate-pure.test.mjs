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
  certificateResult,
  pollNewClaims,
  MANUAL_CHECK_WARNING,
  certificateTestSeams,
  classifyClaimsOutcome,
  classifyCertificateOutcome,
  parseClaimCreated,
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
  // Formily: звёздочка отдельным элементом перед подписью — в тексте блока подписи она идёт первой.
  assert.equal(normalizeLabel("*Формат получения"), "Формат получения");
  assert.equal(normalizeLabel("* Формат получения"), "Формат получения");
  assert.equal(normalizeLabel("*  Формат   получения"), "Формат получения");
});

test("buildCertificateForm: обязательность по звёздочке в начале подписи (разметка Formily)", () => {
  const items = rawForm().items.map((it) =>
    it.label.startsWith("Формат") ? { ...it, label: "*Формат получения", requiredMark: false } : it.label.startsWith("Наименование") ? { ...it, label: "*Наименование организации", requiredMark: false } : it
  );
  const form = buildCertificateForm(rawForm({ items }));
  assert.deepEqual(form.fields.filter((f) => f.required).map((f) => f.label), ["Формат получения", "Наименование организации"]);
  // Ключи fields — обычные подписи, без звёздочки.
  assert.deepEqual(planCertificate(form, FULL).chosen.map((c) => c.label), ["Формат получения", "Наименование организации"]);
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
  refuses(() => planCertificate(form, {}), /«Формат получения».*«Наименование организации»/);
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

test("planCertificate: отказ о недостающих обязательных полях перечисляет подписи и варианты (разведка формы пустым fields)", () => {
  const form = buildCertificateForm(rawForm());
  let msg = "";
  try {
    planCertificate(form, {});
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.ok(err instanceof Refusal);
    msg = err.message;
  }
  assert.match(msg, /^не заданы обязательные поля: /);
  // Подписи и тексты вариантов обоих полей.
  for (const text of [...FORMAT, "Формат получения", "Наименование организации", ORG[0]]) assert.ok(msg.includes(`«${text}»`), text);
  // Вариант, требующий дополнительного поля, помечен как неподдерживаемый, обычные — нет.
  assert.match(msg, /«Полное наименование организации \(указать в дополнительном поле\)» \(не поддерживается\)/);
  assert.ok(!msg.includes(`«${ORG[0]}» (не поддерживается)`));
  assert.ok(!msg.includes(`«${FORMAT[0]}» (не поддерживается)`));
  // Что делать дальше, и что ничего не отправлено.
  assert.match(msg, /задайте их в fields и повторите сухой прогон — ничего не отправлено/);
  // Автозаполненные значения и подписи в отказ не попадают.
  for (const secret of ["Программа", "Факультет", "Образовательная программа"]) assert.ok(!msg.includes(secret), secret);
  // Заданное поле в перечень недостающих не входит и вариантов не раскрывает.
  try {
    planCertificate(form, { "Формат получения": FORMAT[0] });
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.ok(err.message.includes("«Наименование организации»") && err.message.includes(`«${ORG[0]}»`));
    assert.ok(!err.message.includes("«Формат получения»") && !err.message.includes(`«${FORMAT[1]}»`));
  }
  // Обязательное поле-ввод без значения: подпись есть, вариантов нет.
  const reqInput = buildCertificateForm(
    rawForm({ requiredLeft: [3], items: [...rawForm().items, { label: "Телефон*", requiredMark: true, kind: "input", disabled: false, value: "", options: null }] })
  );
  try {
    planCertificate(reqInput, FULL);
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.match(err.message, /не заданы обязательные поля: «Телефон»; задайте/);
    assert.ok(!err.message.includes("вариант"));
  }
});

test("planCertificate: значение не из вариантов — отказ перечисляет варианты этого поля и только их", () => {
  const form = buildCertificateForm(rawForm());
  try {
    planCertificate(form, { ...FULL, "Формат получения": "Факс" });
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.ok(err instanceof Refusal);
    assert.match(err.message, /^поле «Формат получения»: значения нет среди вариантов формы \(варианты: /);
    for (const o of FORMAT) assert.ok(err.message.includes(`«${o}»`), o);
    for (const o of ORG) assert.ok(!err.message.includes(o), "варианты чужого поля");
    for (const secret of ["Программа", "Факультет"]) assert.ok(!err.message.includes(secret), secret);
  }
  // Неподдерживаемые варианты в списке помечены и здесь.
  try {
    planCertificate(form, { ...FULL, "Наименование организации": "Иное" });
    assert.fail("ожидался отказ");
  } catch (err) {
    assert.match(err.message, /«Полное наименование организации \(указать в дополнительном поле\)» \(не поддерживается\)/);
  }
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
  assert.equal(typeof certificateAdapter.commitDeadlineMs, "number", "дедлайн коммита задан явно");
  // Неверные аргументы — отказ до любого обращения к странице и к истории заявок.
  await assert.rejects(() => certificateAdapter.observe({ serviceId: 0, fields: {} }), /serviceId/);
  let commits = 0;
  await assert.rejects(
    () => certificateAdapter.execute({ serviceId: 0, fields: {} }, {}, { signal: new AbortController().signal, commitPoint: async () => void commits++ }),
    (err) => err instanceof Refusal && /serviceId/.test(err.message)
  );
  assert.equal(commits, 0);
});

const W_MANUAL = /сверьте вручную на странице «Заявки» в lk\.hse\.ru/;

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

test("parseClaimCreated: время создания заявки ЕЛК — без пояса как МСК, с поясом как есть, дата без времени — сутки", () => {
  assert.deepEqual(parseClaimCreated("2026-10-20T12:00:00"), { at: Date.parse("2026-10-20T09:00:00Z"), dayOnly: false });
  assert.deepEqual(parseClaimCreated("2026-10-20 12:00"), { at: Date.parse("2026-10-20T09:00:00Z"), dayOnly: false });
  assert.deepEqual(parseClaimCreated("2026-10-20T12:00:00.123456"), { at: Date.parse("2026-10-20T09:00:00.123Z"), dayOnly: false });
  assert.deepEqual(parseClaimCreated("2026-10-20T08:00:00Z"), { at: Date.parse("2026-10-20T08:00:00Z"), dayOnly: false });
  assert.deepEqual(parseClaimCreated("2026-10-20T12:00:00+03:00"), { at: Date.parse("2026-10-20T09:00:00Z"), dayOnly: false });
  assert.deepEqual(parseClaimCreated("20.10.2026 12:00"), { at: Date.parse("2026-10-20T09:00:00Z"), dayOnly: false });
  assert.deepEqual(parseClaimCreated("2026-10-20"), { at: Date.parse("2026-10-19T21:00:00Z"), dayOnly: true });
  for (const bad of ["", "вчера", "2026-13-40T00:00", "2026-02-30", "12:00", null, undefined]) assert.equal(parseClaimCreated(bad), null, String(bad));
});

const CLICK = Date.parse("2026-10-20T09:00:30Z"); // 12:00:30 МСК
const claim = (num, over = {}) => ({
  num,
  service: "Справка об обучении",
  created: "2026-10-20T12:00:10",
  createdByFio: "Иванов Иван",
  createdByEmail: "Student@Edu.hse.ru",
  ...over,
});
const order = (after, over = {}) =>
  classifyCertificateOutcome({ before: ["A-1"], after: [claim("A-1"), ...after], submitRequests: 1, clickedAt: CLICK, loginEmail: "student@edu.hse.ru", ...over });

test("classifyCertificateOutcome: подтверждено только при одном замеченном запросе заказа и одной свежей новой заявке", () => {
  const r = order([claim("A-2")]);
  assert.equal(r.outcome, "confirmed");
  assert.deepEqual(r.warnings, []);
  assert.equal(r.evidence.newClaimNumber, "A-2");
  assert.equal(r.evidence.newClaimService, "Справка об обучении");
  assert.equal(r.evidence.newClaimCreated, "2026-10-20T12:00:10");
  assert.equal(r.evidence.newClaimByLogin, true, "автор — тот же логин (без учёта регистра)");
  assert.ok(!JSON.stringify(r).includes("Иванов"), "ФИО в ответ не попадает (§8)");
  assert.equal(order([claim("A-2", { createdByEmail: "other@hse.ru" })]).evidence.newClaimByLogin, false);
  // Автор — только сведения: другой email подтверждение не отменяет.
  assert.equal(order([claim("A-2", { createdByEmail: "other@hse.ru" })]).outcome, "confirmed");
  assert.equal(order([claim("A-2")], { loginEmail: null }).evidence.newClaimByLogin, null);
  // Создана за 4 минуты до клика (часы могут расходиться) — ещё наша.
  assert.equal(order([claim("A-2", { created: "2026-10-20T11:56:30" })]).outcome, "confirmed");
  // Дата без времени — сегодняшняя — наша.
  assert.equal(order([claim("A-2", { created: "2026-10-20" })]).outcome, "confirmed");
});

test("classifyCertificateOutcome: запрос заказа не замечен или их несколько — неизвестно с предупреждением", () => {
  for (const submitRequests of [0, 2, 3]) {
    const r = order([claim("A-2")], { submitRequests });
    assert.equal(r.outcome, "unknown", `submitRequests ${submitRequests}`);
    assert.ok(r.warnings.some((w) => W_MANUAL.test(w)), `submitRequests ${submitRequests}: предупреждение`);
    // Номер и сведения остаются в ответе: по ним владелец сверяет вручную.
    assert.equal(r.evidence.newClaimNumber, "A-2");
  }
  const none = order([], { submitRequests: 2 });
  assert.equal(none.outcome, "unknown");
  assert.ok(none.warnings.some((w) => W_MANUAL.test(w)));
});

test("classifyCertificateOutcome: новая заявка создана задолго до клика — не наша, неизвестно", () => {
  for (const created of ["2026-10-20T11:50:00", "2026-10-20T08:00:00Z", "2026-10-18", "19.10.2026 23:59"]) {
    const r = order([claim("A-2", { created })]);
    assert.equal(r.outcome, "unknown", created);
    assert.ok(r.warnings.some((w) => W_MANUAL.test(w)), created);
  }
  // Время не распознано — снисходительно: подтверждено, но с предупреждением.
  const odd = order([claim("A-2", { created: "вчера вечером" })]);
  assert.equal(odd.outcome, "confirmed");
  assert.ok(odd.warnings.some((w) => /время создания/.test(w)));
});

test("classifyCertificateOutcome: ни одной или несколько новых — неизвестно, при нескольких номеров нет", () => {
  assert.equal(order([]).outcome, "unknown");
  assert.equal(order([]).evidence.newClaims, 0);
  const two = order([claim("B-1"), claim("B-2")]);
  assert.equal(two.outcome, "unknown");
  assert.ok(two.warnings.some((w) => W_MANUAL.test(w)));
  assert.ok(!JSON.stringify(two).includes("B-1") && !JSON.stringify(two).includes("B-2"));
  // Повтор номера в ответе — одна заявка.
  assert.equal(order([claim("A-2"), claim("A-2")]).outcome, "confirmed");
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
    assert.ok(!JSON.stringify(r2).includes("/api/claims") && !JSON.stringify(r2).includes("username"), "текст ошибки чтения в ответ не попадает");
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

test("certificateResult: каждый неизвестный исход несёт предупреждение «newClaims: 0 не означает…», историю заявок не советуют", () => {
  const trace = (over = {}) => ({ clickedAt: CLICK, clickError: false, submitRequests: 1, submitStatus: 200, dialogAfterCommit: false, ...over });
  const after = (...more) => [claim("A-1"), ...more];
  const unknowns = [
    ["newClaims 0, запрос замечен один раз (случай живой справки)", certificateResult(trace(), ["A-1"], after())],
    ["история не прочиталась", certificateResult(trace(), ["A-1"], null)],
    ["запрос отправки не замечен", certificateResult(trace({ submitRequests: 0 }), ["A-1"], after(claim("A-2")))],
    ["два запроса отправки", certificateResult(trace({ submitRequests: 2 }), ["A-1"], after(claim("A-2")))],
    ["несколько новых заявок", certificateResult(trace(), ["A-1"], after(claim("A-2"), claim("A-3")))],
    ["заявка старая", certificateResult(trace(), ["A-1"], after(claim("A-2", { created: "2026-10-19T12:00:00" })))],
    ["диалог после отправки", certificateResult(trace({ dialogAfterCommit: true }), ["A-1"], after())],
  ];
  for (const [what, r] of unknowns) {
    assert.equal(r.outcome, "unknown", what);
    assert.ok(r.warnings.includes(MANUAL_CHECK_WARNING), `${what}: предупреждение есть`);
    assert.ok(r.warnings.every((w) => !/elk_list_requests/.test(w)), `${what}: elk_list_requests не советуют`);
  }
  assert.match(MANUAL_CHECK_WARNING, /newClaims: 0 не означает, что заказ не прошёл/);
  assert.match(MANUAL_CHECK_WARNING, /Сервиса Студент в истории заявок через API не видны/);
  assert.match(MANUAL_CHECK_WARNING, /странице «Заявки» в lk\.hse\.ru/);
  assert.match(MANUAL_CHECK_WARNING, /не повторяйте заказ без этой проверки/);
  // Подтверждённый исход (формы, чьи заявки видны в /api/claims) предупреждения не получает.
  const ok = certificateResult(trace(), ["A-1"], after(claim("A-2")));
  assert.equal(ok.outcome, "confirmed");
  assert.ok(!ok.warnings.includes(MANUAL_CHECK_WARNING));
});

test("certificateAdapter.verifyOnly: исход неизвестен, предупреждение «newClaims: 0 не означает…» есть, elk_list_requests не советуют", async () => {
  const saved = certificateTestSeams.listRequests;
  try {
    for (const seam of [async () => ({ count: 1, requests: [{ num: "A-1" }] }), async () => { throw new Error("сеть"); }]) {
      certificateTestSeams.listRequests = seam;
      const r = await certificateAdapter.verifyOnly({ serviceId: 1, fields: {} }, undefined);
      assert.equal(r.outcome, "unknown");
      assert.ok(r.warnings.includes(MANUAL_CHECK_WARNING));
      assert.ok(r.warnings.every((w) => !/elk_list_requests/.test(w)));
    }
  } finally {
    certificateTestSeams.listRequests = saved;
  }
});

test("certificateAdapter: явный дедлайн коммита 45 с и предупреждение каждого unknown", () => {
  assert.equal(certificateAdapter.commitDeadlineMs, 45_000);
  assert.deepEqual(certificateAdapter.unknownWarnings, [MANUAL_CHECK_WARNING]);
});

test("pollNewClaims: первое чтение всегда, дальше — не позже чем за 5 с до дедлайна коммита; обычный опрос идёт до окна ожидания", async () => {
  const saved = { ...certificateTestSeams };
  let reads = 0;
  try {
    certificateTestSeams.listRequests = async () => {
      reads++;
      return { count: 1, requests: [{ num: "A-1" }] };
    };
    certificateTestSeams.claimsWaitMs = 60_000;
    certificateTestSeams.claimsPollMs = 1;
    // Клик был 41 с назад: до дедлайна (45 с) осталось меньше 5 с — ровно одно чтение и выход.
    const ac = new AbortController();
    const out = await pollNewClaims(["A-1"], Date.now() - 41_000, ac.signal);
    assert.equal(reads, 1);
    assert.deepEqual(out.map((c) => c.num), ["A-1"]);
    // Окно ожидания короткое: опрос идёт до его конца, несколько чтений.
    reads = 0;
    certificateTestSeams.claimsWaitMs = 40;
    certificateTestSeams.claimsPollMs = 5;
    await pollNewClaims(["A-1"], Date.now(), ac.signal);
    assert.ok(reads >= 3, `чтений: ${reads}`);
    // Новая заявка завершает опрос сразу.
    reads = 0;
    certificateTestSeams.listRequests = async () => {
      reads++;
      return { count: 2, requests: [{ num: "A-1" }, { num: "A-2" }] };
    };
    certificateTestSeams.claimsWaitMs = 10_000;
    await pollNewClaims(["A-1"], Date.now(), ac.signal);
    assert.equal(reads, 1);
  } finally {
    Object.assign(certificateTestSeams, saved);
  }
});
