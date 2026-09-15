import type { Page } from "playwright";
import { openAuthenticatedPage } from "../../auth/browser-session.js";
import { dumpPage, type PageDump } from "../../dom-utils.js";

const BASE_URL = "https://lk.hse.ru";

/**
 * Единый личный кабинет / SmartPoint (lk.hse.ru). Разведано вживую 2026-09-15:
 * - реальные разделы: /task, /claim, /service, /schedule, /student-services, /faq
 * - это SPA поверх REST/GraphQL API под /api/*; после логина в localStorage появляется
 *   OIDC access_token, который нужно слать как `Authorization: Bearer <token>` — простой
 *   fetch с cookie (credentials: include) без этого заголовка возвращает 401.
 * - /api/get-myschedule?begin_date=YYYY-MM-DD&end_date=YYYY-MM-DD отдаёт чистый JSON
 *   расписания (с онлайн-ссылками на пары) — работает из любой сети, в отличие от RUZ.
 * - /api/get-user отдаёт базовую identity-информацию (имя, email, роли), но НЕ академическую
 *   карточку (рейтинг/группа/факультет) — та подгружается через /api/str-graphql (POST,
 *   запрос не реверс-инжинирен), поэтому для неё используем текстовый дамп страницы /profile.
 * - "Заказ справок" (зачётка, подтверждение обучения и т.п.) живёт на
 *   /student-services?section=documents&subsection=certificates — конкретные кнопки не
 *   расковырены (форма отправки), см. ROADMAP.md.
 */

async function fetchElkApi<T>(apiPath: string): Promise<T> {
  const page = await openAuthenticatedPage(`${BASE_URL}/profile`);
  try {
    await page.waitForFunction(() => !!localStorage.getItem("access_token"), undefined, {
      timeout: 10_000,
    });
    return await page.evaluate(async (path) => {
      const token = localStorage.getItem("access_token");
      const res = await fetch(path, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(`lk.hse.ru API ${path} вернул ${res.status}`);
      }
      return res.json();
    }, apiPath);
  } finally {
    await page.close();
  }
}

export interface ElkLesson {
  auditorium: string;
  building: string;
  name: string;
  lesson_type: string;
  begin_time: string;
  end_time: string;
  lecturer: string;
  parent_schedule: string;
  url1?: string | null;
  url1_description?: string | null;
  url2?: string | null;
  url2_description?: string | null;
  [key: string]: unknown;
}

export interface ElkScheduleDay {
  date: string;
  lessons: ElkLesson[];
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Расписание студента через ЕЛК — работает из любой сети (в отличие от ruz_*). */
export function getSchedule(from: Date, to: Date): Promise<ElkScheduleDay[]> {
  return fetchElkApi<ElkScheduleDay[]>(
    `/api/get-myschedule?begin_date=${toIsoDate(from)}&end_date=${toIsoDate(to)}`
  );
}

export interface ElkUserInfo {
  external_id: string;
  first_name: string;
  last_name: string;
  middle_name: string;
  email: string;
  roles: string[];
  target_groups: string[];
  [key: string]: unknown;
}

/** Базовая identity-информация из ЕЛК (структурированный JSON, без академической карточки). */
export function getUserInfo(): Promise<ElkUserInfo> {
  return fetchElkApi<ElkUserInfo>("/api/get-user");
}

export interface ElkServiceResult {
  id: number;
  name: string;
  desc: string | null;
  url: string;
  score: number;
}

export interface ElkSearchServicesResponse {
  total_hits: number;
  categories: Record<string, number>;
  results: ElkServiceResult[];
}

interface RawSearchAllResponse {
  total_hits: number;
  categories: Record<string, number>;
  data: Array<{
    category: string;
    score: number;
    data: { id: number; name: string; desc: string | null; url: string };
  }>;
}

/**
 * Полнотекстовый поиск по каталогу сервисов ЕЛК (lk.hse.ru/api/search/search-all) — разведано
 * вживую 2026-09-15 через шапку SmartPoint: строка поиска ищет по 254 сервисам сразу, а также
 * (отдельными категориями с тем же эндпоинтом) по сотрудникам/студентам/подразделениям.
 * `categories` в ответе — счётчики по всем категориям для запроса, даже когда `category=services`
 * сужает `data` до одной из них.
 */
export function searchServices(query: string, limit = 10): Promise<ElkSearchServicesResponse> {
  const path = `/api/search/search-all?query=${encodeURIComponent(query)}&offset=0&limit=${limit}&category=services`;
  return fetchElkApi<RawSearchAllResponse>(path).then((raw) => ({
    total_hits: raw.total_hits,
    categories: raw.categories,
    results: raw.data.map((item) => ({
      id: item.data.id,
      name: item.data.name,
      desc: item.data.desc,
      url: item.data.url,
      score: item.score,
    })),
  }));
}

async function dumpAuthenticatedPage(url: string): Promise<PageDump> {
  const page: Page = await openAuthenticatedPage(url);
  try {
    return await dumpPage(page);
  } finally {
    await page.close();
  }
}

/** Полная страница профиля (текст + ссылки) — включает академическую карточку (рейтинг, группа, факультет). */
export function getProfile(): Promise<PageDump> {
  return dumpAuthenticatedPage(`${BASE_URL}/profile`);
}

export function openPage(relativePath: string): Promise<PageDump> {
  const url = relativePath.startsWith("http") ? relativePath : `${BASE_URL}${relativePath}`;
  return dumpAuthenticatedPage(url);
}
