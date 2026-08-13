import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialBroker,
  type CredentialSession,
} from "../bridge/credential-broker.js";
import { createOAuth2ProviderAdapter } from "../bridge/oauth-provider.js";
import {
  createObservedAccessTokenInvalid,
  findRefreshAcceptanceTranscriptOutcome,
  prepareInvalidAccessCredential,
  RealRefreshAcceptanceProducer,
} from "./support/real-refresh-acceptance-producer.js";

describe("real refresh acceptance producer", () => {
  it("refreshes when the real provider adapter reports HTTP 200 code 401", async () => {
    const provider = createOAuth2ProviderAdapter({
      issuer: "https://provider.test",
      authorizationEndpoint: "https://provider.test/authorize",
      tokenEndpoint: "https://provider.test/token",
      identityEndpoint: "https://provider.test/identity",
      clientId: "fake-client",
      clientSecret: "fake-secret",
      scope: "user.read",
    });
    const observeProviderResponse = vi.fn();
    const refreshCredential = vi.fn(async () => ({
      accessToken: "renewed-access",
      refreshToken: "rotated-refresh",
    }));
    const seenAuthorization: string[] = [];
    const broker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => ({
        accessToken: "expired-access",
        refreshToken: "initial-refresh",
      }),
      refreshCredential,
      isAccessTokenInvalid: createObservedAccessTokenInvalid(provider, {
        observeProviderResponse,
      }),
      fetch: vi.fn(async (_input, init) => {
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        seenAuthorization.push(authorization);
        return authorization === "Bearer expired-access"
          ? new Response('{"code":401,"data":null}')
          : new Response('{"code":0,"data":{"ok":true}}');
      }) as typeof fetch,
    });
    const observed = observableSession("agent-a");
    broker.observe("user-a", observed.session);
    broker.queueAssistantTurn("user-a", "agent-a", "login-a");
    observed.emit(userMessageEvent());
    observed.emit({ type: "turn_start" } as AgentSessionEvent);

    await expect(
      broker.request("user-a", "agent-a", { method: "GET", path: "/safe" }),
    ).resolves.toMatchObject({
      ok: true,
      body: '{"code":0,"data":{"ok":true}}',
    });
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(seenAuthorization).toEqual([
      "Bearer expired-access",
      "Bearer renewed-access",
    ]);
    expect(observeProviderResponse).toHaveBeenNthCalledWith(1, 200, true);
    expect(observeProviderResponse).toHaveBeenNthCalledWith(2, 200, false);
  });

  it("does not turn a rejected retry into a generic failure when gate observation rejects it", async () => {
    const provider = createOAuth2ProviderAdapter({
      issuer: "https://provider.test",
      authorizationEndpoint: "https://provider.test/authorize",
      tokenEndpoint: "https://provider.test/token",
      identityEndpoint: "https://provider.test/identity",
      clientId: "fake-client",
      clientSecret: "fake-secret",
      scope: "user.read",
    });
    const refreshCredential = vi.fn(async () => ({
      accessToken: "renewed-access",
      refreshToken: "rotated-refresh",
    }));
    const requireReauthentication = vi.fn(async () => {});
    const broker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => ({
        accessToken: "expired-access",
        refreshToken: "initial-refresh",
      }),
      refreshCredential,
      requireReauthentication,
      isAccessTokenInvalid: createObservedAccessTokenInvalid(provider, {
        observeProviderResponse() {
          throw new Error("retry was not accepted by the gate");
        },
      }),
      fetch: vi.fn(async () => new Response('{"code":401,"data":null}')) as typeof fetch,
    });
    const observed = observableSession("agent-a");
    broker.observe("user-a", observed.session);
    broker.queueAssistantTurn("user-a", "agent-a", "login-a");
    observed.emit(userMessageEvent());
    observed.emit({ type: "turn_start" } as AgentSessionEvent);

    await expect(
      broker.request("user-a", "agent-a", { method: "GET", path: "/safe" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "reauth_required" } });
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(requireReauthentication).toHaveBeenCalledOnce();
  });

  it("irreversibly fails the evidence phase after an observation error", async () => {
    const producer = new RealRefreshAcceptanceProducer(() => 250);
    observeTwoSessions(producer);
    const marker = producer.arm("success");
    producer.observePreflight(
      "owner-a",
      "user-a",
      "owner-b",
      "user-a",
      "peer-record",
      "peer-credential",
    );
    producer.observeInvalidAccessPrepared(
      "owner-a",
      "credential-before",
      "credential-prepared",
      "refresh-before",
      "refresh-before",
    );
    const predicate = createObservedAccessTokenInvalid(
      { isAccessTokenInvalid: async () => false },
      producer,
    );
    await expect(predicate(new Response("available"))).resolves.toBe(false);

    producer.observeProviderResponse(401, true);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-prepared",
    );
    producer.observeRefreshGrant("owner-a", "credential-after");
    producer.observeRefreshValidatedUser("owner-a", "user-a");
    producer.observeRefreshSuccess(
      "owner-a",
      "record-after",
      "credential-after",
    );
    producer.observeProviderResponse(200, false);
    producer.observeTranscript(marker, "success");
    producer.observeAuthCurrent("owner-a", "authenticated");
    observePeerAfter(producer);

    expect(producer.phaseStatus()).toEqual({ kind: "success", status: "pending" });
  });

  it("keeps the provider decision when no evidence phase is armed", async () => {
    const producer = new RealRefreshAcceptanceProducer(() => 260);
    const predicate = createObservedAccessTokenInvalid(
      { isAccessTokenInvalid: async () => true },
      producer,
    );

    await expect(predicate(new Response("expired", { status: 401 }))).resolves.toBe(
      true,
    );
  });

  it("binds provider validation to the canonical User resolved for both browsers", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 500);
    observeTwoSessions(producer);
    producer.arm("success");

    expect(() =>
      producer.observePreflight(
        "owner-a",
        "independently-derived-user",
        "owner-b",
        "independently-derived-user",
        "peer-record",
        "peer-credential",
      ),
    ).toThrow(/canonical User/i);
    expect(() =>
      producer.observePreflight(
        "owner-a",
        "user-a",
        "owner-b",
        "user-a",
        "peer-record",
        "peer-credential",
      ),
    ).not.toThrow();
  });

  it("prepares only an invalid access Credential and never revokes the real refresh grant", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../../scripts/run-real-refresh-acceptance.ts"),
      "utf8",
    );

    expect(source).toContain("prepareInvalidAccessCredential(");
    expect(source).toContain("refreshGrantFingerprint(targetCredential)");
    expect(source).toContain("refreshGrantFingerprint(storedPrepared)");
    expect(source).not.toContain("provider.revokeCredential(targetCredential)");
    expect(source).not.toContain("observeRevocation(");
  });

  it("atomically prepares an encrypted invalid access token while preserving the real refresh token", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-refresh-preparation-"));
    const recordPath = path.join(root, "session.json");
    const key = randomBytes(32);
    const loginSessionId = "login-session-a";
    fs.writeFileSync(
      recordPath,
      JSON.stringify({ version: 1, status: "active", credential: { existing: true } }),
      { mode: 0o600 },
    );
    try {
      const prepared = await prepareInvalidAccessCredential({
        recordPath,
        loginSessionId,
        credential: {
          accessToken: "real-access-token",
          refreshToken: "real-refresh-token",
          tokenType: "Bearer",
        },
        encryptionKey: { version: "test-v1", key },
      });
      const serialized = fs.readFileSync(recordPath, "utf8");
      const stored = JSON.parse(serialized).credential;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(stored.iv, "base64url"),
      );
      decipher.setAAD(
        Buffer.from(
          `dano-credential:v1:test-v1:${hash(loginSessionId)}`,
        ),
      );
      decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
      const decrypted = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(stored.ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8"),
      );

      expect(prepared.accessToken).not.toBe("real-access-token");
      expect(decrypted).toEqual(prepared);
      expect(decrypted.refreshToken).toBe("real-refresh-token");
      expect(serialized).not.toContain("real-access-token");
      expect(serialized).not.toContain("real-refresh-token");
      expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only machine-observed success rotation on the same Credential owner", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 1_000);
    observeTwoSessions(producer);
    const marker = producer.arm("success");

    producer.observePreflight(
      "owner-a",
      "user-a",
      "owner-b",
      "user-a",
      "peer-record",
      "peer-credential",
    );
    producer.observeInvalidAccessPrepared(
      "owner-a",
      "credential-before",
      "credential-prepared",
      "refresh-before",
      "refresh-before",
    );
    producer.observeProviderResponse(401, true);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-prepared",
    );
    producer.observeRefreshGrant("owner-a", "credential-after");
    producer.observeRefreshValidatedUser("owner-a", "user-a");
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
      "user-a",
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
    observeInvalidAccessPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-prepared",
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
    observeInvalidAccessPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-prepared",
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
    observeInvalidAccessPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "same-record",
      "credential-prepared",
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
    observeInvalidAccessPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-prepared",
    );

    expect(() =>
      producer.observeRefreshSuccess(
        "owner-a",
        "record-after",
        "same-credential",
      ),
    ).toThrow(/rotate/i);
  });

  it("rejects invalidation unless the encrypted Login Session kept the real refresh grant", () => {
    const producer = new RealRefreshAcceptanceProducer(() => 6_000);
    observeTwoSessions(producer);
    producer.arm("success");
    producer.observePreflight(
      "owner-a",
      "user-a",
      "owner-b",
      "user-a",
      "peer-record",
      "peer-credential",
    );

    expect(() => producer.observeProviderResponse(401, true)).toThrow(
      /prepared/i,
    );
    expect(() =>
      producer.observeInvalidAccessPrepared(
        "owner-a",
        "credential-before",
        "credential-prepared",
        "refresh-before",
        "changed-refresh",
      ),
    ).toThrow(/refresh grant/i);
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
    observeInvalidAccessPreflight(producer);
    producer.observeRefreshStart(
      "owner-a",
      "record-before",
      "credential-prepared",
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
        "user-a",
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

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function observableSession(sessionId: string) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session: CredentialSession = {
    sessionId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    session,
    emit(event: AgentSessionEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

function userMessageEvent(): AgentSessionEvent {
  return {
    type: "message_start",
    message: { role: "user", content: "run skill", timestamp: 1 },
  } as AgentSessionEvent;
}

function observeInvalidAccessPreflight(producer: RealRefreshAcceptanceProducer) {
  producer.observePreflight(
    "owner-a",
    "user-a",
    "owner-b",
    "user-a",
    "peer-record",
    "peer-credential",
  );
  producer.observeInvalidAccessPrepared(
    "owner-a",
    "credential-before",
    "credential-prepared",
    "refresh-before",
    "refresh-before",
  );
  producer.observeProviderResponse(401, true);
}

function observePeerAfter(producer: RealRefreshAcceptanceProducer) {
  producer.observePeerCredential(
    "owner-b",
    "user-a",
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
