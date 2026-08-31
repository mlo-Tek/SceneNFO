from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import router
from .db import init_db
from .discord_summary import router as discord_summary_router
from .folder_browser import router as folder_browser_router
from .groups import seed_p2p_groups, sync_scene_groups
from .import_webhooks import router as import_webhook_router
from .item_management import router as item_management_router
from .library_page import router as library_page_router
from .path_repair import install_scanner_path_repair, repair_saved_library_items
from .performance_api import router as performance_router
from .radarr_integration import install_radarr_integration, router as radarr_integration_router
from .recent import router as recent_router
from .review import router as review_router
from .scheduler import refresh_schedule, scheduler
from .sonarr_integration import install_sonarr_integration, router as sonarr_integration_router

STATIC = Path(__file__).parent / "static"
VERSION = "0.3.29"

# Install the ownership-aware NFO writer first, then layer targeted post-Apply
# refresh hooks for Movies (Radarr) and TV (Sonarr) onto the same scanner.
install_radarr_integration()
install_sonarr_integration()
install_scanner_path_repair()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    repair_saved_library_items()
    seed_p2p_groups()
    asyncio.create_task(sync_scene_groups())
    if not scheduler.running:
        scheduler.start()
    refresh_schedule()
    yield
    if scheduler.running:
        scheduler.shutdown(wait=False)


app = FastAPI(title="SceneNFO", version=VERSION, lifespan=lifespan)


@app.get("/api/health", include_in_schema=False)
def app_health():
    return {"ok": True, "version": VERSION}


# Targeted import routes are registered before the legacy webhook routes in api.py,
# so Radarr/Sonarr imports use exact-file processing without walking whole libraries.
app.include_router(import_webhook_router)
app.include_router(router)
app.include_router(review_router)
app.include_router(item_management_router)
app.include_router(library_page_router)
app.include_router(performance_router)
app.include_router(folder_browser_router)
app.include_router(radarr_integration_router)
app.include_router(sonarr_integration_router)
app.include_router(discord_summary_router)
app.include_router(recent_router)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")
