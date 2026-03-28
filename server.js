require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
secure: true,
httpOnly: true,
sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 jours
  }
}));

// ─── Base de données en mémoire (remplace par MongoDB/PostgreSQL en prod) ──
const users = new Map(); // discord_id -> user object

function getOrCreateUser(discordUser) {
  if (!users.has(discordUser.id)) {
    users.set(discordUser.id, {
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator,
      avatar: discordUser.avatar,
      balance: 1000,       // 1000 €V offerts à l'inscription
      bets: [],
      createdAt: new Date().toISOString()
    });
    console.log(`Nouvel utilisateur: ${discordUser.username}`);
  }
  return users.get(discordUser.id);
}

function getLeaderboard() {
  return [...users.values()]
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 20)
    .map(u => ({
      username: u.username,
      avatar: u.avatar,
      id: u.id,
      balance: u.balance,
      betsCount: u.bets.length,
      wins: u.bets.filter(b => b.status === 'win').length
    }));
}

// ─── Routes Discord OAuth ──────────────────────────────────

// 1. Redirige l'utilisateur vers Discord
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// 2. Discord redirige ici après connexion
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  }

  try {
    // Échange le code contre un access_token
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenResponse.data;

    // Récupère les infos du profil Discord
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const discordUser = userResponse.data;
    const user = getOrCreateUser(discordUser);

    // Sauvegarde en session
    req.session.userId = user.id;

    // Redirige vers le frontend
    res.redirect(`${process.env.FRONTEND_URL}?login=success`);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed`);
  }
});

// 3. Déconnexion
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─── Routes API ────────────────────────────────────────────

// Middleware : vérifie que l'utilisateur est connecté
function requireAuth(req, res, next) {
  if (!req.session.userId || !users.has(req.session.userId)) {
    return res.status(401).json({ error: 'Non connecté' });
  }
  next();
}

// Profil de l'utilisateur connecté
app.get('/api/me', requireAuth, (req, res) => {
  const user = users.get(req.session.userId);
  res.json({
    id: user.id,
    username: user.username,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`,
    balance: user.balance,
    bets: user.bets,
    createdAt: user.createdAt
  });
});

// Classement communauté
app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// Matchs disponibles
app.get('/api/matches', (req, res) => {
  res.json(MATCHES);
});

// Placer un pari
app.post('/api/bet', requireAuth, (req, res) => {
  const user = users.get(req.session.userId);
  const { picks, stake } = req.body;

  if (!picks || !Array.isArray(picks) || picks.length === 0) {
    return res.status(400).json({ error: 'Sélections invalides' });
  }
  if (!stake || stake < 1 || stake > 1000) {
    return res.status(400).json({ error: 'Mise invalide (1-1000 €V)' });
  }
  if (stake > user.balance) {
    return res.status(400).json({ error: 'Solde insuffisant' });
  }

  const totalOdd = picks.reduce((acc, p) => acc * p.odd, 1);
  const potentialGain = +(stake * totalOdd).toFixed(2);

  // Simulation résultat (en prod tu mettras les vrais résultats)
  const rand = Math.random();
  const status = rand < 0.45 ? 'win' : rand < 0.85 ? 'loss' : 'pending';

  user.balance -= stake;
  if (status === 'win') user.balance += potentialGain;
  user.balance = +user.balance.toFixed(2);

  const bet = {
    id: Date.now(),
    picks,
    stake,
    totalOdd: +totalOdd.toFixed(2),
    potentialGain,
    status,
    placedAt: new Date().toISOString()
  };
  user.bets.unshift(bet);

  res.json({ bet, newBalance: user.balance });
});

// ─── Données matchs ────────────────────────────────────────
const MATCHES = [
  // Dimanche 29 mars
  { id: 1, day: 'Dimanche 29 mars', league: 'Amical International', home: 'Colombie', hf: '🇨🇴', away: 'France', af: '🇫🇷', time: '21:00', odds: { h: 3.20, n: 3.30, a: 2.10 } },

  // Lundi 30 mars
  { id: 2, day: 'Lundi 30 mars', league: 'Amical International', home: 'Pays-Bas', hf: '🇳🇱', away: 'Belgique', af: '🇧🇪', time: '20:45', odds: { h: 1.90, n: 3.40, a: 3.80 } },
  { id: 3, day: 'Lundi 30 mars', league: 'Amical International', home: 'Allemagne', hf: '🇩🇪', away: 'Ghana', af: '🇬🇭', time: '20:45', odds: { h: 1.55, n: 3.80, a: 5.50 } },

  // Mardi 31 mars
  { id: 4, day: 'Mardi 31 mars', league: 'Amical International', home: 'Algérie', hf: '🇩🇿', away: 'Uruguay', af: '🇺🇾', time: '20:30', odds: { h: 2.40, n: 3.10, a: 2.90 } },
  { id: 5, day: 'Mardi 31 mars', league: 'Amical International', home: 'Angleterre', hf: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', away: 'Japon', af: '🇯🇵', time: '20:45', odds: { h: 1.75, n: 3.50, a: 4.20 } },
  { id: 6, day: 'Mardi 31 mars', league: 'Amical International', home: 'Maroc', hf: '🇲🇦', away: 'Paraguay', af: '🇵🇾', time: '20:00', odds: { h: 1.85, n: 3.20, a: 4.00 } },
  { id: 7, day: 'Mardi 31 mars', league: 'Amical International', home: 'Écosse', hf: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', away: "Côte d'Ivoire", af: '🇨🇮', time: '20:30', odds: { h: 2.60, n: 3.20, a: 2.70 } },
  { id: 8, day: 'Mardi 31 mars', league: 'Amical International', home: 'Norvège', hf: '🇳🇴', away: 'Suisse', af: '🇨🇭', time: '18:00', odds: { h: 2.50, n: 3.10, a: 2.80 } },
  { id: 9, day: 'Mardi 31 mars', league: 'Amical International', home: 'Autriche', hf: '🇦🇹', away: 'Corée du Sud', af: '🇰🇷', time: '20:45', odds: { h: 2.00, n: 3.20, a: 3.60 } },
  { id: 10, day: 'Mardi 31 mars', league: 'Amical International', home: 'Sénégal', hf: '🇸🇳', away: 'Gambie', af: '🇬🇲', time: '21:00', odds: { h: 1.70, n: 3.40, a: 4.80 } },
];
// ligne 217 vide
const path = require('path');
jsapp.use(express.static(__dirname + '/public')); app.get('/', function(req, res) {   res.sendFile(__dirname + '/public/index.html'); });
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ BetZone backend démarré sur http://localhost:${PORT}`);
});
