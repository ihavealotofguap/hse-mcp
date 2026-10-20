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

/** Ввод строки; на неинтерактивном stdin читает одну строку (для сценариев). */
function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
    rl.once("close", () => resolve(""));
  });
}

/** Ввод без эха: на терминале посимвольно в raw-режиме, иначе — строка из stdin. */
function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLine(prompt);
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let value = "";
    const finish = (fn: () => void): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
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
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  // Конфигурация подключается здесь, а не в начале файла: проверкам нужен только `runCli`.
  const { credentialInputs, optionalEmail } = await import("../config.js");
  const code = await runCli(process.argv.slice(2), {
    env: credentialInputs.env,
    dotenv: credentialInputs.dotenv,
    dotenvFile: credentialInputs.dotenvFile,
    store: credentialInputs.keyStore,
    email: optionalEmail(),
    readSecret,
    readLine,
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
