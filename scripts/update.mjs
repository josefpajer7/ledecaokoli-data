// Stahuje data pro portál ledecaokoli.cz a ukládá je do složky data/.
// Spouští se denně přes GitHub Actions. Nemá žádné závislosti, stačí Node 20+.
//
// Zdroje:
//   akce       – kalendář infocentra ledecsko.cz (The Events Calendar: REST API, záložně iCal)
//   deska      – elektronická úřední deska města ledecns.cz
//   aktuality  – aktuality na webu města ledecns.cz
//
// Pojistka: když zdroj selže nebo vrátí nulu položek, soubor se NEPŘEPÍŠE
// a web dál ukazuje data z posledního úspěšného běhu.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const DATA_DIR = new URL("../data/", import.meta.url);
const DEBUG_DIR = new URL("../debug/", import.meta.url);
const DEBUG = process.env.DEBUG === "1";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 ledecaokoli.cz-bot";

const SRC = {
  tecApi: "https://www.ledecsko.cz/wp-json/tribe/events/v1/events",
  ical: [
    "https://www.ledecsko.cz/akce/?ical=1",
    "https://www.ledecsko.cz/events/?ical=1",
  ],
  akceWeb: "https://www.ledecsko.cz/akce/",
  deska:
    "https://www.ledecns.cz/cs/mestsky-urad/elektronicka-uredni-deska/aktualni-oznameni.html",
  aktuality:
    "https://www.ledecns.cz/redakce/index.php?lanG=cs&portal=2179&as4uOriginalDomain=www.ledecns.cz&as4u_protocol=https&subakce=news&",
  ledecnsBase: "https://www.ledecns.cz",
};

// ---------------------------------------------------------------- pomocné

/** Dnešní datum v Praze jako YYYY-MM-DD. */
function todayPrague() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
}

const NAMED = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
function stripTags(s) {
  return decodeEntities(s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
function absUrl(href, base) {
  try { return new URL(decodeEntities(href), base).href; } catch { return null; }
}
/** "19.10.2026" nebo "19. 10. 2026" → "2026-10-19" */
function czDate(s) {
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

async function get(url, { json = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "cs,en;q=0.5", Accept: json ? "application/json" : "text/html,text/calendar,*/*" },
        signal: AbortSignal.timeout(30000),
        redirect: "follow",
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      let charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") || "")?.[1];
      if (!charset) {
        const head = new TextDecoder("latin1").decode(buf.slice(0, 4000));
        charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
      }
      let text;
      try { text = new TextDecoder(charset || "utf-8").decode(buf); } catch { text = new TextDecoder("utf-8").decode(buf); }
      await debugDump(url, res.status, text);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? JSON.parse(text) : text;
    } catch (e) {
      lastErr = e;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

let dumpN = 0;
async function debugDump(url, status, text) {
  if (!DEBUG) return;
  await mkdir(DEBUG_DIR, { recursive: true });
  const name = `${String(++dumpN).padStart(2, "0")}-${new URL(url).hostname}.txt`;
  await writeFile(new URL(name, DEBUG_DIR), `URL: ${url}\nSTATUS: ${status}\n\n${text.slice(0, 200000)}`);
}

async function readJson(name) {
  try { return JSON.parse(await readFile(new URL(name, DATA_DIR), "utf8")); } catch { return null; }
}
async function writeJson(name, obj) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(new URL(name, DATA_DIR), JSON.stringify(obj, null, 1) + "\n");
}

// ---------------------------------------------------------------- AKCE

/** Převod na formát, který používá web: t, p, s, e, h, run, url */
function toSiteEvent({ title, place, startDate, startTime, endDate, allDay, url }) {
  const e = endDate && endDate !== startDate ? endDate : undefined;
  const long = e && daysBetween(startDate, e) >= 7; // dlouhodobé akce → „Právě probíhá“
  let h = allDay || !startTime ? "" : startTime.replace(/^0(\d)/, "$1");
  if (long && h) h = "od " + h;
  const ev = { t: title, p: place || "", s: startDate, h };
  if (e) ev.e = e;
  if (long) ev.run = 1;
  if (url) ev.url = url;
  return ev;
}

async function akceFromApi(today) {
  const items = [];
  let url = `${SRC.tecApi}?per_page=50&start_date=${addDays(today, -60)}&end_date=${addDays(today, 400)}`;
  for (let page = 0; url && page < 10; page++) {
    const data = await get(url, { json: true });
    for (const ev of data.events || []) {
      const venue = Array.isArray(ev.venue) ? ev.venue[0] : ev.venue;
      const [sd, st] = String(ev.start_date || "").split(" ");
      const [ed] = String(ev.end_date || "").split(" ");
      if (!sd) continue;
      items.push(toSiteEvent({
        title: stripTags(ev.title || ""),
        place: venue && venue.venue ? stripTags(venue.venue) : "",
        startDate: sd, startTime: (st || "").slice(0, 5), endDate: ed, allDay: !!ev.all_day, url: ev.url,
      }));
    }
    url = data.next_rest_url || null;
  }
  return items;
}

function parseIcal(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const items = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const field = (name) => {
      const m = new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`, "m").exec(block);
      return m ? m[1].trim().replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ") : "";
    };
    const dt = (v) => {
      const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(v);
      return m ? { d: `${m[1]}-${m[2]}-${m[3]}`, t: m[4] ? `${m[4]}:${m[5]}` : "" } : null;
    };
    const start = dt(field("DTSTART"));
    if (!start) continue;
    let end = dt(field("DTEND"));
    const allDay = /DTSTART;VALUE=DATE:/.test(block);
    // u celodenních akcí je DTEND v iCal o den dál (exkluzivní)
    if (end && allDay) end = { d: addDays(end.d, -1), t: "" };
    items.push(toSiteEvent({
      title: decodeEntities(field("SUMMARY")),
      place: decodeEntities(field("LOCATION")).split(",")[0],
      startDate: start.d, startTime: start.t, endDate: end?.d, allDay, url: field("URL"),
    }));
  }
  return items;
}

async function akceFromIcal() {
  let lastErr;
  for (const url of SRC.ical) {
    try {
      const text = await get(url);
      if (!text.includes("BEGIN:VCALENDAR")) throw new Error("není iCal");
      return parseIcal(text);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const CZ_MONTHS = { ledna: 1, února: 2, března: 3, dubna: 4, května: 5, června: 6, července: 7, srpna: 8, září: 9, října: 10, listopadu: 11, prosince: 12 };
function czLongDate(s) {
  const m = /(\d{1,2})\.\s*([a-záéíóúůýčďěňřšťž]+)\s+(\d{4})/i.exec(s);
  if (!m || !CZ_MONTHS[m[2].toLowerCase()]) return null;
  return `${m[3]}-${String(CZ_MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** Poslední záchrana: přečíst výpis akcí přímo ze stránky (bez „Načíst více“ jen první dávka). */
export function parseAkceHtml(html) {
  const items = [];
  const parts = html.split(/(?=<h2[^>]*>\s*<a[^>]+\/event\/)/i).slice(1);
  for (const p of parts) {
    const a = /<a[^>]+href=["']([^"']*\/event\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(p);
    if (!a) continue;
    const text = stripTags(p.slice(0, 4000));
    const dm = /Datum:\s*(.+?)\s*Čas:\s*(\d{1,2}:\d{2})?\s*Místo:\s*(.+?)(?:\s+Více informací|$)/.exec(text);
    if (!dm) continue;
    const [sS, eS] = dm[1].split(/\s+-\s+/);
    const s = czLongDate(sS);
    if (!s) continue;
    items.push(toSiteEvent({ title: stripTags(a[2]), place: dm[3], startDate: s, startTime: dm[2] || "", endDate: eS ? czLongDate(eS) : undefined, url: absUrl(a[1], SRC.akceWeb) }));
  }
  return items;
}

async function updateAkce(today) {
  const errors = [];
  let items = null, method = null;
  for (const [name, fn] of [["api", () => akceFromApi(today)], ["ical", akceFromIcal], ["web", async () => parseAkceHtml(await get(SRC.akceWeb))]]) {
    try {
      const got = await fn();
      if (got.length) { items = got; method = name; break; }
      errors.push(`${name}: 0 akcí`);
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  if (!items) return { ok: false, error: errors.join(" | ") };

  // jen akce, které ještě neskončily; seřadit a odstranit duplicity
  const seen = new Set();
  items = items
    .filter((e) => (e.e || e.s) >= today)
    .sort((a, b) => a.s.localeCompare(b.s) || a.h.localeCompare(b.h))
    .filter((e) => { const k = e.s + "|" + e.t; if (seen.has(k)) return false; seen.add(k); return true; });

  if (!items.length) return { ok: false, error: "zdroj vrátil jen proběhlé akce" };
  await writeJson("akce.json", { updated: new Date().toISOString(), source: SRC.akceWeb, items });
  return { ok: true, count: items.length, method, warnings: errors };
}

// ---------------------------------------------------------------- ÚŘEDNÍ DESKA

// Co na portálu nezobrazujeme — dlouhé seznamy, které běžného čtenáře nezajímají.
const DESKA_EXCLUDE = /veřejnoprávní smlouv|smlouv[ay] o poskytnutí|rozpočtov[éá] opatření|závěrečn[ýé] účet|schválen[ýé] rozpočet|návrh rozpočtu|střednědob|výroční zpráva|zpráva o výsledku přezkoumání/i;

const DESKA_TAGS = [
  [/volb|voleb|okrsk|kandid|hlasov|zvolen/i, "Volby", "v"],
  [/uzavírk|objížď|úprav[ay] provozu|dopravní|silnic/i, "Doprava", "d"],
  [/přerušení dodávky|odstávk|vodovod|kanalizac|elektřin|plyn/i, "Odstávka", "s"],
  [/nález|ztrát/i, "Nález", "n"],
  [/záměr|pronájem|pronájmu|prodej|pacht|výpůjčk|směn/i, "Majetek", "m"],
  [/katastr|pozemk|územní plán|stavební/i, "Stavby a pozemky", ""],
  [/zastupitelstv|rada města|vyhlášk|nařízení/i, "Úřad", "u"],
];
function deskaTag(title) {
  for (const [re, label, cls] of DESKA_TAGS) if (re.test(title)) return { tag: label, cls };
  return { tag: "Oznámení", cls: "" };
}

function parseDeska(html) {
  const items = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []);
    if (cells.length < 2) continue;
    const texts = cells.map(stripTags);
    const di = texts.findIndex((t) => /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\s*[-–]\s*\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/.test(t));
    if (di < 0) continue;
    const [fromS, toS] = texts[di].split(/\s*[-–]\s*(?=\d)/);
    const from = czDate(fromS), to = czDate(toS);
    // název = buňka s odkazem na detail (jiná než buňka s daty)
    let ti = cells.findIndex((c, i) => i !== di && /<a\s[^>]*href/i.test(c));
    if (ti < 0) ti = texts.findIndex((t, i) => i !== di && t.length > 8 && !/^\S+\/\d{4}/.test(t));
    if (ti < 0) continue;
    const href = /href=["']([^"']+)["']/i.exec(cells[ti])?.[1];
    const title = texts[ti];
    if (!title || !from || !to) continue;
    items.push({
      t: title,
      from, to,
      src: texts[ti + 1] || "",
      typ: texts[ti + 2] || "",
      url: href ? absUrl(href, SRC.deska) : SRC.deska,
    });
  }
  return items;
}

/** Sloučí řady typu „Kožlí - zápis o výsledku voleb“, „Kouty - zápis…“ do jedné položky. */
function groupSeries(items) {
  const groups = new Map();
  const out = [];
  for (const it of items) {
    const m = /^(.{2,40}?)\s+[-–]\s+(.{6,})$/.exec(it.t);
    if (!m) { out.push(it); continue; }
    const key = m[2].toLowerCase() + "|" + it.from + "|" + it.to;
    if (!groups.has(key)) groups.set(key, { base: m[2], first: it, names: [] });
    groups.get(key).names.push(m[1]);
  }
  for (const g of groups.values()) {
    if (g.names.length < 3) {
      for (const n of g.names) out.push({ ...g.first, t: `${n} - ${g.base}` });
      continue;
    }
    const names = g.names.sort((a, b) => (a.startsWith("Ledeč") ? -1 : b.startsWith("Ledeč") ? 1 : a.localeCompare(b, "cs")));
    const shown = names.slice(0, 3).join(", ");
    const rest = names.length - 3;
    out.push({
      ...g.first,
      t: g.base.charAt(0).toUpperCase() + g.base.slice(1),
      note: rest > 0 ? `${shown} a dalších ${rest}` : shown,
      url: SRC.deska,
    });
  }
  return out;
}

async function updateDeska(today) {
  let raw;
  try { raw = parseDeska(await get(SRC.deska)); } catch (e) { return { ok: false, error: e.message }; }
  if (!raw.length) return { ok: false, error: "na desce se nepodařilo najít žádnou položku" };
  const items = groupSeries(raw.filter((x) => x.to >= today && !DESKA_EXCLUDE.test(x.t)))
    .map((x) => ({ ...x, ...deskaTag(x.t) }))
    .sort((a, b) => b.from.localeCompare(a.from));
  await writeJson("deska.json", { updated: new Date().toISOString(), source: SRC.deska, total: raw.length, items });
  return { ok: true, count: items.length, total: raw.length };
}

// ---------------------------------------------------------------- AKTUALITY

const NEWS_CATS = [
  [/uzavírk|objížď|výluk|jízdní řád|doprav|parkov|silnic|chodník|most/i, "doprava"],
  [/odstávk|přerušení dodávky|vod[ay]\b|elektřin|plyn|kanalizac/i, "site"],
  [/zastupitel|rada města|volb|voleb|zvolen|úřad|poplat|vyhlášk|svoz|odpad/i, "urad"],
];
function newsCat(t) {
  for (const [re, c] of NEWS_CATS) if (re.test(t)) return c;
  return "";
}

function nearestDate(html, start, end, radius = 700) {
  const dateRe = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/g;
  let best = null, bestDist = Infinity, d;
  const from = Math.max(0, start - radius);
  const chunk = html.slice(from, Math.min(html.length, end + radius));
  while ((d = dateRe.exec(chunk))) {
    const pos = from + d.index;
    const dist = pos < start ? start - pos : pos > end ? pos - end : 0;
    if (dist < bestDist) { bestDist = dist; best = d[0]; }
  }
  return best ? czDate(best) : null;
}

function parseAktuality(html) {
  const items = [];
  const seen = new Set();
  // Každá aktualita = odkaz s nadpisem a poblíž datum ve tvaru 13. 10. 2026
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1], title = stripTags(m[2]);
    if (!/clanky\/|#akt\d+|subakce=news/i.test(href)) continue;
    if (title.length < 8 || /^(více|celý článek|další|archiv|zpět)/i.test(title)) continue;
    // datum hledáme v okolí odkazu a bereme to nejbližší (může být před i za nadpisem)
    const date = nearestDate(html, m.index, re.lastIndex);
    if (!date) continue;
    const url = absUrl(href, SRC.aktuality);
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ t: title, date, url, cat: newsCat(title) });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}

async function updateAktuality() {
  let items;
  try { items = parseAktuality(await get(SRC.aktuality)); } catch (e) { return { ok: false, error: e.message }; }
  if (!items.length) return { ok: false, error: "nepodařilo se najít žádnou aktualitu" };
  await writeJson("aktuality.json", { updated: new Date().toISOString(), source: SRC.aktuality, items });
  return { ok: true, count: items.length };
}

// ---------------------------------------------------------------- běh

const today = todayPrague();
const results = {
  akce: await updateAkce(today),
  deska: await updateDeska(today),
  aktuality: await updateAktuality(),
};

const prev = (await readJson("meta.json")) || {};
const meta = { updated: new Date().toISOString(), today, sources: {} };
for (const [k, r] of Object.entries(results)) {
  meta.sources[k] = r.ok
    ? { ok: true, lastSuccess: meta.updated, ...r }
    : { ok: false, error: r.error, lastSuccess: prev.sources?.[k]?.lastSuccess || null };
}
await writeJson("meta.json", meta);

for (const [k, r] of Object.entries(results)) {
  console.log(`${r.ok ? "OK  " : "CHYBA"} ${k}: ${r.ok ? `${r.count} položek${r.method ? " (" + r.method + ")" : ""}` : r.error}`);
}
// Když něco selhalo, skončíme chybou — GitHub pak pošle upozornění e-mailem.
if (Object.values(results).some((r) => !r.ok)) process.exitCode = 1;
