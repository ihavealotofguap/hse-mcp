/** Исход записи: `unknown` — отправка могла дойти, но проверка чтением не подтвердила результат. */
export type Outcome = "confirmed" | "rejected" | "unknown";

/** Стадия записи в журнале: до отправки, после неё, после проверки чтением. */
export type Stage = "sending" | "sent" | "verified";

export type ErrorClass = "timeout" | "validation" | "network" | "auth" | "cancelled" | "other";

/** Данные, к которым привязан `previewToken`: токен одной операции не подходит к другой. */
export interface PreviewPayload {
  op: string;
  target: string;
  mode?: string;
  files: Array<{ name: string; sha256: string }>;
  /** Отпечаток наблюдённого состояния цели на момент сухого прогона. */
  state: string;
}
