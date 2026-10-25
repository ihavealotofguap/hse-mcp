import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const IO_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const LOCK_STALE_MS = 30_000;
const LOCK_DEFAULT_WAIT_MS = 10_000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const errCode = (err: unknown): string | undefined =>
  (err as NodeJS.ErrnoException | undefined)?.code;
/** Файл занят антивирусом/индексатором/другим процессом (Windows) — повторить, а не считать повреждением. */
export const isBusy = (code: string | undefined): boolean =>
  code === "EPERM" || code === "EACCES" || code === "EBUSY";

export async function retryIo<T>(op: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (!isBusy(errCode(err)) || attempt >= IO_RETRY_DELAYS_MS.length) throw err;
      await sleep(IO_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Атомарная запись: во временный файл `<file>.<pid>.tmp` и `rename` поверх (с повторами при занятом
 * файле). При ошибке временный файл удаляется, ошибка пробрасывается.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // 0o600 на Windows не защита (права не применяются), оставлено для POSIX.
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    await retryIo(() => fs.renameSync(tmp, file));
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp мог не создаться */
    }
    throw err;
  }
}

/** Хвосты внутрипроцессных мьютексов по пути lock-файла. */
const mutexTails = new Map<string, Promise<unknown>>();

/**
 * Внутрипроцессный мьютекс на путь + lock-файл `wx` на цикл «прочитать → пересчитать → записать».
 * Сбор данных идёт вне блокировки. Устаревшая (> 30 с) блокировка снимается, чужая — нет.
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {}
): Promise<T> {
  const waitMs = opts.waitMs ?? LOCK_DEFAULT_WAIT_MS;
  const key = path.resolve(lockPath);
  const tail = mutexTails.get(key) ?? Promise.resolve();
  const run = tail.then(
    () => lockedRun(lockPath, fn, waitMs),
    () => lockedRun(lockPath, fn, waitMs)
  );
  const next = run.then(
    () => undefined,
    () => undefined
  );
  mutexTails.set(key, next);
  // Очередь опустела — запись по пути не копится.
  void next.then(() => {
    if (mutexTails.get(key) === next) mutexTails.delete(key);
  });
  return run;
}

async function lockedRun<T>(lock: string, fn: () => Promise<T>, waitMs: number): Promise<T> {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  // Метка владельца: чужую (перехваченную как устаревшую) блокировку при выходе не снимаем.
  const token = `${process.pid} ${Date.now()} ${crypto.randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  const subject = path.basename(lock).replace(/\.lock$/, "");
  const timeout = (): Error =>
    new Error(
      `${subject} занят другим процессом: блокировка не освободилась за ${waitMs / 1000} с`
    );
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch (err) {
      const code = errCode(err);
      if (code !== "EEXIST" && !isBusy(code)) throw err;
      let retrySoon = false;
      try {
        // Содержимое читается до stat и сверяется перед снятием: свежий чужой lock, появившийся
        // между проверкой и unlink, не снимаем.
        const content = fs.readFileSync(lock, "utf8");
        const mtime = fs.statSync(lock).mtimeMs;
        if (Date.now() - mtime > LOCK_STALE_MS) {
          if (fs.readFileSync(lock, "utf8") === content && fs.statSync(lock).mtimeMs === mtime)
            fs.unlinkSync(lock);
          retrySoon = true;
        }
      } catch (inner) {
        // Блокировка исчезла между проверками — пробуем снова; иная ошибка (занят файл) — ждём как обычно.
        if (errCode(inner) === "ENOENT") retrySoon = true;
      }
      if (Date.now() > deadline) throw timeout();
      await sleep(
        retrySoon ? 10 + Math.floor(Math.random() * 10) : 50 + Math.floor(Math.random() * 100)
      );
    }
  }
  let tokenWritten = false;
  try {
    try {
      fs.writeSync(fd, token);
      tokenWritten = true;
    } catch {
      /* содержимое блокировки справочное */
    }
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* уже закрыт */
    }
    try {
      // Токен не записан — lock точно наш; иначе чужой (перехваченный) не снимаем. Повторы при EBUSY.
      await retryIo(() => {
        if (!tokenWritten || fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
      });
    } catch {
      /* уже снята или перехвачена */
    }
  }
}
