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

test("cache:false: abort вызывающего до commit() доходит до ctx.signal, а commit() после отмены бросает", async () => {
  let signal;
  let commitError;
  const call = defineResource({
    name: "t.abortforward",
    cache: false,
    load: async (_a, ctx) => {
      signal = ctx.signal;
      await sleep(60);
      try {
        ctx.commit();
      } catch (e) {
        commitError = e;
        throw e;
      }
      return 1;
    },
  });
  const ac = new AbortController();
  const p = call(undefined, { signal: ac.signal });
  await sleep(10);
  ac.abort(new Error("клиент отменил"));
  await assert.rejects(p, /клиент отменил/);
  assert.equal(signal.aborted, true);
  await sleep(100);
  assert.match(commitError?.message ?? "", /клиент отменил/);
});

test("commit() после истечения исходного дедлайна бросает и не сбрасывает кэш", async () => {
  const readLoad = counting();
  const read = defineResource({ name: "t.read3", ttl: 60_000, key: () => "k", load: readLoad });
  await read(undefined);

  let commitError;
  const write = defineResource({
    name: "t.latecommit",
    cache: false,
    deadlineMs: 30,
    invalidates: ["t.read3"],
    load: async (_a, ctx) => {
      await sleep(80);
      try {
        ctx.commit();
      } catch (e) {
        commitError = e;
        throw e;
      }
      return 1;
    },
  });
  await assert.rejects(write(undefined), /не уложился/);
  await sleep(100);
  assert.match(commitError?.message ?? "", /не уложился/);
  await read(undefined);
  assert.equal(readLoad.calls, 1);
});

test("abort вызывающего после commit() не отменяет ctx.signal загрузчика", async () => {
  let signal;
  const call = defineResource({
    name: "t.abortafternosignal",
    cache: false,
    load: async (_a, ctx) => {
      signal = ctx.signal;
      ctx.commit();
      await sleep(60);
      return "ok";
    },
  });
  const ac = new AbortController();
  const p = call(undefined, { signal: ac.signal });
  await sleep(10);
  ac.abort(new Error("клиент отменил"));
  assert.equal(await p, "ok");
  assert.equal(signal.aborted, false);
});

test("повторный commit() заново взводит дедлайн", async () => {
  const ok = defineResource({
    name: "t.recommit1",
    cache: false,
    load: async (_a, ctx) => {
      ctx.commit(100);
      await sleep(70);
      ctx.commit(100);
      await sleep(70);
      return "ok";
    },
  });
  assert.equal(await ok(undefined), "ok");

  const late = defineResource({
    name: "t.recommit2",
    cache: false,
    load: async (_a, ctx) => {
      ctx.commit(100);
      await sleep(70);
      ctx.commit(100);
      await sleep(300);
      return "поздно";
    },
  });
  await assert.rejects(late(undefined), /после точки невозврата/);
});

test("cache:false: неизвестное имя в invalidates отклоняет вызов до load", async () => {
  const load = counting();
  const call = defineResource({ name: "t.nocacheunknown", cache: false, load, invalidates: ["no.such"] });
  await assert.rejects(call(undefined), /invalidateResource: неизвестный ресурс "no\.such"/);
  assert.equal(load.calls, 0);
});

test("cache:false: invalidates срабатывает после commit() и при успехе загрузчика", async () => {
  const readLoad = counting();
  const read = defineResource({ name: "t.read4", ttl: 60_000, key: () => "k", load: readLoad });
  await read(undefined);

  const write = defineResource({
    name: "t.write4",
    cache: false,
    invalidates: ["t.read4"],
    load: async (_a, ctx) => {
      ctx.commit();
      return "записано";
    },
  });
  assert.equal(await write(undefined), "записано");
  await read(undefined);
  assert.equal(readLoad.calls, 2);
});

/** Вызывает `fn` при подключённом шпионе unhandledRejection; возвращает собранные причины. */
async function withRejectionSpy(fn) {
  const seen = [];
  const spy = (reason) => seen.push(reason);
  process.on("unhandledRejection", spy);
  try {
    await fn();
    // unhandledRejection обрабатывается после опустошения микрозадач — даём тикам отработать
    await sleep(30);
  } finally {
    process.off("unhandledRejection", spy);
  }
  return seen;
}

test("abort вызывающего синхронно внутри load (до первого await): отказ без unhandledRejection", async () => {
  const variants = {
    "cache:false": (ctrl) => defineResource({ name: "t.syncabort1", cache: false, load: (_a, _ctx) => (ctrl.abort(new Error("отменено")), Promise.reject(new Error("после отмены"))) }),
    "кэшируемый": (ctrl) => defineResource({ name: "t.syncabort2", ttl: 1000, key: () => "k", load: (_a, _ctx) => (ctrl.abort(new Error("отменено")), Promise.reject(new Error("после отмены"))) }),
  };
  for (const [label, make] of Object.entries(variants)) {
    const ctrl = new AbortController();
    const call = make(ctrl);
    const seen = await withRejectionSpy(async () => {
      await assert.rejects(call(undefined, { signal: ctrl.signal }), /отменено/, label);
    });
    assert.deepEqual(seen, [], `${label}: unhandledRejection`);
  }
});
