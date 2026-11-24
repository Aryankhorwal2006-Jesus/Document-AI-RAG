from langchain_community.document_loaders import PyPDFLoader, TextLoader, WebBaseLoader
from langchain_groq import ChatGroq
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_text_splitters import TokenTextSplitter, RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings


from dotenv import load_dotenv

load_dotenv()

loader = PyPDFLoader("Documents loader/deeplearning.pdf")
docs = loader.load()

splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
chunks = splitter.split_documents(docs)
embedding = HuggingFaceEmbeddings(
    model_name = "sentence-transformers/all-MiniLM-L6-v2"

)

vectorstore = Chroma.from_documents(documents=chunks, embedding=embedding, persist_directory="ChromaDB")
