import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { waitForRenderedBody } from "../dom-utils.js";

// Считаем от расположения самого файла, а не process.cwd() — хосты вроде Claude
// Desktop запускают stdio-сервер с произвольным (иногда непишущим, напр.
// C:\WINDOWS\system32) cwd, и mkdir там падает с EPERM.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORAGE_DIR = path.join(projectRoot, "storage");
const STORAGE_STATE_PATH = path.join(STORAGE_DIR, "hse-session.json");
const KEYCLOAK_HOST = "saml.hse.ru";

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;
let closingPromise: Promise<void> | null = null;
// Сериализует только шаг прохождения логина (не всю openAuthenticatedPage) — иначе параллельные
// вызовы тулов сразу после истечения сессии могли бы одновременно запустить Keycloak-логин на
// двух страницах общего контекста и конкурировать за его cookies/OIDC state.
let loginLock: Promise<void> = Promise.resolve();

async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      try {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
        if (!browserPromise) {
          browserPromise = chromium.launch({ headless: config.browserHeadless }).catch((err) => {
            browserPromise = null;
            throw err;
          });
        }
        const browser = await browserPromise;
        const storageState = fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;
        return await browser.newContext({ storageState });
      } catch (err) {
        // Без сброса rejected promise остаётся закэширован навсегда (if (!contextPromise) не
        // сработает для truthy rejected Promise) — все последующие вызовы падали бы с этой же
        // ошибкой до перезапуска процесса, даже после того как причина устранена.
        contextPromise = null;
        throw err;
      }
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
  const rendered = await waitForRenderedBody(page);
  if (!rendered) {
    console.error(`hsemcp: страница ${page.url()} не отрендерилась за таймаут при проверке логина`);
  }
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

type LoginState = "already-authenticated" | "logged-in" | "unknown";

/**
 * Приводит текущую страницу к авторизованному состоянию: обрабатывает и автоматический
 * редирект на Keycloak, и вариант с ручной ссылкой "Войти". Не более 3 итераций — этого
 * достаточно на переход по ссылке "Войти" + сам логин на Keycloak.
 * Возвращает, произошёл ли реальный логин в этом вызове — от этого зависит, стоит ли
 * перезаписывать сохранённую storageState (см. openAuthenticatedPage).
 */
async function ensureLoggedIn(page: Page): Promise<LoginState> {
  let loggedInNow = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForRender(page);

    if (hostnameOf(page.url()) === KEYCLOAK_HOST) {
      await performKeycloakLogin(page);
      loggedInNow = true;
      continue;
    }

    const loginHref = await findKeycloakLoginHref(page);
    if (loginHref) {
      await page.goto(loginHref, { waitUntil: "load" });
      continue;
    }

    return loggedInNow ? "logged-in" : "already-authenticated"; // ни редиректа, ни ссылки "Войти"
  }
  // 3 попытки не дали ни логина, ни явного "уже авторизован" (например, неожиданная
  // промежуточная страница) — не рискуем перезаписывать ранее рабочую сессию на диске.
  console.error(
    `hsemcp: не удалось однозначно определить статус входа на ${page.url()} за 3 попытки — сохранённая сессия не будет перезаписана`
  );
  return "unknown";
}

function withLoginLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = loginLock.then(fn, fn);
  loginLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Открывает targetUrl в переиспользуемом браузерном контексте. Если сервис требует входа,
 * проходит единый SSO ВШЭ один раз — благодаря сохранённой Keycloak-сессии остальные сервисы
 * в большинстве случаев авторизуются без повторного ввода пароля.
 * Сохраняет storageState на диск только при реальном переходе в залогиненное состояние, чтобы
 * сессия переживала перезапуск сервера, не перезаписывая её сомнительным/неизменным состоянием.
 */
export async function openAuthenticatedPage(targetUrl: string): Promise<Page> {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: "load" });

    await withLoginLock(async () => {
      const state = await ensureLoggedIn(page);
      if (state === "logged-in") {
        await context.storageState({ path: STORAGE_STATE_PATH });
      }
    });

    return page;
  } catch (err) {
    // Без этого страница осталась бы висеть открытой в общем контексте навсегда при любой
    // ошибке навигации/логина — утечка ресурсов Playwright при повторяющихся сбоях.
    await page.close().catch(() => {});
    throw err;
  }
}

export async function closeBrowserSession(): Promise<void> {
  if (closingPromise) return closingPromise;
  closingPromise = (async () => {
    if (contextPromise) {
      const context = await contextPromise.catch(() => null);
      contextPromise = null;
      if (context) await context.close().catch(() => {});
    }
    if (browserPromise) {
      const browser = await browserPromise.catch(() => null);
      browserPromise = null;
      if (browser) await browser.close().catch(() => {});
    }
  })();
  return closingPromise;
}
