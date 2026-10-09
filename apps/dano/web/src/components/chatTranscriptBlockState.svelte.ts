import { buildToolDetailModel, buildToolInlineModel } from "../utils/toolBlock";
import type { ToolContentBlock } from "../utils/transcript";

// ---------------------------------------------------------------------------
// Tool block expand/collapse state
// ---------------------------------------------------------------------------

export function createChatTranscriptBlockState() {
  let expandedToolBlocks = $state(new Map<string, boolean>());
  let expandedProcessGroups = $state(new Set<string>());

  const toolBlockModelCache = new WeakMap<
    ToolContentBlock,
    ReturnType<typeof buildToolInlineModel>
  >();
  const toolBlockDetailCache = new WeakMap<
    ToolContentBlock,
    ReturnType<typeof buildToolDetailModel>
  >();

  function toggleToolBlock(blockKey: string, defaultExpanded = false) {
    const next = new Map(expandedToolBlocks);
    next.set(blockKey, !isToolBlockExpanded(blockKey, defaultExpanded));
    expandedToolBlocks = next;
  }

  function toggleProcessGroup(groupKey: string) {
    const next = new Set(expandedProcessGroups);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    expandedProcessGroups = next;
  }

  function expandProcessGroup(groupKey: string) {
    if (expandedProcessGroups.has(groupKey)) return;
    expandedProcessGroups = new Set([...expandedProcessGroups, groupKey]);
  }

  function isToolBlockExpanded(blockKey: string, defaultExpanded = false): boolean {
    return expandedToolBlocks.get(blockKey) ?? defaultExpanded;
  }

  function isProcessGroupExpanded(groupKey: string): boolean {
    return expandedProcessGroups.has(groupKey);
  }

  function toolBlockModel(block: ToolContentBlock) {
    const cached = toolBlockModelCache.get(block);
    if (cached) return cached;
    const model = buildToolInlineModel(block);
    toolBlockModelCache.set(block, model);
    return model;
  }

  function toolBlockDetail(block: ToolContentBlock) {
    const cached = toolBlockDetailCache.get(block);
    if (cached) return cached;
    const detail = buildToolDetailModel(block);
    toolBlockDetailCache.set(block, detail);
    return detail;
  }

  return {
    get expandedToolBlocks() {
      return expandedToolBlocks;
    },
    get expandedProcessGroups() {
      return expandedProcessGroups;
    },
    toggleToolBlock,
    toggleProcessGroup,
    expandProcessGroup,
    isToolBlockExpanded,
    isProcessGroupExpanded,
    toolBlockModel,
    toolBlockDetail,
  };
}
