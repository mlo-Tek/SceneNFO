from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import router
from .db import init_db
from .groups import seed_p2p_groups, sync_scene_groups
from .scheduler import refresh_schedule, scheduler

STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_p2p_groups()
    asyncio.create_task(sync_scene_groups())
    if not scheduler.running:
        scheduler.start()
    refresh_schedule()
    yield
    if scheduler.running:
        scheduler.shutdown(wait=False)


app = FastAPI(title="SceneNFO", version="0.1.0", lifespan=lifespan)
app.include_router(router)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")
