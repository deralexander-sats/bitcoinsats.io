# Bitcoin-Chart mit 200-Wochen-Durchschnitt

Reines HTML/CSS/JavaScript, keine Bibliotheken, kein Backend. Erreichbar unter `/tools/bitcoin-chart/` und als Block auf der Startseite direkt vor den Tools.

## Dateien

```
_includes/btc-chart.html          Einbindung: {% include btc-chart.html %}
tools/bitcoin-chart/
├── index.html                    eigene Seite (Layout default)
├── btc-chart.css                 Stile (Namensraum .btcc), Farben aus css/style.css
├── js/btc-calc.js                Berechnung (200WMA, Abstand), ohne DOM
├── js/btc-data.js                Datenabruf (Kraken), Cache, Fehlerbehandlung
├── js/btc-chart.js               Darstellung (Canvas), Tooltip, Touch
├── js/btc-app.js                 Steuerung, Zeiträume, USD/EUR
└── tests/btc-calc.test.js        Formeltests (node tests/btc-calc.test.js), wird nicht veröffentlicht
```

Zusätzlich geändert: `index.html` (Chart vor „Tools“), `_data/tools.yml` (Menüpunkt + Kachel), `sitemap.xml`, `datenschutz.html` (Abschnitt zu Kraken), `_config.yml` (Tests/README nicht veröffentlichen).

## Datenquelle und Berechnung

Kraken Public API, Paare XBT/USD (Standard) und XBT/EUR. Wochenkerzen (`interval=10080`) für die 200WMA und Zeiträume ab 2 Jahren, Tageskerzen (`interval=1440`) für 1M bis 1J, Ticker für den Live-Kurs (alle 60 s). Kraken liefert höchstens 720 Kerzen je Abruf: Wochenhistorie ab ca. 2013, die 200WMA beginnt wegen der 200 nötigen Wochen ca. 2017.

200WMA = einfacher Durchschnitt der letzten 200 Wochenschlusskurse, immer über die gesamte Wochenhistorie berechnet (unabhängig vom Zeitraum). Die laufende Woche geht mit dem aktuellen Kurs ein. Lücken werden nie überbrückt, nichts wird interpoliert oder aufgefüllt. Abstand in % = (Kurs / 200WMA − 1) × 100.

Cache im Browser (Wochenkerzen 1 h, Tageskerzen 15 min, je Währung), veraltete Daten werden bei Netzausfall weiter angezeigt. Abrufe laufen ohne Referrer.

## Farben

Der Chart nutzt die Variablen aus `css/style.css` (`--surface`, `--ink`, `--mu`, `--line`, `--ac`, `--on-ac`, `--in`, `--out`). Die 200WMA hat die Farbe `--ac` (im hellen Modus dunkles Anthrazit, im dunklen Modus Weiß), der Kurs das Bitcoin-Orange `#F7931A`. Hell/Dunkel folgt automatisch dem `data-theme` am `<html>`-Element.

## Einbinden auf weiteren Seiten

Im Front Matter der Seite:

```yaml
head_styles:
  - "/tools/bitcoin-chart/btc-chart.css"
```

und an der gewünschten Stelle `{% include btc-chart.html %}`.
