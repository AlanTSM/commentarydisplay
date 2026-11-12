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
        'play': 'Jugada'
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

    function shortName(name, formatName) {
        var raw = formatName ? formatName(name) : name;
        raw = String(raw || name || '').trim();
        var parts = raw.replace(/\./g, ' ').split(/\s+/).filter(Boolean);
        if (!parts.length) return '';
        var last = parts[parts.length - 1];
        return last.length > 10 ? last.slice(0, 9) + '.' : last;
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
        if (/falta|derriba|comete falta|entrada /.test(s)) return 'foul';
        if (/banda|por fuera|l[ií]nea de banda/.test(s)) return 'wing';
        if (/[aá]rea/.test(s)) return 'box';
        return 'play';
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
                return { x: boxX, y: lastPt ? clamp(lastPt.y, 28, 72) : 50 };
            case 'box':
                return { x: boxX, y: lastPt ? clamp(lastPt.y, 22, 78) : 50 };
            case 'wing':
                return nearPlayer(side === 'home' ? 70 : 30, wingY, true);
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

    function buildPlays(d) {
        if (!d) return [];
        var src = (d.plays || []).map(function (p) { return p.token + '|' + (p.lines || []).join('\n'); }).join('\0');
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
        return parsedPlays;
    }

    function currentPlay(d) {
        var plays = buildPlays(d);
        if (!plays.length) return null;
        if (d.finished) return plays[plays.length - 1];
        if (d.minute == null || d.minute === '') return null;
        var best = -1;
        for (var i = 0; i < plays.length; i++) {
            if (minuteValue(plays[i].minute) <= minuteValue(d.minute) + 0.0001) best = i;
        }
        if (best < 0) return null;
        var narr = (d.narration || '').replace(/\s+/g, ' ').trim();
        var sameMin = [];
        for (var j = 0; j <= best; j++) {
            if (String(plays[j].minute) === String(d.minute) || minuteValue(plays[j].minute) === minuteValue(d.minute)) {
                sameMin.push(plays[j]);
            }
        }
        if (narr && sameMin.length) {
            for (var k = sameMin.length - 1; k >= 0; k--) {
                var body = sameMin[k].text.replace(/\s+/g, ' ');
                if (narr.length > 8 && body.indexOf(narr.slice(0, Math.min(40, narr.length))) !== -1) return sameMin[k];
                if (narr.length > 8 && sameMin[k].text.indexOf(narr.slice(0, Math.min(40, narr.length))) !== -1) return sameMin[k];
            }
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

    function separate(players) {
        var i, j, a, b, dx, dy, dist, push, nx, ny, k;
        for (k = 0; k < 2; k++) {
            for (i = 0; i < players.length; i++) {
                for (j = i + 1; j < players.length; j++) {
                    a = players[i];
                    b = players[j];
                    dx = b.tx - a.tx;
                    dy = b.ty - a.ty;
                    dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 0.15) {
                        dy = (i % 2 ? 1 : -1) * 1.2;
                        dist = Math.abs(dy);
                        dx = 0;
                    }
                    if (dist < 5) {
                        push = (5 - dist) / 2;
                        nx = dist < 0.15 ? 0 : dx / dist;
                        ny = dist < 0.15 ? (dy > 0 ? 1 : -1) : dy / dist;
                        if (a.pos !== 'GK') {
                            a.tx = clamp(a.tx - nx * push, 2.2, 97.8);
                            a.ty = clamp(a.ty - ny * push, 4, 96);
                        }
                        if (b.pos !== 'GK') {
                            b.tx = clamp(b.tx + nx * push, 2.2, 97.8);
                            b.ty = clamp(b.ty + ny * push, 4, 96);
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
        var shotX = opts.keepBall ? ballT.x : (attack === 'home' ? 86 : 14);
        var shotY = clamp(ballT.y, 28, 72);
        if (shooter) placeAt(shooter, shotX - dir * 3.2, shotY);
        if (assist) placeAt(assist, shotX - dir * 9, clamp(shotY + (assist.baseY - 50) * 0.3, 18, 82));
        namedAtk.forEach(function (p, i) {
            if (p === shooter || p === assist) return;
            placeAt(p, shotX - dir * (12 + i * 3), clamp(p.baseY * 0.4 + shotY * 0.6, 16, 84));
        });
        var gk = ofPos(def, 'GK')[0];
        if (gk) {
            var come = opts.oneOnOne ? 6 : 1.5;
            placeAt(gk, (attack === 'home' ? 97 : 3) - dir * come, clamp(shotY, 36, 64));
        }
        var markers = def.filter(function (p) { return p.pos !== 'GK'; }).sort(function (a, b) {
            return Math.abs(a.baseY - shotY) - Math.abs(b.baseY - shotY);
        });
        markers.slice(0, 3).forEach(function (p, i) {
            placeAt(p, shotX + dir * (2 + i), clamp(shotY + (i - 1) * 8, 18, 82));
        });
        var boxSpotsAtk = [
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
        var cornerY = ballT.y < 50 ? 16 : 84;
        var meetX = attack === 'home' ? 88 : 12;
        if (play.kind === 'own-goal') {
            meetX = attack === 'home' ? 14 : 86;
        }
        if (scorer) placeAt(scorer, meetX, cornerY);
        var mates = ofSide(players, attack).filter(function (p) { return p !== scorer && p.pos !== 'GK'; });
        mates.forEach(function (p, i) {
            var col = i % 4;
            var row = Math.floor(i / 4);
            var back = attack === 'home' ? -1 : 1;
            var ySign = cornerY < 50 ? 1 : -1;
            placeAt(p, meetX + back * (7 + col * 5.5 + row * 2), clamp(cornerY + ySign * (5 + row * 7 + (col % 2) * 3.5), 7, 93));
        });
        ofSide(players, attack === 'home' ? 'away' : 'home').forEach(function (p) {
            if (p.pos === 'GK') {
                placeAt(p, attack === 'home' ? 96 : 4, 50);
            } else {
                placeAt(p, lerp(p.baseX, 50, 0.25), lerp(p.baseY, 50, 0.15));
            }
        });
        return { scorer: scorer };
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

    function resolvePlay(play, d) {
        var layouts = layoutTeam(d.homeStarters, 'home').concat(layoutTeam(d.awayStarters, 'away'));
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
            return { phases: [{ players: snapshotTargets(players), ballPath: [{ x: 50, y: 50 }], ms: 500, highlight: [] }] };
        }
        var attack = sideOfTeam(play.team, d) || 'home';
        var ballT = play.target || { x: 50, y: 50 };
        var text = play.text || '';
        var kind = play.kind;
        var phases = [];
        var info;
        var highlight = play.players || [];
        var oneOnOne = /frente a porter[ií]a|mano a mano|solo ante|se planta/.test(text.toLowerCase());

        applyBlock(players, ballT, attack, kind);

        if (kind === 'corner') {
            info = setupCorner(players, play, attack, ballT);
            separate(players);
            var cornerPath = [];
            if (info.taker) cornerPath.push({ x: info.taker.tx, y: info.taker.ty });
            cornerPath.push({ x: attack === 'home' ? 90 : 10, y: 50 });
            phases.push({ players: snapshotTargets(players), ballPath: cornerPath, ms: 850, highlight: highlight });
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
            separate(players);
            phases.push({ players: snapshotTargets(players), ballPath: [ballT], ms: 1000, highlight: highlight, pose: true });
            setupKickoff(players);
            phases.push({ players: snapshotTargets(players), ballPath: [{ x: 50, y: 50 }], ms: 900, highlight: [], pose: false });
        } else if (kind === 'shot' || kind === 'save' || kind === 'box' || kind === 'goal') {
            info = setupShotShape(players, play, attack, ballT, { oneOnOne: oneOnOne });
            separate(players);
            var path = [];
            (info.namedAtk || []).forEach(function (p) { path.push({ x: p.tx, y: p.ty }); });
            if (info.shot) path.push(info.shot);
            if (!path.length) path.push(ballT);
            phases.push({ players: snapshotTargets(players), ballPath: path.slice(), ms: 800, highlight: highlight });
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
                separate(players);
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
        return { phases: phases, highlight: highlight };
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
        ballEl.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    }

    function placePlayerEl(st) {
        if (!st || !st.el) return;
        var p = toSvg(st.x, st.y);
        st.el.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
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
                '<div class="campo-score" id="campo-score">0 - 0</div>' +
                '<div class="campo-team away"><span id="campo-away-name">Visitante</span><span class="campo-swatch" id="campo-away-swatch"></span></div>' +
            '</div>' +
            '<div class="campo-pitch-box" id="campo-pitch-box"></div>' +
            '<div class="campo-caption" id="campo-caption">Pega un informe y pulsa «Comenzar partido» para ver el movimiento.</div>' +
            '<div class="campo-controls">' +
                '<button type="button" id="campo-play">Comenzar</button>' +
                '<span class="campo-min" id="campo-min">Minuto 0</span>' +
                '<input type="range" class="campo-slider" id="campo-slider" min="0" max="90" value="0" step="1">' +
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

        ui.play.addEventListener('click', onPlayClick);
        ui.slider.addEventListener('input', onSliderInput);
        ui.slider.addEventListener('change', onSliderChange);
        built = true;
        return true;
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

    function previewScore(plays, idx, d) {
        var h = 0, a = 0, i, p;
        for (i = 0; i <= idx; i++) {
            p = plays[i];
            if (!p) continue;
            if (p.kind === 'goal' || p.kind === 'own-goal') {
                if (p.team === d.homeTeam) h++;
                else if (p.team === d.awayTeam) a++;
            }
        }
        return h + ' - ' + a;
    }

    function applyPlayPreview(play, d, immediate) {
        if (!play) return;
        setCaption(play, d);
        if (ui.min) ui.min.textContent = 'Minuto ' + play.minute;
        if (ui.score) ui.score.textContent = previewScore(buildPlays(d), play.i, d);
        var narrEl = $('narration');
        var minEl = $('minute');
        if (narrEl) narrEl.textContent = summarize(play.text);
        if (minEl) minEl.textContent = 'Minuto ' + play.minute;
        renderPlayers(d);
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
        if (play) applyPlayPreview(play, d, false);
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
        if (typeof window.seekSimulationTo === 'function') {
            window.seekSimulationTo(play.minute, play.i);
        }
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
        }).filter(Boolean);
        return lines.slice(-2).join(' — ').trim();
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function renderPlayers(d) {
        if (!playersLayer) return;
        ensureRosterNumbers(d);
        var layouts = layoutTeam(d.homeStarters, 'home').concat(layoutTeam(d.awayStarters, 'away'));
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
    }

    function buildPlayerNode(p, d, st) {
        var colors = p.side === 'home' ? d.homeColors : d.awayColors;
        var primary = (colors && colors.primary) || '#333';
        var secondary = (colors && colors.secondary) || '#fff';
        var ink = contrastColor(primary);
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
        g.appendChild(svgEl('circle', {
            r: 20,
            fill: primary,
            stroke: secondary,
            'stroke-width': 2.5,
            'class': 'campo-disk'
        }));
        var tNum = svgEl('text', {
            x: 0, y: 5,
            'text-anchor': 'middle',
            fill: ink,
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
        tName.textContent = shortName(p.name, d.formatName);
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
            g.style.opacity = (!names || !names.length || active) ? '1' : '0.58';
            var c = g.querySelector('circle');
            if (c) c.setAttribute('r', active && names && names.length ? 23 : 20);
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
        if (ui.score && !dragging) ui.score.textContent = d.score || '0 - 0';
        var label = 'Minuto 0';
        if (d.finished) label = 'Finalizado';
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
        var play = currentPlay(d);
        renderPlayers(d);
        updateChrome(d, play);
        if (!dragging) setCaption(play, d);
        if (dragging) return;
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
        resetView: resetView
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
