const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const SHARED_OWNER = 'PUBLIC';
const PRIVATE_OWNER = (req) => req.user && req.user.sub;

function scopeFrom(req) {
  return String(req.query.scope || req.body?.scope || 'private') === 'shared' ? 'shared' : 'private';
}
function ownerFor(req, scope) {
  return scope === 'shared' ? SHARED_OWNER : PRIVATE_OWNER(req);
}
function canRead(req, scope) {
  return scope === 'shared' || !!req.user;
}

async function optionalUser(req, res, next) {
  if (req.headers.authorization) {
    try {
      const { verifyAccessToken } = require('../auth');
      const token = req.headers.authorization.split(' ')[1];
      if (token) req.user = verifyAccessToken(token);
    } catch (_) {}
  }
  next();
}

router.use(optionalUser);

router.get('/kv', async (req, res) => {
  try {
    const scope = scopeFrom(req);
    if (!canRead(req, scope)) return res.status(401).json({ error: 'Authentication required.' });
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'key is required.' });
    if (scope === 'shared' && /^(account:|pwreset:|login_attempts:)/i.test(key) && !req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (scope === 'shared' && /^account:/i.test(key) && req.user) {
      const target=key.slice('account:'.length).toLowerCase();
      const role=String(req.user.role||'').toUpperCase();
      if (role!=='ADMIN' && target!==String(req.user.email||'').toLowerCase()) return res.status(403).json({error:'You are not allowed to access this account record.'});
    }
    const ownerId = ownerFor(req, scope);
    const row = await prisma.portalKV.findFirst({ where: { scope, key, ownerId } });
    res.json({ value: row ? row.value : null });
  } catch (err) {
    res.status(500).json({ error: 'Could not read stored value.' });
  }
});

router.get('/kv/list', async (req, res) => {
  try {
    const scope = scopeFrom(req);
    if (!canRead(req, scope)) return res.status(401).json({ error: 'Authentication required.' });
    const prefix = String(req.query.prefix || '');
    if (scope === 'shared' && /^(account:|pwreset:|login_attempts:)/i.test(prefix) && !req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (scope === 'shared' && /^account:/i.test(prefix) && req.user) {
      const target=prefix.slice('account:'.length).toLowerCase();
      const role=String(req.user.role||'').toUpperCase();
      if (role!=='ADMIN' && target && target!==String(req.user.email||'').toLowerCase()) return res.status(403).json({error:'You are not allowed to list this account record.'});
    }
    const ownerId = ownerFor(req, scope);
    const rows = await prisma.portalKV.findMany({
      where: { scope, ownerId, ...(prefix ? { key: { startsWith: prefix } } : {}) },
      select: { key: true },
      orderBy: { key: 'asc' },
      take: Math.min(Number(req.query.limit || 5000), 5000),
    });
    res.json({ keys: rows.map(r => r.key) });
  } catch (err) {
    res.status(500).json({ error: 'Could not list stored values.' });
  }
});

router.put('/kv', requireAuth, async (req, res) => {
  try {
    const scope = scopeFrom(req);
    const key = String(req.body?.key || '');
    if (!key) return res.status(400).json({ error: 'key is required.' });
    const ownerId = ownerFor(req, scope);
    let value=req.body.value;
    if(scope==='shared' && key.startsWith('account:') && value && typeof value==='object' && !Array.isArray(value)) {
      value={...value}; delete value.passwordHash; delete value.salt; delete value.legacySalt; delete value.codeHash; delete value.recoveryCode;
      if(String(req.user?.role||'').toUpperCase()!=='ADMIN') delete value.role;
    }
    const row = await prisma.portalKV.upsert({
      where: { scope_key_ownerId: { scope, key, ownerId } },
      create: { scope, key, ownerId, value },
      update: { value },
    });
    // Keep the authentication/profile record authoritative for account metadata. Password
    // changes are handled by /api/portal-auth/change-password and never accept a browser hash.
    if(scope==='shared' && key.startsWith('account:') && req.user){
      const email=key.slice('account:'.length).toLowerCase();
      const canSync=email===String(req.user.email||'').toLowerCase() || String(req.user.role||'').toUpperCase()==='ADMIN';
      if(canSync){
        const targetUser=await prisma.user.findUnique({where:{email}});
        if(targetUser) {
          const isAdmin=String(req.user.role||'').toUpperCase()==='ADMIN';
          const data={
            ...(value?.name!==undefined?{name:String(value.name).trim().slice(0,200)}:{}),
            ...(value?.branch!==undefined?{branch:value.branch||null}:{}),
            ...(value?.year!==undefined?{year:value.year||null}:{}),
            ...(value?.photo!==undefined?{photo:value.photo||null}:{}),
            ...(value?.recoveryEmail!==undefined?{recoveryEmail:value.recoveryEmail||null}:{}),
            ...(value?.faceDescriptor!==undefined?{faceDescriptor:value.faceDescriptor||null}:{}),
            ...(value?.fingerprintCredentialId!==undefined?{fingerprintCredentialId:value.fingerprintCredentialId||null}:{}),
            ...(value?.classTeacherEmail!==undefined?{classTeacherEmail:value.classTeacherEmail||null}:{}),
            ...(value?.mentorEmail!==undefined?{mentorEmail:value.mentorEmail||null}:{}),
            ...(value?.mustChangePassword!==undefined?{mustChangePassword:!!value.mustChangePassword}:{}),
          };
          if(isAdmin && value?.role!==undefined && ['student','admin','coordinator','teacher','mentor'].includes(String(value.role).toLowerCase())) data.role=String(value.role).toUpperCase();
          await prisma.user.update({where:{id:targetUser.id},data});
        }
      }
    }
    res.json({ ok: true, value: row.value });
  } catch (err) {
    res.status(500).json({ error: 'Could not save stored value.' });
  }
});

router.delete('/kv', requireAuth, async (req, res) => {
  try {
    const scope = scopeFrom(req);
    const key = String(req.query.key || req.body?.key || '');
    if (!key) return res.status(400).json({ error: 'key is required.' });
    const ownerId = ownerFor(req, scope);
    await prisma.portalKV.deleteMany({ where: { scope, key, ownerId } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete stored value.' });
  }
});

const TABLES = new Set([
  'notices','events','clubs','faculty','timetable_entries',
  'library_books','library_loans','event_rsvps'
]);

function assertTable(req, res) {
  const table = String(req.params.table || '');
  if (!TABLES.has(table)) {
    res.status(404).json({ error: 'Unknown data table.' });
    return null;
  }
  return table;
}
function recordKey(row) {
  if (row && row.id !== undefined && row.id !== null) return String(row.id);
  return require('crypto').randomUUID();
}

router.get('/data/:table', async (req, res) => {
  try {
    const table = assertTable(req, res); if (!table) return;
    const rows = await prisma.campusRecord.findMany({ where: { tableName: table }, take: 5000 });
    let out = rows.map(r => r.data);
    const filters = req.query.filters ? JSON.parse(String(req.query.filters)) : {};
    for (const [k,v] of Object.entries(filters || {})) out = out.filter(r => String(r?.[k] ?? '') === String(v));
    const orderBy = req.query.orderBy ? String(req.query.orderBy) : '';
    if (orderBy) {
      const asc = String(req.query.ascending || 'false') === 'true';
      out.sort((a,b) => {
        const av = a?.[orderBy], bv = b?.[orderBy];
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    const limit = Math.min(Number(req.query.limit || 100), 5000);
    res.json({ data: out.slice(0, limit) });
  } catch (err) {
    res.status(400).json({ error: 'Could not read data table.' });
  }
});

router.post('/data/:table', requireAuth, async (req, res) => {
  try {
    const table = assertTable(req, res); if (!table) return;
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    const created = [];
    for (const row of rows) {
      const key = recordKey(row);
      const data = { ...row, ...(row.id === undefined ? { id: key } : {}) };
      const saved = await prisma.campusRecord.create({ data: { tableName: table, recordKey: key, data } });
      created.push(saved.data);
    }
    res.json({ data: Array.isArray(req.body) ? created : created[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not insert data.' });
  }
});

router.put('/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const table = assertTable(req, res); if (!table) return;
    const key = String(req.params.id);
    const existing = await prisma.campusRecord.findUnique({ where: { tableName_recordKey: { tableName: table, recordKey: key } } });
    if (!existing) return res.status(404).json({ error: 'Record not found.' });
    const data = { ...existing.data, ...(req.body || {}), id: existing.data?.id ?? req.params.id };
    const saved = await prisma.campusRecord.update({ where: { id: existing.id }, data: { data } });
    res.json({ data: saved.data });
  } catch (err) {
    res.status(500).json({ error: 'Could not update data.' });
  }
});

router.delete('/data/:table/:id', requireAuth, async (req, res) => {
  try {
    const table = assertTable(req, res); if (!table) return;
    await prisma.campusRecord.deleteMany({ where: { tableName: table, recordKey: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete data.' });
  }
});

router.post('/data/:table/bulk', requireAuth, async (req, res) => {
  try {
    const table = assertTable(req, res); if (!table) return;
    const rows = Array.isArray(req.body) ? req.body : [];
    const created = [];
    for (const row of rows) {
      const key = recordKey(row);
      const data = { ...row, ...(row.id === undefined ? { id: key } : {}) };
      const saved = await prisma.campusRecord.upsert({
        where: { tableName_recordKey: { tableName: table, recordKey: key } },
        create: { tableName: table, recordKey: key, data },
        update: { data },
      });
      created.push(saved.data);
    }
    res.json({ data: created });
  } catch (err) {
    res.status(500).json({ error: 'Could not save data.' });
  }
});

module.exports = router;
