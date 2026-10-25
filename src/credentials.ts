import fs from "node:fs";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";

/** Откуда взят пароль: окружение процесса, системное хранилище, `.env` или нигде. */
export type CredentialSource = "env" | "keychain" | "dotenv" | "none";

/** Хранилище паролей по учётной записи; в проекте — системное через `@napi-rs/keyring`. */
export interface KeyStore {
  getPassword(account: string): string | null;
  setPassword(account: string, password: string): void;
  deletePassword(account: string): boolean;
}

export const KEYCHAIN_SERVICE = "hse-mcp";

/** Одно предупреждение при чтении пароля из `.env`; значения в тексте нет. */
export const DOTENV_PASSWORD_WARNING = "пароль взят из .env; безопаснее: npm run credentials:set";
const DOTENV_PERMISSION_WARNING =
  ".env доступен группе или другим пользователям системы; ограничьте права: chmod 600 .env";

// Минимальная форма Entry из @napi-rs/keyring: типы пакета не подключаем, чтобы сборка не зависела от
// необязательной зависимости.
interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}
type KeyringEntryCtor = new (
  service: string,
  account: string,
  options?: { linux?: { store?: string } }
) => KeyringEntry;

const importModule = (name: string): Promise<unknown> => import(name);

/**
 * Системное хранилище или `null`: пакета нет, он не загрузился (нет бинарника под платформу) либо
 * хранилище недоступно — любая ошибка означает откат на `.env`. На Linux запись привязывается к Secret
 * Service: без него пакет молча ушёл бы в `keyutils`, чьи данные не переживают перезагрузку; для этого
 * на Linux один раз обращаемся к хранилищу, чтобы убедиться, что оно отвечает (вызов синхронный и при
 * заблокированной связке ключей или отсутствии D-Bus может надолго задержать запуск; обход —
 * `HSE_DISABLE_KEYCHAIN=true`, он же нужен CI и серверам без графической сессии). Импортёр, платформа и
 * окружение вынесены в параметры для проверки без настоящего пакета и хранилища.
 */
export async function loadKeyStore(
  importer: (name: string) => Promise<unknown> = importModule,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<KeyStore | null> {
  if (env.HSE_DISABLE_KEYCHAIN?.trim().toLowerCase() === "true") return null;
  try {
    const mod = (await importer("@napi-rs/keyring")) as { Entry?: KeyringEntryCtor } | null;
    const Entry = mod?.Entry;
    if (typeof Entry !== "function") return null;
    const options = platform === "linux" ? { linux: { store: "secret-service" } } : undefined;
    const entryOf = (account: string): KeyringEntry =>
      options
        ? new Entry(KEYCHAIN_SERVICE, account, options)
        : new Entry(KEYCHAIN_SERVICE, account);
    if (platform === "linux") entryOf("availability-probe").getPassword();
    return {
      // Сбой чтения (хранилище заблокировано) — как «записи нет»: поиск пароля пойдёт дальше, к `.env`.
      getPassword(account) {
        try {
          return entryOf(account).getPassword();
        } catch {
          return null;
        }
      },
      setPassword(account, password) {
        entryOf(account).setPassword(password);
      },
      deletePassword(account) {
        return entryOf(account).deleteCredential();
      },
    };
  } catch {
    return null;
  }
}

/** Чистый поиск пароля: переменная окружения процесса, затем хранилище, затем `.env`. */
export function lookupPassword(args: {
  env: NodeJS.ProcessEnv;
  dotenv: Record<string, string>;
  account: string;
  store: KeyStore | null;
}): { password: string | null; source: CredentialSource } {
  if (args.env.HSE_PASSWORD) return { password: args.env.HSE_PASSWORD, source: "env" };
  if (args.store && args.account) {
    const stored = args.store.getPassword(args.account);
    if (stored) return { password: stored, source: "keychain" };
  }
  if (args.dotenv.HSE_PASSWORD) return { password: args.dotenv.HSE_PASSWORD, source: "dotenv" };
  return { password: null, source: "none" };
}

/** Предупреждение о правах по режиму файла: только POSIX, любой бит группы/остальных — повод. */
export function permissionWarningForMode(
  mode: number,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform === "win32") return null;
  return (mode & 0o077) !== 0 ? DOTENV_PERMISSION_WARNING : null;
}

/** Предупреждение о правах на `.env` (без пути и значений); нет файла или Windows — `null`. */
export function dotenvPermissionWarning(
  file: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform === "win32") return null;
  try {
    return permissionWarningForMode(fs.statSync(file).mode, platform);
  } catch {
    return null;
  }
}

/**
 * Читает `.env` и применяет его к `env` (как раньше), но запоминает окружение ДО применения: пароль,
 * пришедший из `.env`, иначе выглядел бы как пришедший из окружения процесса.
 */
export function captureCredentialInputs(
  dotenvFile: string,
  env: NodeJS.ProcessEnv = process.env
): { envAtStart: NodeJS.ProcessEnv; dotenv: Record<string, string> } {
  const envAtStart: NodeJS.ProcessEnv = { ...env };
  let dotenv: Record<string, string> = {};
  try {
    dotenv = parseDotenv(fs.readFileSync(dotenvFile));
  } catch {
    /* .env нет или он нечитаем — остаётся окружение и хранилище */
  }
  loadDotenv({ path: dotenvFile, processEnv: env as Record<string, string> });
  return { envAtStart, dotenv };
}
