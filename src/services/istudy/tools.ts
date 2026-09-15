import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as istudy from "./client.js";

export function registerIstudyTools(server: McpServer): void {
  server.registerTool(
    "istudy_get_report",
    {
      title: "Академическая карточка (istudy.hse.ru)",
      description:
        "Детальная академическая карточка студента из istudy.hse.ru — отдельной от ЕЛК системы " +
        "с реальными цифрами рейтинга/GPA/кредитов (в отличие от elk_get_profile, где эта карточка " +
        "часто показывает «—», потому что рендерится текстовым дампом страницы). Возвращает " +
        "профиль (программа, факультет, курс, № студенческого), report-info (приказ о зачислении, " +
        "направление) и rating (percentile, место в группе, GPA, кредиты, КУД, средний/минимальный " +
        "балл). Проходит через SSO-переход lk.hse.ru → istudy.hse.ru при каждом вызове.",
      inputSchema: {},
    },
    async () => runTool(() => istudy.getReport())
  );

  server.registerTool(
    "istudy_get_exams",
    {
      title: "Зачётка (экзамены и зачёты) — istudy.hse.ru",
      description:
        "Список дисциплин с результатами (экзамен/зачёт, оценки, кредиты, преподаватель, часы) за " +
        "текущий учебный период студента из istudy.hse.ru.",
      inputSchema: {},
    },
    async () => runTool(() => istudy.getExams())
  );
}
