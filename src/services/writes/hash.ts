import crypto from "node:crypto";

/** sha256 в hex: отпечатки состояния для `previewToken` и сверка байтов файлов в адаптерах записи. */
export const sha256Hex = (data: string | Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");
