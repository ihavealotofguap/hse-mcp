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
