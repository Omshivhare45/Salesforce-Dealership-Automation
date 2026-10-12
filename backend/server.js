require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const jsforce = require("jsforce");

const app = express();
const PORT = process.env.PORT || 4000;

const SF_LOGIN_URL = (process.env.SF_LOGIN_URL || "").replace(/\/+$/, "");
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_CALLBACK_URL = process.env.SF_CALLBACK_URL;

if (!SF_LOGIN_URL || !SF_CLIENT_ID || !SF_CLIENT_SECRET || !SF_CALLBACK_URL) {
  console.error(
    "Missing one or more required env vars: SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_CALLBACK_URL"
  );
  process.exit(1);
}

app.use(cors());
app.use(express.json());

const oauth2 = new jsforce.OAuth2({
  loginUrl: SF_LOGIN_URL,
  clientId: SF_CLIENT_ID,
  clientSecret: SF_CLIENT_SECRET,
  redirectUri: SF_CALLBACK_URL,
});

// NOTE: In-memory, single-user connection. Lost on restart.
// TODO: persist refresh token (file, DB, or secret store) for production.
let salesforceConnection = null;

// state -> { verifier, createdAt }
const pendingOAuth = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Remove abandoned OAuth flows so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pendingOAuth) {
    if (now - entry.createdAt > OAUTH_STATE_TTL_MS) {
      pendingOAuth.delete(state);
    }
  }
}, 60 * 1000).unref();

const LEAD_ID_PATTERN = /^00Q[a-zA-Z0-9]{12,15}$/;
const ALLOWED_STATUSES = [
  "Pending Approval",
  "Approved",
  "Rejected",
  "Reschedule Required",
  "Completed",
  "Cancelled",
];

// Home route
app.get("/", (req, res) => {
  res.json({
    app: "Take A Drive Backend",
    status: "running",
    salesforceConnected: Boolean(salesforceConnection),
  });
});

// Start Salesforce OAuth with PKCE
app.get("/auth", (req, res) => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  const state = crypto.randomBytes(24).toString("hex");
  pendingOAuth.set(state, { verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SF_CLIENT_ID,
    redirect_uri: SF_CALLBACK_URL,
    scope: "api refresh_token",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  res.redirect(`${SF_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`);
});

// Salesforce OAuth callback
app.get("/oauth/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res
        .status(400)
        .send(`Salesforce authorization failed: ${req.query.error}`);
    }

    const { code, state } = req.query;
    const pending = typeof state === "string" ? pendingOAuth.get(state) : null;

    if (!code || !pending) {
      return res
        .status(400)
        .send("Missing authorization code or invalid state. Open /auth again.");
    }

    pendingOAuth.delete(state);

    const tokenResponse = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
        redirect_uri: SF_CALLBACK_URL,
        code_verifier: pending.verifier,
      }),
    });

    const rawResponse = await tokenResponse.text();

    let tokens;
    try {
      tokens = JSON.parse(rawResponse);
    } catch (parseError) {
      console.error("Salesforce returned a non-JSON response:", {
        status: tokenResponse.status,
        body: rawResponse.slice(0, 500),
      });
      return res
        .status(502)
        .send(
          "Salesforce token endpoint returned an unexpected response. Check the backend terminal."
        );
    }

    if (!tokenResponse.ok) {
      console.error("Salesforce token error:", {
        status: tokenResponse.status,
        error: tokens.error,
        description: tokens.error_description,
      });
      return res
        .status(400)
        .send(
          `Token exchange failed: ${tokens.error || "unknown_error"}. ` +
            `${tokens.error_description || "Check backend terminal."}`
        );
    }

    salesforceConnection = new jsforce.Connection({
      instanceUrl: tokens.instance_url,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      oauth2,
    });

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Salesforce Connected</title>
      </head>
      <body style="font-family:Arial,sans-serif;padding:40px">
        <h1>Salesforce connected successfully!</h1>
        <p>Take A Drive backend is authorized.</p>
        <p><a href="/api/leads">Test Leads API</a></p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.status(500).send("Salesforce connection failed. Check backend terminal.");
  }
});

// Require an active Salesforce connection
function requireSalesforce(req, res, next) {
  if (!salesforceConnection) {
    return res.status(401).json({
      error: "Salesforce is not connected.",
      loginUrl: "/auth",
    });
  }
  next();
}

// Get recent Leads
app.get("/api/leads", requireSalesforce, async (req, res) => {
  try {
    const result = await salesforceConnection.query(`
      SELECT Id, FirstName, LastName, Email, Company, City, Status, CreatedDate
      FROM Lead
      ORDER BY CreatedDate DESC
      LIMIT 100
    `);
    res.json(result.records);
  } catch (error) {
    console.error("Lead query error:", error);
    res.status(500).json({ error: "Could not fetch Salesforce Leads." });
  }
});

// Update Test Drive Status
app.patch(
  "/api/leads/:id/test-drive-status",
  requireSalesforce,
  async (req, res) => {
    const { status } = req.body || {};

    if (!LEAD_ID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: "Invalid Salesforce Lead ID." });
    }

    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid test-drive status." });
    }

    try {
      const result = await salesforceConnection.sobject("Lead").update({
        Id: req.params.id,
        Test_Drive_Status__c: status,
      });

      if (!result.success) {
        const message = result.errors?.map((e) => e.message).join("; ");
        console.error("Lead update rejected:", result.errors);
        return res.status(400).json({
          error: message || "Salesforce rejected the update.",
        });
      }

      res.json({ success: true, id: req.params.id, status });
    } catch (error) {
      console.error("Lead update error:", error);
      res.status(500).json({
        error:
          "Could not update status. Check field API name and permissions.",
        detail: error.message,
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Take A Drive backend running at http://localhost:${PORT}`);
  console.log(`Connect Salesforce at http://localhost:${PORT}/auth`);
});