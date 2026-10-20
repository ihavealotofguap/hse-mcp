import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../../config.js";
import { runTool } from "../../mcp-utils.js";
import { CONFIRM_SCHEMA, WRITE_ANNOTATIONS, noteWritesDisabled } from "../writes/gate.js";
import { defineWrite } from "../writes/runner.js";
import * as lms from "./client.js";
import { deleteAdapter, submitAdapter } from "./submissions.js";

const submitAssignment = defineWrite(submitAdapter);
const deleteSubmission = defineWrite(deleteAdapter);

export function registerLmsTools(server: McpServer): void {
  server.registerTool(
    "lms_list_courses",
    {
      title: "Список курсов SmartLMS",
      description:
        "Список курсов текущего студента на SmartLMS (edu.hse.ru, Moodle): id, название, " +
        "категория, даты начала/окончания, процент прохождения, избранное/скрытое. Требует " +
        "входа через единый SSO ВШЭ (выполняется автоматически, credentials из .env).",
      inputSchema: {},
    },
    async () => runTool(() => lms.listCourses())
  );

  server.registerTool(
    "lms_list_messages",
    {
      title: "Входящие внутренней почты SmartLMS",
      description:
        "Список входящих писем внутренней почты SmartLMS (плагин local_mail, edu.hse.ru/local/" +
        "mail) — переписка с преподавателями внутри курсов. Важные объявления и материалы от " +
        "преподавателей часто приходят именно сюда. Возвращает тему, курс, отправителя, дату, " +
        "статус прочтения, число вложений.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50).describe("Максимум писем"),
      },
    },
    async ({ limit }) => runTool(() => lms.listMessages(limit))
  );

  server.registerTool(
    "lms_get_message",
    {
      title: "Письмо внутренней почты SmartLMS",
      description:
        "Полный текст письма внутренней почты SmartLMS по id (см. lms_list_messages): текст, " +
        "курс, отправитель, получатели, вложения (имя файла, размер, ссылка на скачивание).",
      inputSchema: {
        messageId: z.number().int().positive().describe("id письма (из lms_list_messages)"),
      },
    },
    async ({ messageId }) => runTool(() => lms.getMessage(messageId))
  );

  server.registerTool(
    "lms_get_course_materials",
    {
      title: "Материалы курса",
      description:
        "Список элементов курса SmartLMS (файлы, задания, тесты, форумы и т.п.) по id курса " +
        "(см. lms_list_courses). Возвращает тип, название и ссылку каждого элемента.",
      inputSchema: {
        courseId: z.number().int().positive().describe("id курса на edu.hse.ru (course/view.php?id=...)"),
      },
    },
    async ({ courseId }) => runTool(() => lms.getCourseMaterials(courseId))
  );

  server.registerTool(
    "lms_list_assignments",
    {
      title: "Задания курса",
      description: "Список заданий (mod/assign) курса SmartLMS со сроками сдачи и статусами.",
      inputSchema: {
        courseId: z.number().int().positive().describe("id курса на edu.hse.ru"),
      },
    },
    async ({ courseId }) => runTool(() => lms.listAssignments(courseId))
  );

  server.registerTool(
    "lms_get_grades",
    {
      title: "Оценки по курсу",
      description: "Таблица оценок студента по курсу SmartLMS (отчёт по пользователю).",
      inputSchema: {
        courseId: z.number().int().positive().describe("id курса на edu.hse.ru"),
      },
    },
    async ({ courseId }) => runTool(() => lms.getGrades(courseId))
  );

  server.registerTool(
    "lms_open_page",
    {
      title: "Открыть произвольную страницу SmartLMS",
      description:
        "Открыть любую страницу edu.hse.ru по относительному пути (например /calendar/view.php) под " +
        "авторизованной сессией и вернуть видимый текст и ссылки. Полезно для сценариев, не покрытых " +
        "готовыми тулами.",
      inputSchema: {
        path: z.string().describe("Относительный путь на edu.hse.ru, напр. /calendar/view.php?view=month"),
      },
    },
    async ({ path }) => runTool(() => lms.openPage(path))
  );

  if (!config.writesEnabled) {
    noteWritesDisabled();
    return;
  }

  server.registerTool(
    "lms_submit_assignment",
    {
      title: "Сдать ответ на задание SmartLMS (файлами)",
      description:
        "ЗАПИСЬ в SmartLMS: сохраняет файлы из папки «исходящих» как ответ на задание (mod/assign) по " +
        "cmid из lms_get_course_materials. Без confirm — сухой прогон: только чтение, показывает, что " +
        "будет добавлено и заменено, предупреждения и previewToken; ничего не отправляет. Для записи " +
        "нужны confirm: true И previewToken из сухого прогона (токен привязан к заданию, файлам и " +
        "состоянию ответа, действует 15 минут, одноразовый). mode: draft (по умолчанию) — сохранить " +
        "без отправки на оценку; submit — отправить. ВНИМАНИЕ: у заданий без отдельного шага «Отправить " +
        "на оценку» само сохранение сразу отправляет работу на оценку — draft этого не исключает. " +
        "Файлы указываются только ИМЕНЕМ файла из папки «исходящих» (не путём); одноимённый файл ответа " +
        "перезаписывается. Онлайн-текст не поддерживается: параметр text отклоняется до любых " +
        "обращений к системе. Результат записи проверяется чтением: outcome confirmed (подтверждено), " +
        "rejected (система отказала) или unknown (неизвестно); после unknown НЕ повторяйте отправку — " +
        "повторите вызов с тем же previewToken (выполнится только проверка чтением) или сделайте новый " +
        "сухой прогон; новая запись по такой цели требует acknowledgeUnknown: true. Клиент спросит " +
        "разрешение на каждый вызов — присутствие человека обеспечивает он, а не сервер. Тул доступен " +
        "только при HSE_ENABLE_WRITES=true. Возвращает JSON: stage, outcome, evidence, warnings, sent.",
      inputSchema: {
        cmid: z.number().int().positive().describe("id модуля задания (cmid, view.php?id=...)"),
        mode: z
          .enum(["draft", "submit"])
          .default("draft")
          .describe("draft — сохранить без отправки на оценку; submit — отправить на оценку."),
        files: z
          .array(z.string().min(1).max(255))
          .min(1)
          .max(10)
          .describe("Имена файлов из папки «исходящих» (только имя, без пути)."),
        text: z.string().max(100_000).optional().describe("Онлайн-текст: НЕ поддерживается, вызов будет отклонён."),
        ...CONFIRM_SCHEMA,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, extra) => runTool((signal) => submitAssignment(args, signal), extra.signal)
  );

  server.registerTool(
    "lms_delete_submission",
    {
      title: "Удалить ответ на задание SmartLMS",
      description:
        "ЗАПИСЬ в SmartLMS: удаляет представленный ответ на задание (mod/assign) по cmid; файлы в папке " +
        "«исходящих» не трогаются. Без confirm — сухой прогон: только чтение, показывает текущий ответ, " +
        "предупреждения и previewToken; ничего не удаляет. Для удаления нужны confirm: true И " +
        "previewToken из сухого прогона (токен привязан к заданию и состоянию ответа, действует 15 " +
        "минут, одноразовый; токен сдачи сюда не подходит). Удаление необратимо. Результат проверяется " +
        "чтением: outcome confirmed (подтверждено), rejected (система отказала) или unknown " +
        "(неизвестно); после unknown НЕ повторяйте удаление — повторите вызов с тем же previewToken " +
        "(выполнится только проверка чтением) или сделайте новый сухой прогон; новая запись по такой " +
        "цели требует acknowledgeUnknown: true. Клиент спросит разрешение на каждый вызов — " +
        "присутствие человека обеспечивает он, а не сервер. Тул доступен только при " +
        "HSE_ENABLE_WRITES=true. Возвращает JSON: stage, outcome, evidence, warnings, sent.",
      inputSchema: {
        cmid: z.number().int().positive().describe("id модуля задания (cmid, view.php?id=...)"),
        ...CONFIRM_SCHEMA,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, extra) => runTool((signal) => deleteSubmission(args, signal), extra.signal)
  );
}
