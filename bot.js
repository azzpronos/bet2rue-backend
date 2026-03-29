const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const ADMIN_ID = '1143133778512986122';
const API_URL = process.env.RENDER_EXTERNAL_URL || 'https://bet2rue-backend.onrender.com';

client.once('ready', function() {
  console.log('Bot BET2RUE connecte : ' + client.user.tag);
});

client.on('messageCreate', async function(message) {
  if (message.author.bot) return;
  if (message.author.id !== ADMIN_ID) return;

  var content = message.content.trim();

  if (content === '!matchs') {
    try {
      var res = await fetch(API_URL + '/api/admin/matches?uid=' + ADMIN_ID);
      var data = await res.json();
      var txt = '📋 **MATCHS BET2RUE**\n\n';
      data.forEach(function(m) {
        var status = m.settled ? '✅ REGLE' : m.locked ? '🔴 FERME' : '🟢 OUVERT';
        txt += 'ID **' + m.id + '** | ' + m.day + ' ' + m.time + '\n';
        txt += m.hf + ' ' + m.home + ' vs ' + m.away + ' ' + m.af + '\n';
        txt += '1→' + m.odds.h + ' | N→' + m.odds.n + ' | 2→' + m.odds.a + ' | ' + status + '\n\n';
      });
      message.channel.send(txt);
    } catch(e) {
      message.channel.send('❌ Erreur : impossible de charger les matchs.');
    }
  }

  if (content.startsWith('!resultat')) {
    var parts = content.split(' ');
    if (parts.length !== 3) {
      message.channel.send('❌ Format incorrect. Utilise : `!resultat ID_MATCH 1/n/2`\nExemple : `!resultat 8 1`');
      return;
    }
    var matchId = parseInt(parts[1]);
    var result = parts[2].toLowerCase();
    if (!['1', 'n', '2'].includes(result)) {
      message.channel.send('❌ Resultat invalide. Utilise 1, n ou 2.');
      return;
    }
    var resultKey = result === '1' ? 'h' : result === 'n' ? 'n' : 'a';
    try {
      var res = await fetch(API_URL + '/api/admin/result?uid=' + ADMIN_ID, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: matchId, result: resultKey, uid: ADMIN_ID })
      });
      var data = await res.json();
      if (res.ok) {
        var resultLabel = result === '1' ? 'Victoire domicile' : result === 'n' ? 'Match nul' : 'Victoire exterieur';
        message.channel.send('✅ **Resultat enregistre !**\nMatch ID ' + matchId + ' → ' + resultLabel + '\n🏆 ' + data.settled + ' paris regles automatiquement !');
      } else {
        message.channel.send('❌ Erreur : ' + (data.error || 'Inconnue'));
      }
    } catch(e) {
      message.channel.send('❌ Erreur de connexion au serveur.');
    }
  }

  if (content === '!classement') {
    try {
      var res = await fetch(API_URL + '/api/leaderboard');
      var data = await res.json();
      var txt = '🏆 **CLASSEMENT BET2RUE**\n\n';
      var medals = ['🥇', '🥈', '🥉'];
      data.slice(0, 10).forEach(function(p, i) {
        txt += (medals[i] || (i+1) + '.') + ' **' + p.username + '** — ' + p.balance.toLocaleString() + ' EV\n';
      });
      message.channel.send(txt);
    } catch(e) {
      message.channel.send('❌ Erreur : impossible de charger le classement.');
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
