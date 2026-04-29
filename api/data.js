import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // CORS para que funcione desde cualquier origen
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = new URL(req.url, 'http://localhost');
    const action = url.searchParams.get('a');

    // ===== LOGIN =====
    if (action === 'login') {
      const id = url.searchParams.get('id');
      if (!id) return res.json({ error: 'Falta id' });
      const user = await kv.get('u:' + id);
      if (!user) return res.json({ error: 'Codigo no encontrado' });
      return res.json(user);
    }

    // ===== LISTAR TODOS LOS USUARIOS =====
    if (action === 'users') {
      const ids = await kv.get('users_list') || [];
      const users = [];
      for (const id of ids) {
        const u = await kv.get('u:' + id);
        if (u) users.push(u);
      }
      return res.json(users);
    }

    // ===== GUARDAR USUARIO (registro o actualizar stickers) =====
    if (action === 'save') {
      const { id, name, phone, stickers } = req.body;
      if (!id) return res.json({ error: 'Falta id' });
      const existing = await kv.get('u:' + id) || {};
      const userData = {
        id,
        name: name || existing.name,
        phone: phone !== undefined ? phone : existing.phone,
        stickers: stickers !== undefined ? stickers : (existing.stickers || {}),
        reg: existing.reg || Date.now()
      };
      await kv.set('u:' + id, userData);
      // Agregar al indice si es nuevo
      const list = await kv.get('users_list') || [];
      if (!list.includes(id)) {
        list.push(id);
        await kv.set('users_list', list);
      }
      return res.json({ ok: true });
    }

    // ===== BUSCAR INTERCAMBIOS =====
    if (action === 'search') {
      const userId = url.searchParams.get('id');
      const mode = url.searchParams.get('mode') || 'missing';
      const user = await kv.get('u:' + userId);
      if (!user) return res.json({ results: [] });

      const ids = await kv.get('users_list') || [];
      const results = [];

      for (const oid of ids) {
        if (oid === userId) continue;
        const other = await kv.get('u:' + oid);
        if (!other || !other.stickers) continue;

        if (mode === 'missing') {
          // Cromos que me faltan y el otro tiene repetido
          for (const [num, qty] of Object.entries(other.stickers)) {
            if (qty > 1 && !user.stickers[num]) {
              results.push({ stickerNum: parseInt(num), userId: oid, userName: other.name, qty });
            }
          }
        } else {
          // Todos los repetidos del otro
          for (const [num, qty] of Object.entries(other.stickers)) {
            if (qty > 1) {
              results.push({ stickerNum: parseInt(num), userId: oid, userName: other.name, qty });
            }
          }
        }
      }
      return res.json({ results });
    }

    // ===== LISTAR CONVERSACIONES DE UN USUARIO =====
    if (action === 'convs') {
      const userId = url.searchParams.get('id');
      const keys = await kv.get('convs:' + userId) || [];
      const convs = [];
      for (const key of keys) {
        const conv = await kv.get('conv:' + key);
        if (conv) convs.push({ key, ...conv });
      }
      return res.json(convs);
    }

    // ===== OBTENER UNA CONVERSACION =====
    if (action === 'conv') {
      const key = url.searchParams.get('key');
      const conv = await kv.get('conv:' + key);
      return res.json(conv || { users: [], messages: [] });
    }

    // ===== ENVIAR MENSAJE =====
    if (action === 'msg') {
      const { key, from, text } = req.body;
      if (!key || !from || !text) return res.json({ error: 'Datos incompletos' });
      const conv = await kv.get('conv:' + key) || { users: key.split('-'), messages: [] };
      conv.messages.push({ from, text, time: Date.now(), read: false });
      await kv.set('conv:' + key, conv);
      // Asegurar que ambos usuarios tienen la conv en su lista
      for (const uid of conv.users) {
        const list = await kv.get('convs:' + uid) || [];
        if (!list.includes(key)) {
          list.push(key);
          await kv.set('convs:' + uid, list);
        }
      }
      return res.json({ ok: true });
    }

    // ===== MARCAR COMO LEIDO =====
    if (action === 'read') {
      const key = url.searchParams.get('key');
      const userId = url.searchParams.get('id');
      const conv = await kv.get('conv:' + key);
      if (conv) {
        conv.messages.forEach(m => { if (m.from !== userId) m.read = true; });
        await kv.set('conv:' + key, conv);
      }
      return res.json({ ok: true });
    }

    // ===== ADMIN: CREAR USUARIO =====
    if (action === 'adminCreate') {
      const { id, name, phone } = req.body;
      if (!id || !name) return res.json({ error: 'Falta id o nombre' });
      const existing = await kv.get('u:' + id);
      if (existing) return res.json({ error: 'Codigo ya existe' });
      await kv.set('u:' + id, { id, name, phone: phone || '', stickers: {}, reg: Date.now() });
      const list = await kv.get('users_list') || [];
      list.push(id);
      await kv.set('users_list', list);
      return res.json({ ok: true, code: id });
    }

    // ===== ADMIN: ELIMINAR USUARIO =====
    if (action === 'adminDelete') {
      const id = url.searchParams.get('id');
      if (!id) return res.json({ error: 'Falta id' });
      await kv.del('u:' + id);
      let list = await kv.get('users_list') || [];
      list = list.filter(x => x !== id);
      await kv.set('users_list', list);
      // Eliminar sus conversaciones
      const convKeys = await kv.get('convs:' + id) || [];
      for (const key of convKeys) {
        const conv = await kv.get('conv:' + key);
        if (conv) {
          const otherId = conv.users.find(u => u !== id);
          if (otherId) {
            let otherConvs = await kv.get('convs:' + otherId) || [];
            otherConvs = otherConvs.filter(k => k !== key);
            await kv.set('convs:' + otherId, otherConvs);
          }
          await kv.del('conv:' + key);
        }
      }
      await kv.del('convs:' + id);
      return res.json({ ok: true });
    }

    // ===== ADMIN: REINICAR TODO =====
    if (action === 'adminReset') {
      const list = await kv.get('users_list') || [];
      for (const id of list) await kv.del('u:' + id);
      for (const id of list) await kv.del('convs:' + id);
      await kv.del('users_list');
      // No se pueden borrar todas las keys de conv: sin scan, pero las nuevas funcionaran
      return res.json({ ok: true });
    }

    // ===== INICIALIZAR DATOS DEMO =====
    if (action === 'initDemo') {
      const demoUsers = [
        { id: 'CARLOS01', name: 'Carlos Mendez', phone: '555-0101' },
        { id: 'MARIA02', name: 'Maria Garcia', phone: '555-0102' },
        { id: 'PEDRO03', name: 'Pedro Sanchez', phone: '555-0103' },
        { id: 'LUISA04', name: 'Luisa Ramirez', phone: '555-0104' },
        { id: 'JORGE05', name: 'Jorge Torres', phone: '555-0105' },
        { id: 'ANA06', name: 'Ana Lopez', phone: '555-0106' }
      ];
      const total = 980;
      for (const u of demoUsers) {
        const stickers = {};
        const howMany = 200 + Math.floor(Math.random() * 400);
        const used = new Set();
        while (used.size < howMany) {
          const r = Math.floor(Math.random() * total) + 1;
          if (!used.has(r)) { used.add(r); stickers[r] = Math.random() < 0.15 ? 2 : 1; }
        }
        await kv.set('u:' + u.id, { id: u.id, name: u.name, phone: u.phone, stickers, reg: Date.now() });
      }
      await kv.set('users_list', demoUsers.map(u => u.id));
      // Conversacion demo
      const convKey = 'CARLOS01-MARIA02';
      await kv.set('conv:' + convKey, {
        users: ['CARLOS01', 'MARIA02'],
        messages: [
          { from: 'CARLOS01', text: 'Hola Maria, vi que tienes el Messi repetido!', time: Date.now() - 3600000, read: true },
          { from: 'MARIA02', text: 'Si, te lo cambio por el Mbappe si lo tienes repetido', time: Date.now() - 3500000, read: true },
          { from: 'CARLOS01', text: 'Trato hecho! Cuando nos vemos?', time: Date.now() - 3400000, read: true }
        ]
      });
      await kv.set('convs:CARLOS01', [convKey]);
      await kv.set('convs:MARIA02', [convKey]);
      return res.json({ ok: true });
    }

    return res.json({ error: 'Accion no valida' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}