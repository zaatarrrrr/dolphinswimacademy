import type { Config } from "@netlify/functions";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appState, changeLog } from "../../db/schema.js";

const KEY = "academy";
const MAX_BYTES = 4_000_000;

type Any = Record<string, any>;
type Change = { area: string; action: string; summary: string };

const s = (v: unknown) => (v == null || v === "" ? "(empty)" : String(v));
const obj = (v: unknown): Any => (v && typeof v === "object" && !Array.isArray(v) ? (v as Any) : {});
const arr = (v: unknown): Any[] => (Array.isArray(v) ? v : []);

function byId(list: Any[]) {
  const m = new Map<string, Any>();
  for (const x of list) if (x && x.id != null) m.set(String(x.id), x);
  return m;
}

// Push changes for one kind of record, collapsing big batches into one line
function pushGrouped(out: Change[], area: string, action: string, lines: string[], noun: string) {
  if (!lines.length) return;
  if (lines.length > 15) {
    out.push({ area, action, summary: `${action[0].toUpperCase() + action.slice(1)} ${lines.length} ${noun}` });
    return;
  }
  for (const summary of lines) out.push({ area, action, summary });
}

function diffList(
  out: Change[],
  area: string,
  noun: string,
  before: Any[],
  after: Any[],
  label: (x: Any) => string,
  fields: [string, string][],
) {
  const a = byId(before), b = byId(after);
  const added: string[] = [], removed: string[] = [], edited: string[] = [];
  for (const [id, x] of b) {
    const old = a.get(id);
    if (!old) { added.push(`Added ${label(x)}`); continue; }
    const diffs = fields
      .filter(([f]) => JSON.stringify(old[f] ?? null) !== JSON.stringify(x[f] ?? null))
      .map(([f, name]) => `${name}: ${s(old[f])} → ${s(x[f])}`);
    if (diffs.length) edited.push(`Edited ${label(old)} (${diffs.join(", ")})`);
  }
  for (const [id, x] of a) if (!b.has(id)) removed.push(`Deleted ${label(x)}`);
  pushGrouped(out, area, "added", added, noun);
  pushGrouped(out, area, "edited", edited, noun);
  pushGrouped(out, area, "deleted", removed, noun);
}

function diffMap(out: Change[], area: string, before: Any, after: Any, describe: (k: string, o: any, n: any) => string) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const lines: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null)) continue;
    lines.push(describe(k, before[k], after[k]));
  }
  pushGrouped(out, area, "edited", lines, "settings");
}

function describeChanges(oldData: Any, newData: Any): Change[] {
  const out: Change[] = [];

  const m0 = obj(oldData.meet), m1 = obj(newData.meet);
  const meetFields: Any = { name: "Meet name", date: "Date", warmup: "Warm-up time", deadline: "Entry deadline", fee: "Default fee per race" };
  for (const f of new Set([...Object.keys(m0), ...Object.keys(m1)])) {
    if (JSON.stringify(m0[f] ?? null) !== JSON.stringify(m1[f] ?? null))
      out.push({ area: "Meet info", action: "edited", summary: `${meetFields[f] || f}: ${s(m0[f])} → ${s(m1[f])}` });
  }

  // Swimmers (list of names + profile details)
  const sw0 = new Set(arr(oldData.swimmers).map(String)), sw1 = new Set(arr(newData.swimmers).map(String));
  const p0 = obj(oldData.profiles), p1 = obj(newData.profiles);
  const swAdded: string[] = [], swRemoved: string[] = [], swEdited: string[] = [];
  for (const n of sw1) if (!sw0.has(n)) swAdded.push(`Added swimmer ${n}${p1[n]?.yob ? ` (born ${p1[n].yob})` : ""}`);
  for (const n of sw0) if (!sw1.has(n)) swRemoved.push(`Removed swimmer ${n}`);
  for (const n of sw1) {
    if (!sw0.has(n)) continue;
    const y0 = obj(p0[n]).yob, y1 = obj(p1[n]).yob;
    if ((y0 ?? null) !== (y1 ?? null)) swEdited.push(`${n}: year of birth ${s(y0)} → ${s(y1)}`);
  }
  pushGrouped(out, "Swimmers", "added", swAdded, "swimmers");
  pushGrouped(out, "Swimmers", "edited", swEdited, "swimmers");
  pushGrouped(out, "Swimmers", "deleted", swRemoved, "swimmers");

  diffList(out, "Entries", "entries", arr(oldData.entries), arr(newData.entries),
    (x) => `entry ${s(x.name)} · ${s(x.event)} · ${s(x.time)}`,
    [["name", "swimmer"], ["event", "race"], ["time", "time"], ["fee", "fee"]]);

  diffList(out, "Times", "times", arr(oldData.results), arr(newData.results),
    (x) => `time ${s(x.name)} · ${s(x.event)} · ${s(x.time)}${x.date ? ` (${x.date})` : ""}`,
    [["name", "swimmer"], ["event", "race"], ["time", "time"], ["date", "date"], ["meet", "meet"]]);

  diffList(out, "Coaching fees", "payments", arr(oldData.payments), arr(newData.payments),
    (x) => `payment ${s(x.name)} · ${Number(x.amount || 0).toFixed(2)}${x.date ? ` on ${x.date}` : ""}${x.note ? ` (${x.note})` : ""}`,
    [["name", "swimmer"], ["amount", "amount"], ["date", "date"], ["note", "note"]]);

  diffMap(out, "Qualification", obj(oldData.quals), obj(newData.quals),
    (k, o, n) => `${k} qualifying time: ${s(o)} → ${s(n)}`);

  diffMap(out, "Coaching fees", obj(oldData.fees), obj(newData.fees),
    (k, o, n) => `${k} monthly fee: ${s(o)} → ${s(n)}`);

  if ((oldData.coachFee ?? 0) !== (newData.coachFee ?? 0))
    out.push({ area: "Coaching fees", action: "edited", summary: `Default monthly fee: ${s(oldData.coachFee ?? 0)} → ${s(newData.coachFee ?? 0)}` });

  return out;
}

export default async (req: Request) => {
  if (req.method === "GET") {
    const [row] = await db.select().from(appState).where(eq(appState.key, KEY));
    return Response.json(row ? { data: row.data, version: row.version, updatedAt: row.updatedAt } : { data: null, version: 0 });
  }

  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_BYTES) return Response.json({ error: "Too much data" }, { status: 413 });
    let body: Any;
    try { body = JSON.parse(text); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const data = obj(body.data);
    const base = Number(body.version) || 0;
    if (!Array.isArray(data.entries)) return Response.json({ error: "Invalid data" }, { status: 400 });

    const [current] = await db.select().from(appState).where(eq(appState.key, KEY));
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== base) {
      return Response.json({ error: "conflict", data: current?.data ?? null, version: currentVersion }, { status: 409 });
    }

    let saved;
    if (!current) {
      [saved] = await db.insert(appState).values({ key: KEY, data, version: 1 }).onConflictDoNothing().returning();
    } else {
      [saved] = await db.update(appState)
        .set({ data, version: base + 1, updatedAt: new Date() })
        .where(and(eq(appState.key, KEY), eq(appState.version, base)))
        .returning();
    }
    if (!saved) {
      const [latest] = await db.select().from(appState).where(eq(appState.key, KEY));
      return Response.json({ error: "conflict", data: latest?.data ?? null, version: latest?.version ?? 0 }, { status: 409 });
    }

    const changes: Change[] = current
      ? describeChanges(obj(current.data), data)
      : [{ area: "Database", action: "added", summary: "Saved the site's data to the database for the first time" }];
    const ids = changes.length ? (await db.insert(changeLog).values(changes).returning({ id: changeLog.id })).map((r) => r.id) : [];

    return Response.json({ version: saved.version, changeIds: ids });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/state" };
