/**
 * Запуск источника данных с таймаутом: отказ превращается в статус, а не в исключение. Общий для
 * агрегатора `digest` и сервиса `changes`. Таймаут НЕ отменяет работу источника — только
 * перестаёт его ждать (отмена — через сигнал самого вызова, см. ресурсы).
 */

export interface SourceStatus {
  status: "ok" | "error" | "skipped";
  error?: string;
  /** Нефатальные замечания источника. */
  warnings?: string[];
  ms: number;
}

export interface SourceOutcome<T> {
  name: string;
  /** `null` — источник отказал или не запускался. */
  value: T | null;
  status: SourceStatus;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, name: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`источник ${name} не ответил за ${ms / 1000} с`)), ms);
    if (signal) {
      onAbort = () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error(`источник ${name} отменён`));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/** Запускает источник; никогда не бросает — отказ превращается в статус `error`. */
export async function runSource<T extends { warnings?: string[] }>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SourceOutcome<T>> {
  const started = Date.now();
  try {
    const value = await withTimeout(fn(), timeoutMs, name, signal);
    return {
      name,
      value,
      status: {
        status: "ok",
        ms: Date.now() - started,
        ...(value.warnings?.length ? { warnings: value.warnings } : {}),
      },
    };
  } catch (err) {
    return {
      name,
      value: null,
      status: { status: "error", error: err instanceof Error ? err.message : String(err), ms: Date.now() - started },
    };
  }
}
