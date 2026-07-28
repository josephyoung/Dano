<script lang="ts">
  import type { HistoricalMessageRevisionPayload } from "../utils/messageRevision";

  let {
    activeSessionPath = null as string | null,
    pendingRevision = null as HistoricalMessageRevisionPayload | null,
    onReviseMessage = (_: HistoricalMessageRevisionPayload) => {},
    onCancelRevision = () => {},
  }: {
    activeSessionPath?: string | null;
    pendingRevision?: HistoricalMessageRevisionPayload | null;
    onReviseMessage?: (payload: HistoricalMessageRevisionPayload) => void;
    onCancelRevision?: () => void;
  } = $props();
</script>

<div data-testid="active-session">{activeSessionPath}</div>
<div data-testid="pending-revision">{pendingRevision?.entryId ?? "none"}</div>
<button
  type="button"
  onclick={() => onReviseMessage({
    entryId: "history-node-a",
    text: "historical message",
    images: [],
  })}
>
  Begin historical edit
</button>
<button type="button" onclick={onCancelRevision}>Cancel historical edit</button>
