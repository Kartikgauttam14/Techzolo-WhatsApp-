import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const path=new URL('../.env',import.meta.url);
let content=await readFile(path,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
const defaults={APP_URL:'http://localhost:3000',NODE_ENV:'development',META_APP_ID:'2618907555223678',META_APP_SECRET:'',META_GRAPH_VERSION:'v25.0',META_LOGIN_CONFIG_ID:'',META_WEBHOOK_VERIFY_TOKEN:randomBytes(32).toString('hex'),WHATSAPP_ENCRYPTION_KEY:randomBytes(32).toString('base64'),META_ALLOW_MANUAL_CONNECT:'true'};
for(const[key,value]of Object.entries(defaults)){if(!new RegExp(`^${key}=.+$`,'m').test(content)){const line=new RegExp(`^${key}=.*$`,'m');if(line.test(content))content=content.replace(line,`${key}=${value}`);else content+=`${content.endsWith('\n')?'':'\n'}${key}=${value}\n`;}}
await writeFile(path,content,{mode:0o600});
console.log('Updated ignored .env with the dedicated Meta app ID and unique encryption/webhook keys. Existing nonempty values were preserved. Add META_APP_SECRET and META_LOGIN_CONFIG_ID privately, then restart the server. No secret values were printed.');
