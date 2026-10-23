import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

/* ---------- session id (stored in browser) ---------- */
const sid = (() => {
  let s = localStorage.getItem("sid");
  if (!s) {
    s =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2);
    localStorage.setItem("sid", s);
  }
  return s;
})();

const SCOPES = [
  ["both", "Both"],
  ["db", "Database"],
  ["upload", "My uploads"],
];

const SUGGESTIONS = [
  "How many paid leaves do I get?",
  "What is the notice period policy?",
  "Summarize the uploaded document",
];

/* ---------- small helpers ---------- */
const labelOf = (d) => {
  if (typeof d === "string") return d;
  if (!d || typeof d !== "object") return String(d);
  return (
    d.name || d.filename || d.title || d.originalName || d.source || d.id || "Document"
  );
};

const sourceLabel = (s) => {
  if (typeof s === "string") return s;
  if (!s || typeof s !== "object") return String(s);
  const base = labelOf(s);
  return s.page !== undefined && s.page !== null ? `${base} (p.${s.page})` : base;
};

export default function App() {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [scope, setScope] = useState("both");
  const [docs, setDocs] = useState({ db: [], upload: [] });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const end = useRef(null);
  const fileRef = useRef(null);

  /* ---------- load documents ---------- */
  const loadDocs = async () => {
    try {
      const r = await fetch(`/api/documents?sessionId=${sid}`);
      if (!r.ok) throw new Error(`documents ${r.status}`);
      const d = await r.json();
      setDocs({
        db: Array.isArray(d?.db) ? d.db : [],
        upload: Array.isArray(d?.upload) ? d.upload : [],
      });
    } catch (err) {
      console.error(err);
    }
  };

  /* ---------- initial load: docs + history ---------- */
  useEffect(() => {
    loadDocs();
    (async () => {
      try {
        const r = await fetch(`/api/history/${sid}`);
        if (!r.ok) throw new Error(`history ${r.status}`);
        const h = await r.json();
        setMsgs(Array.isArray(h) ? h : []);
      } catch (err) {
        console.error(err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- auto scroll ---------- */
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  /* ---------- upload ---------- */
  async function onUpload(e) {
    const inputEl = e.target;
    const f = inputEl.files && inputEl.files[0];
    if (!f) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("sessionId", sid);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) alert(j.error || "Upload failed");
      await loadDocs();
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      setUploading(false);
      inputEl.value = "";
    }
  }

  /* ---------- send message (streaming) ---------- */
  async function send(text) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    setMsgs((m) => [
      ...m,
      { role: "user", content: q },
      { role: "assistant", content: "", sources: [] },
    ]);

    // update the last (assistant) message
    const patch = (fn) =>
      setMsgs((m) => {
        if (!m.length) return m;
        const c = [...m];
        c[c.length - 1] = fn(c[c.length - 1]);
        return c;
      });

    const handleEvent = (e) => {
      if (e.type === "token") {
        patch((x) => ({ ...x, content: x.content + (e.text ?? "") }));
      } else if (e.type === "sources") {
        patch((x) => ({ ...x, sources: e.sources || [] }));
      } else if (e.type === "error") {
        patch((x) => ({
          ...x,
          content: x.content || "Something went wrong: " + (e.message || e.error || "unknown error"),
        }));
      }
    };

    const handlePart = (p) => {
      if (!p.startsWith("data: ")) return;
      let e;
      try {
        e = JSON.parse(p.slice(6));
      } catch {
        return;
      }
      handleEvent(e);
    };

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, message: q, scope }),
      });
      if (!r.ok || !r.body) throw new Error(`Chat failed (${r.status})`);

      const rd = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const p of parts) handlePart(p);
      }
      if (buf) handlePart(buf);
    } catch (err) {
      console.error(err);
      patch((x) => ({
        ...x,
        content: x.content || "Could not get an answer. Check that the server is running and try again.",
      }));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const total = docs.db.length + docs.upload.length;

  return (
    <div className="ma-root">
      <style>{CSS}</style>

      {/* ---------- sidebar ---------- */}
      <aside className="ma-side">
        <div className="ma-brand">
          <div className="ma-logo">M</div>
          <div>
            <div className="ma-title">MatterAssist</div>
            <div className="ma-sub">Answers from your documents</div>
          </div>
        </div>

        <section className="ma-block">
          <div className="ma-h">Search in</div>
          <div className="ma-seg" role="radiogroup" aria-label="Search scope">
            {SCOPES.map(([v, l]) => (
              <button
                key={v}
                role="radio"
                aria-checked={scope === v}
                className={scope === v ? "on" : ""}
                onClick={() => setScope(v)}
              >
                {l}
              </button>
            ))}
          </div>
        </section>

        <section className="ma-block">
          <div className="ma-h">Add a document</div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,.docx"
            onChange={onUpload}
            hidden
          />
          <button
            className="ma-upload"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "Uploading and indexing..." : "Upload PDF, TXT, DOCX or MD"}
          </button>
        </section>

        <section className="ma-block ma-docs">
          <div className="ma-h">Documents ({total})</div>

          <div className="ma-group">Database</div>
          {docs.db.length === 0 && <div className="ma-empty">No database documents.</div>}
          {docs.db.map((d, i) => (
            <div className="ma-doc" key={"db" + i} title={labelOf(d)}>
              {labelOf(d)}
            </div>
          ))}

          <div className="ma-group">My uploads</div>
          {docs.upload.length === 0 && (
            <div className="ma-empty">Nothing uploaded yet.</div>
          )}
          {docs.upload.map((d, i) => (
            <div className="ma-doc up" key={"up" + i} title={labelOf(d)}>
              {labelOf(d)}
            </div>
          ))}
        </section>
      </aside>

      {/* ---------- chat ---------- */}
      <main className="ma-main">
        <div className="ma-feed">
          {msgs.length === 0 && (
            <div className="ma-hero">
              <h1>Ask anything about your documents</h1>
              <p>
                Answers are grounded in the documents you select, and every answer shows
                where it came from.
              </p>
              <div className="ma-chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className={"ma-msg " + (m.role === "user" ? "user" : "bot")}>
              <div className="ma-bubble">
                {m.role === "user" ? (
                  m.content
                ) : m.content ? (
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                ) : (
                  <span className="ma-typing">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
              {m.role !== "user" && Array.isArray(m.sources) && m.sources.length > 0 && (
                <div className="ma-sources">
                  <span>Sources</span>
                  {m.sources.map((s, k) => (
                    <em key={k}>{sourceLabel(s)}</em>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={end} />
        </div>

        <div className="ma-composer">
          <textarea
            rows={1}
            value={input}
            placeholder="Type your question and press Enter"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button onClick={() => send()} disabled={busy || !input.trim()}>
            {busy ? "Thinking..." : "Send"}
          </button>
        </div>
      </main>
    </div>
  );
}

/* ---------- styles (self-contained, no other CSS needed) ---------- */
const CSS = `
:root{
  --bg:#eef1f5; --panel:#ffffff; --ink:#16202e; --muted:#64708a;
  --line:#dde3ec; --accent:#0f766e; --accent-d:#0b5c56; --accent-l:#e0f2f0;
  --user:#16202e;
}
*{box-sizing:border-box}
html,body,#root{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font-family:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif}
.ma-root{height:100%;display:grid;grid-template-columns:310px 1fr}
.ma-side{background:var(--panel);border-right:1px solid var(--line);padding:20px 18px;display:flex;flex-direction:column;gap:18px;overflow-y:auto}
.ma-brand{display:flex;gap:12px;align-items:center}
.ma-logo{width:40px;height:40px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:20px}
.ma-title{font-weight:700;font-size:17px}
.ma-sub{color:var(--muted);font-size:12.5px}
.ma-h{font-weight:600;font-size:13px;margin-bottom:8px}
.ma-seg{display:grid;grid-template-columns:repeat(3,1fr);background:var(--bg);border-radius:10px;padding:3px;gap:3px}
.ma-seg button{border:0;background:transparent;padding:8px 4px;border-radius:8px;font-size:13px;color:var(--muted);cursor:pointer}
.ma-seg button.on{background:var(--panel);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.ma-upload{width:100%;padding:11px;border-radius:10px;border:1.5px dashed var(--accent);background:var(--accent-l);color:var(--accent-d);font-weight:600;cursor:pointer;font-size:13px}
.ma-upload:disabled{opacity:.6;cursor:wait}
.ma-docs{min-height:0}
.ma-group{font-size:12px;color:var(--muted);margin:10px 0 4px}
.ma-doc{font-size:13px;padding:7px 10px;border-radius:8px;background:var(--bg);margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:3px solid var(--line)}
.ma-doc.up{border-left-color:var(--accent)}
.ma-empty{font-size:12.5px;color:var(--muted);padding:2px 2px 6px}
.ma-main{display:flex;flex-direction:column;min-width:0;height:100%}
.ma-feed{flex:1;overflow-y:auto;padding:28px clamp(16px,6vw,80px);display:flex;flex-direction:column;gap:16px}
.ma-hero{margin:auto;max-width:560px;text-align:center}
.ma-hero h1{font-size:28px;margin:0 0 10px;line-height:1.25}
.ma-hero p{color:var(--muted);margin:0 0 20px;line-height:1.5}
.ma-chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.ma-chips button{border:1px solid var(--line);background:var(--panel);padding:9px 14px;border-radius:999px;font-size:13.5px;cursor:pointer;color:var(--ink)}
.ma-chips button:hover:not(:disabled){border-color:var(--accent);color:var(--accent-d)}
.ma-msg{display:flex;flex-direction:column;max-width:min(760px,100%)}
.ma-msg.user{align-self:flex-end;align-items:flex-end}
.ma-msg.bot{align-self:flex-start}
.ma-bubble{padding:12px 16px;border-radius:14px;line-height:1.6;font-size:15px;overflow-wrap:anywhere}
.user .ma-bubble{background:var(--user);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}
.bot .ma-bubble{background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}
.bot .ma-bubble p{margin:0 0 10px}
.bot .ma-bubble p:last-child{margin:0}
.bot .ma-bubble ul,.bot .ma-bubble ol{margin:6px 0 10px;padding-left:22px}
.bot .ma-bubble code{background:var(--bg);padding:1px 5px;border-radius:5px;font-size:13.5px}
.bot .ma-bubble pre{background:var(--bg);padding:12px;border-radius:8px;overflow-x:auto}
.ma-sources{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:7px;font-size:12px;color:var(--muted)}
.ma-sources em{font-style:normal;background:var(--accent-l);color:var(--accent-d);padding:3px 9px;border-radius:999px}
.ma-typing{display:inline-flex;gap:4px;align-items:center;height:20px}
.ma-typing i{width:7px;height:7px;border-radius:50%;background:var(--muted);animation:b 1s infinite ease-in-out}
.ma-typing i:nth-child(2){animation-delay:.15s}
.ma-typing i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,80%,100%{opacity:.25}40%{opacity:1}}
.ma-composer{display:flex;gap:10px;padding:14px clamp(16px,6vw,80px) 20px;background:var(--bg)}
.ma-composer textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:13px 15px;font:inherit;font-size:15px;max-height:140px;color:var(--ink)}
.ma-composer textarea:focus,.ma-upload:focus-visible,.ma-seg button:focus-visible,.ma-chips button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.ma-composer button{border:0;background:var(--accent);color:#fff;font-weight:600;padding:0 22px;border-radius:12px;cursor:pointer;font-size:14.5px}
.ma-composer button:hover:not(:disabled){background:var(--accent-d)}
.ma-composer button:disabled{opacity:.5;cursor:not-allowed}
@media (max-width:820px){
  .ma-root{grid-template-columns:1fr;grid-template-rows:auto 1fr}
  .ma-side{max-height:42vh;border-right:0;border-bottom:1px solid var(--line)}
}
@media (prefers-reduced-motion:reduce){.ma-typing i{animation:none}}
`;