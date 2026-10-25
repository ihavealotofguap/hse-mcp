import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type { PageCallContext } from "../../../auth/browser-session.js";
import { COMMIT_DEADLINE_MS } from "../../../commit.js";
import { passCommitPoint, Refusal } from "../../writes/errors.js";
import { sha256Hex } from "../../writes/hash.js";
import type { OutboxFile } from "../../writes/outbox.js";
import type { CommitPoint, WriteAdapter } from "../../writes/runner.js";
import {
  buildEditFormInfo,
  editUrl,
  extractEditForm,
  fold,
  readAssignmentView,
  readPage,
  stateFingerprint,
  viewUrl,
} from "./parse.js";
import {
  checkCmid,
  checkDeletePreconditions,
  checkSubmitArgs,
  type DeleteArgs,
  type DeleteObserved,
  diskName,
  planSubmission,
  type SubmitArgs,
  type SubmitObserved,
} from "./plan.js";
import { classifyDeleteOutcome, classifySubmitOutcome, NOT_REACHED } from "./verify.js";

/**
 * Запись сдачи и удаления (спека №4 §9.1, §17): шаги файлового менеджера Moodle, проверка формы кнопки
 * и единственный необратимый клик после `commitPoint`, затем чтение страницы статуса для исхода.
 *
 * Запись покадровая (урок третьего прохода §17): каждый шаг — одно действие по точному селектору
 * (ровно один видимый элемент) и проверка состояния после него; первое расхождение — отказ до точки
 * невозврата. Необратимо только одно действие на операцию: «Сохранить» или «Продолжить».
 */

// --- Запись: шаги файлового менеджера (§17, четвёртый и шестой проходы) ---

// Файловый менеджер ищется только в форме с «Сохранить» (§17, второй проход). На живой странице есть
// второй `.filemanager` — скрытый диалог выбора/правки файла Moodle (`.filemanager.fp-select` в
// `.moodle-dialogue-bd`, вне формы) со своими `.fp-filename`/`.fp-folder`: по всей странице селекторы
// менеджера находили бы и его. «Добавить...» — в панели самого менеджера (§17, четвёртый проход).
const SEL_SUBMIT_FORM = 'form:has(input[name="submitbutton"])';
const SEL_ADD = 'a[title="Добавить..."]:visible';
// Диалог выбора/правки файла открывается только кликом по файлу в менеджере; штатный путь его не открывает.
const SEL_FP_SELECT = ".fp-select:visible";
// Пикер (`.file-picker`) и его форма загрузки — отдельный диалог Moodle вне формы правки: ищутся по
// всей странице, но только видимые; скрытый `.fp-select` под них не подходит.
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
export async function prepareUpload(
  file: OutboxFile,
  n: number,
  opts: { maxBuffer?: number } = {}
): Promise<PreparedUpload> {
  const changed = () =>
    new Refusal(
      `файл №${n} изменился после сухого прогона: выполните сухой прогон заново; операция прервана`
    );
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
  const notPrepared = () =>
    new Refusal(`не удалось подготовить файл №${n} к отправке; операция прервана`);
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

/** Ровно один элемент по селектору (селекторы с `:visible`) внутри `root`, иначе отказ: неожиданная страница. */
async function exactlyOne(root: Page | Locator, selector: string, what: string): Promise<Locator> {
  const loc = root.locator(selector);
  const n = await loc.count();
  if (n !== 1)
    throw new Refusal(`${what}: ожидался ровно один элемент, найдено ${n}; операция прервана`);
  return loc;
}

/** Один клик по единственному элементу; повторов нет (урок третьего прохода §17). */
async function clickOnce(root: Page | Locator, selector: string, what: string): Promise<void> {
  await (await exactlyOne(root, selector, what)).click();
}

/**
 * Файловый менеджер формы правки: ровно одна форма с «Сохранить» и ровно один `.filemanager` в ней,
 * иначе отказ. Видимый диалог `.fp-select` — тоже отказ: его не открывает ни один шаг записи.
 */
async function formManager(page: Page, tail: string): Promise<Locator> {
  const forms = await page.locator(SEL_SUBMIT_FORM).count();
  if (forms !== 1)
    throw new Refusal(`на странице не одна форма с кнопкой «Сохранить» (${forms}); ${tail}`);
  const manager = page.locator(SEL_SUBMIT_FORM).locator(".filemanager");
  if ((await manager.count()) !== 1)
    throw new Refusal(`на форме не один файловый менеджер; ${tail}`);
  if ((await page.locator(SEL_FP_SELECT).count()) > 0)
    throw new Refusal(`открыт диалог файла файлового менеджера; ${tail}`);
  return manager;
}

const visibleCount = (page: Page, selector: string) => page.locator(selector).count();
const dupDialogShown = async (page: Page) =>
  (await page.getByText(DUP_TEXT).filter({ visible: true }).count()) > 0 ||
  (await visibleCount(page, SEL_OVERWRITE)) > 0;

/**
 * Ждёт появления элемента; не появился — отказ с понятной причиной. Отмена и дедлайн страницы
 * (сигнал `withPage`) пробрасываются как есть, чтобы не маскировать их под отказ.
 */
async function waitShown(
  page: Page,
  selector: string,
  refusal: string,
  signal: AbortSignal
): Promise<void> {
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

/** Имена в файловом менеджере формы (`formManager`) — тем же способом, что в `extractEditForm`. */
async function managerNames(manager: Locator): Promise<string[]> {
  return manager.evaluate((el) =>
    Array.from(el.querySelectorAll(".fp-filename"))
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
  await clickOnce(
    await formManager(page, "операция прервана"),
    SEL_ADD,
    "кнопка «Добавить...» файлового менеджера"
  );
  await waitShown(page, SEL_PICKER, "файловый пикер не открылся; операция прервана", signal);
  check();
  await waitShown(
    page,
    SEL_UPLOAD_FORM,
    "в файловом пикере не активна вкладка «Загрузить файл»; операция прервана",
    signal
  );
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
      throw new Refusal(
        `файловый пикер сообщил об ошибке при загрузке файла №${n}; операция прервана`
      );
    }
    const dup = await dupDialogShown(page);
    if (dup && !overwritten) {
      if (!replace)
        throw new Refusal(
          `неожиданный диалог одноимённого файла для файла №${n}; операция прервана`
        );
      if ((await page.getByText(DUP_TEXT).filter({ visible: true }).count()) === 0) {
        throw new Refusal("диалог одноимённого файла не распознан; операция прервана");
      }
      // «Переименовать» не нажимается никогда (§9.1): только «Перезаписать», ровно один раз.
      await clickOnce(page, SEL_OVERWRITE, "кнопка «Перезаписать»");
      overwritten = true;
    } else if (!dup && (overwritten || !replace) && (await visibleCount(page, SEL_PICKER)) === 0) {
      if (
        (await managerNames(await formManager(page, "операция прервана"))).some(
          (x) => fold(x) === fold(name)
        )
      )
        return;
    }
    if (Date.now() > deadline)
      throw new Refusal(
        `файл №${n} не загрузился в файловый менеджер за отведённое время; операция прервана`
      );
    await page.waitForTimeout(POLL_MS);
  }
}

/**
 * Предусловие точки невозврата (§17, третий и четвёртый проходы): пикер и диалоги закрыты, ошибок
 * пикера нет, в форме с «Сохранить» один файловый менеджер, папок в нём нет, имена ровно ожидаемые,
 * «Сохранить» одна.
 */
async function assertManagerState(
  page: Page,
  expected: string[],
  check: () => void
): Promise<Locator> {
  check();
  if ((await visibleCount(page, SEL_PICKER)) > 0)
    throw new Refusal("файловый пикер не закрылся; операция прервана до отправки");
  if (await dupDialogShown(page))
    throw new Refusal("диалог одноимённого файла не закрылся; операция прервана до отправки");
  if ((await visibleCount(page, SEL_PICKER_ERROR)) > 0)
    throw new Refusal("файловый пикер показывает ошибку; операция прервана до отправки");
  const manager = await formManager(page, "операция прервана до отправки");
  if ((await manager.locator(".fp-folder").count()) > 0) {
    throw new Refusal("в файловом менеджере появилась папка; операция прервана до отправки");
  }
  if (!sameFileSet(await managerNames(manager), expected)) {
    throw new Refusal(
      "список файлов в файловом менеджере не совпадает с ожидаемым; операция прервана до отправки"
    );
  }
  return exactlyOne(page, SEL_SAVE, "кнопка «Сохранить»");
}

/** Страница статуса того же задания после POST: Moodle переадресует на `action=view`. */
function isViewUrl(url: URL, cmid: number, action = "view"): boolean {
  return (
    url.pathname.endsWith("/mod/assign/view.php") &&
    url.searchParams.get("id") === String(cmid) &&
    url.searchParams.get("action") === action
  );
}

const moodleErrorShown = async (page: Page) => (await visibleCount(page, SEL_MOODLE_ERROR)) > 0;

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
const BUTTON_FORMS: Record<
  ButtonFormKind,
  { what: string; method: "get" | "post"; action?: string; required: string[]; tail: string }
> = {
  save: {
    what: "кнопки «Сохранить»",
    method: "post",
    required: [
      "lastmodified",
      "userid",
      "action",
      "_qf__mod_assign_submission_form",
      "files_filemanager",
    ],
    tail: "операция прервана до отправки",
  },
  delete: {
    what: "кнопки «Удалить ответ»",
    method: "get",
    action: "removesubmissionconfirm",
    required: ["action"],
    tail: "операция прервана",
  },
  continue: {
    what: "кнопки «Продолжить»",
    method: "post",
    required: ["action", "userid", "sesskey"],
    tail: "операция прервана до отправки",
  },
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
  if (raw.actionPath === null || !raw.actionPath.endsWith("/mod/assign/view.php"))
    fail("неожиданный адрес отправки");
  const values = (name: string) => raw.fields.filter((f) => f.name === name).map((f) => f.value);
  const ids = values("id");
  if (ids.length !== 1 || ids[0] !== String(cmid)) fail("поле id не совпадает с заданием");
  for (const name of rule.required) {
    const v = values(name);
    if (v.length !== 1 || v[0] === "") fail("нет обязательного скрытого поля или оно повторяется");
  }
  if (rule.action !== undefined && values("action")[0] !== rule.action)
    fail("неожиданное действие формы");
}

/** Снимок формы кнопки для `checkButtonForm`; ничего не нажимает. */
async function readButtonForm(button: Locator): Promise<RawButtonForm> {
  return button.evaluate((el) => {
    const b = el as HTMLButtonElement | HTMLInputElement;
    const form = b.form;
    if (!form) return { hasForm: false, method: "", actionPath: null, fields: [] };
    // getAttribute, а не form.method/form.action: поле с name="action" затеняет свойство формы.
    const method =
      (b.getAttribute("formmethod") ?? form.getAttribute("method") ?? "").trim().toLowerCase() ||
      "get";
    let actionPath: string | null = null;
    try {
      const u = new URL(
        b.getAttribute("formaction") ?? form.getAttribute("action") ?? "",
        document.baseURI
      );
      if (u.origin === location.origin) actionPath = u.pathname;
    } catch {
      // адрес не разобран — null
    }
    const fields = Array.from(form.elements)
      .filter(
        (e): e is HTMLInputElement =>
          e instanceof HTMLInputElement && e.type === "hidden" && e.name !== ""
      )
      .map((e) => ({ name: e.name, value: e.value }));
    return { hasForm: true, method, actionPath, fields };
  });
}

/** Кнопка проверена по своей форме (`checkButtonForm`); возвращается она же. */
async function checkedButton(
  button: Locator,
  kind: ButtonFormKind,
  cmid: number
): Promise<Locator> {
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
  await passCommitPoint(commitPoint, pageCtx);
  const reached = page
    .waitForURL((u) => isViewUrl(u, cmid), { timeout: VIEW_WAIT_MS })
    .then(
      () => true,
      () => false
    );
  await button.click();
  return reached;
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

export const executeSubmit: WriteAdapter<SubmitArgs, SubmitObserved>["execute"] = async (
  args,
  { view, files },
  ctx
) => {
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
      if (
        !sameFileSet(
          form.managerFiles,
          view.files.map((f) => f.name)
        )
      ) {
        throw new Refusal(
          "файлы в форме правки не совпадают с ответом на странице задания: состояние изменилось после сухого прогона"
        );
      }
      let manager = form.managerFiles;
      for (const [i, file] of files.entries()) {
        const replace = manager.some((m) => fold(m) === fold(diskName(file)));
        await attachFile(page, file, i + 1, replace, check, pageCtx.signal);
        manager = expectedManagerFiles(manager, [diskName(file)]);
      }
      const save = await checkedButton(
        await assertManagerState(page, manager, check),
        "save",
        args.cmid
      );
      check();

      // Точка невозврата: дальше только ожидание и чтение.
      if (!(await commitAndClick(page, pageCtx, save, args.cmid, ctx.commitPoint))) {
        return NOT_REACHED(await moodleErrorShown(page).catch(() => false));
      }
      const errorShown = await moodleErrorShown(page);
      const after = await readAssignmentView(page, args.cmid);
      return classifySubmitOutcome({
        mode: args.mode,
        expected,
        after,
        before: view,
        expectedTotal: plan.total,
        errorShown,
      });
    },
    ctx.signal
  );
};

export const executeDelete: WriteAdapter<DeleteArgs, DeleteObserved>["execute"] = async (
  args,
  { view },
  ctx
) => {
  checkCmid(args.cmid);
  return readPage(
    viewUrl(args.cmid),
    async (page, pageCtx) => {
      const check = guardPage(page);
      const before = await readAssignmentView(page, args.cmid);
      checkDeletePreconditions(before);
      if (stateFingerprint(before) !== stateFingerprint(view)) {
        throw new Refusal(
          "состояние ответа изменилось после сухого прогона: выполните сухой прогон заново"
        );
      }
      // «Удалить ответ» только открывает страницу подтверждения (GET, §9.1) — это ещё чтение; форма
      // кнопки проверяется до клика, чтобы это не оказалась прямая необратимая отправка.
      const del = await checkedButton(
        await exactlyOne(page, SEL_DELETE, "кнопка «Удалить ответ»"),
        "delete",
        args.cmid
      );
      await del.click();
      try {
        await page.waitForURL((u) => isViewUrl(u, args.cmid, "removesubmissionconfirm"), {
          timeout: STEP_TIMEOUT_MS,
        });
      } catch (err) {
        if (pageCtx.signal.aborted) throw err;
        throw new Refusal("страница подтверждения удаления не открылась; операция прервана");
      }
      check();
      if ((await page.getByText(CONFIRM_DELETE_TEXT).filter({ visible: true }).count()) === 0) {
        throw new Refusal("страница подтверждения удаления не распознана; операция прервана");
      }
      const proceed = await checkedButton(
        await exactlyOne(page, SEL_CONTINUE, "кнопка «Продолжить»"),
        "continue",
        args.cmid
      );
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
};
