/*
  Biblia NBV — Cloudflare Worker: IA Bíblica
  Variable de entorno requerida: AI_API_KEY (clave DeepSeek)
  Despliegue: wrangler deploy
  Secreto:    wrangler secret put AI_API_KEY
*/

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsResponse();
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

    let body;
    // Audio (transcripción con Whisper) o JSON (chat con DeepSeek)
    const contentType = request.headers.get('content-type') || '';
    if (contentType.startsWith('audio/')) {
      return transcribeAudio(request, env);
    }
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return jsonResponse({ error: 'No messages provided' }, 400);
    }

    if (!env.AI_API_KEY) {
      return jsonResponse({ error: 'AI_API_KEY not configured' }, 500);
    }

    const aiRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        max_tokens: 8192,
        temperature: 0.7,
      }),
    });

    const aiData = await aiRes.json();

    if (aiData.error) {
      return jsonResponse({ error: aiData.error.message }, 502);
    }

    const reply = aiData.choices?.[0]?.message?.content || 'Sin respuesta.';
    return jsonResponse({ reply });
  },
};

// ── Transcripción de audio con Whisper (Workers AI) ────────────
// Requiere el binding [ai] en wrangler.toml. El cliente parte el
// audio en trozos (~8MB) y los envía secuencialmente.

async function transcribeAudio(request, env) {
  if (!env.AI || typeof env.AI.run !== 'function') {
    return jsonResponse({ error: 'Workers AI no configurado: agrega el binding [ai] y haz wrangler deploy' }, 500);
  }
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) {
    return jsonResponse({ error: 'Audio vacío' }, 400);
  }
  if (buf.byteLength > 25 * 1024 * 1024) {
    return jsonResponse({ error: 'Trozo muy grande: máximo 25MB por parte' }, 413);
  }
  const url = new URL(request.url);
  const bytes = new Uint8Array(buf);
  // base64 por tramos (evita desbordar la pila con audios grandes)
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }

  let out;
  try {
    out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: btoa(bin),
      language: url.searchParams.get('lang') || 'es',
    });
  } catch (e) {
    return jsonResponse({ error: 'Whisper falló: ' + (e?.message || e) }, 502);
  }
  return jsonResponse({ text: out?.text || '' });
}
