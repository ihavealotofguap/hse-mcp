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
      const all = await deps.listCourses(ctx.opts);
      try {
        courses = selectCourses(all, opts.courses, ctx.now);
      } catch {
        // Ошибка `selectCourses` перечисляет названия курсов — в ответ `hse_changes` они не попадают.
        const actual = selectCourses(all, undefined, ctx.now).length;
        throw new Error(`ни один актуальный курс не подошёл под фильтр courses (актуальных курсов: ${actual}; список — lms_list_courses)`);
      }
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

    // `corrupt` с неудавшимся карантином: файл остался на месте, `saveState(…, null)` отклонит запись
    // по `rev` — ответ уйдёт с `persisted: false`, сам `kind` здесь не различается.
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
