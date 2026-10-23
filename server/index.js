import express from "express";
import cors from "cors";
import multer from "multer";
import mongoose from "mongoose";

const AI = process.env.AI_URL || "http://localhost:8000";
const app = express();
app.use(cors(), express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

mongoose.connect(process.env.MONGO_URL || "mongodb://localhost:27017/matterassist").then(() => console.log("mongo ok"));
const Message = mongoose.model(
  "Message",
  new mongoose.Schema({ sessionId: String, role: String, content: String, sources: Array }, { timestamps: true })
);

app.get("/api/health", (_, res) => res.json({ ok: true }));

// Phase: upload -> forward file to Python service for parse/chunk/embed
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const fd = new FormData();
    fd.append("file", new Blob([req.file.buffer]), req.file.originalname);
    fd.append("session_id", req.body.sessionId);
    const r = await fetch(`${AI}/ingest`, { method: "POST", body: fd });
    const j = await r.json();
    res.status(r.status).json(r.ok ? j : { error: j.detail || "Ingest failed" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/documents", async (req, res) => {
  try {
    const r = await fetch(`${AI}/documents?session_id=${encodeURIComponent(req.query.sessionId)}`);
    res.json(await r.json());
  } catch {
    res.status(502).json({ db: [], upload: [] });
  }
});

app.get("/api/history/:sid", async (req, res) => {
  const msgs = await Message.find({ sessionId: req.params.sid }).sort({ createdAt: 1 }).select("role content sources -_id");
  res.json(msgs);
});

// Phase: chat -> add last 6 turns of history, stream tokens back as SSE, persist final answer
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, scope = "both" } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: "sessionId and message required" });
  const hist = (await Message.find({ sessionId }).sort({ createdAt: -1 }).limit(6)).reverse().map((m) => ({ role: m.role, content: m.content }));
  await Message.create({ sessionId, role: "user", content: message });

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  let buf = "", answer = "", sources = [];
  try {
    const r = await fetch(`${AI}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: message, history: hist, scope, session_id: sessionId }),
    });
    for await (const chunk of r.body) {
      res.write(chunk);
      buf += Buffer.from(chunk).toString();
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        if (!p.startsWith("data: ")) continue;
        const e = JSON.parse(p.slice(6));
        if (e.type === "token") answer += e.text;
        if (e.type === "sources") sources = e.sources;
      }
    }
    if (answer) await Message.create({ sessionId, role: "assistant", content: answer, sources });
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: "error", text: e.message })}\n\n`);
  }
  res.end();
});

app.listen(5000, () => console.log("server on :5000"));
