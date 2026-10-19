import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Ключ и журнал записей — во временном каталоге; задаётся до импорта модулей.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-gating-"));
process.env.HSE_WRITES_DIR = dir;

// `config` при первом импорте подгружает .env владельца, а dotenv не перезаписывает уже заданные
// переменные, поэтому флаг задаётся явно в каждом случае (в том числе пустой — вместо «не задан»).
process.env.HSE_ENABLE_WRITES = "";

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerLmsTools } = await import(new URL("../dist/services/lms/tools.js", import.meta.url).href);

const WRITE_TOOLS = ["lms_submit_assignment", "lms_delete_submission"];
const READ_TOOLS = ["lms_list_courses", "lms_open_page"];

const opened = [];

/** Свой сервер и клиент на каждый случай: флаг читается геттером при регистрации. */
async function connect(flag) {
  if (flag === undefined) delete process.env.HSE_ENABLE_WRITES;
  else process.env.HSE_ENABLE_WRITES = flag;
  const server = new McpServer({ name: "gating-test", version: "0.0.0" });
  registerLmsTools(server);
  const client = new Client({ name: "gating-test-client", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  opened.push(client, server);
  const { tools } = await client.listTools();
  return { client, tools, byName: new Map(tools.map((t) => [t.name, t])) };
}

test.after(async () => {
  for (const x of opened) await x.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [label, flag] of [
  ["не задан", ""],
  ['"false"', "false"],
  ['"1"', "1"],
  ['"yes"', "yes"],
]) {
  test(`флаг ${label}: тулов записи нет, читающие на месте`, async () => {
    const { byName } = await connect(flag);
    for (const name of WRITE_TOOLS) assert.equal(byName.has(name), false, name);
    for (const name of READ_TOOLS) assert.equal(byName.has(name), true, name);
  });
}

test("переменная удалена вовсе: тулов записи нет, читающие на месте", async () => {
  const { byName } = await connect(undefined);
  for (const name of WRITE_TOOLS) assert.equal(byName.has(name), false, name);
  for (const name of READ_TOOLS) assert.equal(byName.has(name), true, name);
});

for (const flag of ["true", " TRUE "]) {
  test(`флаг ${JSON.stringify(flag)}: оба тула записи зарегистрированы`, async () => {
    const { byName } = await connect(flag);
    for (const name of [...WRITE_TOOLS, ...READ_TOOLS]) assert.equal(byName.has(name), true, name);
  });
}

test("тулы записи: аннотации и обязательные поля схемы", async () => {
  const { byName } = await connect("true");
  for (const name of WRITE_TOOLS) {
    const t = byName.get(name);
    assert.equal(t.annotations.readOnlyHint, false, name);
    assert.equal(t.annotations.destructiveHint, true, name);
    assert.equal(t.annotations.idempotentHint, false, name);
    assert.equal(t.annotations.openWorldHint, true, name);
    assert.match(t.description, /confirm/);
    assert.match(t.description, /previewToken/);
    assert.match(t.description, /unknown/);
  }
  const submit = byName.get("lms_submit_assignment").inputSchema;
  assert.ok(submit.required.includes("cmid"));
  assert.ok(submit.required.includes("files"));
  assert.ok(!submit.required.includes("confirm"));
  assert.ok(!submit.required.includes("text"));
  assert.deepEqual(byName.get("lms_delete_submission").inputSchema.required, ["cmid"]);
});

test("вызов без files — ошибка валидации", async () => {
  const { client } = await connect("true");
  let result;
  try {
    result = await client.callTool({ name: "lms_submit_assignment", arguments: { cmid: 1 } });
  } catch (err) {
    assert.ok(err instanceof Error);
    return;
  }
  assert.equal(result.isError, true);
});

test("text: отказ про онлайн-текст до любой навигации (сухой прогон и запись)", async () => {
  const { client } = await connect("true");
  const started = Date.now();
  for (const extra of [{}, { confirm: true, previewToken: "1.abc" }]) {
    const result = await client.callTool({
      name: "lms_submit_assignment",
      arguments: { cmid: 1, files: ["a.txt"], text: "x", ...extra },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /онлайн-текст/);
  }
  // Браузер не запускался бы быстрее нескольких секунд: отказ случился до observe.
  assert.ok(Date.now() - started < 3000, "отказ должен быть мгновенным, без запуска браузера");
});
