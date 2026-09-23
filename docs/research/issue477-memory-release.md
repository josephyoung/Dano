# Issue 477: release and acceptance record

## Fixed candidate

The candidate manifest is `deploy/memory-release.json`; the Dano image build
uses a frozen pnpm lockfile and an exact npm dependency. On 2026-09-23, the
official `ghcr.io/volcengine/openviking:v0.4.20` multi-platform index resolved
to `sha256:b9827753d035f4157b5b318865907fd18f738924ad6398c86feb1182f209825b`.
Its Linux arm64 manifest was
`sha256:d1f3730128f3bde654e7996a88909cb47e4ec08d407806a464da5d91aa64c870`
and amd64 manifest was
`sha256:571fb4e12c66365d3552464617cc9aee8edbdec63e0f7d3ced3beb19db15b742`.
The isolated rootful Podman VM is Linux arm64; its pulled image inspection
confirmed the index digest, platform and upstream entrypoint.

The candidate overlay `deploy/compose/memory.yml` mounts protected config,
model asset and persistent data separately, keeps ports 1933/8080 unpublished,
and keeps the model-provider egress separate from Dano's internal memory
network. Its independent official llama.cpp `b11118` image is pinned to index
`sha256:fb8f521cdfee1b763a6ef0d6633922e780c1393c03b49945526550cf55010343`.
The GGUF checksum is
`ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c`.
`node scripts/check-memory-release.mjs` and its deployment mode passed with a
private synthetic test configuration. Full Compose interpolation passed without
printing its secret environment.

## Executed official-image probe

The first isolated container used the prior, locally successful GGUF
`embedding.dense.provider=local` configuration. Its official image reported
that `llama-cpp-python` was absent, and `/health` did not become ready. This is
a real deployment incompatibility, not an OpenViking API failure. The container
was stopped. The candidate uses an independently pinned upstream llama.cpp
Embedding service. It returned a real 512-dimensional vector for a synthetic
Chinese query. The first OpenViking start with this service also showed that
Podman-injected HTTP proxy variables intercepted internal DNS; the overlay now
sets `NO_PROXY`/`no_proxy` for the internal service names, with a deployment
override for any model-provider hostname that needs direct TLS. The rebuilt
OpenViking service answered its internal `/health` with HTTP 200. A patched
private OpenViking image or runtime `pip install` is not used.

The real, isolated model probe then created a synthetic account and USER key,
wrote one preference message, committed it, and observed the task finish in
30.2 seconds. A USER-scoped search found both the synthetic code word and
Simplified-Chinese preference. The probe used MiMo-v2.5 for extraction and the
512-dimensional local Embedding service; it printed status only and stored its
test USER key in the mode-0600 isolated data volume. This is one functional
sample, not the fixed evaluation set or p95/cost gate.

## Clean Dano/Browser probe and upstream release blocker

A second isolated Compose project, `dano477-clean`, started from empty Dano and
OpenViking volumes, with the official OpenViking and llama.cpp images and the
candidate Dano image. HTTPS `https://localhost:18711/` used the persistent
trusted localhost certificate. The existing Codex in-app Browser completed
production-OA SSO into this isolated Dano account. Both memory switches were
initially off. Explicit memory consent left automatic collection off. A real
MiMo-v2.5 `memory_save` moved from processing to ready; a new browser chat
recalled the synthetic code word `青松47`. The management UI showed source,
timestamp and current status.

This probe exposed two release blockers in `pi-openviking@0.1.8`:

1. One explicit save produced two documents. Correcting the code word removed
   the unrelated language-preference document because both shared the same
   upstream source session. The old extension lacked a durable copy of that
   independent document before source removal. An isolated public OpenViking
   API probe confirmed that `content/write` can recreate the missing user-bound
   document, and a local extension change now stages a bounded, classified
   preservation plan before deleting the source. A unit test covers a lost
   deletion reply, restart and unrelated-document restoration. The temporary
   image then corrected `银杏93→银杏94` while preserving the separate Simplified
   Chinese preference document. Its initial source URI still contained the old
   code word, so the candidate now relocates exclusive retained documents to
   opaque user-bound URIs and labels their source as preserved after correction.
   A further isolated real-service correction of `松柏95→松柏96` completed and
   relocated two documents, including the independent language preference.
   The Dano image pinned to published 0.1.9 displayed the preserved source
   status and the two opaque document URIs in the real Browser. This revealed
   another correction flaw: the extracted document title still said `松柏95`
   although its body said `松柏96`. A new chat using MiMo answered the current
   code correctly but explicitly identified the conflicting old title. The
   0.1.10 extension guard rejects such a partial correction before any remote
   mutation and requires selecting a complete passage. PR #8 was merged and
   published. A full-content correction then exposed a second issue: moving
   the document URI again left an earlier completed job's source reference
   stale, so the task safely remained in `applying`. The local 0.1.11 candidate
   updates historical URI lineage. In the real isolated service the persisted
   task recovered to complete after restart, the browser refused a subsequent
   narrow `松柏96→松柏97` edit, and full-content correction completed. A fresh
   MiMo chat answered only `松柏97`, with no conflicting old memory. The
   independent Simplified-Chinese preference remained in export. PR #9 was
   merged and 0.1.11 appeared in the npm registry. The fixed image built and
   its running package version was confirmed as 0.1.11 with Pi keywords. The
   in-app Browser showed the current `松柏97` document and independently
   preserved language preference in anonymous owner-bound URIs.
2. A second save's OpenViking `session_commit` task completed and produced one
   update, but the old extension stayed at processing. It searched the original
   prompt with a result limit equal to the one changed document; an older
   related memory could rank first indefinitely. A real public API probe found
   the changed document through a search targeted at its validated USER URI.
   The local extension change uses that search for ready verification. The
   long retry period exhausted the configured bounded attempts before the
   change was running; local code now performs one read-only reconciliation
   of such exhausted processing tasks when a user runtime restarts. It never
   replays the original append or commit. In the real Browser, the previously
   blocked task changed to **ready** at 20:00:16 after the temporary 0.1.9
   image restarted, and its content was visible in the management list.

The extension fixes were merged as pi-openviking PRs #7, #8 and #9. Versions
0.1.9, 0.1.10 and 0.1.11 were published through npm Trusted Publisher with
provenance. All 250 package tests passed. The complete Dano suite passed with
Node 22 and the tested Python environment at reduced Vitest concurrency:
142 files, 1651 passed and one skipped. A first run with Node 24 failed to
load the Node 22 `fs-ext` native module; a Node 22 run at default parallelism
had one release-gate timeout, which passed alone and in the bounded full run.
With the tested Python virtual environment on `PATH`, Dano's full suite passed
142 files, 1651 tests and one skip; the host's default Python lacked `httpx`.

## Stopped-stack recovery and post-snapshot deletion

On 2026-09-23, the isolated `dano477-clean` stack was stopped before exporting
all six named volumes and the private deploy-control directory. The private
snapshot manifest at `/private/tmp/dano477-release-backup.iHNEgV/manifest.json`
records SHA-256, byte length and entry count for each archive; the snapshot
directory is mode 0700 and archives are mode 0600. The protected config archive
includes the OA/client configuration, TLS trust material and memory-service
configuration; the protected data archive includes encrypted USER credentials,
owner state, queue and source mappings. This is a local synthetic test backup,
not a production backup.

After the snapshot, a real in-app Browser action forgot the full synthetic
`松柏97` profile document. The completed governance job removed two old document
URIs and its source session while preserving the independent Simplified-Chinese
preference. A separate post-snapshot deletion ledger and owner-state overlay
were saved outside the older snapshot. The ledger records owner, removed URIs,
source IDs, expected current documents and the retained document body. It
contains no API key or removed fact text. The state overlay SHA-256 was checked
after import into a second set of volumes named `dano477-restore-*`.

The older OpenViking archive was imported unchanged into the second volume:
both deleted URI files were present before replay. Only internal OpenViking and
Embedding services were started. With Dano and nginx still stopped, a USER-key
client removed the old source and URIs, rewrote the retained preference, and
checked the three expected public documents. OpenViking's physical Markdown
file includes an internal `MEMORY_FIELDS` trailer; public read/write returns
only the document body, which the replay used. A first attempt compared the
physical trailer to the public readback and failed safely before Dano start;
the corrected idempotent replay passed. A USER-scoped recall of the forgotten
code returned no deleted fact. The replay result reported two deleted URIs,
one removed source, one preserved document and no recalled deleted fact.

Only after this readback were restored Dano and nginx started at the fixed
`https://localhost:18711/` entry. Browser management showed the preserved
preference and the two default documents, with no forgotten profile document.
A fresh chat said it did not know the code and used Simplified Chinese; a
second fresh chat used `memory_export`, found no code, and completed without
the old fact. The first chat also displayed `SUPERVISOR_OPERATION_FAILED`
despite a final answer; a minimal ordinary chat and the second memory query
completed normally. This transient error remains under investigation and is
not counted as a clean regression pass. A pre-deletion historical chat still
renders its historical answer; §11.1 explicitly distinguishes that transcript
from new-memory resurrection.

This exercise proves the local snapshot and replay sequence for one synthetic
deletion. A supported, repeatable backup/replay command, upgrade and matched
rollback rehearsal, independent owner revocation, and the full evaluation
remain release gates.

The candidate protected image now includes
`apps/dano/runtime/replay-memory-deletions.mjs`. Against the stopped restored
app it rejected a changed post-browser owner state with
`POST_SNAPSHOT_STATE_MISMATCH` before mutation. Restoring the exact
post-snapshot owner-state overlay and rerunning the same command passed with
two deleted URIs, one removed source, one retained document and three expected
documents. This is a tested per-owner replay step; the general ledger capture,
revocation and matched rollback procedure still need their release rehearsal.

## Remaining release gates

- Package and validate the recovery procedure as a repeatable command,
  including deletion/revocation records across arbitrary rollback points.
- Exercise candidate upgrade plus matched image/data rollback, old queue and
  upgrade-window operations, documenting format compatibility and retention.
- Run the fixed 20/10/20/10/10/10 evaluation cases three times each, the
  100-request latency/token/cost workload, and the independent dual-user
  in-app Browser scenario. Complete the broader regression and AC/T audit.

No production deployment or release conclusion is implied by this record.
