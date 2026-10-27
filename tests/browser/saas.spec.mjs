import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';

async function register(page, name='Acme Studio', emailAddress='') {
  const suffix=randomUUID().slice(0,8), company=`${name} ${suffix}`;
  await page.goto('/#signup');
  await page.getByLabel('Company name',{exact:true}).fill(company);
  await page.getByLabel('Your name',{exact:true}).fill('Jamie Owner');
  await page.getByLabel('Work email',{exact:true}).fill(emailAddress||`jamie-${suffix}@example.com`);
  await page.getByLabel('Password',{exact:true}).fill('A memorable browser test password!');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Create workspace',exact:false}).click();
  await expect(page.getByRole('heading',{name:`A good day for ${company}.`})).toBeVisible();
  return company;
}
test('public product page, mobile navigation and protected route',async({page})=>{
  await page.goto('/');await expect(page.getByRole('heading',{name:/Small moments/})).toBeVisible();
  await page.screenshot({path:'test-results/landing-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('link',{name:/Start free trial/})).toBeVisible();
  await page.screenshot({path:'test-results/landing-mobile.png',fullPage:true});
  const layout=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,overflow:[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,text:e.textContent.slice(0,40)}))}));
  expect(layout.width,JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
  await page.goto('/#contacts');await expect(page.getByRole('heading',{name:/Good to have/})).toBeVisible();
});
test('register, save contact, reload, change brand and use company subscriber page',async({page,context})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const company=await register(page);
  await page.getByRole('link',{name:'Contacts',exact:true}).click();
  await page.getByRole('button',{name:'Add contact',exact:false}).click();
  await page.getByLabel('Full name',{exact:true}).fill('Aarav Customer');
  await page.getByLabel('International phone number').fill('+919000000101');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByText('Aarav Customer',{exact:true})).toBeVisible();
  await expect(page.locator('#save-status')).toHaveText('All changes saved');
  await page.reload();await expect(page.getByText('Aarav Customer',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Brand identity',exact:true}).click();
  const png=await sharp({create:{width:80,height:80,channels:4,background:'#b84372'}}).png().toBuffer();
  await page.locator('#company-logo').setInputFiles({name:'acme.png',mimeType:'image/png',buffer:png});
  await expect(page.getByAltText('New company logo preview')).toBeVisible();
  await page.getByLabel('Your signature color').fill('#664499');
  await page.getByRole('button',{name:/Save brand identity/}).click();
  await expect(page.getByAltText(`${company} logo`).first()).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Company branding saved');
  await page.reload();await expect(page.getByAltText(`${company} logo`).first()).toBeVisible();
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--green').trim())).toBe('#664499');
  await page.screenshot({path:'test-results/branding-desktop.png',fullPage:true});
  const href=await page.getByRole('link',{name:/Preview subscriber page/}).getAttribute('href');
  const customer=await context.newPage();await customer.goto(href);
  await expect(customer.getByAltText(`${company} logo`)).toBeVisible();
  await customer.getByLabel('Your name',{exact:true}).fill('Interested Customer');
  await customer.getByLabel('WhatsApp number',{exact:true}).fill('+919000000999');
  await customer.getByRole('checkbox').check();
  await customer.getByRole('button',{name:/Request to subscribe/}).click();
  await expect(customer.getByRole('status').first()).toContainText('pending');
  await page.goto('/#subscribers');await expect(page.getByText('Interested Customer',{exact:true})).toBeVisible();
  await page.goto('/#billing');await expect(page.getByText('Your trial ends',{exact:false})).toBeVisible();await expect(page.getByText('Stripe is not configured.',{exact:false})).toBeVisible();
  await page.screenshot({path:'test-results/billing-desktop.png',fullPage:true});
  expect(errors).toEqual([]);
});
test('company switch keeps branding and contacts separate and sign out protects data',async({page})=>{
  const first=await register(page,'First Company');
  await page.getByRole('button',{name:'Switch company workspace'}).click();
  await page.getByRole('button',{name:/Create another workspace/}).click();
  const second=`Second Company ${randomUUID().slice(0,8)}`;
  await page.getByLabel('Company name',{exact:true}).fill(second);
  await page.getByRole('button',{name:'Create workspace',exact:false}).click();
  await expect(page.getByRole('heading',{name:`A good day for ${second}.`})).toBeVisible();
  await page.getByRole('button',{name:'Switch company workspace'}).click();await page.getByRole('button',{name:first,exact:false}).click();
  await expect(page.getByRole('heading',{name:`A good day for ${first}.`})).toBeVisible();
  await page.goto('/#security');await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('heading',{name:/Good to have/})).toBeVisible();await page.goto('/#dashboard');await expect(page.getByRole('heading',{name:/Good to have/})).toBeVisible();
});
test('all CRM routes render without runtime errors and fit a phone viewport',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await register(page,'Mobile Company');
  await page.setViewportSize({width:390,height:844});
  for(const route of ['dashboard','contacts','inbox','pipelines','broadcasts','templates','automations','flows','agents','subscribers','reports','notifications','settings','branding','team','billing','audit','security','integrations']){
    await page.goto(`/#${route}`);await expect(page.locator('#main h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route).toBeTruthy();
  }
  await page.goto('/#dashboard');await page.screenshot({path:'test-results/workspace-mobile.png',fullPage:true});expect(errors).toEqual([]);
});
test('template, campaign, automation and company settings persist through the actual forms',async({page})=>{
  await register(page,'Workflow Company');
  await page.goto('/#templates');await page.getByRole('button',{name:'Create template',exact:true}).click();
  await page.getByLabel('Template name',{exact:true}).fill('welcome_offer');await page.getByLabel('Display title').fill('Welcome offer');await page.getByLabel('Message body').fill('Welcome to our company.');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome offer',exact:true})).toBeVisible();
  await page.goto('/#broadcasts');await page.getByRole('button',{name:'New campaign',exact:true}).click();
  await page.getByLabel('Campaign name',{exact:true}).fill('Welcome campaign');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByText('Welcome campaign',{exact:true})).toBeVisible();
  await page.goto('/#automations');await page.getByRole('button',{name:'New automation',exact:true}).click();
  await page.getByLabel('Automation name').fill('Welcome automation');await page.getByLabel('Trigger keyword').fill('HELLO');await page.getByLabel('Description',{exact:true}).fill('Welcome new customers');await page.getByLabel('Example reply').fill('Hello, how can our team help?');
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome automation',exact:true})).toBeVisible();
  await page.goto('/#settings');await page.getByLabel('Company name',{exact:true}).fill('Updated Company');await page.getByLabel('Business email').fill('business@example.com');await page.getByRole('button',{name:/Save business details/}).click();
  await expect(page.locator('#save-status')).toHaveText('All changes saved');await page.reload();await expect(page.getByLabel('Company name',{exact:true})).toHaveValue('Updated Company');
  const state=await page.evaluate(async()=> (await window.SaaS.api('/workspace')).state);
  expect(state.templates[0].status).toBe('Draft');expect(state.campaigns[0].status).toBe('Draft');expect(state.campaigns[0].sent).toBe(0);expect(state.automations[0].keyword).toBe('HELLO');
});
test('teammate invitation, viewer restrictions and removal work across separate accounts',async({browser,page})=>{
  await register(page,'Team Company');
  const ownerName=await page.evaluate(()=>window.SaaS.account.tenant.name);
  const memberContext=await browser.newContext();const member=await memberContext.newPage();
  try{
    await register(member,'Viewer Company');const address=await member.evaluate(()=>window.SaaS.account.user.email);
    await page.goto('/#team');await page.getByRole('button',{name:/Invite teammate/}).click();await page.getByLabel('Teammate email').fill(address);await page.getByLabel('Access level').selectOption('viewer');await page.getByRole('button',{name:/Create invitation/}).click();
    const link=await page.locator('#invite-link').inputValue();await page.getByRole('button',{name:'Done',exact:true}).click();
    await member.goto(link);await member.getByRole('button',{name:/Join workspace/}).click();await expect(member.getByRole('heading',{name:`A good day for ${ownerName}.`})).toBeVisible();
    await member.goto('/#contacts');await member.getByRole('button',{name:'Add contact',exact:false}).click();await expect(member.locator('#toast')).toContainText('read-only');await expect(member.locator('#dialog')).not.toBeVisible();
    await page.goto('/#team');await page.getByRole('button',{name:'Refresh team',exact:true}).click();const row=page.locator('tr').filter({hasText:address});await expect(row).toBeVisible();await row.getByRole('button',{name:'Remove',exact:true}).click();await page.getByRole('button',{name:'Remove member',exact:true}).click();
    await member.reload();await expect(member.getByRole('heading',{name:/Good to have/})).toBeVisible();
  }finally{await memberContext.close();}
});
test('allowlisted operator can inspect and search the platform admin console',async({page})=>{
  const company=await register(page,'Platform operator','operator@example.com');
  await page.getByRole('link',{name:'Admin console',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Admin console'})).toBeVisible();
  await expect(page.getByText('Platform services')).toBeVisible();
  await page.getByRole('button',{name:'Workspaces',exact:true}).click();
  const search=page.getByRole('textbox',{name:'Search workspaces'});await search.fill(company);
  const rows=page.locator('.pa-table-card tbody tr');await expect(rows).toHaveCount(1);await expect(rows.first()).toContainText(company);
  await rows.first().getByRole('button',{name:'Manage',exact:true}).click();
  await expect(page.getByRole('heading',{name:company})).toBeVisible();
  await expect(page.getByText(/Support view includes workspace, team, subscription and connection metadata/)).toBeVisible();
  await page.screenshot({path:'test-results/platform-admin-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:'test-results/platform-admin-mobile.png',fullPage:true});
});
