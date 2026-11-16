#!/usr/bin/env node
// ask-expert MCP server (stdio): exposes one tool, `ask_expert`, which forwards a
// self-contained question to a configured LLM (any OpenAI-compatible
// /chat/completions endpoint) and returns its answer.
// The same package is also a Magpie plugin: see plugin.mjs.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  DEFAULT_SYSTEM_PROMPT,
  LEVELS,
  LEVEL_DESCRIPTION,
  QUESTION_DESCRIPTION,
  TOOL_DESCRIPTION,
  askExpert,
} from "./core.mjs";

export { askExpert };

// ---------------------------------------------------------------- config ---

const HELP = `ask-expert-mcp — MCP server exposing one tool: ask_expert

Options (cmdline wins over environment):
  --model <name>          ASK_EXPERT_MODEL          Model name (required)
  --base-url <url>        ASK_EXPERT_BASE_URL       OpenAI-compatible base URL
                                                    (default https://api.openai.com/v1)
  --api-key <key>         ASK_EXPERT_API_KEY        API key (falls back to OPENAI_API_KEY)
  --timeout <seconds>     ASK_EXPERT_TIMEOUT        Request timeout (default 600)
  --max-tokens <n>        ASK_EXPERT_MAX_TOKENS     Cap on answer tokens (default: provider's)
  --system-prompt <text>  ASK_EXPERT_SYSTEM_PROMPT  Override the expert's system prompt
  --effort <value>        ASK_EXPERT_EFFORT         Fixed reasoning_effort (e.g. low, high, max),
                                                    independent of the model and of "level"
                                                    (default: follow the level argument)
  --no-reasoning-effort   ASK_EXPERT_NO_REASONING_EFFORT=1
                                                    Never send "reasoning_effort"
  --model-low/-medium/-high <name>
                          ASK_EXPERT_MODEL_LOW/MEDIUM/HIGH
                                                    Per-level model override
`;

const FLAGS = {
  "--model": "model",
  "--base-url": "baseUrl",
  "--api-key": "apiKey",
  "--timeout": "timeout",
  "--max-tokens": "maxTokens",
  "--system-prompt": "systemPrompt",
  "--effort": "effort",
  "--model-low": "modelLow",
  "--model-medium": "modelMedium",
  "--model-high": "modelHigh",
};
const BOOL_FLAGS = { "--no-reasoning-effort": "noReasoningEffort" };

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (a in BOOL_FLAGS) {
      out[BOOL_FLAGS[a]] = true;
    } else if (a in FLAGS) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      out[FLAGS[a]] = v;
    } else {
      throw new Error(`Unknown argument: ${a}\n\n${HELP}`);
    }
  }
  return out;
}

const truthy = (v) => v !== undefined && !/^(|0|false|no|off)$/i.test(String(v));

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const a = parseArgs(argv);
  if (a.help) return { help: true };
  const num = (v, d, name) => {
    if (v === undefined || v === "") return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${v}"`);
    return n;
  };
  return {
    model: a.model ?? env.ASK_EXPERT_MODEL,
    models: {
      low: a.modelLow ?? env.ASK_EXPERT_MODEL_LOW,
      medium: a.modelMedium ?? env.ASK_EXPERT_MODEL_MEDIUM,
      high: a.modelHigh ?? env.ASK_EXPERT_MODEL_HIGH,
    },
    baseUrl: (a.baseUrl ?? env.ASK_EXPERT_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: a.apiKey ?? env.ASK_EXPERT_API_KEY ?? env.OPENAI_API_KEY,
    timeoutMs: num(a.timeout ?? env.ASK_EXPERT_TIMEOUT, 600, "timeout") * 1000,
    maxTokens: num(a.maxTokens ?? env.ASK_EXPERT_MAX_TOKENS, undefined, "max-tokens"),
    systemPrompt: a.systemPrompt ?? env.ASK_EXPERT_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    effort: a.effort ?? env.ASK_EXPERT_EFFORT ?? undefined,
    noReasoningEffort: a.noReasoningEffort ?? truthy(env.ASK_EXPERT_NO_REASONING_EFFORT),
  };
}

// ----------------------------------------------------------- MCP server ----

export function createServer(cfg) {
  const server = new McpServer({ name: "ask-expert", version: "1.0.0" });
  server.registerTool(
    "ask_expert",
    {
      title: "Ask Expert",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        question: z.string().min(1).describe(QUESTION_DESCRIPTION),
        level: z.enum(LEVELS).optional().describe(LEVEL_DESCRIPTION),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ question, level }) => {
      try {
        const answer = await askExpert(cfg, question, level);
        return { content: [{ type: "text", text: answer }] };
      } catch (e) {
        const msg = e?.name === "TimeoutError" ? `Expert request timed out after ${cfg.timeoutMs / 1000}s.` : (e?.message ?? String(e));
        return { isError: true, content: [{ type: "text", text: `ask_expert failed: ${msg}` }] };
      }
    },
  );
  return server;
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (cfg.help) {
    console.error(HELP);
    process.exit(0);
  }
  if (!cfg.model) console.error("ask-expert: warning: no model configured (ASK_EXPERT_MODEL / --model); calls will fail until set.");
  await createServer(cfg).connect(new StdioServerTransport());
  console.error(`ask-expert: ready (model=${cfg.model ?? "<unset>"}, base=${cfg.baseUrl})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
