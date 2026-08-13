import { describe, expect, it } from "vitest";
import {
  findRefreshAcceptanceTranscriptOutcome,
  RealRefreshAcceptanceProducer,
} from "./support/real-refresh-acceptance-producer.js";

describe("real refresh acceptance producer", () => {
  it("accepts only machine-observed success rotation on the same Credential owner", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 1_000);
    producer.observeAuthenticatedClient("owner-a", "client-a", "workspace-a");
    const marker = producer.arm("success");

    expect(producer.classifyProviderResponse(200)).toBe(true);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-before",
    );
    producer.observeRefreshSuccess(
      "owner-a",
      "record-after",
      "credential-after",
    );
    expect(producer.classifyProviderResponse(200)).toBe(false);
    producer.observeTranscript(marker, "success");
    producer.observeAuthCurrent("authenticated");

    expect(producer.phaseStatus()).toEqual({ kind: "success", status: "passed" });
  });

  it("requires reauth projection, transcript, logout, and isolated Anonymous client for cancel", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 2_000);
    producer.observeAuthenticatedClient("owner-a", "client-a", "workspace-a");
    const marker = producer.arm("cancel");
    producer.classifyProviderResponse(200);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-before",
    );
    producer.observeRefreshFailure("owner-a");
    producer.observeReauthentication("owner-a");
    producer.observeTranscript(marker, "reauth_required");
    producer.observeAuthCurrent("reauth_required");
    producer.observeLogout(200, "owner-a");
    expect(producer.phaseStatus().status).toBe("pending");
    producer.observeAnonymousClient("workspace-b");

    expect(producer.phaseStatus()).toEqual({ kind: "cancel", status: "passed" });
  });

  it("requires the actual same-origin login redirect after reauth for confirm", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 3_000);
    producer.observeAuthenticatedClient("owner-b", "client-b", "workspace-b");
    const marker = producer.arm("confirm");
    producer.classifyProviderResponse(200);
    producer.observeRefreshStart(
      "owner-b",
      "record-before",
      "credential-before",
    );
    producer.observeRefreshFailure("owner-b");
    producer.observeReauthentication("owner-b");
    producer.observeTranscript(marker, "reauth_required");
    producer.observeAuthCurrent("reauth_required");
    producer.observeLoginRedirect(302, "owner-b");

    expect(producer.phaseStatus()).toEqual({ kind: "confirm", status: "passed" });
  });

  it("fails closed on reordered or forged owner observations", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 4_000);
    producer.observeAuthenticatedClient("owner-a", "client-a", "workspace-a");
    producer.arm("success");
    producer.classifyProviderResponse(200);
    producer.observeRefreshStart(
      "owner-a",
      "same-record",
      "same-credential",
    );

    expect(() =>
      producer.observeRefreshSuccess(
        "owner-b",
        "same-record",
        "same-credential",
      ),
    ).toThrow(/Credential owner|rotate/i);
  });

  it("rejects an encrypted record rewrite when the Credential did not rotate", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 5_000);
    producer.observeAuthenticatedClient("owner-a", "client-a", "workspace-a");
    producer.arm("success");
    producer.classifyProviderResponse(200);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "same-credential",
    );

    expect(() =>
      producer.observeRefreshSuccess(
        "owner-a",
        "record-after",
        "same-credential",
      ),
    ).toThrow(/rotate/i);
  });

  it("binds refresh proof to the exact Skill question and provider result", () => {
    const marker = "refresh-success-1000-1234567890abcdef";
    const entries = skillTurn(marker, { ok: true, status: 200 });

    expect(
      findRefreshAcceptanceTranscriptOutcome(entries, marker, "/api/safe"),
    ).toBe("success");

    const question = entries[1] as {
      message: { content: Array<{ arguments: { question: string } }> };
    };
    question.message.content[0]!.arguments.question = "Continue?";
    expect(
      findRefreshAcceptanceTranscriptOutcome(entries, marker, "/api/safe"),
    ).toBeNull();
  });

  it("rejects a marker-only transcript and accepts the real reauth result", () => {
    const marker = "refresh-cancel-2000-1234567890abcdef";
    expect(
      findRefreshAcceptanceTranscriptOutcome(
        [{ type: "message", message: { role: "user", content: marker } }],
        marker,
        "/api/safe",
      ),
    ).toBeNull();
    expect(
      findRefreshAcceptanceTranscriptOutcome(
        skillTurn(marker, {
          ok: false,
          error: { code: "reauth_required" },
        }),
        marker,
        "/api/safe",
      ),
    ).toBe("reauth_required");
  });
});

function skillTurn(marker: string, providerDetails: object) {
  return [
    {
      type: "message",
      message: {
        role: "user",
        content: `<skill name="provider-broker-release-gate">${marker}</skill>`,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "question",
            name: "ask_user_question",
            arguments: {
              question: `Continue provider release gate ${marker}?`,
              inputType: "radio",
              options: [
                { id: "continue", label: "Continue" },
                { id: "stop", label: "Stop" },
              ],
              required: true,
              default: "continue",
            },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "question",
        toolName: "ask_user_question",
        details: { status: "answered", answer: "continue" },
        isError: false,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "provider",
            name: "provider_request",
            arguments: { method: "GET", path: "/api/safe" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "provider",
        toolName: "provider_request",
        details: providerDetails,
      },
    },
  ];
}
