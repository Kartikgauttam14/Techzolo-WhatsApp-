// Test-tunnel boundary: forward only Meta's signed webhook, never CRM/account APIs.
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function createWebhookRelay(upstream='http://127.0.0.1:3000'){
  const origin=new URL(upstream);if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.protocol!=='http:')throw new Error('The webhook relay upstream must be a local HTTP server.');
  return createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    const url=new URL(req.url,'http://localhost');
    if(url.pathname!=='/api/whatsapp/webhook'||!['GET','POST'].includes(req.method)){res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');return;}
    try{
      let body;if(req.method==='POST'){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024){res.writeHead(413);res.end('Webhook too large');return;}chunks.push(chunk);}body=Buffer.concat(chunks);}
      const headers={};for(const name of ['content-type','x-hub-signature-256'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
      const response=await fetch(`${origin.origin}${url.pathname}${url.search}`,{method:req.method,headers,...(body?{body}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});
      res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'text/plain'});res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(502,{'Content-Type':'text/plain'});res.end('Local webhook server unavailable');}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))createWebhookRelay(process.env.WEBHOOK_UPSTREAM||'http://127.0.0.1:3000').listen(Number(process.env.WEBHOOK_RELAY_PORT||3002),'127.0.0.1',()=>console.log('Webhook-only relay listening on http://127.0.0.1:3002. CRM/account routes are not forwarded.'));
