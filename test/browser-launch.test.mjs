import assert from "node:assert/strict";
import { test } from "node:test";

const {
  browserCandidates,
  isMissingBrowserError,
  launchWithFallback,
  DOWNLOADING_MESSAGE,
  DOWNLOAD_FAILED_MESSAGE,
} = await import(new URL("../dist/auth/browser-launch.js", import.meta.url).href);

// Тексты, которые Playwright 1.63 выдаёт при отсутствии браузера (сняты вживую).
const MISSING_CHROMIUM = new Error(
  "browserType.launch: Executable doesn't exist at /cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell"
);
const missingChannel = (name) =>
  new Error(`browserType.launch: Chromium distribution '${name}' is not found at /opt/${name}`);

test("порядок браузеров: auto — Chromium, затем Edge на Windows и Chrome на остальных", () => {
  assert.deepEqual(browserCandidates(undefined, "win32"), [undefined, "msedge", "chrome"]);
  assert.deepEqual(browserCandidates("auto", "darwin"), [undefined, "chrome", "msedge"]);
  assert.deepEqual(browserCandidates(" ", "linux"), [undefined, "chrome", "msedge"]);
  assert.deepEqual(browserCandidates("chromium", "win32"), [undefined]);
  assert.deepEqual(browserCandidates("MSEdge", "darwin"), ["msedge"]);
  assert.deepEqual(browserCandidates("chrome", "win32"), ["chrome"]);
  assert.throws(() => browserCandidates("firefox", "win32"), /HSE_BROWSER_CHANNEL/);
});

test("отсутствие браузера отличается от сбоя запуска", () => {
  assert.equal(isMissingBrowserError(MISSING_CHROMIUM), true);
  assert.equal(isMissingBrowserError(missingChannel("msedge")), true);
  assert.equal(
    isMissingBrowserError(new Error("Target page, context or browser has been closed")),
    false
  );
});

function deps(results, downloadState = "started") {
  const tried = [];
  const logs = [];
  let downloads = 0;
  return {
    tried,
    logs,
    get downloads() {
      return downloads;
    },
    launch: async (channel) => {
      tried.push(channel);
      const r = results[channel ?? "chromium"];
      if (r instanceof Error) throw r;
      return r;
    },
    download: () => {
      downloads++;
      return downloadState;
    },
    log: (line) => logs.push(line),
  };
}

test("есть скачанный Chromium — он и запускается, остальные не трогаются", async () => {
  const d = deps({ chromium: "browser" });
  assert.equal(await launchWithFallback([undefined, "msedge"], d), "browser");
  assert.deepEqual(d.tried, [undefined]);
  assert.equal(d.downloads, 0);
  assert.match(d.logs[0], /Chromium/);
});

test("нет Chromium — системный Edge без скачивания", async () => {
  const d = deps({ chromium: MISSING_CHROMIUM, msedge: "edge" });
  assert.equal(await launchWithFallback([undefined, "msedge", "chrome"], d), "edge");
  assert.equal(d.downloads, 0);
  assert.match(d.logs.at(-1), /Microsoft Edge/);
});

test("нет ни одного браузера — фоновое скачивание и понятная ошибка", async () => {
  const d = deps({
    chromium: MISSING_CHROMIUM,
    chrome: missingChannel("chrome"),
    msedge: missingChannel("msedge"),
  });
  await assert.rejects(() => launchWithFallback([undefined, "chrome", "msedge"], d), {
    message: DOWNLOADING_MESSAGE,
  });
  assert.equal(d.downloads, 1);
  const failed = deps({ chromium: MISSING_CHROMIUM }, "failed");
  await assert.rejects(() => launchWithFallback([undefined], failed), {
    message: DOWNLOAD_FAILED_MESSAGE,
  });
});

test("системный браузер упал при запуске, Chromium нет — тоже скачивание; текст сбоя не в логе", async () => {
  const crash = new Error("crash at C:\\Users\\student\\AppData\\profile");
  const d = deps({ chromium: MISSING_CHROMIUM, msedge: crash });
  await assert.rejects(() => launchWithFallback([undefined, "msedge"], d), {
    message: DOWNLOADING_MESSAGE,
  });
  assert.ok(d.logs.every((l) => !l.includes("student")));
});

test("явный канал без браузера — ошибка без скачивания; сбой запуска пробрасывается", async () => {
  const d = deps({ msedge: missingChannel("msedge") });
  await assert.rejects(() => launchWithFallback(["msedge"], d), /Не найден браузер/);
  assert.equal(d.downloads, 0);
  const crash = new Error("boom");
  await assert.rejects(() => launchWithFallback(["chrome"], deps({ chrome: crash })), crash);
});
