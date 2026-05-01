import { kv } from '@vercel/kv';

// === HELPERS ===
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function errorResponse(msg, status = 400) {
  return jsonResponse({ error: msg }, status);
}

// === LEER BODY ===
async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// === USER KEY ===
function uk(id) { return 'user:' + id; }

// === HANDLERS ===

// Listar todos los usuarios
async function handleUsers() {
  try {
    const keys = await kv.keys('user:*');
    if (!keys || !keys.length) return jsonResponse([]);
    const users = await Promise.all(
      keys.map(k => kv.get(k))
    );
    // Filtrar nulos y quitar stickers del listado (pesado)
    return jsonResponse(
      users.filter(Boolean).map(u => ({
        id: u.id,
        name: u.name,
        phone: u.phone || ''
      }))
    );
  } catch (e) {
    console.error('handleUsers:', e);
    return errorResponse('Error al leer usuarios');
  }
}

// Login
async function handleLogin(params) {
  const id = (params.id || '').trim().toUpperCase();
  if (!id) return errorResponse('Codigo vacio');
  if (id === '__ADMIN__') return errorResponse('Codigo reservado');

  let user = await kv.get(uk(id));
  if (!user) return errorResponse('Codigo no encontrado. Pide uno al administrador.');

  return jsonResponse({
    id: user.id,
    name: user.name,
    phone: user.phone || '',
    stickers: user.stickers || {}
  });
}

// Guardar stickers
async function handleSave(body) {
  const id = (body.id || '').trim().toUpperCase();
  if (!id) return errorResponse('Sin usuario');
  if (!body.stickers) return errorResponse('Sin datos');

  const user = await kv.get(uk(id));
  if (!user) return errorResponse('Usuario no encontrado');

  user.stickers = body.stickers;
  await kv.set(uk(id), user);
  return jsonResponse({ ok: true });
}

// Buscar cromos que otros tienen y a mi me faltan
async function handleSearch(params) {
  const myId = (params.id || '').trim().toUpperCase();
  const mode = params.mode || 'missing';
  if (!myId) return errorResponse('Sin usuario');

  const me = await kv.get(uk(myId));
  if (!me) return errorResponse('Usuario no encontrado');

  const myStickers = me.stickers || {};
  const keys = await kv.keys('user:*');
  if (!keys || !keys.length) return jsonResponse({ results: [] });

  const others = await Promise.all(keys.map(k => kv.get(k)));
  const results = [];

  for (const other of others) {
    if (!other || other.id === myId) continue;
    const theirStickers = other.stickers || {};

    for (const numStr in theirStickers) {
      const num = parseInt(numStr);
      const theirQty = theirStickers[num];
      if (theirQty < 1) continue;

      const myQty = myStickers[num] || 0;

      if (mode === 'missing' && myQty >= 1) continue;
      // mode 'all' = mostrar todos los que otros tienen como repetidos

      results.push({
        userId: other.id,
        userName: other.name,
        stickerNum: num,
        qty: theirQty
      });
    }
  }

  // Ordenar: primero los que mas me faltan (qty=0), luego por usuario
  results.sort((a, b) => {
    const aMissing = (myStickers[a.stickerNum] || 0) === 0 ? 0 : 1;
    const bMissing = (myStickers[b.stickerNum] || 0) === 0 ? 0 : 1;
    if (aMissing !== bMissing) return aMissing - bMissing;
    return a.userId.localeCompare(b.userId);
  });

  return jsonResponse({ results });
}

// Obtener conversaciones de un usuario
async function handleConvs(params) {
  const id = (params.id || '').trim().toUpperCase();
  if (!id) return errorResponse('Sin usuario');

  const convKeys = await kv.get('convs:' + id);
  if (!convKeys || !convKeys.length) return jsonResponse([]);

  const convs = await Promise.all(convKeys.map(k => kv.get('conv:' + k)));
  return jsonResponse(convs.filter(Boolean));
}

// Obtener una conversacion especifica
async function handleConv(params) {
  const key = params.key;
  if (!key) return errorResponse('Sin clave de conversacion');

  const conv = await kv.get('conv:' + key);
  if (!conv) return errorResponse('Conversacion no encontrada');

  return jsonResponse(conv);
}

// Marcar mensajes como leidos
async function handleRead(params) {
  const id = (params.id || '').trim().toUpperCase();
  const key = params.key;
  if (!id || !key) return errorResponse('Datos incompletos');

  const conv = await kv.get('conv:' + key);
  if (!conv) return errorResponse('Conversacion no encontrada');

  let changed = false;
  for (const msg of conv.messages) {
    if (msg.from !== id && !msg.read) {
      msg.read = true;
      changed = true;
    }
  }

  if (changed) await kv.set('conv:' + key, conv);
  return jsonResponse({ ok: true });
}

// Enviar mensaje
async function handleMsg(body) {
  const key = body.key;
  const from = (body.from || '').trim().toUpperCase();
  const text = (body.text || '').trim();
  if (!key || !from || !text) return errorResponse('Datos incompletos');

  let conv = await kv.get('conv:' + key);

  if (!conv) {
    // Crear conversacion nueva
    const parts = key.split('-');
    conv = {
      key: key,
      users: parts,
      messages: []
    };

    // Registrar en ambos usuarios
    for (const uid of parts) {
      const list = (await kv.get('convs:' + uid)) || [];
      if (!list.includes(key)) {
        list.push(key);
        await kv.set('convs:' + uid, list);
      }
    }
  }

  conv.messages.push({
    from: from,
    text: text.substring(0, 500),
    time: Date.now(),
    read: false
  });

  await kv.set('conv:' + key, conv);
  return jsonResponse({ ok: true });
}

// Admin: crear usuario
async function handleAdminCreate(body) {
  const id = (body.id || '').trim().toUpperCase();
  const name = (body.name || '').trim();
  if (!id || !name) return errorResponse('Faltan datos');
  if (id === '__ADMIN__') return errorResponse('Codigo reservado');

  const existing = await kv.get(uk(id));
  if (existing) return errorResponse('Codigo ya existe');

  const user = {
    id: id,
    name: name,
    phone: (body.phone || '').trim(),
    stickers: {},
    created: Date.now()
  };

  await kv.set(uk(id), user);
  return jsonResponse({ ok: true, code: id });
}

// Admin: eliminar usuario
async function handleAdminDelete(params) {
  const id = (params.id || '').trim().toUpperCase();
  if (!id) return errorResponse('Sin usuario');

  // Eliminar de KV
  await kv.del(uk(id));
  await kv.del('convs:' + id);

  // Eliminar de conversaciones donde participa
  try {
    const allConvKeys = await kv.keys('conv:*');
    for (const ck of allConvKeys) {
      const conv = await kv.get(ck);
      if (conv && conv.users && conv.users.includes(id)) {
        // Eliminar la conv de la lista del otro usuario
        const otherId = conv.users.find(u => u !== id);
        if (otherId) {
          const otherConvs = (await kv.get('convs:' + otherId)) || [];
          const filtered = otherConvs.filter(k => k !== conv.key);
          await kv.set('convs:' + otherId, filtered);
        }
        await kv.del(ck);
      }
    }
  } catch (e) {
    console.error('Error limpiando convs:', e);
  }

  return jsonResponse({ ok: true });
}

// Admin: reiniciar toda la base de datos
async function handleAdminReset() {
  try {
    const allKeys = await kv.keys('*');
    if (allKeys && allKeys.length) {
      await Promise.all(allKeys.map(k => kv.del(k)));
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error('handleAdminReset:', e);
    return errorResponse('Error al reiniciar');
  }
}

// Admin: cargar datos demo
async function handleInitDemo() {
  const demoUsers = [
    { id: 'CARLOS01', name: 'Carlos Perez', phone: '555-0101' },
    { id: 'MARIA02', name: 'Maria Garcia', phone: '555-0102' },
    { id: 'JUAN03', name: 'Juan Rodriguez', phone: '555-0103' },
    { id: 'ANA04', name: 'Ana Martinez', phone: '555-0104' },
    { id: 'PEDRO05', name: 'Pedro Lopez', phone: '555-0105' },
    { id: 'LAURA06', name: 'Laura Fernandez', phone: '555-0106' },
    { id: 'DIEGO07', name: 'Diego Torres', phone: '555-0107' },
    { id: 'SOFIA08', name: 'Sofia Herrera', phone: '555-0108' }
  ];

  for (const du of demoUsers) {
    const existing = await kv.get(uk(du.id));
    if (existing) continue;

    // Generar stickers aleatorios: ~60-80% del album, algunos repetidos
    const stickers = {};
    const total = 980;
    const haveCount = Math.floor(total * (0.6 + Math.random() * 0.2));

    // Seleccionar cuales tiene
    const have = new Set();
    while (have.size < haveCount) {
      have.add(Math.floor(Math.random() * total) + 1);
    }

    for (const num of have) {
      stickers[num] = 1;
      // ~15% probabilidad de repetido extra
      if (Math.random() < 0.15) {
        stickers[num] = 2;
      }
      // ~5% probabilidad de tener 3
      if (Math.random() < 0.05) {
        stickers[num] = 3;
      }
    }

    await kv.set(uk(du.id), {
      id: du.id,
      name: du.name,
      phone: du.phone,
      stickers: stickers,
      created: Date.now()
    });
  }

  return jsonResponse({ ok: true, count: demoUsers.length });
}

// === HANDLER PRINCIPAL ===
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return jsonResponse({}, 204);
  }

  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('a') || '';

  // GET requests
  if (req.method === 'GET') {
    const params = Object.fromEntries(url.searchParams);

    switch (action) {
      case 'users': return handleUsers();
      case 'login': return handleLogin(params);
      case 'search': return handleSearch(params);
      case 'convs': return handleConvs(params);
      case 'conv': return handleConv(params);
      case 'read': return handleRead(params);
      case 'adminDelete': return handleAdminDelete(params);
      case 'adminReset': return handleAdminReset();
      case 'initDemo': return handleInitDemo();
      default: return errorResponse('Accion GET no reconocida');
    }
  }

  // POST requests
  if (req.method === 'POST') {
    const body = await readBody(req);

    switch (action) {
      case 'save': return handleSave(body);
      case 'msg': return handleMsg(body);
      case 'adminCreate': return handleAdminCreate(body);
      default: return errorResponse('Accion POST no reconocida');
    }
  }

  return errorResponse('Metodo no permitido', 405);
}