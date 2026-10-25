import { resolveOutboxFiles } from "../../writes/outbox.js";
import type { ExecuteResult, WriteAdapter } from "../../writes/runner.js";
import {
  type AssignmentView,
  FileTooLarge,
  fold,
  readAssignmentView,
  readPage,
  stateFingerprint,
  viewUrl,
} from "./parse.js";
import {
  checkCmid,
  checkSubmitArgs,
  type DeleteArgs,
  type DeleteObserved,
  diskName,
  type SubmitArgs,
  type SubmitObserved,
} from "./plan.js";

/**
 * Проверка исхода чтением (спека №4 §7, §9.1): сверка свежей страницы статуса с отправленным —
 * `classifySubmitOutcome`/`classifyDeleteOutcome` — и проверка повтора по токену (`verifyOnly`), которая
 * `rejected` не выносит.
 */

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

const W_SUBMITTED_ON_SAVE =
  "работа отправлена на оценку сразу при сохранении: у этого задания нет отдельного шага «Отправить на оценку»";
const W_DRAFT_ONLY =
  "ответ сохранён черновиком и на оценку не отправлен: отдельный шаг «Отправить на оценку» тул в v1 не выполняет";

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
    const untouched = before.files
      .filter((f) => !sent.has(fold(f.name)))
      .map((f) => ({ name: f.name, sha256: f.sha256 }));
    const kept = compareFiles(untouched, after.files);
    untouchedMatch = kept.namesMatch && kept.contentMatch;
    extra = { untouchedMatch, lastModifiedChanged: before.lastModified !== after.lastModified };
  }
  const evidence = {
    state: after.state,
    files: after.files.length,
    namesMatch,
    contentMatch,
    errorShown,
    ...extra,
  };
  const filesOk =
    namesMatch &&
    contentMatch &&
    untouchedMatch &&
    (expectedTotal == null || after.files.length === expectedTotal);
  if (filesOk) {
    if (after.state === "submitted") {
      return {
        stage: "verified",
        outcome: "confirmed",
        evidence,
        warnings: mode === "draft" ? [W_SUBMITTED_ON_SAVE] : [],
      };
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
  const evidence = {
    state: after.state,
    files: after.files.length,
    canAdd: after.canAdd,
    errorShown,
  };
  if (after.state === "none" && after.canAdd && after.files.length === 0) {
    return { stage: "verified", outcome: "confirmed", evidence, warnings: [] };
  }
  if (errorShown && before && stateFingerprint(before) === stateFingerprint(after)) {
    return { stage: "verified", outcome: "rejected", evidence, warnings: [] };
  }
  return { stage: "verified", outcome: "unknown", evidence, warnings: [] };
}

export const NOT_REACHED = (errorShown: boolean): ExecuteResult => ({
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

export const verifySubmit: WriteAdapter<SubmitArgs, SubmitObserved>["verifyOnly"] = async (
  args,
  signal
) => {
  checkSubmitArgs(args);
  const files = await resolveOutboxFiles(args.files);
  const expected = files.map((f) => ({ name: diskName(f), sha256: f.sha256 }));
  const after = await readForVerify(args.cmid, signal);
  if (!after) return tooLargeToVerify();
  // Без `before`: проверка повтора не выносит `rejected`.
  const { outcome, evidence, warnings } = classifySubmitOutcome({
    mode: args.mode,
    expected,
    after,
  });
  return { outcome: outcome === "rejected" ? "unknown" : outcome, evidence, warnings };
};

export const verifyDelete: WriteAdapter<DeleteArgs, DeleteObserved>["verifyOnly"] = async (
  args,
  signal
) => {
  checkCmid(args.cmid);
  const after = await readForVerify(args.cmid, signal);
  if (!after) return tooLargeToVerify();
  const { outcome, evidence, warnings } = classifyDeleteOutcome({ after });
  return { outcome: outcome === "rejected" ? "unknown" : outcome, evidence, warnings };
};
