const element = (id) => document.getElementById(id);
const permission = element("permission");
const start = element("start");
const stop = element("stop");
const video = element("video");
const playVideo = element("play-video");
const stage = element("stage");
const stageTitle = element("stage-title");
const stageText = element("stage-text");
const viewer = element("viewer");
const fullscreen = element("fullscreen");
const quality = element("quality");
const occupancy = element("occupancy");
const invite = element("invite-preview");
const copy = element("copy");
const stopText = element("stop-text");
const manualOption = element("manual-option");
const manualMode = element("manual-mode");
const roomPattern = /^[a-f0-9]{64}$/;
const route = new URLSearchParams(location.hash.slice(1));
const viewerRoom = route.get("assistir");
const manualInvite = route.get("oferta");
const watching = viewerRoom !== null || manualInvite !== null;
const canCapture = !!navigator.mediaDevices?.getDisplayMedia;
const iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }];
const localSite = location.hostname === "127.0.0.1" || location.hostname === "localhost";
const signalingUrl = localSite ? "ws://127.0.0.1:18787" : window.SIGNALING_URL;
const useManual = !signalingUrl || route.has("manual");
const sourceNames = { browser: "Aba do navegador", window: "Janela do aplicativo", monitor: "Tela inteira" };

let session = null;
let imageTimeout;

function feedback(message = "") {
  const label = element("feedback");
  label.hidden = !message;
  label.textContent = message;
}

function setStatus(text, live = false) {
  element("status-text").textContent = text;
  element("status").classList.toggle("live", live);
}

function setOccupancy(count, capacity) {
  occupancy.hidden = !count;
  occupancy.textContent = count ? `${count}/${capacity} na sala` : "";
}

function showResolution() {
  const label = element("resolution");
  const visible = !!video.srcObject && video.videoWidth > 0;
  label.hidden = !visible;
  label.textContent = visible ? `${video.videoWidth} × ${video.videoHeight}` : "";
}

function isExpanded() {
  return document.fullscreenElement === viewer || document.body.classList.contains("video-expanded");
}

function renderFullscreenButton() {
  fullscreen.textContent = isExpanded() ? "Sair da tela cheia" : "Tela cheia";
}

async function exitVideoFullscreen() {
  if (document.fullscreenElement === viewer) {
    await document.exitFullscreen();
  } else {
    document.body.classList.remove("video-expanded");
    renderFullscreenButton();
  }
}

function setImageMessage(title, message, allowPlayback = false) {
  stageTitle.textContent = title;
  stageText.textContent = message;
  playVideo.hidden = !allowPlayback;
}

function hasImage() {
  return !!video.srcObject && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
}

function updateVideoPresentation() {
  const ready = hasImage();
  stage.classList.toggle("has-video", ready);
  fullscreen.hidden = !ready && !isExpanded();
  showResolution();
  if (ready) {
    clearTimeout(imageTimeout);
    playVideo.hidden = true;
  }
  return ready;
}

function waitForImage() {
  clearTimeout(imageTimeout);
  const current = session;
  imageTimeout = setTimeout(() => {
    if (session !== current || hasImage()) return;
    setImageMessage(
      "Sem imagem por enquanto",
      watching
        ? "Tente reproduzir de novo. Se continuar sem imagem, saia e reabra o convite."
        : "Tente reproduzir a prévia ou escolha outra janela.",
      !!video.srcObject,
    );
  }, 8_000);
}

function playStream(retry = false) {
  const stream = video.srcObject;
  if (!stream) return;
  setImageMessage("Aguardando imagem", "O vídeo aparece assim que o navegador receber a imagem.");
  waitForImage();
  if (retry && !video.paused && !hasImage()) {
    video.pause();
    video.srcObject = null;
    video.srcObject = stream;
  }
  video.play().then(updateViewerPlayback).catch((error) => {
    if (video.srcObject !== stream) return;
    clearTimeout(imageTimeout);
    setImageMessage(
      error.name === "NotAllowedError" ? "Reprodução pausada" : "Não foi possível reproduzir o vídeo",
      "Clique para iniciar o vídeo neste navegador.",
      true,
    );
    updateVideoPresentation();
  });
}

function showVideo(stream) {
  clearTimeout(imageTimeout);
  video.hidden = !stream;
  video.muted = true;
  video.srcObject = stream;
  updateVideoPresentation();
  if (stream) {
    playStream();
  } else {
    playVideo.hidden = true;
    fullscreen.hidden = true;
    if (isExpanded()) exitVideoFullscreen().catch(() => {});
  }
}

function updateViewerPlayback() {
  const ready = updateVideoPresentation();
  if (ready && session?.role === "viewer" && Array.from(session.peers.values()).some(
    ({ connection }) => connection.connectionState === "connected",
  )) {
    setStatus("Ao vivo", true);
  }
}

function closePeer(current, id) {
  const peer = current.peers.get(id);
  if (!peer) return;
  current.peers.delete(id);
  clearTimeout(peer.timeout);
  peer.connection.close();
}

function closePeers(current) {
  for (const id of current.peers.keys()) closePeer(current, id);
}

function updateHostStatus(current) {
  const live = Array.from(current.peers.values()).some(
    ({ connection }) => connection.connectionState === "connected",
  );
  const idle = current.manual ? "Aguardando resposta" : "Aguardando espectador";
  setStatus(live ? "Ao vivo" : current.peers.size ? "Conectando espectador" : idle, live);
}

function finish(current, message = "", status = "Encerrado") {
  if (!current || session !== current) return;
  session = null;
  clearTimeout(current.signalingTimeout);
  if (current.channel?.readyState === "open" && current.role === "host") current.channel.send("end");
  closePeers(current);
  current.socket?.close();
  current.stream?.getTracks().forEach((track) => track.stop());

  showVideo(null);
  start.hidden = false;
  start.disabled = false;
  quality.disabled = false;
  setOccupancy(0);
  manualOption.hidden = watching || useManual;
  stop.hidden = true;
  invite.value = "";
  invite.disabled = true;
  copy.disabled = true;
  element("download-invite").hidden = true;
  element("answer-form").reset();
  element("answer-form").hidden = true;
  element("response-code").value = "";
  element("response-panel").hidden = true;
  element("source").textContent = "Nenhuma fonte";
  if (current.role === "viewer") {
    setImageMessage("Transmissão indisponível", "Tente reconectar ou peça um novo convite.");
  } else {
    setImageMessage("Sua tela aparece aqui", "A prévia aparece depois que você autorizar.");
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
  return session === current && current.peers.get(peer.id) === peer;
}

function addPeer(current, id) {
  closePeer(current, id);
  const connection = new RTCPeerConnection(current.manual ? { iceServers, bundlePolicy: "max-bundle" } : { iceServers });
  const peer = { id, connection, pendingCandidates: [] };
  current.peers.set(id, peer);
  if (current.role === "host") updateHostStatus(current);
  else setStatus("Conectando à transmissão");

  connection.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate && isCurrent(current, peer)) {
      send(current, { type: "candidate", id, candidate: candidate.toJSON() });
    }
  });

  if (current.role === "host") {
    for (const track of current.stream.getVideoTracks()) {
      connection.addTransceiver(track, { direction: "sendonly", streams: [current.stream] });
    }
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
      clearTimeout(peer.timeout);
      if (current.role === "host") updateHostStatus(current);
      else {
        if (hasImage()) {
          setStatus("Ao vivo", true);
        } else {
          setStatus("Aguardando imagem");
          if (!video.srcObject) waitForImage();
        }
        element("response-panel").hidden = true;
      }
      if (current.manual) setOccupancy(2, 2);
      feedback();
    } else if (connection.connectionState === "disconnected") {
      if (current.role === "host" && !current.manual) updateHostStatus(current);
      else setStatus("Reconectando");
      waitForPeer(current, peer);
    } else if (connection.connectionState === "failed") {
      failPeer(current, peer);
    }
  });

  if (!current.manual) waitForPeer(current, peer);
  return peer;
}

function waitForPeer(current, peer) {
  clearTimeout(peer.timeout);
  peer.timeout = setTimeout(() => failPeer(current, peer), 20_000);
}

function failPeer(current, peer) {
  if (!isCurrent(current, peer)) return;
  const message = "Não foi possível conectar o vídeo. A rede pode estar bloqueando a conexão direta.";
  if (current.role === "viewer" || current.manual) {
    finish(current, message, "Falha de conexão");
  } else {
    closePeer(current, peer.id);
    send(current, { type: "drop-peer", id: peer.id });
    updateHostStatus(current);
    feedback(message);
  }
}

async function receive(current, message) {
  if (session !== current || current.manual) return;
  if (message.type === "ready") {
    clearTimeout(current.signalingTimeout);
    if (current.role === "host") {
      const link = new URL(location.href);
      link.hash = new URLSearchParams({ assistir: current.room });
      invite.value = link.href;
      invite.disabled = false;
      copy.disabled = false;
      setStatus("Aguardando espectador");
      feedback("Envie o mesmo convite para até quatro espectadores.");
    }
    return;
  }

  const roomErrors = {
    "room-closed": "A transmissão foi encerrada ou o convite expirou.",
    "room-full": "A sala está cheia. Tente novamente quando alguém sair.",
    "peer-failed": "A conexão com quem compartilha foi interrompida. Tente entrar na sala novamente.",
    "room-busy": "Não foi possível abrir a sala. Inicie uma nova transmissão.",
  };
  if (Object.hasOwn(roomErrors, message.type)) {
    finish(current, roomErrors[message.type]);
    return;
  }

  if (message.type === "occupancy") {
    setOccupancy(message.count, message.capacity);
    return;
  }

  if (message.type === "peer-left") {
    closePeer(current, message.id);
    updateHostStatus(current);
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

  const peer = current.peers.get(message.id);
  if (!peer) return;
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
  if (current.role === "host") endpoint.searchParams.set("v", "2");
  const protocols = current.secret ? ["screen-share", current.secret] : ["screen-share"];
  const socket = new WebSocket(endpoint, protocols);
  current.socket = socket;
  const lost = async () => {
    if (session !== current || current.manual) return;
    if (current.role === "viewer") {
      finish(current, "A sala automática está indisponível. Tente novamente ou peça um convite no modo manual.", "Sala desconectada");
      return;
    }

    current.manual = true;
    closePeers(current);
    setOccupancy(1, 2);
    clearTimeout(current.signalingTimeout);
    current.socket = null;
    socket.close();
    invite.value = "";
    invite.disabled = true;
    copy.disabled = true;
    setStatus("Preparando modo manual");
    feedback("A sala automática ficou indisponível. Gerando um convite com código de resposta.");
    try {
      await manualOffer(current);
    } catch {
      finish(current, "Não foi possível gerar o convite manual. Tente novamente.");
    }
  };
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
  if (role === "host" && !canCapture) {
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
  const current = { role, room, peers: new Map(), queue: Promise.resolve() };
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
  current.manual = useManual || manualMode.checked;
  manualOption.hidden = true;
  start.hidden = true;
  stop.hidden = false;
  stopText.textContent = "Cancelar solicitação";
  setStatus("Aguardando autorização");
  quality.disabled = true;
  const height = Number(quality.value);
  const width = Math.round(height * 8 / 9) * 2;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: width, max: width },
        height: { ideal: height, max: height },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (session !== current || track?.readyState !== "live") {
      stream.getTracks().forEach((item) => item.stop());
      finish(current, "A captura da tela foi encerrada.");
      return;
    }
    current.stream = stream;
    if ("contentHint" in track) track.contentHint = "detail";
    track.addEventListener("ended", () => finish(current, "Compartilhamento encerrado no navegador."), { once: true });
    showVideo(stream);
    element("source").textContent = sourceNames[track.getSettings().displaySurface] ?? "Fonte selecionada";
    stopText.textContent = "Parar compartilhamento";
    stop.focus();
    setStatus("Abrindo sala");

    if (current.manual) {
      setOccupancy(1, 2);
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
  document.body.classList.add("watching");
  element("quality-setting").hidden = true;
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
} else if (!canCapture) {
  element("intro").textContent = "Abra um link de convite para assistir a uma transmissão.";
  element("instructions").textContent = "Para transmitir a tela, use um navegador de computador com suporte à captura.";
  element("quality-setting").hidden = true;
  element("invite").hidden = true;
  element("privacy").hidden = true;
  start.hidden = true;
  setImageMessage("Nenhuma transmissão aberta", "Abra o link enviado por quem está compartilhando.");
} else {
  manualOption.hidden = useManual;
  start.addEventListener("click", () => {
    const unavailable = checkSupport("host", useManual || manualMode.checked);
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

copy.addEventListener("click", () => copyField(invite, session?.manual
  ? "Link copiado. Envie o convite e aguarde o código de resposta."
  : "Link copiado. Envie para quem vai assistir."));

window.addEventListener("pagehide", () => {
  if (session) finish(session);
});

for (const event of ["loadeddata", "playing", "resize"]) {
  video.addEventListener(event, updateViewerPlayback);
}
video.addEventListener("pause", () => {
  if (!video.srcObject || !video.paused) return;
  if (watching) setStatus("Reprodução pausada");
  clearTimeout(imageTimeout);
  setImageMessage("Reprodução pausada", "Clique para retomar o vídeo.", true);
  updateVideoPresentation();
});
playVideo.addEventListener("click", () => playStream(true));
document.addEventListener("fullscreenchange", () => {
  renderFullscreenButton();
  updateVideoPresentation();
});
fullscreen.addEventListener("click", async () => {
  if (isExpanded()) {
    await exitVideoFullscreen().catch(() => {});
    return;
  }
  try {
    await viewer.requestFullscreen();
  } catch {
    if (!video.srcObject) return;
    document.body.classList.add("video-expanded");
    renderFullscreenButton();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("video-expanded")) {
    exitVideoFullscreen();
  }
});

configureManualExchange();

// Convites usam o fragmento da URL. Navegar dentro da mesma aba pode
// atualizar só o fragmento, sem carregar a interface de espectador.
window.addEventListener("hashchange", () => location.reload());
