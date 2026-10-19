import type { PageCallContext } from "../../auth/browser-session.js";
import { defineResource, type LoadContext } from "../../resource.js";
import { findUnresolvedByTarget, latestByToken, recordJournal, type JournalEntry } from "./journal.js";
import { loadOrCreateKey, PREVIEW_TTL_MS, signPreview, targetIdOf, tokenIdOf, verifyPreview } from "./token.js";
import type { ErrorClass, Outcome, PreviewPayload } from "./types.js";

/**
 * Протокол записи (спека §5–§8): сухой прогон → `previewToken` → `confirm` с токеном → точка
 * невозврата → проверка чтением → исход `confirmed`/`rejected`/`unknown`.
 *
 * - Сухой прогон только читает и журнал не трогает.
 * - Запись по одной на процесс (`runExclusive`); токен одноразовый по журналу: повтор того же токена
 *   только читает (`verifyOnly`) или возвращает записанный исход, `execute` второй раз не вызывается.
 * - Исключение до первой точки невозврата пробрасывается (ничего не отправлено, журнал не тронут);
 *   после неё исход `unknown` возвращается обычным ответом, автоповтора отправки нет никогда.
 * - В журнал и ответы после сухого прогона не попадают ни данные операции, ни тексты ошибок.
 */

export interface WriteInput {
  confirm?: boolean;
  previewToken?: string;
  acknowledgeUnknown?: boolean;
}

export interface PreviewResponse {
  stage: "preview";
  previewToken: string;
  expiresAt: string;
  preview: unknown;
  warnings: string[];
  /** По цели есть запись с неизвестным исходом: запись потребует `acknowledgeUnknown: true`. */
  priorUnknown: boolean;
}

export interface ExecuteResult {
  stage: "verified" | "draft-saved" | "sent";
  outcome: Outcome;
  evidence: Record<string, unknown>;
  warnings: string[];
}

export interface WriteResponse extends ExecuteResult {
  /** Пройдена точка невозврата: данные могли дойти до системы. */
  sent: boolean;
}

/**
 * Ожидание, которое прерывается сигналом: по отмене таймер снимается и ожидание отклоняется причиной
 * сигнала (уже отменённый сигнал — сразу, без таймера).
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("операция отменена"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("операция отменена"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Шов только для проверок (`test/runner.test.mjs`): подмена ожидания следующей секунды в сухом прогоне. */
export const testSeams: { sleep: (ms: number, signal?: AbortSignal) => Promise<void> } = { sleep: abortableSleep };

/** Дедлайн коммита из адаптера: конечное положительное число, иначе `undefined` (раннер берёт значение по умолчанию). */
const sanitizeDeadline = (ms: unknown): number | undefined =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : undefined;

/** Журнал `sending` → `commit()` ресурса → `commit()` страницы; бросает, если вызов уже отклонён. */
export type CommitPoint = (pageCtx: PageCallContext) => Promise<void>;

export interface ExecuteContext {
  signal: AbortSignal;
  commitPoint: CommitPoint;
}

export interface WriteAdapter<A extends object, Obs> {
  op: string;
  /** Ресурсы чтения, сбрасываемые после точки невозврата при любом исходе. */
  invalidates: string[];
  /**
   * Тестовый шов: дедлайн после точки невозврата, мс (по умолчанию `COMMIT_DEADLINE_MS`); нужен только
   * проверкам. Принимается лишь конечное положительное число, иное (NaN, 0, отрицательное, Infinity)
   * заменяется значением по умолчанию.
   */
  commitDeadlineMs?: number;
  /** Идентификатор цели (курс/задание/заявка): в журнал попадает только его HMAC. */
  targetOf(args: A): string;
  /** Только чтение; бросает при невыполненных предусловиях. */
  observe(args: A, signal?: AbortSignal): Promise<Obs>;
  describe(args: A, observed: Obs): { preview: unknown; warnings: string[] };
  payloadOf(args: A, observed: Obs): Pick<PreviewPayload, "mode" | "files" | "state">;
  /**
   * Запись и проверка чтением. Перед **каждым** необратимым действием — `await ctx.commitPoint(pageCtx)`.
   * Контракт: `execute` не перехватывает и не проглатывает исключение из `commitPoint` — оно значит,
   * что вызов уже отклонён (отмена, дедлайн, сбой журнала), и необратимое действие выполнять нельзя.
   * Проглоченный отказ раннер считает неизвестным исходом.
   */
  execute(args: A, observed: Obs, ctx: ExecuteContext): Promise<ExecuteResult>;
  /**
   * Только чтение: исход ранее начатой записи, без повторной отправки. Возвращает только `confirmed`
   * или `unknown`, **никогда `rejected`** (раннер превращает `rejected` в `unknown` с предупреждением):
   * проверка не вправе по своему усмотрению закрыть запись как отклонённую. Аргументы повтора могут
   * отличаться от подтверждённых при записи, поэтому проверять нужно то, что сказано в журнале
   * (предыдущая попытка), а не собственные данные вызова: ничего не помечать разрешённым самовольно.
   */
  verifyOnly(
    args: A,
    signal?: AbortSignal
  ): Promise<{ outcome: Outcome; evidence: Record<string, unknown>; warnings: string[] }>;
}

const UNKNOWN_WARNING =
  "Исход записи не определён: данные могли дойти до системы. Повторять отправку без проверки запрещено: " +
  "повторите вызов с тем же previewToken — выполнится только проверка чтением, без отправки.";
const PRIOR_UNKNOWN_WARNING =
  "По этой цели есть запись с неизвестным исходом: сначала проверьте текущее состояние; " +
  "новая запись потребует acknowledgeUnknown: true.";
const NOT_SENT = "ничего не отправлено";

const TOKEN_REFUSAL: Record<"malformed" | "expired" | "mismatch", string> = {
  malformed: "previewToken повреждён: выполните сухой прогон заново",
  expired: `previewToken просрочен (действует ${PREVIEW_TTL_MS / 60_000} мин): выполните сухой прогон заново`,
  mismatch: "previewToken не совпадает с операцией, данными или текущим состоянием цели: выполните сухой прогон заново",
};

/** Класс ошибки для журнала: текст ошибки не пишется никуда. */
export function classifyError(err: unknown): ErrorClass {
  // DOMException (AbortError, TimeoutError) в Node — тоже Error.
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || name === "TimeoutError" || /не уложил/i.test(message)) return "timeout";
  if (/отмен[её]н/i.test(message)) return "cancelled";
  if (/net::|ERR_|fetch/.test(message)) return "network";
  if (/\b401\b|вход/i.test(message)) return "auth";
  return "other";
}

/** Ошибка до точки невозврата: текст как есть плюс явное «ничего не отправлено». */
function notSent(err: unknown): Error {
  if (err instanceof Error && err.message.includes(NOT_SENT)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${message}; ${NOT_SENT}`, { cause: err });
}

let queue: Promise<void> = Promise.resolve();

/** Не более одной записи одновременно в процессе: следующий вызов ждёт завершения предыдущего. */
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Состояние одной записи: общее для раннера и `commitPoint` внутри загрузчика ресурса. */
interface WriteCall {
  ids: Pick<JournalEntry, "op" | "tokenId" | "targetId">;
  /** Раннер уже получил исход ресурса: новая точка невозврата недоступна. */
  done: boolean;
  /** Запись `sending` в журнале: точка невозврата пройдена. */
  sending: boolean;
  /** `commitPoint` хотя бы раз бросил. */
  refused: boolean;
  /** Идущая запись `sending`: раннер дожидается её, прежде чем решать, отправлено ли что-то. */
  pending?: Promise<void>;
}

interface ExecArgs<A, Obs> {
  args: A;
  observed: Obs;
  call: WriteCall;
}

function commitPointFor(call: WriteCall, ctx: LoadContext, deadlineMs?: number): CommitPoint {
  return async (pageCtx) => {
    try {
      if (!call.sending) {
        // Вызов уже отклонён: запись `sending` осталась бы висеть без исхода.
        if (call.done || ctx.signal.aborted || pageCtx.signal.aborted) {
          throw ctx.signal.reason ?? pageCtx.signal.reason ?? new Error("вызов уже завершён, точка невозврата недоступна");
        }
        const pending = recordJournal({ ...call.ids, at: new Date().toISOString(), stage: "sending" }).then(() => {
          call.sending = true;
        });
        call.pending = pending;
        await pending;
      }
      ctx.commit(deadlineMs);
      pageCtx.commit(deadlineMs);
    } catch (err) {
      call.refused = true;
      throw err;
    }
  };
}

/** Исход после точки невозврата пишется в журнал; сбой журнала не отменяет ответ. */
async function journalOutcome(entry: Omit<JournalEntry, "at">, warnings: string[]): Promise<void> {
  try {
    await recordJournal({ ...entry, at: new Date().toISOString() });
  } catch {
    warnings.push("Исход не записан в журнал записей (ошибка файловой системы).");
  }
}

function withUnknownWarning(outcome: Outcome, warnings: string[]): string[] {
  return outcome === "unknown" && !warnings.includes(UNKNOWN_WARNING) ? [...warnings, UNKNOWN_WARNING] : warnings;
}

export function defineWrite<A extends object, Obs>(
  adapter: WriteAdapter<A, Obs>
): (args: A & WriteInput, signal?: AbortSignal) => Promise<PreviewResponse | WriteResponse> {
  const execute = defineResource<ExecArgs<A, Obs>, ExecuteResult>({
    name: `writes.${adapter.op}`,
    cache: false,
    invalidates: adapter.invalidates,
    load: (x, ctx) =>
      adapter.execute(x.args, x.observed, { signal: ctx.signal, commitPoint: commitPointFor(x.call, ctx, sanitizeDeadline(adapter.commitDeadlineMs)) }),
  });

  const payloadFor = (args: A, observed: Obs): PreviewPayload => ({
    op: adapter.op,
    target: adapter.targetOf(args),
    ...adapter.payloadOf(args, observed),
  });

  async function preview(args: A, signal?: AbortSignal): Promise<PreviewResponse> {
    const key = await loadOrCreateKey();
    const observed = await adapter.observe(args, signal);
    const payload = payloadFor(args, observed);
    let now = new Date();
    let previewToken = signPreview(key, payload, now);
    // Токен детерминирован секундой и данными: тот же сухой прогон в ту же секунду после записи дал бы
    // уже использованный токен (повтор из журнала вместо новой записи) — ждём следующую секунду.
    const issuedId = tokenIdOf(previewToken);
    if (issuedId && (await latestByToken(issuedId))) {
      // Отмена прерывает ожидание: сухой прогон ничего не журналирует, отклоняемся причиной отмены.
      await testSeams.sleep(1000 - (Date.now() % 1000) + 5, signal);
      now = new Date();
      previewToken = signPreview(key, payload, now);
    }
    const { preview, warnings } = adapter.describe(args, observed);
    const priorUnknown = (await findUnresolvedByTarget(targetIdOf(key, adapter.op, payload.target))).length > 0;
    return {
      stage: "preview",
      previewToken,
      expiresAt: new Date(Math.floor(now.getTime() / 1000) * 1000 + PREVIEW_TTL_MS).toISOString(),
      preview,
      warnings: priorUnknown ? [...warnings, PRIOR_UNKNOWN_WARNING] : warnings,
      priorUnknown,
    };
  }

  /** Повтор по токену из журнала: только чтение, токен на HMAC и состояние не проверяется. */
  async function replay(args: A, prior: JournalEntry, targetId: string, signal?: AbortSignal): Promise<WriteResponse> {
    if (prior.op !== adapter.op || prior.targetId !== targetId) {
      throw new Error(`previewToken выдан для другой операции или цели: выполните сухой прогон заново; ${NOT_SENT}`);
    }
    if (prior.stage === "verified" && (prior.outcome === "confirmed" || prior.outcome === "rejected")) {
      return { stage: "verified", outcome: prior.outcome, evidence: { fromJournal: true }, warnings: [], sent: prior.outcome === "confirmed" };
    }
    const started = Date.now();
    const checked = await adapter.verifyOnly(args, signal);
    // Контракт verifyOnly: только confirmed/unknown. `rejected` от проверки чтением не принимается как
    // исход — отправка по токену уже начиналась, значит исход неизвестен.
    const outcome: Outcome = checked.outcome === "rejected" ? "unknown" : checked.outcome;
    const extra = checked.outcome === "rejected" ? ["verifyOnly вернул «отклонено», что ему не разрешено: исход считается неизвестным."] : [];
    const warnings = withUnknownWarning(outcome, [...checked.warnings, ...extra]);
    const ids = { op: prior.op, tokenId: prior.tokenId, targetId: prior.targetId };
    await journalOutcome({ ...ids, stage: "verified", outcome, durationMs: Date.now() - started }, warnings);
    // Отправка по токену уже начиналась: «не отправлено» утверждается только записанным в журнале отказом.
    return { stage: "verified", outcome, evidence: checked.evidence, warnings, sent: true };
  }

  async function write(args: A, token: string, acknowledgeUnknown: boolean, signal?: AbortSignal): Promise<WriteResponse> {
    if (signal?.aborted) throw notSent(signal.reason ?? new Error("операция отменена"));
    const key = await loadOrCreateKey();
    const targetId = targetIdOf(key, adapter.op, adapter.targetOf(args));
    const priorTokenId = tokenIdOf(token);
    const prior = priorTokenId ? await latestByToken(priorTokenId) : undefined;
    if (prior) return replay(args, prior, targetId, signal);

    let observed: Obs;
    try {
      observed = await adapter.observe(args, signal);
    } catch (err) {
      throw notSent(err);
    }
    const verdict = verifyPreview(key, token, payloadFor(args, observed));
    if (!verdict.ok) throw new Error(`${TOKEN_REFUSAL[verdict.reason]}; ${NOT_SENT}`);
    const tokenId = verdict.tokenId;
    if (!acknowledgeUnknown && (await findUnresolvedByTarget(targetId, undefined, tokenId)).length > 0) {
      throw new Error(
        "По этой цели есть запись с неизвестным исходом: проверьте состояние сухим прогоном и повторите " +
          `с acknowledgeUnknown: true; ${NOT_SENT}`
      );
    }

    const call: WriteCall = { ids: { op: adapter.op, tokenId, targetId }, done: false, sending: false, refused: false };
    const started = Date.now();
    let result: ExecuteResult | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await execute({ args, observed, call }, { signal });
    } catch (err) {
      failed = true;
      failure = err;
    }
    call.done = true;
    // Ресурс мог отклонить вызов, пока шла запись `sending`: решение — только после неё.
    if (call.pending) await call.pending.catch(() => {});
    const durationMs = Date.now() - started;

    if (failed && !call.sending) throw notSent(failure);
    if (failed || call.refused) {
      // Сбой после точки невозврата либо адаптер проглотил отказ commitPoint: исход неизвестен.
      const errorClass: ErrorClass = failed ? classifyError(failure) : "other";
      const warnings = [UNKNOWN_WARNING];
      await journalOutcome({ ...call.ids, stage: "sent", outcome: "unknown", durationMs, errorClass }, warnings);
      return { stage: "sent", outcome: "unknown", evidence: { errorClass }, warnings, sent: true };
    }

    const done = result as ExecuteResult;
    const warnings = withUnknownWarning(done.outcome, [...done.warnings]);
    if (call.sending) {
      await journalOutcome({ ...call.ids, stage: "verified", outcome: done.outcome, durationMs }, warnings);
    }
    return { stage: done.stage, outcome: done.outcome, evidence: done.evidence, warnings, sent: call.sending };
  }

  return async (input, signal) => {
    const { confirm, previewToken, acknowledgeUnknown, ...rest } = input;
    const args = rest as unknown as A;
    if (!confirm) return preview(args, signal);
    if (!previewToken) throw new Error(`confirm требует previewToken: сначала выполните сухой прогон; ${NOT_SENT}`);
    return runExclusive(() => write(args, previewToken, acknowledgeUnknown === true, signal));
  };
}
