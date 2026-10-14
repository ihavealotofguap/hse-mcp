/**
 * Ограничитель нагрузки на порталы ВШЭ.
 *
 * Страницы: не больше MAX_CONCURRENT одновременно и минимум MIN_INTERVAL_MS между двумя
 * открытиями. Слот выдаётся `withPage` и возвращается в его `finally`; аренда (`leaseMs`) —
 * страховка от любой утечки: по истечении слот освобождается принудительно. Ожидание слота
 * отменяется сигналом.
 *
 * Прямые API-запросы (`context.request`) страниц не занимают, но идут не чаще одного в
 * API_MIN_INTERVAL_MS. Пороги подобраны без данных об антибот-защите ВШЭ — не измерены.
 */

const MAX_CONCURRENT = 3;
const MIN_INTERVAL_MS = 300;
const API_MIN_INTERVAL_MS = 100;
/** Запас аренды сверх дедлайна страницы. */
export const LEASE_GRACE_MS = 5_000;

interface Waiter {
  grant: () => void;
}

let active = 0;
const waiters: Waiter[] = [];
let nextPageStartAt = 0;
let nextApiStartAt = 0;

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new Error("операция отменена");

function takeSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  // Слот передаётся ожидающему напрямую при releaseSlot() — счётчик active при этом не меняется.
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      reject(abortReason(signal!));
    };
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next.grant();
  else active--;
}

function waitUntil(startAt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const delay = startAt - Date.now();
  if (delay <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Дожидается свободного слота и паузы между открытиями. Возвращает идемпотентную функцию
 * освобождения слота. `leaseMs` — принудительное освобождение, если слот держат слишком долго.
 */
export async function acquirePageSlot(
  opts: { signal?: AbortSignal; leaseMs?: number } = {}
): Promise<() => void> {
  await takeSlot(opts.signal);
  let released = false;
  let lease: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (lease) clearTimeout(lease);
    releaseSlot();
  };

  try {
    // Время старта резервируется синхронно, поэтому параллельные вызовы выстраиваются в очередь
    // с шагом MIN_INTERVAL_MS, а не просыпаются разом.
    const now = Date.now();
    const startAt = Math.max(now, nextPageStartAt);
    nextPageStartAt = startAt + MIN_INTERVAL_MS;
    await waitUntil(startAt, opts.signal);
  } catch (err) {
    release();
    throw err;
  }

  if (opts.leaseMs !== undefined) {
    const leaseMs = opts.leaseMs;
    lease = setTimeout(() => {
      if (released) return;
      console.error(`hsemcp: слот страницы удерживался дольше ${leaseMs} мс — освобождаю принудительно`);
      release();
    }, leaseMs);
    lease.unref?.();
  }
  return release;
}

/** Очередь по частоте для прямых API-запросов (слот страницы не занимается). */
export async function acquireRequestTurn(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextApiStartAt);
  nextApiStartAt = startAt + API_MIN_INTERVAL_MS;
  await waitUntil(startAt, signal);
}
