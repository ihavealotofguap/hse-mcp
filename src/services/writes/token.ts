import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errCode, withFileLock, writeFileAtomic } from "../../fs-lock.js";
import { ensurePrivateDir, restrictFile, restrictFileOnce } from "../../fs-secure.js";
import { projectRoot } from "../../project-root.js";
import type { PreviewPayload } from "./types.js";

export const PREVIEW_TTL_MS = 15 * 60_000;
/** Допустимый перекос часов: токен «из будущего» дальше этого срока не принимается. */
const FUTURE_SKEW_MS = 60_000;

const KEY_RE = /^[0-9a-f]{64}$/;
// Время выпуска — каноническое десятичное число (без ведущих нулей, ≤ 16 цифр); безопасность целого проверяется отдельно.
const TOKEN_RE = /^(0|[1-9]\d{0,15})\.([0-9a-f]{64})$/;

/**
 * Каталог ключа и журнала записей; `HSE_WRITES_DIR` — для проверочных скриптов. Относительный путь
 * разрешается от cwd процесса (нужно только проверкам: сервер задаёт абсолютный или берёт каталог проекта).
 */
export function writesDir(): string {
  const override = process.env.HSE_WRITES_DIR;
  return override ? path.resolve(override) : path.join(projectRoot, "storage", "writes");
}

function readKey(file: string): Buffer | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
  if (!KEY_RE.test(text)) throw new Error("Файл ключа записи повреждён: удалите файл key в каталоге записей — ключ создастся заново");
  // Ключ мог быть создан с широкими правами: на POSIX ужимаем до 0o600, на Windows снимаем
  // унаследованные права через icacls (один раз за процесс).
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* не владелец файла — не критично */
    }
  } else {
    restrictFileOnce(file);
  }
  return Buffer.from(text, "hex");
}

/**
 * Ключ HMAC: 32 случайных байта в файле `key` (hex). Создаётся при первом обращении под lock-файлом
 * с повторным чтением внутри — параллельные первые вызовы получают один и тот же ключ.
 */
export async function loadOrCreateKey(dir: string = writesDir()): Promise<Buffer> {
  const file = path.join(dir, "key");
  // Каталог создаём сами с 0o700 (lock-файл создал бы его с правами по умолчанию) и ограничиваем
  // права на нём: на Windows mode игнорируется, а файлы внутри наследуют права каталога. Для
  // стандартного расположения то же делаем с `storage/`.
  if (dir === path.join(projectRoot, "storage", "writes")) ensurePrivateDir(path.dirname(dir));
  ensurePrivateDir(dir);
  const existing = readKey(file);
  if (existing) return existing;
  return withFileLock(path.join(dir, "key.lock"), async () => {
    const again = readKey(file);
    if (again) return again;
    const key = crypto.randomBytes(32);
    await writeFileAtomic(file, key.toString("hex"));
    restrictFile(file);
    return key;
  });
}

/** Канонический JSON: ключи объектов по алфавиту, `files` по `name`; `undefined` пропускается. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

function previewHmac(key: Buffer, issuedAtSec: number, p: PreviewPayload): string {
  const files = [...p.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const body = canonical({ op: p.op, issuedAtSec, target: p.target, mode: p.mode, files, state: p.state });
  return crypto.createHmac("sha256", key).update(body).digest("hex");
}

/** `"<issuedAtSec>.<hmac>"`: HMAC-SHA256 по канонической форме операции, цели, режима, файлов и состояния. */
export function signPreview(key: Buffer, p: PreviewPayload, now: Date = new Date()): string {
  const issuedAtSec = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAtSec)) throw new Error("Некорректное время выпуска токена предпросмотра");
  return `${issuedAtSec}.${previewHmac(key, issuedAtSec, p)}`;
}

export type VerifyResult =
  | { ok: true; tokenId: string; issuedAt: Date }
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

/** Разбор токена: каноническая запись и безопасное целое время выпуска, иначе `null`. */
function parseToken(token: string): { issuedAtSec: number; hash: string } | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const issuedAtSec = Number(m[1]);
  return Number.isSafeInteger(issuedAtSec) ? { issuedAtSec, hash: m[2] } : null;
}

export function verifyPreview(key: Buffer, token: string, p: PreviewPayload, now: Date = new Date()): VerifyResult {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, reason: "malformed" };
  const { issuedAtSec, hash } = parsed;
  const given = Buffer.from(hash, "hex");
  const expected = Buffer.from(previewHmac(key, issuedAtSec, p), "hex");
  // timingSafeEqual бросает на разной длине; формат токена это исключает, но защита дешёвая.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };
  const issuedAt = new Date(issuedAtSec * 1000);
  // «expired» и для токена из будущего (> now + 60 с): подпись верна, но часы разошлись — такой токен не принимаем.
  // Граница строгая: ровно через 15:00.000 токен ещё действителен.
  const age = now.getTime() - issuedAt.getTime();
  if (age > PREVIEW_TTL_MS || age < -FUTURE_SKEW_MS) return { ok: false, reason: "expired" };
  return { ok: true, tokenId: hash.slice(0, 12), issuedAt };
}

/** 12 hex из хеш-части токена; `null`, если это не токен. */
export function tokenIdOf(token: string): string | null {
  const parsed = parseToken(token);
  return parsed ? parsed.hash.slice(0, 12) : null;
}

/** Стабильный обезличенный идентификатор цели для журнала: HMAC по `op` и `target`, 12 hex. */
export function targetIdOf(key: Buffer, op: string, target: string): string {
  return crypto.createHmac("sha256", key).update(canonical(["target", op, target])).digest("hex").slice(0, 12);
}
