import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errCode, withFileLock, writeFileAtomic } from "../../fs-lock.js";
import { projectRoot } from "../../project-root.js";
import type { PreviewPayload } from "./types.js";

export const PREVIEW_TTL_MS = 15 * 60_000;

const KEY_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^(\d+)\.([0-9a-f]{64})$/;

/** Каталог ключа и журнала записей; `HSE_WRITES_DIR` — для проверочных скриптов. */
export function writesDir(): string {
  return process.env.HSE_WRITES_DIR || path.join(projectRoot, "storage", "writes");
}

function readKey(file: string): Buffer | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
  if (!KEY_RE.test(text)) throw new Error("Файл ключа записи повреждён: удалите storage/writes/key — ключ создастся заново");
  return Buffer.from(text, "hex");
}

/**
 * Ключ HMAC: 32 случайных байта в файле `key` (hex). Создаётся при первом обращении под lock-файлом
 * с повторным чтением внутри — параллельные первые вызовы получают один и тот же ключ.
 */
export async function loadOrCreateKey(dir: string = writesDir()): Promise<Buffer> {
  const file = path.join(dir, "key");
  const existing = readKey(file);
  if (existing) return existing;
  return withFileLock(path.join(dir, "key.lock"), async () => {
    const again = readKey(file);
    if (again) return again;
    const key = crypto.randomBytes(32);
    await writeFileAtomic(file, key.toString("hex"));
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
  return `${issuedAtSec}.${previewHmac(key, issuedAtSec, p)}`;
}

export type VerifyResult =
  | { ok: true; tokenId: string; issuedAt: Date }
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

export function verifyPreview(key: Buffer, token: string, p: PreviewPayload, now: Date = new Date()): VerifyResult {
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false, reason: "malformed" };
  const issuedAtSec = Number(m[1]);
  const given = Buffer.from(m[2], "hex");
  const expected = Buffer.from(previewHmac(key, issuedAtSec, p), "hex");
  // timingSafeEqual бросает на разной длине; формат токена это исключает, но защита дешёвая.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };
  const issuedAt = new Date(issuedAtSec * 1000);
  if (now.getTime() - issuedAt.getTime() > PREVIEW_TTL_MS) return { ok: false, reason: "expired" };
  return { ok: true, tokenId: m[2].slice(0, 12), issuedAt };
}

/** 12 hex из хеш-части токена; `null`, если это не токен. */
export function tokenIdOf(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  return m ? m[2].slice(0, 12) : null;
}

/** Стабильный обезличенный идентификатор цели для журнала: HMAC по `op` и `target`, 12 hex. */
export function targetIdOf(key: Buffer, op: string, target: string): string {
  return crypto.createHmac("sha256", key).update(canonical(["target", op, target])).digest("hex").slice(0, 12);
}
