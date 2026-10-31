/*
 * location-settings.js — stateless save-interceptor for iOS Location Spoofer.
 *
 * Runs as an http-REQUEST script on gs-loc.apple.com/ils-settings/… and answers the
 * request itself (never hits Apple). It writes the picked point into THIS device's own
 * $persistentStore, using the exact keys location-spoofer.js already reads via
 * enrichArgsFromPluginStore: `latitude`, `longitude`, `altitude`, `enabled`.
 *
 * Nothing is stored server-side, so one public picker page can be shared by any number of
 * people — each person writes only their own device. `enabled` gates spoofing: cleared /
 * never-picked → enabled=false → location-spoofer.js passes through the real location
 * (this pairs with DEFAULT_CONFIG.enabled=false in location-spoofer.js).
 *
 *   GET …/ils-settings/save?lat=&lon=&alt=   → store coords (+altitude) and enable
 *   GET …/ils-settings/save?action=query      → return the device's current stored point
 *   GET …/ils-settings/save?action=clear      → enabled=false (restore real location)
 *
 * Supported clients: Surge / Shadowrocket / Loon / Stash / Egern ($persistentStore) and
 * Quantumult X ($prefs).
 */
(function () {
  "use strict";

  var isQuanX = typeof $task !== "undefined";
  var SETTINGS_VERSION = "20261101.1";
  var MAX_RANDOM_RADIUS = 10000;
  var MAX_ACCURACY = 9007199254740991;
  var numericKeys = ["latitude", "longitude", "altitude", "horizontalAccuracy", "verticalAccuracy", "randomRadius"];

  function readKey(k) {
    return isQuanX ? $prefs.valueForKey(k) : $persistentStore.read(k);
  }
  function writeKey(k, v) {
    try {
      return isQuanX ? $prefs.setValueForKey(String(v), k) : $persistentStore.write(String(v), k);
    } catch (e) {
      return false;
    }
  }

  function parseQuery(url) {
    var out = {};
    var qi = url.indexOf("?");
    if (qi < 0) return out;
    var parts = url.slice(qi + 1).split("&");
    for (var i = 0; i < parts.length; i += 1) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf("=");
      var k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
      var v = eq < 0 ? "" : parts[i].slice(eq + 1);
      try { k = decodeURIComponent(k.replace(/\+/g, " ")); } catch (e) {}
      try { v = decodeURIComponent(v.replace(/\+/g, " ")); } catch (e) {}
      if (!(k in out)) out[k] = v;
    }
    return out;
  }

  function finiteNum(s) {
    if (s == null) return NaN;
    var text = String(s).replace(/^\s+|\s+$/g, "");
    // Number/parseFloat alone accept hex literals or a valid numeric prefix.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return NaN;
    var n = Number(text);
    return isFinite(n) ? n : NaN;
  }

  function enabledState() {
    var value = readKey("enabled");
    return value === "true" ? true : value === "false" || value == null || value === "" ? false : null;
  }

  function safeEnabledState() {
    try { return enabledState(); } catch (e) { return null; }
  }

  function writeVerified(key, value) {
    var text = String(value);
    // These APIs return booleans: a failed write must never become a success
    // merely because an older value happens to match the requested one.
    try { return writeKey(key, text) === true && readKey(key) === text; }
    catch (e) { return false; }
  }

  function validConfig(values) {
    for (var i = 0; i < numericKeys.length; i += 1) {
      if (!isFinite(values[numericKeys[i]])) return false;
    }
    return values.latitude >= -90 && values.latitude <= 90 &&
      values.longitude >= -180 && values.longitude <= 180 &&
      values.horizontalAccuracy > 0 && values.horizontalAccuracy <= MAX_ACCURACY &&
      values.verticalAccuracy > 0 && values.verticalAccuracy <= MAX_ACCURACY &&
      values.randomRadius >= 0 && values.randomRadius <= MAX_RANDOM_RADIUS;
  }

  function failure(message, code) {
    var result = { success: false, error: message, enabled: safeEnabledState() };
    if (code) result.code = code;
    return result;
  }

  function failedSave(message) {
    // Best effort rollback. If storage denies even this write, report that the
    // disabled state could not be confirmed instead of promising it is safe.
    writeVerified("enabled", "false");
    var result = failure(message, "STORAGE_ERROR");
    result.disabledConfirmed = result.enabled === false;
    return result;
  }

  function parameter(q, shortKey, longKey, defaultValue) {
    var value = q[shortKey] != null ? q[shortKey] : q[longKey];
    return value == null ? defaultValue : finiteNum(value);
  }

  function save(q) {
    var values = {
      latitude: parameter(q, "lat", "latitude", NaN),
      longitude: parameter(q, "lon", "longitude", NaN),
      altitude: parameter(q, "alt", "altitude", 530),
      horizontalAccuracy: parameter(q, "hacc", "horizontalAccuracy", 39),
      verticalAccuracy: parameter(q, "vacc", "verticalAccuracy", 1000),
      randomRadius: parameter(q, "rr", "randomRadius", 0)
    };
    if (!validConfig(values)) {
      var validCoordinates = isFinite(values.latitude) && Math.abs(values.latitude) <= 90 &&
        isFinite(values.longitude) && Math.abs(values.longitude) <= 180;
      return failure("Invalid settings: coordinates must be in range, accuracy must be positive, and random radius must be 0–10000 metres",
        validCoordinates ? "INVALID_SETTINGS" : "INVALID_COORDINATES");
    }
    if (!writeVerified("enabled", "false")) {
      return failedSave("Could not disable location changes before saving; check client storage permissions");
    }
    for (var i = 0; i < numericKeys.length; i += 1) {
      var key = numericKeys[i];
      if (!writeVerified(key, values[key])) {
        return failedSave("Could not save and verify all settings; location changes remain disabled if storage permits");
      }
    }
    // Verify the whole set once more before making it active.
    for (var j = 0; j < numericKeys.length; j += 1) {
      var checkKey = numericKeys[j];
      var matches = false;
      try { matches = readKey(checkKey) === String(values[checkKey]); } catch (e) {}
      if (!matches) {
        return failedSave("Saved settings did not match; location changes remain disabled if storage permits");
      }
    }
    if (!writeVerified("enabled", "true")) {
      return failedSave("Could not enable the saved settings; location changes remain disabled if storage permits");
    }
    values.success = true;
    values.hasCoordinates = true;
    values.enabled = true;
    return values;
  }

  function query() {
    try {
      var rawLat = readKey("latitude"), rawLon = readKey("longitude");
      var enabled = enabledState();
      if (enabled === null) {
        return { success: false, code: "INVALID_SETTINGS", error: "Invalid saved enable state", enabled: null };
      }
      var noLat = rawLat == null || String(rawLat).replace(/^\s+|\s+$/g, "") === "";
      var noLon = rawLon == null || String(rawLon).replace(/^\s+|\s+$/g, "") === "";
      if (noLat && noLon && !enabled) {
        return { success: true, hasCoordinates: false, enabled: false };
      }
      var lat = finiteNum(rawLat), lon = finiteNum(rawLon);
      if (!isFinite(lat) || Math.abs(lat) > 90 || !isFinite(lon) || Math.abs(lon) > 180) {
        return { success: false, code: "INVALID_COORDINATES", error: "Invalid saved coordinates", hasCoordinates: false, enabled: enabled };
      }
      var values = { success: true, hasCoordinates: true, enabled: enabled, latitude: lat, longitude: lon };
      // Older clients may have saved only the coordinate pair. Missing or
      // invalid optional metadata does not erase those saved coordinates.
      for (var i = 2; i < numericKeys.length; i += 1) {
        var key = numericKeys[i];
        var value = finiteNum(readKey(key));
        var valid = isFinite(value);
        if (key === "horizontalAccuracy" || key === "verticalAccuracy") valid = valid && value > 0 && value <= MAX_ACCURACY;
        if (key === "randomRadius") valid = valid && value >= 0 && value <= MAX_RANDOM_RADIUS;
        values[key] = valid ? value : null;
      }
      return values;
    } catch (e) {
      return failure("Cannot read device settings", "STORAGE_ERROR");
    }
  }

  function clear() {
    if (!writeVerified("enabled", "false")) {
      return failure("Could not confirm that location changes are disabled; turn off the module in your client", "STORAGE_ERROR");
    }
    var state = query();
    if (state.success) return state;
    // Disabling succeeded even when old saved data is damaged or cannot be
    // inspected afterward. Expose that separate error without undoing recovery.
    return {
      success: true, enabled: false, disabledConfirmed: true,
      hasCoordinates: state.code === "INVALID_COORDINATES" ? false : null,
      stateError: { code: state.code, error: state.error }
    };
  }

  var url = (typeof $request !== "undefined" && $request && $request.url) || "";
  var method = String((typeof $request !== "undefined" && $request && $request.method) || "GET").toUpperCase();
  var q = parseQuery(url);
  var action = q.action == null ? "save" : q.action;
  var result;

  if (method === "OPTIONS") {
    result = { success: true };
  } else if (method !== "GET") {
    result = failure("Unsupported request method");
  } else if (action === "query") {
    result = query();
  } else if (action === "clear") {
    result = clear();
  } else if (action === "save") {
    result = save(q);
  } else {
    result = failure("Unknown settings action");
  }

  result.settingsVersion = SETTINGS_VERSION;
  var headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store"
  };
  var body = JSON.stringify(result);

  if (isQuanX) {
    $done({ status: "HTTP/1.1 200 OK", headers: headers, body: body });
  } else {
    $done({ response: { status: 200, headers: headers, body: body } });
  }
})();
