// index.js (CommonJS)
const express = require("express");

const app = express();
app.use(express.json());

// Parse Ausgrid .NET dates like "/Date(1771718700000)/"
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
    // ISO fallback
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function toISOorNull(d) {
  return d ? d.toISOString() : null;
}

// Choose the best "planned start" field that exists
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

// GET /v1/ausgrid/planned?days=15&limit=200
app.get("/v1/ausgrid/planned", async (req, res) => {
  const days = Number.parseInt(req.query.days, 10);
  const windowDays = Number.isInteger(days) && days > 0 ? days : 15;

  const limit = Number.parseInt(req.query.limit, 10);
  const maxItems = Number.isInteger(limit) && limit > 0 ? limit : 500; // safety cap

  const url =
    "https://www.ausgrid.com.au/webapi/OutageListData/GetDetailedPlannedOutages";

  // timeout for fetch
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

    // Support multiple possible shapes
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
          WebId: o.WebId ?? null,
          OutageDisplayType: o.OutageDisplayType ?? "P",
          Suburb: o.Suburb || o.Area || o.Location || null,
          CustomersAffected: o.CustomersAffected ?? o.Customers ?? null,
          OutageStatus: o.OutageStatus || o.Status || "Planned",
          StartDateTime: toISOorNull(start),
          EndDateTime: toISOorNull(finish),
          // keep coords optional & small; remove if you hit size limits
          Coords: Array.isArray(o.Coords) ? o.Coords.slice(0, 8) : undefined,
        };
      })
      // Filter: only outages with a valid planned start inside [now, now+15d]
      .filter((o) => {
        const start = o.StartDateTime ? new Date(o.StartDateTime) : null;
        if (!start || Number.isNaN(start.getTime())) return false;
        return start >= now && start <= end;
      });

    // Optional: sort by soonest start
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

app.listen(8080, () => console.log("Listening on http://localhost:8080"));