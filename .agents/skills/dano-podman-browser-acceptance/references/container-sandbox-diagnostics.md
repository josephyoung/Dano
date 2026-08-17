# Container Sandbox Diagnostics

Use this reference when Podman deployment is healthy but a Heimdall-backed model tool cannot run `bash`.

## Prove the deployed boundary

Inside the running app container, verify as the deployed app user:

1. the installed `bwrap` binary and effective capabilities;
2. the active per-User Runtime Workspace and its entry in `/proc/self/mountinfo`;
3. one minimal bwrap invocation that binds and write-tests that exact workspace, then runs a harmless `pwd` or `ls`;
4. the same operation through a real model-triggered `bash` tool call in the rendered Dano transcript.

Do not test only `/opt/dano/runtime-data/workspaces`, a legacy named-volume mount, or another convenient directory. Those paths can pass while the current User workspace still fails. Make the shell fail on the bwrap exit status before printing a success marker.

The direct preflight diagnoses the container boundary; only the model turn proves the shipped integration. App health, OAuth success, or direct model HTTP 200 does not replace either check.

## Diagnose macOS Podman mounts

A host directory under `/private/tmp` or `/Users` is exposed to the Podman VM through virtiofs. Bubblewrap can then fail while recursively remounting a deep workspace with `Unable to remount destination ... with correct flags`.

Before changing Heimdall, run a controlled A/B using the same image, Bubblewrap command, UID, capabilities, and nested workspace path:

- host bind/virtiofs runtime;
- Podman named-volume runtime.

If only virtiofs fails, the fault is the local runtime mount layout, not the Heimdall policy. Move `DANO_RUNTIME_DIR` to a uniquely named Podman volume and recreate the app container. Do not add capabilities, disable Heimdall, bind a shared Users root, or treat a different mountpoint as proof.

## Interpret other startup failures

Errors mentioning `privileged_op_socket`, bind mounts, `devpts`, namespace creation, or seccomp describe different sandbox boundaries. Compare the installed Heimdall version and documented container requirements with the effective Compose configuration.

Treat `privileged: true`, disabled seccomp, or disabled SELinux labeling as explicit security-boundary changes. Test them only with user authorization and never persist them silently as the default fix. If no stable supported seam exists, stop the runtime gate as failed and open a focused follow-up rather than exposing an unsandboxed shell.

## Completion evidence

Record only non-sensitive evidence:

- app image/version and non-root UID;
- active workspace mount type;
- direct bwrap preflight exit status;
- rendered model-triggered bash outcome;
- the exact temporary named volume removed during cleanup.
