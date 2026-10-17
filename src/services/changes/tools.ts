import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as changes from "./client.js";

const SCOPE = z.enum(["deadlines", "schedule", "inbox", "claims", "grades"]);

/** "7d", "12h" (до 4 цифр) или любая дата, которую разбирает `Date.parse`. */
const isSince = (v: string): boolean => /^\d{1,4}[dh]$/.test(v.trim()) || !Number.isNaN(Date.parse(v));

export function registerChangesTools(server: McpServer): void {
  server.registerTool(
    "hse_changes",
    {
      title: "Что изменилось с прошлого раза",
      description:
        "Снимает текущее состояние дедлайнов, расписания, входящего и заявок (по явной просьбе — " +
        "оценок) и возвращает ТОЛЬКО изменения с прошлого снимка: новое, изменено, пропало, " +
        "перенесено, просрочено. Для «что есть сейчас» используйте my_today/my_week/my_deadlines. " +
        "Первый вызов по источнику создаёт базу без событий (status: baseline). События не " +
        "теряются, если ответ не дошёл: курсор двигается только явным подтверждением — передайте " +
        "ackSeq из ответа в параметр ack следующего вызова; без ack те же события вернутся снова. " +
        "Если persisted: false (запись на диск не удалась), у ответа нет ackSeq (null), у событий " +
        "нет seq, и события повторятся в следующем вызове — подтверждать нечего. " +
        "В ответе не более 200 событий: если omitted > 0, ответ усечён — передайте ackSeq ответа в " +
        "ack и вызовите тул снова, чтобы получить остальное; усечённый ответ не считайте полным. " +
        "Тул только ЧИТАЕТ системы ВШЭ и пишет лишь локальную базу снимков. " +
        "«Пропало из календаря» не означает «сдано». Область grades дорогая (страница на курс, " +
        "десятки секунд) и берёт оценки только из журнала LMS. Возвращает JSON: changes, scopes " +
        "(статус по областям), sources (статус каждого источника; отказ одного не роняет вызов), " +
        "ackSeq, omitted, gap, persisted, warnings.",
      inputSchema: {
        scopes: z
          .array(SCOPE)
          .max(SCOPE.options.length)
          .optional()
          .describe("Области; по умолчанию deadlines, schedule, inbox, claims (без grades)."),
        courses: z
          .array(z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(200)]))
          .max(50)
          .optional()
          .describe("Фильтр курсов для grades: число — id курса, строка — часть названия."),
        fresh: z.boolean().optional().describe("true — игнорировать кэш (иначе принимаются данные не старше 60 с)."),
        since: z
          .string()
          .min(2)
          .max(64)
          .refine(isSince, 'Ожидается "7d", "12h" или дата ISO')
          .optional()
          .describe(
            'Журнал за период ("7d", "12h" или дата ISO) вместо неподтверждённого; since сам курсор не ' +
              "двигает (ack в том же вызове двигает)."
          ),
        ack: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .nullish()
          .transform((v) => v ?? undefined)
          .describe(
            "Передавайте ТОЛЬКО ackSeq из последнего ответа hse_changes (число; null не нужен — просто " +
              "опустите параметр, если ackSeq был null). seq отдельного события подтверждением НЕ " +
              "является. События до ackSeq считаются полученными и больше не возвращаются."
          ),
      },
    },
    async ({ scopes, courses, fresh, since, ack }, extra) =>
      runTool((signal) => changes.getChanges({ scopes, courses, fresh, since, ack, signal }), extra.signal)
  );

  server.registerTool(
    "hse_changes_reset",
    {
      title: "Сбросить накопленные изменения",
      description:
        "Стирает локальные базы снимков и журнал событий области (или всех областей), после чего " +
        "следующий hse_changes создаёт базу заново. Полный сброс (без scope) удаляет и копии " +
        "повреждённого файла (state.json.corrupt-*) и оставшиеся временные файлы. Меняет только " +
        "локальные файлы. Требует confirm: true.",
      inputSchema: {
        scope: SCOPE.optional().describe("Область; без неё — все."),
        confirm: z.boolean().describe("Должно быть true: подтверждение стирания."),
      },
    },
    async ({ scope, confirm }) => runTool(() => changes.resetChanges({ scope, confirm }))
  );
}
