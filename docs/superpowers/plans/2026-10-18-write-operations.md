# Подпроект №4 «Записывающие операции» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в hsemcp записывающие операции — сдача и правка ответа на задание SmartLMS, удаление ответа, заказ справки в ЕЛК — с протоколом «сухой прогон → `previewToken` → `confirm` → проверка чтением», журналом и закрытым долгом `resource.ts`.

**Architecture:** Общий каркас `src/services/writes/` (токен, журнал, папка «исходящих», раннер протокола `defineWrite`) поверх расширенных `defineResource` (`cache: false`, `commit()`) и `withPage` (`commit()`); сервисные адаптеры в `src/services/lms/submissions.ts` и `src/services/elk/certificate.ts`, тулы регистрируются в существующих `tools.ts`. Каждый шаг формы проверяется, первое расхождение прекращает операцию до точки невозврата.

**Tech Stack:** TypeScript (ESM, `.js`-суффиксы в импортах), `@modelcontextprotocol/sdk` 1.30.0, `zod`, `playwright`, `node:crypto`/`node:fs`.

**Spec:** `docs/superpowers/specs/2026-10-18-write-operations-design.md` (одобрена 2026-10-18; §17 — результаты живой разведки, селекторы и тексты берутся оттуда). Исполнитель читает спеку целиком.

## Global Constraints

- **Тестового фреймворка и линтера в проекте нет — не добавлять** (ни зависимостей, ни раннера, ни конфигов). Проверки двух видов: **постоянные скрипты чистой логики** (Tasks 1, 3, 4, 5, 6, 7, 11) — обычные `.mjs` на `node:assert` в `scripts/verify/`, коммитятся с задачей, чтобы их мог повторить любой пользователь проекта; **одноразовые скрипты** с Chromium, заглушками страниц и живыми данными (остальные задачи) — в каталоге scratchpad сессии, не коммитятся. Плюс `npm run build` (ожидание: код выхода 0, ошибок TS нет).
- Комментарии, сообщения ошибок и описания тулов — по-русски, в стиле соседнего кода; импорты с суффиксом `.js`; тело тула — `runTool((signal) => …, extra.signal)` из `src/mcp-utils.ts`.
- Учётные данные только из `.env` проекта в `process.env` (у владельца — `C:\Users\alexk\hsemcp\.env`; одноразовые скрипты с живыми данными перед импортом `dist/` вызывают `dotenv.config({ path: <путь к .env> })`); постоянные скрипты `scripts/verify/` **не читают учётные данные, не ходят в сеть и не содержат личных путей**; в вывод, журнал, stderr, коммиты — ничего персонального: ни текста и имён файлов, ни ФИО, email, токенов, cookie, URL с query, id курсов/заданий/заявок.
- **Проект будет передан другому пользователю (одногруппнику):** ничего, что работает только у владельца — личных путей, названий его курсов, его идентификаторов — не коммитить; код при неожиданном состоянии страницы **отказывает**, а не угадывает; документы описывают установку с нуля (Task 18).
- **Живая запись — только в присутствии владельца и с его явным разрешением на каждую операцию; сначала сухой прогон.** Клиент Claude Code блокирует клики по кнопкам записи как «реальные транзакции» — это ожидаемо, обходить нельзя: остановиться и спросить владельца.
- `previewToken = "<issuedAtSec>.<hmac>"`, HMAC-SHA256 с ключом 32 байта из `storage/writes/key`; срок жизни 15 минут; `tokenId` и `targetId` — первые 12 hex-символов HMAC.
- Дедлайн коммита по умолчанию 20 с; каждый вызов `commit()` отсчитывает его заново. Ожидание новой заявки ЕЛК — до 15 с.
- Журнал `storage/writes/journal.json`: 90 дней, ≤ 200 записей; ровно поля `at, op, tokenId, targetId, stage, outcome?, durationMs?, errorClass?`.
- Папка «исходящих» — `storage/outbox/` или `HSE_OUTBOX_DIR`; ≤ 10 файлов; только имя файла (без `/`, `\`, `:`, `..`); `realpath` внутри папки; только обычные файлы; размер > 0. Файлы не удаляются и не перемещаются.
- Одновременно в процессе выполняется не более одной записи.
- Онлайн-текст в v1 не поддерживается (параметр `text` → отказ до записи).
- Аннотации тулов записи: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }`.
- Одноимённый файл в файловом менеджере Moodle — только «Перезаписать», «Переименовать» не нажимается никогда.
- Коммиты: ветка `worktree-4`, сообщение на английском, в конце `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Токен от одной операции/цели не должен подходить к другой (`lms_submit_assignment` → `lms_delete_submission`): проверка в Task 4.
- Имена файлов `..\.env`, `C:\x.txt`, `a/b.txt`, `a:b`, пустое, дубликат, симлинк/junction наружу, файл нулевого размера — отказ без имён в тексте ошибки: Task 6.
- Два параллельных вызова записи с одним токеном — запись одна: Task 7.
- Падение/отмена между «sending» и исходом → повторный вызов с тем же токеном только читает (`verifyOnly`), никогда не шлёт: Task 7.
- Отмена клиента **после** точки невозврата не прерывает запись и не теряет исход в журнале: Tasks 1, 2, 7.
- `confirm: true` без токена, просроченный токен, токен после смены состояния цели — отказ до обращения к системе: Task 7.
- Диалог одноимённого файла: нажимается только «Перезаписать»: Task 9.

## Файловая структура

| Файл | Ответственность |
|---|---|
| `src/commit.ts` (новый) | константа `COMMIT_DEADLINE_MS = 20_000` |
| `src/resource.ts` | `cache: false`, `LoadContext.commit()`, разрешение `invalidates` до загрузки |
| `src/limiter.ts`, `src/auth/browser-session.ts` | продление аренды слота и `PageCallContext.commit()` |
| `src/fs-lock.ts` (новый) | lock-файл, повторы ввода-вывода, атомарная запись (вынесено из `changes/store.ts`) |
| `src/services/writes/types.ts` | общие типы записи |
| `src/services/writes/token.ts` | ключ, `previewToken`, `targetId` |
| `src/services/writes/journal.ts` | журнал записей |
| `src/services/writes/outbox.ts` | проверка файлов из папки «исходящих» |
| `src/services/writes/runner.ts` | `defineWrite`: протокол сухой прогон/запись/повтор |
| `src/services/lms/submissions.ts` (новый) | чтение страницы задания, адаптеры `submit` и `delete` |
| `src/services/lms/tools.ts` | тулы `lms_submit_assignment`, `lms_delete_submission` |
| `src/url-utils.ts`, `lms/client.ts`, `elk/client.ts` | усиление `*_open_page` |
| `src/config.ts`, `.env.example` | `outboxDir` / `HSE_OUTBOX_DIR` |
| `src/services/elk/certificate.ts`, `elk/tools.ts` | `elk_order_certificate` (фаза C, за воротами) |
| `scripts/verify/*.mjs` (новые) | постоянные проверки чистой логики: `resource`, `fs-lock`, `token`, `journal`, `outbox`, `runner`, `open-page` |

## Среда для проверок

Скрипты `verify-<N>.mjs` в тексте задач — это либо **постоянные** скрипты в `scripts/verify/`, либо одноразовые в каталоге scratchpad сессии. Соответствие постоянных: `verify-1` → `scripts/verify/resource.mjs`, `verify-3` → `fs-lock.mjs`, `verify-4` → `token.mjs`, `verify-5` → `journal.mjs`, `verify-6` → `outbox.mjs`, `verify-7` → `runner.mjs`, `verify-11` → `open-page.mjs`; их файл добавляется в коммит Step 5 своей задачи (`git add scripts/verify/<имя>.mjs`). Остальные `verify-N` (2, 8, 9, 10, 14, 15, 16) — одноразовые.

Оба вида скриптов импортируют собранные модули без личных путей: `const m = await import(new URL("../../dist/resource.js", import.meta.url).href)` (для постоянных; одноразовые, лежащие вне репозитория, берут корень репозитория из аргумента или `process.env.HSEMCP_ROOT`), печатают `OK <что проверено>` на каждое утверждение, при первом провале — `throw`. Запуск: `npm run build && node scripts/verify/<имя>.mjs` (или путь к одноразовому), ожидание — все `OK` и код выхода 0. Временные каталоги (`os.tmpdir()`) скрипты создают и убирают сами.

## Процесс исполнения (навыки superpowers)

Правило `using-superpowers`: если навык подходит хоть на 1%, его вызывают **до** действия и объявляют («Использую <навык>, чтобы …»). Для этого плана:

| Навык | Когда | Что это значит здесь |
|---|---|---|
| `subagent-driven-development` | всё исполнение | выбран владельцем: свежий подагент на задачу, затем свежий ревьюер, затем итоговое ревью ветки. Реализаторы работают **последовательно**: общий `dist/` при параллельной сборке портится |
| `using-git-worktrees` | старт | новый worktree **не создавать**: работа идёт в `C:\Users\alexk\hsemcp\.claude\worktrees\4`, ветка `worktree-4` от `master` |
| `verification-before-completion` | перед каждым «готово», коммитом и любым утверждением об успехе | запустить команду проверки задачи (`npm run build` и её `verify-N.mjs`) и привести **фактический вывод**; без вывода задача не закрыта. Для живых шагов доказательство — прочитанное состояние страницы, а не «клик прошёл» |
| `requesting-code-review` | после каждой задачи и один раз по всей ветке | ревьюеру передать спеку и этот план; в фокусе — раздел «Review Focus», безопасность записи (подмена данных между показом и отправкой, дубль после обрыва, утечка содержимого в журнал/stderr) |
| `receiving-code-review` | на каждое замечание ревьюера | проверить замечание технически (воспроизвести или опровергнуть), не принимать вслепую и не отклонять без причины; спорное решение — владельцу |
| `systematic-debugging` | провал проверки, неожиданный ответ Moodle/ЕЛК, отказ клиента | сначала причина, потом правка; в живых шагах — остановиться и разобраться, а не повторять цепочку (урок третьего прохода, спека §17: скрипт с повторными кликами открыл 8 диалогов) |
| `finishing-a-development-branch` | после Task 13 (и Task 16, если фаза C выполнена) — Task 17 | сборка чистая, итоговое ревью пройдено → предложить владельцу варианты завершения ветки; слияние и push — только по его слову |
| `dispatching-parallel-agents` | только для **читающих** независимых работ | например, параллельное ревью разных файлов; не для реализаторов (общий `dist/`, общий worktree) |
| `executing-plans` | не используется | альтернатива `subagent-driven-development`, владелец выбрал последнюю |
| `test-driven-development` | **применяется в облегчённом виде** | тестового фреймворка и линтера в проекте нет (решение владельца, `CLAUDE.md`), поэтому без раннера и зависимостей; дисциплину «сначала проверка, затем код» сохраняют шаги 1–2 каждой задачи — скрипт пишется и падает **до** реализации, а скрипты чистой логики остаются в `scripts/verify/` как повторяемая регрессионная проверка для следующего пользователя |
| `brainstorming`, `writing-plans` | уже выполнены | спека одобрена 2026-10-18; при росте объёма — остановиться и вернуться к владельцу |

Остальные навыки списка (`writing-skills`, `skill-creator`, `build-mcp-*`) к этой работе не относятся.

---

### Task 0: Окружение

**Files:** нет изменений в коде.

- [ ] **Step 1:** В корне worktree выполнить `npm ci`. Ожидание: установка без ошибок; `node_modules/@modelcontextprotocol/sdk/package.json` версии 1.30.0.
- [ ] **Step 2:** `npm run build`. Ожидание: код 0 на неизменённом коде (базовая линия).
- [ ] **Step 3:** Убедиться, что `storage/outbox/test.txt` (содержимое `test\n`) и `storage/outbox/edit/test.txt` (`test edited\n`) существуют; если нет — создать (папка в `.gitignore`).

---

### Task 1: `resource.ts` — режим «не кэшировать», `commit()`, `invalidates` до загрузки

**Files:**
- Create: `src/commit.ts`
- Modify: `src/resource.ts`

**Interfaces:**
- Produces:
  - `src/commit.ts`: `export const COMMIT_DEADLINE_MS = 20_000;`
  - `LoadContext { signal: AbortSignal; commit(deadlineMs?: number): void }`
  - `ResourceDef` получает `cache?: true`; новый `WriteResourceDef<A, Raw, R = Raw> extends Omit<ResourceDef<A, Raw, R>, "ttl" | "key" | "cache"> { cache: false }`; `defineResource` перегружен: `defineResource(def: WriteResourceDef<…>)` и существующий.

Поведение (спека §4.1, п. 1–5):
1. Имена из `invalidates` разрешаются **в начале каждого вызова**, до `load`; неизвестное имя → отклонение `invalidateResource: неизвестный ресурс "<имя>"`, `load` не вызывается. Для кэшируемых ресурсов то же (прежнее поведение инвалидации после успешной загрузки не меняется).
2. `cache: false`: нет `cached()`, нет дедупликации параллельных вызовов, нет записи в кэш и `generation++` от собственной записи.
3. `ctx.commit(deadlineMs?)`: гасит исходный дедлайн загрузки и взводит новый (`deadlineMs ?? COMMIT_DEADLINE_MS` от момента вызова; повторный вызов взводит заново); по его истечении вызов отклоняется `${def.name} не уложился в N с после точки невозврата` и `ctx.signal` срабатывает. После `commit()` `opts.signal` вызывающего (`detach`) игнорируется — вызов дожидается конца загрузки.
4. `invalidates` для `cache: false` выполняется в `finally` **только если был вызван `commit()`** (при любом исходе загрузки).

- [ ] **Step 1: Написать `scripts/verify/resource.mjs`** (постоянный; утверждения):
  `defineResource({ name:"t.a", ttl:1000, key:()=>"k", load, invalidates:["no.such"] })` → вызов реджектится, `load.calls === 0`;
  два параллельных вызова `cache:false`-ресурса → `load.calls === 2`; два последовательных с `maxAgeMs` → `load.calls === 4` (не кэшируется);
  `cache:false` + `invalidates:["t.read"]`: загрузчик вызывает `ctx.commit()` и бросает → `invalidateResource("t.read")` сработал (шпион на `listResources`-ресурсе: следующий вызов `t.read` снова вызывает `load`); загрузчик бросает **до** `commit()` → `t.read` остался в кэше;
  `commit(50)` после «долгой» работы 200 мс → отклонение с текстом «после точки невозврата»; без `commit()` с `deadlineMs: 50` и работой 200 мс → отклонение «не уложился»;
  `AbortController.abort()` вызывающего **после** `commit()` → вызов всё равно резолвится значением загрузчика; **до** `commit()` → реджектится причиной отмены;
  прежний кэшируемый ресурс: два параллельных вызова → `load.calls === 1`, результат заморожен (`Object.isFrozen`).
- [ ] **Step 2:** `npm run build && node scripts/verify/resource.mjs`. Ожидание до реализации: провал на первом утверждении.
- [ ] **Step 3: Реализовать** в `src/resource.ts`: общий объект состояния вызова `{ committed: boolean }`; `loadWithDeadline` принимает `ctx` с `commit` и управляет таймером; `detach(promise, signal, state)` игнорирует abort при `state.committed`; разрешение имён — функция `resolveInvalidates(names): void` (бросает), вызывается в начале замыкания вызова.
- [ ] **Step 4:** `npm run build && node scripts/verify/resource.mjs`. Ожидание: все `OK`.
- [ ] **Step 5: Commit** — `git add src/commit.ts src/resource.ts scripts/verify/resource.mjs && git commit` (`Resources: cache:false mode, commit() point of no return, resolve invalidates before load`).

---

### Task 2: `withPage` — `commit()` и продление аренды слота

**Files:**
- Modify: `src/limiter.ts`, `src/auth/browser-session.ts`

**Interfaces:**
- Consumes: `COMMIT_DEADLINE_MS` из `src/commit.ts`.
- Produces:
  - `limiter.ts`: `export type PageSlotRelease = (() => void) & { extendLease(ms: number): void }`; `acquirePageSlot(opts): Promise<PageSlotRelease>` (поведение прежнее, плюс продление: перезапуск таймера аренды на `ms`).
  - `browser-session.ts`: `PageCallContext { signal: AbortSignal; commit(deadlineMs?: number): void }`.

Поведение (спека §4.3, §6): `commit()` внутри `fn` гасит исходный таймер дедлайна страницы и снимает слушатель внешнего `signal`; взводит таймер `deadlineMs ?? COMMIT_DEADLINE_MS` (повторный вызов — заново); по его истечении страница закрывается и вызов отклоняется «не уложилась … после точки невозврата»; `release.extendLease(ms + LEASE_GRACE_MS)`. Без вызова `commit()` поведение `withPage` не меняется. Вложенный `withPage` по-прежнему запрещён.

- [ ] **Step 1: Написать `verify-2.mjs`** (нужен Chromium; страница — `data:text/html,<body>ok</body>`; перед импортом `dotenv.config` не обязателен, вход не нужен):
  внешний `AbortController.abort()` до `commit()` → `withPage` реджектится, страница закрыта (`page.isClosed()` из замыкания);
  abort **после** `commit()` → `withPage` резолвится результатом `fn` (работа 300 мс);
  `commit(100)` и работа 500 мс → реджект «после точки невозврата», слот возвращён (следующий `withPage` не ждёт);
  без `commit()` с `deadlineMs: 100` и работой 500 мс → реджект как раньше;
  `acquirePageSlot` из `limiter.js`: `release.extendLease` существует и `release()` идемпотентен.
- [ ] **Step 2:** `npm run build && node …/verify-2.mjs` до реализации — провал (`commit` не функция).
- [ ] **Step 3: Реализовать** `PageSlotRelease` в `limiter.ts` (хранить `lease` в замыкании, `extendLease` пересоздаёт таймер) и `commit` в `withPage` (таймер `commitTimer`, очистка в `finally`).
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`withPage: commit() point of no return, lease extension`).

---

### Task 3: Вынос блокировки и атомарной записи в `src/fs-lock.ts`

**Files:**
- Create: `src/fs-lock.ts`
- Modify: `src/services/changes/store.ts`

**Interfaces:**
- Produces: `sleep(ms)`, `errCode(err)`, `isBusy(code)`, `retryIo<T>(op: () => T): Promise<T>`, `withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T>` (внутрипроцессный мьютекс **на путь** + lock-файл `wx`, устаревшая блокировка > 30 с снимается, чужая не снимается — логика из `withFileLock`/`withStateLock`), `writeFileAtomic(file: string, text: string): Promise<void>` (tmp `<file>.<pid>.tmp` + `rename` с `retryIo`, режим `0o600`, `tmp` удаляется при ошибке).
- `changes/store.ts`: `withStateLock(dir, fn, opts)` теперь вызывает `withFileLock(path.join(dir, "state.json.lock"), fn, opts)`; его экспортируемые сигнатуры и поведение не меняются. `saveState` остаётся как есть (использует `retryIo`/`errCode`/`isBusy` из нового модуля).

- [ ] **Step 1: Написать `scripts/verify/fs-lock.mjs`** (постоянный): в `os.tmpdir()`: 20 параллельных `withFileLock(lock, …)` инкрементируют счётчик-файл (чтение → +1 → `writeFileAtomic`) → итог `20`; устаревшая блокировка (создать lock-файл и `fs.utimesSync` на 31 с назад) → вызов проходит; после `writeFileAtomic` рядом нет `*.tmp`; через `changes/store.js`: `withStateLock(dir, …)` ×10 с `loadState`/`saveState` не ломает `state.json` (повторно читается, `rev` не регрессирует).
- [ ] **Step 2:** запуск до реализации — провал (модуль не найден).
- [ ] **Step 3: Реализовать** вынос; поведение `store.ts` не менять. Если вынос ломает хоть одно утверждение про `changes` — вернуть `store.ts` к исходному, скопировать код в `fs-lock.ts` и записать долг в `CLAUDE.md` (спека §4.2).
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`Extract file lock and atomic write into src/fs-lock.ts`), включая `scripts/verify/fs-lock.mjs`.

---

### Task 4: Типы и `previewToken`

**Files:**
- Create: `src/services/writes/types.ts`, `src/services/writes/token.ts`

**Interfaces:**
- Produces (`types.ts`):
  `type Outcome = "confirmed" | "rejected" | "unknown"`;
  `type Stage = "sending" | "sent" | "verified"`;
  `type ErrorClass = "timeout" | "validation" | "network" | "auth" | "cancelled" | "other"`;
  `interface PreviewPayload { op: string; target: string; mode?: string; files: Array<{ name: string; sha256: string }>; state: string }`.
- Produces (`token.ts`):
  `PREVIEW_TTL_MS = 15 * 60_000`;
  `writesDir(): string` (`process.env.HSE_WRITES_DIR`, если задана — каталог для проверочных скриптов; иначе `<projectRoot>/storage/writes`; журнал и ключ по умолчанию берут каталог отсюда);
  `loadOrCreateKey(dir?: string): Promise<Buffer>` (32 случайных байта, файл `key` в hex, права `0o600`; при повторном вызове — тот же ключ);
  `signPreview(key: Buffer, p: PreviewPayload, now?: Date): string`;
  `type VerifyResult = { ok: true; tokenId: string; issuedAt: Date } | { ok: false; reason: "malformed" | "expired" | "mismatch" }`;
  `verifyPreview(key: Buffer, token: string, p: PreviewPayload, now?: Date): VerifyResult`;
  `tokenIdOf(token: string): string | null` (12 hex из хеш-части, `null` для мусора);
  `targetIdOf(key: Buffer, op: string, target: string): string`.
  Каноническая форма: JSON с отсортированными ключами; `files` сортируются по `name`.

- [ ] **Step 1: Написать `scripts/verify/token.mjs`** (постоянный):
  `verify(sign(p))` → `ok`, `tokenId` из 12 hex и `=== tokenIdOf(token)`;
  смена любого из `op`, `target`, `mode`, имени/sha256 файла, `state` → `mismatch`;
  токен для `op: "lms_submit_assignment"` с payload `op: "lms_delete_submission"` → `mismatch`;
  `now` + 16 мин → `expired`, + 14 мин → `ok`; `"garbage"`, `"1.zz"`, пустая строка → `malformed`;
  два `signPreview` с разным `now` дают разные токены;
  `loadOrCreateKey(tmp)` создаёт файл из 64 hex-символов, второй вызов возвращает равный `Buffer`;
  `targetIdOf` детерминирован, 12 hex, различается по `op` и по `target`.
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** `types.ts` и `token.ts` (сравнение хеша — `crypto.timingSafeEqual`).
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`Writes: shared types and HMAC previewToken`), включая `scripts/verify/token.mjs`.

---

### Task 5: Журнал записей

**Files:**
- Create: `src/services/writes/journal.ts`

**Interfaces:**
- Consumes: `withFileLock`, `writeFileAtomic` (Task 3); `Outcome`, `Stage`, `ErrorClass` (Task 4).
- Produces:
  `interface JournalEntry { at: string; op: string; tokenId: string; targetId: string; stage: Stage; outcome?: Outcome; durationMs?: number; errorClass?: ErrorClass }`;
  `JOURNAL_MAX_AGE_MS = 90 * 86_400_000`, `JOURNAL_MAX_ENTRIES = 200`;
  `recordJournal(entry: JournalEntry, dir?: string, now?: Date): Promise<void>` (добавление под lock-файлом, срез по возрасту и числу, атомарная запись; запрещённые поля не пишутся — копируются только перечисленные);
  `latestByToken(tokenId: string, dir?: string): Promise<JournalEntry | undefined>`;
  `findUnresolvedByTarget(targetId: string, dir?: string, exceptTokenId?: string): Promise<JournalEntry[]>` (по каждому `tokenId` берётся последняя запись; «не разрешено» = `stage` не `verified` либо `outcome === "unknown"`).

- [ ] **Step 1: Написать `scripts/verify/journal.mjs`** (постоянный; каталог — временный, через `HSE_WRITES_DIR`): запись `sending` затем `verified/confirmed` одного токена → `latestByToken` вернул `verified`; `sending` без исхода и `verified/unknown` → в `findUnresolvedByTarget`, `confirmed` — нет, `exceptTokenId` исключает; 201 запись → в файле 200, старейшая срезана; запись с `at` 91 день назад срезается; запись, в которую передали лишнее поле (`text`, `name`), в файле **не** содержит его (ключи JSON ⊆ `at, op, tokenId, targetId, stage, outcome, durationMs, errorClass`); 10 параллельных `recordJournal` → 10 записей, файл валиден; повреждённый JSON → не падает, начинается пустой журнал (старый файл переименован `journal.json.corrupt-<ts>`).
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** `journal.ts`.
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`Writes: journal`), включая `scripts/verify/journal.mjs`.

---

### Task 6: Папка «исходящих» и `config.outboxDir`

**Files:**
- Create: `src/services/writes/outbox.ts`
- Modify: `src/config.ts`, `.env.example`

**Interfaces:**
- Produces:
  `config.outboxDir: string` (геттер: `process.env.HSE_OUTBOX_DIR` — абсолютный или относительно `projectRoot` — иначе `<projectRoot>/storage/outbox`);
  `interface OutboxFile { name: string; absPath: string; size: number; sha256: string }`;
  `resolveOutboxFiles(names: string[], opts?: { dir?: string; maxFiles?: number; maxBytes?: number }): Promise<OutboxFile[]>` — `maxFiles` по умолчанию 10. Отказ (`Error`, текст **без имён файлов**, только «файл №N» и причина): пустой список, больше `maxFiles`, дубликаты имён, имя пустое/`.`/`..`/содержит `/`, `\`, `:`, `realpath` вне папки (симлинк/junction), не обычный файл, размер 0, размер больше `maxBytes`.
- `.env.example`: закомментированная необязательная `HSE_OUTBOX_DIR`.

- [ ] **Step 1: Написать `scripts/verify/outbox.mjs`** (постоянный) (временная папка с файлами `a.txt` (5 байт), `empty.txt` (0 байт), `big.bin` (2 Кбайт), подпапка `sub/`, симлинк/junction на внешний файл — если создать нельзя без прав, утверждение пропускается с пометкой `SKIP`): корректные имена → `OutboxFile[]` с верным `size` и `sha256` (сверить с `crypto`); `["..\\x"]`, `["../x"]`, `["C:\\x.txt"]`, `["a/b.txt"]`, `["a:b"]`, `[""]`, `["."]`, `["sub"]`, `["empty.txt"]`, `["missing.txt"]`, `["a.txt","a.txt"]`, 11 имён, `maxBytes: 1024` и `big.bin`, симлинк наружу — каждый отказ бросает, и `err.message` **не содержит** подстроки из имени файла.
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** `outbox.ts` и геттер `outboxDir`; дописать `.env.example`.
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`Writes: outbox folder validation, HSE_OUTBOX_DIR`), включая `scripts/verify/outbox.mjs`.

---

### Task 7: Раннер протокола `defineWrite`

**Files:**
- Create: `src/services/writes/runner.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`defineResource` с `cache: false` и `ctx.commit`, `PageCallContext`, токен, журнал).
- Produces (все экспортируются из `runner.ts`):

```ts
export interface WriteInput { confirm?: boolean; previewToken?: string; acknowledgeUnknown?: boolean }
export interface PreviewResponse { stage: "preview"; previewToken: string; expiresAt: string; preview: unknown; warnings: string[]; priorUnknown: boolean }
export interface ExecuteResult { stage: "verified" | "draft-saved" | "sent"; outcome: Outcome; evidence: Record<string, unknown>; warnings: string[] }
export interface WriteResponse extends ExecuteResult { sent: boolean }
export type CommitPoint = (pageCtx: PageCallContext) => Promise<void>;
export interface ExecuteContext { signal: AbortSignal; commitPoint: CommitPoint }
export interface WriteAdapter<A extends object, Obs> {
  op: string;
  invalidates: string[];
  targetOf(args: A): string;
  observe(args: A, signal?: AbortSignal): Promise<Obs>;                 // только чтение; бросает при невыполненных предусловиях
  describe(args: A, observed: Obs): { preview: unknown; warnings: string[] };
  payloadOf(args: A, observed: Obs): Pick<PreviewPayload, "mode" | "files" | "state">;
  execute(args: A, observed: Obs, ctx: ExecuteContext): Promise<ExecuteResult>;
  verifyOnly(args: A, signal?: AbortSignal): Promise<{ outcome: Outcome; evidence: Record<string, unknown>; warnings: string[] }>;
}
export function defineWrite<A extends object, Obs>(adapter: WriteAdapter<A, Obs>): (args: A & WriteInput, signal?: AbortSignal) => Promise<PreviewResponse | WriteResponse>;
export function classifyError(err: unknown): ErrorClass;
```

Поведение (спека §5–§8):
1. Без `confirm` (или `false`): `observe` → `payloadOf` → токен; в ответе `priorUnknown` = есть ли `findUnresolvedByTarget(targetId)`; журнал не трогается.
2. `confirm: true` без `previewToken` → `Error("confirm требует previewToken: сначала выполните сухой прогон; ничего не отправлено")`.
3. Запись выполняется в общей очереди «по одной» (`runExclusive`); второй одновременный вызов с тем же токеном получает ответ из журнала/`unknown`, а не вторую запись.
4. Повтор: если `latestByToken(tokenIdOf(token))` есть — токен не проверяется на HMAC/состояние (путь только читающий): `confirmed`/`rejected` в журнале → вернуть записанное (`evidence: { fromJournal: true }`, `sent: outcome === "confirmed"`); иначе (`sending`/`sent`/`unknown`) → `adapter.verifyOnly`, дописать исход в журнал, вернуть результат; `execute` **не вызывается**.
5. Новая запись: `observe` заново → `verifyPreview` (расхождение/просрочка → `Error` «…; ничего не отправлено»); если `findUnresolvedByTarget(targetId, undefined, tokenId)` не пусто и нет `acknowledgeUnknown: true` → `Error` с просьбой повторить с `acknowledgeUnknown: true` после проверки.
6. `execute` идёт через `defineResource({ name: "writes.<op>", cache: false, invalidates: adapter.invalidates, load })`. `commitPoint(pageCtx)`: `recordJournal` стадия `sending` → `ctx.commit()` ресурса → `pageCtx.commit()`; вызывается адаптером перед каждым необратимым действием.
7. Исключение из `execute` **до** первого `commitPoint` → пробросить (`isError`, ничего не отправлено, журнал не трогается). **После** → не пробрасывать: `outcome: "unknown"`, `errorClass: classifyError(err)` в журнал, ответ `stage: "sent"`, `sent: true`, предупреждение «повторять отправку без проверки запрещено».
8. После `execute`: `recordJournal` стадия `verified` с `outcome`, `durationMs`.

- [ ] **Step 1: Написать `scripts/verify/runner.mjs`** (постоянный, без сети и браузера) с фейковым адаптером (в памяти; счётчики `observe`/`execute`/`verifyOnly`; «система» — переменная; `execute` вызывает `await ctx.commitPoint({ signal, commit(){} })`; `invalidates: ["t.read"]` с зарегистрированным ресурсом-шпионом; журнал и ключ — во временном каталоге через `process.env.HSE_WRITES_DIR`, заданный скриптом до импорта):
  a. сухой прогон → `previewToken`, `execute.calls === 0`, журнал пуст; `confirm` без токена → бросает, `observe` не доходит до `execute`; confirm с токеном от другого payload (изменено `args`) → бросает, `execute.calls === 0`;
  b. счастливый путь → `outcome: "confirmed"`, `sent: true`; журнал: `sending`, затем `verified`/`confirmed`; `t.read` сброшен;
  c. тот же токен ещё раз → ответ из журнала, `execute.calls` остаётся 1;
  d. `execute` бросает после `commitPoint` → результат `unknown` без исключения; тот же токен снова → `verifyOnly.calls === 1`, `execute.calls` не растёт;
  e. `execute` бросает до `commitPoint` → исключение, журнал без новых записей;
  f. `AbortController.abort()` до `commitPoint` → бросает; abort **после** `commitPoint` (работа 200 мс) → ответ приходит, исход в журнале;
  g. два параллельных `confirm` с одним токеном → `execute.calls === 1`;
  h. после (d) новый сухой прогон той же цели → `priorUnknown: true`; запись без `acknowledgeUnknown` → бросает; с `acknowledgeUnknown: true` → проходит;
  i. токен просрочен (выпустить напрямую `signPreview(key, p, new Date(Date.now() - 16 * 60_000))`) → бросает «просрочен»;
  j. файл журнала: ключи записей ⊆ разрешённых, строка `target` из `targetOf` в файле **не встречается**.
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** `runner.ts`, `runExclusive`, `classifyError` (`AbortError`/сообщения «не уложил» → `timeout`; `отменен` → `cancelled`; `net::`/`ERR_`/`fetch` → `network`; 401/вход → `auth`; иначе `other`).
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`Writes: protocol runner defineWrite`), включая `scripts/verify/runner.mjs`.

---

### Task 8: LMS — чтение страницы задания и сухой прогон

**Files:**
- Create: `src/services/lms/submissions.ts`

**Interfaces:**
- Consumes: `withPage` (Task 2), `resolveOutboxFiles` (Task 6), `WriteAdapter` (Task 7), `sha256` помощник из `node:crypto`.
- Produces:

```ts
export interface AssignmentView {
  cmid: number; title: string;
  state: "none" | "submitted" | "draft" | "unknown";
  closed: { reason: "offsite" | "overdue" | "not-open" | "other"; text: string } | null;
  canAdd: boolean; canEdit: boolean; canDelete: boolean; canFinalize: boolean;
  dueText: string | null; lastModified: string | null;
  files: Array<{ name: string; size: number; sha256: string }>;
}
export interface EditFormInfo { fileOnly: boolean; maxBytes: number | null; maxFiles: number | null; managerFiles: string[] }
export function readAssignmentView(page: Page, cmid: number): Promise<AssignmentView>;   // страница уже на view.php?id=<cmid>
export function readEditFormInfo(page: Page): Promise<EditFormInfo>;                    // страница на action=editsubmission
export interface SubmitArgs { cmid: number; mode: "draft" | "submit"; files: string[]; text?: string }
export interface DeleteArgs { cmid: number }
export const submitAdapter: WriteAdapter<SubmitArgs, SubmitObserved>;
export const deleteAdapter: WriteAdapter<DeleteArgs, DeleteObserved>;
```
(`SubmitObserved`/`DeleteObserved` — внутренние типы модуля: `AssignmentView` + при отправке `EditFormInfo` + `OutboxFile[]`.)

Правила разбора (спека §17, все селекторы и тексты оттуда): статус — по классам ячейки `submissionstatussubmitted` / `submissiondraft`, пусто → `none`; «Состояние ответа на задание» с текстом «представлен вне сайта» → `closed.reason: "offsite"`, «Задание просрочено на» → `overdue`, «Открыто с» в будущем → `not-open`; кнопки на странице статуса: `button` с текстами «Добавить ответ на задание», «Редактировать ответ», «Удалить ответ», «Отправить на оценку»; файлы — `.fileuploadsubmission a[href*="pluginfile"]`, байты читаются `fetch` внутри страницы, sha256 считается в Node. Лимиты и «только файл» — на форме правки (`Максимальный размер новых файлов: N Мбайт, максимальное количество прикрепленных файлов: M`; нет текстового редактора). Читающая часть адаптеров (`targetOf` = `assign:<cmid>`, `observe`, `describe`, `payloadOf`) реализуется здесь; `execute`/`verifyOnly` — Task 9.

Предусловия `observe` для `submit` (отказ до записи, сообщения без имён файлов): задан `text` → «онлайн-текст в v1 не поддерживается»; `files` пуст при `mode: "submit"` → «отправка без файлов не поддерживается»; `closed` не `null` → причина из `closed.reason`; не `canAdd` и не `canEdit` → «нельзя добавить или править ответ»; форма не «только файл»; число файлов (существующие + новые, уникальные по имени) > `maxFiles`; файл > `maxBytes`. `payloadOf.state` — sha256 от JSON `{state, files}`. `describe` показывает владельцу: заголовок, срок, состояние, что будет заменено/добавлено (имена, размеры), предупреждения: «сохранение может сразу отправить работу на оценку (у проверенных заданий отдельного шага нет)», «форма правки открывалась и не сохранялась». Для `delete`: `observe` требует `canDelete`; `describe` — состояние, имена и размеры файлов, предупреждение о необратимости удаления содержимого в системе; `state` — тот же отпечаток.

- [ ] **Step 1: Написать `verify-8.mjs`** — разбор на сохранённых HTML-фрагментах: функции разбора вынести так, чтобы их можно было вызвать на `page.setContent(html)` (Chromium); фрагменты собираются в скрипте из подписей спеки §17 (строки таблицы статуса с классами, кнопки, `fileuploadsubmission`, подпись лимитов). Утверждения: `none` без классов с кнопкой «Добавить…» → `canAdd`; `submissionstatussubmitted` + «Редактировать»/«Удалить» → `canEdit`/`canDelete`, `state: "submitted"`; без кнопок + «вне сайта» → `closed.reason: "offsite"`; «просрочено на: 12 дн.» → `overdue`; лимиты «5 Мбайт … 20» → `maxBytes: 5*1024*1024`, `maxFiles: 20`; форма без `.filemanager` → `fileOnly: false`. Отдельно, на живых данных (только чтение, **с владельцем**, Task 13): `submitAdapter.observe` для `cmid` тестового задания даёт `state: "none"`, `describe` не пустой.
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** читающую часть; `execute`/`verifyOnly` пока бросают «не реализовано» (адаптеры не регистрируются в тулах до Task 10).
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`LMS: read assignment status and edit form, dry-run adapters`).

---

### Task 9: LMS — запись: сдача/правка и удаление

**Files:**
- Modify: `src/services/lms/submissions.ts`

**Interfaces:**
- Consumes: Task 7 (`ExecuteContext`, `CommitPoint`), Task 8.
- Produces: рабочие `submitAdapter.execute/verifyOnly`, `deleteAdapter.execute/verifyOnly`; `invalidates` у обоих: `["lms.assignments", "lms.calendar"]`.

Последовательность `submit.execute` (покадрово, спека §17, 4-й и 6-й проходы; **каждый шаг проверяется, первое расхождение — выброс до точки невозврата**): `withPage("…/mod/assign/view.php?id=<cmid>&action=editsubmission")` → заново `readEditFormInfo`, предусловия как в `observe`; **для каждого файла отдельно**: ровно один клик `a[title="Добавить..."]`, проверка активной вкладки «Загрузить файл», `setInputFiles` на `.fp-upload-form input[name="repo_upload_file"]` (поле одно), один клик `.fp-upload-form .fp-upload-btn`; если появился диалог одноимённого файла — клик **только** `button:visible:has-text("Перезаписать")` (иначе выброс), ожидание закрытия пикера; перед точкой невозврата: имена в `.fp-filename` равны ожидаемому множеству (существующие ∪ новые), `.fp-folder` нет, ошибок пикера нет; затем `await ctx.commitPoint(pageCtx)` и один клик `input[name="submitbutton"]`; ожидание URL `action=view` (в пределах дедлайна коммита); чтение `readAssignmentView`; проверка по §7: имена на месте, sha256 каждого присланного файла равен sha256 скачанного, `state` по `mode`. Итоги: `mode: "draft"` и `state: "submitted"` → `outcome: "confirmed"` + предупреждение «работа отправлена на оценку сразу при сохранении»; `mode: "submit"` и `state: "draft"` → `outcome: "unknown"`, `stage: "draft-saved"`; расхождение файлов → `rejected` только при явной ошибке Moodle (`.alert-danger`/`.moodle-exception-message`) и неизменном состоянии, иначе `unknown`. `verifyOnly` — читает страницу и сравнивает с ожидаемым по присланным файлам тем же способом.

`delete.execute`: `withPage(view.php?id=<cmid>)` → один клик `button:has-text("Удалить ответ")` → проверить URL содержит `action=removesubmissionconfirm` и на странице «Вы уверены, что хотите удалить представленный ответ» → `commitPoint` → один клик `button:has-text("Продолжить")` → дождаться `action=view` → `readAssignmentView`: `state === "none"` и `canAdd` → `confirmed`; явная ошибка и состояние не изменилось → `rejected`; иначе `unknown`. `verifyOnly` — то же чтение.

- [ ] **Step 1: Написать `verify-9.mjs`** — без записи в реальную систему: подставить `page`-двойник (Playwright `page.route` отдаёт HTML-заготовки для `view.php`, `editsubmission`, `removesubmissionconfirm`, а POST «Сохранить»/«Продолжить» меняет состояние заготовки и отвечает редиректом на `action=view`) и вызвать `execute` напрямую с `ctx = { signal, commitPoint: spy }`. Утверждения: порядок вызовов: `commitPoint` ровно один раз и строго после проверки списка менеджера и до клика «Сохранить»; при лишнем элементе в менеджере (`.fp-folder`) — выброс **до** `commitPoint`; диалог одноимённого файла → нажат «Перезаписать», кнопка «Переименовать» ни разу не кликнута (счётчик кликов на заготовке); после сохранения `state: "submitted"` при `mode: "draft"` → `confirmed` + предупреждение; несовпадение sha256 → не `confirmed`; удаление: `commitPoint` после страницы подтверждения и до «Продолжить», итог `confirmed` при `state: "none"`.
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** запись в `submissions.ts`; помощники шагов (`attachFile`, `assertManagerState`, `clickOnce`) — внутри модуля.
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`LMS: submit, edit and delete submission via file manager flow`).

---

### Task 10: Регистрация тулов LMS

**Files:**
- Modify: `src/services/lms/tools.ts`

**Interfaces:**
- Consumes: `defineWrite` (Task 7), `submitAdapter`/`deleteAdapter` (Tasks 8–9).
- Produces: тулы `lms_submit_assignment` и `lms_delete_submission` (регистрация уже вызывается из `src/index.ts`; `index.ts` не меняется).

Схемы входа (`zod`): `lms_submit_assignment` — `cmid: number().int().positive()`, `mode: enum(["draft","submit"]).default("draft")`, `files: array(string().min(1).max(255)).min(1).max(10)`, `text: string().max(100_000).optional()` (при передаче — отказ), `confirm: boolean().optional()`, `previewToken: string().max(200).optional()`, `acknowledgeUnknown: boolean().optional()`. `lms_delete_submission` — `cmid`, `confirm`, `previewToken`, `acknowledgeUnknown`. Оба с `annotations` из Global Constraints и описанием в стиле `hse_changes`: сухой прогон по умолчанию; `confirm` и `previewToken` обязательны для записи; сохранение может сразу отправить работу; исход `confirmed`/`rejected`/`unknown` и запрет автоповтора после `unknown`; файлы только из папки «исходящих» по имени; клиент спросит разрешение на вызов; онлайн-текст не поддерживается. Тела: `runTool((signal) => write(args, signal), extra.signal)`.

- [ ] **Step 1: Написать `verify-10.mjs`:** поднять `McpServer` из `dist` с `registerLmsTools`, вызвать `server.server`-уровневый `tools/list` через внутренний транспорт-пару (`InMemoryTransport` из SDK) и проверить: оба тула есть; `annotations.destructiveHint === true`, `readOnlyHint === false`; схема `lms_submit_assignment` требует `cmid` и `files`; вызов без `files` → ошибка валидации; вызов `text: "x"` → `isError: true` с текстом про онлайн-текст, **без обращения к сети** (отказ до `observe`: проверка предусловия «text» делается раньше любой навигации).
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** регистрацию.
- [ ] **Step 4:** `npm run build && node …/verify-10.mjs` — все `OK`.
- [ ] **Step 5: Commit** (`LMS: register lms_submit_assignment and lms_delete_submission`).

---

### Task 11: Усиление `*_open_page`

**Files:**
- Modify: `src/url-utils.ts`, `src/services/lms/client.ts`, `src/services/elk/client.ts`

**Interfaces:**
- Produces: `assertReadOnlyPath(url: string): void` в `url-utils.ts` — бросает `Error` при `sesskey=` в query (без учёта регистра) и, для путей `/mod/assign/`, при параметре `action=` (кроме пустого). `lms.openPage` и `elk.openPage` вызывают его на результате `resolveScopedUrl`.

- [ ] **Step 1: Написать `scripts/verify/open-page.mjs`** (постоянный): разрешены `/calendar/view.php?view=month`, `/mod/assign/view.php?id=5`; отклонены `/login/logout.php?sesskey=abc`, `/x?SESSKEY=1`, `/mod/assign/view.php?id=5&action=editsubmission`, `/mod/assign/view.php?id=5&action=removesubmissionconfirm`; существующий `resolveScopedUrl` для внешнего хоста по-прежнему бросает.
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** и подключить в обе `openPage`.
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`open_page: reject sesskey and assign action URLs`), включая `scripts/verify/open-page.mjs`.

---

### Task 12: Документация фазы A–B

**Files:**
- Modify: `docs/requirements.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1:** `docs/requirements.md`: перенести «Сдача домашних заданий» из «Запланировано» в реализованное; добавить нефункциональные требования записи (протокол, журнал, папка «исходящих», точка невозврата) и в «Требования к безопасности» — что присутствие обеспечивает запрос разрешения клиента, а не сервер.
- [ ] **Step 2:** `CLAUDE.md`: абзац о сервисе записи (`services/writes/`, `cache: false`, `commit()`, `defineWrite`), снять «LMS/ЕЛК только для чтения» из известных ограничений для LMS, добавить в «Известные ограничения» «онлайн-текст не поддерживается; у заданий без отдельного шага сохранение сразу отправляет работу».
- [ ] **Step 3:** `README.md`: два новых тула, `HSE_OUTBOX_DIR`, правила использования.
- [ ] **Step 4:** `npm run build` — код 0. **Commit** (`Docs: write operations (LMS submit/edit/delete)`).

---

### Task 13: Живая проверка LMS (**только с владельцем**)

**Files:** запись результатов в спеку §17 (новый проход) и `docs/recon.md`.

Порядок строго по §12 спеки. Перед каждым шагом спросить владельца и дождаться «да» именно на этот шаг; на каждый отказ клиента — остановиться и спросить, не обходить.

- [ ] **Step 1:** пересобрать и перезапустить подключённый `hsemcp` (владелец) из актуального кода; убедиться, что новые тулы видны.
- [ ] **Step 2: сухой прогон** `lms_submit_assignment` на тестовом задании (`cmid` указывает владелец; кандидаты — задания без срока из §17) с `files: ["test.txt"]`. Ожидание: `stage: "preview"`, `previewToken`, предупреждения о немедленной отправке; **в системе ничего не изменилось** (статус до и после совпал).
- [ ] **Step 3:** `confirm` с токеном, изменив `files` на другой файл → отказ «изменились данные», без записи.
- [ ] **Step 4: запись** (`confirm: true` + токен, **отдельное разрешение владельца**): ожидание `outcome: "confirmed"`, `sent: true`, `evidence` совпадает со страницей статуса; повтор с тем же токеном → ответ из журнала, вторая запись не выполнена; журнал `storage/writes/journal.json` не содержит имён и id.
- [ ] **Step 5: правка** (тот же `cmid`, `files: ["test.txt"]` при том, что содержимое `storage/outbox/test.txt` заменено на `test edited` — с отдельным разрешением владельца; после проверки вернуть `test\n`): `confirmed`, sha256 скачанного файла совпал с локальным, предупреждение о замене одноимённого файла показано в сухом прогоне.
- [ ] **Step 6: удаление** `lms_delete_submission` (сухой прогон, затем `confirm` + токен, отдельное разрешение): `confirmed`, задание в исходном состоянии.
- [ ] **Step 7:** записать результаты проходом в спеку §17; **Commit** (`Spec: live verification of write tools`).

---

## Фаза C — `elk_order_certificate` (ворота)

> **Ворота:** фаза начинается только после явного «да» владельца на старт; живой заказ справки необратим и выполняется только по отдельному разрешению на эту операцию. До этого допустимы только Tasks 14–16 с сухим прогоном.

### Task 14: ЕЛК — чтение формы и сухой прогон

**Files:**
- Create: `src/services/elk/certificate.ts`

**Interfaces:**
- Consumes: `withPage`, `listRequests` (`elk/client.ts`, `maxAgeMs: 0`), `WriteAdapter`.
- Produces: `interface CertificateArgs { serviceId: number; fields: Record<string, string> }` (подпись поля → текст варианта); `readCertificateForm(page: Page): Promise<{ title: string; fields: Array<{ label: string; required: boolean; kind: "select" | "input"; options: string[] }> }>` (страница `https://lk.hse.ru/student-service/student-service-first?components=<serviceId>`; поля Element Plus — клик по обёртке выпадающего списка, варианты `.el-select-dropdown__item`, закрытие `Escape`; **ничего не отправляется**); `certificateAdapter: WriteAdapter<CertificateArgs, CertificateObserved>`.

Правила: `observe` читает форму и снимок множества номеров заявок (`listRequests({ maxAgeMs: 0 })`, только в памяти) → отпечаток состояния = sha256 набора номеров; предусловия: все обязательные `fields` заданы значениями из `options`, лишних подписей нет; `describe` показывает поля, варианты, незаполненные обязательные и предупреждение «заказ необратим: способа отмены в ЕЛК нет»; автозаполненные значения показываются **только** владельцу в ответе. `targetOf` = `service:<serviceId>`.

- [ ] **Step 1: Написать `verify-14.mjs`** — на HTML-заготовке формы (разметка Element Plus по §17: `.el-form-item`, подписи «Формат получения*»/«Наименование организации*», `.el-select-dropdown__item`, кнопка «Отправить» disabled): `readCertificateForm` возвращает два обязательных поля с вариантами «Электронный документ», «Документ на бумажном носителе» и «По месту требования», «Полное наименование организации (указать в дополнительном поле)»; `observe` с неполным `fields` → бросает со списком недостающих подписей; клик «Отправить» не выполняется ни в одном из этих утверждений (счётчик кликов на заготовке — 0).
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** читающую часть.
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`ELK: certificate form reader and dry-run adapter`).

### Task 15: ЕЛК — запись и проверка

**Files:**
- Modify: `src/services/elk/certificate.ts`

**Interfaces:**
- Produces: `certificateAdapter.execute/verifyOnly`; `invalidates: ["elk.claims"]`.

`execute` (покадрово): `withPage(form URL)` → заполнить каждое поле по подписи и тексту варианта (клик по обёртке, клик варианта), перепроверить, что обязательных пустых нет и кнопка `getByRole('button', { name: 'Отправить', exact: true })` одна и активна → `commitPoint` → один клик «Отправить» → ожидать (`page.waitForResponse`) ответ на `POST …/rest-api/camunda-gateway/process/start` (статус 2xx — только сигнал, не исход). Проверка (§7, §10): опрос `listRequests({ maxAgeMs: 0 })` до 15 с — ровно один новый номер, которого не было в снимке → `confirmed` (`evidence.newClaimNumber` — только в ответе); ни одного → `unknown`; больше одного → `unknown` с предупреждением. `verifyOnly` — тот же опрос без записи (по снимку номеров из журнала нет: снимок не хранится, поэтому повтор после `unknown` сообщает «новые заявки» и предупреждение «сверьте вручную через elk_list_requests»).

- [ ] **Step 1: Написать `verify-15.mjs`** на заготовке и `page.route` (клик «Отправить» перехватывается заготовкой, `process/start` отвечает 200, `listRequests` подменяется шпионом с набором номеров): порядок: `commitPoint` строго между заполнением и кликом; один новый номер → `confirmed`; ноль → `unknown`; два → `unknown` + предупреждение; **реальные запросы к lk.hse.ru не выполняются** (все `route` заглушены; любой запрос вне заготовки → провал).
- [ ] **Step 2:** запуск до реализации — провал.
- [ ] **Step 3: Реализовать** запись и проверку.
- [ ] **Step 4:** сборка и скрипт — все `OK`.
- [ ] **Step 5: Commit** (`ELK: certificate order execute and verification`).

### Task 16: Тул `elk_order_certificate`, документация, живая проверка

**Files:**
- Modify: `src/services/elk/tools.ts`, `docs/requirements.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1:** зарегистрировать `elk_order_certificate` (`serviceId: number().int().positive()`, `fields: record(string(), string())`, `confirm`, `previewToken`, `acknowledgeUnknown`) с аннотациями и описанием в стиле `hse_changes` (необратимость, сухой прогон, один заказ за раз, `unknown` → сверка через `elk_list_requests`).
- [ ] **Step 2:** `verify-16.mjs` как в Task 10: тул виден, аннотации, отказ при пустом `fields`.
- [ ] **Step 3:** документация (как в Task 12, но для ЕЛК).
- [ ] **Step 4: живая проверка — только с владельцем.** Сначала сухой прогон по `serviceId` 14605 (в ЕЛК ничего не меняется: число заявок до и после одинаково); **заказ реальной справки — отдельное явное разрешение владельца**, он выбирает, какая справка ему нужна; перехват блокирующим `route` из §17 перед первым живым запуском повторить и убедиться, что в запросе нет ничего, кроме ожидаемых переменных.
- [ ] **Step 5:** результаты — в спеку §17; **Commit** (`ELK: elk_order_certificate tool, docs`).

---

### Task 17: Завершение ветки

**Files:** нет изменений в коде (кроме правок по итоговому ревью).

- [ ] **Step 1: `verification-before-completion`:** `npm run build` — код 0; все постоянные скрипты проходят (`for f in scripts/verify/*.mjs; do node "$f" || exit 1; done` — все `OK`), одноразовые `verify-N` выполненных задач проходят; `git status` чистый; в `git ls-files` нет `storage/`, `.env`, `.playwright-mcp/`; `grep` по diff на запрещённые утечки — в коде журнала и логов нет записи `text`, имён файлов, `cmid`, номеров заявок (приложить вывод).
- [ ] **Step 2: `requesting-code-review`:** итоговое ревью всей ветки свежим ревьюером на самой сильной модели по спеке и плану; блокирующие и существенные замечания закрыть через `receiving-code-review`, затем снова Step 1.
- [ ] **Step 3: `finishing-a-development-branch`:** показать владельцу итог (список коммитов, результаты проверок и живой проверки, оставшиеся допущения) и варианты завершения; PR в `master`, слияние и push — только по его слову. Обновить `docs/requirements.md`/`CLAUDE.md` строкой о статусе подпроекта №4.

---

### Task 18: Подготовка к передаче другому пользователю

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/requirements.md`, `docs/recon.md`, `docs/superpowers/specs/2026-10-18-write-operations-design.md`, `docs/superpowers/plans/*.md`

Выполняется после Tasks 12 и 17 (и Task 16, если фаза C сделана); живых действий нет.

- [ ] **Step 1: Убрать личное из отслеживаемых файлов.** Заменить путь `C:/Users/alexk/hsemcp` (и `C:\Users\alexk\hsemcp\.env`) на `<путь-к-проекту>` / «`.env` проекта» в `README.md`, `CLAUDE.md`, спеках и планах; убрать название курса «История России — Проекты» из спеки §17 (оставить «второе задание типа „Проекты“ без срока»). Проверка: `git ls-files | xargs grep -lEI "$PRIVATE_PATTERN"` ничего не выводит, где `PRIVATE_PATTERN` — переменная окружения исполнителя с шаблоном из имени пользователя Windows, фамилии, личных email и идентификаторов владельца (**сам шаблон в файлы и коммиты не записывать**); приложить вывод проверки без шаблона.
- [ ] **Step 2: `docs/requirements.md`:** заменить требование «Только для одного пользователя» на «каждый пользователь ставит проект у себя со своими учётными данными; `storage/` (сессия, журнал записей, ключ токена, папка «исходящих») локальна для установки и не передаётся».
- [ ] **Step 3: `README.md`, раздел «Установка и запуск»:** `npm ci`, `npx playwright install chromium`, `cp .env.example .env` и заполнить `HSE_EMAIL`/`HSE_PASSWORD`, `npm run build`, подключение к клиенту (`claude mcp add hsemcp -- node <путь-к-проекту>/dist/index.js`), необязательная `HSE_OUTBOX_DIR`, повторная проверка защиты записи: `for f in scripts/verify/*.mjs; do node "$f"; done` (все `OK`).
- [ ] **Step 4: `README.md`, раздел «Тулы записи — что нужно знать»:** сухой прогон по умолчанию; `confirm` и `previewToken` обязательны; сохранение у части заданий **сразу отправляет** работу, у справки заказ **необратим**; не добавлять тулы записи в автоматически разрешённые в клиенте (защита опирается на запрос разрешения на каждый вызов); файлы только из папки «исходящих»; исход `unknown` — сверить результат вручную, не повторять.
- [ ] **Step 5: `README.md`, раздел «Границы применимости»:** селекторы и тексты Moodle/ЕЛК проверены на одном аккаунте и одном семестре; онлайн-текст не поддерживается; заданий с отдельным шагом «Отправить на оценку» и с `submissiondraft` не наблюдалось (тулы в таких случаях отказывают, а не угадывают); заказ справки проверен на форме одной справки; правила ВШЭ об автоматизированном доступе к SmartLMS/ЕЛК **не проверялись**, пользователь отвечает за их соблюдение сам.
- [ ] **Step 6: `CLAUDE.md`:** строку «Тестов и линтера в проекте нет» заменить на «Тестового фреймворка и линтера нет; чистая логика проверяется скриптами `scripts/verify/*.mjs` (`node:assert`, без зависимостей)»; убрать личный путь из команды подключения.
- [ ] **Step 7:** `npm run build` — код 0; все `scripts/verify/*.mjs` — `OK`; приложить вывод. **Commit** (`Docs: prepare project for use by another student`).

---

## Самопроверка плана по спеке

- §4.1 → Task 1; §4.2 → Tasks 3–7; §4.3 → Tasks 2, 6, 10, 11; §5 → Tasks 4, 7, 10; §6 → Tasks 1, 2, 7, 9; §7 → Tasks 9, 15; §8 → Tasks 5, 7; §9 и §9.1 → Tasks 8–10; §10 → Tasks 14–16; §11 → Tasks 6, 10, 11; §12 → Tasks 13, 16; §13 → Tasks 12, 16; §14 — без задач (вне рамок).
- Типы согласованы: `Outcome`/`Stage`/`ErrorClass`/`PreviewPayload` — `writes/types.ts` (Task 4); `WriteAdapter`, `ExecuteContext`, `CommitPoint`, `defineWrite` — `runner.ts` (Task 7); `PageCallContext.commit` — Task 2; `LoadContext.commit` — Task 1; `PageSlotRelease` — Task 2.
- Допущения, которые план не закрывает и оставляет живой проверке: класс `submissiondraft`, кнопка «Отправить на оценку» (`mode: "submit"` без файлов отказывает), расшифровка переменных `process/start` (путь «нажать кнопку формы» их не требует), поведение на заданиях с редактором текста.
