var UPSTASH_URL = process.env.KV_REST_API_URL;
var UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

function checkConfig() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('Faltan KV_REST_API_URL o KV_REST_API_TOKEN en Environment Variables');
  }
}

async function kv(cmd) {
  var args = Array.prototype.slice.call(arguments, 1);
  var res = await fetch(UPSTASH_URL + '/' + cmd, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  var data = await res.json();
  if (data.error) throw new Error('Redis error: ' + data.error);
  return data.result;
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
  if (!user) return error('Codigo no encontrado. Pide uno al administrador.', 404);
  return jsonResponse({ id: user.id, name: user.name, phone: user.phone || '', stickers: user.stickers || {} });
}

async function handleSave(body) {
  checkConfig();
  var id = (body.id || '').trim().toUpperCase();
  if (!id) return error('Sin usuario');
  if (!body.stickers) return error('Sin datos');
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
  var key = params.key;
  if (!key) return error('Sin clave');
  var conv = await kvGet('conv:' + key);
  if (!conv) return error('Conversacion no encontrada', 404);
  return jsonResponse(conv);
}

async function handleRead(params) {
  checkConfig();
  var id = (params.id || '').trim().toUpperCase();
  var key = params.key;
  if (!id || !key) return error('Datos incompletos');
  var conv = await kvGet('conv:' + key);
  if (!conv) return error('Conversacion no encontrada', 404);
  var changed = false;
  for (var i = 0; i < conv.messages.length; i++) {
    if (conv.messages[i].from !== id && !conv.messages[i].read) {
      conv.messages[i].read = true;
      changed = true;
    }
  }
  if (changed) await kvSet('conv:' + key, conv);
  return jsonResponse({ ok: true });
}

async function handleMsg(body) {
  checkConfig();
  var key = body.key;
  var from = (body.from || '').trim().toUpperCase();
  var text = (body.text || '').trim();
  if (!key || !from || !text) return error('Datos incompletos');
  var conv = await kvGet('conv:' + key);
  if (!conv) {
    var parts = key.split('-');
    conv = { key: key, users: parts, messages: [] };
    for (var i = 0; i < parts.length; i++) {
      var uid = parts[i];
      var list = (await kvGet('convs:' + uid)) || [];
      if (list.indexOf(key) === -1) {
        list.push(key);
        await kvSet('convs:' + uid, list);
      }
    }
  }
  conv.messages.push({ from: from, text: text.substring(0, 500), time: Date.now(), read: false });
  await kvSet('conv:' + key, conv);
  return jsonResponse({ ok: true });
}

async function handleAdminCreate(body) {
  checkConfig();
  var id = (body.id || '').trim().toUpperCase();
  var name = (body.name || '').trim();
  if (!id || !name) return error('Faltan datos');
  if (id === '__ADMIN__') return error('Codigo reservado');
  var existing = await kvGet(uk(id));
  if (existing) return error('Codigo ya existe', 409);
  var user = { id: id, name: name, phone: (body.phone || '').trim(), stickers: {}, created: Date.now() };
  await kvSet(uk(id), user);
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
        for (var j = 0; j < conv.users.length; j++) {
          if (conv.users[j] !== id) otherId = conv.users[j];
        }
        if (otherId) {
          var otherConvs = (await kvGet('convs:' + otherId)) || [];
          await kvSet('convs:' + otherId, otherConvs.filter(function (k) { return k !== conv.key; }));
        }
        await kvDel(allKeys[i]);
      }
    }
  } catch (e) { console.error('Error limpiando convs:', e); }
  return jsonResponse({ ok: true });
}

async function handleAdminReset() {
  checkConfig();
  var allKeys = await kvScan('*');
  for (var i = 0; i < allKeys.length; i++) {
    await kvDel(allKeys[i]);
  }
  return jsonResponse({ ok: true });
}

async function handleInitDemo() {
  checkConfig();
  var demoUsers = [
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
  for (var i = 0; i < demoUsers.length; i++) {
    var du = demoUsers[i];
    var existing = await kvGet(uk(du.id));
    if (existing) continue;
    var stickers = {};
    var total = 980;
    var haveCount = Math.floor(total * (0.6 + Math.random() * 0.2));
    var have = {};
    while (Object.keys(have).length < haveCount) {
      have[Math.floor(Math.random() * total) + 1] = true;
    }
    var nums = Object.keys(have);
    for (var j = 0; j < nums.length; j++) {
      var n = parseInt(nums[j]);
      stickers[n] = 1;
      if (Math.random() < 0.15) stickers[n] = 2;
      if (Math.random() < 0.05) stickers[n] = 3;
    }
    await kvSet(uk(du.id), { id: du.id, name: du.name, phone: du.phone, stickers: stickers, created: Date.now() });
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
    console.error('Handler error:', e);
    return error('Error: ' + e.message);
  }
}