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

## Candidate upgrade and matched rollback rehearsal

A third isolated stack began with Dano `0.2.34` and
`@josephyoung/pi-openviking@0.1.8`, plus the same fixed official OpenViking
`v0.4.20` and Embedding image. Its volumes and OpenViking account were new.
The in-app Browser completed OA SSO, found both memory switches off, enabled
only explicit memory, saved the synthetic `枫桥31` fact to ready, and recalled
it from a separate chat. With OpenViking then stopped, a second `溪桥82` save
entered `session_unknown`. All six volumes and private deploy-control files
were exported after stopping Dano, nginx and Embedding. The private baseline
manifest at `/private/tmp/dano477-upgrade-baseline.189h5urv/manifest.json`
records the seven archive hashes. The baseline state had one ready operation
and one pending `session_unknown` operation.

The same stack's app was recreated with the actual `0.2.35` candidate image
(`8b1524835ee3`), keeping the old volumes and fixed OpenViking version. The
old ready fact remained visible in management and a fresh MiMo chat answered
`枫桥31`. The old offline task became “结果待核实” and was **not** blindly
resent; its remote session had never been confirmed. This is a safe ambiguity
outcome, not a successful old-queue delivery. The candidate then saved a new
synthetic dark-blue chart preference to ready. Its operation, document URI,
digest and content were recorded in a private upgrade-window reconciliation
file outside the old snapshot, alongside stopped candidate data and OpenViking
archives.

For matched rollback, a fourth isolated stack imported the **old** six-volume
snapshot into fresh volumes and ran the old `0.2.34` image (`ff9dcbf3d807`).
Before Dano started, the USER-bound replay command checked the restored
owner-state hash and public document set: the old profile remained, while the
candidate-window document and source were absent. The physical profile file
had one trailing newline that OpenViking's public read omits, so its replay
ledger used the exact public body. Browser management showed the old ready
fact and the unresolved old queue. The new ready operation was not silently
carried into the old state; its synthetic fact was explicitly resubmitted from
the private reconciliation file through the old browser/model/tool path,
reached ready under a **new** operation ID, and a fresh chat answered both
`枫桥31` and the dark-blue preference. This demonstrates data-matched rollback
and explicit reconciliation of one synthetic upgrade-window operation. It does
not establish automatic operation migration or a production-safe resubmission
policy for arbitrary users.

Compatibility observed in this rehearsal: the `0.2.34`/`0.1.8` owner-state
version 1 and OpenViking `v0.4.20` data were readable by `0.2.35`/`0.1.11`;
the reverse path used the old snapshot and reissued the one newer operation.
No OpenViking storage-format migration was exercised. The old ambiguous queue
exposed a genuine extension recovery gap before #477 can pass.

The gap was reproduced in two tests: a Session creation that failed before
OpenViking accepted it left `session_unknown` forever, and pause after that
failure left the payload pending across a new authorization epoch. The
`pi-openviking@0.1.12` fix retries only creation of the **same empty Session
ID** after USER-scoped absence and checks current authorization before that
mutation. It does not retry an unknown message append or commit. The two tests
were red on 0.1.11 and green on 0.1.12; all 252 extension tests passed. A
one-off container from the candidate image with local 0.1.12 bits advanced
the *actual old snapshot operation* against fixed OpenViking `v0.4.20` from
`session_unknown` through `session_created`, `message_delivered`, `processing`
to `ready`, with the original Session ID and one memory document. Extension
PR [#10](https://github.com/josephyoung/pi-openviking/pull/10) merged;
Trusted Publisher run `35879801711` succeeded and published 0.1.12. Dano's
frozen lockfile installed the exact registry tarball after npm CDN propagation.
The complete protected image `5dddd4a48172` reports Dano `0.2.35`, exact
extension `0.1.12`, both Pi keywords and the replay command. A fresh fifth
isolated stack imported the **old** six-volume snapshot, started the fixed
OpenViking/Embedding services and this formal image, then passed real in-app
Browser acceptance: the old pending `溪桥82` task became “已记住”, its profile
document retained the earlier `枫桥31` fact, and a new MiMo chat correctly
answered both codes. This closes the specific session-creation old-queue
recovery gap, without changing the separate upgrade-window reconciliation
policy requirement.

## Frozen evaluation baseline, 2026-09-24

The 80-case synthetic dataset was committed as
[`issue477-evaluation.json`](fixtures/issue477-evaluation.json) at `5616f135`
before executing it. It fixes 20 recall, 10 correction, 20 isolation,
10 deletion, 10 irrelevant-request and 10 authorization cases, with three
repetitions each; the five-user/100-request workload, model, machine,
configuration, official MiMo list prices and acceptance thresholds are also
frozen there. The tested Podman VM had four CPUs and 4,076,376,064 bytes of
RAM. MiMo-v2.5 extraction of the five four-fact source Sessions completed in
87.2–95.1 seconds, producing one to four documents per synthetic owner.
This is batch extraction timing, not the single-fact explicit-save p95 metric.

The real OpenViking `v0.4.20` USER-key run produced these sanitized per-attempt
files: [recall](evidence/issue477-baseline/recall.json),
[isolation](evidence/issue477-baseline/isolation.json) and
[irrelevant requests](evidence/issue477-baseline/irrelevant.json).
All 60/60 recall searches found a document containing the expected fact and
none returned the next owner's forbidden value; this is source retrieval,
not a Dano/MiMo answer-correctness result. All 60/60 cross-user probes kept
the target user's content and state isolated. Search, read, write and tree
export returned 403 in 48 probes. The 12 same-named Session-message probes
returned 200 because OpenViking wrote to the caller's own Session namespace;
the target Session context was unchanged, and the caller's context contained
its synthetic marker without the target fact.

The initial relevance configuration **failed** its fixed requirement:
0/30 irrelevant-request repetitions would avoid injection. Every real search
returned at least one memory above the configured `minimumScore=0.1`; the
published extension's context hook selects those entries under its token
budget. This is a measured selection outcome, not 30 completed Dano chats.
The irrelevant top scores ranged 0.354–0.535, while relevant top scores ranged
0.396–0.755. A single higher vector-score cutoff would also discard some
required facts. The candidate therefore needs a separately frozen and tested
relevance stage; these failed baseline results remain part of the record.

The formal `0.2.35`/`0.1.12` Browser regression also completed ordinary
MiMo text chat, a model-triggered `bash ls` tool call, a real upload of the
fixed synthetic `shapes.png` (model identified red circle, blue square and
yellow triangle), and an `ask_user_question` radio card submitted as
“咖啡” and returned to the model. These observations do not cover the remaining
Skill, Field Assist, Heimdall, dual-user or 100-request gates.

## Candidate 2: bounded local reranking

The first relevance repair used Dano `0.2.36`, exact pi-openviking `0.1.12`,
the same OpenViking/Embedding versions and a separately pinned upstream
llama.cpp reranking service. Its `bge-reranker-v2-m3-Q4_K_M` asset has SHA-256
`e186a244ed455b4ab66ec64339ce7427a6ae13f5c0b5e544de96e50f0f8b3673`.
The unchanged 80-case dataset and the new private limits were frozen in
[`issue477-evaluation-candidate2.json`](fixtures/issue477-evaluation-candidate2.json)
before formal execution. OpenViking `v0.4.20` `/find` is a QUICK vector path,
so merely enabling its server-side reranker cannot affect this extension's
recall. Dano reranks USER-scoped candidates before injecting them, and a
missing, timed-out or malformed reranking response omits memory for that
request. The published extension and user-bound credential scope are unchanged.

The formal image `46443b7b95aa` started with the private reranker configuration.
All 143 Vitest files passed (1,655 tests, one skipped); type/Svelte checks had
no diagnostics. The [candidate 2 retrieval results](evidence/issue477-candidate2/formal-retrieval.json)
contain 90 attempts: 60/60 expected source documents selected, 30/30
irrelevant requests selected no memory, no cross-owner forbidden fact, and
search plus reranking p95 324.45 ms. In the real in-app Browser, a fresh
MiMo chat answered both stored upgrade codes after restart; an unrelated
arithmetic chat returned 45. These are Browser observations, while the
per-attempt file records service selection, not 90 Dano model answers.

The first [five-user, 100-request selection probe](evidence/issue477-candidate2/five-user-selection.json)
then exposed a concurrency flaw: reranking all five vector candidates with
the 750 ms timeout selected only 7/70 relevant facts. 30/30 irrelevant
requests omitted memory; steady selection p95 was 962.5 ms. This is a
supplemental memory-selection workload, **not** the Spec's 100 complete user
requests or a release pass. The failure is retained. The fixed corpus's
expected fact was already in the first vector result for 20/20 distinct
recall cases. Exploratory probes capped reranking at two candidates and used
a 900 ms timeout; 70/70 relevant and 30/30 irrelevant requests then selected
correctly, with steady selection p95 793.64 ms. A separately frozen candidate
must still implement and repeat that result, including Dano host overhead.

## Candidate 3: frozen bounded retrieval retest

The unchanged 80-case dataset and the two-candidate, 900 ms reranker limits
were frozen in [`issue477-evaluation-candidate3.json`](fixtures/issue477-evaluation-candidate3.json)
at `cd064666` before the formal rerun. Dano `0.2.37` limits both the USER-scoped
OpenViking `/find` request and the local reranker input to two candidates. The
protected image `8cb0ff821faf` installed the exact published
`pi-openviking@0.1.12`. Its running package metadata included both required
Pi keywords. All 143 Vitest files passed (1,657 tests, one skipped), and the
server and Svelte checks had no diagnostics.

The [formal retrieval results](evidence/issue477-candidate3/formal-retrieval.json)
record all 90 unchanged recall and irrelevant-request attempts across three
repetitions. Expected source selection was 60/60, irrelevant requests selected
no memory in 30/30 attempts, and no next-owner forbidden fact was read.
USER-scoped search plus reranking p95 was 223.25 ms; reranking alone p95 was
209.41 ms. The [five-user concurrent selection results](evidence/issue477-candidate3/five-user-selection.json)
record 100 attempts: relevant selection 70/70, irrelevant omission 30/30,
first-round p95 690.97 ms and steady selection p95 817.31 ms. That workload
uses real OpenViking and reranker requests on the four-CPU isolated Podman VM,
but it does **not** include five complete Dano/MiMo user requests, model token
usage, extraction cost, or Dano host overhead. It cannot satisfy the Spec's
full latency and cost release gate by itself.

The real in-app Browser on the running `0.2.37` image completed OA-backed
MiMo chats through the fixed trusted `https://localhost:18711/` entry. In a
fresh chat it answered both stored upgrade facts, `枫桥31` and `溪桥82`; a second
fresh chat answered the unrelated `19×23` request as `437`, with no memory fact
in the visible answer. This is direct model/browser evidence for those two
requests, not a 60/30 model-answer audit.

## Remaining release gates

- Package and validate the recovery procedure as a repeatable command,
  including deletion/revocation records across arbitrary rollback points.
- Define and test the multi-user upgrade-window reconciliation policy beyond
  one controlled synthetic resubmission.
- Retain the failed vector-only and candidate-2 concurrency results alongside
  the candidate-3 passing selection evidence; finish full model-answer review.
- Complete correction, deletion and authorization cases three times each,
  model-answer review, the 100-request latency/token/cost workload and the
  independent dual-user in-app Browser scenario.
- Complete Skill, Field Assist and Heimdall Browser regression, the AC/T audit,
  and controlled test-resource cleanup.

No production deployment or release conclusion is implied by this record.
