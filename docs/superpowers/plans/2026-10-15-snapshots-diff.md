# Подпроект №3 «Проактивность: снапшоты и diff» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Тул `hse_changes` отвечает на «что изменилось с прошлого раза» по дедлайнам, расписанию, входящему, заявкам и (по явной просьбе) оценкам: базы по источникам + журнал событий с курсором `ack`, хранимые в `storage/changes/state.json`.

**Architecture:** Новый сервис `src/services/changes/` (чистые `normalize`/`diff`, `store` с атомарной записью и lock-файлом, `extractors` поверх клиентов `elk`/`lms`, `client` как оркестратор, `tools` для MCP). Свежесть — `maxAgeMs` на уровне вызова ресурса (без `clearCache`). Общая инфраструктура: `projectRoot`, `runSource`, `extractGradeTable`.

**Tech Stack:** TypeScript 5 (NodeNext, ES2022), Node ≥ 20 (`structuredClone`), Playwright (уже в проекте), `zod`, `@modelcontextprotocol/sdk`. Новых зависимостей нет.

**Spec:** `docs/superpowers/specs/2026-10-15-snapshots-diff-design.md` (коммит 93640e8 и позже). Исполнитель читает обе вещи: спека — «что и почему», план — «как и в каком порядке».

## Global Constraints

Каждая задача неявно включает этот раздел; значения скопированы из спеки.

- **Тестов и линтера в проекте нет по решению проекта (`CLAUDE.md`) — не добавлять.** Проверка — `tsc`, изолированные скрипты через `dist/` (в репозиторий не коммитятся), затем живая проверка.
- Режим — **только по запросу тулом**: таймеров и фоновых процессов нет (§2).
- Не пишется на диск никогда: токены и всё из `storageState`, email, ФИО (`sender`, `executorFio`, `createdBy*`), тела писем, текст уведомлений и заявок (у заявки `title` = только `service`), url с query, `raw` (§7).
- Файл состояния: `storage/changes/state.json`; `storage/` уже в `.gitignore`; путь — от `projectRoot`, не от `cwd` (§7).
- Журнал: 30 дней и не более 500 событий; в ответе не более 200 событий; `maxAgeMs` по умолчанию 60 с; бюджет `grades` 90 с; пул оценок ≤ 3; таймаут источника 40 с; дедлайн ресурса 45 с (§7–§10).
- Моменты: Moodle — `ГГГГ-ММ-ДДTЧЧ:ммZ` (UTC); ЕЛК и СОП — наивное МСК `ГГГГ-ММ-ДДTЧЧ:мм`; сравниваются строки; пояс машины не участвует (§6).
- `hse_changes` **не вызывает `clearCache`**; лимитер не обходится; вложенных `withPage` нет (§8, §9).
- `getGrades` и тул `lms_get_grades` **не меняются** (§4, §5 п. 6).
- Права файла: `0o600`, но на Windows это не защита — реальная защита ACL профиля (§7).
- Записывающих операций нет; `hse_changes_reset` требует `confirm: true` (§13).
- Язык: комментарии, сообщения об ошибках и описания тулов — русские, по образцу кодовой базы; идентификаторы — английские.
- Сборка (в worktree нет `node_modules`, он находится выше по дереву), из корня worktree: Git Bash — `node C:/Users/alexk/hsemcp/node_modules/typescript/bin/tsc -p tsconfig.json` (прямые слэши: в Git Bash обратные съедаются); PowerShell — та же запись либо `node C:\Users\alexk\hsemcp\node_modules\typescript\bin\tsc -p tsconfig.json`. Далее — «**сборка**». Во всех командах плана, предназначенных для Git Bash, пути пишутся с прямыми слэшами.
- `ack` (П1): `ack`, больший наибольшего когда-либо выданного `seq` (`max(issued[*])` по всем областям), игнорируется целиком с предупреждением; иначе для каждой области вызова `seen = max(seen, min(ack, issued[scope] ?? 0))`. `issued` — карта по областям.

## Что вне плана (явно)

- **(а) Удаление корпоративной почты** — отдельная ветка и PR **до** №3. Зависимостей у этого плана от него нет: код `changes` не импортирует `services/mail`. Пока PR не сделан, почта остаётся в `src/index.ts` — задача 10 добавляет регистрацию рядом и не трогает её.
- **(б) istudy вне №3 по недостижимости** (§12). Вход проходит без MAX, но данные зачётки за двухфакторным подтверждением через MAX (HTTP 412 на `/api/auth/two-factor/required`), API профиля переехал на `POST /api/student/profile?studentId=`; пользователь MAX не использует, поэтому зачётка недоступна. В плане `istudy` не затрагивается, кроме правки устаревшего описания в документации (задача 11); задач по istudy нет.
- **(в) Три решения приняты по умолчанию и помечены оспариваемыми** (шапка спеки): заголовки входящего хранятся как есть; оценки — новым парсером с `unsupported`; защита процессов — lock-файл. Если пользователь оспорит, затронуты: (1) задача 8 (`title` во входящем), (2) задача 5 и 8 (оценки), (3) задача 7 (`withStateLock`).
- **(г) Долг №4 не чинится** (§14): `invalidates` с неизвестным именем и режим «не кэшировать».
- **(д) `lms_get_grades`/`getGrades` не меняются**; их дефект (сдвиг ключей) — «чинится отдельно».

## Поправки к спеке, найденные при планировании

Спека остаётся источником требований; ниже — места, где её буквальное чтение приводит к дефекту или недоопределено. План реализует поправленный вариант, а **задача 9 включает шаг обновления §7 и §10 спеки**. Пользователь может отклонить поправки на ревью плана.

| № | Место в спеке | Проблема | Поправка в плане |
|---|---|---|---|
| П1 | §7 `issued: число`, §10 «`ack` применяется ко всем областям вызова: `seen[scope] = max(seen[scope], ack)`» | Вызов `hse_changes({ scopes:["inbox"], ack: 10 })` после выдачи `deadlines` (до seq 10) пометил бы невыданные события `inbox` с seq ≤ 10 как просмотренные — молчаливая потеря. | `issued` — карта по областям `{ [scope]: seq }` (наибольший выданный `seq` области). `ack N`, больший `max(issued[*])` по всем областям (наибольшего когда-либо выданного `seq`), игнорируется целиком с предупреждением; иначе для областей текущего вызова `seen[scope] = max(seen[scope], min(N, issued[scope] ?? 0))`. |
| П2 | §5/§11: `to = today + 60 д` | `lms/client.ts` отфильтровывает события `due <= to` в `project`; если `to` — полночь, события последнего дня теряются. | `to = endOfDay(today + 60 д)`; `coverage.to` — тот же момент в UTC. |
| П3 | §10 `since` | Не сказано, делается ли снимок и что с `ackSeq`. | Снимок и коммит выполняются как обычно; в ответе журнал за период; `ackSeq: null`, `issued` не меняется. |
| П4 | §10 ответ | Для области `grades` источник `lms_courses` (список курсов) не описан. | `lms_courses` — отдельный источник области `grades` в `sources`; отказ даёт статус области `error`. |
| П5 | §7 | Не описано поведение при `io-error` и `version` новее. | Коммита нет; ответ — статусы областей `error` и предупреждение; `persisted: false`. |

## Review Focus

Входные классы и сбои, которые спека подразумевает, но которые не очевидны исполнителю. У каждой строки есть тест в задаче-владельце.

1. **Пустой ответ источника при непустой базе** (всё сдано, каникулы): ожидается `removed` по каждому элементу в покрытии, а не молчание и не ошибка — задача 6.
2. **Курс без таблицы оценок или с чужой вёрсткой:** статус `error: unsupported grade table` только у этого курса; остальные курсы и области коммитятся — задача 9.
3. **Дубликаты `id` в одном ответе** (два одинаковых занятия в одно время, одинаковые элементы оценок в одной категории): факт не теряется, получает суффикс `#2` — задачи 6 и 8.
4. **`ack` с другим набором областей или больше выданного:** `ack` больше `max(issued)` по всем областям игнорируется целиком с предупреждением; `ack` в пределах выданного, но по другой области, срезается по `issued[scope]` — невыданные события не помечаются просмотренными — задача 9.
5. **Чистый `storage/` (нет каталога `changes`), повреждённый JSON, файл новее, занят антивирусом/другим процессом:** нет падений, нет потери базы, нет ложного `.corrupt` при ошибке ввода-вывода — задача 7.

## Карта файлов

| Файл | Действие | Ответственность |
|---|---|---|
| `src/project-root.ts` | создать | Общий `projectRoot` (один вычисляемый путь от расположения файла) |
| `src/config.ts`, `src/auth/browser-session.ts` | изменить | Использовать `projectRoot` вместо локальных копий |
| `src/run-source.ts` | создать | `withTimeout`, `runSource`, `SourceStatus` (общие для `digest` и `changes`) |
| `src/services/digest/client.ts`, `src/services/digest/types.ts` | изменить | Использовать общий `run-source`, поведение прежнее |
| `src/cache.ts`, `src/resource.ts` | изменить | `Entry.storedAt`, `cached(..., { maxAgeMs })`, `ResourceCallOptions.maxAgeMs` |
| `src/services/elk/client.ts`, `src/services/lms/client.ts` | изменить | `opts?: ResourceCallOptions` у 7 функций; `listGradeItems` |
| `src/dom-utils.ts` | изменить | `extractGradeTable` (существующий `extractTable` не меняется) |
| `src/services/changes/types.ts` | создать | Типы фактов, событий, базы, состояния; константы областей |
| `src/services/changes/normalize.ts` | создать | Нормализация строк и моментов, отпечаток, `dedupeIds` |
| `src/services/changes/diff.ts` | создать | Чистая функция `diffSource` |
| `src/services/changes/store.ts` | создать | `state.json`: чтение, атомарная запись, lock-файл, срезы |
| `src/services/changes/extractors.ts` | создать | Источник → факты (7 источников + оценки по курсам) |
| `src/services/changes/client.ts` | создать | `getChanges`, `resetChanges` |
| `src/mcp-utils.ts` | изменить | `runTool(fn, signal?)` |
| `src/services/changes/tools.ts` | создать | `hse_changes`, `hse_changes_reset` |
| `src/index.ts` | изменить | `registerChangesTools(server)` |
| `docs/requirements.md`, `CLAUDE.md`, `README.md`, `docs/recon.md` | изменить | Документация |
| `docs/superpowers/specs/2026-10-15-snapshots-diff-design.md` | изменить | Поправки П1–П5 (задача 9), §18 (задача 12) |

## Зависимости и параллельность

```
T0 ─┬─ T1 ─────────────────────────────┐
    ├─ T2 ─────────────────────────────┤
    ├─ T3 ── T4 ── T5 ─────────────────┤
    └─ T6 ──┬── T7 (нужен T1) ─────────┤
            └── T8 (нужны T4, T5, T6) ─┴── T9 (T2, T6, T7, T8) ── T10 ── T11 ── T12
```

- **Порядок исполнения — строго последовательный: T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12** (после T0). Граф выше показывает только зависимости: T3 → T4 → T5 (один файл `lms/client.ts` у T4 и T5, семантика `maxAgeMs` у T3); T7 нужны T1 и T6; T8 нужны T4, T5, T6; T9 нужны T2, T6, T7, T8.
- **Параллельность** (T1, T2, T3, T6 не делят файлов) возможна только в разных worktree со слиянием, но в этом плане не используется: в одном worktree `tsc -p` соседа компилирует недописанные файлы, а одновременные `git commit` упираются в `index.lock`.
- Каждый шаг коммитится независимо; ветка собирается после каждой задачи.

---

### Task 0: Подготовка и каркас проверок (без коммита)

**Files:**
- Create (вне репозитория): `$SCRATCH/verify-3/lib.mjs`. `$SCRATCH` — условное обозначение, а не переменная окружения (в PowerShell раскрылась бы в пустую строку): перед выполнением подставить абсолютный путь scratchpad основной сессии (прямые слэши); все задачи используют один и тот же каталог.

**Interfaces:**
- Produces: `lib.mjs` с `dist(rel)`, `sleep(ms)`, `check(cond, msg)`, `finish()`, `ROOT`, `NODE_MODULES`.

- [ ] **Step 1: Проверить ветку и чистоту**

Run: `git branch --show-current && git status --short`
Expected: `snapshots-diff`, вывод `git status` пуст.

- [ ] **Step 2: Базовая сборка**

Run (из корня worktree, Git Bash): `node C:/Users/alexk/hsemcp/node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: код возврата 0, без вывода.

- [ ] **Step 3: Создать каркас проверок**

Создать `$SCRATCH/verify-3/lib.mjs`:

```js
import { pathToFileURL } from "node:url";

export const ROOT = "C:/Users/alexk/hsemcp/.claude/worktrees/update";
export const NODE_MODULES = "C:/Users/alexk/hsemcp/node_modules";
export const dist = (rel) => import(pathToFileURL(`${ROOT}/dist/${rel}`).href);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;
export function check(cond, msg) {
  if (cond) console.log("PASS", msg);
  else {
    failed++;
    console.log("FAIL", msg);
  }
}
export function finish() {
  console.log(failed === 0 ? "ALL PASSED" : `FAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
```

Run: `node $SCRATCH/verify-3/lib.mjs`
Expected: без вывода, код 0.

Скрипты задач запускаются как `node $SCRATCH/verify-3/<файл>.mjs` **после** сборки соответствующей задачи.

---

### Task 1: Общий хелпер `projectRoot`

**Files:**
- Create: `src/project-root.ts`
- Modify: `src/config.ts:2-3,8-9`, `src/auth/browser-session.ts:4,10-14`

**Interfaces:**
- Produces: `export const projectRoot: string` — абсолютный путь корня проекта (родитель `dist/`), независимый от `process.cwd()`.

- [ ] **Step 1: Создать `src/project-root.ts`**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Корень проекта — на уровень выше `dist/` (и `src/` при запуске из исходников). Считается от
 * расположения самого файла, а не `process.cwd()`: хосты вроде Claude Desktop запускают stdio-сервер
 * с произвольным (иногда непишущим, напр. C:\WINDOWS\system32) рабочим каталогом.
 */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
```

- [ ] **Step 2: `config.ts` — использовать хелпер**

Заменить импорты и вычисление корня: удалить `import { fileURLToPath } from "node:url";` и строку `const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");`; добавить `import { projectRoot } from "./project-root.js";`. Строка `loadDotenv({ path: path.join(projectRoot, ".env") });` остаётся.

- [ ] **Step 3: `browser-session.ts` — использовать хелпер**

Удалить `import { fileURLToPath } from "node:url";` и блок
```ts
// Считаем от расположения самого файла, ... EPERM.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
```
Добавить `import { projectRoot } from "../project-root.js";`. Строка `const STORAGE_DIR = path.join(projectRoot, "storage");` остаётся.

- [ ] **Step 4: Сборка**

Expected: код 0 (если `tsc` ругается на неиспользуемый `fileURLToPath` — он удалён целиком; других использований в файлах нет).

- [ ] **Step 5: Изолированная проверка** `$SCRATCH/verify-3/t1-root.mjs`

```js
import path from "node:path";
import { dist, check, finish, ROOT } from "./lib.mjs";

const { projectRoot } = await dist("project-root.js");
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
check(norm(projectRoot) === norm(ROOT), "projectRoot — корень worktree (родитель dist)");
await dist("config.js");
check(true, "config.js загружается (.env ищется от projectRoot)");
await dist("auth/browser-session.js");
check(true, "browser-session.js загружается");
finish();
```

Run: `node $SCRATCH/verify-3/t1-root.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 6: Коммит**

```bash
git add src/project-root.ts src/config.ts src/auth/browser-session.ts
git commit -m "Extract shared projectRoot helper

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Общий `run-source` (вынос из `digest`)

**Files:**
- Create: `src/run-source.ts`
- Modify: `src/services/digest/client.ts:34-63`, `src/services/digest/types.ts:39-45`

**Interfaces:**
- Produces:
```ts
export interface SourceStatus { status: "ok" | "error" | "skipped"; error?: string; warnings?: string[]; ms: number }
export interface SourceOutcome<T> { name: string; value: T | null; status: SourceStatus }
export function withTimeout<T>(promise: Promise<T>, ms: number, name: string, signal?: AbortSignal): Promise<T>
export function runSource<T extends { warnings?: string[] }>(name: string, fn: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<SourceOutcome<T>>
```
- `digest/types.ts` продолжает экспортировать `SourceStatus` (реэкспорт).

- [ ] **Step 1: Создать `src/run-source.ts`**

```ts
/**
 * Запуск источника данных с таймаутом: отказ превращается в статус, а не в исключение. Общий для
 * агрегатора `digest` и сервиса `changes`. Таймаут НЕ отменяет работу источника — только
 * перестаёт его ждать (отмена — через сигнал самого вызова, см. ресурсы).
 */

export interface SourceStatus {
  status: "ok" | "error" | "skipped";
  error?: string;
  /** Нефатальные замечания источника. */
  warnings?: string[];
  ms: number;
}

export interface SourceOutcome<T> {
  name: string;
  /** `null` — источник отказал или не запускался. */
  value: T | null;
  status: SourceStatus;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, name: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`источник ${name} не ответил за ${ms / 1000} с`)), ms);
    if (signal) {
      onAbort = () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error(`источник ${name} отменён`));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/** Запускает источник; никогда не бросает — отказ превращается в статус `error`. */
export async function runSource<T extends { warnings?: string[] }>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SourceOutcome<T>> {
  const started = Date.now();
  try {
    const value = await withTimeout(fn(), timeoutMs, name, signal);
    return {
      name,
      value,
      status: {
        status: "ok",
        ms: Date.now() - started,
        ...(value.warnings?.length ? { warnings: value.warnings } : {}),
      },
    };
  } catch (err) {
    return {
      name,
      value: null,
      status: { status: "error", error: err instanceof Error ? err.message : String(err), ms: Date.now() - started },
    };
  }
}
```

- [ ] **Step 2: `digest/types.ts`** — заменить локальный `export interface SourceStatus {…}` на

```ts
import type { SourceStatus } from "../../run-source.js";
export type { SourceStatus };
```
(в начале файла; `DigestResult.sources: Record<string, SourceStatus>` остаётся).

- [ ] **Step 3: `digest/client.ts`** — удалить локальные `withTimeout` и тело `runSource`; добавить импорт и обёртку, сохраняющую `SourceRun`:

```ts
import { runSource as runGenericSource } from "../../run-source.js";
// ...
/** Запускает коллектор; никогда не бросает — отказ превращается в статус источника. */
async function runSource(name: string, fn: () => Promise<CollectorResult>, timeoutMs: number): Promise<SourceRun> {
  const out = await runGenericSource(name, fn, timeoutMs);
  return { name, items: out.value?.items ?? [], status: out.status };
}
```
Импорт `SourceStatus` из `./types.js` в `digest/client.ts` остаётся (используется в `SourceRun`).

- [ ] **Step 4: Сборка** — Expected: код 0.

- [ ] **Step 5: Проверка** `$SCRATCH/verify-3/t2-run-source.mjs`

```js
import { dist, check, finish } from "./lib.mjs";
const { runSource, withTimeout } = await dist("run-source.js");
const { buildDigest } = await dist("services/digest/client.js");

const ok = await runSource("a", async () => ({ warnings: ["w"], x: 1 }), 500);
check(ok.status.status === "ok" && ok.value.x === 1 && ok.status.warnings[0] === "w", "ok + warnings");
const bad = await runSource("b", async () => { throw new Error("boom"); }, 500);
check(bad.status.status === "error" && bad.status.error === "boom" && bad.value === null, "ошибка → статус");
const slow = await runSource("c", () => new Promise(() => {}), 50);
check(slow.status.status === "error" && /источник c не ответил за 0.05 с/.test(slow.status.error), "таймаут → статус");
const ctrl = new AbortController();
const p = runSource("d", () => new Promise(() => {}), 5000, ctrl.signal);
ctrl.abort(new Error("отмена"));
const aborted = await p;
check(aborted.status.status === "error" && aborted.status.error === "отмена", "сигнал отмены → статус");

// регрессия digest: поведение прежнее
const okC = async () => ({ items: [] });
const collectors = {
  elkSchedule: okC, ruzSchedule: okC, lmsDeadlines: okC, lmsMessages: okC, elkTasks: okC, elkWindows: okC,
  elkNotifications: async () => { throw new Error("boom"); },
  elkClaims: () => new Promise(() => {}),
};
const day = (d) => new Date(2026, 9, d, 0, 0, 0);
const plan = {
  now: new Date(2026, 9, 15, 12), window: { from: day(15), to: day(16) },
  schedule: { range: { from: day(15), to: day(16) }, lessonsUntil: day(16), examsUntil: day(16) },
  deadlinesUntil: day(16), includeUndated: false,
  include: { lmsMessages: true, notifications: true, claims: true, tasks: true }, sourceTimeoutMs: 80,
};
const res = await buildDigest(plan, collectors);
check(res.sources.elk_schedule.status === "ok", "digest: elk_schedule ok");
check(res.sources.ruz_schedule.status === "skipped", "digest: ruz_schedule skipped");
check(res.sources.elk_notifications.status === "error" && res.sources.elk_notifications.error === "boom", "digest: ошибка источника");
check(res.sources.elk_claims.status === "error" && /не ответил за 0.08 с/.test(res.sources.elk_claims.error), "digest: таймаут источника");
finish();
```

Run: `node $SCRATCH/verify-3/t2-run-source.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 6: Коммит**

```bash
git add src/run-source.ts src/services/digest/client.ts src/services/digest/types.ts
git commit -m "Move runSource/withTimeout into a shared module

digest switches to it with unchanged behaviour; changes will reuse it.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `maxAgeMs` в кэше и ресурсе

**Files:**
- Modify: `src/cache.ts` (целиком), `src/resource.ts:18-20,108-112`

**Interfaces:**
- Produces:
```ts
// cache.ts
export interface CachedOptions { maxAgeMs?: number }
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts?: CachedOptions): Promise<T>
// resource.ts
export interface ResourceCallOptions { signal?: AbortSignal; maxAgeMs?: number }
```
- Семантика (§8): `Entry.storedAt` — момент **старта** загрузки; запись годна, если `expiresAt > now` и (`maxAgeMs` не задан или `now − storedAt ≤ maxAgeMs`); in-flight принимается, если стартовал не раньше `now − maxAgeMs`; запись в хранилище разрешена, только если `startedAt ≥ storedAt` текущей записи; `generation` и `clearCache` не меняются.

- [ ] **Step 1: Заменить `src/cache.ts` целиком**

```ts
/**
 * Кэш результатов в памяти процесса с TTL. Нужен, чтобы повторные вопросы и будущие агрегаторы
 * («что у меня сегодня» дёргает десяток тулов) не открывали Playwright-страницы ради данных,
 * которые не изменились минуту назад. Только память — на диск ничего не пишется (на диске
 * лежали бы данные об учёбе, а токены и так живут только в процессе).
 *
 * Ключи имеют вид `<сервис>:<что-то>` (`elk:`, `lms:`, `istudy:`) — по префиксу сервиса
 * работает `clearCache`. Результат, лежащий в кэше, отдаётся одним и тем же объектом всем
 * вызывающим: тулы только сериализуют его в JSON, мутировать результат нельзя.
 *
 * Свежесть «на вызов»: `maxAgeMs` принимает запись/загрузку не старше N мс; это не сброс кэша
 * (`clearCache` бьёт по всем доменам и запрещает запись идущим загрузкам), а требование одного
 * вызова. Свежая загрузка пишется в кэш как обычно — остальные вызывающие получают её же.
 */

export const TTL = {
  /** Быстро меняющееся: уведомления, заявки, задачи, сообщения. */
  short: 2 * 60_000,
  /** Расписание, оценки, материалы курсов. */
  medium: 5 * 60_000,
  /** Почти статичное: профиль, академическая карточка, портфолио. */
  long: 30 * 60_000,
} as const;

const MAX_ENTRIES = 200;

interface Entry {
  value: unknown;
  expiresAt: number;
  /** Момент СТАРТА загрузки, давшей это значение. */
  storedAt: number;
}

interface Inflight {
  promise: Promise<unknown>;
  startedAt: number;
}

export interface CachedOptions {
  /** Принять запись/загрузку не старше N мс; 0 — «перечитай и сохрани». Не «не кэшируй». */
  maxAgeMs?: number;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Inflight>();
// Увеличивается при clearCache: вызов, начатый до очистки, не должен записать в кэш результат
// уже после неё — иначе «сброс кэша» вернул бы устаревшие данные.
let generation = 0;

function evictIfNeeded(): void {
  if (store.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  // Map хранит порядок вставки — самые старые записи идут первыми.
  for (const key of store.keys()) {
    if (store.size < MAX_ENTRIES) break;
    store.delete(key);
  }
}

/**
 * Возвращает свежую запись из кэша или вычисляет через `fn`. Параллельные вызовы с одним ключом
 * делят одно вычисление (если оно не старше `maxAgeMs`). Ошибки не кэшируются.
 */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts: CachedOptions = {}): Promise<T> {
  const now = Date.now();
  const maxAge = opts.maxAgeMs;

  const hit = store.get(key);
  if (hit && hit.expiresAt > now && (maxAge === undefined || now - hit.storedAt <= maxAge)) {
    return Promise.resolve(hit.value as T);
  }

  const pending = inflight.get(key);
  if (pending && (maxAge === undefined || pending.startedAt >= now - maxAge)) {
    return pending.promise as Promise<T>;
  }

  const startedAt = now;
  const startedGeneration = generation;
  const promise: Promise<T> = (async () => {
    const value = await fn();
    if (generation === startedGeneration) {
      // Старая загрузка, завершившаяся позже новой, не затирает свежее значение.
      const current = store.get(key);
      if (!current || startedAt >= current.storedAt) {
        evictIfNeeded();
        store.set(key, { value, expiresAt: Date.now() + ttlMs, storedAt: startedAt });
      }
    }
    return value;
  })().finally(() => {
    const current = inflight.get(key);
    if (current && current.promise === promise) inflight.delete(key);
  });
  inflight.set(key, { promise, startedAt });
  return promise;
}

/**
 * Сбрасывает записи, ключ которых начинается с `prefix` (без аргумента — весь кэш). Возвращает
 * число удалённых готовых записей. Точка инвалидации для будущих записывающих тулов.
 */
export function clearCache(prefix = ""): number {
  generation++;
  let removed = 0;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed++;
    }
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
  return removed;
}
```

- [ ] **Step 2: `src/resource.ts`** — два изменения.

Интерфейс (строки 18–20):
```ts
export interface ResourceCallOptions {
  signal?: AbortSignal;
  /** Принять данные не старше N мс (0 — перечитать и сохранить); см. `cached`. */
  maxAgeMs?: number;
}
```
Вызов `cached` (строка 108):
```ts
    const shared = cached<Raw>(
      key,
      def.ttl,
      async () => {
        const raw = deepFreeze(await loadWithDeadline(def, args, deadlineMs));
        for (const name of def.invalidates ?? []) invalidateResource(name);
        return raw;
      },
      { maxAgeMs: opts.maxAgeMs }
    );
```

- [ ] **Step 3: Сборка** — Expected: код 0.

- [ ] **Step 4: Проверка** `$SCRATCH/verify-3/t3-cache.mjs`

```js
import { dist, check, finish, sleep } from "./lib.mjs";
const { cached } = await dist("cache.js");
const { defineResource } = await dist("resource.js");

let n = 0;
const load = async () => ++n;
await cached("t3:a", 60_000, load);
await cached("t3:a", 60_000, load);
check(n === 1, "без maxAgeMs повтор из кэша");
await sleep(120);
await cached("t3:a", 60_000, load, { maxAgeMs: 50 });
check(n === 2, "запись старше maxAgeMs перезагружается");
await cached("t3:a", 60_000, load, { maxAgeMs: 5_000 });
check(n === 2, "запись моложе maxAgeMs берётся из кэша");

let m = 0;
const slow = async () => { m++; await sleep(200); return m; };
const p1 = cached("t3:b", 60_000, slow);
await sleep(40);
const p2 = cached("t3:b", 60_000, slow, { maxAgeMs: 5_000 });
await Promise.all([p1, p2]);
check(m === 1, "in-flight моложе maxAgeMs разделяется");
const p3 = cached("t3:c", 60_000, slow);
await sleep(40);
const p4 = cached("t3:c", 60_000, slow, { maxAgeMs: 0 });
await Promise.all([p3, p4]);
check(m === 3, "maxAgeMs: 0 не принимает идущую загрузку, запускает новую");

const order = [];
const mk = (label, ms) => async () => { await sleep(ms); order.push(label); return label; };
const a = cached("t3:d", 60_000, mk("A", 300));
await sleep(20);
const b = cached("t3:d", 60_000, mk("B", 40), { maxAgeMs: 0 });
await Promise.all([a, b]);
check(order.join() === "B,A", "B завершилась раньше A");
let reloaded = false;
const v = await cached("t3:d", 60_000, async () => { reloaded = true; return "LOAD"; });
check(v === "B" && !reloaded, "старая загрузка не затёрла свежую");

const other = cached("t3:e", 60_000, async () => { await sleep(150); return "E"; });
await cached("t3:a", 60_000, load, { maxAgeMs: 0 });
await other;
let touched = false;
const e = await cached("t3:e", 60_000, async () => { touched = true; return "X"; });
check(e === "E" && !touched, "перезагрузка по maxAgeMs не запрещает запись чужих загрузок (generation не тронут)");

let r = 0;
const res = defineResource({ name: "t3.res", ttl: 60_000, key: () => "k", load: async () => ({ v: ++r }) });
await res(undefined);
await res(undefined);
check(r === 1, "ресурс: повтор из кэша");
await sleep(60);
await res(undefined, { maxAgeMs: 10 });
check(r === 2, "ресурс: maxAgeMs доходит до кэша");
finish();
```

Run: `node $SCRATCH/verify-3/t3-cache.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 5: Коммит**

```bash
git add src/cache.ts src/resource.ts
git commit -m "Add call-level maxAgeMs freshness to cache and resources

Entries remember the load start time; a stale in-flight load or a late
older load never overwrites a fresher one; clearCache semantics unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `opts` у функций клиентов

**Files:**
- Modify: `src/services/elk/client.ts:8,244-261,452-454,608-610,665-667`, `src/services/lms/client.ts:6,161-163,284-286,356-358`

**Interfaces:**
- Consumes: `ResourceCallOptions` (задача 3).
- Produces (сигнатуры; прежние вызовы без `opts` работают):
```ts
// elk
getSchedule(from: Date, to: Date, opts?: ResourceCallOptions): Promise<ElkScheduleDay[]>
getNotifications(limit = 20, opts?: ResourceCallOptions): Promise<{ count: number; notifications: ElkNotification[] }>
listRequests(limit = 500, opts?: ResourceCallOptions): Promise<{ count: number; requests: ElkClaim[] }>
getCourseEvaluationStatus(opts?: ResourceCallOptions): Promise<Array<Record<string, string>>>
// lms
listCourses(opts?: ResourceCallOptions): Promise<CourseOverview[]>
listActionEvents(from: Date, to: Date, opts?: ResourceCallOptions): Promise<LmsActionEventsResult>
listMessages(limit = 50, opts?: ResourceCallOptions): Promise<LmsMessageSummary[]>
```

- [ ] **Step 1: `elk/client.ts`** — импорт и четыре функции.

Импорт (строка 8): `import { defineResource, type LoadContext, type ResourceCallOptions } from "../../resource.js";`

```ts
export async function getSchedule(from: Date, to: Date, opts?: ResourceCallOptions): Promise<ElkScheduleDay[]> {
  // ... тело без изменений до строки с chunks ...
  const chunks = await Promise.all(weeks.map((m) => elkScheduleWeek(m, opts)));
  // ...
}

export function listRequests(limit = 500, opts?: ResourceCallOptions): Promise<{ count: number; requests: ElkClaim[] }> {
  return elkClaims(limit, opts);
}

export function getNotifications(limit = 20, opts?: ResourceCallOptions): Promise<{ count: number; notifications: ElkNotification[] }> {
  return elkNotifications(limit, opts);
}

export function getCourseEvaluationStatus(opts?: ResourceCallOptions): Promise<Array<Record<string, string>>> {
  return elkCourseEvaluation(undefined, opts);
}
```
**Важно:** `opts` передаётся в **каждый** недельный вызов `elkScheduleWeek` (`getSchedule` сама ресурсом не является): если забыть, ошибки не будет, свежесть молча не применится.

- [ ] **Step 2: `lms/client.ts`**

Импорт (строка 6): `import { defineResource, type ResourceCallOptions } from "../../resource.js";`

```ts
export function listCourses(opts?: ResourceCallOptions): Promise<CourseOverview[]> {
  return lmsCourses(undefined, opts);
}

export function listActionEvents(from: Date, to: Date, opts?: ResourceCallOptions): Promise<LmsActionEventsResult> {
  return lmsCalendar({ from, to }, opts);
}

export function listMessages(limit = 50, opts?: ResourceCallOptions): Promise<LmsMessageSummary[]> {
  return lmsMessages(limit, opts);
}
```

- [ ] **Step 3: Сборка** — Expected: код 0 (вызовы из `digest/sources.ts`, `tools.ts` без `opts` компилируются).

- [ ] **Step 4: Проверка** `$SCRATCH/verify-3/t4-opts.mjs` — без сети: кэш засеивается напрямую, слоты лимитера заняты, поэтому «перезагрузка» повисает на ожидании слота (браузер не запускается). В worktree нет `.env`, а загрузчик `elk.claims` читает `config.hseEmail` ещё до слота: без переменной он бросит исключение (`rejected`, а не `pending`) и проверка упадёт. Поэтому первой строкой скрипта задаётся заглушка (dotenv не перезаписывает уже заданную переменную).

```js
process.env.HSE_EMAIL ??= "t4@example.invalid";
import { dist, check, finish, sleep } from "./lib.mjs";
const { cached, TTL } = await dist("cache.js");
const { acquirePageSlot } = await dist("limiter.js");
const { formatLocalDate } = await dist("date-utils.js");
const elk = await dist("services/elk/client.js");
const lms = await dist("services/lms/client.js");

const seed = (key, raw) => cached(key, TTL.medium, async () => raw);
const settle = (p) =>
  Promise.race([p.then(() => "resolved", () => "rejected"), sleep(400).then(() => "pending")]);

const from = new Date(2026, 9, 12), to = new Date(2026, 9, 25); // пн 12.10 … вс 25.10 — две недели
const horizon = lms.calendarHorizon(to).key;
const calKey = `lms:calendar:${formatLocalDate(from, "-")}:${horizon}`;

await seed("elk:notifications:all", { data: [], count: 0 });
await seed("elk:claims:all", { data: [], count: 0 });
await seed("elk:course-evaluation:me", []);
await seed("lms:courses:all", []);
await seed("lms:messages:inbox", []);
await seed(calKey, { events: [], truncated: false });
await seed("elk:schedule-week:2026-10-12", []);
await seed("elk:schedule-week:2026-10-19", []);
await sleep(120);   // все записи старше stale.maxAgeMs (20 мс), но моложе fresh.maxAgeMs (60 с)

// занять все слоты страниц: любая перезагрузка встанет в очередь, а не откроет браузер
const holds = [await acquirePageSlot(), await acquirePageSlot(), await acquirePageSlot()];

const fresh = { maxAgeMs: 60_000 };
const stale = { maxAgeMs: 20 };
const cases = [
  ["getNotifications", (o) => elk.getNotifications(100, o)],
  ["listRequests", (o) => elk.listRequests(500, o)],
  ["getCourseEvaluationStatus", (o) => elk.getCourseEvaluationStatus(o)],
  ["listCourses", (o) => lms.listCourses(o)],
  ["listMessages", (o) => lms.listMessages(200, o)],
  ["listActionEvents", (o) => lms.listActionEvents(from, to, o)],
];
for (const [name, call] of cases) {
  check((await settle(call(fresh))) === "resolved", `${name}: свежая запись из кэша (maxAgeMs 60 с)`);
  check((await settle(call(undefined))) === "resolved", `${name}: без opts — прежнее поведение`);
  check((await settle(call(stale))) === "pending", `${name}: maxAgeMs доходит до ресурса (перезагрузка ждёт слот)`);
}
check((await settle(elk.getSchedule(from, to, fresh))) === "resolved", "getSchedule: обе недели из кэша");
// по одной неделе за вызов: перезагрузка каждой недели по отдельности доказывает, что opts дошёл до КАЖДОЙ
const week1End = new Date(2026, 9, 18);    // вс 18.10 — только неделя 12.10
const week2Start = new Date(2026, 9, 19);  // пн 19.10 — только неделя 19.10
check((await settle(elk.getSchedule(from, week1End, stale))) === "pending",
  "getSchedule: maxAgeMs доходит до недели 12.10 (перезагрузка ждёт слот)");
check((await settle(elk.getSchedule(week2Start, to, stale))) === "pending",
  "getSchedule: maxAgeMs доходит до недели 19.10 (перезагрузка ждёт слот)");
holds.forEach((release) => release());
finish();
```

Run: `node $SCRATCH/verify-3/t4-opts.mjs`
Expected: `ALL PASSED` (скрипт завершается через `process.exit` в `finish`; висящие загрузки умирают вместе с процессом).

- [ ] **Step 5: Коммит**

```bash
git add src/services/elk/client.ts src/services/lms/client.ts
git commit -m "Pass call options through seven client functions

getSchedule forwards them to every weekly block.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `extractGradeTable` и ресурс `lms.grade-items`

**Files:**
- Modify: `src/dom-utils.ts` (добавить после `extractTable`), `src/services/lms/client.ts:4` (импорт) и после `getGrades` (строки 463–481)

**Interfaces:**
- Produces:
```ts
// dom-utils.ts
export interface GradeItemRow { name: string; level: number; path: string[]; isCategory: boolean; grade: string | null }
export interface GradeTable { found: boolean; recognized: boolean; rows: GradeItemRow[] }
export function extractGradeTable(page: Page, selector?: string): Promise<GradeTable>   // по умолчанию "table.user-grade"
// lms/client.ts
export function listGradeItems(courseId: number, opts?: ResourceCallOptions): Promise<GradeTable>
```
- Семантика: `found` — таблица найдена; `recognized` — есть и `th.column-itemname`, и `td.column-grade`; строка без `td.column-grade` — категория; `path` — имена категорий-предков (уровень меньше уровня строки).

- [ ] **Step 1: `dom-utils.ts` — добавить**

```ts
export interface GradeItemRow {
  /** Текст `th.column-itemname`. */
  name: string;
  /** N из класса `levelN` (0, если класса нет). */
  level: number;
  /** Имена категорий-предков (уровень строго меньше уровня строки). */
  path: string[];
  /** Нет ячейки `td.column-grade` — строка категории. */
  isCategory: boolean;
  /** Текст `td.column-grade`; `null` у категории. */
  grade: string | null;
}

export interface GradeTable {
  /** `table.user-grade` найден на странице. */
  found: boolean;
  /** Хотя бы в одной строке есть и `th.column-itemname`, и `td.column-grade`. */
  recognized: boolean;
  rows: GradeItemRow[];
}

/**
 * Отчёт об оценках Moodle (`grade/report/user`): имя элемента лежит в `<th class="column-itemname
 * levelN">`, а не в `<td>`, поэтому `extractTable` (читает только `td` по индексу заголовков)
 * сдвигает ключи колонок и теряет имя. Здесь имя — из `th`, путь категорий — из `levelN`, оценка —
 * из `td.column-grade` (по классу, не по индексу). Подтверждено вживую 2026-10-15 на 5 курсах.
 */
export async function extractGradeTable(page: Page, selector = "table.user-grade"): Promise<GradeTable> {
  return page.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return { found: false, recognized: false, rows: [] };
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const stack: string[] = [];
    const rows: Array<{ name: string; level: number; path: string[]; isCategory: boolean; grade: string | null }> = [];
    let sawName = false;
    let sawGrade = false;
    for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
      const th = tr.querySelector("th.column-itemname");
      if (!th) continue;
      sawName = true;
      const levelClass = Array.from(th.classList).find((c) => /^level\d+$/.test(c));
      const level = levelClass ? Number(levelClass.slice(5)) : 0;
      const name = clean(th.textContent);
      const gradeCell = tr.querySelector("td.column-grade");
      const path = stack.slice(0, level).filter((x) => x !== undefined);
      if (!gradeCell) {
        stack.length = level;
        stack[level] = name;
        rows.push({ name, level, path, isCategory: true, grade: null });
        continue;
      }
      sawGrade = true;
      rows.push({ name, level, path, isCategory: false, grade: clean(gradeCell.textContent) });
    }
    return { found: true, recognized: sawName && sawGrade, rows };
  }, selector);
}
```

- [ ] **Step 2: `lms/client.ts`**

Импорт (строка 4): `import { dumpPage, extractGradeTable, extractTable, type GradeTable, type PageDump } from "../../dom-utils.js";`

Добавить **после** `getGrades` (его код не менять):

```ts
const lmsGradeItems = defineResource<number, GradeTable>({
  name: "lms.grade-items",
  ttl: TTL.medium,
  key: (courseId) => String(courseId),
  load: (courseId, ctx) =>
    withPage(
      `${BASE_URL}/grade/report/user/index.php?id=${courseId}`,
      (page) => extractGradeTable(page),
      { signal: ctx.signal }
    ),
});

/**
 * Структурированный журнал оценок курса (имя элемента, путь категорий, оценка) — для снимков
 * `hse_changes`. Отдельно от `getGrades`: тот отдаёт сырые строки `extractTable` с ключами,
 * сдвинутыми относительно заголовков, и в №3 не меняется (обратная совместимость).
 */
export function listGradeItems(courseId: number, opts?: ResourceCallOptions): Promise<GradeTable> {
  return lmsGradeItems(courseId, opts);
}
```

- [ ] **Step 3: Сборка** — Expected: код 0.

- [ ] **Step 4: Проверка** `$SCRATCH/verify-3/t5-grade-table.mjs` — локальный Chromium, фикстура `setContent`, без сети.

```js
import { pathToFileURL } from "node:url";
import { dist, check, finish, NODE_MODULES } from "./lib.mjs";

const { chromium } = await import(pathToFileURL(`${NODE_MODULES}/playwright/index.mjs`).href);
const { extractGradeTable, extractTable } = await dist("dom-utils.js");

const cat = (name, lvl) => `<tr><th class="level${lvl} category column-itemname">${name}</th><td class="cell c1 baggt" colspan="6"></td></tr>`;
const item = (name, lvl, grade) =>
  `<tr><th class="level${lvl} item column-itemname">${name}</th><td class="column-weight">10 %</td>` +
  `<td class="column-grade">${grade}</td><td class="column-range">0–10</td><td class="column-percentage">80 %</td>` +
  `<td class="column-feedback"></td><td class="column-contributiontocoursetotal">8 %</td></tr>`;
const html = `<table class="generaltable boxaligncenter user-grade"><thead><tr>
<th class="header column-itemname">Элемент</th><th class="header column-weight">Вес</th><th class="header column-grade">Оценка</th>
<th class="header column-range">Диапазон</th><th class="header column-percentage">Проценты</th><th class="header column-feedback">Отзыв</th>
<th class="header column-contributiontocoursetotal lastcol">Вклад</th></tr></thead><tbody>
${cat("Категория А", 1)}${item("Тест 1", 2, "8,00")}${item("Тест 2", 2, "-")}
${cat("Категория Б", 1)}${item("Тест 1", 2, "5,00")}${item("Итого за курс", 1, "6,5")}<tr></tr>
</tbody></table>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html);
const t = await extractGradeTable(page);
check(t.found && t.recognized, "таблица найдена и распознана");
check(t.rows.length === 6, "6 строк с th.column-itemname (пустая строка пропущена)");
const byName = t.rows.filter((r) => r.name === "Тест 1");
check(byName.length === 2 && byName[0].path.join("/") === "Категория А" && byName[1].path.join("/") === "Категория Б",
  "одноимённые элементы различаются путём категорий");
check(t.rows[2].grade === "-" && t.rows[1].grade === "8,00", "оценка берётся из td.column-grade");
check(t.rows[0].isCategory && t.rows[0].grade === null, "категория: isCategory, grade null");
const total = t.rows[5];
check(total.name === "Итого за курс" && total.path.length === 0, "строка уровня 1 после категории — без пути");

// дефект существующего extractTable (подтверждение причины нового парсера)
const old = await extractTable(page, "table.user-grade");
const itemRow = old.find((r) => Object.keys(r).length === 6);
check(itemRow && Object.values(itemRow).every((v) => v !== "Тест 1"), "extractTable теряет имя элемента (th)");

await page.setContent("<table class='generaltable'><tbody><tr><td>x</td></tr></tbody></table>");
const none = await extractGradeTable(page);
check(!none.found && !none.recognized && none.rows.length === 0, "нет table.user-grade → found:false");
await page.setContent("<table class='user-grade'><tbody><tr><td>x</td></tr></tbody></table>");
const odd = await extractGradeTable(page);
check(odd.found && !odd.recognized && odd.rows.length === 0, "чужая вёрстка → found, не recognized");
await browser.close();
finish();
```

Run: `node $SCRATCH/verify-3/t5-grade-table.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 5: Проверка неизменности `getGrades`**

Run (Git Bash): `git diff -U0 src/services/lms/client.ts | grep -nE "^-.*(lmsGrades|getGrades)"`
Expected: пустой вывод (ни одной УДАЛЁННОЙ строки с `getGrades`/`lmsGrades`: существующий код не затронут). Добавленные строки (`^+`) не проверяются — комментарий к `listGradeItems` законно упоминает `getGrades`.

- [ ] **Step 6: Коммит**

```bash
git add src/dom-utils.ts src/services/lms/client.ts
git commit -m "Add structured grade-table parser and lms.grade-items resource

getGrades and lms_get_grades are left untouched (their column shift is
tracked separately).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `changes` — типы, нормализация, diff

**Files:**
- Create: `src/services/changes/types.ts`, `src/services/changes/normalize.ts`, `src/services/changes/diff.ts`

**Interfaces:**
- Produces (используются задачами 7–10):
```ts
// types.ts
export const STATE_VERSION = 1;
export type Scope = "deadlines" | "schedule" | "inbox" | "claims" | "grades";
export const SCOPES: readonly Scope[]; export const DEFAULT_SCOPES: readonly Scope[];
export function scopeOfSource(source: string): Scope | null;
export interface Fact { id; scope; kind; title; course?; attrs: Record<string, string|null>; at?: string; matchKey?: string }
export interface Coverage { from: string | null; to: string | null }
export type EventType = "added" | "changed" | "removed" | "moved" | "overdue";
export interface FieldChange { field: string; from: string | null; to: string | null }
export interface ChangeEvent { seq: number; at: string; scope: Scope; source: string; type: EventType; cause?: "clock"; id: string; kind: string; title: string; course?: string; fields?: FieldChange[] }
export interface Baseline { takenAt: string; coverage?: Coverage; facts: Record<string, Fact> }
export interface State { version; rev; nextSeq; issued: Partial<Record<Scope, number>>; lost: Partial<Record<Scope, number>>; baselines: Record<string, Baseline>; journal: ChangeEvent[]; seen: Partial<Record<Scope, number>> }
export interface DiffFlags { emitChanged?; emitRemoved?; carryMissing?; mergeMoves?; detectOverdue?; silentEmptyGrade? }
export interface SourceResult { facts: Fact[]; coverage?: Coverage; warnings?: string[]; truncated?: boolean }
// normalize.ts
normText(v: unknown): string; normOrNull(v: unknown): string | null; utcMinute(v: Date|number|string): string | null;
mskNaive(dateText: string, timeText?: string | null): string | null; sopNaive(text: string): string | null;
isEmptyGrade(v: string | null | undefined): boolean; canonicalAttrs(a): Record<string, string|null>; fingerprint(a): string;
dedupeIds<T extends { id: string }>(items: T[]): T[]
// diff.ts
export type RawEvent = Omit<ChangeEvent, "seq" | "at">;
export interface DiffInput extends DiffFlags { source: string; scope: Scope; baseline: Baseline | null; facts: Fact[]; coverage?: Coverage; truncated?: boolean; takenAt: Date }
export interface DiffOutput { events: RawEvent[]; baseline: Baseline; status: "baseline" | "ok" }
export function diffSource(input: DiffInput): DiffOutput
```

- [ ] **Step 1: `types.ts`**

```ts
/** Версия формата `state.json`; файл новее известной версии не трогается. */
export const STATE_VERSION = 1;

export type Scope = "deadlines" | "schedule" | "inbox" | "claims" | "grades";
export const SCOPES: readonly Scope[] = ["deadlines", "schedule", "inbox", "claims", "grades"];
/** Область `grades` дорогая (страница на курс) — только по явной просьбе. */
export const DEFAULT_SCOPES: readonly Scope[] = ["deadlines", "schedule", "inbox", "claims"];

const SOURCE_SCOPE: Readonly<Record<string, Scope>> = {
  lms_calendar: "deadlines",
  elk_windows: "deadlines",
  elk_schedule: "schedule",
  lms_messages: "inbox",
  elk_notifications: "inbox",
  elk_claims: "claims",
};

/** Область источника; `lms_courses` (список курсов) и `lms_grades:<id>` — область `grades`. */
export function scopeOfSource(source: string): Scope | null {
  if (source === "lms_courses" || source.startsWith("lms_grades:")) return "grades";
  return SOURCE_SCOPE[source] ?? null;
}

/** Нормализованный отслеживаемый факт. В `attrs` — только поля, изменение которых есть событие. */
export interface Fact {
  /** Стабилен между снимками. */
  id: string;
  scope: Scope;
  kind: string;
  title: string;
  course?: string;
  attrs: Record<string, string | null>;
  /** Ось покрытия (момент в формате источника) — только у фактов со скользящим окном. */
  at?: string;
  /** Ключ склейки `removed`+`added` в `moved` (расписание: название|тип). */
  matchKey?: string;
}

/** Границы окна, в котором источник «видит» факты; `null` — не ограничено. Сравнение строк. */
export interface Coverage {
  from: string | null;
  to: string | null;
}

export type EventType = "added" | "changed" | "removed" | "moved" | "overdue";

export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface ChangeEvent {
  /** Глобальный, монотонный; выдаётся только при успешном коммите. */
  seq: number;
  /** Момент снимка, породившего событие (ISO UTC). */
  at: string;
  scope: Scope;
  source: string;
  type: EventType;
  /** `clock` — событие порождено ходом часов, а не изменением данных. */
  cause?: "clock";
  id: string;
  kind: string;
  title: string;
  course?: string;
  fields?: FieldChange[];
}

export interface Baseline {
  takenAt: string;
  coverage?: Coverage;
  facts: Record<string, Fact>;
}

export interface State {
  version: number;
  rev: number;
  /** Монотонен: не сбрасывается ни срезом журнала, ни `hse_changes_reset`. */
  nextSeq: number;
  /** Наибольший `seq`, выданный в ответе, по областям (ограничивает `ack`). */
  issued: Partial<Record<Scope, number>>;
  /** Невыданные события, срезанные потолком журнала; сообщаются в `gap` один раз. */
  lost: Partial<Record<Scope, number>>;
  baselines: Record<string, Baseline>;
  journal: ChangeEvent[];
  /** Курсор подтверждённого по областям. */
  seen: Partial<Record<Scope, number>>;
}

/** Правила сравнения источника. По умолчанию — все события включены, отсутствующее переносится. */
export interface DiffFlags {
  /** По умолчанию true. */
  emitChanged?: boolean;
  /** По умолчанию true; false у входящего, оценок и заявок (у заявок события только `added`/`changed`, §5). */
  emitRemoved?: boolean;
  /** Переносить в новую базу факты, отсутствующие в ответе (по умолчанию true; для входящего и оценок — false; у заявок — по умолчанию). */
  carryMissing?: boolean;
  /** Склеивать `removed`+`added` с одинаковым `matchKey` в `moved`. */
  mergeMoves?: boolean;
  /** Порождать `overdue` по `attrs.due`. */
  detectOverdue?: boolean;
  /** Новый элемент с пустой оценкой — не событие. */
  silentEmptyGrade?: boolean;
}

/** Что отдаёт извлекатель источника. */
export interface SourceResult {
  facts: Fact[];
  coverage?: Coverage;
  warnings?: string[];
  /** Выборка усечена: `removed` не вычисляется. */
  truncated?: boolean;
}
```

- [ ] **Step 2: `normalize.ts`**

```ts
/** Нормализация перед сравнением: чтобы diff был событием, а не шумом (§6). */

const pad = (n: number): string => String(n).padStart(2, "0");

/** NFC, trim, схлопывание пробельных символов; null/undefined → "". Регистр не меняется. */
export function normText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFC").replace(/\s+/g, " ").trim();
}

export function normOrNull(value: unknown): string | null {
  const s = normText(value);
  return s === "" ? null : s;
}

/** Момент → `ГГГГ-ММ-ДДTЧЧ:ммZ` (UTC, без секунд); null, если не распознан. Пояс машины не участвует. */
export function utcMinute(value: Date | number | string): string | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
  );
}

/** Дата `ГГГГ-ММ-ДД` + время `Ч:мм` (МСК) → наивное `ГГГГ-ММ-ДДTЧЧ:мм`; без времени — 00:00; null — дата не распознана. */
export function mskNaive(dateText: string, timeText?: string | null): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(normText(dateText));
  if (!d) return null;
  const t = /(\d{1,2}):(\d{2})/.exec(normText(timeText));
  return `${d[1]}-${d[2]}-${d[3]}T${t ? pad(Number(t[1])) : "00"}:${t ? t[2] : "00"}`;
}

/** «23:59 25.10.2026 по московскому времени» → `2026-10-25T23:59`; без времени — конец дня 23:59. */
export function sopNaive(text: string): string | null {
  const s = normText(text);
  const date = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (!date) return null;
  const time = /(\d{1,2}):(\d{2})/.exec(s);
  return `${date[3]}-${pad(Number(date[2]))}-${pad(Number(date[1]))}T${time ? pad(Number(time[1])) : "23"}:${time ? time[2] : "59"}`;
}

/** Пустая оценка Moodle: ничего, «-», «–», «—». */
export function isEmptyGrade(value: string | null | undefined): boolean {
  const s = normText(value);
  return s === "" || s === "-" || s === "–" || s === "—";
}

/** Канонический вид `attrs`: ключи по алфавиту, значения нормализованы, пустое = null. */
export function canonicalAttrs(attrs: Record<string, string | null | undefined>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(attrs).sort()) out[key] = normOrNull(attrs[key]);
  return out;
}

/** Отпечаток `attrs`: детерминированная строка; `null`, `undefined` и "" равны. */
export function fingerprint(attrs: Record<string, string | null | undefined>): string {
  return JSON.stringify(canonicalAttrs(attrs));
}

/** Повторяющиеся `id` в одном ответе: второй и далее получают суффикс `#n` — факт не теряется. */
export function dedupeIds<T extends { id: string }>(items: T[]): T[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const n = (counts.get(item.id) ?? 0) + 1;
    counts.set(item.id, n);
    return n === 1 ? item : { ...item, id: `${item.id}#${n}` };
  });
}
```

- [ ] **Step 3: `diff.ts`**

```ts
import { fingerprint, isEmptyGrade } from "./normalize.js";
import type { Baseline, ChangeEvent, Coverage, DiffFlags, Fact, FieldChange, Scope } from "./types.js";

export type RawEvent = Omit<ChangeEvent, "seq" | "at">;

export interface DiffInput extends DiffFlags {
  source: string;
  scope: Scope;
  /** `null` — первый запуск источника: база создаётся без событий. */
  baseline: Baseline | null;
  facts: Fact[];
  coverage?: Coverage;
  /** Выборка усечена: `removed` не вычисляется, отсутствующее переносится. */
  truncated?: boolean;
  takenAt: Date;
}

export interface DiffOutput {
  events: RawEvent[];
  baseline: Baseline;
  status: "baseline" | "ok";
}

/** Пересечение покрытий: максимум нижних границ и минимум верхних (null — не ограничено). */
function intersect(a: Coverage | undefined, b: Coverage | undefined): Coverage {
  const lows = [a?.from, b?.from].filter((x): x is string => typeof x === "string");
  const highs = [a?.to, b?.to].filter((x): x is string => typeof x === "string");
  return {
    from: lows.length ? lows.reduce((m, x) => (x > m ? x : m)) : null,
    to: highs.length ? highs.reduce((m, x) => (x < m ? x : m)) : null,
  };
}

/** Факт без оси (`at` не задан) считается внутри окна всегда. */
const inCoverage = (at: string | undefined, c: Coverage): boolean =>
  at === undefined || ((c.from === null || at >= c.from) && (c.to === null || at <= c.to));

function fieldChanges(before: Record<string, string | null>, after: Record<string, string | null>): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((k) => (before[k] ?? null) !== (after[k] ?? null))
    .map((k) => ({ field: k, from: before[k] ?? null, to: after[k] ?? null }));
}

function mergeMoves(
  events: RawEvent[],
  before: Record<string, Fact>,
  after: Map<string, Fact>,
  base: { source: string; scope: Scope }
): RawEvent[] {
  const groups = new Map<string, { removed: RawEvent[]; added: RawEvent[] }>();
  const bucket = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { removed: [], added: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const e of events) {
    if (e.type === "removed") {
      const key = before[e.id]?.matchKey;
      if (key) bucket(key).removed.push(e);
    } else if (e.type === "added") {
      const key = after.get(e.id)?.matchKey;
      if (key) bucket(key).added.push(e);
    }
  }
  const dropped = new Set<RawEvent>();
  const moved: RawEvent[] = [];
  for (const g of groups.values()) {
    // Неоднозначная склейка (несколько кандидатов) не выполняется.
    if (g.removed.length !== 1 || g.added.length !== 1) continue;
    const oldFact = before[g.removed[0].id];
    const newFact = after.get(g.added[0].id);
    if (!oldFact || !newFact) continue;
    dropped.add(g.removed[0]);
    dropped.add(g.added[0]);
    moved.push({
      ...base,
      type: "moved",
      id: newFact.id,
      kind: newFact.kind,
      title: newFact.title,
      ...(newFact.course ? { course: newFact.course } : {}),
      fields: [{ field: "start", from: oldFact.at ?? null, to: newFact.at ?? null }, ...fieldChanges(oldFact.attrs, newFact.attrs)],
    });
  }
  return [...events.filter((e) => !dropped.has(e)), ...moved];
}

/**
 * Сравнивает новые факты источника с его базой и возвращает события и новую базу. Чистая функция:
 * не читает часы и диск. `added`/`removed` считаются только внутри пересечения старого и нового
 * покрытий; факты вне пересечения не порождают событий (§11).
 */
export function diffSource(input: DiffInput): DiffOutput {
  const emitChanged = input.emitChanged ?? true;
  const emitRemoved = input.emitRemoved ?? true;
  const carryMissing = input.carryMissing ?? true;
  const takenAt = input.takenAt.toISOString();

  const fresh = new Map<string, Fact>();
  for (const f of input.facts) if (!fresh.has(f.id)) fresh.set(f.id, f);

  const makeBaseline = (carried: Fact[]): Baseline => {
    const facts: Record<string, Fact> = {};
    for (const f of carried) facts[f.id] = f;
    for (const [id, f] of fresh) facts[id] = f;
    return { takenAt, ...(input.coverage ? { coverage: input.coverage } : {}), facts };
  };

  if (input.baseline === null) return { events: [], baseline: makeBaseline([]), status: "baseline" };

  const old = input.baseline;
  const window = intersect(old.coverage, input.coverage);
  const base = { source: input.source, scope: input.scope };
  const make = (type: RawEvent["type"], f: Fact, extra: Partial<RawEvent> = {}): RawEvent => ({
    ...base,
    type,
    id: f.id,
    kind: f.kind,
    title: f.title,
    ...(f.course ? { course: f.course } : {}),
    ...extra,
  });
  const nowMs = input.takenAt.getTime();
  const prevMs = Date.parse(old.takenAt);
  let events: RawEvent[] = [];

  for (const [id, f] of fresh) {
    const before = old.facts[id];
    if (!before) {
      if (!inCoverage(f.at, window)) continue;
      if (input.silentEmptyGrade && isEmptyGrade(f.attrs.grade)) continue;
      events.push(make("added", f));
      continue;
    }
    if (emitChanged && fingerprint(before.attrs) !== fingerprint(f.attrs)) {
      events.push(make("changed", f, { fields: fieldChanges(before.attrs, f.attrs) }));
    }
    if (input.detectOverdue && f.attrs.due) {
      const due = Date.parse(f.attrs.due);
      // Просрочка — ход часов: срок пересёк «сейчас» между снимками, а элемент всё ещё в источнике.
      if (!Number.isNaN(due) && prevMs < due && due <= nowMs) events.push(make("overdue", f, { cause: "clock" }));
    }
  }

  const carried: Fact[] = [];
  for (const [id, before] of Object.entries(old.facts)) {
    if (fresh.has(id)) continue;
    // Ушёл ниже нового покрытия — окно сдвигается только вперёд, назад факт не вернётся: забываем.
    if (input.coverage?.from != null && before.at !== undefined && before.at < input.coverage.from) continue;
    if (emitRemoved && !input.truncated && inCoverage(before.at, window)) {
      events.push(make("removed", before));
      continue;
    }
    if (carryMissing) carried.push(before);
  }

  if (input.mergeMoves) events = mergeMoves(events, old.facts, fresh, base);
  return { events, baseline: makeBaseline(carried), status: "ok" };
}
```

- [ ] **Step 4: Сборка** — Expected: код 0.

- [ ] **Step 5: Проверка** `$SCRATCH/verify-3/t6-diff.mjs`

```js
import { dist, check, finish } from "./lib.mjs";
const n = await dist("services/changes/normalize.js");
const { diffSource } = await dist("services/changes/diff.js");

// --- normalize
check(n.normText("  A\u00A0\n b ") === "A b", "normText: пробелы и NBSP");
check(n.normText("e\u0301") === n.normText("\u00E9"), "normText: NFC");
check(n.utcMinute("2026-10-14T20:59:00.000Z") === "2026-10-14T20:59Z", "utcMinute");
check(n.mskNaive("2026-10-14", "13:00") === "2026-10-14T13:00", "mskNaive");
check(n.mskNaive("2026-10-14", "9:05") === "2026-10-14T09:05", "mskNaive: дополнение нулём");
check(n.mskNaive("плохо") === null, "mskNaive: не распознано → null");
check(n.sopNaive("23:59 25.10.2026 по московскому времени") === "2026-10-25T23:59", "sopNaive");
check(n.fingerprint({ b: "1", a: null }) === n.fingerprint({ a: "", b: "1" }), "fingerprint: null = пусто, порядок ключей");
check(n.isEmptyGrade("-") && n.isEmptyGrade(" ") && !n.isEmptyGrade("5,0"), "isEmptyGrade");
check(JSON.stringify(n.dedupeIds([{ id: "a" }, { id: "a" }, { id: "a" }, { id: "b" }]).map((x) => x.id)) === '["a","a#2","a#3","b"]', "dedupeIds");

// --- diff
const T0 = new Date("2026-10-10T10:00:00Z");
const T1 = new Date("2026-10-15T10:00:00Z");
const F = (id, attrs, extra = {}) => ({ id, scope: "deadlines", kind: "assignment", title: id.toUpperCase(), attrs, ...extra });
const base = (facts, coverage) => ({ takenAt: T0.toISOString(), ...(coverage ? { coverage } : {}), facts: Object.fromEntries(facts.map((f) => [f.id, f])) });
const run = (o) => diffSource({ source: "s", scope: "deadlines", takenAt: T1, ...o });
const types = (r) => r.events.map((e) => `${e.type}:${e.id}`).sort().join(",");

let r = run({ baseline: null, facts: [F("a", { due: "x" })] });
check(r.status === "baseline" && r.events.length === 0 && r.baseline.facts.a, "первый запуск: база без событий");

const cov0 = { from: "2026-10-01T00:00Z", to: "2026-12-01T00:00Z" };
const cov1 = { from: "2026-10-05T00:00Z", to: "2026-12-05T00:00Z" };
r = run({
  baseline: base([F("keep", { due: "1" }, { at: "2026-10-20T00:00Z" }), F("gone", { due: "1" }, { at: "2026-10-20T00:00Z" }),
    F("below", { due: "1" }, { at: "2026-10-02T00:00Z" }), F("chg", { due: "1" }, { at: "2026-10-21T00:00Z" })], cov0),
  facts: [F("keep", { due: "1" }, { at: "2026-10-20T00:00Z" }), F("chg", { due: "2" }, { at: "2026-10-21T00:00Z" }),
    F("new", { due: "1" }, { at: "2026-10-22T00:00Z" }), F("old-new", { due: "1" }, { at: "2026-10-03T00:00Z" })],
  coverage: cov1,
});
check(types(r) === "added:new,changed:chg,removed:gone", "added/changed/removed внутри пересечения; «ниже окна» и «новое вне окна» молчат");
check(!r.baseline.facts.below, "факт ниже нового покрытия забыт молча");
check(r.events.find((e) => e.id === "chg").fields[0].from === "1", "changed: from/to");

r = run({ baseline: base([F("gone", { due: "1" }, { at: "2026-10-20T00:00Z" })], cov0), facts: [], coverage: cov1, truncated: true });
check(r.events.length === 0 && r.baseline.facts.gone, "truncated: removed не вычисляется, факт перенесён");

// Review Focus 1: пустой источник при непустой базе → removed по всем в покрытии
r = run({
  baseline: base([F("a", { due: "1" }, { at: "2026-10-20T00:00Z" }), F("b", { due: "1" }, { at: "2026-10-21T00:00Z" }), F("c", { due: "1" }, { at: "2026-10-22T00:00Z" })], cov0),
  facts: [], coverage: cov0,
});
check(types(r) === "removed:a,removed:b,removed:c", "пустой ответ при непустой базе → removed по каждому");

// overdue: срок между снимками, элемент ещё в календаре
r = run({
  baseline: base([F("t", { due: "2026-10-12T09:00Z" }, { at: "2026-10-12T09:00Z" })], cov0),
  facts: [F("t", { due: "2026-10-12T09:00Z" }, { at: "2026-10-12T09:00Z" })], coverage: cov0, detectOverdue: true,
});
check(types(r) === "overdue:t" && r.events[0].cause === "clock", "overdue: cause clock");
r = run({
  baseline: base([F("t", { due: "2026-10-09T09:00Z" }, { at: "2026-10-09T09:00Z" })], cov0),
  facts: [F("t", { due: "2026-10-09T09:00Z" }, { at: "2026-10-09T09:00Z" })], coverage: cov0, detectOverdue: true,
});
check(r.events.length === 0, "overdue: уже просрочено к прошлому снимку — повторно не порождается");

// inbox: только added, пропажа и изменения молчат, отсутствующее не переносится
r = run({
  baseline: base([F("m1", { subject: "a" }), F("m2", { subject: "b" })]),
  facts: [F("m1", { subject: "A!" }), F("m3", { subject: "c" })], emitChanged: false, emitRemoved: false, carryMissing: false,
});
check(types(r) === "added:m3" && !r.baseline.facts.m2, "inbox: только added; m2 не перенесён");

// claims: только added/changed (§5); пропажа молчит, факт переносится в базу (carryMissing по умолчанию)
r = run({
  baseline: base([F("c1", { state: "A" }), F("c2", { state: "B" })]),
  facts: [F("c1", { state: "A2" }), F("c3", { state: "C" })], emitRemoved: false,
});
check(types(r) === "added:c3,changed:c1" && r.baseline.facts.c2, "claims: removed не порождается, c2 перенесён в базу");

// grades
const G = (id, grade) => F(id, { grade }, { scope: "grades", kind: "grade_item" });
r = run({
  baseline: base([G("c|x|a", null), G("c|x|b", "5")]),
  facts: [G("c|x|a", "7"), G("c|x|b", "5"), G("c|x|n1", null), G("c|x|n2", "9")], silentEmptyGrade: true, emitRemoved: false, carryMissing: false,
});
check(types(r) === "added:c|x|n2,changed:c|x|a", "grades: пустая оценка нового элемента молчит, null→7 — changed");

// moved
const L = (id, at, aud, key) => ({ id, scope: "schedule", kind: "lesson", title: "Матан", attrs: { auditorium: aud }, at, matchKey: key });
const covS0 = { from: "2026-10-15T00:00", to: "2026-10-29T23:59" };
r = run({
  scope: "schedule", mergeMoves: true,
  baseline: base([L("2026-10-16|10:00|Матан|Лекция", "2026-10-16T10:00", "101", "Матан|Лекция")], covS0),
  facts: [L("2026-10-17|12:00|Матан|Лекция", "2026-10-17T12:00", "202", "Матан|Лекция")], coverage: covS0,
});
check(r.events.length === 1 && r.events[0].type === "moved" && r.events[0].fields[0].field === "start" &&
  r.events[0].fields.some((f) => f.field === "auditorium"), "moved: removed+added склеены, start и аудитория");
r = run({
  scope: "schedule", mergeMoves: true,
  baseline: base([L("a|1", "2026-10-16T10:00", "1", "Матан|Лекция"), L("a|2", "2026-10-16T12:00", "1", "Матан|Лекция")], covS0),
  facts: [L("b|1", "2026-10-17T10:00", "1", "Матан|Лекция")], coverage: covS0,
});
check(r.events.every((e) => e.type !== "moved") && r.events.length === 3, "moved: неоднозначная склейка не выполняется");
finish();
```

Run: `node $SCRATCH/verify-3/t6-diff.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 6: Коммит**

```bash
git add src/services/changes/types.ts src/services/changes/normalize.ts src/services/changes/diff.ts
git commit -m "Add changes types, normalization and the pure diff function

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `changes` — хранилище `state.json`

**Files:**
- Create: `src/services/changes/store.ts`

**Interfaces:**
- Consumes: `projectRoot` (T1), типы (T6).
- Produces:
```ts
export const JOURNAL_MAX_EVENTS = 500, JOURNAL_MAX_AGE_MS = 30 * 86_400_000, GRADES_BASELINE_MAX_AGE_MS = 90 * 86_400_000;
export function defaultStateDir(): string;                           // <projectRoot>/storage/changes
export function emptyState(): State;
export type LoadKind = "ok" | "missing" | "corrupt" | "newer" | "io-error";
export interface LoadResult { kind: LoadKind; state: State; warning?: string }
export function loadState(dir: string): Promise<LoadResult>;
export function saveState(dir: string, state: State, expectedRev: number | null): Promise<{ ok: true } | { ok: false; error: string }>;
export function withStateLock<T>(dir: string, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T>;
export function pruneJournal(state: State, now: Date): void;
export function pruneGradeBaselines(state: State, now: Date): void;
```
- Семантика: чтение с повторами при `EPERM/EACCES/EBUSY`; `.corrupt-<метка>` только при невалидном JSON/схеме; `newer`/`io-error` — файл не трогается и вызывающий не пишет; запись — `tmp` с pid + `rename` с повторами; `expectedRev` сверяется с диском перед `rename`.

- [ ] **Step 1: `store.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../../project-root.js";
import { STATE_VERSION, type Scope, type State } from "./types.js";

export const JOURNAL_MAX_EVENTS = 500;
export const JOURNAL_MAX_AGE_MS = 30 * 86_400_000;
export const GRADES_BASELINE_MAX_AGE_MS = 90 * 86_400_000;

const IO_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const LOCK_STALE_MS = 30_000;
const LOCK_DEFAULT_WAIT_MS = 10_000;

export const defaultStateDir = (): string => path.join(projectRoot, "storage", "changes");
const stateFile = (dir: string): string => path.join(dir, "state.json");
const lockFile = (dir: string): string => path.join(dir, "state.json.lock");

export function emptyState(): State {
  return { version: STATE_VERSION, rev: 0, nextSeq: 1, issued: {}, lost: {}, baselines: {}, journal: [], seen: {} };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;
/** Файл занят антивирусом/индексатором/другим процессом (Windows) — повторить, а не считать повреждением. */
const isBusy = (code: string | undefined): boolean => code === "EPERM" || code === "EACCES" || code === "EBUSY";

async function retryIo<T>(op: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (!isBusy(errCode(err)) || attempt >= IO_RETRY_DELAYS_MS.length) throw err;
      await sleep(IO_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isValidState(x: unknown): x is State {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const obj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  return (
    num(s.version) && num(s.rev) && num(s.nextSeq) &&
    obj(s.issued) && obj(s.lost) && obj(s.baselines) && obj(s.seen) && Array.isArray(s.journal)
  );
}

export type LoadKind = "ok" | "missing" | "corrupt" | "newer" | "io-error";
export interface LoadResult {
  kind: LoadKind;
  state: State;
  warning?: string;
}

export async function loadState(dir: string): Promise<LoadResult> {
  const file = stateFile(dir);
  let text: string;
  try {
    text = await retryIo(() => fs.readFileSync(file, "utf8"));
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT") return { kind: "missing", state: emptyState() };
    return {
      kind: "io-error",
      state: emptyState(),
      warning: `не удалось прочитать state.json (${code ?? "ошибка ввода-вывода"}); запись пропущена, файл не тронут`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isValidState(parsed) || parsed.version < 1) {
    // Только невалидный JSON/схема считаются повреждением; прежние .corrupt не затираются.
    try {
      await retryIo(() => fs.renameSync(file, `${file}.corrupt-${Date.now()}`));
    } catch {
      /* не удалось переместить — база всё равно стартует чистой */
    }
    return { kind: "corrupt", state: emptyState(), warning: "state.json повреждён: перемещён в .corrupt-*, начата чистая база" };
  }
  if (parsed.version > STATE_VERSION) {
    return {
      kind: "newer",
      state: emptyState(),
      warning: `state.json создан более новой версией (${parsed.version} > ${STATE_VERSION}); файл не тронут, запись пропущена`,
    };
  }
  return { kind: "ok", state: parsed };
}

function readRevOnDisk(file: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { rev?: unknown };
    return typeof parsed.rev === "number" ? parsed.rev : -1;
  } catch (err) {
    return errCode(err) === "ENOENT" ? null : -1;
  }
}

/**
 * Атомарная запись: во временный файл с pid и `rename` поверх (с повторами). `expectedRev` — `rev`,
 * прочитанный под блокировкой; если на диске другой (файл поменял не-hsemcp процесс), запись
 * отклоняется. `null` — файла при чтении не было.
 */
export async function saveState(
  dir: string,
  state: State,
  expectedRev: number | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const file = stateFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const onDisk = readRevOnDisk(file);
    if (onDisk !== null && onDisk !== expectedRev) {
      return { ok: false, error: "state.json изменён другим процессом (rev не совпал)" };
    }
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    await retryIo(() => fs.renameSync(tmp, file));
    return { ok: true };
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp мог не создаться */
    }
    return { ok: false, error: `не удалось записать state.json (${errCode(err) ?? "ошибка ввода-вывода"})` };
  }
}

let mutexTail: Promise<unknown> = Promise.resolve();

/**
 * Внутрипроцессный мьютекс + lock-файл `state.json.lock` (`wx`) на цикл «прочитать → пересчитать →
 * записать». Сбор данных идёт вне блокировки. Устаревшая (> 30 с) блокировка снимается.
 */
export function withStateLock<T>(dir: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const run = mutexTail.then(
    () => withFileLock(dir, fn, opts.waitMs ?? LOCK_DEFAULT_WAIT_MS),
    () => withFileLock(dir, fn, opts.waitMs ?? LOCK_DEFAULT_WAIT_MS)
  );
  mutexTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function withFileLock<T>(dir: string, fn: () => Promise<T>, waitMs: number): Promise<T> {
  fs.mkdirSync(dir, { recursive: true });
  const lock = lockFile(dir);
  const deadline = Date.now() + waitMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch (err) {
      const code = errCode(err);
      if (code !== "EEXIST" && !isBusy(code)) throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // блокировка исчезла между проверками — пробуем снова
      }
      if (Date.now() > deadline) {
        throw new Error(`state.json занят другим процессом: блокировка не освободилась за ${waitMs / 1000} с`);
      }
      await sleep(50 + Math.floor(Math.random() * 100));
    }
  }
  try {
    try {
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
    } catch {
      /* содержимое блокировки справочное */
    }
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* уже закрыт */
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      /* уже снята */
    }
  }
}

/**
 * Срезы журнала: событие старше 30 дней уходит, только если его `seq` ≤ min(`seen`) по областям;
 * потолок 500 срезает старейшие, в том числе невыданные (они считаются в `lost`). Журнал упорядочен
 * по `seq` по возрастанию.
 */
export function pruneJournal(state: State, now: Date): void {
  const seen = Object.values(state.seen).filter((v): v is number => typeof v === "number");
  const minSeen = seen.length ? Math.min(...seen) : 0;
  const cutoff = now.getTime() - JOURNAL_MAX_AGE_MS;
  state.journal = state.journal.filter((e) => !(Date.parse(e.at) < cutoff && e.seq <= minSeen));
  while (state.journal.length > JOURNAL_MAX_EVENTS) {
    const dropped = state.journal.shift();
    if (dropped && dropped.seq > (state.seen[dropped.scope] ?? 0)) {
      const scope: Scope = dropped.scope;
      state.lost[scope] = (state.lost[scope] ?? 0) + 1;
    }
  }
}

/** Базы `lms_grades:<id>`, не обновлявшиеся 90 дней (курс исчез из актуальных), удаляются. */
export function pruneGradeBaselines(state: State, now: Date): void {
  const cutoff = now.getTime() - GRADES_BASELINE_MAX_AGE_MS;
  for (const [source, baseline] of Object.entries(state.baselines)) {
    if (source.startsWith("lms_grades:") && Date.parse(baseline.takenAt) < cutoff) delete state.baselines[source];
  }
}
```

- [ ] **Step 2: Сборка** — Expected: код 0.

- [ ] **Step 3: Проверка** `$SCRATCH/verify-3/t7-store.mjs` (временный каталог, без сети)

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dist, check, finish, sleep } from "./lib.mjs";
const s = await dist("services/changes/store.js");

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "t7-"));
let dir = mkdir();

// Review Focus 5: чистый storage — каталога changes нет
const sub = path.join(dir, "storage", "changes");
let r = await s.loadState(sub);
check(r.kind === "missing" && r.state.nextSeq === 1, "нет файла → missing, чистое состояние");
const st = s.emptyState();
st.rev = 1; st.nextSeq = 5;
let w = await s.saveState(sub, st, null);
check(w.ok && fs.existsSync(path.join(sub, "state.json")), "каталог создаётся, файл записан");
r = await s.loadState(sub);
check(r.kind === "ok" && r.state.nextSeq === 5 && r.state.rev === 1, "запись → чтение");
check(!fs.readdirSync(sub).some((f) => f.endsWith(".tmp")), "tmp-файл не остаётся");

// rev
w = await s.saveState(sub, { ...st, rev: 2 }, 7);
check(!w.ok && /rev/.test(w.error), "несовпадение rev отклоняет запись");
w = await s.saveState(sub, { ...st, rev: 2 }, 1);
check(w.ok, "совпадение rev — запись проходит");

// повреждение
fs.writeFileSync(path.join(sub, "state.json"), "{ не json");
r = await s.loadState(sub);
check(r.kind === "corrupt" && r.state.nextSeq === 1 && r.warning, "битый JSON → corrupt, чистая база");
check(fs.readdirSync(sub).some((f) => f.startsWith("state.json.corrupt-")), "файл перемещён в .corrupt-*");
// версия новее
fs.writeFileSync(path.join(sub, "state.json"), JSON.stringify({ ...s.emptyState(), version: 99 }));
r = await s.loadState(sub);
check(r.kind === "newer" && fs.existsSync(path.join(sub, "state.json")), "version новее → newer, файл не тронут");
// схема неверна
fs.writeFileSync(path.join(sub, "state.json"), JSON.stringify({ version: 1 }));
r = await s.loadState(sub);
check(r.kind === "corrupt", "неверная схема → corrupt");

// срезы журнала
const now = new Date("2026-10-15T00:00:00Z");
const old = (seq, scope) => ({ seq, at: "2026-08-01T00:00:00Z", scope, source: "x", type: "added", id: String(seq), kind: "k", title: "t" });
let p = s.emptyState();
p.journal = [old(1, "deadlines"), old(2, "deadlines"), old(3, "inbox")];
p.seen = { deadlines: 2, inbox: 1 };
s.pruneJournal(p, now);
check(p.journal.map((e) => e.seq).join() === "2,3", "возрастной срез: ушёл только seq ≤ min(seen)=1; seq 2 и 3 (старые, но > min(seen)) остались");
p = s.emptyState();
p.seen = { inbox: 0 };
p.journal = Array.from({ length: 503 }, (_, i) => ({ ...old(i + 1, "inbox"), at: "2026-10-14T00:00:00Z" }));
s.pruneJournal(p, now);
check(p.journal.length === 500 && p.journal[0].seq === 4, "потолок 500 срезает старейшие");
check(p.lost.inbox === 3, "срезанное невыданное учтено в lost");

// базы оценок
p = s.emptyState();
p.baselines = { "lms_grades:1": { takenAt: "2026-06-01T00:00:00Z", facts: {} }, "lms_grades:2": { takenAt: "2026-10-01T00:00:00Z", facts: {} }, lms_calendar: { takenAt: "2025-01-01T00:00:00Z", facts: {} } };
s.pruneGradeBaselines(p, now);
check(!p.baselines["lms_grades:1"] && p.baselines["lms_grades:2"] && p.baselines.lms_calendar, "база оценок старше 90 дней удалена, прочие нет");

// блокировка: сериализация
dir = mkdir();
let active = 0, overlap = false;
const job = (ms) => s.withStateLock(dir, async () => { active++; if (active > 1) overlap = true; await sleep(ms); active--; });
await Promise.all([job(80), job(30), job(10)]);
check(!overlap, "withStateLock: задачи не перекрываются");
check(!fs.existsSync(path.join(dir, "state.json.lock")), "lock-файл снят");
// устаревшая блокировка снимается
fs.writeFileSync(path.join(dir, "state.json.lock"), "stale");
const longAgo = new Date(Date.now() - 120_000);
fs.utimesSync(path.join(dir, "state.json.lock"), longAgo, longAgo);
let ran = false;
await s.withStateLock(dir, async () => { ran = true; });
check(ran, "устаревшая блокировка (> 30 с) снята");
// живая блокировка блокирует: ожидание истекает
fs.writeFileSync(path.join(dir, "state.json.lock"), "live");
let timedOut = false;
await s.withStateLock(dir, async () => {}, { waitMs: 300 }).catch((e) => { timedOut = /занят/.test(e.message); });
check(timedOut, "свежая чужая блокировка: ожидание истекает понятной ошибкой");
fs.unlinkSync(path.join(dir, "state.json.lock"));
finish();
```

Run: `node $SCRATCH/verify-3/t7-store.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 4: Коммит**

```bash
git add src/services/changes/store.ts
git commit -m "Add changes state store with atomic writes and a lock file

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `changes` — извлекатели источников

**Files:**
- Create: `src/services/changes/extractors.ts`

**Interfaces:**
- Consumes: функции клиентов с `opts` (T4), `listGradeItems` (T5), нормализация (T6), `isExamType`/`startOfDay`/`endOfDay` из `digest/parse.ts`.
- Produces:
```ts
export interface ExtractContext { now: Date; opts: ResourceCallOptions }
export interface SourceExtractor { source: string; scope: Scope; flags: DiffFlags; run(ctx: ExtractContext): Promise<SourceResult> }
export interface ClientDeps { listActionEvents; listMessages; listGradeItems; getCourseEvaluationStatus; getSchedule; getNotifications; listRequests }  // typeof соответствующих функций
export const realClients: ClientDeps;
export function singleExtractors(deps?: ClientDeps): SourceExtractor[];                       // 6 источников
export function gradesExtractor(course: CourseOverview, deps?: ClientDeps): SourceExtractor;  // lms_grades:<id>
export const INBOX_LMS_LIMIT = 200, INBOX_NOTIFICATIONS_LIMIT = 100, CLAIMS_LIMIT = 500;
```
- Окно календаря: `from = полночь(сегодня − 180 д)`, `to = конец дня(сегодня + 60 д)` (поправка П2); расписание: `сегодня … сегодня + 14 д`.

- [ ] **Step 1: `extractors.ts`**

```ts
import { addDays, formatLocalDate } from "../../date-utils.js";
import type { ResourceCallOptions } from "../../resource.js";
import { endOfDay, isExamType, startOfDay } from "../digest/parse.js";
import * as elk from "../elk/client.js";
import * as lms from "../lms/client.js";
import type { CourseOverview } from "../lms/client.js";
import { canonicalAttrs, dedupeIds, isEmptyGrade, mskNaive, normText, sopNaive, utcMinute } from "./normalize.js";
import type { DiffFlags, Fact, Scope, SourceResult } from "./types.js";

export const CALENDAR_LOOKBACK_DAYS = 180;
export const CALENDAR_HORIZON_DAYS = 60;
export const SCHEDULE_HORIZON_DAYS = 14;
export const INBOX_LMS_LIMIT = 200;
export const INBOX_NOTIFICATIONS_LIMIT = 100;
export const CLAIMS_LIMIT = 500;

export interface ExtractContext {
  now: Date;
  opts: ResourceCallOptions;
}

export interface SourceExtractor {
  source: string;
  scope: Scope;
  flags: DiffFlags;
  run(ctx: ExtractContext): Promise<SourceResult>;
}

/** Клиентские функции источников; в проверках подменяются фикстурами. */
export interface ClientDeps {
  listActionEvents: typeof lms.listActionEvents;
  listMessages: typeof lms.listMessages;
  listGradeItems: typeof lms.listGradeItems;
  getCourseEvaluationStatus: typeof elk.getCourseEvaluationStatus;
  getSchedule: typeof elk.getSchedule;
  getNotifications: typeof elk.getNotifications;
  listRequests: typeof elk.listRequests;
}

export const realClients: ClientDeps = {
  listActionEvents: lms.listActionEvents,
  listMessages: lms.listMessages,
  listGradeItems: lms.listGradeItems,
  getCourseEvaluationStatus: elk.getCourseEvaluationStatus,
  getSchedule: elk.getSchedule,
  getNotifications: elk.getNotifications,
  listRequests: elk.listRequests,
};

const maxString = (values: string[]): string | null => (values.length ? values.reduce((m, x) => (x > m ? x : m)) : null);
const minString = (values: string[]): string | null => (values.length ? values.reduce((m, x) => (x < m ? x : m)) : null);
const orUndefined = (s: string): string | undefined => (s === "" ? undefined : s);

function lmsCalendar(deps: ClientDeps): SourceExtractor {
  return {
    source: "lms_calendar",
    scope: "deadlines",
    flags: { detectOverdue: true },
    async run(ctx) {
      const today = startOfDay(ctx.now);
      // Те же даты, от которых строится ключ кэша календаря (`lms/client.ts`), и последний день целиком.
      const from = addDays(today, -CALENDAR_LOOKBACK_DAYS);
      const to = endOfDay(addDays(today, CALENDAR_HORIZON_DAYS));
      const res = await deps.listActionEvents(from, to, ctx.opts);
      const facts = dedupeIds(
        res.events.flatMap((e): Fact[] => {
          const due = utcMinute(e.due);
          if (due === null) return [];
          const name = normText(e.name);
          return [
            {
              id: String(e.id),
              scope: "deadlines",
              kind: e.module === "assign" ? "assignment" : e.module === "quiz" ? "quiz" : "lms_activity",
              title: name,
              ...(orUndefined(normText(e.course)) ? { course: normText(e.course) } : {}),
              attrs: canonicalAttrs({ due, name }),
              at: due,
            },
          ];
        })
      );
      const lastDue = maxString(facts.map((f) => f.at as string));
      return {
        facts,
        // Усечение отрезает самые поздние события — покрытие сужается до последнего загруженного.
        coverage: { from: utcMinute(from), to: res.truncated ? (lastDue ?? utcMinute(from)) : utcMinute(to) },
        truncated: res.truncated,
        warnings: res.truncated
          ? ["календарь LMS усечён по лимиту событий: покрытие сужено, «пропало из календаря» не вычисляется"]
          : [],
      };
    },
  };
}

function elkWindows(deps: ClientDeps): SourceExtractor {
  const pick = (row: Record<string, string>, re: RegExp): string =>
    normText(Object.entries(row).find(([k]) => re.test(k))?.[1]);
  return {
    source: "elk_windows",
    scope: "deadlines",
    flags: {},
    async run(ctx) {
      const rows = await deps.getCourseEvaluationStatus(ctx.opts);
      const warnings: string[] = [];
      const facts: Fact[] = [];
      for (const row of rows) {
        // id окна — только период (§5); номер строки `#` нестабилен и в id не подставляется.
        const period = pick(row, /период|period|name/i);
        if (!period) {
          warnings.push("строка СОП без периода пропущена");
          continue;
        }
        facts.push({
          id: period,
          scope: "deadlines",
          kind: "elk_window",
          title: `Оценка курсов (СОП): ${period}`,
          attrs: canonicalAttrs({ end: sopNaive(pick(row, /окончан|end/i)), status: pick(row, /статус|status/i) }),
        });
      }
      return { facts: dedupeIds(facts), warnings };
    },
  };
}

function elkSchedule(deps: ClientDeps): SourceExtractor {
  return {
    source: "elk_schedule",
    scope: "schedule",
    flags: { mergeMoves: true },
    async run(ctx) {
      const from = startOfDay(ctx.now);
      const to = addDays(from, SCHEDULE_HORIZON_DAYS);
      const days = await deps.getSchedule(from, to, ctx.opts);
      const facts: Fact[] = [];
      for (const day of days) {
        for (const l of day.lessons ?? []) {
          const begin = mskNaive(day.date, l.begin_time);
          if (begin === null) continue;
          const end = mskNaive(day.date, l.end_time);
          const name = normText(l.name);
          const type = normText(l.lesson_type);
          facts.push({
            id: `${begin.slice(0, 10)}|${begin.slice(11)}|${name}|${type}`,
            scope: "schedule",
            kind: isExamType(type) ? "exam" : "lesson",
            title: name,
            attrs: canonicalAttrs({ end, auditorium: normText(l.auditorium), building: normText(l.building) }),
            at: begin,
            matchKey: `${name}|${type}`,
          });
        }
      }
      // `from` — полночь локальная (МСК пользователя): границы покрытия — по локальным компонентам даты.
      return {
        facts: dedupeIds(facts),
        coverage: { from: `${formatLocalDate(from, "-")}T00:00`, to: `${formatLocalDate(to, "-")}T23:59` },
      };
    },
  };
}

function lmsMessages(deps: ClientDeps): SourceExtractor {
  return {
    source: "lms_messages",
    scope: "inbox",
    flags: { emitChanged: false, emitRemoved: false, carryMissing: false },
    async run(ctx) {
      const messages = await deps.listMessages(INBOX_LMS_LIMIT, ctx.opts);
      const facts = dedupeIds(
        messages.flatMap((m): Fact[] => {
          const at = utcMinute(m.time);
          if (at === null) return [];
          const subject = normText(m.subject);
          return [
            {
              id: String(m.id),
              scope: "inbox",
              kind: "lms_message",
              title: subject,
              ...(orUndefined(normText(m.course)) ? { course: normText(m.course) } : {}),
              attrs: canonicalAttrs({ subject }),
              at,
            },
          ];
        })
      );
      // Выборка упёрлась в лимит — старше самого старого элемента ответа «новое» не судим.
      const full = messages.length >= INBOX_LMS_LIMIT;
      return { facts, coverage: { from: full ? minString(facts.map((f) => f.at as string)) : null, to: null } };
    },
  };
}

function elkNotifications(deps: ClientDeps): SourceExtractor {
  return {
    source: "elk_notifications",
    scope: "inbox",
    flags: { emitChanged: false, emitRemoved: false, carryMissing: false },
    async run(ctx) {
      const res = await deps.getNotifications(INBOX_NOTIFICATIONS_LIMIT, ctx.opts);
      const facts = dedupeIds(
        res.notifications.flatMap((n): Fact[] => {
          const raw = normText(n.date);
          // Даты уведомлений приходят без времени (ГГГГ-ММ-ДД) — гранулярность покрытия сутки.
          const at = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : utcMinute(raw);
          if (at === null) return [];
          const title = normText(n.title);
          return [{ id: String(n.id), scope: "inbox", kind: "notification", title, attrs: canonicalAttrs({ title }), at }];
        })
      );
      const full = res.notifications.length >= INBOX_NOTIFICATIONS_LIMIT || res.count > res.notifications.length;
      return { facts, coverage: { from: full ? minString(facts.map((f) => f.at as string)) : null, to: null } };
    },
  };
}

function elkClaims(deps: ClientDeps): SourceExtractor {
  return {
    source: "elk_claims",
    scope: "claims",
    // §5: у заявок события только `added`/`changed`; пропавшая из ответа заявка — не событие.
    flags: { emitRemoved: false },
    async run(ctx) {
      const res = await deps.listRequests(CLAIMS_LIMIT, ctx.opts);
      const truncated = res.count > res.requests.length;
      const facts = dedupeIds(
        res.requests.map(
          (c): Fact => ({
            id: normText(c.num),
            scope: "claims",
            kind: "elk_claim",
            // Только название сервиса: свободный текст заявки и ФИО на диск не пишутся.
            title: normText(c.service),
            attrs: canonicalAttrs({ state: normText(c.stateName), active: c.active ? "1" : "0" }),
          })
        )
      );
      return {
        facts,
        truncated,
        warnings: truncated ? ["список заявок усечён по лимиту — «пропало» не вычисляется"] : [],
      };
    },
  };
}

/** Шесть источников областей `deadlines`, `schedule`, `inbox`, `claims`. */
export function singleExtractors(deps: ClientDeps = realClients): SourceExtractor[] {
  return [lmsCalendar(deps), elkWindows(deps), elkSchedule(deps), lmsMessages(deps), elkNotifications(deps), elkClaims(deps)];
}

/** Оценки одного курса (`lms_grades:<id>`). Нераспознанная таблица — ошибка источника, а не ложные события. */
export function gradesExtractor(course: CourseOverview, deps: ClientDeps = realClients): SourceExtractor {
  return {
    source: `lms_grades:${course.id}`,
    scope: "grades",
    flags: { emitRemoved: false, carryMissing: false, silentEmptyGrade: true },
    async run(ctx) {
      const table = await deps.listGradeItems(course.id, ctx.opts);
      // Нет таблицы или не найдены колонки (`th.column-itemname`/`td.column-grade`) — чужая вёрстка:
      // ошибка источника, а не пустая выдача. В Moodle строка «Итого за курс» с `td.column-grade` есть всегда.
      if (!table.found || !table.recognized) throw new Error("unsupported grade table");
      const courseName = normText(course.fullname);
      const facts = dedupeIds(
        table.rows
          .filter((r) => !r.isCategory)
          .map((r): Fact => {
            const name = normText(r.name);
            const path = r.path.map(normText).join("/");
            return {
              id: `${course.id}|${path}|${name}`,
              scope: "grades",
              kind: "grade_item",
              title: name,
              ...(courseName ? { course: courseName } : {}),
              attrs: canonicalAttrs({ grade: isEmptyGrade(r.grade) ? null : r.grade }),
            };
          })
      );
      return { facts };
    },
  };
}
```

- [ ] **Step 2: Сборка** — Expected: код 0.

- [ ] **Step 3: Проверка** `$SCRATCH/verify-3/t8-extractors.mjs` (подставные клиенты)

```js
import { dist, check, finish } from "./lib.mjs";
const { singleExtractors, gradesExtractor } = await dist("services/changes/extractors.js");

const NOW = new Date(2026, 9, 15, 12, 0, 0);
const ctx = { now: NOW, opts: { maxAgeMs: 60_000 } };
const calls = {};
const deps = {
  listActionEvents: async (from, to, opts) => {
    calls.cal = { from, to, opts };
    return { truncated: false, events: [
      { id: 11, name: "  ДЗ 1 ", module: "assign", course: "Курс А", courseId: 1, due: "2026-10-20T20:59:00.000Z", overdue: false, actionable: true, actionName: "", url: null },
      { id: 12, name: "Тест", module: "quiz", course: "", courseId: 1, due: "2026-10-22T09:00:00.000Z", overdue: false, actionable: false, actionName: "", url: null },
      { id: 13, name: "Прочее", module: "", course: "Курс А", courseId: 1, due: "плохая дата", overdue: false, actionable: false, actionName: "", url: null },
    ] };
  },
  getCourseEvaluationStatus: async () => [
    { "#": "1", "Период": "Осень 2026", "Дата начала": "00:00 01.10.2026", "Дата окончания": "23:59 25.10.2026 по московскому времени", "Статус": "Анкета доступна" },
    { "#": "2", "Период": "", "Статус": "x" },
  ],
  getSchedule: async (from, to, opts) => {
    calls.sched = { from, to, opts };
    return [{ date: "2026-10-16", lessons: [
      { name: "Матан", lesson_type: "Лекция", begin_time: "10:30", end_time: "11:50", auditorium: "101", building: "1" },
      { name: "Матан", lesson_type: "Лекция", begin_time: "10:30", end_time: "11:50", auditorium: "101", building: "1" },
      { name: "Физика", lesson_type: "Экзамен", begin_time: "13:00", end_time: "14:20", auditorium: "", building: "" },
    ] }];
  },
  listMessages: async (limit) => { calls.msgLimit = limit; return [
    { id: 5, subject: " Тема ", course: "Курс А", sender: "ФИО", time: "2026-10-14T10:00:00.000Z", unread: true, starred: false, numAttachments: 0 },
  ]; },
  getNotifications: async (limit) => { calls.ntfLimit = limit; return { count: 1, notifications: [
    { id: 9, title: "Заголовок", text: "СЕКРЕТНЫЙ ТЕКСТ", isImportant: false, isRead: false, date: "2026-10-13" },
  ] }; },
  listRequests: async (limit) => { calls.reqLimit = limit; return { count: 1, requests: [
    { num: "A-1", text: "СВОБОДНЫЙ ТЕКСТ", service: "Справка", executorFio: "ФИО", createdByEmail: "e@x", createdByFio: "ФИО", stateName: " В работе ", active: true, created: "", updated: "", url: null },
  ] }; },
  listGradeItems: async (id) => {
    if (id === 2) return { found: false, recognized: false, rows: [] };
    if (id === 3) return { found: true, recognized: false, rows: [] };   // таблица есть, колонки не найдены
    return { found: true, recognized: true, rows: [
      { name: "Категория", level: 1, path: [], isCategory: true, grade: null },
      { name: "Тест", level: 2, path: ["Категория"], isCategory: false, grade: "-" },
      { name: "Тест", level: 2, path: ["Категория"], isCategory: false, grade: " 8,0 " },
    ] };
  },
};
const ex = Object.fromEntries(singleExtractors(deps).map((e) => [e.source, e]));

let r = await ex.lms_calendar.run(ctx);
check(r.facts.length === 2, "календарь: событие с нераспознанной датой пропущено");
check(r.facts[0].id === "11" && r.facts[0].attrs.due === "2026-10-20T20:59Z" && r.facts[0].attrs.name === "ДЗ 1", "календарь: id, due UTC-минута, имя нормализовано");
check(r.facts[0].kind === "assignment" && r.facts[1].kind === "quiz", "календарь: kind по module");
check(calls.cal.opts.maxAgeMs === 60_000, "календарь: opts переданы клиенту");
check(calls.cal.to.getHours() === 23 && calls.cal.to.getMinutes() === 59, "календарь: to — конец последнего дня (поправка П2)");
check(r.coverage.from.endsWith("Z") && r.coverage.to > r.coverage.from, "календарь: покрытие в UTC");

r = await ex.elk_windows.run(ctx);
check(r.facts.length === 1 && r.facts[0].id === "Осень 2026" && r.facts[0].attrs.end === "2026-10-25T23:59", "СОП: id периода, срок наивным МСК");
check(r.warnings.length === 1, "СОП: строка без периода → предупреждение");

r = await ex.elk_schedule.run(ctx);
check(r.facts.length === 3 && r.facts[1].id === r.facts[0].id + "#2", "расписание: дубликат id получает #2 (Review Focus 3)");
check(r.facts[0].id === "2026-10-16|10:30|Матан|Лекция" && r.facts[0].at === "2026-10-16T10:30", "расписание: id с началом, at — наивное МСК");
check(r.facts[2].kind === "exam" && r.facts[0].matchKey === "Матан|Лекция", "расписание: exam и matchKey");
check(r.coverage.from === "2026-10-15T00:00" && r.coverage.to === "2026-10-29T23:59", "расписание: покрытие сегодня…+14 д");

r = await ex.lms_messages.run(ctx);
check(calls.msgLimit === 200 && r.facts[0].attrs.subject === "Тема" && r.coverage.from === null, "входящее LMS: лимит 200, выборка не полная → без нижней границы");
check(!JSON.stringify(r).includes("ФИО"), "входящее LMS: отправитель не попадает в факты");
r = await ex.elk_notifications.run(ctx);
check(calls.ntfLimit === 100 && r.facts[0].at === "2026-10-13" && !JSON.stringify(r).includes("СЕКРЕТНЫЙ"), "уведомления: дата без времени, текст не попадает");
r = await ex.elk_claims.run(ctx);
check(calls.reqLimit === 500 && r.facts[0].title === "Справка" && r.facts[0].attrs.state === "В работе" && r.facts[0].attrs.active === "1", "заявки: title = service, state нормализован");
check(!JSON.stringify(r).includes("СВОБОДНЫЙ") && !JSON.stringify(r).includes("ФИО") && !JSON.stringify(r).includes("e@x"), "заявки: свободный текст, ФИО, email не попадают");

const course = (id) => ({ id, fullname: "Курс " + id, shortname: "k", category: "", startdate: "", enddate: null, progress: null, isFavourite: false, hidden: false, visible: true, viewUrl: "" });
r = await gradesExtractor(course(1), deps).run(ctx);
check(r.facts.length === 2 && r.facts[0].id === "1|Категория|Тест" && r.facts[1].id === "1|Категория|Тест#2", "оценки: id с путём; дубликат получает #2");
check(r.facts[0].attrs.grade === null && r.facts[1].attrs.grade === "8,0", "оценки: «-» → null, пробелы убраны");
let failed = null;
await gradesExtractor(course(2), deps).run(ctx).catch((e) => { failed = e.message; });
check(failed === "unsupported grade table", "оценки: нет таблицы → unsupported grade table (Review Focus 2)");
failed = null;
await gradesExtractor(course(3), deps).run(ctx).catch((e) => { failed = e.message; });
check(failed === "unsupported grade table", "оценки: таблица найдена, но колонки не распознаны (rows пуст) → unsupported grade table");
check(ex.elk_claims.flags.emitRemoved === false, "заявки: emitRemoved: false (только added/changed, §5)");
finish();
```

Run: `node $SCRATCH/verify-3/t8-extractors.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 4: Коммит**

```bash
git add src/services/changes/extractors.ts
git commit -m "Add per-source fact extractors for changes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `changes` — оркестратор `getChanges` / `resetChanges` (+ поправки спеки)

**Files:**
- Create: `src/services/changes/client.ts`
- Modify: `docs/superpowers/specs/2026-10-15-snapshots-diff-design.md` (§5/§11 П2, §7 и §10 П1, П3–П5)

**Interfaces:**
- Consumes: `runSource` (T2), `loadState`/`saveState`/`withStateLock`/`prune*` (T7), `diffSource` (T6), `singleExtractors`/`gradesExtractor` (T8), `selectCourses` (`digest/parse.ts`), `lms.listCourses(opts)` (T4).
- Produces:
```ts
export interface ChangesOptions { scopes?: Scope[]; courses?: CourseFilter; fresh?: boolean; since?: string; ack?: number; signal?: AbortSignal }
export interface ChangesDeps { now: () => Date; dir: string; single: SourceExtractor[]; grades: (c: CourseOverview) => SourceExtractor; listCourses: (o: ResourceCallOptions) => Promise<CourseOverview[]>; sourceTimeoutMs: number; gradesBudgetMs: number }
export interface ChangeItem { seq: number | null; at: string; scope: Scope; type: EventType; cause?: "clock"; kind: string; title: string; course?: string; fields?: FieldChange[] }
export interface ChangesResponse { takenAt: string; scopes: Partial<Record<Scope, { status: "ok"|"baseline"|"partial"|"error"; facts: number; warnings: string[] }>>; sources: Record<string, { status: "ok"|"error"|"skipped"; ms: number; error?: string }>; changes: ChangeItem[]; ackSeq: number | null; omitted: number; gap: { lostEvents: number }; persisted: boolean; warnings: string[] }
export function getChanges(opts?: ChangesOptions, overrides?: Partial<ChangesDeps>): Promise<ChangesResponse>
export function resetChanges(opts: { scope?: Scope; confirm?: boolean }, overrides?: Partial<Pick<ChangesDeps, "dir" | "now">>): Promise<{ reset: Scope[]; removedBaselines: number; removedEvents: number; persisted: boolean }>
```
- Алгоритм `ack` (П1): `ack`, больший `max(issued[*])` по всем областям (наибольшего когда-либо выданного `seq`), игнорируется целиком с предупреждением; иначе для каждой области текущего вызова `seen[scope] = max(seen[scope], min(ack, issued[scope] ?? 0))`. `seen[scope]` первого запуска области инициализируется `nextSeq − 1` до присвоения `seq` событиям.
- Предупреждение первого `loadState` (вне блокировки; `corrupt` перемещает файл в `.corrupt-*`) переносится в `warnings` ответа; повторный `loadState` под блокировкой видит уже `missing` и своего предупреждения не даёт.

- [ ] **Step 1: `client.ts`**

```ts
import type { ResourceCallOptions } from "../../resource.js";
import { runSource, type SourceStatus } from "../../run-source.js";
import { selectCourses } from "../digest/parse.js";
import type { CourseFilter } from "../digest/types.js";
import * as lms from "../lms/client.js";
import type { CourseOverview } from "../lms/client.js";
import { diffSource } from "./diff.js";
import { gradesExtractor, singleExtractors, type ExtractContext, type SourceExtractor } from "./extractors.js";
import { defaultStateDir, loadState, pruneGradeBaselines, pruneJournal, saveState, withStateLock } from "./store.js";
import {
  DEFAULT_SCOPES,
  SCOPES,
  scopeOfSource,
  type ChangeEvent,
  type DiffFlags,
  type EventType,
  type FieldChange,
  type Scope,
  type SourceResult,
  type State,
} from "./types.js";

const RESPONSE_EVENT_LIMIT = 200;
const DEFAULT_MAX_AGE_MS = 60_000;
const GRADES_POOL = 3;
/** Не запускать новый курс, если до конца бюджета области осталось меньше этого резерва. */
const GRADES_COURSE_RESERVE_MS = 15_000;

export interface ChangesOptions {
  scopes?: Scope[];
  courses?: CourseFilter;
  fresh?: boolean;
  since?: string;
  ack?: number;
  signal?: AbortSignal;
}

export interface ChangesDeps {
  now: () => Date;
  dir: string;
  single: SourceExtractor[];
  grades: (course: CourseOverview) => SourceExtractor;
  listCourses: (opts: ResourceCallOptions) => Promise<CourseOverview[]>;
  sourceTimeoutMs: number;
  gradesBudgetMs: number;
}

const realDeps = (): ChangesDeps => ({
  now: () => new Date(),
  dir: defaultStateDir(),
  single: singleExtractors(),
  grades: (course) => gradesExtractor(course),
  listCourses: (opts) => lms.listCourses(opts),
  sourceTimeoutMs: 40_000,
  gradesBudgetMs: 90_000,
});

export interface ChangeItem {
  /** `null` — событие не записано на диск (`persisted: false`). */
  seq: number | null;
  at: string;
  scope: Scope;
  type: EventType;
  cause?: "clock";
  kind: string;
  title: string;
  course?: string;
  fields?: FieldChange[];
}

export interface ScopeReport {
  status: "ok" | "baseline" | "partial" | "error";
  facts: number;
  warnings: string[];
}

export interface SourceReport {
  status: "ok" | "error" | "skipped";
  ms: number;
  error?: string;
}

export interface ChangesResponse {
  takenAt: string;
  scopes: Partial<Record<Scope, ScopeReport>>;
  sources: Record<string, SourceReport>;
  changes: ChangeItem[];
  /** Значение для `ack` следующего вызова; `null` — подтверждать нечего (в том числе при `since`). */
  ackSeq: number | null;
  omitted: number;
  gap: { lostEvents: number };
  persisted: boolean;
  warnings: string[];
}

interface Gathered {
  source: string;
  scope: Scope;
  flags: DiffFlags;
  status: SourceStatus;
  result: SourceResult | null;
}

/** Первая строка сообщения без query и email: в ответ не должны попадать токены и адреса. */
function sanitize(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return (message.split("\n")[0] ?? "")
    .replace(/\?\S*/g, "?…")
    .replace(/[\w.+-]+@[\w.-]+/g, "<email>")
    .slice(0, 300);
}

function normalizeScopes(scopes: Scope[] | undefined): Scope[] {
  const picked = scopes && scopes.length > 0 ? scopes : [...DEFAULT_SCOPES];
  return SCOPES.filter((s) => picked.includes(s));
}

function parseSince(since: string, now: Date): number {
  const m = /^(\d+)([dh])$/.exec(since.trim());
  if (m) return now.getTime() - Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`Некорректное значение since: "${since}" (ожидается "7d", "12h" или дата ISO)`);
  return t;
}

const skipped = (source: string, scope: Scope, reason: string): Gathered => ({
  source,
  scope,
  flags: {},
  status: { status: "skipped", error: reason, ms: 0 },
  result: null,
});

async function gatherGrades(
  opts: ChangesOptions,
  deps: ChangesDeps,
  ctx: ExtractContext,
  baselinesAge: (source: string) => string
): Promise<Gathered[]> {
  const startedAt = Date.now();
  let courses: CourseOverview[] = [];
  const listed = await runSource(
    "lms_courses",
    async () => {
      courses = selectCourses(await deps.listCourses(ctx.opts), opts.courses, ctx.now);
      return { warnings: [] as string[] };
    },
    deps.sourceTimeoutMs,
    opts.signal
  );
  const head: Gathered = { source: "lms_courses", scope: "grades", flags: {}, status: listed.status, result: null };
  if (listed.status.status !== "ok") return [head];

  // Самые давно снятые курсы — первыми, чтобы один и тот же хвост не пропускался вечно.
  const ordered = [...courses].sort((a, b) =>
    baselinesAge(`lms_grades:${a.id}`).localeCompare(baselinesAge(`lms_grades:${b.id}`))
  );
  const out: Gathered[] = new Array(ordered.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= ordered.length) return;
      const course = ordered[i];
      const source = `lms_grades:${course.id}`;
      if (opts.signal?.aborted) {
        out[i] = skipped(source, "grades", "отменено");
        continue;
      }
      if (Date.now() - startedAt >= deps.gradesBudgetMs - GRADES_COURSE_RESERVE_MS) {
        out[i] = skipped(source, "grades", "бюджет области grades исчерпан");
        continue;
      }
      const ex = deps.grades(course);
      const res = await runSource(source, () => ex.run(ctx), deps.sourceTimeoutMs, opts.signal);
      out[i] = { source, scope: "grades", flags: ex.flags, status: res.status, result: res.value };
    }
  };
  await Promise.all(Array.from({ length: Math.min(GRADES_POOL, ordered.length) }, worker));
  return [head, ...out];
}

async function gather(scopes: Scope[], opts: ChangesOptions, deps: ChangesDeps, now: Date, pre: State): Promise<Gathered[]> {
  const ctx: ExtractContext = { now, opts: { maxAgeMs: opts.fresh ? 0 : DEFAULT_MAX_AGE_MS, signal: opts.signal } };
  const runOne = async (e: SourceExtractor): Promise<Gathered> => {
    const res = await runSource(e.source, () => e.run(ctx), deps.sourceTimeoutMs, opts.signal);
    return { source: e.source, scope: e.scope, flags: e.flags, status: res.status, result: res.value };
  };
  const singles = Promise.all(deps.single.filter((e) => scopes.includes(e.scope)).map(runOne));
  const grades = scopes.includes("grades")
    ? gatherGrades(opts, deps, ctx, (source) => pre.baselines[source]?.takenAt ?? "")
    : Promise.resolve([] as Gathered[]);
  const [a, b] = await Promise.all([singles, grades]);
  return [...a, ...b];
}

interface Selection {
  items: ChangeItem[];
  ackSeq: number | null;
  omitted: number;
  lostEvents: number;
}

const toItem = (e: ChangeEvent): ChangeItem => ({
  seq: e.seq,
  at: e.at,
  scope: e.scope,
  type: e.type,
  ...(e.cause ? { cause: e.cause } : {}),
  kind: e.kind,
  title: e.title,
  ...(e.course ? { course: e.course } : {}),
  ...(e.fields ? { fields: e.fields } : {}),
});

/** Выбор событий ответа: неподтверждённые (по `seen`) либо журнал за период (`since`); префикс ≤ 200. */
function select(state: State, scopes: Scope[], sinceMs: number | null): Selection {
  const inScope = state.journal.filter((e) => scopes.includes(e.scope));
  const all = sinceMs === null ? inScope.filter((e) => e.seq > (state.seen[e.scope] ?? 0)) : inScope.filter((e) => Date.parse(e.at) >= sinceMs);
  const picked = all.slice(0, RESPONSE_EVENT_LIMIT);
  return {
    items: picked.map(toItem),
    ackSeq: sinceMs === null && picked.length > 0 ? picked[picked.length - 1].seq : null,
    omitted: all.length - picked.length,
    lostEvents: scopes.reduce((sum, s) => sum + (state.lost[s] ?? 0), 0),
  };
}

/**
 * `ack` больше наибольшего когда-либо выданного `seq` (`max(issued[*])` по всем областям) —
 * игнорируется целиком с предупреждением; иначе для областей вызова
 * `seen[scope] = max(seen[scope], min(ack, issued[scope] ?? 0))`: подтверждение, выданное по одной
 * области, не помечает просмотренными невыданные события другой.
 */
function applyAck(draft: State, scopes: Scope[], ack: number, warnings: string[]): void {
  const issued = Object.values(draft.issued).filter((v): v is number => typeof v === "number");
  const maxIssued = Math.max(0, ...issued);
  if (ack > maxIssued) {
    warnings.push(`ack ${ack} больше любого выданного seq (${maxIssued}) — игнорируется`);
    return;
  }
  for (const scope of scopes) {
    const ceiling = Math.min(ack, draft.issued[scope] ?? 0);
    if (ceiling > (draft.seen[scope] ?? 0)) draft.seen[scope] = ceiling;
  }
}

function reports(
  gathered: Gathered[],
  scopes: Scope[],
  baselines: State["baselines"],
  diffStatus: Map<string, "baseline" | "ok">
): { scopes: Partial<Record<Scope, ScopeReport>>; sources: Record<string, SourceReport> } {
  const sources: Record<string, SourceReport> = {};
  for (const g of gathered) {
    sources[g.source] = {
      status: g.status.status,
      ms: g.status.ms,
      ...(g.status.error ? { error: sanitize(g.status.error) } : {}),
    };
  }
  const out: Partial<Record<Scope, ScopeReport>> = {};
  for (const scope of scopes) {
    const own = gathered.filter((g) => g.scope === scope);
    // `lms_courses` — справочник курсов, а не данные области: в статус `grades` входит только отказом
    // (иначе его вечное `ok` не даёт области получить статус `baseline`).
    const counted = own.filter((g) => !(g.source === "lms_courses" && g.status.status === "ok"));
    const states = counted.map((g) => (g.status.status === "ok" ? (diffStatus.get(g.source) ?? "ok") : g.status.status));
    let status: ScopeReport["status"];
    if (own.length === 0 || (states.length > 0 && states.every((s) => s === "error"))) status = "error";
    else if (states.some((s) => s === "error" || s === "skipped")) status = "partial";
    else if (states.length > 0 && states.every((s) => s === "baseline")) status = "baseline";
    else status = "ok";
    const facts = own.reduce((n, g) => n + Object.keys(baselines[g.source]?.facts ?? {}).length, 0);
    const warnings = own.flatMap((g) => [
      ...(g.status.warnings ?? []),
      ...(g.status.status === "skipped" && g.status.error ? [`${g.source}: ${g.status.error}`] : []),
    ]);
    out[scope] = { status, facts, warnings };
  }
  return { scopes: out, sources };
}

/**
 * Снимок → diff → коммит → события. Курсор в этом вызове не двигается (только `ack` предыдущей
 * выдачи): событие не теряется, даже если ответ не дошёл. Никогда не бросает из-за источников.
 */
export async function getChanges(opts: ChangesOptions = {}, overrides: Partial<ChangesDeps> = {}): Promise<ChangesResponse> {
  const deps: ChangesDeps = { ...realDeps(), ...overrides };
  const now = deps.now();
  const takenAt = now.toISOString();
  const scopes = normalizeScopes(opts.scopes);
  const sinceMs = opts.since ? parseSince(opts.since, now) : null;
  const warnings: string[] = [];

  const warn = (w: string | undefined): void => {
    if (w && !warnings.includes(w)) warnings.push(w);
  };

  // Чтение до сбора нужно ради порядка обхода курсов (`baselinesAge`). У `loadState` есть побочный
  // эффект (`corrupt` → файл переименован), поэтому его предупреждение переносится в ответ: повторное
  // чтение под блокировкой увидит уже `missing`.
  const pre = await loadState(deps.dir);
  warn(pre.warning);
  const gathered = await gather(scopes, opts, deps, now, pre.state);

  if (opts.signal?.aborted) {
    const rep = reports(gathered, scopes, pre.state.baselines, new Map());
    warn("вызов отменён до коммита");
    return {
      takenAt, scopes: rep.scopes, sources: rep.sources,
      changes: [], ackSeq: null, omitted: 0, gap: { lostEvents: 0 }, persisted: false, warnings,
    };
  }

  return withStateLock(deps.dir, async (): Promise<ChangesResponse> => {
    const load = await loadState(deps.dir);
    warn(load.warning);
    if (load.kind === "newer" || load.kind === "io-error") {
      const rep = reports(gathered.map((g) => ({ ...g, status: { ...g.status, status: "error" as const } })), scopes, {}, new Map());
      return { takenAt, scopes: rep.scopes, sources: rep.sources, changes: [], ackSeq: null, omitted: 0, gap: { lostEvents: 0 }, persisted: false, warnings };
    }

    const base = load.state;
    const draft: State = structuredClone(base);
    if (opts.ack !== undefined) applyAck(draft, scopes, opts.ack, warnings);

    const diffStatus = new Map<string, "baseline" | "ok">();
    const fresh: ChangeEvent[] = [];
    for (const g of gathered) {
      if (!g.result) continue;
      // Первый запуск области: курсор ставится на текущую границу — события этого снимка будут новыми.
      if (draft.seen[g.scope] === undefined) draft.seen[g.scope] = draft.nextSeq - 1;
      const d = diffSource({
        source: g.source, scope: g.scope, baseline: draft.baselines[g.source] ?? null,
        facts: g.result.facts, coverage: g.result.coverage, truncated: g.result.truncated, takenAt: now, ...g.flags,
      });
      draft.baselines[g.source] = d.baseline;
      diffStatus.set(g.source, d.status);
      for (const raw of d.events) {
        const ev: ChangeEvent = { ...raw, seq: draft.nextSeq++, at: takenAt };
        draft.journal.push(ev);
        fresh.push(ev);
      }
    }
    pruneJournal(draft, now);
    pruneGradeBaselines(draft, now);

    const chosen = select(draft, scopes, sinceMs);
    if (sinceMs === null) {
      for (const it of chosen.items) {
        const s = it.scope;
        draft.issued[s] = Math.max(draft.issued[s] ?? 0, it.seq as number);
      }
    }
    for (const s of scopes) draft.lost[s] = 0;
    draft.rev = base.rev + 1;

    const saved = await saveState(deps.dir, draft, load.kind === "ok" ? base.rev : null);
    const rep = reports(gathered, scopes, draft.baselines, diffStatus);
    if (saved.ok) {
      return {
        takenAt, scopes: rep.scopes, sources: rep.sources, changes: chosen.items, ackSeq: chosen.ackSeq,
        omitted: chosen.omitted, gap: { lostEvents: chosen.lostEvents }, persisted: true, warnings,
      };
    }
    // Запись не удалась: база, курсор и nextSeq на диске прежние; новые события возвращаются без seq.
    warn(saved.error);
    const before = select(base, scopes, sinceMs);
    const pending: ChangeItem[] = fresh
      .filter((e) => scopes.includes(e.scope))
      .map((e) => ({ ...toItem(e), seq: null }));
    // Потолок ответа действует и здесь: остаток считается в `omitted`.
    const merged = [...before.items, ...pending];
    const capped = merged.slice(0, RESPONSE_EVENT_LIMIT);
    return {
      takenAt, scopes: rep.scopes, sources: rep.sources, changes: capped,
      ackSeq: before.ackSeq, omitted: before.omitted + (merged.length - capped.length),
      gap: { lostEvents: before.lostEvents }, persisted: false, warnings,
    };
  });
}

/** Стирает базы и события области (или всего). `nextSeq` не сбрасывается; `seen` ставится в `nextSeq − 1`. */
export async function resetChanges(
  opts: { scope?: Scope; confirm?: boolean },
  overrides: Partial<Pick<ChangesDeps, "dir" | "now">> = {}
): Promise<{ reset: Scope[]; removedBaselines: number; removedEvents: number; persisted: boolean }> {
  if (opts.confirm !== true) {
    throw new Error("hse_changes_reset требует confirm: true — будут стёрты накопленные базы и журнал событий");
  }
  const dir = overrides.dir ?? defaultStateDir();
  const targets: Scope[] = opts.scope ? [opts.scope] : [...SCOPES];
  return withStateLock(dir, async () => {
    const load = await loadState(dir);
    if (load.kind === "newer" || load.kind === "io-error") {
      throw new Error(load.warning ?? "state.json недоступен для записи");
    }
    const base = load.state;
    const draft: State = structuredClone(base);
    let removedBaselines = 0;
    for (const source of Object.keys(draft.baselines)) {
      const scope = scopeOfSource(source);
      if (scope && targets.includes(scope)) {
        delete draft.baselines[source];
        removedBaselines++;
      }
    }
    const before = draft.journal.length;
    draft.journal = draft.journal.filter((e) => !targets.includes(e.scope));
    for (const s of targets) {
      draft.seen[s] = draft.nextSeq - 1;
      draft.issued[s] = 0;
      draft.lost[s] = 0;
    }
    draft.rev = base.rev + 1;
    const saved = await saveState(dir, draft, load.kind === "ok" ? base.rev : null);
    if (!saved.ok) throw new Error(saved.error);
    return { reset: targets, removedBaselines, removedEvents: before - draft.journal.length, persisted: true };
  });
}
```

- [ ] **Step 2: Сборка** — Expected: код 0.

- [ ] **Step 3: Проверка** `$SCRATCH/verify-3/t9-client.mjs`

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dist, check, finish, sleep } from "./lib.mjs";
const { getChanges, resetChanges } = await dist("services/changes/client.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t9-"));
const fact = (id, attrs, extra = {}) => ({ id, scope: "deadlines", kind: "assignment", title: id, attrs, ...extra });
let calendar = [fact("1", { due: "2026-10-20T10:00Z" }, { at: "2026-10-20T10:00Z" })];
let inbox = [{ id: "m1", scope: "inbox", kind: "lms_message", title: "m1", attrs: { subject: "m1" }, at: "2026-10-14T10:00Z" }];
// Источник заявок падает с первого вызова: при первом запуске он не снял базу и получит её позже
// (шаг 5); проверки шагов 1–4 от области claims не зависят.
let claimsFail = true;
const ex = (source, scope, flags, get) => ({ source, scope, flags, run: async () => get() });
const single = () => [
  ex("lms_calendar", "deadlines", { detectOverdue: true }, () => ({ facts: calendar, coverage: { from: "2026-04-01T00:00Z", to: "2026-12-30T23:59Z" } })),
  ex("lms_messages", "inbox", { emitChanged: false, emitRemoved: false, carryMissing: false }, () => ({ facts: inbox, coverage: { from: null, to: null } })),
  ex("elk_claims", "claims", {}, () => { if (claimsFail) throw new Error("ЕЛК недоступен"); return { facts: [] }; }),
];
let T = new Date("2026-10-15T10:00:00Z");
// gradesBudgetMs должен быть заметно больше резерва GRADES_COURSE_RESERVE_MS (15 с): иначе условие
// «бюджет − резерв» истинно сразу и все курсы получают skipped.
const base = { dir, now: () => T, single: single(), listCourses: async () => [], grades: () => { throw new Error("не нужен"); }, sourceTimeoutMs: 1000, gradesBudgetMs: 60_000 };
const call = (o, over = {}) => getChanges(o, { ...base, ...over });

// 1. первый запуск — baseline по источникам, событий нет
let r = await call({});
check(r.scopes.deadlines.status === "baseline" && r.scopes.inbox.status === "baseline" && r.changes.length === 0 && r.persisted, "первый запуск: baseline, 0 событий");
check(r.sources.lms_calendar.status === "ok", "sources: статус источника");

// 2. повтор без изменений — пусто
r = await call({});
check(r.changes.length === 0 && r.scopes.deadlines.status === "ok", "повтор без изменений — пусто");

// 3. изменения → события; курсор не двигается без ack
T = new Date("2026-10-16T10:00:00Z");
calendar = [fact("1", { due: "2026-10-25T10:00Z" }, { at: "2026-10-25T10:00Z" }), fact("2", { due: "2026-10-30T10:00Z" }, { at: "2026-10-30T10:00Z" })];
inbox = [...inbox, { id: "m2", scope: "inbox", kind: "lms_message", title: "m2", attrs: { subject: "m2" }, at: "2026-10-16T09:00Z" }];
r = await call({});
const types = r.changes.map((c) => `${c.scope}:${c.type}:${c.title}`).sort().join(",");
check(types === "deadlines:added:2,deadlines:changed:1,inbox:added:m2", "события: added/changed/added");
check(r.ackSeq === Math.max(...r.changes.map((c) => c.seq)), "ackSeq — наибольший выданный seq");
const firstAck = r.ackSeq;
r = await call({});
check(r.changes.length === 3, "без ack события возвращаются снова (потеря исключена, дубль допустим)");

// 4. ack: другой набор областей и больше выданного (Review Focus 4)
r = await call({ scopes: ["deadlines"], ack: firstAck });
check(r.changes.every((c) => c.scope === "deadlines") && r.changes.length === 0, "ack подтвердил deadlines");
r = await call({ scopes: ["inbox"] });
check(r.changes.length === 1 && r.changes[0].title === "m2", "ack одной области не подтвердил невыданное другой (П1)");
r = await call({ scopes: ["inbox"], ack: 99999 });
check(r.warnings.some((w) => /игнорируется/.test(w)) && (await call({ scopes: ["inbox"] })).changes.length === 1,
  "ack больше max(issued) игнорируется целиком с предупреждением (seen не двигается)");
r = await call({ scopes: ["inbox"], ack: 2 });
check(!r.warnings.some((w) => /игнорируется/.test(w)) && (await call({ scopes: ["inbox"] })).changes.length === 1,
  "ack в пределах выданного, но меньше seq события: предупреждения нет, событие не подтверждено");
r = await call({ scopes: ["inbox"], ack: firstAck });
check((await call({ scopes: ["inbox"] })).changes.length === 0, "ack подтвердил inbox");

// 5. частичный отказ источника: база прежняя, остальные коммитятся (claimsFail = true с первого вызова)
T = new Date("2026-10-17T10:00:00Z");
r = await call({ scopes: ["claims", "deadlines"] });
check(r.sources.elk_claims.status === "error" && /ЕЛК недоступен/.test(r.sources.elk_claims.error), "отказ источника — статус, не исключение");
check(r.scopes.claims.status === "error" && r.scopes.deadlines.status === "ok", "область claims error, deadlines ok");
claimsFail = false;
r = await call({ scopes: ["claims"] });
check(r.scopes.claims.status === "baseline" && r.changes.length === 0, "упавший при первом запуске источник получает базу позже без ложных added");

// 6. since: журнал за период, курсор не двигается
r = await call({ since: "30d" });
check(r.changes.length >= 3 && r.ackSeq === null, "since: журнал за период, ackSeq null (П3)");

// 7. ошибка записи: persisted:false, события без seq, состояние на диске прежнее
const stateFile = path.join(dir, "state.json");
const before = fs.readFileSync(stateFile, "utf8");
calendar = [...calendar, fact("3", { due: "2026-11-01T10:00Z" }, { at: "2026-11-01T10:00Z" })];
const orig = fs.renameSync;
fs.renameSync = () => { const e = new Error("busy"); e.code = "EIO"; throw e; };
r = await call({ scopes: ["deadlines"] });
fs.renameSync = orig;
check(!r.persisted && r.changes.some((c) => c.seq === null && c.title === "3"), "ошибка записи: persisted false, новое событие без seq");
check(fs.readFileSync(stateFile, "utf8") === before, "ошибка записи: файл состояния не изменился");
r = await call({ scopes: ["deadlines"] });
check(r.persisted && r.changes.some((c) => c.title === "3" && c.seq !== null), "следующий вызов вычисляет то же самое и записывает");

// 8. сброс
let refused = null;
await resetChanges({ scope: "deadlines" }, { dir }).catch((e) => { refused = e.message; });
check(/confirm/.test(refused ?? ""), "reset без confirm — отказ");
const seqBefore = JSON.parse(fs.readFileSync(stateFile, "utf8")).nextSeq;
const rr = await resetChanges({ scope: "deadlines", confirm: true }, { dir });
const afterState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
check(rr.removedBaselines === 1 && !afterState.baselines.lms_calendar && afterState.baselines.lms_messages, "reset области: стёрта база только этой области");
check(afterState.nextSeq === seqBefore, "reset: nextSeq не сбрасывается");
r = await call({ scopes: ["deadlines"] });
check(r.scopes.deadlines.status === "baseline" && r.changes.length === 0, "после reset область снова baseline, невыданных нет");

// 9. оценки: пул, бюджет, отказ одного курса
const course = (id) => ({ id, fullname: "К" + id, shortname: "k", category: "", startdate: "", enddate: null, progress: null, isFavourite: false, hidden: false, visible: true, viewUrl: "" });
let active = 0, maxActive = 0;
const g = (c) => ({
  source: `lms_grades:${c.id}`, scope: "grades", flags: { emitRemoved: false, carryMissing: false, silentEmptyGrade: true },
  run: async () => {
    active++; maxActive = Math.max(maxActive, active);
    await sleep(40);
    active--;
    if (c.id === 3) throw new Error("unsupported grade table");
    return { facts: [{ id: `${c.id}|x|a`, scope: "grades", kind: "grade_item", title: "a", attrs: { grade: null } }] };
  },
});
const courses = [1, 2, 3, 4, 5, 6].map(course);
r = await call({ scopes: ["grades"] }, { listCourses: async () => courses, grades: g, gradesBudgetMs: 60_000 });
check(maxActive <= 3, "оценки: пул не больше 3");
check(r.sources["lms_grades:3"].status === "error" && /unsupported grade table/.test(r.sources["lms_grades:3"].error), "оценки: ошибка одного курса — статус этого источника");
check(r.sources["lms_grades:1"].status === "ok" && r.scopes.grades.status === "partial", "оценки: остальные курсы закоммичены, область partial (Review Focus 2)");
r = await call({ scopes: ["grades"] }, { listCourses: async () => courses, grades: g, gradesBudgetMs: 15_000 });
check(Object.values(r.sources).filter((s) => s.status === "skipped").length === 6, "оценки: бюджет не больше резерва → все курсы skipped");
// область, где источник-справочник lms_courses ok, а курсы впервые сняты, — baseline, а не ok
const dirG = fs.mkdtempSync(path.join(os.tmpdir(), "t9g-"));
r = await call({ scopes: ["grades"], courses: [1] }, { dir: dirG, listCourses: async () => courses, grades: g, gradesBudgetMs: 60_000 });
check(r.scopes.grades.status === "baseline" && r.sources.lms_courses.status === "ok", "оценки: первый снимок курса → область baseline (lms_courses не мешает)");
r = await call({ scopes: ["grades"], courses: ["нет такого"] }, { listCourses: async () => courses, grades: g });
check(r.sources.lms_courses.status === "error" && r.scopes.grades.status === "error", "оценки: фильтр без совпадений → ошибка источника lms_courses");

// 10. отмена до коммита
const ac = new AbortController();
const slowBase = { ...base, single: [ex("lms_calendar", "deadlines", {}, async () => { await sleep(100); return { facts: [] }; })] };
const revBefore = JSON.parse(fs.readFileSync(stateFile, "utf8")).rev;
const pending = getChanges({ scopes: ["deadlines"], signal: ac.signal }, slowBase);
ac.abort(new Error("отмена"));
r = await pending;
check(!r.persisted && JSON.parse(fs.readFileSync(stateFile, "utf8")).rev === revBefore, "отмена до коммита: запись не выполнена");

// 11. файл новее — не трогаем
const stNow = JSON.parse(fs.readFileSync(stateFile, "utf8"));
fs.writeFileSync(stateFile, JSON.stringify({ ...stNow, version: 99 }));
r = await call({ scopes: ["deadlines"] });
check(!r.persisted && r.warnings.some((w) => /новее|более новой/.test(w)) && JSON.parse(fs.readFileSync(stateFile, "utf8")).version === 99, "version новее: статус error, файл не тронут");
check(r.scopes.deadlines.status === "error", "version новее: статус области error");

// 12. повреждённый файл: предупреждение первого чтения (вне блокировки) доходит до ответа
fs.writeFileSync(stateFile, "{ не json");
r = await call({ scopes: ["deadlines"] });
check(r.persisted && r.warnings.some((w) => /повреждён/.test(w)), "corrupt: предупреждение в ответе, база начата заново и записана");
check(fs.readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-")), "corrupt: файл перемещён в .corrupt-*");

// 13. потолок ответа 200 и omitted (Review: §15 п. 2); отдельный каталог и источник с управляемым числом фактов
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "t9b-"));
let bulkN = 0;
const bulk = () => [ex("bulk", "deadlines", {}, () => ({ facts: Array.from({ length: bulkN }, (_, i) => fact(`b${i}`, { due: "x" })) }))];
const callB = (o) => getChanges(o, { ...base, dir: dirB, single: bulk() });
await callB({ scopes: ["deadlines"] });                       // база (пустая)
bulkN = 205;
r = await callB({ scopes: ["deadlines"] });
check(r.changes.length === 200 && r.omitted === 5 && r.ackSeq === r.changes[199].seq, "потолок 200: omitted = 5, ackSeq — seq 200-го события");
r = await callB({ scopes: ["deadlines"], ack: r.ackSeq });
check(r.changes.length === 5 && r.omitted === 0, "после ack срезанный префикс выдан остатком (5 событий), ничего не потеряно");

// 14. срез журнала по потолку 500 и gap.lostEvents: сообщается один раз
const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "t9c-"));
bulkN = 0;
const callC = (o) => getChanges(o, { ...base, dir: dirC, single: bulk() });
await callC({ scopes: ["deadlines"] });                       // база (пустая), seen.deadlines = 0
bulkN = 505;
r = await callC({ scopes: ["deadlines"] });
check(r.gap.lostEvents === 5 && r.changes.length === 200 && r.omitted === 300, "потолок журнала 500: срезано 5 невыданных → gap.lostEvents = 5, в ответе 200, omitted 300");
r = await callC({ scopes: ["deadlines"] });
check(r.gap.lostEvents === 0, "gap.lostEvents сообщается один раз (повтор — 0)");
finish();
```

Run: `node $SCRATCH/verify-3/t9-client.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 4: Поправки спеки (П1–П5)** — отредактировать `docs/superpowers/specs/2026-10-15-snapshots-diff-design.md`. Поправка П1 (`issued` — карта по областям) должна **полностью** вытеснить описание `issued` одним числом; точные фразы-цели (на момент написания плана — строки спеки):

   1. §7, схема состояния (стр. ~148): `{ version, rev, nextSeq, issued, lost: { [scope]: n },` → `issued: { [scope]: seq }` (наибольший выданный `seq` области).
   2. §10, таблица параметров, строка `ack?` (стр. ~247): «`seq`, до которого события **получены**; сдвигает `seen` для областей вызова» → добавить «не выше выданного по области (`issued[scope]`)».
   3. §10, «Порядок», шаг (1) (стр. ~249–250): «применить к `seen` (с ограничением `ack ≤ issued`; больше — игнорируется с предупреждением)» → «применить к `seen`: `ack`, больший наибольшего когда-либо выданного `seq` (`max(issued[*])` по всем областям), игнорируется целиком с предупреждением; иначе для каждой области вызова `seen[scope] = max(seen[scope], min(ack, issued[scope]))`».
   4. §10, определение `issued` (стр. ~258–259): «`issued` — наибольший `seq`, когда-либо возвращённый в ответе; он записывается тем же коммитом (шаг 3) и ограничивает `ack`» → «`issued` — карта `{ [scope]: seq }`: наибольший `seq`, возвращённый в ответе по области; записывается тем же коммитом (шаг 3), ограничивает `ack` по области; `since` и `persisted: false` его не меняют».
   5. §10, абзац про применение `ack` (стр. ~260–261): «`ack` применяется ко всем областям текущего вызова: `seen[scope] = max(seen[scope], ack)`; области вне вызова не затрагиваются» → «для каждой области вызова `seen[scope] = max(seen[scope], min(ack, issued[scope]))`; области вне вызова не затрагиваются. Иначе `ack` после выдачи одной области подтвердил бы невыданные события другой».
   6. §15 п. 2 (стр. ~404): «`ack` (повтор без ack, ack > issued)» → «`ack` (повтор без ack; `ack` > `max(issued)` — игнорируется целиком; `ack` по другой области срезается по `issued[scope]`)».
   7. §10, `since`: добавить «снимок и коммит выполняются как обычно; `ackSeq: null`, `issued` не меняется».
   8. §10, ответ: добавить «источник `lms_courses` входит в область `grades`; его отказ даёт статус области `error`» и верхнеуровневое поле `warnings: string[]` (в пример JSON и в текст).
   9. §5/§11 п. 1: `to = endOfDay(today + 60 д)` (последний день целиком); `coverage.to` — тот же момент в UTC.
   10. §7: добавить «при `io-error` чтения и `version` новее — коммита нет; статусы областей `error`, `persisted: false`».

   Проверка полноты (Git Bash): `grep -n "issued" docs/superpowers/specs/2026-10-15-snapshots-diff-design.md`. Expected: каждое вхождение описывает карту по областям, `issued[scope]` или `max(issued)`; нет «`ack ≤ issued`», «`seq`, когда-либо возвращённый в ответе» без «по области», «`max(seen[scope], ack)`», «ack > issued» без `max`.

- [ ] **Step 5: Коммит**

```bash
git add src/services/changes/client.ts docs/superpowers/specs/2026-10-15-snapshots-diff-design.md
git commit -m "Add changes orchestrator (getChanges/resetChanges); amend spec ack semantics

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `runTool` с сигналом, тулы `hse_changes`/`hse_changes_reset`, регистрация

**Files:**
- Modify: `src/mcp-utils.ts:14-23`, `src/index.ts:9,23`
- Create: `src/services/changes/tools.ts`

**Interfaces:**
- Consumes: `getChanges`, `resetChanges` (T9).
- Produces:
```ts
// mcp-utils.ts
export async function runTool(fn: (signal?: AbortSignal) => Promise<unknown>, signal?: AbortSignal): Promise<ToolTextResult>
// tools.ts
export function registerChangesTools(server: McpServer): void   // hse_changes, hse_changes_reset
```

- [ ] **Step 1: `mcp-utils.ts`**

```ts
/**
 * Оборачивает тело тула: успешный результат сериализуется в JSON-текст, ошибка — в isError-ответ
 * вместо исключения. `signal` (из `extra.signal` SDK) передаётся в `fn`: срабатывает, когда клиент
 * отменил запрос или остановил задачу.
 */
export async function runTool(
  fn: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<ToolTextResult> {
  try {
    const result = await fn(signal);
    return { content: [{ type: "text", text: toText(result) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Ошибка: ${message}` }], isError: true };
  }
}
```

- [ ] **Step 2: `tools.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as changes from "./client.js";

const SCOPE = z.enum(["deadlines", "schedule", "inbox", "claims", "grades"]);

export function registerChangesTools(server: McpServer): void {
  server.registerTool(
    "hse_changes",
    {
      title: "Что изменилось с прошлого раза",
      description:
        "Снимает текущее состояние дедлайнов, расписания, входящего и заявок (по явной просьбе — " +
        "оценок) и возвращает ТОЛЬКО изменения с прошлого снимка: новое, изменено, пропало, " +
        "перенесено, просрочено. Для «что есть сейчас» используйте my_today/my_week/my_deadlines. " +
        "Первый вызов по источнику создаёт базу без событий (status: baseline). События не " +
        "теряются, если ответ не дошёл: курсор двигается только явным подтверждением — передайте " +
        "ackSeq из ответа в параметр ack следующего вызова; без ack те же события вернутся снова. " +
        "«Пропало из календаря» не означает «сдано». Область grades дорогая (страница на курс, " +
        "десятки секунд) и берёт оценки только из журнала LMS. Возвращает JSON: changes, scopes " +
        "(статус по областям), sources (статус каждого источника; отказ одного не роняет вызов), " +
        "ackSeq, omitted, gap, persisted, warnings.",
      inputSchema: {
        scopes: z
          .array(SCOPE)
          .optional()
          .describe("Области; по умолчанию deadlines, schedule, inbox, claims (без grades)."),
        courses: z
          .array(z.union([z.number().int().positive(), z.string().min(1)]))
          .optional()
          .describe("Фильтр курсов для grades: число — id курса, строка — часть названия."),
        fresh: z.boolean().optional().describe("true — игнорировать кэш (иначе принимаются данные не старше 60 с)."),
        since: z
          .string()
          .min(2)
          .optional()
          .describe('Журнал за период ("7d", "12h" или дата ISO) вместо неподтверждённого; курсор не двигается.'),
        ack: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("ackSeq предыдущего ответа: события до него получены и больше не возвращаются."),
      },
    },
    async ({ scopes, courses, fresh, since, ack }, extra) =>
      runTool((signal) => changes.getChanges({ scopes, courses, fresh, since, ack, signal }), extra.signal)
  );

  server.registerTool(
    "hse_changes_reset",
    {
      title: "Сбросить накопленные изменения",
      description:
        "Стирает локальные базы снимков и журнал событий области (или всех областей), после чего " +
        "следующий hse_changes создаёт базу заново. Меняет только локальный файл. Требует confirm: true.",
      inputSchema: {
        scope: SCOPE.optional().describe("Область; без неё — все."),
        confirm: z.boolean().describe("Должно быть true: подтверждение стирания."),
      },
    },
    async ({ scope, confirm }) => runTool(() => changes.resetChanges({ scope, confirm }))
  );
}
```

- [ ] **Step 3: `index.ts`** — добавить импорт `import { registerChangesTools } from "./services/changes/tools.js";` рядом с `registerDigestTools` и вызов `registerChangesTools(server);` после `registerDigestTools(server);`. Строки с `registerMailTools` не трогать.

- [ ] **Step 4: Сборка** — Expected: код 0.

- [ ] **Step 5: Проверка** `$SCRATCH/verify-3/t10-tools.mjs`

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dist, check, finish } from "./lib.mjs";
const { registerChangesTools } = await dist("services/changes/tools.js");
const { runTool } = await dist("mcp-utils.js");

// runTool: прежнее поведение и передача сигнала
let seen;
const ok = await runTool(async (s) => { seen = s; return { a: 1 }; }, new AbortController().signal);
check(!ok.isError && JSON.parse(ok.content[0].text).a === 1 && seen instanceof AbortSignal, "runTool: сигнал передан в fn");
const err = await runTool(async () => { throw new Error("x"); });
check(err.isError && /Ошибка: x/.test(err.content[0].text), "runTool: исключение → isError");
const legacy = await runTool(() => Promise.resolve("t"));
check(legacy.content[0].text === "t", "runTool: вызов без аргументов работает (существующие тулы)");

// регистрация
const tools = {};
registerChangesTools({ registerTool: (name, def, handler) => { tools[name] = { def, handler }; } });
check(Object.keys(tools).sort().join() === "hse_changes,hse_changes_reset", "зарегистрированы два тула");
check(Object.keys(tools.hse_changes.def.inputSchema).sort().join() === "ack,courses,fresh,scopes,since", "hse_changes: параметры");
check(/ackSeq/.test(tools.hse_changes.def.description) && /my_today/.test(tools.hse_changes.def.description), "описание разводит digest и hse_changes, говорит про ack");

// reset без confirm — отказ на уровне тула (isError)
const refused = await tools.hse_changes_reset.handler({ scope: "deadlines", confirm: false }, { signal: new AbortController().signal });
check(refused.isError && /confirm/.test(refused.content[0].text), "hse_changes_reset без confirm: true → isError");
finish();
```

Run: `node $SCRATCH/verify-3/t10-tools.mjs`
Expected: `ALL PASSED`. (`hse_changes_reset` с `confirm: false` отказывает до обращения к диску.)

- [ ] **Step 6: Модуль тулов загружается и подключён в `index.ts`**

Run (Git Bash, из корня worktree): `node -e "import('file:///C:/Users/alexk/hsemcp/.claude/worktrees/update/dist/services/changes/tools.js').then(()=>console.log('ok'))"`
Expected: `ok`.

Run: `grep -n "registerChangesTools" dist/index.js`
Expected: 2 строки (импорт и вызов). Сам `dist/index.js` не запускается: он открывает stdio-транспорт.

- [ ] **Step 7: Коммит**

```bash
git add src/mcp-utils.ts src/services/changes/tools.ts src/index.ts
git commit -m "Register hse_changes and hse_changes_reset tools; runTool accepts a signal

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Документация

**Files:**
- Modify: `docs/requirements.md` (после п. 10 раздела «Реализовано», нефункциональные), `CLAUDE.md` (архитектура, istudy, roadmap), `README.md` (таблица тулов, «Как это устроено»), `docs/recon.md` (находки)

**Interfaces:** нет кода.

- [ ] **Step 1: `docs/requirements.md`**

После пункта 10 (до заголовка «### Запланировано») добавить пункт:

```markdown
11. Что изменилось с прошлого раза (`hse_changes`, `hse_changes_reset`): снимок дедлайнов,
    расписания (на 14 дней), входящего (внутренняя почта SmartLMS, уведомления ЕЛК) и заявок ЕЛК, а по
    явной просьбе — оценок журнала LMS; в ответе только изменения (новое, изменено, пропало,
    перенесено, просрочено). Базы по источникам и журнал событий (30 дней, ≤ 500) лежат в
    `storage/changes/state.json`; курсор двигается явным `ack`, поэтому событие не теряется при сбое
    ответа. Первый запуск источника создаёт базу без событий; отказ источника — статус, а не
    ошибка. Итоговые и экзаменационные оценки из istudy не входят.
```

В «Нефункциональные требования» добавить пункты:

```markdown
- **Состояние снимков хранится на диске** (`storage/changes/state.json`, в `.gitignore`): только
  нормализованные факты — без токенов, email, ФИО, тел писем, текста уведомлений и заявок, url с
  query. Темы писем и заголовки уведомлений хранятся как есть — принятый риск. `0o600` на Windows
  не защита, защищает ACL профиля. Сброс — `hse_changes_reset({ confirm: true })`.
- **Свежесть по вызову, а не сбросом кэша**: `maxAgeMs` у вызова ресурса (`hse_changes` — 60 с,
  `fresh: true` — 0); `hse_changes` не вызывает `clearCache`.
```

В список «Целевые системы» строку про istudy не менять.

- [ ] **Step 2: `CLAUDE.md`**

(а) В раздел «Архитектура» после абзаца про `digest` добавить:

```markdown
- **Снимки и изменения** (`services/changes/`) — `hse_changes`/`hse_changes_reset`. Извлекатели
  (`extractors.ts`) приводят источники (календарь Moodle, окна СОП, расписание ЕЛК, сообщения LMS,
  уведомления и заявки ЕЛК, оценки по курсам через `lms.listGradeItems`) к фактам с стабильным `id`;
  `diff.ts` — чистое сравнение с базой источника с учётом покрытия (скользящих окон); `store.ts`
  пишет `storage/changes/state.json` атомарно (tmp + rename, повторы при `EBUSY`, lock-файл).
  Единица базы — источник: отказ одного не затрагивает остальных. Курсор двигается только явным
  `ack` (`issued` по областям не даёт подтвердить невыданное). Оценки идут пулом ≤ 3 с бюджетом
  90 с. Моменты — UTC у Moodle и наивное МСК у ЕЛК (пояс машины не участвует).
```

(б) В абзаце про `src/resource.ts#defineResource` добавить: «Вызов принимает `{ signal, maxAgeMs }`: `maxAgeMs` принимает запись не старше N мс, не сбрасывая кэш (`clearCache` бьёт по всем доменам)».

(в) Абзац про istudy (строки ~56–60) заменить на:

```markdown
- **istudy.hse.ru** (`services/istudy/`) — отдельная от ЕЛК система детальной зачётки/рейтинга,
  доступ через SSO-переход по ссылке со страницы `lk.hse.ru/profile`. Клиент слушает
  `page.on("response")` и забирает ответы, которые SPA сама шлёт при заходе. **Сейчас не работает
  (F9):** по живому прогону 2026-10-15 вход работает без MAX (`/auth` → `/token` → `/dashboard`);
  данные зачётки требуют двухфакторного подтверждения через MAX (HTTP 412 на
  `/api/auth/two-factor/required`); API профиля переехал на `POST /api/student/profile?studentId=`
  (клиент ищет `/api/student/\d+/…` и не находит). Пользователь MAX не использует — зачётка
  недоступна. Один аккаунт, один прогон; см. §12 спецификации подпроекта 3.
```

(г) В «Roadmap»: после упоминания подпроекта 2 добавить «подпроект 3 «Проактивность: снапшоты и diff» (`hse_changes`) реализован».

- [ ] **Step 3: `README.md`**

В таблицу тулов после строки `my_deadlines` добавить:

```markdown
| Изменения | `hse_changes` | Что изменилось с прошлого раза: дедлайны, расписание, входящее, заявки (и оценки LMS по явной просьбе); `ack` подтверждает полученное |
| Изменения | `hse_changes_reset` | Стереть локальные базы и журнал событий (`confirm: true`) |
```

В «Как это устроено» после пункта «Сводки» добавить пункт «**Изменения** (`hse_changes`)» с описанием: локальный файл `storage/changes/state.json`, `ack`, первый вызов создаёт базу, оценки только из журнала LMS и дорогие (десятки секунд). Пункт про istudy привести к формулировке из `CLAUDE.md` (в части «причина отказа»).

- [ ] **Step 4: `docs/recon.md`**

Перед разделом «## Учёба» добавить раздел:

```markdown
## Сделано (находки живой проверки подпроекта 3, 2026-10-15)

- [x] **istudy: вход без MAX, API переехал.** SSO-цепочка с профиля ЕЛК проходит
      (`lk.hse.ru/profile` → `istudy.hse.ru/auth` → `/token` → `/dashboard`), экрана входа и MAX нет;
      ответы 200: `/api/sso/auth`, `/api/user`, `/api/user/active-role`, `/api/student/profiles`,
      `POST /api/student/profile?studentId=<id>` (раньше `GET /api/student/<id>/profile`);
      `report-info`, `rating`, `exams-by-period` на `/dashboard` не запрашивались.
- [x] **istudy: данные зачётки за 2FA.** Клик по пункту меню «Зачетная книжка» вызывает
      `GET /api/auth/two-factor/required` → **HTTP 412** (поля `status`, `error`, `message`,
      `details`; текст `message` не просматривался); данных зачётки нет. Причина дефекта F9 —
      смена путей API и 2FA-барьер данных. Один аккаунт, один прогон. Пользователь MAX не
      использует — зачётка недоступна. Не установлено: срок подтверждения, возможность пройти его без
      телефона, эндпоинты после подтверждения.
- [x] **Пресс-релиз НИУ ВШЭ (2026-09-28)** о переводе «ЯУчусь» на авторизацию через MAX с
      двухфакторной аутентификацией — согласуется с HTTP 412 выше; что «ЯУчусь» = `istudy.hse.ru`,
      прямого источника нет. Вход без существующей сессии не проверялся.
- [x] **Журнал оценок LMS (`grade/report/user`)**: `table.user-grade`, имя элемента в
      `th.column-itemname.levelN`, колонки по классам `column-*`; существующий `extractTable`
      сдвигает ключи на одну позицию и теряет имя (дефект `lms_get_grades` — чинится отдельно).
- [x] **Расписание ЕЛК**: `lesson_number` присутствует, но `null` у всех занятий; полей отмены нет.
- [x] **Уведомления ЕЛК**: дата без времени (`ГГГГ-ММ-ДД`).
```

- [ ] **Step 5: Сверка**

Run: `git diff --stat docs/ CLAUDE.md README.md`
Expected: изменены только четыре файла из списка.

Run (Git Bash): `git diff -U0 docs/requirements.md CLAUDE.md README.md docs/recon.md | grep -nE "^\+.*(TBD|TODO)"`
Expected: пустой вывод (ни одной добавленной строки с `TBD`/`TODO`; прежние вхождения не считаются).

- [ ] **Step 6: Коммит**

```bash
git add docs/requirements.md CLAUDE.md README.md docs/recon.md
git commit -m "Document subproject 3: changes tools, state file, istudy finding

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Живая проверка и §18 спеки

**Files:**
- Create (вне репозитория): `$SCRATCH/verify-3/live-changes.mjs`
- Modify: `docs/superpowers/specs/2026-10-15-snapshots-diff-design.md` (§18; шапка статуса)

**Interfaces:** нет кода в репозитории.

> **Разрешения.** Скрипт читает `HSE_EMAIL`/`HSE_PASSWORD` из `C:\Users\alexk\hsemcp\.env` и входит в реальный аккаунт. Предыдущая живая проверка этой ветки была отклонена системой прав у субагента (`[PII Data Handling]`) и выполнена основной сессией по прямому поручению пользователя. Если запуск отклонён — **остановиться** и вернуть пользователю команду `! node …`; не обходить, не менять настройки разрешений.

- [ ] **Step 1: Скрипт** `$SCRATCH/verify-3/live-changes.mjs`

Требования к скрипту (по §15 п. 3 спеки): `.env` читается в `process.env` (только `HSE_EMAIL`, `HSE_PASSWORD`), ничего не печатается, кроме агрегатов; `console.error` проекта перехватывается и обезличивается (URL → host+path); счётчик страниц — патчем `chromium.launch` → `newContext` → событие `page`, как в предыдущем скрипте проверки; при 403/429 от `*.hse.ru` — остановка; каталог состояния — **временный** (`dir` в `overrides`), а не рабочий `storage/changes`. Сценарии, каждый печатает одну строку `{шаг, ok, ms, pages, …агрегаты}`:

1. Холодный `getChanges({})` (области по умолчанию): статусы областей и источников, число фактов, `changes.length === 0`, `persisted`, время, страницы.
2. **Сразу повторный `getChanges({})`**: `changes.length === 0` и **0 новых страниц** (критерий §15 п. 3).
3. `getChanges({ scopes: ["grades"] })` холодный и повторный: время, число курсов, статусы источников (`error: unsupported grade table`, если есть), `skipped`.
4. **Имитация** (помечается «имитация», не «вживую»): взять `state.json` временного каталога, удалить один факт `lms_calendar`, изменить `attrs.due` другого, у оценки выставить `attrs.grade` в `null` у элемента с оценкой, один факт расписания сдвинуть по `at`/`id`; повторный `getChanges` с теми же областями → ожидаемые события `added`, `changed`, `changed`, `moved`/`removed+added`.
5. `ack`: `ackSeq` из шага 4 → следующий вызов с `ack` → 0 неподтверждённых; `ack` больше `max(issued)` → предупреждение, `ack` игнорируется целиком.
6. Отмена: `AbortController`, `abort()` через 1 с после старта области `grades` → `persisted: false`, `rev` на диске не изменился.
7. Регистрация: подставной `server` с `registerTool`, вызов обработчика `hse_changes` с `{}` — ответ парсится как JSON, без исключения.

- [ ] **Step 2: Запуск**

Run: `node $SCRATCH/verify-3/live-changes.mjs > $SCRATCH/verify-3/live-results.txt`
Expected: выполняется без остановки по 403/429; файл содержит обезличенные строки по шагам 1–7.

- [ ] **Step 3: §18 спеки** — дописать в конец раздела §18 подраздел «Проверка реализации (после задач 1–11)»: таблица «проверка · результат (обезличенный) · вердикт `ПРОВЕРЕНО ВЖИВУЮ` / `ИМИТАЦИЯ` / `НЕ ПРОВЕРЕНО`» по шагам 1–7 и тайминги. Обязательно перечислить «Не проверено»: сдвиг срока и override-события Moodle, отмена пары, смена пояса машины, несколько процессов реально, иные темы оформления, вход istudy без существующей сессии. В шапке спеки заменить «реализация не начата» на «реализована и проверена (§18)».

- [ ] **Step 4: Итоговая сборка и чистота**

Run (Git Bash): `node C:/Users/alexk/hsemcp/node_modules/typescript/bin/tsc -p tsconfig.json` и `git status --short`
Expected: код 0; в `git status` только правка спеки; `storage/changes/` не отслеживается (`git check-ignore -v storage/changes/state.json` показывает правило из `.gitignore`).

- [ ] **Step 5: Коммит**

```bash
git add docs/superpowers/specs/2026-10-15-snapshots-diff-design.md
git commit -m "Record live verification results for subproject 3 (spec §18)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Покрытие спеки

| Раздел спеки | Требование | Задача |
|---|---|---|
| §2 | Только по запросу; `ack`; оценки отдельной областью | 9, 10 |
| §4 | Таблица файлов и изменений в существующем коде | 1–10 |
| §5 | Модель факта; таблица «область → источник → id → attrs» | 6, 8 |
| §5 п. 1–4 | «Пропало ≠ сдано», `overdue` вне `attrs`, прочтение — не событие, покрытие | 6 (`diff`), 8 |
| §5 п. 5 | Ключ расписания с началом, склейка `moved` | 6, 8 |
| §5 п. 6 | `extractGradeTable`, `lms.grade-items`, `unsupported`, пустая оценка | 5, 8, 9 |
| §6 | Нормализация: NFC, UTC-минуты, наивное МСК, отпечаток, копирование | 6 |
| §7 | `state.json`, `nextSeq`, срезы, `.corrupt`, повторы ввода-вывода, lock-файл, `version` | 7 |
| §7 | Что не пишется (ФИО, тексты, query) | 8 (извлекатели) |
| §7 | `projectRoot` — общий хелпер | 1 |
| §8 | `maxAgeMs`: `storedAt` как старт, in-flight, защита от старой записи | 3 |
| §8 | Восемь функций с `opts`; `getSchedule` — в каждую неделю | 4, 5 |
| §8 | Полнота: максимальные `limit` | 8 |
| §9 | Пул ≤ 3, бюджет 90 с, порядок по давности, `skipped`, актуальные курсы | 9 |
| §10 | `hse_changes`/`hse_changes_reset`, порядок шагов, `ack`, `since`, потолок 200, `omitted`, `gap`, первый запуск по источнику | 9, 10 |
| §10 | `extra.signal`, пропуск коммита при отмене | 9, 10 |
| §10 | `persisted: false`, события без `seq` | 9 |
| §11 | Покрытие по источникам, `truncated`, отказ источника, идемпотентность | 8, 9 |
| §12 | istudy (недостижим без MAX) и RUZ вне; точка расширения не планируется | вне плана (отмечено), 11 (документация) |
| §13 | Приватность, `confirm` у reset | 7, 8, 10 |
| §14 | Долг №4 не чинится; `getGrades` не меняется; почта — отдельный PR | вне плана (отмечено), 5 (проверка неизменности) |
| §15 | Сборка, изолированные скрипты, живая проверка, имитация, итоги | 0–10 (скрипты), 12 |
| §15 п. 6 | Документация | 11 |
| §16, §18 | Допущения и результаты | 12 |

## Выбор способа исполнения

**Рекомендация: subagent-driven (`superpowers:subagent-driven-development`) для задач 1–10; задачи 11 и 12 выполнять inline в основной сессии.**

- **Почему subagent-driven.** У задач общие интерфейсы (`ResourceCallOptions`, `Fact`/`SourceResult`/`State`, сигнатуры `store` и `extractors`), и ошибка в логике курсора или базы означает молчаливую потерю событий — цену этого ловит свежий ревьюер, а не автор. Задачи малы и независимо коммитятся, поэтому гейт «исполнитель → ревьюер» на каждой дёшев. Исполнители идут строго по очереди (T1 … T12) в одном worktree: параллельный запуск в нём даёт ложные ошибки сборки и конфликты `index.lock`.
- **Когда inline (`superpowers:executing-plans`).** Задача 11 (документация) и задача 12: живая проверка требует учётных данных пользователя и разрешения на доступ к аккаунту — субагенту это ранее было отклонено системой прав; исполнять в основной сессии, где пользователь присутствует.
- **Что остаётся на решение пользователя до старта:** (1) принимает ли он поправки П1–П5 к спеке (особенно П1 — `issued` по областям); (2) три решения по умолчанию (§ «Что вне плана», (в)); (3) судьба дефекта `lms_get_grades` (здесь «чинится отдельно»); (4) нужно ли отдельное небольшое улучшение «статус "требуется 2FA"» в `istudy_get_report`/`istudy_get_exams` (спека §14; в №3 не входит). Решение «istudy вне №3» принято пользователем (MAX не используется) и пересмотра не требует.

**Реализацию не начинать до явного одобрения пользователем плана и способа исполнения.**

## Исправления после preflight

Правки текста плана по отчёту preflight (`.superpowers/sdd/2026-10-15-snapshots-diff/preflight.md`). Код замечания → что изменено.

**Blocking**

- B1 → задача 9: `reports` возвращает `{ scopes, sources }`; ветка отмены берёт `rep.scopes`/`rep.sources`.
- B2 → П1, Global Constraints, Review Focus 4, интерфейсы и `applyAck` задачи 9, тесты t9: `ack` больше `max(issued[*])` по всем областям игнорируется целиком с предупреждением; иначе `seen = max(seen, min(ack, issued[scope]))`; добавлена проверка «ack ≤ max(issued), но меньше seq события».
- B3 → t9: `claimsFail = true` с первого вызова (область `claims` получает `baseline` на шаге 5).
- B4 → t9: `gradesBudgetMs: 60_000` в `base` и в первом вызове оценок (бюджет должен превышать `GRADES_COURSE_RESERVE_MS` = 15 с); случай «бюджет ≤ резерва» остаётся проверкой `skipped`.
- B5 → задача 8: у `elkWindows` убрана подмена `|| normText(row["#"])`; id окна — только период.
- B6 → задача 4: первой строкой `t4-opts.mjs` — `process.env.HSE_EMAIL ??= "t4@example.invalid"` и пояснение.

**Important**

- I1 → задача 9, Step 4: десять пунктов правки спеки с точными фразами-целями (§7 схема, §10 таблица `ack?`, шаг (1), определение `issued`, абзац применения `ack`, §15 п. 2, `since`, `lms_courses`, `warnings`, П2, `io-error`/`newer`) и проверка полноты `grep issued` по спеке.
- I2 → задача 8, задача 6 (тест): у заявок `flags: { emitRemoved: false }`; перенос отсутствующих — по умолчанию; проверки в t6 и t8.
- I3 → задача 8: условие `!table.found || !table.recognized`; предупреждение «таблица оценок пуста» удалено как недостижимое; в t8 добавлен случай `found: true, recognized: false, rows: []`.
- I4 → задача 9: предупреждение первого `loadState` переносится в `warnings` (с дедупликацией при повторе под блокировкой); добавлена проверка `corrupt` в t9.
- I5 → задача 5, Step 5: `grep` только по удалённым строкам (`^-`), Git Bash.
- I6 → задача 7: две пустые проверки среза журнала по возрасту заменены одной `join() === "2,3"`; примечание в Expected убрано.
- I7 → Global Constraints, задачи 0, 10, 12 (и новые команды в 5, 9, 11): для Git Bash прямые слэши; в Global Constraints оба варианта (Git Bash / PowerShell) одной строкой.
- I8 → «Зависимости и параллельность», «Выбор способа исполнения»: порядок строго последовательный T1…T12; параллельность — только в разных worktree и в плане не используется; граф зависимостей оставлен.
- I9 → t9: добавлены проверки потолка 200 и `omitted` (205 событий → 200 + 5, остаток после `ack`) и `gap.lostEvents` (505 событий → потеряно 5, один раз).

**Minor**

- m1 → задача 9: при `persisted: false` объединённый список событий обрезается до 200, остаток входит в `omitted`.
- m2 → задача 9: `lms_courses` со статусом `ok` не участвует в агрегации статуса области `grades` (добавлена проверка `baseline`); пустой список курсов даёт `ok`, а не `error`.
- m3 → t9: пустая проверка `await check(true, "—")` удалена.
- m4 → t4: проверка `getSchedule` разнесена на две недели по отдельности (вызовы на одну неделю с `maxAgeMs: 20`); засев недель без разнесения по времени.
- m5 → задача 8: Step 1 сразу содержит вариант на `formatLocalDate`; прежние Step 2 и «Замечание исполнителю» убраны, шаги перенумерованы (Сборка — 2, Проверка — 3, Коммит — 4).
- m6 → задача 10, Step 6: переименован в «Модуль тулов загружается и подключён в `index.ts`», добавлен `grep registerChangesTools dist/index.js` (2 строки).
- m7 → задача 11, Step 5: `git diff -U0 … | grep -nE "^\+.*(TBD|TODO)"`, ожидается пусто.
- m8 → «Карта файлов»: «Поправки П1–П5 (задача 9)».
- m9 → задача 9, Step 4 (п. 8) и описание тула: `warnings: string[]` в ответе §10.
- m11 → задача 0: `$SCRATCH` объяснён как условное обозначение с подстановкой абсолютного пути scratchpad основной сессии.

**Не применено по решению**

- m10 (атрибуция коммитов «из system-reminder»): трейлер `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` оставлен фиксированным по решению пользователя.

**Попутно**

- Заголовок «Выбор способа исполнения»: «задачи 1–10; задачи 11 и 12 — inline» (приведён в соответствие с пунктом «Когда inline» в том же разделе; ранее 11 числилась и в subagent-driven, и в inline).
