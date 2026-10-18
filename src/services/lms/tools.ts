import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as lms from "./client.js";

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
      description:
        "Оценки студента по курсу SmartLMS (отчёт по пользователю): items — строки журнала по " +
        "порядку, у каждой name (название элемента или категории), level (уровень вложенности), " +
        "path (категории-предки), isCategory и grade (текст оценки; null у категории, «-» если " +
        "оценки ещё нет). Если вёрстка журнала курса не распознана — ошибка.",
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
}
