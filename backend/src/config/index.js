const crypto = require('crypto');

const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const isDevelopment = !isProduction;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validateSecret(name, minLength = 32) {
  const value = required(name);
  if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters in production.`);
  return value;
}

function validateProductionConfig() {
  if (!isProduction) return;
  required('DATABASE_URL');
  validateSecret('JWT_ACCESS_SECRET');
  validateSecret('JWT_REFRESH_SECRET');
  if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different in production.');
  }
  const cors = String(process.env.CORS_ORIGIN || '').trim();
  if (!cors || cors === '*') throw new Error('CORS_ORIGIN must explicitly list allowed frontend origins in production.');
  const origins = cors.split(',').map(s => s.trim()).filter(Boolean);
  if (origins.some(origin => !/^https:\/\//i.test(origin))) {
    throw new Error('Every production CORS_ORIGIN must use HTTPS origins.');
  }
  validateSecret('AI_ML_SERVICE_TOKEN');
  validateSecret('OPERATIONS_TOKEN');
  // Password recovery is an enabled application feature, so production must have a
  // server-side delivery mechanism. The provider is contacted only from the backend.
  required('RECOVERY_EMAILJS_SERVICE_ID');
  required('RECOVERY_EMAILJS_TEMPLATE_ID');
  required('RECOVERY_EMAILJS_PUBLIC_KEY');
  if (process.env.RECOVERY_EMAILJS_PRIVATE_KEY) {
    // Keep accepting the private key for accounts/templates that require it; never log it.
    if (process.env.RECOVERY_EMAILJS_PRIVATE_KEY.length < 8) throw new Error('RECOVERY_EMAILJS_PRIVATE_KEY is invalid.');
  }
}

function bootConfig() {
  validateProductionConfig();
  const generatedDevAccess = crypto.randomBytes(32).toString('hex');
  const generatedDevRefresh = crypto.randomBytes(32).toString('hex');
  return {
    isProduction,
    isDevelopment,
    accessSecret: isProduction ? required('JWT_ACCESS_SECRET') : (process.env.JWT_ACCESS_SECRET || generatedDevAccess),
    refreshSecret: isProduction ? required('JWT_REFRESH_SECRET') : (process.env.JWT_REFRESH_SECRET || generatedDevRefresh),
  };
}

module.exports = bootConfig();
