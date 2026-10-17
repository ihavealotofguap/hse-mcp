import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { projectRoot } from "./project-root.js";

// Ищем .env рядом с проектом, а не в process.cwd() — иначе при запуске сервера
// сторонним хостом (Claude Desktop и т.п.) с произвольной рабочей директорией
// файл просто не найдётся.
loadDotenv({ path: path.join(projectRoot, ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  get hseEmail(): string {
    return required("HSE_EMAIL");
  },
  get hsePassword(): string {
    return required("HSE_PASSWORD");
  },
  get mailAppPassword(): string {
    const value = process.env.HSE_MAIL_APP_PASSWORD;
    if (!value) {
      throw new Error(
        "Missing required environment variable HSE_MAIL_APP_PASSWORD. Почтовые тулы требуют " +
          "отдельный пароль приложения Яндекс 360 (генерируется в настройках безопасности Яндекс " +
          "ID) — использовать HSE_PASSWORD (пароль единого SSO ВШЭ) нельзя: он ушёл бы по IMAP/SMTP " +
          "на серверы Яндекса. Copy .env.example to .env and fill it in."
      );
    }
    return value;
  },
  get browserHeadless(): boolean {
    return process.env.HSE_BROWSER_HEADLESS !== "false";
  },
};
