import { classifyError } from "./runner.js";

// Ошибки адаптеров записи (общие для LMS и ЕЛК): собственный отказ и обезличивание ошибок Playwright,
// чтобы в ответ тула не попали URL, имена файлов и id.

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
