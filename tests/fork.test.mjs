import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import worker,{parseCoordinates} from '../worker/index.js';

const origin='https://test.example';
for(const path of ['/','/picker','/picker/','/location-spoofer.js','/location-spoofer-qx.js','/location-settings.js','/ios-location-spoofer.sgmodule','/ios-location-spoofer.lnplugin','/ios-location-spoofer.stoverride','/ios-location-spoofer.snippet','/icon.svg','/icon-180.png','/manifest.webmanifest','/source.zip']){
  const r=await worker.fetch(new Request(origin+path));assert.equal(r.status,200,path);assert.ok((await r.arrayBuffer()).byteLength>0,path);
}
for(const path of ['/ios-location-spoofer.sgmodule','/ios-location-spoofer.lnplugin','/ios-location-spoofer.stoverride','/ios-location-spoofer.snippet']){
  const text=await(await worker.fetch(new Request(origin+path))).text();
  assert.ok(!text.includes('cyberhandyman-ioslocspo.cyberhandyman.workers.dev'));
  for(const m of text.matchAll(/https:\/\/test\.example\/[a-z0-9.-]+/g))assert.equal((await worker.fetch(new Request(m[0]))).status,200,m[0]);
}
assert.deepEqual(parseCoordinates('22.3193,114.1694'),{lat:22.3193,lon:114.1694,name:''});
assert.deepEqual(parseCoordinates('https://maps.apple.com/?ll=22.3193,114.1694'),{lat:22.3193,lon:114.1694,name:''});
assert.deepEqual(parseCoordinates('https://www.google.com/maps/@35.68,139.76,16z'),{lat:35.68,lon:139.76,name:''});
assert.deepEqual(parseCoordinates('https://www.google.com/maps/place/a/data=!3d35.68!4d139.76'),{lat:35.68,lon:139.76,name:''});
const c=parseCoordinates('https://uri.amap.com/marker?position=116.404,39.915');assert.ok(c.lat<39.915&&c.lon<116.404);
assert.equal(parseCoordinates('1000,2000'),null);
for(const p of ['/index.html','/picker.html']){
  const text=await readFile(new URL('../public'+p,import.meta.url),'utf8');
  for(const m of text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1],{filename:p});
}
const settings=await readFile(new URL('../public/location-settings.js',import.meta.url),'utf8');
for(const qx of [false,true]){
  const store=new Map();
  function run(query){let response;const box={$request:{url:'https://gs-loc.apple.com/ils-settings/save?'+query},$done:r=>response=qx?r:r.response};
    if(qx)Object.assign(box,{$task:{},$prefs:{valueForKey:k=>store.get(k),setValueForKey:(v,k)=>(store.set(k,v),true)}});
    else box.$persistentStore={read:k=>store.get(k),write:(v,k)=>(store.set(k,v),true)};
    vm.runInNewContext(settings,box);return JSON.parse(response.body);}
  assert.equal(run('lat=22.3193&lon=114.1694&randomRadius=0').success,true);
  assert.equal(run('action=query').latitude,22.3193);
  assert.equal(run('action=query').enabled,true);
  assert.equal(run('action=clear').success,true);
  assert.equal(run('action=query').enabled,false);
}
const invalid=await worker.fetch(new Request(origin+'/api/parse?u='+encodeURIComponent('https://127.0.0.1/private')));assert.equal(invalid.status,400);
assert.equal((await worker.fetch(new Request(origin+'/missing'))).status,404);
assert.equal((await worker.fetch(new Request(origin+'/health',{method:'POST'}))).status,405);
console.log('PASS: all routes, module links, page syntax, coordinate parsing, restricted link fetching, and device save/query/clear for both client APIs.');
