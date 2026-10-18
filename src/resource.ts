import { cached, clearCache } from "./cache.js";
import { COMMIT_DEADLINE_MS } from "./commit.js";

/**
 * Декларативный кэшируемый ресурс: один владелец ключа, TTL, загрузчика, среза и дедлайна.
 *
 * - Имя `"<домен>.<id>"` задаёт домен кэша (`elk:`, `lms:`, `istudy:`): ключ записи —
 *   `<домен>:<id>:<ключ ресурса>`, поэтому `clearCache("<домен>:")` и `hse_clear_cache` работают.
 * - Результат загрузки замораживается (глубоко) до записи в кэш: он общий для всех вызывающих,
 *   мутация даёт TypeError. `project` возвращает новое значение для конкретного вызова.
 * - Загрузка ограничена `deadlineMs`; загрузчик получает `ctx.signal`, который срабатывает по
 *   дедлайну. Отмена `opts.signal` вызывающего только отсоединяет его от общей загрузки.
 * - `cache: false` — ресурс записи: без кэша, дедупликации и заморозки результата. Загрузчик вызывает
 *   `ctx.commit()` в точке невозврата: исходный дедлайн заменяется дедлайном коммита, отмена
 *   вызывающего больше не прерывает вызов, а `invalidates` выполняется при любом исходе загрузки.
 * - Имена из `invalidates` проверяются в начале каждого вызова, до загрузки.
 */

export interface LoadContext {
  signal: AbortSignal;
  /**
   * Точка невозврата: гасит исходный дедлайн и взводит новый (`deadlineMs` или
   * `COMMIT_DEADLINE_MS` от этого вызова; повторный вызов взводит заново).
   */
  commit(deadlineMs?: number): void;
}

export interface ResourceCallOptions {
  signal?: AbortSignal;
  /** Принять данные не старше N мс (0 — перечитать и сохранить); см. `cached`. */
  maxAgeMs?: number;
}

export interface ResourceDef<A, Raw, R = Raw> {
  name: string;
  ttl: number;
  key: (args: A) => string;
  load: (args: A, ctx: LoadContext) => Promise<Raw>;
  project?: (raw: Raw, args: A) => R;
  deadlineMs?: number;
  invalidates?: string[];
  cache?: true;
}

/** Ресурс записи: не кэшируется, поэтому TTL и ключ не нужны. */
export interface WriteResourceDef<A, Raw, R = Raw> extends Omit<ResourceDef<A, Raw, R>, "ttl" | "key" | "cache"> {
  cache: false;
}

const DEFAULT_DEADLINE_MS = 45_000;

/** Состояние одного вызова: общее для таймера дедлайна и `detach`. */
interface CallState {
  committed: boolean;
}

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
  def: Pick<ResourceDef<A, Raw, unknown>, "name" | "load">,
  args: A,
  deadlineMs: number,
  state: CallState
): Promise<Raw> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let fail: (err: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const arm = (ms: number, message: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const err = new Error(message);
      ctrl.abort(err);
      fail(err);
    }, ms);
  };
  arm(deadlineMs, `${def.name} не уложился в ${deadlineMs / 1000} с`);
  const ctx: LoadContext = {
    signal: ctrl.signal,
    commit(ms) {
      state.committed = true;
      // Загрузчик, дожившийся до commit() после завершения вызова, таймер не взводит.
      if (settled) return;
      const commitMs = ms ?? COMMIT_DEADLINE_MS;
      arm(commitMs, `${def.name} не уложился в ${commitMs / 1000} с после точки невозврата`);
    },
  };
  try {
    return await Promise.race([def.load(args, ctx), timeout]);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

function detach<T>(promise: Promise<T>, state: CallState, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted && !state.committed) {
    return Promise.reject(signal.reason ?? new Error("операция отменена"));
  }
  return new Promise<T>((resolve, reject) => {
    // После точки невозврата вызов дожидается конца загрузки: исход записи нельзя терять.
    const onAbort = () => {
      if (!state.committed) reject(signal.reason ?? new Error("операция отменена"));
    };
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
  def: WriteResourceDef<A, Raw, R>
): (args: A, opts?: ResourceCallOptions) => Promise<R>;
export function defineResource<A, Raw, R = Raw>(
  def: ResourceDef<A, Raw, R>
): (args: A, opts?: ResourceCallOptions) => Promise<R>;
export function defineResource<A, Raw, R = Raw>(
  def: ResourceDef<A, Raw, R> | WriteResourceDef<A, Raw, R>
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
    // Уже отменённый вызов не запускает загрузку и не пишет в кэш (иначе отказ загрузки
    // остался бы без обработчика и дал unhandledRejection).
    if (opts.signal?.aborted) {
      return Promise.reject(opts.signal.reason ?? new Error("операция отменена"));
    }
    // Имена разрешаются до загрузки: для записывающего ресурса отказ после неё был бы поздно.
    try {
      for (const name of def.invalidates ?? []) lookup(name);
    } catch (err) {
      return Promise.reject(err);
    }
    const state: CallState = { committed: false };
    let shared: Promise<Raw>;
    if (def.cache === false) {
      // Ресурс записи: без кэша и дедупликации; сброс зависимых ресурсов — только после commit().
      shared = (async () => {
        try {
          return await loadWithDeadline(def, args, deadlineMs, state);
        } finally {
          if (state.committed) for (const name of def.invalidates ?? []) invalidateResource(name);
        }
      })();
    } else {
      const key = prefix + def.key(args);
      shared = cached<Raw>(
        key,
        def.ttl,
        async () => {
          const raw = deepFreeze(await loadWithDeadline(def, args, deadlineMs, state));
          for (const name of def.invalidates ?? []) invalidateResource(name);
          return raw;
        },
        { maxAgeMs: opts.maxAgeMs }
      );
    }
    const projected = shared.then((raw) => (def.project ? def.project(raw, args) : (raw as unknown as R)));
    return detach(projected, state, opts.signal);
  };
}

function lookup(name: string): Registered {
  const entry = registry.get(name);
  if (!entry) throw new Error(`invalidateResource: неизвестный ресурс "${name}"`);
  return entry;
}

/** Сбрасывает записи ресурса по имени; возвращает число удалённых готовых записей. */
export function invalidateResource(name: string): number {
  return clearCache(lookup(name).prefix);
}

export function listResources(): string[] {
  return [...registry.keys()];
}
