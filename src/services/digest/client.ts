import { addDays } from "../../date-utils.js";
import { endOfDay, sortItems, startOfDay, toLocalIso } from "./parse.js";
import { realCollectors, type Collectors } from "./sources.js";
import type { CollectorResult, CourseFilter, DateRange, DigestItem, DigestResult, SourceStatus } from "./types.js";

// холодный процесс (первая страница ~8 с + последовательные страницы) укладывается в ~20 с, запас до 40 с.
const DEFAULT_SOURCE_TIMEOUT_MS = 40_000;

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
