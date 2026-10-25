import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Как в tools-gating: ключ записей во временном каталоге, браузер не запускается.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hse-mcp-elk-section-"));
process.env.HSE_WRITES_DIR = dir;
process.env.HSE_ENABLE_WRITES = "";
// Логин нужен разделам на API ЕЛК (имя пользователя в запросе); пароль до запуска браузера не читается.
process.env.HSE_EMAIL = "student@edu.hse.ru";
const realConsoleError = console.error;
console.error = () => {};

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { chromium } = await import("playwright");
const realLaunch = chromium.launch;
let launches = 0;
chromium.launch = async () => {
  launches++;
  throw new Error("запуск браузера отключён в тесте");
};
const { registerElkTools } = await import(
  new URL("../dist/services/elk/tools.js", import.meta.url).href
);
const { ELK_SECTIONS } = await import(
  new URL("../dist/services/elk/client.js", import.meta.url).href
);

const server = new McpServer({ name: "elk-section-test", version: "0.0.0" });
registerElkTools(server);
const client = new Client({ name: "elk-section-test-client", version: "0.0.0" });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
const { tools } = await client.listTools();
const byName = new Map(tools.map((t) => [t.name, t]));

test.after(async () => {
  chromium.launch = realLaunch;
  console.error = realConsoleError;
  await client.close();
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const MERGED = [
  "elk_get_profile",
  "elk_get_login_history",
  "elk_list_tasks",
  "elk_list_dpo_programs",
  "elk_get_antiplagiat_status",
  "elk_get_course_evaluation_status",
  "elk_get_thesis_status",
  "elk_get_portfolio",
  "elk_list_internships",
  "elk_get_scholarship_history",
];

test("elk_get_section заменяет десять тулов разделов", () => {
  assert.ok(byName.has("elk_get_section"));
  for (const name of MERGED) assert.equal(byName.has(name), false, name);
  assert.equal(tools.length, 8, tools.map((t) => t.name).join(", "));
});

test("elk_get_section: перечень разделов в схеме и описании совпадает с ELK_SECTIONS", () => {
  const t = byName.get("elk_get_section");
  assert.deepEqual(t.inputSchema.properties.section.enum, [...ELK_SECTIONS]);
  assert.deepEqual(t.inputSchema.required, ["section"]);
  for (const section of ELK_SECTIONS) assert.match(t.description, new RegExp(`\\b${section}\\b`));
});

test("elk_get_section: неизвестный раздел — ошибка валидации до запуска браузера", async () => {
  const before = launches;
  const res = await client.callTool({ name: "elk_get_section", arguments: { section: "grades" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /section/);
  assert.equal(launches, before);
});

test("elk_get_section: limit и offset проверяются схемой", async () => {
  for (const args of [
    { section: "tasks", limit: 0 },
    { section: "tasks", limit: 501 },
    { section: "login_history", offset: -1 },
  ]) {
    const res = await client.callTool({ name: "elk_get_section", arguments: args });
    assert.equal(res.isError, true, JSON.stringify(args));
  }
});

test("elk_get_section: каждый раздел доходит до ЕЛК (запуска браузера)", async () => {
  for (const section of ELK_SECTIONS) {
    const before = launches;
    const res = await client.callTool({ name: "elk_get_section", arguments: { section } });
    assert.equal(res.isError, true, section);
    assert.ok(launches > before, `${section}: браузер не запускался: ${res.content[0].text}`);
  }
});
