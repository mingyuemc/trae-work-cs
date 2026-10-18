// 账号与会话：PBKDF2 密码哈希 + KV 会话存储。
// 实现对齐 Edgechat（worker/src/auth.js），保持账号体系风格一致。
const encoder = new TextEncoder();

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 天

function toBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function hashPassword(password, salt = null) {
  const passwordSalt = salt || toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64Url(passwordSalt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { salt: passwordSalt, hash: toBase64Url(new Uint8Array(bits)) };
}

export async function verifyPassword(password, passwordHash, passwordSalt) {
  const derived = await hashPassword(password, passwordSalt);
  return timingSafeEqual(derived.hash, passwordHash);
}

export async function createSession(env, user) {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const session = {
    token,
    userId: Number(user.id),
    username: user.username,
    displayName: user.display_name ?? user.displayName ?? user.username,
    createdAt: new Date().toISOString()
  };
  await env.SESSIONS.put(token, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  return session;
}

export async function getSession(env, token) {
  if (!token) return null;
  const raw = await env.SESSIONS.get(token);
  if (!raw) return null;
  const session = JSON.parse(raw);
  session.token = token;
  return session;
}

export async function deleteSession(env, token) {
  if (!token) return;
  await env.SESSIONS.delete(token);
}
