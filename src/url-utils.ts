/**
 * Резолвит путь, переданный тулами *_open_page, относительно baseUrl. Общий авторизованный
 * Playwright-контекст несёт активную SSO-сессию ВШЭ (cookies/токен) — без проверки хоста
 * абсолютный URL из пользовательского/модельного ввода увёл бы этот контекст на произвольный
 * внешний домен (SSRF-подобная утечка сессии, усугубляемая тем, что *_open_page парсит сторонний
 * контент страниц, то есть подвержен prompt injection). Разрешаем абсолютные URL только на baseUrl
 * или явно перечисленные дополнительные хосты (напр. pmo.hse.ru для хелпдеска ЕЛК).
 */
export function resolveScopedUrl(
  baseUrl: string,
  relativePath: string,
  extraAllowedHosts: string[] = []
): string {
  if (/^https?:\/\//i.test(relativePath)) {
    const baseHost = new URL(baseUrl).hostname;
    const targetHost = new URL(relativePath).hostname;
    const allowedHosts = [baseHost, ...extraAllowedHosts];
    if (!allowedHosts.includes(targetHost)) {
      throw new Error(
        `Открытие внешнего URL (${targetHost}) запрещено: этот тул открывает страницы только на ` +
          `${allowedHosts.join(", ")} под авторизованной SSO-сессией ВШЭ.`
      );
    }
    return relativePath;
  }
  return baseUrl + (relativePath.startsWith("/") ? relativePath : `/${relativePath}`);
}

/**
 * Запрет «записывающих» GET для *_open_page: тулы открывают произвольные страницы того же хоста под
 * авторизованной сессией, и без проверки модель могла бы обойти протокол confirm — перейти по URL с
 * `sesskey` (выход, смена состояния Moodle) или с `action=` на `/mod/assign/` (`editsubmission`,
 * `removesubmissionconfirm` и т. п.). Ключи сравниваются после декодирования (URLSearchParams
 * разбирает `sess%6Bey`), нормализуются как в PHP (ведущие пробелы, хвост от первой `[`) и сравниваются
 * без учёта регистра; `sesskey` ищется и в query, и в query фрагмента.
 * Сообщение называет правило и не повторяет URL/query: оно уходит модели и в логи.
 */
export function assertReadOnlyPath(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url, "https://placeholder.invalid");
  } catch {
    throw new Error("Некорректный URL: страница не открыта.");
  }

  // Имя переменной PHP/Moodle нормализует: ведущие пробелы (`%20sesskey`, `+action`) отбрасывает, а всё
  // от первой `[` (`sesskey[]`, `sesskey[a][b]`, `sesskey[]x`, `action[0]`, они же в `%5B`) читает как
  // индекс массива. Режем от первой `[` целиком — строже PHP, зато без обхода хвостом после скобок.
  const normKey = (k: string): string => k.replace(/^ +/, "").replace(/\[[\s\S]*$/, "").toLowerCase();
  const keysOf = (query: string): string[] => [...new URLSearchParams(query).keys()].map(normKey);

  // Фрагмент не уходит на сервер, но SPA читают из него «query» (`#/путь?a=b` или `#a=b`).
  const hash = parsed.hash.replace(/^#/, "");
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash;
  if (keysOf(parsed.search).includes("sesskey") || keysOf(hashQuery).includes("sesskey")) {
    throw new Error(
      "Открытие страниц с параметром sesskey запрещено: такие ссылки выполняют действия, " +
        "а этот тул только читает."
    );
  }

  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Битое кодирование — проверяем путь как есть.
  }
  path = path.toLowerCase().replace(/\/+/g, "/");
  if (path === "/mod/assign" || path.startsWith("/mod/assign/")) {
    const hasAction = [...new URLSearchParams(parsed.search)].some(([k, v]) => normKey(k) === "action" && v !== "");
    if (hasAction) {
      throw new Error(
        "Открытие страниц /mod/assign/ с параметром action запрещено: такие ссылки меняют " +
          "состояние сдачи, а этот тул только читает."
      );
    }
  }
}
