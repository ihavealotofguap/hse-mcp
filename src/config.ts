import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Ищем .env рядом с проектом, а не в process.cwd() — иначе при запуске сервера
// сторонним хостом (Claude Desktop и т.п.) с произвольной рабочей директорией
// файл просто не найдётся.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    return process.env.HSE_MAIL_APP_PASSWORD || required("HSE_PASSWORD");
  },
  get browserHeadless(): boolean {
    return process.env.HSE_BROWSER_HEADLESS !== "false";
  },
};
