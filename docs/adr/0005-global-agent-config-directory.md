# Store shared Pi configuration in the global agent config directory

Status: Accepted
Date: 2026-07-02

Dano stores shared Pi configuration in the Agent Config Directory selected by `PI_CODING_AGENT_DIR`, not in each Runtime Workspace. Runtime Workspaces stay disposable per-session project folders, while `SYSTEM.md`, `settings.json`, and `heimdall.json` live under the persistent runtime data root. Missing files are initialized from source-controlled runtime defaults; the `SYSTEM.md` template is rendered with the resolved product name during that initialization.

Existing files in the Agent Config Directory are host-managed persistent runtime configuration. Application and container startup must not overwrite them. An operator can edit `SYSTEM.md` in the host persistence location, and a deployment that changes an existing assistant identity must update that file explicitly rather than relying on application startup to regenerate it.

This avoids duplicating default `.pi` files into every generated `ws_<random>` workspace while preserving Pi's documented global/project override model. A future single-session override can still use a project `.pi` file, but the default path is global configuration plus isolated Runtime Workspaces.
