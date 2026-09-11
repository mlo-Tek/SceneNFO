# SceneNFO

<p align="center">
  <img src="assets/scenenfo.png" alt="SceneNFO" width="128">
</p>

**Self-hosted Scene/P2P release classification and Scene NFO management for Radarr and Sonarr libraries, with a modern desktop-style web UI.**

Current `main` version: **0.3.31**

> [!IMPORTANT]
> **Development transparency — vibe-coded / AI-assisted:** SceneNFO is developed with substantial AI assistance. Architecture, implementation, refactoring, tests and documentation have been created and iterated on with AI tools under maintainer direction and review. Treat it like any community/self-hosted project: review changes, keep backups and test with **Dry Run** before enabling write operations.

## What SceneNFO does

SceneNFO scans movie and TV libraries, identifies the real release name from the media filename, classifies each release as **Scene** or **P2P**, and can automatically retrieve and manage Scene NFO files.

The core rule is intentionally strict:

> **Exact PreDB.club release match = Scene. No exact match = P2P.**

SceneNFO does not classify a release as Scene merely because its filename ends in a known Scene group.

## Highlights

### Scene / P2P classification

- Uses the actual `.mkv` filename as the release name.
- Removes **only the final `.mkv` extension** before lookup.
- Requires an **exact PreDB.club release match** for Scene classification.
- Falls back to P2P classification when there is no exact match.
- Tracks release group, PreDB ID, NFO state and NFO source per media item.
- Syncs Scene-group data and maintains curated P2P-group metadata locally.

### NFO management

Scene NFO lookup supports these sources in configurable priority order:

1. **srrDB**
2. **PreDB.club**
3. **crowdNFO**

The default priority is:

```text
srrdb,predb,crowdnfo
```

Available NFO policies:

- **Replace all** — retrieve the preferred Scene NFO and replace matching old Scene NFO files.
- **Missing only** — only retrieve an NFO when a matching local NFO is not already present.

Available run modes:

- **Dry Run** — inspect and report what SceneNFO would do without modifying media folders.
- **Apply** — create or replace Scene NFO files.

### Safe write behavior

Apply mode is deliberately conservative:

- P2P releases are inventoried but are **not replaced by Scene automation**.
- Generic metadata files such as `movie.nfo`, `tvshow.nfo` and `season.nfo` are not replacement targets.
- A downloaded NFO is validated before it is written.
- Writes use a temporary file followed by an atomic `os.replace()`.
- Matching old Scene NFO files are removed only after the replacement has been downloaded and validated.
- Movie replacement is constrained to the matching movie folder.
- TV replacement is constrained by the episode key (`SxxEyy`, including multi-episode forms where applicable).

## Web UI

SceneNFO includes a responsive desktop-style web interface with:

- Dashboard and library overview
- Compact **Recently added** sections for Movies and TV
- TV recent items grouped by series in the UI
- Real movie/series titles plus episode keys where available
- Scene/P2P classification and release group display
- NFO presence and NFO source information
- Movies and TV inventory views with filtering
- Multiple configurable Movies and TV library roots
- Folder browser for selecting library paths
- Manual scans and per-item NFO actions
- Live scan progress over Server-Sent Events
- Run review, history and detailed logs
- Settings for integrations, scheduling and source priority

The dashboard recent-items API returns up to 12 entries per library and defaults to 10.

## Scanning

SceneNFO supports two scan scopes:

- **Incremental** — skips unchanged media files using stored file fingerprints and only performs remote work where needed.
- **Full** — re-evaluates the selected library.

Runs record their library, trigger, mode, NFO policy, scan scope, timestamps and result counters in the local SQLite database.

Saved media paths are reconciled against the filesystem, including case differences, so the database can be repaired to the real on-disk path instead of keeping stale path casing.

## Radarr and Sonarr integration

SceneNFO supports Radarr and Sonarr API integration plus import webhooks.

Webhook endpoints:

```text
http://SCENENFO-IP:8787/api/webhooks/radarr
http://SCENENFO-IP:8787/api/webhooks/sonarr
```

Import handling is targeted at the imported media instead of unnecessarily walking the complete library.

Additional behavior includes:

- Optional automatic Apply behavior for imports
- Configurable import NFO policy
- Radarr refresh after successful Apply
- Sonarr refresh after successful Apply
- Sonarr import batching/debounce for imports belonging to the same series
- Fallback matching for recent imports when an exact imported path cannot be resolved immediately

The default Sonarr import debounce is **30 seconds**.

## Scheduled scans

Scheduled scans use cron syntax.

Default schedule configuration:

```text
Enabled: false
Cron:    0 3 * * *
Mode:    Dry Run
Scope:   Movies + TV
```

Schedules can be changed in the web UI.

## Discord weekly summary

SceneNFO can send an optional weekly summary to a Discord webhook.

Configurable options include:

- Enable / disable
- Discord webhook URL
- Day of week
- Time
- Timezone
- Include NFO information
- Send or suppress an empty summary

The default schedule is Sunday at `20:00` in `Europe/Berlin`, but the integration is disabled until configured.

## Installation

### Unraid / prebuilt image

A ready-to-use Unraid template is included at:

```text
unraid/SceneNFO.xml
```

The project publishes a Linux/amd64 image to GitHub Container Registry on successful `main` builds:

```text
ghcr.io/mlo-tek/scenenfo:latest
```

Default container configuration:

| Purpose | Container | Example Unraid host path |
| --- | --- | --- |
| Web UI / API | `8787/tcp` | `8787` |
| Persistent config | `/config` | `/mnt/cache/appdata/scenenfo/config` |
| Media libraries | `/data/media` | `/mnt/user/data/media` |

SceneNFO needs write access to the media mount when **Apply** mode is used. For initial testing you can mount the media path read-only and use Dry Run.

Example:

```bash
docker run -d \
  --name scenenfo \
  --restart unless-stopped \
  -p 8787:8787 \
  -e TZ=Europe/Berlin \
  -e SCENENFO_CONFIG_DIR=/config \
  -v /mnt/cache/appdata/scenenfo/config:/config \
  -v /mnt/user/data/media:/data/media \
  ghcr.io/mlo-tek/scenenfo:latest
```

Open:

```text
http://UNRAID-IP:8787
```

### Docker Compose from source

```bash
git clone https://github.com/mlo-Tek/SceneNFO.git
cd SceneNFO
docker compose up -d --build
```

The included `docker-compose.yml` uses these default mappings:

```text
/config     -> /mnt/cache/appdata/scenenfo/config
/data/media -> /mnt/user/data/media
```

Default library paths inside the container are:

```text
/data/media/movies
/data/media/tv
```

## First setup

1. Start SceneNFO and open the web UI on port `8787`.
2. Configure your Movies and TV library roots.
3. Configure srrDB, PreDB.club and crowdNFO as required.
4. Add Radarr and/or Sonarr connection details if you want import automation and refresh integration.
5. Run the selected library in **Dry Run** first.
6. Review the results and only then enable **Apply** if the proposed NFO changes are correct.
7. Configure schedules and Discord summaries only if needed.

Internet access is required for PreDB.club, srrDB and crowdNFO lookups.

## Persistent data and secrets

SceneNFO stores its persistent state below `/config` by default:

```text
/config/scenenfo.db
/config/secret.key
/config/logs/
/config/tmp/
```

Sensitive settings are encrypted before being stored in SQLite. This currently includes:

- crowdNFO API key
- Radarr API key
- Sonarr API key
- Discord webhook URL

The local Fernet key is stored in `/config/secret.key`. Back up the complete `/config` directory together so encrypted settings remain recoverable.

## Health check

The application exposes:

```text
GET /api/health
```

Example response:

```json
{
  "ok": true,
  "version": "0.3.31"
}
```

## Development and checks

The GitHub workflow validates the application before publishing the container image. It currently performs:

- Python dependency installation
- Python bytecode compilation
- Regression tests with `unittest`
- Syntax validation of frontend JavaScript with Node.js
- Docker build and GHCR publish after the checks pass

Useful local checks:

```bash
pip install -r requirements.txt
python -m compileall -q app
python -m unittest discover -s tests -v

for file in app/static/*.js; do
  node --check "$file"
done
```

## Project status

SceneNFO is under active development. The current `main` branch includes the modern desktop UI, multiple-library support, targeted Radarr/Sonarr import processing, incremental scanning, path reconciliation, run review/history, Discord weekly summaries and the Recently added dashboard.

For bugs and feature requests, use the GitHub issue tracker.