import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLmsTools } from "./services/lms/tools.js";
import { registerElkTools } from "./services/elk/tools.js";
import { registerSystemTools } from "./services/system/tools.js";
import { registerDigestTools } from "./services/digest/tools.js";
import { registerChangesTools } from "./services/changes/tools.js";
import { closeBrowserSession } from "./auth/browser-session.js";

const server = new McpServer({
  name: "hsemcp",
  version: "0.1.0",
});

registerLmsTools(server);
registerElkTools(server);
registerSystemTools(server);
registerDigestTools(server);
registerChangesTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // closeBrowserSession() сам теперь идемпотентен, но таймаут здесь — второй рубеж защиты: если
  // браузер зависнет при закрытии, процесс всё равно должен выйти по сигналу, а не висеть вечно.
  await Promise.race([
    closeBrowserSession(),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]).catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("hsemcp fatal error:", err);
  process.exit(1);
});
