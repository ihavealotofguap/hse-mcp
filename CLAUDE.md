# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## О проекте

hsemcp — локальный MCP-сервер (stdio) для инфраструктуры НИУ ВШЭ: SmartLMS (edu.hse.ru, Moodle) и
Единый личный кабинет (lk.hse.ru). Оба сайта — через общий Playwright-браузер с единым SSO ВШЭ
(Keycloak, `saml.hse.ru`). 21 тул чтения и 3 тула записи (за `HSE_ENABLE_WRITES`).

Куда смотреть:

- [`docs/status.md`](docs/status.md) — что есть, что покрыто тестами, что проверено вживую;
- [`docs/architecture.md`](docs/architecture.md) — слои, карта файлов, подробности по частям
  (сводки, снимки, запись, надёжность), известные ограничения, roadmap;
- [`docs/requirements.md`](docs/requirements.md) — требования (обновлять при их изменении);
- `docs/superpowers/{specs,plans}/` — спецификации и планы подпроектов;
- заметки разведки эндпоинтов — только локально у автора (`docs/recon.md` в `.gitignore`).

## Решения владельца (не пересматривать без него)

- Корпоративная почта ВШЭ исключена: тулов и зависимостей для неё не добавлять. Внутренняя почта
  SmartLMS (`lms_list_messages`, `lms_get_message`) — другая система и остаётся.
- RUZ вынесен в [hse-ruz-mcp](https://github.com/ihavealotofguap/hse-ruz-mcp) (npm `hse-ruz-mcp`):
  тулы `ruz_*` и запасной путь RUZ в сводках сюда не возвращать.
- istudy (зачётка) удалён: данные закрыты 2FA через MAX, обход не предусмотрен. Не возвращать без
  новой разведки.
- Любая запись — только с явным `confirm: true` и в присутствии пользователя; тулы записи нельзя
  добавлять в автоматически разрешённые (см. «Требования к безопасности» в `docs/requirements.md`).

## Команды

- `npm run build` — TypeScript в `dist/`; `npm run dev` — то же в режиме watch; `npm start` — запуск.
- `npm test` — сборка и тесты `node:test` (`test/*.test.mjs`, без сети, браузера и учётных данных).
- `npm run lint` — Biome (линтер и формат); `npm run format` — автоисправление.
- `npx playwright install chromium` — один раз для живой работы LMS/ЕЛК (без него сервер берёт
  системный Edge или Chrome, иначе скачивает Chromium сам).
- `npm run pack:mcpb` — пакет Claude Desktop в `build/hsemcp-<версия>.mcpb` (`manifest.json`).
- Подключение: `claude mcp add hsemcp -- node <путь-к-проекту>/dist/index.js`; перед первым запуском
  `cp .env.example .env`, заполнить `HSE_EMAIL`, пароль — `npm run credentials:set`.
- `HSE_ENABLE_WRITES=true` в `.env` включает `lms_submit_assignment`, `lms_delete_submission`,
  `elk_order_certificate` (читается при старте; без него их нет в `tools/list`).

CI (`.github/workflows/ci.yml`) гоняет lint и тесты на Ubuntu и Windows, Node 22 и 24, и собирает
`.mcpb`. Релиз (`publish.yml`, как в hse-ruz-mcp): push в master с изменениями `src/` или
`manifest.json` → patch-бамп, npm, реестр MCP, GitHub Release с `.mcpb`. Версия — одна в
`package.json`, `server.json` и `manifest.json`.

## Слои

```
src/index.ts → */tools.ts → digest, changes → адаптеры записи → services/writes → lms, elk, system → core
```

- core — `src/*.ts`, `src/auth`, `src/cli`: SSO и браузер (`withPage` — единственный способ открыть
  страницу), лимитер, `defineResource` и кэш, выключатель, блокировки файлов, учётные данные, `runTool`,
  каталог данных (`data-dir.ts`: файлы состояния — только через него, не от корня проекта).
- Сервис — `src/services/<name>/`: `client.ts` (логика, без MCP SDK) и `tools.ts`
  (`registerXTools(server)`: zod-схема и вызов клиента через `runTool()`, без логики).
- Адаптеры записи: `services/lms/submissions.ts`, `services/elk/certificate.ts`; общий протокол —
  `services/writes/` (`runner.ts#defineWrite`, токен, журнал, папка «исходящих», `errors.ts`).
- Сервисы одного слоя друг друга не импортируют; правила проверяет `test/architecture.test.mjs`.
  Новый сервис — строка в `SERVICE_DEPS` этого теста, подключение в `src/index.ts`, README и
  `docs/status.md`.

## Стиль

- Комментарии и тексты ошибок — по-русски; тексты ошибок тулов записи не содержат URL, имён файлов и id.
- Чистая логика покрывается тестами; браузерные части — заглушками и живой проверкой.
- Разбор Moodle опирается на URL-паттерны (`/mod/<type>/view.php?id=`), а не на CSS-классы темы ВШЭ.
- `src/config.ts` читает `.env` относительно своего файла, а не `process.cwd()`.
