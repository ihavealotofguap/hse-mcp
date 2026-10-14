/**
 * Ограничитель открытия страниц в общем Playwright-контексте: не больше MAX_CONCURRENT страниц
 * одновременно и минимум MIN_INTERVAL_MS между двумя открытиями. Без этого агрегирующий вызов
 * (много тулов сразу) открывал бы десяток вкладок разом — медленно и похоже на бота для
 * антибот-защиты ВШЭ.
 *
 * Вызывающие код не меняется: слот отдаётся по закрытию страницы (см. openAuthenticatedPage).
 * Вложенное удержание нескольких слотов одним вызовом недопустимо — упрёмся в лимит и зависнем.
 */

const MAX_CONCURRENT = 3;
const MIN_INTERVAL_MS = 300;

let active = 0;
const waiters: Array<() => void> = [];
let nextStartAt = 0;

function takeSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  // Слот передаётся ожидающему напрямую при release() — счётчик active при этом не меняется.
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

/**
 * Дожидается свободного слота и паузы между открытиями. Возвращает идемпотентную функцию
 * освобождения слота — её безопасно вызвать и из обработчика закрытия страницы, и из catch.
 */
export async function acquirePageSlot(): Promise<() => void> {
  await takeSlot();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };

  try {
    // Время старта резервируется синхронно, поэтому параллельные вызовы выстраиваются в
    // очередь с шагом MIN_INTERVAL_MS, а не просыпаются разом.
    const now = Date.now();
    const startAt = Math.max(now, nextStartAt);
    nextStartAt = startAt + MIN_INTERVAL_MS;
    if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
  } catch (err) {
    release();
    throw err;
  }
  return release;
}
