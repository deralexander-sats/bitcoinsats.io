# bitcoinsats.io

Statische Seite für GitHub Pages. Kopfzeile, Menü und Footer liegen an **einer** Stelle und werden von GitHub Pages (Jekyll) beim Veröffentlichen in jede Seite eingesetzt. Die Besucher bekommen normales, fertiges HTML.

## Aufbau

| Datei / Ordner | Zweck |
|---|---|
| `_layouts/default.html` | Gemeinsames Grundgerüst jeder Seite: `<head>`, Kopfzeile, Inhalt, Footer, Skripte |
| `_includes/header.html` | Obere Leiste mit Logo, Hell/Dunkel-Schalter und Menü |
| `_includes/footer.html` | Footer |
| `_data/tools.yml` | Liste der Tools, daraus entstehen **Menüpunkte und Kacheln der Startseite** |
| `_config.yml` | Einstellungen (schließt `README.md` und `tests` von der Veröffentlichung aus) |
| `index.html`, `impressum.html`, `datenschutz.html`, `watchonly/index.html`, `tools/utxo-rechner/index.html` | Die Seiten. Sie enthalten nur noch den eigenen Inhalt |
| `tools/satoshi-quotes.html`, `404.html` | Bleiben eigenständige Dateien ohne Layout (Slider im iframe bzw. Weiterleitung) |
| `css/`, `js/`, `images/` | Wie bisher |

Ordner und Dateien mit führendem Unterstrich (`_…`) werden nicht veröffentlicht, sie sind nur Bausteine.

## Häufige Aufgaben

**Neues Tool hinzufügen**
1. Seite anlegen, z. B. `tools/mein-tool/index.html`, mit diesem Anfang (die Anführungszeichen sind wichtig):
   ```
   ---
   layout: default
   title: "Mein Tool | bitcoinsats.io"
   description: "Kurzbeschreibung für Suchmaschinen."
   canonical: /tools/mein-tool/
   ---
   <main>
     <h1>Mein Tool</h1>
     ...
   </main>
   ```
2. In `_data/tools.yml` einen Eintrag ergänzen (`title`, `url`, `text`). Menü und Startseite sind damit fertig.
3. Optional in `sitemap.xml` eintragen.

**Menü, Kopfzeile oder Footer ändern:** nur `_includes/header.html` bzw. `_includes/footer.html` bearbeiten. Die Änderung gilt für alle Seiten.

**Optionale Angaben im Seitenkopf (Front Matter):** `og_title`, `og_description` (falls abweichend von Titel/Beschreibung), `referrer: no-referrer`, `head_styles:` und `head_scripts:` (Listen von zusätzlichen CSS-/JS-Dateien für den `<head>`).

## Wichtig

- **Keine Datei `.nojekyll` anlegen.** Sie würde die Zusammensetzung der Seiten abschalten.
- GitHub Pages muss aus dem Branch veröffentlichen (Settings → Pages → „Deploy from a branch“). Das ist die Standardeinstellung.
- Im Seiteninhalt dürfen die Zeichenfolgen `{{` und `{%` nicht vorkommen (Jekyll würde sie als Befehl lesen). In JavaScript-Template-Strings wie `${x}` ist das kein Problem.
- Eine Seite ohne den Anfang `---` … `---` wird von Jekyll unverändert ausgeliefert (so bleiben `404.html` und `tools/satoshi-quotes.html` wie sie sind).

## Tests (lokal)

`node tests/utxo-core.test.js` prüft den Rechenkern des UTXO-Rechners.
