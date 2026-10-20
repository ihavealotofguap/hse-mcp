import crypto from "node:crypto";
import type { Locator, Page } from "playwright";
import { withPage, type PageCallContext } from "../../auth/browser-session.js";
import type { ResourceCallOptions } from "../../resource.js";
import { Refusal, sanitizeNavigationError } from "../lms/submissions.js";
import type { WriteAdapter } from "../writes/runner.js";
import { listRequests, type ElkClaim } from "./client.js";

/**
 * Заказ справки в ЕЛК (спека №4 §10, §17, седьмой и восьмой проходы): читающая половина — разбор
 * формы `/student-service/student-service-first?components=<serviceId>`, предусловия сухого прогона,
 * описание для владельца, отпечаток состояния для `previewToken`. Запись (`execute`/`verifyOnly`) —
 * отдельный шаг, здесь не реализована.
 *
 * Форма — Formily поверх Element Plus: поля `.el-form-item` с подписью `.el-form-item__label`,
 * выпадающие списки раскрываются кликом по обёртке `.el-select` (не по `input`), варианты —
 * `.el-select-dropdown__item` в отдельном всплывающем окне, закрытие — `Escape`. Отправка — POST
 * `/rest-api/camunda-gateway/process/start` по кнопке «Отправить»; заказ **необратим** (в ЕЛК нет
 * отмены заявки). Чтение формы ничего не выбирает и не нажимает «Отправить»; на время чтения
 * страница отклоняет любые свои не-GET запросы.
 *
 * Неожиданная форма (нет полей, поле без подписи или незнакомого типа, повтор подписи, не одна
 * «Отправить», индикатор обязательных полей не сходится с распознанным) — отказ, а не догадка.
 * Тексты отказов о форме ссылаются на поля по номеру, без значений; номера заявок (снимок до заказа)
 * живут только в памяти наблюдения и в ответ, журнал и ошибки не попадают.
 */

const BASE_URL = "https://lk.hse.ru";
const formUrl = (serviceId: number) => `${BASE_URL}/student-service/student-service-first?components=${serviceId}`;

// Подписи и селекторы — из живой разведки (§17, восьмой проход).
const SUBMIT_TEXT = "Отправить";
const SEL_ITEM = ".el-form-item";
// Только «листовые» поля: обёртки раскладки Formily с вложенными полями сами полем не являются.
const SEL_LEAF_ITEM = `${SEL_ITEM}:not(:has(${SEL_ITEM}))`;
const SEL_SELECT = ".el-select";
const SEL_DROPDOWN = ".el-select-dropdown";
const SEL_OPTION = ".el-select-dropdown__item";
const REQUIRED_LEFT_RE = /Заполните обязательные поля \((\d+)\)/g;
// Контролы Element Plus, которые v1 не разбирает (дата, переключатель, загрузка файла и т.п.).
const UNSUPPORTED_CONTROLS =
  ".el-date-editor, .el-switch, .el-upload, .el-checkbox, .el-radio, .el-cascader, .el-input-number, .el-slider, .el-rate, .el-color-picker, .el-transfer, .el-tree-select";

const FORM_WAIT_MS = 15_000;
const SUBMIT_WAIT_MS = 5_000;
const DROPDOWN_WAIT_MS = 5_000;
const MAX_FIELDS = 50;
const MAX_LABEL = 200;
const MAX_VALUE = 500;
// Столько заявок читает `elk_list_requests` (максимум API-запроса модуля client.ts).
const CLAIMS_LIMIT = 500;

export interface CertificateArgs {
  serviceId: number;
  /** Подпись поля → текст варианта выпадающего списка. */
  fields: Record<string, string>;
}

export interface CertificateField {
  label: string;
  required: boolean;
  kind: "select" | "input";
  /** Варианты доступного списка; у поля-ввода и заблокированного списка — пусто. */
  options: string[];
  /** Текущее значение (автозаполнение формы); пусто — не заполнено. */
  value: string;
  disabled: boolean;
}

export interface CertificateForm {
  title: string;
  fields: CertificateField[];
  submitDisabled: boolean;
  /** N из индикатора «Заполните обязательные поля (N)»; индикатора нет — `null`. */
  requiredLeft: number | null;
}

/** Сырой снимок одного поля — всё, что разбор берёт из DOM. */
export interface RawFormItem {
  label: string;
  /** Класс `is-required` у поля (звёздочка в тексте подписи учитывается отдельно). */
  requiredMark: boolean;
  kind: "select" | "input" | "unknown";
  disabled: boolean;
  value: string;
  /** Прочитанные варианты; `null` — список не раскрывался. */
  options: string[] | null;
}

export interface RawCertificateForm {
  title: string;
  items: RawFormItem[];
  /** Сколько кнопок «Отправить» (точное имя) на странице. */
  submitButtons: number;
  submitDisabled: boolean;
  /** Все N индикатора «Заполните обязательные поля (N)» на странице. */
  requiredLeft: number[];
}

export interface CertificatePlan {
  /** Поля, которые заполнит заказ: значение — точный текст варианта формы, `current` — что там сейчас. */
  chosen: Array<{ label: string; value: string; current: string }>;
  /** Непустые поля, которые форма заполнила сама и которые уйдут в заявку как есть. */
  autofilled: Array<{ label: string; value: string }>;
  /** Обязательные поля, пустые на форме при чтении. */
  requiredEmpty: string[];
}

/** Наблюдение сухого прогона: форма, план и снимок номеров заявок (только в памяти). */
export interface CertificateObserved {
  serviceId: number;
  form: CertificateForm;
  plan: CertificatePlan;
  claimNumbers: string[];
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Подпись поля для сравнения: без звёздочки обязательности, двоеточия в конце и лишних пробелов. */
export function normalizeLabel(raw: string): string {
  return collapse(raw.replace(/\*/g, " ")).replace(/\s*:$/, "").trim();
}

/**
 * Вариант отсылает к дополнительному полю, которое форма показывает после выбора (§17: «Полное
 * наименование организации (указать в дополнительном поле)»). Признак консервативный — текст
 * «в дополнительном поле» без учёта регистра.
 */
export function needsExtraInput(option: string): boolean {
  return /в дополнительном поле/i.test(option);
}

const quoted = (labels: string[]) => labels.map((l) => `«${l}»`).join(", ");

/** Отказы по самим аргументам — до любого обращения к системе. */
export function checkCertificateArgs(args: CertificateArgs): void {
  const { serviceId, fields } = args as { serviceId: unknown; fields: unknown };
  if (typeof serviceId !== "number" || !Number.isSafeInteger(serviceId) || serviceId <= 0) {
    throw new Refusal("serviceId должен быть положительным целым числом");
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Refusal("fields должен быть словарём «подпись поля → вариант»");
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) throw new Refusal(`слишком много полей в fields: не более ${MAX_FIELDS}`);
  const seen = new Set<string>();
  entries.forEach(([label, value], i) => {
    const norm = normalizeLabel(label);
    if (!norm || norm.length > MAX_LABEL) throw new Refusal(`fields, поле №${i + 1}: подпись пуста или слишком длинная`);
    if (seen.has(norm)) throw new Refusal(`fields: подпись ${quoted([norm])} повторяется`);
    seen.add(norm);
    if (typeof value !== "string" || !collapse(value) || value.length > MAX_VALUE) {
      throw new Refusal(`fields, поле ${quoted([norm])}: значение должно быть непустой строкой не длиннее ${MAX_VALUE} символов`);
    }
  });
}

/**
 * Разбор снимка формы. Обязательность — класс `is-required` или звёздочка в подписи. Индикатор
 * «Заполните обязательные поля (N)», если он есть, обязан совпасть с числом обязательных пустых
 * полей: иначе обязательность распознана не так, как её считает сама форма.
 */
export function buildCertificateForm(raw: RawCertificateForm): CertificateForm {
  if (raw.items.length === 0) throw new Refusal("на странице не найдено полей формы заказа");
  if (raw.submitButtons !== 1) {
    throw new Refusal(`кнопка «${SUBMIT_TEXT}»: ожидалась ровно одна, найдено ${raw.submitButtons}`);
  }
  const firstByLabel = new Map<string, number>();
  const fields = raw.items.map((item, i): CertificateField => {
    const n = i + 1;
    const label = normalizeLabel(item.label);
    if (!label) throw new Refusal(`поле №${n}: подпись не найдена`);
    if (item.kind === "unknown") throw new Refusal(`поле №${n}: тип поля не поддерживается`);
    const first = firstByLabel.get(label);
    if (first !== undefined) {
      throw new Refusal(`подписи полей формы повторяются (поля №${first} и №${n}): поле нельзя выбрать по подписи`);
    }
    firstByLabel.set(label, n);
    return {
      label,
      required: item.requiredMark || item.label.includes("*"),
      kind: item.kind,
      options: (item.options ?? []).map(collapse).filter(Boolean),
      value: collapse(item.value),
      disabled: item.disabled,
    };
  });
  const indicator = [...new Set(raw.requiredLeft)];
  if (indicator.length > 1) throw new Refusal("индикатор обязательных полей формы показывает разные числа");
  const requiredLeft = indicator.length === 1 ? indicator[0] : null;
  const requiredEmpty = fields.filter((f) => f.required && !f.value).length;
  if (requiredLeft !== null && requiredLeft !== requiredEmpty) {
    throw new Refusal(
      `форма считает незаполненными обязательных полей: ${requiredLeft}, распознано: ${requiredEmpty} — обязательность полей не распознана`
    );
  }
  return { title: collapse(raw.title), fields, submitDisabled: raw.submitDisabled, requiredLeft };
}

/**
 * Предусловия сухого прогона и план заказа: каждая подпись `fields` — ровно одно поле формы,
 * доступный для выбора выпадающий список, значение — ровно один его вариант; все обязательные поля
 * либо уже заполнены формой, либо заданы. Заблокированные (автозаполненные) поля не меняются.
 */
export function planCertificate(form: CertificateForm, fields: Record<string, string>): CertificatePlan {
  const byLabel = new Map(form.fields.map((f) => [f.label, f]));
  const given = new Map(Object.entries(fields).map(([label, value]) => [normalizeLabel(label), collapse(value)]));
  const unknown = [...given.keys()].filter((label) => !byLabel.has(label));
  if (unknown.length > 0) throw new Refusal(`неизвестные поля формы: ${quoted(unknown)}`);

  const chosen: CertificatePlan["chosen"] = [];
  for (const field of form.fields) {
    const value = given.get(field.label);
    if (value === undefined) continue;
    if (field.disabled) throw new Refusal(`поле ${quoted([field.label])} заполняется автоматически и не меняется`);
    if (field.kind !== "select") throw new Refusal(`поле ${quoted([field.label])}: в v1 заполняются только выпадающие списки`);
    const matches = field.options.filter((o) => o === value).length;
    if (matches === 0) throw new Refusal(`поле ${quoted([field.label])}: значения нет среди вариантов формы`);
    if (matches > 1) throw new Refusal(`поле ${quoted([field.label])}: вариант в списке формы повторяется — выбор неоднозначен`);
    chosen.push({ label: field.label, value, current: field.value });
  }
  // Итоговое значение каждого поля (выбранное или уже стоящее на форме) не должно требовать
  // дополнительного поля: его сухой прогон не видит, а v1 текстовые поля не заполняет.
  form.fields.forEach((field, i) => {
    if (needsExtraInput(given.get(field.label) ?? field.value)) {
      throw new Refusal(
        `поле №${i + 1}: выбранный вариант требует заполнить дополнительное поле, а v1 текстовые поля не заполняет — выберите другой вариант`
      );
    }
  });
  const missing = form.fields.filter((f) => f.required && !f.value && !given.has(f.label)).map((f) => f.label);
  if (missing.length > 0) throw new Refusal(`не заданы обязательные поля: ${quoted(missing)}`);
  return {
    chosen,
    autofilled: form.fields.filter((f) => f.value && !given.has(f.label)).map((f) => ({ label: f.label, value: f.value })),
    requiredEmpty: form.fields.filter((f) => f.required && !f.value).map((f) => f.label),
  };
}

const sha256Hex = (data: string) => crypto.createHash("sha256").update(data).digest("hex");

const sortedPairs = (list: Array<{ label: string; value: string }>) =>
  list.map((x) => [x.label, x.value] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/**
 * Отпечаток состояния для `previewToken`: sha256 от JSON с множеством номеров заявок (порядок и
 * повторы не важны), выбранными значениями и автозаполнением формы. Новая заявка, другой вариант или
 * изменившееся автозаполнение между сухим прогоном и записью — расхождение токена.
 */
export function certificateFingerprint(input: {
  claimNumbers: string[];
  chosen: Array<{ label: string; value: string }>;
  autofilled: Array<{ label: string; value: string }>;
}): string {
  return sha256Hex(
    JSON.stringify({
      claims: [...new Set(input.claimNumbers)].sort(),
      chosen: sortedPairs(input.chosen),
      autofilled: sortedPairs(input.autofilled),
    })
  );
}

/** Номера заявок из ответа `listRequests` (отсортированы); пустой или нестроковый номер — отказ. */
export function claimNumbersOf(list: { count: number; requests: Array<Pick<ElkClaim, "num">> }): string[] {
  if (!list || !Array.isArray(list.requests)) throw new Refusal("история заявок ЕЛК: ответ не распознан");
  return list.requests
    .map((c, i) => {
      const num = typeof c?.num === "string" ? c.num.trim() : "";
      if (!num) throw new Refusal(`история заявок ЕЛК: номер заявки №${i + 1} не распознан`);
      return num;
    })
    .sort();
}

/** Шов только для проверок: подмена чтения истории заявок (одноразовые скрипты на заготовках). */
export const certificateTestSeams: {
  listRequests: (opts: ResourceCallOptions) => Promise<{ count: number; requests: ElkClaim[] }>;
} = { listRequests: (opts) => listRequests(CLAIMS_LIMIT, opts) };

// --- Чтение страницы ---

/** Снимок поля без раскрытия списка. Значение списка — из `.el-select__placeholder` (Element Plus ≥ 2.5). */
async function readItem(item: Locator): Promise<Omit<RawFormItem, "options">> {
  return item.evaluate(
    (el, { unsupported }) => {
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const label = clean(el.querySelector(".el-form-item__label")?.textContent);
      const requiredMark = el.classList.contains("is-required");
      const base = { label, requiredMark, disabled: false, value: "" };
      if (el.querySelector(unsupported)) return { ...base, kind: "unknown" as const };
      const selects = el.querySelectorAll(".el-select");
      if (selects.length > 0) {
        const select = selects[0];
        // Несколько списков в поле, множественный выбор (теги) или незнакомая разметка значения — не разбираем.
        const placeholders = select.querySelectorAll(".el-select__placeholder");
        if (selects.length !== 1 || select.querySelector(".el-tag") || placeholders.length !== 1) {
          return { ...base, kind: "unknown" as const };
        }
        const ph = placeholders[0];
        const disabled = select.classList.contains("is-disabled") || select.querySelector(".el-select__wrapper.is-disabled") !== null;
        return { ...base, kind: "select" as const, disabled, value: ph.classList.contains("is-transparent") ? "" : clean(ph.textContent) };
      }
      const controls = el.querySelectorAll('input:not([type="hidden"]), textarea');
      if (controls.length !== 1) return { ...base, kind: "unknown" as const };
      const control = controls[0] as HTMLInputElement | HTMLTextAreaElement;
      return { ...base, kind: "input" as const, disabled: control.disabled || control.readOnly, value: control.value };
    },
    { unsupported: UNSUPPORTED_CONTROLS }
  );
}

const visibleDropdowns = (page: Page) => page.locator(SEL_DROPDOWN).filter({ visible: true });

/**
 * Варианты одного доступного списка: один клик по обёртке `.el-select`, ровно одно видимое окно
 * вариантов, тексты `.el-select-dropdown__item` (кроме недоступных и скрытых), `Escape`, окно
 * закрылось, значение поля не изменилось. Любое расхождение — отказ.
 */
async function readOptions(page: Page, item: Locator, n: number, valueBefore: string): Promise<string[]> {
  if ((await visibleDropdowns(page).count()) !== 0) throw new Refusal(`перед чтением вариантов поля №${n} уже раскрыт другой список`);
  const select = item.locator(SEL_SELECT);
  if ((await select.count()) !== 1) throw new Refusal(`поле №${n}: ожидался ровно один выпадающий список`);
  await select.click();
  try {
    await visibleDropdowns(page).first().waitFor({ state: "visible", timeout: DROPDOWN_WAIT_MS });
  } catch {
    throw new Refusal(`список вариантов поля №${n} не раскрылся`);
  }
  const open = visibleDropdowns(page);
  if ((await open.count()) !== 1) throw new Refusal(`при чтении поля №${n} раскрыт не один список вариантов`);
  const options = await open.locator(SEL_OPTION).evaluateAll((els) =>
    els
      .filter((e) => !e.classList.contains("is-disabled") && e.getClientRects().length > 0)
      .map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim())
  );
  await page.keyboard.press("Escape");
  try {
    await visibleDropdowns(page).first().waitFor({ state: "hidden", timeout: DROPDOWN_WAIT_MS });
  } catch {
    throw new Refusal(`список вариантов поля №${n} не закрылся`);
  }
  if (collapse((await readItem(item)).value) !== collapse(valueBefore)) {
    throw new Refusal(`значение поля №${n} изменилось при чтении вариантов: форма ведёт себя неожиданно`);
  }
  return options;
}

/** Заголовок формы — только для показа владельцу: первый видимый `h1`, иначе `h2`, иначе заголовок окна. */
async function readTitle(page: Page): Promise<string> {
  for (const sel of ["h1", "h2"]) {
    const h = page.locator(sel).filter({ visible: true });
    if ((await h.count()) > 0) return collapse((await h.first().textContent()) ?? "");
  }
  return collapse(await page.title());
}

/**
 * Разбор формы заказа справки; страница уже на `/student-service/student-service-first?components=<id>`.
 * Сначала структура без кликов (поля, «Отправить», индикатор) — неожиданная форма отказывает до
 * раскрытия списков; затем варианты каждого доступного списка. Ничего не выбирает и не отправляет.
 */
export async function readCertificateForm(page: Page): Promise<CertificateForm> {
  try {
    await page.locator(SEL_ITEM).filter({ visible: true }).first().waitFor({ state: "visible", timeout: FORM_WAIT_MS });
  } catch {
    throw new Refusal("форма заказа справки не отрисовалась");
  }
  // Автозаполнение подтягивается запросами после отрисовки.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  const submit = page.getByRole("button", { name: SUBMIT_TEXT, exact: true });
  await submit.first().waitFor({ state: "attached", timeout: SUBMIT_WAIT_MS }).catch(() => {});

  const items = page.locator(SEL_LEAF_ITEM).filter({ visible: true });
  const count = await items.count();
  const raw: RawFormItem[] = [];
  for (let i = 0; i < count; i++) raw.push({ ...(await readItem(items.nth(i))), options: null });
  const submitButtons = await submit.count();
  const bodyText = await page.locator("body").innerText();
  const requiredLeft = [...bodyText.matchAll(REQUIRED_LEFT_RE)].map((m) => Number(m[1]));
  // Проверка структуры до первого клика; активность «Отправить» здесь ещё не нужна.
  buildCertificateForm({ title: "", items: raw, submitButtons, submitDisabled: true, requiredLeft });

  const submitDisabled = await submit.isDisabled();
  for (let i = 0; i < count; i++) {
    const it = raw[i];
    if (it.kind === "select" && !it.disabled) raw[i] = { ...it, options: await readOptions(page, items.nth(i), i + 1, it.value) };
  }
  // Число полей не изменилось за время чтения (раскрытие списков не дорисовало новых).
  if ((await items.count()) !== count) throw new Refusal("набор полей формы изменился во время чтения");
  return buildCertificateForm({ title: await readTitle(page), items: raw, submitButtons, submitDisabled, requiredLeft });
}

// --- Адаптер ---

/**
 * `withPage` с очисткой ошибок от URL (адрес формы содержит `components=<id>`); собственные отказы
 * проходят как есть. На время чтения страница отклоняет свои не-GET запросы: даже если форма что-то
 * отправит сама (например, по раскрытию списка), до системы это не дойдёт.
 */
async function readFormPage<T>(url: string, fn: (page: Page, ctx: PageCallContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await withPage(
      url,
      async (page, ctx) => {
        await page.route("**/*", (route) =>
          route.request().method() === "GET" ? route.fallback() : route.abort("blockedbyclient")
        );
        return fn(page, ctx);
      },
      { signal }
    );
  } catch (err) {
    throw sanitizeNavigationError(err, "форма заказа справки");
  }
}

/** Снимок номеров заявок свежим чтением (`maxAgeMs: 0`); ошибки — без адресов и query. */
async function readClaimNumbers(signal?: AbortSignal): Promise<string[]> {
  let list: { count: number; requests: ElkClaim[] };
  try {
    list = await certificateTestSeams.listRequests({ maxAgeMs: 0, signal });
  } catch (err) {
    throw sanitizeNavigationError(err, "история заявок ЕЛК");
  }
  return claimNumbersOf(list);
}

const W_IRREVERSIBLE = "заказ необратим: способа отмены в ЕЛК нет";
const W_AUTOFILL = "автозаполненные значения форма берёт из личных данных ЕЛК и отправит как есть; они показаны только в этом ответе";
// Чтение ничего не выбирает, поэтому поля, которые форма дорисовывает по выбранному варианту, в
// снимок не попадают: список полей и незаполненных обязательных может быть неполным.
const W_DEPENDENT =
  "поля, которые появляются после выбора варианта, сухой прогон не видит: форма может потребовать больше данных, чем показано здесь";
const W_READ_ONLY ="форма открывалась только для чтения: списки раскрывались и закрывались без выбора, «Отправить» не нажималась";
const NOT_IMPLEMENTED = "заказ справки в ЕЛК ещё не реализован: доступен только сухой прогон";

export const certificateAdapter: WriteAdapter<CertificateArgs, CertificateObserved> = {
  op: "elk_order_certificate",
  invalidates: ["elk.claims"],
  targetOf: (args) => `service:${args.serviceId}`,
  async observe(args, signal) {
    checkCertificateArgs(args);
    const form = await readFormPage(formUrl(args.serviceId), (page) => readCertificateForm(page), signal);
    const plan = planCertificate(form, args.fields);
    const claimNumbers = await readClaimNumbers(signal);
    return { serviceId: args.serviceId, form, plan, claimNumbers };
  },
  describe(_args, { serviceId, form, plan, claimNumbers }) {
    const warnings = [W_IRREVERSIBLE, W_DEPENDENT, W_AUTOFILL, W_READ_ONLY];
    return {
      preview: {
        serviceId,
        title: form.title,
        fields: form.fields.map((f) => ({
          label: f.label,
          required: f.required,
          kind: f.kind,
          // Заблокированное поле форма заполняет сама, менять его нельзя.
          editable: !f.disabled,
          value: f.value || null,
          options: f.options,
        })),
        fill: plan.chosen.map((c) => ({ label: c.label, value: c.value, current: c.current || null })),
        requiredEmpty: plan.requiredEmpty,
        submitDisabled: form.submitDisabled,
        // Число, а не номера: номера заявок остаются в памяти наблюдения.
        requestsBefore: claimNumbers.length,
      },
      warnings,
    };
  },
  payloadOf(_args, { plan, claimNumbers }) {
    return { files: [], state: certificateFingerprint({ claimNumbers, chosen: plan.chosen, autofilled: plan.autofilled }) };
  },
  async execute() {
    throw new Refusal(NOT_IMPLEMENTED);
  },
  async verifyOnly() {
    throw new Refusal(NOT_IMPLEMENTED);
  },
};
