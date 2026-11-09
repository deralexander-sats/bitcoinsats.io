// Formeltests für btc-calc.js (Node: node tests/btc-calc.test.js)
// Hinweis: Die Testreihen sind künstliche Zahlen NUR zur Prüfung der Mathematik;
// sie werden nirgends im Chart angezeigt.
'use strict';
const assert = require('assert');
const C = require('../js/btc-calc.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  - ' + name); }

const W = C.WEEK_MS;
const T0 = Date.UTC(2020, 0, 2); // beliebiger Wochenstart

function weeks(n, f) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ t: T0 + i * W, c: f(i) });
  return a;
}

test('sma: null vor Periode, exakte Mittelwerte danach', () => {
  const r = C.sma([1, 2, 3, 4, 5], 3);
  assert.deepStrictEqual(r, [null, null, 2, 3, 4]);
});

test('200WMA: Reihe 1..300 -> erster Wert 100,5, letzter 200,5', () => {
  const pts = weeks(300, i => i + 1).map(k => ({ t: k.t + W, c: k.c, provisional: false }));
  const w = C.wma(pts, 200);
  assert.strictEqual(w.length, 101);
  assert.strictEqual(w[0].v, 100.5);   // Mittel von 1..200
  assert.strictEqual(w[100].v, 200.5); // Mittel von 101..300
});

test('200WMA: weniger als 200 Wochen -> keine Werte (keine Extrapolation)', () => {
  const pts = weeks(199, () => 10).map(k => ({ t: k.t, c: k.c, provisional: false }));
  assert.strictEqual(C.wma(pts, 200).length, 0);
});

test('cleanCandles: sortiert, entfernt Duplikate und ungültige Werte', () => {
  const raw = [
    { t: T0 + 2 * W, c: 3 }, { t: T0, c: 1 }, { t: T0 + W, c: 2 },
    { t: T0 + W, c: 99 }, { t: T0 + 3 * W, c: NaN }, { t: T0 + 4 * W, c: -5 }
  ];
  const r = C.cleanCandles(raw, W);
  assert.deepStrictEqual(r.map(k => k.c), [1, 2, 3]);
});

test('cleanCandles: Lücke beendet den Abschnitt, nur der letzte lückenlose Teil bleibt', () => {
  const raw = [
    { t: T0, c: 1 }, { t: T0 + W, c: 2 },
    { t: T0 + 5 * W, c: 6 }, { t: T0 + 6 * W, c: 7 }, { t: T0 + 7 * W, c: 8 }
  ];
  const r = C.cleanCandles(raw, W);
  assert.deepStrictEqual(r.map(k => k.c), [6, 7, 8]);
});

test('cleanCandles: dropFirst verwirft die erste (evtl. unvollständige) Kerze', () => {
  const r = C.cleanCandles(weeks(5, i => i + 1), W, { dropFirst: true });
  assert.deepStrictEqual(r.map(k => k.c), [2, 3, 4, 5]);
});

test('toPoints: laufende Woche wird vorläufiger Punkt mit Live-Kurs bei "jetzt"', () => {
  const candles = weeks(3, i => 100 + i);          // 3 Wochen
  const now = candles[2].t + 2 * C.DAY_MS;         // mitten in der 3. Woche
  const pts = C.toPoints(candles, W, now, 555);
  assert.strictEqual(pts.length, 3);
  assert.strictEqual(pts[0].provisional, false);
  assert.strictEqual(pts[0].t, candles[0].t + W);
  assert.strictEqual(pts[2].provisional, true);
  assert.strictEqual(pts[2].t, now);
  assert.strictEqual(pts[2].c, 555);
});

test('toPoints: ohne Live-Kurs gilt der letzte Kerzenschluss', () => {
  const candles = weeks(2, i => 10 + i);
  const now = candles[1].t + C.DAY_MS;
  const pts = C.toPoints(candles, W, now, NaN);
  assert.strictEqual(pts[1].c, 11);
});

test('gap: +72,7 % Beispiel aus dem Auftrag', () => {
  const g = C.gap(95000, 55000);
  assert.strictEqual(g.abs, 40000);
  assert.strictEqual(g.pct.toFixed(1), '72.7');
});

test('gap: negativer Abstand und ungültige Eingaben', () => {
  assert.strictEqual(C.gap(50, 100).pct, -50);
  assert.strictEqual(C.gap(50, 0), null);
  assert.strictEqual(C.gap(NaN, 10), null);
});

test('atOrBefore / nearestIndex: keine Interpolation, korrekte Grenzen', () => {
  const l = [{ t: 10 }, { t: 20 }, { t: 30 }];
  assert.strictEqual(C.atOrBefore(l, 5), null);
  assert.strictEqual(C.atOrBefore(l, 10).t, 10);
  assert.strictEqual(C.atOrBefore(l, 29).t, 20);
  assert.strictEqual(C.atOrBefore(l, 99).t, 30);
  assert.strictEqual(C.nearestIndex(l, 14), 0);
  assert.strictEqual(C.nearestIndex(l, 16), 1);
  assert.strictEqual(C.nearestIndex(l, 1000), 2);
});

test('buildSeries: Ende-zu-Ende mit 260 Wochen, 200WMA unabhängig vom Anzeigezeitraum', () => {
  const raw = weeks(260, i => 100 + i);
  const now = raw[259].t + 3 * C.DAY_MS; // letzte Kerze läuft noch
  const s = C.buildSeries(raw, [], 1000, now);
  // erste Kerze verworfen -> 259 Punkte, davon der letzte vorläufig
  assert.strictEqual(s.weekly.length, 259);
  assert.strictEqual(s.weekly[258].provisional, true);
  assert.strictEqual(s.weekly[258].c, 1000);
  // WMA-Werte ab Index 199 -> 60 Werte
  assert.strictEqual(s.wma.length, 60);
  // letzter Wert: 199 Schlusskurse (Index 59..257 = 159..357? -> Kerzen 60..258 der Rohreihe) + Live-Kurs
  const expectedCloses = [];
  for (let i = 60; i <= 258; i++) expectedCloses.push(100 + i); // 199 abgeschlossene Wochen
  expectedCloses.push(1000);
  const expected = expectedCloses.reduce((a, b) => a + b, 0) / 200;
  assert.ok(Math.abs(s.latest.wma - expected) < 1e-9, 'letzter 200WMA-Wert');
  assert.strictEqual(s.latest.price, 1000);
  assert.ok(Math.abs(s.latest.gap.pct - (1000 / expected - 1) * 100) < 1e-9);
});

console.log('\n' + passed + ' Tests bestanden.');
