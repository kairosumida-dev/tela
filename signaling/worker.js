import { DurableObject } from "cloudflare:workers";

const roomPattern = /^[a-f0-9]{64}$/;
const viewerLimit = 4;

async function roomFor(secret) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(hash).toHex();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.pathname.slice("/room/".length);
    if (!url.pathname.startsWith("/room/") || !roomPattern.test(room)) {
      return new Response("Sala inválida", { status: 404 });
    }
    if (request.headers.get("Origin") !== env.ALLOWED_ORIGIN) {
      return new Response("Origem inválida", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket necessário", { status: 426 });
    }

    const role = url.searchParams.get("role");
    const offeredProtocols = request.headers.get("Sec-WebSocket-Protocol");
    if (role === "host") {
      const [protocol, secret, extra] = offeredProtocols?.split(/,\s*/) ?? [];
      if (protocol !== "screen-share" || !roomPattern.test(secret ?? "") ||
          extra || await roomFor(secret) !== room) {
        return new Response("Credencial inválida", { status: 403 });
      }
    } else if (role !== "viewer" || offeredProtocols !== "screen-share") {
      return new Response("Participante inválido", { status: 400 });
    }

    // Only the edge needs to see the host's one-time credential.
    const forwarded = new Request(request.url, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "screen-share" },
    });
    return env.ROOMS.getByName(room).fetch(forwarded);
  },
};

function send(socket, message) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    socket.close(1011, "Sinalização interrompida");
  }
}

export class Room extends DurableObject {
  #limits = new WeakMap();

  #sockets(role) {
    return this.ctx.getWebSockets(role).filter(
      (socket) => {
        const member = socket.deserializeAttachment();
        return socket.readyState === WebSocket.OPEN && member?.role === role && !member.finished;
      },
    );
  }

  fetch(request) {
    const params = new URL(request.url).searchParams;
    const role = params.get("role");
    const [client, socket] = Object.values(new WebSocketPair());
    const [host] = this.#sockets("host");
    const viewers = this.#sockets("viewer");
    // A host loaded before this release can negotiate with one viewer.
    const capacity = host?.deserializeAttachment()?.viewerLimit ?? 1;
    this.ctx.acceptWebSocket(socket, [role]);

    const rejection = role === "host" && host ? "room-busy"
      : role === "viewer" && !host ? "room-closed"
      : role === "viewer" && viewers.length >= capacity ? "room-full"
      : null;
    if (rejection) {
      send(socket, { type: rejection });
      socket.close(1000, "Sala indisponível");
    } else {
      const id = crypto.randomUUID();
      socket.serializeAttachment(role === "host"
        ? { role, id, viewerLimit: params.get("v") === "2" ? viewerLimit : 1 }
        : { role, id });
      send(socket, { type: "ready" });
      if (role === "viewer") {
        send(socket, { type: "peer", id });
        send(host, { type: "peer", id });
      }
      this.#sendOccupancy();
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "screen-share" },
    });
  }

  webSocketMessage(socket, raw) {
    const member = socket.deserializeAttachment();
    if (!member || member.finished || typeof raw !== "string" || raw.length > 16_384) return;

    const now = Date.now();
    let limit = this.#limits.get(socket);
    if (!limit || now - limit.since >= 10_000) {
      limit = { since: now, count: 0 };
      this.#limits.set(socket, limit);
    }
    if (++limit.count > 180) {
      this.#leave(socket);
      socket.close(1008, "Limite de mensagens");
      return;
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    const isHost = member.role === "host";
    const peer = isHost
      ? this.#sockets("viewer").find((viewer) => viewer.deserializeAttachment().id === message.id)
      : this.#sockets("host")[0];
    const id = isHost ? peer?.deserializeAttachment().id : member.id;
    if (!peer || message.id !== id) return;

    if (isHost && message.type === "drop-peer") {
      this.#closeViewer(peer, "peer-failed", "Conexão de vídeo interrompida");
      this.#sendOccupancy();
      return;
    }

    if (message.type === "candidate" && typeof message.candidate?.candidate === "string") {
      send(peer, { type: "candidate", id, candidate: message.candidate });
    } else if (message.type === (isHost ? "offer" : "answer") &&
        message.description?.type === message.type && typeof message.description.sdp === "string") {
      send(peer, { type: message.type, id, description: message.description });
    }
  }

  #sendOccupancy() {
    const [host] = this.#sockets("host");
    if (!host) return;
    const viewers = this.#sockets("viewer");
    const occupancy = { type: "occupancy", count: 1 + viewers.length, capacity: 1 + (host.deserializeAttachment().viewerLimit ?? 1) };
    send(host, occupancy);
    for (const viewer of viewers) send(viewer, occupancy);
  }

  #closeViewer(viewer, type, reason) {
    viewer.serializeAttachment({ ...viewer.deserializeAttachment(), finished: true });
    send(viewer, { type });
    viewer.close(1000, reason);
  }

  #leave(socket) {
    const member = socket.deserializeAttachment();
    if (!member || member.finished) return;
    socket.serializeAttachment({ ...member, finished: true });

    if (member.role === "host") {
      for (const viewer of this.#sockets("viewer")) {
        this.#closeViewer(viewer, "room-closed", "Transmissão encerrada");
      }
    } else {
      send(this.#sockets("host")[0], { type: "peer-left", id: member.id });
      this.#sendOccupancy();
    }
  }

  webSocketClose(socket) {
    this.#leave(socket);
    socket.close();
  }

  webSocketError(socket) {
    this.#leave(socket);
    socket.close(1011, "Sinalização interrompida");
  }
}
