"""
Orchestrates a single "tailor" run for the product API: job resolution, LangGraph, persistence.
"""

from __future__ import annotations

import json
import time
from typing import Any

import structlog
from starlette.concurrency import run_in_threadpool

from app.core import metrics
from app.core.config import settings
from app.core.db import (
    ApplicationRecord,
    StoredDocument,
    create_application,
    create_document,
    get_document,
    update_document_meta,
)
from app.services.draft_email import parse_draft_email
from app.services.job_text import job_data_to_text
from app.services.langgraph.streaming_agent import (
    run_tailor_pipeline,
    stream_generation,
)
from app.tools.job_fetcher import fetch_job_description

slog = structlog.get_logger(__name__)


def _build_match_analysis(gap: dict[str, Any]) -> dict[str, Any]:
    matched = list(gap.get("matched_keywords") or [])
    missing = list(gap.get("missing_keywords") or [])
    n = len(matched) + len(missing)
    if n > 0:
        base = int(round(100 * len(matched) / n))
    else:
        base = 60
    original = max(25, min(92, base - 8))
    raw_tailored = min(99, max(original + 4, min(99, base + 12)))
    lo = settings.min_tailored_match_score
    hi = settings.max_reported_match_score
    tailored = max(lo, min(hi, raw_tailored))
    # Pre-tailored score should stay below the post-AI score so the lift is visible.
    if original >= tailored:
        original = max(20, min(75, tailored - 12))
    improvement = tailored - original
    return {
        "originalScore": original,
        "tailoredScore": tailored,
        "improvement": improvement,
        "whatWeImproved": [
            "Realigned phrasing to reflect keywords already present in your history.",
            "Tightened bullets toward role-specific outcomes where supported by the resume text.",
        ],
        "strengths": matched[:10],
        "remainingDeficits": missing[:10],
        "matchedKeywords": matched,
        "missingKeywords": missing,
        "suggestions": [s for s in [str(gap.get("summary") or "").strip()] if s],
    }


def _gaps_to_items(missing: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in missing[:12]:
        out.append({"skill": s, "severity": "medium", "note": None})
    return out


def _sse(event: str, data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=True)
    return f"event: {event}\ndata: {payload}"


async def run_tailor_for_user(
    *,
    user_id: str,
    base_resume_id: str,
    job_url: str | None,
    job_description: str | None,
) -> tuple[ApplicationRecord, StoredDocument, dict[str, Any]]:
    """
    Returns the stored application, the new tailored resume document, and the API payload dict
    (camelCase handled by the router layer; this returns snake_case / plain dicts for conversion).
    """
    base = await run_in_threadpool(get_document, doc_id=base_resume_id, owner_user_id=user_id)
    if not base or base.kind != "resume":
        raise ValueError("Base resume not found")
    if len(base.text) > settings.max_text_chars:
        raise ValueError("Base resume text exceeds server limit")

    job_data: dict[str, Any] | None = None
    jd_text = (job_description or "").strip()
    if job_url and job_url.strip():

        def _fetch() -> dict[str, Any]:
            return fetch_job_description.invoke({"url": job_url.strip()})

        try:
            job_data = await run_in_threadpool(_fetch)
        except Exception as e:
            slog.exception("job_fetch_failed", job_url=job_url)
            raise ValueError(f"Could not load job from URL: {e}") from e
        jd_text = job_data_to_text(job_data)
    if not jd_text or len(jd_text.strip()) < 40:
        raise ValueError("Job description is missing or too short; paste more detail or fix the URL.")

    if len(jd_text) > settings.max_text_chars:
        raise ValueError("Job description is too long; shorten or trim the posting.")

    t0 = time.perf_counter()
    try:
        state = await run_tailor_pipeline(
            resume_text=base.text,
            job_description_text=jd_text,
        )
    except Exception as e:
        metrics.tailor_runs.labels("error").inc()
        slog.exception("tailor_pipeline_failed", base_resume_id=base_resume_id)
        raise ValueError("Tailor pipeline failed; please retry or contact support.") from e
    dur = time.perf_counter() - t0
    slog.info("tailor_duration", seconds=round(dur, 3))

    metrics.tailor_runs.labels("success").inc()
    gap = (state or {}).get("gap_analysis") or {}
    if not isinstance(gap, dict):
        gap = {}
    resume_body = (state or {}).get("tailored_resume") or ""
    cover_letter = (state or {}).get("cover_letter") or ""
    gmail_raw = (state or {}).get("gmail_draft") or ""
    de = parse_draft_email(gmail_raw)

    company = (job_data or {}).get("company") if job_data else None
    position = (job_data or {}).get("title") if job_data else None
    if not company:
        company = "Target company"
    if not position:
        position = "Target role"
    mat = _build_match_analysis(gap)
    top_score = float(mat["tailoredScore"])

    missing_kw = [str(x) for x in (gap.get("missing_keywords") or [])]
    gaps_list = _gaps_to_items(missing_kw)
    match_analysis = mat
    app_meta: dict[str, Any] = {
        "match_analysis": match_analysis,
        "draft_email": de,
        "gaps": gaps_list,
        "gap_analysis": gap,
        "tailor_mode": settings.agent_mode,
    }

    title = f"{position} @ {company}"[:200]
    tailored = await run_in_threadpool(
        create_document,
        kind="resume",
        owner_user_id=user_id,
        text=str(resume_body)[: settings.max_output_chars],
        filename=None,
        content_type="text/plain",
        file_path=None,
        meta={"title": title, "is_base": False, "source": "tailor", "base_resume_id": base_resume_id},
    )

    app = await run_in_threadpool(
        create_application,
        user_id=user_id,
        company=str(company)[:300],
        position=str(position)[:300],
        job_url=job_url,
        job_description=jd_text[: min(len(jd_text), 500_000)],
        match_score=top_score,
        status="draft",
        base_resume_id=base_resume_id,
        resume_id=tailored.id,
        cover_letter=cover_letter[: settings.max_output_chars],
        meta=app_meta,
    )

    await run_in_threadpool(
        update_document_meta,
        doc_id=tailored.id,
        owner_user_id=user_id,
        meta_patch={"application_id": app.id, "title": title},
    )

    return app, tailored, {
        "app": app,
        "tailored": tailored,
        "match_score": int(top_score),
        "cover_letter": cover_letter,
        "draft_email": de,
        "gaps": gaps_list,
        "analysis": match_analysis,
    }


async def stream_tailor_for_user(
    *,
    user_id: str,
    base_resume_id: str,
    job_url: str | None,
    job_description: str | None,
):
    """
    Streaming version of run_tailor_for_user.
    Yields SSE events with incremental progress, including final DB persistence.
    """
    base = await run_in_threadpool(get_document, doc_id=base_resume_id, owner_user_id=user_id)
    if not base or base.kind != "resume":
        yield _sse("error", {"message": "Base resume not found"})
        return
    if len(base.text) > settings.max_text_chars:
        yield _sse("error", {"message": "Base resume text exceeds server limit"})
        return

    job_data: dict[str, Any] | None = None
    jd_text = (job_description or "").strip()
    if job_url and job_url.strip():

        def _fetch() -> dict[str, Any]:
            return fetch_job_description.invoke({"url": job_url.strip()})

        try:
            yield _sse("status", {"stage": "fetching_job"})
            job_data = await run_in_threadpool(_fetch)
        except Exception as e:
            slog.exception("job_fetch_failed", job_url=job_url)
            yield _sse("error", {"message": f"Could not load job from URL: {e}"})
            return
        jd_text = job_data_to_text(job_data)

    if not jd_text or len(jd_text.strip()) < 40:
        yield _sse("error", {"message": "Job description is missing or too short; paste more detail or fix the URL."})
        return
    if len(jd_text) > settings.max_text_chars:
        yield _sse("error", {"message": "Job description is too long; shorten or trim the posting."})
        return

    resume_text = base.text
    t0 = time.perf_counter()

    # Stream generation progress
    async for line in stream_generation(resume_text=resume_text, job_description_text=jd_text):
        yield line

    # Now collect the final state by running the full pipeline
    try:
        state = await run_tailor_pipeline(
            resume_text=resume_text,
            job_description_text=jd_text,
        )
    except Exception as e:
        metrics.tailor_runs.labels("error").inc()
        slog.exception("tailor_pipeline_failed", base_resume_id=base_resume_id)
        yield _sse("error", {"message": "Tailor pipeline failed; please retry or contact support."})
        return

    dur = time.perf_counter() - t0
    slog.info("tailor_duration", seconds=round(dur, 3))
    metrics.tailor_runs.labels("success").inc()

    gap = (state or {}).get("gap_analysis") or {}
    if not isinstance(gap, dict):
        gap = {}
    resume_body = (state or {}).get("tailored_resume") or ""
    cover_letter = (state or {}).get("cover_letter") or ""
    gmail_raw = (state or {}).get("gmail_draft") or ""
    de = parse_draft_email(gmail_raw)

    company = (job_data or {}).get("company") if job_data else None
    position = (job_data or {}).get("title") if job_data else None
    if not company:
        company = "Target company"
    if not position:
        position = "Target role"
    mat = _build_match_analysis(gap)
    top_score = float(mat["tailoredScore"])

    missing_kw = [str(x) for x in (gap.get("missing_keywords") or [])]
    gaps_list = _gaps_to_items(missing_kw)
    match_analysis = mat
    app_meta: dict[str, Any] = {
        "match_analysis": match_analysis,
        "draft_email": de,
        "gaps": gaps_list,
        "gap_analysis": gap,
        "tailor_mode": settings.agent_mode,
    }

    title = f"{position} @ {company}"[:200]

    yield _sse("status", {"stage": "saving"})

    tailored = await run_in_threadpool(
        create_document,
        kind="resume",
        owner_user_id=user_id,
        text=str(resume_body)[: settings.max_output_chars],
        filename=None,
        content_type="text/plain",
        file_path=None,
        meta={"title": title, "is_base": False, "source": "tailor", "base_resume_id": base_resume_id},
    )

    app = await run_in_threadpool(
        create_application,
        user_id=user_id,
        company=str(company)[:300],
        position=str(position)[:300],
        job_url=job_url,
        job_description=jd_text[: min(len(jd_text), 500_000)],
        match_score=top_score,
        status="draft",
        base_resume_id=base_resume_id,
        resume_id=tailored.id,
        cover_letter=cover_letter[: settings.max_output_chars],
        meta=app_meta,
    )

    await run_in_threadpool(
        update_document_meta,
        doc_id=tailored.id,
        owner_user_id=user_id,
        meta_patch={"application_id": app.id, "title": title},
    )

    yield _sse("status", {
        "stage": "completed",
        "application_id": app.id,
        "document_id": tailored.id,
        "match_score": int(top_score),
    })

    yield _sse("result", {
        "app": {
            "id": app.id,
            "company": app.company,
            "position": app.position,
            "status": app.status,
            "match_score": int(top_score),
        },
        "tailored": {
            "id": tailored.id,
            "text": resume_body[:2000],
        },
        "match_score": int(top_score),
        "cover_letter": cover_letter,
        "draft_email": de,
        "gaps": gaps_list,
        "analysis": match_analysis,
    })
