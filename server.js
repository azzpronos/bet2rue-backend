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

const ADMIN_ID = '1143133778512986122';
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

function isMatchLocked(match) {
  const now = new Date();
  const [hours, minutes] = match.time.split(':').map(Number);
  const matchDate = new Date();
  matchDate.setHours(hours, minutes, 0, 0);
  return now >= matchDate;
}

function settleMatch(matchId, result) {
  const match = MATCHES.find(function(m) { return m.id === matchId; });
  if (!match) return 0;
  match.result = result;
  match.settled = true;
  let count = 0;
  users.forEach(function(user) {
    user.bets.forEach(function(bet) {
      if (bet.status !== 'pending') return;
      const pick = bet.picks.find(function(p) { return p.mid === matchId; });
      if (!pick) return;
      if (pick.k === result) {
        const gain = parseFloat((bet.stake * bet.totalOdd).toFixed(2));
        user.balance += gain;
        bet.status = 'win';
        count++;
      } else {
        bet.status = 'loss';
        count++;
      }
      user.balance = parseFloat(user.balance.toFixed(2));
    });
  });
  return count;
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
    isAdmin: user.id === ADMIN_ID,
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
  var now = new Date();
  res.json(MATCHES.map(function(m) {
    return Object.assign({}, m, { locked: isMatchLocked(m) });
  }));
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
  var lockedPick = picks.find(function(p) {
    var match = MATCHES.find(function(m) { return m.id === p.mid; });
    return match && isMatchLocked(match);
  });
  if (lockedPick) return res.status(400).json({ error: 'Un match a deja commence !' });
  var totalOdd = picks.reduce(function(acc, p) { return acc * p.odd; }, 1);
  var potentialGain = parseFloat((stake * totalOdd).toFixed(2));
  user.balance -= stake;
  user.balance = parseFloat(user.balance.toFixed(2));
  var bet = {
    id: Date.now(),
    picks: picks,
    stake: stake,
    totalOdd: parseFloat(totalOdd.toFixed(2)),
    potentialGain: potentialGain,
    status: 'pending',
    placedAt: new Date().toISOString()
  };
  user.bets.unshift(bet);
  res.json({ bet: bet, newBalance: user.balance });
});

app.post('/api/admin/result', function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid || uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  var matchId = req.body.matchId;
  var result = req.body.result;
  if (!matchId || !result) return res.status(400).json({ error: 'Donnees manquantes' });
  var count = settleMatch(matchId, result);
  res.json({ ok: true, settled: count });
});

app.get('/api/admin/matches', function(req, res) {
  var uid = req.query.uid;
  if (!uid || uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  res.json(MATCHES);
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

var MATCHES = [
  { id: 1, day: 'Dimanche 29 mars', league: 'Amical International', home: 'Colombie', hf: '🇨🇴', away: 'France', af: '🇫🇷', time: '21:00', odds: { h: 3.20, n: 3.30, a: 2.10 }, result: null, settled: false },
  { id: 2, day: 'Mardi 31 mars', league: 'Amical International', home: 'Algerie', hf: '🇩🇿', away: 'Uruguay', af: '🇺🇾', time: '20:30', odds: { h: 2.40, n: 3.10, a: 2.90 }, result: null, settled: false },
  { id: 3, day: 'Mardi 31 mars', league: 'Amical International', home: 'Angleterre', hf: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', away: 'Japon', af: '🇯🇵', time: '20:45', odds: { h: 1.75, n: 3.50, a: 4.20 }, result: null, settled: false },
  { id: 4, day: 'Mardi 31 mars', league: 'Amical International', home: 'Maroc', hf: '🇲🇦', away: 'Paraguay', af: '🇵🇾', time: '20:00', odds: { h: 1.85, n: 3.20, a: 4.00 }, result: null, settled: false },
  { id: 5, day: 'Mardi 31 mars', league: 'Amical International', home: 'Senegal', hf: '🇸🇳', away: 'Gambie', af: '🇬🇲', time: '21:00', odds: { h: 1.70, n: 3.40, a: 4.80 }, result: null, settled: false },
  { id: 6, day: 'Mardi 31 mars', league: 'Amical International', home: 'Pays-Bas', hf: '🇳🇱', away: 'Equateur', af: '🇪🇨', time: '20:45', odds: { h: 1.80, n: 3.30, a: 4.20 }, result: null, settled: false },
  { id: 7, day: 'Mardi 31 mars', league: 'Amical International', home: 'Ecosse', hf: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', away: 'Cote Ivoire', af: '🇨🇮', time: '20:30', odds: { h: 2.60, n: 3.20, a: 2.70 }, result: null, settled: false },
  { id: 8, day: 'Vendredi 3 avril', league: 'Ligue 1 - J27', home: 'PSG', hf: '🔵', away: 'Nantes', af: '🟡', time: '20:45', odds: { h: 1.25, n: 5.50, a: 10.0 }, result: null, settled: false },
  { id: 9, day: 'Samedi 4 avril', league: 'Premier League', home: 'Arsenal', hf: '🔴', away: 'Fulham', af: '⚪', time: '13:30', odds: { h: 1.55, n: 4.00, a: 5.50 }, result: null, settled: false },
  { id: 10, day: 'Samedi 4 avril', league: 'Premier League', home: 'Liverpool', hf: '🔴', away: 'Everton', af: '🔵', time: '16:00', odds: { h: 1.50, n: 4.20, a: 6.00 }, result: null, settled: false },
  { id: 11, day: 'Samedi 4 avril', league: 'Premier League', home: 'Chelsea', hf: '🔵', away: 'Manchester Utd', af: '🔴', time: '16:00', odds: { h: 1.80, n: 3.50, a: 4.20 }, result: null, settled: false },
  { id: 12, day: 'Samedi 4 avril', league: 'Premier League', home: 'Tottenham', hf: '⚪', away: 'Newcastle', af: '⚫', time: '18:30', odds: { h: 2.10, n: 3.30, a: 3.40 }, result: null, settled: false },
  { id: 13, day: 'Dimanche 5 avril', league: 'Premier League', home: 'Manchester City', hf: '🔵', away: 'Aston Villa', af: '🟣', time: '15:00', odds: { h: 1.60, n: 3.80, a: 5.00 }, result: null, settled: false },
  { id: 14, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Monaco', hf: '🔴', away: 'Brest', af: '⚽', time: '15:00', odds: { h: 1.70, n: 3.50, a: 4.50 }, result: null, settled: false },
  { id: 15, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Strasbourg', hf: '🔵', away: 'Marseille', af: '🔵', time: '17:15', odds: { h: 3.20, n: 3.10, a: 2.20 }, result: null, settled: false },
  { id: 16, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Lille', hf: '🔴', away: 'Lens', af: '🟡', time: '20:45', odds: { h: 1.90, n: 3.40, a: 3.80 }, result: null, settled: false },
  { id: 17, day: 'Dimanche 5 avril', league: 'Ligue 1 - J28', home: 'Rennes', hf: '🔴', away: 'Lyon', af: '🔴', time: '20:45', odds: { h: 2.30, n: 3.20, a: 3.00 }, result: null, settled: false }
];

app.listen(PORT, function() {
  console.log('BET2RUE sur port ' + PORT);
});

const { Client, GatewayIntentBits } = require('discord.js');
const botClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const API_URL = 'https://bet2rue-backend.onrender.com';
botClient.once('ready', function() {
  console.log('Bot connecte : ' + botClient.user.tag);
});
botClient.on('messageCreate', async function(message) {
  if (message.author.bot) return;
  if (message.author.id !== ADMIN_ID) return;
  var content = message.content.trim();
  if (content === '!matchs') {
    var txt = '📋 **MATCHS BET2RUE**\n\n';
    MATCHES.forEach(function(m) {
      var status = m.settled ? '✅ REGLE' : m.locked ? '🔴 FERME' : '🟢 OUVERT';
      txt += 'ID **' + m.id + '** | ' + m.day + ' ' + m.time + '\n';
      txt += m.hf + ' ' + m.home + ' vs ' + m.away + ' ' + m.af + '\n';
      txt += '1→' + m.odds.h + ' | N→' + m.odds.n + ' | 2→' + m.odds.a + ' | ' + status + '\n\n';
    });
    message.channel.send(txt);
  }
  if (content.startsWith('!resultat')) {
    var parts = content.split(' ');
    if (parts.length !== 3) { message.channel.send('❌ Format : `!resultat ID 1/n/2`'); return; }
    var matchId = parseInt(parts[1]);
    var result = parts[2].toLowerCase();
    if (!['1','n','2'].includes(result)) { message.channel.send('❌ Utilise 1, n ou 2'); return; }
    var resultKey = result === '1' ? 'h' : result === 'n' ? 'n' : 'a';
    var count = settleMatch(matchId, resultKey);
    var resultLabel = result === '1' ? 'Victoire domicile' : result === 'n' ? 'Match nul' : 'Victoire exterieur';
    message.channel.send('✅ **Resultat enregistre !**\nMatch ID ' + matchId + ' → ' + resultLabel + '\n🏆 ' + count + ' paris regles !');
  }
  if (content === '!classement') {
    var list = Array.from(users.values()).sort(function(a,b){return b.balance-a.balance;}).slice(0,10);
    var txt = '🏆 **CLASSEMENT BET2RUE**\n\n';
    var medals = ['🥇','🥈','🥉'];
    list.forEach(function(p,i) {
      txt += (medals[i]||(i+1)+'.') + ' **' + p.username + '** — ' + Math.round(p.balance).toLocaleString() + ' EV\n';
    });
    message.channel.send(txt);
  }
});const SHOP_CHANNEL_ID = '1487785562222891078';
const AFFILIATE_URL = 'https://shuffle.com/?r=Y0wS9u2Vh7';

const SHOP_ITEMS = [
  { id: 1, name: '10€ Shuffle', cost: 25000, description: 'Bon de 10€ sur Shuffle.com' },
  { id: 2, name: '20€ Shuffle', cost: 50000, description: 'Bon de 20€ sur Shuffle.com' },
  { id: 3, name: '50€ Shuffle', cost: 125000, description: 'Bon de 50€ sur Shuffle.com' }
];

app.get('/api/shop', function(req, res) {
  res.json(SHOP_ITEMS);
});

app.post('/api/shop/buy', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid || !users.has(uid)) return res.status(401).json({ error: 'Non connecte' });
  var user = users.get(uid);
  var itemId = req.body.itemId;
  var item = SHOP_ITEMS.find(function(i) { return i.id === itemId; });
  if (!item) return res.status(400).json({ error: 'Article introuvable' });
  if (user.balance < item.cost) return res.status(400).json({ error: 'Solde insuffisant' });
  user.balance -= item.cost;
  user.balance = parseFloat(user.balance.toFixed(2));
  try {
    var channel = await botClient.channels.fetch(SHOP_CHANNEL_ID);
    await channel.send(
      '🛒 **NOUVELLE DEMANDE DÉCHANGE**\n\n'
      + '👤 **' + user.username + '**\n'
      + '💰 **' + item.name + '** (' + item.cost.toLocaleString() + ' EV)\n'
      + '📋 ' + item.description + '\n'
      + '🔗 Lien affiliation : ' + AFFILIATE_URL + '\n'
      + '📅 ' + new Date().toLocaleString('fr-FR') + '\n\n'
      + '⚠️ Envoie le code en MP à **' + user.username + '** et dis-lui de suivre le tuto sur Discord !'
    );
  } catch(e) {
    console.error('Erreur envoi Discord:', e.message);
  }
  res.json({ ok: true, newBalance: user.balance, item: item });
});

botClient.on('messageCreate', async function(message) {
  if (message.author.bot) return;
  if (message.author.id !== ADMIN_ID) return;
  var content = message.content.trim();
  if (content === '!shop') {
    var txt = '🛍️ **BOUTIQUE BET2RUE**\n\n';
    SHOP_ITEMS.forEach(function(i) {
      txt += '**' + i.name + '** — ' + i.cost.toLocaleString() + ' EV\n';
    });
    message.channel.send(txt);
  }
});
botClient.login(process.env.DISCORD_BOT_TOKEN);
