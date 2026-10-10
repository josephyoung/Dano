<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AskUserQuestionFileRef, RpcUploadedFileRef } from "@dano/types/protocol";
  import { t } from "../i18n";
  import { Input } from "./ui/input";
  import { Button } from "./ui/button";
  import * as Alert from "./ui/alert";
  import {
    MAX_COMPOSER_ATTACHMENT_BYTES, COMPOSER_ATTACHMENT_ACCEPT, formatAttachmentSize,
    uploadComposerAttachment, markComposerAttachmentOrphaned,
  } from "../utils/attachments";

  let { id, label, value, disabled = false, onChange }: {
    id: string; label: string; value?: AskUserQuestionFileRef; disabled?: boolean;
    onChange: (file: AskUserQuestionFileRef | undefined, blocked: boolean) => void;
  } = $props();
  let selected = $state<File>();
  let files = $state<FileList>(new DataTransfer().files);
  let uploading = $state(false);
  let error = $state("");
  let controller: AbortController | undefined;
  let uploaded: RpcUploadedFileRef | undefined;
  let alive = true;

  function disposeUpload() {
    controller?.abort();
    controller = undefined;
    if (uploaded) void markComposerAttachmentOrphaned(uploaded).catch(() => {});
    uploaded = undefined;
  }

  onDestroy(() => { alive = false; disposeUpload(); });

  function remove() {
    disposeUpload();
    selected = undefined; uploading = false; error = "";
    onChange(undefined, false);
  }

  async function upload(file: File) {
    disposeUpload();
    selected = file;
    error = "";
    onChange(undefined, true);
    if (file.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
      error = t("questionTool.fileTooLarge", { size: formatAttachmentSize(MAX_COMPOSER_ATTACHMENT_BYTES) });
      uploading = false;
      return;
    }
    const run = new AbortController();
    controller = run; uploading = true;
    try {
      const result = await uploadComposerAttachment(file, run.signal);
      if (!alive || controller !== run || run.signal.aborted) {
        void markComposerAttachmentOrphaned(result).catch(() => {});
        return;
      }
      if (!result.relativePath) throw new Error("Missing uploaded project path");
      uploaded = result;
      onChange({ id: result.id, name: file.name, size: result.size, mimeType: result.mimeType, relativePath: result.relativePath }, false);
    } catch {
      if (alive && controller === run && !run.signal.aborted) error = t("composer.attachments.uploadFailed");
    } finally {
      if (alive && controller === run) uploading = false;
    }
  }

  function selectFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void upload(file);
  }
</script>

<div class="file-field">
  {#if !disabled}
    <Input {id} type="file" bind:files accept={COMPOSER_ATTACHMENT_ACCEPT} aria-label={label}
      aria-invalid={Boolean(error)} aria-describedby={`${id}-status`} onchange={selectFile} />
  {/if}
  <div id={`${id}-status`} class="file-status" aria-live="polite">
    {#if value || selected}
      <span class="file-name">{value?.name ?? selected?.name}</span>
      <span class="file-size">{formatAttachmentSize(value?.size ?? selected?.size ?? 0)}</span>
    {:else if disabled}
      <span class="file-size">{t("questionTool.fileEmpty")}</span>
    {/if}
    {#if uploading}<span>{t("composer.attachments.uploading")}</span>{/if}
    {#if !disabled && (value || selected)}
      <Button type="button" variant="outline" size="sm" onclick={remove} aria-label={t("composer.attachments.remove", { name: value?.name ?? selected?.name ?? "" })}>
        {t("questionTool.fileRemove")}
      </Button>
    {/if}
    {#if !disabled && error && selected}
      <Button type="button" variant="outline" size="sm" onclick={() => selected && void upload(selected)}>{t("questionTool.fileRetry")}</Button>
    {/if}
  </div>
  {#if error}
    <Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>
  {/if}
  {#if !disabled}<p class="file-hint">{t("questionTool.fileLimit", { size: formatAttachmentSize(MAX_COMPOSER_ATTACHMENT_BYTES) })}</p>{/if}
</div>

<style>
  .file-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .file-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .file-name { min-width: 0; overflow-wrap: anywhere; }
  .file-size, .file-hint { color: var(--text-muted); font-size: 0.85rem; }
  .file-hint { margin: 0; }
</style>
