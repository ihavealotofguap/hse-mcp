import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../../config.js";
import { dataDir } from "../../data-dir.js";
import { errCode } from "../../fs-lock.js";
import { projectRoot as realProjectRoot } from "../../project-root.js";

// Каноническая форма пути (раскрывает симлинки и junction, на Windows приводит регистр диска и имён).
const realpath = promisify(fs.realpath.native);

const DEFAULT_MAX_FILES = 10;
const MAX_NAME_LENGTH = 255;
const CHUNK = 64 * 1024;

export interface OutboxFile {
  /** Имя на диске (`basename` канонического пути), а не написание из запроса модели. */
  name: string;
  absPath: string;
  size: number;
  sha256: string;
}

// Служебные имена устройств Windows: открываются как устройство независимо от расширения.
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
// Управляющие символы (включая NUL) и знаки, недопустимые в именах Windows; `/`, `\`, `:` — пути и потоки.
// biome-ignore lint/suspicious/noControlCharactersInRegex: управляющие символы в именах файлов отклоняются намеренно.
const BAD_CHAR_RE = /[\x00-\x1f<>"|?*/\\:]/;

/** Приводит путь к виду для сравнения: без `\\?\`, нормализованный, на Windows без учёта регистра. */
function comparable(p: string): string {
  let s = p;
  if (s.startsWith("\\\\?\\UNC\\")) s = `\\\\${s.slice(8)}`;
  else if (s.startsWith("\\\\?\\")) s = s.slice(4);
  s = path.resolve(s);
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Лежит ли `file` строго внутри `dir`. Граница — разделитель пути, а не префикс строки, поэтому
 * `outbox-evil` не считается лежащим в `outbox`. Оба пути должны быть уже канонизированы `realpath`.
 */
export function isInsideDir(dir: string, file: string): boolean {
  const d = comparable(dir);
  const f = comparable(file);
  if (f === d) return false;
  const prefix = d.endsWith(path.sep) ? d : d + path.sep;
  return f.startsWith(prefix);
}

/**
 * Папка «исходящих» не должна быть корнем проекта или каталогом данных (`storage`), содержать их или
 * быть корнем диска: иначе `.env` и `hse-session.json` адресовались бы обычным именем файла. Внутри
 * каталога данных допустима только его `outbox` (по умолчанию) и её подпапки: ключ HMAC и журнал лежат в
 * `writes`, сессия и снимки — рядом, и становиться «исходящими» им нельзя. Все пути должны быть
 * канонизированы `realpath` (в том числе каталог данных: junction не должен обходить сравнение).
 */
function misplacedOutbox(dirReal: string, root: string, storage: string): boolean {
  const dir = comparable(dirReal);
  if (dir === comparable(root) || dir === comparable(storage)) return true;
  if (isInsideDir(dirReal, root) || isInsideDir(dirReal, storage)) return true;
  if (isInsideDir(storage, dirReal)) {
    const defaultOutbox = path.join(storage, "outbox");
    if (comparable(dirReal) !== comparable(defaultOutbox) && !isInsideDir(defaultOutbox, dirReal))
      return true;
  }
  return dir === comparable(path.parse(dir).root);
}

/** Причина отказа по самому имени (без обращения к диску) или `null`. */
function nameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return "имя пустое";
  if (name === "." || name === "..") return "недопустимое имя";
  if (name.length > MAX_NAME_LENGTH) return "слишком длинное имя";
  if (BAD_CHAR_RE.test(name)) return "нужно имя файла без путей, дисков и спецсимволов";
  if (name.endsWith(".") || name.endsWith(" "))
    return "имя не может оканчиваться точкой или пробелом";
  if (RESERVED_RE.test(name.split(".")[0].trimEnd())) return "зарезервированное имя устройства";
  return null;
}

async function hashFile(
  handle: fs.promises.FileHandle,
  expected: number
): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.allocUnsafe(CHUNK);
  let bytes = 0;
  while (bytes <= expected) {
    const { bytesRead } = await handle.read(buf, 0, CHUNK, null);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    bytes += bytesRead;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Проверяет имена файлов из папки «исходящих» и возвращает их канонические пути, размеры и sha256.
 * Принимается только имя файла (без путей и дисков); `realpath` результата обязан лежать внутри
 * папки, это ловит симлинки и junction наружу. Файлы не изменяются и не перемещаются. Тексты ошибок
 * не содержат ни имён, ни путей — только «файл №N» и причину.
 */
export async function resolveOutboxFiles(
  names: string[],
  opts: {
    dir?: string;
    maxFiles?: number;
    maxBytes?: number;
    projectRoot?: string;
    dataDir?: string;
  } = {}
): Promise<OutboxFile[]> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  if (!Array.isArray(names) || names.length === 0) throw new Error("Не указано ни одного файла");
  if (names.length > maxFiles) throw new Error(`Слишком много файлов: не более ${maxFiles}`);

  const dirRaw = opts.dir ?? config.outboxDir;
  // Папку создаём сами (без родителей): в пакете `.mcpb` она по умолчанию в «Документах», и
  // пользователь без терминала не должен готовить её заранее. Проверки ниже идут уже по созданной.
  await fs.promises.mkdir(dirRaw).catch(() => {});
  let dirReal: string;
  try {
    dirReal = await realpath(dirRaw);
    if (!(await fs.promises.stat(dirReal)).isDirectory()) throw new Error("не папка");
  } catch {
    throw new Error(
      "Папка «исходящих» недоступна: создайте её (storage/outbox или HSE_OUTBOX_DIR)"
    );
  }
  // Корень проекта канонизируем так же, как папку (junction/регистр); `projectRoot` в opts — для проверок.
  const root = await realpath(opts.projectRoot ?? realProjectRoot).catch(() =>
    path.resolve(opts.projectRoot ?? realProjectRoot)
  );
  // Каталог данных канонизируем так же (если его нет — берём путь как есть): иначе junction обходит
  // сравнение. С `projectRoot` в opts (проверки) это его `storage`, как у клона репозитория.
  const storageRaw = opts.dataDir ?? (opts.projectRoot ? path.join(root, "storage") : dataDir());
  const storage = await realpath(storageRaw).catch(() => storageRaw);
  if (misplacedOutbox(dirReal, root, storage)) {
    throw new Error(
      "Папка «исходящих» настроена неверно: она не должна совпадать с каталогом проекта или каталогом данных, " +
        "содержать их, быть корнем диска или лежать в каталоге данных кроме его outbox (проверьте HSE_OUTBOX_DIR)"
    );
  }

  const result: OutboxFile[] = [];
  const seenNames = new Map<string, number>();
  const seenReal = new Map<string, number>();

  for (let i = 0; i < names.length; i++) {
    const n = i + 1;
    const name = names[i];
    const problem = nameProblem(name);
    if (problem) throw new Error(`Файл №${n}: ${problem}`);

    const nameKey = process.platform === "win32" ? name.toLowerCase() : name;
    const dupName = seenNames.get(nameKey);
    if (dupName !== undefined) throw new Error(`Файл №${n}: повторяет файл №${dupName}`);
    seenNames.set(nameKey, n);

    let real: string;
    try {
      real = await realpath(path.join(dirReal, name));
    } catch (err) {
      const code = errCode(err);
      throw new Error(
        code === "ENOENT" || code === "ENOTDIR"
          ? `Файл №${n}: не найден в папке «исходящих»`
          : `Файл №${n}: не удалось определить путь`
      );
    }
    if (!isInsideDir(dirReal, real))
      throw new Error(`Файл №${n}: указывает за пределы папки «исходящих»`);

    const realKey = comparable(real);
    const dupReal = seenReal.get(realKey);
    if (dupReal !== undefined) throw new Error(`Файл №${n}: тот же файл, что и №${dupReal}`);
    seenReal.set(realKey, n);

    // На POSIX тип проверяем до open: открытие FIFO без писателя блокируется навсегда. На Windows open
    // устройств отсечён проверкой имён, поведение прежнее.
    if (process.platform !== "win32") {
      let isRegular = false;
      try {
        isRegular = (await fs.promises.stat(real)).isFile();
      } catch {
        throw new Error(`Файл №${n}: не удалось открыть`);
      }
      if (!isRegular) throw new Error(`Файл №${n}: не обычный файл`);
    }

    // Окно между realpath и open (подмена файла) принято: содержимое перепроверяется по sha256 при загрузке.
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(real, "r");
    } catch {
      throw new Error(`Файл №${n}: не удалось открыть`);
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new Error(`Файл №${n}: не обычный файл`);
      if (st.size === 0) throw new Error(`Файл №${n}: пустой (размер 0)`);
      if (opts.maxBytes !== undefined && st.size > opts.maxBytes) {
        throw new Error(`Файл №${n}: размер больше допустимых ${opts.maxBytes} байт`);
      }
      const { sha256, bytes } = await hashFile(handle, st.size);
      if (bytes !== st.size) throw new Error(`Файл №${n}: изменился во время чтения`);
      result.push({ name: path.basename(real), absPath: real, size: st.size, sha256 });
    } catch (err) {
      // Свои отказы уже без имён; ошибки ввода-вывода (с путём в тексте) заменяем.
      if (err instanceof Error && err.message.startsWith(`Файл №${n}:`)) throw err;
      throw new Error(`Файл №${n}: не удалось прочитать`);
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return result;
}
