export default async function handler(req) {
  return new Response(JSON.stringify({
    env_url: process.env.KV_REST_API_URL ? 'SI: ' + process.env.KV_REST_API_URL.substring(0, 20) + '...' : 'NO EXISTE',
    env_token: process.env.KV_REST_API_TOKEN ? 'SI: ' + process.env.KV_REST_API_TOKEN.substring(0, 8) + '...' : 'NO EXISTE',
    method: req.method,
    url: req.url
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}