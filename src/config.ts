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
  get browserHeadless(): boolean {
    return process.env.HSE_BROWSER_HEADLESS !== "false";
  },
};
