/*!
 * btc-calc.js — reine Berechnungslogik für den Bitcoin-Chart (keine DOM-/Netzwerk-Zugriffe).
 *
 * Verantwortlich für:
 *  - Bereinigung der Kerzendaten (Sortierung, Duplikate, Lücken)
 *  - 200-Wochen-SMA (200WMA) aus Wochenschlusskursen
 *  - Abstand Kurs ↔ 200WMA (absolut / prozentual)
 *  - Nachschlagen von Werten zu einem Zeitpunkt
 *
 * Läuft im Browser (window.BtcCalc) und in Node (module.exports) – dadurch testbar.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BtcCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_MS = 86400000;
  var WEEK_MS = 7 * DAY_MS;
  var WMA_PERIOD = 200;

  /**
   * Bereinigt rohe Kerzen: [{t: Startzeit in ms, c: Schlusskurs}, …]
   * - verwirft ungültige Werte (NaN, <= 0)
   * - sortiert aufsteigend, entfernt doppelte Zeitstempel
   * - behält nur den letzten lückenlosen Abschnitt (Lücke > 1,5 Perioden beendet einen Abschnitt),
   *   damit der gleitende Durchschnitt nie über fehlende Wochen hinweg gebildet wird
   * - optional: verwirft die erste Kerze (kann ein unvollständiger Zeitraum sein)
   */
  function cleanCandles(raw, stepMs, opts) {
    opts = opts || {};
    var seen = Object.create(null);
    var list = [];
    for (var i = 0; i < raw.length; i++) {
      var k = raw[i];
      if (!k || !isFinite(k.t) || !isFinite(k.c) || k.c <= 0) continue;
      if (seen[k.t]) continue;
      seen[k.t] = true;
      list.push({ t: k.t, c: k.c });
    }
    list.sort(function (a, b) { return a.t - b.t; });

    var start = 0;
    for (var j = 1; j < list.length; j++) {
      if (list[j].t - list[j - 1].t > stepMs * 1.5) start = j;
    }
    var run = list.slice(start);
    if (opts.dropFirst && run.length > 0) run = run.slice(1);
    return run;
  }

  /**
   * Wandelt Kerzen in Zeitreihen-Punkte um. Zeitstempel = Schlusszeit der Kerze.
   * Eine noch laufende Kerze (Schlusszeit in der Zukunft) wird als vorläufiger Punkt
   * zum Zeitpunkt „jetzt“ geführt; ihr Schluss ist der aktuelle Kurs.
   *
   * @returns {{t:number, c:number, provisional:boolean}[]}
   */
  function toPoints(candles, stepMs, now, livePrice) {
    var out = [];
    for (var i = 0; i < candles.length; i++) {
      var closeT = candles[i].t + stepMs;
      if (closeT <= now) {
        out.push({ t: closeT, c: candles[i].c, provisional: false });
      } else {
        var price = isFinite(livePrice) && livePrice > 0 ? livePrice : candles[i].c;
        out.push({ t: now, c: price, provisional: true });
      }
    }
    // Falls die Daten der laufenden Periode noch fehlen, den Live-Kurs trotzdem anhängen
    var last = out[out.length - 1];
    if (last && !last.provisional && isFinite(livePrice) && livePrice > 0 && now > last.t) {
      out.push({ t: now, c: livePrice, provisional: true });
    }
    return out;
  }

  /**
   * Einfacher gleitender Durchschnitt. Liefert null, solange weniger als `period`
   * Werte vorliegen (keine Auffüllung, keine Extrapolation).
   */
  function sma(values, period) {
    var out = new Array(values.length);
    var sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      out[i] = i >= period - 1 ? sum / period : null;
    }
    return out;
  }

  /**
   * 200WMA über Wochenpunkte ([{t,c,provisional}]).
   * Ergebnis: nur Punkte mit gültigem Wert: [{t, v, provisional}].
   * Der Wert eines Punktes nutzt die 200 Wochenschlusskurse bis einschließlich dieses Punktes;
   * beim vorläufigen Punkt ist das der aktuelle Kurs der laufenden Woche.
   */
  function wma(weekPoints, period) {
    period = period || WMA_PERIOD;
    var closes = weekPoints.map(function (p) { return p.c; });
    var avg = sma(closes, period);
    var out = [];
    for (var i = 0; i < weekPoints.length; i++) {
      if (avg[i] !== null) out.push({ t: weekPoints[i].t, v: avg[i], provisional: weekPoints[i].provisional });
    }
    return out;
  }

  /** Abstand zwischen Kurs und Referenzwert. */
  function gap(price, ref) {
    if (!isFinite(price) || !isFinite(ref) || ref === 0) return null;
    return { abs: price - ref, pct: (price / ref - 1) * 100 };
  }

  /**
   * Letzter Eintrag mit .t <= t (Binärsuche, Liste aufsteigend sortiert), sonst null.
   * Es wird nie zwischen Werten interpoliert.
   */
  function atOrBefore(list, t) {
    var lo = 0, hi = list.length - 1, res = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid].t <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return res >= 0 ? list[res] : null;
  }

  /** Index des Eintrags, dessen .t dem Zeitpunkt t am nächsten liegt (Liste aufsteigend). */
  function nearestIndex(list, t) {
    if (!list.length) return -1;
    var lo = 0, hi = list.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid].t < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(list[lo - 1].t - t) <= Math.abs(list[lo].t - t)) return lo - 1;
    return lo;
  }

  /**
   * Baut alle Reihen für den Chart.
   *
   * @param {{t:number,c:number}[]} weeklyRaw   Wochenkerzen (Startzeit, Schluss)
   * @param {{t:number,c:number}[]} dailyRaw    Tageskerzen (Startzeit, Schluss) – darf leer sein
   * @param {number} livePrice                  aktueller Kurs (EUR) oder NaN
   * @param {number} now                        Zeitpunkt in ms
   * @returns {{weekly:Array, daily:Array, wma:Array, latest:Object|null}}
   */
  function buildSeries(weeklyRaw, dailyRaw, livePrice, now) {
    var weeklyCandles = cleanCandles(weeklyRaw, WEEK_MS, { dropFirst: true });
    var dailyCandles = cleanCandles(dailyRaw || [], DAY_MS, { dropFirst: false });

    var weekly = toPoints(weeklyCandles, WEEK_MS, now, livePrice);
    var daily = toPoints(dailyCandles, DAY_MS, now, livePrice);
    var wmaSeries = wma(weekly, WMA_PERIOD);

    var latest = null;
    var lastWma = wmaSeries[wmaSeries.length - 1];
    var lastPrice = weekly[weekly.length - 1];
    if (lastWma && lastPrice) {
      latest = {
        t: lastPrice.t,
        price: lastPrice.c,
        wma: lastWma.v,
        gap: gap(lastPrice.c, lastWma.v)
      };
    }
    return { weekly: weekly, daily: daily, wma: wmaSeries, latest: latest };
  }

  return {
    DAY_MS: DAY_MS,
    WEEK_MS: WEEK_MS,
    WMA_PERIOD: WMA_PERIOD,
    cleanCandles: cleanCandles,
    toPoints: toPoints,
    sma: sma,
    wma: wma,
    gap: gap,
    atOrBefore: atOrBefore,
    nearestIndex: nearestIndex,
    buildSeries: buildSeries
  };
});
