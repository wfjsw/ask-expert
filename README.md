# ask-expert

One package, two ways to give an agent an `ask_expert(question, level?)` tool that consults a
stronger LLM on hard problems:

1. **Magpie plugin** (`plugin.mjs`): uses the models inside Magpie through Magpie's local gateway;
   settings are edited in Magpie's UI (Settings > Plugins > Ask Expert).
2. **Standalone stdio MCP server** (`server.mjs`): any MCP client; any OpenAI-compatible endpoint.

The tool description tells the calling agent to use it only for hard problems or blockers, and to
write a question that is self-contained (no workspace references), neutralized (no mention of the
project or purpose) and in English. The expert's system prompt makes it end every reply with a
"Would a re-ask help?" section: either "no, this is as good as it gets", or a list of the missing
facts that would give a better answer if the question were asked again with them included. The tool
description tells the agent to re-ask with those facts when it can supply them.

## Magpie plugin

### Install

```
magpie plugin add D:/ask-expert        # a folder is loaded where it is; nothing is copied
```

After editing the plugin's source, turn it off and on in Magpie. Magpie serves the tool to every
agent through its own MCP server at `/mcp/magpie/tools`, as `ask-expert_ask_expert`. The plugin
host code uses only Node built-ins, so the folder needs no `node_modules` to load.

### Configure (Settings > Plugins > Ask Expert)

Settings save automatically. The model and effort pickers are dropdowns.

| Setting | Meaning |
|---|---|
| Expert model | Dropdown of the models Magpie's gateway offers, plus **Custom...** to type any model id. A saved id that is not in the list is kept and shown as Custom. |
| Reasoning effort | Set **separately from the model** (see below). |
| Model / effort per level | Optional overrides for `low` / `medium` / `high`. Empty = use the main model / main effort. |
| Timeout, max answer tokens, system prompt | Under Advanced. |
| Base URL + API key | Under Advanced. If a Base URL is set, the expert is that external OpenAI-compatible endpoint (base URL ending in `/v1`) instead of Magpie's models. The key is stored in Magpie's plugin options in plain text. |

**Reasoning effort** values:

- **Auto** (empty): follow the `level` the calling agent passes (`low` / `medium` / `high`), mapped
  onto the selected model's own reasoning levels (for example `high` becomes `max` if the model has
  no `high`). A model without reasoning levels, or no `level` given, sends nothing. With an external
  Base URL the level is passed through unchanged.
- **Off** (`none`): never send `reasoning_effort`.
- **A fixed level** (`low`, `medium`, `high`, `xhigh`, `max`, or whatever the model lists): sent as
  is, whatever level the agent passes and even when it passes none.

For difficulty level L the effective model is `model<L> || model` and the effective effort is
`effort<L> || effort`. If a provider rejects `reasoning_effort` with HTTP 400, the call is retried
once without it. The old `sendReasoningEffort: false` option is read as Off.

The settings panel cannot use the network, so the plugin writes the model list to `ui/models.js`
when it loads (and refreshes it at most every 5 minutes when the tool runs). The list is empty until
the plugin has run once with Magpie running; any model id can still be typed with Custom.... The
committed `ui/models.js` is an empty stub that the plugin overwrites at runtime.

### Behaviour notes

- Magpie gives a plugin tool 55 seconds. A slow expert is not cancelled: the call returns "still
  thinking" and the agent calls again with the identical question and level to collect the answer
  (the same request is joined, not restarted). Finished answers are kept for 10 minutes.
- Failures come back as tool text starting `ask_expert failed:` and are delivered once; asking again
  retries.
- Gateway discovery order: `MAGPIE_ADDR`, then `gateway.json` and `settings.json` in Magpie's config
  folder, then `http://127.0.0.1:3425`. A gateway key from `MAGPIE_API_KEY` / `MAGPIE_GATEWAY_KEY` or
  `caller-keys.json` is sent as a Bearer token when present.

## Standalone MCP server

```
npm install
npm test
claude mcp add ask-expert -s user -e ASK_EXPERT_MODEL=<model> -e ASK_EXPERT_API_KEY=<key> -- node D:/ask-expert/server.mjs
```

Configuration (command line wins over environment):

| Option | Env var | Meaning |
|---|---|---|
| `--model <name>` | `ASK_EXPERT_MODEL` | Expert model name (**required**) |
| `--base-url <url>` | `ASK_EXPERT_BASE_URL` | Default `https://api.openai.com/v1` |
| `--api-key <key>` | `ASK_EXPERT_API_KEY` | Falls back to `OPENAI_API_KEY` |
| `--timeout <s>` | `ASK_EXPERT_TIMEOUT` | Default 600 |
| `--max-tokens <n>` | `ASK_EXPERT_MAX_TOKENS` | Optional answer cap |
| `--system-prompt <text>` | `ASK_EXPERT_SYSTEM_PROMPT` | Override expert system prompt |
| `--model-low/-medium/-high <name>` | `ASK_EXPERT_MODEL_LOW/MEDIUM/HIGH` | Per-level model override |
| `--effort <value>` | `ASK_EXPERT_EFFORT` | Fixed `reasoning_effort`, independent of the model and of `level` |
| `--no-reasoning-effort` | `ASK_EXPERT_NO_REASONING_EFFORT=1` | Never send `reasoning_effort` |

Without `--effort`, the `level` argument is sent as `reasoning_effort`.

## Layout

`core.mjs` (shared prompt text + expert call) · `server.mjs` (stdio MCP) · `plugin.mjs`,
`expert-tool.mjs`, `magpie.mjs` (Magpie plugin) · `ui/` (settings panel) · `test/`
(`npm test` runs all three suites; no network or API key needed).
