import type { Page } from "playwright";
import { withPage } from "../../auth/browser-session.js";
import { TTL } from "../../cache.js";
import { dumpPage, extractTable, type PageDump } from "../../dom-utils.js";
import { formatLocalDate } from "../../date-utils.js";
import { defineResource, type ResourceCallOptions } from "../../resource.js";
import { resolveScopedUrl } from "../../url-utils.js";

const BASE_URL = "https://edu.hse.ru";

// AJAX-сервису Moodle нужен только sesskey, а дашборд /my/courses.php рендерится 7–9 с и упирается
// в таймаут ожидания рендера; любая лёгкая страница отдаёт sesskey сразу.
const AJAX_HOST_URL = `${BASE_URL}/user/preferences.php`;

export interface ModuleLink {
  type: string;
  cmid: number | null;
  title: string;
  url: string;
}

/**
 * SmartLMS (edu.hse.ru) — Moodle (подтверждено: путь /my/courses.php, заголовок "Smart LMS").
 * Публичного webservice-токена без отдельной настройки администратором нет (вход только через
 * OIDC/Keycloak SSO), поэтому используется Playwright поверх общей SSO-сессии. Извлечение по
 * стандартным для Moodle URL-паттернам (/course/view.php?id=, /mod/<type>/view.php?id=) —
 * это устойчиво к теме оформления, в отличие от CSS-классов, которые ВШЭ могла кастомизировать.
 */

interface MoodleAjaxResponse<T> {
  error: boolean;
  exception?: { message: string };
  data: T;
}

/**
 * Внутренний AJAX-сервис самого Moodle (lib/ajax/service.php) — то, чем пользуется JS дашборда,
 * авторизация через sesskey текущей сессии (не требует отдельного mobile webservice-токена).
 * Реверс-инжинирено 2026-09-15 на вызове дашборда /my/courses.php.
 */
export async function fetchMoodleAjax<T>(
  page: Page,
  methodname: string,
  args: Record<string, unknown>
): Promise<T> {
  type MoodleWindow = { M?: { cfg?: { sesskey?: string } } };
  await page
    .waitForFunction(() => !!(window as unknown as MoodleWindow).M?.cfg?.sesskey, undefined, { timeout: 15_000 })
    .catch(() => {});
  const sesskey = await page.evaluate(() => (window as unknown as MoodleWindow).M?.cfg?.sesskey);
  if (!sesskey) {
    throw new Error("Не удалось найти sesskey на странице edu.hse.ru — возможно, сессия слетела");
  }
  return page.evaluate(
    async ({ methodname, args, sesskey }) => {
      const res = await fetch(`/lib/ajax/service.php?sesskey=${sesskey}&info=${methodname}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname, args }]),
      });
      if (!res.ok) {
        throw new Error(`edu.hse.ru AJAX ${methodname} вернул ${res.status}`);
      }
      const body = (await res.json()) as MoodleAjaxResponse<T>[];
      if (body[0]?.error) {
        throw new Error(`edu.hse.ru AJAX ${methodname}: ${body[0].exception?.message ?? "unknown error"}`);
      }
      return body[0].data;
    },
    { methodname, args, sesskey }
  );
}

interface RawTimelineCourse {
  id: number;
  fullname: string;
  shortname: string;
  coursecategory: string;
  startdate: number;
  enddate: number;
  visible: boolean;
  hidden: boolean;
  isfavourite: boolean;
  hasprogress: boolean;
  progress: number;
  viewurl: string;
}

export interface CourseOverview {
  id: number;
  fullname: string;
  shortname: string;
  category: string;
  startdate: string;
  enddate: string | null;
  progress: number | null;
  isFavourite: boolean;
  hidden: boolean;
  visible: boolean;
  viewUrl: string;
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, "").trim();
const unixToIso = (seconds: number) => new Date(seconds * 1000).toISOString();

// Письма local_mail — это блочный HTML (<p>, <br>) без единого текстового поля; простой strip
// тегов слепил бы все абзацы в одну строку.
const htmlToText = (html: string) =>
  html
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const lmsCourses = defineResource<void, CourseOverview[]>({
  name: "lms.courses",
  ttl: TTL.medium,
  key: () => "all",
  load: (_a, ctx) =>
    withPage(
      AJAX_HOST_URL,
      async (page) => {
        const data = await fetchMoodleAjax<{ courses: RawTimelineCourse[] }>(
          page,
          "local_api_get_enrolled_courses_by_timeline_classification",
          {
            offset: 0,
            limit: 100,
            classification: "all",
            sort: "fullname",
            customfieldname: "",
            customfieldvalue: "",
            requiredfields: ["id", "fullname", "shortname", "showcoursecategory", "showshortname", "visible", "enddate"],
          }
        );
        return data.courses.map((c) => ({
          id: c.id,
          fullname: c.fullname,
          shortname: c.shortname,
          category: stripHtml(c.coursecategory),
          startdate: unixToIso(c.startdate),
          enddate: c.enddate > 0 ? unixToIso(c.enddate) : null,
          progress: c.hasprogress ? c.progress : null,
          isFavourite: c.isfavourite,
          hidden: c.hidden,
          visible: c.visible,
          viewUrl: c.viewurl,
        }));
      },
      { signal: ctx.signal }
    ),
});

/**
 * Список курсов через внутренний AJAX-эндпоинт дашборда (см. fetchMoodleAjax) — вместо парсинга
 * ссылок со страницы: даёт прогресс прохождения, даты начала/окончания и категорию, которых нет
 * в простой ссылке на курс. classification: "all" — все курсы, включая скрытые из вида.
 */
export function listCourses(opts?: ResourceCallOptions): Promise<CourseOverview[]> {
  return lmsCourses(undefined, opts);
}

interface RawActionEvent {
  id: number;
  name: string;
  modulename?: string;
  timesort: number;
  overdue?: boolean;
  url?: string;
  course?: { id: number; fullname: string };
  action?: { name: string; actionable: boolean; url: string };
}

export interface LmsActionEvent {
  id: number;
  name: string;
  module: string;
  course: string;
  courseId: number | null;
  due: string;
  overdue: boolean;
  actionable: boolean;
  actionName: string;
  url: string | null;
}

const CALENDAR_PAGE_SIZE = 50;
const CALENDAR_MAX_PAGES = 6;

export interface LmsActionEventsResult {
  events: LmsActionEvent[];
  /** Выборка упёрлась в потолок страниц: события идут по возрастанию даты, значит, отсечены самые поздние. */
  truncated: boolean;
}

// Правая граница запроса округляется вверх до корзины (7/14/30/60 дней от сегодня): сводки
// «сегодня/неделя/две недели» делят одну дорогую загрузку (страница + до 6 AJAX-запросов), а
// `project` отсекает лишнее. Дальше 60 дней и в прошлом — точный ключ по дате.
const CALENDAR_BUCKET_DAYS = [7, 14, 30, 60];
const MS_PER_DAY = 86_400_000;

export function calendarHorizon(to: Date, today: Date = new Date()): { key: string; end: Date } {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const t1 = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  const days = Math.round((t1.getTime() - t0.getTime()) / MS_PER_DAY);
  const bucket = days >= 0 ? CALENDAR_BUCKET_DAYS.find((b) => b >= days) : undefined;
  if (bucket === undefined) return { key: `d${formatLocalDate(t1, "-")}`, end: to };
  const end = new Date(t0);
  end.setDate(end.getDate() + bucket);
  end.setHours(23, 59, 59, 999);
  return { key: `b${bucket}@${formatLocalDate(t0, "-")}`, end };
}

interface CalendarArgs {
  from: Date;
  to: Date;
}

const lmsCalendar = defineResource<CalendarArgs, LmsActionEventsResult, LmsActionEventsResult>({
  name: "lms.calendar",
  ttl: TTL.medium,
  key: (a) => `${formatLocalDate(a.from, "-")}:${calendarHorizon(a.to).key}`,
  load: (a, ctx) =>
    withPage(
      AJAX_HOST_URL,
      async (page) => {
        const end = calendarHorizon(a.to).end;
        const events: LmsActionEvent[] = [];
        let truncated = false;
        let afterEventId = 0;
        for (let i = 0; i < CALENDAR_MAX_PAGES; i++) {
          const data = await fetchMoodleAjax<{ events: RawActionEvent[]; lastid?: number }>(
            page,
            "core_calendar_get_action_events_by_timesort",
            {
              timesortfrom: Math.floor(a.from.getTime() / 1000),
              timesortto: Math.floor(end.getTime() / 1000),
              aftereventid: afterEventId,
              limitnum: CALENDAR_PAGE_SIZE,
              limittononsuspendedevents: true,
            }
          );
          for (const e of data.events) {
            events.push({
              id: e.id,
              name: stripHtml(e.name),
              module: e.modulename ?? "",
              course: e.course?.fullname ?? "",
              courseId: e.course?.id ?? null,
              due: unixToIso(e.timesort),
              overdue: e.overdue ?? false,
              actionable: e.action?.actionable ?? false,
              actionName: e.action?.name ?? "",
              url: e.action?.url ?? e.url ?? null,
            });
          }
          if (data.events.length < CALENDAR_PAGE_SIZE || !data.lastid) break;
          if (i === CALENDAR_MAX_PAGES - 1) truncated = true;
          afterEventId = data.lastid;
        }
        return { events, truncated };
      },
      { signal: ctx.signal }
    ),
  // Событий позже запрошенной границы быть не должно; усечение относится только к хвосту выборки,
  // поэтому для запроса с более ранней границей, чем последнее полученное событие, оно неактуально.
  project: (raw, a) => {
    const toMs = a.to.getTime();
    const events = raw.events.filter((e) => Date.parse(e.due) <= toMs);
    const lastDue = raw.events.reduce((m, e) => Math.max(m, Date.parse(e.due)), -Infinity);
    return { events, truncated: raw.truncated && lastDue <= toMs };
  },
});

/**
 * События календаря Moodle «нужно действие» (сдать задание, пройти тест) за период — один
 * AJAX-запрос вместо обхода страницы заданий каждого курса; тот же сервис, что питает блок
 * «Таймлайн» дашборда. Проверено вживую 2026-10-14: сданные работы в ответ не попадают;
 * просроченное несданное приходит с `overdue: true` и `actionable: false` (сдача закрыта) —
 * поэтому по `actionable` фильтровать нельзя. Ключ кэша: дата начала + корзина правой границы.
 */
export function listActionEvents(from: Date, to: Date, opts?: ResourceCallOptions): Promise<LmsActionEventsResult> {
  return lmsCalendar({ from, to }, opts);
}

interface RawMailPerson {
  fullname: string;
  profileurl: string;
}

interface RawMailCourse {
  id: number;
  fullname: string;
  shortname: string;
}

interface RawMailMessageSummary {
  id: number;
  subject: string;
  numattachments: number;
  time: number;
  unread: boolean;
  starred: boolean;
  course: RawMailCourse;
  sender: RawMailPerson;
}

export interface LmsMessageSummary {
  id: number;
  subject: string;
  course: string;
  sender: string;
  time: string;
  unread: boolean;
  starred: boolean;
  numAttachments: number;
}

const MESSAGES_FETCH_LIMIT = 200; // максимум тула lms_list_messages

const lmsMessages = defineResource<number, RawMailMessageSummary[], LmsMessageSummary[]>({
  name: "lms.messages",
  ttl: TTL.short,
  key: () => "inbox",
  load: (_limit, ctx) =>
    withPage(
      `${BASE_URL}/local/mail/view.php?t=inbox`,
      (page) =>
        fetchMoodleAjax<RawMailMessageSummary[]>(page, "local_mail_search_messages", {
          query: { roles: ["to", "cc", "bcc"], deleted: false },
          limit: MESSAGES_FETCH_LIMIT,
        }),
      { signal: ctx.signal }
    ),
  project: (raw, limit) =>
    raw.slice(0, limit).map((m) => ({
      id: m.id,
      subject: m.subject,
      course: m.course.fullname,
      sender: m.sender.fullname,
      time: unixToIso(m.time),
      unread: m.unread,
      starred: m.starred,
      numAttachments: m.numattachments,
    })),
});

/**
 * Внутренняя почта SmartLMS (плагин local_mail, edu.hse.ru/local/mail/) — переписка с
 * преподавателями внутри курсов, полностью отдельная от корпоративной почты Яндекс 360
 * (см. src/services/mail/). Реверс-инжинирено 2026-09-15 через тот же внутренний AJAX-сервис
 * Moodle (fetchMoodleAjax), метод local_mail_search_messages с ролями to/cc/bcc — это входящие.
 */
export function listMessages(limit = 50, opts?: ResourceCallOptions): Promise<LmsMessageSummary[]> {
  return lmsMessages(limit, opts);
}

interface RawMailAttachment {
  filename: string;
  filesize: number;
  fileurl: string;
}

interface RawMailMessage {
  id: number;
  subject: string;
  content: string;
  time: number;
  course: RawMailCourse;
  sender: RawMailPerson;
  recipients: Array<RawMailPerson & { type: string }>;
  attachments: RawMailAttachment[];
}

export interface LmsMessage {
  id: number;
  subject: string;
  text: string;
  course: string;
  sender: string;
  recipients: string[];
  time: string;
  attachments: Array<{ filename: string; filesize: number; url: string }>;
}

const lmsMessage = defineResource<number, RawMailMessage, LmsMessage>({
  name: "lms.message",
  ttl: TTL.medium,
  key: (id) => String(id),
  load: (id, ctx) =>
    withPage(
      `${BASE_URL}/local/mail/view.php?t=inbox`,
      (page) => fetchMoodleAjax<RawMailMessage>(page, "local_mail_get_message", { messageid: id }),
      { signal: ctx.signal }
    ),
  project: (m) => ({
    id: m.id,
    subject: m.subject,
    text: htmlToText(m.content),
    course: m.course.fullname,
    sender: m.sender.fullname,
    recipients: m.recipients.map((r) => r.fullname),
    time: unixToIso(m.time),
    attachments: m.attachments.map((a) => ({ filename: a.filename, filesize: a.filesize, url: a.fileurl })),
  }),
});

/** Полный текст письма внутренней почты SmartLMS по id (см. listMessages). */
export function getMessage(messageId: number): Promise<LmsMessage> {
  return lmsMessage(messageId);
}

const lmsMaterials = defineResource<number, ModuleLink[]>({
  name: "lms.materials",
  ttl: TTL.medium,
  key: (courseId) => String(courseId),
  load: (courseId, ctx) =>
    withPage(
      `${BASE_URL}/course/view.php?id=${courseId}`,
      (page) =>
        page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href*="/mod/"]'));
          const seen = new Set<string>();
          const result: Array<{ type: string; cmid: number | null; title: string; url: string }> = [];
          for (const a of anchors) {
            const href = (a as HTMLAnchorElement).href;
            const modMatch = href.match(/\/mod\/([a-z]+)\/view\.php/);
            if (!modMatch) continue;
            const idMatch = href.match(/[?&]id=(\d+)/);
            const title = a.textContent?.trim().replace(/\s+/g, " ") || "";
            if (!title || seen.has(href)) continue;
            seen.add(href);
            result.push({ type: modMatch[1], cmid: idMatch ? Number(idMatch[1]) : null, title, url: href });
          }
          return result;
        }),
      { signal: ctx.signal }
    ),
});

export function getCourseMaterials(courseId: number): Promise<ModuleLink[]> {
  return lmsMaterials(courseId);
}

const lmsAssignments = defineResource<number, Array<Record<string, string>>>({
  name: "lms.assignments",
  ttl: TTL.medium,
  key: (courseId) => String(courseId),
  load: (courseId, ctx) =>
    withPage(
      `${BASE_URL}/mod/assign/index.php?id=${courseId}`,
      (page) => extractTable(page, "table.generaltable"),
      { signal: ctx.signal }
    ),
});

export function listAssignments(courseId: number): Promise<Array<Record<string, string>>> {
  return lmsAssignments(courseId);
}

const lmsGrades = defineResource<number, Array<Record<string, string>>>({
  name: "lms.grades",
  ttl: TTL.medium,
  key: (courseId) => String(courseId),
  load: (courseId, ctx) =>
    withPage(
      `${BASE_URL}/grade/report/user/index.php?id=${courseId}`,
      async (page) => {
        const rows = await extractTable(page, "table.user-grade");
        if (rows.length > 0) return rows;
        return extractTable(page, "table.generaltable");
      },
      { signal: ctx.signal }
    ),
});

export function getGrades(courseId: number): Promise<Array<Record<string, string>>> {
  return lmsGrades(courseId);
}

/** Открыть произвольную страницу edu.hse.ru (относительный путь) — для случаев вне готовых тулов. */
export function openPage(relativePath: string): Promise<PageDump> {
  const url = resolveScopedUrl(BASE_URL, relativePath);
  return withPage(url, (page) => dumpPage(page));
}
