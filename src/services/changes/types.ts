/** Версия формата `state.json`; файл новее известной версии не трогается. */
export const STATE_VERSION = 1;

export type Scope = "deadlines" | "schedule" | "inbox" | "claims" | "grades";
export const SCOPES: readonly Scope[] = ["deadlines", "schedule", "inbox", "claims", "grades"];
/** Область `grades` дорогая (страница на курс) — только по явной просьбе. */
export const DEFAULT_SCOPES: readonly Scope[] = ["deadlines", "schedule", "inbox", "claims"];

const SOURCE_SCOPE: Readonly<Record<string, Scope>> = {
  lms_calendar: "deadlines",
  elk_windows: "deadlines",
  elk_schedule: "schedule",
  lms_messages: "inbox",
  elk_notifications: "inbox",
  elk_claims: "claims",
};

/** Область источника; `lms_courses` (список курсов) и `lms_grades:<id>` — область `grades`. */
export function scopeOfSource(source: string): Scope | null {
  if (source === "lms_courses" || source.startsWith("lms_grades:")) return "grades";
  // Собственные ключи: `toString`/`constructor` не должны находиться через прототип.
  return Object.prototype.hasOwnProperty.call(SOURCE_SCOPE, source) ? SOURCE_SCOPE[source] : null;
}

/** Нормализованный отслеживаемый факт. В `attrs` — только поля, изменение которых есть событие. */
export interface Fact {
  /** Стабилен между снимками. */
  id: string;
  scope: Scope;
  kind: string;
  title: string;
  course?: string;
  attrs: Record<string, string | null>;
  /** Ось покрытия (момент в формате источника) — только у фактов со скользящим окном. */
  at?: string;
  /** Ключ склейки `removed`+`added` в `moved` (расписание: название|тип). */
  matchKey?: string;
}

/** Границы окна, в котором источник «видит» факты; `null` — не ограничено. Сравнение строк. */
export interface Coverage {
  from: string | null;
  to: string | null;
}

export type EventType = "added" | "changed" | "removed" | "moved" | "overdue";

export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface ChangeEvent {
  /** Глобальный, монотонный; выдаётся только при успешном коммите. */
  seq: number;
  /** Момент снимка, породившего событие (ISO UTC). */
  at: string;
  scope: Scope;
  source: string;
  type: EventType;
  /** `clock` — событие порождено ходом часов, а не изменением данных. */
  cause?: "clock";
  id: string;
  kind: string;
  title: string;
  course?: string;
  fields?: FieldChange[];
}

export interface Baseline {
  takenAt: string;
  coverage?: Coverage;
  facts: Record<string, Fact>;
}

export interface State {
  version: number;
  rev: number;
  /** Монотонен: не сбрасывается ни срезом журнала, ни `hse_changes_reset`. */
  nextSeq: number;
  /** Наибольший `seq`, выданный в ответе, по областям (ограничивает `ack`). */
  issued: Partial<Record<Scope, number>>;
  /**
   * Области ответов по их `ackSeq` (последние записи): `ack` сдвигает `seen` только областей ответа,
   * который клиент получил. Необязательно — файлы без поля читаются как прежде.
   */
  issues?: Record<string, Scope[]>;
  /** Невыданные события, срезанные потолком журнала; сообщаются в `gap` один раз. */
  lost: Partial<Record<Scope, number>>;
  baselines: Record<string, Baseline>;
  journal: ChangeEvent[];
  /** Курсор подтверждённого по областям. */
  seen: Partial<Record<Scope, number>>;
}

/** Правила сравнения источника. По умолчанию — все события включены, отсутствующее переносится. */
export interface DiffFlags {
  /** По умолчанию true. */
  emitChanged?: boolean;
  /** По умолчанию true; false у входящего, оценок и заявок (у заявок события только `added`/`changed`, §5). */
  emitRemoved?: boolean;
  /** Переносить в новую базу факты, отсутствующие в ответе (по умолчанию true; для входящего и оценок — false; у заявок — по умолчанию). */
  carryMissing?: boolean;
  /** Склеивать `removed`+`added` с одинаковым `matchKey` в `moved`. */
  mergeMoves?: boolean;
  /** Порождать `overdue` по `attrs.due`; срок должен быть UTC в виде `ГГГГ-ММ-ДДTЧЧ:ммZ`, иначе пропускается. */
  detectOverdue?: boolean;
  /** Новый элемент с пустой оценкой — не событие. */
  silentEmptyGrade?: boolean;
}

/** Что отдаёт извлекатель источника. */
export interface SourceResult {
  facts: Fact[];
  coverage?: Coverage;
  warnings?: string[];
  /** Выборка усечена: `removed` не вычисляется. */
  truncated?: boolean;
}
