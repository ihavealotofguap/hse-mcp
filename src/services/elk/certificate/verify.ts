import { config } from "../../../config.js";
import { abortableSleep, type ExecuteResult, type WriteAdapter } from "../../writes/runner.js";
import type { Outcome } from "../../writes/types.js";
import type { ElkApplication } from "../client.js";
import { certificateTestSeams, claimNumbersOf } from "./claims.js";
import type { CertificateArgs, CertificateObserved } from "./plan.js";

/**
 * Проверка исхода заказа (спека №4 §7, §10): опрос истории заявок после клика и классификация
 * (`classifyCertificateOutcome`). Ответ `process/start` (даже 2xx) — только сигнал: исход решает
 * появление ровно одной новой заявки в свежей истории (номер — только в ответе тула). История —
 * заявки «Сервиса Студент» со страницы «Заявки» (`claims.ts`): в `/api/claims` справки не видны
 * (§17, одиннадцатый проход), поэтому прежде исход был всегда `unknown`.
 */

// Дедлайн коммита заказа: клик, ожидание ответа `process/start` (до 10 с) и опрос истории (до 15 с) с запасом.
export const CERTIFICATE_COMMIT_DEADLINE_MS = 45_000;
// Чтение истории открывает страницу «Заявки» (вход, перезагрузка, ответ списка): запас на одно чтение.
const CLAIMS_READ_RESERVE_MS = 20_000;

// Ручная сверка неизвестного исхода — на странице «Заявки» в ЕЛК (там видны заявки «Сервиса Студент»).
export const MANUAL_WHERE = "сверьте вручную на странице «Заявки» в lk.hse.ru";
/** Предупреждение каждого неизвестного исхода заказа: «0 новых заявок» не значит, что заказ не прошёл. */
export const MANUAL_CHECK_WARNING =
  "исход заказа не подтверждён; newClaims: 0 не означает, что заказ не прошёл: новая заявка могла ещё не появиться в списке; проверьте вручную на странице «Заявки» в lk.hse.ru, не повторяйте заказ без этой проверки";

const W_MANUAL = `после заказа появилось несколько новых заявок: какая из них создана этим вызовом, не установить — ${MANUAL_WHERE}`;

const W_NO_START = `запрос заказа после нажатия «Отправить» не замечен: новая заявка может быть не этой — ${MANUAL_WHERE}`;
const W_MANY_STARTS = `форма отправила запрос заказа больше одного раза: возможны дубли — ${MANUAL_WHERE}`;
const W_CREATED_OLD = `новая заявка создана раньше заказа: вероятно, она не эта — ${MANUAL_WHERE}`;
const W_CREATED_UNPARSED =
  "время создания новой заявки не распознано: сверьте её сервис и время (evidence) с заказом";

/**
 * Первый шаг исхода — сравнение номеров (§7, §10): ровно один номер, которого не было в снимке до
 * заказа, — кандидат в подтверждение (номер только в `evidence`, то есть в ответе тула); ни одного —
 * неизвестно (заявка могла появиться позже); больше одного — неизвестно с предупреждением, номеров в
 * ответе нет. Пропавшие из списка старые номера (усечение истории) не учитываются. Окончательный исход
 * — `classifyCertificateOutcome`. `rejected` проверка не выносит никогда.
 */
export function classifyClaimsOutcome(
  before: string[],
  after: string[]
): {
  outcome: Outcome;
  evidence: { newClaims: number; newClaimNumber?: string };
  warnings: string[];
} {
  const known = new Set(before);
  const fresh = [...new Set(after)].filter((num) => !known.has(num));
  if (fresh.length === 1)
    return {
      outcome: "confirmed",
      evidence: { newClaims: 1, newClaimNumber: fresh[0] },
      warnings: [],
    };
  return {
    outcome: "unknown",
    evidence: { newClaims: fresh.length },
    warnings: fresh.length > 1 ? [W_MANUAL] : [],
  };
}

const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
// Новая заявка, созданная раньше клика больше чем на столько, — не наша (запас на расхождение часов).
const CREATED_SLACK_MS = 5 * 60_000;

/**
 * Время создания заявки ЕЛК (`created`): ISO-подобное `ГГГГ-ММ-ДД[T ]ЧЧ:ММ[:СС[.доли]]` с поясом
 * (`Z`, `±ЧЧ:ММ`) или без него — тогда как МСК (UTC+3, наивное время ЕЛК); `ДД.ММ.ГГГГ ЧЧ:ММ` — МСК;
 * дата без времени — начало суток МСК с `dayOnly`. Не распознано — `null`. Формат поля вживую не
 * зафиксирован, поэтому разбор снисходителен, а отказ разбора не отказывает заказ.
 */
export function parseClaimCreated(raw: unknown): { at: number; dayOnly: boolean } | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let y: number,
    mo: number,
    d: number,
    h = 0,
    mi = 0,
    sec = 0,
    ms = 0;
  let zone: string | undefined;
  let dayOnly = false;
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      s
    );
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})(?:,?\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    dayOnly = iso[4] === undefined;
    if (!dayOnly)
      [h, mi, sec, ms] = [
        Number(iso[4]),
        Number(iso[5]),
        Number(iso[6] ?? 0),
        Number((iso[7] ?? "0").slice(0, 3).padEnd(3, "0")),
      ];
    zone = iso[8];
  } else if (ru) {
    [d, mo, y] = [Number(ru[1]), Number(ru[2]), Number(ru[3])];
    dayOnly = ru[4] === undefined;
    if (!dayOnly) [h, mi, sec] = [Number(ru[4]), Number(ru[5]), Number(ru[6] ?? 0)];
  } else return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d)
    return null;
  let offset = MSK_OFFSET_MS;
  if (zone === "Z") offset = 0;
  else if (zone) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!m) return null;
    offset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000);
  }
  return { at: utc - offset, dayOnly };
}

/**
 * Окончательный исход заказа (§7, §10). Подтверждено, только если одновременно: (1) ровно одна новая
 * заявка; (2) запрос `process/start` замечен ровно один раз — сам факт запроса, не его статус (ответ
 * 2xx — только сигнал); (3) заявка не создана раньше клика больше чем на 5 минут (время не распознано —
 * предупреждение, но не отказ). Иначе — неизвестно с предупреждением «сверьте вручную». Так чужая
 * заявка (сотрудник, другая вкладка, автоматический процесс), появившаяся при проглоченном клике, не
 * даёт ложного `confirmed`. Номер, сервис и время новой заявки остаются в ответе для ручной сверки;
 * автор — только признаком «тот же логин» (ФИО в ответ не попадает, §8), условием не служит.
 *
 * Отступление от §10 («новая заявка с подходящим сервисом»): у заявки ЕЛК есть только название сервиса
 * (`service`), его соответствие `serviceId` формы (`components`) не установлено ни разведкой (§17), ни
 * данными API, поэтому сервис показывается владельцу в `evidence`, но в решении не участвует.
 */
export function classifyCertificateOutcome(input: {
  before: string[];
  after: Array<Pick<ElkApplication, "num" | "service" | "created" | "createdByEmail">>;
  submitRequests: number;
  clickedAt: number;
  loginEmail: string | null;
}): { outcome: Outcome; evidence: Record<string, unknown>; warnings: string[] } {
  const { before, after, submitRequests, clickedAt, loginEmail } = input;
  const byNumber = claimNumbersOf({ count: after.length, requests: after });
  const step = classifyClaimsOutcome(before, byNumber);
  const startWarning = submitRequests > 1 ? [W_MANY_STARTS] : [];
  if (step.outcome !== "confirmed" || step.evidence.newClaimNumber === undefined) {
    return {
      outcome: "unknown",
      evidence: step.evidence,
      warnings: [...step.warnings, ...startWarning],
    };
  }
  const num = step.evidence.newClaimNumber;
  const claim = after.find((c) => typeof c.num === "string" && c.num.trim() === num);
  const fold = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
  const evidence = {
    ...step.evidence,
    newClaimService: typeof claim?.service === "string" ? claim.service : null,
    newClaimCreated: typeof claim?.created === "string" ? claim.created : null,
    newClaimByLogin:
      loginEmail && fold(claim?.createdByEmail)
        ? fold(claim?.createdByEmail) === fold(loginEmail)
        : null,
  };
  if (submitRequests === 0) return { outcome: "unknown", evidence, warnings: [W_NO_START] };
  if (submitRequests > 1) return { outcome: "unknown", evidence, warnings: startWarning };
  const created = parseClaimCreated(claim?.created);
  if (!created) return { outcome: "confirmed", evidence, warnings: [W_CREATED_UNPARSED] };
  // Дата без времени — заявка «старая», только если её сутки закончились до клика.
  const latest = created.dayOnly ? created.at + DAY_MS : created.at;
  if (latest < clickedAt - CREATED_SLACK_MS)
    return { outcome: "unknown", evidence, warnings: [W_CREATED_OLD] };
  return { outcome: "confirmed", evidence, warnings: [] };
}

/** Что известно об отправке после точки невозврата; заполняется по ходу, чтобы пережить сбой страницы. */
export interface SubmitTrace {
  clickedAt: number;
  clickError: boolean;
  submitRequests: number;
  submitStatus: number | null;
  /** После точки невозврата страница показала JS-диалог (он отклонён): объясняет неизвестный исход. */
  dialogAfterCommit: boolean;
}

/**
 * Опрос истории заявок после клика (`maxAgeMs: 0`) до `claimsWaitMs` от клика: первое чтение с новой
 * заявкой (или несколькими) завершает опрос. Возвращается последний удачно прочитанный список (номера
 * распознаны); сбой чтения — следующая попытка; ни одного удачного чтения — `null`.
 */
export async function pollNewClaims(
  before: string[],
  since: number,
  signal: AbortSignal
): Promise<ElkApplication[] | null> {
  const deadline = since + certificateTestSeams.claimsWaitMs;
  // Дедлайн коммита отсчитывается от точки невозврата (клик следует сразу за ней): новое чтение не начинаем,
  // если до него осталось меньше запаса — медленное чтение (повторный вход, запасной путь) не должно
  // превратить исход в «не уложился в дедлайн»; первое чтение делается всегда.
  const hardStop = since + CERTIFICATE_COMMIT_DEADLINE_MS - CLAIMS_READ_RESERVE_MS;
  let last: ElkApplication[] | null = null;
  for (;;) {
    if (last !== null && Date.now() >= hardStop) return last;
    try {
      const list = await certificateTestSeams.listRequests({ maxAgeMs: 0, signal });
      const nums = claimNumbersOf(list);
      last = list.requests;
      if (classifyClaimsOutcome(before, nums).evidence.newClaims > 0) return last;
    } catch {
      // Неудачное чтение — не исход: пробуем снова до конца окна.
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal.aborted) return last;
    try {
      await abortableSleep(Math.min(certificateTestSeams.claimsPollMs, left), signal);
    } catch {
      return last;
    }
  }
}

const W_NOT_READ = `история заявок ЕЛК после заказа не прочиталась: ${MANUAL_WHERE}`;
const W_DIALOG_AFTER_COMMIT = `после нажатия «Отправить» страница показала диалог, он отклонён: заказ мог не уйти — ${MANUAL_WHERE}`;
// Снимок номеров до заказа живёт только в памяти записи, поэтому повтор не может доказать, чья заявка новая.
const W_VERIFY_ONLY = `проверка повтора не может установить, создал ли заявку прежний вызов (снимок заявок до заказа не хранится): ${MANUAL_WHERE}; число заявок сейчас — evidence.requestsNow`;

/** Email входа — только для признака «заявку создал тот же логин»; не задан — `null` (признак неизвестен). */
function loginEmailOrNull(): string | null {
  try {
    return config.hseEmail;
  } catch {
    return null;
  }
}

/**
 * Исход записи по следу отправки и опросу заявок (`classifyCertificateOutcome`). Диалог после точки
 * невозврата отмечается в `evidence` и при неизвестном исходе объясняется предупреждением.
 */
export function certificateResult(
  trace: SubmitTrace,
  before: string[],
  claims: ElkApplication[] | null
): ExecuteResult {
  const sent = {
    clicked: !trace.clickError,
    submitRequests: trace.submitRequests,
    submitStatus: trace.submitStatus,
    dialogAfterCommit: trace.dialogAfterCommit,
  };
  const dialogWarning = trace.dialogAfterCommit ? [W_DIALOG_AFTER_COMMIT] : [];
  if (!claims) {
    return {
      stage: "sent",
      outcome: "unknown",
      evidence: { ...sent, newClaims: null },
      warnings: [MANUAL_CHECK_WARNING, W_NOT_READ, ...dialogWarning],
    };
  }
  const r = classifyCertificateOutcome({
    before,
    after: claims,
    submitRequests: trace.submitRequests,
    clickedAt: trace.clickedAt,
    loginEmail: loginEmailOrNull(),
  });
  return {
    stage: "verified",
    outcome: r.outcome,
    evidence: { ...sent, ...r.evidence },
    warnings:
      r.outcome === "unknown"
        ? [MANUAL_CHECK_WARNING, ...r.warnings, ...dialogWarning]
        : r.warnings,
  };
}

export const verifyCertificateOnly: WriteAdapter<
  CertificateArgs,
  CertificateObserved
>["verifyOnly"] = async (_args, signal) => {
  let requestsNow: number | null = null;
  try {
    requestsNow = claimNumbersOf(
      await certificateTestSeams.listRequests({ maxAgeMs: 0, signal })
    ).length;
  } catch {
    // Число заявок неизвестно; исход и так «неизвестно».
  }
  return {
    outcome: "unknown",
    evidence: { requestsNow },
    warnings: [MANUAL_CHECK_WARNING, W_VERIFY_ONLY],
  };
};
