import crypto from "node:crypto";
import type { Locator, Page, Request, Route } from "playwright";
import { withPage, type PageCallContext } from "../../auth/browser-session.js";
import type { ResourceCallOptions } from "../../resource.js";
import { Refusal, sanitizeCommitError, sanitizeNavigationError } from "../lms/submissions.js";
import { abortableSleep, type ExecuteContext, type ExecuteResult, type WriteAdapter } from "../writes/runner.js";
import type { Outcome } from "../writes/types.js";
import { config } from "../../config.js";
import { listRequests, type ElkClaim } from "./client.js";

/**
 * Заказ справки в ЕЛК (спека №4 §10, §17, седьмой и восьмой проходы): разбор формы
 * `/student-service/student-service-first?components=<serviceId>`, предусловия сухого прогона,
 * описание для владельца, отпечаток состояния для `previewToken`, сама запись (заполнение формы и
 * один клик её «Отправить») и проверка по истории заявок (§7, §10).
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
 *
 * Запись покадровая (урок третьего прохода §17): каждый выбор — клик по обёртке списка, клик ровно
 * одного варианта с точным текстом, проверка значения. Перед точкой невозврата форма перечитывается
 * целиком (поля те же, что в сухом прогоне, значения ожидаемые, обязательных пустых нет, «Отправить»
 * одна и активна); первое расхождение — отказ до отправки. Необратимо одно действие — клик «Отправить»,
 * он не повторяется никогда. Ответ `process/start` (даже 2xx) — только сигнал: исход решает появление
 * ровно одной новой заявки в свежей истории (номер — только в ответе тула).
 */

const BASE_URL = "https://lk.hse.ru";
const formUrl = (serviceId: number) => `${BASE_URL}/student-service/student-service-first?components=${serviceId}`;

// Подписи и селекторы — из живой разведки (§17, восьмой проход).
const SUBMIT_TEXT = "Отправить";
// Живая форма — Formily Element Plus (`.formily-element-plus-form-item`, §17, девятый проход); `.el-form-item`
// оставлен для разметки голого Element Plus (заготовки проверок).
const ITEM_CLASSES = [".formily-element-plus-form-item", ".el-form-item"];
const SEL_ITEM = ITEM_CLASSES.join(", ");
// Только «листовые» поля: обёртки раскладки Formily с вложенными полями сами полем не являются.
const SEL_LEAF_ITEM = ITEM_CLASSES.map((c) => `${c}:not(:has(${SEL_ITEM}))`).join(", ");
// Подпись поля: первый найденный из этих элементов; звёздочка обязательности в Formily — отдельный элемент.
const LABEL_SELECTORS = [".formily-element-plus-form-item-label label", ".formily-element-plus-form-item-label", ".el-form-item__label"];
const SEL_ASTERISK = ".formily-element-plus-form-item-asterisk";
const SEL_SELECT = ".el-select";
const SEL_DROPDOWN = ".el-select-dropdown";
const SEL_OPTION = ".el-select-dropdown__item";
const REQUIRED_LEFT_RE = /Заполните обязательные поля \((\d+)\)/g;
// Контролы Element Plus, которые v1 не разбирает (дата, переключатель, загрузка файла и т.п.).
const UNSUPPORTED_CONTROLS =
  ".el-date-editor, .el-switch, .el-upload, .el-checkbox, .el-radio, .el-cascader, .el-input-number, .el-slider, .el-rate, .el-color-picker, .el-transfer, .el-tree-select";

// Submit формы (§17, восьмой проход): единственный запрос по «Отправить».
const START_PATH = "/rest-api/camunda-gateway/process/start";

const FORM_WAIT_MS = 15_000;
const SUBMIT_WAIT_MS = 5_000;
const DROPDOWN_WAIT_MS = 5_000;
// После точки невозврата всё укладывается в дедлайн коммита (20 с): клик, ответ `process/start`, опрос
// истории заявок до 15 с от клика (ожидание ответа входит в эти 15 с).
const CLICK_TIMEOUT_MS = 5_000;
const START_RESPONSE_WAIT_MS = 10_000;
const CLAIMS_WAIT_MS = 15_000;
const CLAIMS_POLL_MS = 1_000;
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

/**
 * Варианты поля для отказа сухого прогона: подпись и тексты берутся из определения формы (личных данных
 * там нет); вариант, требующий дополнительного поля, помечен — выбрать его нельзя.
 */
const optionsHint = (options: string[]): string =>
  options.length === 0
    ? ""
    : ` (варианты: ${options.map((o) => `«${o}»${needsExtraInput(o) ? " (не поддерживается)" : ""}`).join(", ")})`;

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
    if (matches === 0) throw new Refusal(`поле ${quoted([field.label])}: значения нет среди вариантов формы${optionsHint(field.options)}`);
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
  // Сухой прогон с пустым `fields` — разведка формы: отказ перечисляет, что выбирать (подписи и варианты).
  const missing = form.fields.filter((f) => f.required && !f.value && !given.has(f.label));
  if (missing.length > 0) {
    const list = missing.map((f) => `${quoted([f.label])}${optionsHint(f.options)}`).join("; ");
    throw new Refusal(`не заданы обязательные поля: ${list}; задайте их в fields и повторите сухой прогон — ничего не отправлено`);
  }
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

// Живая проверка (§17, одиннадцатый проход): заявки «Сервиса Студент» в `/api/claims` (то, что читает
// `elk_list_requests`) не видны, поэтому сверка возможна только вручную на странице «Заявки» в ЕЛК.
const MANUAL_WHERE = "сверьте вручную на странице «Заявки» в lk.hse.ru";
/** Предупреждение каждого неизвестного исхода заказа: «0 новых заявок» не значит, что заказ не прошёл. */
export const MANUAL_CHECK_WARNING =
  "newClaims: 0 не означает, что заказ не прошёл: справки Сервиса Студент в истории заявок через API не видны; проверьте вручную на странице «Заявки» в lk.hse.ru, не повторяйте заказ без этой проверки";

const W_MANUAL = `после заказа появилось несколько новых заявок: какая из них создана этим вызовом, не установить — ${MANUAL_WHERE}`;

const W_NO_START = `запрос заказа после нажатия «Отправить» не замечен: новая заявка может быть не этой — ${MANUAL_WHERE}`;
const W_MANY_STARTS = `форма отправила запрос заказа больше одного раза: возможны дубли — ${MANUAL_WHERE}`;
const W_CREATED_OLD = `новая заявка создана раньше заказа: вероятно, она не эта — ${MANUAL_WHERE}`;
const W_CREATED_UNPARSED = "время создания новой заявки не распознано: сверьте её сервис и время (evidence) с заказом";

/**
 * Первый шаг исхода — сравнение номеров (§7, §10): ровно один номер, которого не было в снимке до
 * заказа, — кандидат в подтверждение (номер только в `evidence`, то есть в ответе тула); ни одного —
 * неизвестно (заявка могла появиться позже); больше одного — неизвестно с предупреждением, номеров в
 * ответе нет. Пропавшие из списка старые номера (усечение истории) не учитываются. Окончательный исход
 * — `classifyCertificateOutcome`. `rejected` проверка не выносит никогда.
 */
export function classifyClaimsOutcome(
  before: string[],
  after: string[]
): { outcome: Outcome; evidence: { newClaims: number; newClaimNumber?: string }; warnings: string[] } {
  const known = new Set(before);
  const fresh = [...new Set(after)].filter((num) => !known.has(num));
  if (fresh.length === 1) return { outcome: "confirmed", evidence: { newClaims: 1, newClaimNumber: fresh[0] }, warnings: [] };
  return { outcome: "unknown", evidence: { newClaims: fresh.length }, warnings: fresh.length > 1 ? [W_MANUAL] : [] };
}

const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
// Новая заявка, созданная раньше клика больше чем на столько, — не наша (запас на расхождение часов).
const CREATED_SLACK_MS = 5 * 60_000;

/**
 * Время создания заявки ЕЛК (`created`): ISO-подобное `ГГГГ-ММ-ДД[T ]ЧЧ:ММ[:СС[.доли]]` с поясом
 * (`Z`, `±ЧЧ:ММ`) или без него — тогда как МСК (UTC+3, наивное время ЕЛК); `ДД.ММ.ГГГГ ЧЧ:ММ` — МСК;
 * дата без времени — начало суток МСК с `dayOnly`. Не распознано — `null`. Формат поля вживую не
 * зафиксирован, поэтому разбор снисходителен, а отказ разбора не отказывает заказ.
 */
export function parseClaimCreated(raw: unknown): { at: number; dayOnly: boolean } | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let y: number, mo: number, d: number, h = 0, mi = 0, sec = 0, ms = 0;
  let zone: string | undefined;
  let dayOnly = false;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})(?:,?\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    dayOnly = iso[4] === undefined;
    if (!dayOnly) [h, mi, sec, ms] = [Number(iso[4]), Number(iso[5]), Number(iso[6] ?? 0), Number((iso[7] ?? "0").slice(0, 3).padEnd(3, "0"))];
    zone = iso[8];
  } else if (ru) {
    [d, mo, y] = [Number(ru[1]), Number(ru[2]), Number(ru[3])];
    dayOnly = ru[4] === undefined;
    if (!dayOnly) [h, mi, sec] = [Number(ru[4]), Number(ru[5]), Number(ru[6] ?? 0)];
  } else return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  let offset = MSK_OFFSET_MS;
  if (zone === "Z") offset = 0;
  else if (zone) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!m) return null;
    offset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000);
  }
  return { at: utc - offset, dayOnly };
}

/**
 * Окончательный исход заказа (§7, §10). Подтверждено, только если одновременно: (1) ровно одна новая
 * заявка; (2) запрос `process/start` замечен ровно один раз — сам факт запроса, не его статус (ответ
 * 2xx — только сигнал); (3) заявка не создана раньше клика больше чем на 5 минут (время не распознано —
 * предупреждение, но не отказ). Иначе — неизвестно с предупреждением «сверьте вручную». Так чужая
 * заявка (сотрудник, другая вкладка, автоматический процесс), появившаяся при проглоченном клике, не
 * даёт ложного `confirmed`. Номер, сервис и время новой заявки остаются в ответе для ручной сверки;
 * автор — только признаком «тот же логин» (ФИО в ответ не попадает, §8), условием не служит.
 *
 * Отступление от §10 («новая заявка с подходящим сервисом»): у заявки ЕЛК есть только название сервиса
 * (`service`), его соответствие `serviceId` формы (`components`) не установлено ни разведкой (§17), ни
 * данными API, поэтому сервис показывается владельцу в `evidence`, но в решении не участвует.
 */
export function classifyCertificateOutcome(input: {
  before: string[];
  after: Array<Pick<ElkClaim, "num" | "service" | "created" | "createdByEmail">>;
  submitRequests: number;
  clickedAt: number;
  loginEmail: string | null;
}): { outcome: Outcome; evidence: Record<string, unknown>; warnings: string[] } {
  const { before, after, submitRequests, clickedAt, loginEmail } = input;
  const byNumber = claimNumbersOf({ count: after.length, requests: after });
  const step = classifyClaimsOutcome(before, byNumber);
  const startWarning = submitRequests > 1 ? [W_MANY_STARTS] : [];
  if (step.outcome !== "confirmed" || step.evidence.newClaimNumber === undefined) {
    return { outcome: "unknown", evidence: step.evidence, warnings: [...step.warnings, ...startWarning] };
  }
  const num = step.evidence.newClaimNumber;
  const claim = after.find((c) => typeof c.num === "string" && c.num.trim() === num);
  const fold = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
  const evidence = {
    ...step.evidence,
    newClaimService: typeof claim?.service === "string" ? claim.service : null,
    newClaimCreated: typeof claim?.created === "string" ? claim.created : null,
    newClaimByLogin: loginEmail && fold(claim?.createdByEmail) ? fold(claim?.createdByEmail) === fold(loginEmail) : null,
  };
  if (submitRequests === 0) return { outcome: "unknown", evidence, warnings: [W_NO_START] };
  if (submitRequests > 1) return { outcome: "unknown", evidence, warnings: startWarning };
  const created = parseClaimCreated(claim?.created);
  if (!created) return { outcome: "confirmed", evidence, warnings: [W_CREATED_UNPARSED] };
  // Дата без времени — заявка «старая», только если её сутки закончились до клика.
  const latest = created.dayOnly ? created.at + DAY_MS : created.at;
  if (latest < clickedAt - CREATED_SLACK_MS) return { outcome: "unknown", evidence, warnings: [W_CREATED_OLD] };
  return { outcome: "confirmed", evidence, warnings: [] };
}

/** Значения формы, которые должны стоять перед «Отправить»: выбранные варианты поверх прочитанных в сухом прогоне. */
export function expectedFieldValues(form: CertificateForm, plan: CertificatePlan): Array<{ label: string; value: string }> {
  const chosen = new Map(plan.chosen.map((c) => [c.label, c.value]));
  return form.fields.map((f) => ({ label: f.label, value: chosen.get(f.label) ?? f.value }));
}

/** Снимок формы на странице записи: поля без вариантов, кнопки «Отправить», индикатор. */
export interface FormSnapshot {
  items: Array<Omit<RawFormItem, "options">>;
  submitButtons: number;
  submitDisabled: boolean;
  requiredLeft: number[];
}

/**
 * Перепроверка формы на странице записи. `loaded` — страница только открыта: поля (подписи и порядок)
 * те же, что в сухом прогоне, значения прочитанные, «Отправить» одна. `filled` — перед точкой
 * невозврата: то же с ожидаемыми значениями плюс индикатор обязательных пуст или 0, обязательных пустых
 * нет, ни одно значение не требует дополнительного поля, «Отправить» активна. Новое поле, появившееся
 * после выбора варианта, — расхождение набора полей. Тексты — по номерам полей, без подписей и значений.
 */
export function checkFormState(expected: Array<{ label: string; value: string }>, snap: FormSnapshot, stage: "loaded" | "filled"): void {
  const fail = (problem: string): never => {
    throw new Refusal(`${problem}; операция прервана до отправки`);
  };
  const labels = snap.items.map((it) => normalizeLabel(it.label));
  if (labels.length !== expected.length || labels.some((label, i) => label !== expected[i].label)) {
    fail(`набор полей формы не совпадает с сухим прогоном (было ${expected.length}, сейчас ${labels.length}): форма изменилась — выполните сухой прогон заново`);
  }
  snap.items.forEach((it, i) => {
    if (it.kind === "unknown") fail(`поле №${i + 1}: тип поля не поддерживается`);
  });
  snap.items.forEach((it, i) => {
    if (collapse(it.value) !== expected[i].value) fail(`поле №${i + 1}: значение не совпадает с ожидаемым`);
  });
  if (snap.submitButtons !== 1) fail(`кнопка «${SUBMIT_TEXT}»: ожидалась ровно одна, найдено ${snap.submitButtons}`);
  if (stage === "loaded") return;
  const indicator = [...new Set(snap.requiredLeft)];
  if (indicator.length > 1) fail("индикатор обязательных полей формы показывает разные числа");
  if (indicator.length === 1 && indicator[0] !== 0) fail(`форма считает незаполненными обязательных полей: ${indicator[0]}`);
  const empty = snap.items.filter((it) => (it.requiredMark || it.label.includes("*")) && !collapse(it.value)).length;
  if (empty > 0) fail(`обязательных полей не заполнено: ${empty}`);
  snap.items.forEach((it, i) => {
    if (needsExtraInput(it.value)) fail(`поле №${i + 1}: выбранный вариант требует заполнить дополнительное поле`);
  });
  if (snap.submitDisabled) fail(`кнопка «${SUBMIT_TEXT}» неактивна после заполнения формы`);
}

/**
 * Шов только для проверок (одноразовые скрипты на заготовках): подмена чтения истории заявок и
 * сокращение ожидания новой заявки. В рабочем коде не меняется.
 */
export const certificateTestSeams: {
  listRequests: (opts: ResourceCallOptions) => Promise<{ count: number; requests: ElkClaim[] }>;
  claimsWaitMs: number;
  claimsPollMs: number;
} = { listRequests: (opts) => listRequests(CLAIMS_LIMIT, opts), claimsWaitMs: CLAIMS_WAIT_MS, claimsPollMs: CLAIMS_POLL_MS };

// --- Чтение страницы ---

/** Снимок поля без раскрытия списка. Значение списка — из `.el-select__placeholder` (Element Plus ≥ 2.5). */
async function readItem(item: Locator): Promise<Omit<RawFormItem, "options">> {
  return item.evaluate(
    (el, { unsupported, labelSelectors, asterisk }) => {
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const labelEl = labelSelectors.map((sel) => el.querySelector(sel)).find((x) => x !== null);
      const label = clean(labelEl?.textContent);
      const requiredMark = el.classList.contains("is-required") || el.querySelector(asterisk) !== null;
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
        // Автозаполненные списки живой формы помечены атрибутом `readonly` на самом `.el-select` (без `is-disabled`).
        const disabled =
          select.hasAttribute("readonly") || select.classList.contains("is-disabled") || select.querySelector(".el-select__wrapper.is-disabled") !== null;
        return { ...base, kind: "select" as const, disabled, value: ph.classList.contains("is-transparent") ? "" : clean(ph.textContent) };
      }
      const controls = el.querySelectorAll('input:not([type="hidden"]), textarea');
      if (controls.length !== 1) return { ...base, kind: "unknown" as const };
      const control = controls[0] as HTMLInputElement | HTMLTextAreaElement;
      return { ...base, kind: "input" as const, disabled: control.disabled || control.readOnly, value: control.value };
    },
    { unsupported: UNSUPPORTED_CONTROLS, labelSelectors: LABEL_SELECTORS, asterisk: SEL_ASTERISK }
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
/** Ожидание отрисовки формы и автозаполнения; возвращает локатор «Отправить» (точное имя). */
async function waitForForm(page: Page): Promise<Locator> {
  try {
    await page.locator(SEL_ITEM).filter({ visible: true }).first().waitFor({ state: "visible", timeout: FORM_WAIT_MS });
  } catch {
    throw new Refusal("форма заказа справки не отрисовалась (проверьте serviceId — это число components из url в elk_search_services)");
  }
  // Автозаполнение подтягивается запросами после отрисовки.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  const submit = page.getByRole("button", { name: SUBMIT_TEXT, exact: true });
  await submit.first().waitFor({ state: "attached", timeout: SUBMIT_WAIT_MS }).catch(() => {});
  return submit;
}

export async function readCertificateForm(page: Page): Promise<CertificateForm> {
  const submit = await waitForForm(page);

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

// --- Запись: заполнение формы и перепроверка ---

const leafItems = (page: Page) => page.locator(SEL_LEAF_ITEM).filter({ visible: true });

/** «Отправить» неактивна: атрибут `disabled`/`aria-disabled` или класс Element Plus `is-disabled`. */
async function buttonDisabled(button: Locator): Promise<boolean> {
  if (await button.isDisabled()) return true;
  return button.evaluate((el) => el.classList.contains("is-disabled") || el.getAttribute("aria-disabled") === "true");
}

/** Снимок формы на странице записи для `checkFormState`; ничего не нажимает. */
async function readFormSnapshot(page: Page, submit: Locator): Promise<FormSnapshot> {
  const items = leafItems(page);
  const count = await items.count();
  const raw: FormSnapshot["items"] = [];
  for (let i = 0; i < count; i++) raw.push(await readItem(items.nth(i)));
  const submitButtons = await submit.count();
  const submitDisabled = submitButtons === 1 ? await buttonDisabled(submit) : true;
  const bodyText = await page.locator("body").innerText();
  const requiredLeft = [...bodyText.matchAll(REQUIRED_LEFT_RE)].map((m) => Number(m[1]));
  return { items: raw, submitButtons, submitDisabled, requiredLeft };
}

/**
 * Выбор одного варианта (§17, восьмой проход): поле — ровно одно с этой подписью; открытых списков
 * нет → один клик по обёртке `.el-select` → ровно одно видимое окно → ровно один доступный вариант с
 * точным текстом → один клик по нему → окно закрылось (не закрылось само — один `Escape`) → значение
 * поля равно выбранному. `n` — номер поля в сухом прогоне: тексты отказов без подписей и значений.
 */
async function selectOption(page: Page, label: string, value: string, n: number, signal: AbortSignal): Promise<void> {
  const tail = "операция прервана до отправки";
  const items = leafItems(page);
  const labels = (
    await items.evaluateAll(
      (els, sels) => els.map((el) => sels.map((sel) => el.querySelector(sel)).find((x) => x !== null)?.textContent ?? ""),
      LABEL_SELECTORS
    )
  ).map(normalizeLabel);
  const at = labels.flatMap((l, i) => (l === label ? [i] : []));
  if (at.length !== 1) throw new Refusal(`поле №${n}: на форме найдено полей с этой подписью — ${at.length}, ожидалось одно; ${tail}`);
  const item = items.nth(at[0]);
  if ((await visibleDropdowns(page).count()) !== 0) throw new Refusal(`перед выбором в поле №${n} уже раскрыт другой список; ${tail}`);
  const select = item.locator(SEL_SELECT);
  if ((await select.count()) !== 1) throw new Refusal(`поле №${n}: ожидался ровно один выпадающий список; ${tail}`);
  // Только для чтения (автозаполнение) или недоступный список не открывается никогда.
  const locked = await select.evaluate((el) => el.hasAttribute("readonly") || el.classList.contains("is-disabled"));
  if (locked) throw new Refusal(`поле №${n}: список недоступен для выбора; ${tail}`);
  await select.click();
  try {
    await visibleDropdowns(page).first().waitFor({ state: "visible", timeout: DROPDOWN_WAIT_MS });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Refusal(`список вариантов поля №${n} не раскрылся; ${tail}`);
  }
  const open = visibleDropdowns(page);
  if ((await open.count()) !== 1) throw new Refusal(`при выборе в поле №${n} раскрыт не один список вариантов; ${tail}`);
  const options = open.locator(SEL_OPTION);
  const texts = await options.evaluateAll((els) =>
    els.map((e) => ({
      text: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
      usable: !e.classList.contains("is-disabled") && e.getClientRects().length > 0,
    }))
  );
  const match = texts.flatMap((o, i) => (o.usable && o.text === value ? [i] : []));
  if (match.length !== 1) throw new Refusal(`поле №${n}: нужный вариант в списке найден ${match.length} раз, ожидался один; ${tail}`);
  signal.throwIfAborted();
  await options.nth(match[0]).click();
  // Element Plus закрывает список одиночного выбора сам; если нет — один `Escape` (он ничего не отправляет).
  const closed = () =>
    visibleDropdowns(page)
      .first()
      .waitFor({ state: "hidden", timeout: DROPDOWN_WAIT_MS })
      .then(
        () => true,
        () => false
      );
  if (!(await closed())) {
    signal.throwIfAborted();
    await page.keyboard.press("Escape");
    if (!(await closed())) throw new Refusal(`список вариантов поля №${n} не закрылся после выбора; ${tail}`);
  }
  if (collapse((await readItem(item)).value) !== value) throw new Refusal(`поле №${n}: выбранный вариант не встал в поле; ${tail}`);
}

const isStartRequest = (req: Request): boolean => {
  if (req.method() !== "POST") return false;
  try {
    const u = new URL(req.url());
    return u.origin === BASE_URL && u.pathname === START_PATH;
  } catch {
    return false;
  }
};

/** Что известно об отправке после точки невозврата; заполняется по ходу, чтобы пережить сбой страницы. */
export interface SubmitTrace {
  clickedAt: number;
  clickError: boolean;
  submitRequests: number;
  submitStatus: number | null;
  /** После точки невозврата страница показала JS-диалог (он отклонён): объясняет неизвестный исход. */
  dialogAfterCommit: boolean;
}

/**
 * Страница записи: заполнение → перепроверка → `commitPoint` → один клик «Отправить» → ожидание ответа
 * `process/start`. До точки невозврата не-GET запросы страницы отклоняются (страховка: Service Worker
 * этот перехват обходит), и любая такая попытка к ЕЛК — отказ; перехват снимается до `commitPoint`,
 * чтобы настоящий клик дошёл до системы. Исключение `commitPoint` пробрасывается (очищенным), клика нет.
 */
async function fillAndSubmit(
  page: Page,
  pageCtx: PageCallContext,
  observed: CertificateObserved,
  ctx: ExecuteContext,
  trace: SubmitTrace,
  onCommitted: () => void
): Promise<void> {
  const tail = "операция прервана до отправки";
  let blocked = 0;
  const blocker = (route: Route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fallback();
    try {
      if (new URL(req.url()).origin === BASE_URL) blocked++;
    } catch {
      blocked++;
    }
    return route.abort("blockedbyclient");
  };
  await page.route("**/*", blocker);
  let dialog = false;
  // После проверок `guard` уже не действует: диалог (например, `confirm` на «Отправить») отклоняется и
  // фиксируется в следе — без замеченного запроса заказа исход будет «неизвестно».
  let guarded = true;
  page.on("dialog", (d) => {
    if (guarded) dialog = true;
    else trace.dialogAfterCommit = true;
    d.dismiss().catch(() => {});
  });
  const guard = () => {
    if (dialog) throw new Refusal(`страница показала неожиданный диалог; ${tail}`);
    if (blocked > 0) throw new Refusal(`форма попыталась отправить данные до нажатия «${SUBMIT_TEXT}»; ${tail}`);
  };

  const { form, plan } = observed;
  const submit = await waitForForm(page);
  // Страница открыта заново: форма та же, что в сухом прогоне (поля, порядок, автозаполнение).
  checkFormState(expectedFieldValues(form, { ...plan, chosen: [] }), await readFormSnapshot(page, submit), "loaded");
  const numberOf = new Map(form.fields.map((f, i) => [f.label, i + 1]));
  for (const c of plan.chosen) {
    pageCtx.signal.throwIfAborted();
    guard();
    await selectOption(page, c.label, c.value, numberOf.get(c.label) ?? 0, pageCtx.signal);
  }
  // Дорисовка зависимых полей и пересчёт индикатора — после выбора.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  if ((await visibleDropdowns(page).count()) !== 0) throw new Refusal(`после заполнения раскрыт список вариантов; ${tail}`);
  checkFormState(expectedFieldValues(form, plan), await readFormSnapshot(page, submit), "filled");
  // Счётчик — до снятия перехвата: запрос заказа, ушедший в этом промежутке, тоже будет учтён.
  page.on("request", (req) => {
    if (isStartRequest(req)) trace.submitRequests++;
  });
  await page.unroute("**/*", blocker);
  guard();
  pageCtx.signal.throwIfAborted();
  guarded = false;

  // Точка невозврата: дальше только один клик, ожидание и чтение.
  try {
    await ctx.commitPoint(pageCtx);
  } catch (err) {
    throw sanitizeCommitError(err);
  }
  onCommitted();
  const response = page.waitForResponse((r) => isStartRequest(r.request()), { timeout: START_RESPONSE_WAIT_MS }).then(
    (r) => r.status(),
    () => null
  );
  trace.clickedAt = Date.now();
  try {
    await submit.click({ timeout: CLICK_TIMEOUT_MS });
  } catch {
    // Дошёл ли клик до страницы, неизвестно: повтора нет, исход решит история заявок.
    trace.clickError = true;
  }
  trace.submitStatus = await response;
}

/**
 * Опрос истории заявок после клика (`maxAgeMs: 0`) до `claimsWaitMs` от клика: первое чтение с новой
 * заявкой (или несколькими) завершает опрос. Возвращается последний удачно прочитанный список (номера
 * распознаны); сбой чтения — следующая попытка; ни одного удачного чтения — `null`.
 */
async function pollNewClaims(before: string[], since: number, signal: AbortSignal): Promise<ElkClaim[] | null> {
  const deadline = since + certificateTestSeams.claimsWaitMs;
  let last: ElkClaim[] | null = null;
  for (;;) {
    try {
      const list = await certificateTestSeams.listRequests({ maxAgeMs: 0, signal });
      const nums = claimNumbersOf(list);
      last = list.requests;
      if (classifyClaimsOutcome(before, nums).evidence.newClaims > 0) return last;
    } catch {
      // Неудачное чтение — не исход: пробуем снова до конца окна.
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal.aborted) return last;
    try {
      await abortableSleep(Math.min(certificateTestSeams.claimsPollMs, left), signal);
    } catch {
      return last;
    }
  }
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
const W_NOT_READ = `история заявок ЕЛК после заказа не прочиталась: ${MANUAL_WHERE}`;
const W_DIALOG_AFTER_COMMIT = `после нажатия «Отправить» страница показала диалог, он отклонён: заказ мог не уйти — ${MANUAL_WHERE}`;
// Снимок номеров до заказа живёт только в памяти записи, поэтому повтор не может доказать, чья заявка новая.
const W_VERIFY_ONLY = `проверка повтора не может установить, создал ли заявку прежний вызов (снимок заявок до заказа не хранится): ${MANUAL_WHERE}; число заявок сейчас — evidence.requestsNow`;

/** Email входа — только для признака «заявку создал тот же логин»; не задан — `null` (признак неизвестен). */
function loginEmailOrNull(): string | null {
  try {
    return config.hseEmail;
  } catch {
    return null;
  }
}

/**
 * Исход записи по следу отправки и опросу заявок (`classifyCertificateOutcome`). Диалог после точки
 * невозврата отмечается в `evidence` и при неизвестном исходе объясняется предупреждением.
 */
export function certificateResult(trace: SubmitTrace, before: string[], claims: ElkClaim[] | null): ExecuteResult {
  const sent = {
    clicked: !trace.clickError,
    submitRequests: trace.submitRequests,
    submitStatus: trace.submitStatus,
    dialogAfterCommit: trace.dialogAfterCommit,
  };
  const dialogWarning = trace.dialogAfterCommit ? [W_DIALOG_AFTER_COMMIT] : [];
  if (!claims) {
    return { stage: "sent", outcome: "unknown", evidence: { ...sent, newClaims: null }, warnings: [MANUAL_CHECK_WARNING, W_NOT_READ, ...dialogWarning] };
  }
  const r = classifyCertificateOutcome({
    before,
    after: claims,
    submitRequests: trace.submitRequests,
    clickedAt: trace.clickedAt,
    loginEmail: loginEmailOrNull(),
  });
  return {
    stage: "verified",
    outcome: r.outcome,
    evidence: { ...sent, ...r.evidence },
    warnings: r.outcome === "unknown" ? [MANUAL_CHECK_WARNING, ...r.warnings, ...dialogWarning] : r.warnings,
  };
}

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
  async execute(args, observed, ctx) {
    checkCertificateArgs(args);
    // Второй снимок номеров перед открытием страницы сужает окно, в котором чужая заявка сошла бы за новую:
    // заявка, появившаяся между сухим прогоном и записью, новой не считается. Сбой чтения — отказ до отправки.
    const before = [...new Set([...observed.claimNumbers, ...(await readClaimNumbers(ctx.signal))])];
    const trace: SubmitTrace = { clickedAt: 0, clickError: false, submitRequests: 0, submitStatus: null, dialogAfterCommit: false };
    let committed = false;
    try {
      // Без перехвата чтения (`readFormPage`): своя страница, свой перехват до точки невозврата.
      await withPage(
        formUrl(args.serviceId),
        (page, pageCtx) =>
          fillAndSubmit(page, pageCtx, observed, ctx, trace, () => {
            committed = true;
          }),
        { signal: ctx.signal }
      );
    } catch (err) {
      // До точки невозврата — отказ (ничего не отправлено); после — исход решает проверка, а не ошибка.
      if (!committed) throw sanitizeNavigationError(err, "форма заказа справки");
      if (!trace.clickedAt) {
        // Сбой между точкой невозврата и кликом: клика, скорее всего, не было, но проверка всё равно идёт.
        trace.clickedAt = Date.now();
        trace.clickError = true;
      }
    }
    // Опрос — после закрытия страницы: чтение истории ЕЛК может само открыть страницу (запасной путь
    // client.ts), а вложенный `withPage` запрещён.
    return certificateResult(trace, before, await pollNewClaims(before, trace.clickedAt, ctx.signal));
  },
  async verifyOnly(_args, signal) {
    let requestsNow: number | null = null;
    try {
      requestsNow = claimNumbersOf(await certificateTestSeams.listRequests({ maxAgeMs: 0, signal })).length;
    } catch {
      // Число заявок неизвестно; исход и так «неизвестно».
    }
    return { outcome: "unknown", evidence: { requestsNow }, warnings: [MANUAL_CHECK_WARNING, W_VERIFY_ONLY] };
  },
};
