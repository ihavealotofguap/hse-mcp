# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

hsemcp — локальный MCP-сервер (stdio) для инфраструктуры НИУ ВШЭ: расписание RUZ, SmartLMS
(edu.hse.ru), Единый личный кабинет (lk.hse.ru), корпоративная почта (Яндекс 360).

## Команды разработки

- `npm run build` — компиляция TypeScript (`tsc -p tsconfig.json`) в `dist/`.
- `npm run dev` — компиляция в режиме watch.
- `npm start` — запуск собранного сервера (`node dist/index.js`).
- `npx playwright install chromium` — нужно один раз после `npm install` для сервисов LMS/ЕЛК.
- Тестов и линтера в проекте нет.
- Подключение к Claude Code: `claude mcp add hsemcp -- node C:/Users/alexk/hsemcp/dist/index.js`.
- Перед первым запуском: `cp .env.example .env` и заполнить `HSE_EMAIL` / `HSE_PASSWORD`
  (см. переменные в `.env.example`).

## Архитектура

MCP-сервер на `@modelcontextprotocol/sdk` (stdio-транспорт). `src/index.ts` создаёт `McpServer` и
регистрирует тулы всех сервисов через `registerXTools(server)`; при `SIGINT`/`SIGTERM` закрывает
общий Playwright-браузер перед выходом.

Каждый сервис живёт в `src/services/<name>/` и состоит из двух файлов:
- `client.ts` — логика похода во внешнюю систему, без зависимостей от MCP SDK.
- `tools.ts` — экспортирует `registerXTools(server)`, оборачивает функции клиента в
  `server.registerTool(...)` с zod-схемой входа и вызывает их через `runTool()`
  (`src/mcp-utils.ts`) — единая обёртка, которая сериализует успешный результат в JSON-текст,
  а исключение превращает в `isError`-ответ вместо выброса.

Два способа доступа к данным ВШЭ, в зависимости от сервиса:
- **RUZ** (`services/ruz/`) — прямые HTTP-запросы к `ruz.hse.ru/api` без авторизации.
  ВАЖНО: API отвечает только из внутренней сети ВШЭ (Wi-Fi `HSE.Student` или VPN сотрудника) —
  вне кампуса запросы редиректят на страницу с ограничением доступа.
- **SmartLMS и ЕЛК** (`services/lms/`, `services/elk/`) — через общий Playwright-браузер
  `src/auth/browser-session.ts` (`openAuthenticatedPage`), который проходит единый SSO ВШЭ
  (Keycloak, `saml.hse.ru`, realm `hse`) при первом обращении и переиспользует контекст/сессию
  между вызовами тулов (`storage/hse-session.json` — переживает перезапуск сервера). SmartLMS —
  Moodle; парсинг материалов/заданий/оценок опирается на стандартные Moodle URL-паттерны
  (`/mod/<type>/view.php?id=`), а не на CSS-классы (тема оформления ВШЭ кастомизирована).
  ЕЛК (`lk.hse.ru`) вне `/profile` не имеет документированной структуры, поэтому его тулы
  (`elk_open_page`, `lms_open_page`) возвращают через `dom-utils.ts#dumpPage` сырой видимый
  текст + ссылки страницы вместо разобранных полей — модель извлекает нужное сама.
- **Почта** (`services/mail/`) — напрямую по IMAP/SMTP (`imap.yandex.ru` / `smtp.yandex.ru`),
  так как студенческая почта ВШЭ с 2022/2023 уч. года на Яндекс 360, а не на Exchange.

`src/config.ts` читает `.env` по пути относительно расположения самого файла (не `process.cwd()`),
потому что сторонние хосты (Claude Desktop и т.п.) запускают stdio-сервер с произвольным рабочим
каталогом. Обязательные переменные (`HSE_EMAIL`, `HSE_PASSWORD`, а для почтовых тулов отдельно —
`HSE_MAIL_APP_PASSWORD`) читаются лениво через геттеры и бросают понятную ошибку при отсутствии.
`HSE_MAIL_APP_PASSWORD` не падает обратно на `HSE_PASSWORD` — пароль единого SSO ВШЭ не должен
уходить по IMAP/SMTP на серверы Яндекса.

`src/dom-utils.ts` — две переиспользуемые Playwright-утилиты для сервисов LMS/ЕЛК: `extractTable`
(HTML-таблица thead/tbody → массив объектов) и `dumpPage` (универсальный снимок страницы: текст +
ссылки — для порталов с неизвестной вёрсткой).

## Добавление нового сервиса

Создать `src/services/<name>/` с `client.ts` (логика) и `tools.ts` (`registerXTools(server)`),
подключить вызовом в `src/index.ts` — по образцу существующих сервисов.

## Известные ограничения

- RUZ доступен только из внутренней сети ВШЭ (Wi-Fi `HSE.Student` или VPN) — вне кампуса
  `ruz_*`-тулы возвращают ошибку; используйте `elk_open_page` как альтернативу.
- Селекторы ЕЛК за пределами `/profile` не проверены вживую — структура остальных разделов
  неизвестна.
- Почтовые тулы всегда требуют `HSE_MAIL_APP_PASSWORD` (генерируется в настройках безопасности
  Яндекс ID) — независимо от `HSE_PASSWORD`.
- LMS/ЕЛК в этой версии только для чтения — сдача заданий и подача заявок не реализованы.

## Roadmap

Полный список запланированных задач и известного технического долга — в `ROADMAP.md`. v1 (RUZ,
SmartLMS, ЕЛК-профиль, почта, SSO) готова. Главный текущий блокер — разведка реальной структуры
ЕЛК за пределами `/profile` (нужен живой логин или пути разделов от пользователя), от неё зависит
превращение `elk_open_page` в нормальные структурированные тулы.
