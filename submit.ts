import type { Config } from "@netlify/functions";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appState, changeLog } from "../../db/schema.js";

// Receives a swimmer file from the swimmer form site and adds it to the academy data.
const KEY = "academy";
const MAX_BYTES = 100_000;
const EVENTS = ["50 Free","100 Free","200 Free","400 Free","50 Back","100 Back","200 Back","50 Breast","100 Breast","200 Breast","50 Fly","100 Fly","200 IM","400 IM"];

type Any = Record<string, any>;

// Optional: set FORM_SITE_ORIGIN in Netlify (e.g. https://swimmer-form.netlify.app) to accept only that site
const cors = () => ({
  "Access-Control-Allow-Origin": process.env.FORM_SITE_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors() });

// Same rules as the meet site: 1:08.45 or 34.50
function parseTime(t: unknown): number | null {
  const m = String(t ?? "").trim().replace(",", ".").match(/^(?:(\d{1,2}):)?(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const mins = m[1] ? parseInt(m[1], 10) : 0, secs = parseInt(m[2], 10);
  const frac = m[3] ? parseInt((m[3] + "0").slice(0, 2), 10) : 0;
  if (m[1] && secs >= 60) return null;
  return mins * 60 + secs + frac / 100;
}
function fmt(sec: number): string {
  let m = Math.floor(sec / 60), s = (sec - m * 60).toFixed(2);
  if (parseFloat(s) >= 60) { m += 1; s = "0.00"; }
  return m > 0 ? `${m}:${parseFloat(s) < 10 ? "0" : ""}${s}` : s;
}
const clean = (v: unknown, max: number) =>
  String(v ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const text = await req.text();
  if (text.length > MAX_BYTES) return reply({ error: "Too much data" }, 413);
  let body: Any;
  try { body = JSON.parse(text); } catch { return reply({ error: "Invalid JSON" }, 400); }

  if (body.website) return reply({ ok: true }); // honeypot: pretend success to bots

  const name = clean(body.name, 80);
  const yob = parseInt(body.yob, 10);
  const thisYear = new Date().getFullYear();
  if (!name) return reply({ error: "Please enter your name." }, 400);
  if (isNaN(yob) || yob < 1930 || yob > thisYear) return reply({ error: "Invalid year of birth." }, 400);

  const times: Any[] = [];
  const list = Array.isArray(body.times) ? body.times.slice(0, 40) : [];
  for (const t of list) {
    const ts = parseTime(t?.time);
    const date = String(t?.date ?? "");
    if (!EVENTS.includes(t?.event) || ts == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply({ error: "One of the times is not valid." }, 400);
    }
    times.push({ event: t.event, time: fmt(ts), date, meet: clean(t?.meet, 60) });
  }

  // Add to the saved data; retry if the coach saved at the same moment
  for (let attempt = 0; attempt < 5; attempt++) {
    const [current] = await db.select().from(appState).where(eq(appState.key, KEY));
    const d: Any = current?.data && typeof current.data === "object" ? { ...(current.data as Any) } : {};
    d.meet = d.meet ?? {}; d.entries = Array.isArray(d.entries) ? d.entries : [];
    d.quals = d.quals ?? {}; d.fees = d.fees ?? {}; d.coachFee = d.coachFee ?? 0;
    d.payments = Array.isArray(d.payments) ? d.payments : [];
    d.swimmers = Array.isArray(d.swimmers) ? [...d.swimmers] : [];
    d.results = Array.isArray(d.results) ? [...d.results] : [];
    d.profiles = d.profiles && typeof d.profiles === "object" ? { ...d.profiles } : {};

    // Match an existing swimmer by name, ignoring upper/lower case
    const known = new Set<string>([...d.swimmers, ...d.entries.map((e: Any) => e.name), ...d.results.map((r: Any) => r.name)].map(String));
    const existing = [...known].find((n) => n.toLowerCase() === name.toLowerCase());
    const finalName = existing ?? name;
    const isNew = !existing;
    if (!d.swimmers.includes(finalName)) d.swimmers.push(finalName);
    if (!d.profiles[finalName]?.yob) d.profiles[finalName] = { ...(d.profiles[finalName] ?? {}), yob };

    let added = 0;
    for (const t of times) {
      const dup = d.results.some((r: Any) => r.name === finalName && r.event === t.event && r.time === t.time && r.date === t.date);
      if (dup) continue;
      d.results.push({ id: uid(), name: finalName, event: t.event, time: t.time, date: t.date, meet: t.meet, at: Date.now() });
      added++;
    }

    let saved;
    if (!current) {
      [saved] = await db.insert(appState).values({ key: KEY, data: d, version: 1 }).onConflictDoNothing().returning();
    } else {
      [saved] = await db.update(appState)
        .set({ data: d, version: current.version + 1, updatedAt: new Date() })
        .where(and(eq(appState.key, KEY), eq(appState.version, current.version)))
        .returning();
    }
    if (!saved) continue; // someone saved first: read again and retry

    await db.insert(changeLog).values({
      area: "Swimmers",
      action: isNew ? "added" : "edited",
      summary: `Swimmer form: ${isNew ? "new swimmer" : "updated"} ${finalName} (born ${yob}), ${added} time${added === 1 ? "" : "s"} added`,
    });
    return reply({ ok: true, added });
  }
  return reply({ error: "Busy, please try again." }, 503);
};

export const config: Config = { path: "/api/submit" };
