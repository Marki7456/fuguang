import http from 'node:http';
import worker from '../worker/index.js';
const server=http.createServer(async(req,res)=>{
  try{const response=await worker.fetch(new Request('http://127.0.0.1:8787'+req.url,{method:req.method}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
  catch(e){res.writeHead(500);res.end(String(e));}
});
server.listen(8787,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:8787'));
