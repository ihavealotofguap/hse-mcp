import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Учётная запись для `icacls`: `ДОМЕН\\пользователь`, без домена — просто имя; нет имени — `null`. */
export function windowsAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  const user = env.USERNAME;
  if (!user) return null;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/**
 * Права на пути только текущему пользователю через `icacls`. Сначала выдаём право, потом снимаем
 * наследование: при сбое выдачи путь остаётся доступен. Без оболочки, ошибки глотаются.
 */
function icaclsOwnerOnly(path: string, grant: string): void {
  const account = windowsAccount();
  if (!account || !fs.existsSync(path)) return;
  execFileSync("icacls", [path, "/grant:r", `${account}:${grant}`, "/inheritance:r"], { stdio: "ignore", windowsHide: true });
}

/**
 * Файл-секрет читает только владелец. POSIX: `chmod 0o600`. Windows: `icacls` снимает унаследованные
 * права и оставляет полный доступ текущему пользователю. Best-effort: любая ошибка (чужой файл,
 * нестандартный профиль, нет `icacls`) глотается молча, без вывода путей.
 */
export function restrictFile(path: string): void {
  try {
    if (process.platform === "win32") icaclsOwnerOnly(path, "(F)");
    else fs.chmodSync(path, 0o600);
  } catch {
    /* права не критичны для работы; путь в сообщение не выносим */
  }
}

/**
 * То же для каталога: POSIX `0o700`; Windows — полный доступ владельцу с наследованием на вложенное
 * (`(OI)(CI)(F)`), так что новые файлы сразу создаются с ограниченными правами, без окна между записью
 * и `restrictFile`. Идемпотентно, ошибки глотаются.
 */
export function restrictDir(path: string): void {
  try {
    if (process.platform === "win32") icaclsOwnerOnly(path, "(OI)(CI)(F)");
    else fs.chmodSync(path, 0o700);
  } catch {
    /* см. restrictFile */
  }
}

const privateDirs = new Set<string>();

/**
 * Создаёт каталог (с `0o700`) и один раз за процесс ограничивает его права: файлы, созданные внутри
 * позже, наследуют их и не бывают доступны другим даже на мгновение между записью и `restrictFile`.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (privateDirs.has(dir)) return;
  privateDirs.add(dir);
  restrictDir(dir);
}

const restrictedOnRead = new Set<string>();

/** `restrictFile` не чаще раза за процесс на путь: для уже существующих файлов-секретов (идемпотентно). */
export function restrictFileOnce(path: string): void {
  if (restrictedOnRead.has(path)) return;
  restrictedOnRead.add(path);
  restrictFile(path);
}
