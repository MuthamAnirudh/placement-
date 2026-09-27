const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const redeemLimiter = rateLimit({windowMs:60*1000,max:Number(process.env.GATE_REDEEM_RATE_LIMIT_PER_MINUTE||60),standardHeaders:true,legacyHeaders:false,message:{status:'rate_limited',message:'Too many gate-pass verification attempts. Please try again shortly.'}});

function newQrToken() { return crypto.randomBytes(32).toString('base64url'); }

function idOf(v) {
  try { return BigInt(String(v)); } catch (_) { return null; }
}
function jsonPass(row) {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return { ...data, id: Number(row.id), status: row.status, studentEmail: row.studentEmail, qrToken: row.qrToken, qrUsed: row.qrUsed, qrUsedAt: row.qrUsedAt || data.qrUsedAt || null };
}
function canAccessPass(req,row){
  const role=String(req.user?.role||'').toUpperCase(), email=String(req.user?.email||'').toLowerCase();
  if(role==='ADMIN') return true;
  if(!req.user) return false;
  if(role==='STUDENT'||role==='COORDINATOR') return String(row.studentEmail||'').toLowerCase()===email;
  const data=row.data&&typeof row.data==='object'?row.data:{};
  if(role==='TEACHER') return [data.classTeacherEmail,data.teacherEmail,data.approverEmail].some(v=>String(v||'').toLowerCase()===email);
  if(role==='MENTOR') return [data.mentorEmail,data.approverEmail].some(v=>String(v||'').toLowerCase()===email);
  return false;
}

function safePublic(row) {
  if (!row) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  return {
    id: Number(row.id),
    status: row.status,
    studentName: data.studentName || null,
    rollNo: data.rollNo || null,
    branch: data.branch || null,
    destination: data.destination || null,
    reason: data.reason || null,
    outDate: data.outDate || null,
    outTime: data.outTime || null,
    returnDate: data.returnDate || null,
    returnTime: data.returnTime || null,
    decidedBy: data.decidedBy || null,
    decidedAt: data.decidedAt || null,
    qrUsedAt: row.qrUsedAt || data.qrUsedAt || null,
    // Do not expose biometric/photo/signature blobs from an unauthenticated QR endpoint.
    // The authenticated pass endpoint remains the source for the full student-owned record.
  };
}

router.get('/', requireAuth, async (req,res) => {
  try {
    const isStudent=String(req.user.role||'').toUpperCase()==='STUDENT';
    const rows = await prisma.gatePass.findMany({
      where: isStudent ? { studentEmail: String(req.user.email||'').toLowerCase() } : undefined,
      orderBy: { id: 'desc' }, take: Math.min(Math.max(Number(req.query.limit||500),1),1000)
    });
    res.json({ data: rows.filter(r=>canAccessPass(req,r)).map(jsonPass) });
  } catch (_) { res.status(500).json({ error: 'Could not load gate passes.' }); }
});

router.get('/:id', requireAuth, async (req,res) => {
  const id = idOf(req.params.id); if (id === null) return res.status(400).json({ error:'Invalid pass id.' });
  const row = await prisma.gatePass.findUnique({ where: { id } });
  if (!row) return res.status(404).json({ error:'Gate pass not found.' });
  if (String(req.user.role||'').toUpperCase()==='STUDENT' && String(row.studentEmail||'').toLowerCase() !== String(req.user.email||'').toLowerCase()) {
    return res.status(403).json({ error:'You are not allowed to access this gate pass.' });
  }
  if(!canAccessPass(req,row)) return res.status(403).json({error:'You are not allowed to access this gate pass.'});
  res.json({ data: jsonPass(row) });
});

router.put('/:id', requireAuth, async (req,res) => {
  const id = idOf(req.params.id); if (id === null) return res.status(400).json({ error:'Invalid pass id.' });
  const pass = req.body || {};
  try {
    const existing = await prisma.gatePass.findUnique({ where: { id } });
    if(existing && !canAccessPass(req,existing)) return res.status(403).json({error:'You are not allowed to modify this gate pass.'});
    const existingData = existing?.data && typeof existing.data === 'object' ? existing.data : {};
    const used = !!existing?.qrUsed;
    const data = used
      ? { ...existingData, ...pass, id: Number(id), qrUsed: true, qrUsedAt: existing.qrUsedAt || existingData.qrUsedAt || pass.qrUsedAt || new Date().toISOString() }
      : { ...existingData, ...pass, id: Number(id) };
    const qrToken = existing?.qrToken || newQrToken();
    const row = existing
      ? await prisma.gatePass.update({
          where: { id },
          data: {
            status: String(data.status || existing.status),
            studentEmail: data.studentEmail || data.email || existing.studentEmail || null,
            qrToken: existing.qrToken || qrToken,
            qrUsed: used ? true : !!data.qrUsed,
            qrUsedAt: used ? (existing.qrUsedAt || new Date()) : (data.qrUsedAt ? new Date(data.qrUsedAt) : null),
            expiresAt: data.expiresAt ? new Date(data.expiresAt) : existing.expiresAt,
            data
          }
        })
      : await prisma.gatePass.create({
          data: {
            id, status: String(data.status || 'pending'),
            studentEmail: data.studentEmail || data.email || null,
            qrToken, qrUsed: !!data.qrUsed,
            qrUsedAt: data.qrUsedAt ? new Date(data.qrUsedAt) : null,
            expiresAt: data.expiresAt ? new Date(data.expiresAt) : null, data
          }
        });
    res.json({ data: jsonPass(row) });
  } catch (err) { res.status(500).json({ error:'Could not save gate pass.' }); }
});

router.post('/bulk', requireAuth, async (req,res) => {
  const passes = Array.isArray(req.body) ? req.body : [];
  try {
    const out = [];
    const role=String(req.user?.role||'').toUpperCase(), email=String(req.user?.email||'').toLowerCase();
    for (const pass of passes) {
      if((role==='STUDENT'||role==='COORDINATOR') && String(pass?.studentEmail||pass?.email||'').toLowerCase()!==email) continue;
      const id = idOf(pass?.id);
      if (id === null) continue;
      const existing = await prisma.gatePass.findUnique({ where:{id} });
      const used = !!existing?.qrUsed;
      const oldData = existing?.data && typeof existing.data === 'object' ? existing.data : {};
      const data = used ? { ...oldData, ...pass, id:Number(id), qrUsed:true, qrUsedAt:existing.qrUsedAt || pass.qrUsedAt } : { ...oldData, ...pass, id:Number(id) };
      const qrToken = existing?.qrToken || newQrToken();
      const row = existing ? await prisma.gatePass.update({where:{id},data:{
        status:String(data.status || existing.status), studentEmail:data.studentEmail || data.email || existing.studentEmail || null,
        qrToken:existing.qrToken || qrToken, qrUsed:used ? true : !!data.qrUsed,
        qrUsedAt:used ? (existing.qrUsedAt || new Date()) : (data.qrUsedAt ? new Date(data.qrUsedAt) : null),
        expiresAt:data.expiresAt ? new Date(data.expiresAt) : existing.expiresAt, data
      }}) : await prisma.gatePass.create({data:{id,status:String(data.status||'pending'),studentEmail:data.studentEmail||data.email||null,qrToken,qrUsed:!!data.qrUsed,qrUsedAt:data.qrUsedAt?new Date(data.qrUsedAt):null,expiresAt:data.expiresAt?new Date(data.expiresAt):null,data}});
      out.push(jsonPass(row));
    }
    res.json({data:out});
  } catch (_) { res.status(500).json({error:'Could not save gate passes.'}); }
});

// on the guard device. PostgreSQL's conditional UPDATE is the concurrency boundary.
router.post('/public/redeem', redeemLimiter, async (req,res) => {
  const id = idOf(req.body?.id), token = String(req.body?.token || '').trim();
  if (id === null || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return res.status(400).json({status:'invalid'});
  try {
    const result = await prisma.$transaction(async tx => {
      const won = await tx.gatePass.updateMany({
        where: {
          id, qrToken: token, status: 'approved', qrUsed: false,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        },
        data: { qrUsed: true, qrUsedAt: new Date() }
      });
      if (won.count === 1) {
        const row = await tx.gatePass.findUnique({where:{id}});
        return { status:'ok', row };
      }
      const row = await tx.gatePass.findUnique({where:{id}});
      if (!row || row.qrToken !== token) return { status:'invalid' };
      if (row.status !== 'approved') return { status:'not_approved' };
      if (row.qrUsed) return { status:'already_used', pass:safePublic(row) };
      if (row.expiresAt && row.expiresAt <= new Date()) return { status:'expired' };
      return { status:'error' };
    });
    res.json({status:result.status, pass: result.row ? safePublic(result.row) : result.pass || null});
  } catch (err) { res.status(500).json({status:'error',message:'Could not verify this gate pass.'}); }
});

router.get('/public/usage', redeemLimiter, async (req,res) => {
  try {
    const ids = String(req.query.ids || '').split(',').slice(0,100).map(idOf).filter(Boolean);
    const rows = ids.length ? await prisma.gatePass.findMany({where:{id:{in:ids}},select:{id:true,qrUsed:true,qrUsedAt:true}}) : [];
    res.json({data:rows.map(r=>({id:Number(r.id),qr_used:r.qrUsed,qrUsedAt:r.qrUsedAt}))});
  } catch (_) { res.status(500).json({error:'Could not load gate-pass usage.'}); }
});

module.exports = router;