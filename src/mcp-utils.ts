export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Аннотации тулов чтения: только читают внешние системы ВШЭ, ответ которых меняется со временем.
 * Аннотации тулов записи — `WRITE_ANNOTATIONS` в `services/writes/gate.ts`.
 */
export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  // JSON.stringify(undefined, ...) возвращает undefined, а не строку — нарушало бы контракт
  // ToolTextResult.content[0].text: string, если какой-то тул когда-нибудь ничего не вернёт.
  return JSON.stringify(data === undefined ? null : data, null, 2);
}

/**
 * Оборачивает тело тула: успешный результат сериализуется в JSON-текст, ошибка — в isError-ответ
 * вместо исключения. `signal` (из `extra.signal` SDK) передаётся в `fn`: срабатывает, когда клиент
 * отменил запрос или остановил задачу.
 */
export async function runTool(
  fn: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<ToolTextResult> {
  try {
    const result = await fn(signal);
    return { content: [{ type: "text", text: toText(result) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Ошибка: ${message}` }], isError: true };
  }
}
