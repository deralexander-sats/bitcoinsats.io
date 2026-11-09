# Bitcoin-Preischart mit 200-Wochen-Durchschnitt

Eigenständiges Tool für bitcoinsats.io unter `/tools/bitcoin-chart/`. Reines HTML/CSS/JavaScript, keine Bibliotheken, kein Backend.

## Dateien

```
tools/bitcoin-chart/
├── index.html            Seite (bindet /css/style.css und den Chart ein)
├── btc-chart.css         Alle Chart-Stile, Namensraum .btcc, Hell/Dunkel
├── js/
│   ├── btc-calc.js       Berechnung: Bereinigung, 200WMA, Abstand, Nachschlagen (rein, ohne DOM)
│   ├── btc-data.js       Datenbeschaffung: Kraken-API, Cache, Wiederholungen, Fehler
│   ├── btc-chart.js      Darstellung: Canvas-Chart, Achsen, Fadenkreuz, Tooltip, Touch
│   └── btc-app.js        Steuerung: Oberfläche, Zeiträume, Kennzahlen, Live-Aktualisierung
└── tests/
    └── btc-calc.test.js  Formeltests (`node tests/btc-calc.test.js`), nicht für den Server nötig
```

Es wurden keine bestehenden Dateien der Seite verändert.

## Datenquelle

Kraken Public API (kostenlos, kein Schlüssel, aus dem Browser abrufbar), Handelspaar XBT/EUR:

| Zweck | Abruf | Umfang |
|---|---|---|
| 200WMA und Zeiträume ab 2 Jahren | `OHLC?pair=XBTEUR&interval=10080` (Wochenkerzen) | max. 720 Wochen, ca. ab 2013 |
| Zeiträume 1M, 3M, 6M, 1J | `OHLC?pair=XBTEUR&interval=1440` (Tageskerzen) | max. 720 Tage |
| aktueller Kurs | `Ticker?pair=XBTEUR` | alle 60 s, nur bei sichtbarem Tab |

Robustheit: 12 s Timeout, bis zu 2 Wiederholungen mit Wartezeit (bei Rate-Limit/Serverfehlern), Cache im Browser (Wochenkerzen 1 h, Tageskerzen 15 min). Ist der Cache veraltet, werden die alten Daten sofort gezeigt und im Hintergrund erneuert; fällt das Netz aus, bleiben die Cache-Daten sichtbar, mit Hinweis. Ohne Wochendaten und ohne Cache erscheint eine Fehlermeldung mit „Erneut versuchen“. Der Live-Kurs ist optional: schlägt er fehl, gilt der letzte Kerzenschluss.

## So wird die 200WMA berechnet

1. Grundlage sind echte Wochenkerzen von Kraken. Die erste Kerze der Reihe wird verworfen (kann unvollständig sein), Duplikate und ungültige Werte werden entfernt. Gibt es eine Lücke von mehr als einer Woche, wird nur der letzte lückenlose Abschnitt verwendet, damit nie über fehlende Wochen gemittelt wird.
2. Pro Woche zählt der Schlusskurs. Für jede Woche gilt: Mittelwert der Schlusskurse dieser und der 199 Wochen davor (einfacher gleitender Durchschnitt über 200 Wochen). Davor gibt es keine Werte, es wird nichts aufgefüllt oder extrapoliert.
3. Die laufende, noch nicht abgeschlossene Woche geht mit dem aktuellen Kurs ein (so rechnen auch gängige 200WMA-Anzeigen). Sie ist im Tooltip als „Aktuell“ gekennzeichnet.
4. Die Berechnung läuft immer über die gesamte Wochenhistorie, unabhängig vom gewählten Zeitraum. Die Zeiträume schneiden nur den sichtbaren Ausschnitt.
5. Abstand = Kurs − 200WMA, in Prozent = (Kurs / 200WMA − 1) × 100.

Der Tooltip zeigt für einen Zeitpunkt den 200WMA-Wert der letzten abgeschlossenen Woche (keine Interpolation zwischen Wochen).

## Einbindung

Auf einer beliebigen Seite genügt:

```html
<link rel="stylesheet" href="/tools/bitcoin-chart/btc-chart.css">
<div data-btc-chart></div>
<script src="/tools/bitcoin-chart/js/btc-calc.js" defer></script>
<script src="/tools/bitcoin-chart/js/btc-data.js" defer></script>
<script src="/tools/bitcoin-chart/js/btc-chart.js" defer></script>
<script src="/tools/bitcoin-chart/js/btc-app.js" defer></script>
```

Die mitgelieferte `index.html` ist so aufgebaut. Dort fehlt noch die zentrale Kopfzeile/das Menü: den Platzhalter-Kommentar im `<body>` durch das gemeinsame Header-Fragment ersetzen und im Menü einen Eintrag auf `/tools/bitcoin-chart/` anlegen.

## Voraussetzungen und Anpassungen

- **Dateien hochladen:** den Ordner `tools/bitcoin-chart/` so ablegen, dass er unter `/tools/bitcoin-chart/` erreichbar ist (wie `/tools/utxo-rechner/`).
- **Content-Security-Policy:** falls vorhanden, muss `connect-src` die Adresse `https://api.kraken.com` erlauben.
- **Hell/Dunkel:** der Chart folgt `prefers-color-scheme` sowie `data-theme="dark"`, `.dark` oder `data-bs-theme="dark"` am `<html>`-Element. Nutzt die Seite einen anderen Umschalter, die Selektoren im Block „Dunkel“ in `btc-chart.css` anpassen.
- **Farben/Variablen:** alle Farben stehen als `--btcc-*` oben in `btc-chart.css` und können auf die Variablen von `/css/style.css` verweisen.
- **Grenzen der Quelle:** Kraken liefert höchstens 720 Kerzen pro Abruf. Die Wochenhistorie reicht daher bis etwa 2013 zurück; die 200WMA beginnt wegen der 200 nötigen Wochen entsprechend ca. 2017. „Max“ zeigt diese verfügbare Historie.
- **Ladehäufigkeit:** Die Kraken-API erlaubt öffentliche Abrufe mit moderater Rate; durch Cache und 60-s-Takt bleibt jeder Besucher weit darunter. Bei sehr hohem Besucheraufkommen wäre ein eigener Cache-Endpunkt auf dem Server sinnvoll.

## Prüfstand

- Berechnungsmodul: 12 Formeltests bestanden (u. a. 200WMA-Mittelwerte, Lücken, laufende Woche, Beispiel +72,7 %).
- Oberfläche: in Headless-Chrome mit nachgestellten Kraken-Antworten geprüft (Desktop, 390 px breit, Hell/Dunkel, alle neun Zeiträume, Log-Schalter, Tooltip, Fehlerzustand).
- **Nicht geprüft:** der Abruf gegen die echte Kraken-API. In der Entwicklungsumgebung war der Zugriff gesperrt. Das Antwortformat folgt der Kraken-Dokumentation; bitte nach dem Hochladen einmal im Browser prüfen (Entwicklertools, Reiter „Netzwerk“).
