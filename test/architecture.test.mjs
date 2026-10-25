// Правила слоёв (docs/architecture.md): импорты внутри src/ идут только вниз по слоям, сервисы одного
// слоя друг о друге не знают. Тест читает исходники, сборка ему не нужна.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const SRC = path.resolve(import.meta.dirname, "../src");

/** Адаптеры записи — папки (модули по этапам протокола): живут в папке сервиса, но относятся к слою записи. */
const WRITE_ADAPTERS = new Set(["services/lms/submissions", "services/elk/certificate"]);

function listTs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

/** Относительные импорты файла (статические, `export … from` и динамические). */
function importsOf(file) {
  const text = fs.readFileSync(file, "utf8");
  const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map(
    (m) => m[1]
  );
  return specs.map((s) =>
    path.relative(SRC, path.resolve(path.dirname(file), s)).replace(/\.js$/, ".ts")
  );
}

/** Слой файла: `entry`, `core`, `writes`, `adapter:<svc>`, `tools:<svc>` или `service:<svc>`. */
function layerOf(rel) {
  const p = rel.split(path.sep).join("/");
  if (p === "index.ts") return { name: "entry" };
  if (!p.startsWith("services/")) return { name: "core" };
  const svc = p.split("/")[1];
  if (svc === "writes") return { name: "writes", svc };
  if ([...WRITE_ADAPTERS].some((dir) => p.startsWith(`${dir}/`))) return { name: "adapter", svc };
  if (p.endsWith("/tools.ts")) return { name: "tools", svc };
  return { name: "service", svc };
}

/** Сервисы, на которые может опираться сервис (сверх ядра). */
const SERVICE_DEPS = {
  lms: [],
  elk: [],
  digest: ["lms", "elk"],
  changes: ["lms", "elk", "digest"],
  system: [],
};

function allowed(from, to) {
  if (from.name === "entry") return true;
  if (to.name === "core") return true;
  if (from.name === "core") return false;
  if (to.name === "entry" || to.name === "tools")
    return from.name === "tools" && from.svc === to.svc;
  switch (from.name) {
    case "writes":
      return to.name === "writes";
    case "adapter":
      return (
        to.name === "writes" ||
        ((to.name === "service" || to.name === "adapter") && to.svc === from.svc)
      );
    case "service":
      return (
        to.name === "service" && (to.svc === from.svc || SERVICE_DEPS[from.svc]?.includes(to.svc))
      );
    case "tools":
      return to.name === "writes" || to.svc === from.svc;
    default:
      return false;
  }
}

const describe = (l) => (l.svc ? `${l.name}:${l.svc}` : l.name);

test("импорты в src/ соблюдают слои (docs/architecture.md)", () => {
  const violations = [];
  for (const file of listTs(SRC)) {
    const rel = path.relative(SRC, file);
    const from = layerOf(rel);
    if (from.name === "service" && !(from.svc in SERVICE_DEPS)) {
      violations.push(`${rel}: новый сервис «${from.svc}» не описан в SERVICE_DEPS этого теста`);
      continue;
    }
    for (const target of importsOf(file)) {
      const to = layerOf(target);
      if (!allowed(from, to)) {
        violations.push(
          `${rel} → ${target}: ${describe(from)} не может зависеть от ${describe(to)}`
        );
      }
    }
  }
  assert.deepEqual(violations, [], `нарушения слоёв:\n${violations.join("\n")}`);
});

test("каждый адаптер записи существует", () => {
  for (const rel of WRITE_ADAPTERS) assert.ok(fs.existsSync(path.join(SRC, rel, "index.ts")), rel);
});
