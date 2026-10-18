import fs from "node:fs";
import path from "node:path";
import { errCode, retryIo, withFileLock } from "../../fs-lock.js";
import { projectRoot } from "../../project-root.js";
import { STATE_VERSION, type Scope, type State } from "./types.js";

export const JOURNAL_MAX_EVENTS = 500;
export const JOURNAL_MAX_AGE_MS = 30 * 86_400_000;
export const GRADES_BASELINE_MAX_AGE_MS = 90 * 86_400_000;

export const defaultStateDir = (): string => path.join(projectRoot, "storage", "changes");
const stateFile = (dir: string): string => path.join(dir, "state.json");
const lockFile = (dir: string): string => path.join(dir, "state.json.lock");

export function emptyState(): State {
  return { version: STATE_VERSION, rev: 0, nextSeq: 1, issued: {}, lost: {}, baselines: {}, journal: [], seen: {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Проверка формы, достаточной для работы срезов и диффа; содержимое фактов не проверяется. */
function isValidState(x: unknown): x is State {
  if (!isObj(x)) return false;
  return (
    isNum(x.version) && isNum(x.rev) && isNum(x.nextSeq) &&
    isObj(x.issued) && isObj(x.lost) && isObj(x.seen) && isObj(x.baselines) &&
    (x.issues === undefined ||
      (isObj(x.issues) && Object.values(x.issues).every((v) => Array.isArray(v) && v.every((s) => typeof s === "string")))) &&
    Object.values(x.baselines).every((b) => isObj(b) && typeof b.takenAt === "string" && isObj(b.facts)) &&
    Array.isArray(x.journal) &&
    x.journal.every((e) => isObj(e) && isNum(e.seq) && typeof e.at === "string" && typeof e.scope === "string")
  );
}

export type LoadKind = "ok" | "missing" | "corrupt" | "newer" | "io-error";
export interface LoadResult {
  kind: LoadKind;
  state: State;
  warning?: string;
}

/** Имя для карантина: метка времени, существующие `.corrupt-*` не затираются. */
function corruptName(file: string): string {
  const base = `${file}.corrupt-${Date.now()}`;
  let name = base;
  for (let i = 1; fs.existsSync(name); i++) name = `${base}-${i}`;
  return name;
}

export async function loadState(dir: string): Promise<LoadResult> {
  const file = stateFile(dir);
  let text: string;
  try {
    text = await retryIo(() => fs.readFileSync(file, "utf8"));
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT") return { kind: "missing", state: emptyState() };
    // Любая ошибка ввода-вывода — не повреждение: файл не трогаем, вызывающий не пишет.
    return {
      kind: "io-error",
      state: emptyState(),
      warning: `не удалось прочитать state.json (${code ?? "ошибка ввода-вывода"}); запись пропущена, файл не тронут`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  // Версия проверяется до схемы: у более новой версии схема может быть другой, файл не трогаем.
  if (isObj(parsed) && isNum(parsed.version) && parsed.version > STATE_VERSION) {
    return {
      kind: "newer",
      state: emptyState(),
      warning: `state.json создан более новой версией (${parsed.version} > ${STATE_VERSION}); файл не тронут, запись пропущена`,
    };
  }
  if (!isValidState(parsed) || parsed.version < 1) {
    // Только невалидный JSON/схема считаются повреждением; прежние .corrupt не затираются.
    try {
      await retryIo(() => fs.renameSync(file, corruptName(file)));
    } catch {
      return {
        kind: "corrupt",
        state: emptyState(),
        warning: "state.json повреждён, но не удалось переместить повреждённый файл; запись отложена",
      };
    }
    return { kind: "corrupt", state: emptyState(), warning: "state.json повреждён: перемещён в .corrupt-*, начата чистая база" };
  }
  return { kind: "ok", state: parsed };
}

/**
 * Удаляет карантинные копии `state.json.corrupt-*` (в них те же темы и названия, что в состоянии) и
 * оставшиеся после аварийного завершения `state.json.<pid>.tmp`. Вызывать под `withStateLock`: тогда
 * чужой записи во временный файл идти не может. Возвращает число удалённых файлов.
 */
export async function removeLeftoverFiles(dir: string): Promise<number> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^state\.json\.corrupt-/.test(name) && !/^state\.json\.[^.]+\.tmp$/.test(name)) continue;
    try {
      await retryIo(() => fs.unlinkSync(path.join(dir, name)));
      removed++;
    } catch {
      /* исчез или занят: повторный reset удалит */
    }
  }
  return removed;
}

/** `rev` на диске: `null` — файла нет, `-1` — файл есть, но не разбирается (не совпадёт ни с каким ожидаемым). */
async function readRevOnDisk(file: string): Promise<number | null> {
  let text: string;
  try {
    text = await retryIo(() => fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as { rev?: unknown };
    return isNum(parsed?.rev) ? parsed.rev : -1;
  } catch {
    return -1;
  }
}

/**
 * Атомарная запись: во временный файл с pid и `rename` поверх (с повторами). `expectedRev` — `rev`,
 * прочитанный под блокировкой; если на диске другой (файл поменял не-hsemcp процесс), запись
 * отклоняется. `null` — файла при чтении не было. Ни при каком исходе файл `state.json` не
 * перемещается в `.corrupt`.
 */
export async function saveState(
  dir: string,
  state: State,
  expectedRev: number | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const onDisk = await readRevOnDisk(file);
    if (onDisk !== null && onDisk !== expectedRev) {
      return { ok: false, error: "state.json изменён другим процессом (rev не совпал)" };
    }
    // 0o600 на Windows не защита (права не применяются), оставлено для POSIX.
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    await retryIo(() => fs.renameSync(tmp, file));
    return { ok: true };
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp мог не создаться */
    }
    return { ok: false, error: `не удалось записать state.json (${errCode(err) ?? "ошибка ввода-вывода"})` };
  }
}

/**
 * Внутрипроцессный мьютекс + lock-файл `state.json.lock` (`wx`) на цикл «прочитать → пересчитать →
 * записать». Сбор данных идёт вне блокировки. Устаревшая (> 30 с) блокировка снимается.
 */
export function withStateLock<T>(dir: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  return withFileLock(lockFile(dir), fn, opts);
}

/**
 * Срезы журнала: событие старше 30 дней уходит, только если его `seq` ≤ min(`seen`) по областям
 * (и не выше `seen` своей области — для области без курсора ничего не срезается по возрасту);
 * потолок 500 срезает старейшие, в том числе невыданные (они считаются в `lost`). Журнал упорядочен
 * по `seq` по возрастанию.
 */
export function pruneJournal(state: State, now: Date): void {
  const seen = Object.values(state.seen).filter((v): v is number => typeof v === "number");
  const minSeen = seen.length ? Math.min(...seen) : 0;
  const cutoff = now.getTime() - JOURNAL_MAX_AGE_MS;
  state.journal = state.journal.filter(
    (e) => !(Date.parse(e.at) < cutoff && e.seq <= minSeen && e.seq <= (state.seen[e.scope] ?? 0))
  );
  while (state.journal.length > JOURNAL_MAX_EVENTS) {
    const dropped = state.journal.shift();
    if (dropped && dropped.seq > (state.seen[dropped.scope] ?? 0)) {
      const scope: Scope = dropped.scope;
      state.lost[scope] = (state.lost[scope] ?? 0) + 1;
    }
  }
}

/** Базы `lms_grades:<id>`, не обновлявшиеся 90 дней (курс исчез из актуальных), удаляются. */
export function pruneGradeBaselines(state: State, now: Date): void {
  const cutoff = now.getTime() - GRADES_BASELINE_MAX_AGE_MS;
  for (const [source, baseline] of Object.entries(state.baselines)) {
    if (source.startsWith("lms_grades:") && Date.parse(baseline.takenAt) < cutoff) delete state.baselines[source];
  }
}
