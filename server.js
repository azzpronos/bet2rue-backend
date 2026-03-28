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
      createdAt: new Date().toISOString()
    });
  }
  return users.get(discordUser.id);
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
  if (!code) {
    return res.redirect('/?error=no_code');
  }
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
    var discordUser = userRes.data;
    var user = getOrCreateUser(discordUser);
    res.redirect('/?uid=' + user.id + '&login=success');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/api/me', function(req, res) {
  var uid = req.query.uid;
  if (!uid || !users.has(uid)) {
    return res.status(401).json({ error: 'Non connecte' });
  }
  var user = users.get(uid);
  res.json({
    id: user.id,
    username: user.username,
    avatar: user.avatar
      ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png'
      : 'https://cdn.discordapp.com/embed/avatars/0.png',
    balance: user.balance,
    bets: user.bets,
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
        avatar: u.avatar
          ? 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png'
          : 'https://cdn.discordapp.com/embed/avatars/0.png',
        balance: u.balance,
        betsCount: u.bets.length,
        win
