import type { Page } from "playwright";
import { openAuthenticatedPage } from "../../auth/browser-session.js";
import { config } from "../../config.js";
import { dumpPage, extractTable, type PageDump } from "../../dom-utils.js";
import { formatLocalDate } from "../../date-utils.js";
import { resolveScopedUrl } from "../../url-utils.js";

const BASE_URL = "https://lk.hse.ru";

const stripHtmlElk = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Единый личный кабинет / SmartPoint (lk.hse.ru). Разведано вживую 2026-09-15:
 * - реальные разделы: /task, /claim, /service, /schedule, /student-services, /faq
 * - это SPA поверх REST/GraphQL API под /api/*; после логина в localStorage появляется
 *   OIDC access_token, который нужно слать как `Authorization: Bearer <token>` — простой
 *   fetch с cookie (credentials: include) без этого заголовка возвращает 401.
 * - /api/get-myschedule?begin_date=YYYY-MM-DD&end_date=YYYY-MM-DD отдаёт чистый JSON
 *   расписания (с онлайн-ссылками на пары) — работает из любой сети, в отличие от RUZ.
 * - /api/get-user отдаёт базовую identity-информацию (имя, email, роли), но НЕ академическую
 *   карточку (рейтинг/группа/факультет). Изначально предполагалось, что карточка грузится через
 *   нераскрытый /api/str-graphql — не подтвердилось: на деле это обычный REST-эндпоинт
 *   /api/get-academic-data (тот же Bearer-токен), см. getAcademicData().
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

/** Расписание студента через ЕЛК — работает из любой сети (в отличие от ruz_*). */
export function getSchedule(from: Date, to: Date): Promise<ElkScheduleDay[]> {
  return fetchElkApi<ElkScheduleDay[]>(
    `/api/get-myschedule?begin_date=${formatLocalDate(from, "-")}&end_date=${formatLocalDate(to, "-")}`
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

export interface ElkAcademicData {
  student_id: string;
  student_mdm: string;
  learn_program: string;
  course_number: number;
  group_name: string;
  faculty: string;
  study_form: string;
  study_level: string;
  status: string;
  percentile: number | null;
  place_group_op: number | null;
  place_group_op_total: number | null;
  gpa: number | null;
  credits: number | null;
  kud: number | null;
  rating: number | null;
  filial: string;
  [key: string]: unknown;
}

/**
 * Академическая карточка студента (структурированный JSON): рейтинг, GPA, программа, факультет,
 * курс, группа. lk.hse.ru/api/get-academic-data — реверс-инжинирен 2026-09-15, тот же
 * Bearer-токен, что и остальные elk_get_*. Отдаёт массив с одной записью на пользователя.
 */
export function getAcademicData(): Promise<ElkAcademicData[]> {
  return fetchElkApi<ElkAcademicData[]>("/api/get-academic-data");
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

export interface ElkClaim {
  num: string;
  text: string;
  service: string;
  executorFio: string;
  createdByEmail: string;
  createdByFio: string;
  stateName: string;
  active: boolean;
  created: string;
  updated: string;
  url: string | null;
}

interface RawClaim {
  num: string;
  text: string;
  service: string;
  executor_fio: string;
  created_by_email: string;
  created_by_fio: string;
  state_name: string;
  active: string;
  created: string;
  updated: string;
  url: string;
}

// API отдаёт url заявки с "хвостом" вида `...RequestGUID=...</link><display>Форма</display>
// </hyperlink>` — похоже на нестрипнутый rich-text/hyperlink формат источника (Camunda/BPM).
// Обрезаем по первому "<", валидный URL этот символ содержать не может.
function cleanClaimUrl(raw: string): string | null {
  const url = raw.slice(0, raw.indexOf("<") === -1 ? raw.length : raw.indexOf("<")).trim();
  return url || null;
}

/**
 * История заявок пользователя (lk.hse.ru/claim) — разведано вживую 2026-09-15. В отличие от
 * большинства elk_* эндпоинтов требует username (email) явным query-параметром, а не берёт его
 * из токена.
 */
export function listRequests(limit = 500): Promise<{ count: number; requests: ElkClaim[] }> {
  const path = `/api/claims?username=${encodeURIComponent(config.hseEmail)}&limit=${limit}&sort_by=created&order_by=desc`;
  return fetchElkApi<{ data: RawClaim[]; count: number }>(path).then((raw) => ({
    count: raw.count,
    requests: raw.data.map((c) => ({
      num: c.num,
      text: c.text,
      service: c.service,
      executorFio: c.executor_fio,
      createdByEmail: c.created_by_email,
      createdByFio: c.created_by_fio,
      stateName: c.state_name.trim(),
      active: c.active === "1",
      created: c.created,
      updated: c.updated,
      url: cleanClaimUrl(c.url),
    })),
  }));
}

/**
 * Задачи пользователя (lk.hse.ru/task) — тот же API-паттерн, что и /api/claims (username, limit,
 * sort_by, order_by), реверс-инжинирен 2026-09-15. Поля отдельной задачи не типизированы: на
 * аккаунте, где это проверялось, задач не было (`count: 0`), поэтому форма ответа возвращается
 * как есть, без предположений о конкретных именах полей.
 */
export function listTasks(limit = 500): Promise<{ count: number; data: unknown[] }> {
  const path = `/api/tasks?username=${encodeURIComponent(config.hseEmail)}&limit=${limit}&sort_by=created&order_by=desc`;
  return fetchElkApi<{ count: number; data: unknown[] }>(path);
}

interface RawDpoApplicationsResponse {
  data: {
    docs: unknown[];
    filters: { status: Array<{ value: string; label: string }> };
  };
}

/**
 * Мои программы ДПО (lk.hse.ru/dpo/my-programs → GET /dpo/rest/application) — реверс-инжинирено
 * 2026-09-15. Модуль «Моё ДПО» релевантен только студентам, проходящим доп. проф. образование
 * помимо основной программы; на проверенном аккаунте программ нет (`docs: []`), поэтому форма
 * отдельной записи не подтверждена вживую — возвращается как есть, без типизации полей.
 * `statusLabels` — расшифровка возможных статусов (processing/payment/waiting/studies/...).
 */
export function listDpoPrograms(): Promise<{ docs: unknown[]; statusLabels: Record<string, string> }> {
  return fetchElkApi<RawDpoApplicationsResponse>("/dpo/rest/application").then((raw) => ({
    docs: raw.data.docs,
    statusLabels: Object.fromEntries(raw.data.filters.status.map((s) => [s.value, s.label])),
  }));
}

export interface ElkLoginRecord {
  date: string;
  action: string;
  ip: string;
  place: string;
  device: string;
  deviceType: string;
}

interface RawLoginRecord {
  date: string;
  action: string;
  ip: string;
  place: string;
  deviceData: { device: string; type: string };
}

/**
 * История действий/входов в ЕЛК (вкладка "Прочее" → "История действий" на /profile, обычно не
 * захватывается elk_get_profile — Vue-таб рендерит контент только по клику, а не сразу в DOM).
 * Полезно для проверки безопасности аккаунта (неожиданные IP/устройства). Реверс-инжинирено
 * 2026-09-15: `GET /api/get-action-history-records?offset=0`, тот же Bearer-токен.
 */
export function getLoginHistory(offset = 0): Promise<{ count: number; actions: ElkLoginRecord[] }> {
  return fetchElkApi<{ count: number; actions: RawLoginRecord[] }>(
    `/api/get-action-history-records?offset=${offset}`
  ).then((raw) => ({
    count: raw.count,
    actions: raw.actions.map((a) => ({
      date: a.date,
      action: a.action,
      ip: a.ip,
      place: a.place,
      device: a.deviceData.device,
      deviceType: a.deviceData.type,
    })),
  }));
}

export interface ElkNotification {
  id: number;
  title: string;
  text: string;
  isImportant: boolean;
  isRead: boolean;
  date: string;
}

interface RawNotification {
  id: number;
  title: string;
  text: string;
  is_important: boolean;
  is_read: boolean;
  date: string;
}

/**
 * Уведомления ЕЛК (`/notification`, колокольчик в шапке) — реверс-инжинирено 2026-09-15:
 * `GET /api/notifications?is_no_read=false&offset=0&limit=<n>`, тот же Bearer-токен.
 * `is_no_read=false` — включая уже прочитанные (иначе список часто пуст).
 */
export function getNotifications(limit = 20): Promise<{ count: number; notifications: ElkNotification[] }> {
  return fetchElkApi<{ data: RawNotification[]; count: number }>(
    `/api/notifications?is_no_read=false&offset=0&limit=${limit}`
  ).then((raw) => ({
    count: raw.count,
    notifications: raw.data.map((n) => ({
      id: n.id,
      title: n.title,
      text: stripHtmlElk(n.text),
      isImportant: n.is_important,
      isRead: n.is_read,
      date: n.date,
    })),
  }));
}

export interface ElkAntiplagiatStatus {
  processing: number;
  completed: number;
  total: number;
}

/**
 * Статус проверок в системе Антиплагиат (lk.hse.ru/flow/antiplagiat/...) — реверс-инжинирен
 * 2026-09-15: страница подачи заявки на проверку сама дёргает этот эндпоинт для отображения
 * счётчика "Использовано проверок: N из <лимит>" (сам лимит квоты в ответе не встречается,
 * похоже, задан на фронтенде/CMS отдельно). Только статус — отправка файла на проверку не
 * реализована (запись данных, требует явного согласия пользователя).
 */
export function getAntiplagiatStatus(): Promise<ElkAntiplagiatStatus> {
  const path = `/antiplagiat/api/antiplagiat/attempts?email=${encodeURIComponent(config.hseEmail)}`;
  return fetchElkApi<ElkAntiplagiatStatus>(path);
}

const SOP_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/yii_index.php%3Fr=rt/hse-rt-student-event-list";

/**
 * Статус «Оцени свои курсы» / СОП (студенческая оценка преподавания) — периоды оценки и статус
 * заполнения анкеты по каждому. Реверс-инжинирено 2026-09-15: это отдельный от edu.hse.ru
 * legacy-портал lms.hse.ru (Yii, серверный рендеринг, без JSON API), доступ через SSO-мост
 * /elk_login.php. Данные — обычная HTML-таблица `table.event-table` (thead/tbody), извлекается
 * через extractTable.
 */
export async function getCourseEvaluationStatus(): Promise<Array<Record<string, string>>> {
  const page = await openAuthenticatedPage(SOP_URL);
  try {
    await page.waitForSelector("table.event-table", { timeout: 10_000 }).catch(() => {});
    return await extractTable(page, "table.event-table");
  } finally {
    await page.close();
  }
}

const VKR_URL = "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/%3Fap_list";

/**
 * Мои работы (ВКР/КР/Проект) — статус проверки выпускной квалификационной/курсовой работы:
 * тема, процент заимствований, статус проверки, оценка, рецензия. Тот же портал lms.hse.ru,
 * что и getCourseEvaluationStatus, другая цель SSO-моста /elk_login.php. Таблица без класса
 * (единственная на странице) — на аккаунте без зарегистрированной темы работы возвращает
 * пустой массив (страница показывает только пояснение "Тема работы не занесена в систему АСАВ").
 */
export async function getThesisStatus(): Promise<Array<Record<string, string>>> {
  const page = await openAuthenticatedPage(VKR_URL);
  try {
    await page.waitForSelector("table", { timeout: 10_000 }).catch(() => {});
    return await extractTable(page, "table");
  } finally {
    await page.close();
  }
}

const INTERNSHIP_LIST_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/yii_index.php%3Fr=pr/request-student/demand-list";

const EMPTY_TABLE_PLACEHOLDER = "Ничего не найдено.";

/**
 * Список заявок на практику/стажировку («Модуль Практика» на lms.hse.ru, доступ через тот же
 * SSO-мост `/elk_login.php`). Read-only статус — сама подача заявки на практику отдельная форма,
 * не реализована. Таблица `table.theme_list_table` без содержательных заголовков в пустом
 * состоянии отдаёт строку-заглушку "Ничего не найдено." как будто это данные — отфильтровываем
 * её, иначе пустой список практик выглядел бы как одна поддельная запись.
 */
export async function listInternships(): Promise<Array<Record<string, string>>> {
  const page = await openAuthenticatedPage(INTERNSHIP_LIST_URL);
  try {
    await page.waitForSelector("table.theme_list_table", { timeout: 10_000 }).catch(() => {});
    const rows = await extractTable(page, "table.theme_list_table");
    return rows.filter((r) => !Object.values(r).includes(EMPTY_TABLE_PLACEHOLDER));
  } finally {
    await page.close();
  }
}

const PORTFOLIO_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/index.php%3Fpage=portfolio";

/**
 * Электронное портфолио студента (баллы за учёбу/науку/ДПО/практики/культурно-творческую и
 * общественную деятельность, спорт, олимпиады — влияет на повышенную стипендию). Реверс-
 * инжинирено 2026-09-15: НЕ требует отдельного логина portfolio.hse.ru, как считалось раньше —
 * это отдельная страница на том же портале lms.hse.ru (`index.php?page=portfolio`), доступная
 * через тот же SSO-мост `/elk_login.php`, что и СОП/ВКР. Смешанная вёрстка (профиль + несколько
 * таблиц + список достижений, каждый раздел деятельности — вложенная страница по
 * `page_point=view_*`) — текстовый дамп через dumpPage, а не extractTable.
 */
export async function getPortfolio(): Promise<PageDump> {
  const page = await openAuthenticatedPage(PORTFOLIO_URL);
  try {
    return await dumpPage(page);
  } finally {
    await page.close();
  }
}

const SCHOLARSHIP_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/index.php%3Fpage=portfolio_scholarship";

/**
 * История заявок на повышенную государственную академическую стипендию (портал lms.hse.ru,
 * тот же SSO-мост `/elk_login.php`). В отличие от общей истории заявок ЕЛК
 * (`elk_list_requests`), данные грузятся не через DataTables server-side POST (формат которого
 * не удалось поймать — см. `?r=st/request/history-dt`), а простым GET
 * `act.php?on=portfolio_scholarship&name=history_apps` без параметров пагинации/сортировки —
 * поэтому реализуемо без реверс-инжиниринга протокола DataTables. На проверенном аккаунте заявок
 * не было (`{"data":[]}`), поэтому форма отдельной записи не типизирована.
 */
export async function getScholarshipHistory(): Promise<unknown[]> {
  const page = await openAuthenticatedPage(SCHOLARSHIP_URL);
  try {
    const result = await page.evaluate(async () => {
      const res = await fetch(`act.php?on=portfolio_scholarship&name=history_apps&_=${Date.now()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`lms.hse.ru act.php вернул ${res.status}`);
      }
      return (await res.json()) as { data: unknown[] };
    });
    return result.data;
  } finally {
    await page.close();
  }
}

async function dumpAuthenticatedPage(url: string): Promise<PageDump> {
  const page: Page = await openAuthenticatedPage(url);
  try {
    return await dumpPage(page);
  } finally {
    await page.close();
  }
}

/**
 * Полная страница профиля (текст + ссылки) — общая информация и контакты. Для структурированной
 * академической карточки (рейтинг, GPA, группа, факультет) используйте getAcademicData().
 */
export function getProfile(): Promise<PageDump> {
  return dumpAuthenticatedPage(`${BASE_URL}/profile`);
}

// pmo.hse.ru — домен хелпдеска (создание тикетов), на который ведут документированные ссылки
// со страниц профиля/student-services, поэтому явно разрешён в дополнение к baseUrl.
export function openPage(relativePath: string): Promise<PageDump> {
  const url = resolveScopedUrl(BASE_URL, relativePath, ["pmo.hse.ru"]);
  return dumpAuthenticatedPage(url);
}
