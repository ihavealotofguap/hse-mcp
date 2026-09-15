import type { Page } from "playwright";
import { openAuthenticatedPage } from "../../auth/browser-session.js";

/**
 * istudy.hse.ru — детальная зачётка/рейтинг студента, отдельная от ЕЛК система со своим REST API.
 * Разведано вживую 2026-09-15: на lk.hse.ru/profile есть SSO-ссылка
 * `istudy.hse.ru/auth?lpvGuid=<student_mdm>`, которая проводит через `/api/sso/auth` →
 * `/token?...&token=<одноразовый>`. При заходе по ней SPA сама сразу подгружает
 * profile/report-info/rating/exams-by-period текущего периода — эти запросы мы просто слушаем и
 * забираем готовые ответы, а не повторяем их собственным fetch: авторизация istudy.hse.ru
 * держится не только на cookie, а ещё и на токене в памяти самого SPA (собственный fetch с
 * `credentials: "include"` без него получает 401 даже сразу после захода на страницу).
 */
async function collectIstudyResponses(
  patterns: Record<string, RegExp>
): Promise<Record<string, unknown>> {
  const page: Page = await openAuthenticatedPage("https://lk.hse.ru/profile");
  const href = await page.locator('a[href*="istudy.hse.ru"]').first().getAttribute("href");
  if (!href) {
    await page.close();
    throw new Error("Ссылка на istudy.hse.ru не найдена на странице профиля ЕЛК (lk.hse.ru/profile)");
  }

  const results: Record<string, unknown> = {};
  const pending = new Set(Object.keys(patterns));
  page.on("response", (res) => {
    if (pending.size === 0) return;
    const url = res.url();
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

  try {
    await page.goto(href, { waitUntil: "networkidle", timeout: 20_000 });
  } finally {
    await page.close();
  }

  const missing = Object.keys(patterns).filter((key) => !(key in results));
  if (missing.length > 0) {
    throw new Error(
      `istudy.hse.ru не отдал ожидаемые данные при загрузке SPA: ${missing.join(", ")}`
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

/** Сводная академическая карточка (профиль + рейтинг/GPA/кредиты) с реальными числами из istudy.hse.ru. */
export async function getReport(): Promise<IstudyReport> {
  const data = await collectIstudyResponses({
    profile: new RegExp(`${STUDENT_API.source}profile$`),
    reportInfo: new RegExp(`${STUDENT_API.source}report-info$`),
    rating: new RegExp(`${STUDENT_API.source}rating$`),
  });
  return data as unknown as IstudyReport;
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

/** Список дисциплин с результатами (экзамены/зачёты) за текущий учебный период студента. */
export async function getExams(): Promise<ExamsByPeriodResponse> {
  const data = await collectIstudyResponses({
    exams: new RegExp(`${STUDENT_API.source}exams-by-period\\?`),
  });
  return data.exams as ExamsByPeriodResponse;
}
