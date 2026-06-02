# HarnessBench

**In-browser agent evaluation harness powered by WebGPU.**

Run, constrain, and judge an AI agent entirely inside a browser tab — no server, no API keys, no cloud. Model weights execute locally on your GPU via WebLLM. Nothing leaves your device.

[![Deploy to GitHub Pages](https://github.com/vishalmysore/harnessBench/actions/workflows/deploy.yml/badge.svg)](https://github.com/vishalmysore/harnessBench/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is Harness Engineering?

> Harness engineering for AI agents is the practice of designing and building the isolated software infrastructure used to safely run, test, and evaluate autonomous models. A harness acts as a controlled laboratory environment that feeds specific tasks to the agent, intercepts and executes its requested actions, and records every step of its logical trajectory like a flight data recorder. The harness acts as an objective "judge" by checking the final state of the system against specific criteria — transforming unpredictable AI behavior into measurable, reliable software engineering.

HarnessBench is a working implementation of these principles in the browser. See [`article.md`](article.md) for the full technical write-up.

---

## Live Demo

**[https://vishalmysore.github.io/harnessBench/](https://vishalmysore.github.io/harnessBench/)**

> Requires Chrome or Edge with hardware acceleration enabled (WebGPU). Firefox is not supported.

---

## Features

- **100% client-side** — WebLLM runs quantised open-source models on your GPU via WebGPU
- **Action registry** — defines the exact set of operations the agent is permitted to call
- **Hard unknown-action enforcement** — any unregistered action terminates the run immediately with a FAIL verdict
- **Deterministic judge** — validates the action log and final sandbox state, not the model's self-reported summary
- **Agent Trace panel** — shows thought → action → result for every step in real time
- **Live token stream** — watch the model generate tokens as it reasons
- **JSON repair fallback** — recovers malformed JSON from smaller models automatically
- **Context trimming** — keeps conversation history within the model's context window
- **27-test self-verification suite** — proves the harness machinery is correct without involving the model
- **GitHub Actions deploy** — pushes to GitHub Pages on every commit to `main`

---

## Supported Models

| Model | Size | Notes |
|---|---|---|
| SmolLM2-1.7B | ~1 GB | Recommended — runs on integrated GPUs |
| Llama 3.2 1B | ~0.8 GB | Fastest, lightest |
| Llama 3.2 3B | ~1.8 GB | Better instruction following |
| Phi-3.5 Mini | ~2.3 GB | Strong JSON adherence |
| Gemma 2 2B | ~1.4 GB | Balanced |
| Llama 3.1 8B | ~5 GB | Best quality — requires a discrete GPU |

---

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                   HARNESS (The Laboratory)               │
│                                                          │
│  Action Registry        Agent Execution Loop             │
│  (permitted actions)    (feeds context, parses calls)    │
│                                                          │
│  Sandbox State          Judge                            │
│  (isolated environment) (checks final state vs. task)    │
└──────────────────────────────────────────────────────────┘
                          ↑
              Model runs inside this boundary.
         It cannot reach outside it.
```

1. **Task is fed** to the agent via a structured system prompt listing all registered actions
2. **Model outputs JSON** — `{ thought, action, parameters }` — describing what it wants to do
3. **Harness intercepts** the request, looks up the action in the registry
4. **Unknown action?** → run terminates immediately with FAIL
5. **Known action?** → executes against the in-memory sandbox, result fed back to the model
6. **Every step is logged** in `sandboxState.logs` (the flight data recorder)
7. **Judge runs** when the agent calls `final_answer` — checks action coverage and sandbox state

---

## Quick Start

### Run locally

```bash
git clone https://github.com/vishalmysore/harnessBench.git
cd harnessBench
npx serve .
```

Open `http://localhost:3000` in Chrome or Edge.

### Deploy to GitHub Pages

1. Fork or push this repo to your GitHub account
2. Go to **Settings → Pages → Source → GitHub Actions**
3. Push to `main` — the workflow deploys automatically

---

## Registered Actions

| Action | Description |
|---|---|
| `create_file` | Creates a file in the sandbox with given filename and content |
| `read_file` | Reads the content of an existing file |
| `list_files` | Lists all files currently in the sandbox |
| `delete_file` | Deletes a file from the sandbox |
| `set_variable` | Stores a key-value pair |
| `get_variable` | Retrieves a stored variable |

Any action not in this table causes an immediate FAIL if the agent attempts to call it.

---

## Harness Self-Tests

Click **▶ Run Tests** in the UI (no model needed) to run 27 deterministic assertions:

```
Action Registry        10 tests — each action creates/reads/errors correctly
Sandbox Isolation       2 tests — mutations don't leak between runs
Unknown Action          3 tests — unregistered names absent, all registered callable
Judge / Evaluator       6 tests — passes when done, fails when incomplete
JSON Repair             3 tests — valid JSON, trailing comma, missing brace
Context Trimming        2 tests — history ≤ 16 entries, system prompt preserved
──────────────────────────────────────────────────────────
                   27 / 27 passed · all systems go ✓
```

---

## Project Structure

```
harnessBench/
├── index.html          # SPA shell — UI layout
├── style.css           # Dark theme styles
├── app.js              # Harness engine — registry, loop, judge, self-tests
├── worker.js           # Web Worker — WebLLM model inference
├── article.md          # Full harness engineering write-up
├── LICENSE             # MIT
└── .github/
    └── workflows/
        └── deploy.yml  # GitHub Actions → GitHub Pages
```

---

## Article

[`article.md`](article.md) covers the full theory and implementation:

- The controlled laboratory environment
- Feeding tasks and intercepting actions
- The action registry as a permission boundary
- The flight data recorder (action log)
- The objective judge — action coverage + state assertion
- Automated benchmarking and reproducible conditions
- Common pitfalls: partial completion false positives, JSON degradation, context overflow

---

## License

[MIT](LICENSE) © 2026 Vishal Mysore
