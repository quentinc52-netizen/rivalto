// netlify/functions/sync.js
// Récupère les activités Strava d'un utilisateur et les stocke dans Supabase

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const headers = {
  "Access-Control-Allow-Origin": "https://rivalto52.netlify.app",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

async function getUser(userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=*`, {
    headers: {
      "apikey": SUPABASE_SECRET_KEY,
      "Authorization": `Bearer ${SUPABASE_SECRET_KEY}`
    }
  });
  const data = await res.json();
  return data[0] || null;
}

async function refreshTokenIfNeeded(user) {
  const now = Math.floor(Date.now() / 1000);
  if (user.token_expires > now + 300) return user.access_token;

  // Token expiré — on le rafraîchit
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: user.refresh_token
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Impossible de rafraîchir le token Strava");

  // Mettre à jour dans Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${user.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SECRET_KEY,
      "Authorization": `Bearer ${SUPABASE_SECRET_KEY}`
    },
    body: JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires: data.expires_at
    })
  });

  return data.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const { user_id, session_token } = JSON.parse(event.body || "{}");
    if (!user_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "user_id manquant" }) };

    // Vérifier que le session_token correspond à ce user_id
    if (session_token) {
      const decoded = Buffer.from(session_token, "base64").toString("utf8");
      const tokenUserId = decoded.split(":")[0];
      if (String(tokenUserId) !== String(user_id)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: "Non autorisé" }) };
      }
    }

    // Récupérer l'utilisateur et son token
    const user = await getUser(user_id);
    if (!user) return { statusCode: 404, headers, body: JSON.stringify({ error: "Utilisateur inconnu" }) };

    const token = await refreshTokenIfNeeded(user);

    // Récupérer les activités des 90 derniers jours
    const after = Math.floor((Date.now() - 90 * 24 * 3600 * 1000) / 1000);
    const stravaRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    const activities = await stravaRes.json();
    if (!Array.isArray(activities)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Erreur Strava activities", detail: activities }) };
    }

    // Formater et insérer dans Supabase
    const rows = activities.map(a => ({
      id: a.id,
      user_id: user.id,
      name: a.name,
      sport_type: a.sport_type || a.type,
      start_date: a.start_date,
      distance: a.distance || 0,
      moving_time: a.moving_time || 0,
      elapsed_time: a.elapsed_time || 0,
      total_elevation_gain: a.total_elevation_gain || 0,
      average_speed: a.average_speed || 0,
      max_speed: a.max_speed || 0,
      average_heartrate: a.average_heartrate || null,
      max_heartrate: a.max_heartrate || null,
      calories: a.calories || 0
    }));

    if (rows.length > 0) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/activities`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SECRET_KEY,
          "Authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify(rows)
      });
      if (!insertRes.ok) {
        const err = await insertRes.text();
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Erreur insertion", detail: err }) };
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ synced: rows.length, message: `${rows.length} activités synchronisées` })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
