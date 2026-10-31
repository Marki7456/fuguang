import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../public/picker.html', import.meta.url), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).filter(script => script.trim());
const version = '20261101.1';
const buttons = ['saveBtn', 'restoreBtn', 'clearDeviceBtn', 'refreshBtn'];
const valid = (extra = {}) => ({
  success: true, hasCoordinates: true, enabled: true, settingsVersion: version, latitude: 22, longitude: 114,
  horizontalAccuracy: 39, randomRadius: 0, ...extra
});
const response = (body) => ({ ok: true, json: async () => body });
const never = () => new Promise(() => {});
async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

function element(id, attributes = {}) {
  const classes = new Set();
  return {
    id, attributes, value: attributes.value || '', textContent: '', innerHTML: '', disabled: false,
    style: {}, dataset: {}, className: attributes.class || '',
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
    },
    getAttribute: name => attributes[name] ?? null,
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    addEventListener() {}, appendChild() {}, removeChild() {}, focus() {}, select() {}
  };
}

async function picker() {
  const elements = new Map();
  for (const tag of html.matchAll(/<[a-z][\w-]*\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attrs = Object.fromEntries([...tag[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    elements.set(tag[2], element(tag[2], attrs));
  }
  const timers = new Map();
  let timerId = 0;
  const calls = [];
  let fetchImpl = async () => response({ success: true, hasCoordinates: false, enabled: false, settingsVersion: version });
  const mapViews = [];
  const mapEvents = new Map(), markerEvents = new Map(), markerPositions = [], clipboard = [], geoRequests = [];
  const map = {
    setView(coords, zoom) { mapViews.push({ coords: [...coords], zoom }); return this; },
    removeLayer() {}, on(event, handler) { mapEvents.set(event, handler); return this; }
  };
  const marker = {
    position: [0, 0],
    addTo() { return this; },
    setLatLng(coords) { this.position = [...coords]; markerPositions.push([...coords]); return this; },
    getLatLng() { return { lat: this.position[0], lng: this.position[1] }; },
    on(event, handler) { markerEvents.set(event, handler); return this; }
  };
  const storage = new Map();
  const context = vm.createContext({
    document: {
      getElementById: id => elements.get(id) || null,
      querySelectorAll(selector) {
        const match = selector.match(/^\[([^\]]+)\]$/);
        return match ? [...elements.values()].filter(el => el.attributes[match[1]] != null) : [];
      },
      createElement: tag => element(tag), documentElement: {}, body: element('body'), addEventListener() {}
    },
    window: { innerWidth: 390, innerHeight: 844, addEventListener() {} },
    location: { origin: 'https://picker.test' },
    navigator: {
      clipboard: { async writeText(text) { clipboard.push(text); } },
      geolocation: { getCurrentPosition(success, failure, options) { geoRequests.push({ success, failure, options }); } }
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    L: { map: () => map, tileLayer: () => ({ addTo() { return this; } }), marker: () => marker },
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', position: 'fixed', opacity: '1' }),
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0,
    AbortController, URL, URLSearchParams, console, confirm: () => true,
    fetch(url, options) {
      const call = { url: String(url), options, query: new URL(url, 'https://picker.test').searchParams };
      calls.push(call);
      return fetchImpl(call);
    }
  });
  for (const source of inlineScripts) vm.runInContext(source, context, { timeout: 1000 });
  vm.runInContext(`globalThis.api = {
    deviceRequest, queryActive, save, clearActive, restoreReal, setPos, setMapPos, moveTo, t,
    copyField, copyParams, moduleParamString, confirmFav, loadFav,
    parseLocalCoords, parseUrl, searchPlace, selectSearchResult, locateMe,
    setSelectedForTest: (la, lo) => { lat = la; lon = lo; selected = true; },
    state: () => ({ lat, lon, selected, activeLon, activeLat, activeStatus, savedLon, savedLat, deviceBusy }),
    timeout: DEVICE_TIMEOUT_MS
  }`, context);
  await flush();
  assert.equal(context.api.state().deviceBusy, false, 'initial device query must finish');
  assert.equal(context.api.timeout, 8000, 'production deadline must stay eight seconds');
  calls.length = 0;
  return {
    api: context.api, elements, calls, timers, mapViews, storage, markerPositions, clipboard, geoRequests,
    fetchWith(handler) { fetchImpl = handler; },
    select(lat = 22, lon = 114) { context.api.setPos(lat, lon, 0); },
    clickMap(lat, lng) { return mapEvents.get('click')({ latlng: { lat, lng } }); },
    dragMarker(lat, lng) { marker.setLatLng([lat, lng]); return markerEvents.get('dragend')({ target: marker }); },
    async fireTimers(ms) {
      const pending = [...timers].filter(([, timer]) => timer.ms === ms);
      for (const [id, timer] of pending) { timers.delete(id); timer.fn(); }
      await flush();
    },
    async deadline() {
      await flush();
      const pending = [...timers].filter(([, timer]) => timer.ms === 8000);
      assert.equal(pending.length, 1, 'each active device request has one deadline');
      const [id, timer] = pending[0];
      timers.delete(id);
      timer.fn();
      await flush();
    },
    assertReleased() {
      assert.equal(context.api.state().deviceBusy, false);
      for (const id of buttons) assert.equal(elements.get(id).disabled, false, `${id} is released`);
      assert.ok(![...timers.values()].some(timer => timer.ms === 8000), 'completed requests clear their deadline');
    },
    assertBusy() {
      assert.equal(context.api.state().deviceBusy, true);
      for (const id of buttons) assert.equal(elements.get(id).disabled, true, `${id} is blocked during device requests`);
    }
  };
}

test('deviceRequest bounds both a stalled fetch and a stalled JSON body with an eight-second deadline', async () => {
  for (const stage of ['fetch', 'json']) {
    const p = await picker();
    p.fetchWith(() => stage === 'fetch' ? never() : Promise.resolve({ ok: true, json: never }));
    const request = p.api.deviceRequest('action=query');
    const rejected = assert.rejects(request, /8/);
    await p.deadline();
    await rejected;
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].options.signal.aborted, true, `${stage} timeout aborts the transport`);
    assert.equal(p.calls[0].options.cache, 'no-store');
    p.assertReleased();
  }
});

test('deviceRequest rejects unsuccessful HTTP status, invalid JSON data and decoding errors', async () => {
  for (const r of [
    { ok: false, json: async () => valid() }, response(null), response('wrong payload'),
    { ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } }
  ]) {
    const p = await picker();
    p.fetchWith(async () => r);
    await assert.rejects(p.api.deviceRequest('action=query'));
    p.assertReleased();
  }
});

test('old settings script blocks saving while the recovery command remains available', async () => {
  const p = await picker();
  p.select();
  let cleared = false;
  p.fetchWith(async call => {
    if (call.query.get('action') === 'clear') { cleared = true; return response({ success: true }); }
    return response(valid({ settingsVersion: 'old', enabled: !cleared }));
  });
  await p.api.save();
  assert.deepEqual(p.calls.map(call => call.query.get('action')), ['query']);
  assert.equal(p.api.state().savedLon, null);
  assert.equal(p.elements.get('errorBanner').style.display, 'block');
  assert.match(p.elements.get('errorBanner').textContent, /更新/);
  p.assertReleased();
  await p.api.clearActive();
  assert.deepEqual(p.calls.map(call => call.query.get('action')), ['query', 'clear', 'query']);
  assert.equal(p.api.state().activeStatus, 'disabled');
  assert.ok(p.elements.get('activeValue').textContent.startsWith(p.api.t('disabled')));
  p.assertReleased();
});

test('enabled=false never appears as an active saved location or an active favorite', async () => {
  const p = await picker();
  p.storage.set('ils_favorites', JSON.stringify([{ name: 'Stored place', lat: 22, lon: 114 }]));
  p.fetchWith(async () => response(valid({ enabled: false })));
  await p.api.queryActive();
  assert.equal(p.api.state().activeStatus, 'disabled');
  assert.equal(p.api.state().activeLon, 114, 'disabled settings retain the saved coordinates');
  assert.equal(p.api.state().activeLat, 22);
  assert.ok(p.elements.get('activeValue').textContent.startsWith(p.api.t('disabled')));
  assert.ok(!p.elements.get('favList').innerHTML.includes('fav-active'));
  p.assertReleased();
});

test('a valid query accepts zero latitude and longitude and centers the map there', async () => {
  const p = await picker();
  p.fetchWith(async () => response(valid({ latitude: 0, longitude: 0 })));
  await p.api.queryActive();
  assert.equal(p.api.state().activeStatus, 'ok');
  assert.equal(p.api.state().activeLon, 0);
  assert.equal(p.api.state().activeLat, 0);
  assert.equal(p.api.state().selected, true);
  assert.deepEqual(p.mapViews.at(-1).coords, [0, 0]);
  assert.match(p.elements.get('activeValue').textContent, /0\.000000/);
  p.assertReleased();
});

test('querying an old script does not label its stored coordinates as active', async () => {
  const p = await picker();
  p.fetchWith(async () => response(valid({ settingsVersion: 'old' })));
  await p.api.queryActive();
  assert.equal(p.api.state().activeStatus, 'unverified');
  assert.equal(p.api.state().activeLon, null);
  assert.equal(p.elements.get('activeValue').textContent, p.api.t('unverified'));
  p.assertReleased();
});

test('query distinguishes empty settings from errors and rejects malformed coordinate types', async () => {
  const cases = [
    [{ success: true, hasCoordinates: false, enabled: false, settingsVersion: version }, 'none'],
    [{ success: false, error: 'No saved coordinates' }, 'none'],
    [{ success: false, code: 'STORAGE_ERROR', error: 'Read failed', settingsVersion: version }, 'failed'],
    [{ success: false, code: 'STORAGE_ERROR', error: 'Read failed' }, 'failed'],
    [{ success: false, code: 'INVALID_COORDINATES', enabled: false, settingsVersion: version }, 'failed'],
    [valid({ longitude: true }), 'failed'], [valid({ latitude: false }), 'failed'],
    [valid({ longitude: '0x72' }), 'failed'], [valid({ latitude: '22tail' }), 'failed'],
    [valid({ enabled: 'false' }), 'failed']
  ];
  for (const [result, status] of cases) {
    const p = await picker();
    p.fetchWith(async () => response(result));
    await p.api.queryActive();
    assert.equal(p.api.state().activeStatus, status, JSON.stringify(result));
    assert.equal(p.api.state().activeLon, null);
    p.assertReleased();
  }
});

test('clear distinguishes retained disabled coordinates, confirmed empty state, and a disabled state without coordinates', async () => {
  for (const [result, status, text] of [
    [valid({ enabled: false }), 'disabled', 'disabled'],
    [{ success: true, enabled: false, hasCoordinates: false, settingsVersion: version }, 'none', 'no_saved'],
    [{ success: true, enabled: false, settingsVersion: version }, 'disabled', 'disabled_empty']
  ]) {
    const p = await picker();
    p.fetchWith(async () => response(result));
    await p.api.clearActive();
    assert.equal(p.api.state().activeStatus, status);
    assert.ok(p.elements.get('activeValue').textContent.startsWith(p.api.t(text)));
    assert.equal(p.elements.get('errorBanner').style.display, 'none');
    p.assertReleased();
  }
});

test('confirmed recovery remains successful when saved-coordinate inspection reports a separate error', async () => {
  for (const [code, hasCoordinates] of [['STORAGE_ERROR', null], ['INVALID_COORDINATES', false]]) {
    const p = await picker();
    p.fetchWith(async () => response({
      success: true, enabled: false, disabledConfirmed: true, hasCoordinates,
      settingsVersion: version, stateError: { code, error: 'Cannot inspect old coordinates' }
    }));
    await p.api.clearActive();
    assert.equal(p.api.state().activeStatus, 'disabled');
    assert.equal(p.elements.get('activeValue').textContent, p.api.t('disabled_empty'));
    assert.equal(p.elements.get('toast').textContent, p.api.t('restored'));
    assert.equal(p.elements.get('errorBanner').style.display, 'block');
    assert.match(p.elements.get('errorBanner').textContent, /已确认停用/);
    assert.notEqual(p.elements.get('errorBanner').textContent, p.api.t('clear_failed_cfg'));
    p.assertReleased();
  }
});

test('zero-coordinate saves and the maximum permitted radius complete successfully', async () => {
  const p = await picker();
  p.select(0, 0);
  p.elements.get('haccInput').value = '0.1';
  p.elements.get('jitterInput').value = '10000';
  p.fetchWith(async () => response(valid({ latitude: 0, longitude: 0, horizontalAccuracy: 0.1, randomRadius: 10000 })));
  await p.api.save();
  assert.equal(p.calls[1].query.get('lat'), '0');
  assert.equal(p.calls[1].query.get('lon'), '0');
  assert.equal(p.calls[1].query.get('hacc'), '0.1');
  assert.equal(p.calls[1].query.get('randomRadius'), '10000');
  assert.equal(p.api.state().activeStatus, 'ok');
  assert.equal(p.api.state().savedLat, 0);
  assert.equal(p.api.state().savedLon, 0);
  assert.equal(p.elements.get('errorBanner').style.display, 'none');
  p.assertReleased();
});

test('pending device work blocks overlapping save, query and recovery requests', async () => {
  const p = await picker();
  p.select();
  let finish;
  p.fetchWith(() => new Promise(resolve => { finish = resolve; }));
  const pending = p.api.queryActive();
  p.assertBusy();
  await p.api.save();
  await p.api.queryActive();
  await p.api.clearActive();
  await p.api.restoreReal();
  assert.equal(p.calls.length, 1);
  finish(response(valid({ enabled: false })));
  await pending;
  p.assertReleased();
});

test('saving keeps the original request snapshot even if the user selects another point while waiting', async () => {
  const p = await picker();
  p.select(22, 114);
  let finishSave;
  p.fetchWith(async call => {
    if (call.query.get('action') === 'query') return response(valid());
    return new Promise(resolve => { finishSave = resolve; });
  });
  const operation = p.api.save();
  await flush();
  p.assertBusy();
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].query.get('lat'), '22');
  assert.equal(p.calls[1].query.get('lon'), '114');
  p.select(35, 139);
  p.elements.get('haccInput').value = '99';
  finishSave(response(valid()));
  await operation;
  assert.equal(p.api.state().lat, 35);
  assert.equal(p.api.state().lon, 139);
  assert.equal(p.api.state().savedLat, 22);
  assert.equal(p.api.state().savedLon, 114);
  assert.equal(p.api.state().activeLat, 22);
  assert.equal(p.api.state().activeLon, 114);
  assert.match(p.elements.get('status').textContent, /114\.000000, 22\.000000/);
  assert.match(p.elements.get('activeValue').textContent, /39m/);
  p.assertReleased();
});

test('a save response arriving after timeout cannot replace the error with an unconfirmed success', async () => {
  const p = await picker();
  p.select();
  let finish;
  p.fetchWith(async call => {
    if (call.query.get('action') === 'query') return response(valid());
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = p.api.save();
  await flush();
  await p.deadline();
  await pending;
  assert.equal(p.api.state().activeStatus, 'failed');
  p.assertReleased();
  finish(response(valid()));
  await flush();
  assert.equal(p.api.state().activeStatus, 'failed');
  assert.equal(p.api.state().savedLon, null);
  assert.equal(p.elements.get('errorBanner').style.display, 'block');
  p.assertReleased();
});

test('success=true with different, absent, out-of-range or disabled coordinates is never shown as a successful save', async () => {
  for (const mismatch of [
    { longitude: 115 }, { latitude: 23 }, { longitude: null }, { latitude: '' },
    { latitude: 91 }, { longitude: 181 }, { enabled: false }, { success: false }, { settingsVersion: 'old' }
  ]) {
    const p = await picker();
    p.select();
    p.fetchWith(async call => response(call.query.get('action') === 'query' ? valid() : valid(mismatch)));
    await p.api.save();
    assert.equal(p.api.state().savedLon, null, JSON.stringify(mismatch));
    assert.equal(p.api.state().activeStatus, 'failed');
    assert.equal(p.elements.get('errorBanner').style.display, 'block');
    assert.equal(p.elements.get('saveBtn').textContent, p.api.t('save'));
    p.assertReleased();
  }
});

test('invalid jitter radius or horizontal accuracy is rejected before any device request', async () => {
  for (const [input, values] of [
    ['jitterInput', ['-1', '10000.1', 'NaN', 'Infinity', '12junk']],
    ['haccInput', ['0', '-1', '', 'NaN', '12junk', '9007199254740992']]
  ]) {
    for (const value of values) {
      const p = await picker();
      p.select();
      p.elements.get(input).value = value;
      await p.api.save();
      assert.equal(p.calls.length, 0, `${input}=${value}`);
      assert.equal(p.elements.get('toast').textContent, p.api.t('invalid_settings'));
      assert.equal(p.api.state().savedLon, null);
      p.assertReleased();
    }
  }
});

for (const operation of ['query', 'save-preflight', 'save-write', 'clear', 'legacy-clear-confirmation']) {
  for (const fault of ['network-error', 'json-error', 'fetch-timeout', 'json-timeout']) {
    test(`${operation}: ${fault} releases all controls and never reports success`, async () => {
      const p = await picker();
      p.select();
      p.fetchWith(async call => {
        if (operation === 'save-write' && call.query.get('action') === 'query') return response(valid());
        if (operation === 'legacy-clear-confirmation' && call.query.get('action') === 'clear') return response({ success: true });
        if (fault === 'network-error') throw new Error('Device disconnected');
        if (fault === 'json-error') return { ok: true, json: async () => { throw new Error('Invalid JSON'); } };
        if (fault === 'fetch-timeout') return never();
        return { ok: true, json: never };
      });
      const pending = operation === 'query' ? p.api.queryActive()
        : operation === 'clear' || operation === 'legacy-clear-confirmation' ? p.api.clearActive() : p.api.save();
      if (fault.endsWith('timeout')) {
        await flush();
        p.assertBusy();
        await p.deadline();
      }
      await pending;
      assert.equal(p.api.state().savedLon, null);
      assert.equal(p.api.state().activeStatus, 'failed');
      if (operation !== 'query') assert.equal(p.elements.get('errorBanner').style.display, 'block');
      if (operation.startsWith('save')) assert.equal(p.elements.get('saveBtn').textContent, p.api.t('save'));
      if (fault.endsWith('timeout')) assert.equal(p.calls.at(-1).options.signal.aborted, true);
      p.assertReleased();
    });
  }
}

test('clear refuses failure or an explicitly still-enabled result, and restore uses the same recovery path', async () => {
  for (const result of [valid({ success: false }), valid({ success: true, enabled: true })]) {
    const p = await picker();
    p.fetchWith(async () => response(result));
    await p.api.restoreReal();
    assert.equal(p.calls[0].query.get('action'), 'clear');
    assert.equal(p.api.state().activeStatus, 'failed');
    assert.equal(p.elements.get('errorBanner').style.display, 'block');
    p.assertReleased();
  }
});

test('legacy clear cannot claim recovery when its verification query still reports enabled', async () => {
  const p = await picker();
  p.fetchWith(async call => response(call.query.get('action') === 'clear' ? { success: true } : valid({ settingsVersion: 'old' })));
  await p.api.clearActive();
  assert.deepEqual(p.calls.map(call => call.query.get('action')), ['clear', 'query']);
  assert.equal(p.api.state().activeStatus, 'failed');
  assert.equal(p.elements.get('errorBanner').textContent, p.api.t('clear_failed_cfg'));
  p.assertReleased();
});

test('Leaflet click and drag normalize repeated-world longitude while keeping the marker in the displayed world', async () => {
  for (const gesture of ['clickMap', 'dragMarker']) {
    for (const [rawLongitude, expectedLongitude] of [
      [-588.5, 131.5], [491.5, 131.5], [851.5, 131.5], [-948.5, 131.5],
      [0, 0], [720, 0], [-720, 0], [180, null], [-180, null], [540, null], [-540, null]
    ]) {
      const p = await picker();
      p[gesture](23.25, rawLongitude);
      assert.equal(p.api.state().lat, 23.25);
      if (expectedLongitude === null) assert.equal(Math.abs(p.api.state().lon), 180);
      else assert.ok(p.api.state().lon === expectedLongitude, `${gesture} at ${rawLongitude}`);
      assert.equal(p.api.state().selected, true);
      assert.deepEqual(p.markerPositions.at(-1), [23.25, rawLongitude], 'marker stays under the actual click/drag');
      assert.equal(p.mapViews.length, 1, 'a gesture does not recenter onto another world copy');
      assert.equal(p.elements.get('cvLon').textContent, p.api.state().lon.toFixed(6));
    }
  }
});

test('canonical map coordinates are used for saving, copying, favorites and elevation queries', async () => {
  const p = await picker();
  p.fetchWith(async call => {
    if (call.url.startsWith('https://api.open-meteo.com/')) return response({ elevation: [12] });
    return response(valid({ latitude: 23.25, longitude: 131.5 }));
  });
  p.clickMap(23.25, -588.5);
  p.api.copyField('lon');
  p.api.copyParams();
  await flush();
  assert.equal(p.clipboard[0], '131.500000');
  const copied = new URLSearchParams(p.clipboard[1]);
  assert.equal(copied.get('latitude'), '23.250000');
  assert.equal(copied.get('longitude'), '131.500000');
  assert.equal(p.api.moduleParamString(), p.clipboard[1]);
  p.elements.get('favNameInput').value = 'Synthetic repeated-world point';
  p.api.confirmFav();
  const favorite = JSON.parse(p.storage.get('ils_favorites'))[0];
  assert.equal(favorite.lat, 23.25);
  assert.equal(favorite.lon, 131.5);
  await p.fireTimers(500);
  const elevation = p.calls.find(call => call.url.startsWith('https://api.open-meteo.com/'));
  assert.ok(elevation);
  assert.equal(elevation.query.get('latitude'), '23.25');
  assert.equal(elevation.query.get('longitude'), '131.5');
  await p.api.save();
  const saved = p.calls.find(call => call.query.get('action') === 'save');
  assert.ok(saved);
  assert.equal(saved.query.get('lat'), '23.25');
  assert.equal(saved.query.get('lon'), '131.5');
  assert.equal(p.api.state().savedLon, 131.5);
  assert.deepEqual(p.markerPositions.at(-1), [23.25, -588.5]);
  p.assertReleased();
});

test('direct coordinate entry refuses invalid coordinates without replacing the previous selection or moving the map', async () => {
  const p = await picker();
  p.select(23.25, 131.5);
  for (const [latitude, longitude] of [
    [91, 20], [-91, 20], [23.25, 181], [23.25, -181], [23.25, -588.5],
    [NaN, 20], [20, Infinity], [null, 20], [true, 20], ['', 20], ['23.25x', 131.5]
  ]) {
    const markerCount = p.markerPositions.length, viewCount = p.mapViews.length;
    assert.equal(p.api.setPos(latitude, longitude), false);
    assert.equal(p.api.moveTo(latitude, longitude, 15), false);
    assert.equal(p.api.state().lat, 23.25);
    assert.equal(p.api.state().lon, 131.5);
    assert.equal(p.markerPositions.length, markerCount);
    assert.equal(p.mapViews.length, viewCount);
    assert.equal(p.elements.get('toast').textContent, p.api.t('invalid_coordinates'));
  }
  assert.equal(p.calls.length, 0);
  for (const [latitude, longitude] of [[0, 0], [90, 180], [-90, -180]]) {
    assert.equal(p.api.setPos(latitude, longitude, 0), true);
    assert.equal(p.api.state().lat, latitude);
    assert.equal(p.api.state().lon, longitude);
  }
});

test('invalid Leaflet latitude and nonfinite longitude never change a prior canonical selection', async () => {
  const p = await picker();
  p.select(23.25, 131.5);
  for (const [latitude, longitude] of [[91, -588.5], [NaN, -588.5], [23.25, Infinity], [23.25, NaN]]) {
    p.clickMap(latitude, longitude);
    assert.equal(p.api.state().lat, 23.25);
    assert.equal(p.api.state().lon, 131.5);
    assert.equal(p.elements.get('toast').textContent, p.api.t('invalid_coordinates'));
  }
});

test('save rejects invalid legacy selection state before even its version-check request', async () => {
  for (const [latitude, longitude] of [[23.25, -588.5], [91, 131.5], [NaN, 131.5], [23.25, Infinity]]) {
    const p = await picker();
    p.api.setSelectedForTest(latitude, longitude);
    await p.api.save();
    assert.equal(p.calls.length, 0);
    assert.equal(p.api.state().savedLon, null);
    assert.equal(p.elements.get('toast').textContent, p.api.t('invalid_coordinates'));
    p.assertReleased();
  }
});

test('invalid legacy selection cannot be copied or saved as a new favorite', async () => {
  const p = await picker();
  p.api.setSelectedForTest(23.25, -588.5);
  p.api.copyField('lon');
  p.api.copyParams();
  p.elements.get('favNameInput').value = 'Invalid synthetic selection';
  p.api.confirmFav();
  await flush();
  assert.deepEqual(p.clipboard, []);
  assert.equal(p.api.moduleParamString(), '');
  assert.equal(p.storage.has('ils_favorites'), false);
  assert.equal(p.elements.get('toast').textContent, p.api.t('invalid_coordinates'));
});

test('save failure messages distinguish invalid data, confirmed disabled storage failure and unconfirmed state', async () => {
  const cases = [
    [{ success: false, code: 'INVALID_COORDINATES', enabled: true }, 'invalid_coordinates'],
    [{ success: false, code: 'INVALID_SETTINGS', enabled: true }, 'invalid_settings'],
    [{ success: false, code: 'STORAGE_ERROR', enabled: false, disabledConfirmed: true }, 'save_storage_disabled'],
    [{ success: false, code: 'STORAGE_ERROR', enabled: true, disabledConfirmed: false }, 'save_storage_unknown'],
    [{ success: false, code: 'STORAGE_ERROR', enabled: null, disabledConfirmed: false }, 'save_storage_unknown'],
    [{ success: true, enabled: true, longitude: 132 }, 'save_unconfirmed'],
    [{ success: false }, 'save_failed']
  ];
  for (const [result, message] of cases) {
    const p = await picker();
    p.select(23.25, 131.5);
    p.fetchWith(async call => response(call.query.get('action') === 'query'
      ? valid() : valid({ latitude: 23.25, longitude: 131.5, ...result })));
    await p.api.save();
    assert.equal(p.api.state().activeStatus, 'failed');
    assert.equal(p.elements.get('errorBanner').textContent, p.api.t(message));
    assert.equal(p.elements.get('toast').textContent, p.api.t(message));
    assert.ok(!p.elements.get('errorBanner').textContent.includes(p.api.t('clear_failed_cfg')));
    p.assertReleased();
  }
});

test('out-of-range text, parsed links and old favorites are rejected instead of silently wrapped', async () => {
  const p = await picker();
  p.select(23.25, 131.5);
  for (const input of ['23.25,-588.5', '91.25,181.5', '999.0,999.0']) {
    assert.equal(p.api.parseLocalCoords(input), null);
  }
  p.elements.get('urlInput').value = 'https://maps.example.test/?point=synthetic-invalid';
  p.fetchWith(async () => response({ lat: 23.25, lon: -588.5 }));
  const before = p.mapViews.length;
  await p.api.parseUrl();
  assert.equal(p.api.state().lat, 23.25);
  assert.equal(p.api.state().lon, 131.5);
  assert.equal(p.mapViews.length, before);
  assert.notEqual(p.elements.get('toast').textContent, p.api.t('parsed', -588.5, 23.25));
  p.storage.set('ils_favorites', JSON.stringify([{ name: 'Invalid synthetic favorite', lat: 23.25, lon: -588.5 }]));
  p.api.loadFav(0);
  assert.equal(p.api.state().lat, 23.25);
  assert.equal(p.api.state().lon, 131.5);
  assert.equal(p.mapViews.length, before);
  assert.notEqual(p.elements.get('toast').textContent, 'Invalid synthetic favorite (-588.5000, 23.2500)');
  assert.match(p.elements.get('toast').textContent, /坐标|重选|重新/);
});

test('search and browser geolocation do not report success for out-of-range coordinates', async () => {
  const p = await picker();
  p.select(23.25, 131.5);
  const before = p.mapViews.length;
  p.elements.get('searchInput').value = 'Synthetic invalid search';
  p.fetchWith(async () => response([{ lat: '23.25', lon: '-588.5', display_name: 'Invalid synthetic result' }]));
  await p.api.searchPlace();
  p.api.selectSearchResult(0);
  assert.equal(p.api.state().lat, 23.25);
  assert.equal(p.api.state().lon, 131.5);
  assert.equal(p.mapViews.length, before);
  assert.notEqual(p.elements.get('toast').textContent, 'Invalid synthetic result');
  p.api.locateMe();
  assert.equal(p.geoRequests.length, 1);
  p.geoRequests[0].success({ coords: { latitude: 23.25, longitude: -588.5 } });
  assert.equal(p.api.state().lat, 23.25);
  assert.equal(p.api.state().lon, 131.5);
  assert.equal(p.mapViews.length, before);
  assert.notEqual(p.elements.get('toast').textContent, p.api.t('got_loc'));
  assert.equal(p.elements.get('toast').textContent, p.api.t('invalid_coordinates'));
});
