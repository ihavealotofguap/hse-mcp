import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser } from "playwright";

/** Браузер для Playwright: скачанный им Chromium (`undefined`) или установленный в системе по `channel`. */
export type BrowserChannel = "chrome" | "msedge" | undefined;

/** Понятное имя для логов и ошибок. */
export function channelLabel(channel: BrowserChannel): string {
  if (channel === "msedge") return "Microsoft Edge";
  if (channel === "chrome") return "Google Chrome";
  return "Chromium (Playwright)";
}

/**
 * Порядок попыток по `HSE_BROWSER_CHANNEL`. `auto` (по умолчанию): сначала скачанный Chromium — так
 * работает установка разработчика, — затем браузер, который скорее всего есть в системе (Edge стоит на
 * любой Windows), затем второй. Явное значение — только он.
 */
export function browserCandidates(
  setting: string | undefined,
  platform: NodeJS.Platform
): BrowserChannel[] {
  const value = setting?.trim().toLowerCase() || "auto";
  switch (value) {
    case "auto":
      return platform === "win32"
        ? [undefined, "msedge", "chrome"]
        : [undefined, "chrome", "msedge"];
    case "chromium":
      return [undefined];
    case "chrome":
    case "msedge":
      return [value];
    default:
      throw new Error("HSE_BROWSER_CHANNEL: допустимы auto, chromium, chrome или msedge");
  }
}

/** Ошибка запуска означает, что браузера нет на диске (а не что он упал). */
export function isMissingBrowserError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|is not found at|distribution '.*' is not found/i.test(message);
}

export const DOWNLOADING_MESSAGE =
  "Скачиваю браузер для входа в ВШЭ (около 100 МБ, один раз): повторите запрос через 1–2 минуты";
export const DOWNLOAD_FAILED_MESSAGE =
  "Не удалось скачать браузер для входа в ВШЭ: проверьте интернет и повторите запрос, либо установите Google Chrome или Microsoft Edge";

export interface LaunchDeps {
  launch(channel: BrowserChannel): Promise<Browser>;
  /** Состояние скачивания Chromium: запускает его, если не идёт; `failed` — прошлая попытка не удалась. */
  download(): "started" | "running" | "failed";
  log(line: string): void;
}

/**
 * Пробует браузеры по порядку. Если скачанного Chromium нет, а остальные не запустились, запускает
 * его скачивание в фоне и отклоняет вызов понятной ошибкой: загрузка не укладывается в дедлайн тула.
 */
export async function launchWithFallback(
  candidates: BrowserChannel[],
  deps: LaunchDeps
): Promise<Browser> {
  let chromiumMissing = false;
  let lastError: unknown = null;
  for (const channel of candidates) {
    try {
      const browser = await deps.launch(channel);
      deps.log(`hsemcp: Node ${process.version}, браузер: ${channelLabel(channel)}`);
      return browser;
    } catch (err) {
      if (channel === undefined && isMissingBrowserError(err)) chromiumMissing = true;
      else if (!isMissingBrowserError(err)) {
        // Без текста ошибки: в нём бывают пути профиля пользователя.
        deps.log(`hsemcp: ${channelLabel(channel)} не запустился`);
        lastError = err;
      }
    }
  }
  if (chromiumMissing) {
    const state = deps.download();
    throw new Error(state === "failed" ? DOWNLOAD_FAILED_MESSAGE : DOWNLOADING_MESSAGE);
  }
  if (lastError) throw lastError;
  throw new Error(
    "Не найден браузер для входа в ВШЭ: установите Google Chrome или Microsoft Edge (или HSE_BROWSER_CHANNEL=auto)"
  );
}

/** Путь к CLI Playwright: `cli.js` не в `exports` пакета, поэтому от его `package.json`. */
function playwrightCli(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
}

/**
 * Запускает `playwright install chromium` отдельным процессом того же Node; с `shellOnly` — только
 * Chrome Headless Shell (`--only-shell`), которого достаточно headless-режиму. `ELECTRON_RUN_AS_NODE` — на случай встроенного Node хоста на
 * Electron (Claude Desktop): без него `process.execPath` открыл бы окно приложения. Пароль дочернему
 * процессу не передаётся. Вывод установщика — только в stderr (`inherit`) или никуда: stdout сервера
 * занят протоколом MCP.
 */
export function runChromiumInstall(
  stderr: "inherit" | "ignore",
  shellOnly: boolean
): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.HSE_PASSWORD;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const args = ["install", ...(shellOnly ? ["--only-shell"] : []), "chromium"];
      child = spawn(process.execPath, [playwrightCli(), ...args], {
        env,
        stdio: ["ignore", stderr === "inherit" ? process.stderr : "ignore", stderr],
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

let download: Promise<boolean> | null = null;
let lastDownloadFailed = false;

/** Фоновое скачивание для `launchWithFallback`: одно на процесс; после неудачи следующий вызов пробует снова. */
export function backgroundDownload(
  shellOnly: boolean,
  log: (line: string) => void
): "started" | "running" | "failed" {
  if (download) return "running";
  const failedBefore = lastDownloadFailed;
  log("hsemcp: скачиваю Chromium для Playwright");
  download = runChromiumInstall("ignore", shellOnly).then((ok) => {
    lastDownloadFailed = !ok;
    download = null;
    log(ok ? "hsemcp: Chromium скачан" : "hsemcp: скачать Chromium не удалось");
    return ok;
  });
  return failedBefore ? "failed" : "started";
}
