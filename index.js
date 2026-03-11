const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = `${process.cwd()}\\.env`;
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const app = express();
const PORT = process.env.PORT || 8080;
const VoiceResponse = twilio.twiml.VoiceResponse;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;
if (!supabase) console.warn("[supabase] not configured — Supabase is required for Vercel deployment");

const { GoogleGenerativeAI } = require("@google/generative-ai");
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
if (!gemini) console.warn("[gemini] GEMINI_API_KEY not set — AI insights disabled");

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    console.error("[webhook payload parse error]", err);
    return res.status(400).json({ error: "Invalid request payload", detail: err.message });
  }
  return next();
});
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

async function generateInsights(callId) {
  if (!gemini) return;

  let transcript = [];
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("calls")
        .select("transcript")
        .eq("call_id", callId)
        .limit(1);
      if (!error && Array.isArray(data?.[0]?.transcript)) {
        transcript = data[0].transcript;
      }
    } catch (err) {
      console.warn("[gemini] supabase transcript fetch failed", err.message);
    }
  }

  if (transcript.length < 3) {
    console.log("[gemini] skipped — only", transcript.length, "transcript entries for", callId);
    return;
  }

  const transcriptText = transcript.map((e) => `${e.speaker}: ${e.text}`).join("\n");
  console.log("[gemini] generating insights for", callId, "—", transcript.length, "entries");

  try {
    const model = gemini.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt =
      'You analyze utility/emergency call transcripts for Ausgrid (Sydney, Australia electricity network). ' +
      'Respond ONLY with valid JSON:\n' +
      '{"issue":"<max 10 words>","summary":"<2-3 sentences>",' +
      '"reportedOutageLocations":[{"query":"<suburb + NSW>"}],' +
      '"existingOutageLocations":[{"query":"<suburb + NSW>"}]}\n\n' +
      'Rules: reportedOutageLocations = places the caller says are currently without power (new report). ' +
      'existingOutageLocations = known/planned outages mentioned. Append ", NSW" if needed. ' +
      'Return empty arrays if none found. Never invent locations.\n\n' +
      transcriptText;
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    const call = await getCall(callId);
    if (parsed.issue) call.issue = parsed.issue;
    if (parsed.summary) call.summary = parsed.summary;
    call.transcript = transcript;

    const rawReported = (parsed.reportedOutageLocations || []).map(l => ({ ...l, type: "reported" }));
    const rawExisting = (parsed.existingOutageLocations || []).map(l => ({ ...l, type: "existing" }));
    const allRaw = [...rawReported, ...rawExisting];

    const alreadyGeocoded = new Set((call.outageLocations || []).map(l => l.query));
    const toGeocode = allRaw.filter(l => !alreadyGeocoded.has(l.query));

    if (toGeocode.length && process.env.GOOGLE_MAPS_API_KEY) {
      const results = await Promise.allSettled(
        toGeocode.map(async (entry) => {
          const geo = await geocodeLocationGoogle(entry.query);
          if (!geo) return null;
          return { query: entry.query, ...geo, type: entry.type };
        })
      );
      const newLocs = results.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
      const existing = (call.outageLocations || []).filter(l => allRaw.some(r => r.query === l.query));
      call.outageLocations = [...existing, ...newLocs];
      console.log("[gemini] geocoded", newLocs.length, "outage location(s) for", callId);
    }

    call.updatedAt = new Date().toISOString();
    console.log("[gemini] insights applied for", callId, ":", { issue: call.issue, summary: call.summary?.slice(0, 80) });
    await upsertCallToSupabase(call);
  } catch (err) {
    console.error("[gemini] insights generation failed", callId, err.message, err.status ?? "");
  }
}

function createDefaultCall(callId) {
  return {
    callId,
    callerName: "Live Caller",
    callerNumber: "+1 (000) 000-0000",
    status: "Active",
    issue: "Awaiting issue details",
    severity: "Moderate",
    transcript: [],
    summary: "Summary not received yet.",
    locationQuery: null,
    location: null,
    outageLocations: [],
    updatedAt: new Date().toISOString(),
  };
}

function hydrateRow(row) {
  return {
    callId: row.call_id,
    callerName: row.caller_name ?? "Live Caller",
    callerNumber: row.caller_number ?? "+1 (000) 000-0000",
    status: row.status ?? "Active",
    issue: row.issue ?? "Awaiting issue details",
    severity: row.severity ?? "Moderate",
    summary: row.summary ?? "Summary not received yet.",
    locationQuery: row.location_query ?? null,
    location: row.location ?? null,
    outageLocations: Array.isArray(row.outage_locations) ? row.outage_locations : [],
    transcript: Array.isArray(row.transcript) ? row.transcript : [],
    updatedAt: row.updated_at ?? new Date().toISOString(),
  };
}

async function getCall(callId = "live-call") {
  if (supabase) {
    const { data } = await supabase.from("calls").select("*").eq("call_id", callId).limit(1);
    if (data?.[0]) return hydrateRow(data[0]);
  }
  // Not in DB yet — create default and persist immediately
  const call = createDefaultCall(callId);
  await upsertCallToSupabase(call);
  return call;
}

function sanitizeText(value, fallback = "") {
  if (typeof value === "string") {
    return value.trim();
  }
  return fallback;
}

function normalizeTranscript(input) {
  if (Array.isArray(input)) {
    return input
      .map((m) => ({
        speaker: sanitizeText(m.speaker, "Agent") || "Agent",
        text: sanitizeText(m.text),
        timestamp: sanitizeText(m.timestamp, null) || new Date().toISOString(),
      }))
      .filter((m) => m.text.length > 0);
  }

  if (typeof input === "string") {
    const lines = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.flatMap((line) => {
      // Format: "{user} | {response}" — split into two entries
      if (line.includes("|")) {
        const [userText, agentText] = line.split("|").map((s) => s.trim());
        const entries = [];
        if (userText) entries.push({ speaker: "Caller", text: userText, timestamp: new Date().toISOString() });
        if (agentText) entries.push({ speaker: "Agent", text: agentText, timestamp: new Date().toISOString() });
        return entries;
      }

      const parts = line.split(":");
      if (parts.length > 1 && parts[0].length < 32) {
        const speaker = parts.shift().trim();
        return [{
          speaker: speaker || "Agent",
          text: parts.join(":").trim(),
          timestamp: new Date().toISOString(),
        }];
      }

      return [{
        speaker: "Agent",
        text: line,
        timestamp: new Date().toISOString(),
      }];
    });
  }

  return [];
}

async function upsertTranscriptToSupabase(callId, transcript) {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("calls")
      .upsert(
        { call_id: callId, transcript, updated_at: new Date().toISOString() },
        { onConflict: "call_id" }
      );
    if (error) console.error("[supabase] transcript upsert error", callId, error.message);
  } catch (err) {
    console.error("[supabase] transcript upsert failed", callId, err.message);
  }
}

async function upsertCallToSupabase(call) {
  if (!supabase || !call?.callId) return;

  const row = {
    call_id: call.callId,
    caller_name: call.callerName ?? null,
    caller_number: call.callerNumber ?? null,
    status: call.status ? call.status.toLowerCase() : null,
    issue: call.issue ?? null,
    severity: call.severity ?? null,
    summary: call.summary ?? null,
    location_query: call.locationQuery ?? null,
    location: call.location ?? null,
    outage_locations: call.outageLocations ?? [],
    transcript: Array.isArray(call.transcript) ? call.transcript : [],
    updated_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from("calls").upsert(row, { onConflict: "call_id" });
    if (error) {
      console.error("[supabase] call upsert error", call.callId, error.message, "| status value:", call.status);
    }
  } catch (error) {
    console.error("[supabase] call upsert failed", call.callId, error.message);
  }
}

function getPublicBaseUrl(req) {
  const configured = sanitizeText(process.env.PUBLIC_BASE_URL);
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

function verifyTwilioRequest(req, res, next) {
  if (!twilioAuthToken) {
    return next();
  }

  const signature = req.get("x-twilio-signature");
  if (!signature) {
    return res.status(403).send("Missing Twilio signature");
  }

  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const valid = twilio.validateRequest(twilioAuthToken, signature, url, req.body || {});
  if (!valid) {
    return res.status(403).send("Invalid Twilio signature");
  }

  return next();
}

function mapTwilioTrackToSpeaker(track) {
  const normalized = sanitizeText(track).toLowerCase();
  if (normalized === "inbound_track") return "Caller";
  if (normalized === "outbound_track") return "Agent";
  return "Conversation";
}

function parseTwilioTranscriptionData(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { transcript: raw };
  }
}

function extractTranscriptInput(body = {}) {
  if (!body || typeof body !== "object") return "";

  const candidates = [
    body.transcript,
    body.messages,
    body.conversation,
    body.fullTranscript,
    body.full_transcript,
    body.text,
    body.transcription,
    body.payload?.transcript,
    body.payload?.text,
    body.payload?.fullTranscript,
    body.payload?.full_transcript,
    body.payload?.message,
    body.payload?.messages,
    body.recording?.transcript,
  ];

  for (const candidate of candidates) {
    if (candidate != null && candidate !== "") return candidate;
  }

  if (Array.isArray(body.entries)) return body.entries;

  return "";
}

function extractCallId(body = {}, fallback = "live-call") {
  return sanitizeText(
    body.callId ||
      body.call_id ||
      body.CallSid ||
      body.callSid ||
      body.conversation_id ||
      body.conversationId,
    fallback
  );
}

function extractTranscriptEntries(body = {}) {
  if (!body || typeof body !== "object") return [];

  const timestamp = new Date().toISOString();
  const entries = [];
  const userText = sanitizeText(body.user);
  const agentText = sanitizeText(body.response);

  if (userText) {
    entries.push({
      speaker: "Caller",
      text: userText,
      timestamp,
    });
  }

  if (agentText) {
    entries.push({
      speaker: "Agent",
      text: agentText,
      timestamp,
    });
  }

  return entries;
}

async function geocodeLocationGoogle(query) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY not configured");
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Google geocoder HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== "OK" || !data.results?.length) return null;
  const loc = data.results[0];
  return { lat: loc.geometry.location.lat, lng: loc.geometry.location.lng, displayName: loc.formatted_address || query };
}

async function geocodeLocation(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encoded}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "sentinel-enterprise-dashboard/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Geocoder failed with status ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const item = data[0];
  return {
    lat: Number(item.lat),
    lng: Number(item.lon),
    displayName: item.display_name || query,
  };
}

function parseDotNetDate(val) {
  if (!val) return null;

  if (typeof val === "number") {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof val === "string") {
    const m = val.match(/\/Date\((\-?\d+)\)\//);
    if (m) {
      const d = new Date(Number(m[1]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function toISOorNull(d) {
  return d ? d.toISOString() : null;
}

function getPlannedStart(o) {
  return (
    parseDotNetDate(o.PlannedStartDateTime) ||
    parseDotNetDate(o.StartDateTime) ||
    parseDotNetDate(o.StartTime) ||
    null
  );
}

function getPlannedEnd(o) {
  return (
    parseDotNetDate(o.PlannedEndDateTime) ||
    parseDotNetDate(o.EndDateTime) ||
    parseDotNetDate(o.EstRestTime) ||
    null
  );
}

app.get("/v1/ausgrid/planned", async (req, res) => {
  const days = Number.parseInt(req.query.days, 10);
  const windowDays = Number.isInteger(days) && days > 0 ? days : 15;

  const limit = Number.parseInt(req.query.limit, 10);
  const maxItems = Number.isInteger(limit) && limit > 0 ? limit : 500;

  const url =
    "https://www.ausgrid.com.au/webapi/OutageListData/GetDetailedPlannedOutages";

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!r.ok) {
      return res.status(502).json({
        error: "Ausgrid request failed",
        status: r.status,
        statusText: r.statusText,
      });
    }

    const data = await r.json();

    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.d)
      ? data.d
      : Array.isArray(data?.Data)
      ? data.Data
      : [];

    const now = new Date();
    const end = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

    const normalized = rows
      .map((o) => {
        const start = getPlannedStart(o);
        const finish = getPlannedEnd(o);

        return {
          OutageDisplayType: o.OutageDisplayType ?? "P",
          Suburb: o.Suburb || o.Area || o.Location || null,
          CustomersAffected: o.CustomersAffected ?? o.Customers ?? null,
          OutageStatus: o.OutageStatus || o.Status || "Planned",
          StartDateTime: toISOorNull(start),
          EndDateTime: toISOorNull(finish),
          Cause: o.Cause,
          Streets: o.Streets,
          Coords: Array.isArray(o.Coords) ? o.Coords.slice(0, 8) : undefined,
        };
      })
      .filter((o) => {
        const start = o.StartDateTime ? new Date(o.StartDateTime) : null;
        if (!start || Number.isNaN(start.getTime())) return false;
        return start >= now && start <= end;
      });

    normalized.sort(
      (a, b) =>
        new Date(a.StartDateTime).getTime() - new Date(b.StartDateTime).getTime()
    );

    const trimmed = normalized.slice(0, maxItems);

    res.json({
      source: "ausgrid",
      fetchedAt: new Date().toISOString(),
      windowDays,
      windowStart: now.toISOString(),
      windowEnd: end.toISOString(),
      count: trimmed.length,
      outages: trimmed,
    });
  } catch (e) {
    const isAbort = e?.name === "AbortError";
    res.status(502).json({
      error: "Failed to fetch Ausgrid planned outages",
      reason: isAbort ? "timeout" : String(e),
    });
  } finally {
    clearTimeout(t);
  }
});

app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
});

app.get("/api/calls/:callId", async (req, res) => {
  res.json(await getCall(req.params.callId));
});

app.get("/api/calls/:callId/transcript", async (req, res) => {
  const callId = sanitizeText(req.params.callId, "live-call");
  if (!supabase) {
    return res.json({ callId, source: "memory", entries: [] });
  }

  try {
    const { data, error } = await supabase.from("calls").select("transcript").eq("call_id", callId).limit(1);
    if (!error && Array.isArray(data) && data.length && Array.isArray(data[0].transcript)) {
      return res.json({ callId, source: "supabase", entries: data[0].transcript });
    }
    if (error) {
      console.error("[supabase] fetch transcript", callId, error.message);
    }
  } catch (error) {
    console.error("[supabase] fetch transcript", callId, error.message);
  }

  res.json({ callId, source: "supabase", entries: [] });
});

app.post("/api/calls/:callId/insights", async (req, res) => {
  const callId = sanitizeText(req.params.callId, "live-call");
  if (!gemini) return res.status(503).json({ error: "Gemini not configured" });
  await generateInsights(callId);
  const call = await getCall(callId);
  res.json({ ok: true, issue: call?.issue, summary: call?.summary });
});

app.get("/api/calls", async (req, res) => {
  if (!supabase) return res.json({ calls: [] });
  const { data, error } = await supabase.from("calls").select("*").order("updated_at", { ascending: false });
  if (error) return res.status(502).json({ error: error.message });
  res.json({ calls: (data || []).map(hydrateRow) });
});

app.get("/api/cron/insights", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
    return res.status(401).end();
  }
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });

  const { data } = await supabase
    .from("calls")
    .select("call_id")
    .eq("status", "active");

  const active = data || [];
  await Promise.allSettled(active.map(r => generateInsights(r.call_id)));
  res.json({ ok: true, processed: active.length });
});

app.post("/webhook/location", async (req, res) => {
  try {
    const callId = sanitizeText(req.body?.callId, "live-call");
    const locationText = sanitizeText(req.body?.location || req.body?.locationText);

    if (!locationText && (req.body?.lat == null || req.body?.lng == null)) {
      return res.status(400).json({
        error: "Provide `location` string, or both `lat` and `lng`.",
      });
    }

    const call = await getCall(callId);
    call.locationQuery = locationText || call.locationQuery;

    if (req.body?.lat != null && req.body?.lng != null) {
      call.location = {
        lat: Number(req.body.lat),
        lng: Number(req.body.lng),
        displayName: sanitizeText(req.body?.displayName, locationText || "Coordinates"),
      };
    } else {
      const geo = await geocodeLocation(locationText);
      if (!geo) {
        return res.status(404).json({ error: "Location not found" });
      }
      call.location = geo;
    }

    call.updatedAt = new Date().toISOString();
    await upsertCallToSupabase(call);

    res.json({ ok: true, call });
  } catch (error) {
    res.status(502).json({ error: "Failed to geocode location", detail: String(error) });
  }
});

app.post("/webhook/call-start", async (req, res) => {
  try {
    const callId = extractCallId(req.body, `call-${Date.now()}`);
    const call = await getCall(callId);
    const hasOnlyCallId =
      req.body &&
      typeof req.body === "object" &&
      Object.keys(req.body).every((key) =>
        ["callId", "call_id", "CallSid", "callSid", "conversation_id", "conversationId"].includes(key)
      );

    // ElevenLabs may send only a stable identifier on call start. Treat that as valid.
    if (hasOnlyCallId) {
      call.status = "Active";
      call.updatedAt = new Date().toISOString();
      await upsertCallToSupabase(call);
      return res.status(200).json({ ok: true, callId: call.callId, call });
    }

    if (req.body?.callerName) call.callerName = sanitizeText(req.body.callerName, call.callerName);
    if (req.body?.callerNumber || req.body?.caller_phone) {
      call.callerNumber = sanitizeText(req.body.callerNumber || req.body?.caller_phone, call.callerNumber);
    }
    if (req.body?.issue || req.body?.incident_type) {
      call.issue = sanitizeText(req.body.issue || req.body?.incident_type, call.issue);
    }
    if (req.body?.status) call.status = sanitizeText(req.body.status, "Active");
    else call.status = "Active";
    if (req.body?.severity || req.body?.priority) {
      call.severity = sanitizeText(req.body.severity || req.body?.priority, call.severity);
    }
    if (req.body?.summary) call.summary = sanitizeText(req.body.summary, call.summary);
    if (req.body?.location || req.body?.locationText || req.body?.location_text) {
      call.locationQuery = sanitizeText(
        req.body.location || req.body.locationText || req.body.location_text,
        call.locationQuery
      );
    }

    call.updatedAt = new Date().toISOString();
    await upsertCallToSupabase(call);

    return res.status(200).json({ ok: true, callId: call.callId, call });
  } catch (error) {
    console.error("[call start webhook]", error);
    return res.status(500).json({ ok: false, error: "Failed to create call", detail: String(error) });
  }
});

async function handleTranscriptWebhook(req, res) {
  try {
    const callId = extractCallId(req.body, "live-call");
    const call = await getCall(callId);
    if (!Array.isArray(call.transcript)) {
      call.transcript = [];
    }

    if (req.body?.callerName) call.callerName = sanitizeText(req.body.callerName, call.callerName);
    if (req.body?.callerNumber) call.callerNumber = sanitizeText(req.body.callerNumber, call.callerNumber);
    if (req.body?.issue) call.issue = sanitizeText(req.body.issue, call.issue);
    if (req.body?.status) call.status = sanitizeText(req.body.status, call.status);
    if (req.body?.severity) call.severity = sanitizeText(req.body.severity, call.severity);

    const explicitEntries = extractTranscriptEntries(req.body);
    const transcriptInput = extractTranscriptInput(req.body);
    const normalized =
      explicitEntries.length > 0 ? explicitEntries : normalizeTranscript(transcriptInput);

    // Individual turn pairs (user/response) default to append; full transcript replacements default to replace.
    const rawMode = sanitizeText(req.body?.mode, "").toLowerCase();
    const mode = rawMode || (explicitEntries.length > 0 ? "append" : "replace");

    if (mode === "append") {
      call.transcript.push(...normalized);
    } else {
      call.transcript = normalized;
    }

    call.updatedAt = new Date().toISOString();
    await upsertTranscriptToSupabase(callId, call.transcript);

    // Trigger insights every 5 transcript entries (Hobby-plan alternative to cron)
    if (call.transcript.length % 5 === 0) {
      generateInsights(callId).catch(() => {});
    }

    return res.status(200).json({ ok: true, entries: normalized.length, call });
  } catch (err) {
    console.error("[transcript webhook]", err);
    return res
      .status(200)
      .json({ ok: false, error: "Internal error processing transcript", detail: String(err) });
  }
}

app.post("/webhook/transcript", handleTranscriptWebhook);
app.post("/transcript", handleTranscriptWebhook);

app.post("/webhook/summary", async (req, res) => {
  const callId = sanitizeText(req.body?.callId, "live-call");
  const summary = sanitizeText(req.body?.summary);
  const call = await getCall(callId);

  if (!summary) {
    return res.status(400).json({ error: "Provide `summary` as a non-empty string." });
  }

  call.summary = summary;
  if (req.body?.status) call.status = sanitizeText(req.body.status, call.status);
  call.updatedAt = new Date().toISOString();

  await upsertCallToSupabase(call);
  res.json({ ok: true, call });
});

app.post("/twilio/voice", verifyTwilioRequest, async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = sanitizeText(req.body?.CallSid, "live-call");
  const from = sanitizeText(req.body?.From);
  const to = sanitizeText(req.body?.To);
  const call = await getCall(callSid);

  if (from) call.callerNumber = from;
  if (to && (!call.issue || call.issue === "Awaiting issue details")) {
    call.issue = `Incoming call to ${to}`;
  }
  call.status = "Active";
  call.updatedAt = new Date().toISOString();
  await upsertCallToSupabase(call);

  const start = twiml.start();
  start.transcription({
    name: "Sentinel Live Transcription",
    statusCallbackUrl: `${getPublicBaseUrl(req)}/twilio/transcription`,
    track: sanitizeText(process.env.TWILIO_TRANSCRIPTION_TRACK, "both_tracks"),
    languageCode: sanitizeText(process.env.TWILIO_TRANSCRIPTION_LANGUAGE, "en-US"),
    transcriptionEngine: sanitizeText(process.env.TWILIO_TRANSCRIPTION_ENGINE, "google"),
    speechModel: sanitizeText(process.env.TWILIO_TRANSCRIPTION_MODEL, "telephony"),
  });

  twiml.say("You are connected. Live transcription has started.");
  twiml.pause({ length: 3600 });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/twilio/transcription", verifyTwilioRequest, async (req, res) => {
  const eventType = sanitizeText(req.body?.TranscriptionEvent);
  const callSid = sanitizeText(req.body?.CallSid, "live-call");
  const call = await getCall(callSid);

  if (eventType === "transcription-content") {
    const isFinal = String(req.body?.Final ?? "true").toLowerCase() === "true";
    if (!isFinal) {
      return res.status(200).send("OK");
    }

    const data = parseTwilioTranscriptionData(req.body?.TranscriptionData);
    const text = sanitizeText(data?.transcript);

    if (text) {
      const confidence =
        typeof data?.confidence === "number" ? ` (${Math.round(data.confidence * 100)}% conf)` : "";

      call.transcript.push({
        speaker: mapTwilioTrackToSpeaker(req.body?.Track),
        text: `${text}${confidence}`,
        timestamp: sanitizeText(req.body?.Timestamp, new Date().toISOString()),
      });
      call.updatedAt = new Date().toISOString();
      await upsertCallToSupabase(call);
      await upsertTranscriptToSupabase(callSid, call.transcript);
    }
  } else if (eventType === "transcription-stopped") {
    call.status = "Completed";
    call.updatedAt = new Date().toISOString();
    await upsertCallToSupabase(call);
    await generateInsights(callSid);
  }

  res.status(200).send("OK");
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Local dev: start server directly. Vercel imports this file and uses the export.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
