// End-to-end test: spawn server.mjs over stdio, talk to it with the MCP client,
// with a local mock OpenAI-compatible server standing in for the expert.
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../server.mjs";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const requests = [];
let mode = "ok";

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body);
    requests.push({ url: req.url, auth: req.headers.authorization, body: json });
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (mode === "500") return send(500, { error: { message: "boom" } });
    if (mode === "noeffort" && "reasoning_effort" in json) return send(400, { error: { message: "Unsupported parameter: reasoning_effort" } });
    if (mode === "empty") return send(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] });
    if (mode === "slow") return; // never reply
    send(200, { choices: [{ message: { content: `ANSWER[${json.model}]: ${json.messages.at(-1).content}` }, finish_reason: "stop" }] });
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}/v1`;

async function withClient(extraEnv, args, fn) {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, ...args],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? "", ...extraEnv },
    stderr: "ignore",
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(t);
  try { await fn(c); } finally { await c.close(); }
}
const ask = (c, args) => c.callTool({ name: "ask_expert", arguments: args });
const text = (r) => r.content[0].text;

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

await test("tools/list exposes only ask_expert with question + optional level", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base, ASK_EXPERT_API_KEY: "k" }, [], async (c) => {
    const { tools } = await c.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "ask_expert");
    const s = tools[0].inputSchema;
    assert.deepEqual(s.required, ["question"]);
    assert.deepEqual(Object.keys(s.properties).sort(), ["level", "question"]);
    assert.deepEqual(s.properties.level.enum, ["low", "medium", "high"]);
    assert.match(tools[0].description, /self-contained/);
    assert.match(tools[0].description, /English/);
  }));

await test("env config: call returns expert answer, sends auth/model/system prompt", () =>
  withClient({ ASK_EXPERT_MODEL: "env-model", ASK_EXPERT_BASE_URL: base, ASK_EXPERT_API_KEY: "secret" }, [], async (c) => {
    requests.length = 0;
    const r = await ask(c, { question: "What is 2+2?" });
    assert.ok(!r.isError);
    assert.equal(text(r), "ANSWER[env-model]: What is 2+2?");
    const q = requests[0];
    assert.equal(q.url, "/v1/chat/completions");
    assert.equal(q.auth, "Bearer secret");
    assert.equal(q.body.messages[0].role, "system");
    assert.ok(!("reasoning_effort" in q.body), "no effort without level");
  }));

await test("cmdline args override env; level -> reasoning_effort", () =>
  withClient({ ASK_EXPERT_MODEL: "env-model", ASK_EXPERT_BASE_URL: "http://127.0.0.1:1/v1" },
    ["--model", "cli-model", `--base-url=${base}`, "--max-tokens", "123"], async (c) => {
    requests.length = 0;
    const r = await ask(c, { question: "q", level: "high" });
    assert.equal(text(r), "ANSWER[cli-model]: q");
    assert.equal(requests[0].body.reasoning_effort, "high");
    assert.equal(requests[0].body.max_tokens, 123);
  }));

await test("per-level model override", () =>
  withClient({ ASK_EXPERT_MODEL: "base", ASK_EXPERT_MODEL_HIGH: "big", ASK_EXPERT_BASE_URL: base }, [], async (c) => {
    assert.match(text(await ask(c, { question: "q", level: "high" })), /^ANSWER\[big\]/);
    assert.match(text(await ask(c, { question: "q", level: "low" })), /^ANSWER\[base\]/);
  }));

await test("--no-reasoning-effort suppresses the param", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base }, ["--no-reasoning-effort"], async (c) => {
    requests.length = 0;
    await ask(c, { question: "q", level: "medium" });
    assert.ok(!("reasoning_effort" in requests[0].body));
  }));

await test("--effort is a fixed reasoning_effort independent of level (also with no level)", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base }, ["--effort", "max"], async (c) => {
    requests.length = 0;
    await ask(c, { question: "q" });
    await ask(c, { question: "q", level: "low" });
    assert.equal(requests[0].body.reasoning_effort, "max");
    assert.equal(requests[1].body.reasoning_effort, "max");
  }));

await test("retries without reasoning_effort when provider rejects it", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base }, [], async (c) => {
    mode = "noeffort"; requests.length = 0;
    const r = await ask(c, { question: "q", level: "medium" });
    assert.ok(!r.isError);
    assert.equal(requests.length, 2);
    assert.ok(!("reasoning_effort" in requests[1].body));
    mode = "ok";
  }));

await test("HTTP error -> isError result with status and message", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base }, [], async (c) => {
    mode = "500";
    const r = await ask(c, { question: "q" });
    assert.equal(r.isError, true);
    assert.match(text(r), /HTTP 500.*boom/);
    mode = "ok";
  }));

await test("empty answer -> isError", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base }, [], async (c) => {
    mode = "empty";
    const r = await ask(c, { question: "q" });
    assert.equal(r.isError, true);
    assert.match(text(r), /no text/);
    mode = "ok";
  }));

await test("timeout -> isError", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base, ASK_EXPERT_TIMEOUT: "1" }, [], async (c) => {
    mode = "slow";
    const r = await ask(c, { question: "q" });
    assert.equal(r.isError, true);
    assert.match(text(r), /timed out/);
    mode = "ok";
  }));

await test("missing model -> isError telling how to configure", () =>
  withClient({ ASK_EXPERT_BASE_URL: base }, [], async (c) => {
    const r = await ask(c, { question: "q" });
    assert.equal(r.isError, true);
    assert.match(text(r), /ASK_EXPERT_MODEL/);
  }));

await test("invalid input (empty question / bad level) is rejected", () =>
  withClient({ ASK_EXPERT_MODEL: "m", ASK_EXPERT_BASE_URL: base }, [], async (c) => {
    for (const args of [{ question: "" }, { question: "q", level: "extreme" }, {}]) {
      let rejected = false;
      try { const r = await ask(c, args); rejected = r.isError === true; } catch { rejected = true; }
      assert.ok(rejected, JSON.stringify(args));
    }
  }));

await test("loadConfig: unknown arg throws, bad number throws, default base url", () => {
  assert.throws(() => loadConfig(["--bogus"], {}), /Unknown argument/);
  assert.throws(() => loadConfig([], { ASK_EXPERT_TIMEOUT: "abc" }), /timeout/);
  assert.equal(loadConfig([], {}).baseUrl, "https://api.openai.com/v1");
  assert.equal(loadConfig([], { OPENAI_API_KEY: "x" }).apiKey, "x");
});

mock.close();
console.log(`\n${passed} tests passed`);
process.exit(0);
