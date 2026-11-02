import type { RpcTranscriptMessage } from "@dano/types/protocol";

// Synthetic read-only messages for evaluating shortcut placement with chat history.
export const quickLinks540History: RpcTranscriptMessage[] = [
  { id: "prototype-user-1", role: "user", content: "小络助手能帮我做什么？" },
  { id: "prototype-assistant-1", role: "assistant", content: "你可以用自然语言描述问题，让小络助手协助查询信息、整理资料和处理日常工作。\n\n输入框上方也提供了三个快捷入口：\n\n- **小络助手介绍**：了解助手。\n- **skill系统页面台**：进入 Skill 系统页面。\n- **OA业务管理平台**：进入 OA 平台。" },
  { id: "prototype-user-2", role: "user", content: "打开快捷入口后，这段聊天还会保留吗？" },
  { id: "prototype-assistant-2", role: "assistant", content: "会。快捷入口在新标签页打开，当前聊天页面会留在原标签页。你可以随时切回来继续对话。\n\n这段内容是用于展示布局的示例聊天。" },
];
