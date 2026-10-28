import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ_ANNOTATIONS, runTool } from "../../mcp-utils.js";
import * as digest from "./client.js";
import { ITEM_KINDS } from "./types.js";

const RESULT_NOTE =
  "Возвращает JSON: items — единый список элементов (kind, when, title, course, place, " +
  "overdue, unread, source, ...), отсортированный: просроченные несданные первыми, затем по " +
  "времени, затем без даты; sources — статус каждого источника (ok/error/skipped, текст " +
  "ошибки, warnings). Если источник недоступен (например, ЕЛК не ответил), сводка всё " +
  "равно возвращается — смотрите sources.";

// Схема ответа по DigestResult (types.ts). SDK превращает весь ответ в ошибку при любом несовпадении
// со схемой, поэтому поля, которые приходят из ЕЛК и LMS без проверки (title, important), допускают
// null, а всё, чего у элемента может не быть, необязательно.
const DIGEST_ITEM = z.object({
  kind: z.enum(ITEM_KINDS),
  when: z.string().nullable().describe("Срок или начало, ISO 8601; null — не распознан"),
  until: z.string().optional(),
  received: z.string().optional(),
  title: z.string().nullish(),
  course: z.string().optional(),
  place: z.string().optional(),
  source: z.string().describe("Коллектор: elk_schedule, lms_deadlines, ..."),
  overdue: z.boolean().optional(),
  unread: z.boolean().optional(),
  important: z.boolean().nullish(),
  url: z.string().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const SOURCE_STATUS = z.object({
  status: z.enum(["ok", "error", "skipped"]),
  error: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  ms: z.number().optional(),
});

const DIGEST_OUTPUT = {
  generatedAt: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  items: z.array(DIGEST_ITEM),
  sources: z.record(z.string(), SOURCE_STATUS),
};

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
      outputSchema: DIGEST_OUTPUT,
      annotations: READ_ANNOTATIONS,
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
      outputSchema: DIGEST_OUTPUT,
      annotations: READ_ANNOTATIONS,
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
              "все видимые курсы: будущие дедлайны берутся у актуальных (не завершённых), " +
              "просроченные несданные — у любых видимых. Расписание, окна ЕЛК и остальные " +
              "источники фильтром не ограничиваются."
          ),
      },
      outputSchema: DIGEST_OUTPUT,
      annotations: READ_ANNOTATIONS,
    },
    async ({ days, courses }) => runTool(() => digest.getDeadlines({ days, courses }))
  );
}
