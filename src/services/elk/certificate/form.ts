import type { Locator, Page } from "playwright";
import { type PageCallContext, withPage } from "../../../auth/browser-session.js";
import { Refusal, sanitizeNavigationError } from "../../writes/errors.js";

/**
 * Разбор формы заказа `/student-service/student-service-first?components=<serviceId>`: чистый разбор
 * снимка (`buildCertificateForm`) и чтение снимка со страницы. Чтение ничего не выбирает и не нажимает
 * «Отправить»; на время чтения страница отклоняет любые свои не-GET запросы (`readFormPage`).
 */

export const BASE_URL = "https://lk.hse.ru";
export const formUrl = (serviceId: number) =>
  `${BASE_URL}/student-service/student-service-first?components=${serviceId}`;

// Подписи и селекторы — из живой разведки (§17, восьмой проход).
export const SUBMIT_TEXT = "Отправить";
// Живая форма — Formily Element Plus (`.formily-element-plus-form-item`, §17, девятый проход); `.el-form-item`
// оставлен для разметки голого Element Plus (заготовки проверок).
const ITEM_CLASSES = [".formily-element-plus-form-item", ".el-form-item"];
const SEL_ITEM = ITEM_CLASSES.join(", ");
// Только «листовые» поля: обёртки раскладки Formily с вложенными полями сами полем не являются.
export const SEL_LEAF_ITEM = ITEM_CLASSES.map((c) => `${c}:not(:has(${SEL_ITEM}))`).join(", ");
// Подпись поля: первый найденный из этих элементов; звёздочка обязательности в Formily — отдельный элемент.
export const LABEL_SELECTORS = [
  ".formily-element-plus-form-item-label label",
  ".formily-element-plus-form-item-label",
  ".el-form-item__label",
];
const SEL_ASTERISK = ".formily-element-plus-form-item-asterisk";
export const SEL_SELECT = ".el-select";
const SEL_DROPDOWN = ".el-select-dropdown";
export const SEL_OPTION = ".el-select-dropdown__item";
export const REQUIRED_LEFT_RE = /Заполните обязательные поля \((\d+)\)/g;
// Контролы Element Plus, которые v1 не разбирает (дата, переключатель, загрузка файла и т.п.).
const UNSUPPORTED_CONTROLS =
  ".el-date-editor, .el-switch, .el-upload, .el-checkbox, .el-radio, .el-cascader, .el-input-number, .el-slider, .el-rate, .el-color-picker, .el-transfer, .el-tree-select";

const FORM_WAIT_MS = 15_000;
const SUBMIT_WAIT_MS = 5_000;
export const DROPDOWN_WAIT_MS = 5_000;

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

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

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

/**
 * Разбор снимка формы. Обязательность — класс `is-required` или звёздочка в подписи. Индикатор
 * «Заполните обязательные поля (N)», если он есть, обязан совпасть с числом обязательных пустых
 * полей: иначе обязательность распознана не так, как её считает сама форма.
 */
export function buildCertificateForm(raw: RawCertificateForm): CertificateForm {
  if (raw.items.length === 0) throw new Refusal("на странице не найдено полей формы заказа");
  if (raw.submitButtons !== 1) {
    throw new Refusal(
      `кнопка «${SUBMIT_TEXT}»: ожидалась ровно одна, найдено ${raw.submitButtons}`
    );
  }
  const firstByLabel = new Map<string, number>();
  const fields = raw.items.map((item, i): CertificateField => {
    const n = i + 1;
    const label = normalizeLabel(item.label);
    if (!label) throw new Refusal(`поле №${n}: подпись не найдена`);
    if (item.kind === "unknown") throw new Refusal(`поле №${n}: тип поля не поддерживается`);
    const first = firstByLabel.get(label);
    if (first !== undefined) {
      throw new Refusal(
        `подписи полей формы повторяются (поля №${first} и №${n}): поле нельзя выбрать по подписи`
      );
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
  if (indicator.length > 1)
    throw new Refusal("индикатор обязательных полей формы показывает разные числа");
  const requiredLeft = indicator.length === 1 ? indicator[0] : null;
  const requiredEmpty = fields.filter((f) => f.required && !f.value).length;
  if (requiredLeft !== null && requiredLeft !== requiredEmpty) {
    throw new Refusal(
      `форма считает незаполненными обязательных полей: ${requiredLeft}, распознано: ${requiredEmpty} — обязательность полей не распознана`
    );
  }
  return { title: collapse(raw.title), fields, submitDisabled: raw.submitDisabled, requiredLeft };
}

// --- Чтение страницы ---

/** Снимок поля без раскрытия списка. Значение списка — из `.el-select__placeholder` (Element Plus ≥ 2.5). */
export async function readItem(item: Locator): Promise<Omit<RawFormItem, "options">> {
  return item.evaluate(
    (el, { unsupported, labelSelectors, asterisk }) => {
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const labelEl = labelSelectors.map((sel) => el.querySelector(sel)).find((x) => x !== null);
      const label = clean(labelEl?.textContent);
      const requiredMark =
        el.classList.contains("is-required") || el.querySelector(asterisk) !== null;
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
          select.hasAttribute("readonly") ||
          select.classList.contains("is-disabled") ||
          select.querySelector(".el-select__wrapper.is-disabled") !== null;
        return {
          ...base,
          kind: "select" as const,
          disabled,
          value: ph.classList.contains("is-transparent") ? "" : clean(ph.textContent),
        };
      }
      const controls = el.querySelectorAll('input:not([type="hidden"]), textarea');
      if (controls.length !== 1) return { ...base, kind: "unknown" as const };
      const control = controls[0] as HTMLInputElement | HTMLTextAreaElement;
      return {
        ...base,
        kind: "input" as const,
        disabled: control.disabled || control.readOnly,
        value: control.value,
      };
    },
    { unsupported: UNSUPPORTED_CONTROLS, labelSelectors: LABEL_SELECTORS, asterisk: SEL_ASTERISK }
  );
}

export const visibleDropdowns = (page: Page) =>
  page.locator(SEL_DROPDOWN).filter({ visible: true });

/**
 * Варианты одного доступного списка: один клик по обёртке `.el-select`, ровно одно видимое окно
 * вариантов, тексты `.el-select-dropdown__item` (кроме недоступных и скрытых), `Escape`, окно
 * закрылось, значение поля не изменилось. Любое расхождение — отказ.
 */
async function readOptions(
  page: Page,
  item: Locator,
  n: number,
  valueBefore: string
): Promise<string[]> {
  if ((await visibleDropdowns(page).count()) !== 0)
    throw new Refusal(`перед чтением вариантов поля №${n} уже раскрыт другой список`);
  const select = item.locator(SEL_SELECT);
  if ((await select.count()) !== 1)
    throw new Refusal(`поле №${n}: ожидался ровно один выпадающий список`);
  await select.click();
  try {
    await visibleDropdowns(page).first().waitFor({ state: "visible", timeout: DROPDOWN_WAIT_MS });
  } catch {
    throw new Refusal(`список вариантов поля №${n} не раскрылся`);
  }
  const open = visibleDropdowns(page);
  if ((await open.count()) !== 1)
    throw new Refusal(`при чтении поля №${n} раскрыт не один список вариантов`);
  const options = await open
    .locator(SEL_OPTION)
    .evaluateAll((els) =>
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
    throw new Refusal(
      `значение поля №${n} изменилось при чтении вариантов: форма ведёт себя неожиданно`
    );
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
export async function waitForForm(page: Page): Promise<Locator> {
  try {
    await page
      .locator(SEL_ITEM)
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: FORM_WAIT_MS });
  } catch {
    throw new Refusal(
      "форма заказа справки не отрисовалась (проверьте serviceId — это число components из url в elk_search_services)"
    );
  }
  // Автозаполнение подтягивается запросами после отрисовки.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  const submit = page.getByRole("button", { name: SUBMIT_TEXT, exact: true });
  await submit
    .first()
    .waitFor({ state: "attached", timeout: SUBMIT_WAIT_MS })
    .catch(() => {});
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
  buildCertificateForm({
    title: "",
    items: raw,
    submitButtons,
    submitDisabled: true,
    requiredLeft,
  });

  const submitDisabled = await submit.isDisabled();
  for (let i = 0; i < count; i++) {
    const it = raw[i];
    if (it.kind === "select" && !it.disabled)
      raw[i] = { ...it, options: await readOptions(page, items.nth(i), i + 1, it.value) };
  }
  // Число полей не изменилось за время чтения (раскрытие списков не дорисовало новых).
  if ((await items.count()) !== count)
    throw new Refusal("набор полей формы изменился во время чтения");
  return buildCertificateForm({
    title: await readTitle(page),
    items: raw,
    submitButtons,
    submitDisabled,
    requiredLeft,
  });
}

/**
 * `withPage` с очисткой ошибок от URL (адрес формы содержит `components=<id>`); собственные отказы
 * проходят как есть. На время чтения страница отклоняет свои не-GET запросы: даже если форма что-то
 * отправит сама (например, по раскрытию списка), до системы это не дойдёт.
 */
export async function readFormPage<T>(
  url: string,
  fn: (page: Page, ctx: PageCallContext) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
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
