/**
 * Локальные (не UTC) компоненты даты — важно для запросов расписания РУЗ/ЕЛК, где сервер ждёт
 * дату в TZ пользователя (Москва), а не UTC: `toISOString()` между 00:00–02:59 МСК даёт ещё
 * "вчерашнюю" UTC-дату, из-за чего запрошенный диапазон сдвигался на день назад.
 */
export function formatLocalDate(d: Date, separator: "." | "-"): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return [y, m, day].join(separator);
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
