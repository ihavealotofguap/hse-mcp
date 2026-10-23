import { getApiRequestContext, withPage } from "../../auth/browser-session.js";
import { createBreaker } from "../../breaker.js";
import { TTL } from "../../cache.js";
import { config } from "../../config.js";
import { dumpPage, extractTable, type PageDump } from "../../dom-utils.js";
import { addDays, formatLocalDate } from "../../date-utils.js";
import { acquireRequestTurn } from "../../limiter.js";
import { defineResource, type LoadContext, type ResourceCallOptions } from "../../resource.js";
import { assertReadOnlyPath, resolveScopedUrl } from "../../url-utils.js";

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
 *   расковырены (форма отправки), см. локальные заметки разведки (не в репозитории).
 */

// Токен берём один раз через страницу /profile и дальше ходим в API напрямую (без страницы) до
// истечения. Срок — из `exp` JWT; если токен не JWT или `exp` нет, живёт консервативные 60 с.
const TOKEN_SKEW_MS = 30_000;
const TOKEN_FALLBACK_TTL_MS = 60_000;
const API_TIMEOUT_MS = 20_000;
// Если прямой путь отказал дважды, а запрос через страницу прошёл — значит, API ЕЛК чем-то не
// устраивает запрос вне браузерной страницы. Тогда идём через страницу, а через 10 минут
// пробуем прямой путь снова (одна проба; удача возвращает прямой путь, неудача продлевает).
const DIRECT_COOLDOWN_MS = 10 * 60_000;
const directBreaker = createBreaker(DIRECT_COOLDOWN_MS);

interface TokenEntry {
  token: string;
  expiresAt: number;
}

let tokenEntry: TokenEntry | null = null;
let tokenPromise: Promise<string> | null = null;

/** Время истечения JWT в мс (из `exp`) либо null, если токен не JWT или без `exp`. */
export function tokenExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof json.exp === "number" && Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function acquireToken(): Promise<string> {
  return withPage(`${BASE_URL}/profile`, async (page) => {
    await page.waitForFunction(() => !!localStorage.getItem("access_token"), undefined, {
      timeout: 10_000,
    });
    let token = await page.evaluate(() => localStorage.getItem("access_token"));
    // storageState на диске восстанавливает localStorage, так что сразу после перезапуска там
    // может лежать уже просроченный токен — даём SPA несколько секунд заменить его свежим.
    const expiry = token ? tokenExpiryMs(token) : null;
    if (token && expiry !== null && expiry - TOKEN_SKEW_MS <= Date.now()) {
      await page
        .waitForFunction((old) => localStorage.getItem("access_token") !== old, token, { timeout: 5_000 })
        .catch(() => {});
      token = await page.evaluate(() => localStorage.getItem("access_token"));
    }
    if (!token) throw new Error("ЕЛК не выдал access_token — возможно, сессия слетела");
    tokenEntry = { token, expiresAt: tokenExpiryMs(token) ?? Date.now() + TOKEN_FALLBACK_TTL_MS };
    return token;
  });
}

function getElkToken(): Promise<string> {
  if (tokenEntry && tokenEntry.expiresAt - TOKEN_SKEW_MS > Date.now()) {
    return Promise.resolve(tokenEntry.token);
  }
  // Параллельные вызовы делят одно получение токена, а не открывают по странице на каждый.
  if (!tokenPromise) {
    const promise: Promise<string> = acquireToken().finally(() => {
      if (tokenPromise === promise) tokenPromise = null;
    });
    tokenPromise = promise;
  }
  return tokenPromise;
}

function invalidateToken(usedToken: string): void {
  // Не сбрасываем токен, который уже успели обновить параллельным вызовом.
  if (tokenEntry?.token === usedToken) tokenEntry = null;
}

/** Путь без query: в сообщения об ошибках не должны попадать email, поисковые строки и т.п. */
const pathOnly = (apiPath: string): string => apiPath.split("?")[0] ?? apiPath;

type DirectResult<T> = { ok: true; body: T } | { ok: false; status: number; error?: string };

async function requestDirect<T>(apiPath: string, token: string, signal: AbortSignal): Promise<DirectResult<T>> {
  await acquireRequestTurn(signal);
  const api = await getApiRequestContext();
  let res: Awaited<ReturnType<typeof api.get>>;
  try {
    res = await api.get(`${BASE_URL}${apiPath}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: API_TIMEOUT_MS,
    });
  } catch (err) {
    if (signal.aborted) throw signal.reason ?? err;
    // Сообщение Playwright дописывает «Call log:» с полным URL, query и всеми заголовками
    // (Authorization, cookie) — оставляем только первую строку, без query.
    const raw = err instanceof Error ? err.message : String(err);
    const firstLine = (raw.split("\n")[0] ?? "").replace(/\?\S*/g, "").trim();
    throw new Error(`lk.hse.ru API ${pathOnly(apiPath)}: ${firstLine || "запрос не выполнен"}`);
  }
  if (!res.ok()) return { ok: false, status: res.status() };
  try {
    return { ok: true, body: (await res.json()) as T };
  } catch {
    // 200 не-JSON — обычно редирект на страницу входа вместо 401.
    return { ok: false, status: res.status(), error: "ответ не JSON" };
  }
}

/** Запасной путь: открыть /profile и сделать fetch внутри страницы. */
function fetchElkApiViaPage<T>(apiPath: string, signal: AbortSignal): Promise<T> {
  return withPage(
    `${BASE_URL}/profile`,
    async (page) => {
      await page.waitForFunction(() => !!localStorage.getItem("access_token"), undefined, {
        timeout: 10_000,
      });
      return page.evaluate(async (path) => {
        const token = localStorage.getItem("access_token");
        const res = await fetch(path, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          throw new Error(`lk.hse.ru API ${path.split("?")[0]} вернул ${res.status}`);
        }
        return res.json();
      }, apiPath) as Promise<T>;
    },
    { signal }
  );
}

const describeFailure = (r: { status: number; error?: string }): string =>
  `${r.status}${r.error ? ` (${r.error})` : ""}`;

/**
 * Политика отказов прямого пути:
 * - 401 и не-JSON (редирект на вход): токен сбрасывается, одна повторная попытка со свежим;
 * - 403: это права, а не токен — токен не сбрасывается, повтор с тем же;
 * - 5xx и прочее: ошибка как есть, без отката на страницу и без срабатывания выключателя;
 * - два отказа подряд: один заход через страницу; прошёл — выключатель срабатывает на 10 минут,
 *   не прошёл — ошибка пользователю, выключатель не трогаем (это реальный отказ, не особенность
 *   вне-браузерного запроса).
 */
async function fetchElkApiUncached<T>(apiPath: string, signal: AbortSignal): Promise<T> {
  if (!directBreaker.allow()) return fetchElkApiViaPage<T>(apiPath, signal);

  let lastFailure = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getElkToken();
    const result = await requestDirect<T>(apiPath, token, signal);
    if (result.ok) {
      directBreaker.reset();
      return result.body;
    }
    lastFailure = describeFailure(result);
    const authFailure = result.status === 401 || result.status === 403 || result.error !== undefined;
    if (!authFailure) throw new Error(`lk.hse.ru API ${pathOnly(apiPath)} вернул ${result.status}`);
    if (result.status !== 403) invalidateToken(token);
  }

  const data = await fetchElkApiViaPage<T>(apiPath, signal).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} (прямой запрос тоже не прошёл: ${lastFailure})`);
  });
  directBreaker.trip();
  console.error(
    `hsemcp: прямые запросы к lk.hse.ru/api не работают (${lastFailure}) — иду через страницу ${DIRECT_COOLDOWN_MS / 60_000} мин`
  );
  return data;
}

const elkJson = <T>(apiPath: string, ctx: LoadContext): Promise<T> => fetchElkApiUncached<T>(apiPath, ctx.signal);

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

/** Понедельник (локальная дата, 00:00) недели, в которую попадает `d`. */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

const MAX_SCHEDULE_WEEKS = 53;

// Расписание грузится и кэшируется по неделям (пн–вс): разные диапазоны (сегодня/неделя/две недели)
// делят блоки, а не бьют по разным ключам.
const elkScheduleWeek = defineResource<Date, ElkScheduleDay[]>({
  name: "elk.schedule-week",
  ttl: TTL.medium,
  key: (monday) => formatLocalDate(monday, "-"),
  load: (monday, ctx) =>
    elkJson<ElkScheduleDay[]>(
      `/api/get-myschedule?begin_date=${formatLocalDate(monday, "-")}&end_date=${formatLocalDate(addDays(monday, 6), "-")}`,
      ctx
    ),
});

/** Расписание студента через ЕЛК — работает из любой сети (в отличие от RUZ). */
export async function getSchedule(from: Date, to: Date, opts?: ResourceCallOptions): Promise<ElkScheduleDay[]> {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Некорректная дата в диапазоне расписания (Invalid Date)");
  }
  const fromKey = formatLocalDate(from, "-");
  const toKey = formatLocalDate(to, "-");
  if (fromKey > toKey) return [];

  const weeks: Date[] = [];
  for (let m = mondayOf(from); formatLocalDate(m, "-") <= toKey; m = addDays(m, 7)) {
    weeks.push(m);
    if (weeks.length > MAX_SCHEDULE_WEEKS) {
      throw new Error(`Диапазон расписания больше ${MAX_SCHEDULE_WEEKS} недель — сузьте период`);
    }
  }
  const chunks = await Promise.all(weeks.map((m) => elkScheduleWeek(m, opts)));
  return chunks.flat().filter((day) => day.date >= fromKey && day.date <= toKey);
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

const elkUser = defineResource<void, ElkUserInfo>({
  name: "elk.user",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => elkJson<ElkUserInfo>("/api/get-user", ctx),
});

/** Базовая identity-информация из ЕЛК (структурированный JSON, без академической карточки). */
export function getUserInfo(): Promise<ElkUserInfo> {
  return elkUser();
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

const elkAcademic = defineResource<void, ElkAcademicData[]>({
  name: "elk.academic",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => elkJson<ElkAcademicData[]>("/api/get-academic-data", ctx),
});

/**
 * Академическая карточка студента (структурированный JSON): рейтинг, GPA, программа, факультет,
 * курс, группа. lk.hse.ru/api/get-academic-data — реверс-инжинирен 2026-09-15, тот же
 * Bearer-токен, что и остальные elk_get_*. Отдаёт массив с одной записью на пользователя.
 */
export function getAcademicData(): Promise<ElkAcademicData[]> {
  return elkAcademic();
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

const SEARCH_FETCH_LIMIT = 50; // максимум тула elk_search_services

const elkSearch = defineResource<{ query: string; limit: number }, RawSearchAllResponse, ElkSearchServicesResponse>({
  name: "elk.search",
  ttl: TTL.medium,
  key: (a) => a.query,
  load: (a, ctx) =>
    elkJson<RawSearchAllResponse>(
      `/api/search/search-all?query=${encodeURIComponent(a.query)}&offset=0&limit=${SEARCH_FETCH_LIMIT}&category=services`,
      ctx
    ),
  project: (raw, a) => ({
    total_hits: raw.total_hits,
    categories: raw.categories,
    results: raw.data.slice(0, a.limit).map((item) => ({
      id: item.data.id,
      name: item.data.name,
      desc: item.data.desc,
      url: item.data.url,
      score: item.score,
    })),
  }),
});

/**
 * Полнотекстовый поиск по каталогу сервисов ЕЛК (lk.hse.ru/api/search/search-all) — разведано
 * вживую 2026-09-15 через шапку SmartPoint: строка поиска ищет по 254 сервисам сразу, а также
 * (отдельными категориями с тем же эндпоинтом) по сотрудникам/студентам/подразделениям.
 * `categories` в ответе — счётчики по всем категориям для запроса, даже когда `category=services`
 * сужает `data` до одной из них.
 */
export function searchServices(query: string, limit = 10): Promise<ElkSearchServicesResponse> {
  return elkSearch({ query, limit });
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

const CLAIMS_FETCH_LIMIT = 500; // максимум тулов elk_list_requests / elk_list_tasks

const elkClaims = defineResource<number, { data: RawClaim[]; count: number }, { count: number; requests: ElkClaim[] }>({
  name: "elk.claims",
  ttl: TTL.short,
  key: () => "all",
  load: (_limit, ctx) =>
    elkJson<{ data: RawClaim[]; count: number }>(
      `/api/claims?username=${encodeURIComponent(config.hseEmail)}&limit=${CLAIMS_FETCH_LIMIT}&sort_by=created&order_by=desc`,
      ctx
    ),
  project: (raw, limit) => ({
    count: raw.count,
    requests: raw.data.slice(0, limit).map((c) => ({
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
  }),
});

/**
 * История заявок пользователя (lk.hse.ru/claim) — разведано вживую 2026-09-15. В отличие от
 * большинства elk_* эндпоинтов требует username (email) явным query-параметром, а не берёт его
 * из токена.
 */
export function listRequests(limit = 500, opts?: ResourceCallOptions): Promise<{ count: number; requests: ElkClaim[] }> {
  return elkClaims(limit, opts);
}

const elkTasks = defineResource<number, { count: number; data: unknown[] }>({
  name: "elk.tasks",
  ttl: TTL.short,
  key: () => "all",
  load: (_limit, ctx) =>
    elkJson<{ count: number; data: unknown[] }>(
      `/api/tasks?username=${encodeURIComponent(config.hseEmail)}&limit=${CLAIMS_FETCH_LIMIT}&sort_by=created&order_by=desc`,
      ctx
    ),
  project: (raw, limit) => ({ count: raw.count, data: raw.data.slice(0, limit) }),
});

/**
 * Задачи пользователя (lk.hse.ru/task) — тот же API-паттерн, что и /api/claims (username, limit,
 * sort_by, order_by), реверс-инжинирен 2026-09-15. Поля отдельной задачи не типизированы: на
 * аккаунте, где это проверялось, задач не было (`count: 0`), поэтому форма ответа возвращается
 * как есть, без предположений о конкретных именах полей.
 */
export function listTasks(limit = 500): Promise<{ count: number; data: unknown[] }> {
  return elkTasks(limit);
}

interface RawDpoApplicationsResponse {
  data: {
    docs: unknown[];
    filters: { status: Array<{ value: string; label: string }> };
  };
}

const elkDpo = defineResource<void, RawDpoApplicationsResponse, { docs: unknown[]; statusLabels: Record<string, string> }>({
  name: "elk.dpo",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => elkJson<RawDpoApplicationsResponse>("/dpo/rest/application", ctx),
  project: (raw) => ({
    docs: raw.data.docs,
    statusLabels: Object.fromEntries(raw.data.filters.status.map((s) => [s.value, s.label])),
  }),
});

/**
 * Мои программы ДПО (lk.hse.ru/dpo/my-programs → GET /dpo/rest/application) — реверс-инжинирено
 * 2026-09-15. Модуль «Моё ДПО» релевантен только студентам, проходящим доп. проф. образование
 * помимо основной программы; на проверенном аккаунте программ нет (`docs: []`), поэтому форма
 * отдельной записи не подтверждена вживую — возвращается как есть, без типизации полей.
 * `statusLabels` — расшифровка возможных статусов (processing/payment/waiting/studies/...).
 */
export function listDpoPrograms(): Promise<{ docs: unknown[]; statusLabels: Record<string, string> }> {
  return elkDpo();
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

const elkLoginHistory = defineResource<
  number,
  { count: number; actions: RawLoginRecord[] },
  { count: number; actions: ElkLoginRecord[] }
>({
  name: "elk.login-history",
  ttl: TTL.short,
  key: (offset) => String(offset),
  load: (offset, ctx) =>
    elkJson<{ count: number; actions: RawLoginRecord[] }>(`/api/get-action-history-records?offset=${offset}`, ctx),
  project: (raw) => ({
    count: raw.count,
    actions: raw.actions.map((a) => ({
      date: a.date,
      action: a.action,
      ip: a.ip,
      place: a.place,
      device: a.deviceData.device,
      deviceType: a.deviceData.type,
    })),
  }),
});

/**
 * История действий/входов в ЕЛК (вкладка "Прочее" → "История действий" на /profile, обычно не
 * захватывается elk_get_profile — Vue-таб рендерит контент только по клику, а не сразу в DOM).
 * Полезно для проверки безопасности аккаунта (неожиданные IP/устройства). Реверс-инжинирено
 * 2026-09-15: `GET /api/get-action-history-records?offset=0`, тот же Bearer-токен.
 */
export function getLoginHistory(offset = 0): Promise<{ count: number; actions: ElkLoginRecord[] }> {
  return elkLoginHistory(offset);
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

const NOTIFICATIONS_FETCH_LIMIT = 100; // максимум тула elk_get_notifications

const elkNotifications = defineResource<
  number,
  { data: RawNotification[]; count: number },
  { count: number; notifications: ElkNotification[] }
>({
  name: "elk.notifications",
  ttl: TTL.short,
  key: () => "all",
  load: (_limit, ctx) =>
    elkJson<{ data: RawNotification[]; count: number }>(
      `/api/notifications?is_no_read=false&offset=0&limit=${NOTIFICATIONS_FETCH_LIMIT}`,
      ctx
    ),
  project: (raw, limit) => ({
    count: raw.count,
    notifications: raw.data.slice(0, limit).map((n) => ({
      id: n.id,
      title: n.title,
      text: stripHtmlElk(n.text),
      isImportant: n.is_important,
      isRead: n.is_read,
      date: n.date,
    })),
  }),
});

/**
 * Уведомления ЕЛК (`/notification`, колокольчик в шапке) — реверс-инжинирено 2026-09-15:
 * `GET /api/notifications?is_no_read=false&offset=0&limit=<n>`, тот же Bearer-токен.
 * `is_no_read=false` — включая уже прочитанные (иначе список часто пуст).
 */
export function getNotifications(limit = 20, opts?: ResourceCallOptions): Promise<{ count: number; notifications: ElkNotification[] }> {
  return elkNotifications(limit, opts);
}

export interface ElkAntiplagiatStatus {
  processing: number;
  completed: number;
  total: number;
}

const elkAntiplagiat = defineResource<void, ElkAntiplagiatStatus>({
  name: "elk.antiplagiat",
  ttl: TTL.short,
  key: () => "me",
  load: (_a, ctx) =>
    elkJson<ElkAntiplagiatStatus>(
      `/antiplagiat/api/antiplagiat/attempts?email=${encodeURIComponent(config.hseEmail)}`,
      ctx
    ),
});

/**
 * Статус проверок в системе Антиплагиат (lk.hse.ru/flow/antiplagiat/...) — реверс-инжинирен
 * 2026-09-15: страница подачи заявки на проверку сама дёргает этот эндпоинт для отображения
 * счётчика "Использовано проверок: N из <лимит>" (сам лимит квоты в ответе не встречается,
 * похоже, задан на фронтенде/CMS отдельно). Только статус — отправка файла на проверку не
 * реализована (запись данных, требует явного согласия пользователя).
 */
export function getAntiplagiatStatus(): Promise<ElkAntiplagiatStatus> {
  return elkAntiplagiat();
}

const SOP_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/yii_index.php%3Fr=rt/hse-rt-student-event-list";

/** Таблица СОП с признаком наличия: `found: false` — таблица не отрисовалась (сбой рендера или SSO-моста). */
export interface CourseEvaluationTable {
  found: boolean;
  rows: Array<Record<string, string>>;
}

const elkCourseEvaluation = defineResource<void, CourseEvaluationTable>({
  name: "elk.course-evaluation",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      SOP_URL,
      async (page) => {
        await page.waitForSelector("table.event-table", { timeout: 10_000 }).catch(() => {});
        const found = (await page.$("table.event-table")) !== null;
        return { found, rows: await extractTable(page, "table.event-table") };
      },
      { signal: ctx.signal }
    ),
});

/**
 * Статус «Оцени свои курсы» / СОП (студенческая оценка преподавания) — периоды оценки и статус
 * заполнения анкеты по каждому. Реверс-инжинирено 2026-09-15: это отдельный от edu.hse.ru
 * legacy-портал lms.hse.ru (Yii, серверный рендеринг, без JSON API), доступ через SSO-мост
 * /elk_login.php. Данные — обычная HTML-таблица `table.event-table` (thead/tbody), извлекается
 * через extractTable.
 */
export function getCourseEvaluationStatus(opts?: ResourceCallOptions): Promise<Array<Record<string, string>>> {
  return elkCourseEvaluation(undefined, opts).then((t) => t.rows);
}

/**
 * То же с признаком наличия таблицы — для снимков (`hse_changes`), где «таблицы нет» должно быть
 * отказом источника, а не «окон нет». Закэшированное «таблицы нет» на веру не принимается: страница
 * перечитывается один раз.
 */
export async function getCourseEvaluationTable(opts: ResourceCallOptions = {}): Promise<CourseEvaluationTable> {
  const first = await elkCourseEvaluation(undefined, opts);
  if (first.found || opts.maxAgeMs === 0) return first;
  return elkCourseEvaluation(undefined, { ...opts, maxAgeMs: 0 });
}

const VKR_URL = "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/%3Fap_list";

const elkThesis = defineResource<void, Array<Record<string, string>>>({
  name: "elk.thesis",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      VKR_URL,
      async (page) => {
        await page.waitForSelector("table", { timeout: 10_000 }).catch(() => {});
        return extractTable(page, "table");
      },
      { signal: ctx.signal }
    ),
});

/**
 * Мои работы (ВКР/КР/Проект) — статус проверки выпускной квалификационной/курсовой работы:
 * тема, процент заимствований, статус проверки, оценка, рецензия. Тот же портал lms.hse.ru,
 * что и getCourseEvaluationStatus, другая цель SSO-моста /elk_login.php. Таблица без класса
 * (единственная на странице) — на аккаунте без зарегистрированной темы работы возвращает
 * пустой массив (страница показывает только пояснение "Тема работы не занесена в систему АСАВ").
 */
export function getThesisStatus(): Promise<Array<Record<string, string>>> {
  return elkThesis();
}

const INTERNSHIP_LIST_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/yii_index.php%3Fr=pr/request-student/demand-list";

const EMPTY_TABLE_PLACEHOLDER = "Ничего не найдено.";

const elkInternships = defineResource<void, Array<Record<string, string>>>({
  name: "elk.internships",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      INTERNSHIP_LIST_URL,
      async (page) => {
        await page.waitForSelector("table.theme_list_table", { timeout: 10_000 }).catch(() => {});
        const rows = await extractTable(page, "table.theme_list_table");
        return rows.filter((r) => !Object.values(r).includes(EMPTY_TABLE_PLACEHOLDER));
      },
      { signal: ctx.signal }
    ),
});

/**
 * Список заявок на практику/стажировку («Модуль Практика» на lms.hse.ru, доступ через тот же
 * SSO-мост `/elk_login.php`). Read-only статус — сама подача заявки на практику отдельная форма,
 * не реализована. Таблица `table.theme_list_table` без содержательных заголовков в пустом
 * состоянии отдаёт строку-заглушку "Ничего не найдено." как будто это данные — отфильтровываем
 * её, иначе пустой список практик выглядел бы как одна поддельная запись.
 */
export function listInternships(): Promise<Array<Record<string, string>>> {
  return elkInternships();
}

const PORTFOLIO_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/index.php%3Fpage=portfolio";

const elkPortfolio = defineResource<void, PageDump>({
  name: "elk.portfolio",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => withPage(PORTFOLIO_URL, (page) => dumpPage(page), { signal: ctx.signal }),
});

/**
 * Электронное портфолио студента (баллы за учёбу/науку/ДПО/практики/культурно-творческую и
 * общественную деятельность, спорт, олимпиады — влияет на повышенную стипендию). Реверс-
 * инжинирено 2026-09-15: НЕ требует отдельного логина portfolio.hse.ru, как считалось раньше —
 * это отдельная страница на том же портале lms.hse.ru (`index.php?page=portfolio`), доступная
 * через тот же SSO-мост `/elk_login.php`, что и СОП/ВКР. Смешанная вёрстка (профиль + несколько
 * таблиц + список достижений, каждый раздел деятельности — вложенная страница по
 * `page_point=view_*`) — текстовый дамп через dumpPage, а не extractTable.
 */
export function getPortfolio(): Promise<PageDump> {
  return elkPortfolio();
}

const SCHOLARSHIP_URL =
  "https://lms.hse.ru/elk_login.php?role=student&elk_lms_url=https://lms.hse.ru/index.php%3Fpage=portfolio_scholarship";

const elkScholarship = defineResource<void, unknown[]>({
  name: "elk.scholarship-history",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      SCHOLARSHIP_URL,
      async (page) => {
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
      },
      { signal: ctx.signal }
    ),
});

/**
 * История заявок на повышенную государственную академическую стипендию (портал lms.hse.ru,
 * тот же SSO-мост `/elk_login.php`). В отличие от общей истории заявок ЕЛК
 * (`elk_list_requests`), данные грузятся не через DataTables server-side POST (формат которого
 * не удалось поймать — см. `?r=st/request/history-dt`), а простым GET
 * `act.php?on=portfolio_scholarship&name=history_apps` без параметров пагинации/сортировки —
 * поэтому реализуемо без реверс-инжиниринга протокола DataTables. На проверенном аккаунте заявок
 * не было (`{"data":[]}`), поэтому форма отдельной записи не типизирована.
 */
export function getScholarshipHistory(): Promise<unknown[]> {
  return elkScholarship();
}

const elkProfilePage = defineResource<void, PageDump>({
  name: "elk.profile-page",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => withPage(`${BASE_URL}/profile`, (page) => dumpPage(page), { signal: ctx.signal }),
});

/**
 * Полная страница профиля (текст + ссылки) — общая информация и контакты. Для структурированной
 * академической карточки (рейтинг, GPA, группа, факультет) используйте getAcademicData().
 */
export function getProfile(): Promise<PageDump> {
  return elkProfilePage();
}

// pmo.hse.ru — домен хелпдеска (создание тикетов), на который ведут документированные ссылки
// со страниц профиля/student-services, поэтому явно разрешён в дополнение к baseUrl.
export function openPage(relativePath: string): Promise<PageDump> {
  const url = resolveScopedUrl(BASE_URL, relativePath, ["pmo.hse.ru"]);
  assertReadOnlyPath(url);
  return withPage(url, (page) => dumpPage(page));
}
