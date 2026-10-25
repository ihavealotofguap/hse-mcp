import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./project-root.js";

/**
 * Каталог данных (сессия браузера, ключ и журнал записей, снимки, «исходящие» по умолчанию):
 * 1. `HSE_DATA_DIR` — абсолютный путь или относительно корня проекта;
 * 2. клон репозитория (есть `.git`) или установка, где `storage/` уже есть, — `storage/` в корне проекта,
 *    как раньше;
 * 3. иначе (пакет `.mcpb`, npx) — каталог пользователя: папку установки хост может пересоздать при
 *    обновлении, и вместе с ней пропали бы журнал записей и сессия.
 */
export function resolveDataDir(args: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  root: string;
  home: string;
  exists: (p: string) => boolean;
}): string {
  const override = args.env.HSE_DATA_DIR?.trim();
  if (override) return path.resolve(args.root, override);
  const local = path.join(args.root, "storage");
  if (args.exists(path.join(args.root, ".git")) || args.exists(local)) return local;
  switch (args.platform) {
    case "win32":
      return path.join(
        args.env.LOCALAPPDATA || path.join(args.home, "AppData", "Local"),
        "hse-mcp"
      );
    case "darwin":
      return path.join(args.home, "Library", "Application Support", "hse-mcp");
    default:
      return path.join(
        args.env.XDG_DATA_HOME || path.join(args.home, ".local", "share"),
        "hse-mcp"
      );
  }
}

/**
 * Каталог данных этого процесса. Функция, а не константа: `HSE_DATA_DIR` может прийти из `.env`, который
 * `config.ts` применяет при своём импорте, а он может идти позже импорта этого модуля.
 */
export function dataDir(): string {
  return resolveDataDir({
    env: process.env,
    platform: process.platform,
    root: projectRoot,
    home: os.homedir(),
    exists: fs.existsSync,
  });
}
