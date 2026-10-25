import type { ResourceCallOptions } from "../../../resource.js";
import { Refusal, sanitizeNavigationError } from "../../writes/errors.js";
import { type ElkApplication, listStudentServiceApplications } from "../client.js";

/**
 * История заявок ЕЛК для заказа: снимок номеров до заказа и чтение для проверки исхода. Источник —
 * заявки «Сервиса Студент» со страницы «Заявки» (`listStudentServiceApplications`): справки в
 * `/api/claims` (`elk_list_requests`) не попадают.
 */

// Опрос истории заявок после клика: до 15 с от клика, раз в секунду (см. `pollNewClaims`).
const CLAIMS_WAIT_MS = 15_000;
const CLAIMS_POLL_MS = 1_000;

/** Номера заявок из ответа `listStudentServiceApplications` (отсортированы); пустой или нестроковый номер — отказ. */
export function claimNumbersOf(list: {
  count: number;
  requests: Array<Pick<ElkApplication, "num">>;
}): string[] {
  if (!list || !Array.isArray(list.requests))
    throw new Refusal("история заявок ЕЛК: ответ не распознан");
  return list.requests
    .map((c, i) => {
      const num = typeof c?.num === "string" ? c.num.trim() : "";
      if (!num) throw new Refusal(`история заявок ЕЛК: номер заявки №${i + 1} не распознан`);
      return num;
    })
    .sort();
}

/**
 * Шов только для проверок (одноразовые скрипты на заготовках): подмена чтения истории заявок и
 * сокращение ожидания новой заявки. В рабочем коде не меняется.
 */
export const certificateTestSeams: {
  listRequests: (
    opts: ResourceCallOptions
  ) => Promise<{ count: number; requests: ElkApplication[] }>;
  claimsWaitMs: number;
  claimsPollMs: number;
} = {
  listRequests: (opts) => listStudentServiceApplications(opts),
  claimsWaitMs: CLAIMS_WAIT_MS,
  claimsPollMs: CLAIMS_POLL_MS,
};

/** Снимок номеров заявок свежим чтением (`maxAgeMs: 0`); ошибки — без адресов и query. */
export async function readClaimNumbers(signal?: AbortSignal): Promise<string[]> {
  let list: { count: number; requests: ElkApplication[] };
  try {
    list = await certificateTestSeams.listRequests({ maxAgeMs: 0, signal });
  } catch (err) {
    throw sanitizeNavigationError(err, "история заявок ЕЛК");
  }
  return claimNumbersOf(list);
}
