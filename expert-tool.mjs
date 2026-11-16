// The ask_expert tool: option coercion, the cfg handed to core.askExpert, and
// the 55-second problem.
//
// Magpie kills a tool call at 55s, but a high-effort expert legitimately takes
// minutes. So execute() starts the request detached, waits ~48s, and on timeout
// returns a "still thinking" text carrying the same key. A re-call with the
// identical question and level joins the running request instead of starting a
// second one; finished answers and failures stay reachable for 10 minutes.
// ctx.abort only stops our waiting, never the request.

import { createHash } from "node:crypto";
import {
  DEFAULT_SYSTEM_PROMPT,
  LEVELS,
  LEVEL_DESCRIPTION,
  QUESTION_DESCRIPTION,
  TOOL_DESCRIPTION,
  askExpert,
} from "./core.mjs";
import { createGateway, mapEffort, normalizeOrigin, v1Base } from "./magpie.mjs";

export const DEFAULT_TIMEOUT_S = 600;
export const DEFAULT_WAIT_MS = 48_000;
export const KEEP_RESULT_MS = 10 * 60_000;
export const ASK_TOOL_NAME = "ask_expert";

export const MISSING_MODEL_MESSAGE =
  "No expert model selected. Open Magpie > Settings > Plugins > Ask Expert and choose a model.";

export const TOOL_ARGS = {
  type: "object",
  properties: {
    question: { type: "string", description: QUESTION_DESCRIPTION },
    level: { type: "string", enum: LEVELS, description: LEVEL_DESCRIPTION },
  },
  required: ["question"],
  additionalProperties: false,
};

// -------------------------------------------------------------- options ----

function str(v) {
  return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
}

function positiveNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : 0;
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s) return false;
    return !["false", "0", "no", "off", "n", "disabled"].includes(s);
  }
  return false;
}

// Tolerant coercion of the settings-panel values; numbers arrive as number,
// numeric string or "" and nothing may throw.
//
// Effort is independent of the model: "" = Auto (follow the asker's level),
// "none" = never send the param, anything else = send exactly that string.
export function normalizeOptions(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const timeout = positiveNumber(o.timeout);
  const maxTokens = positiveNumber(o.maxTokens);
  let effort = str(o.effort);
  // Legacy switch from before effort existed: an off switch means "none".
  const legacyOff = o.sendReasoningEffort !== undefined
    && o.sendReasoningEffort !== null
    && !truthy(o.sendReasoningEffort);
  if (legacyOff && !effort) effort = "none";
  return {
    model: str(o.model),
    modelLow: str(o.modelLow),
    modelMedium: str(o.modelMedium),
    modelHigh: str(o.modelHigh),
    effort,
    effortLow: str(o.effortLow),
    effortMedium: str(o.effortMedium),
    effortHigh: str(o.effortHigh),
    baseUrl: normalizeOrigin(o.baseUrl),
    apiKey: str(o.apiKey),
    timeout: timeout || DEFAULT_TIMEOUT_S,
    maxTokens: maxTokens ? Math.floor(maxTokens) : undefined,
    systemPrompt: str(o.systemPrompt),
  };
}

function modelFor(options, level) {
  const perLevel =
    level === "low" ? options.modelLow : level === "medium" ? options.modelMedium : level === "high" ? options.modelHigh : "";
  return perLevel || options.model;
}

// "" | "none" | a literal effort string (per-level setting wins over the general one).
export function effortFor(options, level) {
  const perLevel =
    level === "low" ? options.effortLow : level === "medium" ? options.effortMedium : level === "high" ? options.effortHigh : "";
  return perLevel || options.effort;
}

// ----------------------------------------------------------- config build ---

// deps: { fetch?, env?, home?, configDir?, gateway? } — the gateway instance is
// injectable so tests never probe the real Magpie.
export async function buildConfig(rawOptions, deps = {}) {
  const o = normalizeOptions(rawOptions);
  const gateway = deps.gateway ?? createGateway(deps);

  let baseUrl;
  let apiKey;
  let modelsById = null;

  if (o.baseUrl) {
    // Explicit external OpenAI-compatible endpoint: no discovery, no caller key.
    baseUrl = v1Base(o.baseUrl);
    apiKey = o.apiKey;
  } else {
    const target = await gateway.resolveGateway();
    baseUrl = target.base;
    apiKey = o.apiKey || target.auth;
    try {
      modelsById = new Map((await gateway.listModels()).map((m) => [m.id, m]));
    } catch {
      modelsById = null;
    }
  }

  const external = Boolean(o.baseUrl);
  return {
    model: o.model,
    models: { low: o.modelLow, medium: o.modelMedium, high: o.modelHigh },
    baseUrl,
    apiKey: apiKey || undefined,
    timeoutMs: o.timeout * 1000,
    maxTokens: o.maxTokens,
    systemPrompt: o.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    noReasoningEffort: false,
    effortFor: (model, level) => {
      const fixed = effortFor(o, level);
      if (fixed === "none") return null;
      // A literal effort is sent as-is, level or no level, in or out of the
      // model's own list (the provider knows best; core retries on 400).
      if (fixed) return fixed;
      // Auto: follow the asker's level.
      if (external) return level ?? null;
      const info = modelsById?.get(model);
      return info ? mapEffort(info, level) : null;
    },
    missingModelMessage: MISSING_MODEL_MESSAGE,
  };
}

// ------------------------------------------------------------ still alive ---

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve(null);
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve(STOPPED);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

const STOPPED = Symbol("stopped");

function failureText(error, cfg) {
  const msg = error?.name === "TimeoutError"
    ? `Expert request timed out after ${cfg.timeoutMs / 1000}s.`
    : (error?.message ?? String(error));
  return `ask_expert failed: ${msg}`;
}

export function jobKey(question, level, model, effort) {
  return createHash("sha256")
    .update(JSON.stringify([question, level ?? "", model ?? "", effort ?? ""]))
    .digest("hex")
    .slice(0, 32);
}

// ------------------------------------------------------------------ tool ----

// getOptions: () => raw options (sync or async). deps: waitMs, gateway, fetch,
// onExecuted (lazy model-list refresh), now.
export function createTool(getOptions, deps = {}) {
  const jobs = new Map();

  const waitMs = () => (positiveNumber(deps.waitMs) || DEFAULT_WAIT_MS);
  const now = () => (deps.now ? deps.now() : Date.now());

  function purge() {
    const t = now();
    for (const [key, job] of jobs) {
      if (job.settledAt && t - job.settledAt > KEEP_RESULT_MS) jobs.delete(key);
    }
  }

  function start(key, cfg, question, level) {
    const job = { startedAt: now(), settledAt: 0, outcome: null };
    jobs.set(key, job);
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    // Detached on purpose: cfg.signal stays unset so ctx.abort cannot kill it.
    job.promise = Promise.resolve()
      .then(() => askExpert(cfg, question, level, fetchImpl))
      .then(
        (text) => ({ ok: true, text }),
        (error) => ({ ok: false, text: failureText(error, cfg) }),
      )
      .then((outcome) => {
        job.outcome = outcome;
        job.settledAt = now();
        const timer = setTimeout(() => {
          if (jobs.get(key) === job) jobs.delete(key);
        }, KEEP_RESULT_MS);
        timer.unref?.();
        return outcome;
      });
    return job;
  }

  async function execute(args, ctx) {
    purge();
    if (typeof deps.onExecuted === "function") {
      try { deps.onExecuted(); } catch { /* lazy refresh never blocks */ }
    }

    const question = str(args?.question);
    if (!question) return "ask_expert failed: question is required.";
    const level = LEVELS.includes(args?.level) ? args.level : undefined;

    let options;
    let cfg;
    try {
      options = normalizeOptions(await getOptions?.());
      cfg = await buildConfig(options, deps);
    } catch (error) {
      return failureText(error, { timeoutMs: options ? options.timeout * 1000 : 0 });
    }

    const key = jobKey(question, level, modelFor(options, level), effortFor(options, level));

    let job = jobs.get(key);
    // A finished answer stays reachable for KEEP_RESULT_MS; a failure is
    // delivered once and then forgotten, so a re-ask retries instead of
    // replaying a stale (possibly transient) error.
    const deliver = (outcome) => {
      if (!outcome.ok && jobs.get(key) === job) jobs.delete(key);
      return outcome.text;
    };
    if (job?.settledAt) return deliver(job.outcome);
    if (!job) job = start(key, cfg, question, level);

    const outcome = await Promise.race([job.promise, sleep(waitMs(), ctx?.abort)]);
    if (outcome && outcome !== STOPPED) return deliver(outcome);

    const seconds = Math.max(1, Math.round((now() - job.startedAt) / 1000));
    return `The expert is still thinking (started ${seconds}s ago). Call ask_expert again with the IDENTICAL question and level to collect the answer.`;
  }

  return { description: TOOL_DESCRIPTION, args: TOOL_ARGS, execute };
}
