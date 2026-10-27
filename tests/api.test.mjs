import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import sharp from 'sharp';
import Stripe from 'stripe';
import { createApp } from '../server.mjs';

let instance, server, base;
const SECRET = 'A memorable test passphrase 2026';
const webhookSecret = 'whsec_test_only';
let sent, currentSubscription, retrievals;
const stripeSdk = new Stripe('sk_test_not_a_real_key');
beforeEach(async () => {
  sent=[]; retrievals=0;
  const stripe = {
    webhooks: stripeSdk.webhooks,
    subscriptions: { retrieve: async () => { retrievals++; return currentSubscription; } },
    customers: { create: async () => ({ id: 'cus_test' }) },
    checkout: { sessions: { create: async args => ({ url: 'https://checkout.stripe.com/test-session', ...args }) } },
    billingPortal: { sessions: { create: async () => ({ url:'https://billing.stripe.com/test-portal' }) } }
  };
  instance=createApp({ DATABASE_PATH:':memory:', NODE_ENV:'test', APP_URL:'http://localhost:3000', PLATFORM_ADMIN_EMAILS:'operator@example.com', STRIPE_WEBHOOK_SECRET:webhookSecret, STRIPE_PRICE_GROWTH:'price_growth', STRIPE_PRICE_STARTER:'price_starter', stripe, mailer:{sendMail:async message=>{sent.push(message);}} });
  server=instance.app.listen(0,'127.0.0.1'); await once(server,'listening'); base=`http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); instance.close(); });
function client() {
  return { cookie:'', csrf:'', tenant:'', async request(path, method='GET', body, headers={}) {
    const response=await fetch(`${base}/api${path}`,{method,headers:{...(this.cookie?{Cookie:this.cookie}:{}),...(this.tenant?{'X-Workspace-Id':this.tenant}:{}),...(method!=='GET'?{'Content-Type':'application/json','X-CSRF-Token':this.csrf}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const setCookie=response.headers.get('set-cookie'); if(setCookie)this.cookie=setCookie.split(';')[0];
    const data=await response.json().catch(()=>null); if(data?.csrf)this.csrf=data.csrf; if(data?.tenant)this.tenant=data.tenant.id;
    return {status:response.status,data,headers:response.headers};
  }};
}
async function register(c=client(), suffix=randomUUID().slice(0,8), extra={}) {
  const response=await c.request('/auth/register','POST',{company:`Company ${suffix}`,slug:`company-${suffix}`,name:'Test Owner',email:`owner-${suffix}@example.com`,password:SECRET,terms:true,...extra});
  assert.equal(response.status,201,JSON.stringify(response.data));return {c,account:response.data};
}
async function registerOperator(){const operator=await register(client(),'operator',{email:'operator@example.com'});assert.equal((await operator.c.request('/auth/verify','POST',{token:actionToken(sent.at(-1))})).status,200);operator.account=(await operator.c.request('/session')).data;return operator;}
async function workspace(c){const r=await c.request('/workspace');assert.equal(r.status,200);return r.data;}
const contact=(extra={})=>({id:randomUUID(),name:'Aarav Test',phone:'+919000000101',email:'aarav@example.com',tag:'New lead',stage:'New leads',consent:false,...extra});
async function save(c, data){return c.request('/workspace','PUT',data);}
function actionToken(message, route){return new URL(message.text.match(/http[^\s]+/)[0]).hash.split('token=')[1];}
async function webhook(event, valid=true){const payload=JSON.stringify(event),signature=valid?stripeSdk.webhooks.generateTestHeaderString({payload,secret:webhookSecret}):'bad';const r=await fetch(`${base}/api/billing/webhook`,{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:payload});return {status:r.status,data:await r.json()};}

test('registration provisions an empty company, owner membership and 14-day trial',async()=>{
  const {c,account}=await register(); const w=await workspace(c);
  assert.deepEqual(w.state.contacts,[]);assert.deepEqual(w.state.templates,[]);assert.equal(account.tenant.role,'owner');assert.equal(account.tenant.status,'trialing');assert.equal(account.tenant.plan,'growth');assert.ok(account.tenant.trialEnd>Date.now()+13*86400000);assert.equal(w.state.settings.business,account.tenant.name);
});
test('passwords are salted hashes and session cookies are HttpOnly and SameSite',async()=>{
  const c=client();const r=await c.request('/auth/register','POST',{company:'Secure Co',slug:'secure-co',name:'Owner',email:'secure@example.com',password:SECRET,terms:true});assert.equal(r.status,201);
  const stored=instance.db.prepare('SELECT password FROM users').get().password;assert.notEqual(stored,SECRET);assert.match(stored,/^[a-f0-9]{64}:[a-f0-9]{128}$/);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Lax/);
  const session=instance.db.prepare('SELECT id FROM sessions').get();assert.notEqual(session.id,c.cookie.split('=')[1]);
});
test('weak passwords and unaccepted terms fail without partial tenant creation',async()=>{
  const c=client();const data={company:'Bad Co',slug:'bad-co',name:'Owner',email:'bad@example.com',password:'short',terms:true};assert.equal((await c.request('/auth/register','POST',data)).status,400);data.password=SECRET;data.terms=false;assert.equal((await c.request('/auth/register','POST',data)).status,400);assert.equal(instance.db.prepare('SELECT count(*) n FROM tenants').get().n,0);
});
test('duplicate email and workspace slug are rejected',async()=>{
  const {account}=await register(client(),'unique');const c=client();const data={company:'Another',slug:'company-unique',name:'Other',email:'other@example.com',password:SECRET,terms:true};assert.equal((await c.request('/auth/register','POST',data)).status,409);data.slug='other-workspace';data.email=account.user.email;assert.equal((await c.request('/auth/register','POST',data)).status,409);
});
test('unauthenticated private endpoints reject access and static files are allowlisted',async()=>{
  const c=client();for(const p of ['/session','/workspace','/team','/audit','/billing'])assert.equal((await c.request(p)).status,401,p);
  for(const p of ['/server.mjs','/.env','/package.json','/data/techzolo.sqlite','/tests/api.test.mjs'])assert.equal((await fetch(base+p)).status,404,p);
  const r=await fetch(base+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('tenant data, membership and private audit entries cannot be selected by client tenant ID',async()=>{
  const a=await register(client(),'alpha'),b=await register(client(),'bravo');let w=await workspace(a.c);w.state.contacts.push(contact());assert.equal((await save(a.c,w)).status,200);
  assert.equal((await workspace(b.c)).state.contacts.length,0);
  assert.equal((await b.c.request('/workspaces/switch','POST',{id:a.account.tenant.id})).status,403);
  const bstate=await b.c.request(`/workspace?tenant=${a.account.tenant.id}`);assert.equal(bstate.data.state.settings.business,b.account.tenant.name);
  const logs=await b.c.request(`/audit?tenant=${a.account.tenant.id}`);assert.equal(logs.data.some(v=>v.action==='workspace.saved'),false);
});
test('CSRF, cross-origin and non-JSON writes are rejected',async()=>{
  const {c}=await register();const w=await workspace(c);
  assert.equal((await c.request('/workspace','PUT',w,{'X-CSRF-Token':'forged'})).status,403);
  assert.equal((await c.request('/workspace','PUT',w,{Origin:'https://attacker.example'})).status,403);
  assert.equal((await c.request('/workspace','PUT',w,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await c.request('/workspace','PUT',w,{'Sec-Fetch-Site':'cross-site'})).status,403);
});
test('login rejects wrong passwords and logout revokes the server session',async()=>{
  const {c,account}=await register();const second=client();assert.equal((await second.request('/auth/login','POST',{email:account.user.email,password:'wrong'})).status,401);assert.equal((await second.request('/auth/login','POST',{email:account.user.email,password:SECRET})).status,200);
  const oldCookie=c.cookie;assert.equal((await c.request('/auth/logout','POST',{})).status,200);c.cookie=oldCookie;assert.equal((await c.request('/workspace')).status,401);
});
test('expired sessions cannot access tenant records',async()=>{
  const {c}=await register();instance.db.exec('UPDATE sessions SET expires=1');assert.equal((await c.request('/session')).status,401);
});
test('login rate limiting returns 429 after repeated failed attempts',async()=>{
  const c=client();for(let i=0;i<15;i++)assert.equal((await c.request('/auth/login','POST',{email:'unknown@example.com',password:'wrong'})).status,401);assert.equal((await c.request('/auth/login','POST',{email:'unknown@example.com',password:'wrong'})).status,429);
});
test('CRUD persistence and optimistic concurrency prevent silent overwrites',async()=>{
  const {c}=await register();const first=await workspace(c),stale=structuredClone(first);first.state.contacts.push(contact());const saved=await save(c,first);assert.equal(saved.status,200);assert.equal(saved.data.version,first.version+1);assert.equal((await save(c,stale)).status,409);assert.equal((await workspace(c)).state.contacts.length,1);
});
test('invalid duplicate phones, orphan deals and malformed state are rejected',async()=>{
  const {c}=await register();const w=await workspace(c);w.state.contacts=[contact(),contact()];assert.equal((await save(c,w)).status,400);w.state.contacts=[];w.state.deals=[{id:'deal',title:'Bad deal',contact:'missing',value:1,stage:'Won'}];assert.equal((await save(c,w)).status,400);assert.equal((await save(c,{version:w.version,state:{settings:{}}})).status,400);
});
test('browser requests cannot forge consent, Meta approval or campaign delivery counts',async()=>{
  const {c}=await register();const w=await workspace(c);w.state.contacts=[contact({consent:true})];assert.equal((await save(c,w)).status,400);w.state.contacts=[];
  w.state.templates=[{id:'t',name:'welcome',label:'Welcome',body:'Hello',category:'Marketing',language:'English',button:'View',status:'Approved'}];assert.equal((await save(c,w)).status,400);w.state.templates=[];
  w.state.campaigns=[{id:'b',name:'Fake sent',template:'welcome',recipients:1,status:'Completed',sent:1,read:1,date:'Today'}];assert.equal((await save(c,w)).status,400);
});
test('unsafe notification route strings are rejected',async()=>{const {c}=await register();const w=await workspace(c);w.state.notifications=[{id:'n',title:'XSS',text:'bad',type:'" onclick="alert(1)',read:false}];assert.equal((await save(c,w)).status,400);});
test('trial expiry blocks edits while leaving read access and billing available',async()=>{
  const {c,account}=await register();instance.db.prepare('UPDATE tenants SET trial_end=1 WHERE id=?').run(account.tenant.id);const w=await workspace(c);w.state.contacts.push(contact());assert.equal((await save(c,w)).status,402);assert.equal((await c.request('/billing')).status,200);assert.equal((await c.request('/branding','PUT',{color:'#123456'})).status,402);
});
test('server plan limits stop additional records',async()=>{
  const {c,account}=await register();instance.db.prepare("UPDATE tenants SET plan='starter' WHERE id=?").run(account.tenant.id);const w=await workspace(c);w.state.contacts=Array.from({length:1001},(_,i)=>contact({phone:`+919${String(i).padStart(9,'0')}`}));assert.equal((await save(c,w)).status,402);
});
test('decoded company logos are normalized to PNG and scoped to the company',async()=>{
  const bytes=await sharp({create:{width:900,height:600,channels:4,background:'#aabbcc'}}).webp().toBuffer();const logo=`data:image/webp;base64,${bytes.toString('base64')}`;
  const a=await register(client(),'logo-a',{logo,color:'#6728ac'}),b=await register(client(),'logo-b');
  const response=await fetch(base+a.account.tenant.logo);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/png/);const metadata=await sharp(Buffer.from(await response.arrayBuffer())).metadata();assert.equal(metadata.width,512);assert.equal(metadata.height,341);
  const pub=(await b.c.request(`/public/${a.account.tenant.slug}`)).data;assert.equal(pub.name,a.account.tenant.name);assert.equal(pub.color,'#6728ac');assert.equal(pub.state,undefined);assert.equal(pub.email,undefined);assert.equal(b.account.tenant.logo,'');
});
test('SVG, spoofed image bytes, oversized files and invalid colors fail',async()=>{
  const {c}=await register();for(const body of [{logo:'data:image/svg+xml;base64,PHN2Zy8+'},{logo:'data:image/png;base64,aW52YWxpZA=='},{color:'red" onclick="alert(1)'},{logo:`data:image/png;base64,${Buffer.alloc(2*1024*1024+1).toString('base64')}`}])assert.ok([400,413].includes((await c.request('/branding','PUT',body)).status));
});
test('removing a logo restores initials without affecting another workspace',async()=>{
  const {c,account}=await register();const bytes=await sharp({create:{width:1,height:1,channels:4,background:'red'}}).png().toBuffer();assert.equal((await c.request('/branding','PUT',{logo:`data:image/png;base64,${bytes.toString('base64')}`})).status,200);const r=await c.request('/branding','PUT',{removeLogo:true,color:'#224466'});assert.equal(r.data.tenant.logo,'');assert.equal((await fetch(`${base}/api/public/${account.tenant.slug}/logo`)).status,404);
});
async function addRole(role){const owner=await register(client(),'owner'),member=await register(client(),'member');const invite=await owner.c.request('/team/invite','POST',{email:member.account.user.email,role});assert.equal(invite.status,201);const raw=invite.data.link.split('token=')[1];assert.equal((await member.c.request('/team/accept','POST',{token:raw})).status,200);return {owner,member,raw};}
test('viewer cannot mutate CRM, branding, invitations, audit access or billing',async()=>{
  const {member}=await addRole('viewer');assert.equal((await member.c.request('/team')).status,200);assert.equal((await save(member.c,await workspace(member.c))).status,403);
  for(const [path,body] of [['/branding',{color:'#123456'}],['/team/invite',{email:'x@example.com',role:'agent'}],['/billing/checkout',{plan:'growth'}]])assert.equal((await member.c.request(path,path==='/branding'?'PUT':'POST',body)).status,403,path);assert.equal((await member.c.request('/audit')).status,403);
});
test('agent can edit contacts and notes but cannot change company configuration',async()=>{
  const {member}=await addRole('agent');let w=await workspace(member.c);w.state.contacts=[contact()];assert.equal((await save(member.c,w)).status,200);w=await workspace(member.c);w.state.contacts[0].note='Team note';assert.equal((await save(member.c,w)).status,200);w=await workspace(member.c);w.state.settings.business='Hijacked';assert.equal((await save(member.c,w)).status,403);
});
test('admin can manage branding and invite agents but cannot grant admin or change billing',async()=>{
  const {member}=await addRole('admin');assert.equal((await member.c.request('/branding','PUT',{color:'#123456'})).status,200);assert.equal((await member.c.request('/team/invite','POST',{email:'agent@example.com',role:'agent'})).status,201);assert.equal((await member.c.request('/team/invite','POST',{email:'admin@example.com',role:'admin'})).status,403);assert.equal((await member.c.request('/billing/checkout','POST',{plan:'growth'})).status,403);
});
test('invitations are bound to recipient email, expire and cannot be replayed',async()=>{
  const a=await register(client(),'inviter'),b=await register(client(),'recipient'),c=await register(client(),'stranger');const invite=await a.c.request('/team/invite','POST',{email:b.account.user.email,role:'agent'});const raw=invite.data.link.split('token=')[1];assert.equal((await c.c.request('/team/accept','POST',{token:raw})).status,403);assert.equal((await b.c.request('/team/accept','POST',{token:raw})).status,200);assert.equal((await b.c.request('/team/accept','POST',{token:raw})).status,400);
  const next=await a.c.request('/team/invite','POST',{email:'later@example.com',role:'viewer'});instance.db.exec('UPDATE invites SET expires=1');assert.equal((await a.c.request('/team/accept','POST',{token:next.data.link.split('token=')[1]})).status,400);
});
test('pending invites reserve seats and revoked invitations cannot be used',async()=>{
  const {c,account}=await register();instance.db.prepare("UPDATE tenants SET plan='starter' WHERE id=?").run(account.tenant.id);const a=await c.request('/team/invite','POST',{email:'one@example.com',role:'agent'});assert.equal(a.status,201);assert.equal((await c.request('/team/invite','POST',{email:'two@example.com',role:'agent'})).status,201);assert.equal((await c.request('/team/invite','POST',{email:'three@example.com',role:'agent'})).status,402);
  const team=(await c.request('/team')).data;assert.equal((await c.request(`/team/invites/${team.invites[0].id}`,'DELETE',{})).status,200);assert.equal((await c.request('/team/accept','POST',{token:a.data.link.split('token=')[1]})).status,400);
});
test('owner removal is forbidden and removing members revokes their workspace session',async()=>{
  const {owner,member}=await addRole('agent');assert.equal((await owner.c.request(`/team/${owner.account.user.id}`,'DELETE',{})).status,400);assert.equal((await owner.c.request(`/team/${member.account.user.id}`,'DELETE',{})).status,200);assert.equal((await member.c.request('/workspace')).status,401);
});
test('workspace switching refreshes tenant identity and preserves separate CRM data',async()=>{
  const {c,account}=await register();const next=await c.request('/workspaces','POST',{company:'Second Company',slug:'second-company',color:'#112233'});assert.equal(next.status,201);assert.equal(next.data.tenant.name,'Second Company');assert.equal(next.data.workspaces.length,2);assert.equal((await c.request('/workspaces/switch','POST',{id:account.tenant.id})).status,200);assert.equal((await workspace(c)).state.settings.business,account.tenant.name);
});
test('public signup records pending requests without asserting verified consent',async()=>{
  const {c,account}=await register();const publicClient=client();const body={name:'Customer',phone:'+919000000101',agreement:true};assert.equal((await publicClient.request(`/public/${account.tenant.slug}/subscribe`,'POST',body)).status,202);assert.equal((await workspace(c)).state.contacts.length,0);const requests=(await c.request('/subscriber-requests')).data;assert.equal(requests.length,1);assert.match(requests[0].wording,/WhatsApp confirmation/);assert.equal((await publicClient.request(`/public/${account.tenant.slug}/subscribe`,'POST',body)).status,202);assert.equal((await c.request('/subscriber-requests')).data.length,1);
});
test('disabled public signup and missing consent reject submissions',async()=>{
  const {c,account}=await register();const path=`/public/${account.tenant.slug}/subscribe`,body={name:'Customer',phone:'+919000000101',agreement:false};assert.equal((await c.request(path,'POST',body)).status,400);const w=await workspace(c);w.state.settings.signupEnabled=false;await save(c,w);body.agreement=true;assert.equal((await c.request(path,'POST',body)).status,403);
});
test('password recovery is email-bound, single-use, expires and revokes prior sessions',async()=>{
  const {c,account}=await register();sent=[];assert.equal((await c.request('/auth/forgot','POST',{email:account.user.email})).status,200);const raw=actionToken(sent[0]);const fresh=client();assert.equal((await fresh.request('/auth/reset','POST',{token:raw,password:'My new memorable password!'})).status,200);assert.equal((await c.request('/session')).status,401);assert.equal((await fresh.request('/auth/reset','POST',{token:raw,password:SECRET})).status,400);assert.equal((await fresh.request('/auth/login','POST',{email:account.user.email,password:'My new memorable password!'})).status,200);
});
test('unknown recovery emails receive the same response and email verification is one-time',async()=>{
  const {c,account}=await register();const raw=actionToken(sent[0]);assert.equal((await c.request('/auth/verify','POST',{token:raw})).status,200);assert.equal((await c.request('/session')).data.user.verified,1);assert.equal((await c.request('/auth/verify','POST',{token:raw})).status,400);
  const known=await c.request('/auth/forgot','POST',{email:account.user.email}),unknown=await c.request('/auth/forgot','POST',{email:'unknown@example.com'});assert.deepEqual(known.data,unknown.data);
});
test('checkout does not grant paid entitlements before a verified subscription webhook',async()=>{
  const {c,account}=await register();const result=await c.request('/billing/checkout','POST',{plan:'starter'});assert.equal(result.status,200);assert.equal((await c.request('/billing')).data.status,'trialing');assert.equal((await c.request('/billing')).data.plan,'growth');assert.equal(instance.db.prepare('SELECT customer FROM tenants WHERE id=?').get(account.tenant.id).customer,'cus_test');
});
test('invalid webhook signatures cannot alter billing',async()=>{const {c}=await register();assert.equal((await webhook({id:'evt_bad',type:'customer.subscription.updated',data:{object:{id:'sub_bad'}}},false)).status,400);assert.equal((await c.request('/billing')).data.status,'trialing');});
test('signed billing webhooks are idempotent and reconcile current provider status',async()=>{
  const {c,account}=await register();instance.db.prepare('UPDATE tenants SET customer=? WHERE id=?').run('cus_demo',account.tenant.id);
  currentSubscription={id:'sub_demo',customer:'cus_demo',status:'active',items:{data:[{price:{id:'price_growth'}}]}};
  const event={id:'evt_active',type:'customer.subscription.updated',data:{object:{id:'sub_demo',status:'past_due'}}};assert.equal((await webhook(event)).status,200);assert.equal((await c.request('/billing')).data.status,'active');assert.equal((await webhook(event)).status,200);assert.equal(retrievals,1);
  currentSubscription.status='canceled';assert.equal((await webhook({...event,id:'evt_delayed'})).status,200);assert.equal((await c.request('/billing')).data.status,'canceled');assert.equal((await save(c,await workspace(c))).status,402);
});
test('unknown Stripe price IDs fail closed instead of granting an arbitrary plan',async()=>{
  const {c,account}=await register();instance.db.prepare('UPDATE tenants SET customer=? WHERE id=?').run('cus_demo',account.tenant.id);currentSubscription={id:'sub_demo',customer:'cus_demo',status:'active',items:{data:[{price:{id:'unknown_price'}}]}};await webhook({id:'evt_unknown',type:'customer.subscription.created',data:{object:{id:'sub_demo'}}});assert.equal((await c.request('/billing')).data.status,'incomplete');assert.equal((await save(c,await workspace(c))).status,402);
});
test('platform console is restricted to verified server allowlisted emails and reports safe system metrics',async()=>{
  const operator=await registerOperator(),customer=await register(client(),'customer');
  assert.equal(operator.account.platformAdmin,true);assert.equal(customer.account.platformAdmin,false);
  assert.equal((await customer.c.request('/platform-admin/overview')).status,403);
  assert.equal((await client().request('/platform-admin/workspaces')).status,401);
  const overview=await operator.c.request('/platform-admin/overview');assert.equal(overview.status,200);assert.equal(overview.data.metrics.workspaces,2);assert.equal(overview.data.metrics.users,2);assert.equal(overview.data.system.database,'healthy');
  const list=await operator.c.request('/platform-admin/workspaces?q=customer');assert.equal(list.status,200);assert.equal(list.data.total,1);assert.equal(list.data.workspaces[0].ownerEmail,customer.account.user.email);assert.equal(JSON.stringify(list.data).includes('state'),false);assert.equal(JSON.stringify(list.data).includes('token'),false);
  assert.equal((await operator.c.request(`/platform-admin/workspaces/${customer.account.tenant.id}`)).status,200);
});
test('an unverified allowlisted address cannot enter the platform console',async()=>{
  const account=await register(client(),'unverified-operator',{email:'operator@example.com'});
  assert.equal(account.account.platformAdmin,false);assert.equal((await account.c.request('/platform-admin/overview')).status,403);
  assert.equal((await account.c.request('/auth/verify','POST',{token:actionToken(sent.at(-1))})).status,200);
  assert.equal((await account.c.request('/session')).data.platformAdmin,true);assert.equal((await account.c.request('/platform-admin/overview')).status,200);
});
test('platform operator can extend only unpaid trials and every change is recorded',async()=>{
  const operator=await registerOperator(),customer=await register(client(),'trial-customer');
  const before=(await operator.c.request(`/platform-admin/workspaces/${customer.account.tenant.id}`)).data.workspace.trialEnd;
  const extended=await operator.c.request(`/platform-admin/workspaces/${customer.account.tenant.id}/trial`,'POST',{days:21});assert.equal(extended.status,200);assert.equal(extended.data.trialEnd,before+21*86400000);
  assert.equal((await operator.c.request(`/platform-admin/workspaces/${customer.account.tenant.id}/trial`,'POST',{days:91})).status,400);
  instance.db.prepare("UPDATE tenants SET status='active',subscription='sub_paid' WHERE id=?").run(customer.account.tenant.id);
  assert.equal((await operator.c.request(`/platform-admin/workspaces/${customer.account.tenant.id}/trial`,'POST',{days:10})).status,409);
  assert.equal((await operator.c.request('/platform-admin/overview')).data.activity.some(entry=>entry.action==='workspace.trial_extended'),true);
});
test('platform suspension blocks company writes but preserves reads and can be reversed',async()=>{
  const operator=await registerOperator(),customer=await register(client(),'suspended-customer');
  const state=await workspace(customer.c);
  assert.equal((await operator.c.request(`/platform-admin/workspaces/${customer.account.tenant.id}/suspension`,'POST',{suspended:true,reason:'Payment and ownership verification review'})).status,200);
  assert.equal((await customer.c.request('/session')).data.tenant.suspended,true);assert.equal((await workspace(customer.c)).state.contacts.length,0);
  assert.equal((await save(customer.c,state)).status,403);
  assert.equal((await customer.c.request(`/public/${customer.account.tenant.slug}/subscribe`,'POST',{name:'Test',phone:'+919000000101',agreement:true})).status,403);
  assert.equal((await operator.c.request(`/platform-admin/workspaces/${customer.account.tenant.id}/suspension`,'POST',{suspended:false})).status,200);
  assert.equal((await customer.c.request('/session')).data.tenant.suspended,false);assert.equal((await save(customer.c,state)).status,200);
});
test('platform can revoke and restore user access but cannot disable its own operator account',async()=>{
  const operator=await registerOperator(),customer=await register(client(),'disabled-customer');
  assert.equal((await operator.c.request(`/platform-admin/users/${operator.account.user.id}/access`,'POST',{disabled:true})).status,409);
  const disabled=await operator.c.request(`/platform-admin/users/${customer.account.user.id}/access`,'POST',{disabled:true});assert.equal(disabled.status,200);
  assert.equal(instance.db.prepare('SELECT count(*) n FROM sessions WHERE user=?').get(customer.account.user.id).n,0);
  assert.equal((await customer.c.request('/session')).status,401);
  const login=client();assert.equal((await login.request('/auth/login','POST',{email:customer.account.user.email,password:SECRET})).status,401);
  assert.equal((await operator.c.request(`/platform-admin/users/${customer.account.user.id}/access`,'POST',{disabled:false})).status,200);
  assert.equal((await login.request('/auth/login','POST',{email:customer.account.user.email,password:SECRET})).status,200);
});
test('a stale tab cannot write a different company after another tab switches workspace',async()=>{
  const {c,account}=await register();const stale=await workspace(c);
  const other=await c.request('/workspaces','POST',{company:'Other tab company',slug:'other-tab-company'});assert.equal(other.status,201);
  const attempted=await c.request('/workspace','PUT',stale,{'X-Workspace-Id':account.tenant.id});assert.equal(attempted.status,409);assert.match(attempted.data.error,/active workspace changed/);
  assert.equal((await workspace(c)).state.settings.business,'Other tab company');assert.equal((await c.request('/workspace','GET',undefined,{'X-Workspace-Id':account.tenant.id})).status,409);
});
test('role changes take effect on the member’s next request without requiring logout',async()=>{
  const {owner,member}=await addRole('agent');assert.equal((await owner.c.request(`/team/${member.account.user.id}`,'PATCH',{role:'viewer'})).status,200);assert.equal((await save(member.c,await workspace(member.c))).status,403);
});
test('expired recovery tokens and reserved prototype contact IDs are rejected',async()=>{
  const {c,account}=await register();await c.request('/auth/forgot','POST',{email:account.user.email});const raw=actionToken(sent.at(-1));instance.db.exec("UPDATE actions SET expires=1 WHERE kind='reset'");assert.equal((await c.request('/auth/reset','POST',{token:raw,password:SECRET})).status,400);
  const w=await workspace(c);w.state.contacts=[contact({id:'__proto__'})];assert.equal((await save(c,w)).status,400);
});
test('missing external services fail explicitly without changing trial entitlements',async()=>{
  const isolated=createApp({DATABASE_PATH:':memory:',NODE_ENV:'test',APP_URL:'http://localhost:3000',SMTP_URL:'',STRIPE_SECRET_KEY:''});const other=isolated.app.listen(0,'127.0.0.1');await once(other,'listening');const otherBase=`http://127.0.0.1:${other.address().port}`;
  try{
    const r=await fetch(otherBase+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company:'No Providers',slug:'no-providers',name:'Owner',email:'owner@example.com',password:SECRET,terms:true})});assert.equal(r.status,201);const a=await r.json();const cookie=r.headers.get('set-cookie').split(';')[0];
    for(const path of ['/billing/checkout','/auth/forgot']){const response=await fetch(otherBase+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':a.csrf,'X-Workspace-Id':a.tenant.id},body:JSON.stringify({plan:'growth',email:'owner@example.com'})});assert.equal(response.status,503);}
    assert.equal(isolated.db.prepare('SELECT status FROM tenants').get().status,'trialing');
  }finally{other.closeAllConnections();await new Promise(resolve=>other.close(resolve));isolated.close();}
});
