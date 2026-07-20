<script lang="ts">
  // PROTOTYPE — three Markdown table treatments, switchable with ?tablePrototype=A|B|C.
  import { onMount } from "svelte";

  type Variant = "A" | "B" | "C";

  const variants: Array<{ id: Variant; label: string }> = [
    { id: "A", label: "Dense grid" },
    { id: "B", label: "Comfortable report" },
    { id: "C", label: "Reading-first ledger" },
  ];

  const rows = [
    ["AP-2026-0719", "华东区差旅报销审批", "等待财务复核", "¥12,480.00", "2026-07-19 16:42"],
    ["AP-2026-0718", "供应商合同续签与年度服务费用确认", "业务负责人已批准", "¥86,000.00", "2026-07-19 14:08"],
    ["AP-2026-0717", "生产环境日志归档服务扩容", "等待安全审核", "¥31,200.00", "2026-07-18 18:31"],
    ["AP-2026-0716", "https://internal.example.com/workflows/approval-with-a-very-long-unbroken-reference", "已完成", "¥5,600.00", "2026-07-18 11:20"],
  ];

  let variant = $state<Variant>("B");

  function readVariant(): Variant {
    const value = new URLSearchParams(window.location.search).get("tablePrototype");
    return value === "A" || value === "B" || value === "C" ? value : "B";
  }

  function setVariant(next: Variant) {
    variant = next;
    const url = new URL(window.location.href);
    url.searchParams.set("tablePrototype", next);
    window.history.replaceState(null, "", url);
  }

  function cycle(offset: number) {
    const index = variants.findIndex(item => item.id === variant);
    setVariant(variants[(index + offset + variants.length) % variants.length].id);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
    cycle(event.key === "ArrowLeft" ? -1 : 1);
  }

  onMount(() => {
    variant = readVariant();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<main class="prototype-stage">
  <header class="prototype-heading">
    <span class="prototype-kicker">Markdown Table prototype</span>
    <h1>Agent 查询结果</h1>
    <p>比较完整网格、长文本换行和窄屏横向滚动在真实 Dano 主题中的观感。</p>
  </header>

  <section class="message-surface" aria-label="Assistant response preview">
    <div class="assistant-mark">D</div>
    <div class="assistant-copy">
      <p>我找到了 4 条与你当前工作区相关的审批记录：</p>

      <div class:variant-a={variant === "A"} class:variant-b={variant === "B"} class:variant-c={variant === "C"} class="table-frame">
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>事项</th>
              <th>状态</th>
              <th class="numeric">金额</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row}
              <tr>
                <td><code>{row[0]}</code></td>
                <td>{row[1]}</td>
                <td>{row[2]}</td>
                <td class="numeric">{row[3]}</td>
                <td>{row[4]}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <p>其中两条仍需要人工确认。你可以继续让我打开对应审批记录。</p>
    </div>
  </section>
</main>

<nav class="prototype-switcher" aria-label="Prototype variants">
  <button type="button" aria-label="Previous variant" onclick={() => cycle(-1)}>←</button>
  <span><strong>{variant}</strong> — {variants.find(item => item.id === variant)?.label}</span>
  <button type="button" aria-label="Next variant" onclick={() => cycle(1)}>→</button>
</nav>

<style>
  .prototype-stage {
    width: min(980px, 100%);
    margin: 0 auto;
    padding: clamp(32px, 6vw, 72px) clamp(18px, 5vw, 56px) 120px;
    overflow: auto;
  }

  .prototype-heading {
    margin-bottom: 32px;
  }

  .prototype-kicker {
    color: var(--text-subtle);
    font-size: 0.72rem;
    font-weight: 650;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h1 {
    margin: 8px 0 6px;
    color: var(--text);
    font-size: clamp(1.45rem, 3vw, 2rem);
    line-height: 1.2;
    text-wrap: balance;
  }

  .prototype-heading p,
  .assistant-copy > p {
    margin: 0;
    color: var(--text-muted);
    line-height: 1.65;
    text-wrap: pretty;
  }

  .message-surface {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }

  .assistant-mark {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 9px;
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: 0.78rem;
    font-weight: 700;
  }

  .assistant-copy {
    min-width: 0;
  }

  .table-frame {
    max-width: 100%;
    margin: 14px 0;
    overflow-x: auto;
    border-radius: 8px;
    scrollbar-width: thin;
  }

  table {
    width: 100%;
    min-width: 720px;
    border-collapse: separate;
    border-spacing: 0;
    color: var(--text);
    font-size: 0.8rem;
    line-height: 1.45;
  }

  th,
  td {
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  th:first-child,
  td:first-child {
    border-left: 1px solid var(--border);
  }

  thead th {
    border-top: 1px solid var(--border);
    color: var(--text);
    font-weight: 650;
  }

  thead th:first-child { border-top-left-radius: 8px; }
  thead th:last-child { border-top-right-radius: 8px; }
  tbody tr:last-child td:first-child { border-bottom-left-radius: 8px; }
  tbody tr:last-child td:last-child { border-bottom-right-radius: 8px; }

  tbody tr {
    transition-property: background-color;
    transition-duration: 120ms;
    transition-timing-function: ease-out;
  }

  tbody tr:hover {
    background: color-mix(in srgb, var(--panel-2) 72%, transparent);
  }

  code {
    font-family: var(--pi-font-mono);
    font-size: 0.92em;
  }

  .numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .variant-a {
    border-radius: 4px;
  }

  .variant-a table {
    min-width: 680px;
    font-size: 0.76rem;
  }

  .variant-a th,
  .variant-a td {
    padding: 6px 9px;
  }

  .variant-a thead th {
    background: var(--panel-2);
  }

  .variant-b th,
  .variant-b td {
    padding: 10px 12px;
  }

  .variant-b thead th {
    background: color-mix(in srgb, var(--accent) 10%, var(--panel));
  }

  .variant-c table {
    min-width: 780px;
    line-height: 1.6;
  }

  .variant-c th,
  .variant-c td {
    padding: 12px 14px;
  }

  .variant-c thead th {
    background: var(--panel);
    text-transform: uppercase;
    letter-spacing: 0.045em;
    font-size: 0.72rem;
  }

  .variant-c tbody td:first-child {
    background: color-mix(in srgb, var(--panel) 72%, transparent);
    font-weight: 600;
  }

  .prototype-switcher {
    position: fixed;
    left: 50%;
    bottom: max(20px, env(safe-area-inset-bottom));
    z-index: 1000;
    display: grid;
    grid-template-columns: 44px minmax(180px, auto) 44px;
    align-items: center;
    overflow: hidden;
    border-radius: 999px;
    background: var(--text);
    color: var(--bg);
    box-shadow: var(--shadow-raised);
  }

  .prototype-switcher button {
    width: 44px;
    height: 44px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 1rem;
    cursor: pointer;
    transition-property: background-color, scale;
    transition-duration: 120ms;
  }

  .prototype-switcher button:hover {
    background: color-mix(in srgb, var(--bg) 14%, transparent);
  }

  .prototype-switcher button:active {
    scale: 0.96;
  }

  .prototype-switcher button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
  }

  .prototype-switcher span {
    padding: 0 12px;
    text-align: center;
    font-size: 0.76rem;
    white-space: nowrap;
  }

  @media (max-width: 600px) {
    .prototype-stage {
      padding-inline: 14px;
    }

    .message-surface {
      grid-template-columns: 1fr;
    }

    .assistant-mark {
      display: none;
    }

    .prototype-switcher {
      max-width: calc(100vw - 24px);
    }
  }
</style>
