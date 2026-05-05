from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.api.schemas.frontend import (
    ApplicationOut,
    DraftEmailOut,
    GapItemOut,
    TailorRequestIn,
    TailorResponseOut,
    map_application,
    map_match_analysis,
    map_resume,
)
from app.core.auth import AuthenticatedUser, get_current_user
from app.core.db import get_application, list_applications
from app.services.tailor_orchestrator import run_tailor_for_user, stream_tailor_for_user

router = APIRouter()
log = structlog.get_logger(__name__)


@router.get("/applications", response_model=list[ApplicationOut])
def list_user_applications(
    user: AuthenticatedUser = Depends(get_current_user),
) -> list[ApplicationOut]:
    apps = list_applications(user_id=user.user_id)
    return [map_application(a, list_view=True) for a in apps]


@router.get("/applications/{application_id}", response_model=ApplicationOut)
def get_one_application(
    application_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> ApplicationOut:
    a = get_application(app_id=application_id, user_id=user.user_id)
    if not a:
        raise HTTPException(status_code=404, detail="Application not found")
    return map_application(a, list_view=False)


@router.post("/applications/tailor", response_model=TailorResponseOut)
async def tailor_application(
    body: TailorRequestIn,
    user: AuthenticatedUser = Depends(get_current_user),
) -> TailorResponseOut:
    try:
        app_rec, _tailored, pl = await run_tailor_for_user(
            user_id=user.user_id,
            base_resume_id=body.base_resume_id,
            job_url=body.job_url,
            job_description=body.job_description,
        )
    except ValueError as e:
        log.info("tailor_rejected", reason=str(e))
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        log.exception("tailor_unexpected_error")
        raise HTTPException(
            status_code=500, detail="Tailor failed. Support has been notified."
        ) from e

    tdoc = pl["tailored"]
    gap_items = [
        GapItemOut(
            skill=str(x.get("skill", "")),
            severity=str(x.get("severity", "medium")),
            note=x.get("note"),
        )
        for x in (pl.get("gaps") or [])
    ]
    de = pl.get("draft_email") or {"subject": "Application", "body": ""}
    return TailorResponseOut(
        application_id=app_rec.id,
        match_score=int(pl["match_score"]),
        resume=map_resume(
            tdoc,
            is_base=bool(tdoc.meta.get("is_base", False)),
            application_id=app_rec.id,
        ),
        cover_letter=pl["cover_letter"],
        draft_email=DraftEmailOut(
            subject=de.get("subject", "Application"), body=de.get("body", "")
        ),
        gaps=gap_items,
        analysis=map_match_analysis(pl["analysis"]),
    )


@router.post("/applications/tailor/stream")
async def tailor_application_stream(
    body: TailorRequestIn,
    user: AuthenticatedUser = Depends(get_current_user),
) -> StreamingResponse:
    """
    Streaming version of the tailor endpoint.
    Yields Server-Sent Events (SSE) with incremental progress:
    - status events (fetching_job, started, saving, completed)
    - generation progress (gap_analysis, resume, cover_letter, gmail_draft)
    - error events if something fails
    - final result event with persisted application data
    """

    async def event_stream():
        try:
            async for line in stream_tailor_for_user(
                user_id=user.user_id,
                base_resume_id=body.base_resume_id,
                job_url=body.job_url,
                job_description=body.job_description,
            ):
                yield f"{line}\n\n"
        except Exception as e:
            log.exception("tailor_stream_failed")
            yield 'event: error\ndata: {"message":"tailor_stream_failed"}\n\n'

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
