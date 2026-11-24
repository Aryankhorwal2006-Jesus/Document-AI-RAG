import os
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path                                # NEW

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles             # NEW
from pydantic import BaseModel, Field

from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain_core.prompts import ChatPromptTemplate
from langchain_groq import ChatGroq
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()

PERSIST_DIR = "ChromaDB"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
LLM_MODEL = "openai/gpt-oss-20b"
MAX_UPLOAD_MB = 200
BATCH = 200            # chunks embedded per step (keeps Chroma under its max batch size)
STATIC_DIR = Path(__file__).parent / "static"           # NEW: folder that holds index.html
executor = ThreadPoolExecutor(max_workers=1)   # one PDF is indexed at a time
jobs: dict[str, dict] = {}                     # upload progress, read by GET /upload/{id}
splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)

PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            """You are a helpful AI assistant.

Use ONLY the provided context to answer the question.

If the answer is not present in the context,
say: "I could not find the answer in the document."
""",
        ),
        (
            "human",
            """Context:
{context}

Question:
{question}
""",
        ),
    ]
)

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    embedding = HuggingFaceEmbeddings(model_name=EMBEDDING_MODEL, encode_kwargs={"batch_size": 64})
    vectorstore = Chroma(
        persist_directory=PERSIST_DIR,
        embedding_function=embedding,
    )
    state["vectorstore"] = vectorstore
    state["retriever"] = vectorstore.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 4, "fetch_k": 10, "lambda_mult": 0.5},
    )
    state["llm"] = ChatGroq(model=LLM_MODEL)
    print("RAG system ready")
    yield
    state.clear()


app = FastAPI(
    title="Document RAG API",
    description="Ask questions about your PDF using Chroma + Groq.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, examples=["What is a neural network?"])


class Source(BaseModel):
    page: int | None = None
    source: str | None = None
    snippet: str


class AskResponse(BaseModel):
    answer: str
    sources: list[Source]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest):
    try:
        docs = await state["retriever"].ainvoke(req.question)
        context = "\n\n".join(d.page_content for d in docs)

        final_prompt = PROMPT.invoke({"context": context, "question": req.question})
        response = await state["llm"].ainvoke(final_prompt)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    sources = [
        Source(
            page=d.metadata.get("page"),
            source=d.metadata.get("source"),
            snippet=d.page_content[:200],
        )
        for d in docs
    ]
    return AskResponse(answer=response.content, sources=sources)


# ---------------- upload endpoint (background indexing) ----------------
def ingest(job_id: str, path: str, name: str):
    job = jobs[job_id]
    try:
        job["stage"] = "reading"
        pages = PyPDFLoader(path).load()
        for p in pages:
            p.metadata["source"] = name   # Sources mein asli filename dikhega
        chunks = splitter.split_documents(pages)
        if not chunks:
            raise ValueError("No readable text found. The PDF may be a scan.")
        job.update(pages=len(pages), total=len(chunks), stage="indexing")
        for i in range(0, len(chunks), BATCH):
            state["vectorstore"].add_documents(chunks[i : i + BATCH])
            job["done"] = min(i + BATCH, len(chunks))
        job.update(status="ready", stage="done")
    except Exception as e:
        job.update(status="error", error=str(e))
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


@app.post("/upload", status_code=202)
async def upload(file: UploadFile = File(...)):
    name = file.filename or "document.pdf"
    if not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    head = await file.read(5)
    if head != b"%PDF-":
        raise HTTPException(status_code=400, detail="This is not a valid PDF.")

    # Stream to disk in 1 MB pieces so big files never sit fully in memory.
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    size = len(head)
    try:
        tmp.write(head)
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                raise HTTPException(status_code=413, detail=f"File is larger than {MAX_UPLOAD_MB} MB.")
            tmp.write(chunk)
        tmp.close()
    except Exception:
        tmp.close()
        os.remove(tmp.name)
        raise

    job_id = uuid.uuid4().hex
    jobs[job_id] = {
        "job_id": job_id, "filename": name, "status": "processing", "stage": "queued",
        "pages": 0, "total": 0, "done": 0, "error": None,
    }
    executor.submit(ingest, job_id, tmp.name, name)
    return jobs[job_id]


@app.get("/upload/{job_id}")
async def upload_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown upload job.")
    return job



# Serve the frontend from ./static (must stay LAST so it never hides the API routes)
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


# ---------------- run with:  python app2.py  ----------------
if __name__ == "__main__":
    import threading
    import time
    import urllib.request
    import webbrowser

    import uvicorn

    HOST, PORT = "127.0.0.1", 8000
    URL = f"http://{HOST}:{PORT}"

    # Always behave as if started from this file's folder (ChromaDB, .env, static/ live here).
    os.chdir(Path(__file__).parent)

    def open_when_ready():
        for _ in range(180):                      # wait up to ~3 min for the models to load
            try:
                urllib.request.urlopen(f"{URL}/health", timeout=1)
                webbrowser.open(URL)              # opens the chatbot once, when the server is up
                return
            except Exception:
                time.sleep(1)

    threading.Thread(target=open_when_ready, daemon=True).start()
    uvicorn.run(f"{Path(__file__).stem}:app", host=HOST, port=PORT, reload=True)
