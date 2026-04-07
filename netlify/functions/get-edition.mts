import type { Context } from "@netlify/functions";

const AIRTABLE_BASE = "appAtE1hE5frgdQFo";
const AIRTABLE_TABLE = "tblxnJEq6aeYI8BYM";
const LAT = 42.84, LNG = -80.30;

const WMO: Record<number, string> = {
  0:"Clear skies",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",
  45:"Foggy",48:"Freezing fog",51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",
  61:"Light rain",63:"Rain",65:"Heavy rain",71:"Light snow",73:"Snow",75:"Heavy snow",
  80:"Rain showers",81:"Moderate showers",82:"Heavy showers",95:"Thunderstorms",
};

function parseRSS(xml: string) {
  const items: {title:string;link:string;description:string}[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = b.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() ?? "";
    const link = b.match(/<link>(.*?)<\/link>/s)?.[1]?.trim() ?? "";
    const description = b.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/s)?.[1]?.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().substring(0,300) ?? "";
    if (title) items.push({title,link,description});
    if (items.length >= 8) break;
  }
  return items;
}

async function fetchRSS(url: string, source: string) {
  try {
    const res = await fetch(url, {headers:{"User-Agent":"Mozilla/5.0"},signal:AbortSignal.timeout(8000)});
    if (!res.ok) return null;
    return {source, items: parseRSS(await res.text())};
  } catch { return null; }
}

async function fetchNorfolkCounty() {
  try {
    const res = await fetch("https://www.norfolkcounty.ca/news-and-notices/", {headers:{"User-Agent":"Mozilla/5.0"},signal:AbortSignal.timeout(10000)});
    const html = await res.text();
    const items: {title:string;link:string;description:string}[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(/href="(https?:\/\/www\.norfolkcounty\.ca\/news-and-notices\/posts\/[^"]+)"[^>]*>\s*([^<]{10,})<\/a>/g)) {
      const link = m[1], title = m[2].trim().replace(/\s+/g," ");
      if (!seen.has(link) && title.length > 10) { seen.add(link); items.push({title,link,description:""}); }
      if (items.length >= 5) break;
    }
    return items.length ? {source:"Norfolk County", items} : null;
  } catch { return null; }
}

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

async function fetchEvents() {
  const today = new Date().toISOString().split("T")[0];
  const in30 = new Date(Date.now()+30*86400000).toISOString().split("T")[0];
  const formula = encodeURIComponent(`AND({Date}>="${today}",{Date}<="${in30}")`);
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${formula}&sort[0][field]=Date&sort[0][direction]=asc&maxRecords=100`,
    {headers:{Authorization:`Bearer ${process.env.AIRTABLE_TOKEN}`}}
  );
  const d = await res.json();
  return (d.records||[]).map((r:any) => ({
    title: r.fields.Title||"Untitled",
    date: r.fields.Date||"",
    location: r.fields.Location||"",
    blurb: r.fields.Blurb||"",
  }));
}

async function summarizeNews(feeds: ({source:string;items:{title:string;link:string;description:string}[]}|null)[]) {
  const valid = feeds.filter(Boolean);
  if (!valid.length) return [];
  const stories = valid.flatMap(f=>f!.items.map(i=>`SOURCE: ${f!.source}\nTITLE: ${i.title}\nURL: ${i.link}\nSNIPPET: ${i.description}`)).join("\n\n---\n\n");
  const prompt = `You are the editor of The Norfolk Insider, a community daily brief for Norfolk County, Ontario, Canada.

Pick the 3 most relevant stories for Norfolk County residents from the list below.

RULES:
- Maximum ONE story per source
- NEVER include crime, arrests, charges, assault, theft, homicide, police investigations, or court proceedings
- Prioritize Norfolk County, Haldimand-Norfolk, Simcoe, Port Dover, Delhi, Waterford, Tillsonburg
- If nothing strongly local, pick best southwestern Ontario stories

Return ONLY valid JSON array, no markdown:
[{"title":"...","summary":"2 sentence plain summary.","source":"...","url":"..."}]

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
  try {
    const dateLabel = new Date().toLocaleDateString("en-CA",{
      weekday:"long",year:"numeric",month:"long",day:"numeric",timeZone:"America/Toronto"
    });

    const [weather, events, norfolkToday, cbcHamilton, brantfordExpositor, ctvKitchener, norfolkCounty] = await Promise.all([
      fetchWeather(),
      fetchEvents(),
      fetchRSS("https://www.norfolktoday.ca/feed/","Norfolk Today"),
      fetchRSS("https://www.cbc.ca/cmlink/rss-canada-hamiltonnews","CBC Hamilton"),
      fetchRSS("https://www.brantfordexpositor.ca/feed/","Brantford Expositor"),
      fetchRSS("https://kitchener.ctvnews.ca/rss/ctv-news-kitchener-1.822545","CTV Kitchener"),
      fetchNorfolkCounty(),
    ]);

    const news = await summarizeNews([norfolkToday,cbcHamilton,brantfordExpositor,ctvKitchener,norfolkCounty]);

    return new Response(JSON.stringify({
      date: new Date().toISOString().split("T")[0],
      dateLabel,
      weather,
      news,
      events,
    }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch(err) {
    return new Response(JSON.stringify({error:String(err)}),{
      status:500,headers:{"Content-Type":"application/json"}
    });
  }
};

export const config = {path:"/api/edition"};
