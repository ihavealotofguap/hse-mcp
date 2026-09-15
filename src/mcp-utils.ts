export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function toText(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

/** Оборачивает тело тула: успешный результат сериализуется в JSON-текст, ошибка — в isError-ответ вместо исключения. */
export async function runTool(fn: () => Promise<unknown>): Promise<ToolTextResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: toText(result) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Ошибка: ${message}` }], isError: true };
  }
}
