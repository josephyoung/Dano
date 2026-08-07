<script lang="ts">
  import type {
    RpcExtensionUIRequest,
    RpcExtensionUIResponse,
  } from "@dano/types/protocol";
  import X from "@lucide/svelte/icons/x";
  import { t } from "../i18n";
  import { Button } from "./ui/button";
  import * as Dialog from "./ui/dialog";
  import { Input } from "./ui/input";
  import { Textarea } from "./ui/textarea";

  type DialogExtensionUIRequest = Extract<
    RpcExtensionUIRequest,
    { method: "select" | "confirm" | "input" | "editor" }
  >;

  let {
    request = null as DialogExtensionUIRequest | null,
    onRespond = (_: RpcExtensionUIResponse) => {},
  } = $props();

  let inputValue = $state("");
  let editorValue = $state("");
  let selectedIndex = $state(-1);

  function handleSelect(option: string) {
    if (!request) return;
    onRespond({
      type: "extension_ui_response",
      id: request.id,
      value: option,
    });
  }

  function handleConfirm(confirmed: boolean) {
    if (!request) return;
    onRespond({
      type: "extension_ui_response",
      id: request.id,
      confirmed,
    });
  }

  function handleInputSubmit() {
    if (!request) return;
    onRespond({
      type: "extension_ui_response",
      id: request.id,
      value: inputValue,
    });
    inputValue = "";
  }

  function handleEditorSubmit() {
    if (!request) return;
    onRespond({
      type: "extension_ui_response",
      id: request.id,
      value: editorValue,
    });
    editorValue = "";
  }

  function handleCancel() {
    if (!request) return;
    onRespond({
      type: "extension_ui_response",
      id: request.id,
      cancelled: true,
    });
    inputValue = "";
    editorValue = "";
  }

  function handleOpenChange(open: boolean) {
    if (!open && request) handleCancel();
  }

  function initFromRequest() {
    if (!request) return;
    if (request.method === "input") inputValue = "";
    if (request.method === "editor" && request.prefill) {
      editorValue = request.prefill;
    } else {
      editorValue = "";
    }
    selectedIndex = -1;
  }

  $effect(() => {
    initFromRequest();
  });
</script>

{#if request}
  <Dialog.Root open onOpenChange={handleOpenChange}>
    <Dialog.Content
      class="dialog-panel"
      aria-label={request.title}
      showCloseButton={false}
      overlayProps={{ class: "dialog-overlay" }}
    >
      <div class="dialog-header">
        <div>
          <div class="dialog-kicker">{t("extensionDialog.kicker")}</div>
          <Dialog.Title class="dialog-title" level={3}>{request.title}</Dialog.Title>
        </div>
        <Button class="dialog-close" variant="ghost" size="icon-sm" aria-label={t("common.cancel")} onclick={handleCancel}>
          <X aria-hidden="true" size={16} />
        </Button>
      </div>

      {#if request.method === "select"}
        <div class="dialog-body">
          <ul class="select-list">
            {#each request.options as option, i}
              <li
                class="select-item"
                class:selected={selectedIndex === i}
              >
                <Button
                  class="select-item-btn"
                  variant="ghost"
                  type="button"
                  onclick={() => handleSelect(option)}
                  onmouseenter={() => (selectedIndex = i)}
                  onmouseleave={() => (selectedIndex = -1)}
                >
                  {option}
                </Button>
              </li>
            {/each}
          </ul>
        </div>
      {:else if request.method === "confirm"}
        <div class="dialog-body">
          <p class="confirm-message">{request.message}</p>
          <div class="dialog-actions">
            <Button class="btn btn-cancel" variant="outline" onclick={() => handleConfirm(false)}>
              {t("common.cancel")}
            </Button>
            <Button class="btn btn-primary" onclick={() => handleConfirm(true)}>
              {t("common.confirm")}
            </Button>
          </div>
        </div>
      {:else if request.method === "input"}
        <div class="dialog-body">
          <Input
            bind:value={inputValue}
            class="dialog-input"
            placeholder={request.placeholder ?? t("extensionDialog.inputPlaceholder")}
            onkeydown={(e) => e.key === "Enter" && handleInputSubmit()}
          />
          <div class="dialog-actions">
            <Button class="btn btn-cancel" variant="outline" onclick={handleCancel}>{t("common.cancel")}</Button>
            <Button class="btn btn-primary" onclick={handleInputSubmit}>
              {t("common.submit")}
            </Button>
          </div>
        </div>
      {:else if request.method === "editor"}
        <div class="dialog-body">
          <Textarea
            bind:value={editorValue}
            class="dialog-textarea"
            rows={10}
            onkeydown={(e) =>
              (e.ctrlKey || e.metaKey) && e.key === "Enter" && handleEditorSubmit()}
          ></Textarea>
          <div class="dialog-hint">
            <kbd class="dialog-kbd">Ctrl+Enter</kbd> {t("extensionDialog.submitShortcutSuffix")}
          </div>
          <div class="dialog-actions">
            <Button class="btn btn-cancel" variant="outline" onclick={handleCancel}>{t("common.cancel")}</Button>
            <Button class="btn btn-primary" onclick={handleEditorSubmit}>
              {t("common.submit")}
            </Button>
          </div>
        </div>
      {/if}

      {#if request.method === "select"}
        <div class="dialog-actions select-actions">
          <Button class="btn btn-cancel" variant="outline" onclick={handleCancel}>{t("common.cancel")}</Button>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Root>
{/if}

<style>
  :global(.dialog-overlay) {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--overlay);
    backdrop-filter: blur(6px);
  }

  :global(.dialog-panel) {
    width: min(92vw, 520px);
    max-height: 80vh;
    max-height: 80dvh;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
  }

  .dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .dialog-kicker {
    margin-bottom: 6px;
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-subtle);
  }

  :global(.dialog-title) {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  :global(.dialog-close) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text-subtle);
    cursor: pointer;
    line-height: 1;
    padding: 4px;
  }

  :global(.dialog-close:hover) {
    color: var(--text);
  }

  .dialog-body {
    padding: 16px 20px;
    flex: 1;
    overflow-y: auto;
  }

  .select-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .select-item {
    padding: 0;
    border-radius: 10px;
    transition:
      background 0.1s ease,
      border-color 0.1s ease;
    border: 1px solid var(--border);
    background: var(--panel-2);
    list-style: none;
  }

  :global(.select-item-btn) {
    display: block;
    width: 100%;
    padding: 12px 14px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--text);
    font-size: 0.9rem;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }

  .select-item:hover,
  .select-item.selected {
    background: var(--panel-3);
    border-color: var(--border-strong);
  }

  .confirm-message {
    margin: 0 0 16px;
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  :global(.dialog-input),
  :global(.dialog-textarea) {
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 0.92rem;
    outline: none;
    box-sizing: border-box;
  }

  :global(.dialog-input:focus),
  :global(.dialog-textarea:focus) {
    border-color: var(--border-strong);
  }

  :global(.dialog-input::placeholder) {
    color: var(--text-subtle);
  }

  :global(.dialog-textarea) {
    font-family: var(--pi-font-mono);
    resize: vertical;
    margin-bottom: 6px;
  }

  .dialog-hint {
    margin-bottom: 14px;
    font-family: var(--pi-font-sans);
    font-size: 0.68rem;
    color: var(--text-subtle);
  }

  .dialog-kbd {
    display: inline-flex;
    align-items: center;
    padding: 0 0.36em;
    border: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--panel-2) 78%, transparent);
    font-family: var(--pi-font-mono);
    font-size: 0.95em;
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 20px 18px;
  }

  .select-actions {
    padding-top: 0;
  }

  :global(.btn) {
    height: 38px;
    padding: 0 16px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease,
      border-color 0.15s ease;
  }

  :global(.btn-primary) {
    background: var(--button-bg);
    color: var(--text);
  }

  :global(.btn-primary:hover) {
    background: var(--button-hover);
    border-color: var(--border-strong);
  }

  :global(.btn-cancel) {
    background: transparent;
    color: var(--text-muted);
  }

  :global(.btn-cancel:hover) {
    background: var(--panel-2);
    color: var(--text);
  }

  @media (max-width: 900px) {
    :global(.dialog-panel) {
      width: min(95vw, 520px);
      max-height: 90vh;
      max-height: 90dvh;
    }

    .select-item,
    :global(.btn) {
      min-height: 44px;
    }

    :global(.dialog-input),
    :global(.dialog-textarea) {
      font-size: 16px;
    }
  }
</style>
