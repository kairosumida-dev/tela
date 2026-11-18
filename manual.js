const codeLimit = 24_000;

async function sessionCode(description) {
  const raw = new TextEncoder().encode(JSON.stringify(description));
  const compressed = typeof CompressionStream === "function";
  const bytes = compressed
    ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())
    : raw;
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  const code = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return compressed ? `g.${code}` : code;
}

async function readSessionCode(raw, type) {
  const code = raw.trim();
  if (code.length > codeLimit || !/^(?:g\.)?[a-zA-Z0-9_-]+$/.test(code)) throw new Error("Código inválido");
  const compressed = code.startsWith("g.");
  const base64 = compressed ? code.slice(2) : code;
  const binary = atob(base64.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  let text;
  if (compressed) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const decoder = new TextDecoder();
    text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > codeLimit) {
        await reader.cancel();
        throw new Error("Código inválido");
      }
    }
    text += decoder.decode();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const description = JSON.parse(text);
  if (description?.type !== type || typeof description.sdp !== "string") throw new Error("Código inválido");
  return description;
}

async function prepareSessionCode(connection) {
  await connection.setLocalDescription();
  if (connection.iceGatheringState !== "complete") {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        connection.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (connection.iceGatheringState === "complete") done();
      };
      const timeout = setTimeout(done, 8_000);
      connection.addEventListener("icegatheringstatechange", check);
      check();
    });
  }
  return sessionCode(connection.localDescription.toJSON());
}

function attachManualChannel(current, channel) {
  current.channel = channel;
  if (current.role === "viewer") {
    const end = () => finish(current, "A transmissão foi encerrada.");
    channel.addEventListener("message", ({ data }) => { if (data === "end") end(); });
    channel.addEventListener("close", end);
  }
}

async function manualOffer(current) {
  const peer = addPeer(current, "manual");
  attachManualChannel(current, peer.connection.createDataChannel("session"));
  const code = await prepareSessionCode(peer.connection);
  if (!isCurrent(current, peer)) return;
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ oferta: code });
  invite.value = url.href;
  invite.disabled = false;
  copy.disabled = false;
  element("answer-form").hidden = false;
  setStatus("Aguardando resposta");
  feedback("Envie o convite e cole aqui o código de resposta que a outra pessoa enviar.");
}

async function manualWatch(raw) {
  if (session) return;
  const unavailable = checkSupport("viewer", true);
  if (unavailable) return feedback(unavailable);

  let offer;
  try {
    offer = await readSessionCode(raw, "offer");
  } catch {
    return feedback("Este convite é inválido. Peça um novo link.");
  }

  if (session) return;
  const current = createSession("viewer");
  current.manual = true;
  start.hidden = true;
  stop.hidden = false;
  element("stage-title").textContent = "Aguardando conexão";
  element("stage-text").textContent = "Envie seu código de resposta a quem compartilhou o link.";
  try {
    const peer = addPeer(current, "manual");
    peer.connection.addEventListener("datachannel", ({ channel }) => attachManualChannel(current, channel));
    await peer.connection.setRemoteDescription(offer);
    const code = await prepareSessionCode(peer.connection);
    if (!isCurrent(current, peer)) return;
    element("response-code").value = code;
    element("response-panel").hidden = false;
    setStatus("Resposta pronta");
  } catch {
    finish(current, "Não foi possível preparar a resposta. Peça um novo convite.");
  }
}

function configureManualExchange() {
  element("answer-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = session;
    const peer = current?.peer;
    if (!current?.manual || !peer) return;
    const field = element("answer");
    const submit = event.submitter;
    try {
      submit.disabled = true;
      const answer = await readSessionCode(field.value, "answer");
      if (!isCurrent(current, peer)) return;
      await peer.connection.setRemoteDescription(answer);
      if (!isCurrent(current, peer)) return;
      field.value = "";
      element("answer-form").hidden = true;
      if (peer.connection.connectionState !== "connected") {
        setStatus("Conectando espectador");
        waitForPeer(current, peer);
      }
      feedback();
    } catch {
      if (isCurrent(current, peer)) feedback("Confira o código de resposta e tente novamente.");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  element("copy-response").addEventListener("click", () => copyField(element("response-code"), "Resposta copiada. Envie o código a quem compartilhou o link."));
}
