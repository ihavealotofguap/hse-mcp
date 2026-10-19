import { test } from "node:test";
import assert from "node:assert/strict";

const { assertReadOnlyPath, resolveScopedUrl } = await import(
  new URL("../dist/url-utils.js", import.meta.url).href
);

const BASE = "https://edu.hse.ru";

test("разрешены обычные страницы чтения", () => {
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/calendar/view.php?view=month`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5`));
});

test("sesskey в query отклоняется", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/login/logout.php?sesskey=abc`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?SESSKEY=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?a=1&SessKey=1`), /sesskey/);
});

test("sesskey с процентным кодированием ключа отклоняется", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?sess%6Bey=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?%73%65%73%73%6b%65%79=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?SESS%4BEY=1`), /sesskey/);
});

test("sesskey в query фрагмента отклоняется", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/x#/y?sesskey=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x#a=1&sess%6Bey=1`), /sesskey/);
});

test("абсолютный URL на разрешённом хосте с sesskey отклоняется", () => {
  const url = resolveScopedUrl(BASE, `${BASE}/login/logout.php?sesskey=abc`);
  assert.throws(() => assertReadOnlyPath(url), /sesskey/);
});

test("относительный путь без ведущего слэша проверяется после resolveScopedUrl", () => {
  const bad = resolveScopedUrl(BASE, "mod/assign/view.php?id=5&action=editsubmission");
  assert.throws(() => assertReadOnlyPath(bad), /action/);
  const bad2 = resolveScopedUrl(BASE, "x?sesskey=1");
  assert.throws(() => assertReadOnlyPath(bad2), /sesskey/);
  const ok = resolveScopedUrl(BASE, "mod/assign/view.php?id=5");
  assert.doesNotThrow(() => assertReadOnlyPath(ok));
});

test("action в /mod/assign/ отклоняется", () => {
  assert.throws(
    () => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action=editsubmission`),
    /action/
  );
  assert.throws(
    () => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action=removesubmissionconfirm`),
    /action/
  );
});

test("action: ключ в любом регистре, повторы и кодирование", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&ACTION=grading`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?action=&action=submit`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&%61ction=submit`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action=%65dit`), /action/);
});

test("пути /mod/assign/ распознаются независимо от регистра и лишних слэшей", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/MOD/Assign/view.php?action=edit`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}//mod//assign/view.php?action=edit`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/x/../assign/view.php?action=edit`), /action/);
});

test("ключи-массивы sesskey[] / sesskey%5B%5D / sesskey[0] считаются sesskey", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?sesskey[]=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?sesskey%5B%5D=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?SessKey%5b0%5d=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x#a=1&sesskey[]=1`), /sesskey/);
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/x?sesskeys[]=1`));
});

test("action[] на assign считается action", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action[]=editsubmission`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action%5B%5D=submit`), /action/);
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action[]=`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/forum/view.php?action[]=view`));
});

test("/mod/assign без хвостового слэша — тоже путь assign", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign?action=editsubmission`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/MOD/Assign?action=x`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/?action=x`), /action/);
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign?id=5`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assignment?action=x`));
});

test("пустой action на assign разрешён", () => {
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action=`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action`));
});

test("action вне /mod/assign/ разрешён", () => {
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/forum/view.php?id=5&action=view`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/calendar/view.php?action=x`));
});

test("сообщение об ошибке не содержит ни значения query, ни URL", () => {
  const secret = "SECRETVALUE123";
  const cases = [
    `${BASE}/login/logout.php?sesskey=${secret}`,
    `${BASE}/mod/assign/view.php?id=5&action=${secret}`,
  ];
  for (const url of cases) {
    let msg = "";
    try {
      assertReadOnlyPath(url);
    } catch (e) {
      msg = e.message;
    }
    assert.notEqual(msg, "", "ожидалось исключение");
    assert.ok(!msg.includes(secret), "значение query в сообщении");
    assert.ok(!msg.includes(url), "полный URL в сообщении");
    assert.ok(!msg.includes("edu.hse.ru"), "хост в сообщении");
  }
});

test("resolveScopedUrl по-прежнему бросает для внешнего хоста", () => {
  assert.throws(() => resolveScopedUrl(BASE, "https://evil.example.com/x"), /запрещено/);
});

// PHP нормализует имена переменных запроса: убирает ведущие пробелы и читает всё от первой `[` как индекс массива.
test("ведущий пробел в ключе (%20, +) не обходит sesskey и action", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?%20sesskey=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?+sesskey=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?++%20SessKey=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x#a=1&%20sesskey=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&+action=editsubmission`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&%20%20ACTION=submit`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?%20action[]=submit`), /action/);
});

test("несколько и хвостовые группы скобок: sesskey[a][b], sesskey[]x, action[0]", () => {
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?sesskey[a][b]=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?sesskey%5Ba%5D%5Bb%5D=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?sesskey[]x=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x?sesskey[0=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/x#sesskey[a][b]=1`), /sesskey/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action[0]=submit`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action[a][b]=submit`), /action/);
  assert.throws(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&action[]x=submit`), /action/);
});

test("нормализация ключей не задевает обычные параметры", () => {
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/calendar/view.php?view=month&%20course=5`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/x?ids[]=5&ids[]=6&id[0]=7`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/x?my sesskey=1&sesskeyx=2`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&my+action=submit&actions[0]=x`));
  assert.doesNotThrow(() => assertReadOnlyPath(`${BASE}/mod/assign/view.php?id=5&%20action=`));
});

test("сообщение при нормализованных ключах не повторяет URL и значение", () => {
  const secret = "SECRETVALUE456";
  for (const url of [`${BASE}/x?%20sesskey=${secret}`, `${BASE}/mod/assign/view.php?id=5&action[0]=${secret}`]) {
    let msg = "";
    try {
      assertReadOnlyPath(url);
    } catch (e) {
      msg = e.message;
    }
    assert.notEqual(msg, "");
    assert.ok(!msg.includes(secret) && !msg.includes("edu.hse.ru") && !msg.includes(url));
  }
});
