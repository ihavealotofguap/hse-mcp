import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as elk from "./client.js";

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function registerElkTools(server: McpServer): void {
  server.registerTool(
    "elk_get_schedule",
    {
      title: "Расписание через ЕЛК",
      description:
        "Расписание занятий студента через API Единого личного кабинета " +
        "(lk.hse.ru/api/get-myschedule) — включая ссылки на онлайн-пары. В отличие от ruz_* " +
        "работает из ЛЮБОЙ сети, не только из внутренней сети ВШЭ — используйте этот тул как " +
        "основной источник расписания, если ruz_get_my_schedule упал с ошибкой сети.",
      inputSchema: {
        daysAhead: z.number().int().min(1).max(60).default(7).describe("На сколько дней вперёд от сегодня"),
      },
    },
    async ({ daysAhead }) =>
      runTool(async () => {
        const from = new Date();
        const to = addDays(from, daysAhead);
        return elk.getSchedule(from, to);
      })
  );

  server.registerTool(
    "elk_get_user_info",
    {
      title: "Данные аккаунта ЕЛК",
      description:
        "Базовая структурированная информация об аккаунте в ЕЛК (lk.hse.ru/api/get-user): ФИО, " +
        "email, роли (студент/ДПО и т.п.). Не содержит академическую карточку (рейтинг, группа, " +
        "факультет) — за ней используйте elk_get_profile.",
      inputSchema: {},
    },
    async () => runTool(() => elk.getUserInfo())
  );

  server.registerTool(
    "elk_search_services",
    {
      title: "Поиск сервисов в каталоге ЕЛК",
      description:
        "Полнотекстовый поиск по каталогу сервисов ЕЛК (lk.hse.ru/api/search/search-all, " +
        "категория services — 254 сервиса на 2026-09-15): справки, заявки на практику/" +
        "мобильность/стипендии, запись к психологу, антиплагиат и т.п. Возвращает id, название, " +
        "описание, прямую ссылку на сервис и релевантность (score). Поле categories в ответе — " +
        "счётчики совпадений по ВСЕМ категориям поиска (сотрудники/студенты/сервисы/" +
        "подразделения), даже если сами результаты отданы только по сервисам — так можно понять, " +
        "есть ли смысл поискать ещё и людей/подразделения по этому запросу.",
      inputSchema: {
        query: z.string().min(1).describe("Поисковый запрос, напр. 'справка' или 'стипендия'"),
        limit: z.number().int().min(1).max(50).default(10).describe("Максимум результатов"),
      },
    },
    async ({ query, limit }) => runTool(() => elk.searchServices(query, limit))
  );

  server.registerTool(
    "elk_list_requests",
    {
      title: "История заявок в ЕЛК",
      description:
        "Список всех поданных пользователем заявок в ЕЛК (lk.hse.ru/claim): номер, содержание, " +
        "сервис, статус (например «Выполнено», «На проверке»), даты создания/обновления, " +
        "исполнитель и ссылка на форму заявки (если есть). Полезно проверить статус ранее " +
        "поданных обращений (справки, стипендии, воинский учёт и т.п.) без захода в веб-интерфейс.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(500).describe("Максимум заявок"),
      },
    },
    async ({ limit }) => runTool(() => elk.listRequests(limit))
  );

  server.registerTool(
    "elk_get_profile",
    {
      title: "Профиль в ЕЛК",
      description:
        "Полная страница профиля студента в ЕЛК (lk.hse.ru/profile): ФИО, контакты, а также " +
        "академическая карточка — рейтинг, GPA, программа обучения, факультет, курс, группа. " +
        "Возвращает видимый текст страницы и список ссылок раздела (текстовый дамп, не JSON — " +
        "часть данных подгружается через нераскрытый GraphQL-эндпоинт).",
      inputSchema: {},
    },
    async () => runTool(() => elk.getProfile())
  );

  server.registerTool(
    "elk_open_page",
    {
      title: "Открыть произвольную страницу ЕЛК",
      description:
        "Открыть любую страницу lk.hse.ru по относительному пути под авторизованной SSO-сессией и " +
        "вернуть видимый текст и список ссылок на странице. Известные разделы (разведаны " +
        "2026-09-15): /task (задачи), /claim (заявления/обращения), /service (сервисы), " +
        "/student-services (Центр сервиса «Студент» — заказ справок, изменение персональных " +
        "данных, финансовые вопросы; разделы через ?section=documents&subsection=certificates " +
        "и т.п.), /faq. Хелпдеск-тикеты создаются на отдельном домене " +
        "pmo.hse.ru/servicedesk/customer/portal/81/create/<id> (ссылки на конкретные формы есть " +
        "на странице профиля и student-services).",
      inputSchema: {
        path: z.string().describe("Относительный путь на lk.hse.ru, напр. /claim или /student-services?section=documents"),
      },
    },
    async ({ path }) => runTool(() => elk.openPage(path))
  );
}
