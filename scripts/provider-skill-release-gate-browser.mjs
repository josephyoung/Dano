const moduleUrl = new URL(import.meta.url);
const collector = moduleUrl.origin;
const slot = moduleUrl.searchParams.get("slot");
const token = moduleUrl.searchParams.get("token");
const statusKey = "__dano424ProviderSkillGate";

export async function run() {
  if ((slot !== "a" && slot !== "b") || !token) {
    throw new Error("Invalid provider Skill gate module URL");
  }
  const status = (globalThis[statusKey] = {
    slot,
    phase: "starting",
    complete: false,
    error: null,
  });
  let rpc;
  let clientId;
  try {
    const config = await collectorJson("/config");
    const authentication = await danoJson("/api/auth/current");
    if (
      authentication.status !== "authenticated" ||
      typeof authentication.user?.id !== "string"
    ) {
      throw new Error(`Slot ${slot} is not authenticated`);
    }
    const created = await danoJson("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, 201);
    clientId = requiredString(created.client?.id, "client.id");
    rpc = await openRpc(created.eventsUrl, created.messagesUrl);

    if (slot === "a") {
      status.phase = "a-before";
      const createdSession = await requireRpcSuccess(rpc, {
        type: "new_session",
        workspacePath: created.defaultWorkspacePath,
      });
      const sessionPath = requiredString(createdSession.data?.sessionPath, "sessionPath");
      const model = await readSelectedModel(rpc);
      await runSkillTurn(rpc, config.markers.aBefore, "success");
      await setSharedPreference(clientId, config.sharedPreference);
      await collectorJson("/ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: authentication.status,
          clientId,
          userId: authentication.user.id,
          sessionPath,
          preference: config.sharedPreference,
          model,
        }),
      }, 202);
      await waitState(value => value.bothReady);

      status.phase = "a-held";
      await requireRpcSuccess(rpc, {
        type: "prompt",
        message: `/skill:provider-broker-release-gate ${config.markers.aAfter}`,
      });
      await rpc.waitForQuestion(config.markers.aAfter);
      await collectorJson("/a-held", { method: "POST", body: "{}" }, 202);
      await waitState(value => value.bObservedHeld);

      status.phase = "a-logout";
      const logoutHttpStatus = await danoStatus("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const oldClientHttpStatus = await danoStatus(
        `/api/clients/${encodeURIComponent(clientId)}/user`,
      );
      await collectorJson("/a-logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoutHttpStatus, oldClientHttpStatus }),
      }, 202);
    } else {
      status.phase = "b-shared-session";
      const peer = await waitPeer();
      const switched = await requireRpcSuccess(rpc, {
        type: "switch_session",
        sessionPath: peer.sessionPath,
      });
      const model = await readSelectedModel(rpc);
      const preference = await readPreference(clientId);
      await collectorJson("/ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: authentication.status,
          clientId,
          userId: authentication.user.id,
          sessionPath: requiredString(switched.data?.sessionPath, "sessionPath"),
          preference,
          model,
        }),
      }, 202);
      await waitState(value => value.aHeld);
      const heldQuestion = await rpc.waitForQuestion(config.markers.aAfter);
      await collectorJson("/b-observed-held", { method: "POST", body: "{}" }, 202);
      await waitState(value => value.aLoggedOut);

      status.phase = "answer-held-a";
      await requireRpcSuccess(rpc, {
        type: "answer_question",
        toolCallId: heldQuestion.id,
        cancelled: false,
        answer: "continue",
        ...(Number.isInteger(heldQuestion.revision)
          ? { expectedRevision: heldQuestion.revision }
          : {}),
      });
      await rpc.waitForOutcome(config.markers.aAfter, "authentication_required");

      status.phase = "b-after";
      await runSkillTurn(rpc, config.markers.bAfter, "success");
      const afterLogout = await danoJson("/api/auth/current");
      await collectorJson("/b-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: afterLogout.status }),
      }, 202);
    }
    status.phase = "complete";
    status.complete = true;
    return { slot, status: "complete" };
  } catch (error) {
    status.phase = "failed";
    status.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    rpc?.eventSource.close();
    if (clientId && slot === "b") {
      await danoJson(
        `/api/clients/${encodeURIComponent(clientId)}/disconnect`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        202,
      ).catch(() => {});
    }
  }
}

async function runSkillTurn(rpc, marker, expected) {
  await requireRpcSuccess(rpc, {
    type: "prompt",
    message: `/skill:provider-broker-release-gate ${marker}`,
  });
  const question = await rpc.waitForQuestion(marker);
  await requireRpcSuccess(rpc, {
    type: "answer_question",
    toolCallId: question.id,
    cancelled: false,
    answer: "continue",
    ...(Number.isInteger(question.revision)
      ? { expectedRevision: question.revision }
      : {}),
  });
  await rpc.waitForOutcome(marker, expected);
}

async function openRpc(eventsUrl, messagesUrl) {
  const pending = new Map();
  const observer = createGateObserver();
  const eventSource = new EventSource(requiredString(eventsUrl, "eventsUrl"));
  eventSource.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    observer.observe(message);
    if (message.type !== "response" || typeof message.payload?.id !== "string") return;
    const resolve = pending.get(message.payload.id);
    if (!resolve) return;
    pending.delete(message.payload.id);
    resolve(message.payload);
  };
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSE connection timed out")), 10_000);
    eventSource.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    eventSource.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("SSE connection failed"));
    };
  });
  return {
    eventSource,
    waitForQuestion: observer.waitForQuestion,
    waitForOutcome: observer.waitForOutcome,
    async command(command) {
      const id = crypto.randomUUID();
      const result = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${command.type} timed out`));
        }, 30_000);
        pending.set(id, payload => {
          clearTimeout(timeout);
          resolve(payload);
        });
      });
      const response = await fetch(requiredString(messagesUrl, "messagesUrl"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "command", payload: { ...command, id } }),
      });
      if (response.status !== 202) throw new Error(`RPC HTTP ${response.status}`);
      return result;
    },
  };
}

export function createGateObserver({ timeoutMs = 180_000 } = {}) {
  const questions = new Map();
  const settledSnapshots = [];
  const waiters = new Set();

  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const observe = value => {
    collectQuestions(value, questions);
    const snapshot = transcriptSnapshot(value);
    if (snapshot) settledSnapshots.push(snapshot);
    notify();
  };
  const waitFor = (inspect, label) => new Promise((resolve, reject) => {
    const check = () => {
      const result = inspect();
      if (!result) return false;
      clearTimeout(timeout);
      waiters.delete(check);
      resolve(result);
      return true;
    };
    const timeout = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    if (!check()) waiters.add(check);
  });

  return {
    observe,
    waitForQuestion: marker => waitFor(
      () => [...questions.values()].find(question => question.marker.includes(marker))?.question,
      `question ${marker}`,
    ),
    waitForOutcome: (marker, expected) => waitFor(
      () => settledSnapshots.some(snapshot => transcriptOutcome(snapshot, marker) === expected)
        ? true
        : null,
      `settled provider outcome ${marker}`,
    ),
  };
}

function collectQuestions(value, questions) {
  if (!value || typeof value !== "object") return;
  if (value.name === "ask_user_question" && typeof value.id === "string") {
    const marker = String(value.arguments?.question ?? value.args?.question ?? "");
    questions.set(value.id, {
      marker,
      question: { id: value.id, revision: value.revision },
    });
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectQuestions(child, questions);
  }
}

function transcriptSnapshot(value) {
  const payload = value?.type === "event" ? value.payload : value;
  return payload?.type === "transcript_snapshot" && Array.isArray(payload.messages)
    ? payload.messages
    : null;
}

function transcriptOutcome(messages, marker) {
  const start = messages.findIndex(message =>
    message?.role === "user" && textOf(message.content).includes(marker),
  );
  if (start < 0) return null;
  const nextUserOffset = messages.slice(start + 1)
    .findIndex(message => message?.role === "user");
  const turn = messages.slice(
    start + 1,
    nextUserOffset < 0 ? messages.length : start + 1 + nextUserOffset,
  );
  const providerCall = turn.flatMap(message => Array.isArray(message?.content)
    ? message.content
    : [])
    .find(block => block?.type === "toolCall" && block.name === "provider_request");
  if (typeof providerCall?.id !== "string") return null;
  const result = turn.find(message =>
    message?.role === "toolResult" &&
    message.toolCallId === providerCall.id &&
    message.toolName === "provider_request",
  );
  const details = result?.details ?? parseJsonObject(textOf(result?.content));
  if (details?.ok === true && Number.isInteger(details.status) && details.status >= 200 && details.status < 300) {
    return "success";
  }
  return details?.ok === false && details.error?.code === "authentication_required"
    ? "authentication_required"
    : null;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(textOf).join("\n");
  return "";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readSelectedModel(rpc) {
  const state = await requireRpcSuccess(rpc, { type: "get_state" });
  const provider = requiredString(state.data?.model?.provider, "model.provider");
  const id = requiredString(state.data?.model?.id, "model.id");
  return { provider, id };
}

async function setSharedPreference(clientId, accentColorPreset) {
  await danoJson(`/api/clients/${encodeURIComponent(clientId)}/preferences/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accentColorPreset }),
  });
}

async function readPreference(clientId) {
  return (await danoJson(
    `/api/clients/${encodeURIComponent(clientId)}/preferences/theme`,
  )).accentColorPreset;
}

async function waitPeer() {
  while (true) {
    const response = await collectorFetch("/peer");
    if (response.status === 200) return response.json();
    if (response.status !== 425) throw new Error(`peer HTTP ${response.status}`);
    await delay(250);
  }
}

async function waitState(predicate) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await collectorJson("/state");
    if (predicate(value)) return value;
    await delay(250);
  }
  throw new Error("collector state timed out");
}

async function requireRpcSuccess(rpc, command) {
  const response = await rpc.command(command);
  if (response?.success !== true) {
    throw new Error(`${command.type} failed: ${response?.error ?? "unknown"}`);
  }
  return response;
}

function collectorFetch(path, init = {}) {
  return fetch(
    `${collector}${path}?slot=${encodeURIComponent(slot)}&token=${encodeURIComponent(token)}`,
    { ...init, credentials: "omit", cache: "no-store" },
  );
}

async function collectorJson(path, init, expected = 200) {
  const response = await collectorFetch(path, init);
  if (response.status !== expected) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

async function danoJson(path, init = {}, expected = 200) {
  const response = await fetch(path, { ...init, credentials: "include", cache: "no-store" });
  if (response.status !== expected) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

async function danoStatus(path, init = {}) {
  return (await fetch(path, { ...init, credentials: "include", cache: "no-store" })).status;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value) throw new Error(`${field} is missing`);
  return value;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
