// Cloudflare Realtime TURN：下发短期 ICE 配置（含 TURN 中转），
// 用于穿透对称 NAT / 企业网络等 P2P 直连失败的网络环境。
// 实现对齐 Edgechat（worker/src/calls/turn.ts）。
export function turnConfigured(env) {
  return Boolean(env.TURN_KEY_ID && env.TURN_API_TOKEN);
}

export async function generateIceServers(env, fetcher = fetch) {
  const keyId = env.TURN_KEY_ID;
  const response = await fetcher(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 }),
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!response.ok) throw new Error('TURN 暂时不可用');
  const payload = await response.json();
  if (!Array.isArray(payload.iceServers)) throw new Error('TURN 暂时不可用');
  // 浏览器禁止 53 端口，剔除它以免候选连接无谓超时。
  const iceServers = payload.iceServers
    .map((server) => ({
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
        (url) => typeof url === 'string' && !/:53(?:\?|$)/.test(url)
      ),
      ...(server.username ? { username: server.username, credential: server.credential } : {})
    }))
    .filter((server) => server.urls.length);
  return iceServers;
}

// 未配置 TURN 时退回纯 STUN，保证联机仍可在多数网络中工作。
export const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];
