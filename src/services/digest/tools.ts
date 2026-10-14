import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as digest from "./client.js";

const RESULT_NOTE =
  "Возвращает JSON: items — единый список элементов (kind, when, title, course, place, " +
  "overdue, unread, source, ...), отсортированный: просроченные несданные первыми, затем по " +
  "времени, затем без даты; sources — статус каждого источника (ok/error/skipped, текст " +
  "ошибки, warnings). Если источник недоступен (например, РУЗ вне сети ВШЭ), сводка всё " +
  "равно возвращается — смотрите sources. Корпоративная почта (mail_*) в сводку не входит.";

export function registerDigestTools(server: McpServer): void {
  server.registerTool(
    "my_today",
    {
      title: "Сводка на сегодня",
      description:
        "Что у студента сегодня: занятия на сегодня, дедлайны (все просроченные несданные и " +
        "до конца завтрашнего дня) из SmartLMS и ЕЛК, экзамены/зачёты, непрочитанная " +
        "внутренняя почта SmartLMS, непрочитанные уведомления ЕЛК, активные заявки и задачи " +
        "ЕЛК. " +
        RESULT_NOTE,
      inputSchema: {},
    },
    async () => runTool(() => digest.getToday())
  );

  server.registerTool(
    "my_week",
    {
      title: "Сводка на неделю",
      description:
        "План на ближайшие 7 дней (сегодня + 6): расписание занятий, дедлайны SmartLMS и ЕЛК, " +
        "экзамены/зачёты, просроченные несданные работы. Без почты и уведомлений — для них " +
        "my_today. " +
        RESULT_NOTE,
      inputSchema: {},
    },
    async () => runTool(() => digest.getWeek())
  );

  server.registerTool(
    "my_deadlines",
    {
      title: "Дедлайны",
      description:
        "Что горит: несданные задания и тесты SmartLMS (в том числе просроченные, у которых " +
        "приём уже закрыт), окна ЕЛК (например, оценка курсов), активные задачи и заявки ЕЛК, " +
        "ближайшие экзамены/зачёты за days дней вперёд. Элементы без распознанной даты идут в " +
        "конце с when: null. " +
        RESULT_NOTE,
      inputSchema: {
        days: z.number().int().min(1).max(120).default(14).describe("Горизонт в днях вперёд"),
        courses: z
          .array(z.union([z.number().int().positive(), z.string().min(1)]))
          .optional()
          .describe(
            "Сузить курсы SmartLMS: число — id курса, строка — часть названия. По умолчанию — " +
              "все актуальные (видимые, не завершённые). Расписание и ЕЛК фильтром не ограничиваются."
          ),
      },
    },
    async ({ days, courses }) => runTool(() => digest.getDeadlines({ days, courses }))
  );
}
