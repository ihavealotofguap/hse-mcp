# hsemcp — Прогресс

Снимок состояния на 2026-09-15. Формат каждого пункта: что сделано → как проверено. Подробная
техническая разведка (эндпоинты, находки, тупики) — в `ROADMAP.md`, здесь только статус.

**Итого: 20 тулов в 5 сервисах (RUZ, SmartLMS, ЕЛК, istudy, почта), все read-only** — ни одной
записывающей операции ни в v1, ни в доработках после него (см. «Требования к безопасности» в
`REQUIREMENTS.md`, почему это осознанное решение, а не недоделка).

## Готово и работает (v1)

### RUZ (`src/services/ruz/`)
- [x] `ruz_find_person` — поиск студента/преподавателя/группы/аудитории
- [x] `ruz_get_my_schedule` — расписание студента по email
- [x] `ruz_get_group_schedule` — расписание группы по id
- Ограничение: доступен только из сети ВШЭ (Wi-Fi `HSE.Student` / VPN); вне кампуса тулы падают
  с ошибкой — задокументировано в README/CLAUDE.md, воспроизведено вживую 2026-09-15.

### SmartLMS / Moodle (`src/services/lms/`)
- [x] `lms_list_courses`, `lms_get_course_materials`, `lms_list_assignments`, `lms_get_grades`
- [x] `lms_open_page` — произвольная страница edu.hse.ru (fallback для неразобранных разделов)
- Только чтение — сдача заданий не реализована (см. REQUIREMENTS.md).

### ЕЛК / lk.hse.ru (`src/services/elk/`)
- [x] `elk_get_schedule` — реальный JSON API `get-myschedule`, работает из любой сети (замена RUZ
  вне кампуса)
- [x] `elk_get_user_info` — `get-user`: ФИО, email, роли
- [x] `elk_get_profile` — текстовый дамп профиля + академическая карточка (рейтинг/GPA/группа)
- [x] `elk_search_services` — поиск по каталогу из 254+ сервисов ЕЛК (`search-all`)
- [x] `elk_list_requests` — история поданных заявок (`/api/claims`)
- [x] `elk_open_page` — произвольная страница lk.hse.ru с картой известных разделов в описании
- [x] Исправлены 2 бага авторизации, найденные при живом использовании из Claude Desktop:
      гонка рендеринга SPA (ждём `networkidle`) и отсутствие автoредиректа ЕЛК на Keycloak
      (`ensureLoggedIn` теперь ищет ссылку «Войти»)

### istudy.hse.ru (`src/services/istudy/`)
- [x] `istudy_get_report` — профиль, report-info, rating (percentile/GPA/кредиты) отдельной от
  ЕЛК системы зачётки
- [x] `istudy_get_exams` — список дисциплин с оценками за период
- Технически нетривиально: SPA не отдаёт токен для прямого fetch, поэтому клиент перехватывает
  готовые `page.on("response")` при SSO-переходе, а не повторяет запросы вручную

### Почта (`src/services/mail/`)
- [x] `mail_list_recent`, `mail_search`, `mail_read_message`, `mail_send` — напрямую по
  IMAP/SMTP Яндекс 360 (не Exchange)

### Инфраструктура
- [x] Единый SSO-логин (Keycloak, `saml.hse.ru`, realm `hse`) с переиспользуемой сессией
  (`storage/hse-session.json`, переживает перезапуск сервера)
- [x] `runTool()` (`src/mcp-utils.ts`) — единая обёртка сериализации результата/ошибок
- [x] `dom-utils.ts` — `extractTable` и `dumpPage` для порталов без документированной вёрстки
- [x] `.env` читается по пути относительно `config.ts`, а не `process.cwd()`

## В процессе / разведано, но не реализовано

- [ ] **`elk_get_academic_data`** — эндпоинт `GET /api/get-academic-data` реверс-инжинирен
  (тот же Bearer-токен, что у остальных `elk_get_*`), но тул не написан. Тривиально по образцу
  `elk_get_user_info`.
- [ ] **`elk_order_certificate`** — разведана вся цепочка (Formily-схема формы, проверка доступа,
  автозаполнение, CMS-контент через `str-graphql`), но submit-эндпоинт не пойман осознанно —
  чтобы не создать настоящую заявку в системе ВШЭ без согласия пользователя.

## Не начато

Полный список с оценкой приоритета — в `REQUIREMENTS.md` и `ROADMAP.md` (разделы «Учёба»,
«Финансы, стипендии, гранты», «Здоровье и поддержка», «ДПО», «Внеучебная жизнь и кампус»,
«Технический долг»). Кратко: сдача заданий в LMS, портфолио (portfolio.hse.ru), заявки на
практику/мобильность/стипендии, антиплагиат, «Оцени свои курсы», библиотека, гранты
(grants/studscience/studsupport.hse.ru).

## Последние коммиты

```
5e249c0 Add istudy service for detailed gradebook/rating data
4c98389 Document ELK certificate order form recon findings
1ec722d Add elk_list_requests tool for ELK claim/request history
33e8817 Add elk_search_services tool for ELK catalog search
82cadb8 Initial commit: hsemcp MCP server for HSE infrastructure
```

## Известный технический долг

- Access_token ЕЛК в localStorage, похоже, недолговечен — каждый `elk_get_*` заново открывает
  страницу и берёт свежий токен вместо кэширования с TTL
- Не проверено, работает ли Moodle mobile webservice API для edu.hse.ru (заменил бы скрапинг на
  REST)
- Нет rate-limiting/задержек между Playwright-действиями (риск антибот-защиты ВШЭ)
- Нет тестов и smoke-проверок по модулям (в проекте вообще нет тестов/линтера — см. CLAUDE.md)
