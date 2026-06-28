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

    if (url.pathname === '/list' && request.method === 'GET') {
      return listObjects(env);
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

    // 试三种 URL 来源 (按优先级):
    // 1) R2.dev public URL (如果 Dashboard 启用了 R2 Public Development URL,智谱能 fetch)
    // 2) R2 cloudflarestorage signed URL (worker 生成,绕过 worker.dev GFW)
    // 3) Worker /image/{key} URL (兜底,用户浏览器能访问但智谱可能 fetch 不到)
    let imageUrl, source;
    const r2DevUrl = `https://pub-waybill-images.r2.dev/${key}`;

    // 先验证 R2.dev public URL 是否可用 (HEAD 请求 200 = 可用)
    try {
      const head = await fetch(r2DevUrl, { method: 'HEAD' });
      if (head.ok) {
        imageUrl = r2DevUrl;
        source = 'r2-dev-public';
      }
    } catch (e) { /* R2.dev 没启用,fall through */ }

    // 如果 R2.dev 不可用,生成 R2 signed URL (走 cloudflarestorage.com 域名)
    if (!imageUrl && env.R2_ACCESS_KEY && env.R2_SECRET_KEY && env.R2_ACCOUNT_ID) {
      try {
        imageUrl = await generateSignedUrl(env, key);
        source = 'r2-signed';
      } catch (e) { /* 签名失败 */ }
    }

    // 最后兜底 worker /image URL
    if (!imageUrl) {
      imageUrl = `https://waybill-scan-h5.liuyongning137.workers.dev/image/${key}`;
      source = 'worker-fallback';
    }

    return json({ url: imageUrl, source, key });
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
    const list = await env.WAYBILL_IMAGES.list({ limit: 20, prefix: 'waybills/' });
    const items = list.objects.slice(-20).reverse().map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
      url: `https://waybill-scan-h5.liuyongning137.workers.dev/image/${o.key}`,
    }));
    return json({ count: items.length, items });
  } catch (e) {
    return json({ error: 'list failed: ' + e.message }, 500);
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