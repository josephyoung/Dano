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
  <AlertDialog.Content class="gap-0 overflow-hidden p-0 sm:max-w-md">
    <AlertDialog.Header class="gap-2 p-6 text-left">
      <AlertDialog.Title>{t("reauthentication.title")}</AlertDialog.Title>
      <AlertDialog.Description class="leading-6">
        {t("reauthentication.description")}
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if cancelFailed}
      <div class="px-6 pb-6">
        <Alert.Root variant="destructive">
          <Alert.Description>
            {t("reauthentication.continueAnonymouslyFailed")}
          </Alert.Description>
        </Alert.Root>
      </div>
    {/if}
    <AlertDialog.Footer class="border-t bg-muted/30 p-4 sm:p-5">
      <AlertDialog.Cancel
        class="reauth-cancel"
        disabled={cancelPending}
        onclick={cancel}
      >
        {t("reauthentication.continueAnonymously")}
      </AlertDialog.Cancel>
      <AlertDialog.Action
        class="reauth-confirm"
        disabled={cancelPending}
        onclick={confirm}
      >
        {t("reauthentication.loginAgain")}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
