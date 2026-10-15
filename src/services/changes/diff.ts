import { canonicalAttrs, dedupeIds, isEmptyGrade } from "./normalize.js";
import type { Baseline, ChangeEvent, Coverage, DiffFlags, Fact, FieldChange, Scope } from "./types.js";

export type RawEvent = Omit<ChangeEvent, "seq" | "at">;

export interface DiffInput extends DiffFlags {
  source: string;
  scope: Scope;
  /** `null` — первый запуск источника: база создаётся без событий. */
  baseline: Baseline | null;
  facts: Fact[];
  coverage?: Coverage;
  /** Выборка усечена: `removed` не вычисляется; отсутствующее переносится в базу только при `carryMissing: true`. */
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

/** Момент UTC в формате `utcMinute`: `ГГГГ-ММ-ДДTЧЧ:ммZ`. */
const UTC_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

/** Факт без оси (`at` не задан) считается внутри окна всегда. */
const inCoverage = (at: string | undefined, c: Coverage): boolean =>
  at === undefined || ((c.from === null || at >= c.from) && (c.to === null || at <= c.to));

/** Различия по канонических значениям (как в отпечатке): пустое, `null` и отсутствие ключа равны. */
function fieldChanges(before: Record<string, string | null>, after: Record<string, string | null>): FieldChange[] {
  const was = canonicalAttrs(before);
  const now = canonicalAttrs(after);
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
  return keys
    .filter((k) => (was[k] ?? null) !== (now[k] ?? null))
    .map((k) => ({ field: k, from: was[k] ?? null, to: now[k] ?? null }));
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

  // Повторы `id` получают суффикс `#n` (а не теряются) при любом вызывающем.
  const fresh = new Map<string, Fact>();
  for (const f of dedupeIds(input.facts)) fresh.set(f.id, f);

  const makeBaseline = (carried: Fact[]): Baseline => {
    const facts: Record<string, Fact> = {};
    for (const f of carried) facts[f.id] = f;
    for (const [id, f] of fresh) facts[id] = f;
    return { takenAt, ...(input.coverage ? { coverage: input.coverage } : {}), facts };
  };

  if (input.baseline === null) return { events: [], baseline: makeBaseline([]), status: "baseline" };

  const old = input.baseline;
  const overlap = intersect(old.coverage, input.coverage);
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
      if (!inCoverage(f.at, overlap)) continue;
      if (input.silentEmptyGrade && isEmptyGrade(f.attrs.grade)) continue;
      events.push(make("added", f));
      continue;
    }
    if (emitChanged) {
      // `changed` без изменённых полей не бывает: сравнение — по каноническим значениям.
      const fields = fieldChanges(before.attrs, f.attrs);
      if (fields.length > 0) events.push(make("changed", f, { fields }));
    }
    // Только UTC `…Z`: наивная строка читалась бы `Date.parse` в поясе машины.
    if (input.detectOverdue && f.attrs.due && UTC_MINUTE.test(f.attrs.due)) {
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
    if (emitRemoved && !input.truncated && inCoverage(before.at, overlap)) {
      events.push(make("removed", before));
      continue;
    }
    if (carryMissing) carried.push(before);
  }

  if (input.mergeMoves) events = mergeMoves(events, old.facts, fresh, base);
  return { events, baseline: makeBaseline(carried), status: "ok" };
}
