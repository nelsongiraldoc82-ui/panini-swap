var UPSTASH_URL = process.env.KV_REST_API_URL;
var UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function error(msg, status) {
  return jsonResponse({ error: msg }, status || 500);
}

async function readBody(req) {
  try { return await req.json(); }
  catch (e) { return {}; }
}

function uk(id) { return 'user:' + id; }

function checkConfig() {
  if (!UPSTASH_URL) throw new Error('KV_REST_API_URL no existe. Ejecuta: npx vercel env add KV_REST_API_URL production preview');
  if (!UPSTASH_TOKEN) throw new Error('KV_REST_API_TOKEN no existe. Ejecuta: npx vercel env add KV_REST_API_TOKEN production preview');
}

async function kv(cmd) {
  var args = Array.prototype.slice.call(arguments, 1);
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 8000);
  try {
    var res = await fetch(UPSTASH_URL + '/' + cmd, {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + UPSTASH_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    var data = await res.json();
    if (data.error) throw new Error('Redis: ' + data.error);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function kvGet(key) {
  var val = await kv('get', key);
  return val ? JSON.parse(val) : null;
}

async function kvSet(key, value) {
  await kv('set', key, JSON.stringify(value));
}

async function kvDel(key) {
  await kv('del', key);
}

async function kvScan(pattern) {
  var cursor = '0';
  var allKeys = [];
  do {
    var res = await kv('scan', cursor, 'MATCH', pattern, 'COUNT', '100');
    cursor = res[0];
    if (res[1]) allKeys = allKeys.concat(res[1]);
  } while (cursor !== '0');
  return allKeys;
}

async function handlePing() {
  checkConfig();
  try {
    await kv('ping');
    return jsonResponse({ redis: 'CONECTADO', url: UPSTASH_URL.substring(0, 30) + '...' });
  } catch (e) {
    return jsonResponse({ redis: 'ERROR: ' + e.message, url: UPSTASH_URL.substring(0, 30) + '...' }, 500);
  }
}

async function handleUsers() {
  checkConfig();
  var keys = await kvScan('user:*');
  if (!keys.length) return jsonResponse([]);
  var users = [];
  for (var i = 0; i < keys.length; i++) {
    var u = await kvGet(keys[i]);
    if (u) users.push({ id: u.id, name: u.name, phone: u.phone || '' });
  }
  return jsonResponse(users);
}

async function handleLogin(params) {
  checkConfig();
  var id = (params.id || '').trim().toUpperCase();
  if (!id) return error('Codigo vacio');
  if (id === '__ADMIN__') return error('Codigo reservado');
  var user = await kvGet(uk(id));
  if (!user) return error('Codigo no encontrado.', 404);
  return jsonResponse({ id: user.id, name: user.name, phone: user.phone || '', stickers: user.stickers || {} });
}

async function handleSave(body) {
  checkConfig();
  var id = (body.id || '').trim().toUpperCase();
  if (!id || !body.stickers) return error('Datos incompletos');
  var user = await kvGet(uk(id));
  if (!user) return error('Usuario no encontrado', 404);
  user.stickers = body.stickers;
  await kvSet(uk(id), user);
  return jsonResponse({ ok: true });
}

async function handleSearch(params) {
  checkConfig();
  var myId = (params.id || '').trim().toUpperCase();
  var mode = params.mode || 'missing';
  if (!myId) return error('Sin usuario');
  var me = await kvGet(uk(myId));
  if (!me) return error('Usuario no encontrado', 404);
  var myStickers = me.stickers || {};
  var keys = await kvScan('user:*');
  if (!keys.length) return jsonResponse({ results: [] });
  var results = [];
  for (var i = 0; i < keys.length; i++) {
    var other = await kvGet(keys[i]);
    if (!other || other.id === myId) continue;
    var theirStickers = other.stickers || {};
    var nums = Object.keys(theirStickers);
    for (var j = 0; j < nums.length; j++) {
      var num = parseInt(nums[j]);
      var theirQty = theirStickers[num];
      if (theirQty < 1) continue;
      var myQty = myStickers[num] || 0;
      if (mode === 'missing' && myQty >= 1) continue;
      results.push({ userId: other.id, userName: other.name, stickerNum: num, qty: theirQty });
    }
  }
  results.sort(function (a, b) {
    var am = (myStickers[a.stickerNum] || 0) === 0 ? 0 : 1;
    var bm = (myStickers[b.stickerNum] || 0) === 0 ? 0 : 1;
    if (am !== bm) return am - bm;
    return a.userId.localeCompare(b.userId);
  });
  return jsonResponse({ results: results });
}

async function handleConvs(params) {
  checkConfig();
  var id = (params.id || '').trim().toUpperCase();
  if (!id) return error('Sin usuario');
  var convKeys = await kvGet('convs:' + id);
  if (!convKeys || !convKeys.length) return jsonResponse([]);
  var convs = [];
  for (var i = 0; i < convKeys.length; i++) {
    var c = await kvGet('conv:' + convKeys[i]);
    if (c) convs.push(c);
  }
  return jsonResponse(convs);
}

async function handleConv(params) {
  checkConfig();
  var conv = await kvGet('conv:' + params.key);
  if (!conv) return error('No encontrada', 404);
  return jsonResponse(conv);
}

async function handleRead(params) {
  checkConfig();
  var conv = await kvGet('conv:' + params.key);
  if (!conv) return error('No encontrada', 404);
  var id = params.id;
  var changed = false;
  for (var i = 0; i < conv.messages.length; i++) {
    if (conv.messages[i].from !== id && !conv.messages[i].read) {
      conv.messages[i].read = true;
      changed = true;
    }
  }
  if (changed) await kvSet('conv:' + params.key, conv);
  return jsonResponse({ ok: true });
}

async function handleMsg(body) {
  checkConfig();
  if (!body.key || !body.from || !body.text) return error('Datos incompletos');
  var conv = await kvGet('conv:' + body.key);
  if (!conv) {
    var parts = body.key.split('-');
    conv = { key: body.key, users: parts, messages: [] };
    for (var i = 0; i < parts.length; i++) {
      var list = (await kvGet('convs:' + parts[i])) || [];
      if (list.indexOf(body.key) === -1) { list.push(body.key); await kvSet('convs:' + parts[i], list); }
    }
  }
  conv.messages.push({ from: body.from, text: body.text.substring(0, 500), time: Date.now(), read: false });
  await kvSet('conv:' + body.key, conv);
  return jsonResponse({ ok: true });
}

async function handleAdminCreate(body) {
  checkConfig();
  var id = (body.id || '').trim().toUpperCase();
  var name = (body.name || '').trim();
  if (!id || !name) return error('Faltan datos');
  if (id === '__ADMIN__') return error('Reservado');
  if (await kvGet(uk(id))) return error('Ya existe', 409);
  await kvSet(uk(id), { id: id, name: name, phone: (body.phone || '').trim(), stickers: {}, created: Date.now() });
  return jsonResponse({ ok: true, code: id });
}

async function handleAdminDelete(params) {
  checkConfig();
  var id = (params.id || '').trim().toUpperCase();
  if (!id) return error('Sin usuario');
  await kvDel(uk(id));
  await kvDel('convs:' + id);
  try {
    var allKeys = await kvScan('conv:*');
    for (var i = 0; i < allKeys.length; i++) {
      var conv = await kvGet(allKeys[i]);
      if (conv && conv.users && conv.users.indexOf(id) !== -1) {
        var otherId = null;
        for (var j = 0; j < conv.users.length; j++) { if (conv.users[j] !== id) otherId = conv.users[j]; }
        if (otherId) {
          var oc = (await kvGet('convs:' + otherId)) || [];
          await kvSet('convs:' + otherId, oc.filter(function (k) { return k !== conv.key; }));
        }
        await kvDel(allKeys[i]);
      }
    }
  } catch (e) {}
  return jsonResponse({ ok: true });
}

async function handleAdminReset() {
  checkConfig();
  var allKeys = await kvScan('*');
  for (var i = 0; i < allKeys.length; i++) { await kvDel(allKeys[i]); }
  return jsonResponse({ ok: true });
}

async function handleInitDemo() {
  checkConfig();
  var demo = [
    { id: 'CARLOS01', name: 'Carlos Perez', phone: '555-0101' },
    { id: 'MARIA02', name: 'Maria Garcia', phone: '555-0102' },
    { id: 'JUAN03', name: 'Juan Rodriguez', phone: '555-0103' },
    { id: 'ANA04', name: 'Ana Martinez', phone: '555-0104' },
    { id: 'PEDRO05', name: 'Pedro Lopez', phone: '555-0105' },
    { id: 'LAURA06', name: 'Laura Fernandez', phone: '555-0106' },
    { id: 'DIEGO07', name: 'Diego Torres', phone: '555-0107' },
    { id: 'SOFIA08', name: 'Sofia Herrera', phone: '555-0108' }
  ];
  var created = 0;
  for (var i = 0; i < demo.length; i++) {
    var d = demo[i];
    if (await kvGet(uk(d.id))) continue;
    var stickers = {};
    var have = {};
    var target = Math.floor(980 * (0.6 + Math.random() * 0.2));
    while (Object.keys(have).length < target) { have[Math.floor(Math.random() * 980) + 1] = true; }
    var nums = Object.keys(have);
    for (var j = 0; j < nums.length; j++) {
      var n = parseInt(nums[j]);
      stickers[n] = 1;
      if (Math.random() < 0.15) stickers[n] = 2;
      if (Math.random() < 0.05) stickers[n] = 3;
    }
    await kvSet(uk(d.id), { id: d.id, name: d.name, phone: d.phone, stickers: stickers, created: Date.now() });
    created++;
  }
  return jsonResponse({ ok: true, created: created });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return jsonResponse({}, 204);
  var url = new URL(req.url, 'http://localhost');
  var action = url.searchParams.get('a') || '';
  try {
    if (req.method === 'GET') {
      switch (action) {
        case 'ping': return handlePing();
        case 'users': return handleUsers();
        case 'login': return handleLogin(Object.fromEntries(url.searchParams));
        case 'search': return handleSearch(Object.fromEntries(url.searchParams));
        case 'convs': return handleConvs(Object.fromEntries(url.searchParams));
        case 'conv': return handleConv(Object.fromEntries(url.searchParams));
        case 'read': return handleRead(Object.fromEntries(url.searchParams));
        case 'adminDelete': return handleAdminDelete(Object.fromEntries(url.searchParams));
        case 'adminReset': return handleAdminReset();
        case 'initDemo': return handleInitDemo();
        default: return error('Accion no reconocida: ' + action);
      }
    }
    if (req.method === 'POST') {
      var body = await readBody(req);
      switch (action) {
        case 'save': return handleSave(body);
        case 'msg': return handleMsg(body);
        case 'adminCreate': return handleAdminCreate(body);
        default: return error('Accion no reconocida: ' + action);
      }
    }
    return error('Metodo no permitido', 405);
  } catch (e) {
    return error('Error: ' + e.message);
  }
}