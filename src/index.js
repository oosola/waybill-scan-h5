// 主 worker: 处理图床 API + serve H5 assets
// 路由:
//   POST /upload       -> 存 R2,返回 image URL (R2 signed URL,智谱国内可能能 fetch)
//   GET  /image/<key>  -> 从 R2 读 image bytes (本地兜底)
//   GET  /list         -> 列 R2 最近 20 个对象
//   *                 -> serve H5 assets (index.html 等)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: 'waybill-scan-h5',
        r2_bound: !!env.WAYBILL_IMAGES,
        assets_bound: !!env.ASSETS,
        account_id: env.R2_ACCOUNT_ID || '?',
      });
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }

    if (url.pathname.startsWith('/image/') && request.method === 'GET') {
      return handleGetImage(request, env, url);
    }

    // DELETE /image/<key>  -> 从 R2 删除 object (供图床历史页面删除用)
    if (url.pathname.startsWith('/image/') && request.method === 'DELETE') {
      return handleDeleteImage(request, env, url);
    }

    if (url.pathname === '/list' && request.method === 'GET') {
      return listObjects(env);
    }

    // 别名:/history GET 走 listObjects, DELETE 清空所有
    if (url.pathname === '/history' && request.method === 'GET') {
      return listObjects(env);
    }
    if (url.pathname === '/history' && request.method === 'DELETE') {
      return handleDeleteAll(env);
    }

    // 默认 serve static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleUpload(request, env) {
  try {
    if (!env.WAYBILL_IMAGES) {
      return json({ error: 'R2 bucket WAYBILL_IMAGES not bound' }, 500);
    }

    let file;
    const ct = request.headers.get('content-type') || '';
    if (ct.indexOf('multipart/form-data') >= 0) {
      const formData = await request.formData();
      file = formData.get('file');
    } else if (ct.indexOf('text/plain') >= 0 || ct.indexOf('application/json') >= 0) {
      const text = await request.text();
      let body;
      try { body = JSON.parse(text); }
      catch (e) { return json({ error: 'invalid JSON body' }, 400); }
      if (!body.dataUrl) return json({ error: 'no dataUrl' }, 400);
      const m = /^data:([^;]+);base64,(.*)$/.exec(body.dataUrl);
      if (!m) return json({ error: 'bad dataUrl format' }, 400);
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      file = { type: m[1], bytes };
    } else {
      return json({ error: 'unsupported content-type: ' + ct }, 400);
    }
    if (!file) return json({ error: 'no file' }, 400);

    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    const ext = (file.type || 'image/jpeg').split('/')[1] || 'jpg';
    const key = `waybills/${ts}-${rand}.${ext}`;

    const body = file.bytes || (await file.arrayBuffer());
    await env.WAYBILL_IMAGES.put(key, body, {
      httpMetadata: { contentType: file.type || 'image/jpeg' },
    });

// 策略:直接返回 R2.dev public URL (Dashboard 已启用 Public Development URL)
    // 实际 R2.dev subdomain 是 Cloudflare 随机分配的 (pub-<random>.r2.dev)
    const r2DevUrl = `https://pub-db13d5896aa74f90916123b3697a4b47.r2.dev/${key}`;
    return json({ url: r2DevUrl, source: 'r2-dev-public', key });
  } catch (e) {
    return json({ error: 'handler error: ' + (e.message || String(e)) }, 500);
  }
}

// 生成 R2 signed URL (AWS SigV4,15 分钟有效)
async function generateSignedUrl(env, key) {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const bucket = 'waybill-images';
  const accessKey = env.R2_ACCESS_KEY;
  const secretKey = env.R2_SECRET_KEY;
  const expiresIn = 900; // 15 分钟

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;

  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${bucket}/${encodeURI(key)}`;
  const canonicalQuery = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  }).toString();

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  return `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(buf);
}

async function hmac(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const ck = await crypto.subtle.importKey(
    'raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(data)));
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleGetImage(request, env, url) {
  if (!env.WAYBILL_IMAGES) {
    return new Response('R2 not bound', {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const key = decodeURIComponent(url.pathname.slice('/image/'.length));
  try {
    const obj = await env.WAYBILL_IMAGES.get(key);
    if (!obj) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    return new Response('Read error: ' + e.message, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}

async function listObjects(env) {
  if (!env.WAYBILL_IMAGES) return json({ error: 'R2 not bound' }, 500);
  try {
    const list = await env.WAYBILL_IMAGES.list({ limit: 50, prefix: 'waybills/' });
    const items = list.objects.slice(-50).reverse().map((o) => ({
      key: o.key,
      size: o.size,
      ts: o.uploaded ? new Date(o.uploaded).getTime() : Date.now(),
      url: `https://pub-db13d5896aa74f90916123b3697a4b47.r2.dev/${o.key}`,
      source: 'r2-dev-public',
    }));
    return json({ count: items.length, items });
  } catch (e) {
    return json({ error: 'list failed: ' + e.message }, 500);
  }
}

async function handleDeleteImage(request, env, url) {
  if (!env.WAYBILL_IMAGES) {
    return json({ error: 'R2 not bound' }, 500);
  }
  const key = decodeURIComponent(url.pathname.slice('/image/'.length));
  try {
    await env.WAYBILL_IMAGES.delete(key);
    return json({ ok: true, key });
  } catch (e) {
    return json({ error: 'delete failed: ' + e.message }, 500);
  }
}

async function handleDeleteAll(env) {
  if (!env.WAYBILL_IMAGES) {
    return json({ error: 'R2 not bound' }, 500);
  }
  try {
    // R2 没有批量删除 API,只能 list + 逐个 delete
    const list = await env.WAYBILL_IMAGES.list({ prefix: 'waybills/' });
    let deleted = 0;
    let failed = 0;
    // 并发删除 (一次最多 10 个并发,避免 Worker 超时)
    const keys = list.objects.map(o => o.key);
    const chunks = [];
    for (let i = 0; i < keys.length; i += 10) {
      chunks.push(keys.slice(i, i + 10));
    }
    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map(k => env.WAYBILL_IMAGES.delete(k))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') deleted++;
        else failed++;
      }
    }
    return json({ ok: true, deleted, failed, total: keys.length });
  } catch (e) {
    return json({ error: 'delete all failed: ' + e.message }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}