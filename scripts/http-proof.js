const http=require("http");
const fs=require("fs"); const path=require("path"); const seed=require("../roster");
const dataDir=path.join(__dirname,"../data"); fs.mkdirSync(dataDir,{recursive:true}); fs.writeFileSync(path.join(dataDir,"store.json"), JSON.stringify({roster:seed.map((o,i)=>Object.assign({},o,{order:i})),shifts:[],interests:[],nextShiftId:1},null,2)); const db=require("../db");
const PORT=3848;
const srv=http.createServer(async (req,res)=>{
  const u=new URL(req.url,"http://x");
  let body=""; for await (const x of req) body+=x;
  const j=body?JSON.parse(body||"null"):{};
  const out=(c,o)=>{res.writeHead(c,{"Content-Type":"application/json"});res.end(JSON.stringify(o));};
  if(u.pathname==="/h") return out(200,{ok:1});
  if(u.pathname==="/c"&&req.method==="POST") return out(201,db.createShift(j));
  const m=u.pathname.match(/^\/i\/(.+)$/);
  if(m&&req.method==="POST"){const r=db.addInterest(m[1],j.badge);return out(201,r.interest||r);}
  const n=u.pathname.match(/^\/z\/(.+)$/);
  if(n&&req.method==="POST") return out(200,db.closeShift(n[1]));
  const a=u.pathname.match(/^\/a\/(.+)$/);
  if(a&&req.method==="POST") return out(200,db.confirmAward(a[1]));
  out(404,{});
});
function call(method,path,body){return new Promise((resolve,reject)=>{
  const d=body?JSON.stringify(body):null;
  const r=http.request({host:"127.0.0.1",port:PORT,path,method,headers:d?{"Content-Type":"application/json","Content-Length":Buffer.byteLength(d)}:{}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve(JSON.parse(b)));});
  r.on("error",reject); if(d)r.write(d); r.end();
});}
(async()=>{
  await new Promise(r=>srv.listen(PORT,"127.0.0.1",r));
  console.log(await call("GET","/h"));
  const s=await call("POST","/c",{title:"http",windowMinutes:20});
  await call("POST","/i/"+s.id,{badge:"84"});
  await call("POST","/i/"+s.id,{badge:"80"});
  await call("POST","/i/"+s.id,{badge:"54"});
  const c=await call("POST","/z/"+s.id,{});
  const a=await call("POST","/a/"+s.id,{});
  console.log(JSON.stringify({suggest:c.suggestion,winner:a.winner}));
  const ok=c.suggestion.badge==="54"&&a.winner.badge==="54";
  console.log(ok?"HTTP_PASS":"HTTP_FAIL");
  srv.close(); process.exit(ok?0:1);
})().catch(e=>{console.error(e);process.exit(1);});
