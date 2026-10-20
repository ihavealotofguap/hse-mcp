import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Файл-секрет читает только владелец. POSIX: `chmod 0o600`. Windows: `icacls` снимает унаследованные
 * права и оставляет полный доступ текущему пользователю. Best-effort: любая ошибка (чужой файл,
 * нестандартный профиль, нет `icacls`) глотается молча, без вывода путей.
 */
export function restrictFile(path: string): void {
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME;
      if (!user || !fs.existsSync(path)) return;
      // Сначала выдаём право, потом снимаем наследование: при сбое выдачи файл остаётся доступен.
      execFileSync("icacls", [path, "/grant:r", `${user}:(F)`, "/inheritance:r"], { stdio: "ignore", windowsHide: true });
    } else {
      fs.chmodSync(path, 0o600);
    }
  } catch {
    /* права не критичны для работы; путь в сообщение не выносим */
  }
}
