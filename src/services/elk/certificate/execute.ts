import type { Locator, Page, Request, Route } from "playwright";
import { type PageCallContext, withPage } from "../../../auth/browser-session.js";
import { passCommitPoint, Refusal, sanitizeNavigationError } from "../../writes/errors.js";
import type { ExecuteContext, WriteAdapter } from "../../writes/runner.js";
import { readClaimNumbers } from "./claims.js";
import {
  BASE_URL,
  type CertificateForm,
  collapse,
  DROPDOWN_WAIT_MS,
  formUrl,
  LABEL_SELECTORS,
  needsExtraInput,
  normalizeLabel,
  type RawFormItem,
  REQUIRED_LEFT_RE,
  readItem,
  SEL_LEAF_ITEM,
  SEL_OPTION,
  SEL_SELECT,
  SUBMIT_TEXT,
  visibleDropdowns,
  waitForForm,
} from "./form.js";
import {
  type CertificateArgs,
  type CertificateObserved,
  type CertificatePlan,
  checkCertificateArgs,
} from "./plan.js";
import { certificateResult, pollNewClaims, type SubmitTrace } from "./verify.js";

/**
 * Запись заказа (спека №4 §10, §17, восьмой проход): заполнение формы, перепроверка и один клик
 * «Отправить» после `commitPoint`.
 *
 * Запись покадровая (урок третьего прохода §17): каждый выбор — клик по обёртке списка, клик ровно
 * одного варианта с точным текстом, проверка значения. Перед точкой невозврата форма перечитывается
 * целиком (поля те же, что в сухом прогоне, значения ожидаемые, обязательных пустых нет, «Отправить»
 * одна и активна); первое расхождение — отказ до отправки. Необратимо одно действие — клик «Отправить»,
 * он не повторяется никогда.
 */

// Submit формы (§17, восьмой проход): единственный запрос по «Отправить».
const START_PATH = "/rest-api/camunda-gateway/process/start";

// После точки невозврата всё укладывается в дедлайн коммита (20 с): клик, ответ `process/start`, опрос
// истории заявок до 15 с от клика (ожидание ответа входит в эти 15 с).
const CLICK_TIMEOUT_MS = 5_000;
const START_RESPONSE_WAIT_MS = 10_000;

/** Значения формы, которые должны стоять перед «Отправить»: выбранные варианты поверх прочитанных в сухом прогоне. */
export function expectedFieldValues(
  form: CertificateForm,
  plan: CertificatePlan
): Array<{ label: string; value: string }> {
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
export function checkFormState(
  expected: Array<{ label: string; value: string }>,
  snap: FormSnapshot,
  stage: "loaded" | "filled"
): void {
  const fail = (problem: string): never => {
    throw new Refusal(`${problem}; операция прервана до отправки`);
  };
  const labels = snap.items.map((it) => normalizeLabel(it.label));
  if (labels.length !== expected.length || labels.some((label, i) => label !== expected[i].label)) {
    fail(
      `набор полей формы не совпадает с сухим прогоном (было ${expected.length}, сейчас ${labels.length}): форма изменилась — выполните сухой прогон заново`
    );
  }
  snap.items.forEach((it, i) => {
    if (it.kind === "unknown") fail(`поле №${i + 1}: тип поля не поддерживается`);
  });
  snap.items.forEach((it, i) => {
    if (collapse(it.value) !== expected[i].value)
      fail(`поле №${i + 1}: значение не совпадает с ожидаемым`);
  });
  if (snap.submitButtons !== 1)
    fail(`кнопка «${SUBMIT_TEXT}»: ожидалась ровно одна, найдено ${snap.submitButtons}`);
  if (stage === "loaded") return;
  const indicator = [...new Set(snap.requiredLeft)];
  if (indicator.length > 1) fail("индикатор обязательных полей формы показывает разные числа");
  if (indicator.length === 1 && indicator[0] !== 0)
    fail(`форма считает незаполненными обязательных полей: ${indicator[0]}`);
  const empty = snap.items.filter(
    (it) => (it.requiredMark || it.label.includes("*")) && !collapse(it.value)
  ).length;
  if (empty > 0) fail(`обязательных полей не заполнено: ${empty}`);
  snap.items.forEach((it, i) => {
    if (needsExtraInput(it.value))
      fail(`поле №${i + 1}: выбранный вариант требует заполнить дополнительное поле`);
  });
  if (snap.submitDisabled) fail(`кнопка «${SUBMIT_TEXT}» неактивна после заполнения формы`);
}

// --- Запись: заполнение формы и перепроверка ---

const leafItems = (page: Page) => page.locator(SEL_LEAF_ITEM).filter({ visible: true });

/** «Отправить» неактивна: атрибут `disabled`/`aria-disabled` или класс Element Plus `is-disabled`. */
async function buttonDisabled(button: Locator): Promise<boolean> {
  if (await button.isDisabled()) return true;
  return button.evaluate(
    (el) => el.classList.contains("is-disabled") || el.getAttribute("aria-disabled") === "true"
  );
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
async function selectOption(
  page: Page,
  label: string,
  value: string,
  n: number,
  signal: AbortSignal
): Promise<void> {
  const tail = "операция прервана до отправки";
  const items = leafItems(page);
  const labels = (
    await items.evaluateAll(
      (els, sels) =>
        els.map(
          (el) =>
            sels.map((sel) => el.querySelector(sel)).find((x) => x !== null)?.textContent ?? ""
        ),
      LABEL_SELECTORS
    )
  ).map(normalizeLabel);
  const at = labels.flatMap((l, i) => (l === label ? [i] : []));
  if (at.length !== 1)
    throw new Refusal(
      `поле №${n}: на форме найдено полей с этой подписью — ${at.length}, ожидалось одно; ${tail}`
    );
  const item = items.nth(at[0]);
  if ((await visibleDropdowns(page).count()) !== 0)
    throw new Refusal(`перед выбором в поле №${n} уже раскрыт другой список; ${tail}`);
  const select = item.locator(SEL_SELECT);
  if ((await select.count()) !== 1)
    throw new Refusal(`поле №${n}: ожидался ровно один выпадающий список; ${tail}`);
  // Только для чтения (автозаполнение) или недоступный список не открывается никогда.
  const locked = await select.evaluate(
    (el) => el.hasAttribute("readonly") || el.classList.contains("is-disabled")
  );
  if (locked) throw new Refusal(`поле №${n}: список недоступен для выбора; ${tail}`);
  await select.click();
  try {
    await visibleDropdowns(page).first().waitFor({ state: "visible", timeout: DROPDOWN_WAIT_MS });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Refusal(`список вариантов поля №${n} не раскрылся; ${tail}`);
  }
  const open = visibleDropdowns(page);
  if ((await open.count()) !== 1)
    throw new Refusal(`при выборе в поле №${n} раскрыт не один список вариантов; ${tail}`);
  const options = open.locator(SEL_OPTION);
  const texts = await options.evaluateAll((els) =>
    els.map((e) => ({
      text: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
      usable: !e.classList.contains("is-disabled") && e.getClientRects().length > 0,
    }))
  );
  const match = texts.flatMap((o, i) => (o.usable && o.text === value ? [i] : []));
  if (match.length !== 1)
    throw new Refusal(
      `поле №${n}: нужный вариант в списке найден ${match.length} раз, ожидался один; ${tail}`
    );
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
    if (!(await closed()))
      throw new Refusal(`список вариантов поля №${n} не закрылся после выбора; ${tail}`);
  }
  if (collapse((await readItem(item)).value) !== value)
    throw new Refusal(`поле №${n}: выбранный вариант не встал в поле; ${tail}`);
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
    if (blocked > 0)
      throw new Refusal(`форма попыталась отправить данные до нажатия «${SUBMIT_TEXT}»; ${tail}`);
  };

  const { form, plan } = observed;
  const submit = await waitForForm(page);
  // Страница открыта заново: форма та же, что в сухом прогоне (поля, порядок, автозаполнение).
  checkFormState(
    expectedFieldValues(form, { ...plan, chosen: [] }),
    await readFormSnapshot(page, submit),
    "loaded"
  );
  const numberOf = new Map(form.fields.map((f, i) => [f.label, i + 1]));
  for (const c of plan.chosen) {
    pageCtx.signal.throwIfAborted();
    guard();
    await selectOption(page, c.label, c.value, numberOf.get(c.label) ?? 0, pageCtx.signal);
  }
  // Дорисовка зависимых полей и пересчёт индикатора — после выбора.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  if ((await visibleDropdowns(page).count()) !== 0)
    throw new Refusal(`после заполнения раскрыт список вариантов; ${tail}`);
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
  await passCommitPoint(ctx.commitPoint, pageCtx);
  onCommitted();
  const response = page
    .waitForResponse((r) => isStartRequest(r.request()), { timeout: START_RESPONSE_WAIT_MS })
    .then(
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

export const executeCertificate: WriteAdapter<CertificateArgs, CertificateObserved>["execute"] =
  async (args, observed, ctx) => {
    checkCertificateArgs(args);
    // Второй снимок номеров перед открытием страницы сужает окно, в котором чужая заявка сошла бы за новую:
    // заявка, появившаяся между сухим прогоном и записью, новой не считается. Сбой чтения — отказ до отправки.
    const before = [
      ...new Set([...observed.claimNumbers, ...(await readClaimNumbers(ctx.signal))]),
    ];
    const trace: SubmitTrace = {
      clickedAt: 0,
      clickError: false,
      submitRequests: 0,
      submitStatus: null,
      dialogAfterCommit: false,
    };
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
    // Опрос — после закрытия страницы: чтение истории ЕЛК открывает страницу «Заявки», а вложенный
    // `withPage` запрещён.
    return certificateResult(
      trace,
      before,
      await pollNewClaims(before, trace.clickedAt, ctx.signal)
    );
  };
