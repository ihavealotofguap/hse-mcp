import { addDays, formatLocalDate } from "../../date-utils.js";
import type { ResourceCallOptions } from "../../resource.js";
import { endOfDay, isExamType, startOfDay } from "../digest/parse.js";
import * as elk from "../elk/client.js";
import * as lms from "../lms/client.js";
import type { CourseOverview } from "../lms/client.js";
import {
  canonicalAttrs,
  dedupeIds,
  fingerprint,
  isEmptyGrade,
  mskNaive,
  normText,
  sopNaive,
  utcMinute,
} from "./normalize.js";
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
  getCourseEvaluationTable: typeof elk.getCourseEvaluationTable;
  getSchedule: typeof elk.getSchedule;
  getNotifications: typeof elk.getNotifications;
  listRequests: typeof elk.listRequests;
}

export const realClients: ClientDeps = {
  listActionEvents: lms.listActionEvents,
  listMessages: lms.listMessages,
  listGradeItems: lms.listGradeItems,
  getCourseEvaluationTable: elk.getCourseEvaluationTable,
  getSchedule: elk.getSchedule,
  getNotifications: elk.getNotifications,
  listRequests: elk.listRequests,
};

const maxString = (values: string[]): string | null =>
  values.length ? values.reduce((m, x) => (x > m ? x : m)) : null;
const minString = (values: string[]): string | null =>
  values.length ? values.reduce((m, x) => (x < m ? x : m)) : null;
const orUndefined = (s: string): string | undefined => (s === "" ? undefined : s);
/** Элементы с нераспознанной датой пропускаются — но не молча: счётчик уходит в предупреждения. */
const skippedWarning = (n: number, what: string): string[] =>
  n > 0 ? [`${what} без распознанной даты пропущено: ${n}`] : [];

/**
 * Пропущены все элементы непустого ответа — формат даты не распознан: это ошибка источника, а не
 * «ок с нулём фактов» (иначе база источника обнулилась бы). Частичный пропуск остаётся предупреждением.
 */
function assertDatesParsed(total: number, kept: number): void {
  if (total > 0 && kept === 0)
    throw new Error(`не удалось разобрать даты элементов: ${total} из ${total}`);
}

/**
 * `dedupeIds` с детерминированным порядком входа: суффикс `#n` у настоящих дубликатов определяется
 * содержимым (id, затем отпечаток attrs), а не позицией в ответе — перестановка ответа не даёт ложных событий.
 */
function stableDedupe(facts: Fact[]): Fact[] {
  const keyed = facts.map((fact) => ({ fact, fp: fingerprint(fact.attrs) }));
  keyed.sort((a, b) =>
    a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0
  );
  return dedupeIds(keyed.map((k) => k.fact));
}

/** Минута, предшествующая моменту `ГГГГ-ММ-ДДTЧЧ:ммZ`; при сбое разбора — сам момент. */
function minuteBefore(utc: string): string {
  const d = new Date(utc.replace("Z", ":00Z"));
  return utcMinute(new Date(d.getTime() - 60_000)) ?? utc;
}

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
      const facts = stableDedupe(
        res.events.flatMap((e): Fact[] => {
          const due = utcMinute(e.due);
          if (due === null) return [];
          const name = normText(e.name);
          return [
            {
              id: String(e.id),
              scope: "deadlines",
              kind:
                e.module === "assign"
                  ? "assignment"
                  : e.module === "quiz"
                    ? "quiz"
                    : "lms_activity",
              title: name,
              ...(orUndefined(normText(e.course)) ? { course: normText(e.course) } : {}),
              attrs: canonicalAttrs({ due, name }),
              at: due,
            },
          ];
        })
      );
      assertDatesParsed(res.events.length, facts.length);
      const lastDue = maxString(facts.map((f) => f.at as string));
      return {
        facts,
        // Усечение отрезает самые поздние события — покрытие сужается до минуты ПЕРЕД последним загруженным:
        // событие с тем же сроком могло быть отрезано границей страницы и не должно стать ложным `added`.
        coverage: {
          from: utcMinute(from),
          to: res.truncated ? (lastDue ? minuteBefore(lastDue) : utcMinute(from)) : utcMinute(to),
        },
        truncated: res.truncated,
        warnings: [
          ...(res.truncated
            ? [
                "календарь LMS усечён по лимиту событий: покрытие сужено, «пропало из календаря» не вычисляется",
              ]
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
      const table = await deps.getCourseEvaluationTable(ctx.opts);
      // Таблица не отрисовалась (таймаут рендера, SSO-мост не туда) — отказ источника, а не «окон нет»:
      // у окон нет оси покрытия, и пустой ответ дал бы `removed` по каждому окну.
      if (!table.found)
        throw new Error("таблица окон СОП не найдена на странице (сбой загрузки или входа)");
      const rows = table.rows;
      const facts: Fact[] = [];
      for (const row of rows) {
        // id окна — только период (§5); номер строки `#` нестабилен и в id не подставляется.
        const period = pick(row, /период|period|name/i);
        if (!period) continue;
        facts.push({
          id: period,
          scope: "deadlines",
          kind: "elk_window",
          title: `Оценка курсов (СОП): ${period}`,
          attrs: canonicalAttrs({
            end: sopNaive(pick(row, /окончан|end/i)),
            status: pick(row, /статус|status/i),
          }),
        });
      }
      // Без периода нет стабильного id. Пропущены все строки непустого ответа — колонка не распознана:
      // ошибка источника, а не «ок с нулём фактов» (иначе база окон обнулилась бы массовым `removed`).
      const skipped = rows.length - facts.length;
      if (rows.length > 0 && facts.length === 0) {
        throw new Error(`не удалось найти период в строках СОП: ${rows.length} из ${rows.length}`);
      }
      return {
        facts: stableDedupe(facts),
        warnings: skipped > 0 ? [`строк СОП без периода пропущено: ${skipped}`] : [],
      };
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
      let skipped = 0;
      for (const day of days) {
        for (const l of day.lessons ?? []) {
          const begin = mskNaive(day.date, l.begin_time);
          if (begin === null) {
            skipped++;
            continue;
          }
          const end = mskNaive(day.date, l.end_time);
          const name = normText(l.name);
          const type = normText(l.lesson_type);
          facts.push({
            id: `${begin.slice(0, 10)}|${begin.slice(11)}|${name}|${type}`,
            scope: "schedule",
            kind: isExamType(type) ? "exam" : "lesson",
            title: name,
            attrs: canonicalAttrs({
              end,
              auditorium: normText(l.auditorium),
              building: normText(l.building),
            }),
            at: begin,
            matchKey: `${name}|${type}`,
          });
        }
      }
      // `from` — полночь локальная (МСК пользователя): границы покрытия — по локальным компонентам даты.
      return {
        facts: stableDedupe(facts),
        coverage: {
          from: `${formatLocalDate(from, "-")}T00:00`,
          to: `${formatLocalDate(to, "-")}T23:59`,
        },
        warnings: skippedWarning(skipped, "занятий расписания ЕЛК"),
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
      const facts = stableDedupe(
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
      assertDatesParsed(messages.length, facts.length);
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
      const facts = stableDedupe(
        res.notifications.flatMap((n): Fact[] => {
          const raw = normText(n.date);
          // Даты уведомлений приходят без времени (ГГГГ-ММ-ДД) — гранулярность покрытия сутки. Любая строка,
          // начинающаяся с даты, сводится к этой дате как записана — и без пояса, и с поясом (`…Z`, `…+03:00`),
          // без перевода в UTC: сравнение по суткам. `utcMinute` — только для строк иного вида.
          const at = /^\d{4}-\d{2}-\d{2}(?!\d)/.test(raw) ? raw.slice(0, 10) : utcMinute(raw);
          if (at === null) return [];
          const title = normText(n.title);
          return [
            {
              id: String(n.id),
              scope: "inbox",
              kind: "notification",
              title,
              attrs: canonicalAttrs({ title }),
              at,
            },
          ];
        })
      );
      assertDatesParsed(res.notifications.length, facts.length);
      const full =
        res.notifications.length >= INBOX_NOTIFICATIONS_LIMIT ||
        res.count > res.notifications.length;
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
      // Заявка без номера не имеет стабильного id (""/"#2" зависели бы от порядка) — пропускается.
      const numbered = res.requests.filter((c) => normText(c.num) !== "");
      const facts = stableDedupe(
        numbered.map(
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
      const unnumbered = res.requests.length - numbered.length;
      return {
        facts,
        truncated,
        warnings: [
          ...(truncated ? ["список заявок усечён по лимиту: часть заявок не загружена"] : []),
          ...(unnumbered > 0 ? [`заявок без номера пропущено: ${unnumbered}`] : []),
        ],
      };
    },
  };
}

/** Шесть источников областей `deadlines`, `schedule`, `inbox`, `claims`. */
export function singleExtractors(deps: ClientDeps = realClients): SourceExtractor[] {
  return [
    lmsCalendar(deps),
    elkWindows(deps),
    elkSchedule(deps),
    lmsMessages(deps),
    elkNotifications(deps),
    elkClaims(deps),
  ];
}

/** Оценки одного курса (`lms_grades:<id>`). Нераспознанная таблица — ошибка источника, а не ложные события. */
export function gradesExtractor(
  course: CourseOverview,
  deps: ClientDeps = realClients
): SourceExtractor {
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
      const facts = stableDedupe(
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
