import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeAskUserQuestionCardRequest } from "../ask-user-question.js";

interface ModelDeviationFixture {
  issue: number;
  deviations: Array<{
    name: string;
    capturedArguments: Record<string, unknown>;
    canonicalArguments: Record<string, unknown>;
  }>;
}

const fixture = JSON.parse(readFileSync(
  new URL(
    "./fixtures/ask-user-question-request-model-deviations.json",
    import.meta.url,
  ),
  "utf8",
)) as ModelDeviationFixture;

const canonicalChoiceProjection = {
  batch: false,
  id: "answer",
  kind: "single",
  question: "是否开始？",
  options: [
    { id: "是", label: "是" },
    { id: "否", label: "否" },
  ],
};

describe("ask_user_question request compatibility matrix", () => {
  it.each(["file", "upload", "fileUpload", "file_upload"])("normalizes the %s file control alias without a model default", inputType => {
    expect(normalizeAskUserQuestionCardRequest({
      question: "材料？", inputType, required: true, default: "invented.pdf",
    }, { requireDefault: true })).toEqual({
      batch: false, id: "answer", kind: "file", question: "材料？", required: true,
    });
  });

  it("preserves mixed field identity when file questions are JSON strings", () => {
    const questions = [
      { id: "reason", question: "用途？", default: "合同" },
      { id: "document", question: "材料？", inputType: "file", required: true },
      { id: "extra", question: "补充？", inputType: "file" },
    ];
    expect(normalizeAskUserQuestionCardRequest({ questions: JSON.stringify(questions) }, { requireDefault: true }))
      .toEqual(normalizeAskUserQuestionCardRequest({ questions }, { requireDefault: true }));
  });

  it("projects a file field without a fabricated default or unrelated controls", () => {
    expect(normalizeAskUserQuestionCardRequest({
      questions: [{
        id: "document", question: "Supporting document?", inputType: "file", required: true,
        options: "malformed", multiple: true, fieldAssist: true, dateFormat: "invalid",
        dataSource: { type: "api", endpoint: "/irrelevant" }, default: "/fabricated/path",
      }],
    })).toEqual({
      batch: true, title: "表单",
      questions: [{ id: "document", kind: "file", question: "Supporting document?", required: true }],
    });
  });

  it.each([
    ["native options", { options: ["是", "否"] }],
    ["JSON-stringified options", { options: '["是","否"]' }],
    ["whitespace-padded JSON options", { options: '  ["是", "否"]  ' }],
    ["choices alias", { choices: '["是","否"]' }],
    [
      "malformed canonical falls back to choices alias",
      { options: '["是"', choices: '["是","否"]' },
    ],
    [
      "equivalent canonical and alias options",
      { options: ["是", "否"], choices: '["是","否"]' },
    ],
  ])("projects %s to the canonical browser request", (_name, fields) => {
    expect(normalizeAskUserQuestionCardRequest({
      question: "是否开始？",
      ...fields,
    })).toEqual(canonicalChoiceProjection);
  });

  it("defaults a missing grouped-form title after parsing JSON questions", () => {
    expect(normalizeAskUserQuestionCardRequest({
      questions: '  [{"id":"reason","question":"用途？","default":"签署合同"}]  ',
    })).toEqual({
      batch: true,
      title: "表单",
      questions: [{
        id: "reason",
        kind: "text",
        question: "用途？",
        fieldAssist: false,
        default: "签署合同",
      }],
    });
  });

  it("ignores malformed presentation-only fields without leaking compatibility input", () => {
    const projection = normalizeAskUserQuestionCardRequest({
      title: { malformed: true },
      questions: [{
        id: "reason",
        question: "用途？",
        inputType: "text",
        fieldAssist: { malformed: true },
        options: '["不适用"]',
        dateFormat: { malformed: true },
        default: "签署合同",
      }],
      unknownPresentationHint: "ignored",
    });

    expect(projection).toEqual({
      batch: true,
      title: "表单",
      questions: [{
        id: "reason",
        kind: "text",
        question: "用途？",
        fieldAssist: false,
        default: "签署合同",
      }],
    });
    expect(JSON.stringify(projection)).not.toContain("unknownPresentationHint");
    expect(JSON.stringify(projection)).not.toContain("不适用");
  });

  it.each([
    ["empty JSON options", { question: "选择？", options: "[]" }],
    ["all-invalid JSON options", { question: "选择？", options: "[null]" }],
    ["duplicate JSON options", { question: "选择？", options: '["A","A"]' }],
    ["partial-invalid JSON options", { question: "选择？", options: '["A",null]' }],
    ["malformed JSON options", { question: "选择？", options: '["A"', default: "A" }],
    ["partial-invalid options", { question: "选择？", options: ["A", null], default: "A" }],
    ["conflicting aliases", { question: "选择？", options: ["A"], choices: '["B"]', default: "A" }],
    ["missing grouped id", { title: "表单", questions: [{ question: "用途？", default: "合同" }] }],
    [
      "duplicate grouped ids",
      {
        title: "表单",
        questions: [
          { id: "reason", question: "用途？", default: "合同" },
          { id: "reason", question: "备注？", default: "无" },
        ],
      },
    ],
  ])("keeps strict failure for %s", (_name, request) => {
    expect(normalizeAskUserQuestionCardRequest(request)).toBeNull();
  });

  it("captures the sanitized #322 deviations and canonical equivalents", () => {
    expect(fixture.issue).toBe(322);
    for (const deviation of fixture.deviations) {
      expect(
        normalizeAskUserQuestionCardRequest(deviation.capturedArguments),
        deviation.name,
      ).toEqual(
        normalizeAskUserQuestionCardRequest(deviation.canonicalArguments),
      );
    }
  });
});
