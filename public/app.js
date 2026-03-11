const state = {
  callId: "live-call",
  map: null,
  marker: null,
};

const els = {
  connectionState: document.getElementById("connectionState"),
  callerName: document.getElementById("callerName"),
  callerNumber: document.getElementById("callerNumber"),
  callStatus: document.getElementById("callStatus"),
  callIssue: document.getElementById("callIssue"),
  callSeverity: document.getElementById("callSeverity"),
  callSummary: document.getElementById("callSummary"),
  locationQuery: document.getElementById("locationQuery"),
  transcriptList: document.getElementById("transcriptList"),
  transcriptCount: document.getElementById("transcriptCount"),
  updatedAt: document.getElementById("updatedAt"),
};

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([37.7749, -122.4194], 10);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
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

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("escal")) return "#ff4d57";
  if (s.includes("resolved")) return "#44e19f";
  if (s.includes("pending")) return "#ffd15b";
  return "#1fe4bf";
}

function paintTranscript(transcript) {
  els.transcriptList.innerHTML = "";

  if (!Array.isArray(transcript) || transcript.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted tiny";
    empty.textContent = "No transcript received yet.";
    els.transcriptList.appendChild(empty);
    els.transcriptCount.textContent = "0 entries";
    return;
  }

  transcript.forEach((entry) => {
    const speaker = String(entry.speaker || "Agent");
    const bubble = document.createElement("article");
    const isCaller = speaker.toLowerCase().includes("caller") || speaker.toLowerCase().includes("customer");

    bubble.className = `bubble ${isCaller ? "caller" : "agent"}`;
    bubble.innerHTML = `
      <span class="speaker">${speaker}</span>
      <div>${String(entry.text || "")}</div>
      <span class="timestamp">${fmtDateTime(entry.timestamp)}</span>
    `;

    els.transcriptList.appendChild(bubble);
  });

  els.transcriptCount.textContent = `${transcript.length} entr${transcript.length === 1 ? "y" : "ies"}`;
  els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
}

function updateMap(location) {
  if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
    return;
  }

  const latLng = [location.lat, location.lng];
  if (!state.marker) {
    state.marker = L.marker(latLng).addTo(state.map);
  } else {
    state.marker.setLatLng(latLng);
  }

  state.marker.bindPopup(location.displayName || "Caller location");
  state.map.flyTo(latLng, 13, { duration: 0.85 });
}

function applyCall(call) {
  if (!call) return;

  els.callerName.textContent = call.callerName || "Live Caller";
  els.callerNumber.textContent = call.callerNumber || "+1 (000) 000-0000";
  els.callStatus.textContent = call.status || "Active";
  els.callStatus.style.borderColor = statusClass(call.status);
  els.callStatus.style.color = statusClass(call.status);
  els.callIssue.textContent = call.issue || "Awaiting issue details";
  els.callSeverity.textContent = call.severity || "Moderate";
  els.callSummary.textContent = call.summary || "Summary not received yet.";
  els.locationQuery.textContent = call.locationQuery || call.location?.displayName || "No location yet";
  els.updatedAt.textContent = `Updated: ${fmtDateTime(call.updatedAt)}`;

  paintTranscript(call.transcript || []);
  updateMap(call.location);
}

async function loadInitialState() {
  const response = await fetch(`/api/calls/${state.callId}`);
  if (!response.ok) {
    throw new Error(`Failed to load call: ${response.status}`);
  }
  const call = await response.json();
  applyCall(call);
}

function connectEvents() {
  const events = new EventSource("/events");

  events.onopen = () => {
    els.connectionState.textContent = "Live Connection";
  };

  events.onerror = () => {
    els.connectionState.textContent = "Reconnecting...";
  };

  events.addEventListener("call_update", (event) => {
    try {
      const call = JSON.parse(event.data);
      if (call.callId === state.callId) {
        applyCall(call);
      }
    } catch (_err) {
      // Ignore malformed event payloads.
    }
  });
}

async function bootstrap() {
  initMap();
  try {
    await loadInitialState();
  } catch (_err) {
    els.connectionState.textContent = "Load Error";
  }
  connectEvents();
}

bootstrap();
