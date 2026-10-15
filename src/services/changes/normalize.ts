/** Нормализация перед сравнением: чтобы diff был событием, а не шумом (§6). */

const pad = (n: number): string => String(n).padStart(2, "0");

/** NFC, trim, схлопывание пробельных символов; null/undefined → "". Регистр не меняется. */
export function normText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFC").replace(/\s+/g, " ").trim();
}

export function normOrNull(value: unknown): string | null {
  const s = normText(value);
  return s === "" ? null : s;
}

/** Момент → `ГГГГ-ММ-ДДTЧЧ:ммZ` (UTC, без секунд); null, если не распознан. Пояс машины не участвует. */
export function utcMinute(value: Date | number | string): string | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
  );
}

/** Дата `ГГГГ-ММ-ДД` + время `Ч:мм` (МСК) → наивное `ГГГГ-ММ-ДДTЧЧ:мм`; без времени — 00:00; null — дата не распознана. */
export function mskNaive(dateText: string, timeText?: string | null): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(normText(dateText));
  if (!d) return null;
  const t = /(\d{1,2}):(\d{2})/.exec(normText(timeText));
  return `${d[1]}-${d[2]}-${d[3]}T${t ? pad(Number(t[1])) : "00"}:${t ? t[2] : "00"}`;
}

/** «23:59 25.10.2026 по московскому времени» → `2026-10-25T23:59`; без времени — конец дня 23:59. */
export function sopNaive(text: string): string | null {
  const s = normText(text);
  const date = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (!date) return null;
  const time = /(\d{1,2}):(\d{2})/.exec(s);
  return `${date[3]}-${pad(Number(date[2]))}-${pad(Number(date[1]))}T${time ? pad(Number(time[1])) : "23"}:${time ? time[2] : "59"}`;
}

/** Пустая оценка Moodle: ничего, «-», «–», «—». */
export function isEmptyGrade(value: string | null | undefined): boolean {
  const s = normText(value);
  return s === "" || s === "-" || s === "–" || s === "—";
}

/** Канонический вид `attrs`: ключи по алфавиту, значения нормализованы, пустое = null. */
export function canonicalAttrs(attrs: Record<string, string | null | undefined>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(attrs).sort()) out[key] = normOrNull(attrs[key]);
  return out;
}

/** Отпечаток `attrs`: детерминированная строка; `null`, `undefined` и "" равны. */
export function fingerprint(attrs: Record<string, string | null | undefined>): string {
  return JSON.stringify(canonicalAttrs(attrs));
}

/** Повторяющиеся `id` в одном ответе: второй и далее получают суффикс `#n` — факт не теряется. */
export function dedupeIds<T extends { id: string }>(items: T[]): T[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const n = (counts.get(item.id) ?? 0) + 1;
    counts.set(item.id, n);
    return n === 1 ? item : { ...item, id: `${item.id}#${n}` };
  });
}
