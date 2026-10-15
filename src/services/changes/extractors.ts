import { addDays, formatLocalDate } from "../../date-utils.js";
import type { ResourceCallOptions } from "../../resource.js";
import { endOfDay, isExamType, startOfDay } from "../digest/parse.js";
import * as elk from "../elk/client.js";
import * as lms from "../lms/client.js";
import type { CourseOverview } from "../lms/client.js";
import { canonicalAttrs, dedupeIds, isEmptyGrade, mskNaive, normText, sopNaive, utcMinute } from "./normalize.js";
import type { DiffFlags, Fact, Scope, SourceResult } from "./types.js";

export const CALENDAR_LOOKBACK_DAYS = 180;
export const CALENDAR_HORIZON_DAYS = 60;
export const SCHEDULE_HORIZON_DAYS = 14;
export const INBOX_LMS_LIMIT = 200;
export const INBOX_NOTIFICATIONS_LIMIT = 100;
export const CLAIMS_LIMIT = 500;

export interface ExtractContext {
  now: Date;
  opts: ResourceCallOptions;
}

export interface SourceExtractor {
  source: string;
  scope: Scope;
  flags: DiffFlags;
  run(ctx: ExtractContext): Promise<SourceResult>;
}

/** Клиентские функции источников; в проверках подменяются фикстурами. */
export interface ClientDeps {
  listActionEvents: typeof lms.listActionEvents;
  listMessages: typeof lms.listMessages;
  listGradeItems: typeof lms.listGradeItems;
  getCourseEvaluationStatus: typeof elk.getCourseEvaluationStatus;
  getSchedule: typeof elk.getSchedule;
  getNotifications: typeof elk.getNotifications;
  listRequests: typeof elk.listRequests;
}

export const realClients: ClientDeps = {
  listActionEvents: lms.listActionEvents,
  listMessages: lms.listMessages,
  listGradeItems: lms.listGradeItems,
  getCourseEvaluationStatus: elk.getCourseEvaluationStatus,
  getSchedule: elk.getSchedule,
  getNotifications: elk.getNotifications,
  listRequests: elk.listRequests,
};

const maxString = (values: string[]): string | null => (values.length ? values.reduce((m, x) => (x > m ? x : m)) : null);
const minString = (values: string[]): string | null => (values.length ? values.reduce((m, x) => (x < m ? x : m)) : null);
const orUndefined = (s: string): string | undefined => (s === "" ? undefined : s);
/** Элементы с нераспознанной датой пропускаются — но не молча: счётчик уходит в предупреждения. */
const skippedWarning = (n: number, what: string): string[] => (n > 0 ? [`${what} без распознанной даты пропущено: ${n}`] : []);

function lmsCalendar(deps: ClientDeps): SourceExtractor {
  return {
    source: "lms_calendar",
    scope: "deadlines",
    flags: { detectOverdue: true },
    async run(ctx) {
      const today = startOfDay(ctx.now);
      // Те же даты, от которых строится ключ кэша календаря (`lms/client.ts`), и последний день целиком.
      const from = addDays(today, -CALENDAR_LOOKBACK_DAYS);
      const to = endOfDay(addDays(today, CALENDAR_HORIZON_DAYS));
      const res = await deps.listActionEvents(from, to, ctx.opts);
      const facts = dedupeIds(
        res.events.flatMap((e): Fact[] => {
          const due = utcMinute(e.due);
          if (due === null) return [];
          const name = normText(e.name);
          return [
            {
              id: String(e.id),
              scope: "deadlines",
              kind: e.module === "assign" ? "assignment" : e.module === "quiz" ? "quiz" : "lms_activity",
              title: name,
              ...(orUndefined(normText(e.course)) ? { course: normText(e.course) } : {}),
              attrs: canonicalAttrs({ due, name }),
              at: due,
            },
          ];
        })
      );
      const lastDue = maxString(facts.map((f) => f.at as string));
      return {
        facts,
        // Усечение отрезает самые поздние события — покрытие сужается до последнего загруженного.
        coverage: { from: utcMinute(from), to: res.truncated ? (lastDue ?? utcMinute(from)) : utcMinute(to) },
        truncated: res.truncated,
        warnings: [
          ...(res.truncated
            ? ["календарь LMS усечён по лимиту событий: покрытие сужено, «пропало из календаря» не вычисляется"]
            : []),
          ...skippedWarning(res.events.length - facts.length, "событий календаря LMS"),
        ],
      };
    },
  };
}

function elkWindows(deps: ClientDeps): SourceExtractor {
  const pick = (row: Record<string, string>, re: RegExp): string =>
    normText(Object.entries(row).find(([k]) => re.test(k))?.[1]);
  return {
    source: "elk_windows",
    scope: "deadlines",
    flags: {},
    async run(ctx) {
      const rows = await deps.getCourseEvaluationStatus(ctx.opts);
      const warnings: string[] = [];
      const facts: Fact[] = [];
      for (const row of rows) {
        // id окна — только период (§5); номер строки `#` нестабилен и в id не подставляется.
        const period = pick(row, /период|period|name/i);
        if (!period) {
          warnings.push("строка СОП без периода пропущена");
          continue;
        }
        facts.push({
          id: period,
          scope: "deadlines",
          kind: "elk_window",
          title: `Оценка курсов (СОП): ${period}`,
          attrs: canonicalAttrs({ end: sopNaive(pick(row, /окончан|end/i)), status: pick(row, /статус|status/i) }),
        });
      }
      return { facts: dedupeIds(facts), warnings };
    },
  };
}

function elkSchedule(deps: ClientDeps): SourceExtractor {
  return {
    source: "elk_schedule",
    scope: "schedule",
    flags: { mergeMoves: true },
    async run(ctx) {
      const from = startOfDay(ctx.now);
      const to = addDays(from, SCHEDULE_HORIZON_DAYS);
      const days = await deps.getSchedule(from, to, ctx.opts);
      const facts: Fact[] = [];
      for (const day of days) {
        for (const l of day.lessons ?? []) {
          const begin = mskNaive(day.date, l.begin_time);
          if (begin === null) continue;
          const end = mskNaive(day.date, l.end_time);
          const name = normText(l.name);
          const type = normText(l.lesson_type);
          facts.push({
            id: `${begin.slice(0, 10)}|${begin.slice(11)}|${name}|${type}`,
            scope: "schedule",
            kind: isExamType(type) ? "exam" : "lesson",
            title: name,
            attrs: canonicalAttrs({ end, auditorium: normText(l.auditorium), building: normText(l.building) }),
            at: begin,
            matchKey: `${name}|${type}`,
          });
        }
      }
      // `from` — полночь локальная (МСК пользователя): границы покрытия — по локальным компонентам даты.
      return {
        facts: dedupeIds(facts),
        coverage: { from: `${formatLocalDate(from, "-")}T00:00`, to: `${formatLocalDate(to, "-")}T23:59` },
      };
    },
  };
}

function lmsMessages(deps: ClientDeps): SourceExtractor {
  return {
    source: "lms_messages",
    scope: "inbox",
    flags: { emitChanged: false, emitRemoved: false, carryMissing: false },
    async run(ctx) {
      const messages = await deps.listMessages(INBOX_LMS_LIMIT, ctx.opts);
      const facts = dedupeIds(
        messages.flatMap((m): Fact[] => {
          const at = utcMinute(m.time);
          if (at === null) return [];
          const subject = normText(m.subject);
          return [
            {
              id: String(m.id),
              scope: "inbox",
              kind: "lms_message",
              title: subject,
              ...(orUndefined(normText(m.course)) ? { course: normText(m.course) } : {}),
              attrs: canonicalAttrs({ subject }),
              at,
            },
          ];
        })
      );
      // Выборка упёрлась в лимит — старше самого старого элемента ответа «новое» не судим.
      const full = messages.length >= INBOX_LMS_LIMIT;
      return {
        facts,
        coverage: { from: full ? minString(facts.map((f) => f.at as string)) : null, to: null },
        warnings: skippedWarning(messages.length - facts.length, "писем LMS"),
      };
    },
  };
}

function elkNotifications(deps: ClientDeps): SourceExtractor {
  return {
    source: "elk_notifications",
    scope: "inbox",
    flags: { emitChanged: false, emitRemoved: false, carryMissing: false },
    async run(ctx) {
      const res = await deps.getNotifications(INBOX_NOTIFICATIONS_LIMIT, ctx.opts);
      const facts = dedupeIds(
        res.notifications.flatMap((n): Fact[] => {
          const raw = normText(n.date);
          // Даты уведомлений приходят без времени (ГГГГ-ММ-ДД) — гранулярность покрытия сутки.
          const at = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : utcMinute(raw);
          if (at === null) return [];
          const title = normText(n.title);
          return [{ id: String(n.id), scope: "inbox", kind: "notification", title, attrs: canonicalAttrs({ title }), at }];
        })
      );
      const full = res.notifications.length >= INBOX_NOTIFICATIONS_LIMIT || res.count > res.notifications.length;
      return {
        facts,
        coverage: { from: full ? minString(facts.map((f) => f.at as string)) : null, to: null },
        warnings: skippedWarning(res.notifications.length - facts.length, "уведомлений ЕЛК"),
      };
    },
  };
}

function elkClaims(deps: ClientDeps): SourceExtractor {
  return {
    source: "elk_claims",
    scope: "claims",
    // §5: у заявок события только `added`/`changed`; пропавшая из ответа заявка — не событие.
    flags: { emitRemoved: false },
    async run(ctx) {
      const res = await deps.listRequests(CLAIMS_LIMIT, ctx.opts);
      const truncated = res.count > res.requests.length;
      const facts = dedupeIds(
        res.requests.map(
          (c): Fact => ({
            id: normText(c.num),
            scope: "claims",
            kind: "elk_claim",
            // Только название сервиса: свободный текст заявки и ФИО на диск не пишутся.
            title: normText(c.service),
            attrs: canonicalAttrs({ state: normText(c.stateName), active: c.active ? "1" : "0" }),
          })
        )
      );
      return {
        facts,
        truncated,
        warnings: truncated ? ["список заявок усечён по лимиту — «пропало» не вычисляется"] : [],
      };
    },
  };
}

/** Шесть источников областей `deadlines`, `schedule`, `inbox`, `claims`. */
export function singleExtractors(deps: ClientDeps = realClients): SourceExtractor[] {
  return [lmsCalendar(deps), elkWindows(deps), elkSchedule(deps), lmsMessages(deps), elkNotifications(deps), elkClaims(deps)];
}

/** Оценки одного курса (`lms_grades:<id>`). Нераспознанная таблица — ошибка источника, а не ложные события. */
export function gradesExtractor(course: CourseOverview, deps: ClientDeps = realClients): SourceExtractor {
  return {
    source: `lms_grades:${course.id}`,
    scope: "grades",
    flags: { emitRemoved: false, carryMissing: false, silentEmptyGrade: true },
    async run(ctx) {
      const table = await deps.listGradeItems(course.id, ctx.opts);
      // Нет таблицы или не найдены колонки (`th.column-itemname`/`td.column-grade`) — чужая вёрстка:
      // ошибка источника, а не пустая выдача. В Moodle строка «Итого за курс» с `td.column-grade` есть всегда.
      if (!table.found || !table.recognized) throw new Error("unsupported grade table");
      const courseName = normText(course.fullname);
      const facts = dedupeIds(
        table.rows
          .filter((r) => !r.isCategory)
          .map((r): Fact => {
            const name = normText(r.name);
            const path = r.path.map(normText).join("/");
            return {
              id: `${course.id}|${path}|${name}`,
              scope: "grades",
              kind: "grade_item",
              title: name,
              ...(courseName ? { course: courseName } : {}),
              attrs: canonicalAttrs({ grade: isEmptyGrade(r.grade) ? null : r.grade }),
            };
          })
      );
      return { facts };
    },
  };
}
