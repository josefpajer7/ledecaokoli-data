# ledecaokoli-data

Data pro portál **Ledeč a okolí** (ledecaokoli.cz). Každé ráno je sem automaticky stahuje GitHub Actions a web si je odsud načítá přímo v prohlížeči — na Netlify se kvůli tomu nic znovu nenasazuje.

## Co tu je

| Soubor | Obsah | Zdroj |
|---|---|---|
| `data/akce.json` | nadcházející a probíhající akce | [ledecsko.cz/akce](https://www.ledecsko.cz/akce/) |
| `data/deska.json` | výběr z úřední desky (bez dotačních smluv a rozpočtových opatření) | [úřední deska města](https://www.ledecns.cz/cs/mestsky-urad/elektronicka-uredni-deska/aktualni-oznameni.html) |
| `data/aktuality.json` | posledních 20 aktualit města | [ledecns.cz](https://www.ledecns.cz) |
| `data/meta.json` | kdy a jak dopadlo poslední stahování | — |

## Jak to běží

- **Automaticky** každý den v 6:00 (v zimě v 5:00).
- **Ručně:** záložka *Actions* → *Aktualizace dat* → *Run workflow*.
- Když zdroj selže nebo nevrátí nic, jeho soubor se **nepřepíše** a web dál ukazuje poslední funkční data. GitHub o selhání pošle e-mail.

## Úpravy

Vše je ve skriptu `scripts/update.mjs`:

- `DESKA_EXCLUDE` — co z úřední desky nezobrazovat
- `DESKA_TAGS` — štítky položek desky (Volby, Doprava, Majetek…)
- `NEWS_CATS` — které aktuality jdou do vývěsky jako Doprava / Odstávka / Úřad
