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
        }),
      }, 202);
      await waitState(value => value.aHeld);
      await waitState(value => value.aLoggedOut);

      status.phase = "answer-held-a";
      const held = await requireRpcSuccess(rpc, {
        type: "switch_session",
        sessionPath: peer.sessionPath,
      });
      const heldQuestion = findQuestion(held, config.markers.aAfter);
      if (!heldQuestion) throw new Error("Held A question was not restored to B");
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
  const observed = [];
  const waiters = new Set();
  const eventSource = new EventSource(requiredString(eventsUrl, "eventsUrl"));
  eventSource.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    observed.push(message);
    if (observed.length > 200) observed.shift();
    for (const waiter of [...waiters]) waiter();
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
  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    const inspect = () => {
      for (const message of observed) {
        const result = predicate(message);
        if (!result) continue;
        clearTimeout(timeout);
        waiters.delete(inspect);
        resolve(result);
        return true;
      }
      return false;
    };
    const timeout = setTimeout(() => {
      waiters.delete(inspect);
      reject(new Error(`${label} timed out`));
    }, 60_000);
    if (!inspect()) waiters.add(inspect);
  });
  return {
    eventSource,
    waitForQuestion: marker => waitFor(
      message => findQuestion(message, marker),
      `question ${marker}`,
    ),
    waitForOutcome: (marker, expected) => waitFor(message => {
      const text = JSON.stringify(message);
      if (!text.includes(marker) || !text.includes("provider_request")) return null;
      if (expected === "authentication_required") {
        return text.includes("authentication_required") ? true : null;
      }
      return /\"ok\"\s*:\s*true/.test(text) && /\"status\"\s*:\s*2\d\d/.test(text)
        ? true
        : null;
    }, `provider outcome ${marker}`),
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

function findQuestion(value, marker) {
  if (!value || typeof value !== "object") return null;
  if (
    value.name === "ask_user_question" &&
    typeof value.id === "string" &&
    String(value.arguments?.question ?? value.args?.question ?? "").includes(marker)
  ) {
    return { id: value.id, revision: value.revision };
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findQuestion(child, marker);
    if (found) return found;
  }
  return null;
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
