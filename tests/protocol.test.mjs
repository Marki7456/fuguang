import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync, deflateSync, inflateSync } from 'node:zlib';

const source = await readFile(new URL('../public/location-spoofer.js', import.meta.url), 'utf8');
const quietConsole = { log() {} };
const fixedMath = Object.assign(Object.create(Math), { random: () => 0.25 });
const apiBox = { module: { exports: {} }, Uint8Array, ArrayBuffer, Math: fixedMath, console: quietConsole };
vm.runInNewContext(source, apiBox);
const api = apiBox.module.exports;
const target = { latitude: 39.9, longitude: 116.4, horizontalAccuracy: 10, randomRadius: 0 };
const config = api.normalizeConfig(target);
const bytes = values => Uint8Array.from(values);
const cat = (...parts) => api.concatBytes(parts);
const v = (number, value) => api.makeVarintField(number, value);
const ld = (number, payload) => api.makeLengthDelimitedField(number, payload);
const raw = value => Buffer.from(value);
const sameBytes = (actual, expected, message) => assert.deepEqual(raw(actual), raw(expected), message);
const fields = payload => Array.from(api.parseFields(payload));
const field = (payload, number) => fields(payload).find(item => item.fieldNumber === number);
const signed = item => BigInt.asIntN(64, api.decodeVarint(item.valueBytes, 0).value);
const fixedField = (number, wire, payload) => cat(api.encodeVarintUnsigned((number << 3) | wire), payload);
const suffix = bytes([0xde, 0xad, 0xbe, 0xef]);

const location = cat(
  v(4, 91),
  v(1, api.coordToInt(-31.2)),
  ld(1, bytes([0xab, 0xcd])), // Preserve another wire type at a familiar field number.
  v(5, 92),
  v(2, api.coordToInt(121.4)),
  v(6, 93),
  v(3, 23),
  v(11, 94),
  v(12, 95),
  fixedField(50, 5, bytes([1, 2, 3, 4])),
  fixedField(51, 1, bytes([8, 7, 6, 5, 4, 3, 2, 1]))
);
const wifi = cat(ld(1, bytes([1, 2, 3, 4, 5, 6])), ld(2, location), v(9, 7));
const cell = cat(v(1, 42), ld(5, location), ld(8, bytes([7, 8])));
const payload = cat(
  v(3, 101), ld(2, wifi), v(4, 102), ld(22, cell),
  fixedField(33, 5, bytes([9, 8, 7, 6])), ld(24, cell), ld(60, bytes([4, 3, 2, 1]))
);

function envelope(kind, inner = payload) {
  if (kind === 'synthetic') {
    return cat(api.buildAppleWLocResponse(inner, bytes([0, 1, 0, 0, 0, 3, 0, 0])), suffix);
  }
  if (kind === 'marker') {
    return cat(bytes([0xa5, 0x5a, 0x17]), api.APPLE_WLOC_MARKER, api.writeUInt16BE(inner.length), inner, suffix);
  }
  if (kind === 'arpc') {
    const result = api.serializeArpc({
      version: 2, locale: 'en_US', appIdentifier: 'com.apple.locationd',
      osVersion: '18.7', functionId: 1, payload: inner, suffix
    });
    // An opaque high-bit prefix byte must not be re-encoded through ASCII.
    result[4] = 0xe9;
    return result;
  }
  return inner;
}

function runEntry(options = {}) {
  const response = options.response || {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: envelope('synthetic')
  };
  const originalKeys = Object.keys(response);
  const originalHeaders = { ...response.headers };
  const originalBodies = {};
  for (const name of ['body', 'bodyBytes', 'rawBody', 'binaryBody']) {
    if (response[name] != null) originalBodies[name] = { reference: response[name], bytes: api.bodyToBytes(response[name]).slice() };
  }
  Object.freeze(response.headers);
  Object.freeze(response);
  const store = {
    enabled: 'true', latitude: String(target.latitude), longitude: String(target.longitude),
    horizontalAccuracy: String(target.horizontalAccuracy), randomRadius: '0', ...options.store
  };
  const calls = [];
  const box = {
    Uint8Array, ArrayBuffer, Math: fixedMath, console: quietConsole,
    $request: { url: 'https://gs-loc.apple.com/clls/wloc' },
    $response: response,
    $argument: options.argument || 'mode=response&debug=false',
    $persistentStore: { read: key => store[key] ?? null },
    $done: result => calls.push(result)
  };
  if (options.utils) box.$utils = options.utils;
  vm.runInNewContext(source, box, { timeout: 1000 });
  assert.equal(calls.length, 1, '$done must be called exactly once');
  assert.deepEqual(Object.keys(response), originalKeys, 'response slots must remain unchanged');
  assert.deepEqual(response.headers, originalHeaders, 'source headers must remain unchanged');
  for (const [name, original] of Object.entries(originalBodies)) {
    assert.strictEqual(response[name], original.reference, name + ' reference must remain unchanged');
    sameBytes(api.bodyToBytes(response[name]), original.bytes, name + ' bytes must remain unchanged');
  }
  return calls[0];
}

const isPassThrough = result => assert.deepEqual(Object.keys(result), []);

test('only existing coordinate/accuracy varints change, in place; all other location fields retain their bytes', () => {
  const before = fields(location);
  const after = fields(api.patchLocation(location, config));
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map(f => [f.fieldNumber, f.wireType]), before.map(f => [f.fieldNumber, f.wireType]));
  for (let i = 0; i < before.length; i += 1) {
    const item = before[i];
    if (item.wireType === 0 && [1, 2, 3].includes(item.fieldNumber)) {
      const expected = item.fieldNumber === 1 ? api.coordToInt(target.latitude)
        : item.fieldNumber === 2 ? api.coordToInt(target.longitude) : target.horizontalAccuracy;
      assert.equal(signed(after[i]), BigInt(expected));
    } else sameBytes(after[i].raw, item.raw);
  }
});

test('all root metadata and record metadata survive; both supported cell fields change', () => {
  const result = api.patchAppleWLocPayload(payload, config);
  assert.equal(result.changed, true);
  assert.equal(result.wifiCount, 1);
  assert.equal(result.cellCount, 2);
  const before = fields(payload);
  const after = fields(result.payload);
  assert.deepEqual(after.map(f => f.fieldNumber), before.map(f => f.fieldNumber));
  for (let i = 0; i < before.length; i += 1) {
    if (![2, 22, 24].includes(before[i].fieldNumber)) sameBytes(after[i].raw, before[i].raw);
  }
  const patchedWifi = field(result.payload, 2).valueBytes;
  sameBytes(field(patchedWifi, 1).raw, field(wifi, 1).raw);
  sameBytes(field(patchedWifi, 9).raw, field(wifi, 9).raw);
});

test('empty, partial, or wrong-wire coordinates remain unchanged and absent accuracy is not added', () => {
  for (const partial of [bytes([]), v(1, 1), v(2, 1), cat(ld(1, bytes([1])), v(2, 1)), v(3, 4)]) {
    sameBytes(api.patchLocation(partial, config), partial);
  }
  const noAccuracy = cat(v(1, 1), v(2, 2));
  const patched = fields(api.patchLocation(noAccuracy, config));
  assert.deepEqual(patched.map(f => f.fieldNumber), [1, 2]);
});

test('out-of-range signed source coordinates remain untouched while valid records in the same response change', () => {
  const invalidLocations = [
    cat(v(1, api.coordToInt(999)), v(2, 100)),
    cat(v(1, -9000000001n), v(2, 100)),
    cat(v(1, 0), v(2, 18000000001n)),
    cat(v(1, 0), v(2, -18000000001n)),
    cat(v(1, -(1n << 63n)), v(2, 0))
  ];
  for (const invalid of invalidLocations) {
    sameBytes(api.patchLocation(invalid, config), invalid);
    const invalidRecord = ld(2, invalid);
    const original = cat(ld(2, invalidRecord), ld(2, wifi));
    const result = api.patchAppleWLocPayload(original, config);
    assert.equal(result.changed, true);
    assert.equal(result.wifiCount, 1);
    const resultRecords = fields(result.payload);
    sameBytes(resultRecords[0].valueBytes, invalidRecord);
    sameBytes(resultRecords[1].valueBytes, api.patchWifiDevice(wifi, config));
    isPassThrough(runEntry({ response: { status: 200, headers: {}, body: envelope('synthetic', ld(2, invalidRecord)) } }));
  }
});

test('signed negative values and exact latitude/longitude boundaries are valid coordinates', () => {
  for (const [latitude, longitude] of [[-9000000000n, -18000000000n], [9000000000n, 18000000000n], [-1n, -1n], [0n, 0n]]) {
    const original = cat(v(1, latitude), v(2, longitude), v(3, 20));
    const patched = api.patchLocation(original, config);
    assert.equal(signed(field(patched, 1)), BigInt(api.coordToInt(target.latitude)));
    assert.equal(signed(field(patched, 2)), BigInt(api.coordToInt(target.longitude)));
  }
});

test('uint64 bounds reject overflow, excess bytes and truncation; malformed known/unknown fields pass through', () => {
  const maxUint64 = bytes([...Array(9).fill(0xff), 1]);
  assert.equal(api.decodeVarint(maxUint64, 0).value, (1n << 64n) - 1n);
  const malformed = [
    bytes([...Array(9).fill(0xff), 2]),
    bytes([...Array(10).fill(0x80), 0]),
    bytes([0x80])
  ];
  for (const invalid of malformed) {
    assert.throws(() => api.decodeVarint(invalid, 0));
    const unknownRoot = cat(payload, api.encodeVarintUnsigned(60 << 3), invalid);
    const invalidCoordinate = ld(2, ld(2, cat(bytes([8]), invalid, v(2, 0))));
    for (const inner of [unknownRoot, invalidCoordinate]) {
      isPassThrough(runEntry({ response: { status: 200, headers: {}, body: envelope('synthetic', inner) } }));
    }
  }
  const validUnknown = cat(payload, api.encodeVarintUnsigned(60 << 3), maxUint64);
  const patched = api.patchAppleWLocPayload(validUnknown, config);
  sameBytes(fields(patched.payload).at(-1).raw, fields(validUnknown).at(-1).raw);
});

test('records with absent, empty, or partial locations do not acquire coordinates', () => {
  for (const record of [v(9, 7), cat(v(9, 7), ld(2, bytes([]))), ld(2, v(1, 7))]) {
    sameBytes(api.patchWifiDevice(record, config), record);
  }
  for (const record of [v(9, 7), cat(v(9, 7), ld(5, bytes([]))), ld(5, v(2, 7))]) {
    sameBytes(api.patchCellTower(record, config), record);
  }
});

test('semantic no-op preserves noncanonical raw varints and enclosing lengths byte-for-byte', () => {
  function overlong(value) {
    const encoded = Array.from(api.encodeVarintUnsigned(value));
    encoded[encoded.length - 1] |= 0x80;
    return bytes([...encoded, 0]);
  }
  const already = cat(bytes([8]), overlong(api.coordToInt(target.latitude)), v(2, api.coordToInt(target.longitude)), v(3, target.horizontalAccuracy));
  const record = cat(bytes([18]), overlong(already.length), already);
  const root = cat(bytes([18]), overlong(record.length), record, v(33, 4));
  const result = api.patchAppleWLocPayload(root, config);
  assert.equal(result.changed, false);
  assert.equal(result.wifiCount, 0);
  sameBytes(result.payload, root);
  isPassThrough(runEntry({ response: { status: 200, headers: {}, body: envelope('synthetic', root) } }));
});

test('positive sub-metre accuracy produces a positive integer on the wire', () => {
  const result = api.spoofAppleResponse(payload, { ...target, horizontalAccuracy: 0.1 });
  const patchedLocation = field(field(result.payload, 2).valueBytes, 2).valueBytes;
  assert.equal(signed(field(patchedLocation, 3)), 1n);
});

for (const kind of ['synthetic', 'marker', 'arpc', 'bare']) {
  test(kind + ' preserves the original envelope, including opaque prefix/suffix', () => {
    const original = envelope(kind);
    const extracted = api.extractAppleWLocPayload(original);
    assert.equal(extracted.kind, kind);
    const result = api.spoofAppleResponse(original, target);
    assert.equal(result.kind, kind);
    assert.equal(result.changed, true);
    const after = api.extractAppleWLocPayload(result.response);
    assert.equal(after.kind, kind);
    sameBytes(after.payload, api.patchAppleWLocPayload(payload, config).payload);
    if (kind === 'arpc') {
      sameBytes(after.arpc.prefix, extracted.arpc.prefix);
      sameBytes(after.arpc.suffix, suffix);
      sameBytes(api.serializeArpc(api.parseArpc(original)), original);
    } else if (kind !== 'bare') {
      sameBytes(after.prefix, extracted.prefix);
      sameBytes(after.suffix, suffix);
    } else sameBytes(result.response, result.payload);
  });

  test(kind + ' no-op returns original bytes and the runtime passes through', () => {
    const withoutCoordinates = cat(ld(2, v(9, 7)), v(3, 100), v(33, 101));
    const original = envelope(kind, withoutCoordinates);
    const result = api.spoofAppleResponse(original, target);
    assert.equal(result.changed, false);
    sameBytes(result.response, original);
    isPassThrough(runEntry({ response: { status: 200, headers: {}, body: original } }));
  });
}

test('rewritten response has one case-insensitive content type/length and no stale encoding headers', () => {
  const result = runEntry({ response: {
    status: 'HTTP/1.1 200 OK', body: envelope('synthetic'),
    headers: { 'content-type': 'old/type', 'Content-Type': 'other/type', 'CONTENT-LENGTH': '1', 'content-encoding': 'identity', 'Transfer-Encoding': 'chunked', 'X-Keep': 'unchanged' }
  } });
  for (const name of ['content-type', 'content-length']) {
    assert.equal(Object.keys(result.headers).filter(k => k.toLowerCase() === name).length, 1);
  }
  assert.equal(result.headers['Content-Type'], 'application/octet-stream');
  assert.equal(Number(result.headers['Content-Length']), result.body.length);
  assert.equal(result.headers['X-Keep'], 'unchanged');
  assert.ok(!Object.keys(result.headers).some(k => ['content-encoding', 'transfer-encoding'].includes(k.toLowerCase())));
});

test('gzip reads the binary slot consistently, decodes once, and never mutates either original slot', () => {
  const original = envelope('arpc');
  const compressed = bytes(gzipSync(original));
  let decodes = 0;
  const result = runEntry({
    response: { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: bytes([9, 9]), bodyBytes: compressed },
    utils: { ungzip(input) { decodes += 1; assert.notStrictEqual(input, compressed); return bytes(gunzipSync(input)); } }
  });
  assert.equal(decodes, 1);
  sameBytes(result.body, api.spoofAppleResponse(original, target).response);
});

test('gzip magic without a header and already decoded gzip headers both work', () => {
  const original = envelope('synthetic');
  const utils = { ungzip: input => bytes(gunzipSync(input)) };
  for (const response of [
    { status: 200, headers: {}, body: bytes(gzipSync(original)) },
    { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: original }
  ]) sameBytes(runEntry({ response, utils }).body, api.spoofAppleResponse(original, target).response);
});

test('deflate decodes without changing the original response', () => {
  const original = envelope('synthetic');
  const result = runEntry({
    response: { status: 200, headers: { 'Content-Encoding': 'deflate' }, body: bytes(deflateSync(original)) },
    utils: { inflate: input => bytes(inflateSync(input)) }
  });
  sameBytes(result.body, api.spoofAppleResponse(original, target).response);
});

test('unavailable/failed decoders and decoded invalid/no-op bodies always pass through intact', () => {
  const valid = bytes(gzipSync(envelope('synthetic')));
  for (const options of [
    { response: { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: valid } },
    { response: { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: valid }, utils: { ungzip() { throw new Error('bad gzip'); } } },
    { response: { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: valid }, utils: { ungzip: () => bytes([0, 0, 0]) } },
    { response: { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: valid }, utils: { ungzip: () => envelope('synthetic', v(33, 7)) } },
    { response: { status: 200, headers: { 'Content-Encoding': 'unknown' }, body: envelope('synthetic') } }
  ]) isPassThrough(runEntry(options));
});

test('non-2xx or malformed HTTP status is never rewritten', () => {
  for (const status of [101, 301, 400, 404, 500, 'HTTP/2 503 Service Unavailable', 'invalid']) {
    isPassThrough(runEntry({ response: { status, headers: {}, body: envelope('synthetic') } }));
  }
  isPassThrough(runEntry({ response: { status: 200, statusCode: 500, headers: {}, body: envelope('synthetic') } }));
});

test('missing/short/unknown/malformed responses pass through exactly once, even with failOpen=false', () => {
  const invalid = [
    null, bytes([]), bytes([0]), bytes([0, 0, 0, 0]), bytes([255, 255, 255]),
    bytes(Buffer.from('<html>upstream error</html>')),
    cat(api.APPLE_WLOC_PREFIX, api.writeUInt16BE(100), bytes([18, 1, 1])),
    envelope('synthetic', ld(2, bytes([18, 255])))
  ];
  for (const body of invalid) {
    isPassThrough(runEntry({ response: { status: 200, headers: {}, body }, argument: 'mode=response&failOpen=false' }));
  }
});

test('disabled/default settings do not inspect or decompress responses', () => {
  for (const enabled of ['false', null]) {
    isPassThrough(runEntry({
      store: { enabled },
      response: { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: bytes(gzipSync(envelope('synthetic'))) },
      utils: { ungzip() { assert.fail('disabled module must not decode'); } }
    }));
  }
});

test('invalid legacy coordinates pass through exactly once, including when disabled; no default location is substituted', () => {
  for (const enabled of ['true', 'false']) {
    for (const coordinates of [
      { latitude: '91', longitude: '100' },
      { latitude: '-91', longitude: '100' },
      { latitude: '30', longitude: '181' },
      { latitude: '30', longitude: '-181' },
      { latitude: 'NaN', longitude: '100' },
      { latitude: '30', longitude: 'Infinity' }
    ]) {
      isPassThrough(runEntry({ store: { enabled, ...coordinates } }));
    }
  }
});

test('configuration loading failures pass through once without inspecting the response', () => {
  for (const argument of ['mode=response&config=%7Bbad', 'mode=response&configBase64=not-valid-base64']) {
    isPassThrough(runEntry({ argument }));
  }
});

test('runtime applies a saved random radius once and uses one shared coordinate for all records', () => {
  const original = envelope('synthetic');
  const expected = api.spoofAppleResponse(original, { ...target, randomRadius: 100 });
  const actual = runEntry({ store: { randomRadius: '100' } });
  sameBytes(actual.body, expected.response);
  const root = api.extractAppleWLocPayload(actual.body).payload;
  const wifiLocation = field(field(root, 2).valueBytes, 2).valueBytes;
  for (const number of [22, 24]) {
    const cellLocation = field(field(root, number).valueBytes, 5).valueBytes;
    assert.equal(signed(field(cellLocation, 1)), signed(field(wifiLocation, 1)));
    assert.equal(signed(field(cellLocation, 2)), signed(field(wifiLocation, 2)));
  }
});
