import type { WriteAdapter } from "../../writes/runner.js";
import { executeDelete, executeSubmit } from "./execute.js";
import {
  type DeleteArgs,
  type DeleteObserved,
  deletePayload,
  describeDelete,
  describeSubmit,
  observeDelete,
  observeSubmit,
  type SubmitArgs,
  type SubmitObserved,
  submitPayload,
  targetOf,
} from "./plan.js";
import { verifyDelete, verifySubmit } from "./verify.js";

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
 * Модули по этапам протокола: `parse` — разбор страницы статуса и формы правки, `plan` — предусловия
 * и план (сухой прогон), `execute` — запись до и после `commitPoint` (покадровая, см. там), `verify` —
 * проверка исхода.
 */

export {
  checkButtonForm,
  expectedManagerFiles,
  type PreparedUpload,
  prepareUpload,
  type RawButtonForm,
  sameFileSet,
} from "./execute.js";

export {
  type AssignmentView,
  buildAssignmentView,
  buildEditFormInfo,
  type EditFormInfo,
  parseEditLimits,
  parseRuDateTime,
  type RawAssignmentPage,
  type RawEditForm,
  type RawStatusRow,
  readAssignmentView,
  readEditFormInfo,
  stateFingerprint,
} from "./parse.js";

export {
  checkDeletePreconditions,
  checkSubmitArgs,
  type DeleteArgs,
  type DeleteObserved,
  planSubmission,
  type SubmissionPlan,
  type SubmitArgs,
  type SubmitObserved,
} from "./plan.js";

export {
  classifyDeleteOutcome,
  classifySubmitOutcome,
  compareFiles,
  type ExpectedFile,
} from "./verify.js";

export const submitAdapter: WriteAdapter<SubmitArgs, SubmitObserved> = {
  op: "lms_submit_assignment",
  invalidates: ["lms.assignments", "lms.calendar"],
  targetOf,
  observe: observeSubmit,
  describe: describeSubmit,
  payloadOf: submitPayload,
  execute: executeSubmit,
  verifyOnly: verifySubmit,
};

export const deleteAdapter: WriteAdapter<DeleteArgs, DeleteObserved> = {
  op: "lms_delete_submission",
  invalidates: ["lms.assignments", "lms.calendar"],
  targetOf,
  observe: observeDelete,
  describe: describeDelete,
  payloadOf: deletePayload,
  execute: executeDelete,
  verifyOnly: verifyDelete,
};
