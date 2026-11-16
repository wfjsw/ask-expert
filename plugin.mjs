// Magpie plugin entry: gives agents one tool, ask_expert.
//
// Only the default object is exported as a plugin; helpers live in magpie.mjs
// and expert-tool.mjs, so nothing third-party is needed at load time (the host
// may load this folder without node_modules).
//
// Server() must return fast and must never fail because Magpie is down: the
// model list for the settings panel is fetched detached and written to
// ui/models.js, which the panel (no network of its own) reads.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTool, normalizeOptions } from "./expert-tool.mjs";
import { createGateway } from "./magpie.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFRESH_MS = 5 * 60_000;

export function modelsFilePath(deps = {}) {
  if (deps.modelsFile) return deps.modelsFile;
  if (deps.modelsDir) return join(deps.modelsDir, "models.js");
  return join(HERE, "ui", "models.js");
}

// Exactly the format the panel parses: a classic script, one array, one stamp.
export function renderModelsJs(models, at = new Date()) {
  const list = (Array.isArray(models) ? models : [])
    .filter((m) => m && m.id)
    .map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      reasoning: Boolean(m.reasoning),
      levels: Array.isArray(m.levels) ? m.levels.map(String) : [],
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  return `globalThis.ASK_EXPERT_MODELS = ${JSON.stringify(list)};\n` +
    `globalThis.ASK_EXPERT_MODELS_AT = ${JSON.stringify(at.toISOString())};\n`;
}

// Writes only when the content changed. Returns "written" | "unchanged" | "error";
// every failure (read-only folder included) is swallowed.
export async function writeModelsFile(models, deps = {}) {
  const file = modelsFilePath(deps);
  const body = renderModelsJs(models, deps.now ? new Date(deps.now()) : new Date());
  try {
    let existing = null;
    try { existing = await readFile(file, "utf8"); } catch { /* first write */ }
    // Only the model list is content; the timestamp moves on every render.
    if (existing && existing.split("\n")[0] === body.split("\n")[0]) return "unchanged";
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
    return "written";
  } catch {
    return "error";
  }
}

// The throttle is module-wide because every load builds a fresh refresher.
const REFRESH_STATE = { last: 0 };

// Shared by the load-time kick and the lazy refresh; never throws.
export function createModelsRefresher(deps = {}) {
  const state = deps.refreshState ?? REFRESH_STATE;
  const clock = () => (deps.now ? deps.now() : Date.now());
  let running = null;
  const gateway = deps.gateway ?? createGateway(deps);

  return async function refresh(force = false) {
    const options = normalizeOptions(await deps.readOptions?.());
    if (options.baseUrl) return "external"; // panel gets no gateway list in external mode
    if (!force && clock() - state.last < REFRESH_MS) return "skipped";
    if (running) return running;
    state.last = clock();
    running = (async () => {
      // A dead gateway still gets an empty list written: better than a stale one.
      const models = await gateway.listModels({ force: true }).catch(() => []);
      return writeModelsFile(models, deps);
    })()
      .catch(() => "error")
      .finally(() => { running = null; });
    return running;
  };
}

function optionsOf(input, options) {
  if (options && typeof options === "object" && !Array.isArray(options)) return options;
  const fallback = input?.magpie?.options;
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) return fallback;
  return {};
}

// Exported for tests (the default export is what Magpie calls).
export async function createHooks(input, options, deps = {}) {
  const settings = optionsOf(input, options);
  const readOptions = () => settings;
  const refresh = createModelsRefresher({ ...deps, readOptions });

  refresh(false); // detached: server() returns without waiting for the gateway

  const tool = createTool(readOptions, {
    ...deps,
    onExecuted: () => { refresh(false); },
  });

  return { tool: { ask_expert: tool } };
}

export default {
  id: "ask-expert",
  server: (input, options) => createHooks(input, options),
};
