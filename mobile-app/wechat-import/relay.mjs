import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const limit = 4 * 1024 * 1024, ttl = 10 * 60_000;
const key = () => randomBytes(24).toString('base64url');
const fail = status => { throw Object.assign(new Error('request rejected'), { status }); };
function matches(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function body(req, max) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > max) fail(413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Single-user service. Listen behind an HTTPS reverse proxy, never log requests or file bodies.
export function importRelay(createKey, now = Date.now) {
  if (!/^[!-~]{32,128}$/.test(createKey ?? '')) throw new Error('请设置 32 至 128 位随机 ALCOR_IMPORT_KEY');
  const jobs = new Map();
  const sweep = () => { for (const [id, job] of jobs) if (job.until <= now()) jobs.delete(id); };
  const timer = setInterval(sweep, 30_000).unref();
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      res.writeHead(status, { 'Content-Type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json',
        'Cache-Control': 'no-store', 'Content-Length': bytes.length }).end(bytes);
    };
    try {
      sweep();
      const auth = req.headers.authorization ?? '';
      const authorized = token => { if (!matches(auth, 'Bearer ' + token)) fail(401); };
      if (req.url === '/v1/imports' && req.method === 'POST') {
        authorized(createKey);
        if (jobs.size >= 8) fail(429);
        const id = key(), write = key(), read = key();
        jobs.set(id, { write, read, until: now() + ttl, files: [], ready: false });
        return reply(201, { id, write, read });
      }
      const match = /^\/v1\/imports\/([\w-]{32})(?:\/(finish|files\/([0-2])))?$/.exec(req.url);
      if (!match) fail(404);
      const [, id, action, slot] = match, job = jobs.get(id);
      if (!job) fail(410);
      if (req.method === 'POST' && action) {
        authorized(job.write);
        if (job.busy) fail(409);
        job.busy = true;
        try {
          if (action === 'finish') {
            const n = Number((await body(req, 8)).toString());
            if (![1, 2, 3].includes(n) || job.files.length !== n) fail(409);
            job.ready = true;
            return reply(200, { ready: true });
          }
          if (job.ready || +slot > job.files.length) fail(409);
          const bytes = await body(req, limit + 8192);
          let data;
          try { data = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData(); }
          catch { fail(400); }
          const file = data.get('file'), name = data.get('name');
          if (!(file instanceof File) || typeof name !== 'string' || !name.trim() || name.length > 200 ||
              /[\\/\x00-\x1f\x7f]/.test(name)) fail(400);
          if (file.size > limit) fail(413);
          job.files[+slot] = { name, bytes: Buffer.from(await file.arrayBuffer()) };
          return reply(200, { slot: +slot });
        } finally { job.busy = false; }
      }
      authorized(job.read);
      if (req.method === 'DELETE' && !action) { jobs.delete(id); return reply(200, {}); }
      if (req.method !== 'GET') fail(405);
      if (!action) return reply(200, job.ready ? { ready: true, files: job.files.map(f => ({ name: f.name, size: f.bytes.length })) } : { ready: false });
      if (slot === undefined || !job.ready || !job.files[+slot]) fail(409);
      reply(200, job.files[+slot].bytes);
    } catch (e) { if (!res.destroyed) reply(e.status ?? 500, {}); }
  });
  server.requestTimeout = 90_000;
  server.on('close', () => { clearInterval(timer); jobs.clear(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  importRelay(process.env.ALCOR_IMPORT_KEY).listen(Number(process.env.PORT ?? 8787), '127.0.0.1');
}
