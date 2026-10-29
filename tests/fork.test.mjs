import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import worker,{parseCoordinates} from '../worker/index.js';
import {createDevice, createPicker} from './picker-harness.mjs';

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
// Exercise the actual assets served by the built Worker, not a copy of its logic.
const settings = await (await worker.fetch(new Request(origin + '/location-settings.js'))).text();
const picker = await (await worker.fetch(new Request(origin + '/picker'))).text();
assert.equal(settings, await readFile(new URL('../public/location-settings.js', import.meta.url), 'utf8'));
assert.equal(picker, await readFile(new URL('../public/picker.html', import.meta.url), 'utf8'));
const clients = ['Surge', 'Shadowrocket', 'Egern', 'Loon', 'Stash', 'Quantumult X'];
function assertDisplay(page, status, label, badge = false) {
  assert.equal(page.read('activeStatus'), status);
  assert.ok(page.element('activeValue').textContent.includes(label), page.element('activeValue').textContent);
  assert.equal(page.element('favList').innerHTML.includes('class="fav-active"'), badge);
}
for (const client of clients) {
  for (const [la, lo] of [[22.3193, 114.1694], [0, 114.1694], [22.3193, 0], [0, 0]]) {
    const device = createDevice(settings, client);
    assert.deepEqual(device.run('action=query'), {success:true, hasCoordinates:false, enabled:false});
    const storage = new Map([['ils_favorites', JSON.stringify([{name:'Regression point',lat:la,lon:lo}])]]);
    let page = createPicker(picker, device, storage);
    await page.ready(); // page initialization with no saved point
    assertDisplay(page, 'none', '无已保存的坐标');

    page.box.moveTo(la, lo, 15);
    page.element('altInput').value = '0';
    await page.box.save();
    assert.equal(device.store.get('enabled'), 'true', client);
    assertDisplay(page, 'ok', '已启用定位', true);
    assert.ok(page.element('activeValue').textContent.includes(la.toFixed(6)));
    assert.ok(page.element('activeValue').textContent.includes(lo.toFixed(6)));
    assert.equal(device.run('action=query').altitude, 0);
    assert.equal(device.run('action=query').randomRadius, 0);
    await page.box.queryActive();
    assertDisplay(page, 'ok', '已启用定位', true);

    page = createPicker(picker, device, storage); // refresh/reopen the whole page
    await page.ready();
    assertDisplay(page, 'ok', '已启用定位', true);
    assert.equal(page.read('selected'), true);
    await page.box.clearActive();
    assert.equal(device.store.get('enabled'), 'false', client);
    assert.equal(device.store.get('latitude'), String(la));
    assert.equal(device.store.get('longitude'), String(lo));
    assertDisplay(page, 'disabled', '已保存但停用');
    assert.equal(page.read('savedLon'), null);
    assert.ok(!page.element('status').textContent.includes('已写入'));
    await page.box.queryActive();
    assertDisplay(page, 'disabled', '已保存但停用');

    page = createPicker(picker, device, storage);
    await page.ready();
    assertDisplay(page, 'disabled', '已保存但停用');
    assert.equal(page.read('selected'), false); // no automatic active target for disabled data
    assert.equal(page.views.length, 1); // only the neutral world view
    await page.box.queryActive();
    assertDisplay(page, 'disabled', '已保存但停用');
    page.box.setLang('en');
    assertDisplay(page, 'disabled', 'Saved but disabled');
    page.box.setLang('zh');
    page.box.loadFav(0);
    await page.box.save(); // save the retained point again to re-enable
    assertDisplay(page, 'ok', '已启用定位', true);
    assert.equal(device.run('action=query').enabled, true);
    await page.box.restoreReal(); // second clear entry point uses the same state handling
    assertDisplay(page, 'disabled', '已保存但停用');
    assert.equal(device.run('action=query').enabled, false);
  }

  const device = createDevice(settings, client);
  const page = createPicker(picker, device, new Map([['ils_favorites', JSON.stringify([{name:'point',lat:1,lon:2}])]]));
  await page.ready();
  await page.box.clearActive();
  assertDisplay(page, 'none', '无已保存的坐标');
  page.box.moveTo(1, 2, 15);
  await page.box.save();
  assertDisplay(page, 'ok', '已启用定位', true);

  // A stale enabled query must not overwrite a more recent successful clear.
  let release;
  const staleState = device.run('action=query');
  page.intercept(u => u.searchParams.get('action') === 'query'
    ? new Promise(resolve => { release = () => resolve(new Response(JSON.stringify(staleState))); })
    : new Response(JSON.stringify(device.run(u.search.slice(1)))));
  const pending = page.box.queryActive();
  assertDisplay(page, 'querying', '查询中');
  await page.box.clearActive();
  assertDisplay(page, 'disabled', '已保存但停用');
  release(); await pending;
  assertDisplay(page, 'disabled', '已保存但停用');
  page.intercept(null);

  // A refresh or second mutation during a write cannot publish an older snapshot.
  let finishSave;
  const requestsBeforeSave = page.requests.length;
  page.intercept(u => new Promise(resolve => {
    finishSave = () => resolve(new Response(JSON.stringify(device.run(u.search.slice(1)))));
  }));
  page.box.moveTo(1, 2, 15);
  const saving = page.box.save();
  page.box.moveTo(3, 4, 15); // only the point sent in the request may become active
  await page.box.queryActive();
  await page.box.restoreReal();
  assert.equal(page.requests.length, requestsBeforeSave + 1);
  assertDisplay(page, 'querying', '查询中');
  finishSave(); await saving;
  assertDisplay(page, 'ok', '已启用定位', true);
  assert.equal(page.read('activeLat'), 1);
  assert.equal(page.read('activeLon'), 2);
  assert.equal(page.read('savedLat'), 1);
  assert.equal(page.read('savedLon'), 2);
  assert.equal(page.read('lat'), 3); // the unsaved preview may differ
  page.intercept(null);
  page.box.moveTo(1, 2, 15);
  await page.box.restoreReal();

  // Network/HTTP/JSON/API errors are unknown states, never 'no saved coordinates'.
  for (const fail of [
    () => { throw new Error('Offline'); },
    () => new Response(JSON.stringify(staleState), {status:503}),
    () => new Response('<html>Not intercepted</html>'),
    () => new Response(JSON.stringify({success:false,error:'Storage unavailable'})),
    () => new Response('null'),
    ...[
      {latitude:null}, {longitude:''}, {latitude:' '}, {latitude:false},
      {latitude:'1abc'}, {latitude:91}, {longitude:181}, {latitude:'Infinity'},
      {enabled:'false'}, {enabled:undefined}, {latitude:undefined}
    ].map(overrides => () => new Response(JSON.stringify({...staleState,...overrides})))
  ]) {
    page.intercept(fail);
    await page.box.queryActive();
    assertDisplay(page, 'failed', '查询失败');
    assert.equal(page.read('activeLon'), null);
  }
  page.intercept(() => new Response(JSON.stringify({success:false,error:'No saved coordinates'})));
  await page.box.queryActive();
  assertDisplay(page, 'none', '无已保存的坐标'); // legacy empty response
  page.intercept(null);
  await page.box.queryActive();
  assertDisplay(page, 'disabled', '已保存但停用');

  // An old query format still supports numeric strings and the explicit enabled flag.
  page.intercept(() => new Response(JSON.stringify({success:true,enabled:true,latitude:'0',longitude:'0'})));
  await page.box.queryActive();
  assertDisplay(page, 'ok', '已启用定位');
  assert.equal(page.read('activeLat'), 0);
  assert.equal(page.read('activeLon'), 0);
  page.intercept(null);

  // Cached older mutation scripts omit enabled; the page must query their state.
  page.intercept(u => {
    const result = device.run(u.search.slice(1));
    return new Response(JSON.stringify(u.searchParams.get('action') === 'query' ? result : {success:result.success}));
  });
  await page.box.save();
  assertDisplay(page, 'ok', '已启用定位', true);
  await page.box.clearActive();
  assertDisplay(page, 'disabled', '已保存但停用');
  page.intercept(null);

  // Read/write failures may not be acknowledged as a successful query or mutation.
  device.faults.read = 'latitude';
  assert.equal(device.run('action=query').code, 'STORAGE_ERROR');
  await page.box.queryActive();
  assertDisplay(page, 'failed', '查询失败');
  device.faults.read = null;
  await page.box.save();
  for (const throws of [false, true]) {
    device.faults.write = 'enabled'; device.faults.throwWrite = throws;
    assert.equal(device.run('action=clear').success, false);
    await page.box.clearActive();
    assertDisplay(page, 'failed', '查询失败');
    assert.equal(device.store.get('enabled'), 'true');
    assert.ok(page.element('toast').textContent.includes('清除失败'));
    device.faults.write = null;
    await page.box.queryActive();
    assertDisplay(page, 'ok', '已启用定位', true);
  }
  device.faults.write = 'longitude';
  await page.box.save();
  assertDisplay(page, 'failed', '查询失败');
  assert.equal(device.store.get('enabled'), 'false');
  assert.ok(page.element('toast').textContent.includes('储存失败'));
  device.faults.write = null;
  await page.box.queryActive();
  assertDisplay(page, 'disabled', '已保存但停用');

  for (const invalid of ['lat=91&lon=0', 'lat=0&lon=181', 'lat=&lon=0', 'lat=1abc&lon=2']) {
    assert.equal(device.run(invalid).success, false);
    assert.equal(device.store.get('enabled'), 'false');
  }
  device.store.set('latitude', 'invalid');
  assert.equal(device.run('action=query').code, 'INVALID_COORDINATES');
  await page.box.queryActive();
  assertDisplay(page, 'failed', '查询失败');
  console.log('PASS: picker/device state lifecycle, zero coordinates, failures, legacy responses and stale queries — ' + client);
}
const invalid=await worker.fetch(new Request(origin+'/api/parse?u='+encodeURIComponent('https://127.0.0.1/private')));assert.equal(invalid.status,400);
assert.equal((await worker.fetch(new Request(origin+'/missing'))).status,404);
assert.equal((await worker.fetch(new Request(origin+'/health',{method:'POST'}))).status,405);
console.log('PASS: routes, six-client module links, page syntax, coordinate parsing and restricted link fetching.');
