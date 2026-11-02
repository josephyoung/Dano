<script lang="ts">
  // Throwaway: compare three shortcut placements in the existing page via ?prototype540&variant=A|B|C.
  import { Button, buttonVariants } from "../components/ui/button";
  import * as Popover from "../components/ui/popover";
  import Grid2X2 from "@lucide/svelte/icons/grid-2x2";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  let { placement }: { placement: "header" | "menu" | "switcher" | "composer" } = $props();
  const params = new URLSearchParams(location.search);
  const variant = ["A", "B", "C", "D"].includes(params.get("variant") ?? "") ? params.get("variant")! : "D";
  const variants = ["A", "B", "C", "D"];
  const names: Record<string, string> = { A: "顶部直达", B: "右上应用菜单", C: "左上现有菜单", D: "Composer 上方横排" };
  const descriptions: Record<string, string> = {
    D: "三个入口横排，位于输入框正上方；在新标签页打开。",
    A: "三个入口始终可见；手机顶部会更拥挤。",
    B: "新对话左侧增加「应用」，点击展开三个入口。",
    C: "点击左上角菜单查看；页面最简洁，但入口较隐蔽。",
  };
  const links = [
    { name: "小络助手介绍", path: "/web", color: "#007aff" },
    { name: "skill系统页面台", path: "/page-desk", color: "#000000" },
    { name: "OA业务管理平台", path: "/oa", color: "#ff9500" },
  ];
  function cycle(direction: number) {
    const url = new URL(location.href);
    url.searchParams.set("variant", variants[(variants.indexOf(variant) + direction + variants.length) % variants.length]);
    location.replace(url);
  }
  function onKey(event: KeyboardEvent) {
    if (placement !== "switcher" || (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]"))) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); cycle(event.key === "ArrowLeft" ? -1 : 1);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#snippet linkList()}
  {#each links as link}
    <Button variant="ghost" href={link.path} target="_blank" rel="noopener noreferrer" class="prototype-link">
      <span>{link.name}</span><ExternalLink data-icon="inline-end" aria-hidden="true" />
    </Button>
  {/each}
{/snippet}

{#if placement === "composer" && variant === "D"}
  <nav class="prototype-composer-links" aria-label="应用快捷入口">
    {#each links as link}
      <Button variant="outline" size="sm" href={link.path} target="_blank" rel="noopener noreferrer" class="prototype-composer-link" style={`--shortcut-color: ${link.color}`}>
        {link.name}
      </Button>
    {/each}
  </nav>
{:else if placement === "header" && variant === "A"}
  <nav class="prototype-direct" aria-label="应用快捷入口">{@render linkList()}</nav>
{:else if placement === "header" && variant === "B"}
  <Popover.Root>
    <Popover.Trigger class={buttonVariants({ variant: "outline", size: "lg", class: "prototype-app-trigger" })}>
      <Grid2X2 aria-hidden="true" /><span>应用</span>
    </Popover.Trigger>
    <Popover.Content align="end" sideOffset={8} class="prototype-app-menu">
      <div class="prototype-menu-label">应用快捷入口</div>
      {@render linkList()}
      <div class="prototype-menu-note">在新标签页打开</div>
    </Popover.Content>
  </Popover.Root>
{:else if placement === "menu" && variant === "C"}
  <div class="prototype-menu-label">应用快捷入口</div>
  {@render linkList()}
  <div class="prototype-menu-note">在新标签页打开</div>
  <div class="header-menu-separator" role="separator"></div>
{:else if placement === "switcher" && !params.has("history")}
  <aside class="prototype-switcher" aria-label="原型方案切换">
    <div class="prototype-caption">#540 · 位置原型 · 等待确认</div>
    <div class="prototype-controls">
      <Button variant="outline" size="icon" aria-label="上一个方案" onclick={() => cycle(-1)}><ChevronLeft /></Button>
      <strong>{variant} / {names[variant]}</strong>
      <Button variant="outline" size="icon" aria-label="下一个方案" onclick={() => cycle(1)}><ChevronRight /></Button>
    </div>
    <p>{descriptions[variant]}</p>
  </aside>
{/if}

<style>
  .prototype-composer-links { display: flex; flex-wrap: nowrap; align-items: center; justify-content: flex-start; gap: 8px; padding: 4px 4px 12px; margin: -4px -4px 0; overflow-x: auto; }
  :global(.prototype-composer-link) { border-radius: 999px; background: transparent; color: var(--shortcut-color); border: none; box-shadow: rgba(0, 0, 0, 0.04) 0px 0px 0px 1px, rgba(0, 0, 0, 0.04) 0px 2px 8px 0px; }
  :global(.prototype-composer-link:hover) { background: transparent; color: var(--shortcut-color); }
  .prototype-direct { display: flex; align-items: center; gap: 2px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel); padding: 2px 6px; }
  :global(.prototype-link) { justify-content: space-between; gap: 16px; min-height: 38px; }
  :global(.prototype-app-trigger) { border-radius: 999px; gap: 8px; background: var(--panel); color: var(--text); }
  :global(.prototype-app-menu) { width: 224px; gap: 2px; border-radius: 16px; padding: 8px; background: var(--panel); color: var(--text); }
  .prototype-menu-label { color: var(--text-muted); font-size: 11px; padding: 8px 10px 4px; }
  .prototype-menu-note { color: var(--text-muted); font-size: 11px; padding: 6px 10px; }
  .prototype-switcher { position: fixed; z-index: 60; bottom: 16px; left: 50%; transform: translateX(-50%); width: min(410px, calc(100vw - 24px)); box-sizing: border-box; padding: 12px 16px; border: 1px solid var(--border); border-radius: 20px; background: var(--text); color: var(--panel); box-shadow: 0 8px 32px #0003; }
  .prototype-caption { text-align: center; font-size: 10px; opacity: .65; letter-spacing: 1px; }
  .prototype-controls { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 8px; }
  .prototype-controls strong { font-size: 13px; }
  .prototype-controls :global(button) { color: var(--text); }
  .prototype-switcher p { text-align: center; font-size: 11px; margin: 8px 0 0; opacity: .75; }
  @media (max-width: 640px) {
    .prototype-composer-links { gap: 6px; }
    :global(.prototype-composer-link) { padding: 0 8px; font-size: 12px; }
    .prototype-direct { gap: 0; padding: 0; }
    .prototype-direct :global(.prototype-link) { padding: 0 6px; font-size: 11px; gap: 3px; }
    .prototype-direct :global(svg) { display: none; }
  }
</style>
