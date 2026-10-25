const { timingSafeEqual } = require('node:crypto');

const SESSION_PATH = '/api/lingxi/session';
const MAX_BODY = 4096;
const MAX_UPSTREAM_BODY = 65536;

function readConfig(env = process.env) {
  const names = ['LINGXI_API_KEY', 'LINGXI_API_BASE', 'LINGXI_REALTIME_URL'];
  if (!names.some(name => env[name])) return null;
  if (names.some(name => !env[name]?.trim())) throw new Error('Lingxi requires API_KEY, API_BASE and REALTIME_URL');
  let base, socket, origin;
  try {
    base = new URL(env.LINGXI_API_BASE);
    socket = new URL(env.LINGXI_REALTIME_URL);
    if (env.LINGXI_ALLOWED_ORIGIN) origin = new URL(env.LINGXI_ALLOWED_ORIGIN);
  } catch { throw new Error('Invalid Lingxi URL configuration'); }
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || base.search || base.hash ||
      socket.protocol !== 'wss:' || !socket.pathname.endsWith('/v1/realtime') || socket.username || socket.password || socket.search || socket.hash ||
      /[\r\n]/.test(env.LINGXI_API_KEY) || (env.LINGXI_MODEL && env.LINGXI_MODEL.length > 128)) {
    throw new Error('Invalid Lingxi URL or credential configuration');
  }
  if (origin && (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || !env.LINGXI_PROXY_SECRET)) {
    throw new Error('Public Lingxi access requires an HTTPS origin and authenticated proxy secret');
  }
  const session = { type: 'realtime', output_modalities: ['text'], audio: { input: {
    format: { type: 'audio/pcm', rate: 16000 }, transcription: {}, turn_detection: {
      type: 'server_vad', create_response: false, interrupt_response: false,
      prefix_padding_ms: 100, silence_duration_ms: 200,
    },
  } } };
  if (env.LINGXI_MODEL?.trim()) {
    session.model = env.LINGXI_MODEL.trim();
    socket.searchParams.set('model', session.model);
  }
  return { key: env.LINGXI_API_KEY.trim(), mintURL: new URL('/v1/realtime/client_secrets', base).href,
    socketURL: socket.href, socketOrigin: socket.origin, session,
    publicOrigin: origin?.origin, proxySecret: env.LINGXI_PROXY_SECRET || '' };
}

function equalSecret(value, expected) {
  const a = Buffer.from(value || ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function allowedRequest(req, config) {
  let origin;
  try { origin = new URL(req.headers.origin); } catch { return false; }
  if (req.headers.origin !== origin.origin) return false;
  if (config?.publicOrigin) {
    return config.publicOrigin === origin.origin && equalSecret(req.headers['x-voice-snake-proxy-token'], config.proxySecret);
  }
  return origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
    Number(origin.port || 80) === req.socket.localPort && req.headers.host === origin.host;
}

function reply(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readSmallResponse(response) {
  if (!response.body) throw new Error('invalid upstream');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM_BODY) throw new Error('upstream too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function createSessionBroker({ config = readConfig(), fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 10000, limit = 10 } = {}) {
  let windowAt = now(), issued = 0, pending = 0;
  return async function handle(req, res) {
    const fail = (status, code) => reply(res, status, { error: { code } });
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(405, 'method_not_allowed'); return; }
    if (!allowedRequest(req, config)) { fail(403, 'origin_not_allowed'); return; }
    if (!config) { fail(503, 'lingxi_not_configured'); return; }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { fail(415, 'json_required'); return; }
    if (now() - windowAt >= 60000) { issued = 0; windowAt = now(); }
    if (issued >= limit || pending >= 4) { fail(429, 'session_rate_limited'); return; }
    issued += 1; pending += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(); fail(504, 'lingxi_timeout');
      if (!req.complete) setImmediate(() => req.destroy());
    }, timeoutMs);
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { fail(413, 'request_too_large'); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'invalid_request'); return; }
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
        fail(400, 'invalid_request'); return;
      }
      if (controller.signal.aborted) return;
      const upstream = await fetchImpl(config.mintURL, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 120 }, session: config.session }),
        signal: controller.signal });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        const code = [401, 403].includes(upstream.status) ? 'lingxi_auth_failed' : upstream.status === 429 ? 'lingxi_quota' : 'lingxi_unavailable';
        fail(502, code); return;
      }
      const data = await readSmallResponse(upstream);
      if (typeof data.value !== 'string' || !/^ek_[A-Za-z0-9_-]+$/.test(data.value) || data.value.length > 8192 ||
          !Number.isFinite(data.expires_at) || data.expires_at * 1000 <= now() + 5000 || data.expires_at * 1000 > now() + 7205000) {
        fail(502, 'lingxi_invalid_response'); return;
      }
      if (!controller.signal.aborted) reply(res, 200, { endpoint: config.socketURL,
        credential: data.value, expiresAtMs: data.expires_at * 1000, session: config.session });
    } catch {
      if (!controller.signal.aborted) fail(502, 'lingxi_unavailable');
    } finally {
      clearTimeout(timeout); res.off('close', abort); pending -= 1;
    }
  };
}

module.exports = { SESSION_PATH, readConfig, createSessionBroker };
