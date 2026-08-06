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
Source-controlled files used to initialize the Agent Config Directory only when the corresponding runtime file is missing. The system-prompt template is rendered with the deployment's effective product name. Ordinary starts preserve existing host-managed files; an explicit Release Build synchronizes the system prompt atomically before starting the new app image.
_Avoid_: Runtime state, generated config

**Pi Package Seed**:
Image-owned Pi packages installed with `pi install` during the image build and activated into the persistent Agent Config Directory without runtime downloads. Existing operator-managed packages with the same identity take precedence.
_Avoid_: Runtime package installation, copied skill source

**Local Search Daemon**:
The loopback-only `open-websearch` process started and supervised with the Dano app on every normal container start. It becomes ready before Dano starts and shares the container lifecycle without exposing a Compose port.
_Avoid_: Sidecar, public search endpoint
