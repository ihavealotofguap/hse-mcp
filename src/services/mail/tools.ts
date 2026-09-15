import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as mail from "./client.js";

export function registerMailTools(server: McpServer): void {
  server.registerTool(
    "mail_list_recent",
    {
      title: "Последние письма",
      description: "Список последних писем в почтовом ящике ВШЭ (Яндекс 360) по IMAP.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        mailbox: z.string().default("INBOX").describe("Название папки, напр. INBOX, Отправленные"),
      },
    },
    async ({ limit, mailbox }) => runTool(() => mail.listRecent(limit, mailbox))
  );

  server.registerTool(
    "mail_search",
    {
      title: "Поиск писем",
      description: "Поиск писем по теме, отправителю или тексту письма (IMAP SEARCH).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().describe("Строка поиска"),
        limit: z.number().int().min(1).max(100).default(20),
        mailbox: z.string().default("INBOX"),
      },
    },
    async ({ query, limit, mailbox }) => runTool(() => mail.searchMail(query, limit, mailbox))
  );

  server.registerTool(
    "mail_read_message",
    {
      title: "Прочитать письмо",
      description: "Полный текст письма по его uid (см. mail_list_recent / mail_search).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        uid: z.number().int().describe("uid письма в папке"),
        mailbox: z.string().default("INBOX"),
      },
    },
    async ({ uid, mailbox }) => runTool(() => mail.readMessage(uid, mailbox))
  );

  server.registerTool(
    "mail_send",
    {
      title: "Отправить письмо",
      description: "Отправить письмо с корпоративного адреса студента (SMTP, Яндекс 360). Необратимое действие.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        to: z.string().email().describe("Адрес получателя"),
        subject: z.string(),
        text: z.string().describe("Текст письма (plain text)"),
      },
    },
    async ({ to, subject, text }) => runTool(() => mail.sendMail({ to, subject, text }))
  );
}
