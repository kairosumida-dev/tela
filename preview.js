const element = (id) => document.getElementById(id);
const permission = element("permission");
const start = element("start");
const stop = element("stop");
const video = element("video");
const invite = element("invite-preview");
const copy = element("copy");
const stopText = element("stop-text");
const roomPattern = /^[a-f0-9]{64}$/;
const route = new URLSearchParams(location.hash.slice(1));
const viewerRoom = route.get("assistir");
const manualInvite = route.get("oferta");
const watching = viewerRoom !== null || manualInvite !== null;
const iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }];
const localSite = location.hostname === "127.0.0.1" || location.hostname === "localhost";
const signalingUrl = localSite ? "ws://127.0.0.1:18787" : window.SIGNALING_URL;
const useManual = !signalingUrl || route.has("manual");
const sourceNames = { browser: "Aba do navegador", window: "Janela do aplicativo", monitor: "Tela inteira" };

let session = null;

function feedback(message = "") {
  const label = element("feedback");
  label.hidden = !message;
  label.textContent = message;
}

function setStatus(text, live = false) {
  element("status-text").textContent = text;
  element("status").classList.toggle("live", live);
}

function showVideo(stream) {
  video.srcObject = stream;
  video.hidden = !stream;
  element("stage").classList.toggle("has-video", !!stream);
}

function closePeer(current) {
  clearTimeout(current.peerTimeout);
  const peer = current.peer;
  current.peer = null;
  peer?.connection.close();
}

function finish(current, message = "", status = "Encerrado") {
  if (!current || session !== current) return;
  session = null;
  clearTimeout(current.signalingTimeout);
  if (current.channel?.readyState === "open" && current.role === "host") current.channel.send("end");
  closePeer(current);
  current.socket?.close();
  current.stream?.getTracks().forEach((track) => track.stop());

  showVideo(null);
  start.hidden = false;
  start.disabled = false;
  stop.hidden = true;
  invite.value = "";
  invite.disabled = true;
  copy.disabled = true;
  element("download-invite").hidden = true;
  element("answer-form").reset();
  element("answer-form").hidden = true;
  element("response-code").value = "";
  element("response-panel").hidden = true;
  element("source").textContent = "Nenhuma";
  if (current.role === "viewer") {
    element("stage-title").textContent = "Transmissão indisponível";
    element("stage-text").textContent = "Tente reconectar ou peça um novo convite.";
  }
  setStatus(status);
  feedback(message);
}

function send(current, message) {
  if (current.socket?.readyState === WebSocket.OPEN) {
    current.socket.send(JSON.stringify(message));
  }
}

function isCurrent(current, peer) {
  return session === current && current.peer === peer;
}

function addPeer(current, id) {
  closePeer(current);
  const connection = new RTCPeerConnection(current.manual ? { iceServers, bundlePolicy: "max-bundle" } : { iceServers });
  const peer = { id, connection, pendingCandidates: [] };
  current.peer = peer;
  setStatus(current.role === "host" ? "Conectando espectador" : "Conectando à transmissão");

  connection.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate && isCurrent(current, peer)) {
      send(current, { type: "candidate", id, candidate: candidate.toJSON() });
    }
  });

  if (current.role === "host") {
    for (const track of current.stream.getTracks()) connection.addTrack(track, current.stream);
  } else {
    connection.addEventListener("track", ({ track, streams }) => {
      if (track.kind === "video" && isCurrent(current, peer)) {
        showVideo(streams[0] ?? new MediaStream([track]));
        element("source").textContent = "Tela compartilhada";
      }
    });
  }

  connection.addEventListener("connectionstatechange", () => {
    if (!isCurrent(current, peer)) return;
    if (connection.connectionState === "connected") {
      clearTimeout(current.peerTimeout);
      setStatus("Ao vivo", true);
      if (current.role === "viewer") element("response-panel").hidden = true;
      feedback();
    } else if (connection.connectionState === "disconnected") {
      setStatus("Reconectando");
      waitForPeer(current, peer);
    } else if (connection.connectionState === "failed") {
      failPeer(current, peer);
    }
  });

  if (!current.manual) waitForPeer(current, peer);
  return peer;
}

function waitForPeer(current, peer) {
  clearTimeout(current.peerTimeout);
  current.peerTimeout = setTimeout(() => failPeer(current, peer), 20_000);
}

function failPeer(current, peer) {
  if (!isCurrent(current, peer)) return;
  const message = "Não foi possível conectar o vídeo. A rede pode estar bloqueando a conexão direta.";
  if (current.role === "viewer" || current.manual) {
    finish(current, message, "Falha de conexão");
  } else {
    closePeer(current);
    setStatus("Aguardando espectador");
    feedback(message);
  }
}

async function receive(current, message) {
  if (session !== current) return;
  if (message.type === "ready") {
    clearTimeout(current.signalingTimeout);
    if (current.role === "host") {
      const link = new URL(location.href);
      link.hash = new URLSearchParams({ assistir: current.room });
      invite.value = link.href;
      invite.disabled = false;
      copy.disabled = false;
      setStatus("Aguardando espectador");
    }
    return;
  }

  const roomErrors = {
    "room-closed": "A transmissão foi encerrada ou o convite expirou.",
    "room-full": "Já tem alguém assistindo. Tente de novo quando essa pessoa sair.",
    "room-busy": "Não foi possível abrir a sala. Inicie uma nova transmissão.",
  };
  if (Object.hasOwn(roomErrors, message.type)) {
    finish(current, roomErrors[message.type]);
    return;
  }

  if (message.type === "peer-left" && current.peer?.id === message.id) {
    closePeer(current);
    setStatus("Aguardando espectador");
    feedback("O espectador saiu. Seu convite permanece disponível.");
    return;
  }

  if (message.type === "peer") {
    const peer = addPeer(current, message.id);
    if (current.role === "host") {
      try {
        await peer.connection.setLocalDescription();
        if (isCurrent(current, peer)) {
          send(current, { type: "offer", id: peer.id, description: peer.connection.localDescription });
        }
      } catch {
        failPeer(current, peer);
      }
    }
    return;
  }

  const peer = current.peer;
  if (!peer || peer.id !== message.id) return;
  const connection = peer.connection;

  try {
    if (message.type === "offer" || message.type === "answer") {
      await connection.setRemoteDescription(message.description);
      for (const candidate of peer.pendingCandidates.splice(0)) {
        await connection.addIceCandidate(candidate);
      }
      if (message.type === "offer" && isCurrent(current, peer)) {
        await connection.setLocalDescription();
        if (isCurrent(current, peer)) {
          send(current, { type: "answer", id: peer.id, description: connection.localDescription });
        }
      }
    } else if (message.type === "candidate") {
      if (connection.remoteDescription) await connection.addIceCandidate(message.candidate);
      else peer.pendingCandidates.push(message.candidate);
    }
  } catch {
    failPeer(current, peer);
  }
}

function connect(current) {
  const endpoint = new URL(signalingUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/room/${current.room}`;
  endpoint.searchParams.set("role", current.role);
  const protocols = current.secret ? ["screen-share", current.secret] : ["screen-share"];
  const socket = new WebSocket(endpoint, protocols);
  current.socket = socket;
  const lost = () => finish(current, "A conexão com a sala caiu. Tente novamente.", "Sala desconectada");
  current.signalingTimeout = setTimeout(lost, 10_000);
  socket.addEventListener("error", lost);
  socket.addEventListener("close", () => current.queue.finally(lost));
  socket.addEventListener("message", ({ data }) => {
    current.queue = current.queue.then(() => receive(current, JSON.parse(data))).catch(lost);
  });
}

function checkSupport(role, manual = false) {
  if (!window.isSecureContext) return "Abra a página por HTTPS para iniciar ou assistir a uma transmissão.";
  if (!window.RTCPeerConnection || !window.WebSocket) return "Este navegador não oferece suporte à transmissão ao vivo.";
  if (role === "host" && !navigator.mediaDevices?.getDisplayMedia) {
    return "Para compartilhar, abra a página em um navegador de computador com captura de tela.";
  }
  if (manual) return "";
  try {
    if (new URL(signalingUrl).protocol === (localSite ? "ws:" : "wss:")) return "";
  } catch {
    // The deployment URL is optional until a signaling Worker is published.
  }
  return "O serviço de conexão da sala ainda precisa ser configurado.";
}

function createSession(role, room) {
  const current = { role, room, queue: Promise.resolve() };
  session = current;
  feedback();
  start.disabled = true;
  return current;
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function capture() {
  permission.close();
  if (session) return;
  const current = createSession("host");
  current.manual = useManual;
  start.hidden = true;
  stop.hidden = false;
  stopText.textContent = "Cancelar solicitação";
  setStatus("Aguardando autorização");
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 24 } }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (session !== current || track?.readyState !== "live") {
      stream.getTracks().forEach((item) => item.stop());
      finish(current, "A captura da tela foi encerrada.");
      return;
    }
    current.stream = stream;
    track.addEventListener("ended", () => finish(current, "Compartilhamento encerrado no navegador."), { once: true });
    showVideo(stream);
    element("source").textContent = sourceNames[track.getSettings().displaySurface] ?? "Fonte selecionada";
    stopText.textContent = "Parar compartilhamento";
    stop.focus();
    setStatus("Abrindo sala");

    if (current.manual) {
      await manualOffer(current);
      return;
    }
    current.secret = hex(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(current.secret));
    if (session !== current) return;
    current.room = hex(new Uint8Array(hash));
    connect(current);
  } catch (error) {
    const message = error.name === "NotAllowedError"
      ? "O compartilhamento foi cancelado ou a permissão foi negada."
      : error.name === "NotReadableError"
        ? "O sistema bloqueou a captura. Confira a permissão de gravação de tela do navegador."
        : "Não foi possível iniciar o compartilhamento. Tente novamente.";
    finish(current, message, "Em espera");
  }
}

function watch() {
  if (session) return;
  const unavailable = checkSupport("viewer");
  if (unavailable) return feedback(unavailable);
  if (!roomPattern.test(viewerRoom)) return feedback("Este link de convite é inválido.");

  const current = createSession("viewer", viewerRoom);
  stop.hidden = false;
  start.hidden = true;
  setStatus("Entrando na sala");
  element("stage-title").textContent = "Conectando à transmissão";
  element("stage-text").textContent = "Aguarde a conexão com quem compartilha.";
  try {
    connect(current);
  } catch {
    finish(current, "Não foi possível entrar na sala. Tente novamente.");
  }
}

if (watching) {
  document.title = "Assistir à transmissão";
  element("page-title").textContent = "Assistir à transmissão";
  element("preview-title").textContent = "Tela compartilhada";
  element("intro").textContent = "Acompanhe ao vivo a tela que alguém compartilhou com você.";
  element("instructions").textContent = "Use o botão abaixo para voltar à transmissão se a conexão cair.";
  element("invite").hidden = true;
  element("privacy").hidden = true;
  start.textContent = "Entrar na sala";
  stopText.textContent = "Sair da sala";
  if (manualInvite !== null) {
    element("instructions").textContent = "Copie o código de resposta e envie para quem compartilhou o link.";
    start.textContent = "Gerar resposta";
    start.addEventListener("click", () => manualWatch(manualInvite));
    manualWatch(manualInvite);
  } else {
    start.addEventListener("click", watch);
    watch();
  }
} else {
  start.addEventListener("click", () => {
    const unavailable = checkSupport("host", useManual);
    if (unavailable) return feedback(unavailable);
    feedback();
    permission.showModal();
  });
  element("confirm").addEventListener("click", capture);
}

stop.addEventListener("click", () => {
  if (session?.role === "host" && !session.stream) {
    finish(session, "Solicitação de captura cancelada.", "Em espera");
  } else {
    finish(session, watching ? "Você saiu da sala." : "Você encerrou o compartilhamento.");
  }
  start.focus();
});

async function copyField(field, message) {
  try {
    await navigator.clipboard.writeText(field.value);
    feedback(message);
  } catch {
    field.select();
    feedback("O conteúdo foi selecionado. Copie manualmente.");
  }
}

copy.addEventListener("click", () => copyField(invite, useManual
  ? "Link copiado. Envie o convite e aguarde o código de resposta."
  : "Link copiado. Envie para quem vai assistir."));

window.addEventListener("pagehide", () => {
  if (session) finish(session);
});

configureManualExchange();

// Convites usam o fragmento da URL. Navegar dentro da mesma aba pode
// atualizar só o fragmento, sem carregar a interface de espectador.
window.addEventListener("hashchange", () => location.reload());
