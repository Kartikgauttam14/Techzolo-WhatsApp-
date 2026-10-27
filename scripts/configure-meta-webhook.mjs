const appId=process.env.META_APP_ID,appSecret=process.env.META_APP_SECRET,verifyToken=process.env.META_WEBHOOK_VERIFY_TOKEN;
const callback=new URL(process.env.META_WEBHOOK_URL||'');
const version=process.env.META_GRAPH_VERSION||'v25.0';
if(!appId||!appSecret||!verifyToken||callback.protocol!=='https:'||!callback.pathname.endsWith('/api/whatsapp/webhook'))throw new Error('Configure Meta app credentials and the HTTPS webhook-only URL in the ignored .env file first.');
const root=`https://graph.facebook.com/${version}`;
const tokenUrl=new URL(`${root}/oauth/access_token`);
tokenUrl.searchParams.set('client_id',appId);tokenUrl.searchParams.set('client_secret',appSecret);tokenUrl.searchParams.set('grant_type','client_credentials');
const tokenResponse=await fetch(tokenUrl);
const tokenBody=await tokenResponse.json();
if(!tokenResponse.ok||typeof tokenBody.access_token!=='string')throw new Error('Meta did not issue an app access token. Check the app credentials and Graph API version.');
const appToken=tokenBody.access_token;
async function subscriptions(){
  const url=new URL(`${root}/${appId}/subscriptions`);url.searchParams.set('access_token',appToken);
  const response=await fetch(url);const body=await response.json();
  if(!response.ok||!Array.isArray(body.data))throw new Error('Could not read Meta app webhook subscriptions.');
  return body.data;
}
const before=await subscriptions();
const hasWhatsApp=before.some(item=>item.object==='whatsapp_business_account');
const form=new URLSearchParams({object:'whatsapp_business_account',callback_url:callback.href,verify_token:verifyToken,fields:'messages',access_token:appToken});
const configured=await fetch(`${root}/${appId}/subscriptions`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});
const configuredBody=await configured.json();
if(!configured.ok||configuredBody.success!==true)throw new Error('Meta did not confirm the WhatsApp webhook configuration.');
const after=await subscriptions();
const entry=after.find(item=>item.object==='whatsapp_business_account');
if(!entry?.active||entry.callback_url!==callback.href||!entry.fields?.some(field=>field.name==='messages'))throw new Error('Meta saved the request but the WhatsApp webhook could not be verified afterward.');
console.log(`WhatsApp webhook configured and verified with Meta (messages only; ${hasWhatsApp?'existing WhatsApp subscription updated':'new WhatsApp subscription added'}).`);
