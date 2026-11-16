// Panel tests: (a) static rules for the sandboxed iframe, (b) behaviour of
// ui/settings.js against a DOM with a fake magpie bridge.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const uiDir = fileURLToPath(new URL("../ui/", import.meta.url));
const htmlPath = path.join(uiDir, "settings.html");
const html = fs.readFileSync(htmlPath, "utf8");
const settingsJs = fs.readFileSync(path.join(uiDir, "settings.js"), "utf8");
const modelsJs = fs.readFileSync(path.join(uiDir, "models.js"), "utf8");
const CUSTOM = "\u0000custom";

let failures = 0;
function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("use okAsync");
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${String(err && err.message).split("\n").join("\n  ")}`);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${String(err && err.message).split("\n").join("\n  ")}`);
  }
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- (a) static ---------------- */

const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)];

ok("settings.html has no inline script bodies", () => {
  for (const [, attrs, body] of scriptTags) {
    assert.match(attrs, /\bsrc=/, `script without src: <script${attrs}>`);
    assert.equal(body.trim(), "", `inline body in <script${attrs}>`);
  }
});

ok("settings.html has no <form>, <iframe> or <select>", () => {
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /<iframe\b/i);
  assert.doesNotMatch(html, /<select\b/i); // custom picker: <select> in the sandbox is unverified
});

ok("no external http(s) resource URLs in html or css", () => {
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(fs.readFileSync(path.join(uiDir, "settings.css"), "utf8"), /url\(\s*["']?https?:\/\//i);
});

ok("every script src / link href resolves to a file under ui/ (bridge is host-served)", () => {
  const refs = [];
  for (const [, attrs] of scriptTags) {
    const m = /\bsrc=["']([^"']+)["']/.exec(attrs);
    if (m) refs.push(m[1]);
  }
  for (const [tag] of linkTags) {
    const m = /\bhref=["']([^"']+)["']/.exec(tag);
    if (m) refs.push(m[1]);
  }
  assert.ok(refs.includes("settings.js"));
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^[a-z]+:/i, `absolute ref ${ref}`);
    if (ref === "_magpie/bridge.js") continue; // served by magpie beside every page
    assert.ok(fs.existsSync(path.join(uiDir, ref)), `missing ${ref}`);
  }
});

ok("models.js loads before settings.js", () => {
  const srcs = scriptTags.map(([, a]) => (/\bsrc=["']([^"']+)["']/.exec(a) || [])[1]).filter(Boolean);
  assert.ok(srcs.indexOf("models.js") !== -1 && srcs.indexOf("models.js") < srcs.indexOf("settings.js"));
});

ok("models.js parses as the documented globals (stub or host-written list)", () => {
  const ctx = {};
  vm.runInNewContext(modelsJs, ctx);
  assert.ok(Array.isArray(ctx.ASK_EXPERT_MODELS), "ASK_EXPERT_MODELS must be an array");
  assert.equal(typeof ctx.ASK_EXPERT_MODELS_AT, "string");
  for (const m of ctx.ASK_EXPERT_MODELS) {
    assert.equal(typeof m.id, "string");
    assert.equal(typeof m.name, "string");
    assert.equal(typeof m.reasoning, "boolean");
    assert.ok(Array.isArray(m.levels));
  }
});

ok("settings.js uses no network / storage / dynamic-module primitives", () => {
  for (const token of ["fetch(", "XMLHttpRequest", "WebSocket", "localStorage", "eval(", "import("]) {
    assert.equal(settingsJs.includes(token), false, `settings.js mentions ${token}`);
  }
});

ok("sendReasoningEffort is dropped from the written options", () => {
  assert.match(settingsJs, /delete out\.sendReasoningEffort/);
  assert.doesNotMatch(html, /sendReasoningEffort/);
});

ok("every label targets a control, and each control is labelled", () => {
  const { window } = new JSDOM(html);
  const doc = window.document;
  const controls = [...doc.querySelectorAll("input, textarea, button")];
  assert.ok(controls.length >= 10);
  for (const el of controls) {
    const labelled = (el.id && doc.querySelector(`label[for="${el.id}"]`))
      || el.getAttribute("aria-label")
      || el.getAttribute("aria-labelledby")
      || (el.classList.contains("picker-opt"));
    assert.ok(labelled, `unlabelled control ${el.id || el.outerHTML.slice(0, 40)}`);
  }
  for (const label of doc.querySelectorAll("label[for]")) {
    assert.ok(doc.getElementById(label.getAttribute("for")), `dangling label for ${label.getAttribute("for")}`);
  }
  window.close();
});

ok("every dropdown button points at an existing listbox", () => {
  const { window } = new JSDOM(html);
  const doc = window.document;
  const btns = [...doc.querySelectorAll('button[aria-haspopup="listbox"]')];
  assert.equal(btns.length, 8, "4 model pickers + 4 effort pickers");
  for (const b of btns) {
    const list = doc.getElementById(b.getAttribute("aria-controls"));
    assert.ok(list, `no list for ${b.id}`);
    assert.equal(list.getAttribute("role"), "listbox");
    assert.equal(b.getAttribute("aria-expanded"), "false");
    assert.ok(doc.getElementById(b.getAttribute("aria-labelledby").split(" ")[0]), `bad aria-labelledby on ${b.id}`);
  }
  window.close();
});

/* ---------------- (b) behaviour ---------------- */

const MODELS = [
  { id: "group/a", name: "Alpha", reasoning: false, levels: [] },
  { id: "auto/b", name: "Beta Long Name", reasoning: true, levels: ["low", "high"] },
];

async function mount(opts = {}) {
  const theme = { dark: false, lang: "en", tokens: {}, ...(opts.theme || {}) };
  const dom = new JSDOM(html, {
    url: pathToFileURL(htmlPath).href,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const calls = [];
  let current = JSON.parse(JSON.stringify(opts.options || {}));
  let themeFn = null;

  win.magpie = {
    ready: Promise.resolve(theme),
    onTheme(fn) { themeFn = fn; },
    options: {
      get() { return JSON.parse(JSON.stringify(current)); },
      set(obj) {
        calls.push({ at: Date.now(), obj: JSON.parse(JSON.stringify(obj)) });
        current = { ...current, ...obj };
        return Promise.resolve(JSON.parse(JSON.stringify(current)));
      },
    },
    context: {},
  };

  const inject = (src) => {
    const s = win.document.createElement("script");
    s.textContent = src;
    win.document.body.appendChild(s);
  };
  inject(modelsJs);
  // after the stub: models.js is what overwrites the globals at runtime
  win.ASK_EXPERT_MODELS = opts.models === undefined ? MODELS : opts.models;
  win.ASK_EXPERT_MODELS_AT = opts.at || "";
  inject(settingsJs);
  await settle(25);
  const hook = win.__askExpertTest;
  assert.ok(hook, "test hook missing");
  hook.setDebounce(opts.debounce ?? 12);
  hook.setMinInterval(opts.minInterval ?? 30);

  const $ = (id) => win.document.getElementById(id);
  const type = (id, value) => {
    const el = $(id);
    el.value = value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  const values = (name) => Array.from(hook.list(name));
  const at = (name, value) => {
    const i = values(name).indexOf(value);
    assert.ok(i >= 0, `${value} not offered by ${name}: ${JSON.stringify(values(name))}`);
    hook.pick(name, i);
  };
  const valueOf = (name) => hook.picked(name);
  const doc = win.document;
  return { dom, win, doc, $, type, calls, hook, values, at, valueOf, theme: (t) => themeFn && themeFn(t) };
}

await okAsync("dropdowns are prefilled from options.get()", async () => {
  const m = await mount({ options: { model: "group/a", modelHigh: "auto/b", effort: "high", effortHigh: "low" } });
  assert.equal(m.valueOf("model"), "group/a");
  assert.equal(m.valueOf("modelHigh"), "auto/b");
  assert.equal(m.valueOf("effortHigh"), "low");
  assert.match(m.$("modelBtn").textContent, /Alpha — group\/a/);
  assert.equal(m.$("apiKey").type, "password");
  assert.equal(m.$("timeout").value, "600");
  assert.equal(m.calls.length, 0, "prefill must not save");
  m.dom.window.close();
});

await okAsync("empty list offers only (not set) and Custom…", async () => {
  const m = await mount({ models: [], options: {} });
  assert.deepEqual(m.values("model"), ["", CUSTOM]);
  assert.deepEqual(m.values("modelLow"), ["", CUSTOM]);
  assert.deepEqual(m.values("effort"), ["", "none", "low", "medium", "high", "xhigh", "max"]);
  assert.match(m.$("modelBtn").textContent, /not set/);
  assert.match(m.$("listInfo").textContent, /fills in/);
  m.dom.window.close();
});

await okAsync("model list fills the dropdown with names and a reasoning marker", async () => {
  const m = await mount({ at: new Date().toISOString(), options: {} });
  assert.deepEqual(m.values("model"), ["", "group/a", "auto/b", CUSTOM]);
  const labels = [...m.doc.querySelectorAll("#modelList .picker-opt-label")].map((n) => n.textContent);
  assert.match(labels[1], /Alpha — group\/a/);
  const mark = m.doc.querySelector("#modelList .optmark");
  assert.equal(mark.textContent, "reasoning (low/high)");
  assert.match(m.$("listInfo").textContent, /2 models/);
  assert.match(m.$("listInfo").textContent, /just now/);
  m.dom.window.close();
});

await okAsync("picking a model saves it; Custom… reveals the text input", async () => {
  const m = await mount({ options: {} });
  m.at("model", "group/a");
  assert.equal(m.$("modelCustom").hidden, true);
  await m.hook.flush();
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].obj.model, "group/a");

  m.at("model", CUSTOM);
  assert.equal(m.$("modelCustom").hidden, false);
  m.type("modelCustom", "https-endpoint/some-model");
  await m.hook.flush();
  assert.equal(m.calls.at(-1).obj.model, "https-endpoint/some-model");
  m.dom.window.close();
});

await okAsync("a saved model missing from the list is shown as Custom, prefilled, never lost", async () => {
  const m = await mount({ options: { model: "old/gone-away" } });
  assert.equal(m.valueOf("model"), CUSTOM);
  assert.equal(m.$("modelCustom").hidden, false);
  assert.equal(m.$("modelCustom").value, "old/gone-away");
  m.type("timeout", "300");
  await m.hook.flush();
  assert.equal(m.calls.at(-1).obj.model, "old/gone-away");
  m.dom.window.close();
});

await okAsync("effort list follows the chosen model's levels", async () => {
  const m = await mount({ options: {} });
  assert.deepEqual(m.values("effort"), ["", "none", "low", "medium", "high", "xhigh", "max"], "unknown model → generic levels");
  m.at("model", "auto/b"); // levels low/high only
  await m.hook.flush();
  assert.deepEqual(m.values("effort"), ["", "none", "low", "high"]);
  assert.match(m.$("effortBtn").textContent, /Auto/);
  m.at("model", "group/a"); // no levels → generic
  await m.hook.flush();
  assert.deepEqual(m.values("effort"), ["", "none", "low", "medium", "high", "xhigh", "max"]);
  m.dom.window.close();
});

await okAsync("a saved effort not offered by the model survives as an extra item", async () => {
  const m = await mount({ options: { model: "auto/b", effort: "max" } });
  assert.equal(m.valueOf("effort"), "max");
  assert.deepEqual(m.values("effort"), ["", "none", "low", "high", "max"]);
  assert.match(m.$("effortBtn").textContent, /max/);
  await m.hook.flush();
  assert.equal(m.calls.length, 0);
  m.type("timeout", "120");
  await m.hook.flush();
  assert.equal(m.calls.at(-1).obj.effort, "max");
  m.dom.window.close();
});

await okAsync("per-level rows have their own effort dropdown that follows the row's model", async () => {
  const m = await mount({ options: {} });
  for (const lvl of ["Low", "Medium", "High"]) {
    const name = "effort" + lvl;
    assert.equal(m.values(name)[0], "");
    assert.match(m.$("effort" + lvl + "Btn").textContent, /use main effort/);
    assert.deepEqual(m.values(name).slice(0, 2), ["", "none"]);
  }
  // row model unknown, main set → follow main
  m.at("model", "auto/b");
  await m.hook.flush();
  assert.deepEqual(m.values("effortLow"), ["", "none", "low", "high"]);
  // row model overrides the main one
  m.at("modelHigh", "group/a");
  await m.hook.flush();
  assert.deepEqual(m.values("effortHigh"), ["", "none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(m.values("effortLow"), ["", "none", "low", "high"]);
  m.at("effortHigh", "xhigh");
  await m.hook.flush();
  const sent = m.calls.at(-1).obj;
  assert.equal(sent.effortHigh, "xhigh");
  assert.equal(sent.modelHigh, "group/a");
  assert.equal(sent.effortLow, "");
  m.dom.window.close();
});

await okAsync("one debounced save carries the whole merged object with right types", async () => {
  const m = await mount({ options: { model: "", timeout: 600, maxTokens: "", sendReasoningEffort: true, futureKey: { nested: 1 } } });
  m.at("model", "group/a");
  m.type("modelHighCustom", ""); // invisible custom input, still harmless
  m.at("effort", "medium");
  m.type("maxTokens", "1024");
  m.type("systemPrompt", "be terse");
  await m.hook.flush();
  assert.equal(m.calls.length, 1, `expected one write, got ${m.calls.length}`);
  const sent = m.calls[0].obj;
  assert.equal(sent.model, "group/a");
  assert.equal(sent.effort, "medium");
  assert.equal(sent.maxTokens, 1024);
  assert.equal(typeof sent.maxTokens, "number");
  assert.equal(sent.timeout, 600);
  assert.equal(typeof sent.timeout, "number");
  assert.equal(sent.systemPrompt, "be terse");
  assert.deepEqual(sent.futureKey, { nested: 1 }, "unknown keys must survive");
  assert.equal("sendReasoningEffort" in sent, false, "sendReasoningEffort must be gone");
  for (const k of ["model", "modelLow", "modelMedium", "modelHigh", "effort", "effortLow", "effortMedium", "effortHigh", "baseUrl", "apiKey"]) {
    assert.ok(k in sent, `merged object misses ${k}`);
  }
  m.dom.window.close();
});

await okAsync("clearing maxTokens saves an empty string, not a number", async () => {
  const m = await mount({ options: { maxTokens: "50" } });
  m.type("maxTokens", "");
  await m.hook.flush();
  assert.equal(m.calls[0].obj.maxTokens, "");
  m.dom.window.close();
});

await okAsync("invalid timeout is not saved, shows an error and resets to 600 on blur", async () => {
  const m = await mount({ options: { model: "typed" } });
  m.type("modelCustom", "g/m");
  m.type("timeout", "");
  await settle(40);
  assert.equal(m.calls.length, 0, "invalid state must not save");
  assert.equal(m.$("timeoutErr").hidden, false);
  assert.ok(m.$("timeout").classList.contains("invalid"));
  m.$("timeout").dispatchEvent(new m.win.Event("blur", { bubbles: true }));
  assert.equal(m.$("timeout").value, "600");
  assert.equal(m.$("timeoutErr").hidden, true);
  await m.hook.flush();
  assert.equal(m.calls.length, 1, "fixed value must save");
  assert.equal(m.calls[0].obj.timeout, 600);
  m.dom.window.close();
});

await okAsync("timeout 0 and -3 are rejected, a positive number is not", async () => {
  const m = await mount({ options: {} });
  m.type("timeout", "0");
  await settle(40);
  assert.equal(m.calls.length, 0);
  assert.equal(m.$("timeoutErr").hidden, false);
  m.type("timeout", "-3");
  await settle(40);
  assert.equal(m.calls.length, 0);
  m.type("timeout", "2");
  await m.hook.flush();
  assert.equal(m.calls.length, 1);
  m.dom.window.close();
});

await okAsync("invalid maxTokens rejected, blank allowed", async () => {
  const m = await mount({ options: { maxTokens: "10" } });
  m.type("maxTokens", "1.5");
  await settle(40);
  assert.equal(m.calls.length, 0);
  assert.equal(m.$("maxTokensErr").hidden, false);
  m.type("maxTokens", "");
  await m.hook.flush();
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].obj.maxTokens, "");
  m.dom.window.close();
});

await okAsync("baseUrl must be http(s) or blank; error shows, host appears in the status line", async () => {
  const m = await mount({ options: {} });
  m.type("baseUrl", "api.example/v1");
  await settle(40);
  assert.equal(m.calls.length, 0);
  assert.equal(m.$("baseUrlErr").hidden, false);
  m.type("baseUrl", "https://api.example/v1");
  await m.hook.flush();
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].obj.baseUrl, "https://api.example/v1");
  assert.equal(m.$("modeText").textContent, "Using external endpoint api.example");
  m.type("baseUrl", "");
  await m.hook.flush();
  assert.equal(m.$("modeText").textContent, "Using Magpie's models");
  m.dom.window.close();
});

await okAsync("writes are serialised and at least minInterval apart", async () => {
  const m = await mount({ options: { model: "typed" }, debounce: 5, minInterval: 90 });
  m.type("modelCustom", "a");
  await settle(15);
  m.type("modelCustom", "ab");
  await settle(15);
  m.type("modelCustom", "abc");
  await m.hook.flush();
  assert.ok(m.calls.length >= 1);
  for (let i = 1; i < m.calls.length; i++) {
    const gap = m.calls[i].at - m.calls[i - 1].at;
    assert.ok(gap >= 85, `writes only ${gap}ms apart`);
  }
  assert.equal(m.calls.at(-1).obj.model, "abc");
  m.dom.window.close();
});

await okAsync("a third change within the same second is held, not dropped", async () => {
  const m = await mount({ options: { model: "typed" }, debounce: 5, minInterval: 120 });
  m.type("modelCustom", "one");
  await settle(20);
  m.type("modelCustom", "two");
  await settle(20);
  m.type("modelCustom", "three");
  assert.ok((await m.hook.flush()) >= 1);
  assert.equal(m.calls.at(-1).obj.model, "three");
  assert.equal(m.hook.pending(), false, "queue must drain");
  m.dom.window.close();
});

await okAsync("save indicator walks Saving… → Saved ✓", async () => {
  const m = await mount({ options: { model: "typed" }, minInterval: 0 });
  m.type("modelCustom", "x");
  assert.equal(m.hook.status(), "saving");
  await m.hook.flush();
  assert.equal(m.hook.status(), "saved");
  assert.equal(m.$("saveText").textContent, "Saved ✓");
  m.dom.window.close();
});

await okAsync("a rejected options.set reports Couldn't save", async () => {
  const m = await mount({ options: { model: "typed" } });
  m.win.magpie.options.set = () => Promise.reject(new Error("nope"));
  m.type("modelCustom", "y");
  await m.hook.flush();
  assert.equal(m.hook.status(), "error");
  assert.equal(m.$("saveText").textContent, "Couldn't save");
  m.dom.window.close();
});

await okAsync("zh from theme.lang translates and dark sets the attribute", async () => {
  const m = await mount({ theme: { dark: true, lang: "zh" }, models: [] });
  assert.equal(m.doc.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(m.doc.documentElement.getAttribute("lang"), "zh");
  assert.equal(m.doc.querySelector("h1").textContent, "求助专家");
  assert.equal(m.$("modelLabel").textContent, "专家模型");
  assert.match(m.$("modelBtn").textContent, /未设置/);
  assert.match(m.$("listInfo").textContent, /运行过一次/);
  m.theme({ dark: false, lang: "zh" });
  assert.equal(m.doc.documentElement.getAttribute("data-theme"), "light");
  assert.equal(m.$("modelLabel").textContent, "专家模型");
  m.theme({ dark: true, lang: "fr" });
  assert.equal(m.$("modelLabel").textContent, "Expert model", "unknown lang falls back to English");
  m.dom.window.close();
});

await okAsync("dark theme keeps dropdown items translated after a theme round-trip", async () => {
  const m = await mount({ theme: { dark: false, lang: "en" } });
  m.theme({ dark: true, lang: "zh" });
  assert.equal(m.values("effort")[1], "none");
  const labels = [...m.doc.querySelectorAll("#effortList .picker-opt-label")].map((n) => n.textContent);
  assert.match(labels[0], /自动/);
  m.dom.window.close();
});

await okAsync("reset link clears the system prompt and saves", async () => {
  const m = await mount({ options: { systemPrompt: "old" } });
  m.$("resetPrompt").dispatchEvent(new m.win.Event("click", { bubbles: true }));
  assert.equal(m.$("systemPrompt").value, "");
  await m.hook.flush();
  assert.equal(m.calls.at(-1).obj.systemPrompt, "");
  m.dom.window.close();
});

await okAsync("advanced details is closed by default and holds the risky fields", async () => {
  const m = await mount({ options: {} });
  assert.equal(m.$("advanced").open, false);
  for (const id of ["timeout", "maxTokens", "systemPrompt", "baseUrl", "apiKey"]) {
    assert.ok(m.$("advanced").contains(m.$(id)), `${id} must live in Advanced`);
  }
  m.dom.window.close();
});

if (failures) {
  console.log(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall panel tests passed");
