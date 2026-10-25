// Сборка пакета Claude Desktop: build/hsemcp-<версия>.mcpb. Перед запуском — npm run build.
// В пакет идут manifest.json, dist/ и production-зависимости без необязательных: пароль приходит из
// настроек расширения, системное хранилище (@napi-rs/keyring, платформенный бинарник) там не нужно.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = path.resolve(import.meta.dirname, "..");
const stage = path.join(root, "build", "mcpb");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const { version } = read("package.json");
if (read("manifest.json").version !== version) {
  throw new Error(`версия manifest.json не совпадает с package.json (${version})`);
}
if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  throw new Error("нет dist/index.js: сначала npm run build");
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const file of ["manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
  fs.copyFileSync(path.join(root, file), path.join(stage, file));
}
fs.cpSync(path.join(root, "dist"), path.join(stage, "dist"), { recursive: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";
execFileSync(
  npm,
  ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: stage, stdio: "inherit", shell }
);

// Ничего лишнего: ни учётных данных и сессий, ни хранилища паролей.
for (const forbidden of [".env", "storage", path.join("node_modules", "@napi-rs", "keyring")]) {
  if (fs.existsSync(path.join(stage, forbidden))) {
    throw new Error(`в пакет попал ${forbidden}`);
  }
}

const out = path.join(root, "build", `hsemcp-${version}.mcpb`);
fs.rmSync(out, { force: true });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npx, ["--yes", MCPB_CLI, "pack", stage, out], { stdio: "inherit", shell });
console.log(out);
