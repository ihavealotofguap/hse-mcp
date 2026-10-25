import { Refusal } from "../../writes/errors.js";
import { sha256Hex } from "../../writes/hash.js";
import type { WriteAdapter } from "../../writes/runner.js";
import { readClaimNumbers } from "./claims.js";
import {
  type CertificateForm,
  collapse,
  formUrl,
  needsExtraInput,
  normalizeLabel,
  readCertificateForm,
  readFormPage,
} from "./form.js";

/**
 * Сухой прогон заказа (спека №4 §10): отказы по аргументам, предусловия и план по прочитанной форме,
 * описание для владельца и отпечаток состояния для `previewToken`. Номера заявок (снимок до заказа)
 * живут только в памяти наблюдения.
 */

const MAX_FIELDS = 50;
const MAX_LABEL = 200;
const MAX_VALUE = 500;

export interface CertificateArgs {
  serviceId: number;
  /** Подпись поля → текст варианта выпадающего списка. */
  fields: Record<string, string>;
}

export interface CertificatePlan {
  /** Поля, которые заполнит заказ: значение — точный текст варианта формы, `current` — что там сейчас. */
  chosen: Array<{ label: string; value: string; current: string }>;
  /** Непустые поля, которые форма заполнила сама и которые уйдут в заявку как есть. */
  autofilled: Array<{ label: string; value: string }>;
  /** Обязательные поля, пустые на форме при чтении. */
  requiredEmpty: string[];
}

/** Наблюдение сухого прогона: форма, план и снимок номеров заявок (только в памяти). */
export interface CertificateObserved {
  serviceId: number;
  form: CertificateForm;
  plan: CertificatePlan;
  claimNumbers: string[];
}

const quoted = (labels: string[]) => labels.map((l) => `«${l}»`).join(", ");

/**
 * Варианты поля для отказа сухого прогона: подпись и тексты берутся из определения формы (личных данных
 * там нет); вариант, требующий дополнительного поля, помечен — выбрать его нельзя.
 */
const optionsHint = (options: string[]): string =>
  options.length === 0
    ? ""
    : ` (варианты: ${options.map((o) => `«${o}»${needsExtraInput(o) ? " (не поддерживается)" : ""}`).join(", ")})`;

/** Отказы по самим аргументам — до любого обращения к системе. */
export function checkCertificateArgs(args: CertificateArgs): void {
  const { serviceId, fields } = args as { serviceId: unknown; fields: unknown };
  if (typeof serviceId !== "number" || !Number.isSafeInteger(serviceId) || serviceId <= 0) {
    throw new Refusal("serviceId должен быть положительным целым числом");
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Refusal("fields должен быть словарём «подпись поля → вариант»");
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length > MAX_FIELDS)
    throw new Refusal(`слишком много полей в fields: не более ${MAX_FIELDS}`);
  const seen = new Set<string>();
  entries.forEach(([label, value], i) => {
    const norm = normalizeLabel(label);
    if (!norm || norm.length > MAX_LABEL)
      throw new Refusal(`fields, поле №${i + 1}: подпись пуста или слишком длинная`);
    if (seen.has(norm)) throw new Refusal(`fields: подпись ${quoted([norm])} повторяется`);
    seen.add(norm);
    if (typeof value !== "string" || !collapse(value) || value.length > MAX_VALUE) {
      throw new Refusal(
        `fields, поле ${quoted([norm])}: значение должно быть непустой строкой не длиннее ${MAX_VALUE} символов`
      );
    }
  });
}

/**
 * Предусловия сухого прогона и план заказа: каждая подпись `fields` — ровно одно поле формы,
 * доступный для выбора выпадающий список, значение — ровно один его вариант; все обязательные поля
 * либо уже заполнены формой, либо заданы. Заблокированные (автозаполненные) поля не меняются.
 */
export function planCertificate(
  form: CertificateForm,
  fields: Record<string, string>
): CertificatePlan {
  const byLabel = new Map(form.fields.map((f) => [f.label, f]));
  const given = new Map(
    Object.entries(fields).map(([label, value]) => [normalizeLabel(label), collapse(value)])
  );
  const unknown = [...given.keys()].filter((label) => !byLabel.has(label));
  if (unknown.length > 0) throw new Refusal(`неизвестные поля формы: ${quoted(unknown)}`);

  const chosen: CertificatePlan["chosen"] = [];
  for (const field of form.fields) {
    const value = given.get(field.label);
    if (value === undefined) continue;
    if (field.disabled)
      throw new Refusal(`поле ${quoted([field.label])} заполняется автоматически и не меняется`);
    if (field.kind !== "select")
      throw new Refusal(`поле ${quoted([field.label])}: в v1 заполняются только выпадающие списки`);
    const matches = field.options.filter((o) => o === value).length;
    if (matches === 0)
      throw new Refusal(
        `поле ${quoted([field.label])}: значения нет среди вариантов формы${optionsHint(field.options)}`
      );
    if (matches > 1)
      throw new Refusal(
        `поле ${quoted([field.label])}: вариант в списке формы повторяется — выбор неоднозначен`
      );
    chosen.push({ label: field.label, value, current: field.value });
  }
  // Итоговое значение каждого поля (выбранное или уже стоящее на форме) не должно требовать
  // дополнительного поля: его сухой прогон не видит, а v1 текстовые поля не заполняет.
  form.fields.forEach((field, i) => {
    if (needsExtraInput(given.get(field.label) ?? field.value)) {
      throw new Refusal(
        `поле №${i + 1}: выбранный вариант требует заполнить дополнительное поле, а v1 текстовые поля не заполняет — выберите другой вариант`
      );
    }
  });
  // Сухой прогон с пустым `fields` — разведка формы: отказ перечисляет, что выбирать (подписи и варианты).
  const missing = form.fields.filter((f) => f.required && !f.value && !given.has(f.label));
  if (missing.length > 0) {
    const list = missing.map((f) => `${quoted([f.label])}${optionsHint(f.options)}`).join("; ");
    throw new Refusal(
      `не заданы обязательные поля: ${list}; задайте их в fields и повторите сухой прогон — ничего не отправлено`
    );
  }
  return {
    chosen,
    autofilled: form.fields
      .filter((f) => f.value && !given.has(f.label))
      .map((f) => ({ label: f.label, value: f.value })),
    requiredEmpty: form.fields.filter((f) => f.required && !f.value).map((f) => f.label),
  };
}

const sortedPairs = (list: Array<{ label: string; value: string }>) =>
  list
    .map((x) => [x.label, x.value] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/**
 * Отпечаток состояния для `previewToken`: sha256 от JSON с множеством номеров заявок (порядок и
 * повторы не важны), выбранными значениями и автозаполнением формы. Новая заявка, другой вариант или
 * изменившееся автозаполнение между сухим прогоном и записью — расхождение токена.
 */
export function certificateFingerprint(input: {
  claimNumbers: string[];
  chosen: Array<{ label: string; value: string }>;
  autofilled: Array<{ label: string; value: string }>;
}): string {
  return sha256Hex(
    JSON.stringify({
      claims: [...new Set(input.claimNumbers)].sort(),
      chosen: sortedPairs(input.chosen),
      autofilled: sortedPairs(input.autofilled),
    })
  );
}

const W_IRREVERSIBLE = "заказ необратим: способа отмены в ЕЛК нет";
const W_AUTOFILL =
  "автозаполненные значения форма берёт из личных данных ЕЛК и отправит как есть; они показаны только в этом ответе";
// Чтение ничего не выбирает, поэтому поля, которые форма дорисовывает по выбранному варианту, в
// снимок не попадают: список полей и незаполненных обязательных может быть неполным.
const W_DEPENDENT =
  "поля, которые появляются после выбора варианта, сухой прогон не видит: форма может потребовать больше данных, чем показано здесь";
const W_READ_ONLY =
  "форма открывалась только для чтения: списки раскрывались и закрывались без выбора, «Отправить» не нажималась";

export const observeCertificate: WriteAdapter<CertificateArgs, CertificateObserved>["observe"] =
  async (args, signal) => {
    checkCertificateArgs(args);
    const form = await readFormPage(
      formUrl(args.serviceId),
      (page) => readCertificateForm(page),
      signal
    );
    const plan = planCertificate(form, args.fields);
    const claimNumbers = await readClaimNumbers(signal);
    return { serviceId: args.serviceId, form, plan, claimNumbers };
  };

export const describeCertificate: WriteAdapter<CertificateArgs, CertificateObserved>["describe"] = (
  _args,
  { serviceId, form, plan, claimNumbers }
) => {
  const warnings = [W_IRREVERSIBLE, W_DEPENDENT, W_AUTOFILL, W_READ_ONLY];
  return {
    preview: {
      serviceId,
      title: form.title,
      fields: form.fields.map((f) => ({
        label: f.label,
        required: f.required,
        kind: f.kind,
        // Заблокированное поле форма заполняет сама, менять его нельзя.
        editable: !f.disabled,
        value: f.value || null,
        options: f.options,
      })),
      fill: plan.chosen.map((c) => ({
        label: c.label,
        value: c.value,
        current: c.current || null,
      })),
      requiredEmpty: plan.requiredEmpty,
      submitDisabled: form.submitDisabled,
      // Число, а не номера: номера заявок остаются в памяти наблюдения.
      requestsBefore: claimNumbers.length,
    },
    warnings,
  };
};

export const certificatePayload: WriteAdapter<CertificateArgs, CertificateObserved>["payloadOf"] = (
  _args,
  { plan, claimNumbers }
) => {
  return {
    files: [],
    state: certificateFingerprint({
      claimNumbers,
      chosen: plan.chosen,
      autofilled: plan.autofilled,
    }),
  };
};
