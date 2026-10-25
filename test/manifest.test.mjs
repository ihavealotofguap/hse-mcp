// manifest.json пакета Claude Desktop (.mcpb) и server.json реестра MCP: согласованность с package.json
// и тулами сервера, безопасные значения по умолчанию.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const manifest = read("manifest.json");
const pkg = read("package.json");
const serverJson = read("server.json");
// Подстановка хоста `${…}` (собрана из частей, чтобы не путать с шаблонной строкой JS).
const ph = (name) => `$${"{"}${name}}`;

process.env.HSE_ENABLE_WRITES = "";
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

/** Имена тулов полного сервера (как в src/index.ts) с выключенной записью. */
async function readToolNames() {
  const server = new McpServer({ name: "manifest-test", version: "0.0.0" });
  for (const svc of ["lms", "elk", "system", "digest", "changes"]) {
    const mod = await import(new URL(`../dist/services/${svc}/tools.js`, import.meta.url).href);
    for (const [name, register] of Object.entries(mod)) {
      if (name.startsWith("register")) register(server);
    }
  }
  const client = new Client({ name: "manifest-test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name);
}

test("версия одна в package.json, manifest.json и server.json", () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(serverJson.version, pkg.version);
  assert.equal(serverJson.packages[0].version, pkg.version);
  assert.equal(serverJson.name, pkg.mcpName);
  assert.equal(serverJson.packages[0].identifier, pkg.name);
});

test("сервер запускается из dist/index.js пакета, пароль — только через env", () => {
  const { server } = manifest;
  assert.equal(server.type, "node");
  assert.equal(server.entry_point, "dist/index.js");
  assert.equal(pkg.bin["hse-mcp"], server.entry_point);
  assert.deepEqual(server.mcp_config.args, [`${ph("__dirname")}/dist/index.js`]);
  assert.equal(server.mcp_config.env.HSE_PASSWORD, ph("user_config.password"));
  assert.equal(server.mcp_config.env.HSE_EMAIL, ph("user_config.email"));
  assert.ok(!server.mcp_config.args.some((a) => a.includes("user_config")));
});

test("пароль скрыт и обязателен, запись выключена по умолчанию", () => {
  const { user_config: cfg, server } = manifest;
  assert.equal(cfg.password.sensitive, true);
  assert.equal(cfg.password.required, true);
  assert.equal(cfg.email.required, true);
  assert.equal(cfg.enable_writes.type, "boolean");
  assert.equal(cfg.enable_writes.default, false);
  assert.equal(server.mcp_config.env.HSE_ENABLE_WRITES, ph("user_config.enable_writes"));
  // Без хранилища паролей: пакет собирается без @napi-rs/keyring, пароль приходит из настроек.
  assert.equal(server.mcp_config.env.HSE_DISABLE_KEYCHAIN, "true");
});

test("каждая подстановка user_config.* ссылается на описанное поле", () => {
  const text = JSON.stringify(manifest.server.mcp_config);
  const used = [...text.matchAll(/\$\{user_config\.([^}]+)\}/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const key of used) assert.ok(key in manifest.user_config, key);
  // Необязательное поле без значения по умолчанию хост передал бы строкой «${user_config.…}».
  for (const [key, opt] of Object.entries(manifest.user_config)) {
    assert.ok(opt.required || opt.default !== undefined, `${key}: нет ни required, ни default`);
  }
});

test("список тулов в манифесте совпадает с тулами сервера без записи", async () => {
  const names = await readToolNames();
  assert.deepEqual(
    manifest.tools.map((t) => t.name),
    names
  );
  for (const write of ["lms_submit_assignment", "lms_delete_submission", "elk_order_certificate"]) {
    assert.ok(!names.includes(write), write);
  }
});

test("npm-пакет содержит только dist", () => {
  assert.deepEqual(pkg.files, ["dist"]);
  assert.equal(pkg.private, undefined);
  const entry = fs.readFileSync(path.join(root, "dist", "index.js"), "utf8");
  assert.ok(entry.startsWith("#!/usr/bin/env node\n"), "нет shebang у исполняемого файла");
});
