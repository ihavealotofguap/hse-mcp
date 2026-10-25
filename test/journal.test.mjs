import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Каталог журнала — временный; задаётся до импорта модуля.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "hsemcp-journal-"));
process.env.HSE_WRITES_DIR = path.join(base, "default");

const {
  recordJournal,
  latestByToken,
  findUnresolvedByTarget,
  JOURNAL_MAX_AGE_MS,
  JOURNAL_MAX_ENTRIES,
} = await import(new URL("../dist/services/writes/journal.js", import.meta.url).href);

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
  await recordJournal(
    entry({ tokenId: "t2t2t2t2t2t2", stage: "verified", outcome: "unknown" }),
    dir
  );
  // t3: sending -> verified/confirmed
  await recordJournal(entry({ tokenId: "t3t3t3t3t3t3", stage: "sending" }), dir);
  await recordJournal(
    entry({ tokenId: "t3t3t3t3t3t3", stage: "verified", outcome: "confirmed" }),
    dir
  );
  // t4: другая цель, не разрешена
  await recordJournal(
    entry({ tokenId: "t4t4t4t4t4t4", targetId: "dddddddddddd", stage: "sent" }),
    dir
  );

  const found = await findUnresolvedByTarget("bbbbbbbbbbbb", dir);
  assert.deepEqual(found.map((e) => e.tokenId).sort(), ["t1t1t1t1t1t1", "t2t2t2t2t2t2"]);
  // по каждому токену — последняя запись
  assert.equal(found.find((e) => e.tokenId === "t2t2t2t2t2t2").stage, "verified");

  const except = await findUnresolvedByTarget("bbbbbbbbbbbb", dir, "t1t1t1t1t1t1");
  assert.deepEqual(
    except.map((e) => e.tokenId),
    ["t2t2t2t2t2t2"]
  );

  assert.deepEqual(
    (await findUnresolvedByTarget("dddddddddddd", dir)).map((e) => e.tokenId),
    ["t4t4t4t4t4t4"]
  );
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
  await recordJournal(
    entry({ at: old, tokenId: "oldoldoldold" }),
    dir,
    new Date(now.getTime() - 91 * 86_400_000)
  );
  await recordJournal(entry({ at: fresh, tokenId: "freshfreshfr" }), dir, now);
  const ids = readJournal(dir).map((e) => e.tokenId);
  assert.deepEqual(ids, ["freshfreshfr"]);
});

test("лишние поля в файл не попадают", async () => {
  const dir = tmpDir();
  await recordJournal(
    entry({
      stage: "verified",
      outcome: "rejected",
      durationMs: 5,
      errorClass: "validation",
      text: "секрет",
      name: "file.pdf",
      courseId: 42,
    }),
    dir
  );
  await recordJournal(entry({ tokenId: "zzzzzzzzzzzz", text: "секрет", name: "file.pdf" }), dir);
  const allowed = new Set([
    "at",
    "op",
    "tokenId",
    "targetId",
    "stage",
    "outcome",
    "durationMs",
    "errorClass",
  ]);
  const list = readJournal(dir);
  assert.equal(list.length, 2);
  for (const e of list)
    for (const k of Object.keys(e)) assert.ok(allowed.has(k), `лишний ключ ${k}`);
  assert.equal(list[0].errorClass, "validation");
  const raw = fs.readFileSync(path.join(dir, "journal.json"), "utf8");
  assert.ok(!raw.includes("секрет") && !raw.includes("file.pdf"));
});

test("10 параллельных recordJournal: 10 записей, файл валиден", async () => {
  const dir = tmpDir();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      recordJournal(entry({ tokenId: String(i).padStart(12, "0") }), dir)
    )
  );
  const list = readJournal(dir);
  assert.equal(list.length, 10);
  assert.equal(new Set(list.map((e) => e.tokenId)).size, 10);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock")),
    []
  );
});

test("карантин: journal.json присутствует всегда — безблокировочный читатель во время записи не видит пустой журнал", async () => {
  const dir = tmpDir();
  const original = JSON.stringify([
    entry({ tokenId: "keepkeepkeep", stage: "sending" }),
    { at: 5, tokenId: "x" },
  ]);
  const file = path.join(dir, "journal.json");
  fs.writeFileSync(file, original);

  // Читатели без блокировки (как latestByToken) крутятся на микрозадачах между шагами записи. Их
  // несколько и с разным сдвигом по тактам: хотя бы один попадает в любое окно между шагами записи.
  let done = false;
  let reads = 0;
  let missing = 0;
  // Раунд — все читатели по 50 чтений, затем уступка циклу событий (иначе таймеры и ввод-вывод голодают).
  const round = () =>
    Promise.all(
      Array.from({ length: 12 }, async (_, offset) => {
        for (let i = 0; i < offset; i++) await Promise.resolve();
        for (let i = 0; i < 50 && !done; i++) {
          const last = await latestByToken("keepkeepkeep", dir);
          reads++;
          if (!last) missing++;
        }
      })
    );
  const reader = (async () => {
    while (!done) {
      await round();
      await new Promise((r) => setImmediate(r));
    }
  })();
  try {
    await recordJournal(entry({ tokenId: "newnewnewnew", stage: "verified" }), dir);
  } finally {
    done = true;
    await reader;
  }
  assert.ok(reads > 0, "читатель не отработал");
  assert.equal(missing, 0, `читатель ${missing} раз(а) не увидел неразрешённую запись`);
  const corrupt = fs.readdirSync(dir).filter((n) => /^journal\.json\.corrupt-\d+/.test(n));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), "utf8"), original);
  assert.deepEqual(
    readJournal(dir).map((e) => e.tokenId),
    ["keepkeepkeep", "newnewnewnew"]
  );
});

test("карантин не затирает существующий .corrupt-<ts>: второй вынос получает другое имя", async () => {
  const dir = tmpDir();
  const bad1 = "{ первый";
  const bad2 = "[1, ";
  fs.writeFileSync(path.join(dir, "journal.json"), bad1);
  await recordJournal(entry({ tokenId: "oneoneoneone", stage: "verified" }), dir);
  const firstQuarantine = fs.readdirSync(dir).filter((n) => /^journal\.json\.corrupt-/.test(n));
  assert.equal(firstQuarantine.length, 1);
  // повторная порча в ту же миллисекунду не должна затереть первый карантин: занимаем имена `Date.now()` вперёд
  const realNow = Date.now;
  Date.now = () => Number(firstQuarantine[0].match(/corrupt-(\d+)/)[1]);
  try {
    fs.writeFileSync(path.join(dir, "journal.json"), bad2);
    await recordJournal(entry({ tokenId: "twotwotwotwo", stage: "verified" }), dir);
  } finally {
    Date.now = realNow;
  }
  const all = fs.readdirSync(dir).filter((n) => /^journal\.json\.corrupt-/.test(n));
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((n) => fs.readFileSync(path.join(dir, n), "utf8")).sort(),
    [bad1, bad2].sort()
  );
});

test("повреждённый JSON: не падает, журнал начинается заново, оригинал сохранён копией в .corrupt-<ts>", async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "journal.json"), "{ не json");
  await recordJournal(entry({ stage: "verified" }), dir);
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
  const seeded = {
    ...entry({ tokenId: "seedseedseed", stage: "verified", outcome: "confirmed" }),
    text: "секрет",
    name: "file.pdf",
  };
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
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes(".corrupt-")),
    []
  );
});

test("валидный массив с невалидными элементами: чтение их игнорирует, запись уводит оригинал в .corrupt-<ts>", async () => {
  const dir = tmpDir();
  const good = entry({ tokenId: "goodgoodgood" });
  const original = JSON.stringify([
    good,
    { at: 5, tokenId: "x" },
    "строка",
    null,
    { at: new Date().toISOString() },
  ]);
  fs.writeFileSync(path.join(dir, "journal.json"), original);
  // чтение: игнор плохих элементов, файл не трогается
  assert.equal((await latestByToken("goodgoodgood", dir)).tokenId, "goodgoodgood");
  assert.equal(fs.readFileSync(path.join(dir, "journal.json"), "utf8"), original);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes(".corrupt-")),
    []
  );
  // запись: оригинал в карантине, в новом журнале валидная запись и новая
  await recordJournal(entry({ tokenId: "newnewnewnew", stage: "verified" }), dir);
  const corrupt = fs.readdirSync(dir).filter((n) => /^journal\.json\.corrupt-\d+/.test(n));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), "utf8"), original);
  assert.deepEqual(
    readJournal(dir).map((e) => e.tokenId),
    ["goodgoodgood", "newnewnewnew"]
  );
});

const REUSED = /^Error: этот previewToken уже использован; запись не выполнена$/;
const CORRUPT =
  /^Error: журнал записей повреждён; запись не выполнена — восстановите или удалите writes\/journal\.json в каталоге данных вручную после проверки сайта$/;

test("sending с уже известным tokenId отклоняется под lock-файлом; другие стадии того же токена и другие токены пишутся", async () => {
  const dir = tmpDir();
  await recordJournal(entry({ tokenId: "usedusedused" }), dir);
  await assert.rejects(() => recordJournal(entry({ tokenId: "usedusedused" }), dir), REUSED);
  // Токен с исходом (verified) тоже использован.
  await recordJournal(
    entry({ tokenId: "doneddonedd", stage: "verified", outcome: "confirmed" }),
    dir
  );
  await assert.rejects(() => recordJournal(entry({ tokenId: "doneddonedd" }), dir), REUSED);
  // Исход и повторные стадии того же токена — после точки невозврата, как и раньше.
  await recordJournal(
    entry({ tokenId: "usedusedused", stage: "verified", outcome: "unknown" }),
    dir
  );
  await recordJournal(entry({ tokenId: "othertokenxx" }), dir);
  assert.deepEqual(
    readJournal(dir).map((e) => [e.tokenId, e.stage]),
    [
      ["usedusedused", "sending"],
      ["doneddonedd", "verified"],
      ["usedusedused", "verified"],
      ["othertokenxx", "sending"],
    ]
  );
});

test("параллельные sending одного токена: записан ровно один, остальные отклонены без id в тексте", async () => {
  const dir = tmpDir();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => recordJournal(entry({ tokenId: "racerracerrr" }), dir))
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((x) => x.status === "rejected")) {
    assert.match(String(r.reason), REUSED);
    assert.ok(!r.reason.message.includes("racerracerrr"));
  }
  assert.equal(readJournal(dir).length, 1);
});

for (const [what, content] of [
  ["не JSON", "{ не json"],
  ["обрыв массива", "[1, "],
  ["не массив", '{"a":1}'],
  [
    "массив с невалидным элементом",
    JSON.stringify([entry({ tokenId: "goodgoodgood" }), { at: 5 }]),
  ],
]) {
  test(`повреждённый журнал (${what}): строгие чтения и sending отказывают, лёгкие чтения и исход — как раньше`, async () => {
    const dir = tmpDir();
    const file = path.join(dir, "journal.json");
    fs.writeFileSync(file, content);
    await assert.rejects(() => latestByToken("goodgoodgood", dir, true), CORRUPT);
    await assert.rejects(
      () => findUnresolvedByTarget("bbbbbbbbbbbb", dir, undefined, true),
      CORRUPT
    );
    await assert.rejects(() => recordJournal(entry({ tokenId: "newnewnewnew" }), dir), CORRUPT);
    // Файл не тронут, карантина нет.
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.includes(".corrupt-")),
      []
    );
    // Нестрогие чтения (сухой прогон) работают как раньше.
    await latestByToken("goodgoodgood", dir);
    assert.deepEqual(await findUnresolvedByTarget("zzzzzzzzzzzz", dir), []);
    // Исход после точки невозврата по-прежнему записывается (с карантином).
    await recordJournal(entry({ tokenId: "outcomeoutco", stage: "verified" }), dir);
    assert.equal(fs.readdirSync(dir).filter((n) => /^journal\.json\.corrupt-/.test(n)).length, 1);
  });
}

test("строгие чтения: нет файла журнала — это пустой журнал, не повреждение", async () => {
  const dir = tmpDir();
  assert.equal(await latestByToken("aaaaaaaaaaaa", dir, true), undefined);
  assert.deepEqual(await findUnresolvedByTarget("bbbbbbbbbbbb", dir, undefined, true), []);
});
