import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import { installWhatsApp } from './whatsapp.mjs';
import { installChannels } from './channels.mjs';

const scrypt = promisify(scryptCallback);
const ROOT = dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const now = () => Date.now();
export const PLANS = {
  starter: { name: 'Starter', price: 1499, contacts: 1000, seats: 3, campaigns: 10, automations: 3 },
  growth: { name: 'Growth', price: 3999, contacts: 5000, seats: 10, campaigns: 100, automations: 25 },
  scale: { name: 'Scale', price: 9999, contacts: 10000, seats: 50, campaigns: 1000, automations: 100 }
};
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (condition, status, message) => { if (condition) throw new ApiError(status, message); };
function text(value, max = 100) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function email(value) { const v = text(value, 254).toLowerCase(); fail(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 400, 'Enter a valid email address.'); return v; }
function password(value) { fail(typeof value !== 'string' || value.length < 15 || value.length > 128, 400, 'Use a password between 15 and 128 characters.'); return value; }
async function passwordHash(value) { const salt = token(); return `${salt}:${Buffer.from(await scrypt(value, salt, 64)).toString('hex')}`; }
async function passwordMatches(value, stored) { const [salt, key] = stored.split(':'); const actual = await scrypt(String(value).slice(0, 128), salt, 64); return timingSafeEqual(Buffer.from(key, 'hex'), actual); }
export function emptyState(company, owner, address) {
  return { settings: { business: company, owner, email: address, phone: '', timezone: 'Asia/Kolkata', privacy: '', signupEnabled: true, notifications: true }, contacts: [], messages: {}, deals: [], campaigns: [], templates: [], automations: [], agent: { name: `${company} assistant`, tone: 'Warm and helpful', instructions: 'Use verified business information. Hand off to a person when unsure.', enabled: false }, notifications: [], activity: [] };
}
export async function sanitizeLogo(data) {
  if (!data) return null;
  fail(typeof data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data), 400, 'Upload a PNG, JPEG or WebP logo. SVG files are not accepted.');
  const input = Buffer.from(data.split(',')[1], 'base64');
  fail(input.length > 2 * 1024 * 1024, 413, 'Logo must be smaller than 2 MB.');
  try {
    const image = sharp(input, { limitInputPixels: 16000000, failOn: 'warning' });
    const metadata = await image.metadata();
    fail(!['png', 'jpeg', 'webp'].includes(metadata.format), 400, 'Logo content must be PNG, JPEG or WebP.');
    return await image.rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch { throw new ApiError(400, 'This logo could not be decoded. Choose a valid image under 16 megapixels.'); }
}

export function createApp(options = {}) {
  const config = { ...process.env, ...options };
  const appUrl = config.APP_URL || 'http://localhost:3000';
  fail(config.NODE_ENV === 'production' && !appUrl.startsWith('https://'), 500, 'Production APP_URL must use HTTPS.');
  const databasePath = config.DATABASE_PATH || resolve(ROOT, 'data/techzolo.sqlite');
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, verified INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL, logo BLOB, state TEXT NOT NULL, version INTEGER DEFAULT 1, plan TEXT DEFAULT 'growth', status TEXT DEFAULT 'trialing', trial_end INTEGER NOT NULL, customer TEXT UNIQUE, subscription TEXT, suspended INTEGER NOT NULL DEFAULT 0, suspended_by TEXT NOT NULL DEFAULT '', suspension_reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS members (tenant TEXT REFERENCES tenants(id), user TEXT REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(tenant,user));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user TEXT REFERENCES users(id), tenant TEXT REFERENCES tenants(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, tenant TEXT REFERENCES tenants(id), email TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, UNIQUE(tenant,email));
    CREATE TABLE IF NOT EXISTS actions (token TEXT PRIMARY KEY, user TEXT REFERENCES users(id), kind TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT REFERENCES tenants(id), actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS signup_requests (id TEXT PRIMARY KEY, tenant TEXT REFERENCES tenants(id), name TEXT NOT NULL, phone TEXT NOT NULL, wording TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(tenant,phone));`);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  const tenantColumns = new Set(db.prepare('PRAGMA table_info(tenants)').all().map(column => column.name));
  if (!userColumns.has('disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  if (!tenantColumns.has('suspended')) db.exec("ALTER TABLE tenants ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0");
  if (!tenantColumns.has('suspended_by')) db.exec("ALTER TABLE tenants ADD COLUMN suspended_by TEXT NOT NULL DEFAULT ''");
  if (!tenantColumns.has('suspension_reason')) db.exec("ALTER TABLE tenants ADD COLUMN suspension_reason TEXT NOT NULL DEFAULT ''");
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const platformAdminEmails = new Set(String(config.PLATFORM_ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  const audit = (tenant, actor, action, details = '') => run('INSERT INTO audit(tenant,actor,action,details,at) VALUES(?,?,?,?,?)', tenant, actor, action, details, now());
  const stripe = options.stripe || (config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null);
  const mailer = options.mailer || (config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' https://connect.facebook.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.facebook.com https://*.fbcdn.net; connect-src 'self' https://www.facebook.com https://graph.facebook.com; frame-src https://www.facebook.com https://web.facebook.com; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
    if (config.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  function limited(key, limit = 15, duration = 15 * 60000) {
    if (one('SELECT count(*) AS n FROM rate_limits').n > 10000) run('DELETE FROM rate_limits WHERE expires < ?', now());
    const record = one('SELECT * FROM rate_limits WHERE key=?', key);
    if (!record || record.expires < now()) run('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,expires=excluded.expires', key, now() + duration);
    else { fail(record.count >= limit, 429, 'Too many attempts. Try again later.'); run('UPDATE rate_limits SET count=count+1 WHERE key=?', key); }
  }
  const whatsapp=installWhatsApp({db,config,owner:(req,res,next)=>owner(req,res,next),admin:(req,res,next)=>admin(req,res,next),writable,tenantOf,audit,transaction,limited,plans:PLANS,fetch:options.metaFetch});
  const channels=installChannels({db,config,owner:(req,res,next)=>owner(req,res,next),admin:(req,res,next)=>admin(req,res,next),writable,tenantOf,audit,transaction,limited,mailer,appUrl,plans:PLANS,fetch:options.metaFetch});
  app.use('/api/whatsapp/webhook',whatsapp.webhook);
  app.use('/api/instagram/webhook',channels.instagramWebhook);
  // Raw bytes are essential: never put express.json() before signature verification.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    fail(!stripe || !config.STRIPE_WEBHOOK_SECRET, 503, 'Billing is not configured.');
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.STRIPE_WEBHOOK_SECRET); } catch { throw new ApiError(400, 'Invalid webhook signature.'); }
    if (one('SELECT id FROM billing_events WHERE id=?', event.id)) return res.json({ received: true });
    const object = event.data.object;
    if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      // Reconcile current provider state so delayed events cannot restore old entitlements.
      const subscription = await stripe.subscriptions.retrieve(object.id);
      const tenant = one('SELECT * FROM tenants WHERE customer=?', subscription.customer);
      if (tenant && (!tenant.subscription || tenant.subscription === subscription.id)) {
        const price = subscription.items.data[0]?.price.id;
        const plan = Object.keys(PLANS).find(p => config[`STRIPE_PRICE_${p.toUpperCase()}`] === price);
        const status = plan ? subscription.status : 'incomplete';
        transaction(() => { run('UPDATE tenants SET subscription=?,status=?,plan=? WHERE id=?', subscription.id, status, plan || 'starter', tenant.id); audit(tenant.id, 'Stripe', 'billing.updated', status); run('INSERT OR IGNORE INTO billing_events VALUES(?,?)', event.id, now()); });
        return res.json({ received: true });
      }
    }
    run('INSERT OR IGNORE INTO billing_events VALUES(?,?)', event.id, now());
    res.json({ received: true });
  });
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      fail(req.headers.origin && req.headers.origin !== new URL(appUrl).origin, 403, 'Request origin is not allowed.');
      fail(req.headers['sec-fetch-site'] === 'cross-site', 403, 'Cross-site requests are not allowed.');
      const formPost=['/api/email/confirm','/api/email/unsubscribe'].includes(req.originalUrl.split('?')[0]) && req.is('application/x-www-form-urlencoded');
      fail(!req.is('application/json') && !formPost, 415, 'Use application/json.');
    }
    const rawCookie = /(?:^|;\s*)tz_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    req.session = rawCookie ? one('SELECT * FROM sessions WHERE id=? AND expires>?', hash(rawCookie), now()) : null;
    next();
  });
  function session(req, res, user, tenant) {
    const raw = token(), csrf = token();
    run('DELETE FROM sessions WHERE expires < ?', now());
    run('INSERT INTO sessions VALUES(?,?,?,?,?)', hash(raw), user, tenant, csrf, now() + 7 * DAY);
    res.cookie('tz_session', raw, { httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', maxAge: 7 * DAY, path: '/' });
    req.session = { user, tenant, csrf };
  }
  function authenticated(req, res, next) {
    const pathname=req.originalUrl.split('?')[0];
    if(['/api/email/confirm','/api/email/unsubscribe'].includes(pathname))return next();
    fail(!req.session, 401, 'Please sign in to continue.');
    fail(one('SELECT disabled FROM users WHERE id=?', req.session.user)?.disabled, 403, 'This account is disabled. Contact the service operator.');
    // A shared cookie can be switched by another tab. Reject stale workspace
    // contexts before reading or writing, even when the user belongs to both.
    if (!['/api/session', '/api/auth/logout','/api/instagram/callback'].includes(pathname)) fail(req.headers['x-workspace-id'] !== req.session.tenant, 409, 'The active workspace changed. Reload this tab before continuing.');
    const membership = one('SELECT role FROM members WHERE tenant=? AND user=?', req.session.tenant, req.session.user);
    fail(!membership, 403, 'You no longer belong to this workspace.');
    req.role = membership.role;
    if (!['GET', 'HEAD'].includes(req.method)) fail(req.headers['x-csrf-token'] !== req.session.csrf, 403, 'Session verification failed. Refresh and try again.');
    next();
  }
  const owner = (req, res, next) => { fail(req.role !== 'owner', 403, 'Only the workspace owner can do this.'); next(); };
  const admin = (req, res, next) => { fail(!['owner', 'admin'].includes(req.role), 403, 'Workspace administrator access is required.'); next(); };
  function tenantOf(req) { return one('SELECT * FROM tenants WHERE id=?', req.session.tenant); }
  function writable(tenant) { fail(!!tenant.suspended, 403, 'This workspace is suspended. Contact the service operator.'); fail(!(tenant.status === 'active' || (tenant.status === 'trialing' && tenant.trial_end > now())), 402, 'Your trial or subscription has ended. Choose a plan in Billing to continue editing.'); }
  function meta(req) {
    const tenant = tenantOf(req), user = one('SELECT id,name,email,verified FROM users WHERE id=?', req.session.user);
    return { user, csrf: req.session.csrf, platformAdmin: !!user.verified && platformAdminEmails.has(user.email), tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, color: tenant.color, logo: tenant.logo ? `/api/public/${tenant.slug}/logo?v=${tenant.version}` : '', role: req.role || 'owner', plan: tenant.plan, status: tenant.status, trialEnd: tenant.trial_end, suspended: !!tenant.suspended }, workspaces: all('SELECT t.id,t.name,t.slug,m.role FROM members m JOIN tenants t ON t.id=m.tenant WHERE m.user=?', user.id), plans: PLANS, billingConfigured: !!stripe, emailConfigured: !!mailer };
  }
  async function sendAction(user, kind) {
    if (!mailer) return false;
    const raw = token();
    run('DELETE FROM actions WHERE user=? AND kind=?', user.id, kind);
    run('INSERT INTO actions VALUES(?,?,?,?)', hash(raw), user.id, kind, now() + (kind === 'reset' ? 3600000 : DAY));
    const link = `${appUrl}/#${kind}?token=${raw}`;
    await mailer.sendMail({ from: config.MAIL_FROM || 'Techzolo <hello@localhost>', to: user.email, subject: kind === 'reset' ? 'Reset your Techzolo password' : 'Verify your Techzolo email', text: `Open this link to ${kind === 'reset' ? 'reset your password' : 'verify your email'}: ${link}\nIf you did not request this, ignore this email.` });
    return true;
  }
  function companyInput(body) {
    const name = text(body.company), slug = text(body.slug, 48).toLowerCase(), color = body.color || '#087f5b';
    fail(!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 3, 400, 'Provide a company name and workspace URL of 3–48 lowercase letters, numbers or hyphens.');
    fail(!/^#[0-9a-f]{6}$/i.test(color), 400, 'Choose a valid brand color.');
    fail(one('SELECT id FROM tenants WHERE slug=?', slug), 409, 'That workspace URL is already in use.');
    return { name, slug, color };
  }
  function insertTenant(input, user, logo) {
    const id = randomUUID();
    run('INSERT INTO tenants(id,slug,name,color,logo,state,trial_end) VALUES(?,?,?,?,?,?,?)', id, input.slug, input.name, input.color, logo, JSON.stringify(emptyState(input.name, user.name, user.email)), now() + 14 * DAY);
    run('INSERT INTO members VALUES(?,?,?)', id, user.id, 'owner');
    audit(id, user.email, 'workspace.created'); return id;
  }
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/register', async (req, res) => {
    limited(`register:${req.ip}`, 10);
    const input = companyInput(req.body), address = email(req.body.email), name = text(req.body.name), secret = password(req.body.password);
    fail(!name || req.body.terms !== true, 400, 'Enter your name and accept the terms.');
    fail(one('SELECT id FROM users WHERE email=?', address), 409, 'That email is already registered. Sign in instead.');
    const logo = await sanitizeLogo(req.body.logo), stored = await passwordHash(secret), user = { id: randomUUID(), name, email: address };
    const tenant = transaction(() => { run('INSERT INTO users(id,name,email,password) VALUES(?,?,?,?)', user.id, name, address, stored); return insertTenant(input, user, logo); });
    session(req, res, user.id, tenant);
    // Registration remains usable when an external email provider is down.
    try { await sendAction(user, 'verify'); } catch { audit(tenant, 'System', 'email.delivery_failed', 'verification'); }
    res.status(201).json(meta(req));
  });
  app.post('/api/auth/login', async (req, res) => {
    limited(`login:${req.ip}`); const address = email(req.body.email);
    const user = one('SELECT * FROM users WHERE email=?', address);
    const dummy = `0000000000000000000000000000000000000000000000000000000000000000:${'0'.repeat(128)}`;
    const valid = await passwordMatches(req.body.password || '', user?.password || dummy);
    fail(!user || user.disabled || !valid, 401, 'Email or password is incorrect.');
    const membership = one('SELECT tenant,role FROM members WHERE user=? ORDER BY rowid LIMIT 1', user.id);
    if (req.session) run('DELETE FROM sessions WHERE id=?', req.session.id);
    session(req, res, user.id, membership.tenant); req.role = membership.role;
    audit(membership.tenant, address, 'auth.login'); res.json(meta(req));
  });
  app.post('/api/auth/forgot', async (req, res) => {
    limited(`forgot:${req.ip}`, 5); fail(!mailer, 503, 'Password recovery requires the administrator to configure outbound email.');
    const user = one('SELECT * FROM users WHERE email=?', email(req.body.email));
    if (user) { try { await sendAction(user, 'reset'); } catch { /* Avoid revealing whether this email is registered. */ } }
    res.json({ message: 'If this account exists, a recovery email will arrive shortly.' });
  });
  app.post('/api/auth/reset', async (req, res) => {
    limited(`reset:${req.ip}`); const secret = password(req.body.password);
    const action = one("SELECT * FROM actions WHERE token=? AND kind='reset' AND expires>?", hash(text(req.body.token, 100)), now());
    fail(!action, 400, 'This recovery link is invalid or expired.');
    const stored = await passwordHash(secret);
    transaction(() => { run('UPDATE users SET password=? WHERE id=?', stored, action.user); run('DELETE FROM sessions WHERE user=?', action.user); run('DELETE FROM actions WHERE user=?', action.user); });
    res.clearCookie('tz_session', { path: '/' }); res.json({ message: 'Password changed. Sign in with your new password.' });
  });
  app.post('/api/auth/verify', (req, res) => {
    limited(`verify:${req.ip}`); const action = one("SELECT * FROM actions WHERE token=? AND kind='verify' AND expires>?", hash(text(req.body.token, 100)), now());
    fail(!action, 400, 'This verification link is invalid or expired.');
    transaction(() => { run('UPDATE users SET verified=1 WHERE id=?', action.user); run('DELETE FROM actions WHERE token=?', action.token); });
    res.json({ message: 'Email verified. You can continue to your workspace.' });
  });
  app.get('/api/public/:slug', (req, res) => {
    const t = one('SELECT slug,name,color,logo,state,version FROM tenants WHERE slug=?', req.params.slug); fail(!t, 404, 'Workspace not found.');
    const settings = JSON.parse(t.state).settings;
    res.json({ name: t.name, slug: t.slug, color: t.color, logo: t.logo ? `/api/public/${t.slug}/logo?v=${t.version}` : '', signupEnabled: settings.signupEnabled, privacy: settings.privacy });
  });
  app.get('/api/public/:slug/logo', (req, res) => { const t = one('SELECT logo FROM tenants WHERE slug=?', req.params.slug); fail(!t?.logo, 404, 'Logo not found.'); res.type('png').send(Buffer.from(t.logo)); });
  app.post('/api/public/:slug/subscribe', (req, res) => {
    limited(`subscribe:${req.ip}`, 10); const t = one('SELECT * FROM tenants WHERE slug=?', req.params.slug); fail(!t, 404, 'Workspace not found.'); writable(t);
    const state = JSON.parse(t.state); fail(!state.settings.signupEnabled, 403, 'Subscriber requests are disabled.');
    const name = text(req.body.name), phone = text(req.body.phone, 30).replace(/[\s().-]/g, '');
    fail(!name || !/^\+[1-9]\d{7,14}$/.test(phone) || req.body.agreement !== true, 400, 'Enter your name, international phone number and consent.');
    const wording = `I request WhatsApp offers from ${t.name}. I can reply STOP at any time. WhatsApp confirmation is required.`;
    run('INSERT INTO signup_requests VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,phone) DO UPDATE SET name=excluded.name,wording=excluded.wording,at=excluded.at', randomUUID(), t.id, name, phone, wording, now());
    // A website request never creates verified marketing consent.
    const confirmUrl=whatsapp.createOptin(t.id,phone,wording);
    res.status(202).json({ message: confirmUrl?'Your request is pending. Open WhatsApp and send the prefilled confirmation from the number you entered to verify your permission.':'Your request is saved as pending. The business must connect WhatsApp before you can confirm your permission.',confirmUrl });
  });
  app.use('/api', authenticated);
  app.get('/api/session', (req, res) => res.json(meta(req)));
  const platformApi = express.Router();
  platformApi.use(authenticated, (req, res, next) => {
    const account = one('SELECT email,verified FROM users WHERE id=?', req.session.user);
    fail(!account || !account.verified || !platformAdminEmails.has(account.email), 403, 'A verified, server-allowlisted platform administrator account is required.');
    next();
  });
  function platformWorkspace(row) {
    let state = {};
    try { state = JSON.parse(row.state); } catch {}
    return { id: row.id, name: row.name, slug: row.slug, logo: row.logo ? `/api/public/${row.slug}/logo` : '', color: row.color, plan: row.plan, status: row.status, trialEnd: row.trial_end, subscriptionActive: !!row.subscription, suspended: !!row.suspended, suspensionReason: row.suspension_reason || '', suspendedBy: row.suspended_by || '', ownerName: row.owner_name || 'Unknown', ownerEmail: row.owner_email || '', memberCount: row.member_count, contactCount: state.contacts?.length || 0, whatsapp: row.whatsapp_state || 'not_connected', whatsappPhone: row.whatsapp_phone || '', createdAt: row.created_at || 0 };
  }
  const workspaceSelect = `SELECT t.id,t.name,t.slug,t.color,t.logo,t.state,t.plan,t.status,t.trial_end,t.subscription,t.suspended,t.suspension_reason,t.suspended_by,
    owner.name AS owner_name,owner.email AS owner_email,
    (SELECT count(*) FROM members m WHERE m.tenant=t.id) AS member_count,
    (SELECT min(at) FROM audit a WHERE a.tenant=t.id AND a.action='workspace.created') AS created_at,
    wc.state AS whatsapp_state,wc.display_phone AS whatsapp_phone
    FROM tenants t LEFT JOIN members om ON om.tenant=t.id AND om.role='owner' LEFT JOIN users owner ON owner.id=om.user
    LEFT JOIN wa_connections wc ON wc.tenant=t.id`;
  platformApi.get('/overview', (req, res) => {
    const plans = all("SELECT plan,count(*) AS count FROM tenants WHERE suspended=0 AND status='active' GROUP BY plan");
    const total = one('SELECT count(*) AS count FROM tenants').count;
    const active = one("SELECT count(*) AS count FROM tenants WHERE suspended=0 AND status='active'").count;
    const trialing = one("SELECT count(*) AS count FROM tenants WHERE suspended=0 AND status='trialing' AND trial_end> ?", now()).count;
    const suspended = one('SELECT count(*) AS count FROM tenants WHERE suspended=1').count;
    const users = one('SELECT count(*) AS count FROM users WHERE disabled=0').count;
    const whatsapp = one("SELECT count(*) AS count FROM wa_connections WHERE state='connected'").count;
    const contacts = all('SELECT state FROM tenants').reduce((sum, row) => { try { return sum + (JSON.parse(row.state).contacts?.length || 0); } catch { return sum; } }, 0);
    const mrr = plans.reduce((sum, row) => sum + (PLANS[row.plan]?.price || 0) * row.count, 0);
    const activity = all(`SELECT a.actor,a.action,a.details,a.at,t.name AS workspace FROM audit a LEFT JOIN tenants t ON t.id=a.tenant WHERE a.tenant IS NULL ORDER BY a.id DESC LIMIT 20`);
    const dbCheck = one('PRAGMA quick_check')?.quick_check === 'ok';
    const key = Buffer.from(config.WHATSAPP_ENCRYPTION_KEY || '', 'base64');
    const whatsappConfigured = !!(config.META_APP_ID && config.META_APP_SECRET && config.META_WEBHOOK_VERIFY_TOKEN && /^[A-Za-z0-9+/]{43}=$/.test(config.WHATSAPP_ENCRYPTION_KEY || '') && key.length === 32);
    res.json({ metrics: { workspaces: total, active, trialing, suspended, users, whatsapp, contacts, mrr }, system: { database: dbCheck ? 'healthy' : 'attention', stripe: !!stripe, email: !!mailer, whatsapp: whatsappConfigured, webhookHttps: String(config.META_WEBHOOK_URL || '').startsWith('https://') }, activity });
  });
  platformApi.get('/workspaces', (req, res) => {
    const query = text(req.query.q, 100), status = text(req.query.status, 30), plan = text(req.query.plan, 20), page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page || '1', 10) || 1));
    const rows = all(`${workspaceSelect} WHERE (?='' OR t.name LIKE ? OR t.slug LIKE ? OR owner.email LIKE ?) AND (?='' OR t.status=?) AND (?='' OR t.plan=?) ORDER BY created_at DESC LIMIT 50 OFFSET ?`, query, `%${query}%`, `%${query}%`, `%${query}%`, status, status, plan, plan, (page - 1) * 50);
    const count = one(`SELECT count(*) AS count FROM tenants t LEFT JOIN members om ON om.tenant=t.id AND om.role='owner' LEFT JOIN users owner ON owner.id=om.user WHERE (?='' OR t.name LIKE ? OR t.slug LIKE ? OR owner.email LIKE ?) AND (?='' OR t.status=?) AND (?='' OR t.plan=?)`, query, `%${query}%`, `%${query}%`, `%${query}%`, status, status, plan, plan).count;
    res.json({ workspaces: rows.map(platformWorkspace), total: count, page, pageSize: 50 });
  });
  platformApi.get('/workspaces/:id', (req, res) => {
    const row = one(`${workspaceSelect} WHERE t.id=?`, req.params.id);
    fail(!row, 404, 'Workspace not found.');
    const members = all('SELECT u.id,u.name,u.email,u.verified,u.disabled,m.role FROM members m JOIN users u ON u.id=m.user WHERE m.tenant=? ORDER BY CASE m.role WHEN \'owner\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END,u.name', row.id);
    const activity = all('SELECT actor,action,details,at FROM audit WHERE tenant=? ORDER BY id DESC LIMIT 25', row.id);
    res.json({ workspace: platformWorkspace(row), members, activity });
  });
  platformApi.post('/workspaces/:id/suspension', (req, res) => {
    const row = one('SELECT id,name,suspended FROM tenants WHERE id=?', req.params.id);
    fail(!row, 404, 'Workspace not found.');
    fail(typeof req.body.suspended !== 'boolean', 400, 'Choose whether to suspend or restore this workspace.');
    const reason = req.body.suspended ? text(req.body.reason, 300) : '';
    fail(req.body.suspended && reason.length < 8, 400, 'Add a brief reason of at least eight characters.');
    const actor = one('SELECT email FROM users WHERE id=?', req.session.user).email;
    transaction(() => {
      run('UPDATE tenants SET suspended=?,suspended_by=?,suspension_reason=? WHERE id=?', Number(req.body.suspended), req.body.suspended ? actor : '', reason, row.id);
      run('INSERT INTO audit(tenant,actor,action,details,at) VALUES(NULL,?,?,?,?)', actor, req.body.suspended ? 'workspace.suspended' : 'workspace.restored', `${row.name} (${row.id}): ${req.body.suspended ? reason : 'restored by platform administrator'}`, now());
    });
    res.json({ ok: true, suspended: req.body.suspended });
  });
  platformApi.post('/workspaces/:id/trial', (req, res) => {
    const row = one("SELECT id,name,plan,status,trial_end,subscription FROM tenants WHERE id=?", req.params.id);
    fail(!row, 404, 'Workspace not found.');
    const days = Number(req.body.days);
    fail(row.status !== 'trialing' || row.subscription, 409, 'Only workspaces without a paid subscription can receive more trial time.');
    fail(!Number.isInteger(days) || days < 1 || days > 90, 400, 'Choose between 1 and 90 days.');
    const trialEnd = Math.max(row.trial_end, now()) + days * DAY;
    const actor = one('SELECT email FROM users WHERE id=?', req.session.user).email;
    transaction(() => {
      run("UPDATE tenants SET trial_end=? WHERE id=? AND status='trialing' AND subscription IS NULL", trialEnd, row.id);
      run('INSERT INTO audit(tenant,actor,action,details,at) VALUES(NULL,?,?,?,?)', actor, 'workspace.trial_extended', `${row.name} (${row.id}): +${days} days`, now());
    });
    res.json({ ok: true, trialEnd });
  });
  platformApi.get('/users', (req, res) => {
    const query = text(req.query.q, 100);
    const users = all(`SELECT u.id,u.name,u.email,u.verified,u.disabled,
      (SELECT count(*) FROM members m WHERE m.user=u.id) AS workspace_count,
      (SELECT group_concat(t.name, ', ') FROM members m JOIN tenants t ON t.id=m.tenant WHERE m.user=u.id) AS workspaces
      FROM users u WHERE (?='' OR u.name LIKE ? OR u.email LIKE ?) ORDER BY u.email LIMIT 200`, query, `%${query}%`, `%${query}%`);
    res.json({ users: users.map(user => ({ ...user, workspaces: user.workspaces || '' })) });
  });
  platformApi.post('/users/:id/access', (req, res) => {
    const user = one('SELECT id,name,email,disabled FROM users WHERE id=?', req.params.id);
    fail(!user, 404, 'User not found.');
    fail(typeof req.body.disabled !== 'boolean', 400, 'Choose whether to disable or restore this account.');
    fail(platformAdminEmails.has(user.email), 409, 'Platform administrator accounts cannot be disabled from this panel.');
    const actor = one('SELECT email FROM users WHERE id=?', req.session.user).email;
    transaction(() => {
      run('UPDATE users SET disabled=? WHERE id=?', Number(req.body.disabled), user.id);
      if (req.body.disabled) run('DELETE FROM sessions WHERE user=?', user.id);
      run('INSERT INTO audit(tenant,actor,action,details,at) VALUES(NULL,?,?,?,?)', actor, req.body.disabled ? 'account.disabled' : 'account.restored', `${user.email} (${user.id})`, now());
    });
    res.json({ ok: true, disabled: req.body.disabled });
  });
  app.use('/api/platform-admin', platformApi);
  app.post('/api/auth/logout', (req, res) => { run('DELETE FROM sessions WHERE id=?', req.session.id); res.clearCookie('tz_session', { path: '/' }); res.json({ ok: true }); });
  app.post('/api/auth/resend-verification', async (req, res) => { limited(`resend:${req.session.user}`, 3); fail(!mailer, 503, 'Outbound email is not configured.'); await sendAction(one('SELECT * FROM users WHERE id=?', req.session.user), 'verify'); res.json({ message: 'Verification email sent.' }); });
  app.post('/api/workspaces', async (req, res) => { limited(`workspaces:${req.session.user}`, 10, DAY); const input = companyInput(req.body), logo = await sanitizeLogo(req.body.logo), user = one('SELECT * FROM users WHERE id=?', req.session.user); const id = transaction(() => insertTenant(input, user, logo)); run('UPDATE sessions SET tenant=? WHERE id=?', id, req.session.id); req.session.tenant = id; req.role = 'owner'; res.status(201).json(meta(req)); });
  app.post('/api/workspaces/switch', (req, res) => {
    const member = one('SELECT role FROM members WHERE tenant=? AND user=?', text(req.body.id), req.session.user); fail(!member, 403, 'You do not belong to that workspace.');
    run('UPDATE sessions SET tenant=? WHERE id=?', req.body.id, req.session.id); req.session.tenant = req.body.id; req.role = member.role; res.json(meta(req));
  });
  app.get('/api/workspace', (req, res) => { const t = tenantOf(req); res.json({ state: JSON.parse(t.state), version: t.version }); });
  app.put('/api/workspace', (req, res) => {
    const t = tenantOf(req); writable(t); fail(req.role === 'viewer', 403, 'Viewers have read-only access.');
    fail(req.body.version !== t.version, 409, 'Another team member changed this workspace. Your changes were not saved. Reload and retry.');
    const state = req.body.state, old = JSON.parse(t.state);
    validateState(state, old, req.role, PLANS[t.plan]);
    const serialized = JSON.stringify(state); fail(Buffer.byteLength(serialized) > 16 * 1024 * 1024, 413, 'Workspace exceeds the 16 MB storage limit.');
    transaction(() => { whatsapp.reconcilePreferences(t.id,old,state); channels.reconcileEmailContacts(t.id,old,state); run('UPDATE tenants SET state=?,name=?,version=version+1 WHERE id=?', serialized, state.settings.business, t.id); audit(t.id, one('SELECT email FROM users WHERE id=?', req.session.user).email, 'workspace.saved'); });
    res.json({ version: t.version + 1 });
  });
  app.put('/api/branding', admin, async (req, res) => {
    const t = tenantOf(req); writable(t); const color = req.body.color || t.color;
    fail(!/^#[a-f0-9]{6}$/i.test(color), 400, 'Choose a valid brand color.');
    const logo = req.body.removeLogo ? null : req.body.logo ? await sanitizeLogo(req.body.logo) : t.logo;
    transaction(() => { run('UPDATE tenants SET logo=?,color=?,version=version+1 WHERE id=?', logo, color, t.id); audit(t.id, req.session.user, 'branding.updated'); }); res.json(meta(req));
  });
  app.get('/api/team', (req, res) => res.json({ members: all('SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user WHERE m.tenant=?', req.session.tenant), invites: ['owner', 'admin'].includes(req.role) ? all('SELECT id,email,role,expires FROM invites WHERE tenant=? AND expires>?', req.session.tenant, now()) : [] }));
  app.post('/api/team/invite', admin, async (req, res) => {
    const t = tenantOf(req); writable(t); const address = email(req.body.email), role = req.body.role;
    fail(!['admin', 'agent', 'viewer'].includes(role) || (req.role === 'admin' && role === 'admin'), 403, 'You cannot invite this role.');
    fail(one('SELECT u.id FROM members m JOIN users u ON u.id=m.user WHERE m.tenant=? AND u.email=?', t.id, address), 409, 'That person is already a member.');
    fail(one('SELECT id FROM invites WHERE tenant=? AND email=? AND expires>?', t.id, address, now()), 409, 'An invitation is already pending for this email.');
    const count = one('SELECT count(*) AS n FROM members WHERE tenant=?', t.id).n + one('SELECT count(*) AS n FROM invites WHERE tenant=? AND expires>?', t.id, now()).n;
    fail(count >= PLANS[t.plan].seats, 402, 'Your plan seat limit is reached.');
    const raw = token(), id = randomUUID();
    run('INSERT INTO invites VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,email) DO UPDATE SET id=excluded.id,role=excluded.role,token=excluded.token,expires=excluded.expires', id, t.id, address, role, hash(raw), now() + 7 * DAY);
    const link = `${appUrl}/#accept-invite?token=${raw}`; let delivered = false;
    if (mailer) { try { await mailer.sendMail({ from: config.MAIL_FROM, to: address, subject: `Join ${t.name} on Techzolo`, text: `You were invited as ${role}. Sign in or create your account, then open ${link}` }); delivered = true; } catch { /* The owner can securely copy the link. */ } }
    audit(t.id, req.session.user, 'team.invited', address); res.status(201).json({ link, delivered });
  });
  app.post('/api/team/accept', (req, res) => {
    const invite = one('SELECT * FROM invites WHERE token=? AND expires>?', hash(text(req.body.token, 100)), now()); fail(!invite, 400, 'Invitation is invalid or expired.');
    const user = one('SELECT * FROM users WHERE id=?', req.session.user); fail(user.email !== invite.email, 403, 'Sign in with the email address that received this invitation.');
    const t = one('SELECT * FROM tenants WHERE id=?', invite.tenant); writable(t); fail(one('SELECT count(*) AS n FROM members WHERE tenant=?', t.id).n >= PLANS[t.plan].seats, 402, 'This workspace has no available seats.');
    transaction(() => { run('INSERT OR IGNORE INTO members VALUES(?,?,?)', t.id, user.id, invite.role); run('DELETE FROM invites WHERE id=?', invite.id); run('UPDATE users SET verified=1 WHERE id=?', user.id); run('UPDATE sessions SET tenant=? WHERE id=?', t.id, req.session.id); audit(t.id, user.email, 'team.joined'); });
    req.session.tenant = t.id; req.role = invite.role; res.json(meta(req));
  });
  app.delete('/api/team/invites/:id', admin, (req, res) => { const invite = one('SELECT * FROM invites WHERE id=? AND tenant=?', req.params.id, req.session.tenant); fail(!invite || (req.role === 'admin' && invite.role === 'admin'), 403, 'You cannot revoke this invitation.'); run('DELETE FROM invites WHERE id=? AND tenant=?', req.params.id, req.session.tenant); audit(req.session.tenant, req.session.user, 'team.invitation_revoked', invite.email); res.json({ ok: true }); });
  app.patch('/api/team/:id', owner, (req, res) => {
    fail(req.params.id === req.session.user || !['admin', 'agent', 'viewer'].includes(req.body.role), 400, 'The owner role cannot be changed here.');
    const result = run("UPDATE members SET role=? WHERE tenant=? AND user=? AND role!='owner'", req.body.role, req.session.tenant, req.params.id); fail(!result.changes, 404, 'Team member not found.'); audit(req.session.tenant, req.session.user, 'team.role_changed', req.body.role); res.json({ ok: true });
  });
  app.delete('/api/team/:id', owner, (req, res) => { fail(req.params.id === req.session.user, 400, 'The owner cannot be removed.'); const result = run("DELETE FROM members WHERE tenant=? AND user=? AND role!='owner'", req.session.tenant, req.params.id); fail(!result.changes, 404, 'Member not found.'); run('DELETE FROM sessions WHERE tenant=? AND user=?', req.session.tenant, req.params.id); audit(req.session.tenant, req.session.user, 'team.removed'); res.json({ ok: true }); });
  app.get('/api/audit', admin, (req, res) => res.json(all('SELECT actor,action,details,at FROM audit WHERE tenant=? ORDER BY id DESC LIMIT 200', req.session.tenant)));
  app.get('/api/subscriber-requests', admin, (req, res) => res.json(all('SELECT id,name,phone,wording,at FROM signup_requests WHERE tenant=? ORDER BY at DESC LIMIT 200', req.session.tenant)));
  app.get('/api/billing', (req, res) => { const t = tenantOf(req); const s = JSON.parse(t.state); res.json({ plan: t.plan, status: t.status, trialEnd: t.trial_end, limits: PLANS[t.plan], usage: { contacts: s.contacts.length, campaigns: s.campaigns.length + one('SELECT count(*) AS n FROM email_campaigns WHERE tenant=?', t.id).n, automations: s.automations.length, seats: one('SELECT count(*) AS n FROM members WHERE tenant=?', t.id).n + one('SELECT count(*) AS n FROM invites WHERE tenant=? AND expires>?', t.id, now()).n }, configured: !!stripe }); });
  app.post('/api/billing/checkout', owner, async (req, res) => {
    const t = tenantOf(req), plan = req.body.plan; fail(!Object.hasOwn(PLANS, plan), 400, 'Choose a valid plan.');
    const price = config[`STRIPE_PRICE_${plan.toUpperCase()}`]; fail(!stripe || !price, 503, 'Stripe billing has not been configured. Your plan has not changed.');
    fail(t.subscription && t.status !== 'canceled', 409, 'Manage your existing subscription in the billing portal.');
    if (t.status === 'canceled') run('UPDATE tenants SET subscription=NULL WHERE id=?', t.id);
    let customer = t.customer;
    if (!customer) { const user = one('SELECT email FROM users WHERE id=?', req.session.user); customer = (await stripe.customers.create({ email: user.email, name: t.name, metadata: { tenantId: t.id } }, { idempotencyKey: `tenant-${t.id}` })).id; run('UPDATE tenants SET customer=? WHERE id=?', customer, t.id); }
    const checkout = await stripe.checkout.sessions.create({ customer, mode: 'subscription', line_items: [{ price, quantity: 1 }], success_url: `${appUrl}/#billing?checkout=success`, cancel_url: `${appUrl}/#billing?checkout=cancelled`, client_reference_id: t.id, subscription_data: { metadata: { tenantId: t.id } } });
    res.json({ url: checkout.url });
  });
  app.post('/api/billing/portal', owner, async (req, res) => { const t = tenantOf(req); fail(!stripe || !t.customer, 503, 'A Stripe customer account is required before opening the billing portal.'); res.json({ url: (await stripe.billingPortal.sessions.create({ customer: t.customer, return_url: `${appUrl}/#billing` })).url }); });
  app.use('/api/whatsapp',whatsapp.router);
  app.use('/api/instagram',channels.instagram);
  app.use('/api/email',channels.email);
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  // Explicit allowlist: never expose the database, source, .env, or dependencies.
  for (const file of ['index.html', 'subscribe.html', 'styles.css', 'app.js', 'saas.js', 'saas.css', 'whatsapp-ui.js', 'whatsapp.css', 'channels-ui.js', 'platform-admin.js', 'platform-admin.css']) app.get(`/${file}`, (req, res) => res.sendFile(resolve(ROOT, file)));
  app.get('/', (req, res) => res.sendFile(resolve(ROOT, 'index.html')));
  app.get('/Techzolo-WhatsApp-HTML/:file', (req, res) => { fail(!['index.html', 'subscribe.html', 'app.js', 'styles.css'].includes(req.params.file), 404, 'Not found.'); res.redirect(`/${req.params.file}`); });
  app.use((req, res) => res.status(404).send('Not found'));
  app.use((error, req, res, next) => {
    const status = error.status || (error.code?.startsWith('SQLITE_CONSTRAINT') ? 409 : 500);
    if (status === 500 && config.NODE_ENV !== 'test') console.error(error);
    res.status(status).json({ error: status === 500 ? 'The server could not complete this request.' : status === 413 ? 'This upload or workspace exceeds the size limit.' : error.type === 'entity.parse.failed' ? 'Invalid JSON.' : error.message });
  });
  return { app, db, close: () => db.close() };
}

function validateState(s, old, role, limits) {
  fail(!s || typeof s !== 'object' || Array.isArray(s), 400, 'Invalid workspace data.');
  const keys = ['settings', 'contacts', 'messages', 'deals', 'campaigns', 'templates', 'automations', 'agent', 'notifications', 'activity'];
  fail(keys.some(k => !Object.hasOwn(s, k)) || Object.keys(s).some(k => !keys.includes(k)), 400, 'Invalid workspace structure.');
  for (const key of ['settings', 'messages', 'agent']) fail(!s[key] || typeof s[key] !== 'object' || Array.isArray(s[key]), 400, `Invalid ${key}.`);
  for (const key of ['contacts', 'deals', 'campaigns', 'templates', 'automations', 'notifications', 'activity']) fail(!Array.isArray(s[key]) || s[key].length > 100000 || s[key].some(v => !v || typeof v !== 'object' || Array.isArray(v)), 400, `Invalid ${key}.`);
  fail(role === 'agent' && ['settings', 'agent', 'automations', 'templates', 'campaigns'].some(k => JSON.stringify(s[k]) !== JSON.stringify(old[k])), 403, 'Agents can edit contacts, conversations and deals. Ask an administrator to change workspace configuration.');
  fail(!text(s.settings.business) || typeof s.settings.owner !== 'string' || typeof s.settings.email !== 'string' || typeof s.settings.phone !== 'string' || typeof s.settings.privacy !== 'string' || typeof s.settings.timezone !== 'string' || typeof s.settings.signupEnabled !== 'boolean' || typeof s.settings.notifications !== 'boolean', 400, 'Invalid business settings.');
  fail(s.settings.phone && !/^\+[1-9]\d{7,14}$/.test(s.settings.phone), 400, 'Invalid business phone.');
  fail(s.settings.privacy && !/^https:\/\//.test(s.settings.privacy), 400, 'Privacy policy must use HTTPS.');
  for (const key of ['contacts', 'campaigns', 'automations']) fail(s[key].length > limits[key] && s[key].length > old[key].length, 402, `Your plan ${key} limit has been reached.`);
  const contactIds = new Set(), phones = new Set();
  for (const c of s.contacts) {
    fail(typeof c.id !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(c.id) || ['__proto__','constructor','prototype'].includes(c.id) || contactIds.has(c.id) || !text(c.name) || !/^\+[1-9]\d{7,14}$/.test(c.phone) || phones.has(c.phone) || typeof c.email !== 'string' || typeof c.tag !== 'string' || typeof c.stage !== 'string' || typeof c.consent !== 'boolean', 400, 'Contacts need unique IDs and international phone numbers, names and valid fields.');
    // No browser, member or website form can assert verified WhatsApp permission.
    const previous = old.contacts.find(v => v.id === c.id);
    fail(c.consent && (!previous?.consent || previous.phone !== c.phone), 400, 'Verified marketing consent can only be recorded by a trusted WhatsApp integration.');
    contactIds.add(c.id); phones.add(c.phone);
  }
  for (const [id, list] of Object.entries(s.messages)) fail(!contactIds.has(id) || !Array.isArray(list) || list.some(m => !m || typeof m.text !== 'string' || m.text.length > 4000 || typeof m.time !== 'string' || typeof m.out !== 'boolean'), 400, 'Invalid conversation data.');
  for (const d of s.deals) fail(!contactIds.has(d.contact) || !Number.isFinite(d.value) || d.value < 0 || typeof d.title !== 'string' || !['New leads', 'Qualified', 'Proposal', 'Won'].includes(d.stage), 400, 'Invalid opportunity.');
  for (const key of ['deals', 'campaigns', 'templates', 'automations', 'notifications']) { const ids = new Set(); for (const item of s[key]) { fail(typeof item.id !== 'string' || ids.has(item.id), 400, 'Records must have unique IDs.'); ids.add(item.id); } }
  for (const t of s.templates) { const previous = old.templates.find(v => v.id === t.id); fail(!/^[a-z0-9_]{1,80}$/.test(t.name) || typeof t.body !== 'string' || typeof t.label !== 'string' || typeof t.category !== 'string' || typeof t.language !== 'string' || typeof t.button !== 'string', 400, 'Invalid template.'); fail(t.status !== 'Draft' && (t.status !== previous?.status || t.body !== previous?.body), 400, 'Meta approval cannot be assigned from the browser.'); }
  for (const c of s.campaigns) fail(typeof c.name !== 'string' || typeof c.template !== 'string' || !['Draft', 'Paused'].includes(c.status) || c.sent !== 0 || c.read !== 0 || !Number.isInteger(c.recipients) || c.recipients < 0 || typeof c.date !== 'string', 400, 'Campaigns remain drafts until a delivery integration is connected.');
  for (const a of s.automations) fail(typeof a.name !== 'string' || typeof a.description !== 'string' || typeof a.keyword !== 'string' || typeof a.reply !== 'string' || typeof a.trigger !== 'string' || typeof a.active !== 'boolean' || a.runs !== 0, 400, 'Invalid automation configuration.');
  fail(typeof s.agent.name !== 'string' || typeof s.agent.tone !== 'string' || typeof s.agent.instructions !== 'string' || s.agent.enabled !== false, 400, 'Assistant connection is not configured.');
  for (const n of s.notifications) fail(typeof n.title !== 'string' || typeof n.text !== 'string' || !/^[a-z]+$/.test(n.type) || typeof n.read !== 'boolean', 400, 'Invalid notification.');
  for (const a of s.activity) fail(typeof a.title !== 'string' || typeof a.text !== 'string' || !/^[a-z]+$/.test(a.type) || typeof a.time !== 'string', 400, 'Invalid activity.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '127.0.0.1', () => console.log(`Techzolo SaaS: ${process.env.APP_URL || `http://localhost:${port}`}\nDatabase is stored in ./data (or DATABASE_PATH).`));
}
