// Durable Object：P2P 信令房间 + 匹配队列。
// 房间不再需要玩家手动复制粘贴连接码：主机建房拿到房间号，客户端输入房间号即可，
// 双方的 SDP / ICE 由本 DO 自动中转。手动连接码流程在客户端仍保留作为兜底。
//
// 拓扑与游戏保持一致：1 台主机 + 若干客户端（星型）。本 DO 只做透传，不做权威模拟。

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/O/0/1
const MAX_GUESTS = 3;

function randomCode(len = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.includes('/queue')) return this.handleQueue(request);
    return this.handleRoom(request);
  }

  // ---- 房间信令 ----
  // 信封协议：客户端发送 { to?, d }；DO 转发为 { from, d }。
  // 主机用 { to: guestId } 把 offer 定向发给某个客户端；客户端发消息自动路由给主机。
  async handleRoom(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';

    if (role === 'host' && this.state.getWebSockets('host').length > 0) {
      return new Response('room already has a host', { status: 409 });
    }
    if (role === 'guest' && this.guests().length >= MAX_GUESTS) {
      return new Response('room is full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = role === 'host' ? 'host' : randomCode(6);
    this.state.acceptWebSocket(server, [role, id]);
    server.serializeAttachment({ role, id });

    if (role === 'guest') {
      // 客户端先拿到自己的信令 id，后续主机据此定向下发 offer。
      this.sendRaw(server, { type: 'welcome', id });
      this.sendTo('host', { type: 'peer-joined', id });
    } else {
      // 主机上线：把已在大厅等待的客户端 id 一次性告知，并通知客户端等待 offer。
      this.sendRaw(server, { type: 'guests', ids: this.guestIds() });
      this.sendTo('guest', { type: 'host-ready' });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  guests() {
    return this.state.getWebSockets('guest');
  }

  guestIds() {
    return this.guests().map((ws) => (ws.deserializeAttachment() || {}).id).filter(Boolean);
  }

  webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment() || {};
    const payload = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    if (meta.role === 'host') {
      // 指定 to 时只发给该客户端，否则群发（兼容旧行为）。
      const targets = msg.to ? this.state.getWebSockets(String(msg.to)) : this.guests();
      const out = JSON.stringify({ from: 'host', d: msg.d });
      for (const target of targets) { try { target.send(out); } catch { /* 忽略 */ } }
    } else {
      this.sendRaw2('host', JSON.stringify({ from: meta.id, d: msg.d }));
    }
  }

  webSocketClose(ws) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.role === 'host') this.sendTo('guest', { type: 'peer-left', role: 'host' });
    else this.sendTo('host', { type: 'peer-left', id: meta.id });
  }

  sendRaw(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* 忽略 */ }
  }

  sendRaw2(tag, payload) {
    for (const target of this.state.getWebSockets(tag)) {
      try { target.send(payload); } catch { /* 忽略 */ }
    }
  }

  sendTo(tag, obj) {
    this.sendRaw2(tag, JSON.stringify(obj));
  }

  // ---- 匹配队列 ----
  async handleQueue(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, ['waiting']);
    server.serializeAttachment({ role: 'waiting' });
    this.tryMatch();
    return new Response(null, { status: 101, webSocket: client });
  }

  tryMatch() {
    const waiting = this.state.getWebSockets('waiting').filter((ws) => ws.readyState === 1);
    while (waiting.length >= 2) {
      const host = waiting.shift();
      const guest = waiting.shift();
      const code = randomCode();
      try {
        host.send(JSON.stringify({ type: 'matched', room: code, role: 'host' }));
        guest.send(JSON.stringify({ type: 'matched', room: code, role: 'guest' }));
      } catch { /* 忽略 */ }
      // 延迟关闭：立刻 close 会丢弃尚未刷出的 matched 消息。
      setTimeout(() => {
        try { host.close(1000, 'matched'); } catch { /* 忽略 */ }
        try { guest.close(1000, 'matched'); } catch { /* 忽略 */ }
      }, 500);
    }
  }

  webSocketError() { /* 连接错误无需特殊处理 */ }
}

export { randomCode };
