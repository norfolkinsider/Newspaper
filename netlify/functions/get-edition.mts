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
  return (d.records||[]).map((r:any)=>({
    title: r.fields.Title||"Untitled",
    date: r.fields.Date||"",
    location: r.fields.Location||"",
    blurb: r.fields.Blurb||"",
  }));
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, l => l.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchCountyUpdates() {
  try {
    const res = await fetch("https://www.norfolkcounty.ca/news-and-notices/", {
      headers:{
        "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":"en-CA,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return [];
    const html = await res.text();

    // Extract all unique post URLs
    const seen = new Set<string>();
    const updates: {title:string;url:string;description:string;source:string}[] = [];

    for (const m of html.matchAll(/href="(https?:\/\/www\.norfolkcounty\.ca\/news-and-notices\/posts\/([^"?#\/]+)(?:\/)?)"[^>]*>/g)) {
      const url = m[1].endsWith('/') ? m[1] : m[1] + '/';
      const slug = m[2];
      if (!seen.has(url) && slug && slug.length > 5) {
        seen.add(url);
        updates.push({
          title: slugToTitle(slug),
          url,
          description: "",
          source: "Norfolk County",
        });
      }
      if (updates.length >= 4) break;
    }

    return updates;
  } catch(e) {
    console.error("County fetch error:", e);
    return [];
  }
}

export default async (req: Request, context: Context) => {
  try {
    const dateLabel = new Date().toLocaleDateString("en-CA",{
      weekday:"long",year:"numeric",month:"long",day:"numeric",timeZone:"America/Toronto"
    });

    const [weather, events, countyUpdates] = await Promise.all([
      fetchWeather(),
      fetchEvents(),
      fetchCountyUpdates(),
    ]);

    // If scraper fails, return a single link to the county news page
    const news = countyUpdates.length > 0 ? countyUpdates : [{
      title: "View Latest Norfolk County Updates",
      url: "https://www.norfolkcounty.ca/news-and-notices/",
      description: "Road closures, service disruptions, public notices and more.",
      source: "Norfolk County",
    }];

    return new Response(JSON.stringify({
      date: new Date().toISOString().split("T")[0],
      dateLabel,
      weather,
      news,
      events,
    }), {
      headers:{
        "Content-Type":"application/json",
        "Cache-Control":"no-store",
        "Access-Control-Allow-Origin":"*",
      },
    });
  } catch(err) {
    return new Response(JSON.stringify({error:String(err)}),{
      status:500,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
    });
  }
};

export const config = {path:"/api/edition"};
