require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;
const ADMIN_ID = '1143133778512986122';
const SHOP_CHANNEL_ID = '1487785562222891078';

app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname)));

mongoose.connect(process.env.MONGODB_URI)
  .then(function() { console.log('MongoDB connecte !'); })
  .catch(function(err) { console.error('Erreur MongoDB:', err.message); });

const UserSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  username: String,
  avatar: String,
  balance: { type: Number, default: 1000 },
  bets: { type: Array, default: [] },
  streak: { type: Number, default: 0 },
  lastBonus: { type: String, default: null },
  referredBy: { type: String, default: null },
  referrals: { type: Number, default: 0 },
  shuffleValidated: { type: Boolean, default: false },
  shuffleDeposit: { type: Boolean, default: false },
  games: { type: Array, default: [] },
  weeklyBets: { type: Array, default: [] },
  weeklyStart: { type: String, default: null },
  createdAt: { type: String, default: function() { return new Date().toISOString(); } }
});
const User = mongoose.model('User', UserSchema);

const ResultSchema = new mongoose.Schema({
  matchId: Number,
  home: String,
  away: String,
  hf: String,
  af: String,
  day: String,
  time: String,
  league: String,
  result: String,
  odds: Object,
  settledAt: { type: String, default: function() { return new Date().toISOString(); } }
});
const Result = mongoose.model('Result', ResultSchema);

const MarketSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  creator: String,
  creatorId: String,
  question: String,
  optionA: String,
  optionB: String,
  oddsA: { type: Number, default: 2.0 },
  oddsB: { type: Number, default: 2.0 },
  bets: { type: Array, default: [] },
  status: { type: String, default: 'open' },
  result: { type: String, default: null },
  createdAt: { type: String, default: function() { return new Date().toISOString(); } }
});
const Market = mongoose.model('Market', MarketSchema);

const PromoSchema = new mongoose.Schema({
  code: { type: String, unique: true, uppercase: true },
  reward: Number,
  maxUses: { type: Number, default: 1 },
  uses: { type: Number, default: 0 },
  usedBy: { type: Array, default: [] },
  createdAt: { type: String, default: function() { return new Date().toISOString(); } }
});
const Promo = mongoose.model('Promo', PromoSchema);

async function getOrCreateUser(discordUser, refId) {
  var user = await User.findOne({ id: discordUser.id });
  if (!user) {
    user = await User.create({
      id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      balance: 1000,
      bets: [],
      streak: 0,
      lastBonus: null,
      referredBy: refId || null,
      referrals: 0,
      createdAt: new Date().toISOString()
    });
    if (refId && refId !== discordUser.id) {
      var parrain = await User.findOne({ id: refId });
      if (parrain) {
        parrain.balance += 1000;
        parrain.referrals = (parrain.referrals || 0) + 1;
        await parrain.save();
        console.log('Parrainage : ' + parrain.username + ' gagne 1000 Tall pour ' + discordUser.username);
      }
    }
    console.log('Nouvel utilisateur: ' + discordUser.username);
  }
  return user;
}

async function checkBonus(user) {
  var now = new Date();
  var today = now.toDateString();
  if (user.lastBonus === today) return null;
  user.streak = (user.streak || 0) + 1;
  if (user.streak > 7) user.streak = 7;
  var bonus = user.streak * 100;
  user.balance += bonus;
  user.lastBonus = today;
  await user.save();
  return { bonus: bonus, streak: user.streak };
}

function isMatchLocked(match) {
  // Render is UTC, France is UTC+2 - add 2 hours to now for comparison
  var now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  var parts = match.time.split(':');
  var hours = parseInt(parts[0]);
  var minutes = parseInt(parts[1]);
  if (match.date) {
    var dateParts = match.date.split('-');
    var matchDate = new Date(Date.UTC(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), hours - 2, minutes, 0, 0));
    return now >= matchDate || (match.forceLocked === true);
  }
  var matchDate = new Date();
  matchDate.setHours(hours, minutes, 0, 0);
  return now >= matchDate || (match.forceLocked === true);
}

async function settleMatch(matchId, result) {
  var match = MATCHES.find(function(m) { return m.id === matchId; });
  if (!match) return 0;
  match.result = result;
  match.settled = true;
  await Result.create({
    matchId: matchId,
    home: match.home,
    away: match.away,
    hf: match.hf,
    af: match.af,
    day: match.day,
    time: match.time,
    league: match.league,
    result: result,
    odds: match.odds
  });
  var count = 0;
  var users = await User.find({});
  for (var i = 0; i < users.length; i++) {
    var user = users[i];
    var changed = false;
    user.bets.forEach(function(bet) {
      if (bet.status !== 'pending') return;
      var pick = bet.picks.find(function(p) { return p.mid === matchId; });
      if (!pick) return;
      if (pick.k === result) {
        var gain = parseFloat((bet.stake * bet.totalOdd).toFixed(2));
        user.balance += gain;
        bet.status = 'win';
      } else {
        bet.status = 'loss';
      }
      user.balance = parseFloat(user.balance.toFixed(2));
      changed = true;
      count++;
    });
    if (changed) {
      // Check bet streak - 3 wins in a row = 500 Tall bonus
      var recentBets = user.bets.filter(function(b){ return b.status !== 'pending'; }).slice(0, 3);
      if (recentBets.length >= 3 && recentBets.every(function(b){ return b.status === 'win'; })) {
        var alreadyBonused = user.bets[0] && user.bets[0].streakBonus;
        if (!alreadyBonused) {
          user.balance += 500;
          user.bets[0].streakBonus = true;
          user.markModified('bets');
          console.log('Streak bonus ! +500 Tall pour ' + user.username);
          try {
            var discordUser = await botClient.users.fetch(user.id);
            await discordUser.send('🔥 STREAK DE PARIS ! Tu as gagne 3 paris de suite — +500 Tall bonus sur BET0TALL !');
          } catch(e) {}
        }
      }
      user.markModified('bets');
      await user.save();
    }
  }
  return count;
}


var onlineUsers = {};

function updateOnline(uid) {
  onlineUsers[uid] = Date.now();
}

function getOnlineCount() {
  var now = Date.now();
  var count = 0;
  Object.keys(onlineUsers).forEach(function(uid) {
    if (now - onlineUsers[uid] < 5 * 60 * 1000) count++; // 5 min
  });
  return count;
}

app.get('/auth/discord', function(req, res) {
  var ref = req.query.ref || '';
  var params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state: ref
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
    var refId = req.query.state || null;
    var user = await getOrCreateUser(userRes.data, refId);
    var bonusInfo = await checkBonus(user);
    var bonusParam = bonusInfo ? bonusInfo.bonus + '_' + bonusInfo.streak : 'none';
    res.redirect('/?uid=' + user.id + '&login=success&bonus=' + bonusParam);
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.post('/api/chat', async function(req, res) {
  var uid = req.body.uid;
  var message = req.body.message;
  var username = req.body.username;
  if (!message) return res.status(400).json({ error: 'Message vide' });
  try {
    var channel = await botClient.channels.fetch(SHOP_CHANNEL_ID);
    await channel.send('💬 **MESSAGE SUPPORT**\n\n👤 **' + (username||'Anonyme') + '** (ID: ' + (uid||'?') + ')\n📩 ' + message + '\n📅 ' + new Date().toLocaleString('fr-FR'));
  } catch(e) { console.error('Erreur chat:', e.message); }
  res.json({ ok: true });
});

app.get('/api/online', function(req, res) {
  var uid = req.query.uid;
  if (uid) updateOnline(uid);
  res.json({ count: getOnlineCount() });
});

app.get('/api/me', async function(req, res) {
  var uid = req.query.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var user = await User.findOne({ id: uid });
  if (!user) return res.status(401).json({ error: 'Non connecte' });
  res.json({
    id: user.id,
    username: user.username,
    avatar: user.avatar ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png' : 'https://cdn.discordapp.com/embed/avatars/0.png',
    balance: user.balance,
    bets: user.bets,
    streak: user.streak || 0,
    referrals: user.referrals || 0,
    shuffleValidated: user.shuffleValidated || false,
    shuffleDeposit: user.shuffleDeposit || false,
    isAdmin: user.id === ADMIN_ID,
    createdAt: user.createdAt
  });
});

app.get('/api/leaderboard', async function(req, res) {
  var users = await User.find({}).sort({ balance: -1 }).limit(20);
  res.json(users.map(function(u) {
    return {
      id: u.id,
      username: u.username,
      avatar: u.avatar ? 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png' : 'https://cdn.discordapp.com/embed/avatars/0.png',
      balance: u.balance,
      betsCount: u.bets.length,
      wins: u.bets.filter(function(b) { return b.status === 'win'; }).length,
      streak: u.streak || 0
    };
  }));
});


function getWeekStart(){
  var now=new Date();
  var day=now.getDay();
  var diff=now.getDate()-day+(day===0?-6:1);
  var monday=new Date(now.setDate(diff));
  monday.setHours(0,0,0,0);
  return monday.toISOString().split('T')[0];
}

app.get('/api/tournament', async function(req, res) {
  var weekStart=getWeekStart();
  var users=await User.find({});
  var rankings=[];
  users.forEach(function(u){
    if(u.id===ADMIN_ID) return;
    var weekBets=u.bets.filter(function(b){
      return b.placedAt && b.placedAt >= weekStart;
    });
    var wagered=weekBets.reduce(function(sum,b){return sum+b.stake;},0);
    var wins=weekBets.filter(function(b){return b.status==='win';}).length;
    var losses=weekBets.filter(function(b){return b.status==='loss';}).length;
    if(wagered===0) return;
    rankings.push({
      id: u.id,
      username: u.username,
      avatar: u.avatar ? 'https://cdn.discordapp.com/avatars/'+u.id+'/'+u.avatar+'.png' : null,
      wagered: wagered,
      wins: wins,
      losses: losses,
      total: weekBets.length
    });
  });
  rankings.sort(function(a,b){return b.wagered-a.wagered;});
  res.json({weekStart:weekStart, rankings:rankings.slice(0,20)});
});

app.post('/api/tournament/reward', async function(req, res) {
  var uid=req.query.uid||req.body.uid;
  if(!uid||uid!==ADMIN_ID) return res.status(403).json({error:'Acces refuse'});
  var targetId=req.body.targetId;
  var amount=parseInt(req.body.amount)||10000;
  var winner=await User.findOne({id:targetId});
  if(!winner) return res.status(400).json({error:'Membre introuvable'});
  winner.balance+=amount;
  await winner.save();
  try{
    var discordUser=await botClient.users.fetch(targetId);
    await discordUser.send('TOURNOI HEBDOMADAIRE - Tu as remporte '+amount+' Tall ! Felicitations champion !');
  }catch(e){}
  res.json({ok:true, winner:winner.username, amount:amount});
});

app.get('/api/feed', async function(req, res) {
  var users = await User.find({});
  var feed = [];
  users.forEach(function(u) {
    var avatar = u.avatar ? 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png' : null;
    u.bets.forEach(function(b) {
      feed.push({
        username: u.username,
        avatar: avatar,
        type: 'sport',
        label: b.picks.map(function(p){return p.pick;}).join(' + '),
        stake: b.stake,
        totalOdd: b.totalOdd,
        potentialGain: b.potentialGain,
        status: b.status,
        placedAt: b.placedAt
      });
    });
    if (u.games) {
      u.games.forEach(function(g) {
        feed.push({
          username: u.username,
          avatar: avatar,
          type: g.type || 'game',
          label: g.label || g.type,
          stake: g.stake,
          totalOdd: g.mult || null,
          potentialGain: g.gain || null,
          status: g.status,
          placedAt: g.placedAt
        });
      });
    }
  });
  feed.sort(function(a,b){return new Date(b.placedAt)-new Date(a.placedAt);});
  res.json(feed.slice(0,10));
});

app.get('/api/results', async function(req, res) {
  var results = await Result.find({}).sort({ settledAt: -1 }).limit(50);
  res.json(results);
});

app.get('/api/matches', function(req, res) {
  res.json(MATCHES.map(function(m) {
    return Object.assign({}, m, { locked: isMatchLocked(m) });
  }));
});

app.post('/api/bet', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var user = await User.findOne({ id: uid });
  if (!user) return res.status(401).json({ error: 'Non connecte' });
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
  user.markModified('bets');
  await user.save();
  res.json({ bet: bet, newBalance: user.balance });
});

app.post('/api/promo', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var user = await User.findOne({ id: uid });
  if (!user) return res.status(401).json({ error: 'Non connecte' });
  var code = (req.body.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'Code invalide' });
  var promo = await Promo.findOne({ code: code });
  if (!promo) return res.status(400).json({ error: 'Code introuvable' });
  if (promo.uses >= promo.maxUses) return res.status(400).json({ error: 'Code epuise' });
  if (promo.usedBy.includes(uid)) return res.status(400).json({ error: 'Code deja utilise' });
  promo.uses += 1;
  promo.usedBy.push(uid);
  promo.markModified('usedBy');
  await promo.save();
  user.balance += promo.reward;
  user.balance = parseFloat(user.balance.toFixed(2));
  await user.save();
  res.json({ ok: true, reward: promo.reward, newBalance: user.balance });
});

app.post('/api/bj', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var user = await User.findOne({ id: uid });
  if (!user) return res.status(401).json({ error: 'Non connecte' });
  var balance = req.body.balance;
  if (typeof balance !== 'number' || balance < 0) return res.status(400).json({ error: 'Solde invalide' });
  user.balance = parseFloat(balance.toFixed(2));
  if (req.body.game) {
    if (!user.games) user.games = [];
    user.games.unshift(req.body.game);
    if (user.games.length > 50) user.games = user.games.slice(0, 50);
    user.markModified('games');
  }
  await user.save();
  res.json({ ok: true, newBalance: user.balance });
});

app.post('/api/transfer', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var sender = await User.findOne({ id: uid });
  if (!sender) return res.status(401).json({ error: 'Non connecte' });
  var targetUsername = (req.body.username || '').toLowerCase().trim();
  var amount = parseInt(req.body.amount);
  if (!targetUsername) return res.status(400).json({ error: 'Pseudo invalide' });
  if (!amount || amount < 10) return res.status(400).json({ error: 'Montant minimum : 10 Tall' });
  if (amount > sender.balance) return res.status(400).json({ error: 'Solde insuffisant' });
  var receiver = await User.findOne({ username: { $regex: new RegExp('^' + targetUsername + '$', 'i') } });
  if (!receiver) return res.status(400).json({ error: 'Membre introuvable' });
  if (receiver.id === uid) return res.status(400).json({ error: 'Tu ne peux pas t\'envoyer des Tall' });
  sender.balance -= amount;
  sender.balance = parseFloat(sender.balance.toFixed(2));
  receiver.balance += amount;
  receiver.balance = parseFloat(receiver.balance.toFixed(2));
  await sender.save();
  await receiver.save();
  try {
    var recvUser = await botClient.users.fetch(receiver.id);
    await recvUser.send('💸 **+' + amount + ' Tall** recus de **' + sender.username + '** sur BET0TALL !');
  } catch(e) {}
  res.json({ ok: true, newBalance: sender.balance, receiver: receiver.username, amount: amount });
});

app.get('/api/market', async function(req, res) {
  var markets = await Market.find({ status: 'open' }).sort({ createdAt: -1 }).limit(20);
  res.json(markets);
});

app.post('/api/market/create', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var user = await User.findOne({ id: uid });
  if (!user) return res.status(401).json({ error: 'Non connecte' });
  var question = (req.body.question || '').trim();
  var optionA = (req.body.optionA || '').trim();
  var optionB = (req.body.optionB || '').trim();
  var oddsA = parseFloat(req.body.oddsA) || 2.0;
  var oddsB = parseFloat(req.body.oddsB) || 2.0;
  if (!question || !optionA || !optionB) return res.status(400).json({ error: 'Champs manquants' });
  if (oddsA < 1.1 || oddsB < 1.1) return res.status(400).json({ error: 'Cote minimum : 1.10' });
  var market = await Market.create({
    id: Date.now().toString(),
    creator: user.username,
    creatorId: uid,
    question: question,
    optionA: optionA,
    optionB: optionB,
    oddsA: oddsA,
    oddsB: oddsB,
    bets: [],
    status: 'open',
    result: null
  });
  res.json({ ok: true, market: market });
});

app.post('/api/market/bet', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var user = await User.findOne({ id: uid });
  if (!user) return res.status(401).json({ error: 'Non connecte' });
  var marketId = req.body.marketId;
  var option = req.body.option;
  var stake = parseInt(req.body.stake);
  if (!stake || stake < 10) return res.status(400).json({ error: 'Mise minimum : 10 Tall' });
  if (stake > user.balance) return res.status(400).json({ error: 'Solde insuffisant' });
  var market = await Market.findOne({ id: marketId });
  if (!market) return res.status(400).json({ error: 'Pari introuvable' });
  if (market.status !== 'open') return res.status(400).json({ error: 'Ce pari est ferme' });
  var alreadyBet = market.bets.find(function(b) { return b.uid === uid; });
  if (alreadyBet) return res.status(400).json({ error: 'Tu as deja mise sur ce pari' });
  var odd = option === 'A' ? market.oddsA : market.oddsB;
  user.balance -= stake;
  user.balance = parseFloat(user.balance.toFixed(2));
  await user.save();
  market.bets.push({ uid: uid, username: user.username, option: option, stake: stake, odd: odd });
  market.markModified('bets');
  await market.save();
  res.json({ ok: true, newBalance: user.balance });
});


app.post('/api/market/close', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid || uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  var marketId = req.body.marketId;
  var market = await Market.findOne({ id: marketId });
  if (!market) return res.status(400).json({ error: 'Pari introuvable' });
  market.status = 'closed_betting';
  await market.save();
  res.json({ ok: true });
});

app.post('/api/market/resolve', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var marketId = req.body.marketId;
  var result = req.body.result;
  var market = await Market.findOne({ id: marketId });
  if (!market) return res.status(400).json({ error: 'Pari introuvable' });
  if (market.status !== 'open') return res.status(400).json({ error: 'Deja resolu' });
  if (market.creatorId !== uid && uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  market.status = 'closed';
  market.result = result;
  market.markModified('bets');
  await market.save();
  var winners = 0;
  for (var i = 0; i < market.bets.length; i++) {
    var bet = market.bets[i];
    if (bet.option === result) {
      var gain = parseFloat((bet.stake * bet.odd).toFixed(2));
      var bettor = await User.findOne({ id: bet.uid });
      if (bettor) { bettor.balance += gain; await bettor.save(); winners++; }
    }
  }
  res.json({ ok: true, winners: winners });
});

app.get('/api/shop', function(req, res) {
  res.json(SHOP_ITEMS);
});

app.post('/api/shop/buy', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid) return res.status(401).json({ error: 'Non connecte' });
  var user = await User.findOne({ id: uid });
  if (!user) return res.status(401).json({ error: 'Non connecte' });
  var itemId = req.body.itemId;
  var item = SHOP_ITEMS.find(function(i) { return i.id === itemId; });
  if (!item) return res.status(400).json({ error: 'Article introuvable' });
  if (user.balance < item.cost) return res.status(400).json({ error: 'Solde insuffisant' });
  user.balance -= item.cost;
  user.balance = parseFloat(user.balance.toFixed(2));
  await user.save();
  try {
    var channel = await botClient.channels.fetch(SHOP_CHANNEL_ID);
    await channel.send('🛒 **NOUVELLE DEMANDE ECHANGE**\n\n👤 **' + user.username + '**\n💰 **' + item.name + '** (' + item.cost.toLocaleString() + ' EV)\n📋 ' + item.description + '\n📅 ' + new Date().toLocaleString('fr-FR'));
  } catch(e) { console.error('Erreur Discord:', e.message); }
  res.json({ ok: true, newBalance: user.balance, item: item });
});

app.post('/api/admin/result', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid || uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  var matchId = req.body.matchId;
  var result = req.body.result;
  if (!matchId || !result) return res.status(400).json({ error: 'Donnees manquantes' });
  var count = await settleMatch(matchId, result);
  res.json({ ok: true, settled: count });
});

app.post('/api/admin/lockMatch', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid || uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  var matchId = req.body.matchId;
  var match = MATCHES.find(function(m) { return m.id === matchId; });
  if (!match) return res.status(400).json({ error: 'Match introuvable' });
  match.forceLocked = true;
  res.json({ ok: true });
});

app.post('/api/admin/unlockMatch', async function(req, res) {
  var uid = req.query.uid || req.body.uid;
  if (!uid || uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  var matchId = req.body.matchId;
  var match = MATCHES.find(function(m) { return m.id === matchId; });
  if (!match) return res.status(400).json({ error: 'Match introuvable' });
  match.forceLocked = false;
  res.json({ ok: true });
});

app.get('/api/admin/matches', function(req, res) {
  var uid = req.query.uid;
  if (!uid || uid !== ADMIN_ID) return res.status(403).json({ error: 'Acces refuse' });
  res.json(MATCHES);
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

var SHOP_ITEMS = [
  { id: 1, name: '10 euros Shuffle', icon: '🃏', cost: 25000, description: 'Bon de 10 euros sur Shuffle.com — voir tuto Discord' },
  { id: 2, name: '20 euros Shuffle', icon: '🃏', cost: 50000, description: 'Bon de 20 euros sur Shuffle.com — voir tuto Discord' },
  { id: 3, name: '50 euros Shuffle', icon: '🃏', cost: 125000, description: 'Bon de 50 euros sur Shuffle.com — voir tuto Discord' },
  { id: 4, name: '1v1 FIFA vs Azzpronos', icon: '🎮', cost: 10000, description: 'Defie Azzpronos en 1v1 FIFA ! Notification Discord dans les 24h.' },
  { id: 5, name: 'Prono VIP en MP', icon: '🔮', cost: 5000, description: 'Azzpronos envoie son meilleur prono du jour en message prive !' },
  { id: 6, name: 'Shoutout Discord', icon: '📢', cost: 12000, description: 'Azzpronos te mentionne devant toute la communaute BET0TALL !' },
  { id: 7, name: 'Maillot de foot au choix', icon: '👕', cost: 250000, description: 'Un vrai maillot de foot au choix ! Azzpronos te contacte en MP.' },
  { id: 8, name: 'Jeu video au choix', icon: '🕹️', cost: 200000, description: 'Choisis nimporte quel jeu video ! Azzpronos te contacte en MP.' },
  { id: 9, name: 'Commande Uber Eats', icon: '🍔', cost: 60000, description: 'Azzpronos te commande ce que tu veux sur Uber Eats ! Contacte-le en MP.' },
  { id: 10, name: 'iPhone 17', icon: '📱', cost: 3000000, description: 'Un iPhone 17 offert par Azzpronos ! Le jackpot absolu. Contacte-le en MP.' },
  { id: 11, name: 'Place match Ligue 1', icon: '🏟️', cost: 150000, description: 'Un ticket pour un match de Ligue 1 de ton choix ! Azzpronos te contacte en MP.' },
  { id: 12, name: 'Defi Azzpronos', icon: '⚡', cost: 20000, description: 'Azzpronos te lance un defi personnel ! Contacte-le en MP pour les details.' },
  { id: 13, name: 'Montante Collab Azzpronos', icon: '📈', cost: 40000, description: 'Azzpronos fait une montante en collaboration avec toi ! Contacte-le en MP.' },
  { id: 14, name: 'Clash Yoshi sur X', icon: '💀', cost: 30000, description: 'Azzpronos poste un clash troll sur Yoshi sur X en ton nom 😈 Contacte-le en MP.' }
];

var MATCHES=[
  // ===== LDC QUARTS RETOUR - 15 AVRIL =====
  {id:1,home:'Bayern Munich',away:'Real Madrid',hf:'🇩🇪',af:'🇪🇸',league:'🏆 LDC Quart retour',time:'21:00',day:'Mer 15 Avril',date:'2026-04-15',odds:{h:1.54,n:5.30,a:4.20},locked:false,settled:false,result:null},
  {id:2,home:'Arsenal',away:'Sporting',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🇵🇹',league:'🏆 LDC Quart retour',time:'21:00',day:'Mer 15 Avril',date:'2026-04-15',odds:{h:1.45,n:4.50,a:6.00},locked:false,settled:false,result:null},

  // ===== LIGUE 1 J30 - 17-19 AVRIL =====
  {id:3,home:'Lens',away:'Toulouse',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'20:45',day:'Ven 17 Avril',date:'2026-04-17',odds:{h:1.53,n:4.25,a:5.50},locked:false,settled:false,result:null},
  {id:4,home:'Lorient',away:'Marseille',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'17:00',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:4.30,n:3.88,a:1.72},locked:false,settled:false,result:null},
  {id:5,home:'Angers',away:'Le Havre',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'19:00',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:2.77,n:3.07,a:2.60},locked:false,settled:false,result:null},
  {id:6,home:'Lille',away:'Nice',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'21:05',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:1.55,n:4.05,a:5.60},locked:false,settled:false,result:null},
  {id:7,home:'Monaco',away:'Auxerre',hf:'🇲🇨',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'15:00',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:1.54,n:4.20,a:5.50},locked:false,settled:false,result:null},
  {id:8,home:'Metz',away:'Paris FC',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'17:15',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:3.25,n:3.35,a:2.15},locked:false,settled:false,result:null},
  {id:9,home:'Strasbourg',away:'Rennes',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'17:15',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:2.48,n:3.63,a:2.45},locked:false,settled:false,result:null},
  {id:10,home:'Nantes',away:'Brest',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'17:15',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:2.33,n:3.28,a:2.98},locked:false,settled:false,result:null},
  {id:11,home:'PSG',away:'Lyon',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J30',time:'20:45',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:1.30,n:5.75,a:8.25},locked:false,settled:false,result:null},

  // ===== BUNDESLIGA J30 - 17-19 AVRIL =====
  {id:12,home:'Mayence',away:'Fribourg',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J30',time:'19:30',day:'Ven 17 Avril',date:'2026-04-17',odds:{h:2.30,n:3.40,a:2.90},locked:false,settled:false,result:null},
  {id:13,home:'St Pauli',away:'Cologne',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J30',time:'20:30',day:'Ven 17 Avril',date:'2026-04-17',odds:{h:2.10,n:3.30,a:3.20},locked:false,settled:false,result:null},
  {id:14,home:'Leverkusen',away:'Augsburg',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J30',time:'15:30',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:1.45,n:4.50,a:6.50},locked:false,settled:false,result:null},
  {id:15,home:'Werder Bremen',away:'Hambourg',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J30',time:'15:30',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:2.20,n:3.30,a:3.10},locked:false,settled:false,result:null},
  {id:16,home:'Hoffenheim',away:'Dortmund',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J30',time:'15:30',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:3.20,n:3.50,a:2.10},locked:false,settled:false,result:null},
  {id:17,home:'Eint. Francfort',away:'RB Leipzig',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J30',time:'18:30',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:2.80,n:3.30,a:2.40},locked:false,settled:false,result:null},
  {id:18,home:'Bayern Munich',away:'Stuttgart',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J30',time:'17:30',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:1.35,n:5.00,a:8.00},locked:false,settled:false,result:null},

  // ===== PREMIER LEAGUE J33 - 18-20 AVRIL =====
  {id:19,home:'Brentford',away:'Fulham',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J33',time:'13:30',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:2.10,n:3.30,a:3.40},locked:false,settled:false,result:null},
  {id:20,home:'Chelsea',away:'Man United',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J33',time:'21:00',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:1.90,n:3.50,a:3.80},locked:false,settled:false,result:null},
  {id:21,home:'Tottenham',away:'Brighton',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J33',time:'18:30',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:2.10,n:3.40,a:3.20},locked:false,settled:false,result:null},
  {id:22,home:'Everton',away:'Liverpool',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J33',time:'15:00',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:4.50,n:3.60,a:1.75},locked:false,settled:false,result:null},
  {id:23,home:'Man City',away:'Arsenal',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J33',time:'17:30',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:2.40,n:3.50,a:2.80},locked:false,settled:false,result:null},
  {id:24,home:'Aston Villa',away:'Sunderland',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J33',time:'15:00',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:1.65,n:3.80,a:5.00},locked:false,settled:false,result:null},

  // ===== LA LIGA J33 - 18-20 AVRIL =====
  {id:25,home:'Real Sociedad',away:'Levante',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J33',time:'14:00',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:1.60,n:4.00,a:5.50},locked:false,settled:false,result:null},
  {id:26,home:'Real Madrid',away:'Barcelone',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J33',time:'21:00',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:2.30,n:3.50,a:2.90},locked:false,settled:false,result:null},
  {id:27,home:'Atletico Madrid',away:'Villarreal',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J33',time:'16:15',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:1.70,n:3.80,a:4.80},locked:false,settled:false,result:null},
  {id:28,home:'Osasuna',away:'Betis',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J33',time:'14:00',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:2.50,n:3.40,a:2.70},locked:false,settled:false,result:null},
  {id:29,home:'Bilbao',away:'Majorque',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J33',time:'16:15',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:1.80,n:3.50,a:4.50},locked:false,settled:false,result:null},
  {id:30,home:'Valence',away:'Celta Vigo',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J33',time:'18:30',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:2.10,n:3.20,a:3.40},locked:false,settled:false,result:null},

  // ===== SERIE A J32 - 18-19 AVRIL =====
  {id:31,home:'Atalanta',away:'Inter Milan',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J32',time:'18:00',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:3.20,n:3.40,a:2.10},locked:false,settled:false,result:null},
  {id:32,home:'Juventus',away:'Naples',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J32',time:'20:45',day:'Sam 18 Avril',date:'2026-04-18',odds:{h:2.30,n:3.30,a:3.00},locked:false,settled:false,result:null},
  {id:33,home:'Rome',away:'Lazio',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J32',time:'18:00',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:2.50,n:3.30,a:2.80},locked:false,settled:false,result:null},
  {id:34,home:'Milan',away:'Fiorentina',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J32',time:'20:45',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:1.95,n:3.50,a:3.80},locked:false,settled:false,result:null},
  {id:35,home:'Torino',away:'Bologna',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J32',time:'15:00',day:'Dim 19 Avril',date:'2026-04-19',odds:{h:2.40,n:3.20,a:2.90},locked:false,settled:false,result:null},

  // ===== LIGUE 1 J31 - 24-26 AVRIL =====
  {id:36,home:'Metz',away:'Strasbourg',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J31',time:'20:45',day:'Ven 24 Avril',date:'2026-04-24',odds:{h:2.80,n:3.20,a:2.50},locked:false,settled:false,result:null},
  {id:37,home:'Rennes',away:'Angers',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J31',time:'17:15',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:1.90,n:3.50,a:4.20},locked:false,settled:false,result:null},
  {id:38,home:'Marseille',away:'Nantes',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J31',time:'17:15',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:1.65,n:3.80,a:5.50},locked:false,settled:false,result:null},
  {id:39,home:'PSG',away:'Metz',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J31',time:'20:45',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:1.20,n:6.50,a:12.00},locked:false,settled:false,result:null},
  {id:40,home:'Nice',away:'Lorient',hf:'🇫🇷',af:'🇫🇷',league:'🇫🇷 Ligue 1 J31',time:'17:15',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:1.50,n:4.00,a:6.00},locked:false,settled:false,result:null},

  // ===== BUNDESLIGA J31 - 24-27 AVRIL =====
  {id:41,home:'RB Leipzig',away:'Union Berlin',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J31',time:'20:30',day:'Ven 24 Avril',date:'2026-04-24',odds:{h:1.70,n:3.80,a:5.00},locked:false,settled:false,result:null},
  {id:42,home:'Cologne',away:'Leverkusen',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J31',time:'15:30',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:4.50,n:3.80,a:1.75},locked:false,settled:false,result:null},
  {id:43,home:'Mayence',away:'Bayern Munich',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J31',time:'15:30',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:6.00,n:4.20,a:1.40},locked:false,settled:false,result:null},
  {id:44,home:'Dortmund',away:'Werder Bremen',hf:'🇩🇪',af:'🇩🇪',league:'🇩🇪 Bundesliga J31',time:'18:30',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:1.80,n:3.50,a:4.50},locked:false,settled:false,result:null},

  // ===== PREMIER LEAGUE J34 - 25 AVRIL =====
  {id:45,home:'Arsenal',away:'Newcastle',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J34',time:'17:00',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:1.70,n:3.80,a:4.50},locked:false,settled:false,result:null},
  {id:46,home:'Liverpool',away:'Crystal Palace',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J34',time:'17:00',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:1.45,n:4.20,a:6.00},locked:false,settled:false,result:null},
  {id:47,home:'Burnley',away:'Man City',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J34',time:'17:00',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:5.50,n:4.00,a:1.55},locked:false,settled:false,result:null},
  {id:48,home:'Man United',away:'Brentford',hf:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League J34',time:'17:00',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:2.20,n:3.40,a:3.10},locked:false,settled:false,result:null},

  // ===== LA LIGA J34 - 25-26 AVRIL =====
  {id:49,home:'Barcelone',away:'Alavés',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J34',time:'21:00',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:1.18,n:7.00,a:14.00},locked:false,settled:false,result:null},
  {id:50,home:'Getafe',away:'Real Madrid',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J34',time:'16:15',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:6.50,n:4.20,a:1.42},locked:false,settled:false,result:null},
  {id:51,home:'Séville',away:'Atletico Madrid',hf:'🇪🇸',af:'🇪🇸',league:'🇪🇸 La Liga J34',time:'18:30',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:3.20,n:3.50,a:2.20},locked:false,settled:false,result:null},

  // ===== SERIE A J33 - 25-26 AVRIL =====
  {id:52,home:'Inter Milan',away:'Sassuolo',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J33',time:'20:45',day:'Sam 25 Avril',date:'2026-04-25',odds:{h:1.30,n:5.50,a:9.00},locked:false,settled:false,result:null},
  {id:53,home:'Milan',away:'Juventus',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J33',time:'20:45',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:2.20,n:3.30,a:3.10},locked:false,settled:false,result:null},
  {id:54,home:'Naples',away:'Lazio',hf:'🇮🇹',af:'🇮🇹',league:'🇮🇹 Serie A J33',time:'18:00',day:'Dim 26 Avril',date:'2026-04-26',odds:{h:1.80,n:3.50,a:4.50},locked:false,settled:false,result:null},

  // ===== LDC DEMI-FINALES ALLER - 28-29 AVRIL =====
  {id:55,home:'PSG',away:'Bayern Munich',hf:'🇫🇷',af:'🇩🇪',league:'🏆 LDC Demi-finale aller',time:'21:00',day:'Mar 28 Avril',date:'2026-04-28',odds:{h:2.10,n:3.80,a:3.20},locked:false,settled:false,result:null},
  {id:56,home:'Atletico Madrid',away:'Arsenal',hf:'🇪🇸',af:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',league:'🏆 LDC Demi-finale aller',time:'21:00',day:'Mer 29 Avril',date:'2026-04-29',odds:{h:2.50,n:3.50,a:2.60},locked:false,settled:false,result:null}
];

server.listen(PORT, function() {
  console.log('BET0TALL sur port ' + PORT);
});

const { Client, GatewayIntentBits } = require('discord.js');
const botClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');


var chatSockets = {}; // uid -> socket

io.on('connection', function(socket) {
  socket.on('join', function(uid) {
    chatSockets[uid] = socket;
    socket.uid = uid;
  });
  socket.on('disconnect', function() {
    if(socket.uid) delete chatSockets[socket.uid];
  });
  socket.on('user_message', async function(data) {
    var uid = data.uid;
    var message = data.message;
    var username = data.username;
    try {
      var channel = await botClient.channels.fetch(SHOP_CHANNEL_ID);
      await channel.send('💬 **CHAT SUPPORT** — **' + (username||'Anonyme') + '** (ID: ' + (uid||'?') + ')\n> ' + message + '\n_Pour repondre tape :_ `!reply ' + uid + ' ton message`');
    } catch(e) { console.error('Erreur chat:', e.message); }
  });
});

botClient.once('ready', async function() {
  console.log('Bot connecte : ' + botClient.user.tag);
  try {
    var verifyChannel = await botClient.channels.fetch('1482517246537633964');
    var verifyMsgs = await verifyChannel.messages.fetch({ limit: 10 });
    var verifySent = verifyMsgs.some(function(m){ return m.author.id === botClient.user.id && m.components.length > 0; });
    if (!verifySent) {
      var verifyRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('accept_rules').setLabel("J'accepte les regles").setStyle(ButtonStyle.Success)
      );
      await verifyChannel.send({
        content: '**BIENVENUE SUR BET0TALL !**\n\nEn rejoignant ce serveur tu acceptes de respecter les regles.\n\nClique sur le bouton ci-dessous pour acceder au serveur !',
        components: [verifyRow]
      });
    }
  } catch(e) { console.error('Erreur verify:', e.message); }
  try {
    var ticketChannel = await botClient.channels.fetch('1488203713381400638');
    var ticketMsgs = await ticketChannel.messages.fetch({ limit: 10 });
    var ticketSent = ticketMsgs.some(function(m){ return m.author.id === botClient.user.id && m.components.length > 0; });
    if (!ticketSent) {
      var ticketRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_ticket').setLabel('25 euros Shuffle').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('open_2500').setLabel('2500 Tall Creation Compte').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('open_tall').setLabel('5000 Tall Depot Shuffle').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('open_question').setLabel('Question').setStyle(ButtonStyle.Secondary)
      );
      await ticketChannel.send({
        content: '**ENVOIE TON PSEUDO**\n\nClique sur le bouton ci-dessous pour ouvrir un ticket prive !',
        components: [ticketRow]
      });
    }
  } catch(e) { console.error('Erreur ticket:', e.message); }
});

botClient.on('messageCreate', async function(message) {
  if (message.author.bot) return;
  if (message.author.id !== ADMIN_ID) return;
  var content = message.content.trim();

  if (content === '!matchs') {
    var txt = '📋 **MATCHS BET0TALL**\n\n';
    MATCHES.forEach(function(m) {
      var status = m.settled ? '✅ REGLE' : isMatchLocked(m) ? '🔴 FERME' : '🟢 OUVERT';
      txt += 'ID **' + m.id + '** | ' + m.day + ' ' + m.time + '\n' + m.hf + ' ' + m.home + ' vs ' + m.away + ' ' + m.af + '\n1→' + m.odds.h + ' | N→' + m.odds.n + ' | 2→' + m.odds.a + ' | ' + status + '\n\n';
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
    var count = await settleMatch(matchId, resultKey);
    var resultLabel = result === '1' ? 'Victoire domicile' : result === 'n' ? 'Match nul' : 'Victoire exterieur';
    message.channel.send('✅ **Resultat enregistre !**\nMatch ID ' + matchId + ' → ' + resultLabel + '\n🏆 ' + count + ' paris regles !');
  }

  if (content.startsWith('!createcode')) {
    var parts = content.split(' ');
    if (parts.length !== 4) { message.channel.send('❌ Format : `!createcode CODE MONTANT UTILISATIONS`'); return; }
    var code = parts[1].toUpperCase();
    var reward = parseInt(parts[2]);
    var maxUses = parseInt(parts[3]);
    if (isNaN(reward) || isNaN(maxUses)) { message.channel.send('❌ Montant et utilisations doivent etre des nombres'); return; }
    try {
      await Promo.create({ code: code, reward: reward, maxUses: maxUses });
      message.channel.send('✅ Code promo cree !\n**Code :** ' + code + '\n**Recompense :** ' + reward + ' EV\n**Utilisations max :** ' + maxUses);
    } catch(e) {
      message.channel.send('❌ Ce code existe deja !');
    }
  }

  if (content.startsWith('!code')) {
    var parts = content.split(' ');
    if (parts.length !== 2) { message.channel.send('❌ Format : `!code MONCODE`'); return; }
    var code = parts[1].toUpperCase();
    var promo = await Promo.findOne({ code: code });
    if (!promo) { message.channel.send('❌ Code introuvable'); return; }
    if (promo.uses >= promo.maxUses) { message.channel.send('❌ Code epuise'); return; }
    var discordId = message.author.id;
    if (promo.usedBy.includes(discordId)) { message.channel.send('❌ Tu as deja utilise ce code !'); return; }
    var user = await User.findOne({ id: discordId });
    if (!user) { message.channel.send('❌ Connecte-toi dabord sur bet0tall-backend.onrender.com'); return; }
    promo.uses += 1;
    promo.usedBy.push(discordId);
    promo.markModified('usedBy');
    await promo.save();
    user.balance += promo.reward;
    await user.save();
    message.channel.send('✅ Code **' + code + '** active ! **+' + promo.reward + ' EV** ajoutes sur ton compte BET0TALL !');
  }

  if (content.startsWith('!valide')) {
    var parts = content.split(' ');
    if (parts.length !== 2) { message.channel.send('❌ Format : `!valide DISCORD_ID`'); return; }
    var targetId = parts[1];
    var targetUser = await User.findOne({ id: targetId });
    if (!targetUser) { message.channel.send('❌ Utilisateur introuvable — il doit dabord se connecter sur le site'); return; }
    if (targetUser.shuffleValidated) { message.channel.send('❌ Ce membre a deja recu son bonus Shuffle !'); return; }
    targetUser.balance += 2500;
    targetUser.shuffleValidated = true;
    await targetUser.save();
    message.channel.send('✅ **Bonus Shuffle valide !**\n👤 **' + targetUser.username + '** a recu **+5000 Tall** sur son compte BET0TALL !');
    try {
      var checkChannel = await botClient.channels.fetch('1487956908106322174');
      await checkChannel.send('✅ **' + targetUser.username + '** — Bonus Shuffle confirme par Azzpronos !');
    } catch(e) {}
    return;
  }

  if (content.startsWith('!validedepot')) {
    var parts = content.split(' ');
    if (parts.length !== 2) { message.channel.send('Format : !validedepot DISCORD_ID'); return; }
    var targetId = parts[1];
    var targetUser = await User.findOne({ id: targetId });
    if (!targetUser) { message.channel.send('Utilisateur introuvable'); return; }
    if (targetUser.shuffleDeposit) { message.channel.send('Ce membre a deja recu son bonus depot !'); return; }
    targetUser.balance += 5000;
    targetUser.shuffleDeposit = true;
    await targetUser.save();
    message.channel.send('Bonus depot valide ! **' + targetUser.username + '** a recu **+5000 Tall** sur BET0TALL !');
    return;
  }

  if (content.startsWith('!reply')) {
    var parts = content.split(' ');
    if (parts.length < 3) { message.channel.send('Format : !reply DISCORD_ID ton message'); return; }
    var targetUid = parts[1];
    var replyMsg = parts.slice(2).join(' ');
    var sent = false;
    // Try socket first
    var targetSocket = chatSockets[targetUid];
    if (targetSocket) {
      targetSocket.emit('admin_reply', { message: replyMsg });
      sent = true;
    }
    // Always send Discord MP as backup
    try {
      var dmUser = await botClient.users.fetch(targetUid);
      await dmUser.send('🐱 **Zina - Service Client BET0TALL**\n\n' + replyMsg);
      sent = true;
    } catch(e) {}
    message.channel.send(sent ? '✅ Reponse envoyee !' : '❌ Impossible d\'envoyer le message');
    return;
  }

  if (content === '!classement') {
    var users = await User.find({}).sort({ balance: -1 }).limit(10);
    var txt = '🏆 **CLASSEMENT BET0TALL**\n\n';
    var medals = ['🥇','🥈','🥉'];
    users.forEach(function(p, i) {
      txt += (medals[i] || (i+1) + '.') + ' **' + p.username + '** — ' + Math.round(p.balance).toLocaleString() + ' EV\n';
    });
    message.channel.send(txt);
  }
});

botClient.on('interactionCreate', async function(interaction) {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'accept_rules') {
    try {
      await interaction.member.roles.add('1488197704306655343');
      await interaction.reply({ content: 'Bienvenue ! Tu as maintenant acces au serveur BET0TALL', ephemeral: true });
    } catch(e) { await interaction.reply({ content: 'Erreur — contacte un admin', ephemeral: true }); }
  }
  if (interaction.customId === 'open_ticket') {
    try {
      var existing = interaction.guild.channels.cache.find(function(c){ return c.name === 'ticket-' + interaction.user.username.toLowerCase(); });
      if (existing) { await interaction.reply({ content: 'Tu as deja un ticket ouvert : <#' + existing.id + '>', ephemeral: true }); return; }
      var ticket = await interaction.guild.channels.create({
        name: 'ticket-' + interaction.user.username.toLowerCase(),
        parent: '1488276013233209374',
        permissionOverwrites: [
          { id: interaction.guild.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages'] },
          { id: interaction.guild.members.me.id, allow: ['ViewChannel', 'SendMessages'] }
        ]
      });
      var closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger)
      );
      await ticket.send({ content: '**' + interaction.user.username + '** — Envoie ton pseudo ici !\n<@' + ADMIN_ID + '> nouveau ticket !', components: [closeRow] });
      await interaction.reply({ content: 'Ton ticket : <#' + ticket.id + '>', ephemeral: true });
    } catch(e) { console.error('Erreur ticket:', e.message); await interaction.reply({ content: 'Erreur', ephemeral: true }); }
  }
  if (interaction.customId === 'open_2500') {
    try {
      var existing2500 = interaction.guild.channels.cache.find(function(c){ return c.name === 'creation-' + interaction.user.username.toLowerCase(); });
      if (existing2500) { await interaction.reply({ content: 'Tu as deja un ticket ouvert : <#' + existing2500.id + '>', ephemeral: true }); return; }
      var ticket2500 = await interaction.guild.channels.create({
        name: 'creation-' + interaction.user.username.toLowerCase(),
        parent: '1488276013233209374',
        permissionOverwrites: [
          { id: interaction.guild.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages'] },
          { id: interaction.guild.members.me.id, allow: ['ViewChannel', 'SendMessages'] }
        ]
      });
      var closeRow2500 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger)
      );
      await ticket2500.send({ content: '**' + interaction.user.username + '** — Envoie ton pseudo Shuffle pour recevoir tes +2500 Tall (creation de compte) !\n<@' + ADMIN_ID + '> nouveau ticket 2500 Tall !', components: [closeRow2500] });
      await interaction.reply({ content: 'Ton ticket : <#' + ticket2500.id + '>', ephemeral: true });
    } catch(e) { console.error('Erreur 2500:', e.message); await interaction.reply({ content: 'Erreur', ephemeral: true }); }
  }

  if (interaction.customId === 'open_tall') {
    try {
      var existingP = interaction.guild.channels.cache.find(function(c){ return c.name === 'tall-' + interaction.user.username.toLowerCase(); });
      if (existingP) { await interaction.reply({ content: 'Tu as deja un ticket ouvert : <#' + existingP.id + '>', ephemeral: true }); return; }
      var ticketP = await interaction.guild.channels.create({
        name: 'tall-' + interaction.user.username.toLowerCase(),
        parent: '1488276013233209374',
        permissionOverwrites: [
          { id: interaction.guild.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages'] },
          { id: interaction.guild.members.me.id, allow: ['ViewChannel', 'SendMessages'] }
        ]
      });
      var closeRowP = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger)
      );
      await ticketP.send({ content: '**' + interaction.user.username + '** — Envoie ton pseudo BET0TALL pour recevoir tes 5000 Tall !\n<@' + ADMIN_ID + '> nouveau ticket Tall !', components: [closeRowP] });
      await interaction.reply({ content: 'Ton ticket : <#' + ticketP.id + '>', ephemeral: true });
    } catch(e) { console.error('Erreur tall:', e.message); await interaction.reply({ content: 'Erreur', ephemeral: true }); }
  }

  if (interaction.customId === 'open_question') {
    try {
      var existingQ = interaction.guild.channels.cache.find(function(c){ return c.name === 'question-' + interaction.user.username.toLowerCase(); });
      if (existingQ) { await interaction.reply({ content: 'Tu as deja un ticket ouvert : <#' + existingQ.id + '>', ephemeral: true }); return; }
      var ticketQ = await interaction.guild.channels.create({
        name: 'question-' + interaction.user.username.toLowerCase(),
        parent: '1488276013233209374',
        permissionOverwrites: [
          { id: interaction.guild.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages'] },
          { id: interaction.guild.members.me.id, allow: ['ViewChannel', 'SendMessages'] }
        ]
      });
      var closeRowQ = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Fermer le ticket').setStyle(ButtonStyle.Danger)
      );
      await ticketQ.send({ content: '**' + interaction.user.username + '** — Pose ta question ici !\n<@' + ADMIN_ID + '> nouvelle question !', components: [closeRowQ] });
      await interaction.reply({ content: 'Ton ticket : <#' + ticketQ.id + '>', ephemeral: true });
    } catch(e) { console.error('Erreur question:', e.message); await interaction.reply({ content: 'Erreur', ephemeral: true }); }
  }

  if (interaction.customId === 'close_ticket') {
    try {
      await interaction.channel.send('Ticket ferme par ' + interaction.user.username);
      setTimeout(async function(){ await interaction.channel.delete(); }, 3000);
      await interaction.reply({ content: 'Ticket ferme !', ephemeral: true });
    } catch(e) {}
  }
});

botClient.login(process.env.DISCORD_BOT_TOKEN);
