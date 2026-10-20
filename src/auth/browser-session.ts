import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { chromium, type APIRequestContext, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { waitForRenderedBody } from "../dom-utils.js";
import { COMMIT_DEADLINE_MS } from "../commit.js";
import { restrictFile } from "../fs-secure.js";
import { acquirePageSlot, LEASE_GRACE_MS, type PageSlotRelease } from "../limiter.js";
import { projectRoot } from "../project-root.js";

// Корень проекта берём из общего хелпера (от расположения файла, а не process.cwd()) — хосты вроде
// Claude Desktop запускают stdio-сервер с произвольным (иногда непишущим, напр.
// C:\WINDOWS\system32) cwd, и mkdir там падает с EPERM.
const STORAGE_DIR = path.join(projectRoot, "storage");
const STORAGE_STATE_PATH = path.join(STORAGE_DIR, "hse-session.json");
const KEYCLOAK_HOST = "saml.hse.ru";

/** Верхняя граница на всё в `withPage`: слот, открытие, вход и тело вызова. */
export const PAGE_DEADLINE_MS = 45_000;

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;
let closingPromise: Promise<void> | null = null;
// Сериализует только фактическое прохождение логина (не открытие и не ожидание рендера) —
// параллельные вызовы сразу после истечения сессии не должны одновременно запускать
// Keycloak-логин на двух страницах общего контекста и конкурировать за его cookies/OIDC state.
let loginLock: Promise<void> = Promise.resolve();
// Растёт при каждом реальном входе: вызов, ждавший замок, понимает, что вход уже выполнен другим.
let loginEpoch = 0;

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

function labelOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return "страница";
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
 * Сервисы ВШЭ редиректят на Keycloak автоматически только если в браузере уже есть его сессия —
 * иначе показывают свою страницу с явной ссылкой "Войти" и ждут клика. Формат ссылки отличается
 * по сервису (подтверждено вживую 2026-09-15): ЕЛК/lk.hse.ru ведёт прямо на
 * `openid-connect/auth`, а SmartLMS/edu.hse.ru — на собственный same-origin OIDC-мост
 * `/auth/oidckc/`, который уже сам редиректит на `saml.hse.ru/.../openid-connect/auth`. Эта
 * функция ищет ссылку любого из известных форматов на текущей странице.
 */
async function findKeycloakLoginHref(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href*="openid-connect/auth"], a[href*="/auth/oidckc/"]'
    );
    return link ? link.href : null;
  });
}

type LoginState = "already-authenticated" | "logged-in" | "unknown";

/**
 * Приводит текущую страницу к авторизованному состоянию: обрабатывает и автоматический
 * редирект на Keycloak, и вариант с ручной ссылкой "Войти". Не более 3 итераций — этого
 * достаточно на переход по ссылке "Войти" + сам логин на Keycloak.
 * Возвращает, произошёл ли реальный логин в этом вызове — от этого зависит, стоит ли
 * перезаписывать сохранённую storageState.
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

/** Нужен ли вход: страница на Keycloak либо показывает ссылку «Войти». Работает без замка. */
async function needsLogin(page: Page): Promise<boolean> {
  await waitForRender(page);
  if (hostnameOf(page.url()) === KEYCLOAK_HOST) return true;
  return (await findKeycloakLoginHref(page)) !== null;
}

/**
 * Сохраняет сессию на диск атомарно: во временный файл и rename — оборванная запись не
 * портит рабочий `hse-session.json`.
 */
async function saveStorageState(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  const tmp = `${STORAGE_STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, STORAGE_STATE_PATH);
  restrictFile(STORAGE_STATE_PATH);
}

/**
 * Определение «нужен ли вход» идёт вне замка (параллельно). Замок берётся только на сам вход и
 * после повторной проверки: если другой вызов уже вошёл, пока мы ждали, страница перезагружается
 * с обновлёнными cookies.
 */
async function ensureAuthenticated(page: Page, context: BrowserContext, targetUrl: string): Promise<void> {
  const epochAtDetect = loginEpoch;
  if (!(await needsLogin(page))) return;
  await withLoginLock(async () => {
    if (loginEpoch !== epochAtDetect) {
      await page.goto(targetUrl, { waitUntil: "load" });
    }
    const state = await ensureLoggedIn(page);
    if (state === "logged-in") {
      loginEpoch++;
      await saveStorageState(context);
    }
  });
}

export interface WithPageOptions {
  /** Верхняя граница на слот, открытие, вход и `fn`. По умолчанию PAGE_DEADLINE_MS. */
  deadlineMs?: number;
  /** Внешняя отмена (например, от ресурса). */
  signal?: AbortSignal;
}

export interface PageCallContext {
  signal: AbortSignal;
  /**
   * Точка невозврата: гасит исходный дедлайн и снимает внешний `signal`, взводит дедлайн коммита
   * (`deadlineMs` или `COMMIT_DEADLINE_MS`; повторный вызов — заново) и продлевает аренду слота.
   * После отмены, дедлайна или завершения вызова бросает: загрузчик не должен проходить точку
   * невозврата в уже отклонённом вызове.
   */
  commit(deadlineMs?: number): void;
}

const pageScope = new AsyncLocalStorage<true>();

/**
 * Открывает `url` в общем браузерном контексте, проходит единый SSO ВШЭ при необходимости,
 * вызывает `fn` и **в `finally` закрывает страницу и освобождает слот лимитера**. Вызывающий код
 * `page.close()` не пишет. По истечении `deadlineMs` (или по `signal`) страница закрывается, слот
 * освобождается, вызов отклоняется. Вложенный `withPage` запрещён — он удерживал бы второй слот
 * и мог зависнуть на лимите.
 */
export async function withPage<T>(
  url: string,
  fn: (page: Page, ctx: PageCallContext) => Promise<T>,
  opts: WithPageOptions = {}
): Promise<T> {
  if (pageScope.getStore()) {
    throw new Error(
      "withPage: вложенное открытие страницы внутри withPage недопустимо (слот лимитера удерживается до конца внешнего вызова)"
    );
  }
  const deadlineMs = opts.deadlineMs ?? PAGE_DEADLINE_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`${labelOf(url)} не уложилась в ${deadlineMs / 1000} с`)),
    deadlineMs
  );
  const onExternalAbort = () => ctrl.abort(opts.signal?.reason ?? new Error("операция отменена"));
  if (opts.signal?.aborted) onExternalAbort();
  else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let page: Page | undefined;
  let release: PageSlotRelease | undefined;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const commit = (ms?: number) => {
    if (settled || ctrl.signal.aborted) {
      throw ctrl.signal.reason ?? new Error(`${labelOf(url)}: вызов уже завершён, точка невозврата недоступна`);
    }
    // После точки невозврата исход записи нельзя терять: исходный дедлайн и отмена вызывающего не действуют.
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    const commitMs = ms ?? COMMIT_DEADLINE_MS;
    clearTimeout(commitTimer);
    commitTimer = setTimeout(
      () => ctrl.abort(new Error(`${labelOf(url)} не уложилась в ${commitMs / 1000} с после точки невозврата`)),
      commitMs
    );
    release?.extendLease(commitMs + LEASE_GRACE_MS);
  };

  const aborted = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener(
      "abort",
      () => {
        page?.close().catch(() => {});
        reject(ctrl.signal.reason);
      },
      { once: true }
    );
    if (ctrl.signal.aborted) reject(ctrl.signal.reason);
  });
  aborted.catch(() => {});

  const work = pageScope.run(true, async () => {
    const rel = await acquirePageSlot({ signal: ctrl.signal, leaseMs: deadlineMs + LEASE_GRACE_MS });
    release = rel;
    if (ctrl.signal.aborted) {
      rel();
      ctrl.signal.throwIfAborted();
    }
    const context = await getContext();
    const p = await context.newPage();
    page = p;
    if (ctrl.signal.aborted) {
      await p.close().catch(() => {});
      ctrl.signal.throwIfAborted();
    }
    await p.goto(url, { waitUntil: "load" });
    await ensureAuthenticated(p, context, url);
    ctrl.signal.throwIfAborted();
    return fn(p, { signal: ctrl.signal, commit });
  });
  // Если победила отмена, поздний отказ `work` не должен стать unhandled rejection.
  work.catch(() => {});

  try {
    return await Promise.race([work, aborted]);
  } finally {
    settled = true;
    clearTimeout(timer);
    clearTimeout(commitTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    await page?.close().catch(() => {});
    release?.();
  }
}

/**
 * HTTP-клиент поверх общей браузерной сессии: делит cookies контекста, но не открывает страницу
 * (и потому не занимает слот лимитера). Для JSON-API, которым достаточно cookies + Bearer-токена.
 */
export async function getApiRequestContext(): Promise<APIRequestContext> {
  return (await getContext()).request;
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
