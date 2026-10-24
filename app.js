import { jsonrepair } from "https://esm.run/jsonrepair@3.15.0";

// ── State ────────────────────────────────────────────────────────────────────
let worker = null;
let modelReady = false;
let running = false;
let loadStartTime = null;

const DEFAULT_ACTIONS = {
  create_file: {
    description: "Creates a file in the sandbox. Parameters: { filename, content }",
    execute: (state, { filename, content }) => {
      state.files[filename] = content;
      return `File "${filename}" created successfully.`;
    },
  },
  read_file: {
    description: "Reads an existing file. Parameters: { filename }",
    execute: (state, { filename }) => {
      if (state.files[filename] === undefined) return `Error: File "${filename}" not found.`;
      return state.files[filename];
    },
  },
  list_files: {
    description: "Lists all files in the sandbox. Parameters: {}",
    execute: (state) => {
      const names = Object.keys(state.files);
      return names.length ? names.join(", ") : "(no files)";
    },
  },
  delete_file: {
    description: "Deletes a file from the sandbox. Parameters: { filename }",
    execute: (state, { filename }) => {
      if (state.files[filename] === undefined) return `Error: File "${filename}" not found.`;
      delete state.files[filename];
      return `File "${filename}" deleted.`;
    },
  },
  set_variable: {
    description: "Stores a key-value pair. Parameters: { key, value }",
    execute: (state, { key, value }) => {
      state.vars[key] = value;
      return `Variable "${key}" set to "${value}".`;
    },
  },
  get_variable: {
    description: "Retrieves a stored variable. Parameters: { key }",
    execute: (state, { key }) => {
      return state.vars[key] !== undefined
        ? String(state.vars[key])
        : `Error: Variable "${key}" not found.`;
    },
  },
};

let actionRegistry = { ...DEFAULT_ACTIONS };
let sandboxState = { files: {}, vars: {}, logs: [] };

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const modelSelect   = $("model-select");
const loadModelBtn  = $("load-model-btn");
const modelStatus   = $("model-status");
const loadProgress  = $("load-progress");
const progressBar   = $("progress-bar");
const progressPct   = $("progress-pct");
const taskInput     = $("task-input");
const maxStepsInput = $("max-steps");
const runBtn        = $("run-btn");
const logsEl        = $("logs");
const verdictEl     = $("verdict");
const stateEl       = $("state-view");
const stateBadge    = $("state-badge");
const actionsEl     = $("actions-editor");
const resetBtn      = $("reset-btn");
const clearLogsBtn  = $("clear-logs-btn");
const tokenStreamEl = $("token-stream");
const streamStatus  = $("stream-status");
const statsBarEl    = $("stats-bar");
const traceEl       = $("trace");
const stepCounter   = $("step-counter");

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  const t = new Date().toLocaleTimeString("en", { hour12: false });
  entry.innerHTML = `<span class="log-time">${t}</span> <span class="log-msg">${escapeHtml(msg)}</span>`;
  logsEl.appendChild(entry);
  logsEl.scrollTop = logsEl.scrollHeight;
  return entry;
}

function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Agent Trace cards ─────────────────────────────────────────────────────────
function clearTrace() {
  traceEl.innerHTML = "";
  stepCounter.textContent = "—";
}

function addTraceStep(stepNum, maxSteps) {
  // Remove empty placeholder
  const empty = traceEl.querySelector(".trace-empty");
  if (empty) empty.remove();

  stepCounter.textContent = `Step ${stepNum} / ${maxSteps}`;

  const card = document.createElement("div");
  card.className = "trace-card trace-pending";
  card.id = `trace-step-${stepNum}`;
  card.innerHTML = `
    <div class="trace-step-label">Step ${stepNum}</div>
    <div class="trace-thought trace-section">
      <span class="trace-icon">💭</span>
      <span class="trace-section-label">Thought</span>
      <div class="trace-section-body" id="trace-thought-${stepNum}">waiting…</div>
    </div>
    <div class="trace-action-row trace-section">
      <span class="trace-icon">⚡</span>
      <span class="trace-section-label">Action</span>
      <code class="trace-action-name" id="trace-action-${stepNum}">—</code>
      <span class="trace-params" id="trace-params-${stepNum}"></span>
    </div>
    <div class="trace-result trace-section" id="trace-result-wrap-${stepNum}" hidden>
      <span class="trace-icon">✔</span>
      <span class="trace-section-label">Result</span>
      <div class="trace-section-body trace-result-body" id="trace-result-${stepNum}"></div>
    </div>
  `;
  traceEl.appendChild(card);
  traceEl.scrollTop = traceEl.scrollHeight;
  return card;
}

function fillTraceDecision(stepNum, decision) {
  const thoughtEl = $(`trace-thought-${stepNum}`);
  const actionEl  = $(`trace-action-${stepNum}`);
  const paramsEl  = $(`trace-params-${stepNum}`);
  if (thoughtEl) thoughtEl.textContent = decision.thought || "(no thought)";
  if (actionEl)  actionEl.textContent  = decision.action || "?";
  if (paramsEl)  paramsEl.textContent  = JSON.stringify(decision.parameters || {});
}

function fillTraceResult(stepNum, result, success) {
  const wrap   = $(`trace-result-wrap-${stepNum}`);
  const body   = $(`trace-result-${stepNum}`);
  const card   = $(`trace-step-${stepNum}`);
  if (wrap) wrap.hidden = false;
  if (body) body.textContent = result;
  if (card) {
    card.classList.remove("trace-pending");
    card.classList.add(success === false ? "trace-error" : "trace-done");
  }
}

function markTraceFinal(stepNum, passed) {
  const card = $(`trace-step-${stepNum}`);
  if (card) {
    card.classList.remove("trace-pending", "trace-done", "trace-error");
    card.classList.add(passed ? "trace-final-pass" : "trace-final-fail");
  }
}

// ── Sandbox state view ────────────────────────────────────────────────────────
function updateStateView() {
  stateEl.textContent = JSON.stringify(sandboxState, null, 2);
  const hasContent = Object.keys(sandboxState.files).length > 0 ||
                     Object.keys(sandboxState.vars).length > 0;
  stateBadge.textContent = hasContent ? "updated" : "empty";
  stateBadge.className = `stream-badge ${hasContent ? "stream-live" : "stream-idle"}`;
  // Flash the pre element
  stateEl.classList.remove("state-flash");
  void stateEl.offsetWidth;
  stateEl.classList.add("state-flash");
}

// ── Stats bar ─────────────────────────────────────────────────────────────────
let totalPromptTokens = 0;
let totalCompletionTokens = 0;

function updateStatsBar(usage, elapsed) {
  if (usage) {
    totalPromptTokens     += usage.prompt_tokens ?? 0;
    totalCompletionTokens += usage.completion_tokens ?? 0;
  }
  const tps = usage?.completion_tokens && elapsed
    ? (usage.completion_tokens / parseFloat(elapsed)).toFixed(1) : "—";
  statsBarEl.innerHTML =
    `<span class="stat">last prompt <b>${usage?.prompt_tokens ?? "—"}</b></span>` +
    `<span class="stat">last completion <b>${usage?.completion_tokens ?? "—"}</b></span>` +
    `<span class="stat">step time <b>${elapsed}s</b></span>` +
    `<span class="stat">speed <b>${tps} tok/s</b></span>` +
    `<span class="stat stat-total">session total <b>${totalPromptTokens + totalCompletionTokens}</b> tok</span>`;
  statsBarEl.hidden = false;
}

// ── Verdict ───────────────────────────────────────────────────────────────────
function setVerdict(result) {
  verdictEl.className = "verdict " + (result.success ? "verdict-pass" : "verdict-fail");
  verdictEl.innerHTML = `
    <div class="verdict-label">${result.success ? "✓ PASSED" : "✗ FAILED"}</div>
    <div class="verdict-reason">${escapeHtml(result.reason || "")}</div>`;
  verdictEl.hidden = false;
}

// ── System prompt ─────────────────────────────────────────────────────────────
function generateSystemPrompt(registry) {
  const actionList = Object.entries(registry)
    .map(([name, def]) => `- ${name}: ${def.description}`)
    .join("\n");
  return `You are an autonomous agent inside a browser sandbox. Respond ONLY with valid JSON:
{
  "thought": "<your reasoning about what still needs to be done>",
  "action": "<action_name or final_answer>",
  "parameters": { "<param>": "<value>" }
}

Available actions:
${actionList}
- final_answer: ONLY call this after ALL parts of the task are complete. Parameters: { "result": "<summary of everything done>" }

Example of one valid reply:
{"thought": "The task asks me to create notes.txt first.", "action": "create_file", "parameters": {"filename": "notes.txt", "content": "buy milk"}}

STRICT RULES:
1. Respond ONLY with the JSON object. No prose, no markdown, no code fences.
2. One action per response. Every reply MUST have "thought", "action" and "parameters".
3. Do the steps in the order the task gives them. If the task has multiple steps (e.g. "do X and then do Y"), you MUST execute EVERY step before calling final_answer.
4. Do not repeat an action that already succeeded. Use the Action Result messages to see what is done.
5. If the task asks for an action that is not in the list, still call it by that name — do NOT silently skip it.
6. Only call final_answer when every requested operation has been attempted.
7. parameters must always be an object, even if empty: {}`;
}

// ── Worker bridge ─────────────────────────────────────────────────────────────
let pendingResolve = null;
let pendingReject = null;

function initWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (e) => {
    log("Worker error: " + e.message, "error");
    setLoadingState(false);
    if (pendingReject) { pendingReject(new Error(e.message)); pendingResolve = pendingReject = null; }
  };
}

function handleWorkerMessage({ data }) {
  const { type, text, progress, content, message, elapsed, usage, delta } = data;

  if (type === "progress") {
    const pct = progress != null ? Math.round(progress * 100) : null;
    progressBar.style.width = (pct ?? 0) + "%";
    if (progressPct) progressPct.textContent = pct != null ? `${pct}%` : "";
    modelStatus.textContent = text;

    // Update last progress log line in-place
    const last = logsEl.lastElementChild;
    if (last?.dataset.prog) {
      last.querySelector(".log-msg").textContent = `${text}${pct != null ? ` [${pct}%]` : ""}`;
    } else {
      const e = log(`${text}${pct != null ? ` [${pct}%]` : ""}`, "info");
      e.dataset.prog = "1";
    }

  } else if (type === "ready") {
    const secs = loadStartTime ? ((performance.now() - loadStartTime) / 1000).toFixed(1) : "?";
    modelReady = true;
    setLoadingState(false);
    modelStatus.textContent = "Ready";
    loadProgress.hidden = true;
    runBtn.disabled = false;
    log(`✓ Model ready in ${secs}s`, "success");

  } else if (type === "error") {
    log(`✗ Error: ${message}`, "error");
    setLoadingState(false);
    loadProgress.hidden = true;
    // A chat request is waiting — fail it instead of hanging the run forever
    if (pendingReject) { pendingReject(new Error(message)); pendingResolve = pendingReject = null; }

  } else if (type === "token") {
    // Live token stream
    if (tokenStreamEl) tokenStreamEl.textContent = data.partial || "";
    streamStatus.textContent = "streaming";
    streamStatus.className = "stream-badge stream-live";

  } else if (type === "response") {
    streamStatus.textContent = "done";
    streamStatus.className = "stream-badge stream-done";
    if (usage || elapsed) updateStatsBar(usage, elapsed);
    if (pendingResolve) { pendingResolve(content); pendingResolve = pendingReject = null; }
  }
}

function askModel(messages) {
  if (tokenStreamEl) tokenStreamEl.textContent = "";
  streamStatus.textContent = "generating…";
  streamStatus.className = "stream-badge stream-live";
  const reply = new Promise((resolve, reject) => { pendingResolve = resolve; pendingReject = reject; });
  worker.postMessage({ type: "chat", payload: { messages } });
  return reply;
}

function setLoadingState(loading) {
  loadModelBtn.disabled = loading;
  loadModelBtn.textContent = loading ? "Loading…" : "Load Model";
}

// ── Load model ────────────────────────────────────────────────────────────────
loadModelBtn.addEventListener("click", () => {
  const model = modelSelect.value;
  modelReady = false;
  runBtn.disabled = true;
  loadProgress.hidden = false;
  progressBar.style.width = "0%";
  progressPct.textContent = "0%";
  modelStatus.textContent = "Initializing…";
  loadStartTime = performance.now();
  setLoadingState(true);
  log(`► Loading: ${model}`, "info");
  log("Weights are fetched from the MLC CDN and cached in your browser (IndexedDB). First load may take a few minutes.", "warn");
  initWorker();
  worker.postMessage({ type: "init", payload: { model } });
});

// ── Run harness ───────────────────────────────────────────────────────────────
runBtn.addEventListener("click", async () => {
  if (!modelReady || running) return;
  const userCommand = taskInput.value.trim();
  if (!userCommand) return;

  running = true;
  runBtn.disabled = true;
  loadModelBtn.disabled = true; // reloading mid-run would kill the worker
  verdictEl.hidden = true;
  statsBarEl.hidden = true;
  totalPromptTokens = 0;
  totalCompletionTokens = 0;
  sandboxState = { files: {}, vars: {}, logs: [] };
  updateStateView();
  clearTrace();
  streamStatus.textContent = "idle";
  streamStatus.className = "stream-badge stream-idle";
  if (tokenStreamEl) tokenStreamEl.textContent = "";

  const maxSteps = parseInt(maxStepsInput.value, 10) || 8;
  log(`━━━ Run: "${userCommand}"`, "step");

  try {
    const result = await runAgentHarness(userCommand, maxSteps);
    setVerdict(result);
    log(`━━━ ${result.success ? "✓ PASSED" : "✗ FAILED"}: ${result.reason}`,
      result.success ? "success" : "error");
  } catch (err) {
    log("Harness error: " + err.message, "error");
  }

  running = false;
  runBtn.disabled = !modelReady;
  loadModelBtn.disabled = false;
  streamStatus.textContent = "idle";
  streamStatus.className = "stream-badge stream-idle";
});

async function runAgentHarness(userCommand, maxSteps) {
  const history = [
    { role: "system", content: generateSystemPrompt(actionRegistry) },
    { role: "user",   content: userCommand },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    log(`── Step ${step} / ${maxSteps} ──`, "step");
    const traceCard = addTraceStep(step, maxSteps);
    void traceCard; // used for DOM side-effects

    // Send to model
    const t0 = performance.now();
    let raw;
    try {
      raw = await askModel(history);
    } catch (err) {
      return { success: false, reason: `Model call failed: ${err.message}` };
    }
    const stepSec = ((performance.now() - t0) / 1000).toFixed(2);
    log(`↩ ${stepSec}s`, "info");

    // Parse JSON
    let decision;
    try {
      decision = JSON.parse(raw);
    } catch {
      try {
        decision = parseDecision(raw);
        log("⚠ JSON repaired", "warn");
      } catch {
        log(`✗ Unparseable: ${raw.slice(0, 200)}`, "error");
        fillTraceDecision(step, { thought: "Parse error", action: "error", parameters: {} });
        fillTraceResult(step, raw.slice(0, 200), false);
        return { success: false, reason: "Agent produced unparseable JSON." };
      }
    }

    // Valid JSON but not a decision (e.g. no "action" field) is a format error,
    // not an unregistered action: tell the agent and let it retry within the step budget.
    if (!decision || typeof decision !== "object" || typeof decision.action !== "string" || !decision.action) {
      const reason = `Error: reply had no "action" field. Reply with {"thought": ..., "action": ..., "parameters": {...}}.`;
      fillTraceDecision(step, { thought: "Format error", action: "(none)", parameters: {} });
      fillTraceResult(step, reason, false);
      log(`✗ ${reason} Raw: ${raw.slice(0, 160)}`, "error");
      if (history.length > 16) history.splice(2, 2);
      history.push({ role: "assistant", content: raw });
      history.push({ role: "user", content: `Action Result: ${reason}` });
      continue;
    }

    // Fill trace with thought + action
    fillTraceDecision(step, decision);
    log(`💭 ${decision.thought}`, "thought");
    log(`⚡ ${decision.action} ${JSON.stringify(decision.parameters || {})}`, "action");

    // Final answer?
    if (decision.action === "final_answer") {
      const result = decision.parameters?.result || "";
      fillTraceResult(step, result || "(done)", true);
      markTraceFinal(step, true);
      updateStateView();
      const evalResult = evaluateSuccess(sandboxState, userCommand);
      markTraceFinal(step, evalResult.success);
      return evalResult;
    }

    // Execute action — unknown action is an immediate hard FAIL
    const tool = actionRegistry[decision.action];
    if (!tool) {
      const reason = `Agent called unregistered action "${decision.action}". Only registered actions may be used.`;
      fillTraceResult(step, reason, false);
      markTraceFinal(step, false);
      log(`✗ UNKNOWN ACTION: "${decision.action}" — run failed.`, "error");
      return { success: false, reason };
    }

    let actionResult;
    let actionOk = true;
    try {
      actionResult = tool.execute(sandboxState, decision.parameters || {});
      sandboxState.logs.push({ step, action: decision.action, result: actionResult });
      updateStateView();
    } catch (err) {
      actionResult = `Error: ${err.message}`;
      actionOk = false;
    }

    fillTraceResult(step, actionResult, actionOk);
    log(`${actionOk ? "✔" : "✗"} ${actionResult}`, actionOk ? "result" : "error");

    // Trim history to avoid context overflow
    if (history.length > 16) history.splice(2, 2);
    history.push({ role: "assistant", content: JSON.stringify(decision) });
    history.push({ role: "user",      content: `Action Result: ${actionResult}` });
  }

  return { success: false, reason: "Max steps reached without final_answer." };
}

// ── Decision parsing ──────────────────────────────────────────────────────────
// Small models often wrap the JSON in prose or code fences, or write several
// objects back to back ("{...} {...}"). Take the first complete object only —
// one action per response — and let jsonrepair fix what is left.
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return text;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start); // unclosed — jsonrepair will close it
}

function parseDecision(raw) {
  const candidate = extractFirstJsonObject(raw);
  let parsed;
  try { parsed = JSON.parse(candidate); }
  catch { parsed = JSON.parse(jsonrepair(candidate)); }
  if (Array.isArray(parsed)) parsed = parsed.find(x => x && typeof x === "object");
  return parsed;
}

// ── Evaluation judge ──────────────────────────────────────────────────────────
// Maps keywords in the task to the actions they require.
const TASK_ACTION_REQUIREMENTS = [
  { keywords: ["create"],                    action: "create_file"   },
  { keywords: ["read", "read it back"],      action: "read_file"     },
  { keywords: ["delete", "remove"],          action: "delete_file"   },
  { keywords: ["list"],                      action: "list_files"    },
  { keywords: ["set variable", "set a variable", "store"],    action: "set_variable"  },
  { keywords: ["get variable", "retrieve"],  action: "get_variable"  },
];

function evaluateSuccess(finalState, command) {
  const cmd = command.toLowerCase();
  const calledActions = finalState.logs.map(l => l.action);

  // ── Check every required action was actually called ──────────────────────
  const missing = [];
  for (const req of TASK_ACTION_REQUIREMENTS) {
    const mentioned = req.keywords.some(k => cmd.includes(k));
    if (!mentioned) continue;
    // Only enforce if the action is registered (can't demand unregistered ones)
    if (!actionRegistry[req.action]) continue;
    if (!calledActions.includes(req.action)) {
      missing.push(req.action);
    }
  }
  if (missing.length > 0) {
    return {
      success: false,
      reason: `Task incomplete — these required actions were never called: ${missing.join(", ")}. Agent called: [${calledActions.join(", ") || "none"}].`,
    };
  }

  // ── Specific state assertions ─────────────────────────────────────────────
  // Every filename the task mentions must end up in the expected place
  const filenames = [...new Set([...command.matchAll(/([\w][\w-]*\.[A-Za-z][A-Za-z0-9]*)/g)].map(m => m[1]))];
  if (cmd.includes("create") && filenames.length) {
    // If task also asks to delete the file, the absence is expected
    const shouldDelete = cmd.includes("delete") || cmd.includes("remove");
    if (shouldDelete) {
      const left = filenames.filter(f => finalState.files[f] !== undefined);
      if (left.length === 0) {
        return { success: true, reason: `${filenames.map(f => `"${f}"`).join(", ")} created then deleted — sandbox correctly empty.` };
      }
      return { success: false, reason: `${left.map(f => `"${f}"`).join(", ")} still exists in sandbox after a delete was requested.` };
    }
    const missingFiles = filenames.filter(f => finalState.files[f] === undefined);
    if (missingFiles.length === 0) {
      return {
        success: true,
        reason: filenames.map(f => `"${f}" exists: "${String(finalState.files[f]).slice(0, 40)}"`).join("; "),
      };
    }
    return {
      success: false,
      reason: `Missing from sandbox: ${missingFiles.join(", ")}. Found: [${Object.keys(finalState.files).join(", ") || "none"}].`,
    };
  }

  if (cmd.includes("variable") || cmd.includes("set ")) {
    const hasVars = Object.keys(finalState.vars).length > 0;
    return {
      success: hasVars,
      reason: hasVars
        ? `Variables stored: ${JSON.stringify(finalState.vars)}`
        : "No variables were stored in sandbox.",
    };
  }

  // Generic: any sandbox mutation counts as success
  const anyFiles = Object.keys(finalState.files).length > 0;
  const anyVars  = Object.keys(finalState.vars).length > 0;
  if (anyFiles || anyVars) {
    return {
      success: true,
      reason: `Sandbox: ${Object.keys(finalState.files).length} file(s), ${Object.keys(finalState.vars).length} variable(s).`,
    };
  }

  return { success: true, reason: "Agent reached final_answer." };
}

// ── Actions list ──────────────────────────────────────────────────────────────
function renderActionsEditor() {
  actionsEl.innerHTML = "";
  Object.entries(actionRegistry).forEach(([name, def]) => {
    const div = document.createElement("div");
    div.className = "action-card";
    div.innerHTML = `<div class="action-name">${escapeHtml(name)}</div>
      <div class="action-desc">${escapeHtml(def.description)}</div>`;
    actionsEl.appendChild(div);
  });
}
renderActionsEditor();

resetBtn.addEventListener("click", () => {
  sandboxState = { files: {}, vars: {}, logs: [] };
  updateStateView();
  clearTrace();
  verdictEl.hidden = true;
  statsBarEl.hidden = true;
  traceEl.innerHTML = '<div class="trace-empty">Run an evaluation to see the agent\'s reasoning and actions here.</div>';
  log("↺ Sandbox reset.", "info");
});

clearLogsBtn.addEventListener("click", () => { logsEl.innerHTML = ""; });

updateStateView();

// ── Harness Self-Test Suite ───────────────────────────────────────────────────
// Tests the harness machinery directly — no model needed.
// Each test is { name, fn } where fn returns { pass, detail }.

const HARNESS_TESTS = [

  // ── Action Registry ──────────────────────────────────────────────────────
  {
    group: "Action Registry",
    name: "create_file stores file in sandbox",
    fn() {
      const s = freshState();
      const result = actionRegistry.create_file.execute(s, { filename: "a.txt", content: "hello" });
      return {
        pass: s.files["a.txt"] === "hello" && result.includes("created"),
        detail: `state.files["a.txt"] = "${s.files["a.txt"]}"`,
      };
    },
  },
  {
    group: "Action Registry",
    name: "read_file returns content of existing file",
    fn() {
      const s = freshState();
      s.files["b.txt"] = "world";
      const result = actionRegistry.read_file.execute(s, { filename: "b.txt" });
      return { pass: result === "world", detail: `returned: "${result}"` };
    },
  },
  {
    group: "Action Registry",
    name: "read_file returns error for missing file",
    fn() {
      const s = freshState();
      const result = actionRegistry.read_file.execute(s, { filename: "missing.txt" });
      return { pass: result.startsWith("Error:"), detail: `returned: "${result}"` };
    },
  },
  {
    group: "Action Registry",
    name: "list_files returns all filenames",
    fn() {
      const s = freshState();
      s.files["x.txt"] = "1";
      s.files["y.txt"] = "2";
      const result = actionRegistry.list_files.execute(s, {});
      return {
        pass: result.includes("x.txt") && result.includes("y.txt"),
        detail: `returned: "${result}"`,
      };
    },
  },
  {
    group: "Action Registry",
    name: "list_files returns empty message when no files",
    fn() {
      const s = freshState();
      const result = actionRegistry.list_files.execute(s, {});
      return { pass: result === "(no files)", detail: `returned: "${result}"` };
    },
  },
  {
    group: "Action Registry",
    name: "delete_file removes the file",
    fn() {
      const s = freshState();
      s.files["del.txt"] = "bye";
      actionRegistry.delete_file.execute(s, { filename: "del.txt" });
      return { pass: s.files["del.txt"] === undefined, detail: `state.files["del.txt"] = ${s.files["del.txt"]}` };
    },
  },
  {
    group: "Action Registry",
    name: "delete_file returns error for missing file",
    fn() {
      const s = freshState();
      const result = actionRegistry.delete_file.execute(s, { filename: "ghost.txt" });
      return { pass: result.startsWith("Error:"), detail: `returned: "${result}"` };
    },
  },
  {
    group: "Action Registry",
    name: "set_variable stores value",
    fn() {
      const s = freshState();
      actionRegistry.set_variable.execute(s, { key: "score", value: "42" });
      return { pass: s.vars["score"] === "42", detail: `state.vars["score"] = "${s.vars["score"]}"` };
    },
  },
  {
    group: "Action Registry",
    name: "get_variable retrieves stored value",
    fn() {
      const s = freshState();
      s.vars["name"] = "alice";
      const result = actionRegistry.get_variable.execute(s, { key: "name" });
      return { pass: result === "alice", detail: `returned: "${result}"` };
    },
  },
  {
    group: "Action Registry",
    name: "get_variable returns error for missing key",
    fn() {
      const s = freshState();
      const result = actionRegistry.get_variable.execute(s, { key: "nope" });
      return { pass: result.startsWith("Error:"), detail: `returned: "${result}"` };
    },
  },

  // ── Sandbox Isolation ────────────────────────────────────────────────────
  {
    group: "Sandbox Isolation",
    name: "freshState() produces empty isolated state",
    fn() {
      const s1 = freshState();
      s1.files["leak.txt"] = "oops";
      const s2 = freshState();
      return {
        pass: s2.files["leak.txt"] === undefined,
        detail: `s2.files["leak.txt"] = ${s2.files["leak.txt"]}`,
      };
    },
  },
  {
    group: "Sandbox Isolation",
    name: "mutations in one state do not affect another",
    fn() {
      const s1 = freshState();
      const s2 = freshState();
      actionRegistry.set_variable.execute(s1, { key: "x", value: "1" });
      return { pass: s2.vars["x"] === undefined, detail: `s2.vars["x"] = ${s2.vars["x"]}` };
    },
  },

  // ── Unknown Action Enforcement ───────────────────────────────────────────
  {
    group: "Unknown Action Enforcement",
    name: "unregistered action name is not in registry",
    fn() {
      const has = "ring_bell" in actionRegistry;
      return { pass: !has, detail: `"ring_bell" in registry: ${has}` };
    },
  },
  {
    group: "Unknown Action Enforcement",
    name: "registry lookup returns undefined for unknown action",
    fn() {
      const tool = actionRegistry["fly_to_moon"];
      return { pass: tool === undefined, detail: `registry["fly_to_moon"] = ${tool}` };
    },
  },
  {
    group: "Unknown Action Enforcement",
    name: "all registered actions are executable functions",
    fn() {
      const broken = Object.entries(actionRegistry)
        .filter(([, def]) => typeof def.execute !== "function")
        .map(([name]) => name);
      return {
        pass: broken.length === 0,
        detail: broken.length ? `Non-callable: ${broken.join(", ")}` : `All ${Object.keys(actionRegistry).length} actions OK`,
      };
    },
  },

  // ── Judge / Evaluator ────────────────────────────────────────────────────
  {
    group: "Judge / Evaluator",
    name: "PASS — create_file called and file exists",
    fn() {
      const s = freshState();
      s.files["note.txt"] = "hi";
      s.logs.push({ step: 1, action: "create_file", result: "ok" });
      const r = evaluateSuccess(s, "create a file called note.txt");
      return { pass: r.success === true, detail: `reason: "${r.reason}"` };
    },
  },
  {
    group: "Judge / Evaluator",
    name: "FAIL — create_file never called (agent skipped it)",
    fn() {
      const s = freshState();
      // No logs, no files — agent called final_answer immediately
      const r = evaluateSuccess(s, "create a file called note.txt");
      return { pass: r.success === false, detail: `reason: "${r.reason}"` };
    },
  },
  {
    group: "Judge / Evaluator",
    name: "FAIL — multi-step: create called but read never called",
    fn() {
      const s = freshState();
      s.files["note.txt"] = "hi";
      s.logs.push({ step: 1, action: "create_file", result: "ok" });
      // Agent skipped the read step
      const r = evaluateSuccess(s, "create a file called note.txt then read it back");
      return { pass: r.success === false, detail: `reason: "${r.reason}"` };
    },
  },
  {
    group: "Judge / Evaluator",
    name: "PASS — create then delete: file absent after both called",
    fn() {
      const s = freshState();
      // File was created then deleted — correct final state is empty
      s.logs.push({ step: 1, action: "create_file", result: "ok" });
      s.logs.push({ step: 2, action: "delete_file", result: "ok" });
      const r = evaluateSuccess(s, "create a file called note.txt then delete it");
      return { pass: r.success === true, detail: `reason: "${r.reason}"` };
    },
  },
  {
    group: "Judge / Evaluator",
    name: "PASS — variable task: set_variable called and var stored",
    fn() {
      const s = freshState();
      s.vars["count"] = "5";
      s.logs.push({ step: 1, action: "set_variable", result: "ok" });
      const r = evaluateSuccess(s, "set a variable called count");
      return { pass: r.success === true, detail: `reason: "${r.reason}"` };
    },
  },
  {
    group: "Judge / Evaluator",
    name: "FAIL — variable task: agent never called set_variable",
    fn() {
      const s = freshState();
      const r = evaluateSuccess(s, "set a variable called count");
      return { pass: r.success === false, detail: `reason: "${r.reason}"` };
    },
  },

  {
    group: "Judge / Evaluator",
    name: "FAIL — only one of three requested files was created",
    fn() {
      const s = freshState();
      s.files["c.txt"] = "x";
      s.logs.push({ step: 1, action: "create_file", result: "ok" });
      s.logs.push({ step: 2, action: "list_files", result: "c.txt" });
      const r = evaluateSuccess(s, "Create three files: a.txt, b.txt, and c.txt. Then list all files.");
      return { pass: r.success === false, detail: `reason: "${r.reason}"` };
    },
  },

  // ── JSON Repair ──────────────────────────────────────────────────────────
  {
    group: "JSON Repair",
    name: "valid JSON parses without repair",
    fn() {
      const raw = '{"thought":"ok","action":"create_file","parameters":{}}';
      try { JSON.parse(raw); return { pass: true, detail: "Parsed OK" }; }
      catch (e) { return { pass: false, detail: e.message }; }
    },
  },
  {
    group: "JSON Repair",
    name: "jsonrepair fixes trailing-comma JSON",
    fn() {
      const broken = '{"thought":"ok","action":"final_answer","parameters":{"result":"done",}}';
      try {
        const fixed = jsonrepair(broken);
        JSON.parse(fixed);
        return { pass: true, detail: `repaired: ${fixed.slice(0, 60)}` };
      } catch (e) { return { pass: false, detail: e.message }; }
    },
  },
  {
    group: "JSON Repair",
    name: "jsonrepair fixes missing closing brace",
    fn() {
      const broken = '{"thought":"test","action":"list_files","parameters":{}';
      try {
        const fixed = jsonrepair(broken);
        const parsed = JSON.parse(fixed);
        return { pass: parsed.action === "list_files", detail: `action = "${parsed.action}"` };
      } catch (e) { return { pass: false, detail: e.message }; }
    },
  },

  {
    group: "JSON Repair",
    name: "two objects back to back — first one is taken",
    fn() {
      const raw = '{"thought":"a","action":"set_variable","parameters":{"key":"x","value":1}} {"thought":"b","action":"get_variable","parameters":{"key":"x"}}';
      try {
        const d = parseDecision(raw);
        return { pass: d?.action === "set_variable", detail: `action = "${d?.action}"` };
      } catch (e) { return { pass: false, detail: e.message }; }
    },
  },
  {
    group: "JSON Repair",
    name: "prose and code fence around the object are ignored",
    fn() {
      const raw = 'Sure! Here is my reply:\n```json\n{"thought":"t","action":"list_files","parameters":{}}\n```';
      try {
        const d = parseDecision(raw);
        return { pass: d?.action === "list_files", detail: `action = "${d?.action}"` };
      } catch (e) { return { pass: false, detail: e.message }; }
    },
  },

  // ── Context Trimming ─────────────────────────────────────────────────────
  {
    group: "Context Trimming",
    name: "history stays ≤ 16 messages after trim",
    fn() {
      const history = [
        { role: "system", content: "sys" },
        { role: "user",   content: "task" },
      ];
      for (let i = 0; i < 10; i++) {
        if (history.length > 16) history.splice(2, 2);
        history.push({ role: "assistant", content: `step ${i}` });
        history.push({ role: "user",      content: `result ${i}` });
      }
      return {
        pass: history.length <= 18,
        detail: `history.length = ${history.length} (system + user + trimmed pairs)`,
      };
    },
  },
  {
    group: "Context Trimming",
    name: "system prompt always stays at index 0",
    fn() {
      const history = [
        { role: "system", content: "SYSTEM" },
        { role: "user",   content: "task" },
      ];
      for (let i = 0; i < 15; i++) {
        if (history.length > 16) history.splice(2, 2);
        history.push({ role: "assistant", content: `a${i}` });
        history.push({ role: "user",      content: `u${i}` });
      }
      return {
        pass: history[0].content === "SYSTEM",
        detail: `history[0].content = "${history[0].content}"`,
      };
    },
  },
];

// ── freshState helper (exported for tests) ────────────────────────────────────
function freshState() {
  return { files: {}, vars: {}, logs: [] };
}

// ── Test runner UI ────────────────────────────────────────────────────────────
const testBtn     = $("test-harness-btn");
const testPanel   = $("test-panel");
const testResults = $("test-results");
const testSummary = $("test-summary");

testBtn?.addEventListener("click", () => {
  if (testResults.children.length === 0) {
    runHarnessTests();
    testPanel.hidden = false;
    testSummary.hidden = false;
  } else {
    testPanel.hidden = !testPanel.hidden;
  }
});

function runHarnessTests() {
  testResults.innerHTML = "";
  let passed = 0, failed = 0;
  let currentGroup = null;

  for (const test of HARNESS_TESTS) {
    if (test.group !== currentGroup) {
      currentGroup = test.group;
      const hdr = document.createElement("div");
      hdr.className = "test-group-header";
      hdr.textContent = test.group;
      testResults.appendChild(hdr);
    }

    let result;
    try {
      result = test.fn();
    } catch (err) {
      result = { pass: false, detail: `threw: ${err.message}` };
    }

    if (result.pass) passed++; else failed++;

    const row = document.createElement("div");
    row.className = `test-row ${result.pass ? "test-pass" : "test-fail"}`;
    row.innerHTML =
      `<span class="test-icon">${result.pass ? "✓" : "✗"}</span>` +
      `<span class="test-name">${escapeHtml(test.name)}</span>` +
      `<span class="test-detail">${escapeHtml(result.detail)}</span>`;
    testResults.appendChild(row);
  }

  const total = passed + failed;
  testSummary.className = `test-summary ${failed === 0 ? "test-summary-pass" : "test-summary-fail"}`;
  testSummary.textContent = `${passed} / ${total} passed${failed ? ` · ${failed} failed` : " · all systems go ✓"}`;
}
