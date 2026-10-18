import { test } from "node:test";
import assert from "node:assert/strict";

const { defineResource } = await import(new URL("../dist/resource.js", import.meta.url).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Загрузчик со счётчиком вызовов. */
function counting(fn = async () => ({ v: 1 })) {
  const load = async (args, ctx) => {
    load.calls++;
    return fn(args, ctx);
  };
  load.calls = 0;
  return load;
}

test("неизвестное имя в invalidates отклоняет вызов до load", async () => {
  const load = counting();
  const call = defineResource({ name: "t.a", ttl: 1000, key: () => "k", load, invalidates: ["no.such"] });
  await assert.rejects(call(undefined), /invalidateResource: неизвестный ресурс "no\.such"/);
  assert.equal(load.calls, 0);
});

test("cache:false: параллельные вызовы не дедуплицируются", async () => {
  const load = counting(async () => {
    await sleep(10);
    return { v: 1 };
  });
  const call = defineResource({ name: "t.nocache1", cache: false, load });
  await Promise.all([call(undefined), call(undefined)]);
  assert.equal(load.calls, 2);
});

test("cache:false: последовательные вызовы с maxAgeMs не кэшируются", async () => {
  const load = counting();
  const call = defineResource({ name: "t.nocache2", cache: false, load });
  await call(undefined, { maxAgeMs: 60_000 });
  await call(undefined, { maxAgeMs: 60_000 });
  await call(undefined, { maxAgeMs: 0 });
  await call(undefined);
  assert.equal(load.calls, 4);
});

test("cache:false: invalidates срабатывает после commit() даже при ошибке загрузчика", async () => {
  const readLoad = counting();
  const read = defineResource({ name: "t.read", ttl: 60_000, key: () => "k", load: readLoad });
  await read(undefined);
  await read(undefined);
  assert.equal(readLoad.calls, 1);

  const write = defineResource({
    name: "t.write1",
    cache: false,
    invalidates: ["t.read"],
    load: async (_a, ctx) => {
      ctx.commit();
      throw new Error("сбой после точки невозврата");
    },
  });
  await assert.rejects(write(undefined), /сбой после точки невозврата/);
  await read(undefined);
  assert.equal(readLoad.calls, 2);
});

test("cache:false: ошибка до commit() не сбрасывает кэш", async () => {
  const readLoad = counting();
  const read = defineResource({ name: "t.read2", ttl: 60_000, key: () => "k", load: readLoad });
  await read(undefined);

  const write = defineResource({
    name: "t.write2",
    cache: false,
    invalidates: ["t.read2"],
    load: async () => {
      throw new Error("отказ до точки невозврата");
    },
  });
  await assert.rejects(write(undefined), /отказ до точки невозврата/);
  await read(undefined);
  assert.equal(readLoad.calls, 1);
});

test("commit(50) заменяет дедлайн: работа 200 мс отклоняется «после точки невозврата»", async () => {
  let signal;
  const call = defineResource({
    name: "t.commitdeadline",
    cache: false,
    load: async (_a, ctx) => {
      signal = ctx.signal;
      ctx.commit(50);
      await sleep(200);
      return 1;
    },
  });
  await assert.rejects(call(undefined), /t\.commitdeadline не уложился в 0\.05 с после точки невозврата/);
  assert.equal(signal.aborted, true);
});

test("commit() гасит исходный дедлайн загрузки", async () => {
  const call = defineResource({
    name: "t.commitreplaces",
    cache: false,
    deadlineMs: 30,
    load: async (_a, ctx) => {
      ctx.commit(500);
      await sleep(100);
      return "готово";
    },
  });
  assert.equal(await call(undefined), "готово");
});

test("без commit() действует deadlineMs: работа 200 мс отклоняется «не уложился»", async () => {
  const call = defineResource({
    name: "t.nocommitdeadline",
    cache: false,
    deadlineMs: 50,
    load: async () => {
      await sleep(200);
      return 1;
    },
  });
  await assert.rejects(call(undefined), (e) => /не уложился/.test(e.message) && !/точки невозврата/.test(e.message));
});

test("abort вызывающего после commit() не прерывает вызов", async () => {
  const call = defineResource({
    name: "t.abortafter",
    cache: false,
    load: async (_a, ctx) => {
      ctx.commit();
      await sleep(100);
      return "значение загрузчика";
    },
  });
  const ac = new AbortController();
  const p = call(undefined, { signal: ac.signal });
  await sleep(20);
  ac.abort(new Error("клиент отменил"));
  assert.equal(await p, "значение загрузчика");
});

test("abort вызывающего до commit() отклоняет вызов причиной отмены", async () => {
  const call = defineResource({
    name: "t.abortbefore",
    cache: false,
    load: async () => {
      await sleep(100);
      return 1;
    },
  });
  const ac = new AbortController();
  const p = call(undefined, { signal: ac.signal });
  await sleep(20);
  ac.abort(new Error("клиент отменил"));
  await assert.rejects(p, /клиент отменил/);
});

test("кэшируемый ресурс: параллельные вызовы делят загрузку, результат заморожен", async () => {
  const load = counting(async () => {
    await sleep(10);
    return { list: [1, 2] };
  });
  const call = defineResource({ name: "t.cached", ttl: 60_000, key: () => "k", load });
  const [a, b] = await Promise.all([call(undefined), call(undefined)]);
  assert.equal(load.calls, 1);
  assert.equal(a, b);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.list), true);
});
