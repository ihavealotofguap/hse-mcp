import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clearCache } from "../../cache.js";
import { runTool } from "../../mcp-utils.js";

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "hse_clear_cache",
    {
      title: "Сбросить кэш данных ВШЭ",
      description:
        "Результаты тулов lms_*/elk_* и сводок my_today/my_week/my_deadlines (они " +
        "собираются из тех же ресурсов) кэшируются в памяти на 2–30 минут, чтобы не открывать " +
        "браузер заново ради неизменившихся данных. Если нужно " +
        "гарантированно свежее значение — например, сразу после подачи работы или заявки, — " +
        "вызовите этот тул, затем повторите нужный запрос. scope сужает сброс до одного сервиса.",
      inputSchema: {
        scope: z
          .enum(["all", "elk", "lms"])
          .optional()
          .describe("Что сбросить: all (по умолчанию) или один сервис"),
      },
    },
    async ({ scope }) =>
      runTool(async () => {
        const prefix = !scope || scope === "all" ? "" : `${scope}:`;
        return { cleared: clearCache(prefix), scope: scope ?? "all" };
      })
  );
}
