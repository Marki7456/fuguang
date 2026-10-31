import assert from 'node:assert/strict';
import vm from 'node:vm';

// Execute the real settings script with either client storage/response API.
export function createDevice(settings, client) {
  const store = new Map();
  const faults = { read: null, write: null, throwWrite: false };
  const qx = client === 'Quantumult X';
  function read(k) {
    if (faults.read === k) throw new Error('Storage unavailable');
    return store.get(k);
  }
  function write(v, k) {
    if (faults.write === k) {
      if (faults.throwWrite) throw new Error('Storage unavailable');
      return false;
    }
    store.set(k, v);
    return true;
  }
  function run(query) {
    let response;
    const box = {
      $request: { url: 'https://gs-loc.apple.com/ils-settings/save?' + query },
      $done: r => { response = qx ? r : r.response; }
    };
    if (qx) Object.assign(box, { $task: {}, $prefs: { valueForKey: read, setValueForKey: write } });
    else box.$persistentStore = { read, write: (v, k) => write(v, k) };
    vm.runInNewContext(settings, box, { filename: 'location-settings.js' });
    assert.equal(response.status, qx ? 'HTTP/1.1 200 OK' : 200, client);
    assert.equal(response.headers['Access-Control-Allow-Origin'], '*', client);
    return JSON.parse(response.body);
  }
  return { store, faults, run };
}

// Small DOM/Leaflet substitutes test state and rendered strings, not browser layout.
// Every inline script runs, including the automatic query on page initialization.
export function createPicker(html, device, storage = new Map()) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', innerHTML: '', value: '', style: {}, disabled: false,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}
    });
    return elements.get(id);
  }
  for (const m of html.matchAll(/<input\b[^>]*id="([^"]+)"[^>]*>/g)) {
    element(m[1]).value = (m[0].match(/\bvalue="([^"]*)"/) || [,''])[1];
  }
  const views = [];
  const map = { setView(point, zoom) { views.push({ point, zoom }); return this; }, on() {}, removeLayer() {} };
  const marker = { on() {}, addTo() {}, setLatLng() {} };
  let intercept = null;
  const requests = [];
  const timers = new Map();
  let nextTimer = 1;
  const box = vm.createContext({
    document: {
      documentElement: {}, body: {}, getElementById: element,
      querySelectorAll: () => [], addEventListener() {}
    },
    window: { innerWidth: 390, innerHeight: 844, addEventListener() {} },
    navigator: {}, confirm: () => true,
    location: { origin: 'https://test.example' }, AbortController,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    L: { map: () => map, tileLayer: () => ({ addTo() {} }), marker: () => marker },
    // Timers are explicit so request deadlines can be exercised instantly.
    // Other UI timers (elevation, toast) do not schedule live network activity.
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
    fetch: async (url, options) => {
      const u = new URL(url);
      assert.equal(u.origin + u.pathname, 'https://gs-loc.apple.com/ils-settings/save');
      assert.equal(options.cache, 'no-store');
      requests.push(u.searchParams);
      if (intercept) return intercept(u);
      return new Response(JSON.stringify(device.run(u.search.slice(1))));
    }
  });
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (m[1].trim()) vm.runInContext(m[1], box, { filename: 'picker.html' });
  }
  return {
    box, element, storage, views, requests,
    expireRequests() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === 8000) { timers.delete(id); timer.callback(); }
      }
    },
    pendingDeadlines: () => [...timers.values()].filter(timer => timer.delay === 8000).length,
    read: expression => vm.runInContext(expression, box),
    intercept: handler => { intercept = handler; },
    ready: () => new Promise(resolve => setImmediate(resolve))
  };
}
