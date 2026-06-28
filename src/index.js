// 主 worker: 处理图床 API + serve H5 assets
// 路由:
//   POST /upload       -> 存 R2,返回 image URL
//   GET  /image/<key>  -> 从 R2 读 image bytes
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

    const imageUrl = `https://waybill-scan-h5.liuyongning137.workers.dev/image/${key}`;
    return json({ url: imageUrl, source: 'r2-assets-worker', key });
  } catch (e) {
    return json({ error: 'handler error: ' + (e.message || String(e)) }, 500);
  }
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