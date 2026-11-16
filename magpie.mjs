// Finding and talking to Magpie's local OpenAI-compatible gateway.
//
// The expert backend is "whatever models Magpie already has", so in gateway
// mode this file only has to locate the gateway (its port moves around: env
// MAGPIE_ADDR, gateway.json, settings.json) and read the model list. Everything
// here takes injectable deps so tests never touch the real ~/.config/magpie.
//
// deps: { fetch?, env?, home?, configDir? }

import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_GATEWAY = "http://127.0.0.1:3425";
export const CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 2500;

// ---------------------------------------------------------------- helpers ---

function env(deps) {
  return deps.env ?? process.env;
}

// Plain http(s) origin, no trailing slashes, or "" when it is not a URL.
export function normalizeOrigin(raw) {
  const s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(s)) return "";
  return s;
}

// Base URL usable for core: an origin plus /v1 (core appends /chat/completions).
export function v1Base(origin) {
  const o = normalizeOrigin(origin);
  if (!o) return "";
  return /\/v1$/.test(o) ? o : `${o}/v1`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function portOf(obj) {
  for (const key of ["port", "gatewayPort", "listen"]) {
    const n = Number(obj?.[key]);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return 0;
}

export function configDir(deps = {}) {
  if (deps.configDir) return String(deps.configDir);
  const e = env(deps);
  if (e.MAGPIE_CONFIG_DIR) return String(e.MAGPIE_CONFIG_DIR);
  if (e.XDG_CONFIG_HOME) return join(String(e.XDG_CONFIG_HOME), "magpie");
  return join(deps.home ?? osHomedir(), ".config", "magpie");
}

// Candidate origins in priority order: explicit env addr, the addr Magpie wrote
// for itself, the port in its settings, then the historical default.
export function gatewayCandidates(deps = {}) {
  const out = [];
  const push = (u) => {
    const s = normalizeOrigin(u);
    if (s && !out.includes(s)) out.push(s);
  };

  const addr = String(env(deps).MAGPIE_ADDR ?? "").trim();
  if (addr) {
    if (/^[\w.\-]+:\d+$/.test(addr)) push(`http://${addr}`);
    else if (/^https?:\/\//.test(addr)) push(addr);
    else if (/^[\w.\-]+:\d+/.test(addr)) push(`http://${addr.replace(/^[^:]*:\/\//, "")}`);
  }

  const dir = configDir(deps);
  const gwJson = readJson(join(dir, "gateway.json"));
  const gwAddr = String(gwJson?.addr ?? gwJson?.address ?? "").trim();
  if (gwAddr) {
    const withScheme = /^https?:\/\//.test(gwAddr) ? gwAddr : `http://${gwAddr}`;
    push(withScheme);
  }
  const port = portOf(readJson(join(dir, "settings.json")));
  if (port) push(`http://127.0.0.1:${port}`);

  push(DEFAULT_GATEWAY);
  return out;
}

// A gateway key, if Magpie wants one (the desktop gateway does not, a key is
// harmless): env first, then the first secret Magpie handed out to callers.
export function callerKey(deps = {}) {
  const e = env(deps);
  const fromEnv = String(e.MAGPIE_API_KEY ?? e.MAGPIE_GATEWAY_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const list = readJson(join(configDir(deps), "caller-keys.json"));
  if (!Array.isArray(list)) return "";
  const hit = list.find((k) => k?.secret && k?.name) ?? list.find((k) => k?.secret);
  return hit?.secret ? String(hit.secret) : "";
}

// --------------------------------------------------------- model handling ---

const LEVEL_RANK = {
  minimal: 0,
  min: 0,
  none: 0,
  low: 1,
  medium: 2,
  med: 2,
  high: 3,
  xhigh: 4,
  x_high: 4,
  ultra: 5,
  max: 5,
  maximum: 5,
};

function rank(level) {
  const k = String(level ?? "").trim().toLowerCase();
  return Object.hasOwn(LEVEL_RANK, k) ? LEVEL_RANK[k] : 2.5;
}

export function normalizeModel(m) {
  const id = String(m?.id ?? "").trim();
  const explicit = Array.isArray(m?.reasoning_levels) ? m.reasoning_levels : null;
  const derived = Array.isArray(m?.supported_reasoning_levels)
    ? m.supported_reasoning_levels.map((x) => x?.effort).filter(Boolean)
    : [];
  const levels = (explicit?.length ? explicit : derived)
    .map((x) => String(x).trim())
    .filter(Boolean);
  return {
    id,
    name: String(m?.display_name || m?.magpie_label || m?.name || id).trim(),
    reasoning: Boolean(m?.reasoning) && levels.length > 0,
    levels,
  };
}

// Ask level -> the model's own effort name, or null to send no param at all.
// "medium" with no exact match takes the nearest available level and prefers
// the higher neighbour; "high" with no exact match takes the strongest level.
export function mapEffort(modelInfo, level) {
  const want = String(level ?? "").trim().toLowerCase();
  if (!want || !modelInfo?.reasoning) return null;
  const levels = (modelInfo.levels ?? []).filter(Boolean);
  if (!levels.length) return null;

  const exact = levels.find((l) => String(l).toLowerCase() === want);
  if (exact) return exact;

  const wantRank = rank(want);
  const above = levels
    .map((l, i) => ({ l, i, r: rank(l) }))
    .filter((x) => x.r > wantRank)
    .sort((a, b) => a.r - b.r || b.i - a.i);
  const below = levels
    .map((l, i) => ({ l, i, r: rank(l) }))
    .filter((x) => x.r < wantRank)
    .sort((a, b) => b.r - a.r || a.i - b.i);

  if (want === "high") {
    const strongest = levels
      .map((l, i) => ({ l, i, r: rank(l) }))
      .sort((a, b) => b.r - a.r || b.i - a.i)[0];
    return strongest?.l ?? null;
  }
  if (want === "low") {
    const weakest = levels
      .map((l, i) => ({ l, i, r: rank(l) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)[0];
    return weakest?.l ?? null;
  }
  return above[0]?.l ?? below[0]?.l ?? null;
}

// -------------------------------------------------------------- instance ----

export function createGateway(injected = {}) {
  const deps = {
    fetch: injected.fetch ?? globalThis.fetch,
    env: injected.env ?? process.env,
    home: injected.home,
    configDir: injected.configDir,
  };

  let picked = { at: 0, origin: "", auth: "", source: "" };
  let models = { at: 0, list: null };

  function auth() {
    return callerKey(deps);
  }

  async function probe(origin) {
    try {
      const res = await deps.fetch(`${origin}/v1/models`, {
        headers: auth() ? { authorization: `Bearer ${auth()}` } : {},
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // First candidate that answers /v1/models; the first candidate when none do,
  // so the real error surfaces from the chat call instead of a made-up one.
  async function resolveGateway(opts = {}) {
    const external = normalizeOrigin(opts.baseUrl);
    if (external) {
      return {
        source: "external",
        origin: external,
        base: v1Base(external),
        auth: String(opts.apiKey ?? "").trim(),
      };
    }
    if (picked.origin && Date.now() - picked.at < CACHE_MS) return { ...picked };

    const list = gatewayCandidates(deps);
    for (const origin of list) {
      if (await probe(origin)) {
        picked = { at: Date.now(), origin, base: v1Base(origin), auth: auth(), source: "gateway" };
        return { ...picked };
      }
    }
    const origin = list[0] ?? DEFAULT_GATEWAY;
    picked = { at: Date.now(), origin, base: v1Base(origin), auth: auth(), source: "gateway" };
    return { ...picked };
  }

  async function listModels(opts = {}) {
    const key = normalizeOrigin(opts.baseUrl);
    if (key && models.key !== key) models = { at: 0, list: null, key };
    if (!key && models.key) models = { at: 0, list: null };
    if (!opts.force && models.list && Date.now() - models.at < CACHE_MS) return models.list;

    const target = await resolveGateway(opts);
    const headers = target.auth ? { authorization: `Bearer ${target.auth}` } : {};
    const res = await deps.fetch(`${target.base}/models`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`gateway ${res.status} on /v1/models`);
    const body = await res.json();
    const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const list = raw.map(normalizeModel).filter((m) => m.id);
    models = { at: Date.now(), list, key: key || undefined };
    return list;
  }

  function cacheInfo() {
    return {
      picked: picked.origin ? { ...picked, ageMs: Date.now() - picked.at } : null,
      modelsAgeMs: models.list ? Date.now() - models.at : null,
    };
  }

  return { deps, resolveGateway, listModels, callerKey: () => callerKey(deps), cacheInfo };
}
