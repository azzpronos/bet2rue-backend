require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();

function getOrCreateUser(discordUser) {
  if (!users.has(discordUser.id)) {
    users.set(discordUser.id, {
      id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      balance: 1000,
      bets: [],
      streak: 0,
      lastBonus: null,
      createdAt: new Date().toISOString()
    });
  }
  return users.get(discordUser.id);
}

function checkBonus(user) {
  const now = new Date();
  const today = now.toDateString();
  if (user.lastBonus === today) return null;
  user.streak = (user.streak || 0) + 1;
  if (user.streak > 7) user.streak = 7;
  const bonus = user.streak * 100;
  user.balance += bonus;
  user.lastBonus = today;
  return { bonus, streak: user.streak };
}

app.get('/auth/discord', function(req, res) {
  var params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect('https://discord.com/oauth2/authorize?' + params.toString());
});

app.get('/auth/discord/callback', async function(req, res) {
  var code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');
  try {
    var tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    var access_token = tokenRes.data.access_token;
    var userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + access_token }
    });
    var user = getOrCreateUser(userRes.data);
    var bonusInfo = checkBonus(user);
    var bonusParam = bonusInfo ? bonusInfo.bonus + '_' + bonusInfo.streak : 'none';
    res.redirect('/?uid=' + user.id + '&login=success&bonus=' + bonusParam);
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/api/me', function(req, res) {
  var uid = req.query.uid;
  if (!uid || !users.has(uid)) return res.status(401).json({ error: 'Non connecte' });
  var user = users.get(uid);
  res.json({
    id: user.id,
    username: user.username,
    avatar: user.avatar ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png' : 'https://cdn.discordapp.com/embed/avatars/0.png',
    balance: user.balance,
    bets: user.bets,
    streak: user.streak || 0,
    createdAt: user.createdAt
  });
});

app.get('/api/leaderboard', function(req, res) {
  var list = Array.from(users.values())
    .sort(function(a, b) { return b.balance - a.balance; })
    .slice(0, 20)
    .map(function(u) {
      return {
        id: u.id,
        username: u.username,
        avatar: u.avatar ? 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png' : 'https://cdn.discordapp.com/embed/avatars/0.png',
        balance: u.balance,
        betsCount: u.bets.length,
        wins: u.bets.filter(function(b) { return b.status === 'win'; }).length,
        streak: u.streak || 0
      };
    });
  res.json(list);
});

app.get('/api/matches', function(req, res) {
  res.json(MATCHES);
});

app.post('/api/bet', function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid || !users.has(uid)) return res.status(401).json({ error: 'Non connecte' });
  var user = users.get(uid);
  var picks = req.body.picks;
  var stake = req.body.stake;
  if (!picks || !picks.length) return res.status(400).json({ error: 'Selections invalides' });
  if (!stake || stake < 1 || stake > 1000) return res.status(400).json({ error: 'Mise invalide' });
  if (stake > user.balance) return res.status(400).json({ error: 'Solde insuffisant' });
  var totalOdd = picks.reduce(function(acc, p) { return acc * p.odd; }, 1);
  var potentialGain = parseFloat((stake * totalOdd).toFixed(2));
  var rand = Math.random();
  var status = rand < 0.45 ? 'win' : rand < 0.85 ? 'loss' : 'pending';
  user.balance -= stake;
  if (status === 'win') user.balance += potentialGain;
  user.balance = parseFloat(user.balance.toFixed(2));
  var bet = { id: Date.now(), picks: picks, stake: stake, totalOdd: parseFloat(totalOdd.toFixed(2)), potentialGain: potentialGain, status: status, placedAt: new Date().toISOString() };
  user.bets.unshift(bet);
  res.json({ bet: bet, newBalance: user.balance });
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

var MATCHES = [
  { id: 1, day: 'Dimanche 29 mars', league: 'Amical International', home: 'Colombie', hf: '🇨🇴', away: 'France', af: '🇫🇷', time: '21:00', odds: { h: 3.20, n: 3.30, a: 2.10 } },
  { id: 2, day: 'Mardi 31 mars', league: 'Amical International', home: 'Algerie', hf: '🇩🇿', away: 'Uruguay', af: '🇺🇾', time: '20:30', odds: { h: 2.40, n: 3.10, a: 2.90 } },
  { id: 3, day: 'Mardi 31 mars', league: 'Amical International', home: 'Angleterre', hf: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', away: 'Japon', af: '🇯🇵', time: '20:45', odds: { h: 1.75, n: 3.50, a: 4.20 } },
  { id: 4, day: 'Mardi 31 mars', league: 'Amical International', home: 'Maroc', hf: '🇲🇦', away: 'Paraguay', af: '🇵🇾', time: '20:00', odds: { h: 1.85, n: 3.20, a: 4.00 } },
  { id: 5, day: 'Mardi 31 mars', league: 'Amical International', home: 'Senegal', hf: '🇸🇳', away: 'Gambie', af: '🇬🇲', time: '21:00', odds: { h: 1.70, n: 3.40, a: 4.80 } },
  { id: 6, day: 'Mardi 31 mars', league: 'Amical International', home: 'Pays-Bas', hf: '🇳🇱', away: 'Equateur', af: '🇪🇨', time: '20:45', odds: { h: 1.80, n: 3.30, a: 4.20 } },
  { id: 7, day: 'Mardi 31 mars', league: 'Amical International', home: 'Ecosse', hf: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', away: 'Cote Ivoire', af: '🇨🇮', time: '20:30', odds: { h: 2.60, n: 3.20, a: 2.70 } },
  { id: 8, day: 'Mardi 31 mars', league: 'Amical International', home: 'Norvege', hf: '🇳🇴', away: 'Suisse', af: '🇨🇭', time: '18:00', odds: { h: 2.50, n: 3.10, a: 2.80 } },
  { id: 9, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Monaco', hf: '🇲🇨', away: 'Brest', af: '⚽', time: '15:00', odds: { h: 1.70, n: 3.50, a: 4.50 } },
  { id: 10, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Strasbourg', hf: '⚽', away: 'Marseille', af: '⚽', time: '17:15', odds: { h: 3.20, n: 3.10, a: 2.20 } },
  { id: 11, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Lille', hf: '⚽', away: 'Lens', af: '⚽', time: '20:45', odds: { h: 1.90, n: 3.40, a: 3.80 } },
  { id: 12, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Rennes', hf: '⚽', away: 'Lyon', af: '⚽', time: '20:45', odds: { h: 2.30, n: 3.20, a: 3.00 } }
];

app.listen(PORT, function() {
  console.log('BET2RUE sur port ' + PORT);
});
