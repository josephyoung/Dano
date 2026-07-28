<script lang="ts">
  import type { ComposerSubmissionPayload } from "../utils/composerSubmission";
  import type { HistoricalMessageRevisionPayload } from "../utils/messageRevision";

  let {
    activeSessionPath = null as string | null,
    pendingRevision = null as HistoricalMessageRevisionPayload | null,
    onReviseMessage = (_: HistoricalMessageRevisionPayload) => {},
    onCancelRevision = () => {},
    onSubmit = (_: ComposerSubmissionPayload) => true as boolean | Promise<boolean>,
  }: {
    activeSessionPath?: string | null;
    pendingRevision?: HistoricalMessageRevisionPayload | null;
    onReviseMessage?: (payload: HistoricalMessageRevisionPayload) => void;
    onCancelRevision?: () => void;
    onSubmit?: (payload: ComposerSubmissionPayload) => boolean | Promise<boolean>;
  } = $props();
</script>

<div data-testid="active-session">{activeSessionPath}</div>
<div data-testid="pending-revision">{pendingRevision?.entryId ?? "none"}</div>
<button
  type="button"
  data-testid="begin-revision"
  onclick={() => onReviseMessage({
    entryId: "history-node-a",
    text: "historical message",
    images: [],
  })}
>
  Begin historical edit
</button>
<button type="button" data-testid="cancel-revision" onclick={onCancelRevision}>
  Cancel historical edit
</button>
<button
  type="button"
  data-testid="submit-revision"
  onclick={() => onSubmit({
    message: "edited historical message",
    images: [],
    files: [],
    revisionEntryId: pendingRevision?.entryId,
    steer: false,
  })}
>
  Submit historical edit
</button>
