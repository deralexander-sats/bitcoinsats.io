/*!
 * btc-app.js — Steuerung: baut die Oberfläche, verbindet Daten (BtcData), Berechnung (BtcCalc)
 * und Darstellung (BtcChartView).
 *
 * Einbindung: <div data-btc-chart></div> + btc-calc.js, btc-data.js, btc-chart.js, btc-app.js, btc-chart.css
 */
(function (root) {
  'use strict';

  var Calc = root.BtcCalc, Data = root.BtcData, View = root.BtcChartView;
  var DAY = Calc.DAY_MS;

  // src: 'daily' = Tageskerzen (Kraken liefert max. 720 Tage), 'weekly' = Wochenkerzen
  var RANGES = [
    { id: '1m',  label: '1M',  title: '1 Monat',    days: 30,   src: 'daily' },
    { id: '3m',  label: '3M',  title: '3 Monate',   days: 91,   src: 'daily' },
    { id: '6m',  label: '6M',  title: '6 Monate',   days: 182,  src: 'daily' },
    { id: '1y',  label: '1J',  title: '1 Jahr',     days: 365,  src: 'daily' },
    { id: '2y',  label: '2J',  title: '2 Jahre',    days: 730,  src: 'weekly' },
    { id: '3y',  label: '3J',  title: '3 Jahre',    days: 1096, src: 'weekly' },
    { id: '5y',  label: '5J',  title: '5 Jahre',    days: 1826, src: 'weekly' },
    { id: '10y', label: '10J', title: '10 Jahre',   days: 3652, src: 'weekly' },
    { id: 'max', label: 'Max', title: 'Maximal verfügbare Historie', days: Infinity, src: 'weekly' }
  ];
  var DEFAULT_RANGE = '3y';
  var LIVE_REFRESH_MS = 60 * 1000;
  var CANDLE_REFRESH_MS = 15 * 60 * 1000;

  var nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  var nfSigned0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0, signDisplay: 'always' });
  var nfPct = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'always' });
  var dfTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
  var NB = ' ';

  function eur(v) { return nf0.format(Math.round(v)) + NB + '€'; }
  function eurSigned(v) { return nfSigned0.format(Math.round(v)) + NB + '€'; }
  function pct(v) { return nfPct.format(v) + NB + '%'; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* optional */ } }

  function mount(host) {
    if (host.__btcc) return;
    host.__btcc = true;

    /* ---------- Markup ---------- */
    host.classList.add('btcc');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Bitcoin-Kurs und 200-Wochen-Durchschnitt');
    host.innerHTML = '';

    var stats = el('div', 'btcc__stats');
    function stat(cls, label) {
      var s = el('div', 'btcc__stat ' + cls);
      var l = el('div', 'btcc__label', label);
      var v = el('div', 'btcc__value', '–');
      var sub = el('div', 'btcc__sub', NB);
      s.appendChild(l); s.appendChild(v); s.appendChild(sub);
      stats.appendChild(s);
      return { root: s, value: v, sub: sub, label: l };
    }
    var sPrice = stat('btcc__stat--price', 'Bitcoin');
    var sWma = stat('btcc__stat--wma', '200WMA');
    var sGap = stat('btcc__stat--gap', 'Abstand zur 200WMA');

    var toolbar = el('div', 'btcc__toolbar');
    var ranges = el('div', 'btcc__ranges');
    ranges.setAttribute('role', 'radiogroup');
    ranges.setAttribute('aria-label', 'Zeitraum');
    var rangeBtns = {};
    RANGES.forEach(function (r) {
      var b = el('button', 'btcc__range', r.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', r.title);
      b.title = r.title;
      b.dataset.range = r.id;
      ranges.appendChild(b);
      rangeBtns[r.id] = b;
    });
    var logBtn = el('button', 'btcc__log', 'Log');
    logBtn.type = 'button';
    logBtn.title = 'Logarithmische Preisachse';
    logBtn.setAttribute('aria-pressed', 'false');
    toolbar.appendChild(ranges);
    toolbar.appendChild(logBtn);

    var plot = el('div', 'btcc__plot');
    var status = el('div', 'btcc__status');
    status.setAttribute('role', 'status');
    plot.appendChild(status);

    var legend = el('div', 'btcc__legend');
    legend.innerHTML = '<span class="btcc__item"><span class="btcc__key btcc__key--price"></span>Bitcoin (EUR)</span>' +
      '<span class="btcc__item"><span class="btcc__key btcc__key--wma"></span>200-Wochen-Durchschnitt</span>';

    var note = el('p', 'btcc__note');

    host.appendChild(stats);
    host.appendChild(toolbar);
    host.appendChild(plot);
    host.appendChild(legend);
    host.appendChild(note);

    /* ---------- Zustand ---------- */
    var S = {
      weekly: [], daily: [], live: NaN, liveAt: 0,
      series: null, rangeId: DEFAULT_RANGE, log: lsGet('btcc:log') === '1',
      liveFailed: false, stale: false, loaded: false
    };
    var rangeSrc = 'weekly';

    var view = View.create(plot, { tooltip: tooltipHtml });

    function currentRange() {
      return RANGES.filter(function (r) { return r.id === S.rangeId; })[0] || RANGES[5];
    }

    /* ---------- Tooltip ---------- */
    function dateLabel(pt) {
      if (pt.provisional) return 'Aktuell · ' + dfTime.format(pt.t) + ' Uhr';
      var d = View.fmtFull.format(pt.t - 1); // Schlusszeit-Zeitstempel -> Datum der Kerze
      return rangeSrc === 'weekly' ? 'Woche bis ' + d : d;
    }
    function tooltipHtml(pt, w) {
      var rows = '<div class="btcc__tip-date">' + dateLabel(pt) + '</div>' +
        '<div class="btcc__tip-row"><span class="btcc__dot btcc__dot--price"></span><span>Bitcoin</span><b>' + eur(pt.c) + '</b></div>';
      if (w) {
        var g = Calc.gap(pt.c, w.v);
        rows += '<div class="btcc__tip-row"><span class="btcc__dot btcc__dot--wma"></span><span>200WMA</span><b>' + eur(w.v) + '</b></div>' +
          '<div class="btcc__tip-row btcc__tip-gap"><span></span><span>Abweichung</span><b class="' +
          (g.pct >= 0 ? 'btcc__pos' : 'btcc__neg') + '">' + pct(g.pct) + '</b></div>';
      } else {
        rows += '<div class="btcc__tip-row btcc__tip-muted"><span></span><span>200WMA</span><b>noch nicht verfügbar</b></div>';
      }
      return rows;
    }

    /* ---------- Anzeige ---------- */
    function setStatus(msg, kind, retry) {
      status.className = 'btcc__status' + (kind ? ' btcc__status--' + kind : '');
      status.innerHTML = '';
      if (!msg) { status.hidden = true; return; }
      status.hidden = false;
      status.appendChild(el('span', null, msg));
      if (retry) {
        var b = el('button', 'btcc__retry', 'Erneut versuchen');
        b.type = 'button';
        b.addEventListener('click', retry);
        status.appendChild(b);
      }
    }

    function renderStats() {
      var L = S.series && S.series.latest;
      if (!L) return;
      sPrice.value.textContent = eur(L.price);
      sPrice.sub.textContent = S.liveFailed ? 'letzter Schlusskurs' : (S.liveAt ? 'Stand ' + dfTime.format(S.liveAt) + ' Uhr' : NB);
      sWma.value.textContent = eur(L.wma);
      sWma.sub.textContent = '200 Wochen Ø';
      var g = L.gap;
      sGap.value.textContent = pct(g.pct);
      sGap.value.className = 'btcc__value ' + (g.pct >= 0 ? 'btcc__pos' : 'btcc__neg');
      sGap.sub.textContent = eurSigned(g.abs);
    }

    function sliceForRange() {
      var r = currentRange();
      var src = r.src;
      if (src === 'daily' && S.series.daily.length < 5) src = 'weekly'; // Tagesdaten nicht verfügbar
      var pts = src === 'daily' ? S.series.daily : S.series.weekly;
      rangeSrc = src;
      if (r.days === Infinity) return pts;
      var from = Date.now() - r.days * DAY;
      var out = pts.filter(function (p) { return p.t >= from; });
      return out.length >= 2 ? out : pts.slice(-2);
    }

    function renderChart() {
      Object.keys(rangeBtns).forEach(function (id) {
        var on = id === S.rangeId;
        rangeBtns[id].classList.toggle('is-active', on);
        rangeBtns[id].setAttribute('aria-checked', on ? 'true' : 'false');
        rangeBtns[id].tabIndex = on ? 0 : -1;
      });
      logBtn.setAttribute('aria-pressed', S.log ? 'true' : 'false');
      logBtn.classList.toggle('is-active', S.log);
      if (!S.series || !S.weekly.length) return;

      var pts = sliceForRange();
      view.setData(pts, S.series.wma, { log: S.log });
      var L = S.series.latest;
      var r = currentRange();
      view.setLabel('Bitcoin-Kurs in Euro, Zeitraum ' + r.title + (L ? '. Aktuell ' + eur(L.price) + ', 200WMA ' + eur(L.wma) +
        ', Abstand ' + pct(L.gap.pct) : '') + '. Mit Pfeiltasten durch die Werte navigieren.');
    }

    function renderNote() {
      var txt = 'Daten: Kraken (XBT/EUR). 200WMA = einfacher Durchschnitt der letzten 200 Wochenschlusskurse; ' +
        'die laufende Woche geht mit dem aktuellen Kurs ein. Keine Anlageberatung.';
      if (S.stale) txt += ' Hinweis: Es werden zwischengespeicherte Daten angezeigt, die Aktualisierung ist fehlgeschlagen.';
      else if (S.liveFailed) txt += ' Hinweis: Der Live-Kurs ist gerade nicht erreichbar; es gilt der letzte Kerzenschluss.';
      note.textContent = txt;
    }

    function rebuild() {
      if (!S.weekly.length) return;
      S.series = Calc.buildSeries(S.weekly, S.daily, S.live, Date.now());
      if (!S.series.latest) {
        setStatus('Für die 200WMA liegen noch nicht genügend Wochendaten vor.', 'error');
        return;
      }
      setStatus('');
      renderStats();
      renderChart();
      renderNote();
    }

    /* ---------- Laden ---------- */
    var loading = false;
    function loadAll() {
      if (loading) return Promise.resolve();
      loading = true;
      if (!S.loaded) setStatus('Kursdaten werden geladen …', 'loading');

      var wp = Data.fetchCandles(Data.INTERVAL_WEEK, {
        onUpdate: function (fresh) { S.weekly = fresh.candles; S.stale = false; rebuild(); }
      });
      var dp = Data.fetchCandles(Data.INTERVAL_DAY, {
        onUpdate: function (fresh) { S.daily = fresh.candles; rebuild(); }
      }).catch(function () { return null; }); // Tagesdaten sind optional
      var lp = Data.fetchLivePrice().then(function (p) {
        S.live = p; S.liveAt = Date.now(); S.liveFailed = false;
      }).catch(function () { S.liveFailed = true; });

      return Promise.all([wp.then(function (r) { return r; }, function (e) { return { error: e }; }), dp, lp])
        .then(function (res) {
          var w = res[0], d = res[1];
          if (w.error) {
            if (!S.weekly.length) {
              setStatus('Die Kursdaten konnten nicht geladen werden. Bitte Verbindung prüfen.', 'error', function () { loadAll(); });
              return;
            }
            S.stale = true;
          } else {
            S.weekly = w.candles;
            S.stale = false;
          }
          if (d) S.daily = d.candles;
          S.loaded = true;
          rebuild();
        })
        .then(function () { loading = false; }, function () { loading = false; });
    }

    function refreshLive() {
      if (!S.loaded || document.hidden) return;
      Data.fetchLivePrice().then(function (p) {
        S.live = p; S.liveAt = Date.now(); S.liveFailed = false;
        rebuild();
      }).catch(function () { S.liveFailed = true; renderStats(); renderNote(); });
    }

    /* ---------- Ereignisse ---------- */
    ranges.addEventListener('click', function (e) {
      var b = e.target.closest('.btcc__range');
      if (!b) return;
      S.rangeId = b.dataset.range; // bewusst nicht gespeichert: beim Öffnen gilt immer 3 Jahre
      renderChart();
    });
    ranges.addEventListener('keydown', function (e) {
      var ids = RANGES.map(function (r) { return r.id; });
      var i = ids.indexOf(S.rangeId);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = Math.min(ids.length - 1, i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = Math.max(0, i - 1);
      else return;
      e.preventDefault();
      S.rangeId = ids[i];
      renderChart();
      rangeBtns[S.rangeId].focus();
    });
    logBtn.addEventListener('click', function () {
      S.log = !S.log;
      lsSet('btcc:log', S.log ? '1' : '0');
      renderChart();
    });

    // Hell-/Dunkelmodus der Seite: Attribut- oder Klassenwechsel am <html>/<body> sowie Systemeinstellung
    var redraw = function () { view.redraw(); };
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(redraw);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-bs-theme', 'style'] });
      if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', redraw);
    }

    setInterval(refreshLive, LIVE_REFRESH_MS);
    setInterval(function () { if (!document.hidden) loadAll(); }, CANDLE_REFRESH_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshLive();
    });

    renderChart(); // markiert die Standardauswahl (3J) schon vor dem Laden
    loadAll();
  }

  function autoMount() {
    var nodes = document.querySelectorAll('[data-btc-chart]');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();

  root.BtcChartApp = { mount: mount };
})(typeof self !== 'undefined' ? self : this);
