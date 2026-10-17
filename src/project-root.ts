import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Корень проекта — на уровень выше `dist/` (и `src/` при запуске из исходников). Считается от
 * расположения самого файла, а не `process.cwd()`: хосты вроде Claude Desktop запускают stdio-сервер
 * с произвольным (иногда непишущим, напр. C:\WINDOWS\system32) рабочим каталогом.
 */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
