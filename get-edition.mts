import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const AIRTABLE_BASE = "appAtE1hE5frgdQFo";
const AIRTABLE_TABLE = "tblxnJEq6aeYI8BYM";
const LAT = 42.84, LNG = -80.30;

const WMO_CODES: Record<number, string> = {
  0: "Clear skies", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Moderate showers", 82: "Heavy showers",
  95: "Thunderstorms", 96: "Thunderstorms with hail",
};

async function fetchWeather() {
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&current_weather=true` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,windspeed_10m_max` +
    `&timezone=America%2FToronto&forecast_days=1`
  );
  const data = await res.json();
  const current = data.current_weather;
  const daily = data.daily;
  return {
    condition: WMO_CODES[current.weathercode] ?? "Variable",
    tempCurrent: Math.round(current.temperature),
    tempMax: Math.round(daily.temperature_2m_max[0]),
    tempMin: Math.round(daily.temperature_2m_min[0]),
    rainChance: daily.precipitation_probability_max[0],
    windspeed: Math.round(daily.windspeed_10m_max[0]),
  };
}

function parseRSS(xml: string) {
  const items: { title: string; link: string; description: string }[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = match[1];
    const title = b.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() ?? "";
    const link = b.match(/<link>(.*?)<\/link>/s)?.[1]?.trim() ?? "";
    const description = b.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/s)?.[1]
      ?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300) ?? "";
    if (title) items.push({ title, link, description });
    if (items.length >= 8) break;
  }
  return items;
}

async function fetchRSS(url: string, sourceName: string) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NorfolkInsider/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return { source: sourceName, items: parseRSS(await res.text()) };
  } catch { return null; }
}

async function fetchNorfolkCountyNews() {
  try {
    const res = await fetch("https://www.norfolkcounty.ca/news-and-notices/", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NorfolkInsider/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    const items: { title: string; link: string; description: string }[] = [];
    const seen = new Set<string>();
    const pattern = /href="(https?:\/\/www\.norfolkcounty\.ca\/news-and-notices\/posts\/[^"]+)"[^>]*>\s*([^<]{10,})<\/a>/g;
    for (const match of html.matchAll(pattern)) {
      const link = match[1];
      const title = match[2].trim().replace(/\s+/g, " ");
      if (!seen.has(link) && title.length > 10) {
        seen.add(link);
        items.push({ title, link, description: "" });
      }
      if (items.length >= 5) break;
    }
    if (items.length === 0) return null;
    return { source: "Norfolk County", items };
  } catch { return null; }
}

async function fetchEvents() {
  const today = new Date().toISOString().split("T")[0];
  const inThirtyDays = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
  const formula = encodeURIComponent(`AND({Date} >= "${today}", {Date} <= "${inThirtyDays}")`);
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${formula}&sort[0][field]=Date&sort[0][direction]=asc&maxRecords=20`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  return (data.records || []).map((r: any) => ({
    title: r.fields.Title || "Untitled",
    date: r.fields.Date || "",
    location: r.fields.Location || "",
    blurb: r.fields.Blurb || "",
  }));
}

async function summarizeNews(feeds: ({ source: string; items: { title: string; link: string; description: string }[] } | null)[]) {
  const validFeeds = feeds.filter(Boolean);
  if (validFeeds.length === 0) return [];

  const storiesText = validFeeds
    .flatMap(f => (f!.items || []).map(i =>
      `SOURCE: ${f!.source}\nTITLE: ${i.title}\nURL: ${i.link || ""}\nSNIPPET: ${i.description}`
    ))
    .join("\n\n---\n\n");

  const prompt = `You are the editor of The Norfolk Insider, a community daily brief for Norfolk County, Ontario, Canada.

From the stories below, select the 3 most interesting and relevant for Norfolk County residents.

STRICT RULES:
- Maximum ONE story per source — never pick two stories from the same source
- NEVER include any story involving crime, arrests, charges, assault, theft, homicide, police investigations, or court proceedings — skip entirely
- Prioritize stories directly about Norfolk County, Haldimand-Norfolk, or towns like Simcoe, Port Dover, Delhi, Waterford, Tillsonburg
- If no strong local stories exist, pick the most relevant southwestern Ontario stories

Return ONLY a valid JSON array, no markdown fences:
[{"title":"...","summary":"2-sentence plain summary.","source":"...","url":"..."}]

STORIES:
${storiesText}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const raw = data.content?.[0]?.text?.trim() ?? "[]";
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return []; }
}

export default async (req: Request, context: Context) => {
  const secret = new URL(req.url).searchParams.get("secret");
  if (secret !== process.env.TRIGGER_SECRET) return new Response("Unauthorized", { status: 401 });

  try {
    const todayLabel = new Date().toLocaleDateString("en-CA", {
      weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto",
    });

    const [weather, events, norfolkToday, cbcHamilton, brantfordExpositor, ctvKitchener, norfolkCounty] =
      await Promise.all([
        fetchWeather(), fetchEvents(),
        fetchRSS("https://www.norfolktoday.ca/feed/", "Norfolk Today"),
        fetchRSS("https://www.cbc.ca/cmlink/rss-canada-hamiltonnews", "CBC Hamilton"),
        fetchRSS("https://www.brantfordexpositor.ca/feed/", "Brantford Expositor"),
        fetchRSS("https://kitchener.ctvnews.ca/rss/ctv-news-kitchener-1.822545", "CTV Kitchener"),
        fetchNorfolkCountyNews(),
      ]);

    const news = await summarizeNews([norfolkToday, cbcHamilton, brantfordExpositor, ctvKitchener, norfolkCounty]);

    const edition = {
      date: new Date().toISOString().split("T")[0],
      dateLabel: todayLabel,
      generatedAt: new Date().toISOString(),
      weather,
      news,
      events,
    };

    const store = getStore("editions");
    await store.set("latest", JSON.stringify(edition));
    await store.set(edition.date, JSON.stringify(edition));

    return new Response(JSON.stringify({
      success: true, date: edition.date,
      newsCount: news.length, eventCount: events.length,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/trigger" };
