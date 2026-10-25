import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../../config.js";
import { addDays } from "../../date-utils.js";
import { runTool } from "../../mcp-utils.js";
import { CONFIRM_SCHEMA, noteWritesDisabled, WRITE_ANNOTATIONS } from "../writes/gate.js";
import { defineWrite } from "../writes/runner.js";
import { certificateAdapter } from "./certificate.js";
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
        "уровень обучения, статус. Замена текстовому дампу карточки из elk_get_profile.",
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
    "elk_get_login_history",
    {
      title: "История входов в ЕЛК",
      description:
        "История действий/входов в аккаунт ЕЛК (вкладка «Прочее» на /profile): дата, действие, " +
        "IP, местоположение, устройство и браузер. Полезно для проверки безопасности аккаунта — " +
        "неожиданные входы с незнакомых IP/устройств.",
      inputSchema: {
        offset: z.number().int().min(0).default(0).describe("Смещение для пагинации"),
      },
    },
    async ({ offset }) => runTool(() => elk.getLoginHistory(offset))
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
    "elk_list_tasks",
    {
      title: "Задачи в ЕЛК",
      description:
        "Список задач пользователя в ЕЛК (lk.hse.ru/task, `/api/tasks`) — тот же API-паттерн, " +
        "что у elk_list_requests. Форма ответа не типизирована: точные поля отдельной задачи не " +
        "подтверждены вживую (на проверенном аккаунте задач не было), возвращается как есть.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(500).describe("Максимум задач"),
      },
    },
    async ({ limit }) => runTool(() => elk.listTasks(limit))
  );

  server.registerTool(
    "elk_list_dpo_programs",
    {
      title: "Мои программы ДПО",
      description:
        "Программы дополнительного профессионального образования (ДПО), на которые подана " +
        "заявка/студент обучается (lk.hse.ru/dpo/my-programs). Релевантно только студентам, " +
        "проходящим ДПО помимо основной программы — для остальных возвращает пустой список. " +
        "statusLabels — расшифровка возможных статусов заявки.",
      inputSchema: {},
    },
    async () => runTool(() => elk.listDpoPrograms())
  );

  server.registerTool(
    "elk_get_antiplagiat_status",
    {
      title: "Статус проверок в Антиплагиате",
      description:
        "Статус проверок студенческой работы в системе Антиплагиат: сколько проверок " +
        "обрабатывается (processing), завершено (completed) и всего подано (total). Только " +
        "чтение — отправка работы на проверку (загрузка файла) не реализована.",
      inputSchema: {},
    },
    async () => runTool(() => elk.getAntiplagiatStatus())
  );

  server.registerTool(
    "elk_get_course_evaluation_status",
    {
      title: "Статус СОП (Оцени свои курсы)",
      description:
        "Периоды студенческой оценки преподавания (СОП/«Оцени свои курсы») и статус заполнения " +
        "анкеты по каждому периоду (например «СОП завершён, анкета не заполнена»): номер, " +
        "период, даты начала/окончания, статус. Данные с отдельного портала lms.hse.ru.",
      inputSchema: {},
    },
    async () => runTool(() => elk.getCourseEvaluationStatus())
  );

  server.registerTool(
    "elk_get_thesis_status",
    {
      title: "Статус ВКР/КР/проекта",
      description:
        "Статус проверки выпускной квалификационной/курсовой работы (портал lms.hse.ru): " +
        "период, тип работы, тема, дата загрузки, процент заимствований, статус проверки, " +
        "оценка, рецензия. Пустой список означает, что тема работы ещё не зарегистрирована в " +
        "системе (АСАВ) — обычная ситуация для младших курсов.",
      inputSchema: {},
    },
    async () => runTool(() => elk.getThesisStatus())
  );

  server.registerTool(
    "elk_get_portfolio",
    {
      title: "Электронное портфолио",
      description:
        "Электронное портфолио студента (портал lms.hse.ru): баллы/достижения за учёбу, науку, " +
        "ДПО, практики и проектную деятельность, культурно-творческую и общественную " +
        "деятельность, спорт, олимпиады — влияет на повышенную стипендию. Не требует отдельного " +
        "логина portfolio.hse.ru — доступно через тот же SSO, что и остальные elk_*. Текстовый " +
        "дамп страницы (смешанная вёрстка — профиль + таблицы + список достижений).",
      inputSchema: {},
    },
    async () => runTool(() => elk.getPortfolio())
  );

  server.registerTool(
    "elk_list_internships",
    {
      title: "Заявки на практику",
      description:
        "Список заявок на практику/стажировку студента («Модуль Практика», lms.hse.ru). " +
        "Read-only статус — подача новой заявки на практику не реализована.",
      inputSchema: {},
    },
    async () => runTool(() => elk.listInternships())
  );

  server.registerTool(
    "elk_get_scholarship_history",
    {
      title: "История заявок на повышенную стипендию",
      description:
        "История заявок на повышенную государственную академическую стипендию (портал " +
        "lms.hse.ru): событие, оценки студента/экспертов, результат, комментарий эксперта. " +
        "Пустой список — заявок не подавалось. Read-only — подача новой заявки не реализована.",
      inputSchema: {},
    },
    async () => runTool(() => elk.getScholarshipHistory())
  );

  server.registerTool(
    "elk_get_profile",
    {
      title: "Профиль в ЕЛК",
      description:
        "Полная страница профиля студента в ЕЛК (lk.hse.ru/profile): ФИО, контакты и прочая " +
        "видимая информация страницы. Возвращает видимый текст и список ссылок (текстовый дамп, " +
        "не JSON) — для структурированной академической карточки (рейтинг, GPA, программа, " +
        "факультет, курс, группа) используйте elk_get_academic_data.",
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
