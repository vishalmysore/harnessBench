import { MLCEngine } from "https://esm.run/@mlc-ai/web-llm";

const engine = new MLCEngine();

self.addEventListener("message", async (event) => {
  const { type, payload } = event.data;

  if (type === "init") {
    try {
      await engine.reload(payload.model, {
        initProgressCallback: (report) => {
          self.postMessage({ type: "progress", text: report.text, progress: report.progress ?? 0 });
        },
      });
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
  }

  if (type === "chat") {
    const t0 = performance.now();
    try {
      // Stream tokens for live display; collect full text for parsing
      const stream = await engine.chat.completions.create({
        messages: payload.messages,
        temperature: 0.1,
        stream: true,
        stream_options: { include_usage: true },
      });

      let content = "";
      let usage = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          content += delta;
          self.postMessage({ type: "token", delta, partial: content });
        }
        if (chunk.usage) usage = chunk.usage;
      }

      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      self.postMessage({ type: "response", content, elapsed, usage });
    } catch (err) {
      // Streaming failed — fall back to non-streaming
      try {
        self.postMessage({ type: "token", delta: "[non-stream fallback] ", partial: "" });
        const response = await engine.chat.completions.create({
          messages: payload.messages,
          temperature: 0.1,
        });
        const content = response.choices[0].message.content;
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        const usage = response.usage ?? null;
        self.postMessage({ type: "response", content, elapsed, usage });
      } catch (err2) {
        self.postMessage({ type: "error", message: err2.message });
      }
    }
  }
});
