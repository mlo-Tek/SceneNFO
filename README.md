# SceneNFO

Private-first NFO management for Radarr and Sonarr on Unraid, with an Apple/macOS-inspired web UI.

## v0.1 scope

The first working scaffold already contains:

- FastAPI backend and responsive macOS-style single-page UI
- Movies and TV inventory views with filters
- strict classification rule: **exact PreDB.club release match = Scene; otherwise P2P**
- release lookup based on the actual `.mkv` filename with **only `.mkv` removed**
- 1000 Scene groups synced from `https://predb.club/api/v1/teams`
- 73 curated German P2P groups from the supplied WIP screenshots, including Active / Origin / Type / aliases
- NFO source priority: srrDB → PreDB.club → crowdNFO, configurable in Settings
- encrypted storage for crowdNFO / Radarr / Sonarr API keys
- live scan updates over Server-Sent Events
- dry-run and Apply modes
- safe Apply flow: download → validate → write temp file in media folder → `os.replace()` → remove matching old release NFO(s)
- existing Scene NFOs are checked again and replaced even when already present
- P2P NFOs are inventoried but **never replaced by Scene automation**
- Radarr-safe NFO replacement by verified group inside a one-movie folder
- Sonarr-safe replacement requiring the same episode key (`SxxEyy`) when matching renamed NFOs
- scrollable Logs view
- History for manual, schedule and import-triggered runs
- schedule settings using cron syntax
- Radarr and Sonarr webhook endpoints

## Safety rules

1. Scene status is never inferred from the group suffix alone.
2. A release is Scene only when the complete MKV release name (without `.mkv`) is an exact PreDB.club match.
3. If there is no exact match it is shown as P2P.
4. Existing P2P NFOs remain untouched.
5. Existing Scene NFOs do not cause a skip; they are re-downloaded in Apply mode.
6. The old NFO is not deleted until the replacement has downloaded and passed basic validation.
7. Generic metadata files such as `movie.nfo`, `tvshow.nfo` and `season.nfo` are not replacement targets.

## Unraid paths

Default container mappings:

```text
/config     -> /mnt/cache/appdata/scenenfo
/data/media -> /mnt/user/data/media
```

Default library paths inside the container:

```text
/data/media/movies
/data/media/tv
```

## Run with Docker Compose

```bash
git clone https://github.com/mlo-Tek/SceneNFO.git
cd SceneNFO
docker compose up -d --build
```

Open:

```text
http://UNRAID-IP:8787
```

## Settings

The UI exposes:

- Movies and TV paths
- srrDB base URL
- PreDB.club base URL
- crowdNFO base URL
- crowdNFO API key
- source priority
- scheduled scans and Apply/Dry Run mode
- Radarr import automation
- Sonarr import-complete automation

Secrets are encrypted with a local Fernet key stored at `/config/secret.key` with mode `0600`.

## Webhooks

Configure the relevant Radarr/Sonarr connection to POST to:

```text
http://SCENENFO-IP:8787/api/webhooks/radarr
http://SCENENFO-IP:8787/api/webhooks/sonarr
```

For Sonarr season packs, configure the connection for the import-complete behavior so SceneNFO scans after Sonarr has finished processing the import rather than racing each file operation.

## Current development notes

This is the initial v0.1 implementation. Before treating it as production-ready, the next development pass should add:

- explicit Radarr/Sonarr connection test + API-backed title/ID enrichment
- dedicated TV hierarchy (series → season → episode) rather than a flat episode table
- editable P2P group metadata in the UI
- richer Scene group statistics from local library usage
- per-item detail drawer with source hashes and previous NFO history
- queue/debounce logic for duplicate webhook events
- backup/rollback records for every changed NFO
- authentication for the web UI when exposed outside the trusted LAN
- integration tests against recorded API responses
