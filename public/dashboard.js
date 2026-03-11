const state = {
  callId: "live-call",
  map: null,
  outageCircles: [],
  callsById: new Map(),
  transcriptRequestToken: 0,
  supabaseClient: null,
  realtimeChannel: null,
};

const els = {
  connectionState: document.getElementById("connectionState"),
  tabButtons: Array.from(document.querySelectorAll(".icon-btn[data-tab]")),
  homePanel: document.getElementById("tab-home"),
  callsPanel: document.getElementById("tab-calls"),
  callsLayout: document.querySelector(".calls-layout"),
  transcriptResizer: document.getElementById("transcriptResizer"),
  callList: document.getElementById("callList"),
  callListCount: document.getElementById("callListCount"),
  metricCsat: document.getElementById("metricCsat"),
  metricTotalCalls: document.getElementById("metricTotalCalls"),
  metricTotalDuration: document.getElementById("metricTotalDuration"),
  metricAvgDuration: document.getElementById("metricAvgDuration"),
  cityBars: document.getElementById("cityBars"),
  callerName: document.getElementById("callerName"),
  callerNumber: document.getElementById("callerNumber"),
  callStatus: document.getElementById("callStatus"),
  callIssue: document.getElementById("callIssue"),
  callSeverity: document.getElementById("callSeverity"),
  callSummary: document.getElementById("callSummary"),
  outageLocationSummary: document.getElementById("outageLocationSummary"),
  transcriptList: document.getElementById("transcriptList"),
  transcriptCount: document.getElementById("transcriptCount"),
  updatedAt: document.getElementById("updatedAt"),
};

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([-33.8688, 151.2093], 10);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(state.map);
}

function fmtDateTime(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("escal")) return "#eb5757";
  if (s.includes("resolved")) return "#26b569";
  if (s.includes("pending")) return "#e5a900";
  return "#1f77ff";
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function callDurationEstimate(call) {
  return Math.max(2, Math.round((call.transcript?.length || 0) * 1.6));
}

function cityFromCall(call) {
  const first = call.outageLocations?.[0];
  const src = first?.displayName || first?.query || call.location?.displayName || call.locationQuery || "Unknown";
  return String(src).split(",")[0].trim() || "Unknown";
}

function renderMetrics(calls) {
  const totalCalls = calls.length;
  const totalDuration = calls.reduce((sum, call) => sum + callDurationEstimate(call), 0);
  const avgDuration = totalCalls ? Math.round(totalDuration / totalCalls) : 0;

  const resolved = calls.filter((call) => String(call.status || "").toLowerCase().includes("resolved")).length;
  const csat = totalCalls ? Math.min(10, (4 + (resolved / totalCalls) * 6)).toFixed(1) : "5.5";

  els.metricCsat.textContent = csat;
  els.metricTotalCalls.textContent = String(totalCalls);
  els.metricTotalDuration.textContent = String(totalDuration);
  els.metricAvgDuration.textContent = String(avgDuration);

  const cityCounts = new Map();
  for (const call of calls) {
    const city = cityFromCall(call);
    cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
  }

  const sorted = Array.from(cityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);

  const maxCount = sorted[0]?.[1] || 1;
  if (sorted.length === 0) {
    els.cityBars.innerHTML = '<p class="tiny muted">No city data yet.</p>';
    return;
  }

  els.cityBars.innerHTML = sorted
    .map(
      ([city, count]) =>
        `<div class="city-row"><span>${escapeHtml(city)}</span><div class="city-track"><i class="city-fill" style="width:${(count / maxCount) * 100}%"></i></div><strong>${count}</strong></div>`
    )
    .join("");
}

function renderCallList() {
  const calls = Array.from(state.callsById.values()).sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  );

  els.callListCount.textContent = `${calls.length} call${calls.length === 1 ? "" : "s"}`;

  if (calls.length === 0) {
    els.callList.innerHTML = '<p class="tiny muted">No calls available yet.</p>';
    return;
  }

  els.callList.innerHTML = calls
    .map((call) => {
      const active = call.callId === state.callId ? "active" : "";
      return `
        <button class="call-item ${active}" data-call-id="${escapeHtml(call.callId)}">
          <div class="name">${escapeHtml(call.callerName || call.callId)}</div>
          <div class="meta">${escapeHtml(call.issue || "No issue")}</div>
          <div class="meta">${escapeHtml(call.status || "Active")} • ${escapeHtml(fmtDateTime(call.updatedAt))}</div>
        </button>
      `;
    })
    .join("");

  for (const item of els.callList.querySelectorAll(".call-item")) {
    item.addEventListener("click", () => {
      const callId = item.getAttribute("data-call-id");
      if (!callId || callId === state.callId) return;
      state.callId = callId;
      const call = state.callsById.get(callId);
      if (call) {
        applyCall(call);
        loadTranscriptForCall(callId);
      }
      subscribeTranscript(callId);
      renderCallList();
    });
  }
}

function paintTranscript(transcript) {
  els.transcriptList.innerHTML = "";

  if (!Array.isArray(transcript) || transcript.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tiny muted";
    empty.textContent = "No transcript received yet.";
    els.transcriptList.appendChild(empty);
    els.transcriptCount.textContent = "0 entries";
    return;
  }

  transcript.forEach((entry) => {
    const speaker = String(entry.speaker || "Agent");
    const isCaller = speaker.toLowerCase().includes("caller") || speaker.toLowerCase().includes("customer");
    const bubble = document.createElement("article");

    bubble.className = `bubble ${isCaller ? "caller" : "agent"}`;
    bubble.innerHTML = `
      <span class="speaker">${escapeHtml(speaker)}</span>
      <div>${escapeHtml(entry.text)}</div>
      <span class="timestamp">${escapeHtml(fmtDateTime(entry.timestamp))}</span>
    `;

    els.transcriptList.appendChild(bubble);
  });

  els.transcriptCount.textContent = `${transcript.length} entr${transcript.length === 1 ? "y" : "ies"}`;
  els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
}

function renderOutageCircles(outageLocations) {
  for (const c of state.outageCircles) c.remove();
  state.outageCircles = [];

  if (!Array.isArray(outageLocations) || !outageLocations.length) {
    state.map.setView([-33.8688, 151.2093], 10);
    return;
  }

  const bounds = [];
  for (const loc of outageLocations) {
    if (typeof loc.lat !== "number" || typeof loc.lng !== "number") continue;
    const isReported = loc.type === "reported";
    const circle = L.circle([loc.lat, loc.lng], {
      radius: 600,
      color: isReported ? "#eb5757" : "#e5a900",
      fillColor: isReported ? "#eb5757" : "#e5a900",
      fillOpacity: 0.35,
      weight: 2,
      className: isReported ? "outage-circle outage-reported" : "outage-circle outage-existing",
    });
    circle.bindPopup(
      `<strong>${loc.displayName || loc.query}</strong><br>` +
      `<span style="color:${isReported ? "#eb5757" : "#e5a900"}">${isReported ? "Reported outage" : "Known outage"}</span>`
    );
    circle.addTo(state.map);
    state.outageCircles.push(circle);
    bounds.push([loc.lat, loc.lng]);
  }

  if (bounds.length === 1) state.map.setView(bounds[0], 13);
  else if (bounds.length > 1) state.map.fitBounds(bounds, { padding: [30, 30] });
}

function applyCall(call) {
  if (!call) return;

  els.callerName.textContent = call.callerName || "Live Caller";
  els.callerNumber.textContent = call.callerNumber || "+1 (000) 000-0000";
  els.callStatus.textContent = call.status || "Active";
  els.callStatus.style.borderColor = statusColor(call.status);
  els.callStatus.style.color = statusColor(call.status);

  els.callIssue.textContent = call.issue || "Awaiting issue details";
  els.callSeverity.textContent = call.severity || "Moderate";
  els.callSummary.textContent = call.summary || "Summary not received yet.";
  els.updatedAt.textContent = `Updated: ${fmtDateTime(call.updatedAt)}`;

  const locs = Array.isArray(call.outageLocations) ? call.outageLocations : [];
  const reported = locs.filter(l => l.type === "reported").length;
  const existing = locs.filter(l => l.type === "existing").length;
  els.outageLocationSummary.textContent = locs.length === 0
    ? "No outages mapped yet"
    : [reported && `${reported} reported`, existing && `${existing} known`].filter(Boolean).join(" · ");
  if (state.map) renderOutageCircles(locs);
}

function unsubscribeTranscript() {
  if (state.realtimeChannel && state.supabaseClient) {
    state.supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
}

function subscribeTranscript(callId) {
  if (!state.supabaseClient) return;
  unsubscribeTranscript();
  state.realtimeChannel = state.supabaseClient
    .channel(`transcript:${callId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "calls", filter: `call_id=eq.${callId}` },
      (payload) => {
        if (callId !== state.callId) return;
        const entries = payload.new?.transcript;
        if (Array.isArray(entries)) paintTranscript(entries);
      }
    )
    .subscribe();
}

async function initSupabase() {
  try {
    const resp = await fetch("/api/config");
    if (!resp.ok) return;
    const config = await resp.json();
    if (!config.supabaseUrl || !config.supabaseAnonKey) return;
    state.supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    subscribeTranscript(state.callId);
  } catch (_err) {
    // Supabase not configured — SSE-only fallback
  }
}

async function loadTranscriptForCall(callId) {
  const token = ++state.transcriptRequestToken;
  try {
    const response = await fetch(`/api/calls/${encodeURIComponent(callId)}/transcript`);
    if (!response.ok) {
      throw new Error(`Failed transcript load: ${response.status}`);
    }

    const payload = await response.json();
    if (token !== state.transcriptRequestToken || callId !== state.callId) return;
    paintTranscript(Array.isArray(payload.entries) ? payload.entries : []);
  } catch (_error) {
    if (token !== state.transcriptRequestToken || callId !== state.callId) return;
    paintTranscript([]);
  }
}

let mapInitialized = false;

function setTab(tabName) {
  const showHome = tabName === "home";
  els.homePanel.classList.toggle("hidden", !showHome);
  els.callsPanel.classList.toggle("hidden", showHome);

  for (const btn of els.tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  }

  if (!showHome) {
    if (!mapInitialized) {
      mapInitialized = true;
      initMap();
    } else {
      setTimeout(() => {
        state.map.invalidateSize();
        const current = state.callsById.get(state.callId);
        if (current?.outageLocations) renderOutageCircles(current.outageLocations);
      }, 100);
    }
  }
}

async function loadAllCalls() {
  const response = await fetch("/api/calls");
  if (!response.ok) {
    throw new Error(`Failed to load calls: ${response.status}`);
  }

  const data = await response.json();
  const calls = Array.isArray(data.calls) ? data.calls : [];

  state.callsById.clear();
  for (const call of calls) {
    state.callsById.set(call.callId, call);
  }

  if (!state.callsById.has(state.callId) && calls[0]) {
    state.callId = calls[0].callId;
  }

  renderMetrics(calls);
  renderCallList();
  applyCall(state.callsById.get(state.callId));
  await loadTranscriptForCall(state.callId);
}

function startPolling() {
  async function poll() {
    try {
      const resp = await fetch("/api/calls");
      if (!resp.ok) throw new Error(resp.status);
      const data = await resp.json();
      const calls = Array.isArray(data.calls) ? data.calls : [];
      for (const call of calls) {
        state.callsById.set(call.callId, call);
      }
      renderMetrics(Array.from(state.callsById.values()));
      renderCallList();
      const current = state.callsById.get(state.callId);
      if (current) applyCall(current);
      els.connectionState.textContent = "System online";
    } catch (_err) {
      els.connectionState.textContent = "Reconnecting...";
    }
  }
  poll();
  setInterval(poll, 4000);
}

function bindTabButtons() {
  for (const btn of els.tabButtons) {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  }
}

function initTranscriptResize() {
  if (!els.transcriptResizer || !els.callsLayout) return;

  const minWidth = 240;
  const maxWidth = 520;
  let dragging = false;

  const onMove = (event) => {
    if (!dragging) return;
    if (window.matchMedia("(max-width: 1300px)").matches) return;

    const rect = els.callsLayout.getBoundingClientRect();
    const rightWidth = rect.right - event.clientX;
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, rightWidth));
    els.callsLayout.style.setProperty("--transcript-width", `${Math.round(nextWidth)}px`);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  els.transcriptResizer.addEventListener("mousedown", (event) => {
    if (window.matchMedia("(max-width: 1300px)").matches) return;
    event.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

async function bootstrap() {
  bindTabButtons();
  initTranscriptResize();
  setTab("calls");

  document.getElementById("callListToggle")?.addEventListener("click", () => {
    const panel = document.querySelector(".call-list-panel");
    panel.classList.toggle("collapsed");
    document.getElementById("callListToggle").classList.toggle("rotated");
  });

  try {
    await loadAllCalls();
  } catch (_error) {
    els.connectionState.textContent = "Load error";
  }

  await initSupabase();
  startPolling();
}

bootstrap();
