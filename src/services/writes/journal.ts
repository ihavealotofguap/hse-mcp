import fs from "node:fs";
import path from "node:path";
import { errCode, retryIo, withFileLock, writeFileAtomic } from "../../fs-lock.js";
import { writesDir } from "./token.js";
import type { ErrorClass, Outcome, Stage } from "./types.js";

export const JOURNAL_MAX_AGE_MS = 90 * 86_400_000;
export const JOURNAL_MAX_ENTRIES = 200;

/** Только обезличенные поля: ни текста, ни имён файлов, ни id курсов/заданий/заявок. */
export interface JournalEntry {
  at: string;
  op: string;
  tokenId: string;
  targetId: string;
  stage: Stage;
  outcome?: Outcome;
  durationMs?: number;
  errorClass?: ErrorClass;
}

const journalFile = (dir: string): string => path.join(dir, "journal.json");
const lockFile = (dir: string): string => path.join(dir, "journal.json.lock");

/** Копируются только перечисленные поля: всё лишнее, что передали, в файл не попадёт. */
function pick(e: JournalEntry): JournalEntry {
  const out: JournalEntry = { at: e.at, op: e.op, tokenId: e.tokenId, targetId: e.targetId, stage: e.stage };
  if (e.outcome !== undefined) out.outcome = e.outcome;
  if (e.durationMs !== undefined) out.durationMs = e.durationMs;
  if (e.errorClass !== undefined) out.errorClass = e.errorClass;
  return out;
}

const isEntry = (v: unknown): v is JournalEntry =>
  !!v && typeof v === "object" && typeof (v as JournalEntry).at === "string" && typeof (v as JournalEntry).tokenId === "string";

/** `corrupt` — файл есть, но не разбирается как массив записей; сам файл чтение не трогает. */
async function readEntries(dir: string): Promise<{ entries: JournalEntry[]; corrupt: boolean }> {
  let text: string;
  try {
    text = await retryIo(() => fs.readFileSync(journalFile(dir), "utf8"));
  } catch (err) {
    if (errCode(err) === "ENOENT") return { entries: [], corrupt: false };
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return { entries: parsed.filter(isEntry), corrupt: false };
  } catch {
    /* повреждён */
  }
  return { entries: [], corrupt: true };
}

/** Имя для карантина: метка времени, существующие `.corrupt-*` не затираются. */
function corruptName(file: string): string {
  const base = `${file}.corrupt-${Date.now()}`;
  let name = base;
  for (let i = 1; fs.existsSync(name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * Добавляет запись под lock-файлом, срезает по возрасту (90 дней) и числу (200), пишет атомарно.
 * Повреждённый журнал переименовывается в `journal.json.corrupt-<ts>`, журнал начинается заново.
 */
export async function recordJournal(entry: JournalEntry, dir: string = writesDir(), now: Date = new Date()): Promise<void> {
  await withFileLock(lockFile(dir), async () => {
    const { entries, corrupt } = await readEntries(dir);
    if (corrupt) await retryIo(() => fs.renameSync(journalFile(dir), corruptName(journalFile(dir))));
    const cutoff = now.getTime() - JOURNAL_MAX_AGE_MS;
    const kept = [...entries, pick(entry)].filter((e) => !(Date.parse(e.at) < cutoff));
    await writeFileAtomic(journalFile(dir), JSON.stringify(kept.slice(-JOURNAL_MAX_ENTRIES)));
  });
}

/** Последняя запись по токену (журнал упорядочен по времени добавления). */
export async function latestByToken(tokenId: string, dir: string = writesDir()): Promise<JournalEntry | undefined> {
  const { entries } = await readEntries(dir);
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].tokenId === tokenId) return entries[i];
  return undefined;
}

/**
 * Неразрешённые записи по цели: по каждому `tokenId` берётся последняя; «не разрешено» — стадия не
 * `verified` либо исход `unknown`. `exceptTokenId` исключает токен текущей операции.
 */
export async function findUnresolvedByTarget(
  targetId: string,
  dir: string = writesDir(),
  exceptTokenId?: string
): Promise<JournalEntry[]> {
  const { entries } = await readEntries(dir);
  const last = new Map<string, JournalEntry>();
  for (const e of entries) last.set(e.tokenId, e);
  return [...last.values()].filter(
    (e) => e.targetId === targetId && e.tokenId !== exceptTokenId && (e.stage !== "verified" || e.outcome === "unknown")
  );
}
