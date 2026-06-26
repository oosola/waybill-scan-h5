// src/index.js — waybill-scan-h5 Worker fetch handler
// 处理路由:
//   POST /upload -> 接受图片,转发到 catbox.moe / sm.ms,返回 URL(同时记录到 KV)
//   GET  /history -> 列出上传历史
//   其他路径 -> serve 静态资源(env.ASSETS)

export default {
  async fetch(request, env, ctx) {
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

    if (url.pathname === '/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }
    if (url.pathname === '/history' && request.method === 'GET') {
      return listHistory(url, env);
    }

    // 其他:serve 静态资源
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('ASSETS binding not found', { status: 500 });
  },
};

async function handleUpload(request, env) {
  try {
    let file;
    const ct = request.headers.get('content-type') || '';
    if (ct.indexOf('multipart/form-data') >= 0) {
      const formData = await request.formData();
      file = formData.get('file');
    } else if (ct.indexOf('application/json') >= 0) {
      const body = await request.json();
      if (!body.dataUrl) return json({ error: 'no dataUrl' }, 400);
      const blob = await fetch(body.dataUrl).then(r => r.blob());
      file = new File([blob], 'waybill.jpg', { type: blob.type || 'image/jpeg' });
    } else {
      return json({ error: 'unsupported content-type: ' + ct }, 400);
    }
    if (!file) return json({ error: 'no file' }, 400);

    let uploadedUrl, source, lastError;
    try {
      const fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('fileToUpload', file);
      const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
      if (res.ok) {
        const urlText = (await res.text()).trim();
        if (urlText.indexOf('https://') === 0) {
          uploadedUrl = urlText; source = 'catbox';
        }
      }
      if (!uploadedUrl) throw new Error('catbox HTTP ' + res.status);
    } catch (e1) {
      lastError = e1.message;
      try {
        const fd = new FormData();
        fd.append('smfile', file);
        const res = await fetch('https://sm.ms/api/v1/upload', { method: 'POST', body: fd });
        const j = await res.json();
        if (j && j.code === 'success' && j.data && j.data.url) {
          uploadedUrl = j.data.url; source = 'sm.ms';
        } else {
          throw new Error('sm.ms: ' + (j && j.msg ? j.msg : res.status));
        }
      } catch (e2) {
        return json({ error: 'all hosts failed. catbox: ' + lastError + ' | sm.ms: ' + e2.message }, 502);
      }
    }

    if (uploadedUrl && env.HISTORY) {
      try {
        const ts = Date.now();
        const key = ts + '-' + Math.random().toString(36).slice(2, 10);
        const record = { url: uploadedUrl, source: source, ts: ts };
        await env.HISTORY.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });
      } catch (e) {
        // 记录失败不影响主流程
      }
    }

    return json({ url: uploadedUrl, source: source });
  } catch (e) {
    return json({ error: 'handler error: ' + e.message }, 500);
  }
}

async function listHistory(url, env) {
  if (!env.HISTORY) return json({ error: 'KV not bound' }, 500);
  try {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
    const cursor = url.searchParams.get('cursor') || undefined;
    const list = await env.HISTORY.list({ limit, cursor });
    const values = await Promise.all(list.keys.map(k => env.HISTORY.get(k.name).catch(() => null)));
    const items = [];
    for (let i = 0; i < list.keys.length; i++) {
      if (values[i]) {
        try { items.push(JSON.parse(values[i])); } catch (e) {}
      }
    }
    items.sort((a, b) => b.ts - a.ts);
    return json({ count: items.length, items: items, cursor: list.list_complete ? null : list.cursor });
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
