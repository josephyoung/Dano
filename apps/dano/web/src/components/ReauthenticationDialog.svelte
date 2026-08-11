<script lang="ts">
  import * as Alert from "./ui/alert";
  import * as AlertDialog from "./ui/alert-dialog";
  import { t } from "../i18n";

  let {
    open,
    onCancel,
    onConfirm,
  }: {
    open: boolean;
    onCancel: () => void | Promise<void>;
    onConfirm: () => void;
  } = $props();

  let cancelPending = $state(false);
  let cancelFailed = $state(false);
  let dialogOpen = $state(false);

  $effect(() => {
    dialogOpen = open;
  });

  function keepRequiredDialogOpen(nextOpen: boolean) {
    dialogOpen = open ? true : nextOpen;
  }

  async function continueAnonymously() {
    if (cancelPending) return;
    cancelPending = true;
    cancelFailed = false;
    try {
      await onCancel();
    } catch {
      cancelFailed = true;
    } finally {
      cancelPending = false;
    }
  }

  function cancel(event: MouseEvent) {
    event.preventDefault();
    void continueAnonymously();
  }

  function confirm(event: MouseEvent) {
    event.preventDefault();
    onConfirm();
  }
</script>

<AlertDialog.Root bind:open={dialogOpen} onOpenChange={keepRequiredDialogOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{t("reauthentication.title")}</AlertDialog.Title>
      <AlertDialog.Description>
        {t("reauthentication.description")}
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if cancelFailed}
      <Alert.Root variant="destructive">
        <Alert.Description>
          {t("reauthentication.continueAnonymouslyFailed")}
        </Alert.Description>
      </Alert.Root>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel
        class="reauth-cancel"
        size="lg"
        disabled={cancelPending}
        onclick={cancel}
      >
        {t("reauthentication.continueAnonymously")}
      </AlertDialog.Cancel>
      <AlertDialog.Action
        class="reauth-confirm"
        size="lg"
        disabled={cancelPending}
        onclick={confirm}
      >
        {t("reauthentication.loginAgain")}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
