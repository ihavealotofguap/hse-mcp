/**
 * Кэш результатов в памяти процесса с TTL. Нужен, чтобы повторные вопросы и будущие агрегаторы
 * («что у меня сегодня» дёргает десяток тулов) не открывали Playwright-страницы ради данных,
 * которые не изменились минуту назад. Только память — на диск ничего не пишется (на диске
 * лежали бы данные об учёбе, а токены и так живут только в процессе).
 *
 * Ключи имеют вид `<сервис>:<что-то>` (`elk:`, `lms:`) — по префиксу сервиса
 * работает `clearCache`. Результат, лежащий в кэше, отдаётся одним и тем же объектом всем
 * вызывающим: тулы только сериализуют его в JSON, мутировать результат нельзя.
 *
 * Свежесть «на вызов»: `maxAgeMs` принимает запись/загрузку не старше N мс; это не сброс кэша
 * (`clearCache` бьёт по всем доменам и запрещает запись идущим загрузкам), а требование одного
 * вызова. Свежая загрузка пишется в кэш как обычно — остальные вызывающие получают её же.
 */

export const TTL = {
  /** Быстро меняющееся: уведомления, заявки, задачи, сообщения. */
  short: 2 * 60_000,
  /** Расписание, оценки, материалы курсов. */
  medium: 5 * 60_000,
  /** Почти статичное: профиль, академическая карточка, портфолио. */
  long: 30 * 60_000,
} as const;

const MAX_ENTRIES = 200;

interface Entry {
  value: unknown;
  expiresAt: number;
  /** Момент СТАРТА загрузки, давшей это значение. */
  storedAt: number;
}

interface Inflight {
  promise: Promise<unknown>;
  startedAt: number;
}

export interface CachedOptions {
  /** Принять запись/загрузку не старше N мс; 0 — «перечитай и сохрани». Не «не кэшируй». */
  maxAgeMs?: number;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Inflight>();
// Увеличивается при clearCache: вызов, начатый до очистки, не должен записать в кэш результат
// уже после неё — иначе «сброс кэша» вернул бы устаревшие данные.
let generation = 0;

function evictIfNeeded(): void {
  if (store.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  // Map хранит порядок вставки — самые старые записи идут первыми.
  for (const key of store.keys()) {
    if (store.size < MAX_ENTRIES) break;
    store.delete(key);
  }
}

/**
 * Возвращает свежую запись из кэша или вычисляет через `fn`. Параллельные вызовы с одним ключом
 * делят одно вычисление (если оно не старше `maxAgeMs`). Ошибки не кэшируются.
 */
export function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts: CachedOptions = {}
): Promise<T> {
  const now = Date.now();
  const maxAge = opts.maxAgeMs;

  const hit = store.get(key);
  if (hit && hit.expiresAt > now && (maxAge === undefined || now - hit.storedAt <= maxAge)) {
    return Promise.resolve(hit.value as T);
  }

  const pending = inflight.get(key);
  if (pending && (maxAge === undefined || pending.startedAt >= now - maxAge)) {
    return pending.promise as Promise<T>;
  }

  const startedAt = now;
  const startedGeneration = generation;
  const promise: Promise<T> = (async () => {
    const value = await fn();
    if (generation === startedGeneration) {
      // Старая загрузка, завершившаяся позже новой, не затирает свежее значение.
      const current = store.get(key);
      if (!current || startedAt >= current.storedAt) {
        evictIfNeeded();
        store.set(key, { value, expiresAt: Date.now() + ttlMs, storedAt: startedAt });
      }
    }
    return value;
  })().finally(() => {
    const current = inflight.get(key);
    if (current && current.promise === promise) inflight.delete(key);
  });
  inflight.set(key, { promise, startedAt });
  return promise;
}

/**
 * Сбрасывает записи, ключ которых начинается с `prefix` (без аргумента — весь кэш). Возвращает
 * число удалённых готовых записей. Точка инвалидации для будущих записывающих тулов.
 */
export function clearCache(prefix = ""): number {
  generation++;
  let removed = 0;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed++;
    }
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
  return removed;
}
