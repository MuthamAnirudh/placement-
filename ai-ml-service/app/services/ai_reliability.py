"""
AI Reliability / Hallucination Detection Layer (spec §16).

career_path.py, roadmap.py, and market_intel.py all generate free-text explanations via an
LLM (rationale, priority_gap, etc.). This module adds a lightweight verification pass between
"LLM produced text" and "text is shown to the student":

    LLM output -> claim extraction -> evidence retrieval -> consistency check
    -> uncertainty estimation -> annotated response

Deliberately does NOT call a second LLM to "judge" the first one — that would just be a
second source of hallucination, and doubles cost/latency for a research project this size.
Instead, every claim is checked via embedding similarity (the same matcher.embed/cosine
already used for resume/JD matching — no new ML infra) against a set of KNOWN FACTS the
caller already computed deterministically for that same request (e.g. career_path.py's
matched_skills/missing_skills/confidence, roadmap.py's target_role/current_skills/
missing_skills).

Documented limitation (spec §33): this catches a claim with no basis at all in the facts
already computed for the request — it does NOT verify facts about the outside world (e.g.
"Kubernetes was released in 2014", "React is faster than Vue"). That class of check needs a
real retrieval corpus and is out of scope for this baseline; the `caveats` field on every
response says so explicitly, so this is never silently overclaimed as full fact-checking.

Per spec §16's explicit instruction ("never present uncertain AI output as fact"): this
module never rewrites, blocks, or silently drops the original LLM text — callers attach the
reliability report ALONGSIDE it, so the student always sees both the answer and how grounded
it is, rather than an invisible filter deciding what they get to see.
"""
import re

from app.services.matcher import embed, cosine

GROUNDED_SIMILARITY_THRESHOLD = 0.45  # deliberately generous — a coarse "is this claim even
# related to a known fact" check, not exact verification
LEXICAL_OVERLAP_THRESHOLD = 0.35  # fraction of a claim's meaningful words that must appear
# somewhere in the known facts to count as grounded via this signal
MIN_CLAIM_WORDS = 4  # shorter fragments (greetings, single words) aren't really "claims"

_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "this", "that", "these", "those", "and",
    "or", "to", "of", "in", "on", "for", "with", "your", "you", "it", "its", "as", "be", "at",
    "by", "from", "their", "them", "he", "she", "we", "i", "not", "but", "so", "if", "will",
    "would", "should", "could", "can", "may", "might", "which", "who", "whom", "what", "when",
    "where", "why", "how", "also", "than", "then", "there", "has", "have", "had", "do",
    "does", "did", "been", "being", "next", "most", "already", "typically",
}


def extract_claims(text: str) -> list[str]:
    """Splits LLM free text into individual declarative claims (sentences)."""
    if not text or not text.strip():
        return []
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    return [s.strip() for s in sentences if len(s.strip().split()) >= MIN_CLAIM_WORDS]


def _content_tokens(text: str) -> set[str]:
    return {
        t for t in re.findall(r"[a-zA-Z][a-zA-Z0-9+.#]{1,}", text.lower())
        if t not in _STOPWORDS and len(t) > 2
    }


def _lexical_overlap(claim: str, known_facts: list[str]) -> float:
    claim_tokens = _content_tokens(claim)
    if not claim_tokens:
        return 0.0
    fact_tokens = _content_tokens(" ".join(known_facts))
    return len(claim_tokens & fact_tokens) / len(claim_tokens)


NOTABLE_TERM_GROUNDED_RATIO = 0.5  # if a claim names specific terms (proper nouns, acronyms,
# money/percentages) and fewer than half of them appear anywhere in the known facts, the
# claim is treated as ungrounded regardless of the other two signals — this is the strongest
# available hallucination catch: an invented specific (a skill, a dollar figure) that was
# never in what the caller gave the LLM.


def _notable_terms(claim: str) -> set[str]:
    """Proper nouns/acronyms/figures in `claim` — skill names, role titles, tech terms, and
    dollar/percentage figures are exactly the kind of specific, checkable claim an LLM is
    prone to inventing. A capitalized word is skipped only if it's a common word that's
    merely capitalized by sentence-initial grammar (i.e. it's in the stopword list) — this
    still catches a genuine proper noun that happens to start the sentence (e.g. "Docker
    experience is...")."""
    words = claim.split()
    terms = set()
    for w in words:
        cleaned = re.sub(r"[^\w+.#]", "", w)
        if not cleaned or cleaned.lower() in _STOPWORDS:
            continue
        if re.match(r"^[A-Z][a-zA-Z0-9+.#]*$", cleaned) or re.match(r"^[A-Z]{2,6}$", cleaned):
            terms.add(cleaned.lower())
    for m in re.finditer(r"\$[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%", claim):
        terms.add(m.group().lower())
    return terms


def verify_claim(claim: str, known_facts: list[str]) -> dict:
    """Combines three independent grounding signals so this stays reliable whether or not a
    real sentence-embedding model is configured (see module docstring):
      1. notable-term check — specific names/figures the claim introduces, checked against the
         known facts. Has VETO power: if the claim names specific terms and most of them are
         nowhere in the known facts, it's ungrounded no matter what the other signals say.
      2. embedding cosine similarity (strong when sentence-transformers is installed; degrades
         to a hashed bag-of-words fallback in matcher.py, which only catches literal shared
         tokens).
      3. general lexical-overlap ratio (always meaningful — shared content words, not geometry).
    """
    notable = _notable_terms(claim)
    fact_tokens = _content_tokens(" ".join(known_facts)) if known_facts else set()
    if notable:
        notable_hits = sum(1 for t in notable if t in fact_tokens)
        notable_ratio = notable_hits / len(notable)
        if notable_ratio < NOTABLE_TERM_GROUNDED_RATIO:
            return {
                "claim": claim, "grounded": False, "best_match": None,
                "embedding_similarity": 0.0, "lexical_overlap": 0.0,
                "notable_terms": sorted(notable), "notable_terms_grounded_ratio": round(notable_ratio, 3),
            }

    lexical_score = round(_lexical_overlap(claim, known_facts), 3)

    best_fact, embedding_score = None, 0.0
    if known_facts:
        claim_vec = embed(claim)
        for fact in known_facts:
            score = cosine(claim_vec, embed(fact))
            if score > embedding_score:
                best_fact, embedding_score = fact, score
        embedding_score = round(max(0.0, embedding_score), 3)

    grounded = bool(notable) or embedding_score >= GROUNDED_SIMILARITY_THRESHOLD or lexical_score >= LEXICAL_OVERLAP_THRESHOLD
    return {
        "claim": claim,
        "grounded": grounded,
        "best_match": best_fact,
        "embedding_similarity": embedding_score,
        "lexical_overlap": lexical_score,
        "notable_terms": sorted(notable) if notable else None,
    }


def check_reliability(generated_text: str, known_facts: list[str]) -> dict:
    """Full pipeline over one piece of LLM-generated text against the known facts already
    computed for this request. Returns a groundedness score + per-claim detail + an
    uncertainty label."""
    claims = extract_claims(generated_text)
    if not claims:
        return {
            "groundedness_score": None,
            "confidence_label": "not_applicable",
            "claims_checked": 0,
            "unsupported_claims": [],
            "method": "No checkable declarative claims (4+ words) were found in this text.",
        }

    verified = [verify_claim(c, known_facts) for c in claims]
    grounded_count = sum(1 for v in verified if v["grounded"])
    groundedness_score = round(grounded_count / len(verified), 3)

    if groundedness_score >= 0.8:
        label = "high"
    elif groundedness_score >= 0.5:
        label = "medium"
    else:
        label = "low"

    return {
        "groundedness_score": groundedness_score,
        "confidence_label": label,
        "claims_checked": len(verified),
        "unsupported_claims": [v["claim"] for v in verified if not v["grounded"]],
        "per_claim": verified,
        "method": f"Each claim checked against {len(known_facts)} known facts already computed "
                  f"for this request, via two independent signals: embedding similarity "
                  f"(threshold {GROUNDED_SIMILARITY_THRESHOLD}) and direct lexical word-overlap "
                  f"(threshold {LEXICAL_OVERLAP_THRESHOLD}) — grounded if either clears its bar.",
        "caveats": [
            "A high groundedness score means the text stays close to facts already computed "
            "for this request — it does NOT verify real-world factual accuracy (specific "
            "dates, library versions, or job-market claims).",
            "This is a coarse similarity check, not a validated fact-checking system — treat "
            "'low' as a prompt to double check, not proof the text is wrong.",
        ],
    }
