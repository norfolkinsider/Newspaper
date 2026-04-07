import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const AIRTABLE_BASE = "appAtE1hE5frgdQFo";
const AIRTABLE_TABLE = "tblxnJEq6aeYI8BYM";
const LAT = 42.84, LNG = -80.30;

const WMO: Record<number, string> = {
  0:"Clear skies",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",
  45:"Foggy",48:"Freezing fog",51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",
  61:"Light rain",63:"Rain",65:"Heavy rain",71:"Light snow",73:"Snow",75:"Heavy snow",
  80:"Rain showers",81:"Moderate showers",82:"Heavy showers",95:"Thunderstorms",
};

async function fetchWeather() {
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,windspeed_10m_max&timezone=America%2FToronto&forecast_days=1`
  );
  const d = await res.json();
  return {
    condition: WMO[d.current_weather.weathercode] ?? "Variable",
    tempCurrent: Math.round(d.current_weather.temperature),
    tempMax: Math.round(d.daily.temperature_2m_max[0]),
    tempMin: Math.round(d.daily.temperature_2m_min[0]),
    rainChance: d.daily.precipitation_probability_max[0],
    windspeed: Math.round(d.daily.windspeed_10m_max[0]),
  };
}

function parseRSS(xml: string) {
  const items: {title:string;link:string;description:string;source:string}[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = b.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() ?? "";
    const link = b.match(/<link>(.*?)<\/link>/s)?.[1]?.trim()
      ?? b.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/s)?.[1]?.trim() ?? "";
    const description = b.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/s)?.[1]
      ?.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().substring(0,300) ?? "";
    // Extract source from Google News RSS
    const sourceName = b.match(/<source[^>]*>(.*?)<\/source>/s)?.[1]?.trim() ?? "";
    if (title) items.push({title, link, description, source: sourceName});
    if (items.length >= 15) break;
  }
  return items;
}

async function fetchEvents() {
  const today = new Date().toISOString().split("T")[0];
  const in30 = new Date(Date.now()+30*86400000).toISOString().split("T")[0];
  const formula = encodeURIComponent(`AND({Date}>="${today}",{Date}<="${in30}")`);
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${formula}&sort[0][field]=Date&sort[0][direction]=asc&maxRecords=100`,
    {headers:{Authorization:`Bearer ${process.env.AIRTABLE_TOKEN}`}}
  );
  const d = await res.json();
  return (d.records||[]).map((r:any)=>({
    title: r.fields.Title||"Untitled",
    date: r.fields.Date||"",
    location: r.fields.Location||"",
    blurb: r.fields.Blurb||"",
  }));
}

async function fetchNews() {
  // Google News RSS — searches for Norfolk County Ontario, excludes paywalled sources
  const url = "https://news.google.com/rss/search?q=%22Norfolk+County%22+Ontario+-site:simcoereformer.ca+-site:brantfordexpositor.ca&hl=en-CA&gl=CA&ceid=CA:en";
  try {
    const res = await fetch(url, {
      headers:{"User-Agent":"Mozilla/5.0 (compatible; NorfolkInsider/1.0)"},
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const items = parseRSS(await res.text());
    return items;
  } catch { return []; }
}

async function summarizeNews(items: {title:string;link:string;description:string;source:string}[]) {
  if (!items.length) return [];

  const stories = items.map(i =>
    `PUBLICATION: ${i.source || "Unknown"}\nTITLE: ${i.title}\nURL: ${i.link}\nSNIPPET: ${i.description}`
  ).join("\n\n---\n\n");

  const prompt = `You are the editor of The Norfolk Insider, a community daily brief for Norfolk County, Ontario, Canada.

From the stories below pick the 3 most interesting and relevant for Norfolk County residents.

RULES:
- Pick stories from 3 different publications — never two from the same publication
- NEVER include crime, arrests, charges, assault, theft, homicide, police investigations, or court proceedings — skip these entirely
- Prioritize stories directly about Norfolk County, Simcoe, Port Dover, Delhi, Waterford, Tillsonburg, or Haldimand-Norfolk
- If nothing strongly local exists, pick the best southwestern Ontario stories

Return ONLY a valid JSON array, no markdown fences:
[{"title":"Rewritten headline","summary":"2 sentence plain friendly summary.","source":"Publication name","url":"https://..."}]

STORIES:
${stories}`;

  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY!,"anthropic-version":"2023-06-01"},
    body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:800,messages:[{role:"user",content:prompt}]}),
  });
  const d = await res.json();
  try { return JSON.parse((d.content?.[0]?.text||"[]").replace(/```json|```/g,"").trim()); }
  catch { return []; }
}

export default async (req: Request, context: Context) => {
  if (new URL(req.url).searchParams.get("secret") !== process.env.TRIGGER_SECRET)
    return new Response("Unauthorized",{status:401});

  try {
    const todayLabel = new Date().toLocaleDateString("en-CA",{
      weekday:"long",year:"numeric",month:"long",day:"numeric",timeZone:"America/Toronto"
    });

    const [weather, events, newsItems] = await Promise.all([
      fetchWeather(),
      fetchEvents(),
      fetchNews(),
    ]);

    const news = await summarizeNews(newsItems);

    const edition = {
      date: new Date().toISOString().split("T")[0],
      dateLabel: todayLabel,
      generatedAt: new Date().toISOString(),
      weather, news, events,
    };

    const store = getStore("editions");
    await store.set("latest", JSON.stringify(edition));
    await store.set(edition.date, JSON.stringify(edition));

    return new Response(JSON.stringify({
      success:true,
      date:edition.date,
      newsCount:news.length,
      eventCount:events.length,
      rawStoriesFound:newsItems.length,
    }), {headers:{"Content-Type":"application/json"}});
  } catch(err) {
    return new Response(JSON.stringify({error:String(err)}),{
      status:500,headers:{"Content-Type":"application/json"},
    });
  }
};

export const config = {path:"/api/trigger"};
