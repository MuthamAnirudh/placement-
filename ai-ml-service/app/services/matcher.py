"""
Semantic skill-matching / vector search.

Backend is pluggable via VECTOR_BACKEND env var:
  - "faiss"    (default) — zero-infra local index, perfect for a demo/laptop
  - "qdrant"   — talks to a Qdrant instance (self-hosted or Qdrant Cloud)
  - "pinecone" — talks to Pinecone's managed vector DB

All three implement the same tiny interface (upsert / query), so swapping
backends is a one-line env change and no code change — matching the original
"Pinecone / Qdrant" requirement while staying runnable with zero paid infra
for the ideathon demo.

Embeddings: sentence-transformers (all-MiniLM-L6-v2, 384-dim, CPU-friendly).
Falls back to a lightweight TF-IDF-hash embedding if the model can't be
downloaded (e.g. offline judging room with no internet) so the feature never
hard-fails during a live demo.
"""
import hashlib
import json
import os
from pathlib import Path
from typing import Optional

from app.config import get_settings

settings = get_settings()

try:
    from sentence_transformers import SentenceTransformer
    _MODEL = SentenceTransformer(settings.EMBEDDING_MODEL)
    _EMBED_DIM = _MODEL.get_sentence_embedding_dimension()
except Exception:  # noqa: BLE001 — offline / model not downloaded / no torch
    _MODEL = None
    _EMBED_DIM = settings.EMBEDDING_DIM


def embed(text: str) -> list[float]:
    if _MODEL is not None:
        return _MODEL.encode(text, normalize_embeddings=True).tolist()
    # Deterministic hashed bag-of-words fallback (cosine-comparable, no ML deps needed).
    import re
    vec = [0.0] * _EMBED_DIM
    for tok in re.findall(r"[a-zA-Z][a-zA-Z0-9+.#]{1,}", text.lower()):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        vec[h % _EMBED_DIM] += 1.0
    norm = sum(v * v for v in vec) ** 0.5 or 1.0
    return [v / norm for v in vec]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5 or 1.0
    nb = sum(y * y for y in b) ** 0.5 or 1.0
    return dot / (na * nb)


class _FaissBackend:
    """Local, file-persisted vector index — no external service required."""

    def __init__(self):
        self.path = Path(settings.FAISS_INDEX_PATH)
        self.path.mkdir(parents=True, exist_ok=True)
        self.meta_file = self.path / "meta.jsonl"
        self._records: list[dict] = []
        self._index = None
        self._load()

    def _load(self):
        if self.meta_file.exists():
            with open(self.meta_file, "r") as f:
                self._records = [json.loads(line) for line in f if line.strip()]
        try:
            import faiss  # noqa: F401
            import numpy as np
            self._faiss = faiss
            self._np = np
            self._index = faiss.IndexFlatIP(_EMBED_DIM)
            if self._records:
                vectors = np.array([r["vector"] for r in self._records], dtype="float32")
                self._index.add(vectors)
        except ImportError:
            self._index = None  # brute-force cosine fallback below

    def upsert(self, id_: str, text: str, metadata: dict):
        vector = embed(text)
        record = {"id": id_, "text": text, "metadata": metadata, "vector": vector}
        self._records = [r for r in self._records if r["id"] != id_]
        self._records.append(record)
        with open(self.meta_file, "w") as f:
            for r in self._records:
                f.write(json.dumps(r) + "\n")
        if self._index is not None:
            self._index = self._faiss.IndexFlatIP(_EMBED_DIM)
            vectors = self._np.array([r["vector"] for r in self._records], dtype="float32")
            self._index.add(vectors)

    def query(self, text: str, top_k: int = 5) -> list[dict]:
        if not self._records:
            return []
        qvec = embed(text)
        scored = [(cosine(qvec, r["vector"]), r) for r in self._records]
        scored.sort(key=lambda t: t[0], reverse=True)
        return [
            {"id": r["id"], "score": round(score, 4), "text": r["text"], "metadata": r["metadata"]}
            for score, r in scored[:top_k]
        ]


class _QdrantBackend:
    def __init__(self):
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams
        self.client = QdrantClient(url=settings.QDRANT_URL, api_key=settings.QDRANT_API_KEY or None)
        self.collection = settings.QDRANT_COLLECTION
        try:
            self.client.get_collection(self.collection)
        except Exception:  # noqa: BLE001
            self.client.create_collection(
                collection_name=self.collection,
                vectors_config=VectorParams(size=_EMBED_DIM, distance=Distance.COSINE),
            )

    def upsert(self, id_: str, text: str, metadata: dict):
        from qdrant_client.models import PointStruct
        vector = embed(text)
        self.client.upsert(self.collection, points=[
            PointStruct(id=abs(hash(id_)) % (10 ** 12), vector=vector,
                        payload={**metadata, "text": text, "ext_id": id_})
        ])

    def query(self, text: str, top_k: int = 5) -> list[dict]:
        vector = embed(text)
        hits = self.client.search(self.collection, query_vector=vector, limit=top_k)
        return [
            {"id": h.payload.get("ext_id"), "score": round(h.score, 4),
             "text": h.payload.get("text"), "metadata": {k: v for k, v in h.payload.items() if k not in ("text", "ext_id")}}
            for h in hits
        ]


class _PineconeBackend:
    def __init__(self):
        from pinecone import Pinecone
        self.pc = Pinecone(api_key=settings.PINECONE_API_KEY)
        self.index = self.pc.Index(settings.PINECONE_INDEX)

    def upsert(self, id_: str, text: str, metadata: dict):
        vector = embed(text)
        self.index.upsert(vectors=[{"id": id_, "values": vector, "metadata": {**metadata, "text": text}}])

    def query(self, text: str, top_k: int = 5) -> list[dict]:
        vector = embed(text)
        res = self.index.query(vector=vector, top_k=top_k, include_metadata=True)
        return [
            {"id": m.id, "score": round(m.score, 4), "text": m.metadata.get("text"),
             "metadata": {k: v for k, v in m.metadata.items() if k != "text"}}
            for m in res.matches
        ]


_backend = None


def get_backend():
    global _backend
    if _backend is not None:
        return _backend
    if settings.VECTOR_BACKEND == "qdrant":
        try:
            _backend = _QdrantBackend()
        except Exception:  # noqa: BLE001 — Qdrant unreachable, degrade to local FAISS
            _backend = _FaissBackend()
    elif settings.VECTOR_BACKEND == "pinecone":
        try:
            _backend = _PineconeBackend()
        except Exception:  # noqa: BLE001
            _backend = _FaissBackend()
    else:
        _backend = _FaissBackend()
    return _backend


def index_profile(profile_id: str, text: str, metadata: Optional[dict] = None):
    get_backend().upsert(profile_id, text, metadata or {})


def semantic_search(query_text: str, top_k: int = 5) -> list[dict]:
    return get_backend().query(query_text, top_k)


def match_resume_to_jd(resume_text: str, jd_text: str) -> dict:
    """Single-pair semantic similarity — no index needed, used by the Resume-JD panel."""
    score = cosine(embed(resume_text), embed(jd_text))
    return {"semantic_similarity": round(max(0.0, score) * 100, 1), "backend": settings.VECTOR_BACKEND,
            "embedding_engine": "sentence-transformers" if _MODEL is not None else "hashed-fallback"}


# ---------------------------------------------------------------------------------------
# Explainable Competency Matching (spec §9) — upgrades the panel above from a single opaque
# whole-document cosine score into a per-skill breakdown: matched / partially-matched /
# missing, each with the exact evidence behind it. Deliberately does NOT introduce a second
# skill graph in Python: prerequisite/"required-by" reasoning for missing skills already
# lives in the Node backend's Competency Knowledge Graph (backend/src/services/
# knowledgeGraph*.js, GET /api/twin/gap-analysis) — once matched skills are synced to the
# Digital Twin (see digitalTwinRepo.syncResumeMatch), that existing endpoint is the place to
# ask "what's the prerequisite path to skill X", rather than duplicating graph logic here.
PARTIAL_MATCH_THRESHOLD = 0.55  # below this, two skill labels are treated as unrelated
STRONG_PARTIAL_THRESHOLD = 0.75  # at/above this, a near-miss is closer to "already have it"


def _normalize_skill(skill: str) -> str:
    return skill.strip().lower()


def explain_resume_jd_match(resume_skills: list[str], jd_skills: list[str],
                             resume_text: str = "", jd_text: str = "") -> dict:
    """Skill-level explainable match. `resume_skills`/`jd_skills` should be the lists already
    produced by parser.extract_skills()/parse_job_description() — this function does not
    re-run extraction, so the caller controls (and can cache) that step.

    For every JD skill:
      - exact (case-insensitive) name match against the resume's skill list -> "matched"
      - else, the single closest resume skill by embedding cosine similarity:
          >= STRONG_PARTIAL_THRESHOLD -> "matched" (evidenced, not exact-string)
          >= PARTIAL_MATCH_THRESHOLD  -> "partially_matched"
          else                        -> "missing"
    Every confidence number is the exact cosine score (or 1.0 for an exact string match) —
    nothing here is a fabricated/simulated importance value (spec §33).
    """
    resume_norm = [_normalize_skill(s) for s in resume_skills]
    resume_vecs = {s: embed(s) for s in resume_norm} if resume_norm else {}

    matched, partial, missing = [], [], []
    for raw_jd_skill in jd_skills:
        jd_skill = _normalize_skill(raw_jd_skill)
        if jd_skill in resume_norm:
            matched.append({
                "skill": raw_jd_skill,
                "confidence": 1.0,
                "evidence": f"'{raw_jd_skill}' appears verbatim in your resume's extracted skill list.",
                "match_type": "exact",
            })
            continue

        best_skill, best_score = None, 0.0
        for r_skill, r_vec in resume_vecs.items():
            score = cosine(embed(jd_skill), r_vec)
            if score > best_score:
                best_skill, best_score = r_skill, score
        best_score = round(max(0.0, best_score), 3)

        if best_skill and best_score >= STRONG_PARTIAL_THRESHOLD:
            matched.append({
                "skill": raw_jd_skill,
                "confidence": best_score,
                "evidence": f"Not listed verbatim, but your '{best_skill}' is a near-equivalent "
                            f"skill (semantic similarity {best_score}).",
                "match_type": "semantic",
            })
        elif best_skill and best_score >= PARTIAL_MATCH_THRESHOLD:
            partial.append({
                "skill": raw_jd_skill,
                "confidence": best_score,
                "evidence": f"Your '{best_skill}' is related but not equivalent "
                            f"(semantic similarity {best_score}) — likely a related/transferable "
                            "skill rather than direct experience.",
                "closest_resume_skill": best_skill,
                "match_type": "partial",
            })
        else:
            missing.append({
                "skill": raw_jd_skill,
                "confidence": 0.0,
                "evidence": "No resume skill (exact or semantically similar) was found for this requirement.",
                "match_type": "missing",
            })

    total = len(jd_skills) or 1
    # Exact, traceable decomposition (not an approximation): each matched skill contributes
    # a full point, each partial match contributes its own similarity score as a fraction of
    # a point — both normalized by the number of JD requirements.
    matched_pts = len(matched)
    partial_pts = sum(p["confidence"] for p in partial)
    skill_coverage_score = round(100 * (matched_pts + partial_pts) / total, 1)

    whole_doc = None
    if resume_text and jd_text:
        whole_doc = round(max(0.0, cosine(embed(resume_text), embed(jd_text))) * 100, 1)

    return {
        "matched_skills": matched,
        "partially_matched_skills": partial,
        "missing_skills": missing,
        "skill_coverage_score": skill_coverage_score,
        "semantic_similarity": whole_doc,  # kept for backward compatibility with existing callers
        "backend": settings.VECTOR_BACKEND,
        "embedding_engine": "sentence-transformers" if _MODEL is not None else "hashed-fallback",
        "note": "Prerequisite/graph-based explanations for missing skills are available via the "
                "Digital Twin's gap-analysis endpoint once matched skills are synced (see "
                "POST /api/twin/sync-resume-match then GET /api/twin/gap-analysis).",
    }
