import type { CourseOverview } from "../lms/client.js";
import type { CourseFilter, DigestItem } from "./types.js";

const MONTHS: Record<string, number> = {
  января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5,
  июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Необязательное время после даты: «23:59», «в 23:59», «T10:30:00», «11:59 pm». Группы 4–6.
const TIME = String.raw`(?:(?:[,\s]+|T)(?:в\s+)?(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap]m))?)?`;

type Ymd = [year: number, month: number, day: number];

interface Hit {
  ymd: Ymd;
  hours?: number;
  minutes?: number;
  meridiem?: string;
}

const timeAfter = (m: RegExpMatchArray): Partial<Hit> =>
  m[4] !== undefined ? { hours: +m[4], minutes: +m[5], meridiem: m[6] } : {};

const PATTERNS: Array<{ re: RegExp; read: (m: RegExpMatchArray) => Hit | null }> = [
  // 2026-10-14, 2026.10.14 (формат РУЗ), 2026-10-14T10:30:00
  {
    re: new RegExp(String.raw`(\d{4})[-.](\d{1,2})[-.](\d{1,2})` + TIME, "gi"),
    read: (m) => ({ ymd: [+m[1], +m[2] - 1, +m[3]], ...timeAfter(m) }),
  },
  // 14.10.2026 [10:30]
  {
    re: new RegExp(String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})` + TIME, "gi"),
    read: (m) => ({ ymd: [+m[3], +m[2] - 1, +m[1]], ...timeAfter(m) }),
  },
  // 15 октября 2026 [г.] [23:59], 15 October 2026 (день недели перед датой игнорируется)
  {
    re: new RegExp(String.raw`(\d{1,2})\s+([a-zа-яё]+)\.?\s+(\d{4})(?:\s*г\.?)?` + TIME, "gi"),
    read: (m) => {
      const month = MONTHS[m[2].toLowerCase()];
      return month === undefined ? null : { ymd: [+m[3], month, +m[1]], ...timeAfter(m) };
    },
  },
  // «23:59 25.10.2026 по московскому времени» (формат окон СОП в ЕЛК): время ПЕРЕД датой
  {
    re: /(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/gi,
    read: (m) => ({ ymd: [+m[5], +m[4] - 1, +m[3]], hours: +m[1], minutes: +m[2] }),
  },
];

// Полный ISO с явной зоной (`2026-09-17T09:58:51+03:00`, `...Z`) разбирается движком и не
// переинтерпретируется в локальной зоне машины.
const ISO_WITH_ZONE = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\s*$/i;

function toDate(hit: Hit, endOfDayIfNoTime: boolean): Date | null {
  const [y, mo, d] = hit.ymd;
  let hours = 0;
  let minutes = 0;
  if (hit.hours !== undefined) {
    hours = hit.hours;
    minutes = hit.minutes ?? 0;
    const meridiem = hit.meridiem?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (endOfDayIfNoTime) {
    // Срок без времени — «в этот день»; 00:00 сделал бы задание просроченным с утра дня сдачи.
    hours = 23;
    minutes = 59;
  }
  const date = new Date(y, mo, d, hours, minutes, 0, 0);
  // new Date нормализует «31 февраля» в март — такие значения отбрасываем.
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  return date;
}

/** Все даты, найденные в тексте, в порядке появления (локальное время). */
export function scanDates(text: string, opts: { endOfDayIfNoTime?: boolean } = {}): Date[] {
  const normalized = text.replace(/\u00a0/g, " ");
  const found: Array<{ index: number; end: number; date: Date }> = [];
  for (const { re, read } of PATTERNS) {
    for (const m of normalized.matchAll(re)) {
      const hit = read(m);
      if (!hit) continue;
      const date = toDate(hit, opts.endOfDayIfNoTime ?? false);
      if (!date) continue;
      const index = m.index ?? 0;
      found.push({ index, end: index + m[0].length, date });
    }
  }
  found.sort((a, b) => a.index - b.index);
  // Разные шаблоны могут зацепить один и тот же фрагмент — оставляем непересекающиеся.
  const result: Date[] = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.index < lastEnd) continue;
    result.push(f.date);
    lastEnd = f.end;
  }
  return result;
}

export function parseDateTime(text: string, opts?: { endOfDayIfNoTime?: boolean }): Date | null {
  if (ISO_WITH_ZONE.test(text)) {
    const t = Date.parse(text.trim());
    if (!Number.isNaN(t)) return new Date(t);
  }
  return scanDates(text, opts)[0] ?? null;
}

/**
 * Дата + время из двух полей расписания. Время может прийти как «10:30», «10:30:00» или как
 * полная дата-время — тогда она важнее отдельного поля даты.
 */
export function combineDateAndTime(dateText: string, timeText: string | null | undefined): Date | null {
  if (timeText && /\d{4}[-.]\d|\d\.\d{1,2}\.\d{4}/.test(timeText)) {
    const full = parseDateTime(timeText);
    if (full) return full;
  }
  const day = parseDateTime(dateText);
  if (!day) return null;
  const t = timeText?.match(/(\d{1,2}):(\d{2})/);
  if (!t) return day;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), +t[1], +t[2], 0, 0);
}

/** ISO 8601 с локальным смещением (не UTC — важно для ночи по МСК, см. date-utils.ts). */
export function toLocalIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
export const endOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** Экзамен/зачёт по типу занятия; «консультация к экзамену» экзаменом не считается. */
export function isExamType(lessonType: string | undefined): boolean {
  return !!lessonType && /экзамен|зач[её]т|коллоквиум|exam/i.test(lessonType) && !/консультац/i.test(lessonType);
}

/** Просроченные первыми, затем по времени, затем элементы без даты. Стабильная. */
export function sortItems(items: DigestItem[]): DigestItem[] {
  const rank = (i: DigestItem) => (i.overdue ? 0 : i.when ? 1 : 2);
  return [...items].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.when && b.when) return Date.parse(a.when) - Date.parse(b.when);
    return 0;
  });
}

/** Курс актуален: `enddate` не задан или не прошёл. Видимость/скрытость проверяются отдельно. */
export function isActualCourse(c: CourseOverview, now: Date): boolean {
  return c.enddate === null || Date.parse(c.enddate) >= now.getTime();
}

/**
 * Актуальные курсы (видимые, не скрытые, `enddate` не прошёл) и необязательный фильтр по id или
 * подстроке названия. Фильтр, не нашедший ничего, — ошибка со списком доступных курсов:
 * молчаливый пустой результат выглядел бы как «дедлайнов нет».
 */
export function selectCourses(
  all: CourseOverview[],
  filter: CourseFilter | undefined,
  now: Date,
  opts: { includeEnded?: boolean } = {}
): CourseOverview[] {
  const actual = all.filter(
    (c) => c.visible && !c.hidden && (opts.includeEnded || isActualCourse(c, now))
  );
  if (!filter || filter.length === 0) return actual;
  const picked = actual.filter((c) =>
    filter.some((f) =>
      typeof f === "number"
        ? c.id === f
        : c.fullname.toLowerCase().includes(f.toLowerCase()) || c.shortname.toLowerCase().includes(f.toLowerCase())
    )
  );
  if (picked.length === 0) {
    throw new Error(
      `Ни один ${opts.includeEnded ? "" : "актуальный "}курс не подошёл под фильтр ${JSON.stringify(filter)}. ` +
        `Доступные курсы: ${actual.map((c) => `${c.id} — ${c.fullname}`).join("; ") || "нет"}`
    );
  }
  return picked;
}
