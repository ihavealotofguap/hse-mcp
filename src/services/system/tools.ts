import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clearCache } from "../../cache.js";
import { runTool } from "../../mcp-utils.js";

// Сброс кэша меняет состояние сервера (не readOnly), но ничего не теряет: данные загрузятся заново
// при следующем запросе (не destructive), повтор даёт тот же результат (idempotent), внешние системы
// не трогаются (closed world).
const CLEAR_CACHE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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
      annotations: CLEAR_CACHE_ANNOTATIONS,
    },
    async ({ scope }) =>
      runTool(async () => {
        const prefix = !scope || scope === "all" ? "" : `${scope}:`;
        return { cleared: clearCache(prefix), scope: scope ?? "all" };
      })
  );
}
