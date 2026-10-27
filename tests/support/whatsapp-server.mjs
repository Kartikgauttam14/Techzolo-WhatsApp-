// Browser-test entrypoint only. Production server.mjs never imports this transport.
import {createApp} from '../../server.mjs';
import {randomBytes} from 'node:crypto';
const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
let count=0;
const {app}=createApp({
  DATABASE_PATH:':memory:',NODE_ENV:'test',APP_URL:process.env.APP_URL,
  mailer:{sendMail:async message=>{if(message.subject.startsWith('Verify')){const link=/https?:\/\/\S+/.exec(message.text)?.[0];const raw=link?new URL(link).hash.split('token=')[1]:'';const response=await fetch(`${process.env.APP_URL}/api/auth/verify`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:raw})});if(!response.ok)throw new Error('Test verification email could not be confirmed.');}}},
  META_APP_ID:'2618907555223678',META_APP_SECRET:'browser_test_meta_secret',META_WEBHOOK_VERIFY_TOKEN:'browser-test-verify-token',
  META_GRAPH_VERSION:'v25.0',META_LOGIN_CONFIG_ID:'',WHATSAPP_ENCRYPTION_KEY:randomBytes(32).toString('base64'),META_ALLOW_MANUAL_CONNECT:'true',
  metaFetch:async(url,options)=>{
    const u=new URL(url),path=u.pathname.replace(/^\/v\d+\.0\//,'');
    if(path==='debug_token')return respond({data:{is_valid:true,app_id:'2618907555223678',scopes:['whatsapp_business_messaging','whatsapp_business_management'],expires_at:0}});
    const account=Number(/account_(\d+)/.exec(options.headers.Authorization)?.[1]||1),waba=`100000000${account}`,number=`200000000${account}`;
    if(path===`${waba}/phone_numbers`)return respond({data:[{id:number,display_phone_number:`+1 555 000 000${account}`,verified_name:`Browser Company ${account}`} ]});
    if(path===`${waba}/subscribed_apps`)return respond({success:true});
    if(path===`${waba}/message_templates`)return respond({data:[{id:'900000001',name:'order_update',language:'en_US',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'Your order {{1}} is ready.'} ]},{id:'900000002',name:'special_offer',language:'en_US',category:'MARKETING',status:'APPROVED',components:[{type:'BODY',text:'A special offer from our company.'} ]}]});
    if(path===`${number}/messages`)return respond({messages:[{id:`wamid.browser.${++count}`}]});
    return respond({error:{code:100}},400);
  }
});
app.listen(Number(process.env.PORT||3001),'127.0.0.1');
