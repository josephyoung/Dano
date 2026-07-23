import { mount } from "svelte";
import QuestionToolCard from "../components/QuestionToolCard.svelte";
import { ACCENT_COLOR_PRESETS, resolveAppThemeVars } from "../themes";
import { PI_BASE46_LIGHT_THEME } from "../themes/light";
import type { ToolContentBlock } from "../utils/transcript";

// PROTOTYPE ONLY: three confirmation value treatments, switchable with ?variant=.
const searchParams = new URLSearchParams(window.location.search);
const preset = searchParams.get("accent");
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

const confirmationVariants = [
  { key: "A", label: "柔和置灰控件" },
  { key: "B", label: "无边框审核文本" },
  { key: "C", label: "紧凑摘要行" },
] as const;
const requestedVariant = searchParams.get("variant")?.toUpperCase();
let currentVariant = Math.max(
  0,
  confirmationVariants.findIndex(({ key }) => key === requestedVariant),
);

function setVariant(index: number) {
  currentVariant = (index + confirmationVariants.length) % confirmationVariants.length;
  const variant = confirmationVariants[currentVariant];
  document.body.dataset.confirmationVariant = variant.key;
  const nextSearchParams = new URLSearchParams(window.location.search);
  nextSearchParams.set("variant", variant.key);
  history.replaceState(null, "", `${window.location.pathname}?${nextSearchParams}`);
  const label = document.querySelector<HTMLElement>("[data-prototype-variant-label]");
  if (label) label.textContent = `${variant.key} — ${variant.label}`;
}

const prototypeStyles = document.createElement("style");
prototypeStyles.textContent = `
  body {
    min-height: 100vh;
    box-sizing: border-box;
  }
  #app {
    width: min(760px, 100%);
    margin: 0 auto;
    padding-bottom: 88px;
  }
  .prototype-context {
    margin: 0 0 20px;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .prototype-switcher {
    position: fixed;
    left: 50%;
    bottom: 24px;
    z-index: 100;
    display: grid;
    grid-template-columns: 40px minmax(180px, auto) 40px;
    align-items: center;
    gap: 4px;
    padding: 6px;
    border-radius: 999px;
    background: #111827;
    color: #fff;
    box-shadow: 0 16px 40px rgb(15 23 42 / 28%);
    transform: translateX(-50%);
  }
  .prototype-switcher button {
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 18px;
    cursor: pointer;
  }
  .prototype-switcher button:hover,
  .prototype-switcher button:focus-visible {
    background: rgb(255 255 255 / 14%);
    outline: none;
  }
  .prototype-switcher span {
    padding-inline: 8px;
    text-align: center;
    font-size: 13px;
    font-weight: 650;
  }

  body[data-confirmation-variant="A"] .confirmation-form .submitted-field-value {
    border-color: color-mix(in srgb, var(--border) 65%, transparent);
    background: color-mix(in srgb, var(--control-bg) 72%, var(--bg));
    color: var(--text-muted);
  }

  body[data-confirmation-variant="B"] .confirmation-form .submitted-field-label {
    margin-bottom: 4px;
  }
  body[data-confirmation-variant="B"] .confirmation-form .submitted-field-value {
    height: auto;
    min-height: 24px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font-weight: 550;
  }

  body[data-confirmation-variant="C"] .confirmation-form .submitted-fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    border-top: 1px solid var(--border);
  }
  body[data-confirmation-variant="C"] .confirmation-form .submitted-field {
    display: grid;
    grid-template-columns: minmax(120px, 0.42fr) minmax(0, 1fr);
    align-items: center;
    gap: 20px;
    min-height: 44px;
    border-bottom: 1px solid var(--border);
  }
  body[data-confirmation-variant="C"] .confirmation-form .submitted-field-label {
    margin: 0;
  }
  body[data-confirmation-variant="C"] .confirmation-form .submitted-field-value {
    height: auto;
    min-height: 24px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font-weight: 550;
  }
`;
document.head.append(prototypeStyles);

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

const respond = async () => ({ success: true } as never);
const app = document.getElementById("app")!;
const context = document.createElement("p");
context.className = "prototype-context";
context.textContent = "问题：确认弹窗中的值应该如何明确表达“只读”？使用底部切换器或键盘左右方向键比较。";
app.append(context);

const target = document.createElement("section");
app.append(target);
mount(QuestionToolCard, {
  target,
  props: {
    block: confirmation,
    active: true,
    onPresent: respond,
    onRespond: respond,
    onRevise: respond,
    onSubmitRevision: respond,
  },
});

const switcher = document.createElement("nav");
switcher.className = "prototype-switcher";
switcher.setAttribute("aria-label", "原型方案切换");
switcher.innerHTML = `
  <button type="button" aria-label="上一个方案">←</button>
  <span data-prototype-variant-label></span>
  <button type="button" aria-label="下一个方案">→</button>
`;
const [previousButton, nextButton] = switcher.querySelectorAll("button");
previousButton.addEventListener("click", () => setVariant(currentVariant - 1));
nextButton.addEventListener("click", () => setVariant(currentVariant + 1));
document.body.append(switcher);

window.addEventListener("keydown", event => {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) return;
  if (event.key === "ArrowLeft") setVariant(currentVariant - 1);
  if (event.key === "ArrowRight") setVariant(currentVariant + 1);
});

setVariant(currentVariant);
