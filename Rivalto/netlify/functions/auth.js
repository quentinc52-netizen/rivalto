// netlify/functions/auth.js
// Reçoit le code OAuth Strava, échange contre un token, sauvegarde dans Supabase

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const { code } = JSON.parse(event.body || "{}");
    if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: "Code manquant" }) };

    // 1. Échanger le code contre un token Strava
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code"
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Erreur Strava", detail: tokenData }) };
    }

    const athlete = tokenData.athlete;

    // 2. Sauvegarder / mettre à jour l'utilisateur dans Supabase
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
        "Authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        id: athlete.id,
        username: athlete.username,
        firstname: athlete.firstname,
        lastname: athlete.lastname,
        profile_pic: athlete.profile,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_expires: tokenData.expires_at
      })
    });

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Erreur Supabase", detail: err }) };
    }

    // 3. Renvoyer les infos utiles au front (jamais les tokens !)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        id: athlete.id,
        firstname: athlete.firstname,
        lastname: athlete.lastname,
        username: athlete.username,
        profile_pic: athlete.profile,
        // On renvoie un token de session simplifié (l'id suffit pour prototype)
        session_token: Buffer.from(`${athlete.id}:${tokenData.access_token.slice(0,8)}`).toString("base64")
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
