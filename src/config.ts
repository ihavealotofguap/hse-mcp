import path from "node:path";
import {
  captureCredentialInputs,
  DOTENV_PASSWORD_WARNING,
  dotenvPermissionWarning,
  loadKeyStore,
  lookupPassword,
} from "./credentials.js";
import { dataDir } from "./data-dir.js";
import { projectRoot } from "./project-root.js";

// Ищем .env рядом с проектом, а не в process.cwd() — иначе при запуске сервера
// сторонним хостом (Claude Desktop и т.п.) с произвольной рабочей директорией
// файл просто не найдётся.
const dotenvFile = path.join(projectRoot, ".env");

// Окружение процесса до применения .env: пароль, пришедший из .env, не должен выглядеть «окружением».
const { envAtStart, dotenv: dotenvValues } = captureCredentialInputs(dotenvFile);

// Системное хранилище грузится один раз при импорте, чтобы hsePassword оставался синхронным геттером.
// Само хранилище опрашивается лениво — при первом входе, а не на старте сервера.
const keyStore = await loadKeyStore();

/** Входные данные поиска пароля — для команд `credentials:*`. */
export const credentialInputs = { env: envAtStart, dotenv: dotenvValues, dotenvFile, keyStore };

/** `HSE_EMAIL` без ошибки при отсутствии (для команд, которые умеют спросить его сами). */
export function optionalEmail(): string | null {
  return process.env.HSE_EMAIL || null;
}

let dotenvWarned = false;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function resolvePassword(): string {
  const { password, source } = lookupPassword({
    env: envAtStart,
    dotenv: dotenvValues,
    account: process.env.HSE_EMAIL ?? "",
    store: keyStore,
  });
  if (password === null) {
    throw new Error(
      "Не найден пароль ВШЭ: укажите его в настройках расширения hsemcp, выполните hsemcp credentials set (из клона — npm run credentials:set) или задайте HSE_PASSWORD."
    );
  }
  if (source === "dotenv" && !dotenvWarned) {
    dotenvWarned = true;
    // stderr: stdout занят протоколом MCP. Без значений и без пути.
    console.error(DOTENV_PASSWORD_WARNING);
    const perm = dotenvPermissionWarning(dotenvFile);
    if (perm) console.error(perm);
  }
  return password;
}

export const config = {
  get hseEmail(): string {
    return required("HSE_EMAIL");
  },
  get hsePassword(): string {
    return resolvePassword();
  },
  get browserHeadless(): boolean {
    return process.env.HSE_BROWSER_HEADLESS !== "false";
  },
  /** Папка «исходящих»: `HSE_OUTBOX_DIR` (абсолютный путь или относительно корня проекта), иначе `outbox` в каталоге данных. */
  get outboxDir(): string {
    const value = process.env.HSE_OUTBOX_DIR?.trim();
    return value ? path.resolve(projectRoot, value) : path.join(dataDir(), "outbox");
  },
  /** Тулы записи — opt-in: включены только при `HSE_ENABLE_WRITES=true` (без учёта регистра и пробелов). */
  get writesEnabled(): boolean {
    return process.env.HSE_ENABLE_WRITES?.trim().toLowerCase() === "true";
  },
};
