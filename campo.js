/* Vista de campo 2D para el narrador dinámico de TSM.
   Rama vista-campo. Lee los datos ya parseados mediante window.getCampoData
   y no modifica el flujo de la narración salvo el seek explícito del deslizador. */
(function () {
    'use strict';

    var PITCH = { x: 40, y: 36, w: 1050, h: 680 };
    var POS_X = { GK: 7, DF: 20, DM: 33, MF: 45, AM: 60, FW: 74 };
    var POS_ORDER = ['GK', 'DF', 'DM', 'MF', 'AM', 'FW'];
    var ROLE_PUSH = { GK: 0.12, DF: 0.5, DM: 0.68, MF: 0.85, AM: 1.05, FW: 1.22 };
    var KIND_LABEL = {
        'goal': 'Gol',
        'own-goal': 'Autogol',
        'penalty': 'Penalti',
        'corner': 'Córner',
        'goalkick': 'Saque de puerta',
        'shot': 'Remate',
        'save': 'Parada',
        'red': 'Roja',
        'yellow': 'Amarilla',
        'foul': 'Falta',
        'sub': 'Cambio',
        'injury': 'Lesión',
        'wing': 'Banda',
        'box': 'Área',
        'play': 'Jugada',
        'shootout': 'Tanda',
        'shootout-kick': 'Penalti (tanda)',
        'counter': 'Contraataque',
        'clearance': 'Despeje',
        'throwin': 'Saque de banda',
        'oneonone': 'Mano a mano'
    };

    var root = null;
    var svg = null;
    var playersLayer = null;
    var ballEl = null;
    var ui = {};
    var lastSignature = '';
    var numbers = new Map();
    var nextNumber = { home: 1, away: 1 };
    var numberedMatch = '';
    var ball = { x: 50, y: 50 };
    var lastKind = 'play';
    var lastPlayIndex = -1;
    var parsedPlays = [];
    var lastPlaysSource = '';
    var lastMatchId = '';
    var refreshing = false;
    var dragging = false;
    var built = false;
    var sliderPausedByUs = false;
    var playerState = {};
    var refState = { x: 53, y: 62, el: null, name: '' };
    // Escala de círculos, textos y balón en pantallas estrechas (el SVG se encoge con el ancho).
    var nodeScale = 1;
    var PITCH_GREEN = '#1a7a3c';
    var anim = {
        running: false,
        start: 0,
        ms: 700,
        ballPath: [],
        fromPlayers: {},
        toPlayers: {},
        queue: [],
        raf: 0
    };

    function $(id) { return document.getElementById(id); }

    function data() {
        return typeof window.getCampoData === 'function' ? window.getCampoData() : null;
    }

    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function keyOf(side, name) { return side + ':' + name; }

    function minuteValue(token) {
        if (token == null || token === '') return 0;
        var m = String(token).trim().match(/^(\d+)(?:\+(\d+))?$/);
        if (!m) return 0;
        return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 100 : 0);
    }

    function contrastColor(hex) {
        if (!hex) return '#fff';
        var c = String(hex).replace('#', '');
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        if (c.length < 6) return '#fff';
        var r = parseInt(c.slice(0, 2), 16);
        var g = parseInt(c.slice(2, 4), 16);
        var b = parseInt(c.slice(4, 6), 16);
        if (isNaN(r)) return '#fff';
        return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? '#1a1a1a' : '#ffffff';
    }

    function normalizePos(pos) {
        var p = String(pos || '').toUpperCase().replace(/[^A-Z]/g, '');
        if (p === 'MC' || p === 'CM') return 'MF';
        if (p === 'DC' || p === 'CB') return 'DF';
        if (p === 'ST' || p === 'CF') return 'FW';
        if (POS_X[p]) return p;
        if (p.indexOf('GK') === 0) return 'GK';
        if (p.indexOf('DF') === 0 || p === 'LB' || p === 'RB' || p === 'CB' || p === 'LWB' || p === 'RWB') return 'DF';
        if (p.indexOf('DM') === 0 || p === 'CDM') return 'DM';
        if (p.indexOf('AM') === 0 || p === 'CAM' || p === 'LW' || p === 'RW') return p.indexOf('AM') === 0 || p === 'CAM' ? 'AM' : 'FW';
        if (p.indexOf('MF') === 0 || p === 'CM' || p === 'LM' || p === 'RM') return 'MF';
        if (p.indexOf('FW') === 0) return 'FW';
        return 'MF';
    }

    function shortName(name, formatName, compact) {
        var raw = formatName ? formatName(name) : name;
        raw = String(raw || name || '').trim();
        var parts = raw.replace(/\./g, ' ').split(/\s+/).filter(Boolean);
        if (!parts.length) return '';
        var last = parts[parts.length - 1];
        var max = compact ? 6 : 10;
        return last.length > max ? last.slice(0, max - 1) + '.' : last;
    }

    function pitchBoxWidth() {
        // Ancho real del dibujo (en modo ampliado el SVG puede ser más estrecho que su caja).
        var box = $('campo-pitch-box');
        if (!box) return 0;
        var el = box.querySelector('svg') || box;
        return el.getBoundingClientRect().width || box.getBoundingClientRect().width;
    }

    function isCompactView() {
        var w = pitchBoxWidth();
        return w > 0 && w < 640;
    }

    // Factor de escala de los nodos: 1 en escritorio; hasta 1,75 en un móvil de 360 px.
    // Así el dorsal y el nombre siguen siendo legibles aunque el SVG se reduzca a un 30 %.
    function computeNodeScale() {
        var w = pitchBoxWidth();
        if (!w || w >= 900) return 1;
        return clamp(1 + (900 - w) / 900 * 1.3, 1, 1.75);
    }

    function sepFactor() {
        return 1 + (nodeScale - 1) * 0.5;
    }

    function applyCompactNames() {
        if (!root) return;
        var compact = isCompactView();
        var wrap = root.querySelector('.campo-wrap');
        if (wrap) {
            wrap.classList.toggle('campo-compact', compact);
            wrap.classList.toggle('campo-narrow', pitchBoxWidth() > 0 && pitchBoxWidth() < 420);
        }
        var k = computeNodeScale();
        var changed = Math.abs(k - nodeScale) > 0.01;
        nodeScale = k;
        if (!playersLayer) return;
        Array.prototype.forEach.call(playersLayer.querySelectorAll('.campo-name'), function (t) {
            var full = t.getAttribute('data-full');
            var short = t.getAttribute('data-short');
            if (full && short) t.textContent = compact ? short : full;
            t.setAttribute('font-size', compact ? '13.5' : '11');
            t.setAttribute('y', compact ? (t.getAttribute('data-ref') ? '33' : '35') : (t.getAttribute('data-ref') ? '31' : '33'));
        });
        Array.prototype.forEach.call(playersLayer.querySelectorAll('.campo-player .campo-dorsal'), function (t) {
            t.setAttribute('font-size', compact ? '15' : '13');
            t.setAttribute('y', compact ? '5.5' : '5');
        });
        if (changed) {
            Object.keys(playerState).forEach(function (key) { placePlayerEl(playerState[key]); });
            placeRefEl();
            placeBall();
        }
    }

    function assignNumber(side, name) {
        var k = keyOf(side, name);
        if (numbers.has(k)) return numbers.get(k);
        var n = nextNumber[side]++;
        numbers.set(k, n);
        return n;
    }

    function resetNumbers() {
        numbers.clear();
        nextNumber = { home: 1, away: 1 };
        numberedMatch = '';
    }

    function ensureRosterNumbers(d) {
        var mid = (d.homeTeam || '') + '|' + (d.awayTeam || '');
        if (numberedMatch === mid && numbers.size) return;
        resetNumbers();
        numberedMatch = mid;
        (d.homeStarters || []).forEach(function (p) { if (p && p.name) assignNumber('home', p.name); });
        (d.awayStarters || []).forEach(function (p) { if (p && p.name) assignNumber('away', p.name); });
        (d.homeSubs || []).forEach(function (p) { if (p && p.name) assignNumber('home', p.name); });
        (d.awaySubs || []).forEach(function (p) { if (p && p.name) assignNumber('away', p.name); });
    }

    function yForLine(n, i) {
        if (n <= 1) return 50;
        var margin = n >= 5 ? 10 : n === 4 ? 14 : n === 3 ? 18 : 26;
        var span = 100 - 2 * margin;
        return margin + span * (i + 0.5) / n;
    }

    function layoutTeam(starters, side) {
        var groups = { GK: [], DF: [], DM: [], MF: [], AM: [], FW: [] };
        (starters || []).forEach(function (p) {
            var pos = normalizePos(p.position);
            (groups[pos] || groups.MF).push(p);
        });
        var out = [];
        POS_ORDER.forEach(function (pos) {
            var arr = groups[pos];
            arr.forEach(function (p, i) {
                var x = POS_X[pos];
                if (side === 'away') x = 100 - x;
                out.push({
                    name: p.name,
                    position: p.position,
                    pos: pos,
                    side: side,
                    x: x,
                    y: yForLine(arr.length, i)
                });
            });
        });
        return out;
    }

    function toSvg(x, y) {
        return {
            x: PITCH.x + (x / 100) * PITCH.w,
            y: PITCH.y + (y / 100) * PITCH.h
        };
    }

    function classify(text) {
        var s = String(text || '').toLowerCase();
        if (/autogol|propia puerta/.test(s)) return 'own-goal';
        // Evitar falsos positivos como "Golpea las vallas".
        if (/¡+gol|go{3,}l|(?:^|[^\wáéíóúñ])¡?gol(?:es)?\b/i.test(s)) return 'goal';
        if (/penalti|penalty/.test(s)) return 'penalty';
        if (/c[oó]rner|saque de esquina/.test(s)) return 'corner';
        if (/saque de (puerta|meta)/.test(s)) return 'goalkick';
        if (/tarjeta roja/.test(s)) return 'red';
        if (/tarjeta amarilla/.test(s)) return 'yellow';
        if (/lesionado|lesi[oó]n/.test(s)) return 'injury';
        if (/cambio en |entra .+ por |sale .+ entra |sustituye/.test(s)) return 'sub';
        if (/qu[eé] parada|tapa el remate|ataja|el portero|vuela y (desvía|saca)/.test(s)) return 'save';
        if (/remate|chuta|disparo|volea|busca puerta|define |cabezazo|en posici[oó]n de remate|busca (la escuadra|el ángulo)/.test(s)) return 'shot';
        if (/contraataque|a la contra|se va de contra|sale de contra/.test(s)) return 'counter';
        if (/(?:^|[^a-záéíóúñ])despej[aeo]|manda (el bal[oó]n )?a la grada|rechaza (de cabeza|el bal[oó]n)/.test(s) && !/ataja|qu[eé] parada/.test(s)) return 'clearance';
        if (/frente a porter[ií]a|mano a mano|solo ante|se planta|último defensor/.test(s)) return 'oneonone';
        if (/falta|derriba|comete falta|entrada /.test(s)) return 'foul';
        if (/saque de banda/.test(s)) return 'throwin';
        if (/banda|por fuera|l[ií]nea de banda/.test(s)) return 'wing';
        if (/[aá]rea/.test(s)) return 'box';
        return 'play';
    }

    function isOneOnOneText(text) {
        return /frente a porter[ií]a|mano a mano|solo ante|se planta|último defensor/.test(String(text || '').toLowerCase());
    }

    function isCounterText(text) {
        return /contraataque|a la contra|se va de contra|sale de contra|monta un contra/.test(String(text || '').toLowerCase());
    }

    function sideOfTeam(team, d) {
        if (!team || !d) return null;
        if (team === d.homeTeam) return 'home';
        if (team === d.awayTeam) return 'away';
        return null;
    }

    function inferTarget(kind, team, players, d, playIndex, text) {
        var side = sideOfTeam(team, d) || 'home';
        var attack = side === 'home' ? 1 : -1;
        var goalX = side === 'home' ? 97.5 : 2.5;
        var ownGoalX = side === 'home' ? 2.5 : 97.5;
        var boxX = side === 'home' ? 88 : 12;
        var spotX = side === 'home' ? 89.5 : 10.5;
        var last = players && players.length ? players[players.length - 1] : null;
        var lastPt = last ? basePoint(last, d) : null;
        var t = String(text || '').toLowerCase();
        var left = /izquierda|primer palo/.test(t);
        var right = /derecha|segundo palo/.test(t);
        var wingY;
        if (left) wingY = 8;
        else if (right) wingY = 92;
        else wingY = (playIndex % 2 === 0) ? 8 : 92;

        function nearPlayer(fallbackX, fallbackY, towardGoal) {
            if (!lastPt) return { x: fallbackX, y: fallbackY };
            var x = lastPt.x + (towardGoal ? attack * 4 : 0);
            return { x: clamp(x, 3, 97), y: clamp(lastPt.y, 6, 94) };
        }

        switch (kind) {
            case 'goal':
            case 'own-goal':
                return { x: goalX, y: 50 + ((playIndex % 5) - 2) * 2.2 };
            case 'penalty':
                return { x: spotX, y: 50 };
            case 'corner':
                return { x: goalX, y: wingY };
            case 'goalkick':
                return { x: ownGoalX + attack * 6, y: 50 };
            case 'save':
                return { x: goalX - attack * 3, y: 50 + ((playIndex % 3) - 1) * 6 };
            case 'shot':
            case 'oneonone':
                return { x: boxX, y: lastPt ? clamp(lastPt.y, 28, 72) : 50 };
            case 'box':
                return { x: boxX, y: lastPt ? clamp(lastPt.y, 22, 78) : 50 };
            case 'wing':
                return nearPlayer(side === 'home' ? 70 : 30, wingY, true);
            case 'throwin':
                return { x: lastPt ? clamp(lastPt.x, 12, 88) : (side === 'home' ? 62 : 38), y: wingY };
            case 'counter':
                return { x: side === 'home' ? 78 : 22, y: lastPt ? clamp(lastPt.y, 18, 82) : 50 };
            case 'clearance':
                return { x: boxX, y: lastPt ? clamp(lastPt.y, 18, 82) : 50 };
            case 'foul':
                return nearPlayer(side === 'home' ? 62 : 38, lastPt ? lastPt.y : 50, false);
            case 'yellow':
            case 'red':
            case 'injury':
            case 'sub':
                return nearPlayer(50, 50, false);
            default:
                if (lastPt) return { x: clamp(lastPt.x + attack * 3, 5, 95), y: lastPt.y };
                return { x: side === 'home' ? 58 : 42, y: 50 };
        }
    }

    function basePoint(name, d) {
        var layouts = layoutTeam(d.homeStarters, 'home').concat(layoutTeam(d.awayStarters, 'away'));
        for (var i = 0; i < layouts.length; i++) {
            if (layouts[i].name === name) return { x: layouts[i].x, y: layouts[i].y, side: layouts[i].side, pos: layouts[i].pos };
        }
        return null;
    }

    function isPenaltyRowLine(line) {
        var s = String(line || '').replace(/^\s*\.{3}\s*/, '').trim();
        return /(?:[○✕□]\s*){2,}/.test(s);
    }

    function shootoutKickResult(text) {
        var body = String(text || '');
        var low = body.toLowerCase();
        if (/¡+\s*gol|go{3,}l|(?:^|[^\wáéíóúñ])¡?gol(?:es)?\b/i.test(body) || /poste y entra|larguero y entra|lo ha transformado|qu[eé] bien tirado/.test(low)) {
            return 'goal';
        }
        if (/bloca|detiene el penalti|lo par[oó]|saca con las dos manos|parada decisiva|ataja el disparo|se anticipa al delantero/.test(low)) {
            return 'save';
        }
        if (/desv[ií]a el bal[oó]n/.test(low) && /poste|larguero|fuera|dedos/.test(low)) return 'save';
        return 'miss';
    }

    function startsShootoutKick(line) {
        var s = String(line || '').replace(/^\s*\.{3}\s*/, '').trim();
        if (!s || isPenaltyRowLine(s) || /^\*{3,}/.test(s)) return false;
        if (/^PENALTI\b/i.test(s)) return true;
        return /^\([A-Za-z0-9]{2,5}\)\s+\S/.test(s);
    }

    function parseShootoutKicks(d) {
        var raw = d && d.narrationText ? String(d.narrationText) : '';
        if (!raw) return [];
        var lines = raw.replace(/\r/g, '').split('\n');
        var start = -1, i, line;
        for (i = 0; i < lines.length; i++) {
            if (/\*{3,}\s*[^*]*tanda[^*]*\*{3,}/i.test(lines[i])) { start = i; break; }
        }
        if (start < 0) return [];
        var kicks = [], cur = null;
        function flush() {
            if (cur && cur.lines.length) kicks.push(cur);
            cur = null;
        }
        for (i = start + 1; i < lines.length; i++) {
            line = lines[i];
            if (/\*{3,}\s*[^*]*final[^*]*\*{3,}/i.test(line)) break;
            if (/Detalles del partido|Player Statistics|Produced from /i.test(line) && !/^\s*\.{3}/.test(line)) break;
            if (!String(line).trim()) continue;
            if (startsShootoutKick(line)) {
                flush();
                cur = { startLine: i, endLine: i, lines: [line] };
            } else if (cur) {
                cur.lines.push(line);
                cur.endLine = i;
            }
        }
        flush();
        return kicks.map(function (k, idx) {
            var text = k.lines.join('\n');
            var body = k.lines.map(function (l) {
                return String(l).replace(/^\s*\.{3}\s*/, '').trim();
            }).filter(Boolean).join(' \n ');
            var first = (k.lines[0] || '').replace(/^\s*\.{3}\s*/, '').trim();
            var aliasM = first.match(/^\(([A-Za-z0-9]{2,5})\)/);
            var alias = aliasM ? aliasM[0] : '';
            var players = d.playersIn ? d.playersIn(body) : [];
            var team = null, side = null;
            if (alias && d.sideOfAlias) side = d.sideOfAlias(alias);
            if (!side && alias && d.detectTeam) {
                team = d.detectTeam('Minuto de juego 0: ' + first);
                side = team ? sideOfTeam(team, d) : null;
            }
            if (!side && players.length && d.sideOfPlayer) side = d.sideOfPlayer(players[0]);
            if (side === 'home') team = d.homeTeam;
            else if (side === 'away') team = d.awayTeam;
            var score = null;
            k.lines.forEach(function (l) {
                if (isPenaltyRowLine(l)) return;
                var sm = String(l).replace(/^\s*\.{3}\s*/, '').match(/(\d+)\s*-\s*(\d+)/);
                if (sm) score = sm[1] + '-' + sm[2];
            });
            return {
                startLine: k.startLine,
                endLine: k.endLine,
                text: text,
                players: players,
                team: team,
                result: shootoutKickResult(body),
                score: score,
                iKick: idx
            };
        });
    }

    function buildPlays(d) {
        if (!d) return [];
        var src = (d.plays || []).map(function (p) { return p.token + '|' + (p.lines || []).join('\n'); }).join('\0');
        src += '\0SO:' + ((d.narrationText || '').length);
        if (src === lastPlaysSource && parsedPlays.length) return parsedPlays;
        lastPlaysSource = src;
        parsedPlays = (d.plays || []).map(function (p, i) {
            var first = (p.lines && p.lines[0]) || '';
            var team = d.detectTeam ? d.detectTeam(first) : null;
            var text = (p.lines || []).join(' \n ');
            var players = d.playersIn ? d.playersIn(text) : [];
            var kind = classify(text);
            return {
                i: i,
                minute: p.token,
                team: team,
                text: text,
                players: players,
                kind: kind,
                target: inferTarget(kind, team, players, d, i, text)
            };
        });
        var kicks = parseShootoutKicks(d);
        if (kicks.length) {
            parsedPlays.push({
                i: parsedPlays.length,
                minute: 'tanda',
                team: null,
                text: 'TANDA DE PENALTIS',
                players: [],
                kind: 'shootout',
                startLine: kicks[0].startLine,
                endLine: kicks[0].startLine,
                shootoutIndex: -1,
                target: { x: 89.5, y: 50 }
            });
            kicks.forEach(function (k) {
                parsedPlays.push({
                    i: parsedPlays.length,
                    minute: 'tanda',
                    team: k.team,
                    text: k.text,
                    players: k.players,
                    kind: 'shootout-kick',
                    result: k.result,
                    shootoutIndex: k.iKick,
                    shootoutScore: k.score,
                    startLine: k.startLine,
                    endLine: k.endLine,
                    target: { x: 89.5, y: 50 }
                });
            });
        }
        return parsedPlays;
    }

    function matchNarrationToPlay(plays, narr) {
        if (!narr || narr.length < 6) return null;
        var needle = narr.replace(/\s+/g, ' ').trim().slice(0, Math.min(40, narr.length));
        if (needle.length < 6) return null;
        var i, body;
        for (i = plays.length - 1; i >= 0; i--) {
            body = String(plays[i].text || '').replace(/\s+/g, ' ');
            if (body.indexOf(needle) !== -1) return plays[i];
        }
        return null;
    }

    function currentPlay(d) {
        var plays = buildPlays(d);
        if (!plays.length) return null;
        var soPlays = plays.filter(function (p) { return p.kind === 'shootout' || p.kind === 'shootout-kick'; });
        var inSO = !!(d.inShootout || (d.minute && /tanda/i.test(String(d.minute))));
        var narr = (d.narration || '').replace(/\s+/g, ' ').trim();
        if (inSO && soPlays.length) {
            var hit = matchNarrationToPlay(soPlays, narr);
            if (hit) return hit;
            if (d.finished) return soPlays[soPlays.length - 1];
            return soPlays[0];
        }
        if (d.finished) return plays[plays.length - 1];
        if (d.minute == null || d.minute === '') return null;
        var best = -1;
        for (var i = 0; i < plays.length; i++) {
            if (plays[i].minute === 'tanda') continue;
            if (minuteValue(plays[i].minute) <= minuteValue(d.minute) + 0.0001) best = i;
        }
        if (best < 0) return null;
        var sameMin = [];
        for (var j = 0; j <= best; j++) {
            if (plays[j].minute === 'tanda') continue;
            if (String(plays[j].minute) === String(d.minute) || minuteValue(plays[j].minute) === minuteValue(d.minute)) {
                sameMin.push(plays[j]);
            }
        }
        if (narr && sameMin.length) {
            var found = matchNarrationToPlay(sameMin, narr);
            if (found) return found;
        }
        return sameMin.length ? sameMin[sameMin.length - 1] : plays[best];
    }

    function svgEl(name, attrs) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', name);
        Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
        return el;
    }

    function drawPitch() {
        var vbW = 1130, vbH = 752;
        svg = svgEl('svg', { viewBox: '0 0 ' + vbW + ' ' + vbH, role: 'img', 'aria-label': 'Campo de fútbol' });
        var defs = svgEl('defs', {});
        defs.innerHTML =
            '<pattern id="campo-stripes" patternUnits="userSpaceOnUse" width="70" height="' + PITCH.h + '">' +
            '<rect width="70" height="' + PITCH.h + '" fill="#1a7a3c"/>' +
            '<rect width="35" height="' + PITCH.h + '" fill="#176f36"/>' +
            '</pattern>' +
            '<filter id="campo-shadow" x="-50%" y="-50%" width="200%" height="200%">' +
            '<feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.45"/>' +
            '</filter>' +
            '<clipPath id="campo-clip"><rect x="' + PITCH.x + '" y="' + PITCH.y + '" width="' + PITCH.w + '" height="' + PITCH.h + '"/></clipPath>';
        svg.appendChild(defs);

        var bg = svgEl('rect', { x: 0, y: 0, width: vbW, height: vbH, fill: '#0b3b1c' });
        svg.appendChild(bg);

        var x = PITCH.x, y = PITCH.y, w = PITCH.w, h = PITCH.h;
        var scale = w / 105;
        function m(meters) { return meters * scale; }

        svg.appendChild(svgEl('rect', { x: x, y: y, width: w, height: h, fill: 'url(#campo-stripes)' }));

        var lines = svgEl('g', { fill: 'none', stroke: 'rgba(255,255,255,0.9)', 'stroke-width': 3 });
        lines.appendChild(svgEl('rect', { x: x, y: y, width: w, height: h }));
        lines.appendChild(svgEl('line', { x1: x + w / 2, y1: y, x2: x + w / 2, y2: y + h }));
        lines.appendChild(svgEl('circle', { cx: x + w / 2, cy: y + h / 2, r: m(9.15) }));
        lines.appendChild(svgEl('circle', { cx: x + w / 2, cy: y + h / 2, r: 4, fill: '#fff', stroke: 'none' }));

        var boxW = m(16.5), boxH = m(40.32), boxY = y + (h - boxH) / 2;
        var sixW = m(5.5), sixH = m(18.32), sixY = y + (h - sixH) / 2;
        var spot = m(11), arcR = m(9.15);
        lines.appendChild(svgEl('rect', { x: x, y: boxY, width: boxW, height: boxH }));
        lines.appendChild(svgEl('rect', { x: x + w - boxW, y: boxY, width: boxW, height: boxH }));
        lines.appendChild(svgEl('rect', { x: x, y: sixY, width: sixW, height: sixH }));
        lines.appendChild(svgEl('rect', { x: x + w - sixW, y: sixY, width: sixW, height: sixH }));
        lines.appendChild(svgEl('circle', { cx: x + spot, cy: y + h / 2, r: 4, fill: '#fff', stroke: 'none' }));
        lines.appendChild(svgEl('circle', { cx: x + w - spot, cy: y + h / 2, r: 4, fill: '#fff', stroke: 'none' }));
        // Media luna: arco de 9,15 m centrado en el penalti, solo la parte fuera del área (hacia el centro).
        lines.appendChild(svgEl('path', { d: arcPath(x + spot, y + h / 2, arcR, boxW - spot, true), 'class': 'campo-arc campo-arc-home' }));
        lines.appendChild(svgEl('path', { d: arcPath(x + w - spot, y + h / 2, arcR, boxW - spot, false), 'class': 'campo-arc campo-arc-away' }));

        var cr = m(1);
        lines.appendChild(svgEl('path', { d: cornerArc(x, y, cr, 0) }));
        lines.appendChild(svgEl('path', { d: cornerArc(x + w, y, cr, 1) }));
        lines.appendChild(svgEl('path', { d: cornerArc(x + w, y + h, cr, 2) }));
        lines.appendChild(svgEl('path', { d: cornerArc(x, y + h, cr, 3) }));
        svg.appendChild(lines);

        var goalW = m(2.2), goalH = m(7.32), goalY = y + (h - goalH) / 2;
        var goals = svgEl('g', { fill: 'none', stroke: 'rgba(255,255,255,0.95)', 'stroke-width': 4 });
        goals.appendChild(svgEl('rect', { x: x - goalW, y: goalY, width: goalW, height: goalH }));
        goals.appendChild(svgEl('rect', { x: x + w, y: goalY, width: goalW, height: goalH }));
        svg.appendChild(goals);

        var labels = svgEl('g', { fill: 'rgba(255,255,255,0.45)', 'font-size': '14', 'font-family': 'Segoe UI, sans-serif', 'text-anchor': 'middle' });
        labels.appendChild(textAt(x + 80, y + 22, 'Local'));
        labels.appendChild(textAt(x + w - 80, y + 22, 'Visitante'));
        svg.appendChild(labels);

        playersLayer = svgEl('g', { 'class': 'campo-players' });
        svg.appendChild(playersLayer);

        var ballG = svgEl('g', { 'class': 'campo-ball', filter: 'url(#campo-shadow)' });
        ballG.appendChild(svgEl('circle', { r: 9, fill: '#f4f4f4', stroke: '#222', 'stroke-width': 1.5, cx: 0, cy: 0 }));
        ballG.appendChild(svgEl('path', {
            d: 'M0,-9 C3,-3 3,3 0,9 C-3,3 -3,-3 0,-9',
            fill: 'none', stroke: '#222', 'stroke-width': 1
        }));
        svg.appendChild(ballG);
        ballEl = ballG;

        var mid = toSvg(50, 50);
        ballEl.setAttribute('transform', 'translate(' + mid.x + ',' + mid.y + ')');
    }

    function textAt(x, y, t) {
        var el = svgEl('text', { x: x, y: y });
        el.textContent = t;
        return el;
    }

    function arcPath(cx, cy, r, offset, home) {
        // Cuerda en la línea del área (offset metros hacia el centro desde el penalti).
        // El arco sale hacia el centro del campo, no hacia dentro del área.
        var d = offset;
        if (d >= r) return '';
        var ang = Math.acos(d / r);
        var y1 = cy - r * Math.sin(ang);
        var y2 = cy + r * Math.sin(ang);
        var x = home ? cx + d : cx - d;
        // sweep 1 (horario) en la portería local y 0 en la visitante: el arco abomba hacia el medio.
        return 'M' + x + ',' + y1 + ' A' + r + ',' + r + ' 0 0 ' + (home ? 1 : 0) + ' ' + x + ',' + y2;
    }

    function cornerArc(cx, cy, r, q) {
        var start, end;
        if (q === 0) { start = [cx + r, cy]; end = [cx, cy + r]; }
        else if (q === 1) { start = [cx, cy + r]; end = [cx - r, cy]; }
        else if (q === 2) { start = [cx - r, cy]; end = [cx, cy - r]; }
        else { start = [cx, cy - r]; end = [cx + r, cy]; }
        return 'M' + start[0] + ',' + start[1] + ' A' + r + ',' + r + ' 0 0 1 ' + end[0] + ',' + end[1];
    }

    /* ---------------- Movimiento de jugadores ---------------- */

    function findOnPitch(players, name) {
        if (!name) return null;
        var lower = String(name).toLowerCase();
        var i, p, last;
        for (i = 0; i < players.length; i++) {
            if (players[i].name === name) return players[i];
        }
        for (i = 0; i < players.length; i++) {
            if (String(players[i].name).toLowerCase() === lower) return players[i];
        }
        last = lower.split(/\s+/).pop();
        if (last && last.length > 2) {
            for (i = 0; i < players.length; i++) {
                p = String(players[i].name).toLowerCase();
                if (p === last || p.split(/\s+/).pop() === last) return players[i];
            }
        }
        return null;
    }

    function namedPlayers(players, names, side) {
        var out = [];
        var seen = {};
        (names || []).forEach(function (n) {
            var p = findOnPitch(players, n);
            if (p && !seen[p.side + ':' + p.name] && (!side || p.side === side)) {
                seen[p.side + ':' + p.name] = true;
                out.push(p);
            }
        });
        return out;
    }

    function ofSide(players, side) {
        return players.filter(function (p) { return p.side === side; });
    }

    function ofPos(players, pos) {
        return players.filter(function (p) { return p.pos === pos; });
    }

    function placeAt(p, x, y) {
        if (!p) return;
        p.tx = clamp(x, 2.2, 97.8);
        p.ty = clamp(y, 4, 96);
    }

    function applyBlock(players, ballT, attackSide, kind) {
        var heavy = kind === 'shot' || kind === 'goal' || kind === 'own-goal' || kind === 'save' || kind === 'box' || kind === 'corner' || kind === 'penalty';
        players.forEach(function (p) {
            var rf = ROLE_PUSH[p.pos] || 0.8;
            var dx = (ballT.x - 50) * 0.28 * (p.pos === 'GK' ? 0.15 : 0.9);
            var dy = (ballT.y - 50) * 0.45 * (p.pos === 'GK' ? 0.18 : 0.8);
            var dir = p.side === 'home' ? 1 : -1;
            var onBall = p.side === attackSide;
            var push = 0;
            if (heavy) push = onBall ? 6.2 * rf : -4.6 * rf;
            else if (kind === 'play' || kind === 'wing' || kind === 'foul') push = onBall ? 3.6 * rf : -2.6 * rf;
            else if (kind === 'goalkick') push = onBall ? -1.5 * rf : 1.2 * rf;
            p.tx = clamp(p.baseX + dx + dir * push, 2.5, 97.5);
            p.ty = clamp(p.baseY + dy, 5, 95);
            if (p.pos === 'GK') {
                p.tx = p.side === 'home' ? clamp(7 + dx * 0.4, 3, 16) : clamp(93 + dx * 0.4, 84, 97);
                p.ty = clamp(50 + (ballT.y - 50) * 0.22, 32, 68);
            }
        });
    }

    function separate(players, opts) {
        opts = opts || {};
        var sf = sepFactor();
        var minX = (opts.minX || 6.2) * sf;
        var minY = (opts.minY || 11.2) * sf;
        var rounds = opts.rounds || 4;
        var pinned = opts.pinned || {};
        var i, j, a, b, dx, dy, nx, ny, dist, push, k, pinA, pinB;
        function isPinned(p) {
            return !!(pinned[keyOf(p.side, p.name)] || (opts.freezeGK && p.pos === 'GK'));
        }
        for (k = 0; k < rounds; k++) {
            for (i = 0; i < players.length; i++) {
                for (j = i + 1; j < players.length; j++) {
                    a = players[i];
                    b = players[j];
                    dx = (b.tx - a.tx) / minX;
                    dy = (b.ty - a.ty) / minY;
                    dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 0.08) {
                        dx = 0;
                        dy = (i % 2 ? 1 : -1);
                        dist = 1;
                    }
                    if (dist < 1) {
                        push = (1 - dist) / 2;
                        nx = dx / dist;
                        ny = dy / dist;
                        pinA = isPinned(a) || (a.pos === 'GK' && !opts.moveGK);
                        pinB = isPinned(b) || (b.pos === 'GK' && !opts.moveGK);
                        if (!pinA) {
                            a.tx = clamp(a.tx - nx * push * minX * (pinB ? 2 : 1), 2.2, 97.8);
                            a.ty = clamp(a.ty - ny * push * minY * (pinB ? 2 : 1), 6, 94);
                        }
                        if (!pinB) {
                            b.tx = clamp(b.tx + nx * push * minX * (pinA ? 2 : 1), 2.2, 97.8);
                            b.ty = clamp(b.ty + ny * push * minY * (pinA ? 2 : 1), 6, 94);
                        }
                    }
                }
            }
        }
    }

    function setupShotShape(players, play, attack, ballT, opts) {
        opts = opts || {};
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var atk = ofSide(players, attack);
        var def = ofSide(players, defSide);
        var namedAtk = namedPlayers(players, play.players, attack);
        var shooter = namedAtk.length ? namedAtk[namedAtk.length - 1] : (ofPos(atk, 'FW')[0] || atk[atk.length - 1]);
        var assist = namedAtk.length > 1 ? namedAtk[namedAtk.length - 2] : null;
        var goalish = attack === 'home' ? 86 : 14;
        if (opts.oneOnOne) goalish = opts.approach ? (attack === 'home' ? 68 : 32) : (attack === 'home' ? 80 : 20);
        var shotX = opts.keepBall ? ballT.x : goalish;
        var shotY = clamp(ballT.y, opts.oneOnOne ? 22 : 28, opts.oneOnOne ? 78 : 72);
        if (shooter) placeAt(shooter, shotX - dir * (opts.oneOnOne ? 2.2 : 3.2), shotY);
        if (assist) placeAt(assist, shotX - dir * (opts.oneOnOne ? 14 : 9), clamp(shotY + (assist.baseY - 50) * 0.35, 16, 84));
        namedAtk.forEach(function (p, i) {
            if (p === shooter || p === assist) return;
            placeAt(p, shotX - dir * (opts.oneOnOne ? (16 + i * 4) : (12 + i * 3)), clamp(p.baseY * 0.4 + shotY * 0.6, 16, 84));
        });
        var gk = ofPos(def, 'GK')[0];
        if (gk) {
            var come = opts.oneOnOne ? (opts.approach ? 5 : 12) : 1.5;
            placeAt(gk, (attack === 'home' ? 97 : 3) - dir * come, clamp(shotY, 36, 64));
        }
        var markers = def.filter(function (p) { return p.pos !== 'GK'; }).sort(function (a, b) {
            return Math.abs(a.baseY - shotY) - Math.abs(b.baseY - shotY);
        });
        if (opts.oneOnOne) {
            // Un solo último defensor, al costado y un poco por detrás del atacante; el resto, rezagado.
            if (markers[0]) {
                placeAt(markers[0], shotX + dir * (opts.approach ? 10 : 5.5), clamp(shotY + (markers[0].baseY >= shotY ? 7 : -7), 16, 84));
            }
            markers.slice(1).forEach(function (p, i) {
                var back = opts.approach ? (10 + i * 3) : (16 + i * 4);
                placeAt(p, clamp(shotX - dir * back, 8, 92), clamp(lerp(p.baseY, shotY, 0.15) + (i % 2 ? 12 : -12), 10, 90));
            });
        } else {
            markers.slice(0, 3).forEach(function (p, i) {
                placeAt(p, shotX + dir * (2 + i), clamp(shotY + (i - 1) * 8, 18, 82));
            });
        }
        var boxSpotsAtk = opts.oneOnOne ? [
            [shotX - dir * 12, clamp(shotY - 18, 14, 86)],
            [shotX - dir * 14, clamp(shotY + 18, 14, 86)],
            [shotX - dir * 20, 32],
            [shotX - dir * 20, 68]
        ] : [
            [shotX + dir * 4, clamp(shotY - 14, 16, 84)],
            [shotX + dir * 5, clamp(shotY + 14, 16, 84)],
            [shotX - dir * 6, 30],
            [shotX - dir * 6, 70]
        ];
        var extras = atk.filter(function (p) { return p !== shooter && p !== assist && p.pos !== 'GK' && namedAtk.indexOf(p) === -1; });
        extras.forEach(function (p, i) {
            if (boxSpotsAtk[i]) placeAt(p, boxSpotsAtk[i][0], boxSpotsAtk[i][1]);
        });
        return { shooter: shooter, assist: assist, namedAtk: namedAtk, gk: gk, shot: { x: shotX, y: shotY } };
    }

    function setupCorner(players, play, attack, ballT) {
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var left = ballT.y < 50;
        var goalX = attack === 'home' ? 97.5 : 2.5;
        var nearY = left ? 22 : 78;
        var farY = left ? 74 : 26;
        var atk = ofSide(players, attack);
        var def = ofSide(players, defSide);
        var namedAtk = namedPlayers(players, play.players, attack);
        var taker = namedAtk[0] || ofPos(atk, 'AM')[0] || ofPos(atk, 'MF')[0] || atk[atk.length - 1];
        if (taker) placeAt(taker, goalX, left ? 4 : 96);
        var atkSpots = [
            [attack === 'home' ? 91 : 9, nearY],
            [attack === 'home' ? 89.5 : 10.5, 50],
            [attack === 'home' ? 91 : 9, farY],
            [attack === 'home' ? 84 : 16, left ? 38 : 62],
            [attack === 'home' ? 86 : 14, left ? 62 : 38]
        ];
        var atkRest = atk.filter(function (p) { return p !== taker && p.pos !== 'GK'; })
            .sort(function (a, b) { return (ROLE_PUSH[b.pos] || 0) - (ROLE_PUSH[a.pos] || 0); });
        atkRest.forEach(function (p, i) {
            if (atkSpots[i]) placeAt(p, atkSpots[i][0], atkSpots[i][1]);
        });
        var gk = ofPos(def, 'GK')[0];
        if (gk) placeAt(gk, attack === 'home' ? 96.5 : 3.5, 50 + (left ? -7 : 7));
        var defRest = def.filter(function (p) { return p !== gk; });
        if (defRest[0]) placeAt(defRest[0], attack === 'home' ? 96.2 : 3.8, left ? 20 : 80);
        atkRest.forEach(function (p, i) {
            var m = defRest[i + 1];
            if (m) placeAt(m, p.tx + dir * 1.2, p.ty + (left ? 2 : -2));
        });
        return { taker: taker };
    }

    function setupPenalty(players, play, attack) {
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var spotX = attack === 'home' ? 89.5 : 10.5;
        var edgeX = attack === 'home' ? 83 : 17;
        var atk = ofSide(players, attack);
        var def = ofSide(players, defSide);
        var namedAtk = namedPlayers(players, play.players, attack);
        var taker = namedAtk[namedAtk.length - 1] || ofPos(atk, 'FW')[0] || atk[atk.length - 1];
        if (taker) placeAt(taker, spotX - dir * 2.4, 50);
        var gk = ofPos(def, 'GK')[0];
        if (gk) placeAt(gk, attack === 'home' ? 97.6 : 2.4, 50);
        var rest = players.filter(function (p) { return p !== taker && p !== gk; });
        rest.forEach(function (p, i) {
            var n = rest.length;
            var y = 12 + (76 * (i + 0.5) / n);
            var x = edgeX - dir * (p.side === attack ? 2 : 5);
            placeAt(p, x, y);
        });
        return { taker: taker };
    }

    function setupFoul(players, play, attack, ballT, text) {
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var t = String(text || '').toLowerCase();
        var wall = /barrera|cerca del [aá]rea|falta peligrosa|muy cerca/.test(t) ||
            (attack === 'home' ? ballT.x > 72 : ballT.x < 28);
        var named = namedPlayers(players, play.players);
        var taker = namedPlayers(players, play.players, attack)[0] || named[0];
        var fouledOrKicker = taker;
        if (fouledOrKicker) placeAt(fouledOrKicker, ballT.x - dir * 3, ballT.y);
        var fouler = namedPlayers(players, play.players, defSide)[0];
        if (fouler) placeAt(fouler, ballT.x + dir * 3.5, clamp(ballT.y + 4, 8, 92));
        if (wall) {
            var defenders = ofSide(players, defSide).filter(function (p) { return p.pos !== 'GK' && p !== fouler; });
            var wallN = Math.min(4, defenders.length);
            var wallX = ballT.x + dir * 8.5;
            var midY = ballT.y + (50 - ballT.y) * 0.25;
            for (var i = 0; i < wallN; i++) {
                placeAt(defenders[i], wallX, midY + (i - (wallN - 1) / 2) * 3.4);
            }
            var gk = ofPos(ofSide(players, defSide), 'GK')[0];
            if (gk) placeAt(gk, attack === 'home' ? 96.5 : 3.5, clamp(ballT.y, 36, 64));
        }
        return { taker: fouledOrKicker };
    }

    function setupPassShape(players, play, attack, ballT) {
        var dir = attack === 'home' ? 1 : -1;
        var namedAtk = namedPlayers(players, play.players, attack);
        var namedAll = namedPlayers(players, play.players);
        var chain = namedAtk.length ? namedAtk : namedAll;
        if (!chain.length) return { chain: [] };
        var n = chain.length;
        chain.forEach(function (p, i) {
            var along = (i - (n - 1)) * 6;
            placeAt(p, clamp(ballT.x - dir * (2 - along * 0.15) + dir * along, 6, 94), clamp(lerp(p.baseY, ballT.y, 0.45 + i * 0.12), 8, 92));
        });
        var carrier = chain[chain.length - 1];
        if (carrier) placeAt(carrier, clamp(ballT.x, 6, 94), clamp(ballT.y, 8, 92));
        return { chain: chain, carrier: carrier };
    }

    function setupWing(players, play, attack, ballT) {
        var dir = attack === 'home' ? 1 : -1;
        var namedAtk = namedPlayers(players, play.players, attack);
        var carrier = namedAtk[namedAtk.length - 1] || namedAtk[0];
        var y = ballT.y < 50 ? 7 : 93;
        if (carrier) placeAt(carrier, ballT.x, y);
        var fb = ofPos(ofSide(players, attack), 'DF').sort(function (a, b) {
            return Math.abs(a.baseY - y) - Math.abs(b.baseY - y);
        })[0];
        if (fb && fb !== carrier) placeAt(fb, ballT.x - dir * 7, clamp(y + (y < 50 ? 8 : -8), 6, 94));
        ofPos(ofSide(players, attack), 'FW').forEach(function (p, i) {
            placeAt(p, attack === 'home' ? 88 - i * 3 : 12 + i * 3, 40 + i * 18);
        });
        return { carrier: carrier };
    }

    function setupGoalkick(players, play, attack) {
        var dir = attack === 'home' ? 1 : -1;
        var atk = ofSide(players, attack);
        var gk = ofPos(atk, 'GK')[0];
        if (gk) placeAt(gk, attack === 'home' ? 8 : 92, 50);
        atk.filter(function (p) { return p !== gk; }).forEach(function (p) {
            placeAt(p, clamp(p.baseX - dir * 6, 8, 92), p.baseY);
        });
        ofSide(players, attack === 'home' ? 'away' : 'home').forEach(function (p) {
            if (p.pos !== 'GK') placeAt(p, clamp(p.baseX - dir * 4, 8, 92), p.baseY);
        });
        return { gk: gk };
    }

    function setupSub(players, play) {
        var named = namedPlayers(players, play.players);
        named.forEach(function (p, i) {
            placeAt(p, 50 + (p.side === 'home' ? -4 : 4), 5 + i * 6);
        });
        return { named: named };
    }

    function setupCardOrInjury(players, play, ballT) {
        var named = namedPlayers(players, play.players);
        named.forEach(function (p, i) {
            placeAt(p, ballT.x + (i ? 3 : 0), ballT.y + (i ? 4 : 0));
        });
        players.forEach(function (p) {
            if (named.indexOf(p) !== -1 || p.pos === 'GK') return;
            var ddx = ballT.x - p.tx;
            var ddy = ballT.y - p.ty;
            placeAt(p, p.tx + ddx * 0.15, p.ty + ddy * 0.15);
        });
        return { named: named };
    }

    function setupCelebration(players, play, attack, ballT) {
        var scorer = namedPlayers(players, play.players, attack).pop() || namedPlayers(players, play.players).pop();
        var cornerY = ballT.y < 50 ? 26 : 74;
        var meetX = attack === 'home' ? 78 : 22;
        if (play.kind === 'own-goal') meetX = attack === 'home' ? 24 : 76;
        if (scorer) placeAt(scorer, meetX, cornerY);
        var mates = ofSide(players, attack).filter(function (p) { return p !== scorer && p.pos !== 'GK'; });
        var n = mates.length;
        mates.forEach(function (p, i) {
            var ang = (2 * Math.PI * (i + 0.12) / Math.max(n, 1)) + (cornerY < 50 ? 0.35 : -0.35);
            var ring = (i >= 6) ? 1 : 0;
            var odd = (i % 2) ? 1.12 : 1;
            var rx = (ring ? 16.8 : 10.2) * odd;
            var ry = (ring ? 22.5 : 14.8) * odd;
            placeAt(p, meetX + Math.cos(ang) * rx, clamp(cornerY + Math.sin(ang) * ry, 8, 92));
        });
        var agk = ofPos(ofSide(players, attack), 'GK')[0];
        if (agk) placeAt(agk, attack === 'home' ? 14 : 86, 50);
        function pushOutOfHuddle(p, rx, ry) {
            if (!p || p.pos === 'GK') return;
            var dx = p.tx - meetX, dy = p.ty - cornerY;
            var dist = Math.hypot(dx / rx, dy / ry);
            if (dist >= 1) return;
            var ux = dx, uy = dy;
            if (Math.hypot(ux, uy) < 0.5) {
                ux = (50 - meetX) || (p.baseX - meetX) || 1;
                uy = (50 - cornerY) * 0.4 + (p.baseY - cornerY) * 0.2;
            }
            // Preferir el lado del mediocampo, no el córner de la celebración.
            if ((meetX > 50 && ux > 0) || (meetX < 50 && ux < 0)) ux = -ux || (50 - meetX);
            var ang = Math.atan2(uy / ry, ux / rx);
            placeAt(p, meetX + Math.cos(ang) * rx, clamp(cornerY + Math.sin(ang) * ry, 8, 92));
        }
        var defSide = attack === 'home' ? 'away' : 'home';
        ofSide(players, defSide).forEach(function (p, i) {
            if (p.pos === 'GK') {
                placeAt(p, attack === 'home' ? 95.5 : 4.5, clamp(lerp(50, ballT.y, 0.12), 38, 62));
                return;
            }
            // Se retiran hacia el mediocampo / su campo, repartidos, lejos del corro.
            var retreatX = attack === 'home'
                ? 30 + (p.pos === 'FW' ? 8 : p.pos === 'AM' || p.pos === 'MF' ? 4 : 0)
                : 70 - (p.pos === 'FW' ? 8 : p.pos === 'AM' || p.pos === 'MF' ? 4 : 0);
            var midY = 50 + (50 - cornerY) * 0.42;
            var spreadY = clamp(lerp(p.baseY, midY, 0.55) + ((i % 5) - 2) * 7, 10, 90);
            placeAt(p, retreatX + (p.baseY - 50) * 0.05, spreadY);
            pushOutOfHuddle(p, 38, 48);
        });
        var pin = {};
        if (scorer) pin[keyOf(scorer.side, scorer.name)] = true;
        mates.forEach(function (p) { pin[keyOf(p.side, p.name)] = true; });
        var agkKey = agk ? keyOf(agk.side, agk.name) : null;
        if (agkKey) pin[agkKey] = true;
        separate(players, { minX: 8.4, minY: 15.2, rounds: 8, pinned: pin });
        ofSide(players, defSide).forEach(function (p) { pushOutOfHuddle(p, 38, 48); });
        return { scorer: scorer };
    }

    function findSubRecord(d, name) {
        var lists = [d.homeStarters, d.homeSubs, d.awayStarters, d.awaySubs];
        var i, j, arr;
        for (i = 0; i < lists.length; i++) {
            arr = lists[i] || [];
            for (j = 0; j < arr.length; j++) {
                if (arr[j] && arr[j].name === name) return arr[j];
            }
        }
        return null;
    }

    function ensureNamedOnPitch(players, play, d) {
        (play.players || []).forEach(function (name) {
            if (findOnPitch(players, name)) return;
            var rec = findSubRecord(d, name);
            var side = d.sideOfPlayer ? d.sideOfPlayer(name) : null;
            if (!side && rec) {
                var inHome = (d.homeStarters || []).concat(d.homeSubs || []).some(function (p) { return p && p.name === name; });
                side = inHome ? 'home' : 'away';
            }
            if (!side) return;
            var named = play.players || [];
            var cand = ofSide(players, side).filter(function (p) {
                return p.pos !== 'GK' && named.indexOf(p.name) === -1;
            });
            var victim = ofPos(cand, 'FW')[0] || ofPos(cand, 'AM')[0] || cand[cand.length - 1];
            if (!victim) return;
            victim.name = name;
            victim.pos = rec ? normalizePos(rec.position) : victim.pos;
        });
    }

    function setupShootout(players, play, d) {
        ensureNamedOnPitch(players, play, d);
        var attack = sideOfTeam(play.team, d) || 'home';
        var defSide = attack === 'home' ? 'away' : 'home';
        var namedAtk = namedPlayers(players, play.players, attack);
        var namedAll = namedPlayers(players, play.players);
        var taker = namedAtk[0] || namedAll[0] || ofPos(ofSide(players, attack), 'FW')[0] || ofSide(players, attack).slice(-1)[0];
        var gkDef = ofPos(ofSide(players, defSide), 'GK')[0];
        var gkAtk = ofPos(ofSide(players, attack), 'GK')[0];
        if (taker) placeAt(taker, 87.0, 50);
        if (gkDef && gkDef !== taker) placeAt(gkDef, 97.6, 50);
        if (gkAtk && gkAtk !== taker && gkAtk !== gkDef) placeAt(gkAtk, 96.4, 20.5);
        function placeGroup(arr, cx) {
            var n = arr.length;
            arr.forEach(function (p, i) {
                var ang = -Math.PI / 2 + (2 * Math.PI * (i + 0.5) / Math.max(n, 1));
                var f = n <= 4 ? 0.55 : (0.5 + 0.4 * (i % 2));
                placeAt(p, cx + Math.cos(ang) * 7.2 * f, 50 + Math.sin(ang) * 11.5 * f);
            });
        }
        placeGroup(ofSide(players, 'home').filter(function (p) { return p !== taker && p !== gkDef && p !== gkAtk; }), 45.5);
        placeGroup(ofSide(players, 'away').filter(function (p) { return p !== taker && p !== gkDef && p !== gkAtk; }), 54.5);
        var pin = {};
        if (taker) pin[keyOf(taker.side, taker.name)] = true;
        if (gkDef) pin[keyOf(gkDef.side, gkDef.name)] = true;
        if (gkAtk) pin[keyOf(gkAtk.side, gkAtk.name)] = true;
        separate(players, { minX: 6.8, minY: 12.2, rounds: 6, pinned: pin, freezeGK: true });
        return { taker: taker, gkDef: gkDef, gkAtk: gkAtk, attack: attack };
    }

    function shootoutBallEnd(play, info) {
        var low = String(play.text || '').toLowerCase();
        var result = play.result || 'miss';
        var y = 50;
        if (/primer palo|izquierda/.test(low)) y = 41;
        else if (/segundo palo|derecha/.test(low)) y = 59;
        else if (/[áa]ngulo|escuadra/.test(low)) y = /izquier|primer/.test(low) ? 38 : 62;
        else if (/panenka|picado/.test(low)) y = 50;
        if (result === 'goal') return { x: 98.6, y: clamp(y, 38, 62) };
        if (result === 'save') {
            var gy = info.gkDef ? info.gkDef.ty : 50;
            return { x: 96.4, y: clamp(gy + (y - 50) * 0.4, 36, 64) };
        }
        if (/larguero/.test(low)) return { x: 96.2, y: 36 };
        if (/poste/.test(low)) return { x: 97.2, y: y < 50 ? 34 : 66 };
        return { x: 99.2, y: y < 50 ? 18 : 82 };
    }

    function setupCounter(players, play, attack, ballT, opts) {
        opts = opts || {};
        var start = !!opts.start;
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var namedAtk = namedPlayers(players, play.players, attack);
        var carrier = namedAtk[namedAtk.length - 1] || namedAtk[0] || ofPos(ofSide(players, attack), 'FW')[0];
        var recoverX = attack === 'home' ? 36 : 64;
        var arriveX = attack === 'home'
            ? clamp(Math.max(ballT.x, 70), 64, 86)
            : clamp(Math.min(ballT.x, 30), 14, 36);
        var runY = clamp(ballT.y, 18, 82);

        ofSide(players, attack).forEach(function (p) {
            if (p.pos === 'GK') {
                placeAt(p, attack === 'home' ? 8 : 92, clamp(lerp(50, runY, 0.1), 38, 62));
                return;
            }
            if (start) {
                placeAt(p, clamp(lerp(p.baseX, recoverX, 0.38) + dir * 2, 6, 94), lerp(p.baseY, runY, 0.22));
            } else {
                var boost = { DF: 8, DM: 14, MF: 20, AM: 26, FW: 32 };
                placeAt(p, clamp(p.baseX + dir * (boost[p.pos] || 18), 8, 92), lerp(p.baseY, runY, 0.42));
            }
        });

        ofSide(players, defSide).forEach(function (p) {
            if (p.pos === 'GK') {
                placeAt(p, (attack === 'home' ? 96 : 4) - dir * (start ? 1.2 : 5), clamp(runY, 36, 64));
                return;
            }
            if (start) {
                // Línea alta: acababan de atacar y quedan pillados.
                var high = { FW: -4, AM: -8, MF: -12, DM: -14, DF: -18 };
                placeAt(p, clamp(p.baseX + dir * (high[p.pos] || -10), 8, 92), lerp(p.baseY, runY, 0.12));
            } else {
                // Recuperan de forma escalonada: delanteros aún lejos, algún central más cerca.
                var chase = { FW: 16, AM: 18, MF: 12, DM: 8, DF: 6 };
                placeAt(p, clamp(p.baseX + dir * (chase[p.pos] || 10), 8, 92), lerp(p.baseY, runY, 0.22));
            }
        });

        var individual = /contraataque individual|contra individual/.test(String((play && play.text) || '').toLowerCase());
        var cx = start ? recoverX : arriveX;
        if (carrier) placeAt(carrier, cx, runY);
        namedAtk.forEach(function (p, i) {
            if (p === carrier) return;
            var back = start ? (6 + i * 4) : ((individual ? 16 : 11) + i * 6);
            var lane = (i % 2 ? 1 : -1) * (12 + (i > 1 ? 6 : 0));
            placeAt(p, clamp(cx - dir * back, 8, 92), clamp(runY + lane, 10, 90));
        });
        // En un contra individual el resto del ataque no se mete en el área: queda en carrera, más atrás.
        if (!start && individual) {
            ofSide(players, attack).forEach(function (p) {
                if (p === carrier || p.pos === 'GK' || namedAtk.indexOf(p) !== -1) return;
                if ((p.pos === 'FW' || p.pos === 'AM') && ((attack === 'home' && p.tx > 70) || (attack === 'away' && p.tx < 30))) {
                    placeAt(p, clamp(p.tx - dir * 14, 10, 90), p.ty);
                }
            });
        }

        if (!start) {
            var covers = ofSide(players, defSide).filter(function (p) { return p.pos === 'DF' || p.pos === 'DM'; })
                .sort(function (a, b) { return Math.abs(a.baseY - runY) - Math.abs(b.baseY - runY); });
            if (covers[0]) placeAt(covers[0], clamp(arriveX + dir * 6, 10, 90), clamp(runY + (covers[0].baseY > runY ? 6 : -6), 14, 86));
            if (covers[1]) placeAt(covers[1], clamp(arriveX + dir * 2, 10, 90), clamp(runY + (runY < 50 ? 16 : -16), 12, 88));
        }
        return { carrier: carrier, chain: namedAtk, recoverX: recoverX, arriveX: arriveX, runY: runY };
    }

    function setupClearance(players, play, attack, ballT, opts) {
        opts = opts || {};
        var text = String((play && play.text) || '').toLowerCase();
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var punch = /puñetaz|a puños|de puños/.test(text);
        var toCrowd = /a la grada|a la nada/.test(text);
        var namedDef = namedPlayers(players, play.players, defSide);
        var namedAll = namedPlayers(players, play.players);
        var gk = ofPos(ofSide(players, defSide), 'GK')[0];
        var clearer = (punch && gk) ? gk : (namedDef[0] || namedAll[0] || ofPos(ofSide(players, defSide), 'DF')[0]);
        var boxX = attack === 'home' ? 88 : 12;
        var clrX = clamp(ballT.x || boxX, attack === 'home' ? 76 : 4, attack === 'home' ? 96 : 24);
        var clrY = clamp(ballT.y, 16, 84);
        if (punch && gk) {
            clrX = attack === 'home' ? 94.5 : 5.5;
            clrY = clamp(ballT.y, 32, 68);
        }

        ofSide(players, attack).forEach(function (p, i) {
            if (p.pos === 'GK') {
                placeAt(p, attack === 'home' ? 10 : 90, 50);
                return;
            }
            var ax = boxX - dir * (p.pos === 'FW' ? 2 : p.pos === 'AM' || p.pos === 'MF' ? 8 : 16);
            var ay = clamp(lerp(p.baseY, clrY, 0.45) + ((i % 4) - 1.5) * 5, 12, 88);
            placeAt(p, clamp(ax, 8, 92), ay);
        });
        ofSide(players, defSide).forEach(function (p, i) {
            if (p.pos === 'GK') {
                if (p !== clearer) placeAt(p, attack === 'home' ? 96 : 4, clamp(clrY, 36, 64));
                return;
            }
            var dx = boxX - dir * (p.pos === 'DF' ? 3 : 9);
            placeAt(p, clamp(dx, 6, 94), clamp(lerp(p.baseY, clrY, 0.4) + ((i % 3) - 1) * 6, 12, 88));
        });
        if (clearer) placeAt(clearer, clrX, clrY);

        var landing;
        if (toCrowd) {
            landing = { x: clamp(clrX - dir * 10, 8, 92), y: clrY < 50 ? 2 : 98 };
        } else {
            landing = {
                x: clamp(clrX - dir * (opts.flight ? 42 : 30), 16, 84),
                y: clamp((opts.flight ? (100 - clrY) : lerp(clrY, 100 - clrY, 0.55)), 12, 88)
            };
        }
        if (opts.flight) {
            ofPos(ofSide(players, attack), 'MF').concat(ofPos(ofSide(players, defSide), 'MF')).forEach(function (p, i) {
                placeAt(p, lerp(p.tx, landing.x, 0.28), lerp(p.ty, landing.y, 0.28 + (i % 3) * 0.05));
            });
        }
        return { clearer: clearer, landing: landing, punch: punch };
    }

    function setupThrowIn(players, play, attack, ballT) {
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var yLine = ballT.y < 50 ? 3.2 : 96.8;
        var inward = ballT.y < 50 ? 1 : -1;
        var x = clamp(ballT.x, 12, 88);
        var namedAtk = namedPlayers(players, play.players, attack);
        var namedAll = namedPlayers(players, play.players);
        var thrower = namedAtk[0] || namedAll[0] || ofPos(ofSide(players, attack), 'DF')[0];
        var receiver = null;
        namedAtk.forEach(function (p) { if (p !== thrower && !receiver) receiver = p; });
        if (!receiver && namedAll[1] && namedAll[1] !== thrower) receiver = namedAll[1];

        // Bloque medio corrido hacia la banda, sin apretarse en la línea.
        players.forEach(function (p) {
            if (p.pos === 'GK') {
                placeAt(p, p.side === 'home' ? 8 : 92, clamp(lerp(50, yLine, 0.08), 36, 64));
                return;
            }
            placeAt(p, clamp(lerp(p.baseX, x, 0.22) + (p.side === attack ? dir * 3 : -dir * 1), 8, 92),
                clamp(lerp(p.baseY, yLine + inward * 22, 0.35), 10, 90));
        });
        if (thrower) placeAt(thrower, x, yLine);
        var recvX = clamp(x + dir * 4, 10, 90);
        var recvY = yLine + inward * 8.5;
        if (receiver) placeAt(receiver, recvX, recvY);
        // Opción corta detrás y una más larga hacia delante.
        var mates = ofSide(players, attack).filter(function (p) { return p !== thrower && p !== receiver && p.pos !== 'GK'; });
        if (mates[0]) placeAt(mates[0], clamp(x - dir * 7, 10, 90), yLine + inward * 7);
        if (mates[1]) placeAt(mates[1], clamp(x + dir * 14, 10, 90), yLine + inward * 11);
        if (mates[2]) placeAt(mates[2], clamp(x + dir * 8, 10, 90), yLine + inward * 22);
        // Marcas rivales sobre los que esperan el saque.
        var marks = ofSide(players, defSide).filter(function (p) { return p.pos !== 'GK'; })
            .sort(function (a, b) { return Math.abs(a.baseY - yLine) - Math.abs(b.baseY - yLine); });
        var targets = [receiver, mates[0], mates[1]].filter(Boolean);
        targets.forEach(function (t, i) {
            if (marks[i]) placeAt(marks[i], t.tx + dir * 2.2, t.ty + inward * 3.2);
        });
        var pin = {};
        if (thrower) pin[keyOf(thrower.side, thrower.name)] = true;
        return {
            thrower: thrower,
            receiver: receiver,
            start: { x: x, y: yLine },
            end: receiver ? { x: receiver.tx, y: receiver.ty } : { x: recvX, y: recvY },
            pin: pin
        };
    }

    function setupKickoff(players) {
        players.forEach(function (p) {
            placeAt(p, p.baseX, p.baseY);
        });
    }

    function snapshotTargets(players) {
        var map = {};
        players.forEach(function (p) {
            map[keyOf(p.side, p.name)] = { x: p.tx, y: p.ty };
        });
        return map;
    }

    function copyPlayer(p) {
        return p ? { name: p.name, position: p.position } : p;
    }

    function effectiveLineups(d, play) {
        var home = (d.homeStarters || []).map(copyPlayer);
        var away = (d.awayStarters || []).map(copyPlayer);
        if (!play || (play.kind !== 'shootout' && play.kind !== 'shootout-kick')) {
            return { home: home, away: away };
        }
        function hasName(arr, name) {
            return arr.some(function (p) { return p && p.name === name; });
        }
        function recOf(name) { return findSubRecord(d, name) || { name: name, position: 'FW' }; }
        function sideOf(name) {
            if (d.sideOfPlayer) return d.sideOfPlayer(name);
            if (hasName(d.homeStarters || [], name) || hasName(d.homeSubs || [], name)) return 'home';
            if (hasName(d.awayStarters || [], name) || hasName(d.awaySubs || [], name)) return 'away';
            return null;
        }
        (play.players || []).forEach(function (name) {
            if (hasName(home, name) || hasName(away, name)) return;
            var side = sideOf(name);
            if (!side) return;
            var arr = side === 'home' ? home : away;
            var rec = recOf(name);
            var vi = -1, i;
            for (i = arr.length - 1; i >= 0; i--) {
                if (normalizePos(arr[i].position) === 'GK') continue;
                if ((play.players || []).indexOf(arr[i].name) !== -1) continue;
                vi = i; break;
            }
            if (vi >= 0) arr[vi] = { name: rec.name, position: rec.position || arr[vi].position };
            else arr.push({ name: rec.name, position: rec.position || 'FW' });
        });
        return { home: home, away: away };
    }

    function resolvePlay(play, d) {
        var lineups = effectiveLineups(d, play);
        var layouts = layoutTeam(lineups.home, 'home').concat(layoutTeam(lineups.away, 'away'));
        var players = layouts.map(function (p) {
            return {
                name: p.name,
                side: p.side,
                pos: p.pos,
                baseX: p.x,
                baseY: p.y,
                tx: p.x,
                ty: p.y
            };
        });
        if (!play) {
            setupKickoff(players);
            var kickPhases = [{ players: snapshotTargets(players), ballPath: [{ x: 50, y: 50 }], ms: 500, highlight: [], ref: { x: 53, y: 62 } }];
            return { phases: kickPhases };
        }
        var attack = sideOfTeam(play.team, d) || 'home';
        var ballT = play.target || { x: 50, y: 50 };
        var text = play.text || '';
        var kind = play.kind;
        var phases = [];
        var info;
        var highlight = play.players || [];
        var oneOnOne = isOneOnOneText(text);
        var alsoCounter = isCounterText(text);

        if (kind !== 'shootout' && kind !== 'shootout-kick' && kind !== 'throwin' && kind !== 'counter' && kind !== 'clearance') {
            applyBlock(players, ballT, attack, kind);
        }

        if (kind === 'shootout' || kind === 'shootout-kick') {
            info = setupShootout(players, play, d);
            var spot = { x: 89.5, y: 50 };
            phases.push({
                players: snapshotTargets(players),
                ballPath: [spot],
                ms: kind === 'shootout' ? 700 : 650,
                highlight: highlight,
                pose: kind === 'shootout'
            });
            if (kind === 'shootout-kick') {
                var end = shootoutBallEnd(play, info);
                var mid = { x: lerp(spot.x, end.x, 0.55), y: lerp(spot.y, end.y, 0.55) };
                phases.push({
                    players: snapshotTargets(players),
                    ballPath: [spot, mid, end],
                    ms: 700,
                    highlight: highlight,
                    pose: true
                });
                if (play.result === 'miss' && /poste|larguero/.test(String(play.text || '').toLowerCase())) {
                    phases[phases.length - 1].pose = false;
                    phases.push({
                        players: snapshotTargets(players),
                        ballPath: [end, { x: end.x - 6, y: clamp(end.y + (end.y < 50 ? -10 : 10), 8, 92) }],
                        ms: 380,
                        highlight: highlight,
                        pose: true
                    });
                }
            }
        } else if (kind === 'counter') {
            info = setupCounter(players, play, attack, ballT, { start: true });
            separate(players);
            var cStart = info.carrier ? { x: info.carrier.tx, y: info.carrier.ty } : { x: info.recoverX, y: info.runY };
            phases.push({ players: snapshotTargets(players), ballPath: [cStart], ms: 620, highlight: highlight });
            info = setupCounter(players, play, attack, ballT, { start: false });
            separate(players);
            var cpath = [cStart];
            (info.chain || []).forEach(function (p) { if (p !== info.carrier) cpath.push({ x: p.tx, y: p.ty }); });
            if (info.carrier) cpath.push({ x: info.carrier.tx, y: info.carrier.ty });
            if (cpath.length < 2) cpath.push({ x: info.arriveX, y: info.runY });
            phases.push({ players: snapshotTargets(players), ballPath: cpath, ms: 900, highlight: highlight });
        } else if (kind === 'clearance') {
            info = setupClearance(players, play, attack, ballT, { flight: false });
            separate(players, { pinned: info.clearer ? (function () { var o = {}; o[keyOf(info.clearer.side, info.clearer.name)] = true; return o; })() : {} });
            var clFrom = info.clearer ? { x: info.clearer.tx, y: info.clearer.ty } : ballT;
            phases.push({ players: snapshotTargets(players), ballPath: [clFrom], ms: 550, highlight: highlight });
            info = setupClearance(players, play, attack, ballT, { flight: true });
            separate(players);
            var midAir = { x: lerp(clFrom.x, info.landing.x, 0.5), y: lerp(clFrom.y, info.landing.y, 0.5) - 8 };
            phases.push({ players: snapshotTargets(players), ballPath: [clFrom, midAir, info.landing], ms: 820, highlight: highlight });
        } else if (kind === 'throwin') {
            info = setupThrowIn(players, play, attack, ballT);
            separate(players, { pinned: info.pin || {}, freezeGK: true });
            phases.push({ players: snapshotTargets(players), ballPath: [info.start], ms: 550, highlight: highlight });
            if (info.receiver) {
                // El receptor da un paso al recibir.
                placeAt(info.receiver, lerp(info.receiver.tx, 50, 0.04), lerp(info.receiver.ty, 50, 0.04));
            }
            phases.push({
                players: snapshotTargets(players),
                ballPath: [info.start, { x: lerp(info.start.x, info.end.x, 0.55), y: lerp(info.start.y, info.end.y, 0.55) }, info.end],
                ms: 700,
                highlight: highlight
            });
        } else if (kind === 'corner') {
            info = setupCorner(players, play, attack, ballT);
            separate(players);
            var cornerPath = [];
            if (info.taker) cornerPath.push({ x: info.taker.tx, y: info.taker.ty });
            cornerPath.push({ x: attack === 'home' ? 90 : 10, y: 50 });
            phases.push({ players: snapshotTargets(players), ballPath: cornerPath, ms: 850, highlight: highlight });
            if (/despej/.test(text.toLowerCase())) {
                var clInfo = setupClearance(players, play, attack, ballT, { flight: true });
                separate(players);
                var cFrom = cornerPath[cornerPath.length - 1];
                var cLand = clInfo.landing || { x: 50, y: 22 };
                phases.push({
                    players: snapshotTargets(players),
                    ballPath: [cFrom, { x: lerp(cFrom.x, cLand.x, 0.5), y: lerp(cFrom.y, cLand.y, 0.5) - 8 }, cLand],
                    ms: 800,
                    highlight: highlight
                });
            }
        } else if (kind === 'penalty') {
            info = setupPenalty(players, play, attack);
            separate(players);
            var penPath = [];
            if (info.taker) penPath.push({ x: info.taker.tx, y: info.taker.ty });
            penPath.push({ x: attack === 'home' ? 89.5 : 10.5, y: 50 });
            phases.push({ players: snapshotTargets(players), ballPath: penPath, ms: 700, highlight: highlight });
        } else if (kind === 'foul') {
            info = setupFoul(players, play, attack, ballT, text);
            separate(players);
            var foulPath = [ballT];
            if (info.taker) foulPath.unshift({ x: info.taker.tx, y: info.taker.ty });
            phases.push({ players: snapshotTargets(players), ballPath: foulPath, ms: 750, highlight: highlight });
        } else if (kind === 'goalkick') {
            info = setupGoalkick(players, play, attack);
            separate(players);
            var gkPath = [info.gk ? { x: info.gk.tx, y: info.gk.ty } : { x: attack === 'home' ? 8 : 92, y: 50 }];
            phases.push({ players: snapshotTargets(players), ballPath: gkPath, ms: 650, highlight: highlight });
        } else if (kind === 'wing') {
            info = setupWing(players, play, attack, ballT);
            separate(players);
            var wingPath = [ballT];
            if (info.carrier) wingPath.unshift({ x: info.carrier.tx, y: info.carrier.ty });
            phases.push({ players: snapshotTargets(players), ballPath: wingPath, ms: 750, highlight: highlight });
        } else if (kind === 'sub') {
            setupSub(players, play);
            separate(players);
            phases.push({ players: snapshotTargets(players), ballPath: [ball], ms: 700, highlight: highlight });
        } else if (kind === 'yellow' || kind === 'red' || kind === 'injury') {
            setupCardOrInjury(players, play, ballT);
            separate(players);
            phases.push({ players: snapshotTargets(players), ballPath: [ballT], ms: 650, highlight: highlight });
        } else if (kind === 'own-goal') {
            var unlucky = namedPlayers(players, play.players)[0];
            var ownDir = ballT.x < 50 ? 1 : -1;
            if (unlucky) placeAt(unlucky, ballT.x + ownDir * 7, clamp(ballT.y, 30, 70));
            var ownGk = ofPos(ofSide(players, ballT.x < 50 ? 'home' : 'away'), 'GK')[0];
            if (ownGk && ownGk !== unlucky) placeAt(ownGk, ballT.x < 50 ? 4 : 96, clamp(ballT.y, 36, 64));
            separate(players);
            var ogPath = [];
            if (unlucky) ogPath.push({ x: unlucky.tx, y: unlucky.ty });
            ogPath.push(ballT);
            phases.push({ players: snapshotTargets(players), ballPath: ogPath, ms: 700, highlight: highlight });
            setupCelebration(players, play, attack, ballT);
            phases.push({ players: snapshotTargets(players), ballPath: [ballT], ms: 1000, highlight: highlight, pose: true });
            setupKickoff(players);
            phases.push({ players: snapshotTargets(players), ballPath: [{ x: 50, y: 50 }], ms: 900, highlight: [], pose: false });
        } else if (kind === 'shot' || kind === 'save' || kind === 'box' || kind === 'goal' || kind === 'oneonone') {
            var asOne = oneOnOne || kind === 'oneonone';
            if (alsoCounter) {
                info = setupCounter(players, play, attack, ballT, { start: true });
                separate(players);
                var c0 = info.carrier ? { x: info.carrier.tx, y: info.carrier.ty } : { x: info.recoverX, y: info.runY };
                phases.push({ players: snapshotTargets(players), ballPath: [c0], ms: 580, highlight: highlight });
            } else if (asOne) {
                info = setupShotShape(players, play, attack, ballT, { oneOnOne: true, approach: true });
                separate(players);
                var ap = info.shooter ? { x: info.shooter.tx, y: info.shooter.ty } : (info.shot || ballT);
                phases.push({ players: snapshotTargets(players), ballPath: [ap], ms: 580, highlight: highlight });
            }
            info = setupShotShape(players, play, attack, ballT, { oneOnOne: asOne });
            separate(players);
            var path = [];
            (info.namedAtk || []).forEach(function (p) { path.push({ x: p.tx, y: p.ty }); });
            if (info.shot) path.push(info.shot);
            if (!path.length) path.push(ballT);
            phases.push({ players: snapshotTargets(players), ballPath: path.slice(), ms: alsoCounter || asOne ? 900 : 800, highlight: highlight });
            if (kind === 'save' && info.gk) {
                phases.push({
                    players: snapshotTargets(players),
                    ballPath: [info.shot || ballT, { x: info.gk.tx, y: info.gk.ty }],
                    ms: 450,
                    highlight: highlight
                });
            }
            if (kind === 'goal') {
                var net = { x: ballT.x, y: ballT.y };
                phases.push({
                    players: snapshotTargets(players),
                    ballPath: [info.shot || path[path.length - 1], net],
                    ms: 420,
                    highlight: highlight
                });
                setupCelebration(players, play, attack, ballT);
                phases.push({
                    players: snapshotTargets(players),
                    ballPath: [net],
                    ms: 1000,
                    highlight: highlight,
                    pose: true
                });
                setupKickoff(players);
                phases.push({
                    players: snapshotTargets(players),
                    ballPath: [{ x: 50, y: 50 }],
                    ms: 900,
                    highlight: [],
                    pose: false
                });
            }
        } else {
            info = setupPassShape(players, play, attack, ballT);
            separate(players);
            var passPath = [];
            (info.chain || []).forEach(function (p) { passPath.push({ x: p.tx, y: p.ty }); });
            if (info.carrier) passPath.push({ x: info.carrier.tx, y: info.carrier.ty });
            if (!passPath.length) passPath.push(ballT);
            phases.push({ players: snapshotTargets(players), ballPath: passPath, ms: 800, highlight: highlight });
        }
        attachReferee(phases, play, kind, ballT);
        return { phases: phases, highlight: highlight };
    }

    function refereeSpot(kind, ballPt, typ) {
        var bx = (ballPt && ballPt.x != null) ? ballPt.x : 50;
        var by = (ballPt && ballPt.y != null) ? ballPt.y : 50;
        var spot;
        if (!kind || typ === 'kickoff') spot = { x: 53, y: 62 };
        else if (kind === 'shootout' || kind === 'shootout-kick') spot = { x: 83.5, y: 64 };
        else if (kind === 'corner') spot = { x: bx < 50 ? 18 : 82, y: by < 50 ? 28 : 72 };
        else if (kind === 'penalty') spot = { x: bx < 50 ? 18.5 : 81.5, y: 64 };
        else if (kind === 'foul') spot = { x: clamp(bx - 3.5, 10, 90), y: clamp(by + 9, 12, 88) };
        else if (kind === 'goalkick') spot = { x: bx < 50 ? 30 : 70, y: 60 };
        else if (kind === 'throwin') spot = { x: clamp(bx - 5, 12, 88), y: by < 50 ? 16 : 84 };
        else if (kind === 'clearance') spot = { x: clamp(bx - (bx >= 50 ? 8 : -8), 12, 88), y: clamp(by + (by >= 50 ? -9 : 9), 14, 86) };
        else if (kind === 'counter') {
            var behindC = bx >= 50 ? -9 : 9;
            var sideC = by >= 50 ? -10 : 10;
            spot = { x: clamp(bx + behindC, 12, 88), y: clamp(by + sideC, 14, 86) };
        }
        else if (kind === 'sub' || kind === 'yellow' || kind === 'red' || kind === 'injury') {
            spot = { x: clamp(bx + 6, 10, 90), y: clamp(by + 7, 12, 88) };
        } else if (typ === 'celebrate' || kind === 'goal' || kind === 'own-goal') {
            if (typ === 'celebrate') spot = { x: 50, y: by < 50 ? 62 : 38 };
            else spot = { x: clamp(bx - 10, 12, 88), y: clamp(by + 10, 14, 86) };
        } else {
            var behind = bx >= 50 ? -8 : 8;
            var side = by >= 50 ? -9 : 9;
            spot = { x: clamp(bx + behind, 12, 88), y: clamp(by + side, 14, 86) };
        }
        if (Math.hypot(spot.x - bx, (spot.y - by) * 0.7) < 6) {
            spot.y = clamp(spot.y + (by >= 50 ? -8 : 8), 12, 88);
        }
        return spot;
    }

    function attachReferee(phases, play, kind, ballT) {
        (phases || []).forEach(function (ph) {
            var pt = (ph.ballPath && ph.ballPath.length) ? ph.ballPath[ph.ballPath.length - 1] : (ballT || { x: 50, y: 50 });
            var typ = ph.pose === false ? 'kickoff' : (ph.pose ? 'celebrate' : '');
            ph.ref = refereeSpot(play ? kind : null, pt, typ);
        });
    }

    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function posOnPath(path, t) {
        if (!path || !path.length) return { x: ball.x, y: ball.y };
        if (path.length === 1 || t <= 0) return { x: path[0].x, y: path[0].y };
        if (t >= 1) return { x: path[path.length - 1].x, y: path[path.length - 1].y };
        var i, d, lens = [], total = 0;
        for (i = 1; i < path.length; i++) {
            d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
            lens.push(Math.max(d, 0.05));
            total += Math.max(d, 0.05);
        }
        var dist = t * total;
        for (i = 0; i < lens.length; i++) {
            if (dist <= lens[i] + 0.0001) {
                var u = dist / lens[i];
                return { x: lerp(path[i].x, path[i + 1].x, u), y: lerp(path[i].y, path[i + 1].y, u) };
            }
            dist -= lens[i];
        }
        return { x: path[path.length - 1].x, y: path[path.length - 1].y };
    }

    function placeBall() {
        if (!ballEl) return;
        var p = toSvg(ball.x, ball.y);
        var bk = 1 + (nodeScale - 1) * 0.8;
        ballEl.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')' + (bk !== 1 ? ' scale(' + bk.toFixed(3) + ')' : ''));
    }

    function placeRefEl() {
        if (!refState || !refState.el) return;
        var p = toSvg(refState.x, refState.y);
        refState.el.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')' + (nodeScale !== 1 ? ' scale(' + nodeScale.toFixed(3) + ')' : ''));
    }

    function buildRefNode(name) {
        var short = shortName(name) || 'Árbitro';
        var g = svgEl('g', { 'class': 'campo-ref', 'data-name': name, filter: 'url(#campo-shadow)' });
        g.appendChild(svgEl('circle', {
            r: 18, fill: '#111111', stroke: '#f3f3f3', 'stroke-width': 2.4, 'class': 'campo-disk'
        }));
        var tMark = svgEl('text', {
            x: 0, y: 5, 'text-anchor': 'middle', fill: '#ffffff',
            'font-size': '10', 'font-weight': '700', 'font-family': 'Segoe UI, sans-serif',
            'pointer-events': 'none', 'class': 'campo-dorsal'
        });
        tMark.textContent = 'ARB';
        g.appendChild(tMark);
        var tName = svgEl('text', {
            x: 0, y: 31, 'text-anchor': 'middle', fill: '#fff',
            stroke: 'rgba(0,0,0,0.8)', 'stroke-width': 3, 'paint-order': 'stroke',
            'font-size': '11', 'font-weight': '700', 'font-family': 'Segoe UI, sans-serif',
            'pointer-events': 'none', 'class': 'campo-name'
        });
        tName.setAttribute('data-full', short);
        tName.setAttribute('data-ref', '1');
        tName.setAttribute('data-short', shortName(name, null, true) || short);
        tName.textContent = isCompactView() ? (tName.getAttribute('data-short') || short) : short;
        g.appendChild(tName);
        return g;
    }

    function ensureRef(d) {
        var name = (d && d.refereeName) ? d.refereeName : 'Árbitro';
        if (!playersLayer) return;
        if (!refState.el || refState.name !== name) {
            if (refState.el && refState.el.parentNode) refState.el.parentNode.removeChild(refState.el);
            refState.name = name;
            refState.el = buildRefNode(name);
            playersLayer.appendChild(refState.el);
        }
        placeRefEl();
    }

    function placePlayerEl(st) {
        if (!st || !st.el) return;
        var p = toSvg(st.x, st.y);
        st.el.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')' + (nodeScale !== 1 ? ' scale(' + nodeScale.toFixed(3) + ')' : ''));
    }

    function applyPlayerTargets(targets, t) {
        Object.keys(playerState).forEach(function (k) {
            var st = playerState[k];
            var from = anim.fromPlayers[k] || { x: st.x, y: st.y };
            var to = (targets && targets[k]) || { x: st.x, y: st.y };
            st.x = lerp(from.x, to.x, t);
            st.y = lerp(from.y, to.y, t);
            placePlayerEl(st);
        });
    }

    function startPhase(phase, immediate) {
        if (!phase) return;
        var from = {};
        Object.keys(playerState).forEach(function (k) {
            from[k] = { x: playerState[k].x, y: playerState[k].y };
        });
        anim.fromPlayers = from;
        anim.toPlayers = phase.players || {};
        anim.fromRef = { x: refState.x, y: refState.y };
        anim.toRef = phase.ref || { x: refState.x, y: refState.y };
        var path = (phase.ballPath && phase.ballPath.length) ? phase.ballPath.slice() : [{ x: ball.x, y: ball.y }];
        if (!immediate) path.unshift({ x: ball.x, y: ball.y });
        anim.ballPath = path;
        anim.ms = immediate ? 1 : Math.max(180, phase.ms || 700);
        anim.start = performance.now();
        anim.running = true;
        if (phase.highlight) highlightPlayers(phase.highlight);
        if (immediate) {
            finishPhase();
            return;
        }
        if (anim.raf) cancelAnimationFrame(anim.raf);
        anim.raf = requestAnimationFrame(tickAnim);
    }

    function finishPhase() {
        applyPlayerTargets(anim.toPlayers, 1);
        if (anim.toRef) {
            refState.x = anim.toRef.x;
            refState.y = anim.toRef.y;
            placeRefEl();
        }
        if (anim.ballPath.length) {
            var end = anim.ballPath[anim.ballPath.length - 1];
            ball = { x: end.x, y: end.y };
            placeBall();
        }
        if (anim.queue.length) {
            startPhase(anim.queue.shift(), false);
        } else {
            anim.running = false;
        }
    }

    function tickAnim(now) {
        var t = (now - anim.start) / anim.ms;
        if (t >= 1) {
            finishPhase();
            return;
        }
        var e = easeInOutCubic(t);
        applyPlayerTargets(anim.toPlayers, e);
        if (anim.toRef) {
            var fr = anim.fromRef || { x: refState.x, y: refState.y };
            refState.x = lerp(fr.x, anim.toRef.x, e);
            refState.y = lerp(fr.y, anim.toRef.y, e);
            placeRefEl();
        }
        var bp = posOnPath(anim.ballPath, e);
        ball = { x: bp.x, y: bp.y };
        placeBall();
        anim.raf = requestAnimationFrame(tickAnim);
    }

    function playResolved(play, d, immediate) {
        var resolved = resolvePlay(play, d);
        var phases = resolved.phases || [];
        if (!phases.length) return;
        if (anim.raf) cancelAnimationFrame(anim.raf);
        anim.queue = [];
        if (immediate) {
            // Saltar a la pose característica (celebración, no la vuelta al centro).
            var pose = null;
            for (var pi = phases.length - 1; pi >= 0; pi--) {
                if (phases[pi].pose !== false) { pose = phases[pi]; break; }
            }
            startPhase(pose || phases[phases.length - 1], true);
            return;
        }
        var first = phases.shift();
        anim.queue = phases;
        startPhase(first, false);
    }

    /* ---------------- UI ---------------- */

    function ensureUI() {
        root = $('campo-root');
        if (!root) return false;
        if (built) return true;
        root.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'campo-wrap';
        wrap.innerHTML =
            '<div class="campo-header">' +
                '<div class="campo-team home"><span class="campo-swatch" id="campo-home-swatch"></span><span id="campo-home-name">Local</span></div>' +
                '<div class="campo-score-block">' +
                    '<div class="campo-score" id="campo-score">0 - 0</div>' +
                    '<div class="campo-pens" id="campo-pens" hidden></div>' +
                '</div>' +
                '<div class="campo-team away"><span id="campo-away-name">Visitante</span><span class="campo-swatch" id="campo-away-swatch"></span></div>' +
            '</div>' +
            '<div class="campo-pitch-box" id="campo-pitch-box"></div>' +
            '<div class="campo-caption" id="campo-caption">Pega un informe y pulsa «Comenzar partido» para ver el movimiento.</div>' +
            '<div class="campo-controls">' +
                '<button type="button" id="campo-play">Comenzar</button>' +
                '<span class="campo-min" id="campo-min">Minuto 0</span>' +
                '<button type="button" id="campo-fs" class="campo-fs-btn" title="Ver el campo a pantalla completa (en el móvil, gíralo en horizontal)">Ampliar</button>' +
                '<input type="range" class="campo-slider" id="campo-slider" min="0" max="90" value="0" step="1" aria-label="Jugada">' +
            '</div>' +
            '<p class="campo-note">Los movimientos son aproximados: el informe no trae coordenadas. Los jugadores se desplazan en bloque hacia la jugada y el balón sigue a quienes nombra la narración.</p>';
        root.appendChild(wrap);
        drawPitch();
        $('campo-pitch-box').appendChild(svg);
        ui.play = $('campo-play');
        ui.min = $('campo-min');
        ui.slider = $('campo-slider');
        ui.caption = $('campo-caption');
        ui.score = $('campo-score');
        ui.homeName = $('campo-home-name');
        ui.awayName = $('campo-away-name');
        ui.homeSwatch = $('campo-home-swatch');
        ui.awaySwatch = $('campo-away-swatch');

        ui.fs = $('campo-fs');
        ui.play.addEventListener('click', onPlayClick);
        ui.fs.addEventListener('click', toggleExpanded);
        document.addEventListener('fullscreenchange', function () {
            if (!document.fullscreenElement && wrap.classList.contains('campo-expanded')) setExpanded(false, true);
        });
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && wrap.classList.contains('campo-expanded')) setExpanded(false);
        });
        ui.slider.addEventListener('input', onSliderInput);
        ui.slider.addEventListener('change', onSliderChange);
        if (!window.__campoResizeBound) {
            window.__campoResizeBound = true;
            window.addEventListener('resize', function () { applyCompactNames(); });
        }
        applyCompactNames();
        built = true;
        return true;
    }

    // Modo ampliado: el campo ocupa toda la pantalla (con la API de pantalla completa si existe;
    // si no, con una capa fija). En los móviles intenta girar a horizontal.
    function setExpanded(on, fromEvent) {
        var wrap = root && root.querySelector('.campo-wrap');
        if (!wrap) return;
        wrap.classList.toggle('campo-expanded', on);
        document.documentElement.classList.toggle('campo-noscroll', on);
        if (ui.fs) ui.fs.textContent = on ? 'Cerrar' : 'Ampliar';
        if (!fromEvent) {
            try {
                if (on && wrap.requestFullscreen && !document.fullscreenElement) {
                    var pr = wrap.requestFullscreen();
                    if (pr && pr.then) {
                        pr.then(function () {
                            if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
                        }).catch(function () {});
                    }
                } else if (!on && document.fullscreenElement && document.exitFullscreen) {
                    document.exitFullscreen().catch(function () {});
                }
            } catch (e) { /* capa fija como respaldo */ }
        }
        setTimeout(applyCompactNames, 60);
        setTimeout(applyCompactNames, 400);
    }

    function toggleExpanded() {
        var wrap = root && root.querySelector('.campo-wrap');
        setExpanded(!(wrap && wrap.classList.contains('campo-expanded')));
    }

    function onPlayClick() {
        var d = data();
        if (!d) return;
        if (!d.started || (!d.paused && d.finished) || (d.finished && !d.started)) {
            if (d.finished && typeof window.resetSimulation === 'function') window.resetSimulation();
            if (typeof window.startSimulation === 'function') window.startSimulation();
            return;
        }
        if (typeof window.togglePause === 'function') window.togglePause();
        refresh();
    }

    function regularScoreAt(plays, idx, d) {
        var h = 0, a = 0, i, p;
        for (i = 0; i <= idx && i < plays.length; i++) {
            p = plays[i];
            if (!p) continue;
            if (p.kind === 'goal' || p.kind === 'own-goal') {
                if (p.team === d.homeTeam) h++;
                else if (p.team === d.awayTeam) a++;
            }
        }
        return { h: h, a: a };
    }

    function shootoutScoreAt(plays, idx, d) {
        var h = 0, a = 0, found = false, last = null, i, p;
        for (i = 0; i <= idx && i < plays.length; i++) {
            p = plays[i];
            if (!p || (p.kind !== 'shootout-kick' && p.kind !== 'shootout')) continue;
            if (p.kind === 'shootout') { found = true; continue; }
            found = true;
            if (p.result === 'goal') {
                if (p.team === d.homeTeam) h++;
                else if (p.team === d.awayTeam) a++;
            }
            if (p.shootoutScore) last = p.shootoutScore;
        }
        if (!found) return null;
        if (last && /^\d+-\d+$/.test(last)) {
            var parts = last.split('-');
            return { h: parseInt(parts[0], 10), a: parseInt(parts[1], 10), raw: last };
        }
        return { h: h, a: a };
    }

    function previewScore(plays, idx, d) {
        var reg = regularScoreAt(plays, idx, d);
        var pens = shootoutScoreAt(plays, idx, d);
        var text = reg.h + ' - ' + reg.a;
        if (pens) text += ' (pen ' + pens.h + '-' + pens.a + ')';
        return text;
    }

    function playMinuteLabel(play) {
        if (!play) return 'Minuto 0';
        if (play.kind === 'shootout') return 'Tanda de penaltis';
        if (play.kind === 'shootout-kick') return 'Tanda · lanzamiento ' + (play.shootoutIndex + 1);
        return 'Minuto ' + play.minute;
    }

    function applyPlayPreview(play, d, immediate) {
        if (!play) return;
        setCaption(play, d);
        var label = playMinuteLabel(play);
        if (ui.min) ui.min.textContent = label;
        if (ui.score) ui.score.textContent = previewScore(buildPlays(d), play.i, d);
        updatePensBoard(buildPlays(d), play.i, d);
        var narrEl = $('narration');
        var minEl = $('minute');
        if (narrEl) narrEl.textContent = summarize(play.text);
        if (minEl) minEl.textContent = label;
        renderPlayers(d, play);
        playResolved(play, d, immediate);
    }

    function onSliderInput() {
        dragging = true;
        var d = data();
        if (!d) return;
        if (d.started && !d.paused && !d.finished && typeof window.togglePause === 'function' && !sliderPausedByUs) {
            window.togglePause();
            sliderPausedByUs = true;
        }
        var plays = buildPlays(d);
        var idx = parseInt(ui.slider.value, 10) || 0;
        var play = plays[idx];
        if (play) applyPlayPreview(play, d, true);
    }

    function onSliderChange() {
        var d = data();
        var plays = buildPlays(d || {});
        var idx = parseInt(ui.slider.value, 10) || 0;
        var play = plays[idx];
        sliderPausedByUs = false;
        dragging = false;
        if (!play) return;
        lastPlayIndex = play.i;
        if (typeof window.seekSimulationTo !== 'function') return;
        if (play.kind === 'shootout' || play.kind === 'shootout-kick') {
            window.seekSimulationTo('tanda', null, play.endLine);
        } else {
            window.seekSimulationTo(play.minute, play.i);
        }
    }

    function updatePensBoard(plays, idx, d) {
        var el = $('campo-pens');
        if (!el) return;
        var pens = shootoutScoreAt(plays || [], idx, d || {});
        if (!pens) {
            el.hidden = true;
            el.innerHTML = '';
            return;
        }
        var marks = { home: '', away: '' };
        (plays || []).forEach(function (p) {
            if (!p || p.kind !== 'shootout-kick' || p.i > idx) return;
            var side = sideOfTeam(p.team, d);
            if (!side) return;
            marks[side] += p.result === 'goal' ? '● ' : '✕ ';
        });
        el.hidden = false;
        el.innerHTML = '<span>' + escapeHtml((d.homeTeam || 'Local').split(' ')[0]) + ' ' + marks.home.trim() + '</span>' +
            '<span>' + escapeHtml((d.awayTeam || 'Visitante').split(' ')[0]) + ' ' + marks.away.trim() + '</span>';
    }

    function setCaption(play, d) {
        if (!ui.caption) return;
        if (!play) {
            var fallback = (d && d.started && d.narration && d.narration.trim())
                ? escapeHtml(d.narration.trim())
                : 'Saque inicial. Pulsa «Comenzar» o mueve el deslizador para ver una jugada.';
            ui.caption.innerHTML = fallback;
            return;
        }
        var kind = play.kind || 'play';
        var label = KIND_LABEL[kind] || 'Jugada';
        var live = d && d.started && !dragging && d.narration && d.narration.trim();
        var text = live ? d.narration.trim() : summarize(play.text);
        ui.caption.innerHTML = '<span class="campo-kind ' + kind + '">' + escapeHtml(label) + '</span> ' + escapeHtml(text);
        lastKind = kind;
    }

    function summarize(text) {
        var lines = String(text || '').split(/\n/).map(function (l) {
            return l.replace(/^\s*Minuto de juego\s+\S+\s*:/, '').replace(/^\s*\.\.\.\s*/, '').trim();
        }).filter(function (l) { return l && !isPenaltyRowLine(l); });
        if (!lines.length) return '';
        var isSO = /^\([A-Za-z0-9]{2,5}\)/.test(lines[0]) || /^PENALTI\b/i.test(lines[0]) || /tanda de penaltis/i.test(String(text || ''));
        if (isSO) {
            var result = lines.filter(function (l) {
                return /¡+gol|go{3,}l|bloca|detiene|fuera|poste|larguero|parada/i.test(l);
            });
            var last = result.length ? result[result.length - 1] : lines[lines.length - 1];
            return (lines[0] && lines[0] !== last) ? (lines[0] + ' — ' + last) : last;
        }
        return lines.slice(-2).join(' — ').trim();
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function renderPlayers(d, play) {
        if (!playersLayer) return;
        ensureRosterNumbers(d);
        var lineups = effectiveLineups(d, play);
        var layouts = layoutTeam(lineups.home, 'home').concat(layoutTeam(lineups.away, 'away'));
        var colorSig = (d.homeColors && d.homeColors.primary) + '/' + (d.awayColors && d.awayColors.primary);
        var sig = layouts.map(function (p) { return p.side + ':' + p.name + ':' + p.pos; }).join('|') + '@@' + colorSig;
        var rebuild = sig !== lastSignature || !playersLayer.childNodes.length;
        lastSignature = sig;

        var live = {};
        layouts.forEach(function (p) {
            var k = keyOf(p.side, p.name);
            live[k] = true;
            var st = playerState[k];
            if (!st) {
                st = { name: p.name, side: p.side, pos: p.pos, baseX: p.x, baseY: p.y, x: p.x, y: p.y, el: null };
                playerState[k] = st;
            } else {
                st.pos = p.pos;
                st.baseX = p.x;
                st.baseY = p.y;
            }
            if (rebuild || !st.el) {
                if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el);
                st.el = buildPlayerNode(p, d, st);
                playersLayer.appendChild(st.el);
            }
            placePlayerEl(st);
        });
        Object.keys(playerState).forEach(function (k) {
            if (!live[k]) {
                if (playerState[k].el && playerState[k].el.parentNode) playerState[k].el.parentNode.removeChild(playerState[k].el);
                delete playerState[k];
            }
        });
        if (rebuild) {
            Array.prototype.forEach.call(playersLayer.querySelectorAll('.campo-player'), function (g) {
                var k = g.getAttribute('data-side') + ':' + g.getAttribute('data-name');
                if (!live[k]) playersLayer.removeChild(g);
            });
        }
        ensureRef(d);
        applyCompactNames();
    }

    function hexRgb(hex) {
        var c = String(hex || '').replace('#', '');
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        if (c.length < 6) return null;
        var r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
        if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
        return { r: r, g: g, b: b };
    }

    function colorDist(a, b) {
        var A = hexRgb(a), B = hexRgb(b);
        if (!A || !B) return 999;
        return Math.hypot(A.r - B.r, A.g - B.g, A.b - B.b);
    }

    // Luminancia relativa y contraste WCAG para decidir borde, contorno y color del dorsal.
    function relLum(hex) {
        var c = hexRgb(hex);
        if (!c) return 0.2;
        function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    }

    function contrastRatio(a, b) {
        var la = relLum(a), lb = relLum(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    // Estilo legible de un círculo de jugador a partir de los colores del club:
    // - borde: el color secundario, salvo que casi no se distinga del primario;
    // - contorno exterior fino: oscuro en equipaciones claras (blanco, amarillo, celeste),
    //   claro en las oscuras que se confunden con el césped (negro, verde, granate);
    // - dorsal: blanco o casi negro, el que más contraste tenga, con un halo suave.
    function kitStyle(colors) {
        var fill = (colors && colors.primary) || '#333333';
        var ring = (colors && colors.secondary) || '#ffffff';
        if (!hexRgb(fill)) fill = '#333333';
        if (!hexRgb(ring)) ring = '#ffffff';
        if (contrastRatio(fill, ring) < 1.35) {
            ring = contrastRatio(fill, '#111111') > contrastRatio(fill, '#ffffff') ? '#111111' : '#ffffff';
        }
        var light = relLum(fill) > 0.42 || relLum(ring) > 0.6;
        var outline = null;
        if (light) outline = 'rgba(0,0,0,0.78)';
        else if (contrastRatio(fill, PITCH_GREEN) < 2.2 && contrastRatio(ring, PITCH_GREEN) < 2.2) outline = 'rgba(255,255,255,0.9)';
        var ink = contrastRatio(fill, '#ffffff') >= contrastRatio(fill, '#111111') ? '#ffffff' : '#111111';
        var halo = ink === '#ffffff' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
        return { fill: fill, ring: ring, outline: outline, ink: ink, halo: halo };
    }

    // Camiseta del portero: distinta de la de su equipo, de la del rival y de la del otro portero.
    // Se elige el color cuyo parecido más cercano (a cualquiera de esos colores) sea el menor.
    var GK_OPTIONS = {
        home: [{ primary: '#f59e0b', secondary: '#1a1a1a' }, { primary: '#22c55e', secondary: '#052e16' }, { primary: '#e11d48', secondary: '#ffffff' }, { primary: '#a855f7', secondary: '#ffffff' }, { primary: '#9ca3af', secondary: '#111111' }],
        away: [{ primary: '#22d3ee', secondary: '#083344' }, { primary: '#a855f7', secondary: '#ffffff' }, { primary: '#f97316', secondary: '#1a1a1a' }, { primary: '#84cc16', secondary: '#1a2e05' }, { primary: '#9ca3af', secondary: '#111111' }]
    };

    function pickGk(options, avoid) {
        var i, j, best = options[0], bestD = -1, dmin;
        for (i = 0; i < options.length; i++) {
            dmin = 999;
            for (j = 0; j < avoid.length; j++) {
                if (avoid[j]) dmin = Math.min(dmin, colorDist(options[i].primary, avoid[j]) * (j === 0 ? 1 : 1.15));
            }
            dmin = Math.min(dmin, colorDist(options[i].primary, PITCH_GREEN) * 1.6);
            // Pequeña preferencia por el orden de la lista (colores habituales primero).
            dmin -= i * 6;
            if (dmin > bestD) { bestD = dmin; best = options[i]; }
        }
        return best;
    }

    function gkKit(side, teamColors, d) {
        var own = teamColors || {};
        var rival = d ? (side === 'home' ? d.awayColors : d.homeColors) || {} : {};
        var avoid = [own.primary, rival.primary, own.secondary, rival.secondary];
        if (side === 'away' && d) {
            var homeGk = pickGk(GK_OPTIONS.home, [rival.primary, own.primary, rival.secondary, own.secondary]);
            avoid.push(homeGk.primary);
        }
        return pickGk(GK_OPTIONS[side] || GK_OPTIONS.home, avoid);
    }

    function buildPlayerNode(p, d, st) {
        var teamColors = p.side === 'home' ? d.homeColors : d.awayColors;
        var isGk = p.pos === 'GK';
        var colors = isGk ? gkKit(p.side, teamColors, d) : teamColors;
        var kit = kitStyle(colors);
        var primary = kit.fill;
        var secondary = kit.ring;
        var ink = kit.ink;
        var num = assignNumber(p.side, p.name);
        var pos = toSvg(st.x, st.y);
        var g = svgEl('g', {
            'class': 'campo-player',
            'data-name': p.name,
            'data-side': p.side,
            'data-num': String(num),
            transform: 'translate(' + pos.x + ',' + pos.y + ')',
            filter: 'url(#campo-shadow)'
        });
        if (isGk) g.classList.add('campo-gk');
        if (kit.outline) {
            g.appendChild(svgEl('circle', {
                r: 22.6, fill: 'none', stroke: kit.outline, 'stroke-width': 1.6,
                'class': 'campo-outline', 'pointer-events': 'none'
            }));
        }
        g.appendChild(svgEl('circle', {
            r: 20,
            fill: primary,
            stroke: secondary,
            'stroke-width': isGk ? 3.2 : 2.5,
            'class': 'campo-disk'
        }));
        if (isGk) {
            g.appendChild(svgEl('circle', {
                cx: 14, cy: -14, r: 8,
                fill: '#111', stroke: secondary, 'stroke-width': 1.4,
                'class': 'campo-gk-badge'
            }));
            var tG = svgEl('text', {
                x: 14, y: -10, 'text-anchor': 'middle', fill: '#fff',
                'font-size': '9', 'font-weight': '700', 'font-family': 'Segoe UI, sans-serif',
                'pointer-events': 'none', 'class': 'campo-gk-letter'
            });
            tG.textContent = 'G';
            g.appendChild(tG);
        }
        var tNum = svgEl('text', {
            x: 0, y: 5,
            'text-anchor': 'middle',
            fill: ink,
            stroke: kit.halo,
            'stroke-width': 1.6,
            'paint-order': 'stroke',
            'font-size': '13',
            'font-weight': '700',
            'font-family': 'Segoe UI, sans-serif',
            'pointer-events': 'none',
            'class': 'campo-dorsal'
        });
        tNum.textContent = String(num);
        g.appendChild(tNum);
        var tName = svgEl('text', {
            x: 0, y: 33,
            'text-anchor': 'middle',
            fill: '#fff',
            stroke: 'rgba(0,0,0,0.8)',
            'stroke-width': 3,
            'paint-order': 'stroke',
            'font-size': '11',
            'font-weight': '700',
            'font-family': 'Segoe UI, sans-serif',
            'pointer-events': 'none',
            'class': 'campo-name'
        });
        var fullN = shortName(p.name, d.formatName);
        var shortN = shortName(p.name, d.formatName, true);
        tName.setAttribute('data-full', fullN);
        tName.setAttribute('data-short', shortN);
        tName.textContent = isCompactView() ? shortN : fullN;
        g.appendChild(tName);
        g.addEventListener('click', function () {
            if (typeof window.showPlayerPopupById === 'function') window.showPlayerPopupById(p.name);
        });
        return g;
    }

    function highlightPlayers(names) {
        if (!playersLayer) return;
        var set = {};
        (names || []).forEach(function (n) { set[n] = true; });
        Array.prototype.forEach.call(playersLayer.querySelectorAll('.campo-player'), function (g) {
            var active = !!set[g.getAttribute('data-name')];
            g.classList.toggle('is-active', active && names && names.length);
            // Atenuar sin desteñir: con 0,58 las camisetas blancas se veían verdosas.
            g.style.opacity = (!names || !names.length || active) ? '1' : '0.8';
            var on = active && names && names.length;
            var c = g.querySelector('.campo-disk');
            if (c) c.setAttribute('r', on ? 23 : 20);
            var o = g.querySelector('.campo-outline');
            if (o) o.setAttribute('r', on ? 25.6 : 22.6);
        });
    }

    function updateChrome(d, play) {
        if (ui.homeName) ui.homeName.textContent = d.homeTeam || 'Local';
        if (ui.awayName) ui.awayName.textContent = d.awayTeam || 'Visitante';
        if (ui.homeSwatch && d.homeColors) {
            ui.homeSwatch.style.background = d.homeColors.primary;
            ui.homeSwatch.style.borderColor = d.homeColors.secondary;
        }
        if (ui.awaySwatch && d.awayColors) {
            ui.awaySwatch.style.background = d.awayColors.primary;
            ui.awaySwatch.style.borderColor = d.awayColors.secondary;
        }
        if (ui.score && !dragging) {
            var playsNow = buildPlays(d);
            var idxNow = play ? play.i : -1;
            if (idxNow >= 0 && (d.finished || (play && (play.kind === 'shootout' || play.kind === 'shootout-kick')))) {
                ui.score.textContent = previewScore(playsNow, idxNow, d);
            } else {
                ui.score.textContent = d.score || '0 - 0';
            }
            updatePensBoard(playsNow, idxNow, d);
        }
        var label = 'Minuto 0';
        if (play && (play.kind === 'shootout' || play.kind === 'shootout-kick')) label = playMinuteLabel(play);
        else if (d.finished) label = 'Finalizado';
        else if (d.minute != null && d.minute !== '') label = 'Minuto ' + d.minute;
        if (!dragging && ui.min) ui.min.textContent = label;

        var plays = buildPlays(d);
        if (ui.slider && plays.length) {
            ui.slider.max = String(Math.max(0, plays.length - 1));
            if (!dragging) {
                var idx = play ? play.i : 0;
                ui.slider.value = String(idx);
            }
            ui.slider.disabled = false;
        }

        if (ui.play) {
            if (!d.started) ui.play.textContent = 'Comenzar';
            else if (d.finished) ui.play.textContent = 'Reiniciar';
            else if (d.paused) ui.play.textContent = 'Reanudar';
            else ui.play.textContent = 'Pausar';
        }
    }

    function refresh() {
        if (refreshing) return;
        refreshing = true;
        try {
            refreshInner();
        } finally {
            refreshing = false;
        }
    }

    function refreshInner() {
        if (!ensureUI()) return;
        var d = data();
        if (!d || !d.homeTeam) return;
        if (!d.homeStarters || !d.homeStarters.length) return;
        var matchId = (d.homeTeam || '') + '|' + (d.awayTeam || '') + '|' + ((d.plays && d.plays.length) || 0);
        if (matchId !== lastMatchId) {
            resetView();
            lastMatchId = matchId;
            ensureUI();
        }
        if (dragging) return;
        var play = currentPlay(d);
        renderPlayers(d, play);
        updateChrome(d, play);
        setCaption(play, d);
        if (play && play.i !== lastPlayIndex) {
            var jump = lastPlayIndex < 0 || Math.abs(play.i - lastPlayIndex) > 3;
            playResolved(play, d, jump);
            lastPlayIndex = play.i;
        } else if (!play && lastPlayIndex !== -2) {
            playResolved(null, d, true);
            lastPlayIndex = -2;
        }
    }

    function resetView() {
        lastSignature = '';
        lastPlayIndex = -1;
        lastPlaysSource = '';
        parsedPlays = [];
        resetNumbers();
        playerState = {};
        if (refState.el && refState.el.parentNode) refState.el.parentNode.removeChild(refState.el);
        refState = { x: 53, y: 62, el: null, name: '' };
        if (anim.raf) cancelAnimationFrame(anim.raf);
        anim.running = false;
        anim.queue = [];
        ball = { x: 50, y: 50 };
        if (playersLayer) playersLayer.innerHTML = '';
        if (built) placeBall();
    }

    function onShow() {
        ensureUI();
        refresh();
    }

    function observe() {
        var min = $('minute');
        var narr = $('narration');
        var score = $('score');
        if (window.MutationObserver) {
            var obs = new MutationObserver(function () {
                if (dragging || refreshing) return;
                refresh();
            });
            [min, narr, score].forEach(function (el) {
                if (el) obs.observe(el, { childList: true, characterData: true, subtree: true });
            });
        }
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (t && t.classList && t.classList.contains('tab')) {
                var oc = t.getAttribute('onclick') || '';
                if (oc.indexOf('campo-tab') !== -1) setTimeout(onShow, 0);
            }
        });
        setInterval(function () {
            var tab = $('campo-tab');
            if (tab && tab.classList.contains('active')) refresh();
        }, 400);
    }

    window.Campo = {
        refresh: refresh,
        onShow: onShow,
        resetView: resetView,
        debugPlays: function () {
            var d = data();
            return buildPlays(d).map(function (p) {
                return { i: p.i, minute: p.minute, kind: p.kind, team: p.team, text: (p.text || '').slice(0, 220), players: p.players, target: p.target };
            });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            ensureUI();
            observe();
        });
    } else {
        ensureUI();
        observe();
    }
})();
