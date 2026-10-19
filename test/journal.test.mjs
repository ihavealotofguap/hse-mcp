import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Каталог журнала — временный; задаётся до импорта модуля.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-journal-"));
process.env.HSE_WRITES_DIR = path.join(base, "default");

const { recordJournal, latestByToken, findUnresolvedByTarget, JOURNAL_MAX_AGE_MS, JOURNAL_MAX_ENTRIES } = await import(
  new URL("../dist/services/writes/journal.js", import.meta.url).href
);

let counter = 0;
function tmpDir() {
  return fs.mkdtempSync(path.join(base, `case${counter++}-`));
}
const readJournal = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8"));
const entry = (over = {}) => ({
  at: new Date().toISOString(),
  op: "lms_submit_assignment",
  tokenId: "aaaaaaaaaaaa",
  targetId: "bbbbbbbbbbbb",
  stage: "sending",
  ...over,
});

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

test("константы журнала", () => {
  assert.equal(JOURNAL_MAX_AGE_MS, 90 * 86_400_000);
  assert.equal(JOURNAL_MAX_ENTRIES, 200);
});

test("sending, затем verified/confirmed одного токена: latestByToken возвращает verified", async () => {
  const dir = tmpDir();
  await recordJournal(entry({ stage: "sending" }), dir);
  await recordJournal(entry({ stage: "verified", outcome: "confirmed", durationMs: 120 }), dir);
  const last = await latestByToken("aaaaaaaaaaaa", dir);
  assert.equal(last.stage, "verified");
  assert.equal(last.outcome, "confirmed");
  assert.equal(last.durationMs, 120);
  assert.equal(await latestByToken("cccccccccccc", dir), undefined);
});

test("latestByToken без файла журнала возвращает undefined, а запись использует HSE_WRITES_DIR", async () => {
  assert.equal(await latestByToken("aaaaaaaaaaaa", path.join(base, "nonexistent")), undefined);
  await recordJournal(entry());
  assert.equal((await latestByToken("aaaaaaaaaaaa")).stage, "sending");
  assert.ok(fs.existsSync(path.join(process.env.HSE_WRITES_DIR, "journal.json")));
});

test("findUnresolvedByTarget: sending без исхода и verified/unknown есть, confirmed нет, exceptTokenId исключает", async () => {
  const dir = tmpDir();
  // t1: sending без исхода
  await recordJournal(entry({ tokenId: "t1t1t1t1t1t1", stage: "sending" }), dir);
  // t2: sending -> verified/unknown
  await recordJournal(entry({ tokenId: "t2t2t2t2t2t2", stage: "sending" }), dir);
  await recordJournal(entry({ tokenId: "t2t2t2t2t2t2", stage: "verified", outcome: "unknown" }), dir);
  // t3: sending -> verified/confirmed
  await recordJournal(entry({ tokenId: "t3t3t3t3t3t3", stage: "sending" }), dir);
  await recordJournal(entry({ tokenId: "t3t3t3t3t3t3", stage: "verified", outcome: "confirmed" }), dir);
  // t4: другая цель, не разрешена
  await recordJournal(entry({ tokenId: "t4t4t4t4t4t4", targetId: "dddddddddddd", stage: "sent" }), dir);

  const found = await findUnresolvedByTarget("bbbbbbbbbbbb", dir);
  assert.deepEqual(found.map((e) => e.tokenId).sort(), ["t1t1t1t1t1t1", "t2t2t2t2t2t2"]);
  // по каждому токену — последняя запись
  assert.equal(found.find((e) => e.tokenId === "t2t2t2t2t2t2").stage, "verified");

  const except = await findUnresolvedByTarget("bbbbbbbbbbbb", dir, "t1t1t1t1t1t1");
  assert.deepEqual(except.map((e) => e.tokenId), ["t2t2t2t2t2t2"]);

  assert.deepEqual((await findUnresolvedByTarget("dddddddddddd", dir)).map((e) => e.tokenId), ["t4t4t4t4t4t4"]);
  assert.deepEqual(await findUnresolvedByTarget("eeeeeeeeeeee", dir), []);
});

test("201 запись: в файле 200, старейшая срезана", async () => {
  const dir = tmpDir();
  for (let i = 0; i < 201; i++) {
    await recordJournal(entry({ tokenId: String(i).padStart(12, "0") }), dir);
  }
  const list = readJournal(dir);
  assert.equal(list.length, 200);
  assert.equal(list[0].tokenId, "000000000001");
  assert.equal(list[199].tokenId, "000000000200");
});

test("запись старше 90 дней срезается (по параметру now)", async () => {
  const dir = tmpDir();
  const now = new Date("2026-10-18T12:00:00Z");
  const old = new Date(now.getTime() - 91 * 86_400_000).toISOString();
  const fresh = new Date(now.getTime() - 89 * 86_400_000).toISOString();
  // сама устаревшая запись при добавлении уже срезается
  await recordJournal(entry({ at: old, tokenId: "oldoldoldold" }), dir, now);
  assert.equal(await latestByToken("oldoldoldold", dir), undefined);
  // ранее записанная запись срезается позднейшей записью
  await recordJournal(entry({ at: old, tokenId: "oldoldoldold" }), dir, new Date(now.getTime() - 91 * 86_400_000));
  await recordJournal(entry({ at: fresh, tokenId: "freshfreshfr" }), dir, now);
  const ids = readJournal(dir).map((e) => e.tokenId);
  assert.deepEqual(ids, ["freshfreshfr"]);
});

test("лишние поля в файл не попадают", async () => {
  const dir = tmpDir();
  await recordJournal(
    entry({ stage: "verified", outcome: "rejected", durationMs: 5, errorClass: "validation", text: "секрет", name: "file.pdf", courseId: 42 }),
    dir
  );
  await recordJournal(entry({ tokenId: "zzzzzzzzzzzz", text: "секрет", name: "file.pdf" }), dir);
  const allowed = new Set(["at", "op", "tokenId", "targetId", "stage", "outcome", "durationMs", "errorClass"]);
  const list = readJournal(dir);
  assert.equal(list.length, 2);
  for (const e of list) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `лишний ключ ${k}`);
  assert.equal(list[0].errorClass, "validation");
  const raw = fs.readFileSync(path.join(dir, "journal.json"), "utf8");
  assert.ok(!raw.includes("секрет") && !raw.includes("file.pdf"));
});

test("10 параллельных recordJournal: 10 записей, файл валиден", async () => {
  const dir = tmpDir();
  await Promise.all(Array.from({ length: 10 }, (_, i) => recordJournal(entry({ tokenId: String(i).padStart(12, "0") }), dir)));
  const list = readJournal(dir);
  assert.equal(list.length, 10);
  assert.equal(new Set(list.map((e) => e.tokenId)).size, 10);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock")), []);
});

test("повреждённый JSON: не падает, журнал начинается заново, старый файл переименован в .corrupt-<ts>", async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "journal.json"), "{ не json");
  await recordJournal(entry(), dir);
  const list = readJournal(dir);
  assert.equal(list.length, 1);
  const corrupt = fs.readdirSync(dir).filter((n) => /^journal\.json\.corrupt-\d+/.test(n));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), "utf8"), "{ не json");
});

test("повреждённый журнал при чтении: пусто, без исключения", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "journal.json"), "[1, ");
  assert.equal(await latestByToken("aaaaaaaaaaaa", dir), undefined);
  assert.deepEqual(await findUnresolvedByTarget("bbbbbbbbbbbb", dir), []);
});

test("чтение — белый список полей: лишние поля из правленого вручную файла не всплывают и не переписываются", async () => {
  const dir = tmpDir();
  const seeded = { ...entry({ tokenId: "seedseedseed", stage: "verified", outcome: "confirmed" }), text: "секрет", name: "file.pdf" };
  fs.writeFileSync(path.join(dir, "journal.json"), JSON.stringify([seeded]));
  const last = await latestByToken("seedseedseed", dir);
  assert.equal(last.stage, "verified");
  assert.ok(!("text" in last) && !("name" in last));
  assert.deepEqual(await findUnresolvedByTarget("bbbbbbbbbbbb", dir), []);
  // файл переписывается следующей записью — лишних полей уже нет, карантина нет (все элементы валидны)
  await recordJournal(entry({ tokenId: "othrothrothr" }), dir);
  const raw = fs.readFileSync(path.join(dir, "journal.json"), "utf8");
  assert.ok(!raw.includes("секрет") && !raw.includes("file.pdf"));
  assert.equal(readJournal(dir).length, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".corrupt-")), []);
});

test("валидный массив с невалидными элементами: чтение их игнорирует, запись уводит оригинал в .corrupt-<ts>", async () => {
  const dir = tmpDir();
  const good = entry({ tokenId: "goodgoodgood" });
  const original = JSON.stringify([good, { at: 5, tokenId: "x" }, "строка", null, { at: new Date().toISOString() }]);
  fs.writeFileSync(path.join(dir, "journal.json"), original);
  // чтение: игнор плохих элементов, файл не трогается
  assert.equal((await latestByToken("goodgoodgood", dir)).tokenId, "goodgoodgood");
  assert.equal(fs.readFileSync(path.join(dir, "journal.json"), "utf8"), original);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".corrupt-")), []);
  // запись: оригинал в карантине, в новом журнале валидная запись и новая
  await recordJournal(entry({ tokenId: "newnewnewnew" }), dir);
  const corrupt = fs.readdirSync(dir).filter((n) => /^journal\.json\.corrupt-\d+/.test(n));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), "utf8"), original);
  assert.deepEqual(readJournal(dir).map((e) => e.tokenId), ["goodgoodgood", "newnewnewnew"]);
});
