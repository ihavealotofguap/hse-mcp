import { addDays } from "../../date-utils.js";
import * as elk from "../elk/client.js";
import * as lms from "../lms/client.js";
import type { CourseOverview, LmsActionEvent } from "../lms/client.js";
import {
  combineDateAndTime,
  isActualCourse,
  isExamType,
  parseDateTime,
  scanDates,
  selectCourses,
  startOfDay,
  toLocalIso,
} from "./parse.js";
import type { CollectorResult, CourseFilter, DateRange, DigestItem } from "./types.js";

/** На сколько дней назад искать просроченные несданные работы. */
export const OVERDUE_LOOKBACK_DAYS = 180;

const TEXT_LIMIT = 300;
// Статусы окна СОП, при которых действие уже не требуется. Подтверждён только «Анкета доступна».
// «Анкета не заполнена» / «Не пройдена» — окно открыто, поэтому отрицание перед словом отменяет «закрыто».
const WINDOW_DONE = /(?<!не\s+)(заполнен|пройден|заверш|закрыт)/i;

const nonEmpty = (parts: Array<string | null | undefined>): string | undefined => {
  const joined = parts.filter((p): p is string => !!p && p.trim() !== "").join(", ");
  return joined || undefined;
};
const truncate = (s: string): string => (s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT)}…` : s);
const isoOrUndefined = (text: string): string | undefined => {
  const d = parseDateTime(text);
  return d ? toLocalIso(d) : undefined;
};

export interface Collectors {
  elkSchedule(range: DateRange): Promise<CollectorResult>;
  lmsDeadlines(args: { range: DateRange; now: Date; courses?: CourseFilter }): Promise<CollectorResult>;
  lmsMessages(): Promise<CollectorResult>;
  elkNotifications(): Promise<CollectorResult>;
  elkClaims(): Promise<CollectorResult>;
  elkTasks(): Promise<CollectorResult>;
  elkWindows(now: Date): Promise<CollectorResult>;
}

async function elkSchedule(range: DateRange): Promise<CollectorResult> {
  const days = await elk.getSchedule(range.from, range.to);
  const items: DigestItem[] = [];
  for (const day of days) {
    for (const l of day.lessons ?? []) {
      const start = combineDateAndTime(day.date, l.begin_time);
      const end = combineDateAndTime(day.date, l.end_time);
      const place = nonEmpty([l.auditorium, l.building]);
      items.push({
        kind: isExamType(l.lesson_type) ? "exam" : "lesson",
        when: start ? toLocalIso(start) : null,
        ...(end ? { until: toLocalIso(end) } : {}),
        title: l.name,
        ...(place ? { place } : {}),
        source: "elk_schedule",
        ...(l.url1 ? { url: l.url1 } : {}),
        raw: { lessonType: l.lesson_type, lecturer: l.lecturer },
      });
    }
  }
  return { items };
}

/**
 * Событие календаря → элемент сводки. Календарь возвращает только несданное; `overdue` — флаг
 * Moodle (просрочено и не завершено). `actionable` в отбор НЕ участвует: у просроченного
 * задания со сданным окном приёма он false, а пользователь хочет видеть такие работы.
 */
export function actionEventToItem(e: LmsActionEvent): DigestItem {
  return {
    kind: e.module === "assign" ? "assignment" : "lms_activity",
    when: toLocalIso(new Date(e.due)),
    title: e.name,
    ...(e.course ? { course: e.course } : {}),
    source: "lms_deadlines",
    ...(e.overdue ? { overdue: true } : {}),
    ...(e.url ? { url: e.url } : {}),
    raw: { module: e.module, action: e.actionName, actionable: e.actionable },
  };
}

/**
 * Отбор событий календаря по курсам-кандидатам. Просроченное несданное показывается и у завершившихся
 * курсов; будущие дедлайны — только у актуальных.
 */
export function pickDeadlineEvents(
  events: LmsActionEvent[],
  candidates: CourseOverview[],
  now: Date
): LmsActionEvent[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return events.filter((e) => {
    if (e.courseId === null) return false;
    const course = byId.get(e.courseId);
    if (!course) return false;
    return e.overdue || isActualCourse(course, now);
  });
}

async function lmsDeadlines(args: { range: DateRange; now: Date; courses?: CourseFilter }): Promise<CollectorResult> {
  const { range, now, courses } = args;
  const lookback = addDays(startOfDay(now), -OVERDUE_LOOKBACK_DAYS);
  // Две независимые выборки — параллельно (открытия страниц всё равно сериализует loginLock).
  const [allCourses, calendar] = await Promise.all([lms.listCourses(), lms.listActionEvents(lookback, range.to)]);
  const candidates = selectCourses(allCourses, courses, now, { includeEnded: true });
  return {
    items: pickDeadlineEvents(calendar.events, candidates, now).map((e) => actionEventToItem(e)),
    ...(calendar.truncated
      ? { warnings: ["календарь LMS усечён по лимиту событий — самые поздние дедлайны могут отсутствовать"] }
      : {}),
  };
}

async function lmsMessages(): Promise<CollectorResult> {
  const messages = await lms.listMessages(50);
  return {
    items: messages
      .filter((m) => m.unread)
      .map((m) => ({
        kind: "lms_message" as const,
        when: null,
        received: toLocalIso(new Date(m.time)),
        title: m.subject,
        ...(m.course ? { course: m.course } : {}),
        source: "lms_messages",
        unread: true,
        raw: { sender: m.sender, attachments: m.numAttachments },
      })),
  };
}

async function elkNotifications(): Promise<CollectorResult> {
  const { notifications } = await elk.getNotifications(50);
  return {
    items: notifications
      .filter((n) => !n.isRead)
      .map((n) => {
        const received = isoOrUndefined(n.date);
        return {
          kind: "notification" as const,
          when: null,
          ...(received ? { received } : {}),
          title: n.title,
          source: "elk_notifications",
          unread: true,
          important: n.isImportant,
          raw: { text: truncate(n.text) },
        };
      }),
  };
}

async function elkClaims(): Promise<CollectorResult> {
  const { requests } = await elk.listRequests();
  return {
    items: requests
      .filter((c) => c.active)
      .map((c) => {
        const received = isoOrUndefined(c.updated);
        return {
          kind: "elk_claim" as const,
          when: null,
          ...(received ? { received } : {}),
          title: truncate(`${c.service}: ${c.text}`),
          source: "elk_claims",
          ...(c.url ? { url: c.url } : {}),
          raw: { num: c.num, state: c.stateName, created: c.created },
        };
      }),
  };
}

// Форма задачи на реальных данных не подтверждена (на проверенном аккаунте задач нет), поэтому
// объект кладётся в raw как есть, а title берётся из первого строкового поля title/name/text.
async function elkTasks(): Promise<CollectorResult> {
  const { data } = await elk.listTasks();
  return {
    items: data.map((t) => {
      const obj: Record<string, unknown> =
        t && typeof t === "object" ? (t as Record<string, unknown>) : { value: t };
      const title = ["title", "name", "text"]
        .map((k) => obj[k])
        .find((v): v is string => typeof v === "string" && v.trim() !== "");
      return {
        kind: "elk_task" as const,
        when: null,
        title: title ?? "Задача ЕЛК",
        source: "elk_tasks",
        raw: obj,
      };
    }),
  };
}

/**
 * Строка окна СОП → элемент. Колонки (подтверждено вживую): «#», «Период», «Дата начала»,
 * «Дата окончания», «Статус»; даты вида «23:59 25.10.2026 по московскому времени». Срок —
 * «Дата окончания», иначе самая поздняя дата в строке. Закрытые окна (срок в прошлом или статус
 * «заполнена» и т.п.) отбрасываются; без распознанной даты — остаётся с `when: null`.
 */
export function windowToItem(row: Record<string, string>, now: Date): DigestItem | null {
  const entries = Object.entries(row).filter(([, v]) => v && v.trim() !== "");
  const byKey = (re: RegExp): string | undefined => entries.find(([k]) => re.test(k))?.[1];

  const status = byKey(/статус|status/i);
  if (status && WINDOW_DONE.test(status)) return null;

  const endText = byKey(/окончан|end/i);
  const explicitEnd = endText ? parseDateTime(endText, { endOfDayIfNoTime: true }) : null;
  const all = entries.flatMap(([, v]) => scanDates(v, { endOfDayIfNoTime: true }));
  const end = explicitEnd ?? (all.length ? new Date(Math.max(...all.map((d) => d.getTime()))) : null);
  if (end && end.getTime() < now.getTime()) return null;

  const period = byKey(/период|назван|period|name/i) ?? entries.find(([, v]) => v.length > 3)?.[1] ?? "окно";
  return {
    kind: "elk_window",
    when: end ? toLocalIso(end) : null,
    title: `Оценка курсов (СОП): ${period}`,
    source: "elk_windows",
    raw: row,
  };
}

async function elkWindows(now: Date): Promise<CollectorResult> {
  const rows = await elk.getCourseEvaluationStatus();
  return {
    items: rows.map((r) => windowToItem(r, now)).filter((i): i is DigestItem => i !== null),
  };
}

export const realCollectors: Collectors = {
  elkSchedule,
  lmsDeadlines,
  lmsMessages,
  elkNotifications,
  elkClaims,
  elkTasks,
  elkWindows,
};
