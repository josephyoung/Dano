import { mount } from "svelte";
import ChatTranscript from "../components/ChatTranscript.svelte";
import QuestionToolCard from "../components/QuestionToolCard.svelte";
import { ACCENT_COLOR_PRESETS, resolveAppThemeVars } from "../themes";
import { PI_BASE46_LIGHT_THEME } from "../themes/light";
import type { ToolContentBlock } from "../utils/transcript";

const preset = new URLSearchParams(window.location.search).get("accent");
const accent = ACCENT_COLOR_PRESETS[
  preset && preset in ACCENT_COLOR_PRESETS
    ? preset as keyof typeof ACCENT_COLOR_PRESETS
    : "default"
];
for (const [name, value] of Object.entries(
  resolveAppThemeVars(PI_BASE46_LIGHT_THEME, accent),
)) {
  document.documentElement.style.setProperty(name, value);
}

document.body.style.margin = "0";
document.body.style.padding = "24px";
document.body.style.background = "var(--bg)";
document.body.style.color = "var(--text)";
document.body.style.fontFamily = "system-ui, sans-serif";

const groupedForm: ToolContentBlock = {
  kind: "tool",
  toolName: "ask_user_question",
  toolCallId: "question-browser-form",
  toolArgs: {},
  argumentsText: "",
  toolStatus: "pending",
  questionRequest: {
    batch: true,
    title: "浏览器渲染测试表单",
    questions: [
      {
        id: "reason",
        kind: "text",
        question: "申请原因？",
        fieldAssist: false,
      },
      {
        id: "approver",
        kind: "multiple",
        question: "请选择审批人",
        options: [{ id: "zhang-san", label: "张三" }],
      },
      {
        id: "date",
        kind: "date",
        question: "日期",
        dateFormat: "yyyy-MM-dd",
      },
    ],
  },
};

const confirmation: ToolContentBlock = {
  kind: "tool",
  toolName: "ask_user_question",
  toolCallId: "question-browser-confirmation",
  toolArgs: {},
  argumentsText: "",
  toolStatus: "pending",
  questionRequest: {
    batch: false,
    id: "confirmation",
    kind: "confirm",
    title: "确认 2 份表单",
    confirmationOfToolCallId: "form-a",
    questions: [
      { id: "reason", kind: "text", question: "原因？", fieldAssist: false },
    ],
    answer: { reason: "家庭事务" },
    forms: [
      {
        formId: "form-a",
        title: "请假申请",
        questions: [
          { id: "reason", kind: "text", question: "原因？", fieldAssist: false },
          { id: "date", kind: "date", question: "日期", dateFormat: "yyyy-MM-dd" },
        ],
        answer: { reason: "家庭事务", date: "2026-07-22" },
      },
      {
        formId: "form-b",
        title: "出差申请",
        questions: [
          { id: "destination", kind: "text", question: "目的地？", fieldAssist: false },
          { id: "duration", kind: "text", question: "天数？", fieldAssist: false },
        ],
        answer: { destination: "上海", duration: "2" },
      },
    ],
  },
  formInteraction: {
    interactionId: "question-browser-confirmation",
    state: "awaiting_confirmation",
    revision: 1,
    allowedActions: ["cancel", "return_modify", "confirm"],
    forms: [],
  },
};

const longSubmittedFormQuestions = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `field-${index + 1}`,
    kind: "text" as const,
    question: `字段 ${index + 1}`,
    fieldAssist: false,
  })),
  {
    id: "type",
    kind: "single" as const,
    question: "类型",
    options: [
      { id: "leave", label: "请假" },
      { id: "travel", label: "出差" },
    ],
  },
  {
    id: "systems",
    kind: "multiple" as const,
    question: "同步系统",
    options: [
      { id: "hr", label: "人事" },
      { id: "finance", label: "财务" },
    ],
  },
  {
    id: "department",
    kind: "select" as const,
    question: "部门",
    options: [
      { id: "sales", label: "销售" },
      { id: "finance", label: "财务" },
    ],
  },
  {
    id: "region",
    kind: "treeSelect" as const,
    question: "区域",
    options: [
      { id: "east", label: "华东" },
      { id: "west", label: "华西" },
    ],
  },
];
const longSubmittedForm: ToolContentBlock = {
  kind: "tool",
  toolName: "ask_user_question",
  toolCallId: "question-browser-long-submitted-form",
  toolArgs: {},
  argumentsText: "",
  toolStatus: "success",
  questionRequest: {
    batch: true,
    title: "长表单",
    questions: longSubmittedFormQuestions,
  },
  resultDetails: {
    status: "answered",
    formId: "question-browser-long-submitted-form",
    answer: Object.fromEntries(
      [
        ...longSubmittedFormQuestions.slice(0, 12).map((question, index) => [
          question.id,
          `回答 ${index + 1}`,
        ]),
        ["type", "travel"],
        ["systems", ["hr"]],
        ["department", "sales"],
        ["region", "east"],
      ],
    ),
  },
};

const respond = async () => ({ success: true } as never);
const app = document.getElementById("app")!;
for (const block of [groupedForm, confirmation]) {
  const target = document.createElement("section");
  app.append(target);
  mount(QuestionToolCard, {
    target,
    props: {
      block,
      active: true,
      onPresent: respond,
      onRespond: respond,
      onRevise: respond,
      onSubmitRevision: respond,
    },
  });
}

const transcriptOverflowHarness = document.createElement("div");
transcriptOverflowHarness.dataset.testid = "inline-form-overflow-ancestor";
transcriptOverflowHarness.style.height = "800px";
transcriptOverflowHarness.style.display = "flex";
transcriptOverflowHarness.style.flexDirection = "column";
app.append(transcriptOverflowHarness);
mount(ChatTranscript, {
  target: transcriptOverflowHarness,
  props: {
    messages: [
      { id: "overflow-user", role: "user", content: "填写长表单" },
      {
        id: "overflow-form",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: longSubmittedForm.toolCallId,
            name: "ask_user_question",
            arguments: {},
            questionRequest: longSubmittedForm.questionRequest,
          },
          {
            type: "toolResult",
            text: "submitted",
            details: longSubmittedForm.resultDetails,
            sourceMessageId: "overflow-form-result",
          },
        ],
      },
      { id: "overflow-final", role: "assistant", content: "表单已收到。" },
    ] as never,
  },
});
