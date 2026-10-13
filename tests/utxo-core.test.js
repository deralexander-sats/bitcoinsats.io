/* Tests für js/utxo-core.js – Ausführen mit: node tests/utxo-core.test.js
 * Die Erwartungswerte sind von Hand bzw. aus einer unabhängigen Byte-für-Byte-Rechnung abgeleitet,
 * nicht aus dem Rechenkern übernommen. */
'use strict';
var assert = require('assert');
var C = require('../js/utxo-core.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function eq(a, b, msg) { assert.strictEqual(a, b, msg); }

/* ---- Unabhängige Referenz: Transaktion Byte für Byte aufbauen ---- */
function varint(n) { return n < 253 ? 1 : n <= 65535 ? 3 : 5; }
function refWeight(inType, nIn, outType, nOut) {
  var inp = {
    p2wpkh: { base: 36 + 1 + 0 + 4, wit: 1 + (1 + 72) + (1 + 33), seg: true },   // 41 / 108
    p2tr:   { base: 36 + 1 + 0 + 4, wit: 1 + (1 + 64), seg: true },              // 41 / 66
    p2pkh:  { base: 36 + 1 + (1 + 72 + 1 + 33) + 4, wit: 0, seg: false }         // 148
  }[inType];
  var outScript = { p2wpkh: 22, p2tr: 34, p2pkh: 25 }[outType];
  var nonWitness = 4 + varint(nIn) + nIn * inp.base + varint(nOut) + nOut * (8 + 1 + outScript) + 4;
  var witness = inp.seg ? 2 + nIn * inp.wit : 0;     // Marker+Flag, dann Witness je Input
  return nonWitness * 4 + witness;
}

console.log('Transaktionsgröße');
test('Byte-Referenz stimmt mit Kern überein (alle Typ-Kombinationen, 1–2000 Inputs, 1–5 Outputs)', function () {
  ['p2wpkh', 'p2pkh', 'p2tr'].forEach(function (t) {
    ['p2wpkh', 'p2pkh', 'p2tr'].forEach(function (o) {
      [1, 2, 10, 100, 252, 253, 700, 2000].forEach(function (n) {
        [1, 2, 5].forEach(function (k) {
          eq(C.txWeight(t, n, k, o), refWeight(t, n, o, k), t + '→' + o + ' n=' + n + ' k=' + k);
        });
      });
    });
  });
});
test('Referenzwerte 1-Input-1-Output: P2PKH 192, P2WPKH 109,5 (→110), P2TR 111 vB', function () {
  eq(C.txWeight('p2pkh', 1, 1), 768);
  eq(C.txWeight('p2wpkh', 1, 1), 438);
  eq(C.txWeight('p2tr', 1, 1), 444);
  eq(C.vsizeFromWeight(768), 192); eq(C.vsizeFromWeight(438), 110); eq(C.vsizeFromWeight(444), 111);
});
test('10 P2WPKH-Inputs → 2886 WU = 722 vB; 100 → 27366 WU = 6842 vB', function () {
  eq(C.txWeight('p2wpkh', 10, 1), 2886); eq(C.vsizeFromWeight(2886), 722);
  eq(C.txWeight('p2wpkh', 100, 1), 27366); eq(C.vsizeFromWeight(27366), 6842);
});
test('10 P2PKH → 1524 vB, 10 P2TR → 629 vB', function () {
  eq(C.vsizeFromWeight(C.txWeight('p2pkh', 10, 1)), 1524);
  eq(C.vsizeFromWeight(C.txWeight('p2tr', 10, 1)), 629);
});
test('Input-Zähler ab 253 braucht 3-Byte-Varint (+2 vB)', function () {
  eq(C.txWeight('p2wpkh', 253, 1) - C.txWeight('p2wpkh', 252, 1), 272 + 8);
});
test('Mehr Outputs vergrößern die Transaktion', function () {
  eq(C.txWeight('p2wpkh', 10, 3) - C.txWeight('p2wpkh', 10, 1), 2 * 124);
  eq(C.txWeight('p2wpkh', 10, 1, 'p2tr') - C.txWeight('p2wpkh', 10, 1, 'p2wpkh'), 172 - 124);
});

console.log('Gebühren');
test('Aufrundung auf ganze Sats', function () {
  eq(C.feeFor(110, 10), 1100);
  eq(C.feeFor(722, 10), 7220);
  eq(C.feeFor(722, 1.5), 1083);
  eq(C.feeFor(110, 0.123), 14);        // 13,53
  eq(C.feeFor(110, 0.1), 11);          // darf nicht durch Gleitkomma auf 12 springen
  eq(C.feeFor(1, 0.001), 1);
  eq(C.feeFor(721, 1), 721);
});
test('Plan: 1, 10 und 100 UTXOs bei 10 sat/vB (P2WPKH)', function () {
  eq(C.consolidationPlan('p2wpkh', 1, 1, 'p2wpkh', 10).fee, 1100);
  eq(C.consolidationPlan('p2wpkh', 10, 1, 'p2wpkh', 10).fee, 7220);
  eq(C.consolidationPlan('p2wpkh', 100, 1, 'p2wpkh', 10).fee, 68420);
});
test('Leerer Bestand kostet nichts', function () {
  var p = C.consolidationPlan('p2wpkh', 0, 1, 'p2wpkh', 50);
  eq(p.fee, 0); eq(p.vsize, 0); eq(p.txCount, 0);
});
test('Aufteilung bei Überschreiten von 400.000 WU', function () {
  eq(C.maxInputsPerTx('p2wpkh', 1, 'p2wpkh'), 1469);
  eq(C.maxInputsPerTx('p2pkh', 1, 'p2pkh'), 675);
  assert.ok(C.txWeight('p2wpkh', 1469, 1) <= 400000 && C.txWeight('p2wpkh', 1470, 1) > 400000);
  assert.ok(C.txWeight('p2pkh', 675, 1) <= 400000 && C.txWeight('p2pkh', 676, 1) > 400000);
  var p = C.consolidationPlan('p2wpkh', 3000, 1, 'p2wpkh', 10);
  eq(p.txCount, 3); eq(p.split, true);
  var expected = 2 * C.feeFor(C.vsizeFromWeight(C.txWeight('p2wpkh', 1469, 1)), 10) + C.feeFor(C.vsizeFromWeight(C.txWeight('p2wpkh', 62, 1)), 10);
  eq(p.fee, expected);
  eq(C.consolidationPlan('p2wpkh', 1469, 1, 'p2wpkh', 10).txCount, 1);
  eq(C.consolidationPlan('p2wpkh', 1470, 1, 'p2wpkh', 10).txCount, 2);
});
test('Gebühr steigt monoton mit Rate, Inputs und teurerem Adresstyp', function () {
  var last = -1;
  [0.5, 1, 2, 5, 10, 50, 150, 1000].forEach(function (r) {
    var f = C.consolidationPlan('p2wpkh', 40, 1, 'p2wpkh', r).fee; assert.ok(f > last); last = f;
  });
  assert.ok(C.consolidationPlan('p2pkh', 40, 1, 'p2pkh', 10).fee > C.consolidationPlan('p2wpkh', 40, 1, 'p2wpkh', 10).fee);
  assert.ok(C.consolidationPlan('p2tr', 40, 1, 'p2tr', 10).fee < C.consolidationPlan('p2wpkh', 40, 1, 'p2wpkh', 10).fee);
});

console.log('Dust');
test('Wirtschaftlicher Schwellenwert = Input-vByte × Rate (aufgerundet)', function () {
  eq(C.dustThreshold('p2wpkh', 10), 680);
  eq(C.dustThreshold('p2pkh', 10), 1480);
  eq(C.dustThreshold('p2tr', 10), 575);
  eq(C.dustThreshold('p2tr', 1), 58);     // 57,5
  eq(C.dustThreshold('p2wpkh', 1), 68);
  eq(C.dustThreshold('p2wpkh', 150), 10200);
});
test('Einzelausgabe-Gebühr inkl. Overhead', function () {
  eq(C.singleSpendFee('p2wpkh', 10), 1100);
  eq(C.singleSpendFee('p2pkh', 10), 1920);
  eq(C.singleSpendFee('p2tr', 10), 1110);
});
test('Dust-Relay-Limit von Bitcoin Core: 546 / 294 / 330 Sats', function () {
  eq(C.coreDustLimit('p2pkh'), 546); eq(C.coreDustLimit('p2wpkh'), 294); eq(C.coreDustLimit('p2tr'), 330);
});
test('Rate, ab der ein UTXO unwirtschaftlich wird', function () {
  assert.ok(Math.abs(C.dustRateForValue('p2wpkh', 10000) - 147.0588) < 1e-3);
  assert.ok(Math.abs(C.dustRateForValue('p2wpkh', 680) - 10) < 1e-9);
});

console.log('DCA');
test('Anzahl der Käufe', function () {
  eq(C.purchaseCount('weekly', 1), 52); eq(C.purchaseCount('weekly', 5), 260); eq(C.purchaseCount('weekly', 10), 521);
  eq(C.purchaseCount('biweekly', 1), 26); eq(C.purchaseCount('biweekly', 3), 78);
  eq(C.purchaseCount('monthly', 1), 12); eq(C.purchaseCount('monthly', 10), 120); eq(C.purchaseCount('monthly', 0.5), 6);
  eq(C.purchaseCount('monthly', 0.05), 0);
});
test('Sats pro Kauf werden abgerundet und sind gleitkommasicher', function () {
  eq(C.satsForEur(50, 60000, 0), 83333);
  eq(C.satsForEur(60, 60000, 0), 100000);
  eq(C.satsForEur(100, 100000, 0), 100000);
  eq(C.satsForEur(100, 100000, 1), 99000);
  eq(C.satsForEur(10, 0, 0), null);
});

console.log('Parser');
test('Beträge in Sats und BTC, Mengen-Schreibweise', function () {
  var r = C.parseUtxoList('10 x 50.000\n100000\n3×1.500 # Kommentar\n\n', 'sats');
  eq(r.errors.length, 0); eq(r.count, 14); eq(r.stackSats, 500000 + 100000 + 4500);
  var b = C.parseUtxoList('0,0015\n2 x 0.001\n1', 'btc');
  eq(b.errors.length, 0); eq(b.stackSats, 150000 + 200000 + 100000000);
});
test('Ungültige und negative Eingaben liefern Fehler mit Zeilennummer', function () {
  var r = C.parseUtxoList('abc\n-5\n0\n1,5\n0 x 100\n123', 'sats');
  eq(r.errors.length, 5);
  eq(r.errors[0].line, 1); eq(r.errors[1].line, 2); eq(r.errors[2].line, 3); eq(r.errors[3].line, 4); eq(r.errors[4].line, 5);
  assert.ok(C.parseUtxoList('0,123456789', 'btc').errors.length === 1);
  assert.ok(C.parseUtxoList('21000001', 'btc').errors.length === 1);
  eq(C.parseUtxoList('', 'sats').count, 0);
});
test('Zahleneingabe deutsch', function () {
  eq(C.parseNum('60.000'), 60000); eq(C.parseNum('1.234,5'), 1234.5); eq(C.parseNum('0,5'), 0.5); eq(C.parseNum('12.5'), 12.5);
  assert.ok(isNaN(C.parseNum('abc'))); assert.ok(isNaN(C.parseNum('1e5'))); assert.ok(isNaN(C.parseNum('')));
  assert.ok(isNaN(C.parseNum('--3')));
});

console.log('Gesamtberechnung (compute)');
function base(o) {
  var r = { mode: 'dca', amount: '50', frequency: 'weekly', years: '5', buyPrice: '60000', price: '60000', buyFee: '0',
            feeRate: '10', type: 'p2wpkh', outType: 'same', nOut: '1', scenarios: ['2', '10', '50', '150'], list: '', unit: 'sats' };
  for (var k in o) r[k] = o[k];
  return r;
}
test('DCA 50 € wöchentlich, 5 Jahre, 60.000 €/BTC, 10 sat/vB', function () {
  var r = C.compute(base());
  eq(r.ok, true); eq(r.utxoCount, 260); eq(r.investedEur, 13000);
  eq(r.dca.satsPerUtxo, 83333); eq(r.stackSats, 260 * 83333);
  eq(r.main.plan.vsize, C.vsizeFromWeight(refWeight('p2wpkh', 260, 'p2wpkh', 1)));   // 70.894 WU (inkl. 3-Byte-Varint)
  eq(r.main.plan.vsize, 17724);
  eq(r.main.fee, 177240);
  assert.ok(Math.abs(r.main.pct - 177240 / (260 * 83333) * 100) < 1e-9);
  eq(r.main.threshold, 680); eq(r.main.belowCount, 0);
  assert.ok(Math.abs(r.main.feeEur - 177240 * 60000 / 1e8) < 1e-9);
});
test('Szenarien: 100 × 10.000 Sats (Beispiel 34,21 % bei 50 sat/vB)', function () {
  var r = C.compute(base({ mode: 'custom', list: '100 x 10000', scenarios: ['2', '10', '50', '150'], feeRate: '50' }));
  eq(r.ok, true); eq(r.utxoCount, 100); eq(r.stackSats, 1000000);
  eq(r.main.fee, 342100);
  assert.ok(Math.abs(r.main.pct - 34.21) < 1e-9); eq(r.main.level, 'sehr hoch');
  eq(r.scenarios[0].fee, 6842 * 2); eq(r.scenarios[1].fee, 68420);
  eq(r.scenarios[2].belowCount, 0);            // Schwelle 3.400 < 10.000
  eq(r.scenarios[3].threshold, 10200); eq(r.scenarios[3].belowCount, 100); // 10.000 <= 10.200 → unwirtschaftlich
  eq(r.scenarios[3].fee, 6842 * 150); eq(r.scenarios[3].feasible, false);   // Gebühr 1.026.300 > Bestand
  assert.ok(r.scenarios[0].pct < r.scenarios[1].pct && r.scenarios[1].pct < r.scenarios[2].pct);
});
test('Einzelner UTXO, zehn gleich große UTXOs', function () {
  var one = C.compute(base({ mode: 'custom', list: '250000' }));
  eq(one.utxoCount, 1); eq(one.main.fee, 1100); eq(one.main.feasible, true);
  var ten = C.compute(base({ mode: 'custom', list: '10 x 100000' }));
  eq(ten.utxoCount, 10); eq(ten.main.fee, 7220); eq(ten.stackSats, 1000000);
  assert.ok(Math.abs(ten.main.pct - 0.722) < 1e-9); eq(ten.main.level, 'gering');
});
test('Alle Adresstypen, auch gemischt (Taproot-Ziel)', function () {
  eq(C.compute(base({ mode: 'custom', list: '10 x 100000', type: 'p2pkh' })).main.fee, 15240);
  eq(C.compute(base({ mode: 'custom', list: '10 x 100000', type: 'p2tr' })).main.fee, 6290);
  var mix = C.compute(base({ mode: 'custom', list: '10 x 100000', type: 'p2wpkh', outType: 'p2tr' }));
  eq(mix.main.plan.vsize, C.vsizeFromWeight(42 + 2720 + 172)); eq(mix.main.fee, 7340);
});
test('Sehr kleine UTXOs: Ausgabekosten übersteigen den Wert', function () {
  var r = C.compute(base({ mode: 'custom', list: '100 x 500', feeRate: '10' }));
  eq(r.main.threshold, 680); eq(r.main.belowCount, 100); eq(r.main.belowSats, 50000);
  eq(r.main.fee, 68420); eq(r.main.feasible, false); // Gebühr > Bestand
});
test('Leerer Bestand', function () {
  var r = C.compute(base({ mode: 'custom', list: '' }));
  eq(r.ok, true); eq(r.empty, true); eq(r.utxoCount, 0); eq(r.main.fee, 0); eq(r.main.pct, null);
  var r2 = C.compute(base({ mode: 'custom', list: '# nur Kommentar\n\n' }));
  eq(r2.empty, true);
});
test('DCA ohne Kurs: Anzahl und Gebühr in Sats vorhanden, Euro-Werte fehlen', function () {
  var r = C.compute(base({ buyPrice: '', price: '' }));
  eq(r.ok, true); eq(r.stackSats, null); eq(r.stackEur, null); eq(r.main.feeEur, null); eq(r.main.pct, null);
  eq(r.main.fee, 177240); eq(r.hasPrice, false);
});
test('Aktueller Kurs fehlt → Kaufkurs wird verwendet und gekennzeichnet', function () {
  var r = C.compute(base({ price: '' }));
  eq(r.price, 60000); eq(r.priceIsBuyFallback, true);
  var r2 = C.compute(base({ price: '90000' }));
  eq(r2.price, 90000); eq(r2.priceIsBuyFallback, false);
  assert.ok(Math.abs(r2.stackEur - r2.stackSats * 90000 / 1e8) < 1e-9);
});
test('Ungültige und negative Eingaben werden abgefangen (kein NaN, keine Division durch 0)', function () {
  [
    [{ amount: '-5' }, 'amount'], [{ amount: '0' }, 'amount'], [{ amount: 'abc' }, 'amount'], [{ amount: '' }, 'amount'],
    [{ years: '0' }, 'years'], [{ years: '-1' }, 'years'], [{ years: '0.01' }, 'years'], [{ years: '100' }, 'years'],
    [{ feeRate: '0' }, 'feeRate'], [{ feeRate: '-3' }, 'feeRate'], [{ feeRate: 'x' }, 'feeRate'], [{ feeRate: '' }, 'feeRate'],
    [{ buyPrice: '0' }, 'buyPrice'], [{ buyPrice: '-1' }, 'buyPrice'], [{ price: '0' }, 'price'], [{ price: 'abc' }, 'price'],
    [{ nOut: '0' }, 'nOut'], [{ nOut: '1.5' }, 'nOut'], [{ buyFee: '60' }, 'buyFee'], [{ scenarios: ['2', '', '50', '150'] }, 'scen1'],
    [{ amount: '0,00001', buyPrice: '1000000000' }, 'amount']
  ].forEach(function (c) {
    var r = C.compute(base(c[0]));
    eq(r.ok, false, JSON.stringify(c[0])); assert.ok(r.errors[c[1]], 'Fehler für ' + c[1] + ' erwartet bei ' + JSON.stringify(c[0]));
  });
  var bad = C.compute(base({ mode: 'custom', list: 'foo' }));
  eq(bad.ok, false); assert.ok(bad.errors.list);
});
test('Ergebnisse enthalten nie NaN oder Infinity', function () {
  function scan(o, path) {
    if (typeof o === 'number') assert.ok(isFinite(o), 'nicht endlich bei ' + path);
    else if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { scan(o[k], path + '.' + k); });
  }
  [base(), base({ mode: 'custom', list: '' }), base({ mode: 'custom', list: '3 x 1' }), base({ type: 'p2tr', nOut: '3' }),
   base({ mode: 'custom', list: '5000 x 546', feeRate: '0,001' }), base({ buyPrice: '', price: '' }),
   base({ mode: 'custom', list: '1 x 2100000000000000', unit: 'sats' })].forEach(function (raw, i) { scan(C.compute(raw), 'case' + i); });
});
test('Gebührenrate wird auf 3 Nachkommastellen normiert, Sonderfälle kleiner Raten', function () {
  var r = C.compute(base({ mode: 'custom', list: '10000', feeRate: '0,1' }));
  eq(r.rate, 0.1); eq(r.main.fee, 11);
  eq(C.compute(base({ feeRate: '1.23456' })).rate, 1.235);
});
test('Anteil-Raten: Gebühr 1/5/10 % des Bestands', function () {
  var r = C.compute(base({ mode: 'custom', list: '10 x 100000' }));
  var s = r.shareRates; eq(s.length, 3);
  assert.ok(Math.abs(s[0].rate - 1000000 * 0.01 / 722) < 1e-9);
  assert.ok(s[0].rate < s[1].rate && s[1].rate < s[2].rate);
});

console.log('\n' + passed + ' bestanden, ' + failed + ' fehlgeschlagen');
process.exit(failed ? 1 : 0);
