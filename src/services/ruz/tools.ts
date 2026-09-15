import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import { addDays } from "../../date-utils.js";
import * as ruz from "./client.js";

export function registerRuzTools(server: McpServer): void {
  server.registerTool(
    "ruz_find_person",
    {
      title: "Найти в РУЗ",
      description:
        "Поиск студента, преподавателя, группы или аудитории ВШЭ по подстроке (ФИО, номер группы) " +
        "через API RUZ (ruz.hse.ru/api/search). ВАЖНО: RUZ отдаёт данные только из внутренней сети " +
        "ВШЭ (Wi-Fi HSE.Student на кампусе или VPN сотрудника) — вне сети запрос вернёт ошибку. " +
        "Для поиска по расписанию вне сети ВШЭ используйте elk_get_schedule (API ЕЛК, работает " +
        "из любой сети). Возвращает id и подпись найденных совпадений — id группы/преподавателя " +
        "пригодится для ruz_get_group_schedule.",
      inputSchema: {
        term: z.string().describe("Строка поиска: часть ФИО, номер группы и т.п."),
        type: z.enum(["student", "lecturer", "group", "auditorium"]).default("student"),
      },
    },
    async ({ term, type }) => runTool(() => ruz.search(term, type))
  );

  server.registerTool(
    "ruz_get_my_schedule",
    {
      title: "Расписание студента по email",
      description:
        "Расписание занятий студента ВШЭ на заданный период по его корпоративному email " +
        "(login@edu.hse.ru). Использует API RUZ, который отдаёт данные только из внутренней сети " +
        "ВШЭ (Wi-Fi HSE.Student на кампусе или VPN) — при ошибке подключения вне кампуса " +
        "используйте elk_get_schedule — расписание через API ЕЛК, работает из любой сети.",
      inputSchema: {
        email: z.string().email().describe("Корпоративный email студента, напр. ivanov@edu.hse.ru"),
        daysAhead: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(7)
          .describe("На сколько дней вперёд от сегодня получить расписание"),
      },
    },
    async ({ email, daysAhead }) =>
      runTool(async () => {
        const student = await ruz.getStudentInfo(email);
        const from = new Date();
        const to = addDays(from, daysAhead);
        const lessons = await ruz.getSchedule("student", student.id, from, to);
        return { student, lessons };
      })
  );

  server.registerTool(
    "ruz_get_group_schedule",
    {
      title: "Расписание группы",
      description:
        "Расписание занятий учебной группы ВШЭ по её RUZ id (узнать id — ruz_find_person с type=group) " +
        "на заданный период.",
      inputSchema: {
        groupId: z.number().int().positive().describe("RUZ id группы"),
        daysAhead: z.number().int().min(1).max(60).default(7),
      },
    },
    async ({ groupId, daysAhead }) =>
      runTool(async () => {
        const from = new Date();
        const to = addDays(from, daysAhead);
        return ruz.getGroupSchedule(groupId, from, to);
      })
  );
}
