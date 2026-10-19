import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { withPage, type PageCallContext } from "../../auth/browser-session.js";
import { COMMIT_DEADLINE_MS } from "../../commit.js";
import { resolveOutboxFiles, type OutboxFile } from "../writes/outbox.js";
import { classifyError, type CommitPoint, type ExecuteResult, type WriteAdapter } from "../writes/runner.js";

/**
 * Сдача, правка и удаление ответа на задание SmartLMS (спека №4 §9, §9.1): разбор страницы статуса
 * `/mod/assign/view.php?id=<cmid>` и формы правки (`action=editsubmission`), предусловия сухого
 * прогона, описание для владельца, отпечаток состояния для `previewToken`, сама запись через
 * файловый менеджер Moodle и проверка чтением (§7). Все селекторы и подписи — из живой разведки
 * (спека §17).
 *
 * Неожиданное состояние страницы (незнакомый класс статуса, нет нужной строки или кнопки) — отказ,
 * а не догадка. Тексты ошибок не содержат ни имён файлов, ни URL, ни текста страницы.
 *
 * Запись покадровая (урок третьего прохода §17): каждый шаг — одно действие по точному селектору
 * (ровно один видимый элемент) и проверка состояния после него; первое расхождение — отказ до точки
 * невозврата. Необратимо только одно действие на операцию: «Сохранить» или «Продолжить».
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
// спеке (не наблюдался); любой другой `submissionstatus*` или два таких класса сразу — не распознано.
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

/**
 * `withPage` с очисткой ошибок от URL; собственные отказы проходят как есть. Через неё идёт любое
 * обращение к странице, и запись тоже: исключение `commitPoint` пробрасывается (очищенным), а не
 * глотается.
 */
async function readPage<T>(url: string, fn: (page: Page, ctx: PageCallContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
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
  const marks = row.classes.filter((c) => c === CLASS_DRAFT || c.startsWith(CLASS_STATUS_PREFIX));
  // У несданных ячейка статуса без класса `submissionstatus*` (§17).
  if (marks.length === 0) return "none";
  // Два признака сразу (например, «отправлено» и «черновик») — противоречие: отказ, а не выбор одного.
  if (marks.length > 1) return "unknown";
  if (marks[0] === CLASS_SUBMITTED) return "submitted";
  if (marks[0] === CLASS_DRAFT) return "draft";
  return "unknown";
}

/** Есть ли повторы имён без учёта регистра (одноимённые файлы во вложенных папках ответа). */
function hasDuplicateNames(names: string[]): boolean {
  return new Set(names.map(fold)).size !== names.length;
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
  // Одноимённые файлы ответа (вложенные папки) по имени не различить: состояние не распознано.
  const state = hasDuplicateNames(files.map((f) => f.name)) ? "unknown" : stateOf(status);
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
  if (hasDuplicateNames(view.files.map((f) => f.name))) {
    throw new Refusal("в ответе несколько файлов с одинаковым именем (вложенные папки): такой ответ тул не правит");
  }
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

/**
 * Одинаковы ли списки имён как мультимножества без учёта регистра. Регистр не различается, потому
 * что `planSubmission` уже отказывает на именах, различающихся только регистром; повторы различаются:
 * `a.txt` и `A.txt` против `a.txt` и `b.txt` — не совпадение.
 */
export function sameFileSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = actual.map(fold).sort();
  const e = expected.map(fold).sort();
  return a.every((name, i) => name === e[i]);
}

/** Ожидаемый список файлового менеджера после загрузки: существующие ∪ новые (одноимённый заменяется). */
export function expectedManagerFiles(existing: string[], added: string[]): string[] {
  const result = [...existing];
  for (const name of added) if (!result.some((n) => fold(n) === fold(name))) result.push(name);
  return result;
}

export interface ExpectedFile {
  name: string;
  sha256: string;
}

/**
 * Присланные файлы против файлов ответа на странице статуса (§7, §9.1): имя на месте ровно один раз
 * (без учёта регистра) и sha256 скачанного равен sha256 отправленного.
 */
export function compareFiles(
  expected: ExpectedFile[],
  actual: AssignmentView["files"]
): { namesMatch: boolean; contentMatch: boolean } {
  let namesMatch = true;
  let contentMatch = true;
  for (const e of expected) {
    const found = actual.filter((f) => fold(f.name) === fold(e.name));
    if (found.length !== 1) {
      namesMatch = false;
      contentMatch = false;
    } else if (found[0].sha256 !== e.sha256) contentMatch = false;
  }
  return { namesMatch, contentMatch };
}

const W_SUBMITTED_ON_SAVE = "работа отправлена на оценку сразу при сохранении: у этого задания нет отдельного шага «Отправить на оценку»";
const W_DRAFT_ONLY = "ответ сохранён черновиком и на оценку не отправлен: отдельный шаг «Отправить на оценку» тул в v1 не выполняет";

/**
 * Исход сдачи по свежему чтению страницы статуса (§7). Файлы совпали: `submitted` — подтверждено
 * (при `draft` с предупреждением, что работа уже отправлена), `draft` — подтверждено для `draft` и
 * `unknown`/`draft-saved` для `submit`; иное состояние (в том числе нераспознанный класс) — `unknown`.
 * Файлы не совпали: `rejected` только при явной ошибке Moodle на странице и неизменном состоянии
 * относительно `before`; без `before` (проверка повтора) `rejected` не бывает. `expectedTotal` —
 * сколько файлов должно быть в ответе (существующие ∪ присланные), если это известно. С `before`
 * нетронутые файлы ответа (не одноимённые присланным) тоже сверяются: каждый на месте ровно один раз с
 * прежним sha256 (`untouchedMatch`); «Последнее изменение» попадает в `evidence`
 * (`lastModifiedChanged`), но условием подтверждения не служит (§9.1: признак — байты). Проверка
 * повтора (без `before`) сравнивает только присланные файлы. В `evidence` только нейтральные
 * признаки, без имён.
 */
export function classifySubmitOutcome(input: {
  mode: SubmitArgs["mode"];
  expected: ExpectedFile[];
  after: AssignmentView;
  before?: AssignmentView | null;
  expectedTotal?: number | null;
  errorShown?: boolean;
}): ExecuteResult {
  const { mode, expected, after, before, expectedTotal } = input;
  const errorShown = input.errorShown === true;
  const { namesMatch, contentMatch } = compareFiles(expected, after.files);
  let untouchedMatch = true;
  let extra = {};
  if (before) {
    const sent = new Set(expected.map((e) => fold(e.name)));
    const untouched = before.files.filter((f) => !sent.has(fold(f.name))).map((f) => ({ name: f.name, sha256: f.sha256 }));
    const kept = compareFiles(untouched, after.files);
    untouchedMatch = kept.namesMatch && kept.contentMatch;
    extra = { untouchedMatch, lastModifiedChanged: before.lastModified !== after.lastModified };
  }
  const evidence = { state: after.state, files: after.files.length, namesMatch, contentMatch, errorShown, ...extra };
  const filesOk = namesMatch && contentMatch && untouchedMatch && (expectedTotal == null || after.files.length === expectedTotal);
  if (filesOk) {
    if (after.state === "submitted") {
      return { stage: "verified", outcome: "confirmed", evidence, warnings: mode === "draft" ? [W_SUBMITTED_ON_SAVE] : [] };
    }
    if (after.state === "draft") {
      return mode === "draft"
        ? { stage: "verified", outcome: "confirmed", evidence, warnings: [] }
        : { stage: "draft-saved", outcome: "unknown", evidence, warnings: [W_DRAFT_ONLY] };
    }
    return { stage: "verified", outcome: "unknown", evidence, warnings: [] };
  }
  if (errorShown && before && stateFingerprint(before) === stateFingerprint(after)) {
    return { stage: "verified", outcome: "rejected", evidence, warnings: [] };
  }
  return { stage: "verified", outcome: "unknown", evidence, warnings: [] };
}

/**
 * Исход удаления (§9.1): ответа нет, файлов нет, кнопка «Добавить ответ на задание» на месте —
 * подтверждено; явная ошибка и состояние не изменилось относительно `before` — `rejected`; иначе
 * `unknown`. Без `before` (проверка повтора) `rejected` не бывает.
 */
export function classifyDeleteOutcome(input: {
  after: AssignmentView;
  before?: AssignmentView | null;
  errorShown?: boolean;
}): ExecuteResult {
  const { after, before } = input;
  const errorShown = input.errorShown === true;
  const evidence = { state: after.state, files: after.files.length, canAdd: after.canAdd, errorShown };
  if (after.state === "none" && after.canAdd && after.files.length === 0) {
    return { stage: "verified", outcome: "confirmed", evidence, warnings: [] };
  }
  if (errorShown && before && stateFingerprint(before) === stateFingerprint(after)) {
    return { stage: "verified", outcome: "rejected", evidence, warnings: [] };
  }
  return { stage: "verified", outcome: "unknown", evidence, warnings: [] };
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

// Предел файла ответа, скачиваемого для sha256: байты идут из страницы в Node одним base64-значением.
const MAX_VERIFY_DOWNLOAD = 64 * 1024 * 1024;

/** Файл ответа больше `MAX_VERIFY_DOWNLOAD`: проверить содержимое нельзя (проверка повтора даёт `unknown`). */
class FileTooLarge extends Refusal {}

/**
 * Байты файла ответа: обычный GET ссылки `pluginfile` из самой страницы (её cookies), sha256 — в Node
 * (§9.1, девятый проход). Переадресация (например, на вход) — отказ: хэшировать чужую страницу нельзя.
 * Крупнее `MAX_VERIFY_DOWNLOAD` (по `Content-Length` или по факту чтения, до сборки base64) — отказ.
 */
async function downloadSubmissionFile(page: Page, href: string, n: number): Promise<{ size: number; sha256: string }> {
  const r = await page.evaluate(
    async ({ url, max }) => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok || res.redirected) return null;
        const declared = Number(res.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > max) {
          await res.body?.cancel().catch(() => {});
          return { tooLarge: true as const };
        }
        // Тело читается по частям: без `Content-Length` предел проверяется до сборки всего файла.
        const chunks: BlobPart[] = [];
        let total = 0;
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > max) {
              await reader.cancel().catch(() => {});
              return { tooLarge: true as const };
            }
            chunks.push(value as BlobPart);
          }
        }
        const blob = new Blob(chunks);
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
      } catch {
        return null;
      }
    },
    { url: href, max: MAX_VERIFY_DOWNLOAD }
  );
  if (r === null) throw new Refusal(`Файл ответа №${n} не скачался со страницы задания`);
  const tooLarge = () => new FileTooLarge(`файл ответа №${n} слишком большой для проверки`);
  if ("tooLarge" in r) throw tooLarge();
  const bytes = Buffer.from(r.data, "base64");
  if (bytes.length > MAX_VERIFY_DOWNLOAD) throw tooLarge();
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

// --- Запись: шаги файлового менеджера (§17, четвёртый и шестой проходы) ---

const SEL_ADD = 'a[title="Добавить..."]:visible';
const SEL_PICKER = ".file-picker:visible";
// Форма загрузки показывается только на вкладке «Загрузить файл»: её видимость и есть проверка вкладки.
const SEL_UPLOAD_FORM = ".file-picker:visible .fp-upload-form:visible";
const SEL_UPLOAD_INPUT = `${SEL_UPLOAD_FORM} input[name="repo_upload_file"]`;
const SEL_UPLOAD_BTN = `${SEL_UPLOAD_FORM} .fp-upload-btn:visible`;
const SEL_OVERWRITE = 'button:visible:has-text("Перезаписать")';
const SEL_PICKER_ERROR = ".fp-msg-error:visible";
const SEL_SAVE = 'input[name="submitbutton"]';
const SEL_DELETE = 'button:visible:has-text("Удалить ответ")';
const SEL_CONTINUE = 'button:visible:has-text("Продолжить")';
const SEL_MOODLE_ERROR = ".alert-danger:visible, .moodle-exception-message:visible";
const DUP_TEXT = "Файл с этим именем уже был прикреплен";
const CONFIRM_DELETE_TEXT = "Вы уверены, что хотите удалить представленный ответ";

const POLL_MS = 100;
const STEP_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 20_000;
// Ожидание страницы статуса после «Сохранить»/«Продолжить»: половина дедлайна коммита, вторая —
// на чтение и скачивание файлов для проверки.
const VIEW_WAIT_MS = COMMIT_DEADLINE_MS / 2;
// Весь этап до точки невозврата (открытие формы и загрузка всех файлов) делит один дедлайн — 45 с по
// умолчанию у ресурса записи (`defineResource` задаёт дедлайн на ресурс, а не на вызов) и у `withPage`.
// Прибавка на файл здесь не действовала бы: ресурс прервёт вызов раньше.

// Предел буфера Playwright в `setInputFiles` (≈50 МБ); крупнее — проверенная копия во временной папке.
const MAX_UPLOAD_BUFFER = 48 * 1024 * 1024;
const UPLOAD_TMP_PREFIX = "hsemcp-upload-";
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Что передаётся в `setInputFiles`: байты в памяти либо путь к проверенной копии. */
export interface PreparedUpload {
  files: string | { name: string; mimeType: string; buffer: Buffer };
  /** Убирает временную копию; для буфера ничего не делает. */
  cleanup(): Promise<void>;
}

async function hashAt(p: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(p)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha256: hash.digest("hex") };
}

/**
 * Байты для загрузки — те, что покрыты токеном. Путь в `setInputFiles` не передаётся: Chromium читал
 * бы файл в момент запроса пикера, и правка или подмена файла «исходящих» после сухого прогона ушла
 * бы в систему. Файл читается один раз в Node, размер и sha256 сверяются с наблюдением `observe`;
 * крупнее предела буфера — копия во временной папке под тем же именем, сверяется именно копия, и она
 * же загружается. Расхождение или ошибка чтения — отказ без имени и пути (до точки невозврата).
 */
export async function prepareUpload(file: OutboxFile, n: number, opts: { maxBuffer?: number } = {}): Promise<PreparedUpload> {
  const changed = () => new Refusal(`файл №${n} изменился после сухого прогона: выполните сухой прогон заново; операция прервана`);
  const name = diskName(file);
  if (file.size <= (opts.maxBuffer ?? MAX_UPLOAD_BUFFER)) {
    let buffer: Buffer;
    try {
      if ((await fs.promises.stat(file.absPath)).size !== file.size) throw changed();
      buffer = await fs.promises.readFile(file.absPath);
    } catch {
      throw changed();
    }
    if (buffer.length !== file.size || sha256Hex(buffer) !== file.sha256) throw changed();
    const mimeType = MIME_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    return { files: { name, mimeType, buffer }, cleanup: async () => {} };
  }
  // Сбой временной папки, копирования или чтения копии — свой текст (не «изменился») и без пути.
  const notPrepared = () => new Refusal(`не удалось подготовить файл №${n} к отправке; операция прервана`);
  let dir: string;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), UPLOAD_TMP_PREFIX));
  } catch {
    throw notPrepared();
  }
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const copy = path.join(dir, name);
    let actual: { size: number; sha256: string };
    try {
      await fs.promises.copyFile(file.absPath, copy, fs.constants.COPYFILE_EXCL);
      actual = await hashAt(copy);
    } catch {
      throw notPrepared();
    }
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw changed();
    return { files: copy, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Ровно один элемент по селектору (селекторы с `:visible`), иначе отказ: неожиданная страница. */
async function exactlyOne(page: Page, selector: string, what: string): Promise<Locator> {
  const loc = page.locator(selector);
  const n = await loc.count();
  if (n !== 1) throw new Refusal(`${what}: ожидался ровно один элемент, найдено ${n}; операция прервана`);
  return loc;
}

/** Один клик по единственному элементу; повторов нет (урок третьего прохода §17). */
async function clickOnce(page: Page, selector: string, what: string): Promise<void> {
  await (await exactlyOne(page, selector, what)).click();
}

const visibleCount = (page: Page, selector: string) => page.locator(selector).count();
const dupDialogShown = async (page: Page) =>
  (await page.getByText(DUP_TEXT).filter({ visible: true }).count()) > 0 || (await visibleCount(page, SEL_OVERWRITE)) > 0;

/**
 * Ждёт появления элемента; не появился — отказ с понятной причиной. Отмена и дедлайн страницы
 * (сигнал `withPage`) пробрасываются как есть, чтобы не маскировать их под отказ.
 */
async function waitShown(page: Page, selector: string, refusal: string, signal: AbortSignal): Promise<void> {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Refusal(refusal);
  }
}

/**
 * Неожиданные события страницы: системный диалог выбора файла (штатный путь его не открывает,
 * §17, четвёртый проход) и JS-диалоги. Диалог закрывается, следующая проверка отказывает.
 */
function guardPage(page: Page): () => void {
  let problem: string | null = null;
  page.on("filechooser", () => {
    problem ??= "открылся системный диалог выбора файла";
  });
  page.on("dialog", (dialog) => {
    problem ??= "страница показала неожиданный диалог";
    dialog.dismiss().catch(() => {});
  });
  return () => {
    if (problem) throw new Refusal(`${problem}; операция прервана`);
  };
}

/** Имена в файловом менеджере формы — тем же способом, что в `extractEditForm`. */
async function managerNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".filemanager .fp-filename"))
      .map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
}

/**
 * Один файл в файловый менеджер. Сначала байты сверяются с наблюдением `observe` (`prepareUpload`) —
 * до первого клика в менеджере; временная копия крупного файла убирается после загрузки.
 */
async function attachFile(
  page: Page,
  file: OutboxFile,
  n: number,
  replace: boolean,
  check: () => void,
  signal: AbortSignal
): Promise<void> {
  const prepared = await prepareUpload(file, n);
  try {
    await uploadPrepared(page, file, prepared.files, n, replace, check, signal);
  } finally {
    await prepared.cleanup();
  }
}

/**
 * Клик «Добавить...» → вкладка «Загрузить файл» → `setInputFiles` проверенных байтов → клик
 * «Загрузить этот файл» → при одноимённом файле только «Перезаписать» → пикер закрыт, имя в списке.
 * `replace` — имя уже есть в менеджере: тогда диалог одноимённого файла обязателен (§17, шестой
 * проход), без него — отказ по таймауту; для нового имени диалог — отказ.
 */
async function uploadPrepared(
  page: Page,
  file: OutboxFile,
  upload: PreparedUpload["files"],
  n: number,
  replace: boolean,
  check: () => void,
  signal: AbortSignal
): Promise<void> {
  const name = diskName(file);
  check();
  if ((await visibleCount(page, SEL_PICKER)) > 0 || (await dupDialogShown(page))) {
    throw new Refusal("файловый пикер или диалог уже открыт до загрузки; операция прервана");
  }
  await clickOnce(page, SEL_ADD, "кнопка «Добавить...» файлового менеджера");
  await waitShown(page, SEL_PICKER, "файловый пикер не открылся; операция прервана", signal);
  check();
  await waitShown(page, SEL_UPLOAD_FORM, "в файловом пикере не активна вкладка «Загрузить файл»; операция прервана", signal);
  const input = await exactlyOne(page, SEL_UPLOAD_INPUT, "поле файла на вкладке «Загрузить файл»");
  await input.setInputFiles(upload);
  const picked = await input.evaluate((el) =>
    Array.from((el as HTMLInputElement).files ?? []).map((f) => ({ name: f.name, size: f.size }))
  );
  if (picked.length !== 1 || picked[0].name !== name || picked[0].size !== file.size) {
    throw new Refusal(`файл №${n} не попал в поле загрузки; операция прервана`);
  }
  check();
  await clickOnce(page, SEL_UPLOAD_BTN, "кнопка «Загрузить этот файл»");

  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  let overwritten = false;
  for (;;) {
    check();
    signal.throwIfAborted();
    if ((await visibleCount(page, SEL_PICKER_ERROR)) > 0) {
      throw new Refusal(`файловый пикер сообщил об ошибке при загрузке файла №${n}; операция прервана`);
    }
    const dup = await dupDialogShown(page);
    if (dup && !overwritten) {
      if (!replace) throw new Refusal(`неожиданный диалог одноимённого файла для файла №${n}; операция прервана`);
      if ((await page.getByText(DUP_TEXT).filter({ visible: true }).count()) === 0) {
        throw new Refusal("диалог одноимённого файла не распознан; операция прервана");
      }
      // «Переименовать» не нажимается никогда (§9.1): только «Перезаписать», ровно один раз.
      await clickOnce(page, SEL_OVERWRITE, "кнопка «Перезаписать»");
      overwritten = true;
    } else if (!dup && (overwritten || !replace) && (await visibleCount(page, SEL_PICKER)) === 0) {
      if ((await managerNames(page)).some((x) => fold(x) === fold(name))) return;
    }
    if (Date.now() > deadline) throw new Refusal(`файл №${n} не загрузился в файловый менеджер за отведённое время; операция прервана`);
    await page.waitForTimeout(POLL_MS);
  }
}

/**
 * Предусловие точки невозврата (§17, третий и четвёртый проходы): пикер и диалоги закрыты, ошибок
 * пикера нет, на форме один файловый менеджер, папок нет, имена ровно ожидаемые, «Сохранить» одна.
 */
async function assertManagerState(page: Page, expected: string[], check: () => void): Promise<Locator> {
  check();
  if ((await visibleCount(page, SEL_PICKER)) > 0) throw new Refusal("файловый пикер не закрылся; операция прервана до отправки");
  if (await dupDialogShown(page)) throw new Refusal("диалог одноимённого файла не закрылся; операция прервана до отправки");
  if ((await visibleCount(page, SEL_PICKER_ERROR)) > 0) throw new Refusal("файловый пикер показывает ошибку; операция прервана до отправки");
  if ((await page.locator(".filemanager").count()) !== 1) throw new Refusal("на форме не один файловый менеджер; операция прервана до отправки");
  if ((await page.locator(".filemanager .fp-folder").count()) > 0) {
    throw new Refusal("в файловом менеджере появилась папка; операция прервана до отправки");
  }
  if (!sameFileSet(await managerNames(page), expected)) {
    throw new Refusal("список файлов в файловом менеджере не совпадает с ожидаемым; операция прервана до отправки");
  }
  return exactlyOne(page, SEL_SAVE, "кнопка «Сохранить»");
}

/** Страница статуса того же задания после POST: Moodle переадресует на `action=view`. */
function isViewUrl(url: URL, cmid: number, action = "view"): boolean {
  return url.pathname.endsWith("/mod/assign/view.php") && url.searchParams.get("id") === String(cmid) && url.searchParams.get("action") === action;
}

const moodleErrorShown = async (page: Page) => (await visibleCount(page, SEL_MOODLE_ERROR)) > 0;

/**
 * Отказ `commitPoint` → текст без путей с тем же классом `classifyError`: дедлайн — «не уложился» (имя
 * `AbortError`/`TimeoutError` сохраняется), отмена — «операция отменена», вызов уже завершён — так и
 * сказано; прочее — сбой журнала записей (иных причин у `commitPoint` нет, а текст ошибки файловой
 * системы несёт путь). Результат — `Refusal`, поэтому `readPage` не заменяет его на «не удалось открыть».
 */
export function sanitizeCommitError(err: unknown): Refusal {
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  const message = err instanceof Error || err instanceof DOMException ? err.message : String(err);
  let text: string;
  switch (classifyError(err)) {
    case "timeout":
      text = "вызов не уложился в отведённое время до точки невозврата";
      break;
    case "cancelled":
      text = "операция отменена";
      break;
    default:
      text = /точка невозврата недоступна/.test(message)
        ? "вызов уже завершён, точка невозврата недоступна"
        : "не удалось записать журнал записей перед отправкой";
  }
  const clean = new Refusal(text);
  if (name === "AbortError" || name === "TimeoutError") clean.name = name;
  return clean;
}

/** Форма, которую отправит кнопка: метод и путь с учётом `formmethod`/`formaction`, скрытые поля. */
export interface RawButtonForm {
  hasForm: boolean;
  method: string;
  /** Путь адреса отправки на том же сайте; другой сайт или неразобранный адрес — `null`. */
  actionPath: string | null;
  fields: Array<{ name: string; value: string }>;
}

type ButtonFormKind = "save" | "delete" | "continue";

// Только то, что зафиксировано разведкой. «Сохранить»: `POST /mod/assign/view.php`, скрытые
// `lastmodified`, `id`, `userid`, `action`, `_qf__mod_assign_submission_form`, `files_filemanager` (§17,
// второй проход). «Удалить ответ»: GET на `action=removesubmissionconfirm` (§9.1). «Продолжить»: POST с
// полями `id`, `action`, `userid`, `sesskey` (§17, шестой проход). Значение `action` у «Сохранить» и
// «Продолжить» в §17 не записано — проверяется только наличие поля.
const BUTTON_FORMS: Record<ButtonFormKind, { what: string; method: "get" | "post"; action?: string; required: string[]; tail: string }> = {
  save: {
    what: "кнопки «Сохранить»",
    method: "post",
    required: ["lastmodified", "userid", "action", "_qf__mod_assign_submission_form", "files_filemanager"],
    tail: "операция прервана до отправки",
  },
  delete: { what: "кнопки «Удалить ответ»", method: "get", action: "removesubmissionconfirm", required: ["action"], tail: "операция прервана" },
  continue: { what: "кнопки «Продолжить»", method: "post", required: ["action", "userid", "sesskey"], tail: "операция прервана до отправки" },
};

/**
 * Проверка формы кнопки до клика (и до точки невозврата): метод, адрес `/mod/assign/view.php` того же
 * сайта, ровно одно поле `id` со значением `cmid`, обязательные скрытые поля по одному и непустые.
 * «Удалить ответ» обязана быть GET-переходом на подтверждение, а не прямой отправкой. Расхождение — отказ;
 * в тексте нет ни значений полей, ни id.
 */
export function checkButtonForm(raw: RawButtonForm, kind: ButtonFormKind, cmid: number): void {
  const rule = BUTTON_FORMS[kind];
  const fail = (problem: string): never => {
    throw new Refusal(`форма ${rule.what}: ${problem}; ${rule.tail}`);
  };
  if (!raw.hasForm) fail("кнопка не в форме");
  if (raw.method !== rule.method) fail("неожиданный метод отправки");
  if (raw.actionPath === null || !raw.actionPath.endsWith("/mod/assign/view.php")) fail("неожиданный адрес отправки");
  const values = (name: string) => raw.fields.filter((f) => f.name === name).map((f) => f.value);
  const ids = values("id");
  if (ids.length !== 1 || ids[0] !== String(cmid)) fail("поле id не совпадает с заданием");
  for (const name of rule.required) {
    const v = values(name);
    if (v.length !== 1 || v[0] === "") fail("нет обязательного скрытого поля или оно повторяется");
  }
  if (rule.action !== undefined && values("action")[0] !== rule.action) fail("неожиданное действие формы");
}

/** Снимок формы кнопки для `checkButtonForm`; ничего не нажимает. */
async function readButtonForm(button: Locator): Promise<RawButtonForm> {
  return button.evaluate((el) => {
    const b = el as HTMLButtonElement | HTMLInputElement;
    const form = b.form;
    if (!form) return { hasForm: false, method: "", actionPath: null, fields: [] };
    // getAttribute, а не form.method/form.action: поле с name="action" затеняет свойство формы.
    const method = (b.getAttribute("formmethod") ?? form.getAttribute("method") ?? "").trim().toLowerCase() || "get";
    let actionPath: string | null = null;
    try {
      const u = new URL(b.getAttribute("formaction") ?? form.getAttribute("action") ?? "", document.baseURI);
      if (u.origin === location.origin) actionPath = u.pathname;
    } catch {
      // адрес не разобран — null
    }
    const fields = Array.from(form.elements)
      .filter((e): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === "hidden" && e.name !== "")
      .map((e) => ({ name: e.name, value: e.value }));
    return { hasForm: true, method, actionPath, fields };
  });
}

/** Кнопка проверена по своей форме (`checkButtonForm`); возвращается она же. */
async function checkedButton(button: Locator, kind: ButtonFormKind, cmid: number): Promise<Locator> {
  checkButtonForm(await readButtonForm(button), kind, cmid);
  return button;
}

/**
 * Единственный необратимый клик: `commitPoint` → клик → ожидание страницы статуса. Отказ `commitPoint`
 * не проглатывается: он пробрасывается дальше (очищенным `sanitizeCommitError`), клика нет. Не дошли до
 * страницы статуса — `false`: исход определит вызывающий как `unknown`.
 */
async function commitAndClick(
  page: Page,
  pageCtx: PageCallContext,
  button: Locator,
  cmid: number,
  commitPoint: CommitPoint
): Promise<boolean> {
  try {
    await commitPoint(pageCtx);
  } catch (err) {
    throw sanitizeCommitError(err);
  }
  const reached = page.waitForURL((u) => isViewUrl(u, cmid), { timeout: VIEW_WAIT_MS }).then(
    () => true,
    () => false
  );
  await button.click();
  return reached;
}

const NOT_REACHED = (errorShown: boolean): ExecuteResult => ({
  stage: "sent",
  outcome: "unknown",
  evidence: { reachedView: false, errorShown },
  warnings: [],
});

const tooLargeToVerify = () => ({
  outcome: "unknown" as const,
  evidence: { tooLargeToVerify: true },
  warnings: ["файл ответа слишком большой для проверки содержимого: исход не определён"],
});

/** Чтение для проверки повтора; файл ответа крупнее предела — `null` (исход `unknown`, а не ошибка тула). */
async function readForVerify(cmid: number, signal?: AbortSignal): Promise<AssignmentView | null> {
  try {
    return await readPage(viewUrl(cmid), (page) => readAssignmentView(page, cmid), signal);
  } catch (err) {
    if (err instanceof FileTooLarge) return null;
    throw err;
  }
}

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
  async execute(args, { view, files }, ctx) {
    checkSubmitArgs(args);
    const expected = files.map((f) => ({ name: diskName(f), sha256: f.sha256 }));
    return readPage(
      editUrl(args.cmid),
      async (page, pageCtx) => {
        const check = guardPage(page);
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
        // Предусловия заново, как в observe: форма та же, что показана в сухом прогоне.
        const raw = await extractEditForm(page);
        if (!raw.hasForm) throw new Refusal("форма правки ответа не открылась");
        const form = buildEditFormInfo(raw);
        const plan = planSubmission(view, form, files);
        if (!sameFileSet(form.managerFiles, view.files.map((f) => f.name))) {
          throw new Refusal("файлы в форме правки не совпадают с ответом на странице задания: состояние изменилось после сухого прогона");
        }
        let manager = form.managerFiles;
        for (const [i, file] of files.entries()) {
          const replace = manager.some((m) => fold(m) === fold(diskName(file)));
          await attachFile(page, file, i + 1, replace, check, pageCtx.signal);
          manager = expectedManagerFiles(manager, [diskName(file)]);
        }
        const save = await checkedButton(await assertManagerState(page, manager, check), "save", args.cmid);
        check();

        // Точка невозврата: дальше только ожидание и чтение.
        if (!(await commitAndClick(page, pageCtx, save, args.cmid, ctx.commitPoint))) {
          return NOT_REACHED(await moodleErrorShown(page).catch(() => false));
        }
        const errorShown = await moodleErrorShown(page);
        const after = await readAssignmentView(page, args.cmid);
        return classifySubmitOutcome({ mode: args.mode, expected, after, before: view, expectedTotal: plan.total, errorShown });
      },
      ctx.signal
    );
  },
  async verifyOnly(args, signal) {
    checkSubmitArgs(args);
    const files = await resolveOutboxFiles(args.files);
    const expected = files.map((f) => ({ name: diskName(f), sha256: f.sha256 }));
    const after = await readForVerify(args.cmid, signal);
    if (!after) return tooLargeToVerify();
    // Без `before`: проверка повтора не выносит `rejected`.
    const { outcome, evidence, warnings } = classifySubmitOutcome({ mode: args.mode, expected, after });
    return { outcome: outcome === "rejected" ? "unknown" : outcome, evidence, warnings };
  },
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
  async execute(args, { view }, ctx) {
    checkCmid(args.cmid);
    return readPage(
      viewUrl(args.cmid),
      async (page, pageCtx) => {
        const check = guardPage(page);
        const before = await readAssignmentView(page, args.cmid);
        checkDeletePreconditions(before);
        if (stateFingerprint(before) !== stateFingerprint(view)) {
          throw new Refusal("состояние ответа изменилось после сухого прогона: выполните сухой прогон заново");
        }
        // «Удалить ответ» только открывает страницу подтверждения (GET, §9.1) — это ещё чтение; форма
        // кнопки проверяется до клика, чтобы это не оказалась прямая необратимая отправка.
        const del = await checkedButton(await exactlyOne(page, SEL_DELETE, "кнопка «Удалить ответ»"), "delete", args.cmid);
        await del.click();
        try {
          await page.waitForURL((u) => isViewUrl(u, args.cmid, "removesubmissionconfirm"), { timeout: STEP_TIMEOUT_MS });
        } catch (err) {
          if (pageCtx.signal.aborted) throw err;
          throw new Refusal("страница подтверждения удаления не открылась; операция прервана");
        }
        check();
        if ((await page.getByText(CONFIRM_DELETE_TEXT).filter({ visible: true }).count()) === 0) {
          throw new Refusal("страница подтверждения удаления не распознана; операция прервана");
        }
        const proceed = await checkedButton(await exactlyOne(page, SEL_CONTINUE, "кнопка «Продолжить»"), "continue", args.cmid);
        check();

        // Точка невозврата: дальше только ожидание и чтение.
        if (!(await commitAndClick(page, pageCtx, proceed, args.cmid, ctx.commitPoint))) {
          return NOT_REACHED(await moodleErrorShown(page).catch(() => false));
        }
        const errorShown = await moodleErrorShown(page);
        const after = await readAssignmentView(page, args.cmid);
        return classifyDeleteOutcome({ after, before, errorShown });
      },
      ctx.signal
    );
  },
  async verifyOnly(args, signal) {
    checkCmid(args.cmid);
    const after = await readForVerify(args.cmid, signal);
    if (!after) return tooLargeToVerify();
    const { outcome, evidence, warnings } = classifyDeleteOutcome({ after });
    return { outcome: outcome === "rejected" ? "unknown" : outcome, evidence, warnings };
  },
};
