import { openAuthenticatedPage } from "../../auth/browser-session.js";
import { dumpPage, extractTable, type PageDump } from "../../dom-utils.js";

const BASE_URL = "https://edu.hse.ru";

export interface CourseLink {
  id: number;
  name: string;
}

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

export async function listCourses(): Promise<CourseLink[]> {
  const page = await openAuthenticatedPage(`${BASE_URL}/my/courses.php`);
  try {
    return await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/course/view.php?id="]'));
      const byId = new Map<string, string>();
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        const match = href.match(/[?&]id=(\d+)/);
        const text = a.textContent?.trim().replace(/\s+/g, " ");
        if (match && text) byId.set(match[1], text);
      }
      return Array.from(byId.entries()).map(([id, name]) => ({ id: Number(id), name }));
    });
  } finally {
    await page.close();
  }
}

export async function getCourseMaterials(courseId: number): Promise<ModuleLink[]> {
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

export async function listAssignments(courseId: number): Promise<Array<Record<string, string>>> {
  const page = await openAuthenticatedPage(`${BASE_URL}/mod/assign/index.php?id=${courseId}`);
  try {
    return await extractTable(page, "table.generaltable");
  } finally {
    await page.close();
  }
}

export async function getGrades(courseId: number): Promise<Array<Record<string, string>>> {
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
  const url = relativePath.startsWith("http") ? relativePath : `${BASE_URL}${relativePath}`;
  const page = await openAuthenticatedPage(url);
  try {
    return await dumpPage(page);
  } finally {
    await page.close();
  }
}
