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
        max_tokens: 1000,
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
