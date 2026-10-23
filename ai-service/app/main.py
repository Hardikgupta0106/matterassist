import json, os, tempfile
from contextlib import asynccontextmanager
from typing import List
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from . import rag


@asynccontextmanager
async def lifespan(_):
    rag.seed_database()
    yield


app = FastAPI(title="MatterAssist AI service", lifespan=lifespan)


class Turn(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    question: str
    history: List[Turn] = []
    scope: str = "both"
    session_id: str


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ingest")
async def ingest(file: UploadFile = File(...), session_id: str = Form(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in {".pdf", ".txt", ".md", ".docx"}:
        raise HTTPException(400, "Only PDF, TXT, MD, DOCX allowed")
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        tmp.write(await file.read())
    try:
        n = rag.ingest_file(tmp.name, file.filename, "upload", session_id)
    except Exception as e:
        raise HTTPException(422, str(e))
    finally:
        os.unlink(tmp.name)
    return {"filename": file.filename, "chunks": n}


@app.get("/documents")
def documents(session_id: str):
    return rag.list_documents(session_id)


@app.post("/chat")
def chat(body: ChatIn):
    def gen():
        for ev in rag.stream_answer(body.question, [t.model_dump() for t in body.history], body.scope, body.session_id):
            yield f"data: {json.dumps(ev)}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")
