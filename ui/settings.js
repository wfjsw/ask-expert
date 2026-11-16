/* Ask Expert — settings panel.
   Plain classic script, no build step. Lives in a sandboxed iframe with no
   network, so everything here is DOM, the magpie bridge and the model list
   the host drops in as models.js. */
(function () {
  "use strict";

  var DEBOUNCE_MS = 600; // trailing debounce after the last change
  var MIN_INTERVAL_MS = 1000; // options.set may be called once a second at most
  var TIMEOUT_RESET = 600;
  var CUSTOM = "\u0000custom";
  var GENERIC_LEVELS = ["low", "medium", "high", "xhigh", "max"];
  var MODEL_KEYS = { model: "", modelLow: "Low", modelMedium: "Medium", modelHigh: "High" };
  var EFFORT_KEYS = { effort: true, effortLow: false, effortMedium: false, effortHigh: false };
  var PLAIN_KEYS = ["baseUrl", "apiKey", "systemPrompt"];

  // The host serves the bridge beside every page. Tests and stray loads may
  // not have it, so fall back to a quiet stub that behaves like "no options".
  var bridge = window.magpie;
  if (!bridge || !bridge.options) {
    bridge = window.magpie = {
      ready: Promise.resolve({ dark: false, lang: "en", tokens: {} }),
      onTheme: function () {},
      options: {
        get: function () { return {}; },
        set: function (o) { return o; }
      },
      context: {}
    };
  }

  var I18N = {
    en: {
      title: "Ask Expert",
      intro: " lets an agent consult a stronger model when a problem is hard. Pick which model answers, how hard each difficulty may be pushed, and where that model lives.",
      modeMagpie: "Using Magpie's models",
      modeExternal: "Using external endpoint {host}",
      listPending: "The model list fills in after the plugin has run once with Magpie running. Any model id can be typed through Custom….",
      listReady: "{n} models from Magpie, updated {age}. Models that take a reasoning level are marked.",
      ageNow: "just now",
      ageMin: "{n} min ago",
      ageHour: "{n} h ago",
      ageDay: "{n} d ago",
      modelLabel: "Expert model",
      modelHint: "The model the expert tool asks. Pick from Magpie's list, or Custom… to type any model id (needed for an external endpoint).",
      notSet: "(not set)",
      custom: "Custom…",
      customValue: "Custom model id",
      effortLabel: "Reasoning effort",
      effortHint: "Auto sends the difficulty the agent asked for. A fixed level sends that one instead. Off never sends reasoning effort.",
      effortShort: "effort",
      autoEffort: "Auto — follow the difficulty the agent asks for",
      useMainEffort: "(use main effort)",
      offEffort: "Off — never send reasoning effort",
      offShort: "Off",
      savedEffort: "(saved)",
      levelLow: "Low",
      levelLowSub: "moderately tricky",
      levelMedium: "Medium",
      levelMediumSub: "hard",
      levelHigh: "High",
      levelHighSub: "very hard",
      levelsLabel: "Model per difficulty level",
      levelsHint: "Optional. Left empty, a level uses the main model and effort; the effort list follows whichever model that level ends up using.",
      useMainModel: "(use main model)",
      advanced: "Advanced",
      timeoutLabel: "Timeout",
      timeoutHint: "seconds, at least 1",
      timeoutErr: "Enter a positive number of seconds.",
      maxTokensLabel: "Max answer tokens",
      maxTokensHint: "blank = the provider's default",
      maxTokensErr: "Enter a positive integer, or leave it blank.",
      systemLabel: "System prompt",
      reset: "Reset",
      systemHint: "blank = the built-in default",
      systemPlaceholder: "built-in default",
      external: "External endpoint",
      externalHint: "Leave the base URL blank to use Magpie's own gateway. With a URL the expert calls that OpenAI-compatible endpoint instead.",
      baseUrlLabel: "Base URL",
      baseUrlHint: "blank = use Magpie; ends in /v1",
      baseUrlErr: "Must start with http:// or https://, or be blank.",
      apiKeyLabel: "API key",
      apiKeyHint: "ignored in Magpie mode",
      apiKeyNote: "Stored in Magpie's plugin options in plain text.",
      saved: "Saved ✓",
      saving: "Saving…",
      cantSave: "Couldn't save",
      fixFirst: "Fix the highlighted field",
      levelLowE: "low",
      levelMediumE: "medium",
      levelHighE: "high",
      levelXhighE: "x-high",
      levelMaxE: "max"
    },
    zh: {
      title: "求助专家",
      intro: " 让 agent 在难题上向更强的模型求助。在这里选择由哪个模型回答、每档难度最多推到多强，以及模型在哪里。",
      modeMagpie: "正在使用 Magpie 自己的模型",
      modeExternal: "正在使用外部端点 {host}",
      listPending: "模型列表会在插件随 Magpie 运行过一次之后填入。也可以通过「自定义…」输入任意模型 id。",
      listReady: "来自 Magpie 的 {n} 个模型，更新于 {age}。会标记支持推理档位的模型。",
      ageNow: "刚刚",
      ageMin: "{n} 分钟前",
      ageHour: "{n} 小时前",
      ageDay: "{n} 天前",
      modelLabel: "专家模型",
      modelHint: "求助工具会问这个模型。可从 Magpie 列表中选择，或用「自定义…」输入任意模型 id（外部端点时必须用它）。",
      notSet: "（未设置）",
      custom: "自定义…",
      customValue: "自定义模型 id",
      effortLabel: "推理强度",
      effortHint: "自动 = 发送 agent 请求的难度；固定档位 = 改发那一档；关闭 = 从不发送推理强度。",
      effortShort: "强度",
      autoEffort: "自动 —— 跟随 agent 请求的难度",
      useMainEffort: "（跟随主设置）",
      offEffort: "关闭 —— 从不发送推理强度",
      offShort: "关闭",
      savedEffort: "（已保存）",
      levelLow: "低",
      levelLowSub: "稍难",
      levelMedium: "中",
      levelMediumSub: "难",
      levelHigh: "高",
      levelHighSub: "很难",
      levelsLabel: "按难度指定模型",
      levelsHint: "可选。留空则该档使用主模型与主强度；这一档的强度列表跟随它最终使用的模型。",
      useMainModel: "（使用主模型）",
      advanced: "高级",
      timeoutLabel: "超时",
      timeoutHint: "秒，至少 1",
      timeoutErr: "请输入正数的秒数。",
      maxTokensLabel: "回答最大 token",
      maxTokensHint: "留空 = 提供方默认",
      maxTokensErr: "请输入正整数，或留空。",
      systemLabel: "系统提示词",
      reset: "重置",
      systemHint: "留空 = 内置默认",
      systemPlaceholder: "内置默认",
      external: "外部端点",
      externalHint: "Base URL 留空即使用 Magpie 自己的网关。填了 URL 就改为调用该 OpenAI 兼容端点。",
      baseUrlLabel: "Base URL",
      baseUrlHint: "留空 = 用 Magpie；需以 /v1 结尾",
      baseUrlErr: "必须以 http:// 或 https:// 开头，或留空。",
      apiKeyLabel: "API key",
      apiKeyHint: "Magpie 模式下忽略",
      apiKeyNote: "以明文保存在 Magpie 的插件选项里。",
      saved: "已保存 ✓",
      saving: "正在保存…",
      cantSave: "保存失败",
      fixFirst: "请先修正标出的字段",
      levelLowE: "低",
      levelMediumE: "中",
      levelHighE: "高",
      levelXhighE: "更高",
      levelMaxE: "最高"
    }
  };

  var lang = "en";
  var current = {}; // last known saved options, unknown keys included
  var state = {}; // per dropdown: "", an id, a level, or CUSTOM
  var queue = null; // full options object waiting to be written
  var writeTimer = null;
  var writeAt = 0; // earliest moment the next write may go out
  var writing = false;
  var writeCount = 0;
  var lastStatus = "";
  var pickers = {};
  var openPicker = null;

  function $(id) { return document.getElementById(id); }
  function t(key) {
    var dict = I18N[lang] || I18N.en;
    return dict[key] != null ? dict[key] : (I18N.en[key] != null ? I18N.en[key] : key);
  }

  function setStatus(st, text) {
    var box = $("save");
    if (!box) return;
    lastStatus = st;
    box.dataset.state = st || "";
    $("saveText").textContent = text == null ? "" : text;
  }

  /* ---------- theme & language ---------- */

  function applyTheme(theme) {
    theme = theme || {};
    document.documentElement.setAttribute("data-theme", theme.dark ? "dark" : "light");
    lang = theme.lang === "zh" ? "zh" : "en";
    document.documentElement.setAttribute("lang", lang);
    translate();
    paintStatusLine();
    syncAll(); // item labels are translated strings
  }

  function translate() {
    var nodes = document.querySelectorAll("[data-t]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].dataset.t);
    }
    var ph = document.querySelectorAll("[data-t-placeholder]");
    for (var j = 0; j < ph.length; j++) ph[j].setAttribute("placeholder", t(ph[j].dataset.tPlaceholder));
    document.title = t("title");
  }

  /* ---------- model list ---------- */

  function models() {
    var list = window.ASK_EXPERT_MODELS;
    return Object.prototype.toString.call(list) === "[object Array]" ? list : [];
  }

  function findModel(id) {
    if (!id) return null;
    var list = models();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  function ageText(iso) {
    var then = Date.parse(iso || "");
    if (!isFinite(then)) return t("ageNow");
    var mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return t("ageNow");
    if (mins < 60) return t("ageMin").replace("{n}", String(mins));
    var hours = Math.floor(mins / 60);
    if (hours < 24) return t("ageHour").replace("{n}", String(hours));
    return t("ageDay").replace("{n}", String(Math.floor(hours / 24)));
  }

  function hostOf(url) {
    try {
      return new URL(url).host || url;
    } catch (e) {
      return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    }
  }

  function paintStatusLine() {
    var url = ($("baseUrl") && $("baseUrl").value.trim()) || "";
    if (url) {
      $("modeDot").className = "dot external";
      $("modeText").textContent = t("modeExternal").replace("{host}", hostOf(url));
    } else {
      $("modeDot").className = "dot";
      $("modeText").textContent = t("modeMagpie");
    }
    var list = models();
    $("listInfo").textContent = list.length
      ? t("listReady").replace("{n}", String(list.length)).replace("{age}", ageText(window.ASK_EXPERT_MODELS_AT))
      : t("listPending");
  }

  /* ---------- dropdown engine (magpie's picker look) ---------- */

  function optButton(item, idx, listId) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "picker-opt";
    b.id = listId + "-opt-" + idx;
    b.dataset.value = item.value;
    b.setAttribute("role", "option");
    b.tabIndex = -1;
    var label = document.createElement("span");
    label.className = "picker-opt-label";
    label.textContent = item.label;
    b.appendChild(label);
    if (item.mark) {
      var mark = document.createElement("span");
      mark.className = "optmark";
      mark.textContent = item.mark;
      b.appendChild(mark);
    }
    return b;
  }

  function makePicker(name, btnId, listId, getItems, onPick) {
    var btn = $(btnId);
    var list = $(listId);
    var val = btn.querySelector(".picker-val");
    var sig = "";
    var active = 0;
    var api = {};

    function items() { return getItems(); }

    function setActive(idx) {
      var opts = list.querySelectorAll(".picker-opt");
      if (!opts.length) return;
      active = (idx + opts.length) % opts.length;
      for (var i = 0; i < opts.length; i++) opts[i].classList.toggle("active", i === active);
      list.setAttribute("aria-activedescendant", opts[active].id);
    }

    function sync() {
      var opts = items();
      var cur = state[name];
      var found = null;
      for (var i = 0; i < opts.length; i++) if (opts[i].value === cur) found = opts[i];
      var shown = (found || opts[0] || { label: "" }).label;
      if (cur === CUSTOM) {
        var typed = $(name + "Custom").value.trim();
        if (typed) shown = t("custom").replace("…", "") + " · " + typed; // show what was typed, not just "Custom…"
      }
      val.textContent = shown;
      var nextSig = lang + "|" + cur + "|" + opts.map(function (o) { return o.value + ":" + o.label; }).join(",");
      if (nextSig === sig) return;
      sig = nextSig;
      while (list.firstChild) list.removeChild(list.firstChild);
      for (var j = 0; j < opts.length; j++) {
        var b = optButton(opts[j], j, listId);
        b.setAttribute("aria-selected", String(opts[j].value === cur));
        if (opts[j].value === CUSTOM) b.dataset.custom = "1";
        list.appendChild(b);
      }
      if (!list.hidden) setActive(0);
    }

    function position() {
      if (list.hidden) return;
      var r = btn.getBoundingClientRect();
      var gap = 4;
      var edge = 8;
      list.style.minWidth = Math.min(Math.max(r.width, 170), window.innerWidth - edge * 2) + "px";
      var natural = Math.min(list.scrollHeight + 2, 240);
      var below = window.innerHeight - r.bottom - gap - edge;
      var above = r.top - gap - edge;
      var flip = below < natural && above > below;
      var maxH = Math.max(72, Math.min(240, flip ? above : below));
      var h = Math.min(natural, maxH);
      var top = flip
        ? Math.max(edge, r.top - gap - h)
        : Math.min(window.innerHeight - edge - h, Math.max(edge, r.bottom + gap));
      list.style.left = Math.max(edge, Math.min(r.left, window.innerWidth - list.offsetWidth - edge)) + "px";
      list.style.top = top + "px";
      list.style.maxHeight = maxH + "px";
    }

    function close(refocus) {
      if (openPicker === api) openPicker = null;
      list.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      list.removeAttribute("aria-activedescendant");
      if (refocus) btn.focus({ preventScroll: true });
    }

    function choose(idx) {
      var picked = items()[idx];
      if (!picked) return;
      var at = list.querySelectorAll(".picker-opt")[idx];
      close(true);
      onPick(picked.value, at && at.dataset.custom === "1");
    }

    function open(idx) {
      if (openPicker && openPicker !== api) openPicker.close(false);
      if (!items().length) return;
      sync();
      var opts = items();
      var sel = 0;
      for (var i = 0; i < opts.length; i++) if (opts[i].value === state[name]) sel = i;
      list.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      openPicker = api;
      position();
      setActive(idx === "last" ? opts.length - 1 : sel);
      list.focus({ preventScroll: true });
    }

    btn.addEventListener("click", function () {
      if (list.hidden) open("sel"); else close(true);
    });

    btn.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (list.hidden) open(ev.key === "ArrowUp" ? "last" : "sel");
        else setActive(active + (ev.key === "ArrowDown" ? 1 : -1));
      } else if (ev.key === "Enter" || ev.key === " ") {
        if (list.hidden) { ev.preventDefault(); open("sel"); }
      } else if (ev.key === "Escape" && !list.hidden) {
        ev.preventDefault();
        close(true);
      }
    });

    list.addEventListener("pointermove", function (ev) {
      var el = ev.target.closest ? ev.target.closest(".picker-opt") : null;
      if (!el) return;
      var idx = Number(el.id.slice(listId.length + 5));
      if (idx !== active) setActive(idx);
    });

    list.addEventListener("click", function (ev) {
      var el = ev.target.closest ? ev.target.closest(".picker-opt") : null;
      if (!el) return;
      ev.stopPropagation();
      choose(Number(el.id.slice(listId.length + 5)));
    });

    list.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") { ev.preventDefault(); setActive(active + 1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive(active - 1); }
      else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); choose(active); }
      else if (ev.key === "Home") { ev.preventDefault(); setActive(0); }
      else if (ev.key === "End") { ev.preventDefault(); setActive(items().length - 1); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(true); }
      else if (ev.key === "Tab") close(false);
    });

    api.sync = sync;
    api.close = close;
    pickers[name] = api;
    return api;
  }

  /* ---------- item lists ---------- */

  function modelItems(notSetLabel) {
    var out = [{ value: "", label: t(notSetLabel) }];
    var list = models();
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m.id !== "string" || !m.id) continue;
      out.push({
        value: m.id,
        label: m.name && m.name !== m.id ? m.name + " — " + m.id : m.id,
        mark: m.reasoning ? "reasoning" + (m.levels && m.levels.length ? " (" + m.levels.join("/") + ")" : "") : ""
      });
    }
    out.push({ value: CUSTOM, label: t("custom") });
    return out;
  }

  function levelsFor(modelId) {
    var m = findModel(modelId);
    if (m && m.levels && m.levels.length) return m.levels;
    return GENERIC_LEVELS;
  }

  function effortItems(name) {
    var mainEffort = name === "effort";
    var modelId = mainEffort ? effValue("model") : (effValue(name.replace("effort", "model")) || effValue("model"));
    var out = [{ value: "", label: t(mainEffort ? "autoEffort" : "useMainEffort") }];
    out.push({ value: "none", label: t(mainEffort ? "offEffort" : "offShort") });
    var lv = levelsFor(modelId);
    for (var i = 0; i < lv.length; i++) {
      if (lv[i] === "none") continue; // the Off item already covers it
      var key = "level" + lv[i].charAt(0).toUpperCase() + lv[i].slice(1) + "E";
      out.push({ value: lv[i], label: t(key) === key ? lv[i] : t(key) });
    }
    var cur = state[name];
    if (cur && cur !== CUSTOM) {
      var known = false;
      for (var j = 0; j < out.length; j++) if (out[j].value === cur) known = true;
      if (!known) out.push({ value: cur, label: cur + " " + t("savedEffort") });
    }
    return out;
  }

  /* ---------- values ---------- */

  function effValue(name) {
    var v = state[name];
    if (v !== CUSTOM) return v || "";
    var el = $(name + "Custom");
    return el ? el.value.trim() : "";
  }

  function onPickModel(name, value, isCustom) {
    var el = $(name + "Custom");
    state[name] = value;
    if (isCustom) {
      el.hidden = false;
      el.focus();
    } else {
      el.hidden = true;
      el.value = "";
    }
    pickers[name].sync();
    refreshEfforts();
    scheduleSave();
  }

  function onPickEffort(name, value) {
    state[name] = value;
    pickers[name].sync();
    scheduleSave();
  }

  function refreshEfforts() {
    var k;
    for (k in EFFORT_KEYS) if (pickers[k]) pickers[k].sync();
  }

  /* ---------- validation ---------- */

  function bad(field, errId, on) {
    var el = $(field);
    if (on) el.classList.add("invalid"); else el.classList.remove("invalid");
    if ($(errId)) $(errId).hidden = !on;
  }

  function validTimeout() {
    var raw = $("timeout").value.trim();
    var v = Number(raw);
    var fine = raw !== "" && isFinite(v) && v >= 1;
    bad("timeout", "timeoutErr", !fine);
    return fine;
  }

  function validMaxTokens() {
    var raw = $("maxTokens").value.trim();
    var fine = raw === "" || (/^\d+$/.test(raw) && Number(raw) >= 1);
    bad("maxTokens", "maxTokensErr", !fine);
    return fine;
  }

  function validBaseUrl() {
    var raw = $("baseUrl").value.trim();
    var fine = raw === "" || /^https?:\/\//i.test(raw);
    bad("baseUrl", "baseUrlErr", !fine);
    paintStatusLine();
    return fine;
  }

  function allValid() {
    var a = validTimeout();
    var b = validMaxTokens();
    var c = validBaseUrl();
    return a && b && c;
  }

  /* ---------- reading / writing options ---------- */

  function buildOptions() {
    var out = {};
    var k;
    for (k in current) if (Object.prototype.hasOwnProperty.call(current, k)) out[k] = current[k];
    delete out.sendReasoningEffort; // replaced by effort / effortLow… effortHigh
    for (k in MODEL_KEYS) out[k] = effValue(k);
    for (k in EFFORT_KEYS) out[k] = effValue(k);
    out.baseUrl = $("baseUrl").value.trim();
    out.apiKey = $("apiKey").value;
    out.systemPrompt = $("systemPrompt").value.trim();
    out.timeout = Number($("timeout").value.trim());
    var mt = $("maxTokens").value.trim();
    out.maxTokens = mt === "" ? "" : Number(mt);
    return out;
  }

  function seedPicker(name, value) {
    if (name.indexOf("model") !== 0) return value; // effort: unknown values stay, listed as extras
    if (value === "") return "";
    var list = modelItems(name === "model" ? "notSet" : "useMainModel");
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return value;
    return CUSTOM;
  }

  function fill(opts) {
    current = opts && typeof opts === "object" ? opts : {};
    var name, v, el;
    for (name in MODEL_KEYS) {
      v = typeof current[name] === "string" ? current[name].trim() : current[name] == null ? "" : String(current[name]);
      el = $(name + "Custom");
      state[name] = seedPicker(name, v);
      if (state[name] === CUSTOM) {
        el.value = v;
        el.hidden = false;
      } else {
        el.value = "";
        el.hidden = true;
      }
    }
    for (name in EFFORT_KEYS) {
      v = typeof current[name] === "string" ? current[name].trim() : current[name] == null ? "" : String(current[name]);
      state[name] = v;
    }
    $("timeout").value = current.timeout == null || current.timeout === "" ? String(TIMEOUT_RESET) : String(current.timeout);
    $("maxTokens").value = current.maxTokens == null ? "" : String(current.maxTokens);
    $("baseUrl").value = typeof current.baseUrl === "string" ? current.baseUrl : "";
    $("apiKey").value = typeof current.apiKey === "string" ? current.apiKey : "";
    $("systemPrompt").value = typeof current.systemPrompt === "string" ? current.systemPrompt : "";
  }

  function syncAll() {
    var k;
    for (k in MODEL_KEYS) if (pickers[k]) pickers[k].sync();
    for (k in EFFORT_KEYS) if (pickers[k]) pickers[k].sync();
    paintStatusLine();
  }

  /* ---------- saving ---------- */

  function scheduleSave() {
    if (!allValid()) {
      queue = null;
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      setStatus("invalid", t("fixFirst"));
      return;
    }
    queue = buildOptions();
    setStatus("saving", t("saving"));
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(pump, DEBOUNCE_MS);
  }

  function pump() {
    writeTimer = null;
    if (writing || !queue) return;
    var wait = writeAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      writeTimer = setTimeout(pump, wait);
      return;
    }
    write();
  }

  function write() {
    if (writing || !queue) return;
    var payload = queue;
    queue = null;
    writing = true;
    writeAt = Date.now();
    setStatus("saving", t("saving"));
    var p;
    try {
      p = bridge.options.set(payload);
    } catch (e) {
      p = Promise.reject(e);
    }
    Promise.resolve(p).then(function (saved) {
      var result = saved && typeof saved === "object" ? saved : payload;
      for (var k in result) if (Object.prototype.hasOwnProperty.call(result, k)) current[k] = result[k];
      writeCount++;
      setStatus("saved", t("saved"));
    }, function () {
      setStatus("error", t("cantSave"));
    }).then(function () {
      writing = false;
      if (queue) pump();
    });
  }

  function flush() {
    return new Promise(function (resolve) {
      (function wait() {
        if (!writing && !queue && !writeTimer) return resolve(writeCount);
        setTimeout(wait, 5);
      })();
    });
  }

  /* ---------- wiring ---------- */

  function wire() {
    var name, k;
    function bindPicker(mode) {
      var key = name;
      makePicker(key, key + "Btn", key + "List",
        function () { return mode === "model" ? modelItems(key === "model" ? "notSet" : "useMainModel") : effortItems(key); },
        mode === "model"
          ? function (value, isCustom) { onPickModel(key, value, isCustom); }
          : function (value) { onPickEffort(key, value); });
      if (mode === "model") {
        $(key + "Custom").addEventListener("input", function () {
          pickers[key].sync(); // keep the button label showing the typed id
          scheduleSave();
        });
      }
    }
    for (name in MODEL_KEYS) bindPicker("model");
    for (name in EFFORT_KEYS) bindPicker("effort");

    var plain = PLAIN_KEYS.concat(["timeout", "maxTokens"]);
    for (k = 0; k < plain.length; k++) {
      var el = $(plain[k]);
      if (!el) continue;
      el.addEventListener("input", scheduleSave);
      if (el.tagName === "TEXTAREA") continue;
      el.addEventListener("blur", function (ev) {
        var id = ev.target.id;
        if (id === "timeout" && !validTimeout()) {
          ev.target.value = String(TIMEOUT_RESET);
          validTimeout();
          scheduleSave();
        } else if (id === "maxTokens" && ev.target.value.trim() !== "" && !validMaxTokens()) {
          setStatus("invalid", t("fixFirst"));
        } else if (id === "baseUrl") {
          validBaseUrl();
        }
      });
    }

    $("resetPrompt").addEventListener("click", function () {
      $("systemPrompt").value = "";
      $("systemPrompt").focus();
      scheduleSave();
    });

    document.addEventListener("click", function (ev) {
      if (!openPicker) return;
      if (ev.target.closest && ev.target.closest(".picker")) return;
      openPicker.close(false);
    });
    window.addEventListener("resize", function () {
      if (openPicker) openPicker.close(false);
    });
  }

  window.__askExpertTest = {
    config: function () { return { debounce: DEBOUNCE_MS, minInterval: MIN_INTERVAL_MS }; },
    setDebounce: function (ms) { DEBOUNCE_MS = ms; },
    setMinInterval: function (ms) { MIN_INTERVAL_MS = ms; },
    flush: flush,
    writes: function () { return writeCount; },
    status: function () { return lastStatus; },
    pending: function () { return !!queue; },
    items: function (name) { return pickers[name] ? pickers[name].sync() || null : null; },
    open: function (name) { pickers[name] && $(name + "Btn").click(); },
    list: function (name) {
      var out = [];
      var nodes = $(name + "List").querySelectorAll(".picker-opt");
      for (var i = 0; i < nodes.length; i++) out.push(nodes[i].dataset.value);
      return out;
    },
    pick: function (name, index) {
      var nodes = $(name + "List").querySelectorAll(".picker-opt");
      if (nodes[index]) nodes[index].click();
    },
    picked: function (name) { return state[name]; }
  };

  function start(opts) {
    fill(opts);
    wire();
    syncAll(); // pickers exist only now, so the first paint happens here
  }

  function init() {
    Promise.resolve(bridge.ready).then(function (theme) {
      applyTheme(theme);
      return Promise.resolve(bridge.options.get()).then(function (opts) {
        start(opts);
        if (typeof bridge.onTheme === "function") bridge.onTheme(applyTheme);
      }, function () {
        start({});
      });
    }, function () {
      applyTheme({});
      start({});
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  var panelEl = $("panel");
  if (panelEl) panelEl.dataset.ready = "1";
})();
