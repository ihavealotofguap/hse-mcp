# Переработка подпроекта 1 «Надёжность и скорость» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить кэш/лимитер/доступ к ЕЛК из `d98fbe6` на декларативные ресурсы, `withPage` с дедлайном и арендой слота, узкий замок входа и выключатель прямого пути ЕЛК — без изменения публичных сигнатур клиентов и MCP-тулов.

**Architecture:** `src/resource.ts` (`defineResource`) владеет ключом, TTL, загрузчиком, срезом и дедлайном и сидит поверх существующего `cache.ts`. `withPage` в `browser-session.ts` гарантирует закрытие страницы и возврат слота; лимитер получает аренду слота, отмену по сигналу и очередь по частоте для `context.request`. Клиенты `elk`/`lms`/`istudy` становятся тонкими обёртками над ресурсами.

**Tech Stack:** TypeScript (strict, NodeNext, ESM), Playwright, `@modelcontextprotocol/sdk`, zod. Node 26 (`node -v` → v26.8.1).

**Spec:** `docs/superpowers/specs/2026-10-14-reliability-rework-design.md`

## Global Constraints

- Тестов и линтера в проекте нет **по решению проекта** (CLAUDE.md) — не добавлять и не коммитить. Проверка: `npm run build`, изолированные скрипты через `dist/`, живая проверка. Скрипты лежат в scratchpad сессии (ниже `$SCRATCH`) и в репозиторий не попадают.
- Рабочая директория — worktree `<путь-к-проекту>/.claude/worktrees/reliability-rework` (ниже `$WT`), ветка `reliability-rework`. Команды запускать оттуда, без `cd` в другие каталоги.
- Публичные сигнатуры клиентских функций (`getSchedule(from, to)`, `listMessages(limit)`, `getNotifications(limit)` и т.д.) и MCP-тулов **не меняются**.
- Домен кэша — префикс `elk:` / `lms:` / `istudy:`; `clearCache("<домен>:")` и `hse_clear_cache({scope})` сохраняют смысл.
- Пороги лимитера остаются **3 страницы / ≥300 мс** (не измерены); аренда слота = `deadlineMs` + 5 с; дедлайн загрузки по умолчанию 45 с; выключатель прямого пути — 10 мин.
- Кэш только в памяти, на диск не пишется; единый `hse_clear_cache`, параметра `refresh` в тулах нет.
- Живые скрипты читают `HSE_EMAIL`/`HSE_PASSWORD` из `.env` проекта в `process.env`, ничего не печатают; токены, пароли, ФИО, email, query-строки URL в вывод не попадают. `.env` и `storage/` в worktree не копировать (`storage/` создаётся логином и в .gitignore).
- Комментарии, сообщения об ошибках и документация — на русском; импорты с суффиксом `.js`.
- Каждый коммит заканчивается трейлером `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- В документах честно разделять «проверено вживую» и «не проверено». Отдельного `PROGRESS.md` нет: итоги — раздел «Результаты живой проверки» в спецификации.

## Уточнения к спецификации (подтвердить на ревью)

Спецификация молчит или допускает два прочтения; план фиксирует такие решения:

1. **Защита общего результата — `Object.freeze` на запись в кэш, а не `DeepReadonly` в типах.** Тип `DeepReadonly` каскадом сломал бы сигнатуры `digest` и тулов (запрещено «сигнатуры не меняются»), а приведение типов (`as T`) отменяло бы защиту. Заморозка во время выполнения строже: мутация даёт `TypeError`. Проверено чтением: потребители копируют (`[...items].sort`, `filter`, `map`), на кэшированных результатах мутаций нет.
2. **Политика прямого пути ЕЛК.** Две попытки прямого запроса при 401, 403 или не-JSON-ответе. Токен сбрасывается только при 401 и не-JSON; при 403 — нет. После двух отказов — один заход через страницу; если страница прошла, выключатель срабатывает (10 мин), если нет — ошибка пользователю без срабатывания.
3. **Интервал для `context.request` — 100 мс** (спецификация говорит «только интервал», значения не задаёт; 300 мс замедлили бы сводку на секунды). Не измерено.
4. **Расписание ЕЛК по неделям; потолок 53 недели** на один вызов (иначе явная ошибка вместо сотен запросов).
5. **«Максимум» для срезов:** сообщения LMS — 200 (максимум тула), уведомления ЕЛК — 100 (максимум тула), заявки/задачи — 500 (максимум тула), поиск ЕЛК — 50 (максимум тула).
6. **`digest` не меняется.** Передача `AbortSignal` из `runSource` в клиенты в этот план не входит (спецификация: опционально); ресурсы принимают `signal`, так что это можно добавить позже.

## Review Focus

Отказы и входы, которые спецификация подразумевает, но задачи не покрывают очевидными тестами; для каждого есть проверка в задаче-владельце:

1. **Очистка кэша во время загрузки не должна «воскрешать» устаревшее** (поколение) — на уровне ресурса: Task 2.
2. **Отмена одним из нескольких ожидающих не должна убивать общую загрузку** — Task 2.
3. **Слот не утекает ни при зависшей `fn`, ни при отмене в очереди, ни при повторном вызове `release`** (двойное освобождение не должно поднимать потолок выше 3) — Task 1 и Task 3.
4. **Диапазон расписания через границу недели/года и `from > to`** — Task 4.
5. **Дедлайн календаря в прошлом или дальше 60 дней** (точный ключ вместо корзины) и пересчёт `truncated` для среза — Task 6.

---

## Структура файлов

| Файл | Действие | Ответственность |
|---|---|---|
| `src/breaker.ts` | создать | выключатель с охлаждением (чистая логика) |
| `src/limiter.ts` | переписать | слоты страниц с отменой и арендой; очередь по частоте для API |
| `src/resource.ts` | создать | `defineResource`, реестр, заморозка, дедлайн, отсоединение по сигналу |
| `src/cache.ts` | не менять | хранилище с TTL, дедупликацией, поколением |
| `src/auth/browser-session.ts` | изменить | `withPage`, узкий замок входа, атомарная запись сессии |
| `src/services/elk/client.ts` | изменить | токен через `withPage`, политика + выключатель, ресурсы |
| `src/services/lms/client.ts` | изменить | ресурсы, корзины календаря, срез сообщений |
| `src/services/istudy/client.ts` | изменить | миграция на `withPage` и ресурсы (поведение прежнее) |
| `src/services/system/tools.ts` | изменить | описание `hse_clear_cache` |
| `CLAUDE.md`, `docs/requirements.md` | изменить | архитектура, нефункциональные требования |
| `docs/superpowers/specs/2026-10-14-reliability-rework-design.md` | изменить | раздел «Результаты живой проверки» |

Общий каркас проверочных скриптов (`$SCRATCH` — каталог scratchpad этой сессии):

- `$SCRATCH/lib.mjs` — загрузка `.env`, импорт из `dist/`, `check`/`done`.

---

### Task 1: Выключатель и лимитер

**Files:**
- Create: `src/breaker.ts`
- Modify (полная замена): `src/limiter.ts`
- Check (scratchpad): `$SCRATCH/lib.mjs`, `$SCRATCH/check-limiter.mjs`

**Interfaces:**
- Produces:
  - `createBreaker(cooldownMs: number, now?: () => number): Breaker`, где `Breaker = { allow(): boolean; trip(): void; reset(): void }`
  - `acquirePageSlot(opts?: { signal?: AbortSignal; leaseMs?: number }): Promise<() => void>` (возвращённая функция идемпотентна)
  - `acquireRequestTurn(signal?: AbortSignal): Promise<void>`
  - `LEASE_GRACE_MS: number` (5000)
- Consumes: ничего.

- [ ] **Step 1: Создать каркас проверки `$SCRATCH/lib.mjs`**

```js
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const WT = process.env.WT ?? "<путь-к-проекту>/.claude/worktrees/reliability-rework";
export const imp = (rel) => import(pathToFileURL(`${WT}/dist/${rel}`).href);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadEnv() {
  for (const line of fs.readFileSync("<путь-к-проекту>/.env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
}

let failures = 0;
export function check(cond, msg) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}
export function done() {
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}
```

- [ ] **Step 2: Написать проверку `$SCRATCH/check-limiter.mjs` (до реализации)**

```js
import { imp, check, done, sleep } from "./lib.mjs";

const { createBreaker } = await imp("breaker.js");
const { acquirePageSlot, acquireRequestTurn } = await imp("limiter.js");

// --- выключатель
{
  let t = 1000;
  const b = createBreaker(600_000, () => t);
  check(b.allow() === true, "breaker: изначально разрешает прямой путь");
  b.trip();
  check(b.allow() === false, "breaker: после trip запрещает");
  t += 599_999;
  check(b.allow() === false, "breaker: запрещает до конца охлаждения");
  t += 2;
  check(b.allow() === true, "breaker: после охлаждения разрешает пробу");
  b.trip();
  check(b.allow() === false, "breaker: неудачная проба снова запрещает");
  b.reset();
  check(b.allow() === true, "breaker: reset открывает путь");
}

const pending = (p) => Promise.race([p.then(() => false), sleep(450).then(() => true)]);

// --- потолок 3 и шаг ≥300 мс
const stamps = [];
const held = [];
for (let i = 0; i < 3; i++) {
  held.push(await acquirePageSlot());
  stamps.push(Date.now());
}
check(stamps[1] - stamps[0] >= 280 && stamps[2] - stamps[1] >= 280, "limiter: шаг между открытиями ≥ ~300 мс");
const fourth = acquirePageSlot();
check(await pending(fourth), "limiter: 4-й слот ждёт при трёх занятых");

// --- отмена в очереди не оставляет «фантомного» ожидающего
const ctrl = new AbortController();
const aborted = acquirePageSlot({ signal: ctrl.signal });
aborted.catch(() => {});
ctrl.abort(new Error("стоп"));
let abortMsg = "";
await aborted.catch((e) => (abortMsg = e.message));
check(abortMsg === "стоп", "limiter: отмена ожидающего отклоняет его причиной сигнала");

held[0]();
const r4 = await fourth; // 4-й получает слот от первого освобождённого, а не «фантом»
check(typeof r4 === "function", "limiter: освобождённый слот достаётся живому ожидающему");
held[1]();
held[2]();
r4();

// --- двойное освобождение не поднимает потолок выше 3
held[0]();
held[0]();
const a = [];
for (let i = 0; i < 3; i++) a.push(await acquirePageSlot());
const over = acquirePageSlot();
check(await pending(over), "limiter: повторный release не добавил лишний слот (потолок остаётся 3)");
a.forEach((r) => r());
(await over)();

// --- аренда: зависший держатель освобождается принудительно (3 слота с шагом ≥300 мс, аренда
// 1200 мс: первая истекает ~через 600 мс после того, как ожидающий встал в очередь)
const l = [];
for (let i = 0; i < 3; i++) l.push(await acquirePageSlot({ leaseMs: 1200 }));
const t0 = Date.now();
const waiter = await acquirePageSlot();
check(Date.now() - t0 < 2500, `limiter: слот возвращён по аренде за ${Date.now() - t0} мс`);
l.forEach((r) => r()); // поздний release после принудительного — не ломает счётчик
waiter();
const z = [];
for (let i = 0; i < 3; i++) z.push(await acquirePageSlot());
check(await pending(acquirePageSlot()), "limiter: после аренды и позднего release потолок по-прежнему 3");

// --- очередь по частоте для API
const ts = [];
await Promise.all([1, 2, 3].map(() => acquireRequestTurn().then(() => ts.push(Date.now()))));
ts.sort((x, y) => x - y);
check(ts[1] - ts[0] >= 90 && ts[2] - ts[1] >= 90, "limiter: API-запросы идут с шагом ≥ ~100 мс");

done();
```

- [ ] **Step 3: Запустить проверку — убедиться, что падает**

Run: `node $SCRATCH/check-limiter.mjs`
Expected: ошибка импорта `dist/breaker.js` (файла нет) — проверка не может выполниться.

- [ ] **Step 4: Создать `src/breaker.ts`**

```ts
/**
 * Выключатель прямого пути: после `trip()` путь считается недоступным `cooldownMs`; затем
 * `allow()` снова возвращает true — первая же проба либо подтверждает путь (`reset()`), либо
 * снова вызывает `trip()`. Заменяет необратимый флаг «до перезапуска».
 */
export interface Breaker {
  /** true — прямой путь можно пробовать (выключатель закрыт или охлаждение истекло). */
  allow(): boolean;
  /** Прямой путь признан плохим: не пробовать `cooldownMs`. */
  trip(): void;
  /** Прямой путь подтверждён рабочим. */
  reset(): void;
}

export function createBreaker(cooldownMs: number, now: () => number = Date.now): Breaker {
  let openUntil = 0;
  return {
    allow: () => now() >= openUntil,
    trip: () => {
      openUntil = now() + cooldownMs;
    },
    reset: () => {
      openUntil = 0;
    },
  };
}
```

- [ ] **Step 5: Заменить `src/limiter.ts` целиком**

```ts
/**
 * Ограничитель нагрузки на порталы ВШЭ.
 *
 * Страницы: не больше MAX_CONCURRENT одновременно и минимум MIN_INTERVAL_MS между двумя
 * открытиями. Слот выдаётся `withPage` и возвращается в его `finally`; аренда (`leaseMs`) —
 * страховка от любой утечки: по истечении слот освобождается принудительно. Ожидание слота
 * отменяется сигналом.
 *
 * Прямые API-запросы (`context.request`) страниц не занимают, но идут не чаще одного в
 * API_MIN_INTERVAL_MS. Пороги подобраны без данных об антибот-защите ВШЭ — не измерены.
 */

const MAX_CONCURRENT = 3;
const MIN_INTERVAL_MS = 300;
const API_MIN_INTERVAL_MS = 100;
/** Запас аренды сверх дедлайна страницы. */
export const LEASE_GRACE_MS = 5_000;

interface Waiter {
  grant: () => void;
}

let active = 0;
const waiters: Waiter[] = [];
let nextPageStartAt = 0;
let nextApiStartAt = 0;

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new Error("операция отменена");

function takeSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  // Слот передаётся ожидающему напрямую при releaseSlot() — счётчик active при этом не меняется.
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      reject(abortReason(signal!));
    };
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next.grant();
  else active--;
}

function waitUntil(startAt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const delay = startAt - Date.now();
  if (delay <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Дожидается свободного слота и паузы между открытиями. Возвращает идемпотентную функцию
 * освобождения слота. `leaseMs` — принудительное освобождение, если слот держат слишком долго.
 */
export async function acquirePageSlot(
  opts: { signal?: AbortSignal; leaseMs?: number } = {}
): Promise<() => void> {
  await takeSlot(opts.signal);
  let released = false;
  let lease: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (lease) clearTimeout(lease);
    releaseSlot();
  };

  try {
    // Время старта резервируется синхронно, поэтому параллельные вызовы выстраиваются в очередь
    // с шагом MIN_INTERVAL_MS, а не просыпаются разом.
    const now = Date.now();
    const startAt = Math.max(now, nextPageStartAt);
    nextPageStartAt = startAt + MIN_INTERVAL_MS;
    await waitUntil(startAt, opts.signal);
  } catch (err) {
    release();
    throw err;
  }

  if (opts.leaseMs !== undefined) {
    const leaseMs = opts.leaseMs;
    lease = setTimeout(() => {
      if (released) return;
      console.error(`hsemcp: слот страницы удерживался дольше ${leaseMs} мс — освобождаю принудительно`);
      release();
    }, leaseMs);
    lease.unref?.();
  }
  return release;
}

/** Очередь по частоте для прямых API-запросов (слот страницы не занимается). */
export async function acquireRequestTurn(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextApiStartAt);
  nextApiStartAt = startAt + API_MIN_INTERVAL_MS;
  await waitUntil(startAt, signal);
}
```

- [ ] **Step 6: Собрать и пройти проверку**

Run: `npm run build` → без ошибок (старые вызовы `acquirePageSlot()` без аргументов остаются валидными).
Run: `node $SCRATCH/check-limiter.mjs`
Expected: все строки `PASS`, итог `ALL PASSED`.

- [ ] **Step 7: Commit**

```bash
git add src/breaker.ts src/limiter.ts
git commit -m "Add breaker and rework limiter: lease, abort in queue, API request turn

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ресурс (`defineResource`)

**Files:**
- Create: `src/resource.ts`
- Check (scratchpad): `$SCRATCH/check-resource.mjs`

**Interfaces:**
- Consumes: `cached`, `clearCache`, `TTL` из `src/cache.ts` (без изменений).
- Produces:
  ```ts
  export interface LoadContext { signal: AbortSignal }
  export interface ResourceCallOptions { signal?: AbortSignal }
  export interface ResourceDef<A, Raw, R = Raw> {
    name: string;                       // "<домен>.<id>", напр. "elk.schedule-week"
    ttl: number;
    key: (args: A) => string;
    load: (args: A, ctx: LoadContext) => Promise<Raw>;
    project?: (raw: Raw, args: A) => R;
    deadlineMs?: number;                // по умолчанию 45_000
    invalidates?: string[];             // имена ресурсов, сбрасываемых после успешной загрузки
  }
  export function defineResource<A, Raw, R = Raw>(def: ResourceDef<A, Raw, R>):
    (args: A, opts?: ResourceCallOptions) => Promise<R>;
  export function invalidateResource(name: string): number;   // число удалённых записей
  export function listResources(): string[];
  ```

- [ ] **Step 1: Написать проверку `$SCRATCH/check-resource.mjs` (до реализации)**

```js
import { imp, check, done, sleep } from "./lib.mjs";

const { defineResource, invalidateResource, listResources } = await imp("resource.js");
const { clearCache, TTL } = await imp("cache.js");

// 1. срез после кэша: limit не входит в ключ
let loads = 0;
const list = defineResource({
  name: "t.list",
  ttl: TTL.medium,
  key: () => "all",
  load: async () => {
    loads++;
    return [1, 2, 3, 4, 5];
  },
  project: (raw, a) => raw.slice(0, a.limit),
});
const r10 = await list({ limit: 2 });
const r20 = await list({ limit: 4 });
check(loads === 1, "resource: два limit — одна загрузка");
check(r10.length === 2 && r20.length === 4, "resource: project режет по limit");

// 2. дедупликация параллельных вызовов
let slow = 0;
const dedup = defineResource({
  name: "t.dedup",
  ttl: TTL.short,
  key: (a) => String(a),
  load: async () => {
    slow++;
    await sleep(100);
    return { v: 1 };
  },
});
await Promise.all([dedup(1), dedup(1), dedup(1)]);
check(slow === 1, "resource: три параллельных вызова — одна загрузка");

// 3. ошибки не кэшируются
let tries = 0;
const flaky = defineResource({
  name: "t.flaky",
  ttl: TTL.short,
  key: () => "k",
  load: async () => {
    if (++tries === 1) throw new Error("boom");
    return "ok";
  },
});
await flaky().catch(() => {});
check((await flaky()) === "ok" && tries === 2, "resource: ошибка не кэшируется");

// 4. заморозка общего результата
const frozen = await list({ limit: 5 });
const raw = await defineResource({
  name: "t.frozen",
  ttl: TTL.short,
  key: () => "k",
  load: async () => ({ a: { b: [1] } }),
})();
let threw = false;
try {
  raw.a.b.push(2);
} catch {
  threw = true;
}
check(threw && Object.isFrozen(raw.a), "resource: результат в кэше заморожен глубоко (мутация даёт TypeError)");
void frozen;

// 5. очистка по домену и по имени
let dom = 0;
const domA = defineResource({ name: "t.dom-a", ttl: TTL.short, key: () => "k", load: async () => ++dom });
const domB = defineResource({ name: "u.dom-b", ttl: TTL.short, key: () => "k", load: async () => ++dom });
await domA();
await domB();
check(clearCache("t:") >= 1, "resource: clearCache по домену t: удаляет записи ресурсов домена");
const before = dom;
await domB();
check(dom === before, "resource: ресурс чужого домена остался в кэше");
await domA();
check(dom === before + 1, "resource: ресурс очищенного домена загрузился заново");
check(invalidateResource("u.dom-b") === 1, "resource: invalidateResource по имени удаляет запись");

// 6. очистка во время загрузки не воскрешает устаревшее
let gen = 0;
const racy = defineResource({
  name: "t.racy",
  ttl: TTL.medium,
  key: () => "k",
  load: async () => {
    const v = ++gen;
    await sleep(150);
    return v;
  },
});
const first = racy();
await sleep(30);
clearCache("t:");
check((await first) === 1, "resource: начатая до очистки загрузка возвращает свой результат");
check((await racy()) === 2, "resource: результат до-очисточной загрузки не записан в кэш");

// 7. дедлайн
let sawAbort = false;
const hang = defineResource({
  name: "t.hang",
  ttl: TTL.short,
  key: () => "k",
  deadlineMs: 120,
  load: (_a, ctx) =>
    new Promise(() => {
      ctx.signal.addEventListener("abort", () => (sawAbort = true));
    }),
});
const t0 = Date.now();
let msg = "";
await hang().catch((e) => (msg = e.message));
check(/не уложился/.test(msg) && Date.now() - t0 < 1000, `resource: дедлайн отклоняет за ${Date.now() - t0} мс`);
check(sawAbort, "resource: загрузчик получил abort по дедлайну");

// 8. отмена одним из ожидающих не убивает общую загрузку
let shared = 0;
const sharedRes = defineResource({
  name: "t.shared",
  ttl: TTL.short,
  key: () => "k",
  load: async () => {
    shared++;
    await sleep(150);
    return "done";
  },
});
const ctrl = new AbortController();
const p1 = sharedRes(undefined, { signal: ctrl.signal });
const p2 = sharedRes();
p1.catch(() => {});
ctrl.abort(new Error("отмена"));
let p1msg = "";
await p1.catch((e) => (p1msg = e.message));
check(p1msg === "отмена", "resource: отменивший вызов отклонён");
check((await p2) === "done" && shared === 1, "resource: второй ожидающий получил результат общей загрузки");

// 9. invalidates у «записывающего» ресурса
let reads = 0;
const readRes = defineResource({ name: "t.read", ttl: TTL.long, key: () => "k", load: async () => ++reads });
const writeRes = defineResource({
  name: "t.write",
  ttl: 0,
  key: () => "k",
  invalidates: ["t.read"],
  load: async () => "written",
});
await readRes();
await readRes();
check(reads === 1, "resource: чтение закэшировано");
await writeRes();
await readRes();
check(reads === 2, "resource: invalidates сбросил зависимый ресурс после успешной записи");

// 10. реестр и валидация имён
check(listResources().includes("t.list"), "resource: ресурс зарегистрирован в реестре");
let dupe = false;
try {
  defineResource({ name: "t.list", ttl: 1, key: () => "k", load: async () => 1 });
} catch {
  dupe = true;
}
check(dupe, "resource: повторное имя запрещено");
let badName = false;
try {
  defineResource({ name: "nodot", ttl: 1, key: () => "k", load: async () => 1 });
} catch {
  badName = true;
}
check(badName, "resource: имя без домена запрещено");

done();
```

- [ ] **Step 2: Запустить проверку — убедиться, что падает**

Run: `node $SCRATCH/check-resource.mjs`
Expected: ошибка импорта `dist/resource.js`.

- [ ] **Step 3: Создать `src/resource.ts`**

```ts
import { cached, clearCache } from "./cache.js";

/**
 * Декларативный кэшируемый ресурс: один владелец ключа, TTL, загрузчика, среза и дедлайна.
 *
 * - Имя `"<домен>.<id>"` задаёт домен кэша (`elk:`, `lms:`, `istudy:`): ключ записи —
 *   `<домен>:<id>:<ключ ресурса>`, поэтому `clearCache("<домен>:")` и `hse_clear_cache` работают.
 * - Результат загрузки замораживается (глубоко) до записи в кэш: он общий для всех вызывающих,
 *   мутация даёт TypeError. `project` возвращает новое значение для конкретного вызова.
 * - Загрузка ограничена `deadlineMs`; загрузчик получает `ctx.signal`, который срабатывает по
 *   дедлайну. Отмена `opts.signal` вызывающего только отсоединяет его от общей загрузки.
 */

export interface LoadContext {
  signal: AbortSignal;
}

export interface ResourceCallOptions {
  signal?: AbortSignal;
}

export interface ResourceDef<A, Raw, R = Raw> {
  name: string;
  ttl: number;
  key: (args: A) => string;
  load: (args: A, ctx: LoadContext) => Promise<Raw>;
  project?: (raw: Raw, args: A) => R;
  deadlineMs?: number;
  invalidates?: string[];
}

const DEFAULT_DEADLINE_MS = 45_000;

interface Registered {
  prefix: string;
}
const registry = new Map<string, Registered>();

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value as object)) deepFreeze(v);
  return value;
}

async function loadWithDeadline<A, Raw>(
  def: ResourceDef<A, Raw, unknown>,
  args: A,
  deadlineMs: number
): Promise<Raw> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${def.name} не уложился в ${deadlineMs / 1000} с`);
      ctrl.abort(err);
      reject(err);
    }, deadlineMs);
  });
  try {
    return await Promise.race([def.load(args, { signal: ctrl.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function detach<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("операция отменена"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("операция отменена"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

export function defineResource<A, Raw, R = Raw>(
  def: ResourceDef<A, Raw, R>
): (args: A, opts?: ResourceCallOptions) => Promise<R> {
  const dot = def.name.indexOf(".");
  if (dot <= 0 || dot === def.name.length - 1) {
    throw new Error(`defineResource: имя ресурса "${def.name}" должно иметь вид "<домен>.<id>"`);
  }
  if (registry.has(def.name)) throw new Error(`defineResource: ресурс "${def.name}" уже определён`);

  const domain = def.name.slice(0, dot);
  const id = def.name.slice(dot + 1);
  const prefix = `${domain}:${id}:`;
  registry.set(def.name, { prefix });
  const deadlineMs = def.deadlineMs ?? DEFAULT_DEADLINE_MS;

  return (args: A, opts: ResourceCallOptions = {}): Promise<R> => {
    const key = prefix + def.key(args);
    const shared = cached<Raw>(key, def.ttl, async () => {
      const raw = deepFreeze(await loadWithDeadline(def, args, deadlineMs));
      for (const name of def.invalidates ?? []) invalidateResource(name);
      return raw;
    });
    const projected = shared.then((raw) => (def.project ? def.project(raw, args) : (raw as unknown as R)));
    return detach(projected, opts.signal);
  };
}

/** Сбрасывает записи ресурса по имени; возвращает число удалённых готовых записей. */
export function invalidateResource(name: string): number {
  const entry = registry.get(name);
  if (!entry) throw new Error(`invalidateResource: неизвестный ресурс "${name}"`);
  return clearCache(entry.prefix);
}

export function listResources(): string[] {
  return [...registry.keys()];
}
```

- [ ] **Step 4: Собрать и пройти проверку**

Run: `npm run build` → без ошибок.
Run: `node $SCRATCH/check-resource.mjs`
Expected: все `PASS`, `ALL PASSED`.

Примечание: в `cached()` уже есть защита поколением (`generation`) — пункт 6 проверки опирается на неё; `cache.ts` не меняется.

- [ ] **Step 5: Commit**

```bash
git add src/resource.ts
git commit -m "Add declarative resource layer on top of the in-memory cache

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `withPage`, узкий замок входа, атомарная запись сессии

**Files:**
- Modify (полная замена): `src/auth/browser-session.ts`
- Check (scratchpad): `$SCRATCH/check-withpage.mjs`

**Interfaces:**
- Consumes: `acquirePageSlot`, `LEASE_GRACE_MS` из `src/limiter.ts` (Task 1).
- Produces:
  ```ts
  export interface WithPageOptions { deadlineMs?: number; signal?: AbortSignal }
  export interface PageCallContext { signal: AbortSignal }
  export const PAGE_DEADLINE_MS = 45_000;
  export function withPage<T>(url: string, fn: (page: Page, ctx: PageCallContext) => Promise<T>, opts?: WithPageOptions): Promise<T>;
  // остаются: getApiRequestContext(), closeBrowserSession(),
  // openAuthenticatedPage(url) — переходный экспорт, удаляется в Task 8
  ```

- [ ] **Step 1: Написать проверку `$SCRATCH/check-withpage.mjs` (живая; до реализации)**

```js
import { imp, check, done, loadEnv, sleep } from "./lib.mjs";
import fs from "node:fs";
import { createRequire } from "node:module";
import { WT } from "./lib.mjs";

loadEnv();
const { chromium } = createRequire(`${WT}/dist/x.js`)("playwright");
const live = { opened: 0, closed: 0 };
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const browser = await origLaunch(...a);
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...b) => {
    const ctx = await origNewContext(...b);
    ctx.on("page", (p) => {
      live.opened++;
      p.once("close", () => live.closed++);
    });
    return ctx;
  };
  return browser;
};

const session = await imp("auth/browser-session.js");
const { withPage } = session;
const profile = "https://lk.hse.ru/profile";
const prefs = "https://edu.hse.ru/user/preferences.php";

// 1. нормальное открытие и закрытие
const len = await withPage(profile, async (page) => (await page.title()).length);
check(len >= 0 && live.opened === 1 && live.closed === 1, "withPage: страница открыта и закрыта");

// 2. вложенный withPage — явная ошибка, а не зависание
let nested = "";
await withPage(profile, async () => {
  await withPage(prefs, async () => 1).catch((e) => (nested = e.message));
});
check(/вложенное/.test(nested), "withPage: вложенное открытие отклоняется");

// 3. зависшая fn освобождается по дедлайну; слоты не утекли
const t0 = Date.now();
let msg = "";
await withPage(profile, () => new Promise(() => {}), { deadlineMs: 1500 }).catch((e) => (msg = e.message));
check(/не уложилась/.test(msg) && Date.now() - t0 < 4000, `withPage: дедлайн сработал за ${Date.now() - t0} мс`);
check(live.opened === live.closed, "withPage: после дедлайна нет открытых страниц");

// 4. после трёх таких зависаний очередь не забита (раньше — дедлок)
await Promise.all(
  [1, 2, 3].map(() => withPage(profile, () => new Promise(() => {}), { deadlineMs: 800 }).catch(() => {}))
);
const t1 = Date.now();
await withPage(profile, async () => 1);
check(Date.now() - t1 < 5000, "withPage: после трёх зависших вызовов слоты свободны");
check(live.opened === live.closed, "withPage: страницы закрыты после зависших вызовов");

// 5. внешняя отмена
const ctrl = new AbortController();
const p = withPage(profile, () => new Promise(() => {}), { signal: ctrl.signal });
await sleep(1500);
ctrl.abort(new Error("внешняя отмена"));
let m2 = "";
await p.catch((e) => (m2 = e.message));
check(m2 === "внешняя отмена", "withPage: внешний сигнал отклоняет вызов");

// 6. параллельные открытия
const tp = Date.now();
await Promise.all([withPage(profile, async () => 1), withPage(prefs, async () => 1), withPage(profile, async () => 1)]);
console.log(`INFO  3 параллельных открытия: ${Date.now() - tp} мс`);

// 7. файл сессии цел и без временных файлов
const dir = `${WT}/storage`;
const files = fs.readdirSync(dir);
check(files.includes("hse-session.json") && !files.some((f) => f.endsWith(".tmp")), "storage: файл сессии есть, временных нет");
check(Array.isArray(JSON.parse(fs.readFileSync(`${dir}/hse-session.json`, "utf8")).cookies), "storage: файл сессии — валидный JSON");

await session.closeBrowserSession();
done();
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node $SCRATCH/check-withpage.mjs`
Expected: `withPage is not a function` (или аналогичная ошибка), проверка падает.

- [ ] **Step 3: Заменить `src/auth/browser-session.ts` целиком**

```ts
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { chromium, type APIRequestContext, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { waitForRenderedBody } from "../dom-utils.js";
import { acquirePageSlot, LEASE_GRACE_MS } from "../limiter.js";

// Считаем от расположения самого файла, а не process.cwd() — хосты вроде Claude
// Desktop запускают stdio-сервер с произвольным (иногда непишущим, напр.
// C:\WINDOWS\system32) cwd, и mkdir там падает с EPERM.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORAGE_DIR = path.join(projectRoot, "storage");
const STORAGE_STATE_PATH = path.join(STORAGE_DIR, "hse-session.json");
const KEYCLOAK_HOST = "saml.hse.ru";

/** Верхняя граница на всё в `withPage`: слот, открытие, вход и тело вызова. */
export const PAGE_DEADLINE_MS = 45_000;

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;
let closingPromise: Promise<void> | null = null;
// Сериализует только фактическое прохождение логина (не открытие и не ожидание рендера) —
// параллельные вызовы сразу после истечения сессии не должны одновременно запускать
// Keycloak-логин на двух страницах общего контекста и конкурировать за его cookies/OIDC state.
let loginLock: Promise<void> = Promise.resolve();
// Растёт при каждом реальном входе: вызов, ждавший замок, понимает, что вход уже выполнен другим.
let loginEpoch = 0;

async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      try {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
        if (!browserPromise) {
          browserPromise = chromium.launch({ headless: config.browserHeadless }).catch((err) => {
            browserPromise = null;
            throw err;
          });
        }
        const browser = await browserPromise;
        const storageState = fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;
        return await browser.newContext({ storageState });
      } catch (err) {
        // Без сброса rejected promise остаётся закэширован навсегда (if (!contextPromise) не
        // сработает для truthy rejected Promise) — все последующие вызовы падали бы с этой же
        // ошибкой до перезапуска процесса, даже после того как причина устранена.
        contextPromise = null;
        throw err;
      }
    })();
  }
  return contextPromise;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function labelOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return "страница";
  }
}

/**
 * Единый вход ВШЭ — Keycloak (realm "hse"). Форма подтверждена вручную 2026-09-15:
 * поле логина #username, поле пароля input[name=password], кнопка с текстом "Войти".
 * После входа Keycloak сам редиректит обратно на сервис (response_mode=form_post),
 * так что достаточно дождаться смены хоста.
 */
async function performKeycloakLogin(page: Page): Promise<void> {
  await page.locator("#username").fill(config.hseEmail);
  await page.locator('input[name="password"]').fill(config.hsePassword);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL((url) => url.hostname !== KEYCLOAK_HOST, { timeout: 20_000 });
}

async function waitForRender(page: Page): Promise<void> {
  // SPA-порталы ВШЭ (особенно ЕЛК/SmartPoint) рендерятся JS уже после события load —
  // без паузы проверки ниже регулярно срабатывают на пустой/недорисованной странице.
  const rendered = await waitForRenderedBody(page);
  if (!rendered) {
    console.error(`hsemcp: страница ${page.url()} не отрендерилась за таймаут при проверке логина`);
  }
}

/**
 * Сервисы ВШЭ редиректят на Keycloak автоматически только если в браузере уже есть его сессия —
 * иначе показывают свою страницу с явной ссылкой "Войти" и ждут клика. Формат ссылки отличается
 * по сервису (подтверждено вживую 2026-09-15): ЕЛК/lk.hse.ru ведёт прямо на
 * `openid-connect/auth`, а SmartLMS/edu.hse.ru — на собственный same-origin OIDC-мост
 * `/auth/oidckc/`, который уже сам редиректит на `saml.hse.ru/.../openid-connect/auth`. Эта
 * функция ищет ссылку любого из известных форматов на текущей странице.
 */
async function findKeycloakLoginHref(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href*="openid-connect/auth"], a[href*="/auth/oidckc/"]'
    );
    return link ? link.href : null;
  });
}

type LoginState = "already-authenticated" | "logged-in" | "unknown";

/**
 * Приводит текущую страницу к авторизованному состоянию: обрабатывает и автоматический
 * редирект на Keycloak, и вариант с ручной ссылкой "Войти". Не более 3 итераций — этого
 * достаточно на переход по ссылке "Войти" + сам логин на Keycloak.
 * Возвращает, произошёл ли реальный логин в этом вызове — от этого зависит, стоит ли
 * перезаписывать сохранённую storageState.
 */
async function ensureLoggedIn(page: Page): Promise<LoginState> {
  let loggedInNow = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForRender(page);

    if (hostnameOf(page.url()) === KEYCLOAK_HOST) {
      await performKeycloakLogin(page);
      loggedInNow = true;
      continue;
    }

    const loginHref = await findKeycloakLoginHref(page);
    if (loginHref) {
      await page.goto(loginHref, { waitUntil: "load" });
      continue;
    }

    return loggedInNow ? "logged-in" : "already-authenticated"; // ни редиректа, ни ссылки "Войти"
  }
  // 3 попытки не дали ни логина, ни явного "уже авторизован" (например, неожиданная
  // промежуточная страница) — не рискуем перезаписывать ранее рабочую сессию на диске.
  console.error(
    `hsemcp: не удалось однозначно определить статус входа на ${page.url()} за 3 попытки — сохранённая сессия не будет перезаписана`
  );
  return "unknown";
}

function withLoginLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = loginLock.then(fn, fn);
  loginLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Нужен ли вход: страница на Keycloak либо показывает ссылку «Войти». Работает без замка. */
async function needsLogin(page: Page): Promise<boolean> {
  await waitForRender(page);
  if (hostnameOf(page.url()) === KEYCLOAK_HOST) return true;
  return (await findKeycloakLoginHref(page)) !== null;
}

/**
 * Сохраняет сессию на диск атомарно: во временный файл и rename — оборванная запись не
 * портит рабочий `hse-session.json`.
 */
async function saveStorageState(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  const tmp = `${STORAGE_STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STORAGE_STATE_PATH);
}

/**
 * Определение «нужен ли вход» идёт вне замка (параллельно). Замок берётся только на сам вход и
 * после повторной проверки: если другой вызов уже вошёл, пока мы ждали, страница перезагружается
 * с обновлёнными cookies.
 */
async function ensureAuthenticated(page: Page, context: BrowserContext, targetUrl: string): Promise<void> {
  const epochAtDetect = loginEpoch;
  if (!(await needsLogin(page))) return;
  await withLoginLock(async () => {
    if (loginEpoch !== epochAtDetect) {
      await page.goto(targetUrl, { waitUntil: "load" });
    }
    const state = await ensureLoggedIn(page);
    if (state === "logged-in") {
      loginEpoch++;
      await saveStorageState(context);
    }
  });
}

export interface WithPageOptions {
  /** Верхняя граница на слот, открытие, вход и `fn`. По умолчанию PAGE_DEADLINE_MS. */
  deadlineMs?: number;
  /** Внешняя отмена (например, от ресурса). */
  signal?: AbortSignal;
}

export interface PageCallContext {
  signal: AbortSignal;
}

const pageScope = new AsyncLocalStorage<true>();

/**
 * Открывает `url` в общем браузерном контексте, проходит единый SSO ВШЭ при необходимости,
 * вызывает `fn` и **в `finally` закрывает страницу и освобождает слот лимитера**. Вызывающий код
 * `page.close()` не пишет. По истечении `deadlineMs` (или по `signal`) страница закрывается, слот
 * освобождается, вызов отклоняется. Вложенный `withPage` запрещён — он удерживал бы второй слот
 * и мог зависнуть на лимите.
 */
export async function withPage<T>(
  url: string,
  fn: (page: Page, ctx: PageCallContext) => Promise<T>,
  opts: WithPageOptions = {}
): Promise<T> {
  if (pageScope.getStore()) {
    throw new Error(
      "withPage: вложенное открытие страницы внутри withPage недопустимо (слот лимитера удерживается до конца внешнего вызова)"
    );
  }
  const deadlineMs = opts.deadlineMs ?? PAGE_DEADLINE_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`${labelOf(url)} не уложилась в ${deadlineMs / 1000} с`)),
    deadlineMs
  );
  const onExternalAbort = () => ctrl.abort(opts.signal?.reason ?? new Error("операция отменена"));
  if (opts.signal?.aborted) onExternalAbort();
  else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let page: Page | undefined;
  let release: (() => void) | undefined;

  const aborted = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener(
      "abort",
      () => {
        page?.close().catch(() => {});
        reject(ctrl.signal.reason);
      },
      { once: true }
    );
    if (ctrl.signal.aborted) reject(ctrl.signal.reason);
  });
  aborted.catch(() => {});

  const work = pageScope.run(true, async () => {
    const rel = await acquirePageSlot({ signal: ctrl.signal, leaseMs: deadlineMs + LEASE_GRACE_MS });
    release = rel;
    if (ctrl.signal.aborted) {
      rel();
      ctrl.signal.throwIfAborted();
    }
    const context = await getContext();
    const p = await context.newPage();
    page = p;
    if (ctrl.signal.aborted) {
      await p.close().catch(() => {});
      ctrl.signal.throwIfAborted();
    }
    await p.goto(url, { waitUntil: "load" });
    await ensureAuthenticated(p, context, url);
    ctrl.signal.throwIfAborted();
    return fn(p, { signal: ctrl.signal });
  });
  // Если победила отмена, поздний отказ `work` не должен стать unhandled rejection.
  work.catch(() => {});

  try {
    return await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    await page?.close().catch(() => {});
    release?.();
  }
}

/**
 * @deprecated Переходный экспорт на время миграции клиентов на `withPage`; удаляется в конце
 * миграции. Слот держится до закрытия страницы, закрывать её должен вызывающий.
 */
export async function openAuthenticatedPage(targetUrl: string): Promise<Page> {
  const release = await acquirePageSlot();
  let page: Page | undefined;
  try {
    const context = await getContext();
    page = await context.newPage();
    page.once("close", release);
    await page.goto(targetUrl, { waitUntil: "load" });
    await ensureAuthenticated(page, context, targetUrl);
    return page;
  } catch (err) {
    // Без этого страница осталась бы висеть открытой в общем контексте навсегда при любой
    // ошибке навигации/логина — утечка ресурсов Playwright при повторяющихся сбоях.
    await page?.close().catch(() => {});
    release();
    throw err;
  }
}

/**
 * HTTP-клиент поверх общей браузерной сессии: делит cookies контекста, но не открывает страницу
 * (и потому не занимает слот лимитера). Для JSON-API, которым достаточно cookies + Bearer-токена.
 */
export async function getApiRequestContext(): Promise<APIRequestContext> {
  return (await getContext()).request;
}

export async function closeBrowserSession(): Promise<void> {
  if (closingPromise) return closingPromise;
  closingPromise = (async () => {
    if (contextPromise) {
      const context = await contextPromise.catch(() => null);
      contextPromise = null;
      if (context) await context.close().catch(() => {});
    }
    if (browserPromise) {
      const browser = await browserPromise.catch(() => null);
      browserPromise = null;
      if (browser) await browser.close().catch(() => {});
    }
  })();
  return closingPromise;
}
```

- [ ] **Step 4: Собрать и пройти проверку**

Run: `npm run build` → без ошибок.
Run: `node $SCRATCH/check-withpage.mjs`
Expected: все `PASS`, `ALL PASSED`; строка `INFO` с временем трёх параллельных открытий (для сравнения с замером разведки F7: 1,34 с против 1,81 с).

- [ ] **Step 5: Проверить узкий замок: «просроченная сессия → N параллельных открытий → один логин»**

Написать `$SCRATCH/check-login-once.mjs`: удалить сохранённую сессию в `$WT/storage/hse-session.json` нельзя (это файл рабочей сессии) — вместо этого запустить в **чистом процессе** с переменной окружения `WT`, указывающей на копию `dist/`? Проще и безопаснее: временно переименовать файл сессии и вернуть после проверки.

```js
import fs from "node:fs";
import { imp, check, done, loadEnv, WT } from "./lib.mjs";
import { createRequire } from "node:module";

loadEnv();
const state = `${WT}/storage/hse-session.json`;
const backup = `${state}.bak`;
fs.renameSync(state, backup); // процесс стартует без сессии — как «протухшая»
try {
  const { chromium } = createRequire(`${WT}/dist/x.js`)("playwright");
  let logins = 0;
  const origLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (...a) => {
    const browser = await origLaunch(...a);
    const origNewContext = browser.newContext.bind(browser);
    browser.newContext = async (...b) => {
      const ctx = await origNewContext(...b);
      ctx.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).host === "saml.hse.ru") logins++;
      });
      return ctx;
    };
    return browser;
  };
  const { withPage, closeBrowserSession } = await imp("auth/browser-session.js");
  const urls = ["https://lk.hse.ru/profile", "https://edu.hse.ru/user/preferences.php", "https://lk.hse.ru/claim"];
  const t0 = Date.now();
  await Promise.all(urls.map((u) => withPage(u, async (p) => p.url().length)));
  console.log(`INFO  параллельное открытие с нуля: ${Date.now() - t0} мс, POST на saml.hse.ru: ${logins}`);
  check(logins === 1, "login: N параллельных открытий без сессии дали ровно один POST логина");
  check(fs.existsSync(state), "login: сессия сохранена после входа");
  await closeBrowserSession();
} finally {
  if (!fs.existsSync(state)) fs.renameSync(backup, state);
  else fs.rmSync(backup, { force: true });
}
done();
```

Run: `node $SCRATCH/check-login-once.mjs`
Expected: `PASS login: ... ровно один POST логина`. Если `FAIL` (логинов больше одного) — не продолжать: вернуть прежнюю область замка (`withLoginLock` вокруг всего `ensureLoggedIn` на каждой странице) и сообщить пользователю.

- [ ] **Step 6: Commit**

```bash
git add src/auth/browser-session.ts
git commit -m "Add withPage with deadline and slot lease, narrow the login lock, write session atomically

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ЕЛК — прямой путь, политика отказов, API-ресурсы

**Files:**
- Modify: `src/services/elk/client.ts` (верх файла до `ElkLesson` и функции API; страничные функции — в Task 5)
- Check (scratchpad): `$SCRATCH/check-elk.mjs`

**Interfaces:**
- Consumes: `withPage`, `getApiRequestContext` (Task 3); `createBreaker` (Task 1); `acquireRequestTurn` (Task 1); `defineResource`, `LoadContext` (Task 2).
- Produces: те же публичные функции с теми же сигнатурами: `getSchedule`, `getUserInfo`, `getAcademicData`, `searchServices`, `listRequests`, `listTasks`, `listDpoPrograms`, `getLoginHistory`, `getNotifications`, `getAntiplagiatStatus`.

- [ ] **Step 1: Написать проверку `$SCRATCH/check-elk.mjs` (живая, с подменой `api.get`; до реализации)**

```js
import { imp, check, done, loadEnv, WT } from "./lib.mjs";
import { createRequire } from "node:module";

loadEnv();
const mode = process.argv[2] ?? "normal";
const { chromium } = createRequire(`${WT}/dist/x.js`)("playwright");
const pages = { opened: 0 };
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const browser = await origLaunch(...a);
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...b) => {
    const ctx = await origNewContext(...b);
    ctx.on("page", () => pages.opened++);
    return ctx;
  };
  return browser;
};

const session = await imp("auth/browser-session.js");
const elk = await imp("services/elk/client.js");
const { clearCache } = await imp("cache.js");

const api = await session.getApiRequestContext();
const origGet = api.get.bind(api);
const calls = []; // { path, query, status }
let inject = []; // очередь подмен: статусы или "html"
api.get = async (url, opts) => {
  const u = new URL(url);
  const next = inject.shift();
  if (next !== undefined) {
    calls.push({ path: u.pathname, query: u.search, status: `inj:${next}` });
    if (next === "html") return { ok: () => true, status: () => 200, json: async () => { throw new Error("not json"); } };
    return { ok: () => false, status: () => next, json: async () => ({}) };
  }
  const res = await origGet(url, opts);
  calls.push({ path: u.pathname, query: u.search, status: res.status() });
  return res;
};
const count = (p) => calls.filter((c) => c.path === p).length;
const reset = () => { calls.length = 0; clearCache(""); };

// прогрев токена и сессии
await elk.getUserInfo();

if (mode === "normal") {
  reset();
  const p0 = pages.opened;
  await elk.getAcademicData();
  await elk.getAcademicData();
  check(count("/api/get-academic-data") === 1 && pages.opened === p0, "elk: прямой путь, повтор из кэша, без страниц");

  // уведомления: разные limit — один запрос с максимальным limit
  reset();
  const n5 = await elk.getNotifications(5);
  const n20 = await elk.getNotifications(20);
  check(count("/api/notifications") === 1, "elk: notifications(5) и (20) — один запрос");
  check(calls[0].query.includes("limit=100"), "elk: запрос уведомлений идёт с максимальным limit=100");
  check(n5.notifications.length <= 5 && n20.notifications.length <= 20, "elk: срез по limit");
  check(n5.count === n20.count, "elk: count — общий, не зависит от среза");

  // расписание: недельные блоки
  reset();
  const day = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const m = mondayOf(new Date());
  const sunday = day(m, 6);
  const nextMonday = day(m, 7);
  const a = await elk.getSchedule(sunday, nextMonday); // через границу недели → 2 блока
  check(count("/api/get-myschedule") === 2, `elk: диапазон через границу недели — 2 запроса (было ${count("/api/get-myschedule")})`);
  const b = await elk.getSchedule(m, sunday); // первая неделя уже в кэше
  check(count("/api/get-myschedule") === 2, "elk: вторая неделя-то же окно берётся из кэша блоков");
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  check(a.every((x) => x.date >= fmt(sunday) && x.date <= fmt(nextMonday)), "elk: дни вне [from, to] отрезаны");
  check(b.every((x) => x.date >= fmt(m) && x.date <= fmt(sunday)), "elk: дни вне [from, to] отрезаны (вторая выборка)");
  check((await elk.getSchedule(day(m, 3), day(m, 1))).length === 0, "elk: from > to — пустой результат без запросов");
  let capped = "";
  await elk.getSchedule(m, day(m, 7 * 60)).catch((e) => (capped = e.message));
  check(/недель/.test(capped), "elk: диапазон больше 53 недель отклоняется явной ошибкой");
}

if (mode === "401") {
  reset();
  const p0 = pages.opened;
  inject = [401];
  await elk.getAcademicData();
  check(calls.length === 2 && calls[0].status === "inj:401" && calls[1].status === 200, "elk: 401 → один повтор со свежим токеном");
  check(pages.opened - p0 === 1, `elk: на 401 открыта 1 страница (токен), было ${pages.opened - p0}`);
  // выключатель не сработал: следующий вызов снова прямой
  reset();
  const p1 = pages.opened;
  await elk.getAcademicData();
  check(pages.opened === p1 && calls.length === 1, "elk: после 401-повтора прямой путь по-прежнему работает");
}

if (mode === "403") {
  reset();
  const p0 = pages.opened;
  inject = [403, 403];
  await elk.getAcademicData();
  check(pages.opened - p0 === 1, `elk: 403×2 → ровно 1 страница (через страницу), было ${pages.opened - p0}`);
  // выключатель сработал: следующие вызовы идут через страницу, без прямых запросов
  reset();
  const p1 = pages.opened;
  await elk.getUserInfo();
  check(calls.length === 0 && pages.opened - p1 === 1, "elk: при сработавшем выключателе — через страницу, без прямых запросов");
}

if (mode === "500") {
  reset();
  const p0 = pages.opened;
  inject = [500];
  let msg = "";
  await elk.getAcademicData().catch((e) => (msg = e.message));
  check(/500/.test(msg) && pages.opened === p0, "elk: 5xx → ошибка как есть, страница не открывалась");
  reset();
  await elk.getAcademicData();
  check(calls.length === 1, "elk: после 5xx прямой путь не отключён");
}

if (mode === "html") {
  reset();
  const p0 = pages.opened;
  inject = ["html"];
  await elk.getAcademicData();
  check(pages.opened - p0 === 1, `elk: не-JSON → сброс токена и повтор (1 страница на токен), было ${pages.opened - p0}`);
}

await session.closeBrowserSession();
done();
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `node $SCRATCH/check-elk.mjs normal`
Expected: `FAIL` на запросах уведомлений (`limit=100` отсутствует) и на недельных блоках (старый код делает один запрос на диапазон).

- [ ] **Step 3: Заменить импорты и блок токена/прямого пути в `src/services/elk/client.ts`**

Заменить первые 7 строк (импорты) на:

```ts
import { getApiRequestContext, withPage } from "../../auth/browser-session.js";
import { createBreaker } from "../../breaker.js";
import { TTL } from "../../cache.js";
import { config } from "../../config.js";
import { dumpPage, extractTable, type PageDump } from "../../dom-utils.js";
import { addDays, formatLocalDate } from "../../date-utils.js";
import { acquireRequestTurn } from "../../limiter.js";
import { defineResource, type LoadContext } from "../../resource.js";
import { resolveScopedUrl } from "../../url-utils.js";
```

Блок от комментария `// Токен берём один раз через страницу /profile …` до конца функции `fetchElkApi` (включая `ELK_API_TTL`) заменить на:

```ts
// Токен берём один раз через страницу /profile и дальше ходим в API напрямую (без страницы) до
// истечения. Срок — из `exp` JWT; если токен не JWT или `exp` нет, живёт консервативные 60 с.
const TOKEN_SKEW_MS = 30_000;
const TOKEN_FALLBACK_TTL_MS = 60_000;
const API_TIMEOUT_MS = 20_000;
// Если прямой путь отказал дважды, а запрос через страницу прошёл — значит, API ЕЛК чем-то не
// устраивает запрос вне браузерной страницы. Тогда идём через страницу, а через 10 минут
// пробуем прямой путь снова (одна проба; удача возвращает прямой путь, неудача продлевает).
const DIRECT_COOLDOWN_MS = 10 * 60_000;
const directBreaker = createBreaker(DIRECT_COOLDOWN_MS);

interface TokenEntry {
  token: string;
  expiresAt: number;
}

let tokenEntry: TokenEntry | null = null;
let tokenPromise: Promise<string> | null = null;

/** Время истечения JWT в мс (из `exp`) либо null, если токен не JWT или без `exp`. */
export function tokenExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof json.exp === "number" && Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function acquireToken(): Promise<string> {
  return withPage(`${BASE_URL}/profile`, async (page) => {
    await page.waitForFunction(() => !!localStorage.getItem("access_token"), undefined, {
      timeout: 10_000,
    });
    let token = await page.evaluate(() => localStorage.getItem("access_token"));
    // storageState на диске восстанавливает localStorage, так что сразу после перезапуска там
    // может лежать уже просроченный токен — даём SPA несколько секунд заменить его свежим.
    const expiry = token ? tokenExpiryMs(token) : null;
    if (token && expiry !== null && expiry - TOKEN_SKEW_MS <= Date.now()) {
      await page
        .waitForFunction((old) => localStorage.getItem("access_token") !== old, token, { timeout: 5_000 })
        .catch(() => {});
      token = await page.evaluate(() => localStorage.getItem("access_token"));
    }
    if (!token) throw new Error("ЕЛК не выдал access_token — возможно, сессия слетела");
    tokenEntry = { token, expiresAt: tokenExpiryMs(token) ?? Date.now() + TOKEN_FALLBACK_TTL_MS };
    return token;
  });
}

function getElkToken(): Promise<string> {
  if (tokenEntry && tokenEntry.expiresAt - TOKEN_SKEW_MS > Date.now()) {
    return Promise.resolve(tokenEntry.token);
  }
  // Параллельные вызовы делят одно получение токена, а не открывают по странице на каждый.
  if (!tokenPromise) {
    const promise: Promise<string> = acquireToken().finally(() => {
      if (tokenPromise === promise) tokenPromise = null;
    });
    tokenPromise = promise;
  }
  return tokenPromise;
}

function invalidateToken(usedToken: string): void {
  // Не сбрасываем токен, который уже успели обновить параллельным вызовом.
  if (tokenEntry?.token === usedToken) tokenEntry = null;
}

type DirectResult<T> = { ok: true; body: T } | { ok: false; status: number; error?: string };

async function requestDirect<T>(apiPath: string, token: string, signal: AbortSignal): Promise<DirectResult<T>> {
  await acquireRequestTurn(signal);
  const api = await getApiRequestContext();
  const res = await api.get(`${BASE_URL}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: API_TIMEOUT_MS,
  });
  if (!res.ok()) return { ok: false, status: res.status() };
  try {
    return { ok: true, body: (await res.json()) as T };
  } catch {
    // 200 не-JSON — обычно редирект на страницу входа вместо 401.
    return { ok: false, status: res.status(), error: "ответ не JSON" };
  }
}

/** Запасной путь: открыть /profile и сделать fetch внутри страницы. */
function fetchElkApiViaPage<T>(apiPath: string, signal: AbortSignal): Promise<T> {
  return withPage(
    `${BASE_URL}/profile`,
    async (page) => {
      await page.waitForFunction(() => !!localStorage.getItem("access_token"), undefined, {
        timeout: 10_000,
      });
      return page.evaluate(async (path) => {
        const token = localStorage.getItem("access_token");
        const res = await fetch(path, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          throw new Error(`lk.hse.ru API ${path} вернул ${res.status}`);
        }
        return res.json();
      }, apiPath) as Promise<T>;
    },
    { signal }
  );
}

const describeFailure = (r: { status: number; error?: string }): string =>
  `${r.status}${r.error ? ` (${r.error})` : ""}`;

/**
 * Политика отказов прямого пути:
 * - 401 и не-JSON (редирект на вход): токен сбрасывается, одна повторная попытка со свежим;
 * - 403: это права, а не токен — токен не сбрасывается, повтор с тем же;
 * - 5xx и прочее: ошибка как есть, без отката на страницу и без срабатывания выключателя;
 * - два отказа подряд: один заход через страницу; прошёл — выключатель срабатывает на 10 минут,
 *   не прошёл — ошибка пользователю, выключатель не трогаем (это реальный отказ, не особенность
 *   вне-браузерного запроса).
 */
async function fetchElkApiUncached<T>(apiPath: string, signal: AbortSignal): Promise<T> {
  if (!directBreaker.allow()) return fetchElkApiViaPage<T>(apiPath, signal);

  let lastFailure = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getElkToken();
    const result = await requestDirect<T>(apiPath, token, signal);
    if (result.ok) {
      directBreaker.reset();
      return result.body;
    }
    lastFailure = describeFailure(result);
    const authFailure = result.status === 401 || result.status === 403 || result.error !== undefined;
    if (!authFailure) throw new Error(`lk.hse.ru API ${apiPath} вернул ${result.status}`);
    if (result.status !== 403) invalidateToken(token);
  }

  const data = await fetchElkApiViaPage<T>(apiPath, signal).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} (прямой запрос тоже не прошёл: ${lastFailure})`);
  });
  directBreaker.trip();
  console.error(
    `hsemcp: прямые запросы к lk.hse.ru/api не работают (${lastFailure}) — иду через страницу ${DIRECT_COOLDOWN_MS / 60_000} мин`
  );
  return data;
}

const elkJson = <T>(apiPath: string, ctx: LoadContext): Promise<T> => fetchElkApiUncached<T>(apiPath, ctx.signal);
```

- [ ] **Step 4: Заменить API-функции ресурсами**

Интерфейсы (`ElkLesson`, `ElkScheduleDay`, `ElkUserInfo`, `ElkAcademicData`, `ElkServiceResult`, `ElkSearchServicesResponse`, `RawSearchAllResponse`, `ElkClaim`, `RawClaim`, `cleanClaimUrl`, `RawDpoApplicationsResponse`, `ElkLoginRecord`, `RawLoginRecord`, `ElkNotification`, `RawNotification`, `ElkAntiplagiatStatus`) **оставить как есть**. Заменить только перечисленные функции. Каждый блок ниже **включает JSDoc функции**: старый JSDoc заменяется вместе с телом, дублей быть не должно. Ресурс определяется после типов, которые он использует.

`getSchedule` (вместо прежней функции):

```ts
/** Понедельник (локальная дата, 00:00) недели, в которую попадает `d`. */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

const MAX_SCHEDULE_WEEKS = 53;

// Расписание грузится и кэшируется по неделям (пн–вс): разные диапазоны (сегодня/неделя/две недели)
// делят блоки, а не бьют по разным ключам.
const elkScheduleWeek = defineResource<Date, ElkScheduleDay[]>({
  name: "elk.schedule-week",
  ttl: TTL.medium,
  key: (monday) => formatLocalDate(monday, "-"),
  load: (monday, ctx) =>
    elkJson<ElkScheduleDay[]>(
      `/api/get-myschedule?begin_date=${formatLocalDate(monday, "-")}&end_date=${formatLocalDate(addDays(monday, 6), "-")}`,
      ctx
    ),
});

/** Расписание студента через ЕЛК — работает из любой сети (в отличие от ruz_*). */
export async function getSchedule(from: Date, to: Date): Promise<ElkScheduleDay[]> {
  const fromKey = formatLocalDate(from, "-");
  const toKey = formatLocalDate(to, "-");
  if (fromKey > toKey) return [];

  const weeks: Date[] = [];
  for (let m = mondayOf(from); formatLocalDate(m, "-") <= toKey; m = addDays(m, 7)) weeks.push(m);
  if (weeks.length > MAX_SCHEDULE_WEEKS) {
    throw new Error(`Диапазон расписания (${weeks.length} недель) больше ${MAX_SCHEDULE_WEEKS} недель — сузьте период`);
  }
  const chunks = await Promise.all(weeks.map((m) => elkScheduleWeek(m)));
  return chunks.flat().filter((day) => day.date >= fromKey && day.date <= toKey);
}
```

`getUserInfo` и `getAcademicData`:

```ts
const elkUser = defineResource<void, ElkUserInfo>({
  name: "elk.user",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => elkJson<ElkUserInfo>("/api/get-user", ctx),
});

/** Базовая identity-информация из ЕЛК (структурированный JSON, без академической карточки). */
export function getUserInfo(): Promise<ElkUserInfo> {
  return elkUser();
}

const elkAcademic = defineResource<void, ElkAcademicData[]>({
  name: "elk.academic",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => elkJson<ElkAcademicData[]>("/api/get-academic-data", ctx),
});

/**
 * Академическая карточка студента (структурированный JSON): рейтинг, GPA, программа, факультет,
 * курс, группа. lk.hse.ru/api/get-academic-data — реверс-инжинирен 2026-09-15, тот же
 * Bearer-токен, что и остальные elk_get_*. Отдаёт массив с одной записью на пользователя.
 */
export function getAcademicData(): Promise<ElkAcademicData[]> {
  return elkAcademic();
}
```

`searchServices`:

```ts
const SEARCH_FETCH_LIMIT = 50; // максимум тула elk_search_services

const elkSearch = defineResource<{ query: string; limit: number }, RawSearchAllResponse, ElkSearchServicesResponse>({
  name: "elk.search",
  ttl: TTL.medium,
  key: (a) => a.query,
  load: (a, ctx) =>
    elkJson<RawSearchAllResponse>(
      `/api/search/search-all?query=${encodeURIComponent(a.query)}&offset=0&limit=${SEARCH_FETCH_LIMIT}&category=services`,
      ctx
    ),
  project: (raw, a) => ({
    total_hits: raw.total_hits,
    categories: raw.categories,
    results: raw.data.slice(0, a.limit).map((item) => ({
      id: item.data.id,
      name: item.data.name,
      desc: item.data.desc,
      url: item.data.url,
      score: item.score,
    })),
  }),
});

/**
 * Полнотекстовый поиск по каталогу сервисов ЕЛК (lk.hse.ru/api/search/search-all) — разведано
 * вживую 2026-09-15 через шапку SmartPoint: строка поиска ищет по 254 сервисам сразу, а также
 * (отдельными категориями с тем же эндпоинтом) по сотрудникам/студентам/подразделениям.
 * `categories` в ответе — счётчики по всем категориям для запроса, даже когда `category=services`
 * сужает `data` до одной из них.
 */
export function searchServices(query: string, limit = 10): Promise<ElkSearchServicesResponse> {
  return elkSearch({ query, limit });
}
```

`listRequests` и `listTasks`:

```ts
const CLAIMS_FETCH_LIMIT = 500; // максимум тулов elk_list_requests / elk_list_tasks

const elkClaims = defineResource<number, { data: RawClaim[]; count: number }, { count: number; requests: ElkClaim[] }>({
  name: "elk.claims",
  ttl: TTL.short,
  key: () => "all",
  load: (_limit, ctx) =>
    elkJson<{ data: RawClaim[]; count: number }>(
      `/api/claims?username=${encodeURIComponent(config.hseEmail)}&limit=${CLAIMS_FETCH_LIMIT}&sort_by=created&order_by=desc`,
      ctx
    ),
  project: (raw, limit) => ({
    count: raw.count,
    requests: raw.data.slice(0, limit).map((c) => ({
      num: c.num,
      text: c.text,
      service: c.service,
      executorFio: c.executor_fio,
      createdByEmail: c.created_by_email,
      createdByFio: c.created_by_fio,
      stateName: c.state_name.trim(),
      active: c.active === "1",
      created: c.created,
      updated: c.updated,
      url: cleanClaimUrl(c.url),
    })),
  }),
});

/**
 * История заявок пользователя (lk.hse.ru/claim) — разведано вживую 2026-09-15. В отличие от
 * большинства elk_* эндпоинтов требует username (email) явным query-параметром, а не берёт его
 * из токена.
 */
export function listRequests(limit = 500): Promise<{ count: number; requests: ElkClaim[] }> {
  return elkClaims(limit);
}

const elkTasks = defineResource<number, { count: number; data: unknown[] }>({
  name: "elk.tasks",
  ttl: TTL.short,
  key: () => "all",
  load: (_limit, ctx) =>
    elkJson<{ count: number; data: unknown[] }>(
      `/api/tasks?username=${encodeURIComponent(config.hseEmail)}&limit=${CLAIMS_FETCH_LIMIT}&sort_by=created&order_by=desc`,
      ctx
    ),
  project: (raw, limit) => ({ count: raw.count, data: raw.data.slice(0, limit) }),
});

/**
 * Задачи пользователя (lk.hse.ru/task) — тот же API-паттерн, что и /api/claims (username, limit,
 * sort_by, order_by), реверс-инжинирен 2026-09-15. Поля отдельной задачи не типизированы: на
 * аккаунте, где это проверялось, задач не было (`count: 0`), поэтому форма ответа возвращается
 * как есть, без предположений о конкретных именах полей.
 */
export function listTasks(limit = 500): Promise<{ count: number; data: unknown[] }> {
  return elkTasks(limit);
}
```

`listDpoPrograms`:

```ts
const elkDpo = defineResource<void, RawDpoApplicationsResponse, { docs: unknown[]; statusLabels: Record<string, string> }>({
  name: "elk.dpo",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => elkJson<RawDpoApplicationsResponse>("/dpo/rest/application", ctx),
  project: (raw) => ({
    docs: raw.data.docs,
    statusLabels: Object.fromEntries(raw.data.filters.status.map((s) => [s.value, s.label])),
  }),
});

/**
 * Мои программы ДПО (lk.hse.ru/dpo/my-programs → GET /dpo/rest/application) — реверс-инжинирено
 * 2026-09-15. Модуль «Моё ДПО» релевантен только студентам, проходящим доп. проф. образование
 * помимо основной программы; на проверенном аккаунте программ нет (`docs: []`), поэтому форма
 * отдельной записи не подтверждена вживую — возвращается как есть, без типизации полей.
 * `statusLabels` — расшифровка возможных статусов (processing/payment/waiting/studies/...).
 */
export function listDpoPrograms(): Promise<{ docs: unknown[]; statusLabels: Record<string, string> }> {
  return elkDpo();
}
```

`getLoginHistory`:

```ts
const elkLoginHistory = defineResource<
  number,
  { count: number; actions: RawLoginRecord[] },
  { count: number; actions: ElkLoginRecord[] }
>({
  name: "elk.login-history",
  ttl: TTL.short,
  key: (offset) => String(offset),
  load: (offset, ctx) =>
    elkJson<{ count: number; actions: RawLoginRecord[] }>(`/api/get-action-history-records?offset=${offset}`, ctx),
  project: (raw) => ({
    count: raw.count,
    actions: raw.actions.map((a) => ({
      date: a.date,
      action: a.action,
      ip: a.ip,
      place: a.place,
      device: a.deviceData.device,
      deviceType: a.deviceData.type,
    })),
  }),
});

/**
 * История действий/входов в ЕЛК (вкладка "Прочее" → "История действий" на /profile, обычно не
 * захватывается elk_get_profile — Vue-таб рендерит контент только по клику, а не сразу в DOM).
 * Полезно для проверки безопасности аккаунта (неожиданные IP/устройства). Реверс-инжинирено
 * 2026-09-15: `GET /api/get-action-history-records?offset=0`, тот же Bearer-токен.
 */
export function getLoginHistory(offset = 0): Promise<{ count: number; actions: ElkLoginRecord[] }> {
  return elkLoginHistory(offset);
}
```

`getNotifications`:

```ts
const NOTIFICATIONS_FETCH_LIMIT = 100; // максимум тула elk_get_notifications

const elkNotifications = defineResource<
  number,
  { data: RawNotification[]; count: number },
  { count: number; notifications: ElkNotification[] }
>({
  name: "elk.notifications",
  ttl: TTL.short,
  key: () => "all",
  load: (_limit, ctx) =>
    elkJson<{ data: RawNotification[]; count: number }>(
      `/api/notifications?is_no_read=false&offset=0&limit=${NOTIFICATIONS_FETCH_LIMIT}`,
      ctx
    ),
  project: (raw, limit) => ({
    count: raw.count,
    notifications: raw.data.slice(0, limit).map((n) => ({
      id: n.id,
      title: n.title,
      text: stripHtmlElk(n.text),
      isImportant: n.is_important,
      isRead: n.is_read,
      date: n.date,
    })),
  }),
});

/**
 * Уведомления ЕЛК (`/notification`, колокольчик в шапке) — реверс-инжинирено 2026-09-15:
 * `GET /api/notifications?is_no_read=false&offset=0&limit=<n>`, тот же Bearer-токен.
 * `is_no_read=false` — включая уже прочитанные (иначе список часто пуст).
 */
export function getNotifications(limit = 20): Promise<{ count: number; notifications: ElkNotification[] }> {
  return elkNotifications(limit);
}
```

`getAntiplagiatStatus`:

```ts
const elkAntiplagiat = defineResource<void, ElkAntiplagiatStatus>({
  name: "elk.antiplagiat",
  ttl: TTL.short,
  key: () => "me",
  load: (_a, ctx) =>
    elkJson<ElkAntiplagiatStatus>(
      `/antiplagiat/api/antiplagiat/attempts?email=${encodeURIComponent(config.hseEmail)}`,
      ctx
    ),
});

/**
 * Статус проверок в системе Антиплагиат (lk.hse.ru/flow/antiplagiat/...) — реверс-инжинирен
 * 2026-09-15: страница подачи заявки на проверку сама дёргает этот эндпоинт для отображения
 * счётчика "Использовано проверок: N из <лимит>" (сам лимит квоты в ответе не встречается,
 * похоже, задан на фронтенде/CMS отдельно). Только статус — отправка файла на проверку не
 * реализована (запись данных, требует явного согласия пользователя).
 */
export function getAntiplagiatStatus(): Promise<ElkAntiplagiatStatus> {
  return elkAntiplagiat();
}
```

Удалить из файла: прежние `ELK_API_TTL`, `fetchElkApi`, `fetchElkApiUncached` (старую), `fetchElkApiViaPage` (старую), `directApiBroken`.

- [ ] **Step 5: Страничные функции пока не трогать — убедиться, что файл собирается**

В файле остались вызовы `cached(...)` и `openAuthenticatedPage(...)` в страничных функциях (Task 5). Чтобы сборка проходила до Task 5, временно вернуть в импорты **только** эти два имени:

```ts
import type { Page } from "playwright";                                 // временно, удаляется в Task 5
import { cached } from "../../cache.js";                                // временно, удаляется в Task 5
import { openAuthenticatedPage } from "../../auth/browser-session.js";  // временно, удаляется в Task 5
```

(Task 5 удаляет все три импорта вместе со страничными `*Uncached` и `dumpAuthenticatedPage`.)
Run: `npm run build` → без ошибок.

- [ ] **Step 6: Прогнать проверки**

Run (каждый режим — отдельный процесс, потому что выключатель — состояние процесса):
- `node $SCRATCH/check-elk.mjs normal`
- `node $SCRATCH/check-elk.mjs 401`
- `node $SCRATCH/check-elk.mjs 403`
- `node $SCRATCH/check-elk.mjs 500`
- `node $SCRATCH/check-elk.mjs html`

Expected: во всех режимах `ALL PASSED`. Зафиксировать для документа: число страниц на 403×2 (было 3 в разведке F2, теперь 1), состояние выключателя.

Если в режиме `normal` пункт `limit=100` падает (API отверг `limit=100` — вызов вернул не 200): откатить `NOTIFICATIONS_FETCH_LIMIT` до 50 и обновить проверку; сообщить пользователю — максимум тула 100 не подтверждён сервером.

- [ ] **Step 7: Commit**

```bash
git add src/services/elk/client.ts
git commit -m "ELK client: breaker with cooldown, 401/403 policy, week-block schedule, API resources

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ЕЛК — страничные ресурсы и `openPage`

**Files:**
- Modify: `src/services/elk/client.ts` (нижняя часть файла: от `SOP_URL` до конца)
- Check (scratchpad): `$SCRATCH/check-elk-pages.mjs`

**Interfaces:**
- Consumes: `withPage` (Task 3), `defineResource` (Task 2).
- Produces (сигнатуры без изменений): `getCourseEvaluationStatus()`, `getThesisStatus()`, `listInternships()`, `getPortfolio()`, `getScholarshipHistory()`, `getProfile()`, `openPage(relativePath)`.

- [ ] **Step 1: Написать проверку `$SCRATCH/check-elk-pages.mjs`**

```js
import { imp, check, done, loadEnv, WT } from "./lib.mjs";
import { createRequire } from "node:module";

loadEnv();
const { chromium } = createRequire(`${WT}/dist/x.js`)("playwright");
const live = { opened: 0, closed: 0 };
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const browser = await origLaunch(...a);
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...b) => {
    const ctx = await origNewContext(...b);
    ctx.on("page", (p) => {
      live.opened++;
      p.once("close", () => live.closed++);
    });
    return ctx;
  };
  return browser;
};

const session = await imp("auth/browser-session.js");
const elk = await imp("services/elk/client.js");

const cases = [
  ["getCourseEvaluationStatus", () => elk.getCourseEvaluationStatus()],
  ["getThesisStatus", () => elk.getThesisStatus()],
  ["listInternships", () => elk.listInternships()],
  ["getPortfolio", () => elk.getPortfolio()],
  ["getScholarshipHistory", () => elk.getScholarshipHistory()],
  ["getProfile", () => elk.getProfile()],
];
for (const [name, fn] of cases) {
  const o0 = live.opened;
  let err = "";
  const t = Date.now();
  await fn().catch((e) => (err = e.message));
  const first = live.opened - o0;
  await fn().catch(() => {});
  check(!err, `${name}: ответ получен${err ? ` (${err.slice(0, 100)})` : ""} за ${Date.now() - t} мс`);
  check(first === 1 && live.opened - o0 === 1, `${name}: 1 страница на два вызова (второй из кэша)`);
}
const o1 = live.opened;
const dump = await elk.openPage("/profile");
check(typeof dump.text === "string" && live.opened - o1 === 1, "openPage: снимок страницы без кэша, одна страница");
check(live.opened === live.closed, "elk-страницы: все страницы закрыты");
await session.closeBrowserSession();
done();
```

- [ ] **Step 2: Заменить страничные функции**

Удалить временные импорты `cached` и `openAuthenticatedPage`, импорт `Page`, функции `dumpAuthenticatedPage` и все `*Uncached`. Заменить блоки (константы `SOP_URL`, `VKR_URL`, `INTERNSHIP_LIST_URL`, `EMPTY_TABLE_PLACEHOLDER`, `PORTFOLIO_URL`, `SCHOLARSHIP_URL` и их комментарии оставить):

```ts
const elkCourseEvaluation = defineResource<void, Array<Record<string, string>>>({
  name: "elk.course-evaluation",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      SOP_URL,
      async (page) => {
        await page.waitForSelector("table.event-table", { timeout: 10_000 }).catch(() => {});
        return extractTable(page, "table.event-table");
      },
      { signal: ctx.signal }
    ),
});

/**
 * Статус «Оцени свои курсы» / СОП (студенческая оценка преподавания) — периоды оценки и статус
 * заполнения анкеты по каждому. Реверс-инжинирено 2026-09-15: это отдельный от edu.hse.ru
 * legacy-портал lms.hse.ru (Yii, серверный рендеринг, без JSON API), доступ через SSO-мост
 * /elk_login.php. Данные — обычная HTML-таблица `table.event-table` (thead/tbody), извлекается
 * через extractTable.
 */
export function getCourseEvaluationStatus(): Promise<Array<Record<string, string>>> {
  return elkCourseEvaluation();
}
```

```ts
const elkThesis = defineResource<void, Array<Record<string, string>>>({
  name: "elk.thesis",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      VKR_URL,
      async (page) => {
        await page.waitForSelector("table", { timeout: 10_000 }).catch(() => {});
        return extractTable(page, "table");
      },
      { signal: ctx.signal }
    ),
});

/**
 * Мои работы (ВКР/КР/Проект) — статус проверки выпускной квалификационной/курсовой работы:
 * тема, процент заимствований, статус проверки, оценка, рецензия. Тот же портал lms.hse.ru,
 * что и getCourseEvaluationStatus, другая цель SSO-моста /elk_login.php. Таблица без класса
 * (единственная на странице) — на аккаунте без зарегистрированной темы работы возвращает
 * пустой массив (страница показывает только пояснение "Тема работы не занесена в систему АСАВ").
 */
export function getThesisStatus(): Promise<Array<Record<string, string>>> {
  return elkThesis();
}
```

```ts
const elkInternships = defineResource<void, Array<Record<string, string>>>({
  name: "elk.internships",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      INTERNSHIP_LIST_URL,
      async (page) => {
        await page.waitForSelector("table.theme_list_table", { timeout: 10_000 }).catch(() => {});
        const rows = await extractTable(page, "table.theme_list_table");
        return rows.filter((r) => !Object.values(r).includes(EMPTY_TABLE_PLACEHOLDER));
      },
      { signal: ctx.signal }
    ),
});

/**
 * Список заявок на практику/стажировку («Модуль Практика» на lms.hse.ru, доступ через тот же
 * SSO-мост `/elk_login.php`). Read-only статус — сама подача заявки на практику отдельная форма,
 * не реализована. Таблица `table.theme_list_table` без содержательных заголовков в пустом
 * состоянии отдаёт строку-заглушку "Ничего не найдено." как будто это данные — отфильтровываем
 * её, иначе пустой список практик выглядел бы как одна поддельная запись.
 */
export function listInternships(): Promise<Array<Record<string, string>>> {
  return elkInternships();
}
```

```ts
const elkPortfolio = defineResource<void, PageDump>({
  name: "elk.portfolio",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => withPage(PORTFOLIO_URL, (page) => dumpPage(page), { signal: ctx.signal }),
});

/**
 * Электронное портфолио студента (баллы за учёбу/науку/ДПО/практики/культурно-творческую и
 * общественную деятельность, спорт, олимпиады — влияет на повышенную стипендию). Реверс-
 * инжинирено 2026-09-15: НЕ требует отдельного логина portfolio.hse.ru, как считалось раньше —
 * это отдельная страница на том же портале lms.hse.ru (`index.php?page=portfolio`), доступная
 * через тот же SSO-мост `/elk_login.php`, что и СОП/ВКР. Смешанная вёрстка (профиль + несколько
 * таблиц + список достижений, каждый раздел деятельности — вложенная страница по
 * `page_point=view_*`) — текстовый дамп через dumpPage, а не extractTable.
 */
export function getPortfolio(): Promise<PageDump> {
  return elkPortfolio();
}
```

```ts
const elkScholarship = defineResource<void, unknown[]>({
  name: "elk.scholarship-history",
  ttl: TTL.medium,
  key: () => "me",
  load: (_a, ctx) =>
    withPage(
      SCHOLARSHIP_URL,
      async (page) => {
        const result = await page.evaluate(async () => {
          const res = await fetch(`act.php?on=portfolio_scholarship&name=history_apps&_=${Date.now()}`, {
            credentials: "include",
          });
          if (!res.ok) {
            throw new Error(`lms.hse.ru act.php вернул ${res.status}`);
          }
          return (await res.json()) as { data: unknown[] };
        });
        return result.data;
      },
      { signal: ctx.signal }
    ),
});

/**
 * История заявок на повышенную государственную академическую стипендию (портал lms.hse.ru,
 * тот же SSO-мост `/elk_login.php`). В отличие от общей истории заявок ЕЛК
 * (`elk_list_requests`), данные грузятся не через DataTables server-side POST (формат которого
 * не удалось поймать — см. `?r=st/request/history-dt`), а простым GET
 * `act.php?on=portfolio_scholarship&name=history_apps` без параметров пагинации/сортировки —
 * поэтому реализуемо без реверс-инжиниринга протокола DataTables. На проверенном аккаунте заявок
 * не было (`{"data":[]}`), поэтому форма отдельной записи не типизирована.
 */
export function getScholarshipHistory(): Promise<unknown[]> {
  return elkScholarship();
}
```

```ts
const elkProfilePage = defineResource<void, PageDump>({
  name: "elk.profile-page",
  ttl: TTL.long,
  key: () => "me",
  load: (_a, ctx) => withPage(`${BASE_URL}/profile`, (page) => dumpPage(page), { signal: ctx.signal }),
});

/**
 * Полная страница профиля (текст + ссылки) — общая информация и контакты. Для структурированной
 * академической карточки (рейтинг, GPA, группа, факультет) используйте getAcademicData().
 */
export function getProfile(): Promise<PageDump> {
  return elkProfilePage();
}

// pmo.hse.ru — домен хелпдеска (создание тикетов), на который ведут документированные ссылки
// со страниц профиля/student-services, поэтому явно разрешён в дополнение к baseUrl.
export function openPage(relativePath: string): Promise<PageDump> {
  const url = resolveScopedUrl(BASE_URL, relativePath, ["pmo.hse.ru"]);
  return withPage(url, (page) => dumpPage(page));
}
```

- [ ] **Step 3: Собрать и проверить**

Run: `npm run build` → без ошибок (в `elk/client.ts` больше нет ссылок на `cached`/`openAuthenticatedPage`).
Run: `node $SCRATCH/check-elk-pages.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 4: Повторить Task 4 проверки (регрессия)**

Run: `node $SCRATCH/check-elk.mjs normal`
Expected: `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/services/elk/client.ts
git commit -m "ELK client: page-based resources and openPage on withPage

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: LMS — ресурсы, корзины календаря, срез сообщений

**Files:**
- Modify: `src/services/lms/client.ts`
- Check (scratchpad): `$SCRATCH/check-lms.mjs`

**Interfaces:**
- Consumes: `withPage` (Task 3), `defineResource` (Task 2).
- Produces:
  - сигнатуры без изменений: `listCourses()`, `listActionEvents(from, to): Promise<LmsActionEventsResult>`, `listMessages(limit = 50)`, `getMessage(id)`, `getCourseMaterials(courseId)`, `listAssignments(courseId)`, `getGrades(courseId)`, `openPage(relativePath)`, `fetchMoodleAjax(page, methodname, args)`;
  - новая экспортируемая чистая функция `calendarHorizon(to: Date, today?: Date): { key: string; end: Date }` (экспорт ради проверки).

- [ ] **Step 1: Написать проверку `$SCRATCH/check-lms.mjs`**

```js
import { imp, check, done, loadEnv, WT } from "./lib.mjs";
import { createRequire } from "node:module";

loadEnv();
const { chromium } = createRequire(`${WT}/dist/x.js`)("playwright");
const live = { opened: 0, closed: 0 };
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const browser = await origLaunch(...a);
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...b) => {
    const ctx = await origNewContext(...b);
    ctx.on("page", (p) => {
      live.opened++;
      p.once("close", () => live.closed++);
    });
    return ctx;
  };
  return browser;
};

const session = await imp("auth/browser-session.js");
const lms = await imp("services/lms/client.js");
const day = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// --- calendarHorizon: чистая логика
{
  const today = new Date(2026, 9, 14, 10, 0);
  const h1 = lms.calendarHorizon(endOfDay(day(today, 1)), today);
  const h6 = lms.calendarHorizon(endOfDay(day(today, 6)), today);
  const h7 = lms.calendarHorizon(endOfDay(day(today, 7)), today);
  const h8 = lms.calendarHorizon(endOfDay(day(today, 8)), today);
  const h14 = lms.calendarHorizon(endOfDay(day(today, 14)), today);
  const h61 = lms.calendarHorizon(endOfDay(day(today, 61)), today);
  const hPast = lms.calendarHorizon(endOfDay(day(today, -3)), today);
  check(h1.key === h6.key && h6.key === h7.key, "calendar: +1, +6, +7 дней — одна корзина (7)");
  check(h8.key === h14.key && h8.key !== h7.key, "calendar: +8 и +14 — корзина 14");
  check(h61.key.startsWith("d") && hPast.key.startsWith("d"), "calendar: дальше 60 дней и прошлое — точный ключ");
  check(h7.end.getTime() >= endOfDay(day(today, 7)).getTime(), "calendar: граница корзины не меньше запрошенной");
}

// --- живая часть
const p0 = live.opened;
const courses = await lms.listCourses();
await lms.listCourses();
check(live.opened - p0 === 1 && courses.length > 0, `lms: listCourses — 1 страница на 2 вызова (${courses.length} курсов)`);

const today = new Date();
const lookback = startOfDay(day(today, -180));
const o1 = live.opened;
const e1 = await lms.listActionEvents(lookback, endOfDay(day(today, 1)));
const e6 = await lms.listActionEvents(lookback, endOfDay(day(today, 6)));
check(live.opened - o1 === 1, "lms: calendar +1 и +6 дней — одна загрузка (корзина 7)");
check(e1.events.every((e) => Date.parse(e.due) <= endOfDay(day(today, 1)).getTime()), "lms: срез: нет событий позже запрошенной даты (+1)");
check(e6.events.length >= e1.events.length, "lms: срез: +6 содержит не меньше, чем +1");
const o2 = live.opened;
await lms.listActionEvents(lookback, endOfDay(day(today, 14)));
check(live.opened - o2 === 1, "lms: calendar +14 — другая корзина, одна новая загрузка");
check(typeof e1.truncated === "boolean", "lms: truncated — boolean для среза");

const o3 = live.opened;
const m10 = await lms.listMessages(10);
const m50 = await lms.listMessages(50);
const m200 = await lms.listMessages(200);
check(live.opened - o3 === 1, "lms: listMessages(10|50|200) — одна загрузка");
check(m10.length <= 10 && m50.length <= 50 && m200.length <= 200 && m10.length <= m50.length, "lms: срез по limit");

if (m50[0]) {
  const o4 = live.opened;
  await lms.getMessage(m50[0].id);
  await lms.getMessage(m50[0].id);
  check(live.opened - o4 === 1, "lms: getMessage — 1 страница на 2 вызова");
}

const cid = courses[0].id;
for (const [name, fn] of [
  ["getCourseMaterials", () => lms.getCourseMaterials(cid)],
  ["listAssignments", () => lms.listAssignments(cid)],
  ["getGrades", () => lms.getGrades(cid)],
]) {
  const o = live.opened;
  let err = "";
  await fn().catch((e) => (err = e.message));
  await fn().catch(() => {});
  check(!err && live.opened - o === 1, `lms: ${name} — 1 страница на 2 вызова${err ? ` (${err.slice(0, 80)})` : ""}`);
}
const o5 = live.opened;
const dump = await lms.openPage("/my/");
check(typeof dump.text === "string" && live.opened - o5 === 1, "lms: openPage — снимок без кэша");
check(live.opened === live.closed, "lms: все страницы закрыты");
await session.closeBrowserSession();
done();
```

- [ ] **Step 2: Заменить импорты и функции в `src/services/lms/client.ts`**

Импорты (строки 1–6) заменить на:

```ts
import type { Page } from "playwright";
import { withPage } from "../../auth/browser-session.js";
import { TTL } from "../../cache.js";
import { dumpPage, extractTable, type PageDump } from "../../dom-utils.js";
import { formatLocalDate } from "../../date-utils.js";
import { defineResource } from "../../resource.js";
import { resolveScopedUrl } from "../../url-utils.js";
```

`listCourses` + `listCoursesUncached` заменить на:

```ts
const lmsCourses = defineResource<void, CourseOverview[]>({
  name: "lms.courses",
  ttl: TTL.medium,
  key: () => "all",
  load: (_a, ctx) =>
    withPage(
      AJAX_HOST_URL,
      async (page) => {
        const data = await fetchMoodleAjax<{ courses: RawTimelineCourse[] }>(
          page,
          "local_api_get_enrolled_courses_by_timeline_classification",
          {
            offset: 0,
            limit: 100,
            classification: "all",
            sort: "fullname",
            customfieldname: "",
            customfieldvalue: "",
            requiredfields: ["id", "fullname", "shortname", "showcoursecategory", "showshortname", "visible", "enddate"],
          }
        );
        return data.courses.map((c) => ({
          id: c.id,
          fullname: c.fullname,
          shortname: c.shortname,
          category: stripHtml(c.coursecategory),
          startdate: unixToIso(c.startdate),
          enddate: c.enddate > 0 ? unixToIso(c.enddate) : null,
          progress: c.hasprogress ? c.progress : null,
          isFavourite: c.isfavourite,
          hidden: c.hidden,
          visible: c.visible,
          viewUrl: c.viewurl,
        }));
      },
      { signal: ctx.signal }
    ),
});

/**
 * Список курсов через внутренний AJAX-эндпоинт дашборда (см. fetchMoodleAjax) — вместо парсинга
 * ссылок со страницы: даёт прогресс прохождения, даты начала/окончания и категорию, которых нет
 * в простой ссылке на курс. classification: "all" — все курсы, включая скрытые из вида.
 */
export function listCourses(): Promise<CourseOverview[]> {
  return lmsCourses();
}
```

(Старый JSDoc над `listCourses` заменяется вместе с телом — новый уже включён в блок. То же для `listActionEvents`, `listMessages`, `getMessage` ниже: заменять функцию вместе с её JSDoc, дублей быть не должно.)

`listActionEvents` + `listActionEventsUncached` заменить на (интерфейсы `RawActionEvent`, `LmsActionEvent`, `LmsActionEventsResult`, константы `CALENDAR_PAGE_SIZE`/`CALENDAR_MAX_PAGES` оставить):

```ts
// Правая граница запроса округляется вверх до корзины (7/14/30/60 дней от сегодня): сводки
// «сегодня/неделя/две недели» делят одну дорогую загрузку (страница + до 6 AJAX-запросов), а
// `project` отсекает лишнее. Дальше 60 дней и в прошлом — точный ключ по дате.
const CALENDAR_BUCKET_DAYS = [7, 14, 30, 60];
const MS_PER_DAY = 86_400_000;

export function calendarHorizon(to: Date, today: Date = new Date()): { key: string; end: Date } {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const t1 = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  const days = Math.round((t1.getTime() - t0.getTime()) / MS_PER_DAY);
  const bucket = days >= 0 ? CALENDAR_BUCKET_DAYS.find((b) => b >= days) : undefined;
  if (bucket === undefined) return { key: `d${formatLocalDate(t1, "-")}`, end: to };
  const end = new Date(t0);
  end.setDate(end.getDate() + bucket);
  end.setHours(23, 59, 59, 999);
  return { key: `b${bucket}@${formatLocalDate(t0, "-")}`, end };
}

interface CalendarArgs {
  from: Date;
  to: Date;
}

const lmsCalendar = defineResource<CalendarArgs, LmsActionEventsResult, LmsActionEventsResult>({
  name: "lms.calendar",
  ttl: TTL.medium,
  key: (a) => `${formatLocalDate(a.from, "-")}:${calendarHorizon(a.to).key}`,
  load: (a, ctx) =>
    withPage(
      AJAX_HOST_URL,
      async (page) => {
        const end = calendarHorizon(a.to).end;
        const events: LmsActionEvent[] = [];
        let truncated = false;
        let afterEventId = 0;
        for (let i = 0; i < CALENDAR_MAX_PAGES; i++) {
          const data = await fetchMoodleAjax<{ events: RawActionEvent[]; lastid?: number }>(
            page,
            "core_calendar_get_action_events_by_timesort",
            {
              timesortfrom: Math.floor(a.from.getTime() / 1000),
              timesortto: Math.floor(end.getTime() / 1000),
              aftereventid: afterEventId,
              limitnum: CALENDAR_PAGE_SIZE,
              limittononsuspendedevents: true,
            }
          );
          for (const e of data.events) {
            events.push({
              id: e.id,
              name: stripHtml(e.name),
              module: e.modulename ?? "",
              course: e.course?.fullname ?? "",
              courseId: e.course?.id ?? null,
              due: unixToIso(e.timesort),
              overdue: e.overdue ?? false,
              actionable: e.action?.actionable ?? false,
              actionName: e.action?.name ?? "",
              url: e.action?.url ?? e.url ?? null,
            });
          }
          if (data.events.length < CALENDAR_PAGE_SIZE || !data.lastid) break;
          if (i === CALENDAR_MAX_PAGES - 1) truncated = true;
          afterEventId = data.lastid;
        }
        return { events, truncated };
      },
      { signal: ctx.signal }
    ),
  // Событий позже запрошенной границы быть не должно; усечение относится только к хвосту выборки,
  // поэтому для запроса с более ранней границей, чем последнее полученное событие, оно неактуально.
  project: (raw, a) => {
    const toMs = a.to.getTime();
    const events = raw.events.filter((e) => Date.parse(e.due) <= toMs);
    const lastDue = raw.events.reduce((m, e) => Math.max(m, Date.parse(e.due)), -Infinity);
    return { events, truncated: raw.truncated && lastDue <= toMs };
  },
});

/**
 * События календаря Moodle «нужно действие» (сдать задание, пройти тест) за период — один
 * AJAX-запрос вместо обхода страницы заданий каждого курса; тот же сервис, что питает блок
 * «Таймлайн» дашборда. Проверено вживую 2026-10-14: сданные работы в ответ не попадают;
 * просроченное несданное приходит с `overdue: true` и `actionable: false` (сдача закрыта) —
 * поэтому по `actionable` фильтровать нельзя. Ключ кэша: дата начала + корзина правой границы.
 */
export function listActionEvents(from: Date, to: Date): Promise<LmsActionEventsResult> {
  return lmsCalendar({ from, to });
}
```

Старый блок с ключом `lms:calendar:<from>:<to>` и его JSDoc удалить целиком.

`listMessages` + `listMessagesUncached`:

```ts
const MESSAGES_FETCH_LIMIT = 200; // максимум тула lms_list_messages

const lmsMessages = defineResource<number, RawMailMessageSummary[], LmsMessageSummary[]>({
  name: "lms.messages",
  ttl: TTL.short,
  key: () => "inbox",
  load: (_limit, ctx) =>
    withPage(
      `${BASE_URL}/local/mail/view.php?t=inbox`,
      (page) =>
        fetchMoodleAjax<RawMailMessageSummary[]>(page, "local_mail_search_messages", {
          query: { roles: ["to", "cc", "bcc"], deleted: false },
          limit: MESSAGES_FETCH_LIMIT,
        }),
      { signal: ctx.signal }
    ),
  project: (raw, limit) =>
    raw.slice(0, limit).map((m) => ({
      id: m.id,
      subject: m.subject,
      course: m.course.fullname,
      sender: m.sender.fullname,
      time: unixToIso(m.time),
      unread: m.unread,
      starred: m.starred,
      numAttachments: m.numattachments,
    })),
});

/**
 * Внутренняя почта SmartLMS (плагин local_mail, edu.hse.ru/local/mail/) — переписка с
 * преподавателями внутри курсов. Реверс-инжинирено 2026-09-15 через тот же внутренний AJAX-сервис
 * Moodle (fetchMoodleAjax), метод local_mail_search_messages с ролями to/cc/bcc — это входящие.
 */
export function listMessages(limit = 50): Promise<LmsMessageSummary[]> {
  return lmsMessages(limit);
}
```

`getMessage` + `getMessageUncached`:

```ts
const lmsMessage = defineResource<number, RawMailMessage, LmsMessage>({
  name: "lms.message",
  ttl: TTL.medium,
  key: (id) => String(id),
  load: (id, ctx) =>
    withPage(
      `${BASE_URL}/local/mail/view.php?t=inbox`,
      (page) => fetchMoodleAjax<RawMailMessage>(page, "local_mail_get_message", { messageid: id }),
      { signal: ctx.signal }
    ),
  project: (m) => ({
    id: m.id,
    subject: m.subject,
    text: htmlToText(m.content),
    course: m.course.fullname,
    sender: m.sender.fullname,
    recipients: m.recipients.map((r) => r.fullname),
    time: unixToIso(m.time),
    attachments: m.attachments.map((a) => ({ filename: a.filename, filesize: a.filesize, url: a.fileurl })),
  }),
});

/** Полный текст письма внутренней почты SmartLMS по id (см. listMessages). */
export function getMessage(messageId: number): Promise<LmsMessage> {
  return lmsMessage(messageId);
}
```

Материалы, задания, оценки:

```ts
const lmsMaterials = defineResource<number, ModuleLink[]>({
  name: "lms.materials",
  ttl: TTL.medium,
  key: (courseId) => String(courseId),
  load: (courseId, ctx) =>
    withPage(
      `${BASE_URL}/course/view.php?id=${courseId}`,
      (page) =>
        page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href*="/mod/"]'));
          const seen = new Set<string>();
          const result: Array<{ type: string; cmid: number | null; title: string; url: string }> = [];
          for (const a of anchors) {
            const href = (a as HTMLAnchorElement).href;
            const modMatch = href.match(/\/mod\/([a-z]+)\/view\.php/);
            if (!modMatch) continue;
            const idMatch = href.match(/[?&]id=(\d+)/);
            const title = a.textContent?.trim().replace(/\s+/g, " ") || "";
            if (!title || seen.has(href)) continue;
            seen.add(href);
            result.push({ type: modMatch[1], cmid: idMatch ? Number(idMatch[1]) : null, title, url: href });
          }
          return result;
        }),
      { signal: ctx.signal }
    ),
});

export function getCourseMaterials(courseId: number): Promise<ModuleLink[]> {
  return lmsMaterials(courseId);
}

const lmsAssignments = defineResource<number, Array<Record<string, string>>>({
  name: "lms.assignments",
  ttl: TTL.medium,
  key: (courseId) => String(courseId),
  load: (courseId, ctx) =>
    withPage(
      `${BASE_URL}/mod/assign/index.php?id=${courseId}`,
      (page) => extractTable(page, "table.generaltable"),
      { signal: ctx.signal }
    ),
});

export function listAssignments(courseId: number): Promise<Array<Record<string, string>>> {
  return lmsAssignments(courseId);
}

const lmsGrades = defineResource<number, Array<Record<string, string>>>({
  name: "lms.grades",
  ttl: TTL.medium,
  key: (courseId) => String(courseId),
  load: (courseId, ctx) =>
    withPage(
      `${BASE_URL}/grade/report/user/index.php?id=${courseId}`,
      async (page) => {
        const rows = await extractTable(page, "table.user-grade");
        if (rows.length > 0) return rows;
        return extractTable(page, "table.generaltable");
      },
      { signal: ctx.signal }
    ),
});

export function getGrades(courseId: number): Promise<Array<Record<string, string>>> {
  return lmsGrades(courseId);
}

/** Открыть произвольную страницу edu.hse.ru (относительный путь) — для случаев вне готовых тулов. */
export function openPage(relativePath: string): Promise<PageDump> {
  const url = resolveScopedUrl(BASE_URL, relativePath);
  return withPage(url, (page) => dumpPage(page));
}
```

- [ ] **Step 3: Собрать и проверить**

Run: `npm run build` → без ошибок (в `lms/client.ts` не осталось `cached`/`openAuthenticatedPage`; тип `Page` нужен только для `fetchMoodleAjax`).
Run: `node $SCRATCH/check-lms.mjs`
Expected: `ALL PASSED`.

- [ ] **Step 4: Commit**

```bash
git add src/services/lms/client.ts
git commit -m "LMS client: resources, calendar horizon buckets, message slice from one load

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: istudy — миграция на `withPage` и ресурсы

**Files:**
- Modify: `src/services/istudy/client.ts`
- Check (scratchpad): `$SCRATCH/check-istudy.mjs`

**Interfaces:**
- Consumes: `withPage` (Task 3), `defineResource` (Task 2).
- Produces: `getReport(): Promise<IstudyReport>`, `getExams(): Promise<ExamsByPeriodResponse>` — сигнатуры без изменений.

Поведение сохраняется (дефект F9 вне рамок): проверка подтверждает, что отказ остаётся прежним и не течёт слот.

- [ ] **Step 1: Написать проверку `$SCRATCH/check-istudy.mjs`**

```js
import { imp, check, done, loadEnv, WT } from "./lib.mjs";
import { createRequire } from "node:module";

loadEnv();
const { chromium } = createRequire(`${WT}/dist/x.js`)("playwright");
const live = { opened: 0, closed: 0 };
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const browser = await origLaunch(...a);
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...b) => {
    const ctx = await origNewContext(...b);
    ctx.on("page", (p) => {
      live.opened++;
      p.once("close", () => live.closed++);
    });
    return ctx;
  };
  return browser;
};

const session = await imp("auth/browser-session.js");
const istudy = await imp("services/istudy/client.js");

for (const [name, fn] of [
  ["getReport", () => istudy.getReport()],
  ["getExams", () => istudy.getExams()],
]) {
  let msg = "";
  let ok = false;
  await fn().then(() => (ok = true)).catch((e) => (msg = e.message));
  // F9: сервис не отдаёт ответы SPA — прежняя ошибка допустима; главное, что страница закрыта и слот свободен
  console.log(`INFO  ${name}: ${ok ? "данные получены" : msg.slice(0, 120)}`);
  check(ok || /не отдал ожидаемые данные|Ссылка на istudy/.test(msg), `${name}: либо данные, либо прежняя понятная ошибка`);
}
check(live.opened === live.closed, "istudy: все страницы закрыты, в том числе после ошибки");
const t = Date.now();
await Promise.all([1, 2, 3, 4].map(() => session.withPage("https://lk.hse.ru/profile", async () => 1)));
check(Date.now() - t < 15_000, "istudy: после отказа слоты свободны (4 параллельных открытия прошли)");
await session.closeBrowserSession();
done();
```

- [ ] **Step 2: Заменить `src/services/istudy/client.ts` частично**

Импорты (строки 1–3) заменить на:

```ts
import { withPage } from "../../auth/browser-session.js";
import { TTL } from "../../cache.js";
import { defineResource } from "../../resource.js";
```

Функцию `collectIstudyResponses` (с её комментарием-описанием над ней, комментарий сохранить) заменить на:

```ts
async function collectIstudyResponses(
  patterns: Record<string, RegExp>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const pending = new Set(Object.keys(patterns));

  await withPage(
    "https://lk.hse.ru/profile",
    async (page) => {
      const href = await page.locator('a[href*="istudy.hse.ru"]').first().getAttribute("href");
      if (!href) {
        throw new Error("Ссылка на istudy.hse.ru не найдена на странице профиля ЕЛК (lk.hse.ru/profile)");
      }
      page.on("response", (res) => {
        if (pending.size === 0) return;
        const url = res.url();
        for (const key of pending) {
          if (patterns[key].test(url)) {
            pending.delete(key);
            res
              .json()
              .then((body) => {
                results[key] = body;
              })
              .catch(() => {});
            break;
          }
        }
      });
      await page.goto(href, { waitUntil: "networkidle", timeout: 20_000 });
    },
    { signal }
  );

  const missing = Object.keys(patterns).filter((key) => !(key in results));
  if (missing.length > 0) {
    throw new Error(
      `istudy.hse.ru не отдал ожидаемые данные при загрузке SPA: ${missing.join(", ")}`
    );
  }
  return results;
}
```

`getReport`:

```ts
const istudyReport = defineResource<void, IstudyReport>({
  name: "istudy.report",
  ttl: TTL.long,
  key: () => "me",
  load: async (_a, ctx) => {
    const data = await collectIstudyResponses(
      {
        profile: new RegExp(`${STUDENT_API.source}profile$`),
        reportInfo: new RegExp(`${STUDENT_API.source}report-info$`),
        rating: new RegExp(`${STUDENT_API.source}rating$`),
      },
      ctx.signal
    );
    return data as unknown as IstudyReport;
  },
});

/** Сводная академическая карточка (профиль + рейтинг/GPA/кредиты) с реальными числами из istudy.hse.ru. */
export function getReport(): Promise<IstudyReport> {
  return istudyReport();
}
```

`getExams`:

```ts
const istudyExams = defineResource<void, ExamsByPeriodResponse>({
  name: "istudy.exams",
  ttl: TTL.long,
  key: () => "me",
  load: async (_a, ctx) => {
    const data = await collectIstudyResponses(
      { exams: new RegExp(`${STUDENT_API.source}exams-by-period\\?`) },
      ctx.signal
    );
    return data.exams as ExamsByPeriodResponse;
  },
});

/** Список дисциплин с результатами (экзамены/зачёты) за текущий учебный период студента. */
export function getExams(): Promise<ExamsByPeriodResponse> {
  return istudyExams();
}
```

- [ ] **Step 3: Собрать и проверить**

Run: `npm run build` → без ошибок.
Run: `node $SCRATCH/check-istudy.mjs`
Expected: `ALL PASSED`. Строки `INFO` покажут, работает ли istudy сейчас. Если данные пришли — отметить в итогах «istudy заработал», если прежняя ошибка — «не проверено (F9)».

- [ ] **Step 4: Commit**

```bash
git add src/services/istudy/client.ts
git commit -m "istudy client: migrate to withPage and resources (behaviour unchanged)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Удаление переходного API, документы, сквозная живая проверка

**Files:**
- Modify: `src/auth/browser-session.ts` (удалить `openAuthenticatedPage`)
- Modify: `src/services/system/tools.ts` (описание)
- Modify: `CLAUDE.md`, `docs/requirements.md`
- Modify: `docs/superpowers/specs/2026-10-14-reliability-rework-design.md` (раздел результатов)
- Check (scratchpad): `$SCRATCH/check-e2e.mjs`

**Interfaces:** consumes всё выше; produces ничего нового.

- [ ] **Step 1: Убедиться, что `openAuthenticatedPage` больше никто не использует**

Run (инструмент Grep): шаблон `openAuthenticatedPage` по `src/`.
Expected: единственное совпадение — определение в `src/auth/browser-session.ts`. Любое другое — вернуться в соответствующую задачу и мигрировать.

- [ ] **Step 2: Удалить `openAuthenticatedPage` из `src/auth/browser-session.ts`**

Удалить функцию и её `@deprecated`-комментарий целиком (блок между `withPage` и `getApiRequestContext`).

Run: `npm run build` → без ошибок.

- [ ] **Step 3: Обновить описание `hse_clear_cache` в `src/services/system/tools.ts`**

Значение `description` заменить на:

```ts
      description:
        "Результаты тулов lms_*/elk_*/istudy_* и сводок my_today/my_week/my_deadlines (они " +
        "собираются из тех же ресурсов) кэшируются в памяти на 2–30 минут, чтобы не открывать " +
        "браузер заново ради неизменившихся данных (почта и RUZ не кэшируются). Если нужно " +
        "гарантированно свежее значение — например, сразу после подачи работы или заявки, — " +
        "вызовите этот тул, затем повторите нужный запрос. scope сужает сброс до одного сервиса.",
```

- [ ] **Step 4: Написать сквозную проверку `$SCRATCH/check-e2e.mjs`**

```js
import { imp, check, done, loadEnv, WT } from "./lib.mjs";
import { createRequire } from "node:module";

loadEnv();
const { chromium } = createRequire(`${WT}/dist/x.js`)("playwright");
const live = { opened: 0, closed: 0 };
const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
  const browser = await origLaunch(...a);
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...b) => {
    const ctx = await origNewContext(...b);
    ctx.on("page", (p) => {
      live.opened++;
      p.once("close", () => live.closed++);
    });
    return ctx;
  };
  return browser;
};

const session = await imp("auth/browser-session.js");
const digest = await imp("services/digest/client.js");
const { clearCache } = await imp("cache.js");

async function run(name, fn) {
  const o = live.opened;
  const t = Date.now();
  const r = await fn();
  const statuses = Object.entries(r.sources).map(([k, v]) => `${k}=${v.status}`).join(" ");
  console.log(`INFO  ${name}: ${Date.now() - t} мс, страниц +${live.opened - o}, элементов ${r.items.length}; ${statuses}`);
  return r;
}

// холодный процесс
const today = await run("my_today (холодный)", () => digest.getToday());
await run("my_today (повтор)", () => digest.getToday());
const week = await run("my_week", () => digest.getWeek());
const dl = await run("my_deadlines(14)", () => digest.getDeadlines({ days: 14 }));

const okSources = (r) => Object.values(r.sources).filter((s) => s.status === "ok").length;
check(okSources(today) >= 6, `e2e: my_today — источников ok: ${okSources(today)}`);
check(okSources(week) >= 2 && okSources(dl) >= 3, "e2e: my_week и my_deadlines получили свои источники");
check(Array.isArray(today.items) && Array.isArray(week.items), "e2e: результаты сводок — массивы (заморозка кэша не сломала потребителей)");

// повторные сводки не открывают страницы заново
const o = live.opened;
await digest.getToday();
await digest.getWeek();
await digest.getDeadlines({ days: 14 });
check(live.opened === o, "e2e: повтор всех трёх сводок — 0 новых страниц (всё из кэша)");

// сброс кэша действительно вызывает перезагрузку
clearCache("lms:");
const o2 = live.opened;
await digest.getDeadlines({ days: 14 });
check(live.opened > o2, "e2e: после clearCache('lms:') сводка загружает LMS заново");

check(live.opened === live.closed, "e2e: все страницы закрыты");
await session.closeBrowserSession();
done();
```

- [ ] **Step 5: Запустить сквозную проверку и повторить регрессию**

Run: `node $SCRATCH/check-e2e.mjs`
Expected: `ALL PASSED`; записать в итоги строки `INFO` (время холодного `my_today`, число страниц) — сравнить с замером №2: `my_today` ≈ 17 с, `my_week` ≈ 2,8 с, `my_deadlines(14)` ≈ 4,0 с.

Регрессия (по одному запуску): `check-limiter.mjs`, `check-resource.mjs`, `check-withpage.mjs`, `check-login-once.mjs`, `check-elk.mjs normal`, `check-elk.mjs 403`, `check-elk-pages.mjs`, `check-lms.mjs`, `check-istudy.mjs`.
Expected: везде `ALL PASSED`.

- [ ] **Step 6: Обновить `CLAUDE.md`**

Блок «Надёжность и скорость (общая инфраструктура поверх сервисов):» с тремя пунктами (строки 82–92) заменить на:

```markdown
Надёжность и скорость (общая инфраструктура поверх сервисов):
- `src/auth/browser-session.ts#withPage(url, fn, { deadlineMs, signal })` — единственный способ
  открыть страницу: проходит SSO, вызывает `fn`, в `finally` закрывает страницу и возвращает слот
  лимитера; по дедлайну (45 с) или сигналу страница закрывается, слот освобождается. Вложенный
  `withPage` запрещён (ошибка вместо зависания). Замок входа держится только на фактический логин;
  сессия на диск пишется атомарно.
- `src/limiter.ts` — потолок 3 одновременных страницы и пауза ≥300 мс между открытиями; слот имеет
  аренду (дедлайн + 5 с) как страховку от утечки; прямые API-запросы идут не чаще 1 в 100 мс.
  Пороги не измерены на антибот-защите ВШЭ.
- `src/resource.ts#defineResource` — кэшируемый ресурс: имя `<домен>.<id>`, ключ, TTL, загрузчик,
  срез `project` после кэша, дедлайн загрузки. Результат в кэше заморожен (мутация даёт
  `TypeError`). Домены `elk:`/`lms:`/`istudy:` — по префиксу работает `clearCache` (тул
  `hse_clear_cache`); `invalidates` у будущих записывающих ресурсов сбрасывает ресурсы по имени.
  Хранилище — `src/cache.ts` (память, TTL, дедупликация, лимит 200 записей); на диск ничего не
  пишется. Почта и RUZ не кэшируются.
- Прямой путь ЕЛК (`services/elk/client.ts`): токен кэшируется до `exp` JWT, запросы идут через
  `context.request`. 401/не-JSON сбрасывают токен, 403 нет; после двух отказов один заход через
  страницу, и если он прошёл — выключатель (`src/breaker.ts`) на 10 минут отправляет запросы через
  страницу, затем одна проба. Расписание ЕЛК грузится и кэшируется по неделям; календарь LMS —
  по корзинам правой границы (7/14/30/60 дней).
```

- [ ] **Step 7: Обновить `docs/requirements.md`**

Два нефункциональных пункта (строки 102–109) заменить на:

```markdown
- **Нагрузка на порталы ВШЭ ограничена**: не больше 3 одновременно открытых страниц общего
  браузера и ≥300 мс между открытиями, прямые API-запросы — не чаще 1 в 100 мс
  (`src/limiter.ts`; пороги не измерены на антибот-защите ВШЭ). Новый код открывает страницы
  только через `withPage` и не вкладывает вызовы друг в друга; слот возвращается по завершении
  вызова либо по дедлайну (45 с).
- **Данные читающих тулов кэшируются в памяти на 2–30 минут** (`src/resource.ts`,
  `src/cache.ts`), кэш на диск не пишется. Свежесть по требованию — `hse_clear_cache`. Любая
  будущая записывающая операция обязана объявлять `invalidates` для затронутых ресурсов и
  никогда сама не кэшируется. Почта и RUZ не кэшируются.
```

- [ ] **Step 8: Дописать раздел «Результаты живой проверки» в спецификацию**

Добавить в конец `docs/superpowers/specs/2026-10-14-reliability-rework-design.md` раздел `## 14. Результаты живой проверки реализации` со структурой:

```markdown
## 14. Результаты живой проверки реализации

Проверено на реальном аккаунте, один аккаунт и один день; без персональных значений.

| Что | До (§2) | После |
|---|---|---|
| Два 403 на прямом пути (подмена `api.get`) | 3 страницы, `directApiBroken` навсегда | <страниц по check-elk 403>, выключатель 10 мин |
| 401 один раз (подмена) | — | <страниц по check-elk 401> |
| 3 незакрытые страницы + 4-я | зависание | дедлайн/аренда, слоты свободны |
| 3 параллельных открытия | 1,34 с против 1,81 с | <по check-withpage> |
| N параллельных открытий без сессии | — | POST логина: <число по check-login-once> |
| `listMessages(10/50/200)` | 3 запроса | <по check-lms> |
| `getNotifications(5/20)` | 2 запроса | <по check-elk normal> |
| Расписание: две сводки с пересекающимися окнами | отдельные ключи | блоки по неделям |
| `my_today` холодный / повтор | ≈ 17 с / ≈ 0 мс | <по check-e2e> |
| `my_week`, `my_deadlines(14)` | ≈ 2,8 с, ≈ 4,0 с | <по check-e2e> |

**Не проверено:** реальный 403/WAF-отказ, протухшая SSO-сессия (проверен только сценарий «сессии нет»),
несколько процессов одновременно, пороги антибот-защиты, `istudy_*` (<результат check-istudy>),
восстановление выключателя по истечении 10 минут (проверено только на подставных часах).
```

Заменить угловые скобки реальными значениями из выводов проверок Step 5; ни одной незаполненной ячейки в коммите быть не должно (если значение не получено — писать «не измерено» и причину).

- [ ] **Step 9: Финальная сборка и коммиты**

Run: `npm run build` → без ошибок. Run (Grep): `<` и `>` вокруг «по check-» в спеке — совпадений быть не должно.

```bash
git add src/auth/browser-session.ts src/services/system/tools.ts CLAUDE.md docs/requirements.md docs/superpowers/specs/2026-10-14-reliability-rework-design.md
git commit -m "Remove transitional openAuthenticatedPage, update docs and record live verification

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (выполнено)

**Покрытие спецификации.** §3 архитектура → Tasks 1–3; §4 ресурс → Task 2; §4.1 нормализация → Tasks 4 (недели, лимиты), 6 (корзины, срез); §5 `withPage` → Task 3; §5.1 замок → Task 3 (шаг 5); §6 лимитер → Task 1; §7 токен/выключатель/сессия → Tasks 3–4; §8 отмена → Tasks 2, 3 (контракт на уровне ресурса и `withPage`; прокидывание из `digest` явно вне плана, см. «Уточнения» п. 6); §9 миграция → порядок задач 1–8; §10 ошибки → Tasks 2–4 (сообщения); §11 вне рамок → не реализуется; §12 верификация → шаги проверок и Task 8; §13 риски → Task 3 шаг 5 (откат замка).

**Сканирование заглушек.** В коде плана нет «TBD/TODO»; в Task 8 шаг 8 угловые скобки в таблице — это место подстановки измеренных значений, а не код; шаг 9 проверяет, что их не осталось.

**Согласованность типов.** `withPage(url, fn, { deadlineMs, signal })` (Task 3) используется в Tasks 4–7 теми же именами; `defineResource` и `LoadContext` (Task 2) — в 4–7; `createBreaker`/`acquireRequestTurn` (Task 1) — в Task 4; `calendarHorizon` определён и экспортирован в Task 6 и используется только там.
