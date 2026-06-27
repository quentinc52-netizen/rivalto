// netlify/functions/leaderboard.js
// Calcule le classement d'un groupe d'amis sur une période donnée

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const headers = {
  "Access-Control-Allow-Origin": "https://rivalto52.netlify.app",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

// Correspondance types Strava → catégories Rivalto
const SPORT_MAP = {
  Run: "run", TrailRun: "trail", Walk: "walk", Hike: "hike",
  Ride: "ride", VirtualRide: "ride", GravelRide: "ride",
  Swim: "swim", WeightTraining: "workout", Workout: "workout",
  Crossfit: "workout", Yoga: "workout", Elliptical: "workout"
};

function mapSport(stravaType) {
  return SPORT_MAP[stravaType] || "workout";
}

function calcEffort(acts) {
  // Score d'effort : durée (min) × intensité FC normalisée
  return acts.reduce((sum, a) => {
    const dur = (a.moving_time || 0) / 60;
    const hr = a.average_heartrate || 130;
    return sum + dur * (hr / 100);
  }, 0);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const { user_id, period = "semaine", sport = "all", crit = "effort" } = JSON.parse(event.body || "{}");
    if (!user_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "user_id manquant" }) };

    // 1. Récupérer les amis acceptés
    const frRes = await fetch(
      `${SUPABASE_URL}/rest/v1/friendships?or=(user_id.eq.${user_id},friend_id.eq.${user_id})&status=eq.accepted&select=user_id,friend_id`,
      { headers: { "apikey": SUPABASE_SECRET_KEY, "Authorization": `Bearer ${SUPABASE_SECRET_KEY}` } }
    );
    const friendships = await frRes.json();
    const friendIds = new Set([user_id]);
    friendships.forEach(f => {
      friendIds.add(f.user_id);
      friendIds.add(f.friend_id);
    });
    const groupIds = [...friendIds];

    // 2. Période
    const SPANS = { jour: 1, semaine: 7, mois: 30, annee: 365 };
    const days = SPANS[period] || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // 3. Récupérer les activités du groupe sur la période
    const sportFilter = sport !== "all"
      ? `&sport_type=in.(${Object.entries(SPORT_MAP).filter(([,v])=>v===sport).map(([k])=>k).join(",")})`
      : "";
    const actsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/activities?user_id=in.(${groupIds.join(",")})&start_date=gte.${since}${sportFilter}&select=*`,
      { headers: { "apikey": SUPABASE_SECRET_KEY, "Authorization": `Bearer ${SUPABASE_SECRET_KEY}` } }
    );
    const activities = await actsRes.json();

    // 4. Récupérer les infos des utilisateurs
    const usersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?id=in.(${groupIds.join(",")})&select=id,firstname,lastname,username,profile_pic`,
      { headers: { "apikey": SUPABASE_SECRET_KEY, "Authorization": `Bearer ${SUPABASE_SECRET_KEY}` } }
    );
    const users = await usersRes.json();

    // 5. Agréger par utilisateur
    const byUser = {};
    groupIds.forEach(id => { byUser[id] = []; });
    activities.forEach(a => { if (byUser[a.user_id]) byUser[a.user_id].push(a); });

    // 6. Calculer le score selon le critère
    const rows = users.map(u => {
      const acts = byUser[u.id] || [];
      const km = +(acts.reduce((s, a) => s + (a.distance || 0), 0) / 1000).toFixed(1);
      const cal = Math.round(acts.reduce((s, a) => s + (a.calories || 0), 0));
      const elev = Math.round(acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0));
      const sessions = acts.length;
      const activeDays = new Set(acts.map(a => a.start_date?.slice(0, 10))).size;
      const effort = Math.round(calcEffort(acts));

      const vals = { effort, cal, km, denivele: elev, seances: sessions, regularite: activeDays };
      return {
        user: { id: u.id, firstname: u.firstname, lastname: u.lastname, username: u.username, profile_pic: u.profile_pic },
        is_me: u.id === user_id,
        stats: { km, cal, elev, sessions, activeDays, effort },
        value: vals[crit] ?? effort
      };
    });

    rows.sort((a, b) => b.value - a.value);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ period, sport, crit, group: rows })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
