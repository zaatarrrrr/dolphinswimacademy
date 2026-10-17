import type { Config } from "@netlify/functions";
import { desc } from "drizzle-orm";
import { db } from "../../db/index.js";
import { changeLog } from "../../db/schema.js";

export default async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 300, 1), 1000);
  const rows = await db.select().from(changeLog).orderBy(desc(changeLog.id)).limit(limit);
  return Response.json(rows);
};

export const config: Config = { path: "/api/changes" };
