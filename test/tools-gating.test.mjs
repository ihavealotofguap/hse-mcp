import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ключ и журнал записей — во временном каталоге; задаётся до импорта модулей.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-gating-"));
process.env.HSE_WRITES_DIR = dir;

// Перехват stderr: уведомление «тулы записи выключены» печатается один раз на экземпляр модуля.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => {
  stderrLines.push(args.join(" "));
};
const writesOffNotices = () => stderrLines.filter((l) => /тулы записи выключены/.test(l));

// `config` при первом импорте подгружает .env владельца, а dotenv не перезаписывает уже заданные
// переменные, поэтому флаг задаётся явно в каждом случае (в том числе пустой — вместо «не задан»).
process.env.HSE_ENABLE_WRITES = "";

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
// Шпион на запуск браузера: общий объект `chromium` из playwright тот же, что использует dist/auth/browser-session.
// Любой запуск считается и отклоняется — настоящий Chromium в тестах не стартует.
const { chromium } = await import("playwright");
const realLaunch = chromium.launch;
let launches = 0;
chromium.launch = async () => {
  launches++;
  throw new Error("запуск браузера отключён в тесте");
};
const { registerLmsTools } = await import(new URL("../dist/services/lms/tools.js", import.meta.url).href);
const { registerElkTools } = await import(new URL("../dist/services/elk/tools.js", import.meta.url).href);

const WRITE_TOOLS = ["lms_submit_assignment", "lms_delete_submission"];
const READ_TOOLS = ["lms_list_courses", "lms_open_page"];
const ELK_WRITE_TOOL = "elk_order_certificate";
const ELK_READ_TOOLS = ["elk_list_requests", "elk_open_page"];

const opened = [];

/** Свой сервер и клиент на каждый случай: флаг читается геттером при регистрации. */
async function connect(flag, register = registerLmsTools) {
  if (flag === undefined) delete process.env.HSE_ENABLE_WRITES;
  else process.env.HSE_ENABLE_WRITES = flag;
  const server = new McpServer({ name: "gating-test", version: "0.0.0" });
  register(server);
  const client = new Client({ name: "gating-test-client", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  opened.push(client, server);
  const { tools } = await client.listTools();
  return { client, tools, byName: new Map(tools.map((t) => [t.name, t])) };
}

test.after(async () => {
  chromium.launch = realLaunch;
  console.error = realConsoleError;
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
    assert.match(err.message, /files/);
    return;
  }
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /files/);
});

test("схема lms_submit_assignment: mode по умолчанию draft; files 1..10, элементы 1..255", async () => {
  const { byName } = await connect("true");
  const { properties } = byName.get("lms_submit_assignment").inputSchema;
  assert.equal(properties.mode.default, "draft");
  assert.deepEqual(properties.mode.enum, ["draft", "submit"]);
  assert.equal(properties.files.type, "array");
  assert.equal(properties.files.minItems, 1);
  assert.equal(properties.files.maxItems, 10);
  assert.equal(properties.files.items.type, "string");
  assert.equal(properties.files.items.minLength, 1);
  assert.equal(properties.files.items.maxLength, 255);
});

test("границы files проверяются валидацией: 0 и 11 файлов, пустое и 256-символьное имя — отказ по files", async () => {
  const { client } = await connect("true");
  const bad = [[], Array.from({ length: 11 }, (_, i) => `f${i}.txt`), [""], ["x".repeat(256)]];
  for (const files of bad) {
    let text;
    try {
      const result = await client.callTool({ name: "lms_submit_assignment", arguments: { cmid: 1, files } });
      assert.equal(result.isError, true);
      text = result.content[0].text;
    } catch (err) {
      text = err.message;
    }
    assert.match(text, /files/);
  }
});

test("text: отказ про онлайн-текст до любой навигации (сухой прогон и запись)", async () => {
  const { client } = await connect("true");
  const launchesBefore = launches;
  for (const extra of [{}, { confirm: true, previewToken: "1.abc" }]) {
    const result = await client.callTool({
      name: "lms_submit_assignment",
      arguments: { cmid: 1, files: ["a.txt"], text: "x", ...extra },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /онлайн-текст/);
  }
  // Детерминированно: отказ случился до observe, браузер не запускался ни разу.
  assert.equal(launches, launchesBefore, "отказ про текст не должен запускать браузер");
});

test("контроль шпиона: настоящее открытие страницы доходит до запуска браузера", async () => {
  const { client } = await connect("true");
  const before = launches;
  const result = await client.callTool({ name: "lms_open_page", arguments: { path: "/" } });
  assert.equal(result.isError, true);
  assert.equal(launches, before + 1, "шпион на chromium.launch не сработал — проверка выше ничего не доказывает");
});

test("уведомление «тулы записи выключены» печатается ровно один раз на процесс", async () => {
  // Тесты файла идут по порядку объявления: первый же случай выше (флаг пуст) регистрировал выключенный
  // режим, значит к этому моменту уведомление уже напечатано — ровно одно; флаг модульный.
  const total = writesOffNotices().length;
  assert.equal(total, 1, `уведомлений: ${total}`);
  for (const flag of ["", "false", undefined]) await connect(flag);
  assert.equal(writesOffNotices().length, total, "повторные регистрации не печатают уведомление снова");
  await connect("true");
  assert.equal(writesOffNotices().length, total);
  for (const line of writesOffNotices()) assert.equal(line, "hsemcp: тулы записи выключены (HSE_ENABLE_WRITES не задан)");
});

test("уведомление «тулы записи выключены»: свежий процесс, две регистрации с выключенным флагом — ровно одна строка", () => {
  const script = `
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerLmsTools } = await import(process.env.HSEMCP_TEST_TOOLS_URL);
    for (let i = 0; i < 2; i++) registerLmsTools(new McpServer({ name: "child", version: "0.0.0" }));
  `;
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-gating-child-"));
  try {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), // отсюда разрешается @modelcontextprotocol/sdk
      env: {
        ...process.env,
        HSE_ENABLE_WRITES: "",
        HSE_WRITES_DIR: childDir,
        HSEMCP_TEST_TOOLS_URL: new URL("../dist/services/lms/tools.js", import.meta.url).href,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 0, `дочерний процесс: ${res.stderr}`);
    const notices = res.stderr.split(/\r?\n/).filter((l) => /тулы записи выключены/.test(l));
    assert.deepEqual(notices, ["hsemcp: тулы записи выключены (HSE_ENABLE_WRITES не задан)"]);
  } finally {
    fs.rmSync(childDir, { recursive: true, force: true });
  }
});

// --- ЕЛК: заказ справки (спека №4 §10) ---

for (const flag of ["", "false", undefined]) {
  test(`ЕЛК, флаг ${JSON.stringify(flag)}: elk_order_certificate нет, читающие на месте`, async () => {
    const { byName } = await connect(flag, registerElkTools);
    assert.equal(byName.has(ELK_WRITE_TOOL), false);
    for (const name of ELK_READ_TOOLS) assert.equal(byName.has(name), true, name);
  });
}

test("ЕЛК, флаг true: elk_order_certificate зарегистрирован, читающие на месте", async () => {
  const { byName } = await connect("true", registerElkTools);
  for (const name of [ELK_WRITE_TOOL, ...ELK_READ_TOOLS]) assert.equal(byName.has(name), true, name);
});

test("elk_order_certificate: аннотации, описание и схема", async () => {
  const { byName } = await connect("true", registerElkTools);
  const t = byName.get(ELK_WRITE_TOOL);
  assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.match(t.description, /confirm/);
  assert.match(t.description, /previewToken/);
  assert.match(t.description, /unknown/);
  assert.match(t.description, /необратим/i);
  assert.match(t.description, /elk_list_requests/);
  const { properties, required } = t.inputSchema;
  assert.deepEqual([...required].sort(), ["fields", "serviceId"]);
  assert.equal(properties.serviceId.type, "integer");
  assert.ok(properties.serviceId.exclusiveMinimum === 0 || properties.serviceId.minimum >= 1, "serviceId должен быть положительным");
  assert.equal(properties.fields.type, "object");
  assert.equal(properties.fields.additionalProperties.type, "string");
  for (const name of ["confirm", "previewToken", "acknowledgeUnknown"]) assert.ok(properties[name], name);
});

test("elk_order_certificate: нет serviceId, нецелый и неположительный serviceId — ошибка валидации по serviceId", async () => {
  const { client } = await connect("true", registerElkTools);
  const launchesBefore = launches;
  for (const args of [{ fields: {} }, { serviceId: 1.5, fields: {} }, { serviceId: 0, fields: {} }, { serviceId: -3, fields: {} }, { serviceId: "7", fields: {} }]) {
    let text;
    try {
      const result = await client.callTool({ name: ELK_WRITE_TOOL, arguments: args });
      assert.equal(result.isError, true);
      text = result.content[0].text;
    } catch (err) {
      text = err.message;
    }
    assert.match(text, /serviceId/);
  }
  assert.equal(launches, launchesBefore, "валидация не должна запускать браузер");
});

test("elk_order_certificate: нет fields и нестроковое значение в fields — ошибка валидации по fields", async () => {
  const { client } = await connect("true", registerElkTools);
  const launchesBefore = launches;
  for (const args of [{ serviceId: 1 }, { serviceId: 1, fields: { a: 1 } }, { serviceId: 1, fields: [] }]) {
    let text;
    try {
      const result = await client.callTool({ name: ELK_WRITE_TOOL, arguments: args });
      assert.equal(result.isError, true);
      text = result.content[0].text;
    } catch (err) {
      text = err.message;
    }
    assert.match(text, /fields/);
  }
  assert.equal(launches, launchesBefore, "валидация не должна запускать браузер");
});

test("elk_order_certificate: отказы адаптера по аргументам приходят до запуска браузера", async () => {
  const { client } = await connect("true", registerElkTools);
  const launchesBefore = launches;
  const bad = [
    [{ serviceId: 1, fields: { "": "x" } }, /подпись пуста/],
    [{ serviceId: 1, fields: { "Тип справки": "   " } }, /значение должно быть непустой строкой/],
    [{ serviceId: 1, fields: { "Тип": "a", "Тип:": "b" } }, /повторяется/],
  ];
  for (const extra of [{}, { confirm: true, previewToken: "1.abc" }]) {
    for (const [args, re] of bad) {
      const result = await client.callTool({ name: ELK_WRITE_TOOL, arguments: { ...args, ...extra } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, re);
    }
  }
  assert.equal(launches, launchesBefore, "отказ по аргументам не должен запускать браузер");
});

test("elk_order_certificate: пустой fields — допустимый сухой прогон (разведка формы), доходит до открытия формы", async () => {
  // Пустой fields не отказывается заранее: сухой прогон с ним показывает поля формы и варианты.
  // Отказ «не заданы обязательные поля» выносит планировщик после чтения формы, а не тул.
  const { client } = await connect("true", registerElkTools);
  const before = launches;
  const result = await client.callTool({ name: ELK_WRITE_TOOL, arguments: { serviceId: 1, fields: {} } });
  assert.equal(result.isError, true);
  assert.equal(launches, before + 1, "форма должна открываться: запуск браузера отклонён шпионом");
});

test("уведомление «тулы записи выключены»: LMS и ЕЛК в одном процессе — ровно одна строка", () => {
  const script = `
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerLmsTools } = await import(process.env.HSEMCP_TEST_LMS_URL);
    const { registerElkTools } = await import(process.env.HSEMCP_TEST_ELK_URL);
    for (let i = 0; i < 2; i++) {
      registerLmsTools(new McpServer({ name: "child", version: "0.0.0" }));
      registerElkTools(new McpServer({ name: "child", version: "0.0.0" }));
    }
  `;
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-gating-child-"));
  try {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        HSE_ENABLE_WRITES: "",
        HSE_WRITES_DIR: childDir,
        HSEMCP_TEST_LMS_URL: new URL("../dist/services/lms/tools.js", import.meta.url).href,
        HSEMCP_TEST_ELK_URL: new URL("../dist/services/elk/tools.js", import.meta.url).href,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 0, `дочерний процесс: ${res.stderr}`);
    const notices = res.stderr.split(/\r?\n/).filter((l) => /тулы записи выключены/.test(l));
    assert.deepEqual(notices, ["hsemcp: тулы записи выключены (HSE_ENABLE_WRITES не задан)"]);
  } finally {
    fs.rmSync(childDir, { recursive: true, force: true });
  }
});
