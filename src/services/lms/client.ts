import type { Page } from "playwright";
import { openAuthenticatedPage } from "../../auth/browser-session.js";
import { cached, TTL } from "../../cache.js";
import { dumpPage, extractTable, type PageDump } from "../../dom-utils.js";
import { formatLocalDate } from "../../date-utils.js";
import { resolveScopedUrl } from "../../url-utils.js";

const BASE_URL = "https://edu.hse.ru";

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

/**
 * Список курсов через внутренний AJAX-эндпоинт дашборда (см. fetchMoodleAjax) — вместо парсинга
 * ссылок со страницы: даёт прогресс прохождения, даты начала/окончания и категорию, которых нет
 * в простой ссылке на курс. classification: "all" — все курсы, включая скрытые из вида.
 */
export function listCourses(): Promise<CourseOverview[]> {
  return cached("lms:courses", TTL.medium, listCoursesUncached);
}

async function listCoursesUncached(): Promise<CourseOverview[]> {
  const page = await openAuthenticatedPage(`${BASE_URL}/my/courses.php`);
  try {
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
  } finally {
    await page.close();
  }
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

/**
 * События календаря Moodle «нужно действие» (сдать задание, пройти тест) за период — один
 * AJAX-запрос вместо обхода страницы заданий каждого курса; тот же сервис, что питает блок
 * «Таймлайн» дашборда. Проверено вживую 2026-10-14: сданные работы в ответ не попадают;
 * просроченное несданное приходит с `overdue: true` и `actionable: false` (сдача закрыта) —
 * поэтому по `actionable` фильтровать нельзя. Ключ кэша дневной гранулярности.
 */
export function listActionEvents(from: Date, to: Date): Promise<LmsActionEvent[]> {
  const key = `lms:calendar:${formatLocalDate(from, "-")}:${formatLocalDate(to, "-")}`;
  return cached(key, TTL.medium, () => listActionEventsUncached(from, to));
}

async function listActionEventsUncached(from: Date, to: Date): Promise<LmsActionEvent[]> {
  const page = await openAuthenticatedPage(`${BASE_URL}/my/courses.php`);
  try {
    const events: LmsActionEvent[] = [];
    let afterEventId = 0;
    for (let i = 0; i < CALENDAR_MAX_PAGES; i++) {
      const data = await fetchMoodleAjax<{ events: RawActionEvent[]; lastid?: number }>(
        page,
        "core_calendar_get_action_events_by_timesort",
        {
          timesortfrom: Math.floor(from.getTime() / 1000),
          timesortto: Math.floor(to.getTime() / 1000),
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
      afterEventId = data.lastid;
    }
    return events;
  } finally {
    await page.close();
  }
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

/**
 * Внутренняя почта SmartLMS (плагин local_mail, edu.hse.ru/local/mail/) — переписка с
 * преподавателями внутри курсов, полностью отдельная от корпоративной почты Яндекс 360
 * (см. src/services/mail/). Реверс-инжинирено 2026-09-15 через тот же внутренний AJAX-сервис
 * Moodle (fetchMoodleAjax), метод local_mail_search_messages с ролями to/cc/bcc — это входящие.
 */
export function listMessages(limit = 50): Promise<LmsMessageSummary[]> {
  return cached(`lms:messages:${limit}`, TTL.short, () => listMessagesUncached(limit));
}

async function listMessagesUncached(limit: number): Promise<LmsMessageSummary[]> {
  const page = await openAuthenticatedPage(`${BASE_URL}/local/mail/view.php?t=inbox`);
  try {
    const messages = await fetchMoodleAjax<RawMailMessageSummary[]>(page, "local_mail_search_messages", {
      query: { roles: ["to", "cc", "bcc"], deleted: false },
      limit,
    });
    return messages.map((m) => ({
      id: m.id,
      subject: m.subject,
      course: m.course.fullname,
      sender: m.sender.fullname,
      time: unixToIso(m.time),
      unread: m.unread,
      starred: m.starred,
      numAttachments: m.numattachments,
    }));
  } finally {
    await page.close();
  }
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

/** Полный текст письма внутренней почты SmartLMS по id (см. listMessages). */
export function getMessage(messageId: number): Promise<LmsMessage> {
  return cached(`lms:message:${messageId}`, TTL.medium, () => getMessageUncached(messageId));
}

async function getMessageUncached(messageId: number): Promise<LmsMessage> {
  const page = await openAuthenticatedPage(`${BASE_URL}/local/mail/view.php?t=inbox`);
  try {
    const m = await fetchMoodleAjax<RawMailMessage>(page, "local_mail_get_message", { messageid: messageId });
    return {
      id: m.id,
      subject: m.subject,
      text: htmlToText(m.content),
      course: m.course.fullname,
      sender: m.sender.fullname,
      recipients: m.recipients.map((r) => r.fullname),
      time: unixToIso(m.time),
      attachments: m.attachments.map((a) => ({ filename: a.filename, filesize: a.filesize, url: a.fileurl })),
    };
  } finally {
    await page.close();
  }
}

export function getCourseMaterials(courseId: number): Promise<ModuleLink[]> {
  return cached(`lms:materials:${courseId}`, TTL.medium, () => getCourseMaterialsUncached(courseId));
}

async function getCourseMaterialsUncached(courseId: number): Promise<ModuleLink[]> {
  const page = await openAuthenticatedPage(`${BASE_URL}/course/view.php?id=${courseId}`);
  try {
    return await page.evaluate(() => {
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
    });
  } finally {
    await page.close();
  }
}

export function listAssignments(courseId: number): Promise<Array<Record<string, string>>> {
  return cached(`lms:assignments:${courseId}`, TTL.medium, () => listAssignmentsUncached(courseId));
}

async function listAssignmentsUncached(courseId: number): Promise<Array<Record<string, string>>> {
  const page = await openAuthenticatedPage(`${BASE_URL}/mod/assign/index.php?id=${courseId}`);
  try {
    return await extractTable(page, "table.generaltable");
  } finally {
    await page.close();
  }
}

export function getGrades(courseId: number): Promise<Array<Record<string, string>>> {
  return cached(`lms:grades:${courseId}`, TTL.medium, () => getGradesUncached(courseId));
}

async function getGradesUncached(courseId: number): Promise<Array<Record<string, string>>> {
  const page = await openAuthenticatedPage(`${BASE_URL}/grade/report/user/index.php?id=${courseId}`);
  try {
    const rows = await extractTable(page, "table.user-grade");
    if (rows.length > 0) return rows;
    return await extractTable(page, "table.generaltable");
  } finally {
    await page.close();
  }
}

/** Открыть произвольную страницу edu.hse.ru (относительный путь) — для случаев вне готовых тулов. */
export async function openPage(relativePath: string): Promise<PageDump> {
  const url = resolveScopedUrl(BASE_URL, relativePath);
  const page = await openAuthenticatedPage(url);
  try {
    return await dumpPage(page);
  } finally {
    await page.close();
  }
}
