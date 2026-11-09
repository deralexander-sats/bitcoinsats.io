/*!
 * btc-data.js — Datenbeschaffung für den Bitcoin-Chart (nur Netzwerk + Cache, keine Berechnung).
 *
 * Datenquelle: Kraken Public API (kostenlos, ohne API-Key, CORS-fähig), Handelspaar XBT/EUR.
 *   - Wochenkerzen  : GET /0/public/OHLC?pair=XBTEUR&interval=10080  (max. 720 Kerzen ≈ 13,8 Jahre)
 *   - Tageskerzen   : GET /0/public/OHLC?pair=XBTEUR&interval=1440   (max. 720 Kerzen ≈ 2 Jahre)
 *   - Live-Kurs     : GET /0/public/Ticker?pair=XBTEUR
 *
 * Robustheit: Timeout, Wiederholungen mit Backoff, localStorage-Cache (mit Verfall) und
 * Rückgriff auf veraltete Cache-Daten, wenn das Netz ausfällt.
 */
(function (root) {
  'use strict';

  var BASE = 'https://api.kraken.com/0/public/';
  var PAIR = 'XBTEUR';
  var TIMEOUT_MS = 12000;
  var RETRIES = 2;                      // zusätzlich zum ersten Versuch
  var CACHE_PREFIX = 'bsc:v1:';
  var TTL = {
    10080: 60 * 60 * 1000,              // Wochenkerzen: 1 h frisch
    1440: 15 * 60 * 1000                // Tageskerzen: 15 min frisch
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function readCache(key) {
    var s = storage();
    if (!s) return null;
    try {
      var raw = s.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.candles) || !isFinite(obj.savedAt)) return null;
      return obj;
    } catch (e) { return null; }
  }

  function writeCache(key, candles) {
    var s = storage();
    if (!s) return;
    try {
      s.setItem(CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), candles: candles }));
    } catch (e) { /* Speicher voll oder gesperrt – Cache ist optional */ }
  }

  /** fetch mit Timeout; wirft bei HTTP-Fehlern und API-Fehlern (Feld "error"). */
  function getJson(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .then(function (json) {
        if (json && Array.isArray(json.error) && json.error.length) {
          throw new Error('API: ' + json.error.join(', '));
        }
        if (!json || !json.result) throw new Error('Unerwartete API-Antwort');
        return json.result;
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function withRetry(fn) {
    var attempt = 0;
    function run() {
      return fn().catch(function (err) {
        attempt++;
        // Bei Rate-Limit (429) oder Serverfehlern erneut versuchen, bei Clientfehlern nicht
        var retryable = !err.status || err.status === 429 || err.status >= 500 || /rate limit/i.test(err.message);
        if (attempt > RETRIES || !retryable) throw err;
        return sleep(700 * Math.pow(2, attempt - 1)).then(run);
      });
    }
    return run();
  }

  /** Kraken-Kerze: [time(s), open, high, low, close, vwap, volume, count] -> {t(ms), c} */
  function parseCandles(result) {
    var key = null;
    Object.keys(result).forEach(function (k) { if (k !== 'last') key = k; });
    var rows = key ? result[key] : null;
    if (!Array.isArray(rows)) throw new Error('Keine Kerzendaten in der Antwort');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var t = Number(r[0]) * 1000;
      var c = parseFloat(r[4]);
      if (isFinite(t) && isFinite(c) && c > 0) out.push({ t: t, c: c });
    }
    return out;
  }

  /**
   * Lädt Kerzen für ein Intervall (Minuten: 10080 = Woche, 1440 = Tag).
   * Strategie „stale-while-revalidate“:
   *   - frischer Cache  -> sofort zurück, kein Netzwerk
   *   - veralteter Cache -> sofort zurück (onStale), parallel im Hintergrund erneuern
   *   - kein Cache       -> Netzwerk, bei Fehler Ausnahme
   *
   * @param {number} interval
   * @param {{onUpdate?:function(Array)}} [opts]  wird aufgerufen, wenn nach einem veralteten Cache frische Daten eintreffen
   * @returns {Promise<{candles:Array, source:'cache'|'network'|'stale', savedAt:number}>}
   */
  function fetchCandles(interval, opts) {
    opts = opts || {};
    var key = String(interval);
    var cached = readCache(key);
    var ttl = TTL[interval] || 15 * 60 * 1000;

    function network() {
      return withRetry(function () {
        return getJson(BASE + 'OHLC?pair=' + PAIR + '&interval=' + interval);
      }).then(function (result) {
        var candles = parseCandles(result);
        if (candles.length < 10) throw new Error('Zu wenige Kerzen erhalten');
        writeCache(key, candles);
        return { candles: candles, source: 'network', savedAt: Date.now() };
      });
    }

    if (cached && Date.now() - cached.savedAt < ttl) {
      return Promise.resolve({ candles: cached.candles, source: 'cache', savedAt: cached.savedAt });
    }
    if (cached) {
      network().then(function (fresh) {
        if (opts.onUpdate) opts.onUpdate(fresh);
      }).catch(function () { /* stilles Scheitern: Cache bleibt in Gebrauch */ });
      return Promise.resolve({ candles: cached.candles, source: 'stale', savedAt: cached.savedAt });
    }
    return network();
  }

  /** Aktueller Kurs (letzter Handelspreis) in EUR. Wirft bei Fehlern. */
  function fetchLivePrice() {
    return withRetry(function () {
      return getJson(BASE + 'Ticker?pair=' + PAIR);
    }).then(function (result) {
      var key = Object.keys(result)[0];
      var price = key && result[key] && result[key].c ? parseFloat(result[key].c[0]) : NaN;
      if (!isFinite(price) || price <= 0) throw new Error('Ungültiger Live-Kurs');
      return price;
    });
  }

  root.BtcData = {
    INTERVAL_WEEK: 10080,
    INTERVAL_DAY: 1440,
    fetchCandles: fetchCandles,
    fetchLivePrice: fetchLivePrice,
    _parseCandles: parseCandles // für Tests
  };
})(typeof self !== 'undefined' ? self : this);
