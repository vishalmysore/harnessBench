# Harness Engineering, Explained by Building One: An AI Agent Test Bench That Runs in Your Browser

*Your agent says "Done!" How do you know it's true? A practical introduction to harness engineering, with a working example you can open in a browser tab: no server, no API keys, no cloud bill.*

**Live demo:** [vishalmysore.github.io/harnessBench](https://vishalmysore.github.io/harnessBench/) · **Source code:** [github.com/vishalmysore/harnessBench](https://github.com/vishalmysore/harnessBench)

![HarnessBench: load a model, give it a task, watch every step, and get a verdict](https://raw.githubusercontent.com/vishalmysore/harnessBench/main/docs/screenshots/01-overview.png)

---

## An agent that lies, politely

I asked a small language model to do something simple: *create three files called a.txt, b.txt and c.txt, then list them.*

It created one file. Then it announced: *"File 'c.txt' has been created successfully."* It never made the other two and it never listed anything. By its own account, the task was done.

That isn't a bug in one model. It's normal behaviour for AI agents, especially small ones. They skip steps, do things out of order, call tools that don't exist, repeat themselves, and finish with a confident summary either way. If you grade an agent by its last message, you're letting it grade its own homework.

The fix is not a better prompt. It's a different kind of engineering.

---

## What is harness engineering?

**Harness engineering is the practice of building the controlled environment an AI agent runs inside.** The harness decides what the agent can see, what it is allowed to do, records everything it does, and checks the result against reality instead of the agent's own claims.

The word comes from testing. In electronics and software, a *test harness* is the rig you clamp a component into so you can feed it inputs, watch its outputs, and measure whether it behaves. Think of a car on a crash-test sled. The car is the interesting part, but the sled, the sensors and the high-speed cameras are what turn a crash into data.

For AI agents, the model is the car. The harness is everything else.

### Why it became its own discipline

Working with language models has gone through roughly three layers of concern:

- **Prompt engineering:** *what do I say to the model?* Wording, examples, instructions.
- **Context engineering:** *what information does the model see?* Retrieved documents, memory, conversation history, tool results.
- **Harness engineering:** *what world does the model act in, and how do I know what it did?* Tools, permissions, sandboxes, loops, logs and judges.

The first two make a single answer better. Once a model starts *acting* (running code, editing files, calling APIs, spending money) a good answer isn't enough. You need to contain the actions, observe them, and verify the outcome. That is the harness's job.

### The five parts of a harness

Almost every agent harness, from a research benchmark to a production coding assistant, comes down to the same five pieces:

1. **The sandbox (environment).** An isolated place where the agent's actions land. In production it might be a Docker container, a virtual machine or a staging database. The key property is that it is fresh and disposable, so every run starts from the same known state.
2. **The tool registry (permissions).** The explicit list of actions the agent may take, each with a defined input. Anything not on the list does not run. This is the agent's permission boundary.
3. **The agent loop (control).** The cycle of *model decides → harness executes → result is fed back*, with limits on steps, tokens and time so a confused agent can't run forever.
4. **The recorder (observability).** A step-by-step log of what the agent thought, what it called, with which parameters, and what came back. It works like a flight data recorder: when something goes wrong, you can replay exactly how.
5. **The judge (evaluation).** Code that inspects the *final state of the sandbox* and the *action log* and decides pass or fail. It never relies on the agent's description of what it did.

Get these five right and an unpredictable model becomes something you can measure, compare and trust a little more. Leave any one out and you're back to taking the agent's word for it.

### Why you need one even for small experiments

You don't need a harness only for big production systems. The moment you want to answer questions like *"Is model A better than model B at this task?"* or *"Did my prompt change actually help?"*, you need the same five parts: identical starting conditions, the same allowed actions, a record of what happened, and a judge that applies the same rules every time. Without them, you are comparing anecdotes.

The catch is that harnesses usually need infrastructure: servers, containers, API keys, somewhere to keep logs. That's a lot of setup just to learn the idea. So I built the smallest complete harness I could, and put it in a web page.

---

## HarnessBench: all five parts in one browser tab

HarnessBench is a single web page. It downloads an open-source language model once, runs it on your own GPU through [WebLLM](https://github.com/mlc-ai/web-llm) and WebGPU, and wraps it in a complete harness. Nothing is sent to a server, and after the first visit the model loads from the browser's cache in seconds.

Here is how each part of harness engineering maps onto the app:

| Harness part | In HarnessBench |
|---|---|
| Sandbox | A fresh in-memory "file system" and variable store, reset before every run |
| Tool registry | Six actions: `create_file`, `read_file`, `list_files`, `delete_file`, `set_variable`, `get_variable`, plus `final_answer` |
| Agent loop | One JSON decision per step (`thought`, `action`, `parameters`), a step limit, and a cap on reply length |
| Recorder | A live token stream, a step-by-step trace, and the full action log in the sandbox state |
| Judge | Plain JavaScript that checks which actions were called and what is actually in the sandbox |

![Model loaded and ready to run](https://raw.githubusercontent.com/vishalmysore/harnessBench/main/docs/screenshots/02-model-ready.png)

### A run that passes

Pick a task (or click one of the "Try" chips) and press **Run Evaluation**. Here the agent was asked: *"Create a file called note.txt with the content 'hello world', then read it back."*

![A passing run: create_file, then read_file, then final_answer, judged PASSED](https://raw.githubusercontent.com/vishalmysore/harnessBench/main/docs/screenshots/03-run-passed.png)

Everything the harness knows is on screen:

- **The verdict** at the top, with the judge's reason. Note what the reason says: `"note.txt" exists: "hello world"`. That's a fact read from the sandbox, not a quote from the model.
- **The live token stream**, showing the model's raw output as it's generated.
- **The agent trace**, one card per step: what the model was thinking, which action it chose, and what happened.
- **The sandbox state**, showing the actual files, variables and action log after the run.

A longer task shows why the recorder matters. Asked to create three files and list them, Llama 3.2 3B created `a.txt`, `b.txt` and `c.txt` in order, listed them, and finished. It also listed them a second time for no reason. The run still passes, but the trace shows you the wasted step. A single score would have hidden it.

![Multi-step trace: three create_file calls, list_files, then final_answer](https://raw.githubusercontent.com/vishalmysore/harnessBench/main/docs/screenshots/04-multi-step-trace.png)

### A run that fails, and why that's the useful part

Here is that same three-file task given to a smaller model, SmolLM2 1.7B. This is the "polite liar" from the start of the article. It created only `c.txt`, then declared the job done.

![The judge catches an incomplete run: list_files was never called and two files are missing](https://raw.githubusercontent.com/vishalmysore/harnessBench/main/docs/screenshots/06-judge-catches-incomplete.png)

The judge doesn't care what the model said. It sees that `list_files` was never called and that `a.txt` and `b.txt` don't exist, so the verdict is **FAILED**. This is the whole point of a harness: the agent's confidence has no effect on the score.

### The permission boundary in action

The tool registry isn't a suggestion. Ask the agent to *"Ring the bell using the ring_bell action, then create bell.txt"* and it will dutifully try to call `ring_bell`. That action isn't registered, so the harness stops the run at once and nothing else executes.

![Unknown action blocked: ring_bell is not a registered action](https://raw.githubusercontent.com/vishalmysore/harnessBench/main/docs/screenshots/05-unknown-action-blocked.png)

In a real system, the same rule is what keeps an agent from calling a "delete everything" endpoint just because it believes one exists. The model can *ask* for anything; only registered actions ever run.

---

## How the judge decides

The judge is ordinary code, not another AI model. That's deliberate: a judge should be predictable and give the same verdict for the same behaviour every time.

It runs two checks:

1. **Did the agent do every step?** Words in the task map to the actions they require: "create" needs `create_file`, "read" needs `read_file`, "delete" needs `delete_file`, "list" needs `list_files`, and so on. If a required action never appears in the log, the run fails, whatever the agent claimed.
2. **Is the world in the right state?** Every file named in the task must exist at the end, or must be gone if the task asked for a delete. Variable tasks must leave a stored variable.

Because every run starts from an empty sandbox and the judge is plain code, two runs with the same behaviour always get the same verdict. That reproducibility is what makes it fair to compare models side by side.

## Dealing with messy model output

A harness also has to cope with the model breaking the rules of the conversation, not just the rules of the task. Small models are bad at clean structured output. While testing, a frequent habit was writing two decisions back to back, `{...} {...}`, which isn't valid JSON. Others wrap the answer in a chatty sentence or a code fence.

HarnessBench handles this the way a production harness should:

- It takes the **first complete JSON object** in the reply (one action per step) and uses [jsonrepair](https://github.com/josdejong/jsonrepair) to fix small mistakes such as a trailing comma or a missing closing brace.
- If a reply still has no action, the harness tells the model its format was wrong and lets it try again. That retry uses up one of its steps.
- Each reply is **capped at 384 tokens**, so a runaway generation can't stall a step for minutes.
- Old steps are **trimmed from the conversation** so long runs stay inside a small model's memory window.

None of this makes the model smarter. It makes the *measurement* more reliable, so that a failed run means the agent failed and not that the plumbing did.

## A harness has to test itself, too

If the judge has a bug, every verdict is wrong. So HarnessBench includes a **Harness Verification** panel: 29 deterministic tests that run without any model. They cover every action, sandbox isolation, unknown-action blocking, judge pass and fail cases (including "only one of three files was created"), JSON repair and context trimming.

![All 29 harness self-tests passing](https://raw.githubusercontent.com/vishalmysore/harnessBench/main/docs/screenshots/07-self-tests.png)

---

## What I saw on a real laptop

Every screenshot in this article comes from real models running on WebGPU in Chrome, on a laptop with an integrated Intel Iris Xe GPU:

| Model | Example tasks passed | What it did |
|---|---|---|
| Llama 3.2 3B Instruct (q4f32) | 4 of 4 | Followed steps in order; sometimes repeated a harmless `list_files` |
| SmolLM2 1.7B Instruct (q4f16) | 1 of 4 | Often stopped after the first step, or kept retrying a failing action |

On this hardware the 3B model produces about 3 tokens per second. One step takes roughly 8 to 20 seconds, and a full task takes one to two minutes. The first visit downloads about 1.8 GB; after that it loads from cache in seconds.

The interesting result isn't the scores. It's that the harness made the difference between the two models *visible and explainable*. You can see exactly where the smaller model gave up.

## Why this is useful

- **Learn harness engineering by touching it.** All five parts are on one screen and in a few hundred lines of plain JavaScript, so you can see how they connect.
- **Compare models honestly.** Swap the model, run the same tasks, and get verdicts based on what happened in the sandbox.
- **See how agents fail, not just that they fail.** Early stopping, wrong order, invented tools and loops all show up in the trace.
- **Private by default.** Prompts and results never leave your machine.
- **Zero setup.** Share a link. Anyone with Chrome or Edge and a WebGPU-capable GPU can watch an agent run and get graded.

## Limitations

To be clear about what this is:

- **The tasks are toy tasks.** Six in-memory tools are enough to show the ideas, not to benchmark real-world agents.
- **The judge is keyword-based.** It works for the included kinds of tasks. A task worded very differently might not map to the right required actions.
- **Results vary.** Small models behave differently across hardware and library versions. Treat the table above as one observation, not a leaderboard.
- **WebGPU is required.** It works in recent Chrome and Edge with hardware acceleration enabled. Bigger models need more GPU memory than many laptops have. If a model starts producing garbled text, clearing the site's data (which resets the cached model) usually fixes it.

## The takeaway

Prompting makes an agent *say* better things. A harness tells you what it actually *did*. Before you trust any agent with real work, it's worth asking five questions: Where do its actions land? What is it allowed to do? Who stops it when it loops? Where is the record? And who checks the result, other than the agent itself?

Open the [live demo](https://vishalmysore.github.io/harnessBench/), load **Llama 3.2 3B**, click a "Try" chip and press **Run Evaluation**. Then try to break it: ask for a tool that doesn't exist, or give a small model a five-step task, and watch the harness catch it.

---

### Credits

HarnessBench builds on open-source work:

- [WebLLM](https://github.com/mlc-ai/web-llm) and [MLC LLM](https://github.com/mlc-ai/mlc-llm) by the MLC team, for in-browser LLM inference on WebGPU and the prebuilt quantized models.
- [Llama 3.2](https://www.llama.com/) by Meta and [SmolLM2](https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct) by Hugging Face, plus the other model families offered in the app (Phi-3.5, Gemma 2).
- [jsonrepair](https://github.com/josdejong/jsonrepair) by Jos de Jong, for recovering malformed JSON.
- The [WebGPU](https://www.w3.org/TR/webgpu/) standard and its browser implementations.

### Disclaimer

HarnessBench is an educational demo, not a production evaluation tool. Its verdicts come from simple rule-based checks on toy tasks and should not be used to make claims about any model's real-world capability or safety. Model weights are downloaded from their publishers and are covered by their own licenses. This is a personal project and is not affiliated with or endorsed by any of the projects or companies named above.
