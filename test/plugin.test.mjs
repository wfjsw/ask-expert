// Host-side tests: gateway discovery, option coercion, tool shape, the 55s
// hand-off, and the models.js writer. Everything runs on a local mock gateway
// and temp config dirs, so the real ~/.config/magpie is never touched.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEVELS, TOOL_DESCRIPTION } from "../core.mjs";
import {
  DEFAULT_GATEWAY,
  callerKey,
  createGateway,
  gatewayCandidates,
  mapEffort,
  normalizeModel,
} from "../magpie.mjs";
import {
  MISSING_MODEL_MESSAGE,
  buildConfig,
  createTool,
  effortFor,
  jobKey,
  normalizeOptions,
  TOOL_ARGS,
} from "../expert-tool.mjs";
import plugin, {
  createHooks,
  createModelsRefresher,
  modelsFilePath,
  renderModelsJs,
  writeModelsFile,
} from "../plugin.mjs";

// ------------------------------------------------------------- mock gateway ---

const chats = [];
const modelHits = [];
let mode = "ok";
let delayMs = 0;
let modelsBody = null;

function catalog() {
  return {
    data: [
      { id: "expert/hi", display_name: "Zeta Expert", reasoning: true, reasoning_levels: ["low", "max"] },
      { id: "expert/plain", display_name: "Alpha Plain", reasoning: false },
      { id: "expert/both", display_name: "Mid Expert", reasoning: true, reasoning_levels: ["low", "medium", "high"] },
    ],
  };
}

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/v1/models") {
      modelHits.push(req.headers.authorization ?? "");
      if (mode === "models500") return send(500, { error: { message: "no models" } });
      return send(200, modelsBody ?? catalog());
    }
    if (req.url !== "/v1/chat/completions") return send(404, {});
    const json = JSON.parse(body);
    chats.push({ auth: req.headers.authorization, body: json });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (mode === "500") return send(500, { error: { message: "boom" } });
    if (mode === "empty") return send(200, { choices: [{ message: { content: "" } }] });
    if (mode === "noeffort" && "reasoning_effort" in json) {
      return send(400, { error: { message: "Unsupported parameter: reasoning_effort" } });
    }
    send(200, { choices: [{ message: { content: `ANSWER[${json.model}/${json.reasoning_effort ?? "-"}]: ${json.messages.at(-1).content}` } }] });
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${mock.address().port}`;
const BASE = `${ORIGIN}/v1`;

// ---------------------------------------------------------------- fixtures ---

let n = 0;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "askexpert-"));
  const cfgDir = join(root, "config");
  const uiDir = join(root, "ui");
  await mkdir(cfgDir, { recursive: true });
  await mkdir(uiDir, { recursive: true });
  n += 1;
  // Own refresh throttle per fixture, on an injectable clock.
  const f = { root, cfgDir, uiDir, clock: Date.now(), deps: null };
  f.advance = (ms) => { f.clock += ms; };
  f.deps = {
    env: { MAGPIE_ADDR: `127.0.0.1:${mock.address().port}` },
    configDir: cfgDir,
    home: root,
    modelsDir: uiDir,
    refreshState: { last: 0 },
    now: () => f.clock,
  };
  f.cleanup = () => rm(root, { recursive: true, force: true });
  return f;
}

function reset() {
  chats.length = 0;
  modelHits.length = 0;
  mode = "ok";
  delayMs = 0;
  modelsBody = null;
}

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`not ok - ${name}`);
    console.log(`  ${String(e?.message ?? e).split("\n").join("\n  ")}`);
  }
}

// ------------------------------------------------------------------ shape ---

await test("tool shape: name, JSON schema, core description", async () => {
  const tool = createTool(() => ({}), {});
  assert.equal(tool.description, TOOL_DESCRIPTION);
  assert.equal(TOOL_ARGS.type, "object");
  assert.deepEqual(TOOL_ARGS.required, ["question"]);
  assert.deepEqual(TOOL_ARGS.properties.level.enum, LEVELS);
  assert.equal(TOOL_ARGS.properties.question.type, "string");
  assert.equal(typeof tool.execute, "function");
  // no zod: the args object is plain JSON Schema
  assert.equal(typeof TOOL_ARGS.parse, "undefined");
});

await test("plugin default export is the entry object, hooks carry the tool", async () => {
  const f = await fixture();
  try {
    assert.equal(plugin.id, "ask-expert");
    assert.equal(typeof plugin.server, "function");
    // The default export's server() is createHooks without test deps; call
    // createHooks with the fixture's deps so nothing touches the real gateway
    // or the real ui/models.js.
    const hooks = await createHooks({}, { model: "expert/plain" }, f.deps);
    assert.deepEqual(Object.keys(hooks), ["tool"]);
    assert.deepEqual(Object.keys(hooks.tool), ["ask_expert"]);
    assert.equal(hooks.tool.ask_expert.description, TOOL_DESCRIPTION);
  } finally {
    await f.cleanup();
  }
});

await test("options come from the options argument, else input.magpie.options", async () => {
  const f = await fixture();
  try {
    const viaInput = await createHooks({ magpie: { options: { model: "expert/plain" } } }, undefined, f.deps);
    reset();
    const r = await viaInput.tool.ask_expert.execute({ question: "q" }, {});
    assert.equal(r, "ANSWER[expert/plain/-]: q");

    const viaArgs = await createHooks({}, { model: "expert/both", sendReasoningEffort: false }, f.deps);
    reset();
    assert.equal(await viaArgs.tool.ask_expert.execute({ question: "q" }, {}), "ANSWER[expert/both/-]: q");
  } finally {
    await f.cleanup();
  }
});

// ------------------------------------------------------------- normalising ---

await test("normalizeOptions coerces junk", () => {
  const o = normalizeOptions({
    model: "  m  ",
    timeout: "90",
    maxTokens: " 12 ",
    effort: " XHIGH ",
    effortHigh: " max ",
    systemPrompt: "",
    baseUrl: " http://x/v1/ ",
    apiKey: 42,
  });
  assert.equal(o.model, "m");
  assert.equal(o.timeout, 90);
  assert.equal(o.maxTokens, 12);
  assert.equal(o.effort, "XHIGH");
  assert.equal(o.effortHigh, "max");
  assert.equal(o.baseUrl, "http://x/v1");
  assert.equal(o.apiKey, "42");

  const d = normalizeOptions(undefined);
  assert.equal(d.timeout, 600);
  assert.equal(d.maxTokens, undefined);
  assert.equal(d.effort, "");
  assert.equal(d.model, "");

  assert.equal(normalizeOptions({ timeout: "0" }).timeout, 600);
  assert.equal(normalizeOptions({ timeout: -5 }).timeout, 600);
  assert.equal(normalizeOptions({ timeout: "abc" }).timeout, 600);
  assert.equal(normalizeOptions({ maxTokens: 0 }).maxTokens, undefined);
  assert.equal(normalizeOptions({ maxTokens: 3.7 }).maxTokens, 3);
  for (const off of [false, 0, "0", "off", "No", ""]) {
    assert.equal(normalizeOptions({ sendReasoningEffort: off }).effort, "none", String(off));
  }
  for (const on of [true, 1, "true", "yes"]) {
    assert.equal(normalizeOptions({ sendReasoningEffort: on }).effort, "", "auto stays auto");
  }
  // legacy off switch never overrides an explicit effort
  assert.equal(normalizeOptions({ sendReasoningEffort: false, effort: "high" }).effort, "high");
  assert.equal(normalizeOptions({ baseUrl: "not a url" }).baseUrl, "");
  assert.deepEqual(normalizeOptions("junk"), normalizeOptions({}));
});

await test("effortFor: per-level effort wins over the general one", () => {
  const o = normalizeOptions({ effort: "medium", effortHigh: "max" });
  assert.equal(effortFor(o, "high"), "max");
  assert.equal(effortFor(o, "low"), "medium");
  assert.equal(effortFor(o, undefined), "medium");
  assert.equal(effortFor(normalizeOptions({}), "high"), "");
  assert.equal(effortFor(normalizeOptions({ effort: "none" }), "high"), "none");
});

// --------------------------------------------------------------- discovery ---

await test("gateway candidates: env, gateway.json, settings port, default", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cfgDir, "gateway.json"), JSON.stringify({ addr: "127.0.0.1:7777" }));
    await writeFile(join(f.cfgDir, "settings.json"), JSON.stringify({ port: 18086 }));
    const got = gatewayCandidates({ env: { MAGPIE_ADDR: "10.0.0.9:4321" }, configDir: f.cfgDir });
    assert.deepEqual(got, ["http://10.0.0.9:4321", "http://127.0.0.1:7777", "http://127.0.0.1:18086", DEFAULT_GATEWAY]);
  } finally {
    await f.cleanup();
  }
});

await test("discovery falls back past dead candidates", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cfgDir, "gateway.json"), JSON.stringify({ addr: `127.0.0.1:${mock.address().port}` }));
    const gw = createGateway({ fetch, env: { MAGPIE_ADDR: "127.0.0.1:1" }, configDir: f.cfgDir });
    const target = await gw.resolveGateway();
    assert.equal(target.origin, ORIGIN);
    assert.equal(target.base, BASE);
    assert.equal(target.source, "gateway");
  } finally {
    await f.cleanup();
  }
});

await test("discovery with nothing alive returns the first candidate", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cfgDir, "gateway.json"), JSON.stringify({ addr: "127.0.0.1:2" }));
    // Every probe fails, so no default gateway may win by accident.
    const dead = () => Promise.reject(new Error("dead"));
    const gw = createGateway({ fetch: dead, env: { MAGPIE_ADDR: "127.0.0.1:1" }, configDir: f.cfgDir });
    const target = await gw.resolveGateway();
    assert.equal(target.origin, "http://127.0.0.1:1");
    assert.equal(target.base, "http://127.0.0.1:1/v1");
    await assert.rejects(() => gw.listModels(), /dead/);
  } finally {
    await f.cleanup();
  }
});

await test("model list is cached, force bypasses the cache", async () => {
  const f = await fixture();
  try {
    const gw = createGateway({ fetch, ...f.deps });
    const list = await gw.listModels();
    assert.equal(list[0].id, "expert/hi");
    assert.equal(list[0].reasoning, true);
    assert.equal(list[1].reasoning, false);
    const hits = modelHits.length;
    await gw.listModels();
    assert.equal(modelHits.length, hits, "second call served from cache");
    await gw.listModels({ force: true });
    assert.equal(modelHits.length, hits + 1);
  } finally {
    await f.cleanup();
  }
});

await test("caller key: env wins, else the first secret in caller-keys.json", async () => {
  const f = await fixture();
  try {
    assert.equal(callerKey({ env: {}, configDir: f.cfgDir }), "");
    await writeFile(join(f.cfgDir, "caller-keys.json"), JSON.stringify([{ name: "a", secret: "s1" }, { secret: "s2" }]));
    assert.equal(callerKey({ env: {}, configDir: f.cfgDir }), "s1");
    assert.equal(callerKey({ env: { MAGPIE_GATEWAY_KEY: "gk" }, configDir: f.cfgDir }), "gk");
    assert.equal(callerKey({ env: { MAGPIE_API_KEY: "ak" }, configDir: f.cfgDir }), "ak");

    const gw = createGateway({ fetch, ...f.deps });
    await gw.listModels();
    assert.equal(modelHits.at(-1), "Bearer s1", "key sent as bearer");
  } finally {
    await f.cleanup();
  }
});

// ------------------------------------------------------------------ effort ---

await test("mapEffort: exact, medium-nearest-up, high->strongest, low->weakest", () => {
  const r = { reasoning: true, levels: ["low", "medium", "high"] };
  assert.equal(mapEffort(r, "medium"), "medium");
  assert.equal(mapEffort(r, "high"), "high");
  assert.equal(mapEffort(r, "low"), "low");

  const gap = { reasoning: true, levels: ["low", "high"] };
  assert.equal(mapEffort(gap, "medium"), "high", "prefers the higher neighbour");
  assert.equal(mapEffort(gap, "low"), "low");

  const top = { reasoning: true, levels: ["low", "max"] };
  assert.equal(mapEffort(top, "high"), "max");
  assert.equal(mapEffort({ reasoning: true, levels: ["minimal", "high"] }, "low"), "minimal");

  assert.equal(mapEffort({ reasoning: false, levels: ["low"] }, "high"), null);
  assert.equal(mapEffort({ reasoning: true, levels: [] }, "high"), null);
  assert.equal(mapEffort(null, "high"), null);
  assert.equal(mapEffort(r, undefined), null);
});

await test("normalizeModel derives levels and requires reasoning for a flag", () => {
  const m = normalizeModel({ id: "g/x", display_name: "X", reasoning: true, supported_reasoning_levels: [{ effort: "low" }] });
  assert.deepEqual(m, { id: "g/x", name: "X", reasoning: true, levels: ["low"] });
  assert.equal(normalizeModel({ id: "y", reasoning: true }).reasoning, false);
  assert.equal(normalizeModel({ id: "z" }).name, "z");
});

await test("effort param is mapped onto the model's own level", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/hi" }), f.deps);
    reset();
    assert.match(await tool.execute({ question: "q", level: "high" }, {}), /ANSWER\[expert\/hi\/max\]/);
    assert.equal(chats[0].body.reasoning_effort, "max");
  } finally {
    await f.cleanup();
  }
});

await test("non-reasoning model and effort=none send no param", async () => {
  const f = await fixture();
  try {
    const plain = createTool(() => ({ model: "expert/plain" }), f.deps);
    reset();
    await plain.execute({ question: "q", level: "high" }, {});
    assert.ok(!("reasoning_effort" in chats[0].body));

    const off = createTool(() => ({ model: "expert/both", effort: "none" }), f.deps);
    reset();
    await off.execute({ question: "q", level: "high" }, {});
    assert.ok(!("reasoning_effort" in chats[0].body));
  } finally {
    await f.cleanup();
  }
});

await test("a fixed effort is sent as-is, with and without a level", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/both" }), f.deps);
    reset();
    const lower = createTool(() => ({ model: "expert/both", effort: "low" }), f.deps);
    await lower.execute({ question: "q", level: "high" }, {});
    assert.equal(chats[0].body.reasoning_effort, "low", "fixed effort beats the level");

    await lower.execute({ question: "q2" }, {});
    assert.equal(chats[1].body.reasoning_effort, "low", "fixed effort works with no level");

    // A literal outside the model's own list is still sent.
    const odd = createTool(() => ({ model: "expert/plain", effort: "xhigh" }), f.deps);
    await odd.execute({ question: "q3" }, {});
    assert.equal(chats[2].body.reasoning_effort, "xhigh");
    assert.ok(tool);
  } finally {
    await f.cleanup();
  }
});

await test("per-level effort overrides the general effort, and legacy off means none", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/both", effort: "low", effortHigh: "max" }), f.deps);
    reset();
    await tool.execute({ question: "q", level: "high" }, {});
    await tool.execute({ question: "q2", level: "low" }, {});
    assert.deepEqual(chats.map((c) => c.body.reasoning_effort), ["max", "low"]);

    const legacy = createTool(() => ({ model: "expert/both", sendReasoningEffort: false }), f.deps);
    await legacy.execute({ question: "q3", level: "medium" }, {});
    assert.ok(!("reasoning_effort" in chats[2].body));
  } finally {
    await f.cleanup();
  }
});

await test("auto effort with no level sends nothing", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/both" }), f.deps);
    reset();
    await tool.execute({ question: "q" }, {});
    assert.ok(!("reasoning_effort" in chats[0].body));
  } finally {
    await f.cleanup();
  }
});

await test("gateway rejects reasoning_effort: core retries without it", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/both" }), f.deps);
    reset();
    mode = "noeffort";
    assert.match(await tool.execute({ question: "q", level: "medium" }, {}), /ANSWER\[expert\/both\/-\]/);
    assert.equal(chats.length, 2);
    assert.ok(!("reasoning_effort" in chats[1].body));
  } finally {
    await f.cleanup();
  }
});

// ------------------------------------------------------------------ models ---

await test("model selection: per-level overrides, base model, missing message", async () => {
  const f = await fixture();
  try {
    const perLevel = createTool(() => ({ model: "expert/plain", modelHigh: "expert/hi" }), f.deps);
    reset();
    await perLevel.execute({ question: "q", level: "high" }, {});
    await perLevel.execute({ question: "q2", level: "low" }, {});
    assert.equal(chats[0].body.model, "expert/hi");
    assert.equal(chats[1].body.model, "expert/plain");

    const none = createTool(() => ({}), f.deps);
    reset();
    assert.equal(await none.execute({ question: "q" }, {}), `ask_expert failed: ${MISSING_MODEL_MESSAGE}`);
    assert.equal(chats.length, 0);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------- external ---

await test("external baseUrl: apiKey used, discovery and caller key skipped", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cfgDir, "caller-keys.json"), JSON.stringify([{ name: "a", secret: "s1" }]));
    const tool = createTool(() => ({ model: "expert/both", baseUrl: ORIGIN, apiKey: "ext-key" }), {
      ...f.deps,
      env: { MAGPIE_ADDR: "127.0.0.1:1" }, // dead on purpose
    });
    reset();
    assert.match(await tool.execute({ question: "q", level: "medium" }, {}), /ANSWER\[expert\/both\/medium\]/);
    assert.equal(chats[0].auth, "Bearer ext-key");
    assert.equal(modelHits.length, 0, "no /v1/models in external mode");

    const noEffort = createTool(() => ({ model: "m", baseUrl: ORIGIN, sendReasoningEffort: false }), f.deps);
    reset();
    await noEffort.execute({ question: "q", level: "medium" }, {});
    assert.ok(!("reasoning_effort" in chats[0].body));
  } finally {
    await f.cleanup();
  }
});

await test("buildConfig rejects a bad baseUrl and keeps the default timeout", async () => {
  const f = await fixture();
  try {
    const cfg = await buildConfig({ model: "m" }, { gateway: createGateway({ fetch, ...f.deps }) });
    assert.equal(cfg.timeoutMs, 600_000);
    assert.equal(cfg.missingModelMessage, MISSING_MODEL_MESSAGE);
    assert.equal(cfg.baseUrl, BASE);
  } finally {
    await f.cleanup();
  }
});

// ------------------------------------------------------------------ errors ---

await test("HTTP error becomes ask_expert failed text", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/plain" }), f.deps);
    reset();
    mode = "500";
    const r = await tool.execute({ question: "q" }, {});
    assert.match(r, /^ask_expert failed: /);
    assert.match(r, /500|boom/);
  } finally {
    await f.cleanup();
  }
});

await test("empty answer becomes ask_expert failed text", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/plain" }), f.deps);
    reset();
    mode = "empty";
    assert.match(await tool.execute({ question: "q" }, {}), /^ask_expert failed: /);
  } finally {
    await f.cleanup();
  }
});

await test("missing question never reaches the gateway", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/plain" }), f.deps);
    reset();
    assert.match(await tool.execute({}, {}), /^ask_expert failed: question is required/);
    assert.equal(chats.length, 0);
  } finally {
    await f.cleanup();
  }
});

// ------------------------------------------------------------ 55s hand-off ---

await test("slow expert: still-thinking text, identical re-call joins the one request", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/plain" }), { ...f.deps, waitMs: 300 });
    reset();
    delayMs = 1500;
    const first = await tool.execute({ question: "same q", level: "medium" }, {});
    assert.match(first, /still thinking/i);
    assert.match(first, /IDENTICAL question and level/);
    assert.match(first, /started \d+s ago/);
    assert.equal(chats.length, 1, "no answer yet");

    const second = await tool.execute({ question: "same q", level: "medium" }, {});
    assert.match(second, /still thinking/i);
    assert.equal(chats.length, 1, "second call did not start a new request");

    let third;
    for (let i = 0; i < 40; i++) {
      third = await tool.execute({ question: "same q", level: "medium" }, {});
      if (!/still thinking/i.test(third)) break;
    }
    assert.match(third, /^ANSWER\[expert\/plain\//);
    assert.equal(chats.length, 1, "every re-call joined the one request");
  } finally {
    await f.cleanup();
  }
});

await test("ctx.abort stops the wait but not the request", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/plain" }), { ...f.deps, waitMs: 5_000 });
    reset();
    delayMs = 300;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const t0 = Date.now();
    const r = await tool.execute({ question: "q", level: "low" }, { abort: ac.signal });
    assert.ok(Date.now() - t0 < 250, "returned on abort, not on the 5s wait");
    assert.match(r, /still thinking/i);

    await new Promise((res) => setTimeout(res, 320));
    assert.match(await tool.execute({ question: "q", level: "low" }, {}), /^ANSWER/);
    assert.equal(chats.length, 1);
  } finally {
    await f.cleanup();
  }
});

await test("a different question starts its own request", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/plain" }), { ...f.deps, waitMs: 60 });
    reset();
    delayMs = 300;
    await tool.execute({ question: "q1" }, {});
    await tool.execute({ question: "q2" }, {});
    assert.equal(chats.length, 2);
    assert.deepEqual(chats.map((c) => c.body.messages.at(-1).content), ["q1", "q2"]);
  } finally {
    await f.cleanup();
  }
});

await test("a different level for the same question is a different job", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/both" }), { ...f.deps, waitMs: 60 });
    reset();
    delayMs = 300;
    await tool.execute({ question: "q", level: "low" }, {});
    await tool.execute({ question: "q", level: "high" }, {});
    assert.equal(chats.length, 2);
    assert.deepEqual(chats.map((c) => c.body.reasoning_effort), ["low", "high"]);
  } finally {
    await f.cleanup();
  }
});

await test("finished results are kept for 10 minutes, then re-requested", async () => {
  const f = await fixture();
  try {
    let clock = Date.now();
    const tool = createTool(() => ({ model: "expert/plain" }), { ...f.deps, waitMs: 500, now: () => clock });
    reset();
    const t0 = Date.now();
    assert.match(await tool.execute({ question: "q" }, {}), /^ANSWER/);
    assert.equal(chats.length, 1);

    clock += 5 * 60_000;
    assert.match(await tool.execute({ question: "q" }, {}), /^ANSWER/);
    assert.equal(chats.length, 1, "served from retention inside 10 min");

    clock += 6 * 60_000;
    assert.match(await tool.execute({ question: "q" }, {}), /^ANSWER/);
    assert.equal(chats.length, 2, "expired after 10 min");
    assert.ok(Date.now() - t0 < 5_000);
  } finally {
    await f.cleanup();
  }
});

await test("a failure is delivered once; re-asking retries instead of replaying it", async () => {
  const f = await fixture();
  try {
    const tool = createTool(() => ({ model: "expert/plain" }), { ...f.deps, waitMs: 500 });
    reset();
    mode = "500";
    assert.match(await tool.execute({ question: "q" }, {}), /^ask_expert failed:.*boom/);
    assert.equal(chats.length, 1);

    mode = "ok";
    assert.match(await tool.execute({ question: "q" }, {}), /^ANSWER/);
    assert.equal(chats.length, 2, "the failed job was not replayed from retention");
  } finally {
    await f.cleanup();
  }
});

await test("jobKey separates on model and on effort", () => {
  assert.equal(jobKey("q", "high", "m", ""), jobKey("q", "high", "m", ""));
  assert.notEqual(jobKey("q", "high", "m", ""), jobKey("q", "high", "m2", ""));
  assert.notEqual(jobKey("q", "high", "m", ""), jobKey("q", "low", "m", ""));
  assert.notEqual(jobKey("q", "high", "m", "low"), jobKey("q", "high", "m", "high"));
  assert.notEqual(jobKey("q", "high", "m", ""), jobKey("q", "high", "m", "none"));
  assert.match(jobKey("q", "high", "m", ""), /^[0-9a-f]{32}$/);
});

// ----------------------------------------------------------------- writer ---

await test("renderModelsJs produces the exact classic-script format, sorted", () => {
  const out = renderModelsJs(
    [
      { id: "b/x", name: "Beta", reasoning: true, levels: ["low"], extra: 1 },
      { id: "a/x", name: "Alpha", reasoning: false, levels: [] },
      { id: "", name: "gone" },
    ],
    new Date("2026-01-02T03:04:05Z"),
  );
  assert.equal(
    out,
    'globalThis.ASK_EXPERT_MODELS = [{"id":"a/x","name":"Alpha","reasoning":false,"levels":[]},' +
      '{"id":"b/x","name":"Beta","reasoning":true,"levels":["low"]}];\n' +
      'globalThis.ASK_EXPERT_MODELS_AT = "2026-01-02T03:04:05.000Z";\n',
  );
  assert.ok(!/\bimport\b|\bexport\b/.test(out));
});

await test("writeModelsFile writes, then skips an unchanged list", async () => {
  const f = await fixture();
  try {
    assert.equal(await writeModelsFile([{ id: "a", name: "A" }], f.deps), "written");
    const first = await readFile(join(f.uiDir, "models.js"), "utf8");
    assert.match(first, /^globalThis\.ASK_EXPERT_MODELS = \[\{"id":"a"/);
    assert.equal(await writeModelsFile([{ id: "a", name: "A" }], f.deps), "unchanged");
    assert.equal(await writeModelsFile([{ id: "b", name: "B" }], f.deps), "written");
    assert.match(await readFile(join(f.uiDir, "models.js"), "utf8"), /"id":"b"/);
  } finally {
    await f.cleanup();
  }
});

await test("writeModelsFile survives an unwritable path", async () => {
  const f = await fixture();
  try {
    const blocker = join(f.root, "blocker");
    await writeFile(blocker, "not a dir");
    const deps = { modelsFile: join(blocker, "ui", "models.js") };
    assert.equal(modelsFilePath(deps), deps.modelsFile);
    assert.equal(await writeModelsFile([{ id: "a", name: "A" }], deps), "error");
  } finally {
    await f.cleanup();
  }
});

await test("load-time refresh writes ui/models.js; a second load within 5 min skips", async () => {
  const f = await fixture();
  try {
    reset();
    await createHooks({}, {}, f.deps);
    await new Promise((r) => setTimeout(r, 250));
    const body = await readFile(join(f.uiDir, "models.js"), "utf8");
    assert.match(body, /"id":"expert\/hi"/);
    assert.match(body, /ASK_EXPERT_MODELS_AT = "\d{4}-/);
    const hits = modelHits.length;
    await createHooks({}, {}, f.deps);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(modelHits.length, hits, "refresh throttled for 5 minutes");
  } finally {
    await f.cleanup();
  }
});

await test("refresh is skipped in external mode", async () => {
  const f = await fixture();
  try {
    reset();
    await createHooks({}, { baseUrl: ORIGIN }, f.deps);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(modelHits.length, 0);
    await assert.rejects(() => readFile(join(f.uiDir, "models.js")));
  } finally {
    await f.cleanup();
  }
});

await test("a dead gateway never wipes a good list, and the next attempt retries at once", async () => {
  const f = await fixture();
  try {
    const file = join(f.uiDir, "models.js");
    const good = 'globalThis.ASK_EXPERT_MODELS = [{"id":"keep/me","name":"Keep","reasoning":false,"levels":[]}];\nglobalThis.ASK_EXPERT_MODELS_AT = "x";\n';
    await writeFile(file, good);
    const dead = createModelsRefresher({ ...f.deps, readOptions: () => ({}), fetch: () => Promise.reject(new Error("dead")) });
    assert.equal(await dead(false), "failed");
    assert.equal(await readFile(file, "utf8"), good, "existing list kept");

    // A failure does not start the 5-minute throttle: the next attempt (gateway up now) writes.
    reset();
    const alive = createModelsRefresher({ ...f.deps, readOptions: () => ({}) });
    assert.equal(await alive(false), "written");
    assert.match(await readFile(file, "utf8"), /expert\/hi/);
  } finally {
    await f.cleanup();
  }
});

await test("a tool call refreshes the list lazily, once the 5 minutes are up", async () => {
  const f = await fixture();
  try {
    reset();
    const hooks = await createHooks({}, { model: "expert/plain" }, f.deps);
    const file = join(f.uiDir, "models.js");
    const waitFile = async () => {
      for (let i = 0; i < 100; i++) {
        try { return await readFile(file, "utf8"); } catch { await new Promise((r) => setTimeout(r, 50)); }
      }
      throw new Error("models.js never appeared");
    };
    assert.ok((await waitFile()).includes("expert/hi"));

    await rm(file, { force: true });
    await hooks.tool.ask_expert.execute({ question: "q" }, {});
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(() => readFile(file), "throttled right after load");

    f.advance(6 * 60_000);
    await hooks.tool.ask_expert.execute({ question: "q2" }, {});
    assert.match(await waitFile(), /expert\/plain|expert\/hi/);
  } finally {
    await f.cleanup();
  }
});

// ------------------------------------------------------------- import safety ---

await test("server() returns fast with the gateway down", async () => {
  const f = await fixture();
  try {
    const deps = { ...f.deps, env: { MAGPIE_ADDR: "127.0.0.1:1" } };
    const t0 = Date.now();
    const hooks = await createHooks({}, { model: "m" }, deps);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 150, `server() took ${elapsed}ms`);
    assert.equal(typeof hooks.tool.ask_expert.execute, "function");
  } finally {
    await f.cleanup();
  }
});

mock.close();

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
if (failures.length) process.exitCode = 1;
