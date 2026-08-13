import { describe, expect, it } from "vitest";
import {
  findRefreshAcceptanceTranscriptOutcome,
  RealRefreshAcceptanceProducer,
} from "./support/real-refresh-acceptance-producer.js";

describe("real refresh acceptance producer", () => {
  it("accepts only machine-observed success rotation on the same Credential owner", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 1_000);
    observeTwoSessions(producer);
    const marker = producer.arm("success");

    producer.observePreflight(
      "owner-a",
      "identity-a",
      "owner-b",
      "identity-a",
      "peer-record",
      "peer-credential",
    );
    producer.observeRevocation("owner-a");
    producer.observeProviderResponse(401, true);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-before",
    );
    producer.observeRefreshGrant("owner-a", "credential-after");
    producer.observeRefreshIdentity("owner-a", "identity-a");
    producer.observeRefreshSuccess(
      "owner-a",
      "record-after",
      "credential-after",
    );
    producer.observeProviderResponse(200, false);
    producer.observeTranscript(marker, "success");
    producer.observeAuthCurrent("owner-a", "authenticated");
    producer.observePeerCredential(
      "owner-b",
      "identity-a",
      "peer-record",
      "peer-credential",
    );
    producer.observeAuthCurrent("owner-b", "authenticated");

    expect(producer.phaseStatus()).toEqual({ kind: "success", status: "passed" });
  });

  it("requires reauth projection, transcript, logout, and isolated Anonymous client for cancel", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 2_000);
    observeTwoSessions(producer);
    const marker = producer.arm("cancel");
    observeRevokedPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-before",
    );
    producer.observeRefreshRejection("owner-a");
    producer.observeRefreshFailure("owner-a");
    producer.observeReauthentication("owner-a");
    producer.observeTranscript(marker, "reauth_required");
    producer.observeAuthCurrent("owner-a", "reauth_required");
    producer.observeLogout(200, "owner-a");
    expect(producer.phaseStatus().status).toBe("pending");
    producer.observeAnonymousClient("workspace-b");
    observePeerAfter(producer);

    expect(producer.phaseStatus()).toEqual({ kind: "cancel", status: "passed" });
  });

  it("requires the actual same-origin login redirect after reauth for confirm", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 3_000);
    observeTwoSessions(producer);
    const marker = producer.arm("confirm");
    observeRevokedPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-before",
    );
    producer.observeRefreshRejection("owner-a");
    producer.observeRefreshFailure("owner-a");
    producer.observeReauthentication("owner-a");
    producer.observeTranscript(marker, "reauth_required");
    producer.observeAuthCurrent("owner-a", "reauth_required");
    producer.observeLoginRedirect(302, "owner-a");
    observePeerAfter(producer);

    expect(producer.phaseStatus()).toEqual({ kind: "confirm", status: "passed" });
  });

  it("fails closed on reordered or forged owner observations", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 4_000);
    observeTwoSessions(producer);
    producer.arm("success");
    observeRevokedPreflight(producer);
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
    observeTwoSessions(producer);
    producer.arm("success");
    observeRevokedPreflight(producer);
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

  it("rejects a synthetic invalidation without a completed real revocation", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 6_000);
    observeTwoSessions(producer);
    producer.arm("success");
    producer.observePreflight(
      "owner-a",
      "identity-a",
      "owner-b",
      "identity-a",
      "peer-record",
      "peer-credential",
    );

    expect(() => producer.observeProviderResponse(200, true)).toThrow(
      /revocation/i,
    );
  });

  it("requires the peer to be a distinct Login Session and Client of the same canonical User", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 6_500);
    producer.observeTargetClient(
      "owner-a",
      "client-a",
      "workspace-a",
      "user-a",
    );

    expect(() =>
      producer.observePeerClient("owner-b", "client-a", "user-a"),
    ).toThrow(/peer/i);
    expect(() =>
      producer.observePeerClient("owner-b", "client-b", "user-b"),
    ).toThrow(/same User/i);
  });

  it("does not pass until the same User peer Login Session remains usable", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 7_000);
    observeTwoSessions(producer);
    const marker = producer.arm("cancel");
    observeRevokedPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-before",
    );
    producer.observeRefreshRejection("owner-a");
    producer.observeRefreshFailure("owner-a");
    producer.observeReauthentication("owner-a");
    producer.observeTranscript(marker, "reauth_required");
    producer.observeAuthCurrent("owner-a", "reauth_required");
    producer.observeLogout(200, "owner-a");
    producer.observeAnonymousClient("anonymous-workspace");

    expect(producer.phaseStatus().status).toBe("pending");
    expect(() =>
      producer.observePeerCredential(
        "owner-b",
        "identity-a",
        "changed-record",
        "peer-credential",
      ),
    ).toThrow(/peer/i);
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

function observeTwoSessions(producer: RealRefreshAcceptanceProducer) {
  producer.observeTargetClient(
    "owner-a",
    "client-a",
    "workspace-a",
    "user-a",
  );
  producer.observePeerClient("owner-b", "client-b", "user-a");
}

function observeRevokedPreflight(producer: RealRefreshAcceptanceProducer) {
  producer.observePreflight(
    "owner-a",
    "identity-a",
    "owner-b",
    "identity-a",
    "peer-record",
    "peer-credential",
  );
  producer.observeRevocation("owner-a");
  producer.observeProviderResponse(401, true);
}

function observePeerAfter(producer: RealRefreshAcceptanceProducer) {
  producer.observePeerCredential(
    "owner-b",
    "identity-a",
    "peer-record",
    "peer-credential",
  );
  producer.observeAuthCurrent("owner-b", "authenticated");
}

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
