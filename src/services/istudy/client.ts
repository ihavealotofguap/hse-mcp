import { withPage } from "../../auth/browser-session.js";
import { TTL } from "../../cache.js";
import { defineResource } from "../../resource.js";

/**
 * istudy.hse.ru — детальная зачётка/рейтинг студента, отдельная от ЕЛК система со своим REST API.
 * Разведано вживую 2026-09-15: на lk.hse.ru/profile есть SSO-ссылка
 * `istudy.hse.ru/auth?lpvGuid=<student_mdm>`, которая проводит через `/api/sso/auth` →
 * `/token?...&token=<одноразовый>`. При заходе по ней SPA сама сразу подгружает
 * profile/report-info/rating/exams-by-period текущего периода — эти запросы мы просто слушаем и
 * забираем готовые ответы, а не повторяем их собственным fetch: авторизация istudy.hse.ru
 * держится не только на cookie, а ещё и на токене в памяти самого SPA (собственный fetch с
 * `credentials: "include"` без него получает 401 даже сразу после захода на страницу).
 *
 * Живая разведка 2026-10-15: вход проходит без MAX, но данные зачётки закрыты двухфакторным
 * подтверждением — раздел «Зачетная книжка» шлёт `GET /api/auth/two-factor/required` и получает
 * HTTP 412 (запрос уходит только после клика по пункту меню, а не при загрузке `/dashboard`).
 * Шаблоны путей `/api/student/\d+/…` ниже устарели (профиль переехал на
 * `POST /api/student/profile?studentId=`), эндпоинты после 2FA неизвестны.
 */
const TWO_FACTOR_URL = "/api/auth/two-factor/required";
const TWO_FACTOR_MENU_ITEM = "Зачетная книжка";

/** Данные зачётки istudy.hse.ru закрыты двухфакторным подтверждением (2FA через MAX). */
export class IstudyTwoFactorRequiredError extends Error {
  constructor() {
    super(
      "данные зачётки istudy.hse.ru закрыты двухфакторным подтверждением (2FA через MAX): сервис " +
        `ответил HTTP 412 на ${TWO_FACTOR_URL}. Вход в istudy проходит, но без подтверждения в MAX ` +
        "зачётка, рейтинг и экзамены недоступны. Повторный вызов не поможет. Оценки по курсам " +
        "LMS — lms_get_grades."
    );
    this.name = "IstudyTwoFactorRequiredError";
  }
}

/** Путь запроса к API istudy без query, числовые сегменты заменены на `:id` — без персональных данных. */
function maskedApiPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "istudy.hse.ru" || !u.pathname.startsWith("/api/")) return null;
    return u.pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
  } catch {
    return null;
  }
}

async function collectIstudyResponses(
  patterns: Record<string, RegExp>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const pending = new Set(Object.keys(patterns));
  const seenApiPaths = new Set<string>();
  let twoFactorRequired = false;

  await withPage(
    "https://lk.hse.ru/profile",
    async (page) => {
      const href = await page.locator('a[href*="istudy.hse.ru"]').first().getAttribute("href");
      if (!href) {
        throw new Error("Ссылка на istudy.hse.ru не найдена на странице профиля ЕЛК (lk.hse.ru/profile)");
      }
      page.on("response", (res) => {
        const url = res.url();
        const apiPath = maskedApiPath(url);
        if (apiPath) {
          seenApiPaths.add(`${res.request().method()} ${apiPath} → ${res.status()}`);
          if (apiPath === TWO_FACTOR_URL && res.status() === 412) twoFactorRequired = true;
        }
        if (pending.size === 0) return;
        for (const key of pending) {
          if (patterns[key].test(url)) {
            pending.delete(key);
            res
              .json()
              .then((body) => {
                results[key] = body;
              })
              .catch(() => {});
            break;
          }
        }
      });
      await page.goto(href, { waitUntil: "networkidle", timeout: 20_000 });

      // Единственный клик — по пункту меню «Зачетная книжка»: он запускает проверку 2FA.
      if (pending.size > 0 && !twoFactorRequired) {
        const item = page.getByText(TWO_FACTOR_MENU_ITEM, { exact: true }).first();
        if ((await item.count()) > 0) {
          const checked = page
            .waitForResponse((res) => res.url().includes(TWO_FACTOR_URL), { timeout: 10_000 })
            .catch(() => null);
          await item.click({ timeout: 5_000 }).catch(() => {});
          await checked;
        }
      }
    },
    { signal }
  );

  const missing = Object.keys(patterns).filter((key) => !(key in results));
  if (missing.length > 0) {
    if (twoFactorRequired) throw new IstudyTwoFactorRequiredError();
    const seen = [...seenApiPaths].sort().join("; ") || "запросов к /api/ не было";
    throw new Error(
      `istudy.hse.ru не отдал ожидаемые данные при загрузке SPA: ${missing.join(", ")}. ` +
        `Запросы SPA к API: ${seen}`
    );
  }
  return results;
}

interface LocalizedName {
  ru: string;
  en: string;
}

export interface IstudyProfile {
  id: number;
  studCardNumber: string;
  name: string;
  filial: { id: number; name: LocalizedName };
  faculty: { id: number; name: LocalizedName };
  learnProgram: { id: number; name: LocalizedName };
  course: string;
  periodStartId: number;
  periodFinishId: number;
  educationLevel: { id: number; name: LocalizedName };
  hasExams: boolean;
  hasRating: boolean;
  isGraduate: boolean;
  [key: string]: unknown;
}

export interface IstudyReportInfo {
  fullName: LocalizedName;
  studCardNumber: string;
  course: { name: string; number: number };
  direction: { id: number; description: string; code: string };
  order: { name: string; number: string; date: string };
  faculty: { id: number; name: LocalizedName };
  [key: string]: unknown;
}

export interface IstudyRating {
  percentile: number | null;
  placeGroupOp: number | null;
  placeGroupOpTotal: number | null;
  gpa: number | null;
  credits: number | null;
  kudValue: number | null;
  markAvg: number | null;
  markMin: number | null;
  ratingDate: string | null;
  [key: string]: unknown;
}

export interface IstudyReport {
  profile: IstudyProfile;
  reportInfo: IstudyReportInfo;
  rating: IstudyRating;
}

const STUDENT_API = /\/api\/student\/\d+\//;

const istudyReport = defineResource<void, IstudyReport>({
  name: "istudy.report",
  ttl: TTL.long,
  key: () => "me",
  load: async (_a, ctx) => {
    const data = await collectIstudyResponses(
      {
        profile: new RegExp(`${STUDENT_API.source}profile$`),
        reportInfo: new RegExp(`${STUDENT_API.source}report-info$`),
        rating: new RegExp(`${STUDENT_API.source}rating$`),
      },
      ctx.signal
    );
    return data as unknown as IstudyReport;
  },
});

/** Сводная академическая карточка (профиль + рейтинг/GPA/кредиты) с реальными числами из istudy.hse.ru. */
export function getReport(): Promise<IstudyReport> {
  return istudyReport();
}

export interface IstudyExam {
  id: number;
  name: LocalizedName;
  toDiploma: boolean;
  controlType: { id: number; name: LocalizedName };
  entireHours: number;
  audHours: number;
  credits: number;
  tenScaleMark: number | null;
  fiveScaleMark: number | null;
  testMark: string | null;
  teacher: string | null;
  moduleNumber: number;
  year: number;
  [key: string]: unknown;
}

export interface ExamsByPeriodResponse {
  startYear: number;
  modules: Array<{ periodId: number; disciplineList: IstudyExam[] }>;
}

const istudyExams = defineResource<void, ExamsByPeriodResponse>({
  name: "istudy.exams",
  ttl: TTL.long,
  key: () => "me",
  load: async (_a, ctx) => {
    const data = await collectIstudyResponses(
      { exams: new RegExp(`${STUDENT_API.source}exams-by-period\\?`) },
      ctx.signal
    );
    return data.exams as ExamsByPeriodResponse;
  },
});

/** Список дисциплин с результатами (экзамены/зачёты) за текущий учебный период студента. */
export function getExams(): Promise<ExamsByPeriodResponse> {
  return istudyExams();
}
