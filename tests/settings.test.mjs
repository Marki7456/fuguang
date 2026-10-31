import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/location-settings.js', import.meta.url), 'utf8');
const saved = {
  latitude: '22.3193', longitude: '114.1694', altitude: '530',
  horizontalAccuracy: '39', verticalAccuracy: '1000', randomRadius: '0', enabled: 'true'
};

function client(qx, options = {}) {
  const store = new Map(Object.entries(options.initial || {}));
  const writes = [];
  const reads = [];
  function read(key) {
    reads.push(key);
    return options.read ? options.read(key, store) : store.get(key);
  }
  function write(value, key) {
    writes.push([key, value]);
    if (options.write) return options.write(key, value, store);
    store.set(key, value);
    return true;
  }
  function run(params, method = 'GET') {
    const query = typeof params === 'string' ? params : new URLSearchParams(params).toString();
    const completions = [];
    const box = {
      $request: { url: 'https://gs-loc.apple.com/ils-settings/save?' + query, method },
      $done: value => completions.push(value),
      console: new Proxy({}, { get: () => () => { throw new Error('Settings must not log private coordinates'); } })
    };
    if (qx) {
      box.$task = {};
      if (!options.unavailable) box.$prefs = { valueForKey: read, setValueForKey: write };
    } else if (!options.unavailable) {
      box.$persistentStore = { read, write };
    }
    vm.runInNewContext(source, box, { timeout: 1000 });
    assert.equal(completions.length, 1, 'request must complete exactly once');
    const response = qx ? completions[0] : completions[0].response;
    assert.equal(response.status, qx ? 'HTTP/1.1 200 OK' : 200);
    assert.equal(response.headers['Content-Type'], 'application/json');
    assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    const result = JSON.parse(response.body);
    assert.equal(result.settingsVersion, '20261101.2', 'every response identifies the running settings script');
    return result;
  }
  return { store, writes, reads, run };
}

for (const qx of [false, true]) {
  test(`diagnostics (${qx ? 'prefs' : 'persistentStore'}): return only bounded local metadata and tolerate bad records`, () => {
    const timestamp = Date.now();
    const raw = {
      version: '20261101.2', timestamp, state: 'rewritten', wifiCount: 2, cellCount: 3, bodyLength: 100,
      kind: 'bare', latitude: 12, longitude: 34, headers: { authorization: 'private' }, body: 'private'
    };
    const c = client(qx, { initial: { ...saved, ils_core_diagnostic_v1: JSON.stringify(raw) } });
    assert.deepEqual(c.run('action=query').diagnostics, {
      version: raw.version, timestamp, state: 'rewritten', wifiCount: 2, cellCount: 3, bodyLength: 100, kind: 'bare'
    });
    assert.equal(c.writes.length, 0, 'reading diagnostics does not change location settings');
    for (const record of ['not-json', 'x'.repeat(2049), JSON.stringify({ ...raw, state: 'private' }), JSON.stringify({ ...raw, timestamp: 1e30 })]) {
      c.store.set('ils_core_diagnostic_v1', record);
      const result = c.run('action=query');
      assert.equal(result.success, true);
      assert.equal(result.diagnostics, null);
    }
    const denied = client(qx, { initial: saved, read: (key, store) => {
      if (key === 'ils_core_diagnostic_v1') throw new Error('Diagnostic storage denied');
      return store.get(key);
    } });
    assert.equal(denied.run('action=query').success, true);
    assert.equal(denied.run('action=query').diagnostics, null);
  });
}

for (const qx of [false, true]) {
  const api = qx ? 'Quantumult X' : 'persistentStore';
  test(`${api}: complete save, query and clear preserve zero values and disable before writing`, () => {
    const c = client(qx, { initial: saved });
    const result = c.run({ lat: '0', lon: '0', alt: '0', hacc: '0.1', vacc: '0.25', rr: '0' });
    assert.equal(result.success, true);
    assert.equal(result.hasCoordinates, true);
    assert.equal(result.enabled, true);
    assert.equal(result.latitude, 0);
    assert.equal(result.longitude, 0);
    assert.equal(result.altitude, 0);
    assert.equal(result.horizontalAccuracy, 0.1);
    assert.equal(result.verticalAccuracy, 0.25);
    assert.equal(result.randomRadius, 0);
    assert.deepEqual(c.writes, [
      ['enabled', 'false'], ['latitude', '0'], ['longitude', '0'], ['altitude', '0'],
      ['horizontalAccuracy', '0.1'], ['verticalAccuracy', '0.25'], ['randomRadius', '0'], ['enabled', 'true']
    ]);
    assert.deepEqual(c.run('action=query'), result);
    const cleared = c.run('action=clear');
    assert.equal(cleared.success, true);
    assert.equal(cleared.enabled, false);
    assert.equal(cleared.hasCoordinates, true);
    assert.equal(cleared.latitude, 0);
    assert.equal(cleared.longitude, 0);
    assert.equal(c.store.get('enabled'), 'false');
    const inactive = c.run('action=query');
    assert.equal(inactive.success, true);
    assert.equal(inactive.enabled, false);
    assert.equal(inactive.latitude, 0);
  });

  test(`${api}: aliases, defaults and exact geographic/radius boundaries are valid`, () => {
    const c = client(qx);
    const first = c.run('action=save&latitude=-90&longitude=180');
    assert.equal(first.success, true);
    assert.equal(first.altitude, 530);
    assert.equal(first.horizontalAccuracy, 39);
    assert.equal(first.verticalAccuracy, 1000);
    assert.equal(first.randomRadius, 0);
    assert.equal(c.run('action=query').success, true);
    const second = c.run('latitude=90&longitude=-180&altitude=-20&horizontalAccuracy=1e1&verticalAccuracy=25.5&randomRadius=10000');
    assert.equal(second.success, true);
    assert.equal(second.altitude, -20);
    assert.equal(second.horizontalAccuracy, 10);
    assert.equal(second.verticalAccuracy, 25.5);
    assert.equal(second.randomRadius, 10000);
  });

  test(`${api}: malformed numbers, missing coordinates and invalid ranges cause no writes`, () => {
    const invalid = [
      { lat: 'NaN' }, { lon: 'Infinity' }, { lat: '12junk' }, { lon: '0x10' },
      { lat: '' }, { lon: ' ' }, { lat: '91' }, { lat: '-90.0001' },
      { lon: '180.0001' }, { lon: '-181' }, { hacc: '-1' }, { hacc: '0' },
      { vacc: '-0.01' }, { vacc: '0' }, { rr: '-1' }, { rr: '10000.01' },
      { alt: '123metres' }, { alt: 'NaN' }, { hacc: '' }, { vacc: '1.2.3' },
      { rr: '2x' }, { rr: '1e309' }, { hacc: '9007199254740992' }, { vacc: '1e100' }
    ];
    for (const params of invalid) {
      const c = client(qx, { initial: saved });
      assert.equal(c.run({ lat: '20', lon: '100', ...params }).success, false, JSON.stringify(params));
      assert.deepEqual(c.writes, [], 'reject invalid input before changing an existing config');
      assert.equal(c.store.get('enabled'), 'true');
    }
    for (const query of ['lat=20', 'lon=100', '']) {
      const c = client(qx);
      assert.equal(c.run(query).success, false);
      assert.deepEqual(c.writes, []);
    }
  });

  test(`${api}: a partial write failure leaves the configuration disabled`, () => {
    const c = client(qx, {
      initial: saved,
      write(key, value, store) {
        if (key === 'longitude') return false;
        store.set(key, value);
        return true;
      }
    });
    const result = c.run('lat=0&lon=0');
    assert.equal(result.success, false);
    assert.equal(result.enabled, false);
    assert.equal(result.disabledConfirmed, true);
    assert.equal(c.store.get('enabled'), 'false');
    assert.equal(c.store.get('latitude'), '0');
    assert.equal(c.store.get('longitude'), saved.longitude);
    assert.ok(!c.writes.some(([key, value]) => key === 'enabled' && value === 'true'));
  });

  test(`${api}: a write claiming success without persisting its value is rejected`, () => {
    const c = client(qx, {
      initial: saved,
      write(key, value, store) {
        if (key !== 'longitude') store.set(key, value);
        return true;
      }
    });
    const result = c.run('lat=0&lon=0');
    assert.equal(result.success, false);
    assert.equal(result.disabledConfirmed, true);
    assert.equal(c.store.get('enabled'), 'false');
  });

  test(`${api}: final enable failure, including a write that mutated storage then returned false, rolls back`, () => {
    for (const mutate of [false, true]) {
      const c = client(qx, {
        initial: saved,
        write(key, value, store) {
          if (key === 'enabled' && value === 'true') {
            if (mutate) store.set(key, value);
            return false;
          }
          store.set(key, value);
          return true;
        }
      });
      const result = c.run('lat=0&lon=0');
      assert.equal(result.success, false);
      assert.equal(result.enabled, false);
      assert.equal(result.disabledConfirmed, true);
      assert.equal(c.store.get('enabled'), 'false');
      assert.deepEqual(c.writes.at(-1), ['enabled', 'false']);
    }
  });

  test(`${api}: denied storage cannot claim a successful save or guaranteed disable`, () => {
    const c = client(qx, { initial: saved, write: () => false });
    const result = c.run('lat=0&lon=0');
    assert.equal(result.success, false);
    assert.equal(result.enabled, true);
    assert.equal(result.disabledConfirmed, false);
    assert.ok(c.writes.every(([key, value]) => key === 'enabled' && value === 'false'));
    assert.equal(c.run('action=clear').success, false);
  });

  test(`${api}: final enable readback failure returns an error and restores disabled state`, () => {
    const c = client(qx, {
      read(key, store) {
        if (key === 'enabled' && store.get(key) === 'true') throw new Error('Enable readback failed');
        return store.get(key);
      }
    });
    const result = c.run('lat=0&lon=0');
    assert.equal(result.success, false);
    assert.equal(result.enabled, false);
    assert.equal(result.disabledConfirmed, true);
    assert.equal(c.store.get('enabled'), 'false');
  });

  test(`${api}: failed rollback truthfully reports that enabled state persists`, () => {
    let enablingAttempted = false;
    const c = client(qx, {
      write(key, value, store) {
        if (key === 'enabled' && value === 'true') {
          enablingAttempted = true;
          store.set(key, value);
          return false;
        }
        if (key === 'enabled' && enablingAttempted) return false;
        store.set(key, value);
        return true;
      }
    });
    const result = c.run('lat=0&lon=0');
    assert.equal(result.success, false);
    assert.equal(result.enabled, true);
    assert.equal(result.disabledConfirmed, false);
  });

  test(`${api}: configuration changed during a later write is caught before enabling`, () => {
    const c = client(qx, {
      write(key, value, store) {
        store.set(key, value);
        if (key === 'randomRadius') store.set('latitude', '50');
        return true;
      }
    });
    const result = c.run('lat=0&lon=0');
    assert.equal(result.success, false);
    assert.equal(result.disabledConfirmed, true);
    assert.ok(!c.writes.some(([key, value]) => key === 'enabled' && value === 'true'));
  });

  test(`${api}: unavailable and throwing storage return errors and complete the request`, () => {
    for (const options of [
      { unavailable: true },
      { read: () => { throw new Error('Read denied'); }, write: () => { throw new Error('Write denied'); } }
    ]) {
      const c = client(qx, options);
      const save = c.run('lat=0&lon=0');
      assert.equal(save.success, false);
      assert.equal(save.disabledConfirmed, false);
      assert.equal(save.enabled, null);
      assert.equal(save.code, 'STORAGE_ERROR');
      for (const action of ['query', 'clear']) {
        const result = c.run({ action });
        assert.equal(result.success, false);
        assert.equal(result.code, 'STORAGE_ERROR');
      }
    }
  });

  test(`${api}: clear checks both the write result and exact stored disabled state`, () => {
    for (const options of [
      { initial: saved, write: () => true },
      { initial: { ...saved, enabled: 'false' }, write: () => false },
      { initial: saved, read: () => { throw new Error('Readback denied'); } }
    ]) {
      const c = client(qx, options);
      assert.equal(c.run('action=clear').success, false);
    }
  });

  test(`${api}: empty saved state is successful and distinct from a read failure`, () => {
    for (const initial of [{}, { enabled: 'false' }, { latitude: '', longitude: '', enabled: 'false' }]) {
      const c = client(qx, { initial });
      assert.deepEqual(c.run('action=query'), {
        success: true, hasCoordinates: false, enabled: false, settingsVersion: '20261101.2', diagnostics: null
      });
      assert.deepEqual(c.writes, []);
      assert.deepEqual(c.run('action=clear'), {
        success: true, hasCoordinates: false, enabled: false, settingsVersion: '20261101.2', diagnostics: null
      });
    }
  });

  test(`${api}: query preserves valid legacy coordinates with missing optional values or a disabled switch`, () => {
    for (const enabled of ['true', 'false', undefined]) {
      const initial = { latitude: '0', longitude: '0' };
      if (enabled !== undefined) initial.enabled = enabled;
      const c = client(qx, { initial });
      const result = c.run('action=query');
      assert.equal(result.success, true);
      assert.equal(result.hasCoordinates, true);
      assert.equal(result.enabled, enabled === 'true');
      assert.equal(result.latitude, 0);
      assert.equal(result.longitude, 0);
      for (const key of ['altitude', 'horizontalAccuracy', 'verticalAccuracy', 'randomRadius']) assert.equal(result[key], null);
      assert.deepEqual(c.writes, []);
      const cleared = c.run('action=clear');
      assert.equal(cleared.success, true);
      assert.equal(cleared.hasCoordinates, true);
      assert.equal(cleared.enabled, false);
      assert.equal(cleared.latitude, 0);
      assert.equal(cleared.longitude, 0);
    }
    for (const [key, value] of [
      ['horizontalAccuracy', '0'], ['verticalAccuracy', '-1'], ['randomRadius', '10001'], ['altitude', 'NaN']
    ]) {
      const result = client(qx, { initial: { ...saved, [key]: value } }).run('action=query');
      assert.equal(result.success, true);
      assert.equal(result.hasCoordinates, true);
      assert.equal(result[key], null);
    }
  });

  test(`${api}: query reports actual enabled state and rejects missing or invalid coordinate pairs`, () => {
    for (const invalid of [
      { enabled: 'true' }, { latitude: '0', enabled: 'false' },
      { ...saved, latitude: 'NaN' }, { ...saved, longitude: '4tail' },
      { ...saved, latitude: '91' }, { ...saved, longitude: '0x10' }
    ]) {
      const c = client(qx, { initial: invalid });
      const result = c.run('action=query');
      assert.equal(result.success, false);
      assert.equal(result.code, 'INVALID_COORDINATES');
      assert.equal(result.enabled, invalid.enabled === 'true');
      assert.deepEqual(c.writes, []);
    }
    const invalidEnabled = client(qx, { initial: { ...saved, enabled: 'unknown' } }).run('action=query');
    assert.equal(invalidEnabled.success, false);
    assert.equal(invalidEnabled.code, 'INVALID_SETTINGS');
    assert.equal(invalidEnabled.enabled, null);
  });

  test(`${api}: read exceptions for required or optional fields are STORAGE_ERROR, never empty or normal disabled`, () => {
    for (const key of Object.keys(saved)) {
      const c = client(qx, {
        initial: { ...saved, enabled: 'false' },
        read(name, store) { if (name === key) throw new Error('Read denied'); return store.get(name); }
      });
      const result = c.run('action=query');
      assert.equal(result.success, false, key);
      assert.equal(result.code, 'STORAGE_ERROR', key);
      assert.deepEqual(c.writes, []);
    }
  });

  test(`${api}: confirmed disabling succeeds even when old coordinates are invalid or cannot be read afterward`, () => {
    const invalid = client(qx, { initial: { ...saved, latitude: 'broken' } });
    const cleared = invalid.run('action=clear');
    assert.equal(cleared.success, true);
    assert.equal(cleared.enabled, false);
    assert.equal(cleared.disabledConfirmed, true);
    assert.equal(cleared.hasCoordinates, false);
    assert.equal(cleared.stateError.code, 'INVALID_COORDINATES');
    assert.equal(invalid.store.get('enabled'), 'false');
    for (const failedKey of ['latitude', 'horizontalAccuracy']) {
      const c = client(qx, {
        initial: saved,
        read(key, store) { if (key === failedKey) throw new Error('Read denied'); return store.get(key); }
      });
      const result = c.run('action=clear');
      assert.equal(result.success, true);
      assert.equal(result.enabled, false);
      assert.equal(result.disabledConfirmed, true);
      assert.equal(result.hasCoordinates, null, 'unreadable coordinates must not be called empty');
      assert.equal(result.stateError.code, 'STORAGE_ERROR');
      assert.equal(c.store.get('enabled'), 'false');
    }
  });

  test(`${api}: OPTIONS is read/write free; unknown actions and methods never save`, () => {
    const c = client(qx, { initial: saved });
    assert.equal(c.run('lat=0&lon=0', 'OPTIONS').success, true);
    assert.deepEqual(c.writes, []);
    assert.deepEqual(c.reads, []);
    for (const action of ['remove', 'SAVE', '']) {
      assert.equal(c.run({ action, lat: '0', lon: '0' }).success, false);
    }
    assert.equal(c.run('lat=0&lon=0', 'POST').success, false);
    assert.deepEqual(c.writes, []);
    assert.equal(c.store.get('enabled'), 'true');
  });
}
