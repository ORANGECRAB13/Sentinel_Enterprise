const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Server running" });
});

// GET endpoint your ElevenLabs agent can call directly.
app.get("/ausgrid/outages", async (req, res) => {
  try {
    const response = await fetch(
      "https://www.ausgrid.com.au/webapi/OutageListData/GetDetailedPlannedOutages",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    // Trim response to prevent 413
    const trimmed = (data.d || []).slice(0, 5).map(o => ({
      WebId: o.WebId,
      Suburb: o.Suburb,
      CustomersAffected: o.CustomersAffected,
      OutageStatus: o.OutageStatus,
      OutageDisplayType: o.OutageDisplayType
    }));

    const payload = {
      source: "ausgrid",
      fetchedAt: new Date().toISOString(),
      count: trimmed.length,
      outages: trimmed
    };
    res.json(payload);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Ausgrid data" });
  }
});


app.listen(8000, () => {
  console.log("Server running on port 8000");
});
