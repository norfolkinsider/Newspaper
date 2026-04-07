import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Shares build logic with daily-engine — duplicated here for independence
const AIRTABLE_BASE = "appAtE1hE5frgdQFo";
const AIRTABLE_TABLE = "tblxnJEq6aeYI8BYM";
const LAT = 42.84, LNG = -80.30;

const WMO_CODES: Record<number, string> = {
  0: "clear skies", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow",
  80: "rain showers", 81: "moderate showers", 82: "heavy showers",
  95: "thunderstorms", 96: "thunderstorms with hail",
};

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,windspeed_10m_max&timezone=America%2FToronto&forecast_days=1`;
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

function parseRSS(xml: string) {
  const items: { title: string; link: string; description: string }[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = match[1];
    const title = b.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() ?? "";
    const link = b.match(/<link>(.*?)<\/link>/s)?.[1]?.trim() ?? "";
    const description = b.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/s)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300) ?? "";
    if (title) items.push({ title, link, description });
    if (items.length >= 8) break;
  }
  return items;
}

async function fetchRSS(url: string, sourceName: string) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    return { source: sourceName, url, items: parseRSS(await res.text()) };
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

async function callClaude(prompt: string, maxTokens = 800) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? "";
}

export default async (req: Request, context: Context) => {
  const secret = new URL(req.url).searchParams.get("secret");
  if (secret !== process.env.TRIGGER_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const todayLabel = new Date().toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });

    const [weather, events, norfolkToday, cbcHamilton] = await Promise.all([
      fetchWeather(), fetchEvents(),
      fetchRSS("https://www.norfolktoday.ca/feed/", "Norfolk Today"),
      fetchRSS("https://www.cbc.ca/cmlink/rss-canada-hamiltonnews", "CBC Hamilton"),
    ]);

    const weatherPrompt = `Write a 2-3 sentence sassy, warm weather blurb for Norfolk County, Ontario today. Condition: ${weather.condition}, ${weather.tempCurrent}°C now, high ${weather.tempMax}°C, low ${weather.tempMin}°C, ${weather.rainChance}% rain chance, wind ${weather.windspeed}km/h. Make it funny and local. No title.`;

    const validFeeds = [norfolkToday, cbcHamilton].filter(Boolean);
    const storiesText = validFeeds.flatMap(f => (f!.items || []).map(i => `SOURCE: ${f!.source}\nTITLE: ${i.title}\nURL: ${i.link}\nSNIPPET: ${i.description}`)).join("\n\n---\n\n");

    const newsPrompt = `Pick the 3 most relevant stories for Norfolk County, Ontario residents from these RSS headlines. Return ONLY a JSON array, no markdown:\n[{"title":"...","summary":"2 sentence summary.","source":"...","url":"..."}]\n\nSTORIES:\n${storiesText}`;

    const [weatherBlurb, newsRaw] = await Promise.all([
      callClaude(weatherPrompt, 200),
      callClaude(newsPrompt, 800),
    ]);

    let news = [];
    try { news = JSON.parse(newsRaw.replace(/```json|```/g, "").trim()); } catch {}

    const edition = {
      date: new Date().toISOString().split("T")[0],
      dateLabel: todayLabel,
      generatedAt: new Date().toISOString(),
      weather: { ...weather, blurb: weatherBlurb },
      news,
      events,
    };

    const store = getStore("editions");
    await store.set("latest", JSON.stringify(edition));
    await store.set(edition.date, JSON.stringify(edition));

    return new Response(JSON.stringify({ success: true, date: edition.date, newsCount: news.length, eventCount: events.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

export const config = { path: "/api/trigger" };
