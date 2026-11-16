// Shared by the standalone MCP server (server.mjs) and the Magpie plugin
// (plugin.mjs): the tool text and the call to an OpenAI-compatible
// /chat/completions endpoint.

export const LEVELS = ["low", "medium", "high"];

export const DEFAULT_SYSTEM_PROMPT =
  "You are a senior expert consulted on difficult technical and analytical problems. " +
  "Each question is self-contained. Answer directly and rigorously: give the answer first, " +
  "then the key reasoning, and state any assumptions you had to make. If the question is " +
  "ambiguous or underspecified, answer for the most plausible reading anyway. You cannot hold a " +
  "conversation: the asker may ask again, but only with a new, self-contained question. " +
  "So always end your reply with a section titled \"Would a re-ask help?\" that says either " +
  "\"No - the answer above is as good as it gets from the information given\", or " +
  "\"Yes - a better answer is possible if the question also included:\" followed by a short list of " +
  "the specific missing facts (exact error text, versions, code, constraints, input/output examples, " +
  "what was already tried, ...), each with a one-line note on how it would change or sharpen the answer.";

export const TOOL_DESCRIPTION = `Consult a stronger external expert model. Use it when you hit a hard problem, a hard blocker, or anything that is limited by your own intelligence or knowledge (difficult reasoning, math, algorithms, obscure technical facts, a bug you cannot crack after real effort). Do not use it for trivial questions or things you can look up or verify yourself with your tools.

The expert sees ONLY the text you send, in a fresh conversation with no memory of earlier calls. So the question MUST:
1. Be fully self-contained: include all context, definitions, relevant code, error messages, data, constraints and what you already tried, inline. Never refer to "the workspace", "this repo", "the file", or earlier messages.
2. Be neutralized from its purpose: state only the technical/abstract problem. Do not explain or mention what project, product or goal you are working on, who the user is, or why you need the answer.
3. Be written in English only, regardless of the language of the conversation.
4. Ask one specific question (or a tight set of closely related ones) and say what form of answer you want.

The expert's reply can be wrong; check it against what you know and can test. The expert cannot reply interactively, but its answer ends with a "Would a re-ask help?" section. If it lists missing information that you can supply, call ask_expert again with a new self-contained question that includes that information (still neutralized and in English); if it says no, do not re-ask.`;

export const QUESTION_DESCRIPTION =
  "The complete, self-contained, purpose-neutral question in English, including all context needed to answer it (code, errors, data, constraints, what was tried).";

export const LEVEL_DESCRIPTION =
  "How hard the question is: 'low' (moderately tricky), 'medium' (hard), 'high' (very hard; allow the expert to think the longest). Controls the expert's reasoning effort / model. Omit for the server default.";

/**
 * Ask the expert one question.
 * cfg: { model, models:{low,medium,high}, baseUrl, apiKey, timeoutMs, maxTokens,
 *        systemPrompt, noReasoningEffort, signal?, missingModelMessage?,
 *        effortFor?(model, level) -> string|null|undefined }
 */
export async function askExpert(cfg, question, level, fetchImpl = fetch) {
  const model = (level && cfg.models?.[level]) || cfg.model;
  if (!model) {
    throw new Error(
      cfg.missingModelMessage ?? "No model configured. Set ASK_EXPERT_MODEL or pass --model <name> to the server.",
    );
  }
  const url = `${cfg.baseUrl}/chat/completions`;
  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const base = {
    model,
    messages: [
      { role: "system", content: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: question },
    ],
  };
  if (cfg.maxTokens) base.max_tokens = cfg.maxTokens;

  const post = async (body) => {
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: cfg.signal ? AbortSignal.any([timeout, cfg.signal]) : timeout,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { res, text, json };
  };

  // Reasoning effort is independent of the model: a fixed cfg.effort wins over the
  // asker's level; effortFor(model, level) lets a host map/override both.
  let effort;
  if (!cfg.noReasoningEffort) {
    effort = cfg.effortFor ? await cfg.effortFor(model, level) : cfg.effort || level;
  }
  let r = await post(effort ? { ...base, reasoning_effort: effort } : base);
  // Models that do not support reasoning_effort reject it; retry once without.
  if (effort && r.res.status === 400 && /reasoning|effort/i.test(r.text)) {
    r = await post(base);
  }

  if (!r.res.ok) {
    const msg = r.json?.error?.message ?? r.text.slice(0, 500);
    throw new Error(`Expert API returned HTTP ${r.res.status} (model ${model}): ${msg}`);
  }
  const choice = r.json?.choices?.[0];
  let answer = choice?.message?.content;
  if (Array.isArray(answer)) answer = answer.map((p) => p?.text ?? "").join("");
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error(
      `Expert returned no text (model ${model}, finish_reason=${choice?.finish_reason ?? "unknown"}). ` +
        `If the model uses hidden reasoning, a token cap (max tokens) may be exhausting it.`,
    );
  }
  if (choice.finish_reason === "length") {
    answer += "\n\n[Note: the expert's answer was cut off at the token limit.]";
  }
  return answer;
}
