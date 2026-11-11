/* Vista de campo 2D para el narrador dinámico de TSM.
   Rama vista-campo. Lee los datos ya parseados mediante window.getCampoData
   y no modifica el flujo de la narración salvo el seek explícito del deslizador. */
(function () {
    'use strict';

    var PITCH = { x: 40, y: 36, w: 1050, h: 680 };
    var POS_X = { GK: 7, DF: 20, DM: 33, MF: 45, AM: 60, FW: 74 };
    var POS_ORDER = ['GK', 'DF', 'DM', 'MF', 'AM', 'FW'];
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
    var ball = { x: 50, y: 50 };
    var ballFrom = { x: 50, y: 50 };
    var ballTo = { x: 50, y: 50 };
    var ballAnimStart = 0;
    var ballAnimMs = 450;
    var animating = false;
    var dragging = false;
    var built = false;
    var lastKind = 'play';
    var lastPlayIndex = -1;
    var parsedPlays = [];
    var lastPlaysSource = '';
    var lastMatchId = '';
    var refreshing = false;

    function $(id) { return document.getElementById(id); }

    function data() {
        return typeof window.getCampoData === 'function' ? window.getCampoData() : null;
    }

    function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

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

    function initials(name, formatName) {
        var raw = formatName ? formatName(name) : name;
        raw = String(raw || name || '').trim();
        var parts = raw.replace(/\./g, ' ').split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function assignNumber(side, name) {
        if (numbers.has(side + ':' + name)) return numbers.get(side + ':' + name);
        var n = nextNumber[side]++;
        numbers.set(side + ':' + name, n);
        return n;
    }

    function resetNumbers() {
        numbers.clear();
        nextNumber = { home: 1, away: 1 };
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
        if (/qu[eé] parada|tapa el remate|ataja|el portero/.test(s)) return 'save';
        if (/remate|chuta|disparo|volea|busca puerta|define |cabezazo|en posici[oó]n de remate/.test(s)) return 'shot';
        if (/falta|derriba|comete falta|entrada /.test(s)) return 'foul';
        if (/banda|por fuera/.test(s)) return 'wing';
        if (/[aá]rea/.test(s)) return 'box';
        return 'play';
    }

    function sideOfTeam(team, d) {
        if (!team || !d) return null;
        if (team === d.homeTeam) return 'home';
        if (team === d.awayTeam) return 'away';
        return null;
    }

    function playerPoint(name, d) {
        var layouts = layoutTeam(d.homeStarters, 'home').concat(layoutTeam(d.awayStarters, 'away'));
        for (var i = 0; i < layouts.length; i++) {
            if (layouts[i].name === name) return { x: layouts[i].x, y: layouts[i].y, side: layouts[i].side, pos: layouts[i].pos };
        }
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
        var lastPt = last ? playerPoint(last, d) : null;
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
                // El equipo de la narración es el que se apunta el tanto (también en autogol).
                return { x: goalX, y: 50 + ((playIndex % 5) - 2) * 2 };
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
        // Si hay varias jugadas en el mismo minuto, intenta casar por el texto de la narración.
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
        lines.appendChild(svgEl('path', { d: arcPath(x + spot, y + h / 2, arcR, boxW - spot, true) }));
        lines.appendChild(svgEl('path', { d: arcPath(x + w - spot, y + h / 2, arcR, boxW - spot, false) }));

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
        ballEl = svgEl('circle', { r: 9, fill: '#f4f4f4', stroke: '#222', 'stroke-width': 1.5, cx: 0, cy: 0 });
        ballG.appendChild(ballEl);
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
        // Arco fuera del área: la cuerda está a `offset` del punto de penalti hacia el centro.
        var d = offset;
        if (d >= r) return '';
        var ang = Math.acos(d / r);
        var y1 = cy - r * Math.sin(ang);
        var y2 = cy + r * Math.sin(ang);
        var x = home ? cx + d : cx - d;
        return 'M' + x + ',' + y1 + ' A' + r + ',' + r + ' 0 0 ' + (home ? 0 : 1) + ' ' + x + ',' + y2;
    }

    function cornerArc(cx, cy, r, q) {
        // q: 0 TL, 1 TR, 2 BR, 3 BL
        var start, end;
        if (q === 0) { start = [cx + r, cy]; end = [cx, cy + r]; }
        else if (q === 1) { start = [cx, cy + r]; end = [cx - r, cy]; }
        else if (q === 2) { start = [cx - r, cy]; end = [cx, cy - r]; }
        else { start = [cx, cy - r]; end = [cx + r, cy]; }
        return 'M' + start[0] + ',' + start[1] + ' A' + r + ',' + r + ' 0 0 1 ' + end[0] + ',' + end[1];
    }

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
            '<p class="campo-note">Los movimientos son aproximados: el informe no trae coordenadas. El balón se sitúa según el jugador y la zona que describe cada jugada (gol, remate, córner, falta…).</p>';
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

    function onSliderInput() {
        dragging = true;
        var d = data();
        if (!d) return;
        var plays = buildPlays(d);
        var idx = parseInt(ui.slider.value, 10) || 0;
        var play = plays[idx];
        if (play) {
            ui.min.textContent = 'Minuto ' + play.minute;
            setCaption(play, d);
            moveBallTo(play.target, true);
            highlightPlayers(play.players || []);
        }
    }

    function onSliderChange() {
        dragging = false;
        var d = data();
        if (!d) return;
        var plays = buildPlays(d);
        var idx = parseInt(ui.slider.value, 10) || 0;
        var play = plays[idx];
        if (!play) return;
        if (typeof window.seekSimulationTo === 'function') {
            window.seekSimulationTo(play.minute);
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

    function moveBallTo(target, immediate) {
        if (!target) return;
        if (immediate) {
            ball = { x: target.x, y: target.y };
            ballTo = { x: target.x, y: target.y };
            ballFrom = { x: target.x, y: target.y };
            placeBall();
            animating = false;
            return;
        }
        ballFrom = { x: ball.x, y: ball.y };
        ballTo = { x: target.x, y: target.y };
        ballAnimStart = performance.now();
        if (!animating) {
            animating = true;
            requestAnimationFrame(tickBall);
        }
    }

    function tickBall(now) {
        var t = (now - ballAnimStart) / ballAnimMs;
        if (t >= 1) {
            ball = { x: ballTo.x, y: ballTo.y };
            placeBall();
            animating = false;
            return;
        }
        var e = 1 - Math.pow(1 - t, 3);
        ball = {
            x: ballFrom.x + (ballTo.x - ballFrom.x) * e,
            y: ballFrom.y + (ballTo.y - ballFrom.y) * e
        };
        placeBall();
        requestAnimationFrame(tickBall);
    }

    function placeBall() {
        if (!ballEl) return;
        var p = toSvg(ball.x, ball.y);
        ballEl.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    }

    function renderPlayers(d) {
        if (!playersLayer) return;
        var layouts = layoutTeam(d.homeStarters, 'home').concat(layoutTeam(d.awayStarters, 'away'));
        var sig = layouts.map(function (p) { return p.side + ':' + p.name + ':' + p.pos + ':' + p.x.toFixed(1) + ':' + p.y.toFixed(1); }).join('|');
        var colorSig = (d.homeColors && d.homeColors.primary) + '/' + (d.awayColors && d.awayColors.primary);
        sig += '@@' + colorSig;
        if (sig === lastSignature && playersLayer.childNodes.length) return;
        lastSignature = sig;
        playersLayer.innerHTML = '';
        layouts.forEach(function (p) {
            var colors = p.side === 'home' ? d.homeColors : d.awayColors;
            var primary = (colors && colors.primary) || '#333';
            var secondary = (colors && colors.secondary) || '#fff';
            var ink = contrastColor(primary);
            var num = assignNumber(p.side, p.name);
            var pos = toSvg(p.x, p.y);
            var g = svgEl('g', {
                'class': 'campo-player',
                'data-name': p.name,
                'data-side': p.side,
                transform: 'translate(' + pos.x + ',' + pos.y + ')',
                filter: 'url(#campo-shadow)'
            });
            g.appendChild(svgEl('circle', {
                r: 20,
                fill: primary,
                stroke: secondary,
                'stroke-width': 2.5
            }));
            var tNum = svgEl('text', {
                x: 0, y: 5,
                'text-anchor': 'middle',
                fill: ink,
                'font-size': '14',
                'font-weight': '700',
                'font-family': 'Segoe UI, sans-serif',
                'pointer-events': 'none'
            });
            tNum.textContent = String(num);
            g.appendChild(tNum);
            var tName = svgEl('text', {
                x: 0, y: 34,
                'text-anchor': 'middle',
                fill: '#fff',
                stroke: 'rgba(0,0,0,0.75)',
                'stroke-width': 3,
                'paint-order': 'stroke',
                'font-size': '11',
                'font-weight': '700',
                'font-family': 'Segoe UI, sans-serif',
                'pointer-events': 'none'
            });
            tName.textContent = shortName(p.name, d.formatName);
            g.appendChild(tName);
            g.addEventListener('click', function () {
                if (typeof window.showPlayerPopupById === 'function') window.showPlayerPopupById(p.name);
            });
            playersLayer.appendChild(g);
        });
    }

    function highlightPlayers(names) {
        if (!playersLayer) return;
        var set = {};
        (names || []).forEach(function (n) { set[n] = true; });
        Array.prototype.forEach.call(playersLayer.querySelectorAll('.campo-player'), function (g) {
            var active = !!set[g.getAttribute('data-name')];
            g.style.opacity = (!names || !names.length || active) ? '1' : '0.55';
            var c = g.querySelector('circle');
            if (c) c.setAttribute('r', active ? 23 : 20);
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
        if (ui.score) ui.score.textContent = d.score || '0 - 0';
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
        if (!d || !d.homeTeam) {
            return;
        }
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
        if (!dragging) {
            setCaption(play, d);
        }
        if (!dragging) {
            if (play && play.i !== lastPlayIndex) {
                moveBallTo(play.target, lastPlayIndex < 0 || Math.abs(play.i - lastPlayIndex) > 3);
                highlightPlayers(play.players || []);
                lastPlayIndex = play.i;
            } else if (!play) {
                moveBallTo({ x: 50, y: 50 }, true);
            }
        }
    }

    function resetView() {
        lastSignature = '';
        lastPlayIndex = -1;
        lastPlaysSource = '';
        parsedPlays = [];
        resetNumbers();
        ball = { x: 50, y: 50 };
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
