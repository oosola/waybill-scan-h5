// _worker.js — Workers fetch handler
// 这个文件作为 Worker 的入口,接管所有请求:
//   - /upload 路径:接受 POST 图片,转发到 catbox.moe / sm.ms,返回 URL
//   - 其他路径:serve 静态资源(index.html 等)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // /upload 端点
    if (url.pathname === '/upload' && request.method === 'POST') {
      return handleUpload(request);
    }

    // 其他:serve 静态资源
    // Workers + assets 模式下,env.ASSETS 是静态资源 binding
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    // fallback:返回 index.html
    return new Response('static assets not bound', { status: 500 });
  },
};

async function handleUpload(request) {
  try {
    let file;
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('multipart/form-data')) {
      const formData = await request.formData();
      file = formData.get('file');
    } else if (ct.includes('application/json')) {
      const { dataUrl } = await request.json();
      if (!dataUrl) return json({ error: 'no dataUrl' }, 400);
      const blob = await fetch(dataUrl).then(r => r.blob());
      file = new File([blob], 'waybill.jpg', { type: blob.type || 'image/jpeg' });
    } else {
      return json({ error: 'unsupported content-type: ' + ct }, 400);
    }
    if (!file) return json({ error: 'no file' }, 400);

    // 首选 catbox.moe
    try {
      const fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('fileToUpload', file);
      const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
      if (res.ok) {
        const urlText = (await res.text()).trim();
        if (urlText.startsWith('https://')) {
          return json({ url: urlText, source: 'catbox' });
        }
      }
      throw new Error('catbox HTTP ' + res.status);
    } catch (e1) {
      // fallback: sm.ms v1
      try {
        const fd = new FormData();
        fd.append('smfile', file);
        const res = await fetch('https://sm.ms/api/v1/upload', { method: 'POST', body: fd });
        const j = await res.json();
        if (j && j.code === 'success' && j.data && j.data.url) {
          return json({ url: j.data.url, source: 'sm.ms' });
        }
        throw new Error('sm.ms: ' + (j && j.msg ? j.msg : res.status));
      } catch (e2) {
        return json({ error: 'all hosts failed. catbox: ' + e1.message + ' | sm.ms: ' + e2.message }, 502);
      }
    }
  } catch (e) {
    return json({ error: 'handler error: ' + e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
