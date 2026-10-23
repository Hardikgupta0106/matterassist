"""RAG core: ingest -> chunk -> embed -> Chroma -> scoped retrieval -> Gemini (streamed)."""
import glob, os
from langchain_chroma import Chroma
from langchain_community.document_loaders import Docx2txtLoader, PyPDFLoader, TextLoader
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

embeddings = GoogleGenerativeAIEmbeddings(model=os.getenv("EMBED_MODEL", "models/gemini-embedding-001"))
llm = ChatGoogleGenerativeAI(model=os.getenv("LLM_MODEL", "gemini-2.5-flash"), temperature=0.2)
store = Chroma(
    collection_name="matterassist",
    embedding_function=embeddings,
    persist_directory=os.getenv("CHROMA_DIR", "./chroma_data"),
)
splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=100)

SYSTEM = (
    "You are MatterAssist, a document assistant. Answer ONLY using the provided context. "
    "If the answer is not in the context, say you could not find it in the documents. "
    "Cite sources inline like [filename p.N]. Be concise and well structured (markdown ok)."
)


def ingest_file(path: str, filename: str, source: str, session_id: str = "") -> int:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        loader = PyPDFLoader(path)
    elif ext == ".docx":
        loader = Docx2txtLoader(path)
    else:  # .txt / .md
        loader = TextLoader(path, encoding="utf-8")
    chunks = splitter.split_documents(loader.load())
    if not chunks:
        raise ValueError("No text found in file (scanned PDF?)")
    for c in chunks:
        c.metadata = {
            "source": source,  # "db" | "upload"
            "session_id": session_id,
            "filename": filename,
            "page": int(c.metadata.get("page", 0)) + 1,
        }
    store.add_documents(chunks)
    return len(chunks)


def seed_database(folder: str = "sample_docs") -> None:
    """Pre-load sample docs once; Chroma persists them on disk."""
    if store.get(where={"source": "db"}, limit=1)["ids"]:
        return
    for p in sorted(glob.glob(f"{folder}/*")):
        ingest_file(p, os.path.basename(p), "db")


def list_documents(session_id: str) -> dict:
    out = {"db": set(), "upload": set()}
    for m in store.get(include=["metadatas"])["metadatas"]:
        if m["source"] == "db":
            out["db"].add(m["filename"])
        elif m["session_id"] == session_id:
            out["upload"].add(m["filename"])
    return {k: sorted(v) for k, v in out.items()}


def build_filter(scope: str, session_id: str):
    mine = {"$and": [{"source": "upload"}, {"session_id": session_id}]}
    if scope == "db":
        return {"source": "db"}
    if scope == "upload":
        return mine
    return {"$or": [{"source": "db"}, mine]}


def _text(chunk) -> str:
    c = chunk.content
    if isinstance(c, str):
        return c
    return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)


def _standalone(question: str, history: list) -> str:
    """Rewrite follow-ups ('what about its cost?') into a self-contained search query."""
    if not history:
        return question
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in history)
    msg = f"Chat so far:\n{convo}\n\nRewrite the last question as a standalone search query. Output only the query.\nQuestion: {question}"
    return _text(llm.invoke([HumanMessage(msg)])).strip() or question


def stream_answer(question: str, history: list, scope: str, session_id: str):
    try:
        query = _standalone(question, history)
        docs = store.similarity_search(query, k=5, filter=build_filter(scope, session_id))
        sources = [{"filename": d.metadata["filename"], "page": d.metadata["page"], "source": d.metadata["source"]} for d in docs]
        yield {"type": "sources", "sources": [dict(t) for t in {tuple(s.items()) for s in sources}]}
        if not docs:
            yield {"type": "token", "text": "Selected scope me koi document nahi mila. Upload karo ya scope badlo."}
            return
        context = "\n\n".join(f"[{d.metadata['filename']} p.{d.metadata['page']}]\n{d.page_content}" for d in docs)
        messages = [SystemMessage(SYSTEM)]
        for m in history:
            messages.append(HumanMessage(m["content"]) if m["role"] == "user" else SystemMessage("Earlier assistant reply: " + m["content"]))
        messages.append(HumanMessage(f"Context:\n{context}\n\nQuestion: {question}"))
        for chunk in llm.stream(messages):
            t = _text(chunk)
            if t:
                yield {"type": "token", "text": t}
    except Exception as e:  # surface errors to the UI instead of dying silently
        yield {"type": "error", "text": str(e)[:300]}
