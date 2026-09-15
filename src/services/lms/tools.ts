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
        "Список курсов текущего студента на SmartLMS (edu.hse.ru, Moodle) со страницы «Мои курсы». " +
        "Требует входа через единый SSO ВШЭ (выполняется автоматически, credentials из .env).",
      inputSchema: {},
    },
    async () => runTool(() => lms.listCourses())
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
}
