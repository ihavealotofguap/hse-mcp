import path from "node:path";
import { Refusal } from "../../writes/errors.js";
import { type OutboxFile, resolveOutboxFiles } from "../../writes/outbox.js";
import type { WriteAdapter } from "../../writes/runner.js";
import {
  type AssignmentView,
  buildEditFormInfo,
  type EditFormInfo,
  editUrl,
  extractEditForm,
  fold,
  hasDuplicateNames,
  MAX_VERIFY_DOWNLOAD,
  readAssignmentView,
  readPage,
  stateFingerprint,
  viewUrl,
} from "./parse.js";

/**
 * Сухой прогон сдачи и удаления (спека №4 §9, §9.1): отказы по аргументам, предусловия по странице
 * статуса и форме правки, план (какие файлы заменятся, какие добавятся), описание для владельца и
 * отпечаток состояния для `previewToken`. Неожиданное состояние страницы — отказ, а не догадка.
 */

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

export interface SubmissionPlan {
  add: Array<{ name: string; size: number }>;
  replace: Array<{ name: string; size: number; currentSize: number }>;
  /** Файлов в ответе после сохранения (уникальные по имени). */
  total: number;
}

export function checkCmid(cmid: unknown): void {
  if (typeof cmid !== "number" || !Number.isSafeInteger(cmid) || cmid <= 0) {
    throw new Refusal("cmid должен быть положительным целым числом");
  }
}

/** Отказы по самим аргументам — до любого обращения к диску и к системе. */
export function checkSubmitArgs(args: SubmitArgs): void {
  if (args.text !== undefined) throw new Refusal("онлайн-текст в v1 не поддерживается");
  checkCmid(args.cmid);
  if (args.mode !== "draft" && args.mode !== "submit")
    throw new Refusal("mode должен быть draft или submit");
  if (!Array.isArray(args.files) || args.files.length === 0)
    throw new Refusal("отправка без файлов не поддерживается");
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
    throw new Refusal(
      "в ответе несколько файлов с одинаковым именем (вложенные папки): такой ответ тул не правит"
    );
  }
  if (view.state === "unknown")
    throw new Refusal("состояние ответа на странице задания не распознано");
  if (view.closed) throw new Refusal(CLOSED_REFUSAL[view.closed.reason]);
  if (!view.canAdd && !view.canEdit) throw new Refusal("нельзя добавить или править ответ");
}

/** Имя, под которым файл уйдёт в Moodle: настоящее имя на диске, а не написание модели. */
export const diskName = (f: OutboxFile) => path.basename(f.absPath);

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
export function planSubmission(
  view: AssignmentView,
  form: EditFormInfo,
  files: OutboxFile[]
): SubmissionPlan {
  checkSubmittable(view);
  if (!form.fileOnly)
    throw new Refusal("задание принимает не только файлы: в v1 поддерживается только сдача файлом");

  const existing = new Map(view.files.map((f) => [f.name, f]));
  const existingFolded = new Set(view.files.map((f) => fold(f.name)));
  const add: SubmissionPlan["add"] = [];
  const replace: SubmissionPlan["replace"] = [];
  files.forEach((f, i) => {
    const name = diskName(f);
    const same = existing.get(name);
    if (same) replace.push({ name, size: f.size, currentSize: same.size });
    else if (existingFolded.has(fold(name))) {
      throw new Refusal(
        `файл №${i + 1}: имя отличается от файла ответа только регистром букв — переименуйте файл`
      );
    } else add.push({ name, size: f.size });
  });

  const total = existing.size + add.length;
  if (form.maxFiles !== null && total > form.maxFiles) {
    throw new Refusal(
      `файлов в ответе будет больше, чем разрешает задание: не более ${form.maxFiles}`
    );
  }
  if (form.maxBytes !== null) {
    const maxBytes = form.maxBytes;
    files.forEach((f, i) => {
      if (f.size > maxBytes)
        throw new Refusal(
          `файл №${i + 1} больше допустимого размера задания (${formatBytes(maxBytes)})`
        );
    });
  }
  // Проверка после сохранения скачивает файл со страницы статуса; крупнее предела скачивания исход
  // записи нельзя будет установить ни сразу, ни повтором — отказ до записи, а не отправка вслепую.
  files.forEach((f, i) => {
    if (f.size > MAX_VERIFY_DOWNLOAD) {
      throw new Refusal(
        `файл №${i + 1} больше ${formatBytes(MAX_VERIFY_DOWNLOAD)}: результат отправки нельзя будет проверить`
      );
    }
  });
  return { add, replace, total };
}

/** Удаление: нужен представленный ответ и кнопка «Удалить ответ» на странице статуса. */
export function checkDeletePreconditions(view: AssignmentView): void {
  if (view.state === "unknown")
    throw new Refusal("состояние ответа на странице задания не распознано");
  if (view.state === "none") throw new Refusal("нечего удалять: ответ на задание не представлен");
  if (!view.canDelete)
    throw new Refusal("удалить ответ нельзя: на странице задания нет кнопки «Удалить ответ»");
}

const STATE_TEXT: Record<AssignmentView["state"], string> = {
  none: "ответ не представлен",
  submitted: "отправлено для оценивания",
  draft: "черновик",
  unknown: "не распознано",
};

const W_SAVE_MAY_SUBMIT =
  "сохранение может сразу отправить работу на оценку (у проверенных заданий отдельного шага нет)";
const W_FORM_OPENED = "форма правки открывалась и не сохранялась";

export const targetOf = (args: { cmid: number }) => `assign:${args.cmid}`;

function viewSummary(view: AssignmentView) {
  return {
    title: view.title,
    due: view.dueText,
    state: view.state,
    stateText: STATE_TEXT[view.state],
    lastModified: view.lastModified,
  };
}

export const observeSubmit: WriteAdapter<SubmitArgs, SubmitObserved>["observe"] = async (
  args,
  signal
) => {
  checkSubmitArgs(args);
  // Файл крупнее предела проверки всё равно будет отклонён (`planSubmission`): отказ до хеширования целиком.
  const files = await resolveOutboxFiles(args.files, { maxBytes: MAX_VERIFY_DOWNLOAD });
  const view = await readPage(
    viewUrl(args.cmid),
    (page) => readAssignmentView(page, args.cmid),
    signal
  );
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
};

export const describeSubmit: WriteAdapter<SubmitArgs, SubmitObserved>["describe"] = (
  args,
  { view, form, files }
) => {
  const plan = planSubmission(view, form, files);
  const warnings = [W_SAVE_MAY_SUBMIT, W_FORM_OPENED];
  if (view.state === "submitted")
    warnings.push("ответ уже отправлен на оценку: сохранение изменит отправленную работу");
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
};

export const submitPayload: WriteAdapter<SubmitArgs, SubmitObserved>["payloadOf"] = (
  args,
  { view, files }
) => {
  return {
    mode: args.mode,
    files: files.map((f) => ({ name: diskName(f), sha256: f.sha256 })),
    state: stateFingerprint(view),
  };
};

export const observeDelete: WriteAdapter<DeleteArgs, DeleteObserved>["observe"] = async (
  args,
  signal
) => {
  checkCmid(args.cmid);
  const view = await readPage(
    viewUrl(args.cmid),
    (page) => readAssignmentView(page, args.cmid),
    signal
  );
  checkDeletePreconditions(view);
  return { view };
};

export const describeDelete: WriteAdapter<DeleteArgs, DeleteObserved>["describe"] = (
  _args,
  { view }
) => {
  return {
    preview: {
      ...viewSummary(view),
      files: view.files.map((f) => ({ name: f.name, size: f.size })),
    },
    warnings: [
      "удаление необратимо: ответ и его файлы будут удалены из системы; файлы в папке «исходящих» не трогаются",
    ],
  };
};

export const deletePayload: WriteAdapter<DeleteArgs, DeleteObserved>["payloadOf"] = (
  _args,
  { view }
) => {
  return { files: [], state: stateFingerprint(view) };
};
