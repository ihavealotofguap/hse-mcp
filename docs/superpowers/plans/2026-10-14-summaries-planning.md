# Сводки и планирование (`my_today` / `my_week` / `my_deadlines`) — план реализации

*Исторический документ: план писался до живых замеров; итоговое поведение (календарь без fallback, таймаут 40 с, просроченные видны всегда) — в спецификации.*

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Три read-only тула-агрегатора, отдающие единый JSON-список элементов (занятия, дедлайны **включая просроченные несданные**, входящие) с явным статусом каждого источника.

**Architecture:** Новый сервис `src/services/digest/`: чистые функции разбора (`parse.ts`), коллекторы по источникам (`sources.ts`), сборка с частичными отказами и внедряемыми коллекторами (`client.ts`), MCP-обёртки (`tools.ts`). Агрегаторы вызывают клиентские функции `elk`/`lms`/`ruz`, не MCP-тулы. Дедлайны LMS берутся из календаря Moodle одним AJAX-запросом (работоспособность подтверждена живым зондированием 2026-10-14, см. ниже); обход таблиц заданий по курсам не реализуется.

**Tech Stack:** TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk`, `zod`, Playwright (через существующий `openAuthenticatedPage`).

**Spec:** `docs/superpowers/specs/2026-10-14-summaries-planning-design.md`. Изменения к ней, возникшие при проработке плана и зондировании, перечислены в Task 8 и вносятся в спецификацию там же.

## Результаты живого зондирования (2026-10-14, реальный аккаунт)

Исполнитель этого плана их не видел — они здесь, чтобы опираться на факты, а не на допущения.

**Календарь Moodle** — `core_calendar_get_action_events_by_timesort` через `fetchMoodleAjax` на `edu.hse.ru` **работает** (HTTP 200, без `error`). Аргументы, которые сработали: `{ timesortfrom, timesortto, aftereventid, limitnum: 50, limittononsuspendedevents }`. Ответ: `{ events: [...], firstid, lastid }`. Поля события: `id, name, modulename, activityname, instance, eventtype, timesort, timestart, overdue (boolean), isactionevent, viewurl, url, course {id, fullname, ...}, action {name, actionable, url, ...}` и др. `timesort` — unix-секунды.

**Семантика для «просроченных»** (ключевое):
- Сданное задание в календарь **не попадает вообще** (задание «Отправлено для оценивания» за 25 сентября в ответе отсутствует, хотя окно захватывало год назад).
- Просроченное и несданное приходит с `overdue: true` **и `action.actionable: false`** (сдача уже закрыта). Поэтому фильтр по `actionable` **запрещён**: он спрятал бы ровно то, что пользователь хочет видеть.
- Будущий тест до открытия имеет `actionable: false` и `overdue: false` — тоже остаётся в списке.
- Модули в ответе: `assign`, `quiz`.

**Таблица заданий** (`lms_list_assignments`): колонки `["Секция","Задания","Последний срок сдачи","Ответ","Оценка"]`; срок — «понедельник, 5 октября 2026, 23:59»; статусы «Ответ не представлен», «Нет ответа на задание», «Отправлено для оценивания»; строка-разделитель секции приходит как `[""]`. Нужна только для справки: в коде не используется.

**Курсы:** 19 видимых, у 14 есть `enddate`, завершённых нет; все курсы с событиями проходят правило «актуальный».

**Расписание ЕЛК** (`get-myschedule`): `date` = `"2026-10-14"`, `begin_time`/`end_time` = `"13:00"`/`"14:20"`; поля занятия: `auditorium, building, name, lesson_type, lesson_type_id, begin_time, end_time, lecturer, lesson_number, parent_schedule, url1, url1_description, url2, url2_description`. Значения `lesson_type`: «Проведение семинаров (студенты)», «Лекция», «Проведение практических занятий (студенты)», «Научно-исследовательский семинар» — экзаменов в окне не встретилось, их точное написание не подтверждено.

**СОП** (`getCourseEvaluationStatus`): колонки `["#","Период","Дата начала","Дата окончания","Статус"]`; даты вида `"23:59 25.10.2026 по московскому времени"` (**время перед датой**); статус «Анкета доступна».

**Форматы дат:** уведомления ЕЛК — `"2026-09-17"`; заявки (`updated`) — `"2026-09-17T09:58:51+03:00"` (с зоной); задачи ЕЛК — `count: 0`, форма не подтверждена.

**Побочное наблюдение:** при каждом запуске `openAuthenticatedPage("https://edu.hse.ru/my/courses.php")` печатает в stderr «страница … не отрендерилась за таймаут при проверке логина», хотя данные приходят. Существующее поведение, не часть этого плана; зафиксировать в PROGRESS.md как наблюдение (Task 8).

## Global Constraints

- **Тестов и линтера в проекте нет по решению проекта (CLAUDE.md) — не добавлять** (ни фреймворк, ни `tests/`, ни скрипты в `package.json`). «Тесты» этого плана — одноразовые скрипты в scratchpad, они **не коммитятся**.
- Проверка: `npm run build` (чисто), изолированные скрипты через `dist/`, живая проверка.
- Записывающих операций не добавлять.
- Страницы открывать только через `openAuthenticatedPage` (внутри клиентских функций); не держать несколько страниц в одном вызове. Лимитер: 3 одновременных, ≥300 мс между открытиями.
- RUZ не кэшируется; агрегат сам не кэшируется.
- Не копировать `.env` и `storage/` в воркtree. `.env` лежит в `.env` проекта; скрипты читают из него только `HSE_EMAIL`/`HSE_PASSWORD` в `process.env`, ничего не печатают.
- В вывод скриптов не попадают токены, пароли, ФИО, email. Письма и их отправители не печатаются; в текстах ошибок email маскируется.
- Комментарии и документация — по-русски, в стиле окружающего кода. Время — локальное (как `src/date-utils.ts`), ISO со смещением.
- Коммиты — с трейлером `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Рабочий каталог: `<путь-к-проекту>\.claude\worktrees\update` (ветка `worktree-update`).
- Scratchpad: `<scratchpad>` (далее `$SP`). Там уже лежат `common.mjs`, `probe.mjs`, `probe2.mjs`, `probe3.mjs`.

## Review Focus

Входы и отказы, которые спецификация подразумевает, но которые легко сломать; каждый пин закреплён за задачей-владельцем.

1. **Просроченное несданное задание не пропадает**, даже если сдача закрыта (`overdue: true`, `actionable: false`); фильтра по `actionable` нет. Task 4 (`check-sources`) и Task 7 (живая проверка).
2. **Дата без времени** («15 октября 2026») → срок = конец дня 23:59, а не 00:00; **время перед датой** в СОП («23:59 25.10.2026») читается правильно; ISO с зоной (`+03:00`) не сдвигается на зону машины. Task 2.
3. **Ночь 00:00–02:59 по МСК:** границы «сегодня» считаются по локальным компонентам, не по UTC. Task 2.
4. **Фильтр `courses`, не нашедший ни одного курса** → ошибка источника со списком доступных курсов, а не тихий пустой результат; скрытые/завершённые курсы по умолчанию не попадают. Task 2.
5. **Все источники упали / завис один** → `DigestResult` с пустым `items` и ошибками в `sources`, без исключения; завис — по таймауту, остальные источники отдаются. Task 5.

---

## Task 1: Экспорт `fetchMoodleAjax` и запись результатов зондирования в спецификацию

**Files:**
- Modify: `src/services/lms/client.ts:35` (добавить `export`)
- Modify: `docs/superpowers/specs/2026-10-14-summaries-planning-design.md` (§13)
- Проверить наличие вне репозитория: `$SP/common.mjs` (создаётся ниже, если его нет)

**Interfaces:**
- Produces: `fetchMoodleAjax<T>(page: Page, methodname: string, args: Record<string, unknown>): Promise<T>` экспортируется из `src/services/lms/client.ts`; `$SP/common.mjs` экспортирует `WT`, `dist(relPath)`, `loadEnv()`, `shape(value)`, `trunc(value, n)`.

- [ ] **Step 1: Проверить базовую сборку**

Run: `npm run build`
Expected: без ошибок (node_modules резолвятся из `<путь-к-проекту>\node_modules`). Если `tsc` не найден — остановиться и сообщить пользователю, `node_modules` не копировать.

- [ ] **Step 2: Экспортировать `fetchMoodleAjax`**

В `src/services/lms/client.ts` заменить `async function fetchMoodleAjax<T>(` на `export async function fetchMoodleAjax<T>(`.

- [ ] **Step 3: Пересобрать**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 4: Убедиться, что `$SP/common.mjs` существует; иначе создать**

```js
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WT = "<путь-к-проекту>/.claude/worktrees/update";
export const dist = (p) => import(pathToFileURL(path.join(WT, "dist", p)).href);

// Берём только логин/пароль SSO; ничего не печатаем. Почтовый пароль агрегаторам не нужен.
export function loadEnv() {
  const text = fs.readFileSync("<путь-к-проекту>/.env", "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(HSE_EMAIL|HSE_PASSWORD)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Только форма значения: ключи и типы, без содержимого.
export function shape(v, depth = 0) {
  if (Array.isArray(v)) {
    return `array(${v.length})` + (v.length && depth < 2 ? `<${shape(v[0], depth + 1)}>` : "");
  }
  if (v && typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => `${k}:${depth < 2 ? shape(x, depth + 1) : typeof x}`).join(", ") + "}";
  }
  return v === null ? "null" : typeof v;
}

export const trunc = (s, n = 70) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
```

- [ ] **Step 5: Заменить §13 спецификации результатами зондирования**

Секцию «13. Открытые вопросы реализации» заменить на «13. Результаты живого зондирования (2026-10-14)» с содержанием раздела «Результаты живого зондирования» этого плана (календарь работает; семантика `overdue`/`actionable`; сданное не возвращается; форматы расписания, СОП, дат; что осталось не подтверждено: точное написание `lesson_type` экзаменов, форма задачи ЕЛК). Только форма и форматы, без персональных данных.

- [ ] **Step 6: Commit**

```bash
git add src/services/lms/client.ts docs/superpowers/specs/2026-10-14-summaries-planning-design.md
git commit -F - <<'EOF'
Export fetchMoodleAjax and record live probing results in the digest spec

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 2: Типы и чистые функции разбора

**Files:**
- Create: `src/services/digest/types.ts`
- Create: `src/services/digest/parse.ts`
- Create (вне репозитория): `$SP/check-parse.mjs`

**Interfaces:**
- Consumes: `CourseOverview` из `src/services/lms/client.ts` (поля `id`, `fullname`, `shortname`, `enddate: string | null`, `visible`, `hidden`).
- Produces (экспортируется из `types.ts` / `parse.ts`):
  - `ItemKind`, `DigestItem`, `SourceStatus`, `DigestResult`, `CollectorResult`, `DateRange`, `CourseFilter`
  - `scanDates(text: string, opts?: { endOfDayIfNoTime?: boolean }): Date[]`
  - `parseDateTime(text: string, opts?: { endOfDayIfNoTime?: boolean }): Date | null`
  - `combineDateAndTime(dateText: string, timeText: string | null | undefined): Date | null`
  - `toLocalIso(d: Date): string`, `startOfDay(d: Date): Date`, `endOfDay(d: Date): Date`
  - `isExamType(lessonType: string | undefined): boolean`
  - `sortItems(items: DigestItem[]): DigestItem[]`
  - `selectCourses(all: CourseOverview[], filter: CourseFilter | undefined, now: Date): CourseOverview[]`

- [ ] **Step 1: Создать `src/services/digest/types.ts`**

```ts
/** Тип элемента сводки. */
export type ItemKind =
  | "lesson"
  | "exam"
  | "assignment"
  | "lms_activity"
  | "elk_window"
  | "elk_task"
  | "elk_claim"
  | "lms_message"
  | "notification";

export interface DigestItem {
  kind: ItemKind;
  /**
   * Момент, к которому нужно успеть / когда состоится (ISO 8601 с локальным смещением).
   * null — не распознан или не применим (письма, уведомления, заявки, задачи).
   */
  when: string | null;
  /** Конец занятия/окна. */
  until?: string;
  /** Момент прихода/обновления у информационных элементов (письма, уведомления, заявки). */
  received?: string;
  title: string;
  course?: string;
  place?: string;
  /** Имя коллектора: elk_schedule, ruz_schedule, lms_deadlines, ... */
  source: string;
  /** true только для просроченных и несданных работ (в т.ч. когда сдача уже закрыта). */
  overdue?: boolean;
  unread?: boolean;
  /** isImportant уведомления ЕЛК. */
  important?: boolean;
  url?: string;
  /** Нераспознанные/сопутствующие поля источника. */
  raw?: Record<string, unknown>;
}

export interface SourceStatus {
  status: "ok" | "error" | "skipped";
  error?: string;
  /** Нефатальные замечания источника. */
  warnings?: string[];
  ms: number;
}

export interface DigestResult {
  generatedAt: string;
  window: { from: string; to: string };
  items: DigestItem[];
  sources: Record<string, SourceStatus>;
}

/** Что возвращает коллектор источника. */
export interface CollectorResult {
  items: DigestItem[];
  warnings?: string[];
}

export interface DateRange {
  from: Date;
  to: Date;
}

/** Элементы фильтра курсов: число — точный id, строка — подстрока названия. */
export type CourseFilter = Array<string | number>;
```

- [ ] **Step 2: Создать `src/services/digest/parse.ts`**

```ts
import type { CourseOverview } from "../lms/client.js";
import type { CourseFilter, DigestItem } from "./types.js";

const MONTHS: Record<string, number> = {
  января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5,
  июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Необязательное время после даты: «23:59», «в 23:59», «T10:30:00», «11:59 pm». Группы 4–6.
const TIME = String.raw`(?:(?:[,\s]+|T)(?:в\s+)?(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap]m))?)?`;

type Ymd = [year: number, month: number, day: number];

interface Hit {
  ymd: Ymd;
  hours?: number;
  minutes?: number;
  meridiem?: string;
}

const timeAfter = (m: RegExpMatchArray): Partial<Hit> =>
  m[4] !== undefined ? { hours: +m[4], minutes: +m[5], meridiem: m[6] } : {};

const PATTERNS: Array<{ re: RegExp; read: (m: RegExpMatchArray) => Hit | null }> = [
  // 2026-10-14, 2026.10.14 (формат РУЗ), 2026-10-14T10:30:00
  {
    re: new RegExp(String.raw`(\d{4})[-.](\d{1,2})[-.](\d{1,2})` + TIME, "gi"),
    read: (m) => ({ ymd: [+m[1], +m[2] - 1, +m[3]], ...timeAfter(m) }),
  },
  // 14.10.2026 [10:30]
  {
    re: new RegExp(String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})` + TIME, "gi"),
    read: (m) => ({ ymd: [+m[3], +m[2] - 1, +m[1]], ...timeAfter(m) }),
  },
  // 15 октября 2026 [г.] [23:59], 15 October 2026 (день недели перед датой игнорируется)
  {
    re: new RegExp(String.raw`(\d{1,2})\s+([a-zа-яё]+)\.?\s+(\d{4})(?:\s*г\.?)?` + TIME, "gi"),
    read: (m) => {
      const month = MONTHS[m[2].toLowerCase()];
      return month === undefined ? null : { ymd: [+m[3], month, +m[1]], ...timeAfter(m) };
    },
  },
  // «23:59 25.10.2026 по московскому времени» (формат окон СОП в ЕЛК): время ПЕРЕД датой
  {
    re: /(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/gi,
    read: (m) => ({ ymd: [+m[5], +m[4] - 1, +m[3]], hours: +m[1], minutes: +m[2] }),
  },
];

// Полный ISO с явной зоной (`2026-09-17T09:58:51+03:00`, `...Z`) разбирается движком и не
// переинтерпретируется в локальной зоне машины.
const ISO_WITH_ZONE = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\s*$/i;

function toDate(hit: Hit, endOfDayIfNoTime: boolean): Date | null {
  const [y, mo, d] = hit.ymd;
  let hours = 0;
  let minutes = 0;
  if (hit.hours !== undefined) {
    hours = hit.hours;
    minutes = hit.minutes ?? 0;
    const meridiem = hit.meridiem?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (endOfDayIfNoTime) {
    // Срок без времени — «в этот день»; 00:00 сделал бы задание просроченным с утра дня сдачи.
    hours = 23;
    minutes = 59;
  }
  const date = new Date(y, mo, d, hours, minutes, 0, 0);
  // new Date нормализует «31 февраля» в март — такие значения отбрасываем.
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  return date;
}

/** Все даты, найденные в тексте, в порядке появления (локальное время). */
export function scanDates(text: string, opts: { endOfDayIfNoTime?: boolean } = {}): Date[] {
  const normalized = text.replace(/\u00a0/g, " ");
  const found: Array<{ index: number; end: number; date: Date }> = [];
  for (const { re, read } of PATTERNS) {
    for (const m of normalized.matchAll(re)) {
      const hit = read(m);
      if (!hit) continue;
      const date = toDate(hit, opts.endOfDayIfNoTime ?? false);
      if (!date) continue;
      const index = m.index ?? 0;
      found.push({ index, end: index + m[0].length, date });
    }
  }
  found.sort((a, b) => a.index - b.index);
  // Разные шаблоны могут зацепить один и тот же фрагмент — оставляем непересекающиеся.
  const result: Date[] = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.index < lastEnd) continue;
    result.push(f.date);
    lastEnd = f.end;
  }
  return result;
}

export function parseDateTime(text: string, opts?: { endOfDayIfNoTime?: boolean }): Date | null {
  if (ISO_WITH_ZONE.test(text)) {
    const t = Date.parse(text.trim());
    if (!Number.isNaN(t)) return new Date(t);
  }
  return scanDates(text, opts)[0] ?? null;
}

/**
 * Дата + время из двух полей расписания. Время может прийти как «10:30», «10:30:00» или как
 * полная дата-время — тогда она важнее отдельного поля даты.
 */
export function combineDateAndTime(dateText: string, timeText: string | null | undefined): Date | null {
  if (timeText && /\d{4}[-.]\d|\d\.\d{1,2}\.\d{4}/.test(timeText)) {
    const full = parseDateTime(timeText);
    if (full) return full;
  }
  const day = parseDateTime(dateText);
  if (!day) return null;
  const t = timeText?.match(/(\d{1,2}):(\d{2})/);
  if (!t) return day;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), +t[1], +t[2], 0, 0);
}

/** ISO 8601 с локальным смещением (не UTC — важно для ночи по МСК, см. date-utils.ts). */
export function toLocalIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
export const endOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** Экзамен/зачёт по типу занятия; «консультация к экзамену» экзаменом не считается. */
export function isExamType(lessonType: string | undefined): boolean {
  return !!lessonType && /экзамен|зач[её]т|коллоквиум|exam/i.test(lessonType) && !/консультац/i.test(lessonType);
}

/** Просроченные первыми, затем по времени, затем элементы без даты. Стабильная. */
export function sortItems(items: DigestItem[]): DigestItem[] {
  const rank = (i: DigestItem) => (i.overdue ? 0 : i.when ? 1 : 2);
  return [...items].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.when && b.when) return Date.parse(a.when) - Date.parse(b.when);
    return 0;
  });
}

/**
 * Актуальные курсы (видимые, не скрытые, `enddate` не прошёл) и необязательный фильтр по id или
 * подстроке названия. Фильтр, не нашедший ничего, — ошибка со списком доступных курсов:
 * молчаливый пустой результат выглядел бы как «дедлайнов нет».
 */
export function selectCourses(all: CourseOverview[], filter: CourseFilter | undefined, now: Date): CourseOverview[] {
  const actual = all.filter(
    (c) => c.visible && !c.hidden && (c.enddate === null || Date.parse(c.enddate) >= now.getTime())
  );
  if (!filter || filter.length === 0) return actual;
  const picked = actual.filter((c) =>
    filter.some((f) =>
      typeof f === "number"
        ? c.id === f
        : c.fullname.toLowerCase().includes(f.toLowerCase()) || c.shortname.toLowerCase().includes(f.toLowerCase())
    )
  );
  if (picked.length === 0) {
    throw new Error(
      `Ни один актуальный курс не подошёл под фильтр ${JSON.stringify(filter)}. ` +
        `Доступные курсы: ${actual.map((c) => `${c.id} — ${c.fullname}`).join("; ") || "нет"}`
    );
  }
  return picked;
}
```

- [ ] **Step 3: Создать `$SP/check-parse.mjs`**

```js
import assert from "node:assert/strict";
import { dist } from "./common.mjs";
const p = await dist("services/digest/parse.js");

const ymdhm = (d) => d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].join("-");

// Форматы дат, реально встреченные на ВШЭ
assert.equal(ymdhm(p.parseDateTime("понедельник, 5 октября 2026, 23:59")), "2026-10-5-23-59");
assert.equal(ymdhm(p.parseDateTime("среда, 15 октября 2026, 23:59")), "2026-10-15-23-59");
assert.equal(ymdhm(p.parseDateTime("15 октября 2026 г. в 09:05")), "2026-10-15-9-5");
assert.equal(ymdhm(p.parseDateTime("14.10.2026 10:30")), "2026-10-14-10-30");
assert.equal(ymdhm(p.parseDateTime("2026-10-14T10:30:00")), "2026-10-14-10-30");
assert.equal(ymdhm(p.parseDateTime("2026.10.14")), "2026-10-14-0-0");
assert.equal(ymdhm(p.parseDateTime("2026-09-17")), "2026-9-17-0-0");
assert.equal(ymdhm(p.parseDateTime("Wednesday, 15 October 2026, 11:59 PM")), "2026-10-15-23-59");
assert.equal(ymdhm(p.parseDateTime("1 January 2026, 12:05 AM")), "2026-1-1-0-5");
assert.equal(p.parseDateTime("31 февраля 2026"), null);
assert.equal(p.parseDateTime("нет даты"), null);
assert.equal(p.parseDateTime("5 штук 2026"), null);

// Review Focus 2: срок без времени = конец дня; время ПЕРЕД датой (СОП); ISO с зоной
assert.equal(ymdhm(p.parseDateTime("15 октября 2026", { endOfDayIfNoTime: true })), "2026-10-15-23-59");
assert.equal(ymdhm(p.parseDateTime("15 октября 2026")), "2026-10-15-0-0");
assert.equal(ymdhm(p.parseDateTime("23:59 25.10.2026 по московскому времени")), "2026-10-25-23-59");
assert.equal(ymdhm(p.parseDateTime("23:00 05.10.2026 по московскому времени")), "2026-10-5-23-0");
assert.equal(p.scanDates("23:00 05.10.2026 по московскому времени").length, 1);
assert.equal(
  p.parseDateTime("2026-09-17T09:58:51+03:00").getTime(),
  new Date("2026-09-17T09:58:51+03:00").getTime()
);

// Несколько дат в строке
const two = p.scanDates("с 01.10.2026 по 20.10.2026", { endOfDayIfNoTime: true });
assert.equal(two.length, 2);
assert.equal(ymdhm(two[1]), "2026-10-20-23-59");

// combineDateAndTime (формат расписания ЕЛК: «2026-10-14» + «13:00»)
assert.equal(ymdhm(p.combineDateAndTime("2026-10-14", "13:00")), "2026-10-14-13-0");
assert.equal(ymdhm(p.combineDateAndTime("2026.10.14", "10:30:00")), "2026-10-14-10-30");
assert.equal(ymdhm(p.combineDateAndTime("2026-10-14", "2026-10-14 11:00:00")), "2026-10-14-11-0");
assert.equal(ymdhm(p.combineDateAndTime("2026-10-14", null)), "2026-10-14-0-0");
assert.equal(p.combineDateAndTime("мусор", "10:30"), null);

// Review Focus 3: локальные границы, не UTC (00:30 локально остаётся 14-м числом)
const night = new Date(2026, 9, 14, 0, 30, 0);
assert.ok(p.toLocalIso(night).startsWith("2026-10-14T00:30:00"));
assert.match(p.toLocalIso(night), /[+-]\d\d:\d\d$/);
assert.equal(ymdhm(p.startOfDay(night)), "2026-10-14-0-0");
assert.equal(ymdhm(p.endOfDay(night)), "2026-10-14-23-59");

// Экзамены: реальные типы занятий не экзамены; консультация к экзамену — тоже нет
assert.equal(p.isExamType("Экзамен"), true);
assert.equal(p.isExamType("Зачёт с оценкой"), true);
assert.equal(p.isExamType("зачет"), true);
assert.equal(p.isExamType("Консультация перед экзаменом"), false);
assert.equal(p.isExamType("Проведение семинаров (студенты)"), false);
assert.equal(p.isExamType("Лекция"), false);
assert.equal(p.isExamType(undefined), false);

// Сортировка: просроченные → по времени → без даты; порядок равных сохраняется
const it = (title, when, overdue) => ({ kind: "assignment", when, title, source: "t", ...(overdue ? { overdue } : {}) });
const sorted = p.sortItems([
  it("undated", null), it("later", "2026-10-16T10:00:00+03:00"), it("overdue-new", "2026-10-13T10:00:00+03:00", true),
  it("soon", "2026-10-15T10:00:00+03:00"), it("overdue-old", "2026-10-01T10:00:00+03:00", true),
]);
assert.deepEqual(sorted.map((x) => x.title), ["overdue-old", "overdue-new", "soon", "later", "undated"]);

// Review Focus 4: курсы
const now = new Date(2026, 9, 14, 12, 0);
const c = (id, fullname, o = {}) => ({ id, fullname, shortname: fullname.slice(0, 4), category: "", startdate: "", enddate: null, progress: null, isFavourite: false, hidden: false, visible: true, viewUrl: "", ...o });
const all = [
  c(1, "Матанализ"), c(2, "Алгебра"), c(3, "Старый курс", { enddate: new Date(2026, 5, 1).toISOString() }),
  c(4, "Скрытый", { hidden: true }), c(5, "Невидимый", { visible: false }),
  c(6, "Будущий", { enddate: new Date(2027, 0, 1).toISOString() }),
];
assert.deepEqual(p.selectCourses(all, undefined, now).map((x) => x.id), [1, 2, 6]);
assert.deepEqual(p.selectCourses(all, [2], now).map((x) => x.id), [2]);
assert.deepEqual(p.selectCourses(all, ["матан"], now).map((x) => x.id), [1]);
assert.throws(() => p.selectCourses(all, ["Старый"], now), /Доступные курсы:.*1 — Матанализ/);
assert.throws(() => p.selectCourses(all, [999], now), /Ни один актуальный курс/);

console.log("check-parse: OK");
```

- [ ] **Step 4: Собрать и запустить**

Run: `npm run build && node $SP/check-parse.mjs`
Expected: сборка чистая, вывод `check-parse: OK`. Падение ассерта — исправить `parse.ts`, не ассерт.

- [ ] **Step 5: Commit**

```bash
git add src/services/digest/types.ts src/services/digest/parse.ts
git commit -F - <<'EOF'
Add digest types and pure parsing helpers (dates, exam type, sorting, course filter)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 3: Календарь Moodle в клиенте LMS

**Files:**
- Modify: `src/services/lms/client.ts` (импорт `formatLocalDate`; новый блок после `listCoursesUncached`)

**Interfaces:**
- Consumes: `fetchMoodleAjax`, `openAuthenticatedPage`, `cached`, `TTL`, `BASE_URL`, `stripHtml`, `unixToIso` (всё уже в файле).
- Produces:
  ```ts
  export interface LmsActionEvent {
    id: number; name: string; module: string;       // module: modulename (assign, quiz, ...) или ""
    course: string; courseId: number | null;
    due: string;                                     // ISO UTC из timesort
    overdue: boolean;                                // флаг Moodle: просрочено и не завершено
    actionable: boolean; actionName: string; url: string | null;
  }
  export function listActionEvents(from: Date, to: Date): Promise<LmsActionEvent[]>;
  ```

- [ ] **Step 1: Добавить импорт**

В начало `src/services/lms/client.ts`, к остальным импортам:

```ts
import { formatLocalDate } from "../../date-utils.js";
```

- [ ] **Step 2: Добавить блок после `listCoursesUncached` (перед `interface RawMailPerson`)**

```ts
interface RawActionEvent {
  id: number;
  name: string;
  modulename?: string;
  timesort: number;
  overdue?: boolean;
  url?: string;
  course?: { id: number; fullname: string };
  action?: { name: string; actionable: boolean; url: string };
}

export interface LmsActionEvent {
  id: number;
  name: string;
  module: string;
  course: string;
  courseId: number | null;
  due: string;
  overdue: boolean;
  actionable: boolean;
  actionName: string;
  url: string | null;
}

const CALENDAR_PAGE_SIZE = 50;
const CALENDAR_MAX_PAGES = 6;

/**
 * События календаря Moodle «нужно действие» (сдать задание, пройти тест) за период — один
 * AJAX-запрос вместо обхода страницы заданий каждого курса; тот же сервис, что питает блок
 * «Таймлайн» дашборда. Проверено вживую 2026-10-14: сданные работы в ответ не попадают;
 * просроченное несданное приходит с `overdue: true` и `actionable: false` (сдача закрыта) —
 * поэтому по `actionable` фильтровать нельзя. Ключ кэша дневной гранулярности.
 */
export function listActionEvents(from: Date, to: Date): Promise<LmsActionEvent[]> {
  const key = `lms:calendar:${formatLocalDate(from, "-")}:${formatLocalDate(to, "-")}`;
  return cached(key, TTL.medium, () => listActionEventsUncached(from, to));
}

async function listActionEventsUncached(from: Date, to: Date): Promise<LmsActionEvent[]> {
  const page = await openAuthenticatedPage(`${BASE_URL}/my/courses.php`);
  try {
    const events: LmsActionEvent[] = [];
    let afterEventId = 0;
    for (let i = 0; i < CALENDAR_MAX_PAGES; i++) {
      const data = await fetchMoodleAjax<{ events: RawActionEvent[]; lastid?: number }>(
        page,
        "core_calendar_get_action_events_by_timesort",
        {
          timesortfrom: Math.floor(from.getTime() / 1000),
          timesortto: Math.floor(to.getTime() / 1000),
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
      afterEventId = data.lastid;
    }
    return events;
  } finally {
    await page.close();
  }
}
```

- [ ] **Step 3: Собрать**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 4: Живая проверка функции**

Создать `$SP/check-calendar.mjs`:

```js
import assert from "node:assert/strict";
import { dist, loadEnv } from "./common.mjs";
loadEnv();
const { closeBrowserSession } = await dist("auth/browser-session.js");
const lms = await dist("services/lms/client.js");
const from = new Date(Date.now() - 180 * 86400_000);
const to = new Date(Date.now() + 30 * 86400_000);
const t0 = Date.now();
const ev = await lms.listActionEvents(from, to);
const t1 = Date.now();
const again = await lms.listActionEvents(from, to);
const overdue = ev.filter((e) => e.overdue);
console.log("events:", ev.length, "overdue:", overdue.length,
  "overdue и actionable=false:", overdue.filter((e) => !e.actionable).length,
  "модули:", JSON.stringify([...new Set(ev.map((e) => e.module))]),
  "холодный:", t1 - t0, "мс; повтор:", Date.now() - t1, "мс; тот же объект:", ev === again);
assert.ok(ev.every((e) => typeof e.overdue === "boolean" && typeof e.due === "string"));
assert.equal(ev, again);
await closeBrowserSession();
```

Run: `node $SP/check-calendar.mjs`
Expected: без исключения; `overdue ≥ 1` и среди них есть `actionable=false` (на аккаунте 2026-10-14 — одно задание от 5 октября; если с тех пор его сдали или оно исчезло, число может быть 0 — это не ошибка кода, зафиксировать); повтор ≈ 0 мс, `тот же объект: true`.

- [ ] **Step 5: Commit**

```bash
git add src/services/lms/client.ts
git commit -F - <<'EOF'
Add Moodle calendar action events (incl. overdue flag) to the LMS client

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 4: Коллекторы источников

**Files:**
- Create: `src/services/digest/sources.ts`
- Create (вне репозитория): `$SP/check-sources.mjs`

**Interfaces:**
- Consumes: `elk.getSchedule/getNotifications/listRequests/listTasks/getCourseEvaluationStatus`, `lms.listCourses/listMessages/listActionEvents`, тип `LmsActionEvent`, `ruz.getStudentInfo/getSchedule`, `config.hseEmail`, всё из `parse.ts` и `types.ts`.
- Produces:
  ```ts
  export const OVERDUE_LOOKBACK_DAYS = 180;
  export function actionEventToItem(e: LmsActionEvent): DigestItem;
  export function windowToItem(row: Record<string, string>, now: Date): DigestItem | null;
  export interface Collectors {
    elkSchedule(range: DateRange): Promise<CollectorResult>;
    ruzSchedule(range: DateRange): Promise<CollectorResult>;
    lmsDeadlines(args: { range: DateRange; now: Date; courses?: CourseFilter }): Promise<CollectorResult>;
    lmsMessages(): Promise<CollectorResult>;
    elkNotifications(): Promise<CollectorResult>;
    elkClaims(): Promise<CollectorResult>;
    elkTasks(): Promise<CollectorResult>;
    elkWindows(now: Date): Promise<CollectorResult>;
  }
  export const realCollectors: Collectors;
  ```
  `lmsDeadlines` возвращает и просроченные (за `OVERDUE_LOOKBACK_DAYS`), и будущие до `range.to`; фильтрация по окну — в `client.ts`.

- [ ] **Step 1: Создать `src/services/digest/sources.ts`**

```ts
import { config } from "../../config.js";
import { addDays } from "../../date-utils.js";
import * as elk from "../elk/client.js";
import * as lms from "../lms/client.js";
import type { LmsActionEvent } from "../lms/client.js";
import * as ruz from "../ruz/client.js";
import {
  combineDateAndTime,
  isExamType,
  parseDateTime,
  scanDates,
  selectCourses,
  startOfDay,
  toLocalIso,
} from "./parse.js";
import type { CollectorResult, CourseFilter, DateRange, DigestItem } from "./types.js";

/** На сколько дней назад искать просроченные несданные работы. */
export const OVERDUE_LOOKBACK_DAYS = 180;

const TEXT_LIMIT = 300;
// Статусы окна СОП, при которых действие уже не требуется. Подтверждён только «Анкета доступна».
const WINDOW_DONE = /заполнен|пройден|заверш|закрыт/i;

const nonEmpty = (parts: Array<string | null | undefined>): string | undefined => {
  const joined = parts.filter((p): p is string => !!p && p.trim() !== "").join(", ");
  return joined || undefined;
};
const truncate = (s: string): string => (s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT)}…` : s);
const isoOrUndefined = (text: string): string | undefined => {
  const d = parseDateTime(text);
  return d ? toLocalIso(d) : undefined;
};

export interface Collectors {
  elkSchedule(range: DateRange): Promise<CollectorResult>;
  ruzSchedule(range: DateRange): Promise<CollectorResult>;
  lmsDeadlines(args: { range: DateRange; now: Date; courses?: CourseFilter }): Promise<CollectorResult>;
  lmsMessages(): Promise<CollectorResult>;
  elkNotifications(): Promise<CollectorResult>;
  elkClaims(): Promise<CollectorResult>;
  elkTasks(): Promise<CollectorResult>;
  elkWindows(now: Date): Promise<CollectorResult>;
}

async function elkSchedule(range: DateRange): Promise<CollectorResult> {
  const days = await elk.getSchedule(range.from, range.to);
  const items: DigestItem[] = [];
  for (const day of days) {
    for (const l of day.lessons ?? []) {
      const start = combineDateAndTime(day.date, l.begin_time);
      const end = combineDateAndTime(day.date, l.end_time);
      const place = nonEmpty([l.auditorium, l.building]);
      items.push({
        kind: isExamType(l.lesson_type) ? "exam" : "lesson",
        when: start ? toLocalIso(start) : null,
        ...(end ? { until: toLocalIso(end) } : {}),
        title: l.name,
        ...(place ? { place } : {}),
        source: "elk_schedule",
        ...(l.url1 ? { url: l.url1 } : {}),
        raw: { lessonType: l.lesson_type, lecturer: l.lecturer },
      });
    }
  }
  return { items };
}

// Запасной источник: только когда ЕЛК-расписание не ответило (см. client.ts). Вне сети ВШЭ
// сам упадёт с понятной ошибкой ruz/client.ts — это тоже статус источника, а не отказ тула.
async function ruzSchedule(range: DateRange): Promise<CollectorResult> {
  const info = await ruz.getStudentInfo(config.hseEmail);
  const lessons = await ruz.getSchedule("student", info.id, range.from, range.to);
  const items: DigestItem[] = lessons.map((l) => {
    const start = combineDateAndTime(l.date, l.beginLesson);
    const end = combineDateAndTime(l.date, l.endLesson);
    const place = nonEmpty([l.auditorium, l.building]);
    return {
      kind: isExamType(l.kindOfWork) ? "exam" : "lesson",
      when: start ? toLocalIso(start) : null,
      ...(end ? { until: toLocalIso(end) } : {}),
      title: l.discipline,
      ...(place ? { place } : {}),
      source: "ruz_schedule",
      ...(l.url1 ? { url: l.url1 } : {}),
      raw: { lessonType: l.kindOfWork, lecturer: l.lecturer },
    };
  });
  return { items };
}

/**
 * Событие календаря → элемент сводки. Календарь возвращает только несданное; `overdue` — флаг
 * Moodle (просрочено и не завершено). `actionable` в отбор НЕ участвует: у просроченного
 * задания со сданным окном приёма он false, а пользователь хочет видеть такие работы.
 */
export function actionEventToItem(e: LmsActionEvent): DigestItem {
  return {
    kind: e.module === "assign" ? "assignment" : "lms_activity",
    when: toLocalIso(new Date(e.due)),
    title: e.name,
    ...(e.course ? { course: e.course } : {}),
    source: "lms_deadlines",
    ...(e.overdue ? { overdue: true } : {}),
    ...(e.url ? { url: e.url } : {}),
    raw: { module: e.module, action: e.actionName, actionable: e.actionable },
  };
}

async function lmsDeadlines(args: { range: DateRange; now: Date; courses?: CourseFilter }): Promise<CollectorResult> {
  const { range, now, courses } = args;
  const selected = selectCourses(await lms.listCourses(), courses, now);
  const ids = new Set(selected.map((c) => c.id));
  const lookback = addDays(startOfDay(now), -OVERDUE_LOOKBACK_DAYS);
  const events = await lms.listActionEvents(lookback, range.to);
  return {
    items: events
      .filter((e) => e.courseId !== null && ids.has(e.courseId))
      .map((e) => actionEventToItem(e)),
  };
}

async function lmsMessages(): Promise<CollectorResult> {
  const messages = await lms.listMessages(50);
  return {
    items: messages
      .filter((m) => m.unread)
      .map((m) => ({
        kind: "lms_message" as const,
        when: null,
        received: toLocalIso(new Date(m.time)),
        title: m.subject,
        course: m.course,
        source: "lms_messages",
        unread: true,
        raw: { sender: m.sender, attachments: m.numAttachments },
      })),
  };
}

async function elkNotifications(): Promise<CollectorResult> {
  const { notifications } = await elk.getNotifications(50);
  return {
    items: notifications
      .filter((n) => !n.isRead)
      .map((n) => {
        const received = isoOrUndefined(n.date);
        return {
          kind: "notification" as const,
          when: null,
          ...(received ? { received } : {}),
          title: n.title,
          source: "elk_notifications",
          unread: true,
          important: n.isImportant,
          raw: { text: truncate(n.text) },
        };
      }),
  };
}

async function elkClaims(): Promise<CollectorResult> {
  const { requests } = await elk.listRequests();
  return {
    items: requests
      .filter((c) => c.active)
      .map((c) => {
        const received = isoOrUndefined(c.updated);
        return {
          kind: "elk_claim" as const,
          when: null,
          ...(received ? { received } : {}),
          title: truncate(`${c.service}: ${c.text}`),
          source: "elk_claims",
          ...(c.url ? { url: c.url } : {}),
          raw: { num: c.num, state: c.stateName, created: c.created },
        };
      }),
  };
}

// Форма задачи на реальных данных не подтверждена (на проверенном аккаунте задач нет), поэтому
// объект кладётся в raw как есть, а title берётся из первого строкового поля title/name/text.
async function elkTasks(): Promise<CollectorResult> {
  const { data } = await elk.listTasks();
  return {
    items: data.map((t) => {
      const obj: Record<string, unknown> =
        t && typeof t === "object" ? (t as Record<string, unknown>) : { value: t };
      const title = ["title", "name", "text"]
        .map((k) => obj[k])
        .find((v): v is string => typeof v === "string" && v.trim() !== "");
      return {
        kind: "elk_task" as const,
        when: null,
        title: title ?? "Задача ЕЛК",
        source: "elk_tasks",
        raw: obj,
      };
    }),
  };
}

/**
 * Строка окна СОП → элемент. Колонки (подтверждено вживую): «#», «Период», «Дата начала»,
 * «Дата окончания», «Статус»; даты вида «23:59 25.10.2026 по московскому времени». Срок —
 * «Дата окончания», иначе самая поздняя дата в строке. Закрытые окна (срок в прошлом или статус
 * «заполнена» и т.п.) отбрасываются; без распознанной даты — остаётся с `when: null`.
 */
export function windowToItem(row: Record<string, string>, now: Date): DigestItem | null {
  const entries = Object.entries(row).filter(([, v]) => v && v.trim() !== "");
  const byKey = (re: RegExp): string | undefined => entries.find(([k]) => re.test(k))?.[1];

  const status = byKey(/статус|status/i);
  if (status && WINDOW_DONE.test(status)) return null;

  const endText = byKey(/окончан|end/i);
  const explicitEnd = endText ? parseDateTime(endText, { endOfDayIfNoTime: true }) : null;
  const all = entries.flatMap(([, v]) => scanDates(v, { endOfDayIfNoTime: true }));
  const end = explicitEnd ?? (all.length ? new Date(Math.max(...all.map((d) => d.getTime()))) : null);
  if (end && end.getTime() < now.getTime()) return null;

  const period = byKey(/период|назван|period|name/i) ?? entries.find(([, v]) => v.length > 3)?.[1] ?? "окно";
  return {
    kind: "elk_window",
    when: end ? toLocalIso(end) : null,
    title: `Оценка курсов (СОП): ${period}`,
    source: "elk_windows",
    raw: row,
  };
}

async function elkWindows(now: Date): Promise<CollectorResult> {
  const rows = await elk.getCourseEvaluationStatus();
  return {
    items: rows.map((r) => windowToItem(r, now)).filter((i): i is DigestItem => i !== null),
  };
}

export const realCollectors: Collectors = {
  elkSchedule,
  ruzSchedule,
  lmsDeadlines,
  lmsMessages,
  elkNotifications,
  elkClaims,
  elkTasks,
  elkWindows,
};
```

- [ ] **Step 2: Собрать**

Run: `npm run build`
Expected: без ошибок. (Типовые риски: поля `ElkLesson`/`Lesson` обязательны; `l.url1` у РУЗ — `string | undefined`.)

- [ ] **Step 3: Создать `$SP/check-sources.mjs`**

```js
import assert from "node:assert/strict";
import { dist } from "./common.mjs";
const s = await dist("services/digest/sources.js");

const now = new Date(2026, 9, 14, 12, 0);

// Review Focus 1: просроченное несданное задание со ЗАКРЫТОЙ сдачей остаётся и помечено overdue
const overdue = s.actionEventToItem({
  id: 1, name: "Домашнее задание по блоку 1", module: "assign", course: "Создание контента",
  courseId: 299092, due: "2026-10-05T20:59:00.000Z", overdue: true, actionable: false,
  actionName: "", url: "https://edu.hse.ru/mod/assign/view.php?id=1",
});
assert.equal(overdue.kind, "assignment");
assert.equal(overdue.overdue, true);
assert.equal(overdue.course, "Создание контента");
assert.equal(overdue.raw.actionable, false);
assert.match(overdue.when, /^2026-10-0[56]T\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);

// Будущий тест: lms_activity, без флага overdue; actionable=false (до открытия) не скрывает
const quiz = s.actionEventToItem({
  id: 2, name: "Экзамен 26 октября", module: "quiz", course: "Основы государственности",
  courseId: 1001, due: "2026-10-26T07:30:00.000Z", overdue: false, actionable: false,
  actionName: "", url: null,
});
assert.equal(quiz.kind, "lms_activity");
assert.equal("overdue" in quiz, false);
assert.equal("url" in quiz, false);

// Окно СОП (реальная форма строки)
const row = {
  "#": "1", "Период": "1 модуль 2026/2027 учебного года",
  "Дата начала": "23:00 05.10.2026 по московскому времени",
  "Дата окончания": "23:59 25.10.2026 по московскому времени",
  "Статус": "Анкета доступна",
};
const w = s.windowToItem(row, now);
assert.equal(w.kind, "elk_window");
assert.equal(w.title, "Оценка курсов (СОП): 1 модуль 2026/2027 учебного года");
assert.ok(w.when.startsWith("2026-10-25T23:59:00"));
assert.equal(s.windowToItem({ ...row, "Статус": "Анкета заполнена" }, now), null);
assert.equal(s.windowToItem({ ...row, "Дата окончания": "23:59 01.10.2026 по московскому времени" }, now), null);
const undated = s.windowToItem({ "Период": "Весна", "Статус": "Анкета доступна" }, now);
assert.equal(undated.when, null);

console.log("check-sources: OK");
```

- [ ] **Step 4: Запустить**

Run: `node $SP/check-sources.mjs`
Expected: `check-sources: OK`. Падение — править `sources.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/services/digest/sources.ts
git commit -F - <<'EOF'
Add digest source collectors (schedule, LMS deadlines incl. overdue, inbox, ELK windows)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 5: Сборка агрегата с частичными отказами

**Files:**
- Create: `src/services/digest/client.ts`
- Create (вне репозитория): `$SP/check-digest.mjs`

**Interfaces:**
- Consumes: `Collectors`, `realCollectors` из `sources.ts`; `types.ts`; `startOfDay`, `endOfDay`, `toLocalIso`, `sortItems` из `parse.ts`; `addDays` из `date-utils.ts`.
- Produces:
  ```ts
  export interface DigestPlan {
    now: Date;
    window: DateRange;
    schedule: { range: DateRange; lessonsUntil: Date | null; examsUntil: Date };
    deadlinesUntil: Date;
    courses?: CourseFilter;
    includeUndated: boolean;
    include: { lmsMessages: boolean; notifications: boolean; claims: boolean; tasks: boolean };
    sourceTimeoutMs?: number;   // по умолчанию 20_000
  }
  export function buildDigest(plan: DigestPlan, src?: Collectors): Promise<DigestResult>;
  export function getToday(now?: Date): Promise<DigestResult>;
  export function getWeek(now?: Date): Promise<DigestResult>;
  export function getDeadlines(opts?: { days?: number; courses?: CourseFilter }, now?: Date): Promise<DigestResult>;
  ```

- [ ] **Step 1: Создать `src/services/digest/client.ts`**

```ts
import { addDays } from "../../date-utils.js";
import { endOfDay, sortItems, startOfDay, toLocalIso } from "./parse.js";
import { realCollectors, type Collectors } from "./sources.js";
import type { CollectorResult, CourseFilter, DateRange, DigestItem, DigestResult, SourceStatus } from "./types.js";

const DEFAULT_SOURCE_TIMEOUT_MS = 20_000;

export interface DigestPlan {
  now: Date;
  /** Окно, которое покрывает сводка (в `DigestResult.window`). */
  window: DateRange;
  schedule: {
    /** Что запрашивать у ЕЛК/РУЗ. */
    range: DateRange;
    /** Занятия показывать до этого момента; null — занятия не нужны, только экзамены. */
    lessonsUntil: Date | null;
    examsUntil: Date;
  };
  deadlinesUntil: Date;
  courses?: CourseFilter;
  /** Дедлайны без распознанной даты: только в my_deadlines — в сводках дня/недели это шум. */
  includeUndated: boolean;
  include: { lmsMessages: boolean; notifications: boolean; claims: boolean; tasks: boolean };
  sourceTimeoutMs?: number;
}

interface SourceRun {
  name: string;
  items: DigestItem[];
  status: SourceStatus;
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`источник ${name} не ответил за ${ms / 1000} с`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Запускает коллектор; никогда не бросает — отказ превращается в статус источника. */
async function runSource(name: string, fn: () => Promise<CollectorResult>, timeoutMs: number): Promise<SourceRun> {
  const started = Date.now();
  try {
    const result = await withTimeout(fn(), timeoutMs, name);
    return {
      name,
      items: result.items,
      status: {
        status: "ok",
        ms: Date.now() - started,
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      },
    };
  } catch (err) {
    return {
      name,
      items: [],
      status: { status: "error", error: err instanceof Error ? err.message : String(err), ms: Date.now() - started },
    };
  }
}

function keep(item: DigestItem, plan: DigestPlan): boolean {
  const dayStart = plan.window.from.getTime();
  const when = item.when ? Date.parse(item.when) : null;
  switch (item.kind) {
    case "lesson":
      if (plan.schedule.lessonsUntil === null) return false;
      // Время не распознано — оставляем: молча терять занятие хуже, чем показать без времени.
      return when === null || (when >= dayStart && when <= plan.schedule.lessonsUntil.getTime());
    case "exam":
      return when === null || (when >= dayStart && when <= plan.schedule.examsUntil.getTime());
    case "assignment":
    case "lms_activity":
    case "elk_window":
      // Просроченные несданные показываются всегда — по явному требованию пользователя.
      if (item.overdue) return true;
      if (when === null) return plan.includeUndated;
      return when <= plan.deadlinesUntil.getTime();
    default:
      return true;
  }
}

/**
 * Собирает сводку: коллекторы идут параллельно, отказ одного не влияет на остальные. РУЗ
 * запрашивается только если упало расписание ЕЛК (иначе в сводке были бы дубли занятий, а вне
 * сети ВШЭ — лишний заведомо неудачный запрос). `src` внедряется для проверки без сети.
 */
export async function buildDigest(plan: DigestPlan, src: Collectors = realCollectors): Promise<DigestResult> {
  const { now } = plan;
  const timeoutMs = plan.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const run = (name: string, fn: () => Promise<CollectorResult>) => runSource(name, fn, timeoutMs);
  const ifIncluded = <T>(cond: boolean, make: () => Promise<T>): Promise<T[]> =>
    cond ? make().then((r) => [r]) : Promise.resolve([]);

  const scheduleChain = (async (): Promise<SourceRun[]> => {
    const primary = await run("elk_schedule", () => src.elkSchedule(plan.schedule.range));
    if (primary.status.status !== "error") {
      return [primary, { name: "ruz_schedule", items: [], status: { status: "skipped", ms: 0 } }];
    }
    return [primary, await run("ruz_schedule", () => src.ruzSchedule(plan.schedule.range))];
  })();

  const runs = (
    await Promise.all([
      scheduleChain,
      ifIncluded(true, () =>
        run("lms_deadlines", () =>
          src.lmsDeadlines({
            range: { from: startOfDay(now), to: plan.deadlinesUntil },
            now,
            courses: plan.courses,
          })
        )
      ),
      ifIncluded(true, () => run("elk_windows", () => src.elkWindows(now))),
      ifIncluded(plan.include.lmsMessages, () => run("lms_messages", () => src.lmsMessages())),
      ifIncluded(plan.include.notifications, () => run("elk_notifications", () => src.elkNotifications())),
      ifIncluded(plan.include.claims, () => run("elk_claims", () => src.elkClaims())),
      ifIncluded(plan.include.tasks, () => run("elk_tasks", () => src.elkTasks())),
    ])
  ).flat();

  const sources: Record<string, SourceStatus> = {};
  const items: DigestItem[] = [];
  for (const r of runs) {
    sources[r.name] = r.status;
    items.push(...r.items.filter((i) => keep(i, plan)));
  }

  return {
    generatedAt: toLocalIso(now),
    window: { from: toLocalIso(plan.window.from), to: toLocalIso(plan.window.to) },
    items: sortItems(items),
    sources,
  };
}

export function getToday(now: Date = new Date()): Promise<DigestResult> {
  const from = startOfDay(now);
  const todayEnd = endOfDay(now);
  const tomorrowEnd = endOfDay(addDays(now, 1));
  return buildDigest({
    now,
    window: { from, to: tomorrowEnd },
    schedule: { range: { from, to: tomorrowEnd }, lessonsUntil: todayEnd, examsUntil: tomorrowEnd },
    deadlinesUntil: tomorrowEnd,
    includeUndated: false,
    include: { lmsMessages: true, notifications: true, claims: true, tasks: true },
  });
}

export function getWeek(now: Date = new Date()): Promise<DigestResult> {
  const from = startOfDay(now);
  const end = endOfDay(addDays(now, 6)); // сегодня + 6 дней = 7 дней
  return buildDigest({
    now,
    window: { from, to: end },
    schedule: { range: { from, to: end }, lessonsUntil: end, examsUntil: end },
    deadlinesUntil: end,
    includeUndated: false,
    include: { lmsMessages: false, notifications: false, claims: false, tasks: false },
  });
}

export function getDeadlines(
  opts: { days?: number; courses?: CourseFilter } = {},
  now: Date = new Date()
): Promise<DigestResult> {
  const from = startOfDay(now);
  const end = endOfDay(addDays(now, opts.days ?? 14));
  return buildDigest({
    now,
    window: { from, to: end },
    // Расписание нужно только ради экзаменов/зачётов — обычные занятия отбрасываются.
    schedule: { range: { from, to: end }, lessonsUntil: null, examsUntil: end },
    deadlinesUntil: end,
    courses: opts.courses,
    includeUndated: true,
    include: { lmsMessages: false, notifications: false, claims: true, tasks: true },
  });
}
```

- [ ] **Step 2: Создать `$SP/check-digest.mjs`**

```js
import assert from "node:assert/strict";
import { dist } from "./common.mjs";
const { buildDigest } = await dist("services/digest/client.js");

const now = new Date(2026, 9, 14, 12, 0);
const day = (d, h = 0) => new Date(2026, 9, d, h, 0);
const iso = (d, h) => {
  const x = day(d, h); const p = (n) => String(n).padStart(2, "0");
  const o = -x.getTimezoneOffset(); const a = Math.abs(o);
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:00:00${o >= 0 ? "+" : "-"}${p(Math.floor(a / 60))}:${p(a % 60)}`;
};
const basePlan = (over = {}) => ({
  now,
  window: { from: day(14), to: day(15, 23) },
  schedule: { range: { from: day(14), to: day(15, 23) }, lessonsUntil: day(14, 23), examsUntil: day(15, 23) },
  deadlinesUntil: day(15, 23),
  includeUndated: false,
  include: { lmsMessages: true, notifications: true, claims: true, tasks: true },
  ...over,
});
const ok = (items = [], warnings) => async () => ({ items, ...(warnings ? { warnings } : {}) });
const boom = (m) => async () => { throw new Error(m); };
const calls = [];
const track = (name, fn) => async (...a) => { calls.push(name); return fn(...a); };
const fake = (over = {}) => ({
  elkSchedule: ok(), ruzSchedule: ok(), lmsDeadlines: ok(), lmsMessages: ok(),
  elkNotifications: ok(), elkClaims: ok(), elkTasks: ok(), elkWindows: ok(), ...over,
});
const lesson = (title, h) => ({ kind: "lesson", when: iso(14, h), title, source: "elk_schedule" });

// 1. ЕЛК ok → РУЗ skipped и не вызывался
{
  calls.length = 0;
  const r = await buildDigest(basePlan(), fake({
    elkSchedule: track("elk", ok([lesson("A", 10)])),
    ruzSchedule: track("ruz", ok([lesson("B", 11)])),
  }));
  assert.equal(r.sources.elk_schedule.status, "ok");
  assert.equal(r.sources.ruz_schedule.status, "skipped");
  assert.deepEqual(calls, ["elk"]);
  assert.deepEqual(r.items.map((i) => i.title), ["A"]);
}

// 2. ЕЛК упал → РУЗ вызван, его занятия в сводке, остальные источники целы
{
  const r = await buildDigest(basePlan(), fake({
    elkSchedule: boom("ЕЛК недоступен"),
    ruzSchedule: ok([lesson("B", 11)]),
    elkNotifications: ok([{ kind: "notification", when: null, title: "N", source: "elk_notifications", unread: true }]),
  }));
  assert.equal(r.sources.elk_schedule.status, "error");
  assert.match(r.sources.elk_schedule.error, /ЕЛК недоступен/);
  assert.equal(r.sources.ruz_schedule.status, "ok");
  assert.deepEqual(r.items.map((i) => i.title).sort(), ["B", "N"]);
}

// 3 (Review Focus 5). Все упали → без исключения, items пуст, у каждого источника error
{
  const all = Object.fromEntries(["elkSchedule", "ruzSchedule", "lmsDeadlines", "lmsMessages", "elkNotifications", "elkClaims", "elkTasks", "elkWindows"].map((k) => [k, boom("нет сети")]));
  const r = await buildDigest(basePlan(), all);
  assert.deepEqual(r.items, []);
  assert.ok(Object.values(r.sources).every((s) => s.status === "error"));
  // elk_schedule, ruz_schedule, lms_deadlines, elk_windows, lms_messages, elk_notifications, elk_claims, elk_tasks
  assert.equal(Object.keys(r.sources).length, 8);
}

// 4 (Review Focus 5). Зависший источник → таймаут, остальные отдаются
{
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await buildDigest(basePlan({ sourceTimeoutMs: 200 }), fake({
    lmsDeadlines: hang,
    elkSchedule: ok([lesson("A", 10)]),
  }));
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.sources.lms_deadlines.status, "error");
  assert.match(r.sources.lms_deadlines.error, /не ответил/);
  assert.deepEqual(r.items.map((i) => i.title), ["A"]);
}

// 5. Фильтрация и порядок: просроченное (в т.ч. давнее) первым; далёкое и безвременное отброшено
{
  const dl = (title, when, extra = {}) => ({ kind: "assignment", when, title, source: "lms_deadlines", ...extra });
  const deadlines = [
    dl("far", iso(30, 10)), dl("tomorrow", iso(15, 10)), dl("old", iso(1, 10), { overdue: true }),
    dl("undated", null),
  ];
  const schedule = [
    { kind: "lesson", when: iso(15, 10), title: "tomorrow-lesson", source: "elk_schedule" },
    { kind: "exam", when: iso(15, 9), title: "exam", source: "elk_schedule" },
  ];
  const r = await buildDigest(basePlan(), fake({ lmsDeadlines: ok(deadlines), elkSchedule: ok(schedule) }));
  assert.deepEqual(r.items.map((i) => i.title), ["old", "exam", "tomorrow"]);
  const r2 = await buildDigest(basePlan({ includeUndated: true }), fake({ lmsDeadlines: ok(deadlines) }));
  assert.deepEqual(r2.items.map((i) => i.title), ["old", "tomorrow", "undated"]);
}

// 6. Предупреждения источника доходят до sources; schedule без lessonsUntil отдаёт только экзамены
{
  const r = await buildDigest(
    basePlan({ schedule: { range: { from: day(14), to: day(15, 23) }, lessonsUntil: null, examsUntil: day(15, 23) } }),
    fake({
      lmsDeadlines: ok([], ["замечание источника"]),
      elkSchedule: ok([lesson("A", 10), { kind: "exam", when: iso(15, 9), title: "E", source: "elk_schedule" }]),
    })
  );
  assert.deepEqual(r.sources.lms_deadlines.warnings, ["замечание источника"]);
  assert.deepEqual(r.items.map((i) => i.title), ["E"]);
}

console.log("check-digest: OK");
```

- [ ] **Step 3: Собрать и запустить**

Run: `npm run build && node $SP/check-digest.mjs`
Expected: сборка чистая, вывод `check-digest: OK`. Падение — править `client.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/services/digest/client.ts
git commit -F - <<'EOF'
Add digest aggregation with partial-failure handling and per-source timeouts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 6: MCP-тулы и подключение

**Files:**
- Create: `src/services/digest/tools.ts`
- Modify: `src/index.ts` (импорт и регистрация)
- Create (вне репозитория): `$SP/check-tools.mjs`

**Interfaces:**
- Consumes: `getToday`, `getWeek`, `getDeadlines` из `client.ts`; `runTool` из `src/mcp-utils.ts`.
- Produces: `registerDigestTools(server: McpServer): void` — регистрирует `my_today`, `my_week`, `my_deadlines`.

- [ ] **Step 1: Создать `src/services/digest/tools.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "../../mcp-utils.js";
import * as digest from "./client.js";

const RESULT_NOTE =
  "Возвращает JSON: items — единый список элементов (kind, when, title, course, place, " +
  "overdue, unread, source, ...), отсортированный: просроченные несданные первыми, затем по " +
  "времени, затем без даты; sources — статус каждого источника (ok/error/skipped, текст " +
  "ошибки, warnings). Если источник недоступен (например, РУЗ вне сети ВШЭ), сводка всё " +
  "равно возвращается — смотрите sources.";

export function registerDigestTools(server: McpServer): void {
  server.registerTool(
    "my_today",
    {
      title: "Сводка на сегодня",
      description:
        "Что у студента сегодня: занятия на сегодня, дедлайны (все просроченные несданные и " +
        "до конца завтрашнего дня) из SmartLMS и ЕЛК, экзамены/зачёты, непрочитанная " +
        "внутренняя почта SmartLMS, непрочитанные уведомления ЕЛК, активные заявки и задачи " +
        "ЕЛК. " +
        RESULT_NOTE,
      inputSchema: {},
    },
    async () => runTool(() => digest.getToday())
  );

  server.registerTool(
    "my_week",
    {
      title: "Сводка на неделю",
      description:
        "План на ближайшие 7 дней (сегодня + 6): расписание занятий, дедлайны SmartLMS и ЕЛК, " +
        "экзамены/зачёты, просроченные несданные работы. Без почты и уведомлений — для них " +
        "my_today. " +
        RESULT_NOTE,
      inputSchema: {},
    },
    async () => runTool(() => digest.getWeek())
  );

  server.registerTool(
    "my_deadlines",
    {
      title: "Дедлайны",
      description:
        "Что горит: несданные задания и тесты SmartLMS (в том числе просроченные, у которых " +
        "приём уже закрыт), окна ЕЛК (например, оценка курсов), активные задачи и заявки ЕЛК, " +
        "ближайшие экзамены/зачёты за days дней вперёд. Элементы без распознанной даты идут в " +
        "конце с when: null. " +
        RESULT_NOTE,
      inputSchema: {
        days: z.number().int().min(1).max(120).default(14).describe("Горизонт в днях вперёд"),
        courses: z
          .array(z.union([z.number().int().positive(), z.string().min(1)]))
          .optional()
          .describe(
            "Сузить курсы SmartLMS: число — id курса, строка — часть названия. По умолчанию — " +
              "все актуальные (видимые, не завершённые). Расписание и ЕЛК фильтром не ограничиваются."
          ),
      },
    },
    async ({ days, courses }) => runTool(() => digest.getDeadlines({ days, courses }))
  );
}
```

- [ ] **Step 2: Подключить в `src/index.ts`**

Добавить импорт после `registerSystemTools`:

```ts
import { registerDigestTools } from "./services/digest/tools.js";
```

и вызов после `registerSystemTools(server);`:

```ts
registerDigestTools(server);
```

- [ ] **Step 3: Собрать**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 4: Создать `$SP/check-tools.mjs` — проверка, что сервер стартует и тулы видны**

```js
import { spawn } from "node:child_process";
import { WT } from "./common.mjs";

const child = spawn("node", [`${WT}/dist/index.js`], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const wait = (id) => new Promise((resolve) => {
  const onData = (chunk) => {
    buf += chunk;
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id === id) { child.stdout.off("data", onData); resolve(m); return; } } catch {}
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", onData);
});
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } } });
await wait(1);
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const list = await wait(2);
const names = list.result.tools.map((t) => t.name);
console.log("tools:", names.length, "digest:", names.filter((n) => n.startsWith("my_")).join(", "));
const dl = list.result.tools.find((t) => t.name === "my_deadlines");
console.log("my_deadlines.inputSchema.properties:", Object.keys(dl.inputSchema.properties).join(", "));
child.kill();
```

Run: `node $SP/check-tools.mjs`
Expected: `digest: my_today, my_week, my_deadlines` и `properties: days, courses`; общее число тулов — на 3 больше прежнего. Если абсолютное число отличается от 37 — это поправка к документам (PROGRESS.md называет 34), а не ошибка реализации.

- [ ] **Step 5: Commit**

```bash
git add src/services/digest/tools.ts src/index.ts
git commit -F - <<'EOF'
Register my_today, my_week and my_deadlines MCP tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 7: Живая проверка на реальном аккаунте

**Files:**
- Create (вне репозитория): `$SP/live-digest.mjs`

**Interfaces:**
- Consumes: `getToday`, `getWeek`, `getDeadlines` из `dist/services/digest/client.js`; `listCourses` из `dist/services/lms/client.js`.

- [ ] **Step 1: Создать `$SP/live-digest.mjs`**

```js
import { dist, loadEnv } from "./common.mjs";
loadEnv();

const { closeBrowserSession } = await dist("auth/browser-session.js");
const digest = await dist("services/digest/client.js");
const lms = await dist("services/lms/client.js");

// Печатаем только агрегаты и названия занятий/заданий/окон. Письма, отправители, тексты
// уведомлений и заявок, raw — не печатаются.
const SAFE_TITLE = new Set(["lesson", "exam", "assignment", "lms_activity", "elk_window"]);

function report(label, r, ms) {
  const kinds = {};
  for (const i of r.items) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  console.log(`\n== ${label}: ${ms} мс, элементов: ${r.items.length}, просроченных: ${r.items.filter((i) => i.overdue).length}`);
  console.log("   по видам:", JSON.stringify(kinds));
  for (const [name, s] of Object.entries(r.sources)) {
    // Тексты ошибок бывают с email (RUZ: «студент с email ... не найден») — маскируем.
    const masked = (s.error ?? "").replace(/[\w.+-]+@[\w.-]+/g, "<email>").slice(0, 120);
    const extra = [s.error && `error: ${masked}`, s.warnings && `warnings: ${s.warnings.length}`].filter(Boolean).join("; ");
    console.log(`   источник ${name}: ${s.status} (${s.ms} мс)${extra ? " — " + extra : ""}`);
  }
  for (const i of r.items.slice(0, 14)) {
    const title = SAFE_TITLE.has(i.kind) ? i.title.slice(0, 60) : "<скрыто>";
    console.log(`   - ${i.kind}${i.overdue ? " [ПРОСРОЧЕНО]" : ""} ${i.when ?? "без даты"} ${title}`);
  }
}

async function timed(label, fn) {
  const t0 = Date.now();
  const r = await fn();
  report(label, r, Date.now() - t0);
  return r;
}

const today = await timed("my_today (холодный)", () => digest.getToday());
await timed("my_today (повтор, из кэша)", () => digest.getToday());
const week = await timed("my_week", () => digest.getWeek());
const dl = await timed("my_deadlines (14 дней)", () => digest.getDeadlines({ days: 14 }));

// Требование пользователя: просроченные несданные видны во всех трёх тулах
for (const [name, r] of [["my_today", today], ["my_week", week], ["my_deadlines", dl]]) {
  const n = r.items.filter((i) => i.overdue && i.source === "lms_deadlines").length;
  console.log(`просроченных LMS-заданий в ${name}: ${n}`);
}

// Фильтр курсов: id первого актуального курса и заведомо несуществующая подстрока
const courses = (await lms.listCourses()).filter((c) => c.visible && !c.hidden);
if (courses[0]) {
  await timed("my_deadlines (фильтр по id первого курса)", () => digest.getDeadlines({ days: 30, courses: [courses[0].id] }));
}
const bad = await digest.getDeadlines({ days: 7, courses: ["__нет_такого_курса__"] });
console.log("\n== фильтр без совпадений: lms_deadlines =", bad.sources.lms_deadlines.status,
  "| ошибка содержит перечень курсов:", /Доступные курсы/.test(bad.sources.lms_deadlines.error ?? ""));

// Заодно: lms_* через кэш (закрывает «не проверено» подпроекта 1)
const t0 = Date.now(); await lms.listCourses(); const first = Date.now() - t0;
const t1 = Date.now(); await lms.listCourses(); const second = Date.now() - t1;
console.log(`\n== lms.listCourses: ${first} мс, повтор ${second} мс`);

await closeBrowserSession();
```

- [ ] **Step 2: Запустить**

Run: `node $SP/live-digest.mjs`
Expected (на аккаунте на 2026-10-14; конкретные элементы могут измениться, если пользователь сдал работы):
- нет исключений; `lms_deadlines`, `elk_schedule`, `elk_windows`, `lms_messages`, `elk_notifications`, `elk_claims`, `elk_tasks` — `ok`; `ruz_schedule` — `skipped`;
- **во всех трёх тулах есть просроченное LMS-задание** («Домашнее задание по блоку 1 …», срок 5 октября) с пометкой `[ПРОСРОЧЕНО]`; «Отправлено для оценивания» (25 сентября) — отсутствует;
- в `my_today` и `my_week` нет безвременных LMS-заданий; в `my_deadlines` есть окно СОП «1 модуль 2026/2027 учебного года» со сроком 25 октября;
- повтор `my_today` заметно быстрее холодного (кэш клиентских функций);
- в выводе нет ФИО, email, текстов писем и уведомлений.

- [ ] **Step 3: Разобрать расхождения**

Любой `error` из ожидаемо рабочего источника, подозрительный `when: null` у занятий, пропавшее просроченное задание, лишние элементы — исправить в `sources.ts`/`parse.ts`/`client.ts`, пересобрать, повторить Step 2 и `check-*.mjs`. Если проблему нельзя исправить без изменения замысла — остановиться и описать пользователю.

- [ ] **Step 4: Записать факты для документации (в заметки, не в репозиторий)**

Для Task 8 выписать: замеренные времена холодного/повторного вызова каждого тула, статусы источников, количество просроченных, что осталось непроверенным (не воспроизведено: протухший токен ЕЛК end-to-end, протухшая SSO-сессия, форма задачи ЕЛК, точный `lesson_type` экзамена, РУЗ из сети ВШЭ как запасной источник).

- [ ] **Step 5: Commit (только если Step 3 менял код)**

```bash
git add src/services/digest
git commit -F - <<'EOF'
Fix digest collectors after live verification

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Task 8: Документация и правки спецификации

**Files:**
- Modify: `PROGRESS.md`, `REQUIREMENTS.md`, `CLAUDE.md`, `README.md`
- Modify: `docs/superpowers/specs/2026-10-14-summaries-planning-design.md`

- [ ] **Step 1: Привести спецификацию в соответствие с реализацией**

Внести в спецификацию:
- §5: у `DigestItem` добавлено поле `received?: string` (момент прихода/обновления письма, уведомления, заявки); `when` для них всегда `null`. У `SourceStatus` добавлено `warnings?: string[]`. `overdue` — «просрочено и несдано, в т.ч. когда приём закрыт».
- §6: источники `lms_messages`, `elk_notifications`, `elk_claims` кладут время в `received`; в `my_today`/`my_week` дедлайны без даты отбрасываются (остаются только в `my_deadlines`); просроченные несданные показываются **во всех трёх** тулах (требование пользователя).
- §7: **единственная реализация — календарь Moodle** (обход таблиц курсов не реализуется: календарь подтверждён живьём). Отбор по `actionable` не применяется — просроченное несданное приходит с `overdue: true`, `actionable: false`; сданное календарь не возвращает. Кэш — на уровне клиентской функции (`lms:calendar:<от>:<до>`), отдельного `lms:deadlines:*` нет. Просроченные ищутся за `OVERDUE_LOOKBACK_DAYS = 180` дней.
- §6/`elk_windows`: фактические колонки и формат дат СОП; статус «Анкета доступна» — активно; «заполнен/пройден/завершён/закрыт» — отбрасывается.
- §9: вместо `Promise.allSettled` — `runSource`, который не бросает (эквивалент); таймаут 20 с настраивается `DigestPlan.sourceTimeoutMs`.
- §12: убрать пункт про разбор русских дат в запасном пути как основной риск; живая проверка — по факту Task 7.
- §13: оставить только то, что реально не подтверждено.

- [ ] **Step 2: `PROGRESS.md`**

- В «Дорожной карте» строку `2. Сводки и планирование ... — не начато` заменить на статус «реализовано, проверено вживую (список — ниже)» или «реализовано, частично проверено» — по итогам Task 7.
- Добавить раздел «### Подпроект 2: сводки и планирование» по образцу «Подпроекта 1»: что сделано (3 тула, сервис `digest`, модель элемента, источники, календарь Moodle, просроченные, частичные отказы) → как проверено.
- Раздельно: «**Проверено вживую (дата)**» — только то, что реально получено в Task 7 и зондировании (в т.ч. семантика `overdue`/`actionable`, замеры) и «**Не проверено**» — протухший токен ЕЛК end-to-end, протухшая SSO-сессия, форма задачи ЕЛК, точный `lesson_type` экзамена, РУЗ-запасной путь из сети ВШЭ.
- Наблюдение: на каждом запуске `openAuthenticatedPage` для `/my/courses.php` пишет в stderr «страница … не отрендерилась за таймаут при проверке логина», хотя данные приходят — существующее поведение, не исследовано.
- В итоговой строке заголовка «34 тула» → «37 тулов», дополнить «+ 3 агрегатора».
- Если Task 7 проверил `lms_*` через кэш — перенести пункт из «не проверено» подпроекта 1 в «проверено».

- [ ] **Step 3: `REQUIREMENTS.md`**

- Функциональные требования (Реализовано): добавить пункт 10 — сводки `my_today`/`my_week`/`my_deadlines` (состав, горизонты, просроченные несданные видны).
- Нефункциональные: «Агрегаторы возвращают частичный результат — отказ одного источника не роняет сводку и явно отражается в `sources`; таймаут источника 20 с; агрегат не кэшируется».

- [ ] **Step 4: `CLAUDE.md`**

В раздел «Архитектура» добавить абзац про `services/digest/`: сервис вызывает клиентские функции (не MCP-тулы), `buildDigest` с внедряемыми `Collectors`, единая модель `DigestItem`, `sources` со статусами, дедлайны LMS — календарь Moodle, РУЗ — только запасной. В «Roadmap» отметить подпроект 2 как готовый.

- [ ] **Step 5: `README.md`**

Открыть раздел со списком тулов, добавить три тула в том же формате, что соседние строки (имя, одно предложение назначения), обновить общее число тулов, если оно указано.

- [ ] **Step 6: Проверить, что документация не противоречит друг другу**

Run: `git grep -n "34 тула\|34 tools" -- '*.md'`
Expected: нет устаревших упоминаний (кроме исторических в «Последних коммитах»).

- [ ] **Step 7: Commit**

```bash
git add PROGRESS.md REQUIREMENTS.md CLAUDE.md README.md docs/superpowers/specs/2026-10-14-summaries-planning-design.md
git commit -F - <<'EOF'
Document subproject 2 (summaries and planning): progress, requirements, architecture

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 8: Итоговая проверка перед завершением**

Run: `npm run build && node $SP/check-parse.mjs && node $SP/check-sources.mjs && node $SP/check-digest.mjs && git status -sb`
Expected: сборка чистая, три скрипта `OK`, дерево чистое. Дальше — `superpowers:finishing-a-development-branch` (решение о слиянии с `master` принимает пользователь).
