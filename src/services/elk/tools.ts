import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../../config.js";
import { addDays } from "../../date-utils.js";
import { runTool } from "../../mcp-utils.js";
import { CONFIRM_SCHEMA, noteWritesDisabled, WRITE_ANNOTATIONS } from "../writes/gate.js";
import { defineWrite } from "../writes/runner.js";
import { certificateAdapter } from "./certificate/index.js";
import * as elk from "./client.js";

const orderCertificate = defineWrite(certificateAdapter);

export function registerElkTools(server: McpServer): void {
  server.registerTool(
    "elk_get_schedule",
    {
      title: "Расписание через ЕЛК",
      description:
        "Расписание занятий студента через API Единого личного кабинета " +
        "(lk.hse.ru/api/get-myschedule) — включая ссылки на онлайн-пары. Работает из ЛЮБОЙ сети " +
        "(в отличие от RUZ, который доступен только из внутренней сети ВШЭ) — основной источник " +
        "расписания.",
      inputSchema: {
        daysAhead: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(7)
          .describe("На сколько дней вперёд от сегодня"),
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
        "факультет) — за ней используйте elk_get_academic_data.",
      inputSchema: {},
    },
    async () => runTool(() => elk.getUserInfo())
  );

  server.registerTool(
    "elk_get_academic_data",
    {
      title: "Академическая карточка ЕЛК",
      description:
        "Структурированная академическая карточка студента (lk.hse.ru/api/get-academic-data): " +
        "рейтинг, GPA, кредиты, КУД, программа обучения, факультет, курс, группа, форма и " +
        "уровень обучения, статус. Структурированная замена разделу profile в elk_get_section.",
      inputSchema: {},
    },
    async () => runTool(() => elk.getAcademicData())
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
    "elk_get_notifications",
    {
      title: "Уведомления ЕЛК",
      description:
        "Уведомления ЕЛК (колокольчик в шапке, lk.hse.ru/notification): заголовок, текст, дата, " +
        "важность, прочитано ли.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("Максимум уведомлений"),
      },
    },
    async ({ limit }) => runTool(() => elk.getNotifications(limit))
  );

  server.registerTool(
    "elk_get_section",
    {
      title: "Раздел ЕЛК",
      description:
        "Один из разделов Единого личного кабинета (lk.hse.ru и его порталы) по имени section. " +
        "profile — страница профиля /profile текстом и ссылками (ФИО, контакты); для рейтинга, " +
        "GPA и группы есть elk_get_academic_data. login_history — история входов: дата, действие, " +
        "IP, местоположение, устройство (проверка безопасности аккаунта; offset — пагинация). " +
        "tasks — задачи пользователя (/task); поля задачи вживую не подтверждены, ответ как есть " +
        "(limit — максимум задач). dpo_programs — программы ДПО, на которые подана заявка, со " +
        "statusLabels; у остальных студентов пусто. antiplagiat — сколько проверок в Антиплагиате " +
        "обрабатывается, завершено и подано. course_evaluation — периоды СОП («Оцени свои курсы») и " +
        "заполнена ли анкета. thesis — статус ВКР/КР: тема, заимствования, оценка, рецензия; пусто, " +
        "если тема не зарегистрирована. portfolio — электронное портфолио (достижения, влияют на " +
        "повышенную стипендию), текстом. internships — заявки на практику. scholarship_history — " +
        "история заявок на повышенную стипендию; пусто, если заявок не было. Все разделы только " +
        "читаются: подача заявок не реализована.",
      inputSchema: {
        section: z.enum(elk.ELK_SECTIONS).describe("Какой раздел прочитать"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Только для tasks: максимум задач (по умолчанию 500)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Только для login_history: смещение для пагинации (по умолчанию 0)"),
      },
    },
    async ({ section, limit, offset }) => runTool(() => elk.getSection(section, { limit, offset }))
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
        path: z
          .string()
          .describe(
            "Относительный путь на lk.hse.ru, напр. /claim или /student-services?section=documents"
          ),
      },
    },
    async ({ path }) => runTool(() => elk.openPage(path))
  );

  if (!config.writesEnabled) {
    noteWritesDisabled();
    return;
  }

  server.registerTool(
    "elk_order_certificate",
    {
      title: "Заказать справку в ЕЛК",
      description:
        "ЗАПИСЬ в ЕЛК: заказывает справку через форму сервиса (lk.hse.ru, student-service) по serviceId — " +
        "числу components из url результата elk_search_services (не полю id). fields — словарь «подпись поля формы → точный текст варианта " +
        "выпадающего списка». Без confirm — сухой прогон: только чтение, форма открывается без выбора и " +
        "отправки. Первым шагом вызовите его с пустым fields: он откроет форму и вернёт отказ со списком " +
        "обязательных полей и их вариантов (варианты, требующие «дополнительное поле», помечены как не " +
        "поддерживаемые) — так узнают, что выбирать. Когда все обязательные поля заданы, сухой прогон " +
        "возвращает превью (поля, варианты, что будет выбрано), предупреждения и previewToken; ничего не " +
        "отправляет. Автозаполненные формой значения (из личных данных ЕЛК) показываются только " +
        "владельцу, в ответе сухого прогона. Для заказа нужны confirm: true И previewToken из сухого " +
        "прогона (токен привязан к сервису, выбранным значениям, автозаполнению и набору номеров уже " +
        "поданных заявок, действует 15 минут, одноразовый). ЗАКАЗ НЕОБРАТИМ: отмены заявки в ЕЛК нет. " +
        "За раз выполняется один заказ. Поддерживаются только поля-выпадающие списки: форма со " +
        "свободным текстом, датой, файлом и т.п. и варианты, требующие заполнить «дополнительное поле», " +
        "тул отклоняет. ИСХОД ЗАКАЗА СПРАВКИ ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ: справки «Сервиса Студент» в " +
        "elk_list_requests не видны, поэтому ответ — outcome unknown (newClaims: 0 НЕ означает, что " +
        "заказ не прошёл: запрос отправки формы мог уйти и заявка создана). confirmed для справки " +
        "сейчас недостижим (оставлен для форм, чьи заявки видны в истории). После unknown НЕ " +
        "повторяйте заказ: сверьте вручную на странице «Заявки» в lk.hse.ru; повтор с тем же " +
        "previewToken ничего не отправляет и лишь вернёт unknown, а новый заказ по этой справке " +
        "требует acknowledgeUnknown: true. Клиент спросит разрешение на каждый вызов — присутствие " +
        "человека обеспечивает он, а не сервер. Тул доступен только при HSE_ENABLE_WRITES=true. " +
        "Возвращает JSON: stage, outcome, evidence, warnings, sent.",
      inputSchema: {
        serviceId: z
          .number()
          .int()
          .positive()
          .describe("Число components из url результата elk_search_services (не поле id)"),
        fields: z
          .record(z.string(), z.string())
          .describe(
            "Подпись поля формы → точный текст варианта выпадающего списка; {} — разведка формы (отказ со списком обязательных полей и вариантов)."
          ),
        ...CONFIRM_SCHEMA,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, extra) => runTool((signal) => orderCertificate(args, signal), extra.signal)
  );
}
