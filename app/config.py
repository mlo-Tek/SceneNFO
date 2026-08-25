from __future__ import annotations

import os
from pathlib import Path

CONFIG_DIR = Path(os.getenv("SCENENFO_CONFIG_DIR", "/config"))
DB_PATH = CONFIG_DIR / "scenenfo.db"
SECRET_PATH = CONFIG_DIR / "secret.key"
LOG_DIR = CONFIG_DIR / "logs"
TMP_DIR = CONFIG_DIR / "tmp"

for path in (CONFIG_DIR, LOG_DIR, TMP_DIR):
    path.mkdir(parents=True, exist_ok=True)

DEFAULTS = {
    "movies_path": "/data/media/movies",
    "tv_path": "/data/media/tv",
    "srrdb_base_url": "https://api.srrdb.com",
    "predb_base_url": "https://predb.club",
    "crowdnfo_base_url": "https://crowdnfo.net",
    "source_priority": "srrdb,predb,crowdnfo",
    "schedule_enabled": "false",
    "schedule_cron": "0 3 * * *",
    "schedule_libraries": "movies,tv",
    "schedule_apply": "false",
    "radarr_webhook_enabled": "true",
    "sonarr_webhook_enabled": "true",
    "import_apply": "false",
    "import_nfo_policy": "replace_all",
    "sonarr_import_debounce_seconds": "30",
    "import_fallback_window_minutes": "10",
    "import_fallback_max_files": "5",
}
