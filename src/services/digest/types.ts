import type { SourceStatus } from "../../run-source.js";

export type { SourceStatus };

/** Тип элемента сводки. */
export type ItemKind =
  | "lesson"
  | "exam"
  | "assignment"
  | "lms_activity"
  | "elk_window"
  | "elk_task"
  | "elk_claim"
  | "lms_message"
  | "notification";

export interface DigestItem {
  kind: ItemKind;
  /**
   * Момент, к которому нужно успеть / когда состоится (ISO 8601 с локальным смещением).
   * null — не распознан или не применим (письма, уведомления, заявки, задачи).
   */
  when: string | null;
  /** Конец занятия/окна. */
  until?: string;
  /** Момент прихода/обновления у информационных элементов (письма, уведомления, заявки). */
  received?: string;
  title: string;
  course?: string;
  place?: string;
  /** Имя коллектора: elk_schedule, lms_deadlines, ... */
  source: string;
  /** true только для просроченных и несданных работ (в т.ч. когда сдача уже закрыта). */
  overdue?: boolean;
  unread?: boolean;
  /** isImportant уведомления ЕЛК. */
  important?: boolean;
  url?: string;
  /** Нераспознанные/сопутствующие поля источника. */
  raw?: Record<string, unknown>;
}

export interface DigestResult {
  generatedAt: string;
  window: { from: string; to: string };
  items: DigestItem[];
  sources: Record<string, SourceStatus>;
}

/** Что возвращает коллектор источника. */
export interface CollectorResult {
  items: DigestItem[];
  warnings?: string[];
}

export interface DateRange {
  from: Date;
  to: Date;
}

/** Элементы фильтра курсов: число — точный id, строка — подстрока названия. */
export type CourseFilter = Array<string | number>;
