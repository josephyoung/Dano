const moduleUrl = new URL(import.meta.url);
const collector = moduleUrl.origin;
const slot = moduleUrl.searchParams.get("slot");
const token = moduleUrl.searchParams.get("token");
const statusKey = "__dano424RealUserGate";

export async function run() {
  if ((slot !== "a" && slot !== "b") || !token) {
    throw new Error("Invalid real User gate module URL");
  }
  const status = (globalThis[statusKey] = {
    slot,
    phase: "starting",
    complete: false,
    error: null,
  });
  let eventSource;
  let clientId;
  let initialPreference;
  let preferenceChanged = false;
  try {
    const config = await collectorJson("/config");
    status.phase = "authenticated-user";
    const authentication = await danoJson("/api/auth/current");
    if (
      authentication.status !== "authenticated" ||
      typeof authentication.user?.id !== "string"
    ) {
      throw new Error(`Slot ${slot} is not authenticated in Dano`);
    }

    status.phase = "create-client";
    const created = await danoJson("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, 201);
    clientId = requiredString(created.client?.id, "client.id");
    const workspacePath = requiredString(
      created.defaultWorkspacePath,
      "defaultWorkspacePath",
    );
    const rpc = await openRpc(created.eventsUrl, created.messagesUrl);
    eventSource = rpc.eventSource;

    status.phase = "own-session";
    const newSession = await rpc.command({
      type: "new_session",
      workspacePath,
    });
    requireSuccess(newSession, "new_session");
    const sessionPath = requiredString(newSession.data?.sessionPath, "sessionPath");
    await requireRpcSuccess(rpc, {
      type: "set_session_name",
      name: config.marker,
    });
    const ownSessionOpen = await requireRpcSuccess(rpc, {
      type: "switch_session",
      sessionPath,
    });

    status.phase = "own-preference";
    const preferenceEndpoint = `/api/clients/${encodeURIComponent(clientId)}/preferences/theme`;
    initialPreference = await danoJson(preferenceEndpoint);
    await danoJson(preferenceEndpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accentColorPreset: config.preference }),
    });
    preferenceChanged = true;
    const ownPreference = await danoJson(preferenceEndpoint);

    status.phase = "own-upload";
    const markerBytes = new TextEncoder().encode(config.marker);
    const markerSha256 = await sha256(markerBytes);
    const upload = await danoJson(
      `/api/uploads?clientId=${encodeURIComponent(clientId)}&name=${encodeURIComponent(`${config.marker}.txt`)}&mimeType=text/plain&sha256=${markerSha256}`,
      { method: "POST", body: markerBytes },
      201,
    );
    const uploadId = requiredString(upload.id, "upload.id");
    const uploadRelativePath = requiredString(
      upload.relativePath,
      "upload.relativePath",
    );
    const ownPreview = await danoBytes(
      previewUrlForClient(
        requiredString(upload.previewUrl, "upload.previewUrl"),
        clientId,
      ),
    );
    const ownWorkspaceRead = await requireRpcSuccess(rpc, {
      type: "read_workspace_file",
      workspacePath,
      path: uploadRelativePath,
    });

    status.phase = "own-transcript";
    const transcriptMarker = rpc.waitForTranscriptMarker(config.marker);
    await requireRpcSuccess(rpc, {
      type: "prompt",
      message: config.marker,
    });
    await transcriptMarker;
    const ownSessions = await requireRpcSuccess(rpc, {
      type: "list_sessions",
      workspacePath,
      query: config.marker,
      includeActive: true,
    });
    const sessionMarkerCount = Array.isArray(ownSessions.data?.sessions)
      ? ownSessions.data.sessions.filter(session =>
          JSON.stringify(session).includes(config.marker),
        ).length
      : 0;

    const raw = {
      clientId,
      sessionPath,
      workspacePath,
      uploadId,
      uploadRelativePath,
    };
    const own = {
      authenticationStatus: "authenticated",
      runtimeOwnerFingerprint: await sha256(authentication.user.id),
      raw,
    };
    own.own = {
      resourceFingerprints: await resourceFingerprints(raw),
      sessionMarkerCount,
      sessionOpen: ownSessionOpen.success ? "succeeded" : "rejected",
      transcriptMarkerCount: 1,
      workspaceMarkerSha256: await sha256(
        requiredString(ownWorkspaceRead.data?.content, "workspace content"),
      ),
      uploadPreviewSha256: await sha256(ownPreview),
      preference: ownPreference.accentColorPreset,
    };
    await collectorJson("/own", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(own),
    }, 202);

    status.phase = "wait-peer";
    const peer = await waitForPeer();
    status.phase = "cross-probes";
    const forgedClientHttpStatus = await danoStatus(
      `/api/clients/${encodeURIComponent(peer.clientId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "command",
          payload: { id: crypto.randomUUID(), type: "get_state" },
        }),
      },
    );
    const crossSessionList = await rpc.command({
      type: "list_sessions",
      workspacePath: peer.workspacePath,
      includeActive: true,
    });
    const crossSessionOpen = await rpc.command({
      type: "switch_session",
      sessionPath: peer.sessionPath,
    });
    const crossTranscriptRead = await rpc.command({
      type: "list_tree_entries",
      sessionPath: peer.sessionPath,
    });
    const crossWorkspaceRegister = await rpc.command({
      type: "register_workspace",
      workspacePath: peer.workspacePath,
    });
    const crossWorkspaceList = await rpc.command({
      type: "list_workspace_entries",
      workspacePath: peer.workspacePath,
      force: true,
    });
    const crossWorkspaceRead = await rpc.command({
      type: "read_workspace_file",
      workspacePath: peer.workspacePath,
      path: peer.uploadRelativePath,
    });
    const uploadPreviewHttpStatus = await danoStatus(
      `/api/uploads/${encodeURIComponent(peer.uploadId)}/preview?clientId=${encodeURIComponent(clientId)}`,
    );
    const preferenceReadHttpStatus = await danoStatus(
      `/api/clients/${encodeURIComponent(peer.clientId)}/preferences/theme`,
    );

    status.phase = "restore-preference";
    await danoJson(preferenceEndpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialPreference),
    });
    preferenceChanged = false;
    const restored = await danoJson(preferenceEndpoint);
    const preferenceRestored =
      restored.accentColorPreset === initialPreference.accentColorPreset;

    status.phase = "submit-cross";
    await collectorJson("/cross", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetFingerprints: await resourceFingerprints(peer),
        forgedClientHttpStatus,
        sessionList: rejection(crossSessionList),
        sessionOpen: rejection(crossSessionOpen),
        transcriptRead: rejection(crossTranscriptRead),
        workspaceRegister: rejection(crossWorkspaceRegister),
        workspaceList: rejection(crossWorkspaceList),
        workspaceRead: rejection(crossWorkspaceRead),
        uploadPreviewHttpStatus,
        preferenceReadHttpStatus,
        preferenceRestored,
      }),
    }, 202);

    status.phase = "complete";
    status.complete = true;
    return { slot, status: "complete" };
  } catch (error) {
    status.phase = "failed";
    status.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    eventSource?.close();
    if (preferenceChanged && clientId && initialPreference) {
      await danoJson(
        `/api/clients/${encodeURIComponent(clientId)}/preferences/theme`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(initialPreference),
        },
      ).catch(() => {});
    }
    if (clientId) {
      await danoJson(
        `/api/clients/${encodeURIComponent(clientId)}/disconnect`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        202,
      ).catch(() => {});
    }
  }
}

export function previewUrlForClient(value, clientId) {
  const url = new URL(value, globalThis.location?.origin ?? "http://localhost");
  if (!url.searchParams.has("clientId")) {
    url.searchParams.set("clientId", clientId);
  }
  return `${url.pathname}${url.search}`;
}

async function openRpc(eventsUrl, messagesUrl) {
  const pending = new Map();
  const transcriptWaiters = new Set();
  const eventSource = new EventSource(requiredString(eventsUrl, "eventsUrl"));
  eventSource.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      new Set(["transcript_snapshot", "transcript_upsert"]).has(
        message.payload?.type,
      )
    ) {
      for (const waiter of [...transcriptWaiters]) waiter(message);
    }
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
    waitForTranscriptMarker(marker) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          transcriptWaiters.delete(onMessage);
          reject(new Error(`Own transcript did not persist the slot ${slot} marker`));
        }, 30_000);
        const onMessage = message => {
          if (!JSON.stringify(message.payload).includes(marker)) return;
          clearTimeout(timeout);
          transcriptWaiters.delete(onMessage);
          resolve();
        };
        transcriptWaiters.add(onMessage);
      });
    },
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
      if (response.status !== 202) {
        pending.delete(id);
        throw new Error(`RPC ${command.type} HTTP ${response.status}`);
      }
      return result;
    },
  };
}

async function waitForPeer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await collectorFetch("/peer");
    if (response.status === 200) return response.json();
    if (response.status !== 425) {
      throw new Error(`Collector peer lookup failed with HTTP ${response.status}`);
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the other browser slot");
}

async function requireRpcSuccess(rpc, command) {
  const response = await rpc.command(command);
  requireSuccess(response, command.type);
  return response;
}

function requireSuccess(response, command) {
  if (response?.success !== true) {
    throw new Error(`${command} failed: ${response?.error ?? "unknown error"}`);
  }
}

function rejection(response) {
  return response?.success === false ? "rejected" : "succeeded";
}

async function collectorJson(path, init, expectedStatus = 200) {
  const response = await collectorFetch(path, init);
  if (response.status !== expectedStatus) {
    throw new Error(`Collector ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

function collectorFetch(path, init = {}) {
  return fetch(
    `${collector}${path}?slot=${encodeURIComponent(slot)}&token=${encodeURIComponent(token)}`,
    { ...init, credentials: "omit", cache: "no-store" },
  );
}

async function danoJson(path, init = {}, expectedStatus = 200) {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function danoBytes(path, init = {}, expectedStatus = 200) {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function danoStatus(path, init = {}) {
  return (await fetch(path, { ...init, credentials: "include", cache: "no-store" })).status;
}

async function resourceFingerprints(raw) {
  return {
    client: await sha256(raw.clientId),
    session: await sha256(raw.sessionPath),
    workspace: await sha256(raw.workspacePath),
    upload: await sha256(raw.uploadId),
  };
}

async function sha256(value) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value) {
    throw new Error(`${field} is missing from the Dano response`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
