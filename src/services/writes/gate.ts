import { z } from "zod";

/**
 * Общее для тулов записи всех сервисов (LMS, ЕЛК): аннотации, поля подтверждения во входной схеме и
 * одно на процесс уведомление о выключенных тулах записи (спека №4 §5).
 */

// Аннотации тулов записи: клиент не должен разрешать вызов автоматически.
export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const CONFIRM_SCHEMA = {
  confirm: z
    .boolean()
    .optional()
    .describe("true — выполнить запись; требует previewToken из сухого прогона."),
  previewToken: z
    .string()
    .max(200)
    .optional()
    .describe("Токен из ответа сухого прогона (действует 15 минут)."),
  acknowledgeUnknown: z
    .boolean()
    .optional()
    .describe("true — подтвердить новую запись по цели, где прошлая закончилась исходом unknown."),
};

let writesOffNoted = false;

/** Один раз за процесс сообщает в stderr, что тулов записи нет (без личных данных). */
export function noteWritesDisabled(): void {
  if (writesOffNoted) return;
  writesOffNoted = true;
  console.error("hse-mcp: тулы записи выключены (HSE_ENABLE_WRITES не задан)");
}
