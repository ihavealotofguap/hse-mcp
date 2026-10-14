/**
 * Кэш результатов в памяти процесса с TTL. Нужен, чтобы повторные вопросы и будущие агрегаторы
 * («что у меня сегодня» дёргает десяток тулов) не открывали Playwright-страницы ради данных,
 * которые не изменились минуту назад. Только память — на диск ничего не пишется (на диске
 * лежали бы данные об учёбе, а токены и так живут только в процессе).
 *
 * Ключи имеют вид `<сервис>:<что-то>` (`elk:`, `lms:`, `istudy:`) — по префиксу сервиса
 * работает `clearCache`. Результат, лежащий в кэше, отдаётся одним и тем же объектом всем
 * вызывающим: тулы только сериализуют его в JSON, мутировать результат нельзя.
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
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
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
 * делят одно вычисление. Ошибки не кэшируются.
 */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value as T);

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const startedAt = generation;
  const promise: Promise<T> = (async () => {
    const value = await fn();
    if (generation === startedAt) {
      evictIfNeeded();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
    return value;
  })().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
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
