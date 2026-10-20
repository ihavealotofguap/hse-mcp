import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
  DOTENV_PASSWORD_WARNING,
  dotenvPermissionWarning,
  lookupPassword,
  type KeyStore,
} from "../credentials.js";

/** Всё, что нужно командам; внедряется, чтобы проверять без настоящего хранилища и терминала. */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  dotenv: Record<string, string>;
  /** Путь к `.env` для проверки прав; `null` — не проверять. */
  dotenvFile: string | null;
  store: KeyStore | null;
  /** `HSE_EMAIL` из окружения или `.env`; `null` — спросить (для `set`). */
  email: string | null;
  readSecret(prompt: string): Promise<string>;
  readLine(prompt: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = "Использование: npm run credentials:set | credentials:clear | credentials:status";

// Сообщения об ошибках хранилища нарочно не выводим: в них могут оказаться учётная запись или значение.
async function setPassword(deps: CliDeps): Promise<number> {
  if (!deps.store) {
    deps.err("системное хранилище недоступно (пакет не установлен или служба не отвечает); пароль можно задать в .env");
    return 1;
  }
  const email = (deps.email ?? (await deps.readLine("Email (логин ВШЭ): "))).trim();
  if (!email) {
    deps.err("email не указан");
    return 1;
  }
  const password = await deps.readSecret("Пароль (ввод не отображается): ");
  if (!password) {
    deps.err("пустой пароль не сохраняется");
    return 1;
  }
  try {
    deps.store.setPassword(email, password);
    // Читаем обратно: на части систем запись «проходит», но не сохраняется.
    if (deps.store.getPassword(email) !== password) {
      deps.err("хранилище не вернуло сохранённое значение; пароль не сохранён");
      return 1;
    }
  } catch {
    deps.err("не удалось записать в системное хранилище");
    return 1;
  }
  deps.out("пароль сохранён в системное хранилище");
  return 0;
}

async function clearPassword(deps: CliDeps): Promise<number> {
  if (!deps.store) {
    deps.err("системное хранилище недоступно");
    return 1;
  }
  const email = (deps.email ?? (await deps.readLine("Email (логин ВШЭ): "))).trim();
  if (!email) {
    deps.err("email не указан");
    return 1;
  }
  try {
    deps.out(deps.store.deletePassword(email) ? "запись удалена из системного хранилища" : "записи в системном хранилище не было");
    return 0;
  } catch {
    deps.err("не удалось удалить запись из системного хранилища");
    return 1;
  }
}

/** Только источник пароля (`env`/`keychain`/`dotenv`/`none`); ни значений, ни email. */
function status(deps: CliDeps): number {
  const { source } = lookupPassword({ env: deps.env, dotenv: deps.dotenv, account: deps.email ?? "", store: deps.store });
  deps.out(`источник пароля: ${source}`);
  if (source === "dotenv") {
    deps.err(DOTENV_PASSWORD_WARNING);
    const perm = deps.dotenvFile ? dotenvPermissionWarning(deps.dotenvFile) : null;
    if (perm) deps.err(perm);
  }
  return 0;
}

/** Выполняет подкоманду, возвращает код выхода. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  switch (argv[0]) {
    case "set":
      return setPassword(deps);
    case "clear":
      return clearPassword(deps);
    case "status":
      return status(deps);
    default:
      deps.err(USAGE);
      return 2;
  }
}

/** Построчное чтение: один интерфейс на поток, чтобы пришедшие одним куском строки не терялись. */
export interface LineReader {
  readLine(prompt: string): Promise<string>;
  close(): void;
}

/** Читает строки из `input`; конец потока (с последней строкой без перевода строки или без неё) — пустая строка. */
export function createLineReader(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineReader {
  const rl = readline.createInterface({ input, terminal: false });
  const buffered: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiting.splice(0)) waiter("");
  });
  return {
    readLine(prompt) {
      output.write(prompt);
      const line = buffered.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.resolve("");
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

/**
 * Ввод без эха: на терминале посимвольно в raw-режиме; иначе (канал, перенаправление) — строка из
 * `reader`, и об этом предупреждаем: оболочка или источник могут показать или сохранить введённое.
 */
export function readSecretFrom(
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown },
  output: NodeJS.WritableStream,
  reader: LineReader,
  prompt: string
): Promise<string> {
  if (!input.isTTY || !input.setRawMode) {
    output.write("ввод идёт не из терминала: введённое может быть видно\n");
    return reader.readLine(prompt);
  }
  const setRaw = input.setRawMode.bind(input);
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let value = "";
    const finish = (fn: () => void): void => {
      setRaw(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      fn();
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(() => resolve(value));
        if (ch === "\u0003") return finish(() => reject(new Error("прервано")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    setRaw(true);
    input.resume();
    input.on("data", onData);
  });
}

/**
 * Ввод для команд. Не терминал: один читатель на весь процесс, создаётся лениво при первом чтении
 * (строки приходят одним куском). Терминал: читатель на каждый вопрос, закрывается сразу, а пароль
 * читается посимвольно без readline, чтобы постоянный читатель не копил его в буфере.
 */
export function createStdinIo(
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown },
  output: NodeJS.WritableStream
): { readLine(prompt: string): Promise<string>; readSecret(prompt: string): Promise<string> } {
  let shared: LineReader | null = null;
  const lazyShared: LineReader = {
    readLine: (prompt) => (shared ??= createLineReader(input, output)).readLine(prompt),
    close: () => shared?.close(),
  };
  return {
    async readLine(prompt) {
      if (!input.isTTY) return lazyShared.readLine(prompt);
      const reader = createLineReader(input, output);
      try {
        return await reader.readLine(prompt);
      } finally {
        reader.close();
      }
    },
    readSecret: (prompt) => readSecretFrom(input, output, lazyShared, prompt),
  };
}

async function main(): Promise<void> {
  // Конфигурация подключается здесь, а не в начале файла: проверкам нужен только `runCli`.
  const { credentialInputs, optionalEmail } = await import("../config.js");
  const io = createStdinIo(process.stdin, process.stderr);
  const code = await runCli(process.argv.slice(2), {
    env: credentialInputs.env,
    dotenv: credentialInputs.dotenv,
    dotenvFile: credentialInputs.dotenvFile,
    store: credentialInputs.keyStore,
    email: optionalEmail(),
    readSecret: io.readSecret,
    readLine: io.readLine,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("команда завершилась ошибкой");
    process.exit(1);
  });
}
