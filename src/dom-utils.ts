import type { Page } from "playwright";

/** Разбирает HTML-таблицу (thead/tbody) в массив объектов по заголовкам столбцов. */
export async function extractTable(page: Page, selector: string): Promise<Array<Record<string, string>>> {
  return page.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return [];
    const headerCells = Array.from(table.querySelectorAll("thead th")).map(
      (th) => th.textContent?.trim() || ""
    );
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      const obj: Record<string, string> = {};
      cells.forEach((cell, i) => {
        const key = headerCells[i] || `col${i}`;
        obj[key] = cell.textContent?.trim().replace(/\s+/g, " ") || "";
      });
      return obj;
    });
  }, selector);
}

export interface PageDump {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
}

/**
 * Универсальный "снимок" страницы для порталов с неизвестной/меняющейся вёрсткой (ЕЛК и т.п.):
 * видимый текст основного контента + список ссылок. Модель может сама выделить из текста
 * нужные поля, а по ссылкам — перейти дальше через *_open_page.
 */
export async function dumpPage(page: Page): Promise<PageDump> {
  // Многие порталы ВШЭ (особенно ЕЛК/SmartPoint) — SPA, рендерящиеся JS уже после события
  // load; без этой паузы снимок страницы регулярно получается пустым (гонка с рендером).
  await page
    .waitForFunction(() => document.body.innerText.trim().length > 20, undefined, {
      timeout: 8_000,
    })
    .catch(() => {});
  // Часть контента (напр. академическая карточка профиля в ЕЛК) подгружается отдельным
  // асинхронным запросом уже ПОСЛЕ того, как в body появился первый текст — ждём, пока
  // сеть успокоится, иначе такие блоки снимаются пустыми/незаполненными.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

  const { title, text, links } = await page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const links = Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({
        text: a.textContent?.trim().replace(/\s+/g, " ") || "",
        href: (a as HTMLAnchorElement).href,
      }))
      .filter((l) => l.text.length > 0);
    return {
      title: document.title,
      text: (main as HTMLElement).innerText.replace(/\n{3,}/g, "\n\n").trim(),
      links,
    };
  });
  return { url: page.url(), title, text, links };
}
