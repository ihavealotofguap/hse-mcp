# Участие в разработке

1. Node.js 22+, `npm install`. Для живой проверки LMS/ЕЛК — один раз `npx playwright install chromium`,
   `.env` по `.env.example` и `npm run credentials:set`.
2. `npm test` собирает проект и запускает тесты (`node:test`): сеть ВШЭ, браузер и учётные данные им не
   нужны. `npm run lint` проверяет линтер и формат (Biome), `npm run format` форматирует код.
3. Тулы вручную проверяйте вживую со своим аккаунтом, например через
   `npx @modelcontextprotocol/inspector node dist/index.js`. Тулы записи — только с
   `HSE_ENABLE_WRITES=true` и только на своих данных.

## Код

Устройство и правила слоёв — в [`docs/architecture.md`](docs/architecture.md). Коротко:

- логика похода в систему — в `src/services/<name>/client.ts`, без зависимостей от MCP SDK;
- регистрация тулов — в `src/services/<name>/tools.ts`, без логики;
- сервисы одного слоя друг друга не импортируют; общий код уходит в ядро (`src/`) или в
  `services/writes/`. Нарушение ловит `test/architecture.test.mjs`.

Два правила Biome выключены намеренно (`biome.json`): `useDomNodeTextContent` — в Playwright нужен
видимый текст (`innerText`), а не `textContent`; `useMathMinMax` — сравниваются строки дат ISO, а
`Math.min/max` превратили бы их в `NaN`.

## PR

- Один PR — одна тема; CI (lint и тесты на Ubuntu и Windows, Node 22 и 24) должен быть зелёным.
- Поменялись тулы — обновите таблицу в README и [`docs/status.md`](docs/status.md); поменялись
  требования — [`docs/requirements.md`](docs/requirements.md).
- Тулы записи не добавляйте в автоматически разрешённые: защита держится на запросе разрешения
  клиента MCP на каждый вызов (см. «Требования к безопасности» в `docs/requirements.md`).
