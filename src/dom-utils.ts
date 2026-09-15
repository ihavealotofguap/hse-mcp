import type { Page } from "playwright";

/** Разбирает HTML-таблицу (thead/tbody) в массив объектов по заголовкам столбцов. */
export async function extractTable(page: Page, selector: string): Promise<Array<Record<string, string>>> {
  return page.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return [];
    let headerCells = Array.from(table.querySelectorAll("thead th")).map(
      (th) => th.textContent?.trim() || ""
    );
    let rows = Array.from(table.querySelectorAll("tbody tr"));
    // Некоторые Moodle-темы не используют <thead> — заголовок рисуется первой строкой <tbody>
    // из <th>-ячеек. Отличаем её от обычной строки данных по тегу ячеек, а не по позиции.
    if (headerCells.length === 0 && rows.length > 0) {
      const firstRowCells = Array.from(rows[0].children);
      const isHeaderRow = firstRowCells.length > 0 && firstRowCells.every((c) => c.tagName === "TH");
      if (isHeaderRow) {
        headerCells = firstRowCells.map((c) => c.textContent?.trim() || "");
        rows = rows.slice(1);
      }
    }
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      const obj: Record<string, string> = {};
      const usedKeys = new Set<string>();
      cells.forEach((cell, i) => {
        let key = headerCells[i] || `col${i}`;
        // Совпадающие заголовки колонок (частый случай в grade report Moodle) иначе затирали бы
        // друг друга — вместо перезаписи различаем повтор индексом ячейки.
        if (usedKeys.has(key)) key = `${key} (${i})`;
        usedKeys.add(key);
        obj[key] = cell.textContent?.trim().replace(/\s+/g, " ") || "";
      });
      return obj;
    });
  }, selector);
}

/** Ждёт, пока SPA-страница отрендерит основной контент. Возвращает false при таймауте вместо
 * молчаливого проглатывания — вызывающий код решает, критично ли это для его сценария. */
export async function waitForRenderedBody(page: Page, timeoutMs = 8_000): Promise<boolean> {
  return page
    .waitForFunction(() => document.body.innerText.trim().length > 20, undefined, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

export interface PageDump {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  warning?: string;
}

/**
 * Универсальный "снимок" страницы для порталов с неизвестной/меняющейся вёрсткой (ЕЛК и т.п.):
 * видимый текст основного контента + список ссылок. Модель может сама выделить из текста
 * нужные поля, а по ссылкам — перейти дальше через *_open_page.
 */
export async function dumpPage(page: Page): Promise<PageDump> {
  const warnings: string[] = [];

  // Многие порталы ВШЭ (особенно ЕЛК/SmartPoint) — SPA, рендерящиеся JS уже после события
  // load; без этой паузы снимок страницы регулярно получается пустым (гонка с рендером).
  const rendered = await waitForRenderedBody(page);
  if (!rendered) warnings.push("страница не успела отрендериться за 8с — снимок может быть неполным");

  // Часть контента (напр. академическая карточка профиля в ЕЛК) подгружается отдельным
  // асинхронным запросом уже ПОСЛЕ того, как в body появился первый текст — ждём, пока
  // сеть успокоится, иначе такие блоки снимаются пустыми/незаполненными.
  const networkIdle = await page
    .waitForLoadState("networkidle", { timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!networkIdle) warnings.push("сеть не успокоилась за 8с — часть контента могла не подгрузиться");

  const { title, text, links } = await page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const links = Array.from(document.querySelectorAll("a[href]"))
      .map((el) => {
        const a = el as HTMLAnchorElement;
        const text = a.textContent?.trim().replace(/\s+/g, " ") || a.getAttribute("aria-label")?.trim() || "";
        return { text, href: a.href };
      })
      .filter((l) => l.text.length > 0);
    return {
      title: document.title,
      text: (main as HTMLElement).innerText.replace(/\n{3,}/g, "\n\n").trim(),
      links,
    };
  });
  return {
    url: page.url(),
    title,
    text,
    links,
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
}
