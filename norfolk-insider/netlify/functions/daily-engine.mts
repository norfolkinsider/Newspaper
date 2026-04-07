import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const AIRTABLE_BASE = "appAtE1hE5frgdQFo";
const AIRTABLE_TABLE = "tblxnJEq6aeYI8BYM";

// Simcoe, Ontario
const LAT = 42.84;
const LNG = -80.30;

// ─── Weather ─────────────────────────────────────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: "clear skies", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "rain showers", 81: "moderate showers", 82: "heavy showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "heavy thunderstorms",
};

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LAT}&longitude=${LNG}` +
    `&current_weather=true` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,windspeed_10m_max` +
    `&timezone=America%2FToronto&forecast_days=1`;

  const res = await fetch(url);
  const data = await res.json();

  const current = data.current_weather;
  const daily = data.daily;

  return {
    condition: WMO_CODES[current.weathercode] ?? "variable",
    tempCurrent: Math.round(current.temperature),
    tempMax: Math.round(daily.temperature_2m_max[0]),
    tempMin: Math.round(daily.temperature_2m_min[0]),
    rainChance: daily.precipitation_probability_max[0],
    windspeed: Math.round(daily.windspeed_10m_max[0]),
  };
}

// ─── RSS News ─────────────────────────────────────────────────────────────────

function parseRSS(xml: string): { title: string; link: string; description: string }[] {
  const items: { title: string; link: string; description: string }[] = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const block = match[1];
    const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() ?? "";
    const link = block.match(/<link>(.*?)<\/link>/s)?.[1]?.trim() ?? "";
    const description = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/s)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      ?.replace(/\s+/g, " ")
      ?.trim()
      ?.substring(0, 300) ?? "";

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
    const xml = await res.text();
    const items = parseRSS(xml);
    return { source: sourceName, url, items };
  } catch (err) {
    console.warn(`RSS fetch failed for ${sourceName}:`, err);
    return null;
  }
}

// ─── Airtable Events ──────────────────────────────────────────────────────────

async function fetchEvents() {
  const today = new Date().toISOString().split("T")[0];
  const inThirtyDays = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

  const formula = encodeURIComponent(
    `AND({Date} >= "${today}", {Date} <= "${inThirtyDays}")`
  );

  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}` +
    `?filterByFormula=${formula}&sort[0][field]=Date&sort[0][direction]=asc&maxRecords=20`,
    { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } }
  );

  if (!res.ok) {
    console.error("Airtable error:", await res.text());
    return [];
  }

  const data = await res.json();
  return (data.records || []).map((r: any) => ({
    title: r.fields.Title || "Untitled Event",
    date: r.fields.Date || "",
    location: r.fields.Location || "",
    blurb: r.fields.Blurb || "",
    type: r.fields.Type || "",
  }));
}

// ─── Claude ───────────────────────────────────────────────────────────────────

async function callClaude(prompt: string, maxTokens = 800): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? "";
}

async function generateSassyWeather(weather: Awaited<ReturnType<typeof fetchWeather>>) {
  const prompt = `You write the daily weather blurb for The Norfolk Insider, a local daily brief for Norfolk County, Ontario, Canada.

Today's weather for Simcoe, ON:
- Condition: ${weather.condition}
- Current temp: ${weather.tempCurrent}°C
- High: ${weather.tempMax}°C / Low: ${weather.tempMin}°C
- Rain chance: ${weather.rainChance}%
- Max wind: ${weather.windspeed} km/h

Write a weather blurb that is:
- 2-3 sentences max
- Warm, sassy, and a little funny — like a friend who grew up in Norfolk
- Gives a genuine sense of what to expect today
- Mentions what you might actually do (or avoid doing) given the weather
- References Norfolk County life naturally — farming, Lake Erie, Port Dover, the drive to work, etc.

Just the blurb. No label, no title.`;

  return callClaude(prompt, 200);
}

async function summarizeNews(feeds: (Awaited<ReturnType<typeof fetchRSS>>)[]) {
  const validFeeds = feeds.filter(Boolean);
  if (validFeeds.length === 0) return [];

  const storiesText = validFeeds
    .flatMap(f => (f!.items || []).map(item =>
      `SOURCE: ${f!.source}\nTITLE: ${item.title}\nURL: ${item.link}\nSNIPPET: ${item.description}`
    ))
    .join("\n\n---\n\n");

  const prompt = `You are the editor of The Norfolk Insider, a local daily brief for Norfolk County, Ontario, Canada.

Below are recent headlines from local RSS feeds. Pick the 3 most relevant and interesting stories for Norfolk County residents. Ignore national or international stories unless they have a very direct local impact.

For each story write:
- A short, punchy headline (rewrite it if needed — make it feel local)
- A 2-sentence summary in a warm, readable community voice
- The source name and URL

Return ONLY valid JSON array, no markdown:
[
  {
    "title": "Rewritten headline",
    "summary": "Two sentence summary.",
    "source": "Source Name",
    "url": "https://..."
  }
]

STORIES:
${storiesText}`;

  const raw = await callClaude(prompt, 800);

  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    console.error("Failed to parse news JSON:", raw);
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function buildEdition() {
  const todayLabel = new Date().toLocaleDateString("en-CA", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Toronto",
  });

  const [weather, events, norfolkToday, cbcHamilton] = await Promise.all([
    fetchWeather(),
    fetchEvents(),
    fetchRSS("https://www.norfolktoday.ca/feed/", "Norfolk Today"),
    fetchRSS("https://www.cbc.ca/cmlink/rss-canada-hamiltonnews", "CBC Hamilton"),
  ]);

  const [weatherBlurb, news] = await Promise.all([
    generateSassyWeather(weather),
    summarizeNews([norfolkToday, cbcHamilton]),
  ]);

  return {
    date: new Date().toISOString().split("T")[0],
    dateLabel: todayLabel,
    generatedAt: new Date().toISOString(),
    weather: { ...weather, blurb: weatherBlurb },
    news,
    events,
  };
}

// Runs at 12:00 UTC = ~8am EDT / 7am EST
export const handler = schedule("0 12 * * *", async () => {
  console.log("Norfolk Insider daily engine running...");
  try {
    const edition = await buildEdition();
    const store = getStore("editions");
    await store.set("latest", JSON.stringify(edition));
    await store.set(edition.date, JSON.stringify(edition));
    console.log("Edition saved:", edition.date);
    return { statusCode: 200 };
  } catch (err) {
    console.error("Engine failed:", err);
    return { statusCode: 500 };
  }
});
