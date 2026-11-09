/*!
 * btc-app.js — Steuerung: baut die Oberfläche, verbindet Daten (BtcData), Berechnung (BtcCalc)
 * und Darstellung (BtcChartView).
 *
 * Einbindung: <div data-btc-chart></div> + btc-calc.js, btc-data.js, btc-chart.js, btc-app.js, btc-chart.css
 * (auf der Seite erledigt das _includes/btc-chart.html)
 */
(function (root) {
  'use strict';

  var Calc = root.BtcCalc, Data = root.BtcData, View = root.BtcChartView;
  var DAY = Calc.DAY_MS;

  var CURRENCIES = { USD: { sym: '$' }, EUR: { sym: '€' } };
  var DEFAULT_CURRENCY = 'USD';

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
    var ranges = el('div', 'btcc__seg btcc__ranges');
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

    var tools = el('div', 'btcc__tools');
    var curSeg = el('div', 'btcc__seg btcc__cur');
    curSeg.setAttribute('role', 'radiogroup');
    curSeg.setAttribute('aria-label', 'Währung');
    var curBtns = {};
    Object.keys(CURRENCIES).forEach(function (code) {
      var b = el('button', 'btcc__curbtn', code);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.cur = code;
      curSeg.appendChild(b);
      curBtns[code] = b;
    });
    var logBtn = el('button', 'btcc__log', 'Log');
    logBtn.type = 'button';
    logBtn.title = 'Logarithmische Preisachse';
    logBtn.setAttribute('aria-pressed', 'false');
    tools.appendChild(curSeg);
    tools.appendChild(logBtn);

    toolbar.appendChild(ranges);
    toolbar.appendChild(tools);

    var plot = el('div', 'btcc__plot');
    var status = el('div', 'btcc__status');
    status.setAttribute('role', 'status');
    plot.appendChild(status);

    var note = el('p', 'btcc__note'); // nur für Warnhinweise (veraltete Daten, Live-Kurs nicht erreichbar)

    host.appendChild(stats);
    host.appendChild(toolbar);
    host.appendChild(plot);
    host.appendChild(note);

    /* ---------- Zustand (je Währung getrennt) ---------- */
    function newCurState() {
      return { weekly: [], daily: [], live: NaN, liveAt: 0, series: null, liveFailed: false, stale: false, loaded: false, loading: false };
    }
    var S = {
      cur: DEFAULT_CURRENCY,
      rangeId: DEFAULT_RANGE,
      log: lsGet('btcc:log') === '1',
      byCur: { USD: newCurState(), EUR: newCurState() }
    };
    var rangeSrc = 'weekly';

    function C() { return S.byCur[S.cur]; }
    function sym() { return CURRENCIES[S.cur].sym; }
    function money(v) { return nf0.format(Math.round(v)) + NB + sym(); }
    function moneySigned(v) { return nfSigned0.format(Math.round(v)) + NB + sym(); }

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
        '<div class="btcc__tip-row"><span class="btcc__dot btcc__dot--price"></span><span>Bitcoin</span><b>' + money(pt.c) + '</b></div>';
      if (w) {
        var g = Calc.gap(pt.c, w.v);
        rows += '<div class="btcc__tip-row"><span class="btcc__dot btcc__dot--wma"></span><span>200WMA</span><b>' + money(w.v) + '</b></div>' +
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

    function resetStats() {
      [sPrice, sWma, sGap].forEach(function (s) { s.value.textContent = '–'; s.sub.textContent = NB; });
      sGap.value.className = 'btcc__value';
    }

    function renderStats() {
      var st = C();
      var L = st.series && st.series.latest;
      if (!L) { resetStats(); return; }
      sPrice.value.textContent = money(L.price);
      sPrice.sub.textContent = st.liveFailed ? 'letzter Schlusskurs' : (st.liveAt ? 'Stand ' + dfTime.format(st.liveAt) + ' Uhr' : NB);
      sWma.value.textContent = money(L.wma);
      sWma.sub.textContent = '200 Wochen Ø';
      var g = L.gap;
      sGap.value.textContent = pct(g.pct);
      sGap.value.className = 'btcc__value ' + (g.pct >= 0 ? 'btcc__pos' : 'btcc__neg');
      sGap.sub.textContent = moneySigned(g.abs);
    }

    function sliceForRange(series) {
      var r = currentRange();
      var src = r.src;
      if (src === 'daily' && series.daily.length < 5) src = 'weekly'; // Tagesdaten nicht verfügbar
      var pts = src === 'daily' ? series.daily : series.weekly;
      rangeSrc = src;
      if (r.days === Infinity) return pts;
      var from = Date.now() - r.days * DAY;
      var out = pts.filter(function (p) { return p.t >= from; });
      return out.length >= 2 ? out : pts.slice(-2);
    }

    function renderControls() {
      Object.keys(rangeBtns).forEach(function (id) {
        var on = id === S.rangeId;
        rangeBtns[id].classList.toggle('on', on);
        rangeBtns[id].setAttribute('aria-checked', on ? 'true' : 'false');
        rangeBtns[id].tabIndex = on ? 0 : -1;
      });
      Object.keys(curBtns).forEach(function (code) {
        var on = code === S.cur;
        curBtns[code].classList.toggle('on', on);
        curBtns[code].setAttribute('aria-checked', on ? 'true' : 'false');
        curBtns[code].tabIndex = on ? 0 : -1;
      });
      logBtn.setAttribute('aria-pressed', S.log ? 'true' : 'false');
      logBtn.classList.toggle('on', S.log);
    }

    function renderChart() {
      renderControls();
      var st = C();
      if (!st.series || !st.weekly.length) return;

      var pts = sliceForRange(st.series);
      view.setData(pts, st.series.wma, { log: S.log, sym: sym() });
      var L = st.series.latest;
      var r = currentRange();
      view.setLabel('Bitcoin-Kurs in ' + S.cur + ', Zeitraum ' + r.title + (L ? '. Aktuell ' + money(L.price) + ', 200WMA ' + money(L.wma) +
        ', Abstand ' + pct(L.gap.pct) : '') + '. Mit Pfeiltasten durch die Werte navigieren.');
    }

    function renderNote() {
      var st = C(), txt = '';
      if (st.stale) txt = 'Hinweis: Es werden zwischengespeicherte Daten angezeigt, die Aktualisierung ist fehlgeschlagen.';
      else if (st.liveFailed) txt = 'Hinweis: Der Live-Kurs ist gerade nicht erreichbar; es gilt der letzte Kerzenschluss.';
      note.textContent = txt;
    }

    function renderAll() {
      var st = C();
      if (!st.series || !st.series.latest) { renderControls(); return; }
      setStatus('');
      renderStats();
      renderChart();
      renderNote();
    }

    function rebuild(cur) {
      var st = S.byCur[cur];
      if (!st.weekly.length) return;
      st.series = Calc.buildSeries(st.weekly, st.daily, st.live, Date.now());
      if (cur !== S.cur) return; // andere Währung ist gerade nicht sichtbar
      if (!st.series.latest) {
        setStatus('Für die 200WMA liegen noch nicht genügend Wochendaten vor.', 'error');
        return;
      }
      renderAll();
    }

    /* ---------- Laden ---------- */
    function loadAll(cur) {
      var st = S.byCur[cur];
      if (st.loading) return Promise.resolve();
      st.loading = true;
      if (!st.loaded && cur === S.cur) setStatus('Kursdaten werden geladen …', 'loading');

      var wp = Data.fetchCandles(cur, Data.INTERVAL_WEEK, {
        onUpdate: function (fresh) { st.weekly = fresh.candles; st.stale = false; rebuild(cur); }
      });
      var dp = Data.fetchCandles(cur, Data.INTERVAL_DAY, {
        onUpdate: function (fresh) { st.daily = fresh.candles; rebuild(cur); }
      }).catch(function () { return null; }); // Tagesdaten sind optional
      var lp = Data.fetchLivePrice(cur).then(function (p) {
        st.live = p; st.liveAt = Date.now(); st.liveFailed = false;
      }).catch(function () { st.liveFailed = true; });

      return Promise.all([wp.then(function (r) { return r; }, function (e) { return { error: e }; }), dp, lp])
        .then(function (res) {
          var w = res[0], d = res[1];
          if (w.error) {
            if (!st.weekly.length) {
              if (cur === S.cur) setStatus('Die Kursdaten konnten nicht geladen werden. Bitte Verbindung prüfen.', 'error', function () { loadAll(cur); });
              return;
            }
            st.stale = true;
          } else {
            st.weekly = w.candles;
            st.stale = false;
          }
          if (d) st.daily = d.candles;
          st.loaded = true;
          rebuild(cur);
        })
        .then(function () { st.loading = false; }, function () { st.loading = false; });
    }

    function refreshLive() {
      var cur = S.cur, st = C();
      if (!st.loaded || document.hidden) return;
      Data.fetchLivePrice(cur).then(function (p) {
        st.live = p; st.liveAt = Date.now(); st.liveFailed = false;
        rebuild(cur);
      }).catch(function () { st.liveFailed = true; if (cur === S.cur) { renderStats(); renderNote(); } });
    }

    /* ---------- Ereignisse ---------- */
    function pickRange(id) {
      S.rangeId = id; // bewusst nicht gespeichert: beim Öffnen gilt immer 3 Jahre
      renderChart();
    }
    ranges.addEventListener('click', function (e) {
      var b = e.target.closest('.btcc__range');
      if (b) pickRange(b.dataset.range);
    });
    ranges.addEventListener('keydown', function (e) {
      var ids = RANGES.map(function (r) { return r.id; });
      var i = ids.indexOf(S.rangeId);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = Math.min(ids.length - 1, i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = Math.max(0, i - 1);
      else return;
      e.preventDefault();
      pickRange(ids[i]);
      rangeBtns[S.rangeId].focus();
    });

    function pickCurrency(code) {
      if (code === S.cur) return;
      S.cur = code;
      renderControls();
      var st = C();
      if (st.series && st.series.latest) {
        renderAll();
        refreshLive();
      } else {
        resetStats();
        note.textContent = '';
        loadAll(code);
      }
    }
    curSeg.addEventListener('click', function (e) {
      var b = e.target.closest('.btcc__curbtn');
      if (b) pickCurrency(b.dataset.cur);
    });
    curSeg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      var codes = Object.keys(CURRENCIES);
      var next = codes[(codes.indexOf(S.cur) + (e.key === 'ArrowRight' ? 1 : codes.length - 1)) % codes.length];
      pickCurrency(next);
      curBtns[S.cur].focus();
    });

    logBtn.addEventListener('click', function () {
      S.log = !S.log;
      lsSet('btcc:log', S.log ? '1' : '0');
      renderChart();
    });

    // Hell-/Dunkelmodus: die Seite setzt data-theme am <html>-Element (js/site.js); zusätzlich Systemeinstellung
    var redraw = function () { view.redraw(); };
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(redraw);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-bs-theme'] });
    }
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', redraw);
    }

    setInterval(refreshLive, LIVE_REFRESH_MS);
    setInterval(function () { if (!document.hidden) loadAll(S.cur); }, CANDLE_REFRESH_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshLive();
    });

    renderControls(); // markiert Standardauswahl (3J, USD) schon vor dem Laden
    loadAll(S.cur);
  }

  function autoMount() {
    var nodes = document.querySelectorAll('[data-btc-chart]');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();

  root.BtcChartApp = { mount: mount };
})(typeof self !== 'undefined' ? self : this);
