<script lang="ts">
  import AppMainContent from "../layout/AppMainContent.svelte";

  type Phase = "idle" | "pending" | "revising" | "terminal" | "grown" | "continued";
  type TerminalState = "answered" | "cancelled" | "confirmed" | "interrupted";

  const searchParams = new URLSearchParams(window.location.search);
  const requestedState = searchParams.get("state");
  const revisionMode = searchParams.get("revision") === "1";
  const terminalState: TerminalState =
    requestedState === "cancelled" ||
      requestedState === "confirmed" ||
      requestedState === "interrupted"
      ? requestedState
      : "answered";
  let phase = $state<Phase>("idle");
  let backgroundGrown = $state(false);

  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `field-${index + 1}`,
    kind: "text" as const,
    question: `字段 ${index + 1}`,
    fieldAssist: false,
  }));
  const answer = Object.fromEntries(
    questions.map((question, index) => [question.id, `回答 ${index + 1}`]),
  );
  const baselineRows = Array.from(
    { length: 48 },
    (_, index) => `正常聊天历史内容 ${index + 1}。`,
  ).join("\n\n");
  const focusedGrowthRows = Array.from(
    { length: 12 },
    (_, index) => `弹窗期间后台内容增长 ${index + 1}。`,
  ).join("\n\n");
  const longRows = Array.from(
    { length: 28 },
    (_, index) => `| ${index + 1} | 用于验证弹窗关闭后恢复正常聊天滚动的详细说明 ${index + 1} |`,
  ).join("\n");
  const longResponse = [
    "以下是提交后的长回复：",
    "",
    "| 编号 | 详细说明 |",
    "| --- | --- |",
    longRows,
  ].join("\n");

  function groupedToolCall() {
    return {
      type: "toolCall",
      id: "focus-scroll-card",
      name: "ask_user_question",
      arguments: {},
      questionRequest: {
        batch: true,
        title: "长表单",
        questions,
      },
    };
  }

  function confirmationToolCall(
    state: "awaiting_confirmation" | "revising" | "confirmed" | "interrupted",
  ) {
    return {
      type: "toolCall",
      id: "focus-scroll-card",
      name: "ask_user_question",
      arguments: { confirm: true },
      questionState: state === "interrupted" ? "terminal_failure" : undefined,
      questionRequest: {
        batch: false,
        id: "confirmation",
        kind: "confirm",
        title: "长表单确认",
        confirmationOfToolCallId: "focus-scroll-card",
        questions,
        answer,
        forms: [{
          formId: "focus-scroll-card",
          title: "长表单",
          questions,
          answer,
        }],
      },
      formInteraction: {
        interactionId: "focus-scroll-card",
        state,
        revision: state === "awaiting_confirmation" ? 1 : 2,
        allowedActions: state === "awaiting_confirmation"
          ? revisionMode
            ? ["cancel", "return_modify", "confirm"]
            : ["cancel", "confirm"]
          : state === "revising"
            ? ["cancel_revision", "submit_revision"]
            : [],
        forms: state === "revising"
          ? [{
              formId: "focus-scroll-source",
              title: "长表单",
              revision: 2,
              questions,
              answer,
            }]
          : [],
      },
    };
  }

  function submittedFormContent(
    state: "awaiting_confirmation" | "revising",
  ) {
    return [
      {
        type: "toolCall",
        id: "focus-scroll-source",
        name: "ask_user_question",
        arguments: {},
        questionRequest: {
          batch: true,
          title: "长表单",
          questions,
        },
        formInteraction: {
          interactionId: "focus-scroll-card",
          state,
          revision: state === "awaiting_confirmation" ? 1 : 2,
          allowedActions: state === "awaiting_confirmation"
            ? ["cancel", "return_modify", "confirm"]
            : ["cancel_revision", "submit_revision"],
          forms: state === "revising"
            ? [{
                formId: "focus-scroll-source",
                title: "长表单",
                revision: 2,
                questions,
                answer,
              }]
            : [],
        },
      },
      {
        type: "toolResult",
        text: "answered",
        details: {
          status: "answered",
          formId: "focus-scroll-source",
          answer,
        },
        sourceMessageId: "focus-scroll-source-result",
      },
    ];
  }

  function revisionContent(state: "awaiting_confirmation" | "revising") {
    return [
      ...submittedFormContent(state),
      confirmationToolCall(state),
    ];
  }

  function pendingContent() {
    if (revisionMode) return revisionContent("awaiting_confirmation");
    return terminalState === "confirmed" || terminalState === "interrupted"
      ? [confirmationToolCall("awaiting_confirmation")]
      : [groupedToolCall()];
  }

  function terminalContent() {
    if (terminalState === "confirmed" || terminalState === "interrupted") {
      return [confirmationToolCall(terminalState)];
    }
    return [
      groupedToolCall(),
      {
        type: "toolResult",
        text: terminalState,
        details: terminalState === "answered"
          ? {
              status: "answered",
              formId: "focus-scroll-card",
              answer,
            }
          : { status: "cancelled" },
        sourceMessageId: "focus-scroll-result",
      },
    ];
  }

  const assistantContent = $derived.by(() => {
    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: backgroundGrown
        ? `${baselineRows}\n\n${focusedGrowthRows}`
        : baselineRows,
    }];
    if (phase === "idle") return content;
    if (phase === "pending") return [...content, ...pendingContent()];
    if (phase === "revising") {
      return [...content, ...revisionContent("revising")];
    }
    return [
      ...content,
      ...terminalContent(),
      {
        type: "text",
        text: phase === "terminal"
          ? "表单已结束。"
          : phase === "grown"
            ? longResponse
            : `${longResponse}\n\n回复继续增长。`,
      },
    ];
  });

  const transcript = $derived([
    {
      id: "focus-scroll-user",
      role: "user",
      content: "填写并确认表单",
    },
    {
      id: "focus-scroll-assistant",
      role: "assistant",
      content: assistantContent,
    },
  ]);
</script>

<div class="harness-controls" aria-label="浏览器测试控制">
  <button data-testid="open-focus-card" onclick={() => phase = "pending"}>
    打开卡片
  </button>
  <button data-testid="grow-focused-background" onclick={() => backgroundGrown = true}>
    增长背景内容
  </button>
  <button data-testid="resolve-focus-card" onclick={() => phase = "terminal"}>
    恢复卡片
  </button>
  <button data-testid="return-to-revision" onclick={() => phase = "revising"}>
    返回修改
  </button>
  <button data-testid="save-revision" onclick={() => phase = "pending"}>
    保存并返回确认
  </button>
  <button data-testid="grow-final-response" onclick={() => phase = "grown"}>
    增长回复
  </button>
  <button data-testid="continue-final-response" onclick={() => phase = "continued"}>
    继续增长回复
  </button>
</div>

<AppMainContent
  activeSessionPath="browser-focus-scroll"
  transcript={transcript as never}
  isStreaming={true}
  isEmptyConversation={false}
  connectionStatus="connected"
  presentQuestionAction={async () => ({ success: true } as never)}
/>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    width: 100%;
    height: 100%;
    margin: 0;
  }

  :global(#app) {
    display: flex;
    min-height: 0;
  }

  .harness-controls {
    position: fixed;
    top: 4px;
    right: 4px;
    z-index: 100;
    display: flex;
    gap: 4px;
    opacity: 0.01;
  }
</style>
