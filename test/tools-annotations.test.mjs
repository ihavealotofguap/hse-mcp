import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Как в tools-gating: ключ записей во временном каталоге, браузер не запускается.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-annotations-"));
process.env.HSE_WRITES_DIR = dir;
process.env.HSE_ENABLE_WRITES = "";
const realConsoleError = console.error;
console.error = () => {};

const { z } = await import("zod");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const dist = (p) => new URL(`../dist/${p}`, import.meta.url).href;
const { READ_ANNOTATIONS, runTool } = await import(dist("mcp-utils.js"));
const { WRITE_ANNOTATIONS } = await import(dist("services/writes/gate.js"));
const REGISTER = [
  (await import(dist("services/lms/tools.js"))).registerLmsTools,
  (await import(dist("services/elk/tools.js"))).registerElkTools,
  (await import(dist("services/system/tools.js"))).registerSystemTools,
  (await import(dist("services/digest/tools.js"))).registerDigestTools,
  (await import(dist("services/changes/tools.js"))).registerChangesTools,
];

test.after(() => {
  console.error = realConsoleError;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Собирает зарегистрированные тулы всех сервисов без настоящего McpServer. */
function collectTools(writes) {
  process.env.HSE_ENABLE_WRITES = writes ? "true" : "";
  const tools = {};
  const server = {
    registerTool(name, config, handler) {
      tools[name] = { config, handler };
    },
  };
  for (const register of REGISTER) register(server);
  return tools;
}

const WRITE_TOOLS = ["lms_submit_assignment", "lms_delete_submission", "elk_order_certificate"];
const SPECIAL = {
  hse_changes_reset: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  hse_clear_cache: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

test("21 тул без записи, 24 с записью; у каждого есть аннотации", () => {
  for (const [writes, count] of [
    [false, 21],
    [true, 24],
  ]) {
    const tools = collectTools(writes);
    assert.equal(Object.keys(tools).length, count);
    for (const [name, { config }] of Object.entries(tools))
      assert.ok(config.annotations, `${name}: нет annotations`);
  }
});

test("тулы чтения — READ_ANNOTATIONS, записи — WRITE_ANNOTATIONS, служебные — свои", () => {
  assert.deepEqual(READ_ANNOTATIONS, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  for (const [name, { config }] of Object.entries(collectTools(true))) {
    let expected = READ_ANNOTATIONS;
    if (WRITE_TOOLS.includes(name)) expected = WRITE_ANNOTATIONS;
    else if (SPECIAL[name]) expected = SPECIAL[name];
    assert.deepEqual(config.annotations, expected, name);
  }
  // Тулы чтения — все lms_*, elk_* (кроме записи), сводки и hse_changes.
  const read = Object.entries(collectTools(false))
    .filter(([, { config }]) => config.annotations.readOnlyHint === true)
    .map(([name]) => name);
  assert.equal(read.length, 19);
  for (const name of ["my_today", "my_week", "my_deadlines", "hse_changes", "elk_get_section"])
    assert.ok(read.includes(name), name);
});

test("runTool: объект — компактный JSON и structuredContent", async () => {
  const res = await runTool(async () => ({ a: [1, 2], b: "x" }));
  assert.deepEqual(res, {
    content: [{ type: "text", text: '{"a":[1,2],"b":"x"}' }],
    structuredContent: { a: [1, 2], b: "x" },
  });
});

test("runTool: массив, строка и undefined — без structuredContent", async () => {
  const arr = await runTool(async () => [1, { c: 2 }]);
  assert.equal(arr.content[0].text, '[1,{"c":2}]');
  assert.equal(arr.structuredContent, undefined);
  const str = await runTool(async () => "привет");
  assert.equal(str.content[0].text, "привет");
  assert.equal(str.structuredContent, undefined);
  assert.equal((await runTool(async () => undefined)).content[0].text, "null");
  assert.equal((await runTool(async () => null)).structuredContent, undefined);
});

test("runTool: исключение — isError без structuredContent", async () => {
  const res = await runTool(async () => {
    throw new Error("сломалось");
  });
  assert.deepEqual(res, { content: [{ type: "text", text: "Ошибка: сломалось" }], isError: true });
});

const ITEM = {
  kind: "assignment",
  when: "2026-10-27T23:59:00+03:00",
  title: "ДЗ 3",
  course: "Матанализ",
  source: "lms_deadlines",
  url: "https://edu.hse.ru/mod/assign/view.php?id=1",
};
const DIGEST = {
  generatedAt: "2026-10-25T12:00:00+03:00",
  window: { from: "2026-10-25T00:00:00+03:00", to: "2026-10-26T23:59:59+03:00" },
  items: [
    ITEM,
    {
      kind: "lms_message",
      when: null,
      received: "2026-10-24T10:00:00+03:00",
      title: "Re",
      source: "lms_messages",
      unread: true,
    },
    {
      kind: "notification",
      when: null,
      title: null,
      source: "elk_notifications",
      important: null,
      raw: { text: "" },
    },
    {
      kind: "assignment",
      when: "2026-10-20T23:59:00+03:00",
      title: "ДЗ 2",
      source: "lms_deadlines",
      overdue: true,
    },
  ],
  sources: {
    lms_deadlines: { status: "ok", ms: 120 },
    elk_schedule: { status: "error", error: "таймаут", ms: 40000 },
    elk_tasks: { status: "skipped", warnings: ["нет данных"], ms: 0 },
  },
};

/** Типичные ответы тулов (формы — из типов client.ts и digest/types.ts). */
const SAMPLES = {
  my_today: DIGEST,
  my_week: DIGEST,
  my_deadlines: { ...DIGEST, items: [] },
  elk_get_schedule: {
    days: [
      {
        date: "2026-10-26",
        lessons: [
          {
            name: "Матанализ",
            lesson_type: "Лекция",
            begin_time: "09:30",
            end_time: "10:50",
            auditorium: "R405",
            building: "Покровский б-р, 11",
            lecturer: "Иванов И.И.",
            parent_schedule: "БПМИ241",
            url1: null,
            url1_description: null,
            stream: "БПМИ24",
          },
        ],
      },
      { date: "2026-10-27" },
    ],
  },
  lms_list_courses: {
    courses: [
      {
        id: 101,
        fullname: "Матанализ",
        shortname: "MA",
        category: "ФКН",
        startdate: "2026-09-01T00:00:00.000Z",
        enddate: null,
        progress: null,
        isFavourite: false,
        hidden: false,
        visible: true,
        viewUrl: "https://edu.hse.ru/course/view.php?id=101",
      },
    ],
  },
  lms_list_assignments: {
    assignments: [{ Тема: "Неделя 1", Задание: "ДЗ 1", "Срок сдачи": "1 октября 2026" }],
  },
};

test("outputSchema есть у основных тулов и принимает типичный ответ", () => {
  const tools = collectTools(false);
  for (const [name, sample] of Object.entries(SAMPLES)) {
    const shape = tools[name].config.outputSchema;
    assert.ok(shape, `${name}: нет outputSchema`);
    const res = z.object(shape).safeParse(sample);
    assert.ok(res.success, `${name}: ${res.error?.message}`);
  }
});

test("outputSchema отклоняет ответ не той формы", () => {
  const tools = collectTools(false);
  const schema = (name) => z.object(tools[name].config.outputSchema);
  assert.equal(
    schema("my_today").safeParse({ ...DIGEST, items: [{ ...ITEM, kind: "x" }] }).success,
    false
  );
  assert.equal(schema("lms_list_courses").safeParse({ courses: [{ id: "1" }] }).success, false);
  assert.equal(schema("elk_get_schedule").safeParse([]).success, false);
});

test("stdio: tools/list отдаёт 21 тул без HSE_ENABLE_WRITES и 24 с ним, у каждого annotations", async () => {
  for (const [flag, count] of [
    ["", 21],
    ["true", 24],
  ]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      env: { ...process.env, HSE_ENABLE_WRITES: flag, HSE_WRITES_DIR: dir },
      stderr: "ignore",
    });
    const client = new Client({ name: "annotations-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, count, `HSE_ENABLE_WRITES=${JSON.stringify(flag)}`);
      for (const t of tools) assert.ok(t.annotations, `${t.name}: нет annotations`);
      const outputs = tools.filter((t) => t.outputSchema).map((t) => t.name);
      assert.deepEqual(outputs.sort(), Object.keys(SAMPLES).sort());
    } finally {
      await client.close();
    }
  }
});
