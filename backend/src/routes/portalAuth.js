const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { hashPassword, verifyPassword, signAccessToken, generateRefreshToken, hashRefreshToken, refreshExpiryDate } = require('../auth');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
const authLimiter = rateLimit({windowMs:15*60*1000,max:Number(process.env.PORTAL_AUTH_RATE_LIMIT_PER_15MIN||30),standardHeaders:true,legacyHeaders:false,message:{error:'Too many authentication attempts. Please try again later.'}});
router.use(authLimiter);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roleMap = { student:'STUDENT', admin:'ADMIN', coordinator:'COORDINATOR', teacher:'TEACHER', mentor:'MENTOR' };
const RECOVERY_TTL_MS = 10 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_COOLDOWN_MS = 30 * 1000;

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function passwordIsStrong(password) {
  const p = String(password || '');
  return p.length >= 8 && p.length <= 200;
}
function randomRecoveryCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashRecoveryCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
function safeEqualHex(a,b) {
  try {
    const aa=Buffer.from(String(a),'hex'), bb=Buffer.from(String(b),'hex');
    return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
  } catch (_) { return false; }
}
async function deliverRecoveryCode(toEmail, code) {
  const serviceId=String(process.env.RECOVERY_EMAILJS_SERVICE_ID||'').trim();
  const templateId=String(process.env.RECOVERY_EMAILJS_TEMPLATE_ID||'').trim();
  const publicKey=String(process.env.RECOVERY_EMAILJS_PUBLIC_KEY||'').trim();
  const privateKey=String(process.env.RECOVERY_EMAILJS_PRIVATE_KEY||'').trim();
  if(!serviceId || !templateId || !publicKey) throw new Error('Password recovery delivery is not configured on the server.');
  const body={service_id:serviceId,template_id:templateId,user_id:publicKey,template_params:{to_email:toEmail,passcode:code,purpose:'password reset',expires_in:'10 minutes'}};
  if(privateKey) body.accessToken=privateKey;
  const response=await fetch('https://api.emailjs.com/api/v1.0/email/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok) throw new Error(`Recovery delivery failed with HTTP ${response.status}`);
}
function genericRecoveryResponse(res) {
  return res.status(200).json({ok:true,message:'If an account exists, recovery instructions have been sent.'});
}


function publicUser(u, account = null) {
  return {
    id:u.id,email:u.email,name:u.name,role:String(u.role).toLowerCase(),branch:u.branch || account?.branch || null,
    year:u.year || account?.year || '', graduationYear:u.graduationYear || null,
    photo:u.photo || account?.photo || null, mustChangePassword:!!u.mustChangePassword,
    classTeacherEmail:u.classTeacherEmail || account?.classTeacherEmail || '',
    mentorEmail:u.mentorEmail || account?.mentorEmail || '',
  };
}
async function issue(user, req, res, account=null) {
  const accessToken=signAccessToken(user), refreshToken=generateRefreshToken();
  await prisma.refreshToken.create({data:{tokenHash:hashRefreshToken(refreshToken),userId:user.id,expiresAt:refreshExpiryDate(),userAgent:req.headers['user-agent']||null,ip:req.ip}});
  res.cookie('cp_refresh', refreshToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.COOKIE_SAMESITE||'lax',path:'/api/auth',maxAge:Number(process.env.JWT_REFRESH_EXPIRES_DAYS||30)*24*60*60*1000});
  res.cookie('cp_access', accessToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.COOKIE_SAMESITE||'lax',path:'/',maxAge:15*60*1000});
  res.json({accessToken,user:publicUser(user,account)});
}
async function mirrorAccount(user, extra={}) {
  const existing = await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:`account:${user.email}`}});
  const old = existing?.value && typeof existing.value === 'object' ? existing.value : {};
  const value = {...old,...extra,email:user.email,name:user.name,role:String(user.role).toLowerCase(),branch:user.branch||old.branch||'',year:user.year||old.year||'',photo:user.photo||old.photo||null,mustChangePassword:!!user.mustChangePassword};
  delete value.passwordHash; delete value.salt; delete value.legacySalt; delete value.codeHash; delete value.recoveryCode;
  await prisma.portalKV.upsert({where:{scope_key_ownerId:{scope:'shared',key:`account:${user.email}`,ownerId:'PUBLIC'}},create:{scope:'shared',key:`account:${user.email}`,ownerId:'PUBLIC',value},update:{value}});
  return value;
}

router.post('/bootstrap-admin', async (req,res)=>{
  try{
    const email=String(process.env.PORTAL_ADMIN_EMAIL||'').trim().toLowerCase();
    const password=String(process.env.PORTAL_ADMIN_PASSWORD||'');
    const name=String(process.env.PORTAL_ADMIN_NAME||'Professor-In-Charge (T&P)');
    if(!email||password.length<8) return res.status(503).json({error:'PORTAL_ADMIN_EMAIL and PORTAL_ADMIN_PASSWORD must be configured on the backend.'});
    let u=await prisma.user.findUnique({where:{email}});
    if(!u){
      u=await prisma.user.create({data:{email,passwordHash:await hashPassword(password),name,role:'ADMIN'}});
      await mirrorAccount(u,{email,name,role:'admin'});
    }
    return res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not bootstrap the administrator account.'});}
});

router.post('/register', async (req,res)=>{
  try {
    const b=req.body||{}, email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
    if(!EMAIL_RE.test(email)) return res.status(400).json({error:'A valid email is required.'});
    if(password.length<8) return res.status(400).json({error:'Password must be at least 8 characters.'});
    if(!b.name?.trim()) return res.status(400).json({error:'Name is required.'});
    if(await prisma.user.findUnique({where:{email}})) return res.status(409).json({error:'An account with this email already exists.'});
    const coord=await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:'coordinator-emails'}});
    const coordinatorEmails=Array.isArray(coord?.value)?coord.value.map(x=>String(x).toLowerCase()):[];
    const role=coordinatorEmails.includes(email)?'COORDINATOR':'STUDENT';
    const user=await prisma.user.create({data:{
      email,passwordHash:await hashPassword(password),name:String(b.name).trim(),role,
      branch:b.branch||null,year:b.year||null,photo:b.photo||null,recoveryEmail:b.recoveryEmail||null,
      mustChangePassword:!!b.mustChangePassword,faceDescriptor:b.faceDescriptor||null,fingerprintCredentialId:b.fingerprintCredentialId||null,
      classTeacherEmail:b.classTeacherEmail||null,mentorEmail:b.mentorEmail||null
    }});
    await mirrorAccount(user,{...b,passwordHash:undefined,salt:undefined});
    await issue(user,req,res);
  } catch(e){ res.status(500).json({error:'Could not create account.'}); }
});

router.post('/login', async (req,res)=>{
  try {
    const email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||'');
    const user=await prisma.user.findUnique({where:{email}});
    if(!user) return res.status(401).json({error:'Invalid email or password.'});
    let ok=false;
    try { ok=await verifyPassword(password,user.passwordHash); } catch(_){}
    // Backward-compatible verifier for imported legacy SHA-256+salt records.
    if(!ok){
      const acc=await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:`account:${email}`}});
      const a=acc?.value;
      if(a?.salt && a?.passwordHash){
        const legacy=crypto.createHash('sha256').update(`${a.salt}::${password}`).digest('hex');
        ok=legacy===a.passwordHash;
        if(ok) await prisma.user.update({where:{id:user.id},data:{passwordHash:await hashPassword(password)}});
      }
    }
    if(!ok) return res.status(401).json({error:'Invalid email or password.'});
    await prisma.user.update({where:{id:user.id},data:{lastLoginAt:new Date()}});
    await issue({...user,lastLoginAt:new Date()},req,res);
  } catch(e){res.status(500).json({error:'Login failed.'});}
});

router.get('/lookup', async (req,res)=>{
  try{
    const email=String(req.query.email||'').trim().toLowerCase();
    const u=await prisma.user.findUnique({where:{email}});
    const acc=await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:`account:${email}`}});
    const a=acc?.value && typeof acc.value==='object'?acc.value:{};
    if(!u && !acc) return res.status(404).json({error:'Account not found.'});
    res.json({user:u?publicUser(u,a):{email,name:a.name||'',role:a.role||'student',branch:a.branch||'',year:a.year||'',photo:a.photo||null}});
  }catch(_){res.status(500).json({error:'Lookup failed.'});}
});

router.post('/face-login', async (req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase(), descriptor=Array.isArray(req.body?.descriptor)?req.body.descriptor:null;
    const u=await prisma.user.findUnique({where:{email}});
    if(!u || !Array.isArray(u.faceDescriptor) || !descriptor) return res.status(401).json({error:'Face ID is not configured for this account.'});
    const stored=u.faceDescriptor.map(Number), live=descriptor.map(Number);
    if(stored.length!==live.length || !stored.length) return res.status(401).json({error:'Face ID did not match.'});
    let sum=0; for(let i=0;i<stored.length;i++){const d=stored[i]-live[i];sum+=d*d;}
    const distance=Math.sqrt(sum);
    const threshold=Number(process.env.FACE_MATCH_THRESHOLD||0.48);
    if(distance>=threshold) return res.status(401).json({error:'Face ID did not match.'});
    await issue(u,req,res);
  }catch(_){res.status(500).json({error:'Face login failed.'});}
});

router.post('/fingerprint-login', async (req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    const credentialId=String(req.body?.credentialId||'');
    const u=await prisma.user.findUnique({where:{email}});
    if(!u || !credentialId || u.fingerprintCredentialId!==credentialId) return res.status(401).json({error:'Fingerprint is not registered for this account.'});
    await issue(u,req,res);
  }catch(_){res.status(500).json({error:'Fingerprint login failed.'});}
});

router.patch('/me',requireAuth,async(req,res)=>{
  try{
    const patch=req.body||{};
    const u=await prisma.user.update({where:{id:req.user.sub},data:{
      ...(patch.name!==undefined?{name:String(patch.name).trim()}:{}),
      ...(patch.branch!==undefined?{branch:patch.branch||null}:{}),
      ...(patch.year!==undefined?{year:patch.year||null}:{}),
      ...(patch.photo!==undefined?{photo:patch.photo||null}:{}),
      ...(patch.recoveryEmail!==undefined?{recoveryEmail:patch.recoveryEmail||null}:{}),
      ...(patch.faceDescriptor!==undefined?{faceDescriptor:patch.faceDescriptor||null}:{}),
      ...(patch.fingerprintCredentialId!==undefined?{fingerprintCredentialId:patch.fingerprintCredentialId||null}:{}),
      ...(patch.classTeacherEmail!==undefined?{classTeacherEmail:patch.classTeacherEmail||null}:{}),
      ...(patch.mentorEmail!==undefined?{mentorEmail:patch.mentorEmail||null}:{}),
    }});
    await mirrorAccount(u,patch);
    res.json({user:publicUser(u)});
  }catch(_){res.status(500).json({error:'Could not update account.'});}
});

router.post('/recovery/start',rateLimit({windowMs:15*60*1000,max:5,standardHeaders:true,legacyHeaders:false}),async(req,res)=>{
  try{
    const email=normalizeEmail(req.body?.email);
    if(!EMAIL_RE.test(email)) return genericRecoveryResponse(res);
    const now=new Date();
    const u=await prisma.user.findUnique({where:{email}});
    if(!u) return genericRecoveryResponse(res);
    const recent=await prisma.passwordRecovery.findFirst({where:{userId:u.id,createdAt:{gt:new Date(Date.now()-RECOVERY_COOLDOWN_MS)},usedAt:null},orderBy:{createdAt:'desc'}});
    if(recent) return genericRecoveryResponse(res);
    await prisma.passwordRecovery.updateMany({where:{userId:u.id,usedAt:null},data:{usedAt:now}});
    const code=randomRecoveryCode();
    const record=await prisma.passwordRecovery.create({data:{userId:u.id,tokenHash:hashRecoveryCode(code),expiresAt:new Date(Date.now()+RECOVERY_TTL_MS)}});
    const deliveryEmail=u.recoveryEmail||u.email;
    try { await deliverRecoveryCode(deliveryEmail,code); }
    catch (deliveryError) {
      await prisma.passwordRecovery.update({where:{id:record.id},data:{usedAt:new Date()}});
      if(config.isProduction) return genericRecoveryResponse(res);
      return res.status(503).json({ok:false,error:'Password recovery delivery is not configured. Configure the server recovery email settings and try again.'});
    }
    return genericRecoveryResponse(res);
  }catch(_){ return genericRecoveryResponse(res); }
});

router.post('/recovery/verify',rateLimit({windowMs:15*60*1000,max:10,standardHeaders:true,legacyHeaders:false}),async(req,res)=>{
  try{
    const email=normalizeEmail(req.body?.email), code=String(req.body?.code||'').trim();
    if(!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({error:'Invalid recovery code.'});
    const u=await prisma.user.findUnique({where:{email}});
    if(!u) return res.status(400).json({error:'Invalid or expired recovery code.'});
    const row=await prisma.passwordRecovery.findFirst({where:{userId:u.id,usedAt:null},orderBy:{createdAt:'desc'}});
    if(!row || row.expiresAt<=new Date()) return res.status(400).json({error:'This code has expired. Please request a new one.'});
    if(row.attempts>=RECOVERY_MAX_ATTEMPTS) return res.status(429).json({error:'Too many incorrect attempts. Please request a new code.'});
    const actual=hashRecoveryCode(code);
    if(!safeEqualHex(actual,row.tokenHash)) {
      const attempts=row.attempts+1;
      await prisma.passwordRecovery.update({where:{id:row.id},data:{attempts,usedAt:attempts>=RECOVERY_MAX_ATTEMPTS?new Date():null}});
      return res.status(400).json({error:'Invalid or expired recovery code.'});
    }
    await prisma.passwordRecovery.update({where:{id:row.id},data:{verifiedAt:new Date()}});
    return res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not verify recovery code.'});}
});

router.post('/recovery/reset',async(req,res)=>{
  try{
    const email=normalizeEmail(req.body?.email), next=String(req.body?.newPassword||'');
    if(!EMAIL_RE.test(email) || !passwordIsStrong(next)) return res.status(400).json({error:'A valid email and password of at least 8 characters are required.'});
    const u=await prisma.user.findUnique({where:{email}});
    if(!u) return res.status(400).json({error:'Your verification has expired. Please start over.'});
    const row=await prisma.passwordRecovery.findFirst({where:{userId:u.id,usedAt:null},orderBy:{createdAt:'desc'}});
    if(!row?.verifiedAt || row.expiresAt<=new Date()) return res.status(400).json({error:'Your verification has expired. Please start over.'});
    await prisma.$transaction(async tx=>{
      await tx.user.update({where:{id:u.id},data:{passwordHash:await hashPassword(next),mustChangePassword:false}});
      await tx.refreshToken.updateMany({where:{userId:u.id,revokedAt:null},data:{revokedAt:new Date()}});
      await tx.passwordRecovery.update({where:{id:row.id},data:{usedAt:new Date()}});
    });
    res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not reset password.'});}
});

router.post('/change-password',requireAuth,async(req,res)=>{
  try{
    const current=String(req.body?.currentPassword||''), next=String(req.body?.newPassword||'');
    if(!passwordIsStrong(next)) return res.status(400).json({error:'New password must be at least 8 characters.'});
    const u=await prisma.user.findUnique({where:{id:req.user.sub}});
    if(!u || !(await verifyPassword(current,u.passwordHash))) return res.status(401).json({error:'Current password is incorrect.'});
    const updated=await prisma.user.update({where:{id:u.id},data:{passwordHash:await hashPassword(next),mustChangePassword:false}});
    await mirrorAccount(updated,{mustChangePassword:false});
    res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not change password.'});}
});

router.post('/admin/create',requireAuth,async(req,res)=>{
  try{
    if(String(req.user.role).toUpperCase()!=='ADMIN') return res.status(403).json({error:'Admin access required.'});
    const b=req.body||{}, email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
    if(!EMAIL_RE.test(email)||password.length<8||!b.name) return res.status(400).json({error:'Valid email, name and password are required.'});
    if(await prisma.user.findUnique({where:{email}})) return res.status(409).json({error:'An account with this email already exists.'});
    const role=roleMap[String(b.role||'student').toLowerCase()]||'STUDENT';
    const user=await prisma.user.create({data:{email,passwordHash:await hashPassword(password),name:String(b.name).trim(),role,branch:b.branch||null,year:b.year||null,mustChangePassword:!!b.mustChangePassword,recoveryEmail:b.recoveryEmail||null}});
    await mirrorAccount(user,b);
    res.json({user:publicUser(user)});
  }catch(_){res.status(500).json({error:'Could not create account.'});}
});

module.exports=router;
