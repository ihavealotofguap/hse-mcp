import type { WriteAdapter } from "../../writes/runner.js";
import { executeCertificate } from "./execute.js";
import {
  type CertificateArgs,
  type CertificateObserved,
  certificatePayload,
  describeCertificate,
  observeCertificate,
} from "./plan.js";
import {
  CERTIFICATE_COMMIT_DEADLINE_MS,
  MANUAL_CHECK_WARNING,
  verifyCertificateOnly,
} from "./verify.js";

/**
 * Заказ справки в ЕЛК (спека №4 §10, §17, седьмой и восьмой проходы): разбор формы
 * `/student-service/student-service-first?components=<serviceId>`, предусловия сухого прогона,
 * описание для владельца, отпечаток состояния для `previewToken`, сама запись (заполнение формы и
 * один клик её «Отправить») и проверка по истории заявок (§7, §10).
 *
 * Форма — Formily поверх Element Plus: поля `.el-form-item` с подписью `.el-form-item__label`,
 * выпадающие списки раскрываются кликом по обёртке `.el-select` (не по `input`), варианты —
 * `.el-select-dropdown__item` в отдельном всплывающем окне, закрытие — `Escape`. Отправка — POST
 * `/rest-api/camunda-gateway/process/start` по кнопке «Отправить»; заказ **необратим** (в ЕЛК нет
 * отмены заявки). Чтение формы ничего не выбирает и не нажимает «Отправить»; на время чтения
 * страница отклоняет любые свои не-GET запросы.
 *
 * Неожиданная форма (нет полей, поле без подписи или незнакомого типа, повтор подписи, не одна
 * «Отправить», индикатор обязательных полей не сходится с распознанным) — отказ, а не догадка.
 * Тексты отказов о форме ссылаются на поля по номеру, без значений; номера заявок (снимок до заказа)
 * живут только в памяти наблюдения и в ответ, журнал и ошибки не попадают.
 *
 * Модули по этапам протокола: `form` — разбор формы, `claims` — история заявок, `plan` — предусловия
 * и план (сухой прогон), `execute` — запись до и после `commitPoint` (покадровая, см. там), `verify` —
 * проверка исхода. Ответ `process/start` (даже 2xx) — только сигнал: исход решает появление ровно
 * одной новой заявки в свежей истории (номер — только в ответе тула).
 */

export {
  certificateTestSeams,
  claimNumbersOf,
} from "./claims.js";

export {
  checkFormState,
  expectedFieldValues,
  type FormSnapshot,
} from "./execute.js";

export {
  buildCertificateForm,
  type CertificateField,
  type CertificateForm,
  needsExtraInput,
  normalizeLabel,
  type RawCertificateForm,
  type RawFormItem,
  readCertificateForm,
} from "./form.js";

export {
  type CertificateArgs,
  type CertificateObserved,
  type CertificatePlan,
  certificateFingerprint,
  checkCertificateArgs,
  planCertificate,
} from "./plan.js";

export {
  certificateResult,
  classifyCertificateOutcome,
  classifyClaimsOutcome,
  MANUAL_CHECK_WARNING,
  parseClaimCreated,
  pollNewClaims,
  type SubmitTrace,
} from "./verify.js";

export const certificateAdapter: WriteAdapter<CertificateArgs, CertificateObserved> = {
  op: "elk_order_certificate",
  invalidates: ["elk.claims", "elk.applications"],
  commitDeadlineMs: CERTIFICATE_COMMIT_DEADLINE_MS,
  // Любой неизвестный исход заказа несёт предупреждение о ручной сверке (в том числе при сбое или дедлайне).
  unknownWarnings: [MANUAL_CHECK_WARNING],
  targetOf: (args) => `service:${args.serviceId}`,
  observe: observeCertificate,
  describe: describeCertificate,
  payloadOf: certificatePayload,
  execute: executeCertificate,
  verifyOnly: verifyCertificateOnly,
};
