/*!
 * btc-chart.js — Darstellung (Canvas 2D) des Bitcoin-Charts. Keine Datenbeschaffung, keine Berechnung.
 *
 * Zwei übereinanderliegende Canvas: unten Linien/Achsen (wird nur bei Daten-/Größen-/Themawechsel
 * neu gezeichnet), oben das Fadenkreuz (wird bei jeder Mausbewegung billig neu gezeichnet).
 * Farben kommen aus CSS-Variablen (--btcc-*), dadurch folgt der Chart Hell-/Dunkelmodus der Seite.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var BTC = root.BtcCalc;

  var fmtDayMonth = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  var fmtMonth = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', month: 'short' });
  var fmtFull = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
  var nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

  function cssVar(el, name, fallback) {
    var v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* ---------- Achsen-Hilfen ---------- */

  function niceStep(range, target) {
    var raw = range / target;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * mag;
  }

  function linearTicks(min, max, target) {
    var step = niceStep(max - min, target);
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(v);
    return out;
  }

  function logTicks(min, max) {
    var sets = [[1, 2, 5], [1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9]];
    for (var s = 0; s < sets.length; s++) {
      var out = [];
      for (var d = Math.floor(Math.log10(min)); d <= Math.ceil(Math.log10(max)); d++) {
        for (var i = 0; i < sets[s].length; i++) {
          var v = sets[s][i] * Math.pow(10, d);
          if (v >= min && v <= max) out.push(v);
        }
      }
      if (out.length >= 4) return out;
    }
    return linearTicks(min, max, 5);
  }

  function formatAxisPrice(v, narrow) {
    if (narrow && v >= 10000) {
      var k = v / 1000;
      return (Number.isInteger(k) ? nf0.format(k) : k.toFixed(1).replace('.', ',')) + 'k €';
    }
    return nf0.format(Math.round(v)) + ' €';
  }

  /** Zeitachsen-Marken auf Kalendergrenzen (UTC). */
  function timeTicks(t0, t1, plotW) {
    var target = Math.max(3, Math.min(8, Math.floor(plotW / 90)));
    var spanDays = (t1 - t0) / DAY;
    var steps = [
      { k: 'd', n: 1 }, { k: 'd', n: 2 }, { k: 'd', n: 5 }, { k: 'd', n: 7 }, { k: 'd', n: 14 },
      { k: 'm', n: 1 }, { k: 'm', n: 2 }, { k: 'm', n: 3 }, { k: 'm', n: 6 },
      { k: 'y', n: 1 }, { k: 'y', n: 2 }, { k: 'y', n: 5 }
    ];
    var chosen = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var days = s.k === 'd' ? s.n : s.k === 'm' ? s.n * 30.4 : s.n * 365.25;
      if (spanDays / days <= target) { chosen = s; break; }
    }
    var ticks = [];
    var d;
    if (chosen.k === 'd') {
      var stepMs = chosen.n * DAY;
      for (var t = Math.ceil(t0 / stepMs) * stepMs; t <= t1; t += stepMs) {
        ticks.push({ t: t, label: fmtDayMonth.format(t) });
      }
    } else if (chosen.k === 'm') {
      d = new Date(t0);
      var y = d.getUTCFullYear(), m = d.getUTCMonth();
      for (;;) {
        var tm = Date.UTC(y, m, 1);
        if (tm > t1) break;
        if (tm >= t0 && m % chosen.n === 0) {
          ticks.push({ t: tm, label: m === 0 ? String(y) : fmtMonth.format(tm), strong: m === 0 });
        }
        m++; if (m > 11) { m = 0; y++; }
      }
    } else {
      for (var yy = new Date(t0).getUTCFullYear(); ; yy++) {
        var ty = Date.UTC(yy, 0, 1);
        if (ty > t1) break;
        if (ty >= t0 && yy % chosen.n === 0) ticks.push({ t: ty, label: String(yy), strong: true });
      }
    }
    return ticks;
  }

  /* ---------- Chart ---------- */

  function create(host, opts) {
    opts = opts || {};
    var base = document.createElement('canvas');
    var over = document.createElement('canvas');
    base.className = 'btcc__canvas';
    over.className = 'btcc__canvas btcc__canvas--over';
    over.tabIndex = 0;
    over.setAttribute('role', 'img');
    var tip = document.createElement('div');
    tip.className = 'btcc__tip';
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');
    host.appendChild(base);
    host.appendChild(over);
    host.appendChild(tip);

    var bctx = base.getContext('2d');
    var octx = over.getContext('2d');

    var state = {
      price: [], wma: [], log: false,
      t0: 0, t1: 1, yMin: 0, yMax: 1,
      w: 0, h: 0, dpr: 1,
      pad: { l: 10, r: 60, t: 12, b: 28 },
      hover: -1, colors: {}, font: ''
    };

    function yOf(v) {
      var p = state.pad, ph = state.h - p.t - p.b;
      var f = state.log
        ? (Math.log10(v) - Math.log10(state.yMin)) / (Math.log10(state.yMax) - Math.log10(state.yMin))
        : (v - state.yMin) / (state.yMax - state.yMin);
      return p.t + (1 - f) * ph;
    }
    function xOf(t) {
      var p = state.pad, pw = state.w - p.l - p.r;
      return p.l + (t - state.t0) / (state.t1 - state.t0) * pw;
    }
    function tOf(x) {
      var p = state.pad, pw = state.w - p.l - p.r;
      return state.t0 + (x - p.l) / pw * (state.t1 - state.t0);
    }

    function readColors() {
      var c = state.colors;
      c.price = cssVar(host, '--btcc-price', '#F7931A');
      c.priceFill = cssVar(host, '--btcc-price-fill', 'rgba(247,147,26,0.12)');
      c.wma = cssVar(host, '--btcc-wma', '#1F4FD8');
      c.halo = cssVar(host, '--btcc-card', '#FFFFFF');
      c.grid = cssVar(host, '--btcc-grid', 'rgba(20,24,31,0.07)');
      c.text = cssVar(host, '--btcc-muted', 'rgba(20,24,31,0.58)');
      c.ink = cssVar(host, '--btcc-text', '#14181F');
      c.tagText = cssVar(host, '--btcc-tag-text', '#FFFFFF');
      state.font = getComputedStyle(host).fontFamily || 'system-ui, sans-serif';
    }

    function resize() {
      var w = host.clientWidth, h = host.clientHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 3);
      if (!w || !h) return false;
      state.w = w; state.h = h; state.dpr = dpr;
      [base, over].forEach(function (cv) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + 'px';
        cv.style.height = h + 'px';
      });
      return true;
    }

    /** Sichtbare Punkte + ein vorangehender Punkt (echter Wert), damit die Linie am linken Rand nahtlos beginnt. */
    function visible(list, t0) {
      var i = 0;
      while (i < list.length && list[i].t < t0) i++;
      return list.slice(Math.max(0, i - 1));
    }

    function computeDomain() {
      var pv = state.price;
      state.t0 = pv.length ? pv[0].t : 0;
      state.t1 = pv.length ? pv[pv.length - 1].t : 1;
      if (state.t1 <= state.t0) state.t1 = state.t0 + 1;
      var wv = visible(state.wma, state.t0);
      var min = Infinity, max = -Infinity;
      pv.forEach(function (p) { if (p.c < min) min = p.c; if (p.c > max) max = p.c; });
      wv.forEach(function (p) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; });
      if (!isFinite(min)) { min = 0; max = 1; }
      if (state.log) {
        var lmin = Math.log10(min), lmax = Math.log10(max), pad = (lmax - lmin) * 0.06 || 0.05;
        state.yMin = Math.pow(10, lmin - pad); state.yMax = Math.pow(10, lmax + pad);
      } else {
        var padv = (max - min) * 0.07 || max * 0.05 || 1;
        state.yMin = Math.max(0, min - padv); state.yMax = max + padv;
      }
    }

    function tagY(list) {
      // Verhindert, dass sich die Wertmarken am rechten Rand überlappen (Mindestabstand 22 px)
      list.sort(function (a, b) { return a.y - b.y; });
      for (var i = 1; i < list.length; i++) {
        if (list[i].y - list[i - 1].y < 22) list[i].y = list[i - 1].y + 22;
      }
      return list;
    }

    function drawBase() {
      var ctx = bctx, c = state.colors, p = state.pad;
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, state.w, state.h);
      if (!state.price.length) return;

      var narrow = state.w < 520;
      var yTicks = state.log ? logTicks(state.yMin, state.yMax) : linearTicks(state.yMin, state.yMax, narrow ? 4 : 5);

      // Letzte Werte (für die Marken am rechten Rand)
      var pv = state.price;
      var wv = visible(state.wma, state.t0);
      var lastP = pv[pv.length - 1];
      var lastW = wv.length ? wv[wv.length - 1] : null;
      var priceTagText = nf0.format(Math.round(lastP.c)) + ' €';
      var wmaTagText = lastW ? nf0.format(Math.round(lastW.v)) + ' €' : '';

      // rechte Randbreite: breitestes Achsenlabel bzw. breiteste Wertmarke
      ctx.font = '12px ' + state.font;
      var wmax = 0;
      yTicks.forEach(function (v) { wmax = Math.max(wmax, ctx.measureText(formatAxisPrice(v, narrow)).width); });
      ctx.font = '600 11.5px ' + state.font;
      var tagW = Math.max(ctx.measureText(priceTagText).width, ctx.measureText(wmaTagText).width) + 16;
      p.r = Math.max(Math.ceil(wmax) + 14, Math.ceil(tagW) + 10);
      p.b = 28;
      var plotW = state.w - p.l - p.r, plotH = state.h - p.t - p.b;

      // Gitter + Y-Beschriftung
      ctx.font = '12px ' + state.font;
      ctx.lineWidth = 1;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      yTicks.forEach(function (v) {
        var y = Math.round(yOf(v)) + 0.5;
        ctx.strokeStyle = c.grid;
        ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(p.l + plotW, y); ctx.stroke();
        if (y < p.t + 6 || y > p.t + plotH - 6) return; // Label nicht in den Rand quetschen
        ctx.fillStyle = c.text;
        ctx.fillText(formatAxisPrice(v, narrow), p.l + plotW + 10, y);
      });

      // X-Beschriftung
      var xt = timeTicks(state.t0, state.t1, plotW);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      xt.forEach(function (tk) {
        var x = xOf(tk.t);
        if (x < p.l + 14 || x > p.l + plotW - 14) return;
        ctx.strokeStyle = c.grid;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, p.t); ctx.lineTo(Math.round(x) + 0.5, p.t + plotH); ctx.stroke();
        ctx.fillStyle = tk.strong ? c.ink : c.text;
        ctx.font = (tk.strong ? '600 ' : '') + '12px ' + state.font;
        ctx.fillText(tk.label, x, p.t + plotH + 8);
      });

      // Zeichenbereich begrenzen
      ctx.save();
      ctx.beginPath(); ctx.rect(p.l, p.t - 2, plotW + 1, plotH + 4); ctx.clip();

      // Kurs: dezente Fläche + dünne Linie
      var grad = ctx.createLinearGradient(0, p.t, 0, p.t + plotH);
      grad.addColorStop(0, c.priceFill);
      grad.addColorStop(1, 'rgba(247,147,26,0)');
      ctx.beginPath();
      pv.forEach(function (pt, i) { var x = xOf(pt.t), y = yOf(pt.c); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.lineTo(xOf(pv[pv.length - 1].t), p.t + plotH);
      ctx.lineTo(xOf(pv[0].t), p.t + plotH);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      ctx.beginPath();
      pv.forEach(function (pt, i) { var x = xOf(pt.t), y = yOf(pt.c); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = c.price; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 200WMA: heller Saum (hebt sie vom Kurs ab) + kräftige Linie, liegt über dem Kurs
      if (wv.length) {
        ctx.beginPath();
        wv.forEach(function (pt, i) { var x = xOf(pt.t), y = yOf(pt.v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.strokeStyle = c.halo; ctx.lineWidth = 6.5; ctx.stroke();
        ctx.strokeStyle = c.wma; ctx.lineWidth = 3.2; ctx.stroke();
      }
      ctx.restore();

      // Endpunkte + Wertmarken am rechten Rand
      var tags = [{ y: yOf(lastP.c), text: priceTagText, color: c.price }];
      if (lastW) tags.push({ y: yOf(lastW.v), text: wmaTagText, color: c.wma });
      [[lastP.t, lastP.c, c.price], lastW ? [lastW.t, lastW.v, c.wma] : null].forEach(function (d) {
        if (!d) return;
        var x = xOf(d[0]), y = yOf(d[1]);
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = c.halo; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = d[2]; ctx.fill();
      });
      ctx.font = '600 11.5px ' + state.font;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      tagY(tags).forEach(function (tg) {
        var tw = p.r - 8, th = 20, x = state.w - tw - 2, y = Math.max(p.t + th / 2, Math.min(p.t + plotH - th / 2, tg.y));
        roundRect(ctx, x, y - th / 2, tw, th, 6);
        ctx.fillStyle = tg.color; ctx.fill();
        ctx.fillStyle = c.tagText;
        ctx.fillText(tg.text, x + tw / 2, y + 0.5);
      });
    }

    function drawOver() {
      var ctx = octx, c = state.colors, p = state.pad;
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, state.w, state.h);
      if (state.hover < 0 || !state.price.length) return;
      var pt = state.price[state.hover];
      var x = Math.round(xOf(pt.t)) + 0.5;
      var plotH = state.h - p.t - p.b;
      ctx.strokeStyle = c.text; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, p.t); ctx.lineTo(x, p.t + plotH); ctx.stroke();
      ctx.setLineDash([]);
      var w = BTC.atOrBefore(state.wma, pt.t);
      [[pt.c, c.price], w ? [w.v, c.wma] : null].forEach(function (d) {
        if (!d) return;
        var y = yOf(d[0]);
        ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fillStyle = c.halo; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 3.8, 0, Math.PI * 2); ctx.fillStyle = d[1]; ctx.fill();
      });
    }

    function showTip() {
      if (state.hover < 0) { tip.hidden = true; return; }
      var pt = state.price[state.hover];
      var w = BTC.atOrBefore(state.wma, pt.t);
      tip.innerHTML = opts.tooltip ? opts.tooltip(pt, w) : '';
      tip.hidden = false;
      var x = xOf(pt.t), tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = x + 16;
      if (left + tw > state.w - state.pad.r) left = x - 16 - tw;
      left = Math.max(4, left);
      var yPrice = yOf(pt.c);
      // Tooltip über dem Kurs halten, bei Platzmangel darunter
      var top = yPrice - th - 18;
      if (top < 4) top = Math.min(state.h - th - state.pad.b - 4, yPrice + 18);
      tip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    }

    function setHover(idx) {
      if (idx === state.hover) return;
      state.hover = idx;
      drawOver();
      showTip();
    }

    function indexFromEvent(e) {
      var rect = over.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var p = state.pad;
      x = Math.max(p.l, Math.min(state.w - p.r, x));
      return BTC.nearestIndex(state.price, tOf(x));
    }

    var raf = 0;
    function onMove(e) {
      if (!state.price.length) return;
      var idx = indexFromEvent(e);
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { raf = 0; setHover(idx); });
    }
    over.addEventListener('pointermove', onMove);
    over.addEventListener('pointerdown', onMove);
    over.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse') setHover(-1);
    });
    over.addEventListener('pointercancel', function () { setHover(-1); });
    document.addEventListener('pointerdown', function (e) {
      if (!host.contains(e.target)) setHover(-1);
    });
    over.addEventListener('keydown', function (e) {
      if (!state.price.length) return;
      var n = state.price.length;
      if (e.key === 'ArrowLeft') { setHover(state.hover < 0 ? n - 1 : Math.max(0, state.hover - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { setHover(state.hover < 0 ? n - 1 : Math.min(n - 1, state.hover + 1)); e.preventDefault(); }
      else if (e.key === 'Escape') setHover(-1);
    });
    over.addEventListener('blur', function () { setHover(-1); });

    function render() {
      if (!resize()) return;
      readColors();
      computeDomain();
      drawBase();
      // Hover-Index nach Datenwechsel gültig halten
      if (state.hover >= state.price.length) state.hover = -1;
      drawOver();
      showTip();
    }

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(render).observe(host);
    else window.addEventListener('resize', render);

    return {
      /** price: [{t,c,provisional}], wma: [{t,v,provisional}] */
      setData: function (price, wma, o) {
        state.price = price; state.wma = wma;
        state.log = !!(o && o.log);
        state.hover = -1;
        render();
      },
      redraw: render,
      setLabel: function (text) { over.setAttribute('aria-label', text); }
    };
  }

  root.BtcChartView = { create: create, fmtFull: fmtFull };
})(typeof self !== 'undefined' ? self : this);
