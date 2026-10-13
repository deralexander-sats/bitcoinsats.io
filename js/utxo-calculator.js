/*!
 * bitcoinsats.io – UTXO-Rechner: Oberfläche
 * Benötigt js/utxo-core.js (window.UtxoCore). Alle Berechnungen laufen lokal im Browser.
 */
(function () {
  'use strict';

  var C = window.UtxoCore;
  var root = document.getElementById('uc');
  if (!C || !root) return;

  var SCEN_LABELS = ['Niedrig', 'Mittel', 'Hoch', 'Spitze'];
  var state = { mode: 'dca', frequency: 'weekly', type: 'p2wpkh', unit: 'sats' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- Formatierung (de-DE) ---------- */

  var fmtCache = {};
  function nf(min, max, extra) {
    var k = min + '/' + max + '/' + (extra || '');
    if (!fmtCache[k]) {
      var o = { minimumFractionDigits: min, maximumFractionDigits: max };
      if (extra) o.notation = extra;
      fmtCache[k] = new Intl.NumberFormat('de-DE', o);
    }
    return fmtCache[k];
  }
  function fInt(n) { return nf(0, 0).format(Math.round(n)); }
  function fSat(n) { return n === null ? '–' : fInt(n) + ' sat'; }
  function fVb(n) { return fInt(n) + ' vB'; }
  function fBtc(sats) {
    if (sats === null) return '–';
    var neg = sats < 0, s = Math.abs(Math.round(sats));
    var whole = Math.floor(s / 1e8), frac = String(s % 1e8);
    while (frac.length < 8) frac = '0' + frac;
    return (neg ? '−' : '') + fInt(whole) + ',' + frac + ' BTC';
  }
  function fEur(n) {
    if (n === null || n === undefined) return '–';
    if (n > 0 && n < 0.01) return '< 0,01 €';
    return (n >= 10000 ? nf(0, 0) : nf(2, 2)).format(n) + ' €';
  }
  function fRate(r) { return nf(0, r < 1 ? 3 : r < 10 ? 2 : r < 100 ? 1 : 0).format(r); }
  function fPct(p) {
    if (p === null) return '–';
    if (p > 0 && p < 0.01) return '< 0,01 %';
    if (p >= 1000) return '> 1.000 %';
    return nf(p < 10 ? 2 : 1, p < 10 ? 2 : 1).format(p) + ' %';
  }
  function approxEur(n) { return n === null ? '' : '≈ ' + fEur(n); }

  /* ---------- Eingaben lesen ---------- */

  function val(id) { return $(id).value; }

  function readRaw() {
    return {
      mode: state.mode, amount: val('uc-amount'), frequency: state.frequency, years: val('uc-years'),
      buyPrice: val('uc-buyprice'), price: val('uc-price'), buyFee: val('uc-buyfee'), feeRate: val('uc-rate'),
      type: state.type, outType: val('uc-outtype'), nOut: val('uc-nout'),
      scenarios: [0, 1, 2, 3].map(function (i) { return val('uc-s' + i); }),
      list: val('uc-list'), unit: state.unit
    };
  }

  var FIELD_FOR_ERR = {
    amount: 'uc-amount', years: 'uc-years', buyPrice: 'uc-buyprice', price: 'uc-price', buyFee: 'uc-buyfee',
    feeRate: 'uc-rate', nOut: 'uc-nout', list: 'uc-list', scen0: 'uc-s0', scen1: 'uc-s1', scen2: 'uc-s2', scen3: 'uc-s3'
  };

  function showErrors(errors) {
    var advKey = false;
    Object.keys(FIELD_FOR_ERR).forEach(function (k) {
      var box = $('uc-err-' + k), input = $(FIELD_FOR_ERR[k]);
      if (errors[k]) {
        box.textContent = errors[k]; box.hidden = false; input.setAttribute('aria-invalid', 'true');
        if (/^scen|^nOut$|^buyFee$/.test(k)) advKey = true;
      } else { box.hidden = true; box.textContent = ''; input.removeAttribute('aria-invalid'); }
    });
    if (advKey) $('uc-adv').open = true;
  }

  /* ---------- Bausteine ---------- */

  function kpi(label, value, sub, cls) {
    return '<div class="uc-kpi' + (cls ? ' ' + cls : '') + '"><div class="uc-kl">' + label + '</div><div class="uc-kv">' + value + '</div>' +
      (sub ? '<div class="uc-ks">' + sub + '</div>' : '') + '</div>';
  }
  function stat(label, value, sub) {
    return '<div class="uc-stat"><span>' + label + '</span><b>' + value + '</b>' + (sub ? '<i>' + sub + '</i>' : '') + '</div>';
  }
  function note(kind, text) { return '<div class="uc-note ' + kind + '">' + text + '</div>'; }
  var LEVEL_CLASS = { 'gering': 'l0', 'moderat': 'l1', 'hoch': 'l2', 'sehr hoch': 'l3' };
  function levelPill(level) { return level ? '<span class="uc-pill ' + LEVEL_CLASS[level] + '">' + level + '</span>' : ''; }

  /* ---------- Rendern ---------- */

  function render(r) {
    var m = r.main, T = C.TYPES[r.type];
    $('uc-res-rate').textContent = fRate(r.rate) + ' sat/vB';

    var out = '';

    if (r.empty) {
      $('uc-results').innerHTML = note('', 'Kein Bestand eingegeben. Trage mindestens einen UTXO ein, um Konsolidierungskosten zu berechnen. Die Dust-Schwellenwerte unten gelten unabhängig vom Bestand.');
      $('uc-scen-card').hidden = true;
      renderDust(r);
      renderCalcPath(r);
      return;
    }

    /* Überblick: investiert / Marktwert / Bestand nach Gebühr */
    var stats = '';
    if (r.mode === 'dca') stats += stat('Investiertes Kapital', fEur(r.investedEur), r.dca.purchases + ' Käufe × ' + fEur(r.dca.amountEur));
    if (r.stackSats !== null && r.hasPrice) {
      stats += stat('Marktwert des Bestands', fEur(r.stackEur), r.priceIsBuyFallback ? 'zum Kaufkurs (kein aktueller Kurs eingegeben)' : 'zum aktuellen Kurs von ' + fEur(r.price));
    }
    if (m.netSats !== null) {
      stats += stat('Bestand nach Gebühr', m.netSats > 0 ? fBtc(m.netSats) : 'nichts übrig', m.netSats > 0 ? fSat(m.netSats) : 'Gebühr ≥ Bestand');
    }
    if (stats) out += '<div class="uc-stats">' + stats + '</div>';

    /* Kennzahlen */
    var avgTxt = r.avgSats !== null ? 'Ø ' + fSat(r.avgSats) + ' je UTXO' : '';
    out += '<div class="uc-kpis">';
    out += kpi('UTXOs', fInt(r.utxoCount), r.mode === 'dca' ? 'aus ' + fInt(r.dca.purchases) + ' Käufen' + (avgTxt ? '<br>' + avgTxt : '') : avgTxt);
    out += kpi('Geschätzter Bestand', r.stackSats !== null ? fBtc(r.stackSats) : '–',
      r.stackSats !== null ? fSat(r.stackSats) : 'Kaufkurs eingeben, um den Bestand zu schätzen');
    out += kpi('Konsolidierungsgebühr', fSat(m.fee),
      fBtc(m.fee) + (m.feeEur !== null ? ' · ' + approxEur(m.feeEur) : '') + '<br>' + fVb(m.plan.vsize) + ' in ' + m.plan.txCount + (m.plan.txCount === 1 ? ' Transaktion' : ' Transaktionen'), 'hi');
    out += kpi('Gebührenanteil am Bestand', m.pct !== null ? fPct(m.pct) + ' ' + levelPill(m.level) : '–',
      m.pct !== null ? 'Orientierungswert, keine Empfehlung' : 'Benötigt einen Kurs (Bestand in Sats)');
    out += kpi('Dust-Schwelle', fSat(m.threshold),
      (m.thresholdEur !== null ? approxEur(m.thresholdEur) + '<br>' : '') + 'bei ' + fRate(r.rate) + ' sat/vB · ' + T.short);
    out += '</div>';

    /* Hinweise */
    var notes = '';
    if (r.utxoCount === 1) notes += note('', 'Bei nur einem UTXO gibt es nichts zusammenzuführen. Angezeigt sind die Kosten einer Einzelausgabe (1 Input, ' + r.nOut + (r.nOut === 1 ? ' Output' : ' Outputs') + ').');
    if (m.plan.split) notes += note('', 'Die Zusammenführung überschreitet das Standard-Limit von 400.000 WU je Transaktion und wird auf <strong>' + m.plan.txCount + ' Transaktionen</strong> aufgeteilt (höchstens ' + fInt(m.plan.maxInputsPerTx) + ' Inputs je Transaktion).');
    if (m.feasible === false) notes += note('bad', 'Bei ' + fRate(r.rate) + ' sat/vB ist die Gebühr so hoch wie der gesamte Bestand oder der Output läge unter dem Dust-Relay-Limit. Eine Zusammenführung zu dieser Rate ist nicht möglich bzw. ergibt keinen sinnvollen Output.');
    if (m.belowCount) {
      notes += note('warn', '<strong>' + fInt(m.belowCount) + ' von ' + fInt(r.utxoCount) + ' UTXOs</strong> (zusammen ' + fSat(m.belowSats) + ') liegen bei dieser Rate unter dem wirtschaftlichen Schwellenwert von ' + fSat(m.threshold) + ': Ihre Ausgabe kostet mehr, als sie einbringt. Sie sind weiterhin gültig und ausgebbar; bei niedrigeren Gebühren oder zusammen mit größeren UTXOs kann sich die Ausgabe wieder lohnen.');
    }
    if (r.dustRateForAvg !== null) {
      notes += note('', 'Ein UTXO mit dem Durchschnittswert von ' + fSat(r.avgSats) + ' ist bis etwa <strong>' + fRate(r.dustRateForAvg) + ' sat/vB</strong> wirtschaftlich ausgebbar; darüber übersteigt die Gebühr für seinen Input seinen Wert.');
    }
    if (r.shareRates && m.plan.txCount === 1) {
      notes += note('', 'Die Konsolidierungsgebühr entspräche etwa 1 % / 5 % / 10 % des Bestands bei ca. <strong>' +
        r.shareRates.map(function (s) { return fRate(s.rate); }).join(' / ') + ' sat/vB</strong>.');
    }
    if (!r.hasPrice) notes += note('', 'Ohne Kurs werden Gebühren nur in Sats und BTC angezeigt. Gib oben einen Kurs ein, um Euro-Werte und den Gebührenanteil am Bestand zu sehen.');
    out += notes;

    $('uc-results').innerHTML = out;
    $('uc-scen-card').hidden = false;
    renderScenarios(r);
    renderDust(r);
    renderCalcPath(r);
  }

  function renderInvalid() {
    $('uc-res-rate').textContent = '…';
    $('uc-results').innerHTML = note('bad', 'Bitte prüfe die markierten Eingaben. Sobald alle Werte gültig sind, erscheinen die Ergebnisse.');
    $('uc-scen-card').hidden = true;
    $('uc-dust-card').hidden = true;
    $('uc-calcpath').innerHTML = '';
  }

  function renderScenarios(r) {
    var hasStack = r.stackSats !== null && r.stackSats > 0;
    var rows = r.scenarios.map(function (s, i) {
      var below = s.belowCount === null ? '–' : fInt(s.belowCount) + ' von ' + fInt(r.utxoCount) + (s.belowCount ? '<small>' + fSat(s.belowSats) + '</small>' : '');
      var share = s.pct === null ? '–' : fPct(s.pct) + '<small>' + (s.feasible === false ? '<span class="uc-pill l3">übersteigt Bestand</span>' : levelPill(s.level)) + '</small>';
      return '<tr>' +
        '<td data-label="Szenario">' + SCEN_LABELS[i] + '<small>' + fRate(s.rate) + ' sat/vB</small></td>' +
        '<td data-label="Gebühr">' + fSat(s.fee) + '<small>' + (s.feeEur !== null ? approxEur(s.feeEur) : fBtc(s.fee)) + '</small></td>' +
        '<td data-label="Anteil am Bestand">' + share + '</td>' +
        '<td data-label="Dust-Schwelle">' + fSat(s.threshold) + (s.thresholdEur !== null ? '<small>' + approxEur(s.thresholdEur) + '</small>' : '') + '</td>' +
        '<td data-label="UTXOs unter Schwelle">' + below + '</td></tr>';
    }).join('');
    $('uc-scen-table').innerHTML = '<table class="uc-table"><thead><tr><th>Szenario</th><th>Gebühr</th><th>Anteil am Bestand</th><th>Dust-Schwelle</th><th>UTXOs unter Schwelle</th></tr></thead><tbody>' + rows + '</tbody></table>';
    $('uc-scen-note').textContent = 'Ob eine Zusammenführung sinnvoll ist, hängt von Bestand, Zeithorizont und deiner Einschätzung künftiger Gebühren ab. Der Rechner gibt bewusst keine pauschale Empfehlung.' +
      (r.mode === 'custom' ? ' Tipp: Du kannst auch nur einen Teil der UTXOs zusammenführen, etwa die größeren.' : '');
    renderChart(r, hasStack);
  }

  function renderChart(r, hasStack) {
    var W = 340, H = 226, top = 30, bottom = 50, ph = H - top - bottom, slot = W / 4, bw = 50;
    var vals = r.scenarios.map(function (s) { return hasStack ? s.pct : s.fee; });
    var max = Math.max.apply(null, vals), scaleMax;
    if (hasStack) scaleMax = max >= 100 ? 100 : Math.max(max * 1.15, 0.5);
    else scaleMax = Math.max(max * 1.15, 1);
    var compact = nf(0, 1, 'compact');
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(
      (hasStack ? 'Konsolidierungsgebühr in Prozent des Bestands' : 'Konsolidierungsgebühr in Sats') + ' nach Gebührenszenario') + '">';
    svg += '<line class="c-base" x1="8" x2="' + (W - 8) + '" y1="' + (top + ph) + '" y2="' + (top + ph) + '"/>';
    r.scenarios.forEach(function (s, i) {
      var v = vals[i], h = Math.max(3, Math.min(ph, v / scaleMax * ph)), x = i * slot + (slot - bw) / 2, y = top + ph - h;
      var bad = s.feasible === false;
      var label = hasStack ? fPct(v) : (v >= 100000 ? compact.format(v) : fInt(v));
      svg += '<rect class="c-bar' + (bad ? ' bad' : '') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + h.toFixed(1) + '" rx="6"><title>' +
        esc(SCEN_LABELS[i] + ': ' + fSat(s.fee) + (s.pct !== null ? ' (' + fPct(s.pct) + ')' : '')) + '</title></rect>';
      svg += '<text class="c-val" x="' + (i * slot + slot / 2) + '" y="' + Math.max(14, y - 7).toFixed(1) + '">' + esc(label) + '</text>';
      svg += '<text class="c-lbl" x="' + (i * slot + slot / 2) + '" y="' + (top + ph + 18) + '">' + esc(fRate(s.rate)) + ' sat/vB</text>';
      svg += '<text class="c-sub" x="' + (i * slot + slot / 2) + '" y="' + (top + ph + 34) + '">' + SCEN_LABELS[i] + '</text>';
    });
    svg += '</svg>';
    var cap = hasStack
      ? 'Gebühr in % des Bestands' + (max >= 100 ? ' (Skala bis 100 %, rot = Gebühr übersteigt den Bestand)' : '')
      : 'Gebühr in Sats (ohne Kurs ist kein Anteil am Bestand berechenbar)';
    $('uc-chart').innerHTML = svg + '<div class="uc-chart-cap">' + cap + '</div>';
  }

  function renderDust(r) {
    $('uc-dust-card').hidden = false;
    var rows = r.dustByType.map(function (d) {
      return '<tr' + (d.id === r.type ? ' class="cur"' : '') + '>' +
        '<td data-label="Adresstyp">' + esc(d.label) + '<small>Input ' + nf(0, 1).format(d.inputVB) + ' vB</small></td>' +
        '<td data-label="Wirtschaftl. Schwelle">' + fSat(d.threshold) + (d.thresholdEur !== null ? '<small>' + approxEur(d.thresholdEur) + '</small>' : '') + '</td>' +
        '<td data-label="Einzelausgabe">' + fSat(d.singleSpend) + '<small>1 Input, 1 Output</small></td>' +
        '<td data-label="Relay-Limit (Core)">' + fSat(d.coreLimit) + '<small>bei 3 sat/vB</small></td></tr>';
    }).join('');
    var html = '<p>Bei <strong>' + fRate(r.rate) + ' sat/vB</strong>:</p>' +
      '<table class="uc-table"><thead><tr><th>Adresstyp</th><th>Wirtschaftl. Schwelle</th><th>Einzelausgabe</th><th>Relay-Limit (Core)</th></tr></thead><tbody>' + rows + '</tbody></table>';
    $('uc-dust-body').innerHTML = html;
  }

  function renderCalcPath(r) {
    var el = $('uc-calcpath');
    if (r.empty || r.utxoCount === 0) { el.innerHTML = '<p class="uc-mu">Noch kein Bestand eingegeben.</p>'; return; }
    var m = r.main, T = C.TYPES[r.type], O = C.TYPES[r.outType], p = m.plan;
    var s = '';
    if (p.txCount === 1) {
      var overhead = p.weight - p.nIn * T.inputWU - r.nOut * O.outputWU;
      s += 'Gewicht = ' + fInt(overhead) + ' (Overhead) + ' + fInt(p.nIn) + ' × ' + T.inputWU + ' (Inputs, ' + T.short + ') + ' + r.nOut + ' × ' + O.outputWU + ' (Output' + (r.nOut === 1 ? '' : 's') + ', ' + O.short + ')\n';
      s += '        = ' + fInt(p.weight) + ' WU\n';
      s += 'vSize   = ⌈' + fInt(p.weight) + ' / 4⌉ = ' + fInt(p.vsize) + ' vB\n';
      s += 'Gebühr  = ⌈' + fInt(p.vsize) + ' × ' + fRate(r.rate) + '⌉ = ' + fInt(m.fee) + ' sat';
    } else {
      s += 'Aufgeteilt auf ' + p.txCount + ' Transaktionen (höchstens ' + fInt(p.maxInputsPerTx) + ' Inputs je Transaktion, ' + p.nIn + ' Inputs insgesamt).\n';
      s += 'Gesamtgröße = ' + fInt(p.vsize) + ' vB (Summe der aufgerundeten Einzelgrößen)\n';
      s += 'Gebühr      = Summe der je Transaktion aufgerundeten Gebühren = ' + fInt(m.fee) + ' sat';
    }
    el.innerHTML = '<pre class="uc-pre">' + esc(s) + '</pre>';
  }

  /* ---------- Update ---------- */

  function update() {
    var r = C.compute(readRaw());
    showErrors(r.errors || {});
    if (r.ok) render(r); else renderInvalid();
    syncRateControls();
  }

  /* ---------- Gebühren-Regler (logarithmisch 1–1000 sat/vB) ---------- */

  function sliderToRate(v) {
    var r = Math.pow(10, v / 100);
    return r < 10 ? Math.round(r * 10) / 10 : Math.round(r);
  }
  function rateToSlider(rate) { return Math.max(0, Math.min(300, Math.round(Math.log10(rate) * 100))); }
  function rateText(r) { return String(r).replace('.', ','); }

  var sliderActive = false;
  function syncRateControls() {
    var n = C.parseNum(val('uc-rate'));
    if (!sliderActive && !isNaN(n) && n > 0) $('uc-slider').value = rateToSlider(n);
    Array.prototype.forEach.call($('uc-presets').children, function (b) {
      b.setAttribute('aria-pressed', !isNaN(n) && Number(b.getAttribute('data-v')) === n ? 'true' : 'false');
    });
    var y = C.parseNum(val('uc-years'));
    Array.prototype.forEach.call($('uc-year-chips').children, function (b) {
      b.setAttribute('aria-pressed', !isNaN(y) && Number(b.getAttribute('data-v')) === y ? 'true' : 'false');
    });
  }

  /* ---------- Events ---------- */

  function bindSeg(id, key, after) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b || !this.contains(b)) return;
      state[key] = b.getAttribute('data-v');
      Array.prototype.forEach.call(this.querySelectorAll('button[data-v]'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      if (after) after();
      update();
    });
  }

  bindSeg('uc-mode', 'mode', function () {
    var dca = state.mode === 'dca';
    $('uc-dca').hidden = !dca; $('uc-custom').hidden = dca; $('uc-buyfee-field').hidden = !dca;
  });
  bindSeg('uc-freq', 'frequency');
  bindSeg('uc-type', 'type');
  bindSeg('uc-unit', 'unit');

  $('uc-presets').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]'); if (!b) return;
    $('uc-rate').value = rateText(b.getAttribute('data-v')); update();
  });
  $('uc-year-chips').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]'); if (!b) return;
    $('uc-years').value = b.getAttribute('data-v'); update();
  });
  $('uc-slider').addEventListener('input', function () {
    sliderActive = true;
    $('uc-rate').value = rateText(sliderToRate(Number(this.value)));
    update();
    sliderActive = false;
  });

  ['uc-amount', 'uc-years', 'uc-buyprice', 'uc-price', 'uc-rate', 'uc-nout', 'uc-buyfee', 'uc-list', 'uc-s0', 'uc-s1', 'uc-s2', 'uc-s3'].forEach(function (id) {
    $(id).addEventListener('input', update);
  });
  $('uc-outtype').addEventListener('change', update);

  /* Live-Kurs (optional, nur auf Klick): mempool.space */
  $('uc-live').addEventListener('click', function () {
    var btn = this, msg = $('uc-live-msg');
    btn.disabled = true; msg.textContent = 'Lade …';
    fetch('https://mempool.space/api/v1/prices', { cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (d) {
        if (!d || !(d.EUR > 0)) throw new Error('kein EUR-Kurs');
        $('uc-price').value = String(Math.round(d.EUR));
        msg.textContent = 'Live-Kurs von mempool.space übernommen.';
        update();
      })
      .catch(function () { msg.textContent = 'Kurs konnte nicht geladen werden. Bitte manuell eingeben.'; })
      .then(function () { btn.disabled = false; });
  });

  update();
})();
