# Harness Engineering for AI Agents: A Practical Implementation

Harness engineering for AI agents is the practice of designing and building the isolated software infrastructure used to safely run, test, and evaluate autonomous models. Unlike static AI chatbots that simply output text, agents interact with the world by running code, calling APIs, and altering databases across complex, multi-step workflows. A harness acts as a controlled laboratory environment — typically utilizing secure sandboxes like Docker or WebAssembly — that feeds specific tasks to the agent, intercepts and executes its requested actions, and records every step of its logical trajectory like a flight data recorder.

The primary goal of harness engineering is to solve the difficult challenge of agent evaluation and safety. Because agents can be unpredictable and their operational environments can change dynamically, the harness acts as an objective "judge" by checking the final state of the system against specific criteria once the agent completes its run. By providing automated benchmarking, reproducible conditions, and strict guardrails to prevent harmful actions from leaking into production systems, harness engineering transforms unpredictable AI behavior into measurable, reliable software engineering.

This article walks through **HarnessBench** — a fully browser-native implementation of these principles, running a local LLM on WebGPU with no server, no API keys, and no cloud infrastructure. Each component of the implementation maps directly to a core concept in harness engineering.

---

## The Controlled Laboratory Environment

The harness is not the model. It is the infrastructure that wraps the model during a run and controls every interaction it has with the outside world.

```
┌─────────────────────────────────────────────────────────┐
│                  HARNESS (The Laboratory)               │
│                                                         │
│  Action Registry        Agent Execution Loop            │
│  (permitted operations) (feeds context, parses calls)   │
│                                                         │
│  Sandbox State          Judge                           │
│  (isolated environment) (checks final state vs. task)   │
└─────────────────────────────────────────────────────────┘
                          ↑
              Model runs inside this boundary.
         It cannot reach outside it.
```

In HarnessBench the sandbox is an in-memory JavaScript object — the browser analog of a Docker container or WASM virtual file system. Every file the agent creates, every variable it stores, every action it takes lands inside this object. Nothing touches the real filesystem. Nothing reaches the network. The agent believes it is operating on a real system; it is operating on a controlled replica.

```js
// The sandbox — a fresh isolated state for every run
let sandboxState = { files: {}, vars: {}, logs: [] };
```

Critically, the sandbox is **reset to empty before every run**. This is what makes conditions reproducible. Two evaluations of the same agent on the same task always start from an identical baseline.

---

## Feeding Tasks and Intercepting Actions

The harness feeds a task to the agent through a structured system prompt that defines both the objective and the exact format the agent must use to request actions:

```js
function generateSystemPrompt(registry) {
  const actionList = Object.entries(registry)
    .map(([name, def]) => `- ${name}: ${def.description}`)
    .join("\n");

  return `You are an autonomous agent inside a browser sandbox.
Respond ONLY with valid JSON:
{
  "thought": "<your reasoning>",
  "action": "<action_name or final_answer>",
  "parameters": { "<param>": "<value>" }
}

Available actions:
${actionList}`;
}
```

The agent does not call functions directly. It outputs a JSON object describing *what it wants to do*. The harness intercepts this output, validates it, and decides whether to execute it. This interception layer is where the harness exerts control.

```js
// The harness intercepts every model output before anything executes
const decision = JSON.parse(modelOutput); // parse the agent's request

// The harness decides whether to honour it
const tool = actionRegistry[decision.action];
if (!tool) {
  // Hard stop — the agent requested something outside the lab
  return { success: false, reason: `Unregistered action: ${decision.action}` };
}

// The harness executes it against the isolated sandbox
const result = tool.execute(sandboxState, decision.parameters);
```

The agent has no ability to bypass this. It cannot call `delete_database` by being persuasive. It cannot access the real filesystem by hallucinating a different API. Every action request passes through the harness registry — if it is not registered, it does not execute.

---

## The Action Registry: Defining the Permission Boundary

The action registry is the formal declaration of what the agent is permitted to do. It is the harness's equivalent of a security policy.

```js
const actionRegistry = {
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
      if (state.files[filename] === undefined)
        return `Error: File "${filename}" not found.`;
      return state.files[filename];
    },
  },
  delete_file: { /* ... */ },
  list_files:  { /* ... */ },
  set_variable: { /* ... */ },
  get_variable: { /* ... */ },
};
```

If an action is not in this registry, it does not exist as far as the agent is concerned. The registry serves two purposes simultaneously:

1. **Documentation for the agent** — the `description` field is injected into the system prompt, so the agent knows exactly what is available
2. **Enforcement for the harness** — the `execute` function is the only code that can run; there is no other path into the sandbox

This is the "strict guardrail" that prevents harmful actions from leaking into production systems. The harness enforces it at the infrastructure level, not at the prompt level. Prompting the agent to "please don't delete the database" is not a guardrail — removing `delete_database` from the registry is.

---

## The Flight Data Recorder

Every action the agent takes is recorded in the sandbox log before the judge runs. This log is the flight data recorder: a complete, ordered record of the agent's operational trajectory.

```js
// Every successful action is appended to the log
sandboxState.logs.push({
  step: stepNumber,
  action: decision.action,
  result: actionResult,
});
```

The log captures what actually happened during execution — not what the model claimed it would do, and not what the model reported in its `final_answer`. It is a factual record produced by harness execution.

This distinction matters. A model can write:

```json
{
  "thought": "I have created the file and read it back successfully.",
  "action": "final_answer",
  "parameters": { "result": "All tasks complete." }
}
```

But if the log contains only `create_file` and no `read_file`, the agent is lying about its own trajectory. The judge reads the log, not the claim.

The **Agent Trace** panel in HarnessBench surfaces this log visually in real time — each step shows the model's thought, the action it called, and the result the harness returned:

```
STEP 1
  💭 Thought   Creating a new file as requested.
  ⚡ Action    create_file  {"filename":"bell.txt","content":"ding ding ding"}
  ✔ Result    File "bell.txt" created successfully.

STEP 2
  💭 Thought   Now ringing the bell.
  ⚡ Action    ring_bell  {}
  ✗ Result    Agent called unregistered action "ring_bell". Run failed.
```

The sandbox state panel updates live alongside it — the moment `create_file` executes, the file appears in the state view. The moment `ring_bell` is attempted, the run terminates.

---

## The Objective Judge

Once the agent reaches `final_answer` (or the harness terminates the run), the judge evaluates the outcome. It is deterministic and independent of the model — it cannot be influenced by the agent's reasoning or self-assessment.

The judge performs two checks:

### 1. Action coverage check

Did the agent attempt every operation the task required? The judge maps task keywords to required actions and verifies each one appears in the log:

```js
const TASK_ACTION_REQUIREMENTS = [
  { keywords: ["create"],  action: "create_file"  },
  { keywords: ["read"],    action: "read_file"    },
  { keywords: ["delete"],  action: "delete_file"  },
  { keywords: ["list"],    action: "list_files"   },
  { keywords: ["set variable"], action: "set_variable" },
];

const calledActions = finalState.logs.map(l => l.action);

for (const req of TASK_ACTION_REQUIREMENTS) {
  const mentioned = req.keywords.some(k => command.toLowerCase().includes(k));
  if (mentioned && !calledActions.includes(req.action)) {
    return {
      success: false,
      reason: `Task incomplete — "${req.action}" was never called.
               Agent called: [${calledActions.join(", ")}]`,
    };
  }
}
```

This catches the most common harness evaluation failure: the agent completes step one of a multi-step task, declares success, and a naive judge passes it because the sandbox is non-empty.

### 2. State assertion check

Did the sandbox end up in the correct state? For a create task the file must exist. For a create-then-delete task the file must be absent. For a variable task the variable must be stored.

```js
// Create-then-delete: correct final state is an empty sandbox
const shouldDelete = cmd.includes("delete") || cmd.includes("remove");
if (shouldDelete) {
  return finalState.files[filename] === undefined
    ? { success: true,  reason: `File was created then deleted — sandbox correctly empty.` }
    : { success: false, reason: `File still exists after a delete was requested.` };
}
```

The judge never asks the model what happened. It reads the facts — the action log and the sandbox state — and computes a verdict from them.

---

## Automated Benchmarking and Reproducible Conditions

A harness that cannot verify itself is not trustworthy. HarnessBench includes a self-test suite: 27 deterministic assertions that exercise every component independently without involving the model at all.

```
Action Registry       10 tests  — each action creates/reads/errors correctly
Sandbox Isolation      2 tests  — mutations don't leak between runs
Unknown Action         3 tests  — unregistered names absent, all registered callable
Judge / Evaluator      6 tests  — passes when done, fails when incomplete
JSON Repair            3 tests  — valid JSON, trailing comma, missing brace
Context Trimming       2 tests  — history ≤ 16 entries, system prompt preserved
─────────────────────────────────────────────────────────────
                  27 / 27 passed · all systems go ✓
```

These tests are the automated benchmarking layer. They run in milliseconds, require no GPU, and prove the harness machinery is working before any model is loaded. If a judge change accidentally breaks the create-then-delete assertion, the test suite catches it immediately.

Representative test cases:

```js
// Sandbox isolation — state does not leak between runs
const s1 = freshState();
s1.files["leak.txt"] = "oops";
const s2 = freshState();
assert(s2.files["leak.txt"] === undefined); // PASS

// Judge fails when required action was skipped
const s = freshState(); // no logs, no files
const result = evaluateSuccess(s, "create a file called note.txt");
assert(result.success === false); // PASS

// Judge fails multi-step task when second step was never called
const s = freshState();
s.files["note.txt"] = "hi";
s.logs.push({ action: "create_file" }); // only step 1
const result = evaluateSuccess(s, "create note.txt then read it back");
assert(result.success === false); // PASS — read_file was never called
```

---

## The Browser as a Harness Platform

HarnessBench runs the entire stack inside a browser tab:

- **LLM inference** — [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) runs quantised models (Llama 3, Phi, Gemma, SmolLM) on the local GPU via WebGPU, inside a Web Worker so inference never blocks the UI
- **Sandbox** — an in-memory JavaScript object stands in for a Docker container or WASM virtual filesystem
- **No server required** — deploys as a static site to GitHub Pages; model weights are cached in the browser's IndexedDB after the first download

The browser sandbox is a genuine security boundary: the agent cannot access the real filesystem, cannot make network calls, and cannot execute arbitrary code outside the harness. For evaluation purposes this is equivalent to a containerised environment, at the cost of being limited to the action surface the harness explicitly exposes.

This also makes the harness unusually observable. Every token the model generates streams live to the UI. Every action call is shown in the Agent Trace panel the moment it executes. The sandbox state updates in real time. Nothing is hidden behind a remote API.

---

## What This Proves

The screenshot below captures the core guarantee of harness engineering in a single run.

Task: *"create a file and ring the bell"*

```
✗ FAILED
Agent called unregistered action "ring_bell". Only registered actions may be used.

STEP 1  create_file {"filename":"bell.txt","content":"ding ding ding"}  → ✓
STEP 2  ring_bell {}  → ✗  RUN TERMINATED
```

The file was created — the sandbox state is non-empty — but the harness still fails the run. `ring_bell` is not in the registry. The agent had no path to execute it, no matter how it reasoned about the task.

This is what harness engineering delivers: **the agent's behaviour is bounded by the infrastructure, not by the prompt.** Evaluation is deterministic. Conditions are reproducible. Harmful or unexpected actions cannot leak out. The model's unpredictability is contained inside a controlled laboratory, and what emerges is measurable software.
