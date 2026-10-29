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

  function readKey(k) {
    return isQuanX ? $prefs.valueForKey(k) : $persistentStore.read(k);
  }
  function writeKey(k, v) {
    var ok = isQuanX ? $prefs.setValueForKey(String(v), k) : $persistentStore.write(String(v), k);
    if (!ok) throw new Error("Cannot write " + k);
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
    if (s == null || String(s).trim() === "") return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  // A successful query describes saved data separately from the enable switch.
  // Clearing deliberately retains the coordinates so they can be saved again.
  function queryState() {
    var qlat = readKey("latitude");
    var qlon = readKey("longitude");
    var enabled = String(readKey("enabled")) === "true";
    var noLat = qlat == null || qlat === "";
    var noLon = qlon == null || qlon === "";
    if (noLat && noLon && !enabled) {
      return { success: true, hasCoordinates: false, enabled: false };
    }
    var lat = finiteNum(qlat), lon = finiteNum(qlon);
    if (!isFinite(lat) || Math.abs(lat) > 90 || !isFinite(lon) || Math.abs(lon) > 180) {
      return { success: false, code: "INVALID_COORDINATES", error: "Invalid saved coordinates" };
    }
    var result = { success: true, hasCoordinates: true, enabled: enabled, latitude: lat, longitude: lon };
    var optional = ["altitude", "horizontalAccuracy", "verticalAccuracy", "randomRadius"];
    for (var i = 0; i < optional.length; i += 1) {
      var n = finiteNum(readKey(optional[i]));
      result[optional[i]] = isFinite(n) ? n : null;
    }
    return result;
  }

  var url = (typeof $request !== "undefined" && $request && $request.url) || "";
  var q = parseQuery(url);
  var action = q.action || "save";
  var result;

  try {
    if (action === "query") {
      result = queryState();
    } else if (action === "clear") {
      writeKey("enabled", "false");
      result = queryState();
    } else {
      var lon = finiteNum(q.lon != null ? q.lon : q.longitude);
      var lat = finiteNum(q.lat != null ? q.lat : q.latitude);
      var alt = finiteNum(q.alt != null ? q.alt : q.altitude);
      var hacc = finiteNum(q.hacc != null ? q.hacc : q.horizontalAccuracy);
      var vacc = finiteNum(q.vacc != null ? q.vacc : q.verticalAccuracy);
      var rr = finiteNum(q.rr != null ? q.rr : q.randomRadius);
      if (isFinite(lon) && Math.abs(lon) <= 180 && isFinite(lat) && Math.abs(lat) <= 90) {
        // Do not leave a partially written coordinate pair enabled if a write fails.
        writeKey("enabled", "false");
        writeKey("latitude", String(lat));
        writeKey("longitude", String(lon));
        if (isFinite(alt)) writeKey("altitude", String(Math.round(alt)));
        if (isFinite(hacc)) writeKey("horizontalAccuracy", String(Math.round(hacc)));
        if (isFinite(vacc)) writeKey("verticalAccuracy", String(Math.round(vacc)));
        // randomRadius: 0 is a valid value (off), so write whenever the picker sends it.
        if (isFinite(rr)) writeKey("randomRadius", String(Math.max(0, Math.round(rr))));
        writeKey("enabled", "true");
        result = queryState();
      } else {
        result = { success: false, code: "INVALID_COORDINATES", error: "Invalid lat/lon parameters" };
      }
    }
  } catch (e) {
    result = { success: false, code: "STORAGE_ERROR", error: "Cannot read or write device settings" };
  }

  var headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
  var body = JSON.stringify(result);

  if (isQuanX) {
    $done({ status: "HTTP/1.1 200 OK", headers: headers, body: body });
  } else {
    $done({ response: { status: 200, headers: headers, body: body } });
  }
})();
