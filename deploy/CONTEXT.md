# Deployment

Deployment defines how Dano is built, packaged, configured, and operated as a containerized service.

## Language

**Release Build**:
A deployment flow that builds a Dano image from a disposable source checkout, copies deploy inputs, starts the prebuilt image, and runs smoke validation.
_Avoid_: Source deploy, live checkout deploy

**Deploy Control Directory**:
The host directory that stores Compose files, `.env`, secrets, and nginx config for production operation.
_Avoid_: Source checkout, runtime data

**Runtime Data Directory**:
The host directory mounted into the app container for Dano runtime state that must survive container recreation.
_Avoid_: Deploy directory, source checkout

**Agent Config Directory**:
The Pi global agent directory selected by `PI_CODING_AGENT_DIR`, where Dano stores shared agent settings and system prompt files for all Runtime Workspaces.
_Avoid_: Runtime Workspace, user home, project `.pi`

**Runtime Defaults**:
Source-controlled files used to initialize the Agent Config Directory only when the corresponding runtime file is missing. The system-prompt template is rendered with the deployment's effective product name. Release Builds and ordinary starts preserve existing host-managed files.
_Avoid_: Runtime state, generated config

**Two-phase Switch**:
The app/nginx release and rollback order that keeps the current nginx online, replaces only the app, waits for its healthcheck, and then replaces nginx. It preserves adjacent services, named volumes, Runtime Data, and Agent Config.
_Avoid_: Aggregate Compose up, full-stack restart

**OAuth Relay Namespace**:
The `/admin-api/` browser and upstream namespace forwarded unchanged to a deployment-configured OAuth provider origin. Provider asset, logo, and favicon references are rewritten back into the namespace.
_Avoid_: Hardcoded provider origin, root `/assets/`

**Agent Skill Seed**:
Image-owned skills installed with the upstream `skills` CLI during the image build, then copied into Pi's persistent global skill directory without runtime downloads or `settings.skills` changes. Existing operator-managed skills with the same name take precedence.
_Avoid_: Runtime skill download, Pi package seed

**Local Search Daemon**:
The loopback-only `open-websearch` process started and supervised with the Dano app on every normal container start. It becomes ready before Dano starts and shares the container lifecycle without exposing a Compose port.
_Avoid_: Sidecar, public search endpoint

**Production Authentication Gate**:
The configuration-only server entrypoint executed directly against the exact Release Build image before Compose replaces running containers. It applies the server's production parser, actively validates every provider TLS origin's certificate chain and hostname, and exits without Agent Config initialization, Local Search Daemon startup, Runtime loading, or a listener. A failed gate leaves the running deployment unchanged.
_Avoid_: Demo authentication initialization, smoke-only configuration check
