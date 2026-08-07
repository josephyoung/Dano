<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { Button } from "../components/ui/button";
  import { t } from "../i18n";

  let {
    message,
    typeLabel,
    error = false,
    dismissible = false,
    onDismiss = () => {},
    closeToast = () => {},
  }: {
    message: string;
    typeLabel: string;
    error?: boolean;
    dismissible?: boolean;
    onDismiss?: () => void;
    closeToast?: () => void;
  } = $props();

  function dismiss() {
    onDismiss();
    closeToast();
  }
</script>

<div class="toast-item" class:error role={error ? "alert" : "status"}>
  <div class="toast-copy">
    <span class="toast-type">{typeLabel}</span>
    <span class="toast-message">{message}</span>
  </div>
  {#if dismissible}
    <Button
      class="toast-dismiss"
      variant="ghost"
      size="icon-xs"
      aria-label={t("notifications.dismiss")}
      onclick={dismiss}
    >
      <X size={14} aria-hidden="true" />
    </Button>
  {/if}
</div>

<style>
  .toast-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: min(340px, calc(100vw - 32px));
    padding: 12px 14px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--panel);
    box-shadow: var(--shadow);
  }

  .toast-item.error {
    border-color: var(--error-border);
    background: color-mix(in srgb, var(--error-text) 10%, var(--panel));
  }

  .toast-item.error .toast-type,
  .toast-item.error .toast-message {
    color: var(--error-text);
  }

  .toast-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .toast-type {
    color: var(--text-subtle);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .toast-message {
    color: var(--text-muted);
    font-size: 0.82rem;
    line-height: 1.45;
  }

  :global(.toast-dismiss) {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-subtle);
  }

  :global(.toast-dismiss:hover) {
    background: transparent;
    color: var(--text);
  }
</style>
