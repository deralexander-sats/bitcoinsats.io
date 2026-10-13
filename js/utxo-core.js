/*!
 * bitcoinsats.io – UTXO-Rechner: Rechenkern
 * Reine Funktionen ohne DOM-Zugriff (im Browser als window.UtxoCore, in Node per require).
 * Alle Größen werden in Weight Units (WU) gerechnet und erst zuletzt in vByte umgewandelt.
 * Alle Gebühren werden auf ganze Satoshis aufgerundet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UtxoCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SATS_PER_BTC = 100000000;
  var MAX_SATS = 2100000000000000;          // 21 Mio. BTC
  var MAX_STANDARD_TX_WEIGHT = 400000;      // Standardness-Grenze von Bitcoin Core (100.000 vB)
  var DUST_RELAY_FEE = 3;                   // sat/vB (Bitcoin Core: 3000 sat/kvB)
  var MAX_UTXOS = 10000000;

  /*
   * Größen je Adresstyp (Single-Sig, Key-Path / Standard-Spend, komprimierte Pubkeys).
   * inputWU:  41 Byte Non-Witness (x4) + Witness
   *   P2WPKH: 164 + 108 = 272 WU  (68 vB; Signatur mit max. 72 Byte angenommen)
   *   P2TR:   164 +  66 = 230 WU  (57,5 vB; Schnorr-Signatur 64 Byte, SIGHASH_DEFAULT)
   *   P2PKH:  148 Byte x4 = 592 WU (148 vB; ScriptSig mit 72-Byte-Signatur + 33-Byte-Pubkey)
   * outputWU: 8 Byte Betrag + 1 Byte Script-Länge + Script, x4
   *   P2WPKH 31 B, P2TR 43 B, P2PKH 34 B
   */
  var TYPES = {
    p2wpkh: { id: 'p2wpkh', label: 'Native SegWit (P2WPKH)', short: 'P2WPKH', prefix: 'bc1q', inputWU: 272, outputWU: 124, segwit: true },
    p2pkh:  { id: 'p2pkh',  label: 'Legacy (P2PKH)',         short: 'P2PKH',  prefix: '1',    inputWU: 592, outputWU: 136, segwit: false },
    p2tr:   { id: 'p2tr',   label: 'Taproot (P2TR)',         short: 'P2TR',   prefix: 'bc1p', inputWU: 230, outputWU: 172, segwit: true }
  };

  /* ---------- Zahlen ---------- */

  function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

  /* Deutsche Eingabe: "1.234,56", "0,5", "60.000", "12.5" */
  function parseNum(s) {
    if (typeof s === 'number') return isFinite(s) ? s : NaN;
    if (s === null || s === undefined) return NaN;
    s = String(s).trim().replace(/[\s\u00a0'’_]/g, '');
    if (s === '') return NaN;
    if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');
    s = s.replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  function rateMilli(rate) { return Math.round(rate * 1000); }   // Gebührenrate in mSat/vB (exakte Ganzzahlrechnung)
  function ceilDiv(a, b) { return Math.floor((a + b - 1) / b); }

  /* ---------- Transaktionsgröße ---------- */

  function varintLen(n) { return n < 253 ? 1 : (n <= 65535 ? 3 : 5); }

  /* Gewicht einer Transaktion mit nIn Inputs des Typs `type` und nOut Outputs des Typs `outType`. */
  function txWeight(type, nIn, nOut, outType) {
    var t = TYPES[type], o = TYPES[outType || type];
    var overhead = 4 * (4 + 4 + varintLen(nIn) + varintLen(nOut)); // Version, Locktime, Zähler
    if (t.segwit) overhead += 2;                                    // Marker + Flag (je 1 WU)
    return overhead + nIn * t.inputWU + nOut * o.outputWU;
  }

  function vsizeFromWeight(w) { return ceilDiv(w, 4); }

  function feeFor(vsize, rate) { return ceilDiv(vsize * rateMilli(rate), 1000); }

  /* Maximale Inputs, damit die Transaktion unter 400.000 WU bleibt. */
  function maxInputsPerTx(type, nOut, outType) {
    var t = TYPES[type];
    var k = Math.floor((MAX_STANDARD_TX_WEIGHT - txWeight(type, 0, nOut, outType)) / t.inputWU);
    if (k > 252) {
      var extra = 4 * (varintLen(k) - 1);
      k = Math.floor((MAX_STANDARD_TX_WEIGHT - txWeight(type, 0, nOut, outType) - extra) / t.inputWU);
    }
    return Math.max(1, k);
  }

  /*
   * Plan für die Zusammenführung von nIn Inputs. Überschreitet die Transaktion die
   * Standardness-Grenze, wird sie auf mehrere Transaktionen aufgeteilt (jede mit eigenen Outputs).
   */
  function consolidationPlan(type, nIn, nOut, outType, rate) {
    var res = { nIn: nIn, nOut: nOut, txCount: 0, maxInputsPerTx: maxInputsPerTx(type, nOut, outType),
                weight: 0, vsize: 0, fee: 0, firstTxVsize: 0, split: false };
    if (nIn <= 0) return res;
    var k = res.maxInputsPerTx;
    var full = Math.floor(nIn / k), rem = nIn - full * k;
    function add(n, times) {
      var w = txWeight(type, n, nOut, outType), v = vsizeFromWeight(w);
      res.weight += w * times; res.vsize += v * times; res.fee += feeFor(v, rate) * times; res.txCount += times;
      if (!res.firstTxVsize) res.firstTxVsize = v;
    }
    if (full > 0) add(k, full);
    if (rem > 0) add(rem, 1);
    res.split = res.txCount > 1;
    return res;
  }

  /* ---------- Dust ---------- */

  /* Wirtschaftlicher Schwellenwert: Gebühr, die ein weiterer Input dieses Typs in einer Transaktion kostet. */
  function dustThreshold(type, rate) { return ceilDiv(TYPES[type].inputWU * rateMilli(rate), 4000); }

  /* Gebühr für die Einzelausgabe (1 Input, 1 Output gleichen Typs) – inklusive Overhead. */
  function singleSpendFee(type, rate) { return feeFor(vsizeFromWeight(txWeight(type, 1, 1, type)), rate); }

  /* Gebührenrate, bei der ein UTXO mit `value` Sats genau dem Input-Schwellenwert entspricht. */
  function dustRateForValue(type, value) { return value * 4 / TYPES[type].inputWU; }

  /* Dust-Limit der Relay-Policy von Bitcoin Core (dustRelayFee = 3 sat/vB) für einen Output dieses Typs. */
  function coreDustLimit(type) {
    var t = TYPES[type];
    return DUST_RELAY_FEE * (t.outputWU / 4 + (t.segwit ? 67 : 148));
  }

  /* ---------- DCA ---------- */

  function purchaseCount(frequency, years) {
    var eps = 1e-9;
    if (frequency === 'weekly') return Math.floor(years * 365.25 / 7 + eps);
    if (frequency === 'biweekly') return Math.floor(years * 365.25 / 14 + eps);
    return Math.floor(years * 12 + eps);
  }

  function satsForEur(eur, price, feePct) {
    if (!(price > 0)) return null;
    return Math.floor(eur * (1 - (feePct || 0) / 100) * SATS_PER_BTC / price + 1e-7);
  }

  /* ---------- Parser für den eigenen Bestand ---------- */

  function parseSats(str) {
    var s = str.replace(/[\s'’_]/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    if (/^\d+$/.test(s)) { var n = Number(s); return n > 0 && n <= MAX_SATS ? { v: n } : { err: 'Betrag muss zwischen 1 Sat und 21 Mio. BTC liegen' }; }
    if (/^-/.test(s)) return { err: 'Negative Beträge sind nicht erlaubt' };
    if (/^\d+[.,]\d+$/.test(s)) return { err: 'Sats müssen ganze Zahlen sein' };
    return { err: 'Kein gültiger Betrag' };
  }

  function parseBtc(str) {
    var s = str.replace(/[\s'’_]/g, '').replace(',', '.');
    if (/^-/.test(s)) return { err: 'Negative Beträge sind nicht erlaubt' };
    var m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
    if (!m) return { err: /^\d+\.\d{9,}$/.test(s) ? 'Maximal 8 Nachkommastellen' : 'Kein gültiger Betrag' };
    var v = Number(m[1]) * SATS_PER_BTC + Number((m[2] || '').padEnd(8, '0'));
    return v > 0 && v <= MAX_SATS ? { v: v } : { err: 'Betrag muss zwischen 1 Sat und 21 Mio. BTC liegen' };
  }

  /* Eine Zeile je UTXO oder "Anzahl x Betrag". Leerzeilen und Zeilen mit # werden ignoriert. */
  function parseUtxoList(text, unit) {
    var groups = [], errors = [], total = 0, stack = 0;
    String(text || '').split(/\r?\n/).forEach(function (raw, i) {
      var line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      var count = 1, amount = line, m = /^(\d+)\s*[x×*]\s*(.+)$/i.exec(line);
      if (m) { count = Number(m[1]); amount = m[2]; }
      if (count < 1 || count > MAX_UTXOS) { errors.push({ line: i + 1, msg: 'Anzahl muss zwischen 1 und ' + MAX_UTXOS + ' liegen' }); return; }
      var r = unit === 'btc' ? parseBtc(amount) : parseSats(amount);
      if (r.err) { errors.push({ line: i + 1, msg: r.err }); return; }
      total += count; stack += count * r.v;
      groups.push({ count: count, value: r.v });
    });
    if (!errors.length && total > MAX_UTXOS) errors.push({ line: 0, msg: 'Maximal ' + MAX_UTXOS + ' UTXOs insgesamt' });
    if (!errors.length && stack > MAX_SATS) errors.push({ line: 0, msg: 'Gesamtbestand übersteigt 21 Mio. BTC' });
    return { groups: groups, errors: errors, count: total, stackSats: stack };
  }

  /* ---------- Bewertung ---------- */

  function shareLevel(pct) {
    if (pct === null) return null;
    if (pct < 1) return 'gering';
    if (pct < 5) return 'moderat';
    if (pct < 20) return 'hoch';
    return 'sehr hoch';
  }

  function satsToEur(sats, price) { return (price > 0 && sats !== null) ? sats * price / SATS_PER_BTC : null; }

  /* Analyse einer Gebührenrate für einen UTXO-Bestand. ctx = { groups, nIn, stackSats, type, outType, nOut, price } */
  function analyze(ctx, rate) {
    var plan = consolidationPlan(ctx.type, ctx.nIn, ctx.nOut, ctx.outType, rate);
    var thr = dustThreshold(ctx.type, rate);
    var below = 0, belowSats = 0, belowKnown = true;
    ctx.groups.forEach(function (g) {
      if (g.value === null) { belowKnown = false; return; }
      if (g.value <= thr) { below += g.count; belowSats += g.count * g.value; }
    });
    var stack = ctx.stackSats;
    var pct = (stack !== null && stack > 0) ? plan.fee / stack * 100 : null;
    var net = stack !== null ? stack - plan.fee : null;
    var feasible = null;
    if (net !== null && plan.nIn > 0) feasible = net > 0 && Math.floor(net / ctx.nOut) >= coreDustLimit(ctx.outType);
    return {
      rate: rate, plan: plan, fee: plan.fee, feeBtc: plan.fee / SATS_PER_BTC, feeEur: satsToEur(plan.fee, ctx.price),
      pct: pct, level: shareLevel(pct), netSats: net, feasible: feasible,
      threshold: thr, thresholdEur: satsToEur(thr, ctx.price), singleSpend: singleSpendFee(ctx.type, rate),
      belowCount: belowKnown ? below : null, belowSats: belowKnown ? belowSats : null
    };
  }

  /* Gebührenraten, bei denen die Konsolidierung 1 %, 5 % bzw. 10 % des Bestands kostet (Näherung, linear). */
  function ratesForShare(stackSats, vsizeTotal, shares) {
    if (!(stackSats > 0) || !(vsizeTotal > 0)) return null;
    return shares.map(function (p) { return { pct: p, rate: stackSats * p / 100 / vsizeTotal }; });
  }

  /* ---------- Gesamtberechnung aus Roheingaben ---------- */

  function compute(raw) {
    var errors = {};
    function num(key, val, o) {
      if (isBlank(val)) { if (o.required) errors[key] = o.reqMsg || 'Bitte einen Wert eingeben'; return o.def === undefined ? null : o.def; }
      var n = parseNum(val);
      if (isNaN(n)) { errors[key] = 'Ungültige Zahl'; return null; }
      if (n < 0) { errors[key] = 'Negative Werte sind nicht erlaubt'; return null; }
      if (o.gt !== undefined && !(n > o.gt)) { errors[key] = 'Wert muss größer als ' + o.gt + ' sein'; return null; }
      if (o.min !== undefined && n < o.min) { errors[key] = 'Mindestens ' + o.min; return null; }
      if (o.max !== undefined && n > o.max) { errors[key] = 'Höchstens ' + o.max; return null; }
      if (o.int && Math.floor(n) !== n) { errors[key] = 'Bitte eine ganze Zahl eingeben'; return null; }
      return n;
    }

    var mode = raw.mode === 'custom' ? 'custom' : 'dca';
    var type = TYPES[raw.type] ? raw.type : 'p2wpkh';
    var outType = (raw.outType && raw.outType !== 'same' && TYPES[raw.outType]) ? raw.outType : type;
    var nOut = num('nOut', raw.nOut, { def: 1, min: 1, max: 100, int: true });
    var rateOpt = { required: true, min: 0.001, max: 100000 };
    var rate = num('feeRate', raw.feeRate, rateOpt);
    if (rate !== null) rate = rateMilli(rate) / 1000;
    var scenRates = (raw.scenarios || []).map(function (v, i) {
      var r = num('scen' + i, v, rateOpt);
      return r === null ? null : rateMilli(r) / 1000;
    });
    var price = num('price', raw.price, { gt: 0, max: 1e9 });
    var buyPrice = mode === 'dca' ? num('buyPrice', raw.buyPrice, { gt: 0, max: 1e9 }) : null;

    var groups = [], nIn = 0, stack = null, dca = null, invested = null, empty = false;

    if (mode === 'dca') {
      var amount = num('amount', raw.amount, { required: true, gt: 0, max: 1e7 });
      var years = num('years', raw.years, { required: true, gt: 0, max: 60 });
      var buyFee = num('buyFee', raw.buyFee, { def: 0, min: 0, max: 50 });
      var freq = ['weekly', 'biweekly', 'monthly'].indexOf(raw.frequency) >= 0 ? raw.frequency : 'weekly';
      if (amount !== null && years !== null) {
        var count = purchaseCount(freq, years);
        if (count < 1) errors.years = 'Zeitraum zu kurz für einen Kauf';
        else {
          var per = satsForEur(amount, buyPrice, buyFee || 0);
          if (per !== null && per < 1) errors.amount = 'Der Betrag ergibt weniger als 1 Sat';
          else {
            groups = [{ count: count, value: per }];
            nIn = count; invested = count * amount;
            stack = per === null ? null : per * count;
            dca = { frequency: freq, years: years, purchases: count, amountEur: amount, satsPerUtxo: per, invested: invested };
          }
        }
      }
    } else {
      var parsed = parseUtxoList(raw.list, raw.unit === 'btc' ? 'btc' : 'sats');
      if (parsed.errors.length) errors.list = parsed.errors.slice(0, 3).map(function (e) { return (e.line ? 'Zeile ' + e.line + ': ' : '') + e.msg; }).join(' · ');
      else { groups = parsed.groups; nIn = parsed.count; stack = parsed.stackSats; empty = nIn === 0; }
    }

    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var valuationPrice = price || buyPrice || null;
    var ctx = { groups: groups, nIn: nIn, stackSats: stack, type: type, outType: outType, nOut: nOut, price: valuationPrice };
    var main = analyze(ctx, rate);
    var scenarios = scenRates.map(function (r) { return analyze(ctx, r); });
    var dustByType = Object.keys(TYPES).map(function (id) {
      return { id: id, label: TYPES[id].label, inputVB: TYPES[id].inputWU / 4, threshold: dustThreshold(id, rate),
               thresholdEur: satsToEur(dustThreshold(id, rate), valuationPrice), singleSpend: singleSpendFee(id, rate), coreLimit: coreDustLimit(id) };
    });
    var avg = (stack !== null && nIn > 0) ? stack / nIn : null;

    return {
      ok: true, errors: errors, mode: mode, empty: empty, type: type, outType: outType, nOut: nOut, rate: rate,
      price: valuationPrice, priceIsBuyFallback: !price && !!buyPrice, hasPrice: !!valuationPrice,
      utxoCount: nIn, groups: groups, stackSats: stack, stackBtc: stack === null ? null : stack / SATS_PER_BTC,
      stackEur: satsToEur(stack, valuationPrice), avgSats: avg, dca: dca, investedEur: invested,
      main: main, scenarios: scenarios, dustByType: dustByType,
      dustRateForAvg: avg !== null ? dustRateForValue(type, avg) : null,
      shareRates: ratesForShare(stack, main.plan.vsize, [1, 5, 10])
    };
  }

  return {
    SATS_PER_BTC: SATS_PER_BTC, MAX_SATS: MAX_SATS, TYPES: TYPES, DUST_RELAY_FEE: DUST_RELAY_FEE,
    parseNum: parseNum, txWeight: txWeight, vsizeFromWeight: vsizeFromWeight, feeFor: feeFor,
    maxInputsPerTx: maxInputsPerTx, consolidationPlan: consolidationPlan, dustThreshold: dustThreshold,
    singleSpendFee: singleSpendFee, dustRateForValue: dustRateForValue, coreDustLimit: coreDustLimit,
    purchaseCount: purchaseCount, satsForEur: satsForEur, parseUtxoList: parseUtxoList, analyze: analyze,
    ratesForShare: ratesForShare, compute: compute, satsToEur: satsToEur
  };
}));
