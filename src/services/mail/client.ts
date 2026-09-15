import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { config } from "../../config.js";

// Студенческая почта ВШЭ с 2022/2023 уч. года — Яндекс 360 (mail.yandex.ru), не Exchange/O365.
// Доступ по стандартному IMAP/SMTP.
const IMAP_HOST = "imap.yandex.ru";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.yandex.ru";
const SMTP_PORT = 465;

function createImapClient(): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: config.hseEmail, pass: config.mailAppPassword },
    logger: false,
  });
}

export interface MailSummary {
  uid: number;
  subject: string;
  from: string;
  date: string;
  seen: boolean;
}

async function withMailbox<T>(mailbox: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createImapClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

function toSummary(message: {
  uid: number;
  envelope?: { subject?: string | null; from?: Array<{ address?: string | null }> | null; date?: Date | null };
  flags?: Set<string>;
}): MailSummary {
  return {
    uid: message.uid,
    subject: message.envelope?.subject ?? "(без темы)",
    from: message.envelope?.from?.map((a) => a.address).filter(Boolean).join(", ") ?? "",
    date: message.envelope?.date?.toISOString() ?? "",
    seen: message.flags?.has("\\Seen") ?? false,
  };
}

export async function listRecent(limit = 20, mailbox = "INBOX"): Promise<MailSummary[]> {
  return withMailbox(mailbox, async (client) => {
    const status = await client.status(mailbox, { messages: true });
    const total = status.messages ?? 0;
    if (total === 0) return [];
    const from = Math.max(1, total - limit + 1);
    const messages: MailSummary[] = [];
    for await (const message of client.fetch(`${from}:*`, { envelope: true, flags: true })) {
      messages.push(toSummary(message));
    }
    return messages.reverse();
  });
}

export async function searchMail(query: string, limit = 20, mailbox = "INBOX"): Promise<MailSummary[]> {
  return withMailbox(mailbox, async (client) => {
    const uids = await client.search(
      { or: [{ subject: query }, { from: query }, { body: query }] },
      { uid: true }
    );
    if (!uids || uids.length === 0) return [];
    const limited = uids.slice(-limit);
    const messages: MailSummary[] = [];
    for await (const message of client.fetch(limited, { envelope: true, flags: true }, { uid: true })) {
      messages.push(toSummary(message));
    }
    return messages.reverse();
  });
}

export interface MailContent {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string;
  text: string;
}

export async function readMessage(uid: number, mailbox = "INBOX"): Promise<MailContent> {
  return withMailbox(mailbox, async (client) => {
    const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
    if (!message || !message.source) {
      throw new Error(`Письмо с uid=${uid} не найдено в ${mailbox}`);
    }
    const parsed = await simpleParser(message.source);
    return {
      uid,
      subject: parsed.subject ?? "(без темы)",
      from: parsed.from?.text ?? "",
      to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to.text) : "",
      date: parsed.date?.toISOString() ?? "",
      text: (parsed.text ?? "").trim(),
    };
  });
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail(input: SendMailInput): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: config.hseEmail, pass: config.mailAppPassword },
  });
  const info = await transporter.sendMail({
    from: config.hseEmail,
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  return { messageId: info.messageId };
}
