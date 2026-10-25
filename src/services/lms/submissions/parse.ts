import type { Page } from "playwright";
import { type PageCallContext, withPage } from "../../../auth/browser-session.js";
import { Refusal, sanitizeNavigationError } from "../../writes/errors.js";
import { sha256Hex } from "../../writes/hash.js";

/**
 * Разбор страницы статуса задания `/mod/assign/view.php?id=<cmid>` и формы правки
 * (`action=editsubmission`): чистые функции над сырым снимком и чтение снимка со страницы (ничего не
 * нажимает). Все селекторы и подписи — из живой разведки (спека §17).
 */

export const BASE_URL = "https://edu.hse.ru";

export const viewUrl = (cmid: number) => `${BASE_URL}/mod/assign/view.php?id=${cmid}`;
// Открытие формы правки записи сдачи не создаёт (§17, седьмой проход: 5 заданий из 5); «Сохранить» и
// «Отмена» сухой прогон не нажимает, страница закрывается `page.close()` из `withPage`.
export const editUrl = (cmid: number) =>
  `${BASE_URL}/mod/assign/view.php?id=${cmid}&action=editsubmission`;

// Подписи строк таблицы статуса и кнопок (§17 спеки, подпроект 4).
const ROW_STATUS = "Состояние ответа на задание";
const ROW_REMAINING = "Оставшееся время";
const ROW_MODIFIED = "Последнее изменение";
export const BTN_ADD = "Добавить ответ на задание";
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
  /** На странице есть `input[name="submitbutton"]` внутри формы — это форма правки. */
  hasForm: boolean;
  hasFileManager: boolean;
  hasTextEditor: boolean;
  text: string;
  managerFiles: string[];
}

/**
 * `withPage` с очисткой ошибок от URL; собственные отказы проходят как есть. Через неё идёт любое
 * обращение к странице, и запись тоже: исключение `commitPoint` пробрасывается (очищенным), а не
 * глотается.
 */
export async function readPage<T>(
  url: string,
  fn: (page: Page, ctx: PageCallContext) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await withPage(url, fn, { signal });
  } catch (err) {
    throw sanitizeNavigationError(err);
  }
}

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const RU_DATE_RE = new RegExp(
  `(\\d{1,2})\\s+(${MONTHS.join("|")})\\s+(\\d{4})(?:,?\\s*(\\d{1,2}):(\\d{2}))?`,
  "i"
);
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
export function parseEditLimits(text: string): {
  maxBytes: number | null;
  maxFiles: number | null;
} {
  const size =
    /Максимальный размер новых файлов:\s*(\d+(?:[.,]\d+)?)\s*(Гбайт|Мбайт|Кбайт|байт)(?![\p{L}])/iu.exec(
      text
    );
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
    const value = line
      .slice(label.length)
      .replace(/^:?\s*/, "")
      .trim();
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
export function hasDuplicateNames(names: string[]): boolean {
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
    closed = {
      reason: "overdue",
      text: /просрочено на/i.test(remainingText) ? remainingText : statusText,
    };
  } else {
    const from = openFrom ? parseRuDateTime(openFrom) : null;
    if (from && from.getTime() > now.getTime())
      closed = { reason: "not-open", text: `Открыто с: ${openFrom}` };
    else if (state === "none" && !canAdd && !canEdit)
      closed = { reason: "other", text: statusText };
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
    .sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : a.sha256 < b.sha256
            ? -1
            : a.sha256 > b.sha256
              ? 1
              : 0
    );
  return sha256Hex(JSON.stringify({ state: view.state, files }));
}

export const fold = (s: string) => s.toLowerCase();

async function extractAssignmentPage(page: Page): Promise<RawAssignmentPage> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const rows: Array<{ label: string; text: string; classes: string[] }> = [];
    for (const tr of Array.from(document.querySelectorAll("tr"))) {
      const th = tr.querySelector("th");
      const td = tr.querySelector("td");
      if (!th || !td) continue;
      rows.push({
        label: clean(th.textContent).replace(/:$/, ""),
        text: clean(td.textContent),
        classes: Array.from(td.classList),
      });
    }
    const heading = document.querySelector('[role="main"] h2, main h2');
    const seen = new Set<string>();
    const fileLinks: Array<{ name: string; href: string }> = [];
    for (const el of Array.from(
      document.querySelectorAll('.fileuploadsubmission a[href*="pluginfile"]')
    )) {
      const a = el as HTMLAnchorElement;
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      fileLinks.push({ name: clean(a.textContent), href: a.href });
    }
    return {
      title: clean(heading?.textContent) || clean(document.title),
      rows,
      lines: document.body.innerText.split("\n").map(clean).filter(Boolean),
      buttons: Array.from(document.querySelectorAll("button"))
        .map((b) => clean(b.textContent))
        .filter(Boolean),
      fileLinks,
    };
  });
}

// Предел файла ответа, скачиваемого для sha256: байты идут из страницы в Node одним base64-значением.
export const MAX_VERIFY_DOWNLOAD = 64 * 1024 * 1024;

/** Файл ответа больше `MAX_VERIFY_DOWNLOAD`: проверить содержимое нельзя (проверка повтора даёт `unknown`). */
export class FileTooLarge extends Refusal {}

/**
 * Байты файла ответа: обычный GET ссылки `pluginfile` из самой страницы (её cookies), sha256 — в Node
 * (§9.1, девятый проход). Переадресация (например, на вход) — отказ: хэшировать чужую страницу нельзя.
 * Крупнее `MAX_VERIFY_DOWNLOAD` (по `Content-Length` или по факту чтения, до сборки base64) — отказ.
 */
async function downloadSubmissionFile(
  page: Page,
  href: string,
  n: number
): Promise<{ size: number; sha256: string }> {
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

export async function extractEditForm(page: Page): Promise<RawEditForm> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const form = document.querySelector('input[name="submitbutton"]')?.closest("form") ?? null;
    // Всё ищется внутри формы с «Сохранить» (вне её есть скрытый `.filemanager.fp-select`); без формы —
    // по всей странице, но тогда hasForm = false и сухой прогон отказывает.
    const scope: ParentNode = form ?? document;
    return {
      hasForm: form !== null,
      hasFileManager: scope.querySelector(".filemanager") !== null,
      // Atto и TinyMCE в Moodle строятся поверх textarea; любое текстовое поле — не «только файл».
      hasTextEditor:
        scope.querySelector('textarea, [contenteditable]:not([contenteditable="false"])') !== null,
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
