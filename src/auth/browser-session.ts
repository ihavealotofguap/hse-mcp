import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";

// Считаем от расположения самого файла, а не process.cwd() — хосты вроде Claude
// Desktop запускают stdio-сервер с произвольным (иногда непишущим, напр.
// C:\WINDOWS\system32) cwd, и mkdir там падает с EPERM.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORAGE_DIR = path.join(projectRoot, "storage");
const STORAGE_STATE_PATH = path.join(STORAGE_DIR, "hse-session.json");
const KEYCLOAK_HOST = "saml.hse.ru";

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;

async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
      if (!browserPromise) {
        browserPromise = chromium.launch({ headless: config.browserHeadless });
      }
      const browser = await browserPromise;
      const storageState = fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;
      return browser.newContext({ storageState });
    })();
  }
  return contextPromise;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Единый вход ВШЭ — Keycloak (realm "hse"). Форма подтверждена вручную 2026-09-15:
 * поле логина #username, поле пароля input[name=password], кнопка с текстом "Войти".
 * После входа Keycloak сам редиректит обратно на сервис (response_mode=form_post),
 * так что достаточно дождаться смены хоста.
 */
async function performKeycloakLogin(page: Page): Promise<void> {
  await page.locator("#username").fill(config.hseEmail);
  await page.locator('input[name="password"]').fill(config.hsePassword);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL((url) => url.hostname !== KEYCLOAK_HOST, { timeout: 20_000 });
}

async function waitForRender(page: Page): Promise<void> {
  // SPA-порталы ВШЭ (особенно ЕЛК/SmartPoint) рендерятся JS уже после события load —
  // без паузы проверки ниже регулярно срабатывают на пустой/недорисованной странице.
  await page
    .waitForFunction(() => document.body.innerText.trim().length > 20, undefined, {
      timeout: 8_000,
    })
    .catch(() => {});
}

/**
 * Некоторые сервисы ВШЭ (SmartLMS/edu.hse.ru) при заходе неавторизованным сразу редиректят на
 * Keycloak. Другие (ЕЛК/lk.hse.ru — подтверждено вживую 2026-09-15) НЕ редиректят: показывают
 * свою страницу "Вы не вошли в аккаунт" с явной ссылкой "Войти", ведущей на Keycloak, и ждут
 * клика. Эта функция ищет такую ссылку на текущей странице.
 */
async function findKeycloakLoginHref(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('a[href*="openid-connect/auth"]');
    return link ? link.href : null;
  });
}

/**
 * Приводит текущую страницу к авторизованному состоянию: обрабатывает и автоматический
 * редирект на Keycloak, и вариант с ручной ссылкой "Войти". Не более 3 итераций — этого
 * достаточно на переход по ссылке "Войти" + сам логин на Keycloak.
 */
async function ensureLoggedIn(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForRender(page);

    if (hostnameOf(page.url()) === KEYCLOAK_HOST) {
      await performKeycloakLogin(page);
      continue;
    }

    const loginHref = await findKeycloakLoginHref(page);
    if (loginHref) {
      await page.goto(loginHref, { waitUntil: "load" });
      continue;
    }

    return; // ни редиректа на Keycloak, ни ссылки "Войти" — уже авторизованы
  }
}

/**
 * Открывает targetUrl в переиспользуемом браузерном контексте. Если сервис требует входа,
 * проходит единый SSO ВШЭ один раз — благодаря сохранённой Keycloak-сессии остальные сервисы
 * в большинстве случаев авторизуются без повторного ввода пароля.
 * Сохраняет storageState на диск, чтобы сессия переживала перезапуск сервера.
 */
export async function openAuthenticatedPage(targetUrl: string): Promise<Page> {
  const context = await getContext();
  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: "load" });

  await ensureLoggedIn(page);

  await context.storageState({ path: STORAGE_STATE_PATH });
  return page;
}

export async function closeBrowserSession(): Promise<void> {
  if (contextPromise) {
    const context = await contextPromise;
    await context.close();
    contextPromise = null;
  }
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}
