import crypto from "node:crypto";
import path from "node:path";
import type { Page } from "playwright";
import { withPage } from "../../auth/browser-session.js";
import { resolveOutboxFiles, type OutboxFile } from "../writes/outbox.js";
import { classifyError, type WriteAdapter } from "../writes/runner.js";

/**
 * Сдача, правка и удаление ответа на задание SmartLMS (спека №4 §9, §9.1). Здесь — читающая
 * половина адаптеров записи: разбор страницы статуса `/mod/assign/view.php?id=<cmid>` и формы правки
 * (`action=editsubmission`), предусловия сухого прогона, описание для владельца и отпечаток
 * состояния для `previewToken`. Все селекторы и подписи — из живой разведки (спека §17).
 *
 * Неожиданное состояние страницы (незнакомый класс статуса, нет нужной строки или кнопки) — отказ,
 * а не догадка. Тексты ошибок не содержат ни имён файлов, ни URL, ни текста страницы.
 */

const BASE_URL = "https://edu.hse.ru";

const viewUrl = (cmid: number) => `${BASE_URL}/mod/assign/view.php?id=${cmid}`;
// Открытие формы правки записи сдачи не создаёт (§17, седьмой проход: 5 заданий из 5); «Сохранить» и
// «Отмена» сухой прогон не нажимает, страница закрывается `page.close()` из `withPage`.
const editUrl = (cmid: number) => `${BASE_URL}/mod/assign/view.php?id=${cmid}&action=editsubmission`;

// Подписи строк таблицы статуса и кнопок (§17; разведка — `docs/recon.md`, подпроект 4).
const ROW_STATUS = "Состояние ответа на задание";
const ROW_REMAINING = "Оставшееся время";
const ROW_MODIFIED = "Последнее изменение";
const BTN_ADD = "Добавить ответ на задание";
const BTN_EDIT = "Редактировать ответ";
const BTN_DELETE = "Удалить ответ";
const BTN_FINALIZE = "Отправить на оценку";
// Классы ячейки статуса: `submissionstatussubmitted` подтверждён вживую, `submissiondraft` — по
// спеке (не наблюдался); любой другой `submissionstatus*` — состояние не распознано.
const CLASS_SUBMITTED = "submissionstatussubmitted";
const CLASS_DRAFT = "submissiondraft";
const CLASS_STATUS_PREFIX = "submissionstatus";

export interface AssignmentView {
  cmid: number;
  title: string;
  state: "none" | "submitted" | "draft" | "unknown";
  closed: { reason: "offsite" | "overdue" | "not-open" | "other"; text: string } | null;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canFinalize: boolean;
  dueText: string | null;
  lastModified: string | null;
  files: Array<{ name: string; size: number; sha256: string }>;
}

export interface EditFormInfo {
  fileOnly: boolean;
  maxBytes: number | null;
  maxFiles: number | null;
  managerFiles: string[];
}

export interface SubmitArgs {
  cmid: number;
  mode: "draft" | "submit";
  files: string[];
  text?: string;
}

export interface DeleteArgs {
  cmid: number;
}

/** Наблюдение сухого прогона сдачи: страница статуса, форма правки, проверенные файлы «исходящих». */
export interface SubmitObserved {
  view: AssignmentView;
  form: EditFormInfo;
  files: OutboxFile[];
}

export interface DeleteObserved {
  view: AssignmentView;
}

/** Строка таблицы статуса: подпись из `th`, текст и классы первой `td`. */
export interface RawStatusRow {
  label: string;
  text: string;
  classes: string[];
}

/** Сырой снимок страницы статуса — всё, что разбор берёт из DOM. */
export interface RawAssignmentPage {
  title: string;
  rows: RawStatusRow[];
  /** Строки видимого текста страницы (пробелы схлопнуты): отсюда «Открыто с» и «Срок сдачи». */
  lines: string[];
  buttons: string[];
  fileLinks: Array<{ name: string; href: string }>;
}

/** Сырой снимок формы правки. */
export interface RawEditForm {
  /** На странице есть `input[name="submitbutton"]` — это форма правки. */
  hasForm: boolean;
  hasFileManager: boolean;
  hasTextEditor: boolean;
  text: string;
  managerFiles: string[];
}

export interface SubmissionPlan {
  add: Array<{ name: string; size: number }>;
  replace: Array<{ name: string; size: number; currentSize: number }>;
  /** Файлов в ответе после сохранения (уникальные по имени). */
  total: number;
}

/** Собственный отказ модуля: текст составлен здесь и безопасен для ответа тула (без URL, имён, id). */
export class Refusal extends Error {}

/**
 * Ошибка открытия или чтения страницы → текст без URL. Сообщения Playwright (`page.goto`, журнал
 * вызова) и дедлайн `withPage` содержат адрес с query, то есть id задания, а в ответ тула он попадать
 * не должен (спека §8). `Refusal` проходит как есть; прочее заменяется нейтральным текстом, который
 * сохраняет то, по чему `classifyError` различает класс: имя `AbortError`/`TimeoutError`, «не уложил»,
 * «отменен», код `ERR_…`, «вход (401)». Исходная ошибка в `cause` не кладётся.
 */
export function sanitizeNavigationError(err: unknown, what = "страница задания"): Error {
  if (err instanceof Refusal) return err;
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  const message = err instanceof Error || err instanceof DOMException ? err.message : String(err);
  let text: string;
  switch (classifyError(err)) {
    case "timeout":
      text = `${what} не уложилась в отведённое время`;
      break;
    case "cancelled":
      text = "операция отменена";
      break;
    case "network": {
      const code = /\bERR_[A-Z0-9_]+/.exec(message)?.[0];
      text = `${what} не открылась: ошибка сети ${code ?? "(fetch)"}`;
      break;
    }
    case "auth":
      text = `${what} не открылась: требуется вход (401)`;
      break;
    default:
      text = `${what}: не удалось открыть или прочитать`;
  }
  const clean = new Error(text);
  if (name === "AbortError" || name === "TimeoutError") clean.name = name;
  return clean;
}

/** `withPage` с очисткой ошибок от URL; собственные отказы проходят как есть. */
async function readPage<T>(url: string, fn: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await withPage(url, fn, { signal });
  } catch (err) {
    throw sanitizeNavigationError(err);
  }
}

const sha256Hex = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const RU_DATE_RE = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join("|")})\\s+(\\d{4})(?:,?\\s*(\\d{1,2}):(\\d{2}))?`, "i");
// Moodle показывает даты в поясе пользователя; у аккаунтов ВШЭ это Москва (UTC+3 без перехода).
const MSK_OFFSET_MS = 3 * 3_600_000;

/** «среда, 1 октября 2026, 00:00» (время МСК) → момент; не распознано — `null`. */
export function parseRuDateTime(text: string): Date | null {
  const m = RU_DATE_RE.exec(text);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2].toLowerCase());
  const year = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  if (hour > 23 || minute > 59) return null;
  const utc = new Date(Date.UTC(year, month, day, hour, minute));
  if (utc.getUTCDate() !== day || utc.getUTCMonth() !== month) return null;
  return new Date(utc.getTime() - MSK_OFFSET_MS);
}

const UNITS: Record<string, number> = { байт: 1, кбайт: 1024, мбайт: 1024 ** 2, гбайт: 1024 ** 3 };

/**
 * Подпись лимитов формы правки (§17): «Максимальный размер новых файлов: 5 Мбайт, максимальное
 * количество прикрепленных файлов: 20». Не найдено или единица незнакома — `null` (лимит неизвестен).
 */
export function parseEditLimits(text: string): { maxBytes: number | null; maxFiles: number | null } {
  const size = /Максимальный размер новых файлов:\s*(\d+(?:[.,]\d+)?)\s*(Гбайт|Мбайт|Кбайт|байт)(?![\p{L}])/iu.exec(text);
  const count = /максимальное количество прикрепл[её]нных файлов:\s*(\d+)/i.exec(text);
  const unit = size ? UNITS[size[2].toLowerCase()] : undefined;
  return {
    maxBytes: size && unit ? Math.floor(Number(size[1].replace(",", ".")) * unit) : null,
    maxFiles: count ? Number(count[1]) : null,
  };
}

/** Значение строки «<подпись>: значение» из видимого текста страницы. */
function lineValue(lines: string[], label: string): string | null {
  for (const line of lines) {
    if (!line.startsWith(label)) continue;
    const value = line.slice(label.length).replace(/^:?\s*/, "").trim();
    if (value) return value;
  }
  return null;
}

function stateOf(row: RawStatusRow | undefined): AssignmentView["state"] {
  if (!row) return "unknown";
  if (row.classes.includes(CLASS_SUBMITTED)) return "submitted";
  if (row.classes.includes(CLASS_DRAFT)) return "draft";
  if (row.classes.some((c) => c.startsWith(CLASS_STATUS_PREFIX))) return "unknown";
  // У несданных ячейка статуса без класса `submissionstatus*` (§17).
  return "none";
}

/**
 * Разбор снимка страницы статуса. Закрытая сдача различается по тексту (§17, седьмой проход):
 * «…представлен вне сайта» в «Состоянии ответа», «Задание просрочено на» в «Оставшемся времени»,
 * «Открыто с» в будущем; не сдано и нет ни одной кнопки сдачи — «иное».
 */
export function buildAssignmentView(
  raw: RawAssignmentPage,
  cmid: number,
  files: AssignmentView["files"],
  now: Date = new Date()
): AssignmentView {
  const rowOf = (label: string) => raw.rows.find((r) => r.label === label);
  const status = rowOf(ROW_STATUS);
  const remaining = rowOf(ROW_REMAINING);
  const modified = rowOf(ROW_MODIFIED)?.text ?? "";
  const hasButton = (text: string) => raw.buttons.some((b) => b.includes(text));
  const canAdd = hasButton(BTN_ADD);
  const canEdit = hasButton(BTN_EDIT);
  const state = stateOf(status);
  const statusText = status?.text ?? "";
  const remainingText = remaining?.text ?? "";
  const openFrom = lineValue(raw.lines, "Открыто с");

  let closed: AssignmentView["closed"] = null;
  if (/вне сайта/i.test(statusText)) {
    closed = { reason: "offsite", text: statusText };
  } else if (/просрочено на/i.test(remainingText) || /просрочено на/i.test(statusText)) {
    closed = { reason: "overdue", text: /просрочено на/i.test(remainingText) ? remainingText : statusText };
  } else {
    const from = openFrom ? parseRuDateTime(openFrom) : null;
    if (from && from.getTime() > now.getTime()) closed = { reason: "not-open", text: `Открыто с: ${openFrom}` };
    else if (state === "none" && !canAdd && !canEdit) closed = { reason: "other", text: statusText };
  }

  return {
    cmid,
    title: raw.title,
    state,
    closed,
    canAdd,
    canEdit,
    canDelete: hasButton(BTN_DELETE),
    canFinalize: hasButton(BTN_FINALIZE),
    dueText: lineValue(raw.lines, "Срок сдачи"),
    lastModified: modified && modified !== "-" ? modified : null,
    files,
  };
}

/** «Только файл»: есть файловый менеджер и нет текстового редактора (§17, второй и седьмой проходы). */
export function buildEditFormInfo(raw: Omit<RawEditForm, "hasForm">): EditFormInfo {
  return {
    fileOnly: raw.hasFileManager && !raw.hasTextEditor,
    ...parseEditLimits(raw.text),
    managerFiles: raw.managerFiles,
  };
}

/** Отпечаток состояния цели для `previewToken`: sha256 от JSON `{state, files}`, порядок файлов не важен. */
export function stateFingerprint(view: Pick<AssignmentView, "state" | "files">): string {
  const files = view.files
    .map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  return sha256Hex(JSON.stringify({ state: view.state, files }));
}

function checkCmid(cmid: unknown): void {
  if (typeof cmid !== "number" || !Number.isSafeInteger(cmid) || cmid <= 0) {
    throw new Refusal("cmid должен быть положительным целым числом");
  }
}

/** Отказы по самим аргументам — до любого обращения к диску и к системе. */
export function checkSubmitArgs(args: SubmitArgs): void {
  if (args.text !== undefined) throw new Refusal("онлайн-текст в v1 не поддерживается");
  checkCmid(args.cmid);
  if (args.mode !== "draft" && args.mode !== "submit") throw new Refusal("mode должен быть draft или submit");
  if (!Array.isArray(args.files) || args.files.length === 0) throw new Refusal("отправка без файлов не поддерживается");
}

const CLOSED_REFUSAL: Record<NonNullable<AssignmentView["closed"]>["reason"], string> = {
  offsite: "ответ на это задание представляется вне сайта: сдача через SmartLMS не предусмотрена",
  overdue: "задание просрочено: приём ответов закрыт",
  "not-open": "приём ответов на задание ещё не открыт",
  other: "приём ответов на задание закрыт (причина на странице не распознана)",
};

/** Предусловия по странице статуса: их проверяют до открытия формы правки. */
function checkSubmittable(view: AssignmentView): void {
  if (view.state === "unknown") throw new Refusal("состояние ответа на странице задания не распознано");
  if (view.closed) throw new Refusal(CLOSED_REFUSAL[view.closed.reason]);
  if (!view.canAdd && !view.canEdit) throw new Refusal("нельзя добавить или править ответ");
}

const fold = (s: string) => s.toLowerCase();

/** Имя, под которым файл уйдёт в Moodle: настоящее имя на диске, а не написание модели. */
const diskName = (f: OutboxFile) => path.basename(f.absPath);

function formatBytes(n: number): string {
  if (n >= 1024 ** 2 && n % 1024 ** 2 === 0) return `${n / 1024 ** 2} Мбайт`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} Кбайт`;
  return `${n} байт`;
}

/**
 * Предусловия сухого прогона сдачи и план: какие файлы ответа заменятся (одноимённые), какие
 * добавятся. Имя, совпадающее с файлом ответа только с точностью до регистра, — отказ: заменит его
 * Moodle или добавит второй, неизвестно.
 */
export function planSubmission(view: AssignmentView, form: EditFormInfo, files: OutboxFile[]): SubmissionPlan {
  checkSubmittable(view);
  if (!form.fileOnly) throw new Refusal("задание принимает не только файлы: в v1 поддерживается только сдача файлом");

  const existing = new Map(view.files.map((f) => [f.name, f]));
  const existingFolded = new Set(view.files.map((f) => fold(f.name)));
  const add: SubmissionPlan["add"] = [];
  const replace: SubmissionPlan["replace"] = [];
  files.forEach((f, i) => {
    const name = diskName(f);
    const same = existing.get(name);
    if (same) replace.push({ name, size: f.size, currentSize: same.size });
    else if (existingFolded.has(fold(name))) {
      throw new Refusal(`файл №${i + 1}: имя отличается от файла ответа только регистром букв — переименуйте файл`);
    } else add.push({ name, size: f.size });
  });

  const total = existing.size + add.length;
  if (form.maxFiles !== null && total > form.maxFiles) {
    throw new Refusal(`файлов в ответе будет больше, чем разрешает задание: не более ${form.maxFiles}`);
  }
  if (form.maxBytes !== null) {
    const maxBytes = form.maxBytes;
    files.forEach((f, i) => {
      if (f.size > maxBytes) throw new Refusal(`файл №${i + 1} больше допустимого размера задания (${formatBytes(maxBytes)})`);
    });
  }
  return { add, replace, total };
}

/** Удаление: нужен представленный ответ и кнопка «Удалить ответ» на странице статуса. */
export function checkDeletePreconditions(view: AssignmentView): void {
  if (view.state === "unknown") throw new Refusal("состояние ответа на странице задания не распознано");
  if (view.state === "none") throw new Refusal("нечего удалять: ответ на задание не представлен");
  if (!view.canDelete) throw new Refusal("удалить ответ нельзя: на странице задания нет кнопки «Удалить ответ»");
}

async function extractAssignmentPage(page: Page): Promise<RawAssignmentPage> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const rows: Array<{ label: string; text: string; classes: string[] }> = [];
    for (const tr of Array.from(document.querySelectorAll("tr"))) {
      const th = tr.querySelector("th");
      const td = tr.querySelector("td");
      if (!th || !td) continue;
      rows.push({ label: clean(th.textContent).replace(/:$/, ""), text: clean(td.textContent), classes: Array.from(td.classList) });
    }
    const heading = document.querySelector('[role="main"] h2, main h2');
    const seen = new Set<string>();
    const fileLinks: Array<{ name: string; href: string }> = [];
    for (const el of Array.from(document.querySelectorAll('.fileuploadsubmission a[href*="pluginfile"]'))) {
      const a = el as HTMLAnchorElement;
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      fileLinks.push({ name: clean(a.textContent), href: a.href });
    }
    return {
      title: clean(heading?.textContent) || clean(document.title),
      rows,
      lines: document.body.innerText.split("\n").map(clean).filter(Boolean),
      buttons: Array.from(document.querySelectorAll("button")).map((b) => clean(b.textContent)).filter(Boolean),
      fileLinks,
    };
  });
}

/**
 * Байты файла ответа: обычный GET ссылки `pluginfile` из самой страницы (её cookies), sha256 — в Node
 * (§9.1, девятый проход). Переадресация (например, на вход) — отказ: хэшировать чужую страницу нельзя.
 */
async function downloadSubmissionFile(page: Page, href: string, n: number): Promise<{ size: number; sha256: string }> {
  const r = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok || res.redirected) return null;
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return dataUrl.slice(dataUrl.indexOf(",") + 1);
    } catch {
      return null;
    }
  }, href);
  if (r === null) throw new Refusal(`Файл ответа №${n} не скачался со страницы задания`);
  const bytes = Buffer.from(r, "base64");
  return { size: bytes.length, sha256: sha256Hex(bytes) };
}

/** Разбор страницы статуса; страница уже на `view.php?id=<cmid>`. Файлы ответа скачиваются для sha256. */
export async function readAssignmentView(page: Page, cmid: number): Promise<AssignmentView> {
  const raw = await extractAssignmentPage(page);
  const files: AssignmentView["files"] = [];
  for (const [i, link] of raw.fileLinks.entries()) {
    if (!link.name) throw new Refusal(`Файл ответа №${i + 1}: имя на странице не найдено`);
    files.push({ name: link.name, ...(await downloadSubmissionFile(page, link.href, i + 1)) });
  }
  return buildAssignmentView(raw, cmid, files);
}

async function extractEditForm(page: Page): Promise<RawEditForm> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const submit = document.querySelector('input[name="submitbutton"]');
    // Всё ищется внутри формы с «Сохранить»; без неё — по всей странице (тогда hasForm = false).
    const scope: ParentNode = submit?.closest("form") ?? document;
    return {
      hasForm: submit !== null,
      hasFileManager: scope.querySelector(".filemanager") !== null,
      // Atto и TinyMCE в Moodle строятся поверх textarea; любое текстовое поле — не «только файл».
      hasTextEditor: scope.querySelector('textarea, [contenteditable]:not([contenteditable="false"])') !== null,
      text: (scope instanceof HTMLElement ? scope : document.body).innerText,
      managerFiles: Array.from(scope.querySelectorAll(".filemanager .fp-filename"))
        .map((e) => clean(e.textContent))
        .filter(Boolean),
    };
  });
}

/** Разбор формы правки; страница уже на `action=editsubmission`. Ничего не нажимает. */
export async function readEditFormInfo(page: Page): Promise<EditFormInfo> {
  return buildEditFormInfo(await extractEditForm(page));
}

const STATE_TEXT: Record<AssignmentView["state"], string> = {
  none: "ответ не представлен",
  submitted: "отправлено для оценивания",
  draft: "черновик",
  unknown: "не распознано",
};

const W_SAVE_MAY_SUBMIT = "сохранение может сразу отправить работу на оценку (у проверенных заданий отдельного шага нет)";
const W_FORM_OPENED = "форма правки открывалась и не сохранялась";

const notImplemented = async (): Promise<never> => {
  throw new Error("не реализовано");
};

const targetOf = (args: { cmid: number }) => `assign:${args.cmid}`;

function viewSummary(view: AssignmentView) {
  return {
    title: view.title,
    due: view.dueText,
    state: view.state,
    stateText: STATE_TEXT[view.state],
    lastModified: view.lastModified,
  };
}

export const submitAdapter: WriteAdapter<SubmitArgs, SubmitObserved> = {
  op: "lms_submit_assignment",
  invalidates: ["lms.assignments", "lms.calendar"],
  targetOf,
  async observe(args, signal) {
    checkSubmitArgs(args);
    const files = await resolveOutboxFiles(args.files);
    const view = await readPage(viewUrl(args.cmid), (page) => readAssignmentView(page, args.cmid), signal);
    checkSubmittable(view);
    const form = await readPage(
      editUrl(args.cmid),
      async (page) => {
        // Файловый менеджер дорисовывает список файлов запросом после загрузки страницы.
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        const raw = await extractEditForm(page);
        if (!raw.hasForm) throw new Refusal("форма правки ответа не открылась");
        return buildEditFormInfo(raw);
      },
      signal
    );
    planSubmission(view, form, files);
    return { view, form, files };
  },
  describe(args, { view, form, files }) {
    const plan = planSubmission(view, form, files);
    const warnings = [W_SAVE_MAY_SUBMIT, W_FORM_OPENED];
    if (view.state === "submitted") warnings.push("ответ уже отправлен на оценку: сохранение изменит отправленную работу");
    if (plan.replace.length > 0) warnings.push("одноимённые файлы ответа будут перезаписаны");
    if (form.maxBytes === null || form.maxFiles === null) {
      warnings.push("лимит размера или числа файлов на форме не найден: проверку выполнит Moodle");
    }
    return {
      preview: {
        action: view.state === "none" ? "новый ответ" : "правка ответа",
        mode: args.mode,
        ...viewSummary(view),
        currentFiles: view.files.map((f) => ({ name: f.name, size: f.size })),
        replace: plan.replace,
        add: plan.add,
        filesAfter: plan.total,
        limits: { maxBytes: form.maxBytes, maxFiles: form.maxFiles },
      },
      warnings,
    };
  },
  payloadOf(args, { view, files }) {
    return {
      mode: args.mode,
      files: files.map((f) => ({ name: diskName(f), sha256: f.sha256 })),
      state: stateFingerprint(view),
    };
  },
  execute: notImplemented,
  verifyOnly: notImplemented,
};

export const deleteAdapter: WriteAdapter<DeleteArgs, DeleteObserved> = {
  op: "lms_delete_submission",
  invalidates: ["lms.assignments", "lms.calendar"],
  targetOf,
  async observe(args, signal) {
    checkCmid(args.cmid);
    const view = await readPage(viewUrl(args.cmid), (page) => readAssignmentView(page, args.cmid), signal);
    checkDeletePreconditions(view);
    return { view };
  },
  describe(_args, { view }) {
    return {
      preview: { ...viewSummary(view), files: view.files.map((f) => ({ name: f.name, size: f.size })) },
      warnings: [
        "удаление необратимо: ответ и его файлы будут удалены из системы; файлы в папке «исходящих» не трогаются",
      ],
    };
  },
  payloadOf(_args, { view }) {
    return { files: [], state: stateFingerprint(view) };
  },
  execute: notImplemented,
  verifyOnly: notImplemented,
};
