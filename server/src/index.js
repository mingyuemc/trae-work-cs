// 王者对决 · 联机后端 Worker（Cloudflare Workers + D1 + KV + Durable Objects）
// 提供：账号密码认证、TURN 凭证下发、P2P 房间信令、排行榜。
import { Hono } from 'hono';
import { createSession, deleteSession, getSession, hashPassword, verifyPassword } from './auth.js';
import { extractSessionToken, sessionCookie } from './session-cookie.js';
import { errorResponse, jsonResponse, parseJsonRequest } from './utils.js';
import { STUN_ONLY, generateIceServers, turnConfigured } from './turn.js';
import { GameRoom, randomCode } from './room.js';

export { GameRoom };

const app = new Hono();

// ---- CORS（同源部署时无需，但保留以支持旧站点/本地开发跨域调用）----
function allowedOrigins(env) {
  return String(env.SITE_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin') || '';
  const sameOrigin = origin && origin === new URL(c.req.url).origin;
  const allowed = sameOrigin || allowedOrigins(c.env).includes(origin);
  if (c.req.method === 'OPTIONS') {
    const headers = {
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400'
    };
    if (origin && allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Vary'] = 'Origin';
    }
    return c.body(null, 204, headers);
  }
  await next();
  // 直接改写最终 Response 头；因为多数路由返回的是原生 Response，c.header() 不生效。
  if (origin && allowed && c.res) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    c.res.headers.append('Vary', 'Origin');
  }
});

async function currentSession(c) {
  const token = extractSessionToken(c.req.raw);
  return getSession(c.env, token);
}

async function requireSession(c) {
  const session = await currentSession(c);
  if (!session) return { error: errorResponse('请先登录', 401) };
  return { session };
}

async function requireAdmin(c) {
  const { session, error } = await requireSession(c);
  if (error) return { error };
  const row = await c.env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(session.userId).first();
  if (!row || !row.is_admin) return { error: errorResponse('需要管理员权限', 403) };
  return { session };
}

// 管理员账号引导：读取 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量，
// 若该账号不存在则创建（并标记为管理员），已存在则确保管理员标记。
async function ensureAdmin(env) {
  const username = String(env.ADMIN_USERNAME || '').trim();
  const password = String(env.ADMIN_PASSWORD || '');
  if (!username || !password) return;
  const existing = await env.DB.prepare('SELECT id, is_admin FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    if (!existing.is_admin) {
      await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(existing.id).run();
    }
    return;
  }
  const hashed = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO users (username, display_name, password_hash, password_salt, is_admin) VALUES (?, ?, ?, ?, 1)'
  )
    .bind(username, username, hashed.hash, hashed.salt)
    .run();
}

// ---- 健康检查 ----
app.get('/api/health', async (c) => {
  try { await ensureAdmin(c.env); } catch { /* 忽略引导失败 */ }
  return jsonResponse({ ok: true, turn: turnConfigured(c.env) });
});

// ---- TURN / ICE 配置 ----
// 按 IP 做简单限流，避免 TURN 凭证被滥用消耗中转流量。
const TURN_RATE_LIMIT = 60;        // 每窗口最多次数
const TURN_RATE_WINDOW = 3600;     // 窗口秒数

app.get('/api/turn', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || 'anon';
  const key = `rl:turn:${ip}`;
  let used = 0;
  try { used = Number(await c.env.SESSIONS.get(key)) || 0; } catch { /* KV 不可用时放行 */ }
  if (used >= TURN_RATE_LIMIT) {
    return jsonResponse({ iceServers: STUN_ONLY, turn: false, limited: true });
  }
  try { await c.env.SESSIONS.put(key, String(used + 1), { expirationTtl: TURN_RATE_WINDOW }); } catch { /* 忽略 */ }

  if (!turnConfigured(c.env)) return jsonResponse({ iceServers: STUN_ONLY, turn: false });
  try {
    const iceServers = await generateIceServers(c.env);
    return jsonResponse({ iceServers: [...STUN_ONLY, ...iceServers], turn: true });
  } catch {
    return jsonResponse({ iceServers: STUN_ONLY, turn: false });
  }
});

// ---- 账号：注册 / 登录 / 登出 / 当前会话 ----
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

app.post('/api/auth/register', async (c) => {
  const payload = await parseJsonRequest(c.req.raw);
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  const displayName = String(payload.displayName || username).trim();
  if (!USERNAME_RE.test(username)) return errorResponse('用户名需为 3~20 位字母、数字或下划线');
  if (password.length < 6) return errorResponse('密码至少 6 位');

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return errorResponse('该用户名已被占用', 409);

  const hashed = await hashPassword(password);
  const result = await c.env.DB.prepare(
    'INSERT INTO users (username, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)'
  )
    .bind(username, displayName || username, hashed.hash, hashed.salt)
    .run();
  const userId = result.meta.last_row_id;
  const user = { id: userId, username, display_name: displayName || username };
  const session = await createSession(c.env, user);
  return jsonResponse(
    { token: session.token, user: { id: userId, username, displayName: user.display_name } },
    200,
    { 'Set-Cookie': sessionCookie(c.req.raw, session.token) }
  );
});

app.post('/api/auth/login', async (c) => {
  const payload = await parseJsonRequest(c.req.raw);
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  if (!username || !password) return errorResponse('请输入用户名和密码');
  try { await ensureAdmin(c.env); } catch { /* 忽略引导失败 */ }

  const user = await c.env.DB.prepare(
    'SELECT id, username, display_name, password_hash, password_salt FROM users WHERE username = ?'
  )
    .bind(username)
    .first();
  if (!user) return errorResponse('账号或密码错误', 401);
  if (!(await verifyPassword(password, user.password_hash, user.password_salt))) {
    return errorResponse('账号或密码错误', 401);
  }
  const session = await createSession(c.env, user);
  return jsonResponse(
    {
      token: session.token,
      user: { id: Number(user.id), username: user.username, displayName: user.display_name }
    },
    200,
    { 'Set-Cookie': sessionCookie(c.req.raw, session.token) }
  );
});

app.post('/api/auth/logout', async (c) => {
  const token = extractSessionToken(c.req.raw);
  await deleteSession(c.env, token);
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': sessionCookie(c.req.raw, '') });
});

app.get('/api/auth/session', async (c) => {
  const session = await currentSession(c);
  if (!session) return jsonResponse({ user: null });
  const row = await c.env.DB.prepare(
    'SELECT id, username, display_name, wins, losses, rating, is_admin FROM users WHERE id = ?'
  )
    .bind(session.userId)
    .first();
  if (!row) {
    await deleteSession(c.env, session.token);
    return jsonResponse({ user: null });
  }
  return jsonResponse({
    user: {
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
      wins: row.wins,
      losses: row.losses,
      rating: row.rating,
      isAdmin: !!row.is_admin
    }
  });
});

// ---- 房间信令 ----
app.post('/api/room', async (c) => {
  // 允许匿名建房（游客也能开房间）；登录用户会附带自己的名字。
  const code = randomCode();
  return jsonResponse({ code });
});

app.get('/api/room/:code/ws', async (c) => {
  const code = String(c.req.param('code') || '').toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) return errorResponse('房间号无效');
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return errorResponse('需要 WebSocket 升级', 426);
  const id = c.env.GAME_ROOM.idFromName(`room:${code}`);
  return c.env.GAME_ROOM.get(id).fetch(c.req.raw);
});

// ---- 匹配队列 ----
app.get('/api/queue/ws', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return errorResponse('需要 WebSocket 升级', 426);
  const id = c.env.GAME_ROOM.idFromName('__matchmaking__');
  return c.env.GAME_ROOM.get(id).fetch(c.req.raw);
});

// ---- 战绩上报 ----
const RATING_WIN = 20;
const RATING_LOSS = -20;

app.post('/api/result', async (c) => {
  const { session, error } = await requireSession(c);
  if (error) return error;
  const payload = await parseJsonRequest(c.req.raw);
  const result = payload.result === 'win' ? 'win' : payload.result === 'loss' ? 'loss' : '';
  if (!result) return errorResponse('result 必须为 win 或 loss');
  const mode = String(payload.mode || '1v1').slice(0, 12);
  const opponent = String(payload.opponent || '').slice(0, 40);
  const delta = result === 'win' ? RATING_WIN : RATING_LOSS;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET
         wins = wins + ?, losses = losses + ?,
         rating = MAX(0, rating + ?),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0, delta, session.userId),
    c.env.DB.prepare(
      'INSERT INTO matches (user_id, mode, result, opponent, rating_delta) VALUES (?, ?, ?, ?, ?)'
    ).bind(session.userId, mode, result, opponent, delta)
  ]);

  const row = await c.env.DB.prepare('SELECT wins, losses, rating FROM users WHERE id = ?')
    .bind(session.userId)
    .first();
  return jsonResponse({ wins: row.wins, losses: row.losses, rating: row.rating });
});

// ---- 排行榜 ----
app.get('/api/leaderboard', async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 20));
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, display_name, wins, losses, rating
     FROM users
     ORDER BY rating DESC, wins DESC, id ASC
     LIMIT ?`
  )
    .bind(limit)
    .all();
  return jsonResponse({
    entries: results.map((row) => ({
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
      wins: row.wins,
      losses: row.losses,
      rating: row.rating
    }))
  });
});

// ---- 管理员：用户管理 ----
app.get('/api/admin/users', async (c) => {
  const { error } = await requireAdmin(c);
  if (error) return error;
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, wins, losses, rating, is_admin, created_at
     FROM users
     ORDER BY id ASC`
  ).all();
  return jsonResponse({
    users: results.map((row) => ({
      id: Number(row.id),
      username: row.username,
      wins: row.wins,
      losses: row.losses,
      rating: row.rating,
      isAdmin: !!row.is_admin,
      createdAt: row.created_at
    }))
  });
});

app.delete('/api/admin/users/:id', async (c) => {
  const { session, error } = await requireAdmin(c);
  if (error) return error;
  const targetId = Number(c.req.param('id'));
  if (!Number.isInteger(targetId) || targetId <= 0) return errorResponse('用户 ID 无效');
  if (targetId === Number(session.userId)) return errorResponse('不能删除自己的管理员账号');
  const target = await c.env.DB.prepare('SELECT is_admin FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return errorResponse('用户不存在', 404);
  if (target.is_admin) return errorResponse('不能删除管理员账号', 403);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM matches WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId)
  ]);
  return jsonResponse({ ok: true });
});

// ---- 静态资源兜底 ----
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound()));

export default app;
