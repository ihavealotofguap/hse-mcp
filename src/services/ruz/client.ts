// ВНИМАНИЕ (проверено 2026-09-15): ruz.hse.ru/api/* больше не отвечает JSON напрямую — редиректит
// на https://www.hse.ru/eduland/schedule/ со страницей "Доступ к РУЗ осуществляется только из
// внутренней сети НИУ ВШЭ" (нужен Wi-Fi HSE.Student на кампусе или VPN сотрудника). Этот модуль
// рабочий, но только пока машина, на которой запущен hsemcp, находится в сети ВШЭ. Вне кампуса
// расписание надёжнее смотреть через elk_open_page (lk.hse.ru — там оно тоже дублируется).
const BASE_URL = "https://ruz.hse.ru/api";

export interface StudentInfo {
  id: number;
  uns: string;
  email: string;
  fio: string;
  info: string;
}

export interface Lesson {
  discipline: string;
  kindOfWork: string;
  lecturer: string;
  auditorium: string;
  building: string;
  date: string;
  beginLesson: string;
  endLesson: string;
  dayOfWeekString: string;
  group?: string;
  url1?: string;
  url1Description?: string;
  url2?: string;
  url2Description?: string;
  [key: string]: unknown;
}

export type SearchPersonType = "student" | "lecturer" | "group" | "auditorium";

export interface SearchResult {
  id: number;
  label: string;
  type: string;
  [key: string]: unknown;
}

async function ruzGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`RUZ API error ${response.status} for ${url.pathname}`);
  }
  const data = (await response.json()) as T | { error: string };
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(`RUZ API returned error: ${(data as { error: string }).error}`);
  }
  return data as T;
}

/** Найти студента ВШЭ по корпоративному email и получить его RUZ id. */
export function getStudentInfo(email: string): Promise<StudentInfo> {
  return ruzGet<StudentInfo>("studentinfo", { email });
}

function toRuzDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

/** Расписание по person_id (студент или преподаватель) за указанный период. */
export function getSchedule(
  personType: "student" | "lecturer",
  personId: number,
  from: Date,
  to: Date,
  language: 1 | 2 = 1
): Promise<Lesson[]> {
  return ruzGet<Lesson[]>(`schedule/${personType}/${personId}`, {
    lng: language,
    start: toRuzDate(from),
    finish: toRuzDate(to),
  });
}

/** Расписание группы по её RUZ id. */
export function getGroupSchedule(
  groupId: number,
  from: Date,
  to: Date,
  language: 1 | 2 = 1
): Promise<Lesson[]> {
  return ruzGet<Lesson[]>(`schedule/group/${groupId}`, {
    lng: language,
    start: toRuzDate(from),
    finish: toRuzDate(to),
  });
}

/** Поиск людей/групп/аудиторий по подстроке (ФИО, номер группы и т.п.). */
export function search(term: string, type: SearchPersonType = "student"): Promise<SearchResult[]> {
  return ruzGet<SearchResult[]>("search", { term, type });
}
