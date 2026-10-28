const ORIGINAL_ORIGIN = 'https://cyberhandyman-ioslocspo.cyberhandyman.workers.dev';
const TYPES = {html:'text/html; charset=utf-8',js:'application/javascript; charset=utf-8',svg:'image/svg+xml',png:'image/png',webmanifest:'application/manifest+json',sgmodule:'text/plain; charset=utf-8',lnplugin:'text/plain; charset=utf-8',stoverride:'text/yaml; charset=utf-8',snippet:'text/plain; charset=utf-8'};
const HEADERS = {'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'};
function json(data,status=200){ return new Response(JSON.stringify(data),{status,headers:{...HEADERS,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
function coords(lat,lon,name='') {
  lat=Number(lat); lon=Number(lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180) return null;
  return {lat,lon,name};
}
function gcjToWgs(lat,lon){
  if(lon<72.004||lon>137.8347||lat<0.8293||lat>55.8271) return {lat,lon};
  const x=lon-105,y=lat-35,pi=Math.PI;
  let a=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));
  a+=(20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
  a+=(20*Math.sin(y*pi)+40*Math.sin(y*pi/3))*2/3;
  a+=(160*Math.sin(y*pi/12)+320*Math.sin(y*pi/30))*2/3;
  let b=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));
  b+=(20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
  b+=(20*Math.sin(x*pi)+40*Math.sin(x*pi/3))*2/3;
  b+=(150*Math.sin(x*pi/12)+300*Math.sin(x*pi/30))*2/3;
  const rad=lat*pi/180,magic=1-.00669342162296594323*Math.sin(rad)**2,sqrt=Math.sqrt(magic);
  a=a*180/((6378245*(1-.00669342162296594323))/(magic*sqrt)*pi);
  b=b*180/(6378245/sqrt*Math.cos(rad)*pi);
  return {lat:lat-a,lon:lon-b};
}
function bdToWgs(lat,lon){ const x=lon-.0065,y=lat-.006,z=Math.sqrt(x*x+y*y)-.00002*Math.sin(y*Math.PI*3000/180),t=Math.atan2(y,x)-.000003*Math.cos(x*Math.PI*3000/180); return gcjToWgs(z*Math.sin(t),z*Math.cos(t)); }
export function parseCoordinates(input){
  const text=String(input).trim();
  if(!text||text.length>8192)return null;
  const n='(-?\\d+(?:\\.\\d+)?)';
  let m=text.match(new RegExp('^\\s*'+n+'[,，\\s]+'+n+'\\s*$'));
  if(m)return coords(m[1],m[2])||(Math.abs(Number(m[1]))>90?coords(m[2],m[1]):null);
  let u; try{u=new URL((text.match(/https?:\/\/[^\s<>]+/)||[])[0]||text);}catch{return null;}
  const p=u.searchParams,host=u.hostname;
  let decoded=text;try{decoded=decodeURIComponent(u.href);}catch{}
  if(/(^|\.)amap\.com$|(^|\.)alimaps\.com$/.test(host)){
    const point=p.get('position')||p.get('center')||p.get('location')||p.get('q')||p.get('to');
    m=point&&point.match(new RegExp(n+','+n));
    if(!m)m=decoded.match(new RegExp('(?:lon|lng)='+n+'.*?lat='+n));
    if(m){const c=coords(m[2],m[1]); if(c)return {...gcjToWgs(c.lat,c.lon),name:p.get('name')||p.get('poiname')||''};}
  }
  if(/(^|\.)baidu\.com$/.test(host)){
    const point=p.get('location')||p.get('latlng')||p.get('destination')||p.get('origin')||'';
    m=point.match(new RegExp('(?:latlng:)?'+n+','+n));
    if(m){const c=coords(m[1],m[2]);if(c)return {...(p.get('coord_type')==='wgs84'?c:bdToWgs(c.lat,c.lon)),name:p.get('title')||''};}
  }
  for(const key of ['ll','q','query','sll','center','destination']){
    m=(p.get(key)||'').match(new RegExp('^'+n+','+n+'$'));
    if(m)return coords(m[1],m[2],p.get('name')||'');
  }
  m=decoded.match(new RegExp('!3d'+n+'!4d'+n))||decoded.match(new RegExp('@'+n+','+n));
  if(m)return coords(m[1],m[2]);
  return null;
}
const MAP_HOSTS=['maps.app.goo.gl','goo.gl','www.google.com','maps.google.com','maps.apple.com','surl.amap.com','uri.amap.com','www.amap.com','amap.com','nav.alimaps.com','j.map.baidu.com','map.baidu.com'];
async function parseLink(input){
  const direct=parseCoordinates(input); if(direct)return direct;
  let value=(String(input).match(/https?:\/\/[^\s<>]+/)||[])[0];
  if(!value)throw new Error('未找到有效坐标，请输入「纬度, 经度」或地图分享链接。');
  for(let i=0;i<5;i++){
    const u=new URL(value);
    if(u.protocol!=='https:'||u.port||u.username||u.password||!MAP_HOSTS.includes(u.hostname))throw new Error('暂不支持这个链接，请粘贴经纬度或受支持的地图链接。');
    const r=await fetch(u.href,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'User-Agent':'Mozilla/5.0 iOSLocationFork/1.0'}});
    if(r.status>=300&&r.status<400&&r.headers.has('location')){
      value=new URL(r.headers.get('location'),u).href;
      const c=parseCoordinates(value);if(c)return c;continue;
    }
    const body=await r.text();
    if(body.length>1500000)throw new Error('地图返回内容过大，请使用完整链接或经纬度。');
    let m=body.match(/(?:location|position)["']?\s*:\s*["'](-?[\d.]+),(-?[\d.]+)/);
    if(m){const c=coords(m[2],m[1]);if(c)return /baidu/.test(u.hostname)?bdToWgs(c.lat,c.lon):/amap|alimaps/.test(u.hostname)?gcjToWgs(c.lat,c.lon):c;}
    m=body.match(/(?:latitude|lat)["']?\s*[:=]\s*(-?[\d.]+)[\s\S]{0,100}?(?:longitude|lng|lon)["']?\s*[:=]\s*(-?[\d.]+)/);
    if(m){const c=coords(m[1],m[2]);if(c)return c;}
    throw new Error('此分享链接未提供可识别坐标，请使用完整链接或经纬度。');
  }
  throw new Error('链接跳转过多，请使用完整地图链接或经纬度。');
}
export default {
  async fetch(request){
    const u=new URL(request.url);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...HEADERS,'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS'}});
    if(!['GET','HEAD'].includes(request.method))return json({error:'Method not allowed'},405);
    if(u.pathname==='/health')return json({ok:true,version:'1.0.0',storage:'device-only'});
    if(u.pathname==='/api/parse'){
      try{const input=u.searchParams.get('u')||'';if(input.length>8192)return json({error:'链接过长'},400);return json(await parseLink(input));}catch(e){return json({error:e.message},400);}
    }
    if(u.pathname==='/source.zip')return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(SOURCE_ARCHIVE),c=>c.charCodeAt(0)),{headers:{...HEADERS,'Content-Type':'application/zip','Content-Disposition':'attachment; filename="ios-location-fork-source.zip"'}});
    let key=u.pathname==='/'?'/index.html':u.pathname==='/picker'||u.pathname==='/picker/'?'/picker.html':u.pathname;
    const asset=ASSETS[key];
    if(!asset)return new Response('Not found',{status:404,headers:HEADERS});
    const ext=key.split('.').pop();
    let body=asset.binary?Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0)):asset.data.split(ORIGINAL_ORIGIN).join(u.origin);
    return new Response(request.method==='HEAD'?null:body,{headers:{...HEADERS,'Content-Type':TYPES[ext]||'text/plain; charset=utf-8'}});
  }
};
