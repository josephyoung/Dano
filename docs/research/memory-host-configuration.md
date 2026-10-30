# Memory configuration

Issue #539 consolidates configuration by responsibility. These are the only
operator inputs; generated projections are not configuration entry points.

| Input | Authority |
| --- | --- |
| Agent Config Directory `settings.json` | Pi `defaultProvider`, `defaultModel`, `defaultThinkingLevel` |
| `dano.config.json.openVikingSettings` | Memory enablement, service endpoints, budgets, timeouts, collection policy, generation limits, embedding and reranker parameters |
| Existing Pi provider credentials / deployment Secrets | Provider authentication, resolved by Pi `ModelRuntime.getAuth` |
| Private `memory-secrets.json` | Existing OpenViking account/management credential and Dano encryption key/version only |

There is no `memoryModel`, memory API key or configurable tokenizer binding.
`memory-service.defaults.json` and the old private functional configuration
reader have been removed. `MemoryHostConfig` is an internal validated resolved
object; its versioned parser is not a file-based operator interface.
`memory-release.json` locks deployable artifacts/digests, not functional defaults.
Its tokenizer counterpart is release-owned provenance in
`apps/dano/src/bridge/tokenizer-catalog.json`, not an administrator-maintained
copy of the selected model.

## Resolution and activation

The protected host resolves the Agent Config Directory using the server's
normal options parser, initializes only missing Runtime Defaults, and reads
**that directory's global settings file directly**. It never consults a User's
Runtime Workspace, `.pi/settings.json`, session selection or thinking override
for background collection/extraction. The resulting model configuration is a
startup snapshot. Existing settings are never overwritten by the new `off`
Runtime Default. `off` means disabled thinking, not guaranteed zero latency.

The same resolver validates the model, provider API key, supported adapter,
functional settings and exact tokenizer binding in deployment and startup.
Only compatible OpenAI completion adapters with API-key authentication are
currently projected into OpenViking. Unsupported models, header-only/OAuth
adapters, unknown fields, duplicate model/key inputs and missing credentials
fail activation. No fallback model/tokenizer or implicit memory disablement
repairs an invalid enabled configuration. Safe errors identify a phase and code,
for example `credentials:MEMORY_PROVIDER_API_KEY_REQUIRED`.

The release-owned tokenizer catalog pins official publisher repositories,
revisions and SHA-256 values. `install-memory-tokenizers.mjs` prepares the assets
explicitly, reuses verified files, and refuses corrupt assets. Startup performs
no downloads. The initial catalog covers MiMo V2.6 Flash on official Xiaomi
origins and DeepSeek V4.1 Flash (`deepseek-flash`) on its official origin:

- [Xiaomi tokenizer source](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL/tree/f657ba2f7d24c9adc5730675baaa2d34de878a49)
- [DeepSeek tokenizer source](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/314113f8a7dadb388215396ba5fbee2c610a04d6)

Other models and proxy aliases require verified catalog support before use.
The actual receiving chat model is passed to token counting; it is never
replaced by the background default. The browser's model-switch command checks
compatibility before mutating the selected model. Restored sessions also retain
strict exact-model counting; there is no cross-model budget fallback.

## Explicit transition from the former private configuration

Do this under the deployment lock, before the candidate release preflight.
Do not change running containers until all checks pass. Keep rollback copies
on the host with restricted permissions. Never print private JSON or use shell
arguments containing credentials.

1. Transfer the old non-secret policy, scheduler, collection, embedding,
   reranker and tokenizer resource limits into the **single** target
   `dano.config.json.openVikingSettings`. Preserve existing values rather than
   replacing them with new defaults. Set `enabled: true` for an enabled service.
   Move `memoryModel.generation.maxTokens` and `.temperature` into `generation`;
   omit the old generation thinking field and all model/tokenizer overrides.
   A former version-1 `collection.model` must likewise be removed after its
   non-model limits have been retained. Review this non-secret diff.
2. Explicitly configure Pi's existing global `defaultProvider`, `defaultModel`
   and `defaultThinkingLevel`. These are now the only LLM choices. Preserve
   host-managed settings unless their update is part of the release scope.
3. Keep provider keys in the existing Pi/deployment Secret source. Confirm the
   chosen provider resolves its credential without transferring the old
   extraction key into either JSON configuration.
4. With `umask 077`, extract only `accountId`, `managementKey`, `encryptionKey`,
   `encryptionKeyVersion` from the old private file into `memory-secrets.json`.
   Preserve values exactly, including account and encryption version. Use the
   existing host UID/GID, directory mode 0700 and file mode 0600. For a new
   installation, the same four fields in temporary `memory-secrets.inputs.json`
   can be published atomically by `init-memory-service.mjs`. No functional
   defaults or LLM credentials are read from this bootstrap input.
5. Run the candidate image's asset installer with the private directory mounted
   read-write, then its model projection `sync` and independent `check`. These
   commands use the same effective settings, credential resolver and real
   tokenizer workers as startup. Ordinary runtime mounts remain read-only.
6. Keep the old file only as a protected rollback archive, outside the active
   configuration directory. It is never a runtime fallback. Preserve owner
   mappings, authorizations, encrypted user credentials, memory/recovery volumes
   and all encryption material. This change does not migrate or delete them.

For example, the secret-only extraction can be performed locally on the target
host without emitting any credential to the terminal:

```sh
umask 077
jq '{accountId,managementKey,encryptionKey,encryptionKeyVersion}' \
  /etc/dano-memory/memory-service.json > /etc/dano-memory/memory-secrets.inputs.json
node deploy/init-memory-service.mjs /etc/dano-memory
node deploy/install-memory-tokenizers.mjs /etc/dano-memory
```

The initializer validates inputs and publishes only a missing secret file. It
preserves existing bytes/inodes and refuses unsafe paths. Remove only the
bootstrap file created for this operation after successful publication.

## Projections and restarts

Run from `/app` in the candidate image, with the real global Agent Config
Directory mounted at `PI_CODING_AGENT_DIR` and existing provider Secret environment
injected. Mount the private memory directory at `/etc/dano-memory`, the
OpenViking control directory and deploy control directory for these helpers:

```sh
node deploy/memory-models.mjs preflight /etc/dano-memory
node deploy/memory-models.mjs sync /etc/dano-memory /etc/openviking/ov.conf /deploy/.env
node deploy/memory-models.mjs check /etc/dano-memory /etc/openviking/ov.conf /deploy/.env
```

`sync` validates all inputs and tokenizer workers before writing either output;
`check` refuses stale/mixed outputs. Only allowlisted model variables in `.env`
are projected, preserving other credentials. The OpenViking API key is an
unavoidable protected generated copy for its downstream client: the mode-0600
`ov.conf` is generated before activation, mounted read-only by OpenViking,
replaced on the next explicit sync, and never copied into source/image/logs.
OpenViking VLM thinking is projected through its
[documented request-body settings](https://github.com/volcengine/OpenViking/blob/v0.5.2.1/docs/en/guides/01-configuration.md).

`deploy:release` invokes secret initialization, then projection `sync`/`check`
before container replacement. A memory-enabled release recreates app and its
model-service dependencies so file changes cannot leave OpenViking on the prior
startup snapshot. Prepare tokenizer assets before release; failures leave the
running service intact. Mounted settings/auth changes require explicit projection
and service recreation. Compose environment changes require recreation, not only
`restart`. Product JSON baked into the image requires a rebuild; an explicitly
mounted replacement needs recreation only. There is no configuration hot reload.

## Browser exposure and acceptance

Vite loads an explicit virtual module containing only the product-name fallback.
The raw JSON never enters the browser module graph and its dev URL is blocked.
The server runtime-config projection separately allowlists browser fields.

Automated verification covers resolution, private inputs, duplicate-source
rejection, global/session boundaries, startup snapshots, asset integrity,
projection and pre-switch validation. Real-browser release acceptance must
additionally demonstrate cross-session recall and collection/save reaching
`ready` after a configuration switch, plus plain text, image interpretation and
`bash ls`. Unit tests/builds do not prove those live outcomes. No production
configuration or user memory is changed by this implementation alone.
