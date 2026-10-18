// 会话 Cookie 读写（对齐 Edgechat 的 session-cookie）。
import { SESSION_TTL_SECONDS } from './auth.js';

function cookieName(request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-session' : 'session';
}

export function cookieToken(request) {
  const name = `${cookieName(request)}=`;
  return (request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(name))?.slice(name.length) || '';
}

// 跨站判定：静态站点部署在 Pages、API 在 Worker 时，请求会带一个不同主机的 Origin。
// 这种情况下 Cookie 必须用 SameSite=None（且必须 Secure），否则浏览器不会随 fetch 发送。
function isCrossSite(request) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return false;
  try { return new URL(origin).host !== new URL(request.url).host; } catch { return false; }
}

export function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const sameSite = isCrossSite(request) ? 'None' : 'Lax';
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${token ? SESSION_TTL_SECONDS : 0}${secure}`;
}

// 浏览器走 Cookie，原生客户端/WebSocket 走 Bearer 或 ?token=
export function extractSessionToken(request) {
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return new URL(request.url).searchParams.get('token') || cookieToken(request);
}
