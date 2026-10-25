import { runChromiumInstall } from "../auth/browser-launch.js";

const USAGE = [
  "hsemcp — MCP-сервер SmartLMS и ЕЛК ВШЭ (stdio). Без аргументов запускает сервер.",
  "",
  "Команды:",
  "  hsemcp credentials set | clear | status   пароль ВШЭ в системном хранилище",
  "  hsemcp install-browser                    скачать Chromium для Playwright",
].join("\n");

/** Подкоманды исполняемого файла; `null` — аргументов нет, нужно запускать сервер. */
export async function runCommand(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      return null;
    case "credentials": {
      const { credentialsCommand } = await import("./credentials.js");
      return credentialsCommand(rest);
    }
    case "install-browser":
      // Полный Chromium: он нужен и для HSE_BROWSER_HEADLESS=false; Playwright ставит вместе с ним и
      // Headless Shell.
      if (await runChromiumInstall("inherit", false)) return 0;
      console.error("не удалось скачать Chromium");
      return 1;
    case "help":
    case "--help":
    case "-h":
      console.error(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}
