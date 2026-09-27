/*
 * Import a JSON export of the former portal persistence into PostgreSQL.
 * This script intentionally has no dependency on any hosted database SDK.
 *
 * Supported top-level arrays:
 *   kv / tnp_kv
 *   campusRecords / campus
 *   gatePasses / gate_passes
 *   users / accounts
 *
 * Example:
 *   node scripts/import-postgresql-export.js ./portal-export.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/import-postgresql-export.js <export.json>');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const prisma = new PrismaClient();

const arr = (...names) => {
  for (const n of names) if (Array.isArray(input[n])) return input[n];
  return [];
};
const asDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const idString = (v) => String(v ?? crypto.randomUUID());

(async () => {
  let counts = { users: 0, kv: 0, campus: 0, gatePasses: 0 };

  for (const raw of arr('users', 'accounts')) {
    const email = String(raw.email || '').trim().toLowerCase();
    if (!email) continue;
    const roleMap = { admin: 'ADMIN', student: 'STUDENT', coordinator: 'COORDINATOR', teacher: 'TEACHER', mentor: 'MENTOR' };
    const role = roleMap[String(raw.role || 'student').toLowerCase()] || 'STUDENT';
    const legacyHash = raw.passwordHash && raw.salt ? String(raw.passwordHash) : null;
    const passwordHash = raw.bcryptPasswordHash || await bcrypt.hash('MIGRATION_PENDING_RESET_REQUIRED', 12);
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        id: raw.id ? String(raw.id) : undefined,
        email,
        passwordHash,
        name: String(raw.name || email.split('@')[0]),
        role,
        branch: raw.branch || null,
        graduationYear: raw.graduationYear ? Number(raw.graduationYear) : null,
        year: raw.year || null,
        photo: raw.photo || null,
        recoveryEmail: raw.recoveryEmail || null,
        mustChangePassword: !!raw.mustChangePassword,
        faceDescriptor: raw.faceDescriptor || null,
        fingerprintCredentialId: raw.fingerprintCredentialId || null,
        classTeacherEmail: raw.classTeacherEmail || null,
        mentorEmail: raw.mentorEmail || null,
        legacySalt: raw.legacySalt || raw.salt || null,
      },
      update: {
        name: String(raw.name || email.split('@')[0]), role, branch: raw.branch || null,
        year: raw.year || null, photo: raw.photo || null, recoveryEmail: raw.recoveryEmail || null,
        mustChangePassword: !!raw.mustChangePassword, faceDescriptor: raw.faceDescriptor || null,
        fingerprintCredentialId: raw.fingerprintCredentialId || null,
        classTeacherEmail: raw.classTeacherEmail || null, mentorEmail: raw.mentorEmail || null,
        ...(legacyHash ? { legacySalt: raw.salt || null } : {}),
      },
    });
    if (legacyHash) {
      await prisma.portalKV.upsert({
        where: { scope_key_ownerId: { scope: 'shared', key: `account:${email}`, ownerId: 'PUBLIC' } },
        create: { scope: 'shared', key: `account:${email}`, ownerId: 'PUBLIC', value: { ...raw, email, role: String(role).toLowerCase(), passwordHash: legacyHash, salt: raw.salt } },
        update: { value: { ...raw, email, role: String(role).toLowerCase(), passwordHash: legacyHash, salt: raw.salt } },
      });
    }
    counts.users++;
  }

  for (const raw of arr('kv', 'tnp_kv')) {
    const key = String(raw.key || '');
    if (!key) continue;
    const scope = String(raw.scope || (raw.shared ? 'shared' : 'private')) === 'shared' ? 'shared' : 'private';
    const ownerId = scope === 'shared' ? 'PUBLIC' : String(raw.ownerId || raw.userId || 'PUBLIC');
    await prisma.portalKV.upsert({
      where: { scope_key_ownerId: { scope, key, ownerId } },
      create: { id: raw.id ? String(raw.id) : undefined, scope, key, ownerId, value: raw.value === null || raw.value === undefined ? {} : raw.value, createdAt: asDate(raw.createdAt) || undefined, updatedAt: asDate(raw.updatedAt) || undefined },
      update: { value: raw.value === null || raw.value === undefined ? {} : raw.value },
    });
    counts.kv++;
  }

  const campusTables = ['notices','events','clubs','faculty','timetable_entries','library_books','library_loans','event_rsvps'];
  for (const table of campusTables) {
    const rows = Array.isArray(input[table]) ? input[table] : [];
    for (const raw of rows) {
      const recordKey = idString(raw.id ?? raw.recordKey);
      await prisma.campusRecord.upsert({
        where: { tableName_recordKey: { tableName: table, recordKey } },
        create: { tableName: table, recordKey, data: { ...raw, ...(raw.id == null ? { id: recordKey } : {}) } },
        update: { data: { ...raw, ...(raw.id == null ? { id: recordKey } : {}) } },
      });
      counts.campus++;
    }
  }
  for (const raw of arr('campusRecords', 'campus')) {
    const tableName = String(raw.tableName || raw.table || '');
    if (!campusTables.includes(tableName)) continue;
    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const recordKey = idString(raw.recordKey ?? data.id);
    await prisma.campusRecord.upsert({
      where: { tableName_recordKey: { tableName, recordKey } },
      create: { tableName, recordKey, data }, update: { data },
    });
    counts.campus++;
  }

  for (const raw of arr('gatePasses', 'gate_passes')) {
    const id = BigInt(String(raw.id));
    const data = raw.data && typeof raw.data === 'object' ? raw.data : { ...raw };
    const qrToken = String(raw.qrToken ?? raw.qr_token ?? data.qrToken ?? data.qr_token ?? '');
    if (!qrToken) continue;
    await prisma.gatePass.upsert({
      where: { id },
      create: {
        id, status: String(raw.status || data.status || 'pending'), studentEmail: raw.studentEmail || raw.student_email || data.studentEmail || null,
        qrToken, qrUsed: !!(raw.qrUsed ?? raw.qr_used ?? data.qrUsed), qrUsedAt: asDate(raw.qrUsedAt ?? raw.qr_used_at ?? data.qrUsedAt),
        expiresAt: asDate(raw.expiresAt ?? raw.expires_at ?? data.expiresAt), data,
      },
      update: {
        status: String(raw.status || data.status || 'pending'), studentEmail: raw.studentEmail || raw.student_email || data.studentEmail || null,
        qrToken, qrUsed: !!(raw.qrUsed ?? raw.qr_used ?? data.qrUsed), qrUsedAt: asDate(raw.qrUsedAt ?? raw.qr_used_at ?? data.qrUsedAt),
        expiresAt: asDate(raw.expiresAt ?? raw.expires_at ?? data.expiresAt), data,
      },
    });
    counts.gatePasses++;
  }

  console.log(JSON.stringify({ ok: true, imported: counts }, null, 2));
})()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
