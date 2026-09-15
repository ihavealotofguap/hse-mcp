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
