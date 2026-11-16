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
    var ball = { x: 50, y: 50, h: 0, state: 'free', owner: null };
    var ballShadowEl = null;
    var lastKind = 'play';
    var lastPlayIndex = -1;
    var parsedPlays = [];
    var lastPlaysSource = '';
    var lastMatchId = '';
    var refreshing = false;
    var dragging = false;
    var keepViewOnReset = false;
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
        // «ocasión manifiesta de gol», «dedica el gol al banquillo»... no son un gol de esta jugada.
        s = s.replace(/ocasi[oó]n(?:es)? (?:manifiesta |clara )?de gol|posible gol|dedica el gol|celebra el gol|tras el gol|(?:merec[ií]a|merece|mereci[oó]|ol[ií]a a|huele a|roza el|rozó el|cerca del|casi el|sin|acabar en|terminar en|l[ií]nea de|ocasiones de|buscando el|busca el|en busca del|a por el) gol|gol en contra|gol(?:es)? anulado|anula(?:do)? el gol/g, ' ');
        // Gol anulado (fuera de juego, VAR, falta previa): no sube al marcador.
        var annulled = /anula|anulado|no sube al marcador|no vale|invalida/.test(s);
        if (!annulled && /autogol|propia puerta/.test(s)) return 'own-goal';
        // Evitar falsos positivos como "Golpea las vallas".
        if (!annulled && /¡+gol|go{3,}l|(?:^|[^\wáéíóúñ])¡?gol(?:es)?\b/i.test(s)) return 'goal';
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

    /* ---- Izquierda / centro / derecha (L/C/R) a partir de la narración ----
       Siempre desde el punto de vista del equipo que ataca (como en la radio: «banda izquierda»
       es la izquierda del que ataca). El local ataca hacia la derecha de la pantalla, así que su
       izquierda es la parte de arriba; para el visitante es al revés.
       Se descartan las menciones que no hablan de la zona: pierna, pie, bota, guante, puño, palo,
       la estirada del portero («hacia su izquierda»), «primer/segundo palo», «desde la banda» (banquillo)... */
    var LANE_NOISE = /(?:pierna|pie|bota|guante|pu[nñ]o|palo|mano|tobillo|rodilla|muslo|hombro)\s+(?:izquierd[oa]|derech[oa])|(?:hacia|a|por)\s+su\s+(?:izquierda|derecha)|(?:con|de)\s+la\s+(?:izquierda|derecha)\b(?!\s+(?:del|de la)\s+(?:área|campo))|(?:primer|segundo)\s+palo|desde\s+la\s+(?:banda|l[ií]nea\s+de\s+banda)(?!\s+(?:izquierda|derecha))|fuera\s+de\s+banda|a\s+la\s+banda\b(?!\s+(?:izquierda|derecha))|derechazo|zurdazo|zurda/g;
    var LANE_L = /(?:banda|extremo|costado|flanco|carril|lateral|perfil|sector|lado|v[ií]a|zona|pegado a la l[ií]nea)\s+izquierd[oa]|(?:por|hacia|a|desde|en)\s+la\s+izquierda|abre\s+(?:el\s+juego\s+)?(?:a|hacia)\s+la\s+izquierda|escorado\s+(?:a|en)\s+la\s+(?:banda\s+)?izquierda/;
    var LANE_R = /(?:banda|extremo|costado|flanco|carril|lateral|perfil|sector|lado|v[ií]a|zona|pegado a la l[ií]nea)\s+derech[oa]|(?:por|hacia|a|desde|en)\s+la\s+derecha|abre\s+(?:el\s+juego\s+)?(?:a|hacia)\s+la\s+derecha|escorado\s+(?:a|en)\s+la\s+(?:banda\s+)?derecha/;
    var LANE_C = /por\s+el\s+(?:centro|medio)|carril\s+central|zona\s+central|por\s+dentro|frontal\s+del\s+[aá]rea|en\s+la\s+frontal|pasillo\s+central|eje\s+central|por\s+el\s+coraz[oó]n/;
    var LANE_SWITCH = /(?:la|esa)\s+otra\s+banda|en\s+la\s+otra\s+banda|cambia\s+(?:el\s+juego|de\s+orientaci[oó]n)|cambio\s+de\s+orientaci[oó]n|hacia\s+esa\s+banda|al\s+otro\s+lado|al\s+lado\s+contrario|banda\s+contraria/;
    var LANE_WING = /banda|extremo|flanco|costado|carril|desborde|pegado a la l[ií]nea|línea de fondo|l[ií]nea de fondo/;

    function laneHint(text, prevLane) {
        var t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
        // «saque de banda» no indica lado; «desde la banda» suele ser el banquillo.
        t = t.replace(LANE_NOISE, ' ');
        // El banquillo: «el entrenador se desgañita en la banda», «aplaude desde la banda».
        t = t.replace(/(?:entrenador|t[eé]cnico|banquillo|m[ií]ster|desga[nñ]ita|aplaude|instrucciones|no para de hablar)[^.\n]{0,40}banda/g, ' ');
        function lastAt(re) {
            var g = new RegExp(re.source, 'g'), m, at = -1;
            while ((m = g.exec(t)) !== null) { at = m.index; if (m[0] === '') g.lastIndex++; }
            return at;
        }
        var mL = lastAt(LANE_L), mR = lastAt(LANE_R), mC = lastAt(LANE_C);
        var found = [];
        if (mL >= 0) found.push({ lane: 'L', at: mL });
        if (mR >= 0) found.push({ lane: 'R', at: mR });
        if (mC >= 0) found.push({ lane: 'C', at: mC });
        if (found.length) {
            // Cuenta la última mención: es donde acaba la jugada («atrae por la izquierda y gira
            // el juego a la derecha» termina en la derecha).
            found.sort(function (a, b) { return b.at - a.at; });
            return { lane: found[0].lane, src: 'text' };
        }
        if (LANE_SWITCH.test(t) && (prevLane === 'L' || prevLane === 'R')) {
            return { lane: prevLane === 'L' ? 'R' : 'L', src: 'switch' };
        }
        if (LANE_WING.test(t.replace(/saque de banda/g, ''))) return { lane: 'W', src: 'wing' };
        return { lane: null, src: null };
    }

    // y (0-100) de una banda para el equipo que ataca. depth: 0 = pegado a la línea, 1 = centro.
    function laneY(lane, side, depth) {
        var top = 10 + (depth || 0) * 38;
        if (lane === 'C') return 50;
        var leftIsTop = side !== 'away';
        var isTop = lane === 'L' ? leftIsTop : !leftIsTop;
        return isTop ? top : 100 - top;
    }

    function inferTarget(kind, team, players, d, playIndex, text, lane) {
        var side = sideOfTeam(team, d) || 'home';
        var attack = side === 'home' ? 1 : -1;
        var goalX = side === 'home' ? 97.5 : 2.5;
        var ownGoalX = side === 'home' ? 2.5 : 97.5;
        var boxX = side === 'home' ? 88 : 12;
        var spotX = side === 'home' ? 89.5 : 10.5;
        var last = players && players.length ? players[players.length - 1] : null;
        var lastPt = last ? basePoint(last, d) : null;
        var hasLane = lane === 'L' || lane === 'R';
        var wingY;
        if (hasLane) wingY = laneY(lane, side, 0) < 50 ? 8 : 92;
        else wingY = (playIndex % 2 === 0) ? 8 : 92;
        // Altura sugerida por la narración para jugadas que no son de banda.
        function laneShift(y, depth, lo, hi) {
            if (lane === 'C') return clamp(lerp(y, 50, 0.7), lo, hi);
            if (hasLane) return clamp(laneY(lane, side, depth), lo, hi);
            return clamp(y, lo, hi);
        }

        function nearPlayer(fallbackX, fallbackY, towardGoal) {
            if (!lastPt) return { x: fallbackX, y: fallbackY };
            var x = lastPt.x + (towardGoal ? attack * 4 : 0);
            return { x: clamp(x, 3, 97), y: clamp(lastPt.y, 6, 94) };
        }

        switch (kind) {
            case 'goal':
                // Si la jugada viene por una banda, el balón entra por ese lado de la portería.
                if (hasLane) return { x: goalX, y: laneY(lane, side, 0) < 50 ? 46.5 : 53.5 };
                return { x: goalX, y: 50 + ((playIndex % 5) - 2) * 2.2 };
            case 'own-goal':
                return { x: goalX, y: 50 + ((playIndex % 5) - 2) * 2.2 };
            case 'penalty':
                return { x: spotX, y: 50 };
            case 'corner':
                return { x: goalX, y: wingY };
            case 'goalkick':
                return { x: ownGoalX + attack * 6, y: 50 };
            case 'save':
                if (hasLane) return { x: goalX - attack * 3, y: laneY(lane, side, 0) < 50 ? 44 : 56 };
                return { x: goalX - attack * 3, y: 50 + ((playIndex % 3) - 1) * 6 };
            case 'shot':
            case 'oneonone':
                return { x: boxX, y: laneShift(lastPt ? lastPt.y : 50, 0.55, 28, 72) };
            case 'box':
                return { x: boxX, y: laneShift(lastPt ? lastPt.y : 50, 0.45, 22, 78) };
            case 'wing':
                if (hasLane) {
                    var wp = nearPlayer(side === 'home' ? 70 : 30, wingY, true);
                    return { x: wp.x, y: laneY(lane, side, 0.1) };
                }
                return nearPlayer(side === 'home' ? 70 : 30, wingY, true);
            case 'throwin':
                return { x: lastPt ? clamp(lastPt.x, 12, 88) : (side === 'home' ? 62 : 38), y: wingY };
            case 'counter':
                return { x: side === 'home' ? 78 : 22, y: laneShift(lastPt ? lastPt.y : 50, 0.3, 18, 82) };
            case 'clearance':
                return { x: boxX, y: laneShift(lastPt ? lastPt.y : 50, 0.4, 18, 82) };
            case 'foul':
                return nearPlayer(side === 'home' ? 62 : 38, laneShift(lastPt ? lastPt.y : 50, 0.25, 8, 92), false);
            case 'yellow':
            case 'red':
            case 'injury':
            case 'sub':
                return nearPlayer(50, 50, false);
            default:
                if (hasLane || lane === 'C') {
                    var bx = lastPt ? clamp(lastPt.x + attack * 3, 5, 95) : (side === 'home' ? 58 : 42);
                    return { x: bx, y: laneShift(lastPt ? lastPt.y : 50, 0.15, 6, 94) };
                }
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

    // Saques de centro: primera jugada del partido, de la segunda parte y de cada parte de la prórroga.
    // Saca el equipo de esa primera jugada en la primera parte; en la segunda, el otro (reglamento).
    /* ---- Goles según el marcador narrado ----
       La narración trae tras cada gol la línea «Local n-m Visitante ...». Esa línea manda: una jugada
       solo es gol si el marcador cambia (un «¡gol!» anulado, «la jugada merecía gol»... no cuentan), y
       el equipo que marca es el que sube en el marcador (en una falta directa la cabecera es la del
       equipo que hizo la falta). Si el partido no trae esas líneas, se queda la clasificación por texto. */
    function scoreLinesIn(text, d) {
        var re = /(?:^|\n)\s*(?:\.\.\.)?\s*([^\n]*?[A-Za-zÀ-ÿ.)][^\n]*?)\s(\d{1,2})\s?-\s?(\d{1,2})\s([^\n]*?[A-Za-zÀ-ÿ(][^\n]*?)\s*\.\.\./g;
        var m, out = [], hf = foldText(d.homeTeam || ''), af = foldText(d.awayTeam || '');
        function like(a, b) { a = foldText(a).trim(); if (!a || !b) return false; return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0 || a.split(' ')[0] === b.split(' ')[0]; }
        while ((m = re.exec(String(text || ''))) !== null) {
            var l = m[1], r = m[4], h = parseInt(m[2], 10), a = parseInt(m[3], 10);
            if (like(l, hf) || like(r, af)) out.push({ h: h, a: a });
            else if (like(l, af) || like(r, hf)) out.push({ h: a, a: h });
        }
        return out;
    }
    function reconcileGoals(plays, d) {
        var lines = plays.map(function (p) { return scoreLinesIn(p.text, d); });
        if (!lines.some(function (l) { return l.length; })) return;
        var cur = { h: 0, a: 0 };
        plays.forEach(function (p, i) {
            var l = lines[i], sl = l.length ? l[l.length - 1] : null;
            var wasGoal = p.kind === 'goal' || p.kind === 'own-goal';
            var changed = sl && (sl.h !== cur.h || sl.a !== cur.a) && sl.h >= cur.h && sl.a >= cur.a;
            if (changed) {
                var side = sl.h > cur.h ? 'home' : 'away';
                var own = /autogol|propia puerta/i.test(p.text || '');
                p.kind = own ? 'own-goal' : 'goal';
                p.scoreSide = side;
                p.scoreAfter = sl.h + '-' + sl.a;
                // El equipo de la jugada es el que ataca y marca (en propia puerta, el que se beneficia).
                p.headerTeam = p.team;
                p.team = side === 'home' ? d.homeTeam : d.awayTeam;
                cur = { h: sl.h, a: sl.a };
                p.target = inferTarget(p.kind, p.team, p.players, d, p.i, p.text, p.lane);
            } else if (wasGoal) {
                // «¡Gol!» que no sube al marcador (anulado) o mención suelta: no es un gol.
                p.kind = classify(String(p.text || '').replace(/autogol|propia puerta|¡+\s*gol\w*!*|go{3,}l\w*|\bgol(?:es)?\b/gi, ' '));
                p.annulled = /anula|no sube|no vale/i.test(p.text || '');
                p.target = inferTarget(p.kind, p.team, p.players, d, p.i, p.text, p.lane);
            }
        });
    }

    // Penalti narrado con la cabecera del equipo que lo comete («Real Madrid: Theo derriba a Llorente
    // ... ¡PENALTI!»): lo lanza el otro equipo.
    function fixPenaltySides(plays, d) {
        plays.forEach(function (p) {
            if (p.kind !== 'penalty' || p.scoreSide) return;
            var t = foldText(p.text), first = t.split('\n')[0];
            if (!/(derriba|entrada de|mano de|falta de|comete|agarr|zancadill|empuj|arrolla|pisot|codazo|zarandea|objeta|tumba|pierde los papeles)/.test(first)) return;
            var hs = sideOfTeam(p.team, d);
            var fs = p.players && p.players.length && d.sideOfPlayer ? d.sideOfPlayer(p.players[0]) : null;
            if (hs && (!fs || fs === hs)) {
                p.headerTeam = p.team;
                p.team = hs === 'home' ? d.awayTeam : d.homeTeam;
                p.target = inferTarget(p.kind, p.team, p.players, d, p.i, p.text, p.lane);
            }
        });
    }

    function markKickoffs(plays, d) {
        var firstHalfKicker = null, etKicker = null;
        var seen46 = false, seen91 = false, seen106 = false;
        var hasET = plays.some(function (p) { return minuteValue(p.minute) >= 96 && !/\+/.test(String(p.minute)); });
        plays.forEach(function (p, i) {
            var v = minuteValue(p.minute);
            var side = sideOfTeam(p.team, d) || 'home';
            if (i === 0) {
                firstHalfKicker = side;
                p.kickoffBefore = side;
                p.kickoffLabel = 'Saque inicial';
            } else if (!seen46 && v >= 46) {
                p.kickoffBefore = firstHalfKicker === 'home' ? 'away' : 'home';
                p.kickoffLabel = 'Saque de centro (segunda parte)';
            } else if (hasET && !seen91 && v >= 91) {
                etKicker = side;
                p.kickoffBefore = side;
                p.kickoffLabel = 'Saque de centro (prórroga)';
            } else if (hasET && !seen106 && v >= 106) {
                p.kickoffBefore = etKicker === 'home' ? 'away' : 'home';
                p.kickoffLabel = 'Saque de centro (segunda parte de la prórroga)';
            }
            if (v >= 46) seen46 = true;
            if (v >= 91) seen91 = true;
            if (v >= 106) seen106 = true;
        });
    }

    function buildPlays(d) {
        if (!d) return [];
        var src = (d.plays || []).map(function (p) { return p.token + '|' + (p.lines || []).join('\n'); }).join('\0');
        src += '\0SO:' + ((d.narrationText || '').length);
        if (src === lastPlaysSource && parsedPlays.length) return parsedPlays;
        lastPlaysSource = src;
        var prevLane = null, prevTeam = null;
        parsedPlays = (d.plays || []).map(function (p, i) {
            var first = (p.lines && p.lines[0]) || '';
            var team = d.detectTeam ? d.detectTeam(first) : null;
            var text = (p.lines || []).join(' \n ');
            var players = d.playersIn ? d.playersIn(text) : [];
            var kind = classify(text);
            // «la otra banda» solo tiene sentido si sigue atacando el mismo equipo.
            var hint = laneHint(text, team && team === prevTeam ? prevLane : null);
            var lane = hint.lane;
            if (lane === 'W') lane = null;
            // En jugadas a balón parado la «frontal» o «por el centro» no es una banda
            // (córner al área, penalti por el centro...). Solo cuentan izquierda/derecha.
            if (lane === 'C' && /^(corner|penalty|goalkick|throwin|sub|yellow|red|injury)$/.test(kind)) { lane = null; hint = { lane: null, src: null }; }
            if (kind === 'penalty' || kind === 'goalkick' || kind === 'sub') { lane = null; hint = { lane: null, src: null }; }
            if (kind === 'goal' && /penalti|penalty/i.test(text)) { lane = null; hint = { lane: null, src: null }; }
            if (hint.lane) { prevLane = lane || prevLane; prevTeam = team; }
            return {
                i: i,
                minute: p.token,
                team: team,
                text: text,
                players: players,
                kind: kind,
                lane: lane,
                laneSrc: hint.src,
                target: inferTarget(kind, team, players, d, i, text, lane)
            };
        });
        reconcileGoals(parsedPlays, d);
        fixPenaltySides(parsedPlays, d);
        markKickoffs(parsedPlays, d);
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
        // Redes (se mueven cuando entra el balón).
        [['campo-net-l', x - goalW], ['campo-net-r', x + w]].forEach(function (nd) {
            var net = svgEl('g', { 'class': 'campo-net ' + nd[0], stroke: 'rgba(255,255,255,0.45)', 'stroke-width': 1 });
            var gx0 = nd[1];
            for (var qi = 1; qi < 4; qi++) net.appendChild(svgEl('line', { x1: gx0 + goalW * qi / 4, y1: goalY, x2: gx0 + goalW * qi / 4, y2: goalY + goalH }));
            for (var qj = 1; qj < 9; qj++) net.appendChild(svgEl('line', { x1: gx0, y1: goalY + goalH * qj / 9, x2: gx0 + goalW, y2: goalY + goalH * qj / 9 }));
            svg.appendChild(net);
        });
        svg.appendChild(goals);

        var labels = svgEl('g', { fill: 'rgba(255,255,255,0.45)', 'font-size': '14', 'font-family': 'Segoe UI, sans-serif', 'text-anchor': 'middle' });
        var lblL = textAt(x + 80, y + 22, ends.flipped ? 'Visitante' : 'Local');
        var lblR = textAt(x + w - 80, y + 22, ends.flipped ? 'Local' : 'Visitante');
        labels.appendChild(lblL);
        labels.appendChild(lblR);
        ends.labels = [lblL, lblR];
        svg.appendChild(labels);

        // Fuera del campo (banda de abajo): banquillos, entrenadores y asistencias.
        offLayer = svgEl('g', { 'class': 'campo-off' });
        benchLayer = svgEl('g', { 'class': 'campo-benches' });
        staffLayer = svgEl('g', { 'class': 'campo-staff-layer' });
        offLayer.appendChild(benchLayer);
        offLayer.appendChild(staffLayer);
        svg.appendChild(offLayer);
        benchSig = '';
        managers = { home: null, away: null };

        playersLayer = svgEl('g', { 'class': 'campo-players' });
        svg.appendChild(playersLayer);

        ballShadowEl = svgEl('ellipse', { 'class': 'campo-ball-shadow', rx: 9, ry: 4, fill: '#000', opacity: 0, cx: 0, cy: 0 });
        svg.appendChild(ballShadowEl);
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
        if (kind === 'goalkick' || kind === 'penalty' || kind === 'corner') return;
        shiftDefence(players, ballT, attackSide);
    }

    // Basculación: el equipo que defiende se corre hacia el lado del balón y se estrecha
    // (bloque compacto); la línea de defensas queda plana y el lateral del lado del balón sale.
    // El que ataca abre el campo: los de banda contraria se quedan abiertos para el cambio de juego.
    function shiftDefence(players, ballT, attackSide) {
        var defSide = attackSide === 'home' ? 'away' : 'home';
        var def = ofSide(players, defSide).filter(function (p) { return p.pos !== 'GK'; });
        var atk = ofSide(players, attackSide).filter(function (p) { return p.pos !== 'GK'; });
        var shift = (ballT.y - 50) * 0.55;
        def.forEach(function (p) {
            p.ty = clamp(50 + shift + (p.baseY - 50) * 0.7, 6, 94);
        });
        var dfs = def.filter(function (p) { return p.pos === 'DF'; });
        if (dfs.length >= 2) {
            var mean = dfs.reduce(function (a, p) { return a + p.tx; }, 0) / dfs.length;
            dfs.forEach(function (p) { p.tx = lerp(p.tx, mean, 0.75); });
            var near = dfs.slice().sort(function (a, b) { return Math.abs(a.ty - ballT.y) - Math.abs(b.ty - ballT.y); })[0];
            if (near && Math.abs(near.ty - ballT.y) < 30) {
                placeAt(near, lerp(near.tx, ballT.x, 0.18), lerp(near.ty, ballT.y, 0.3));
            }
        }
        atk.forEach(function (p) {
            var wide = Math.abs(p.baseY - 50) > 22;
            var farSide = (p.baseY - 50) * (ballT.y - 50) < 0;
            if (wide && farSide) p.ty = clamp(lerp(p.ty, p.baseY, 0.6), 6, 94);
        });
    }

    // Después de colocar a los protagonistas: nadie del ataque (sin balón) se queda en fuera de juego
    // ni por detrás del portero, y los que no intervienen buscan un hueco lejos de su marca (desmarque).
    function naturalize(players, play, attack, ballT) {
        var dir = attack === 'home' ? 1 : -1;
        var defSide = attack === 'home' ? 'away' : 'home';
        var named = {};
        (play && play.players || []).forEach(function (n) { named[n] = true; });
        var def = ofSide(players, defSide);
        var gk = ofPos(def, 'GK')[0];
        var outfield = def.filter(function (p) { return p.pos !== 'GK'; });
        if (!outfield.length) return;
        var line = Math.max.apply(null, outfield.map(function (p) { return dir * p.tx; }));
        var ballD = dir * (ballT ? ballT.x : 50);
        var cap = Math.max(line, ballD) + 0.8;
        if (gk) cap = Math.min(cap, dir * gk.tx - 3.5);
        // Mano a mano: el atacante va solo; sus compañeros llegan por detrás de él.
        if (play && (play.kind === 'oneonone' || isOneOnOneText(play.text))) {
            var lead = ofSide(players, attack).filter(function (p) { return named[p.name]; })
                .reduce(function (a, p) { return Math.max(a, dir * p.tx); }, -999);
            if (lead > -999) cap = Math.min(cap, lead - 5);
        }
        ofSide(players, attack).forEach(function (p) {
            if (p.pos === 'GK' || named[p.name]) return;
            if (dir * p.tx > cap) p.tx = clamp(cap / dir - dir * 0.6, 2.2, 97.8);
            // Sin balón no se planta encima del balón.
            if (ballT && Math.hypot((p.tx - ballT.x) / 3.5, (p.ty - ballT.y) / 6) < 1) {
                p.ty = clamp(p.ty + (p.ty >= ballT.y ? 6 : -6), 8, 92);
            }
            // Desmarque: si tiene un rival encima y no participa, se separa hacia el hueco.
            if (p.pos === 'FW' || p.pos === 'AM' || p.pos === 'MF') {
                var m = null, md = 99;
                outfield.forEach(function (q) {
                    var dd = Math.hypot((q.tx - p.tx) / 6, (q.ty - p.ty) / 10);
                    if (dd < md) { md = dd; m = q; }
                });
                if (m && md < 0.9) {
                    var away = p.ty >= m.ty ? 1 : -1;
                    p.ty = clamp(p.ty + away * (0.9 - md) * 9, 8, 92);
                    if (dir * p.tx < cap - 2) p.tx = clamp(p.tx + dir * 1.2, 2.2, 97.8);
                }
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
                var back = Math.min(opts.approach ? (10 + i * 2) : (14 + i * 2.2), 24);
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

    // Formación de saque de centro: cada equipo en su campo, los rivales fuera del círculo central
    // y dos jugadores del equipo que saca junto al balón (uno sobre él y otro a su lado).
    var CIRCLE_RX = 9.15 / 105 * 100 + 1.6;   // radio del círculo en % de ancho (+ margen del disco)
    var CIRCLE_RY = 9.15 / 68 * 100 + 2.4;    // y en % de alto
    function setupKickoff(players, kicker) {
        kicker = kicker || 'home';
        players.forEach(function (p) {
            var own = p.side === 'home' ? p.baseX : 100 - p.baseX;   // 0 = su portería
            var x = 7 + (own - 7) * 0.58;                             // FW 74 -> ~46, MF 45 -> ~29
            if (p.pos === 'GK') x = 5.5;
            var y = 50 + (p.baseY - 50) * 1.05;
            placeAt(p, p.side === 'home' ? x : 100 - x, y);
            // Nadie pisa el campo rival.
            if (p.side === 'home') p.tx = Math.min(p.tx, 48.3);
            else p.tx = Math.max(p.tx, 51.7);
        });
        var team = ofSide(players, kicker).filter(function (p) { return p.pos !== 'GK'; });
        var order = ['FW', 'AM', 'MF', 'DM', 'DF'];
        team.sort(function (a, b) {
            var oa = order.indexOf(a.pos), ob = order.indexOf(b.pos);
            if (oa !== ob) return oa - ob;
            return Math.abs(a.baseY - 50) - Math.abs(b.baseY - 50);
        });
        var dir = kicker === 'home' ? 1 : -1;
        var taker = team[0], mate = team[1];
        if (taker) placeAt(taker, 50 - dir * 1.4, 50);
        if (mate) placeAt(mate, 50 - dir * 3.2, mate.baseY < 50 ? 41 : 59);
        // Los demás, fuera del círculo central (el que no saca, obligatoriamente).
        players.forEach(function (p) {
            if (p === taker || p === mate || p.pos === 'GK') return;
            var dx = (p.tx - 50) / CIRCLE_RX, dy = (p.ty - 50) / CIRCLE_RY;
            var r = Math.sqrt(dx * dx + dy * dy);
            if (r < 1.05) {
                if (r < 0.05) { dx = -dir; dy = 0.4; r = Math.sqrt(dx * dx + dy * dy); }
                p.tx = 50 + dx / r * CIRCLE_RX * 1.08;
                p.ty = 50 + dy / r * CIRCLE_RY * 1.08;
                if (p.side === 'home') p.tx = Math.min(p.tx, 48.3);
                else p.tx = Math.max(p.tx, 51.7);
            }
        });
        return { taker: taker, mate: mate };
    }

    // El árbitro, fuera del círculo y del lado del equipo que no saca (no tapa a los que sacan).
    function kickoffRefSpot(kicker) {
        return { x: kicker === 'away' ? 44 : 56, y: 70 };
    }

    function resetToBase(players) {
        players.forEach(function (p) { p.tx = p.baseX; p.ty = p.baseY; });
    }

    // Fase previa de saque de centro (inicio de cada parte): formación, toque y pase atrás.
    function kickoffLeadIn(players, kicker, highlight) {
        var phases = [];
        var info = setupKickoff(players, kicker);
        phases.push({ players: snapshotTargets(players), ballPath: [{ x: 50, y: 50 }], ms: 650, highlight: [], pose: false, kickoff: true, ref: refAvoid(kickoffRefSpot(kicker), snapshotTargets(players), { x: 50, y: 50 }) });
        var dir = kicker === 'home' ? 1 : -1;
        var recv = ofSide(players, kicker).filter(function (p) { return p.pos === 'MF' || p.pos === 'DM'; })
            .sort(function (a, b) { return Math.abs(a.ty - 50) - Math.abs(b.ty - 50); })[0];
        var path = [{ x: 50, y: 50 }];
        if (info.mate) path.push({ x: info.mate.tx, y: info.mate.ty });
        // Arrancan todos: medio camino entre la formación de saque y su sitio.
        players.forEach(function (p) {
            if (p === info.taker || p === info.mate) return;
            p.tx = lerp(p.tx, p.baseX, 0.45);
            p.ty = lerp(p.ty, p.baseY, 0.45);
        });
        // El que saca no conduce: toca atrás al compañero desde el centro, quieto, y luego se incorpora.
        if (info.taker) { info.taker.tx = 50 - dir * 1.4; info.taker.ty = 50; }
        if (recv === info.taker || recv === info.mate) recv = null;
        if (recv) { placeAt(recv, recv.tx - dir * 1.5, recv.ty); path.push({ x: recv.tx, y: recv.ty }); }
        phases.push({ players: snapshotTargets(players), ballPath: path, ms: 700, highlight: [], pose: false, kickoff: true, ref: (function () { var r = kickoffRefSpot(kicker); return { x: r.x + (kicker === 'away' ? -3 : 3), y: r.y - 2 }; })() });
        resetToBase(players);
        return phases;
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
        // Los expulsados ya no están en el campo (en directo se van andando a vestuarios).
        var red = {};
        (d.redCarded || []).forEach(function (n) { red[n] = true; });
        function onPitch(p) { return p && !red[p.name]; }
        var home = (d.homeStarters || []).filter(onPitch).map(copyPlayer);
        var away = (d.awayStarters || []).filter(onPitch).map(copyPlayer);
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
            var firstKicker = (parsedPlays[0] && parsedPlays[0].kickoffBefore) || 'home';
            setupKickoff(players, firstKicker);
            var kickPhases = [{ players: snapshotTargets(players), ballPath: [{ x: 50, y: 50 }], ms: 500, highlight: [], ref: kickoffRefSpot(firstKicker) }];
            return { phases: kickPhases };
        }
        var leadIn = play.kickoffBefore ? kickoffLeadIn(players, play.kickoffBefore, play.players || []) : [];
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
            naturalize(players, play, attack, ballT);
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
            naturalize(players, play, attack, ballT);
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
            setupKickoff(players, ballT.x > 50 ? 'away' : 'home');
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
            naturalize(players, play, attack, info.shot || ballT);
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
                setupKickoff(players, ballT.x > 50 ? 'away' : 'home');
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
            naturalize(players, play, attack, info.carrier ? { x: info.carrier.tx, y: info.carrier.ty } : ballT);
            separate(players);
            var passPath = [];
            (info.chain || []).forEach(function (p) { passPath.push({ x: p.tx, y: p.ty }); });
            if (info.carrier) passPath.push({ x: info.carrier.tx, y: info.carrier.ty });
            if (!passPath.length) passPath.push(ballT);
            phases.push({ players: snapshotTargets(players), ballPath: passPath, ms: 800, highlight: highlight });
        }
        attachReferee(phases, play, kind, ballT);
        if (leadIn.length) phases = leadIn.concat(phases);
        return { phases: phases, highlight: highlight };
    }

    function refereeSpot(kind, ballPt, typ) {
        var bx = (ballPt && ballPt.x != null) ? ballPt.x : 50;
        var by = (ballPt && ballPt.y != null) ? ballPt.y : 50;
        var spot;
        if (!kind || typ === 'kickoff') spot = { x: 56, y: 70 };
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

    // Aparta al árbitro de los jugadores y del balón (sigue cerca, pero sin tapar a nadie).
    function refAvoid(spot, phPlayers, ballPt) {
        var x = spot.x, y = spot.y, k, i, keys = Object.keys(phPlayers || {});
        var sf = sepFactor();
        var rx = 5.6 * sf, ry = 10 * sf;
        for (k = 0; k < 6; k++) {
            var moved = false;
            for (i = 0; i < keys.length; i++) {
                var q = phPlayers[keys[i]];
                var dx = (x - q.x) / rx, dy = (y - q.y) / ry;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (d < 1) {
                    if (d < 0.05) { dx = 0; dy = y < 50 ? -1 : 1; d = 1; }
                    x += dx / d * (1 - d) * rx * 1.05;
                    y += dy / d * (1 - d) * ry * 1.05;
                    moved = true;
                }
            }
            if (ballPt) {
                var bd = Math.hypot((x - ballPt.x) / 4, (y - ballPt.y) / 7);
                if (bd < 1) { y += (y >= ballPt.y ? 1 : -1) * (1 - bd) * 7; moved = true; }
            }
            x = clamp(x, 3, 97); y = clamp(y, 5, 95);
            if (!moved) break;
        }
        function clearance(px, py) {
            var best = 99;
            keys.forEach(function (kk) {
                var q = phPlayers[kk];
                best = Math.min(best, Math.hypot((px - q.x) / rx, (py - q.y) / ry));
            });
            return best;
        }
        if (clearance(x, y) >= 0.95 || !ballPt) return { x: x, y: y };
        // Zona apiñada: probar puntos alrededor de la jugada (en diagonal, como un árbitro real)
        // y quedarse con el más despejado, prefiriendo los más cercanos a la posición ideal.
        var bestPt = { x: x, y: y }, bestScore = clearance(x, y);
        [[-9, 14], [9, 14], [-9, -14], [9, -14], [-13, 6], [13, 6], [-13, -6], [13, -6], [-5, 20], [5, -20], [-16, 18], [16, -18]].forEach(function (o) {
            var cx = clamp(ballPt.x + o[0], 3, 97), cy = clamp(ballPt.y + o[1], 5, 95);
            var c = clearance(cx, cy) - Math.hypot(cx - spot.x, (cy - spot.y) * 0.6) * 0.012;
            if (c > bestScore) { bestScore = c; bestPt = { x: cx, y: cy }; }
        });
        return bestPt;
    }

    function attachReferee(phases, play, kind, ballT) {
        (phases || []).forEach(function (ph) {
            var pt = (ph.ballPath && ph.ballPath.length) ? ph.ballPath[ph.ballPath.length - 1] : (ballT || { x: 50, y: 50 });
            var typ = ph.pose === false ? 'kickoff' : (ph.pose ? 'celebrate' : '');
            ph.ref = refAvoid(refereeSpot(play ? kind : null, pt, typ), ph.players, pt);
        });
    }

    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    /* ================= Motor de movimiento continuo (sesiones 8-9) =================
       Estilo Championship Manager 2002/03: cada jugador, el árbitro y el balón tienen posición y
       velocidad propias y se mueven en cada fotograma (requestAnimationFrame) hacia su objetivo,
       acelerando y frenando. Nadie salta de sitio: si llega una jugada nueva a mitad de otra,
       cada uno cambia de rumbo desde donde está. El balón siempre está pegado al pie de alguien
       o viajando entre dos puntos (pase raso, pase bombeado, conducción o tiro).
       Solo el deslizador coloca el estado exacto de una jugada al instante. */
    var M_X = 1.05, M_Y = 0.68;                  // metros por cada 1 % de ancho / alto
    var SPD_MIN = 1.3, SPD_MAX = 9.2;            // m/s (andar ... esprintar), a tempo 1
    var BALL_SPEED = { ground: 15, lofted: 13, shot: 27, carry: 0, reset: 11 };
    var motor = {
        raf: 0, last: 0, running: false,
        phases: [], phase: null, phaseT: 0, phaseDur: 1,
        actions: [], action: null, actionT: 0,
        scale: 1, frame: 0, seekFrame: -1,
        stats: { plays: 0, cut: 0, droppedPhases: 0 }
    };

    function lineMs() {
        var sel = $('speedSelect');
        var v = sel ? parseInt(sel.value, 10) : 2000;
        return v > 0 ? v : 2000;
    }

    // Tempo: a más velocidad de narración, más rápido se mueve todo (para no quedarse atrás).
    function tempo() {
        if (simulating) return 1;
        return clamp(2000 / lineMs(), 0.55, 4);
    }

    function mDist(ax, ay, bx, by) {
        return Math.hypot((bx - ax) * M_X, (by - ay) * M_Y);
    }

    function allMovers() {
        var arr = Object.keys(playerState).map(function (k) { return playerState[k]; });
        return arr;
    }

    function setMoverTarget(st, tx, ty, durSec, opts) {
        opts = opts || {};
        var d = mDist(st.x, st.y, tx, ty);
        // Tiempo de reacción: los que intervienen arrancan ya; el resto, un poco después y escalonados.
        var react = opts.involved ? 0 : (opts.react != null ? opts.react : 0.05 + rng() * 0.25);
        // Los que intervienen llegan justo a tiempo (sin esperar parados con el balón); el resto, algo antes.
        var avail = Math.max(0.4, durSec * (opts.involved ? 0.92 : 0.7) - react);
        // Velocidad para llegar a tiempo: andando, trotando o esprintando según haga falta.
        var spd = clamp(d / avail, SPD_MIN, SPD_MAX);
        if (opts.jog) spd = Math.min(spd, Math.max(SPD_MIN, Math.min(4.6, d / Math.max(0.4, durSec * 0.9))));
        if (opts.cap) spd = Math.min(spd, opts.cap);
        st.pend = { tx: tx, ty: ty, spd: spd, at: nowMs() + react * 1000 / tempo() };
        st.hx = tx; st.hy = ty;
        st.idleAt = nowMs() + 900 + rng() * 1600;
        if (react <= 0) applyPending(st, nowMs());
    }

    function applyPending(st, now) {
        if (!st.pend || now < st.pend.at) return;
        st.tx = st.pend.tx; st.ty = st.pend.ty; st.spd = st.pend.spd;
        st.pend = null;
    }

    function stepMover(st, dt, tp) {
        if (st.vx == null) { st.vx = 0; st.vy = 0; }
        if (st.tx == null) { st.tx = st.x; st.ty = st.y; }
        var dx = (st.tx - st.x) * M_X, dy = (st.ty - st.y) * M_Y;
        var d = Math.hypot(dx, dy);
        var maxS = (st.spd || 3) * tp;
        var dec = 6.5 * tp;
        var want = d < 0.03 ? 0 : Math.min(maxS, Math.sqrt(2 * dec * d));
        var wx = d > 0 ? dx / d * want : 0, wy = d > 0 ? dy / d * want : 0;
        // Aceleración limitada: arranca y frena de forma progresiva.
        var acc = 11 * tp * dt;
        var ax = wx - st.vx, ay = wy - st.vy, al = Math.hypot(ax, ay);
        if (al > acc) { ax = ax / al * acc; ay = ay / al * acc; }
        st.vx += ax; st.vy += ay;
        st.x = clamp(st.x + st.vx * dt / M_X, -6, 106);
        st.y = clamp(st.y + st.vy * dt / M_Y, -12, 112);
        return d;
    }

    // Pequeños movimientos de espera: nadie se queda como una estatua mientras la jugada sigue.
    function idleWander(st, now, d) {
        if (st.hx == null || d > 0.6 || now < (st.idleAt || 0)) return;
        var r = st.pos === 'GK' ? 0.6 : 1.6;
        var a = rng() * Math.PI * 2, m = rng() * r;
        st.tx = clamp(st.hx + Math.cos(a) * m / M_X, 1, 99);
        st.ty = clamp(st.hy + Math.sin(a) * m / M_Y, 2, 98);
        st.spd = 1.2 + rng() * 0.8;
        st.idleAt = now + 1300 + rng() * 2200;
    }

    function holderOf(key) {
        return key ? playerState[key] || null : null;
    }

    function nearestPlayerTo(x, y, maxM, fromTargets) {
        var best = null, bd = maxM;
        Object.keys(playerState).forEach(function (k) {
            var st = playerState[k];
            var px = fromTargets ? (st.tx != null ? st.tx : st.x) : st.x;
            var py = fromTargets ? (st.ty != null ? st.ty : st.y) : st.y;
            var dd = mDist(px, py, x, y);
            if (dd < bd) { bd = dd; best = k; }
        });
        return best;
    }

    function isGoalPoint(pt) {
        return pt && (pt.x <= 3.5 || pt.x >= 96.5) && Math.abs(pt.y - 50) < 9;
    }

    // Traduce la ruta de balón de una fase (puntos) en acciones: conducir, pasar, chutar.
    function buildBallActions(ph) {
        var path = (ph.ballPath || []).slice();
        var targets = ph.players || {};
        var nodes = path.map(function (pt) {
            var best = null, bd = 2.8;
            Object.keys(targets).forEach(function (k) {
                var t = targets[k];
                var dd = mDist(t.x, t.y, pt.x, pt.y);
                if (dd < bd) { bd = dd; best = k; }
            });
            return { pt: pt, who: best };
        });
        var acts = [];
        if (simulating && ph.kickoff && path.length && mDist(ball.x, ball.y, path[0].x, path[0].y) > 6 && ball.state !== 'flight') {
            // Saque de centro: el balón vuelve al centro de un envío (nadie lo conduce 40 m).
            acts.push({ type: 'kick', pt: { x: path[0].x, y: path[0].y }, forceKind: 'reset' });
        }
        var prevWho = ball.state === 'held' ? ball.owner : null;
        var prevPt = { x: ball.x, y: ball.y };
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var next = nodes[i + 1];
            if (n.pt.kind) {
                // Desenlace planificado (remate fuera, al palo, por encima, rechace...).
                acts.push({ type: 'kick', pt: n.pt, shot: n.pt.kind === 'shot' || n.pt.kind === 'over', forceKind: n.pt.kind });
                prevWho = null; prevPt = n.pt;
                continue;
            }
            if (!n.who && next && !next.who && !isGoalPoint(n.pt)) continue;   // punto intermedio de una parábola
            var dist = mDist(prevPt.x, prevPt.y, n.pt.x, n.pt.y);
            if (n.who && n.who === prevWho) {
                acts.push({ type: 'carry', who: n.who, pt: n.pt });
            } else if (n.who) {
                acts.push({ type: 'pass', to: n.who, pt: n.pt, lofted: dist > 26 || !!(nodes[i - 1] && !nodes[i - 1].who && i > 0 && path.length > 2) });
            } else if (dist > 0.8 || i === nodes.length - 1) {
                acts.push({ type: 'kick', pt: n.pt, shot: isGoalPoint(n.pt) || ph.shootout, lofted: !isGoalPoint(n.pt) && (dist > 22 || i > 0 && path.length > 2) });
            }
            prevWho = n.who || null;
            prevPt = n.pt;
        }
        return acts;
    }

    function launchBall(to, kind, receiver) {
        var tp = tempo();
        var from = { x: ball.x, y: ball.y };
        var dist = Math.max(0.5, mDist(from.x, from.y, to.x, to.y));
        var base = BALL_SPEED[kind === 'over' ? 'shot' : kind] || 14;
        if (kind === 'lofted' || kind === 'ground' || kind === 'reset') base += Math.min(10, Math.max(0, dist - 20) * 0.2);   // los envíos largos van más fuertes
        var spd = Math.min(36, base * tp);   // tope: ni en «Turbo» el balón salta
        var dur = dist / spd + (kind === 'lofted' ? 0.25 / tp : 0);
        if (kind === 'shot' || kind === 'over') dur = Math.max(dur, 0.32);   // un remate siempre se ve salir
        var lo = ball.owner && playerState[ball.owner];
        ball.lastSide = lo ? lo.side : (simulating ? simAttackSide : ball.lastSide);
        ball.goalNet = false;
        if (simulating && kind === 'over') simEvent('over', to.x, to.y);
        var uLine = 0;
        if (kind === 'over') { var gxl = to.x > 50 ? 100 : 0; uLine = Math.abs(to.x - from.x) > 0.5 ? clamp(Math.abs(gxl - from.x) / Math.abs(to.x - from.x), 0.5, 0.97) : 0; }
        ball.state = 'flight';
        ball.owner = null;
        ball.lock = false;
        ball.fl = { at: simClock, from: from, to: { x: to.x, y: to.y }, t: 0, dur: dur, kind: kind, H: kind === 'lofted' ? clamp(dist / 30, 0.35, 1.1) : (kind === 'reset' ? 0.5 : (kind === 'over' ? 2.6 : 0)), receiver: receiver || null, uLine: uLine };
    }

    function startAction(a) {
        motor.action = a;
        motor.actionT = 0;
        if (!a) return;
        a.launched = false;
    }

    function stepAction(dt) {
        var a = motor.action;
        if (!a) {
            if (motor.actions.length) startAction(motor.actions.shift());
            return;
        }
        motor.actionT += dt;
        var tp = tempo();
        if (a.type === 'carry') {
            var who = holderOf(a.who);
            if (!who) { startAction(null); return; }
            if (ball.state !== 'held' || ball.owner !== a.who) {
                // El balón no lo tiene él: si está cerca lo controla; si no, se lo pasan.
                if (ball.state !== 'flight' && mDist(ball.x, ball.y, who.x, who.y) < 2.2) { ball.state = 'held'; ball.owner = a.who; }
                else if (ball.state !== 'flight') { launchBall({ x: who.tx, y: who.ty }, 'ground', a.who); }
            }
            var dd = mDist(who.x, who.y, who.tx, who.ty);
            if ((ball.owner === a.who && dd < 1.4) || motor.actionT > 3.2 / tp) startAction(null);
            return;
        }
        if (!a.launched) {
            // Preparación breve: el pasador se acomoda antes de soltarla.
            var owner = holderOf(ball.owner);
            var ready = !owner || mDist(owner.x, owner.y, owner.tx, owner.ty) < 2.5;
            if (ball.state === 'flight') return;
            // Pase al que cae en fuera de juego: sale cuando ya está por delante de la defensa.
            if (a.type === 'pass' && motor.phase && motor.phase.waitRecv === a.to && motor.actionT < 3.5) {
                var wr = holderOf(a.to);
                if (wr && (mDist(wr.x, wr.y, wr.tx, wr.ty) > 0.8 || motor.phaseT < 1.0)) return;
            }
            if ((ready && motor.actionT > 0.12 / tp) || motor.actionT > 0.9 / tp) {
                var to = a.pt;
                var recv = a.type === 'pass' ? holderOf(a.to) : null;
                if (recv) to = { x: recv.tx, y: recv.ty };
                var kind = a.forceKind || (a.shot ? 'shot' : (a.lofted ? 'lofted' : 'ground'));
                if (recv && owner && recv.side !== owner.side) kind = recv.pos === 'GK' ? 'shot' : 'ground';
                // Balón parado dentro del campo tras un remate (parada, rechace): es un balón suelto más, alguien lo recoge.
                if (simulating && ball.lock && !simRestart && !ball.goalNet && ball.state === 'free' && ball.x >= 0 && ball.x <= 100 && ball.y >= 0 && ball.y <= 100) ball.lock = false;
                // Balón suelto lejos del destino: antes de enviarlo, alguien va a por él (nunca viaja solo).
                if (simulating && a.forceKind !== 'reset' && !ball.lock && !owner && ball.state === 'free' && mDist(ball.x, ball.y, to.x, to.y) > 20 &&
                    ball.x > 0 && ball.x < 100 && ball.y > 0 && ball.y < 100 && (a.fetchT = (a.fetchT || 0) + dt) < 4) {
                    var fetch = a.fetcher && playerState[a.fetcher] ? a.fetcher : nearestOf(sideKeys(simAttackSide, true), ball.x, ball.y);
                    if (!a.fetcher && fetch && mDist(playerState[fetch].x, playerState[fetch].y, ball.x, ball.y) > 15) fetch = nearestOf(sideKeys('home', true).concat(sideKeys('away', true)), ball.x, ball.y) || fetch;
                    a.fetcher = fetch;
                    if (fetch) { var fs = playerState[fetch]; fs.tx = ball.x; fs.ty = ball.y; fs.hx = ball.x; fs.hy = ball.y; fs.pend = null; fs.spd = Math.max(fs.spd || 0, 7); }
                    return;
                }
                if (!a.forceKind && (ball.lock || (!owner && ball.state === 'free' && mDist(ball.x, ball.y, to.x, to.y) > 20))) kind = kind === 'shot' ? kind : 'reset';
                // Remate desde muy lejos: antes, un pase a un compañero a distancia de tiro (20-24 m).
                if (simulating && (kind === 'shot' || kind === 'over') && !a.approached && !simRestart && ball.x >= 0 && ball.x <= 100) {
                    var gxS = to.x > 50 ? 100 : 0, dG = mDist(ball.x, ball.y, gxS, 50);
                    if (dG > 30) {
                        a.approached = true;
                        var ux2 = (ball.x - gxS) * M_X, uy2 = (ball.y - 50) * M_Y, ul2 = Math.max(0.1, Math.hypot(ux2, uy2)), dS = 20 + rng() * 4;
                        var P = { x: gxS + ux2 / ul2 * dS / M_X, y: clamp(50 + uy2 / ul2 * dS / M_Y, 22, 78) };
                        var sideA = owner ? owner.side : simAttackSide;
                        var mate = nearestOf(sideKeys(sideA, true).filter(function (k) { return k !== ball.owner; }), P.x, P.y);
                        if (mate) setMoverTarget(playerState[mate], P.x, P.y, 0.6, { involved: true });
                        if (ball.owner) { ball.owner = null; ball.state = 'free'; }
                        launchBall(P, dG - dS > 25 ? 'lofted' : 'ground', mate);
                        motor.actionT = 0;
                        return;
                    }
                }
                launchBall(to, kind, a.type === 'pass' ? a.to : null);
                if ((a.shot && isGoalPoint(to)) || a.forceKind === 'over' || (a.forceKind === 'shot' && (to.x > 100.5 || to.x < -0.5))) ball.fl.net = true;
                if (a.pt && a.pt.touch === 'def') ball.lastSide = oppOf(simAttackSide);
                a.launched = true;
                motor.actionT = 0;
            }
            return;
        }
        if (ball.state !== 'flight') startAction(null);
    }

    function stepBall(dt) {
        if (ball.state === 'flight' && ball.fl) {
            var f = ball.fl;
            f.t += dt;
            var u = clamp(f.t / f.dur, 0, 1);
            // Pase raso: sale fuerte y se frena por el rozamiento. Bombeado y tiro: velocidad casi constante.
            var e = f.kind === 'ground' ? 1 - Math.pow(1 - u, 1.6) : u;
            ball.x = lerp(f.from.x, f.to.x, e);
            ball.y = lerp(f.from.y, f.to.y, e);
            // Por encima del larguero: sube hasta pasada la portería y cae ya detrás de ella.
            if (f.kind === 'over' && f.uLine > 0 && f.uLine < 1) ball.h = f.H * (u < f.uLine ? Math.sin(Math.PI / 2 * u / f.uLine) : Math.cos(Math.PI / 2 * (u - f.uLine) / (1 - f.uLine)));   // lo más alto, justo sobre el larguero
            else ball.h = f.H ? Math.sin(Math.PI * u) * f.H : 0;
            if (u >= 1) {
                ball.state = 'free';
                ball.h = 0;
                ball.lock = !!f.net || !!f.keep;
                if (f.net && simulating && simGoalPlay && Math.abs(f.to.y - 50) < 6) ball.goalNet = true;
                ball.fl = null;
            }
            return;
        }
        if (ball.state === 'held') {
            var o = holderOf(ball.owner);
            if (!o) { ball.state = 'free'; return; }
            if (o.throwing) { ball.x = o.x; ball.y = o.y; ball.h = 0.62; return; }   // saque de banda: balón sobre la cabeza
            var sp = Math.hypot(o.vx || 0, o.vy || 0);
            var fx, fy;
            if (sp > 0.4) { fx = o.vx / sp; fy = o.vy / sp; }
            else { fx = o.side === 'home' ? 1 : -1; fy = 0; }
            // Conducción: toques cortos. Con el jugador en carrera el balón se adelanta y vuelve al pie.
            o.touch = (o.touch || 0) + dt * (sp > 2 ? 1.6 + sp * 0.18 : 0);
            var reach = sp > 2 ? 0.7 + 0.9 * Math.abs(Math.sin(o.touch * Math.PI)) : 0.75;
            var tx = o.x + fx * reach / M_X, ty = o.y + fy * reach / M_Y;
            var k = Math.min(1, dt * 14);
            ball.x += (tx - ball.x) * k;
            ball.y += (ty - ball.y) * k;
            ball.h = 0;
            return;
        }
        // Balón suelto: lo controla el primero que llega (salvo si está dentro de la red).
        if (!ball.lock) {
            var near = nearestPlayerTo(ball.x, ball.y, 1.5, false);
            if (near) { ball.state = 'held'; ball.owner = near; if (playerState[near]) ball.lastSide = playerState[near].side; }
        }
    }

    function startMotorPhase(ph) {
        motor.phase = ph;
        motor.phaseT = 0;
        if (!ph) return;
        var dur = Math.max(0.35, (ph.ms || 700) / 1000 * motor.scale);
        motor.phaseDur = dur;
        var targets = ph.players || {};
        var involved = {};
        (ph.highlight || []).forEach(function (n) { involved[n] = true; });
        (ph.ballPath || []).forEach(function (pt) {
            var k = nearestPlayerTo(pt.x, pt.y, 2.8, true);
            if (k) involved[k] = true;
        });
        if (ball.owner) involved[ball.owner] = true;
        Object.keys(playerState).forEach(function (k) {
            var st = playerState[k];
            var t = targets[k];
            if (!t) return;
            var inv = involved[k] || involved[st.name];
            if (st.hold) { st.hx = t.x; st.hy = t.y; return; }   // atendido por las asistencias
            // Vuelta a la posición (tras gol, falta, saque...): se vuelve trotando, sin prisas.
            var celeb = ph.pose === true && ph.goal && k.split(':')[0] === ph.goal;   // corren a abrazar al goleador
            setMoverTarget(st, t.x, t.y, celeb ? Math.min(dur, 1.9) : dur, { involved: inv || celeb, jog: ph.pose === false && !ph.kickoff, cap: ph.spdCap && ph.spdCap[k] });
        });
        if (ph.ref) {
            refState.tx = ph.ref.x; refState.ty = ph.ref.y; refState.hx = ph.ref.x; refState.hy = ph.ref.y;
            refState.spd = clamp(mDist(refState.x, refState.y, ph.ref.x, ph.ref.y) / Math.max(0.4, dur * 0.8), SPD_MIN, 7.5);
        }
        if (!simulating) {
            if (ph.highlight) highlightPlayers(ph.highlight);
            if (ui.caption) ui.caption.classList.toggle('kickoff-on', !!ph.kickoff);
        }
        motor.actions = buildBallActions(ph);
        startAction(null);
        if (simulating) {
            var kp = ph.ballPath || [];
            if (ph.kickoff || (ph.pose === false && kp.length === 1 && kp[0].x === 50 && kp[0].y === 50)) {
                var lastK = simEvents.filter(function (e) { return e.type === 'kickoff'; }).pop();
                if (!lastK || simNs - lastK.s > 30) simEvent('kickoff', 50, 50);
            }
            if (ph.protest) startProtest(ph.protest.side, ph.protest.n || 3);
            if (ph.appeal) startAppeal(ph.appeal);
            if (ph.setPiece) beginRestart(ph.setPiece);
        }
    }

    function snapMotorPhase(ph) {
        if (!ph) return;
        var targets = ph.players || {};
        Object.keys(playerState).forEach(function (k) {
            var st = playerState[k];
            var t = targets[k];
            if (!t) return;
            st.x = t.x; st.y = t.y; st.tx = t.x; st.ty = t.y; st.hx = t.x; st.hy = t.y; st.vx = 0; st.vy = 0; st.pend = null;
            st.idleAt = performance.now() + 600 + Math.random() * 1500;
            placePlayerEl(st);
        });
        if (ph.ref) {
            refState.x = ph.ref.x; refState.y = ph.ref.y; refState.tx = ph.ref.x; refState.ty = ph.ref.y;
            refState.hx = ph.ref.x; refState.hy = ph.ref.y; refState.vx = 0; refState.vy = 0;
            placeRefEl();
        }
        var end = (ph.ballPath && ph.ballPath.length) ? ph.ballPath[ph.ballPath.length - 1] : { x: ball.x, y: ball.y };
        ball.x = end.x; ball.y = end.y; ball.h = 0; ball.fl = null;
        var near = nearestPlayerTo(end.x, end.y, 2.8, false);
        if (near && !isGoalPoint(end)) { ball.state = 'held'; ball.owner = near; }
        else { ball.state = 'free'; ball.owner = null; ball.lock = isGoalPoint(end); }
        placeBall();
        if (ph.highlight) highlightPlayers(ph.highlight);
        if (ui.caption) ui.caption.classList.toggle('kickoff-on', !!ph.kickoff);
        motor.phase = null;
        motor.phases = [];
        motor.actions = [];
        motor.action = null;
        motor.seekFrame = motor.frame;
        window.__seeking = true;   // marca para el medidor de fluidez: este salto es del deslizador
    }

    function motorTick(now) {
        motor.raf = requestAnimationFrame(motorTick);
        var dt = motor.last ? (now - motor.last) / 1000 : 0.016;
        motor.last = now;
        if (document.hidden || !built) return;
        if (window.__seeking && motor.frame > motor.seekFrame) window.__seeking = false;
        dt = clamp(dt, 0, 0.05);
        motor.frame++;
        if (tl) { tlFrame(dt); return; }
        var tp = tempo();
        // Fase actual: cuando termina (tiempo cumplido y balón entregado) empieza la siguiente.
        if (motor.phase) {
            motor.phaseT += dt;
            stepAction(dt);
            var ballBusy = motor.action || motor.actions.length || ball.state === 'flight';
            if (motor.phaseT >= motor.phaseDur && !ballBusy) {
                startMotorPhase(motor.phases.length ? motor.phases.shift() : null);
            } else if (motor.phaseT > motor.phaseDur + 4 / tp) {
                motor.actions = []; motor.action = null;
                startMotorPhase(motor.phases.length ? motor.phases.shift() : null);
            }
        }
        var allowIdle = !motor.phase || motor.phaseT > motor.phaseDur * 0.9;
        Object.keys(playerState).forEach(function (k) {
            var st = playerState[k];
            if (st.x == null) return;
            if (st.pend) applyPending(st, now);
            var d = stepMover(st, dt, tp);
            if (allowIdle && !st.hold && !(motor.phase && motor.phase.pose)) idleWander(st, now, d);
            placePlayerEl(st);
        });
        if (refState.el) {
            stepMover(refState, dt, tp);
            placeRefEl();
        }
        stepBall(dt);
        placeBall();
        stepLeavers(dt, tp);
        stepScenes(dt, tp);
        stepManagers(dt, now);
    }

    function ensureMotor() {
        if (motor.running) return;
        motor.running = true;
        motor.last = 0;
        motor.raf = requestAnimationFrame(motorTick);
    }

    // Compatibilidad: inicia una fase (animada) o la coloca al instante.
    function startPhase(phase, immediate) {
        ensureMotor();
        if (immediate) snapMotorPhase(phase);
        else { motor.phases = []; startMotorPhase(phase); }
    }

    function playLines(play) {
        if (!play) return 3;
        if (play.lines && play.lines.length) return play.lines.length;
        if (!play.text) return 3;
        return Math.max(1, String(play.text).split('\n').filter(function (l) { return l.trim(); }).length);
    }

    function playResolved(play, d, immediate) {
        ensureMotor();
        setEnds(periodOf(play), immediate);
        if (immediate) resetStaff();
        var resolved = resolvePlay(play, d);
        var phases = resolved.phases || [];
        if (!phases.length) return;
        if (immediate) {
            // Deslizador: estado exacto de la pose característica (celebración, llegada...), al instante.
            var pose = null;
            for (var pi = phases.length - 1; pi >= 0; pi--) {
                if (phases[pi].pose !== false) { pose = phases[pi]; break; }
            }
            snapMotorPhase(pose || phases[phases.length - 1]);
            return;
        }
        // Repartir las fases a lo largo de lo que dura la narración de la jugada.
        var avail = playLines(play) * lineMs() / 1000 * 0.75;
        var sum = phases.reduce(function (a, p) { return a + (p.ms || 700) / 1000; }, 0);
        motor.scale = clamp(avail / Math.max(0.3, sum), 0.6, 4.5);
        motor.stats.plays++;
        if (motor.phases.length || motor.phase) motor.stats.cut++;
        motor.stats.droppedPhases += motor.phases.length;
        motor.phases = phases.slice(1);
        startMotorPhase(phases[0]);
        playEvents(play, d);
    }

    function placeBall() {
        if (!ballEl) return;
        var p = toView(ball.x, ball.y);
        var bk = 1 + (nodeScale - 1) * 0.8;
        var h = ball.h || 0;
        // Balón bombeado: sube (se dibuja más arriba y más grande) y su sombra queda en el suelo.
        var lift = h * 26 * bk;
        var sc = bk * (1 + h * 0.45);
        ballEl.setAttribute('transform', 'translate(' + p.x.toFixed(2) + ',' + (p.y - lift).toFixed(2) + ')' + (sc !== 1 ? ' scale(' + sc.toFixed(3) + ')' : ''));
        if (ballShadowEl) {
            ballShadowEl.setAttribute('transform', 'translate(' + p.x.toFixed(2) + ',' + (p.y + 6 * bk).toFixed(2) + ') scale(' + (bk * (1 - h * 0.35)).toFixed(3) + ')');
            ballShadowEl.setAttribute('opacity', h > 0.02 ? (0.45 - h * 0.15).toFixed(2) : '0');
        }
    }

    function placeRefEl() {
        if (!refState || !refState.el) return;
        var p = toView(refState.x, refState.y);
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
        var p = toView(st.x, st.y);
        st.el.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')' + (nodeScale !== 1 ? ' scale(' + nodeScale.toFixed(3) + ')' : ''));
    }

    /* ================= Sesión 10: cambio de campo, banquillos, cambios, expulsiones, lesiones y entrenadores =================
       Coordenadas: el motor trabaja en coordenadas «lógicas» (el local siempre ataca hacia x=100). Al cambiar de campo
       (descanso, inicio de la prórroga y su descanso) solo cambia cómo se dibuja: la vista gira 180°. En ese instante
       el estado lógico se refleja también, de modo que en pantalla nadie se mueve de golpe: los jugadores caminan
       hacia su nueva mitad. Banquillos, entrenadores y asistencias están fuera del campo, en la banda de abajo, y no
       giran (los banquillos no cambian de sitio en el descanso). */
    var ends = { flipped: false, period: 1, labels: null, bannerEl: null };
    var offLayer = null, benchLayer = null, staffLayer = null;
    var leavers = {};                     // jugadores que salen del campo (cambio o expulsión)
    var benchOut = { home: [], away: [] }; // sustituidos que ya se han sentado en el banquillo
    var scenes = [];                      // escenas en curso (lesión con asistencias y camilla)
    var managers = { home: null, away: null };
    var benchSig = '';
    var BENCH = { home: { x: 30, y: 103.1 }, away: { x: 70, y: 103.1 } };
    var MANAGER_SPOT = { home: { x: 42.5, y: 102.2 }, away: { x: 57.5, y: 102.2 } };

    function visOf(x, y) { return ends.flipped ? { x: 100 - x, y: 100 - y } : { x: x, y: y }; }
    function logOf(x, y) { return visOf(x, y); }           // la simetría es su propia inversa
    function toView(x, y) { var v = visOf(x, y); return toSvg(v.x, v.y); }

    function periodOf(play) {
        if (!play) return 1;
        if (play.kind === 'shootout' || play.kind === 'shootout-kick') return ends.period;
        var m = parseInt(String(play.minute || '').split('+')[0], 10);
        if (isNaN(m)) return ends.period;
        if (m <= 45) return 1;
        if (m <= 90) return 2;
        if (m <= 105) return 3;
        return 4;
    }

    function mirrorObj(o) {
        if (!o) return;
        if (o.x != null) { o.x = 100 - o.x; o.y = 100 - o.y; }
        if (o.tx != null) { o.tx = 100 - o.tx; o.ty = 100 - o.ty; }
        if (o.hx != null) { o.hx = 100 - o.hx; o.hy = 100 - o.hy; }
        if (o.vx != null) { o.vx = -o.vx; o.vy = -o.vy; }
        if (o.pend) { o.pend.tx = 100 - o.pend.tx; o.pend.ty = 100 - o.pend.ty; }
    }

    function setEnds(period, immediate) {
        var flip = period % 2 === 0;
        var changed = flip !== ends.flipped;
        ends.period = period;
        if (!changed) return;
        if (!immediate) {
            Object.keys(playerState).forEach(function (k) { mirrorObj(playerState[k]); });
            Object.keys(leavers).forEach(function (k) { mirrorObj(leavers[k]); });
            mirrorObj(refState);
            ball.x = 100 - ball.x; ball.y = 100 - ball.y;
            if (ball.fl) { mirrorObj(ball.fl.from); mirrorObj(ball.fl.to); }
        }
        ends.flipped = flip;
        if (ends.labels) {
            ends.labels[0].textContent = flip ? 'Visitante' : 'Local';
            ends.labels[1].textContent = flip ? 'Local' : 'Visitante';
        }
        if (!immediate) showBanner(period === 3 ? 'Prórroga · cambio de campo' : 'Cambio de campo');
    }

    function showBanner(text) {
        if (!offLayer) return;
        if (ends.bannerEl && ends.bannerEl.parentNode) ends.bannerEl.parentNode.removeChild(ends.bannerEl);
        var p = toSvg(50, 8);
        var g = svgEl('g', { 'class': 'campo-banner', transform: 'translate(' + p.x + ',' + p.y + ')' });
        var bw = Math.max(240, Math.min(1000, text.length * 8.6 + 40));
        g.appendChild(svgEl('rect', { x: -bw / 2, y: -17, width: bw, height: 30, rx: 15, fill: 'rgba(10,20,15,0.78)', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1.5 }));
        var t = svgEl('text', { x: 0, y: 4, 'text-anchor': 'middle', fill: '#fff', 'font-size': 15, 'font-weight': 700, 'font-family': 'Segoe UI, sans-serif' });
        t.textContent = text;
        g.appendChild(t);
        offLayer.appendChild(g);
        ends.bannerEl = g;
        setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 3200);
    }

    /* ---- Banquillos ---- */
    function teamColorsOf(side, d) {
        return (side === 'home' ? d.homeColors : d.awayColors) || { primary: '#333', secondary: '#fff' };
    }

    function benchNames(side, d) {
        if (tl && pb.seg) {
            var sg = pb.seg.bench ? pb.seg : (pb.seg.i === -2 ? tl.segs[tl.segs.length - 2] : tl.segs[1]);
            if (sg && sg.bench) {
                benchOut[side] = (sg.out && sg.out[side]) ? sg.out[side].slice() : [];
                return sg.bench[side].slice();
            }
        }
        var subs = ((side === 'home' ? d.homeSubs : d.awaySubs) || []).map(function (p) { return p.name; });
        var onPitch = {};
        Object.keys(playerState).forEach(function (k) { onPitch[k] = true; });
        var list = subs.filter(function (n) { return !onPitch[keyOf(side, n)] && !leavers[keyOf(side, n)]; });
        benchOut[side].forEach(function (n) { if (list.indexOf(n) === -1 && !onPitch[keyOf(side, n)]) list.push(n); });
        return list;
    }

    function drawBenches(d) {
        if (!benchLayer || !d) return;
        var data = ['home', 'away'].map(function (side) { return { side: side, names: benchNames(side, d) }; });
        var sig = JSON.stringify(data) + nodeScale.toFixed(2) + (pitchBoxWidth() < 520 ? 'n' : 'w') + (teamColorsOf('home', d).primary) + (teamColorsOf('away', d).primary);
        if (sig === benchSig) return;
        benchSig = sig;
        benchLayer.innerHTML = '';
        // En pantallas estrechas el banquillo se dibuja bastante más grande (en móvil apenas se veía).
        var narrowB = pitchBoxWidth() > 0 && pitchBoxWidth() < 520;
        var k = narrowB ? Math.max(2.1, nodeScale * 1.1) : 1 + (nodeScale - 1) * 0.6;
        data.forEach(function (b) {
            var c = toSvg(BENCH[b.side].x, BENCH[b.side].y);
            if (narrowB) { c.y = Math.min(c.y, 752 - 13 * k); }
            var n = Math.max(5, b.names.length);
            var step = 21 * k;
            var w = n * step + 12;
            var g = svgEl('g', { 'class': 'campo-bench', 'data-side': b.side });
            g.appendChild(svgEl('rect', { x: c.x - w / 2, y: c.y - 12 * k, width: w, height: 24 * k, rx: 6, fill: 'rgba(0,0,0,0.38)', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 1 }));
            var kit = kitStyle(teamColorsOf(b.side, d));
            b.names.forEach(function (name, i) {
                var x = c.x - (b.names.length - 1) * step / 2 + i * step;
                var out = benchOut[b.side].indexOf(name) !== -1;
                var dot = svgEl('g', { 'class': 'campo-bench-player' + (out ? ' is-out' : ''), transform: 'translate(' + x.toFixed(1) + ',' + c.y.toFixed(1) + ') scale(' + k.toFixed(3) + ')', opacity: out ? 0.55 : 1 });
                var title = svgEl('title', {});
                title.textContent = name + (out ? ' (sustituido)' : ' (suplente)');
                dot.appendChild(title);
                dot.appendChild(svgEl('circle', { r: 8.5, fill: kit.fill, stroke: kit.ring, 'stroke-width': 2 }));
                var t = svgEl('text', { y: 3.6, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 700, fill: kit.ink, 'font-family': 'Segoe UI, sans-serif' });
                t.textContent = String(assignNumber(b.side, name));
                dot.appendChild(t);
                g.appendChild(dot);
            });
            benchLayer.appendChild(g);
        });
    }

    function benchSpotLogical(side) {
        var b = BENCH[side];
        return logOf(b.x + (side === 'home' ? 6 : -6), 101.5);
    }

    /* ---- Salidas (cambio o expulsión) y entradas ---- */
    function startLeaving(k, st, why, force) {
        var target;
        if (!force) {
            // Si las asistencias lo están atendiendo, primero se lo llevan en camilla; luego va al banquillo.
            var sc = scenes.filter(function (x) { return x.key === k && x.stage < 4; })[0];
            if (sc) {
                sc.subbed = why;
                delete playerState[k];
                if (ball.owner === k) { ball.state = 'free'; ball.owner = null; }
                return;
            }
        }
        if (why === 'red') target = logOf(50, 106);          // vestuarios: túnel en el centro de la banda
        else target = benchSpotLogical(st.side);
        st.leaving = why;
        st.pend = null;
        st.tx = target.x; st.ty = target.y; st.hx = null;
        st.spd = why === 'red' ? 1.5 : 3;                      // el expulsado se va andando; el cambiado, al trote
        st.leaveT = 0;
        if (st.el) {
            st.el.setAttribute('data-leaving', why);
            st.el.classList.add('campo-leaving');
            if (why === 'red') st.el.classList.add('campo-sent-off');
        }
        leavers[k] = st;
        delete playerState[k];
        if (ball.owner === k) { ball.state = 'free'; ball.owner = null; }
    }

    function stepLeavers(dt, tp) {
        Object.keys(leavers).forEach(function (k) {
            var st = leavers[k];
            st.leaveT += dt;
            var d = stepMover(st, dt, Math.min(tp, 2.5));
            var v = visOf(st.x, st.y);
            if (st.el && v.y > 100.5) st.el.style.opacity = String(clamp(1 - (v.y - 100.5) / 5, 0, 1).toFixed(2));
            placePlayerEl(st);
            if (d < 0.6 || st.leaveT > 25) finishLeaving(k);
        });
    }

    function finishLeaving(k) {
        var st = leavers[k];
        if (!st) return;
        if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el);
        if (st.leaving === 'sub' && benchOut[st.side].indexOf(st.name) === -1) benchOut[st.side].push(st.name);
        delete leavers[k];
        benchSig = '';
        var d = data();
        if (d) drawBenches(d);
    }

    function clearLeavers() {
        Object.keys(leavers).forEach(function (k) {
            var st = leavers[k];
            if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el);
            if (st.leaving === 'sub' && benchOut[st.side].indexOf(st.name) === -1) benchOut[st.side].push(st.name);
        });
        leavers = {};
        benchSig = '';
    }

    function leaveReason(st, play, d) {
        if (d && (d.redCarded || []).indexOf(st.name) !== -1) return 'red';
        var t = String((play && play.text) || '').toLowerCase();
        var last = String(st.name || '').toLowerCase().split(' ').pop();
        if (/tarjeta roja|cartulina roja|ve la roja|la roja|expulsad|segunda amarilla|se marcha/.test(t) && (!last || t.indexOf(last) !== -1 || (play && play.kind === 'red'))) return 'red';
        return 'sub';
    }

    /* ---- Lesión: asistencias y camilla ---- */
    function injuredKey(play) {
        var text = String((play && play.text) || '');
        var m = text.match(/([^\n.:;!¡]+?)\s+(?:cae lesionado|se duele|se ha lesionado|está lesionado)/i);
        var cand = m ? m[1].trim().toLowerCase() : '';
        var best = null;
        Object.keys(playerState).forEach(function (k) {
            var n = String(playerState[k].name || '').toLowerCase();
            if (!n) return;
            var last = n.split(' ').pop();
            if (cand && (cand.indexOf(n) !== -1 || (last.length > 2 && cand.indexOf(last) !== -1))) best = best || k;
        });
        if (!best && play && play.players) {
            play.players.forEach(function (name) {
                Object.keys(playerState).forEach(function (k) { if (!best && playerState[k].name === name) best = k; });
            });
        }
        return best;
    }

    function staffNode(kind) {
        var g = svgEl('g', { 'class': 'campo-staff campo-' + kind });
        if (kind === 'medic') {
            g.appendChild(svgEl('circle', { r: 9, fill: '#ffffff', stroke: '#b91c1c', 'stroke-width': 2 }));
            g.appendChild(svgEl('rect', { x: -1.8, y: -5.5, width: 3.6, height: 11, fill: '#dc2626' }));
            g.appendChild(svgEl('rect', { x: -5.5, y: -1.8, width: 11, height: 3.6, fill: '#dc2626' }));
        } else if (kind === 'stretcher') {
            g.appendChild(svgEl('rect', { x: -22, y: -8, width: 44, height: 16, rx: 4, fill: 'rgba(255,255,255,0.92)', stroke: '#7f1d1d', 'stroke-width': 1.5 }));
            g.appendChild(svgEl('line', { x1: -27, y1: -6, x2: 27, y2: -6, stroke: '#4b5563', 'stroke-width': 2 }));
            g.appendChild(svgEl('line', { x1: -27, y1: 6, x2: 27, y2: 6, stroke: '#4b5563', 'stroke-width': 2 }));
        }
        return g;
    }

    function placeStaff(o) {
        var p = toSvg(o.x, o.y);
        var k = 1 + (nodeScale - 1) * 0.7;
        o.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')' + (o.rot ? ' rotate(' + o.rot + ')' : '') + ' scale(' + k.toFixed(3) + ')');
    }

    function startInjury(play, d) {
        var k = injuredKey(play);
        if (!k || !staffLayer) return;
        if (scenes.some(function (s) { return s.key === k; })) return;
        var st = playerState[k];
        var text = String(play.text || '').toLowerCase();
        var w = text.match(/lesi[oó]n de (\d+) semana/);
        var serious = /camilla|no puede seguir|grave|retirado/.test(text) || (w ? parseInt(w[1], 10) >= 2 : /cae lesionado/.test(text));
        st.hold = true;
        st.pend = null;
        st.tx = st.x; st.ty = st.y;
        if (st.el) st.el.classList.add('campo-down');
        var v = visOf(st.x, st.y);
        var bench = BENCH[st.side];
        var medics = [-1, 1].map(function (s) {
            var o = { x: bench.x + s * 2, y: 102.2, vx: 0, vy: 0, spd: 5.5, el: staffNode('medic') };
            o.tx = o.x; o.ty = o.y;
            staffLayer.appendChild(o.el);
            placeStaff(o);
            return o;
        });
        scenes.push({ type: 'injury', key: k, st: st, serious: serious, stage: 0, t: 0, medics: medics, stretcher: null, side: st.side });
    }

    function stepScenes(dt, tp) {
        var tq = Math.min(tp, 3);
        scenes = scenes.filter(function (sc) {
            sc.t += dt;
            var st = sc.st;
            var alive = playerState[sc.key] === st || !!sc.subbed;
            if (!alive && sc.stage < 4) sc.stage = 4;
            var v = visOf(st.x, st.y);
            if (sc.stage === 0 && sc.t > 0.6 / tq) {
                // Las asistencias salen corriendo desde su banquillo hacia el jugador.
                sc.medics.forEach(function (m, i) { m.tx = clamp(v.x + (i ? 1.6 : -1.6), 1, 99); m.ty = clamp(v.y + 1.2, 1, 99); m.spd = 5.5; });
                sc.stage = 1; sc.t = 0;
            } else if (sc.stage === 1) {
                var arrived = sc.medics.every(function (m) { return mDist(m.x, m.y, m.tx, m.ty) < 0.7; });
                if (arrived || sc.t > 9 / tq) { sc.stage = 2; sc.t = 0; }
            } else if (sc.stage === 2 && sc.t > 1.8 / tq) {
                if (sc.serious) {
                    // Camilla: se lo llevan hasta la banda, despacio.
                    sc.stretcher = { x: v.x, y: v.y, vx: 0, vy: 0, el: staffNode('stretcher') };
                    staffLayer.insertBefore(sc.stretcher.el, staffLayer.firstChild);
                    var exitX = clamp(v.x, 8, 92);
                    sc.exit = { x: exitX, y: 101.6 };
                    sc.stage = 3; sc.t = 0;
                    if (st.el) st.el.classList.add('campo-on-stretcher');
                } else {
                    sc.stage = 4; sc.t = 0;
                    st.hold = false;
                    if (st.hx != null) { st.tx = st.hx; st.ty = st.hy; st.spd = 2.5; }
                    if (st.el) st.el.classList.remove('campo-down');
                }
            } else if (sc.stage === 3) {
                var sp = 1.8 * tq * dt;
                var dx = (sc.exit.x - v.x) * M_X, dy = (sc.exit.y - v.y) * M_Y, dd = Math.hypot(dx, dy);
                if (dd > 0.2) {
                    var nx = v.x + dx / dd * Math.min(sp, dd) / M_X, ny = v.y + dy / dd * Math.min(sp, dd) / M_Y;
                    var lg = logOf(nx, ny);
                    st.x = lg.x; st.y = lg.y; st.tx = lg.x; st.ty = lg.y; st.vx = 0; st.vy = 0;
                    v = { x: nx, y: ny };
                }
                placePlayerEl(st);
                sc.stretcher.x = v.x; sc.stretcher.y = v.y;
                sc.medics[0].x = sc.medics[0].tx = v.x - 3.2; sc.medics[0].y = sc.medics[0].ty = v.y;
                sc.medics[1].x = sc.medics[1].tx = v.x + 3.2; sc.medics[1].y = sc.medics[1].ty = v.y;
                if (dd <= 0.2 || sc.t > 30) {
                    sc.stage = 4; sc.t = 0;
                    // Fuera del campo: si no lo sustituyen, vuelve cuando el árbitro lo autoriza.
                    sc.returnAt = 6 / tq;
                }
            } else if (sc.stage === 4) {
                if (sc.stretcher && sc.stretcher.el) { sc.stretcher.el.remove(); sc.stretcher = null; }
                if (sc.subbed) {
                    st.hold = false;
                    if (st.el) st.el.classList.remove('campo-down');
                    startLeaving(sc.key, st, sc.subbed, true);
                    sc.returnAt = 0; sc.subbed = null;
                }
                sc.medics.forEach(function (m) { var b = BENCH[sc.side]; m.tx = b.x; m.ty = 102.4; m.spd = 3; });
                if (st.el) st.el.classList.remove('campo-on-stretcher');
                sc.stage = 5; sc.t = 0;
            } else if (sc.stage === 5) {
                if (sc.returnAt && sc.t > sc.returnAt && playerState[sc.key] === st) {
                    st.hold = false;
                    if (st.hx != null) { st.tx = st.hx; st.ty = st.hy; st.spd = 3; }
                    if (st.el) st.el.classList.remove('campo-down');
                    sc.returnAt = 0;
                }
                var home = sc.medics.every(function (m) { return mDist(m.x, m.y, m.tx, m.ty) < 0.8; });
                if (home && !sc.returnAt) {
                    sc.medics.forEach(function (m) { if (m.el) m.el.remove(); });
                    if (playerState[sc.key] === st && st.hold && !sc.serious) st.hold = false;
                    return false;
                }
            }
            sc.medics.forEach(function (m) { if (sc.stage !== 3) stepMover(m, dt, tq); placeStaff(m); });
            if (sc.stretcher) placeStaff(sc.stretcher);
            return true;
        });
    }

    function clearScenes() {
        scenes.forEach(function (sc) {
            sc.medics.forEach(function (m) { if (m.el) m.el.remove(); });
            if (sc.stretcher && sc.stretcher.el) sc.stretcher.el.remove();
            if (sc.st) { sc.st.hold = false; if (sc.st.el) sc.st.el.classList.remove('campo-down', 'campo-on-stretcher'); }
        });
        scenes = [];
    }

    /* ---- Entrenadores en la banda ---- */
    function buildManager(side, d) {
        var kit = kitStyle(teamColorsOf(side, d));
        var g = svgEl('g', { 'class': 'campo-manager', 'data-side': side });
        var title = svgEl('title', {});
        title.textContent = 'Entrenador de ' + ((side === 'home' ? d.homeTeam : d.awayTeam) || '');
        g.appendChild(title);
        var body = svgEl('g', { 'class': 'campo-manager-body' });
        body.appendChild(svgEl('circle', { r: 10.5, fill: '#1f2937', stroke: kit.fill, 'stroke-width': 3 }));
        var t = svgEl('text', { y: 3.8, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 800, fill: '#fff', 'font-family': 'Segoe UI, sans-serif' });
        t.textContent = 'DT';
        body.appendChild(t);
        g.appendChild(body);
        var bubble = svgEl('g', { 'class': 'campo-bubble', opacity: 0 });
        bubble.appendChild(svgEl('rect', { x: -34, y: -40, width: 68, height: 20, rx: 10, fill: '#fff', stroke: 'rgba(0,0,0,0.5)', 'stroke-width': 1 }));
        bubble.appendChild(svgEl('path', { d: 'M -4 -20.5 L 0 -14 L 4 -20.5 Z', fill: '#fff' }));
        var bt = svgEl('text', { y: -26, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 700, fill: '#111', 'font-family': 'Segoe UI, sans-serif' });
        bubble.appendChild(bt);
        g.appendChild(bubble);
        staffLayer.appendChild(g);
        var s = MANAGER_SPOT[side];
        return { side: side, x: s.x, y: s.y, tx: s.x, ty: s.y, vx: 0, vy: 0, spd: 1.2, el: g, body: body, bubble: bubble, bubbleText: bt, mood: null, moodT: 0, moodDur: 0, idleAt: 0 };
    }

    function ensureManagers(d) {
        if (!staffLayer || !d || !d.homeTeam) return;
        ['home', 'away'].forEach(function (side) {
            if (!managers[side] || !managers[side].el.parentNode) managers[side] = buildManager(side, d);
        });
    }

    var MOODS = {
        celebrate: { text: '¡Gooool!', dur: 3.2 },
        despair: { text: '¡No!', dur: 2.6 },
        protest: { text: '¡Árbitro!', dur: 2.8 },
        applaud: { text: '¡Bien!', dur: 2.4 },
        instruct: { text: '¡Arriba!', dur: 2.8 },
        argue: { text: '¡Eh!', dur: 2.6 },
        nervous: { text: '¡Vamos!', dur: 2.6 }
    };

    function setMood(side, mood) {
        var m = managers[side];
        if (!m || !MOODS[mood]) return;
        m.mood = mood; m.moodT = 0; m.moodDur = MOODS[mood].dur;
        m.bubbleText.textContent = MOODS[mood].text;
        var s = MANAGER_SPOT[side];
        // Al protestar, dar instrucciones o celebrar se va hasta la línea; si no, se queda en su zona.
        if (mood === 'protest' || mood === 'instruct' || mood === 'argue' || mood === 'celebrate') { m.tx = s.x + (side === 'home' ? 2.5 : -2.5); m.ty = 100.9; m.spd = mood === 'celebrate' ? 4 : 2.6; }
        else if (mood === 'despair') { m.tx = s.x; m.ty = s.y + 0.6; m.spd = 1.2; }
        else { m.tx = s.x; m.ty = s.y; m.spd = 1.6; }
    }

    function sideMentioned(text, d) {
        var t = foldText(text);
        var h = d.homeTeam ? foldText(d.homeTeam) : '', a = d.awayTeam ? foldText(d.awayTeam) : '';
        var hi = h ? t.indexOf(h.split(' ')[0]) : -1, ai = a ? t.indexOf(a.split(' ')[0]) : -1;
        if (hi >= 0 && (ai < 0 || hi < ai)) return 'home';
        if (ai >= 0) return 'away';
        return null;
    }

    function foldText(s) {
        return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    function managerReact(play, d) {
        if (!play || !managers.home) return;
        var t = foldText(play.text);
        var side = sideOfTeam(play.team, d);
        var other = side === 'home' ? 'away' : side === 'away' ? 'home' : null;
        var named = sideMentioned(play.text, d) || side;
        if (play.kind === 'goal' || play.kind === 'own-goal') {
            var scorer = play.scoreSide || side;
            if (scorer) { setMood(scorer, 'celebrate'); setMood(scorer === 'home' ? 'away' : 'home', 'despair'); }
            return;
        }
        if (/celebra con el cuerpo tecnico|dedica el gol al banquillo|abrazo con el banquillo/.test(t) && side) { setMood(side, 'celebrate'); return; }
        if (/entrenador .{0,40}aplaude|aplaude desde la banda/.test(t) && named) { setMood(named, 'applaud'); return; }
        if ((/(entrenador|tecnico|mister).{0,60}(pide|exige|ordena|grita|instrucciones|mas metros|presion)/.test(t) || /empuja desde la banda|presion tras el gol/.test(t)) && named) { setMood(named, 'instruct'); return; }
        if (/discute con .{0,40}banquillo|protesta|se encara/.test(t) && side) { setMood(side, 'argue'); return; }
        if (/nervios .{0,30}banquillos/.test(t)) { setMood('home', 'nervous'); setMood('away', 'nervous'); return; }
        if (play.kind === 'red' || play.kind === 'yellow' || play.kind === 'penalty') {
            // Protesta el banquillo del que recibe la tarjeta o el penalti en contra.
            var victim = play.kind === 'penalty' ? other : side;
            if (victim) setMood(victim, 'protest');
            return;
        }
        if (play.kind === 'sub' && named) setMood(named, 'instruct');
    }

    function stepManagers(dt, now) {
        ['home', 'away'].forEach(function (side) {
            var m = managers[side];
            if (!m) return;
            var s = MANAGER_SPOT[side];
            if (m.mood) {
                m.moodT += dt;
                if (m.moodT > m.moodDur) { m.mood = null; m.tx = s.x; m.ty = s.y; m.spd = 1.3; }
            } else if (now > m.idleAt) {
                // Paseo por su área técnica.
                m.tx = s.x + (Math.random() - 0.5) * 4; m.ty = s.y + (Math.random() - 0.3) * 0.8; m.spd = 0.9 + Math.random() * 0.5;
                m.idleAt = now + 2200 + Math.random() * 3000;
            }
            stepMover(m, dt, 1);
            var p = toSvg(m.x, m.y);
            var k = 1 + (nodeScale - 1) * 0.7;
            var bob = 0, rot = 0;
            if (m.mood === 'celebrate') bob = -Math.abs(Math.sin(m.moodT * 9)) * 7;
            else if (m.mood === 'protest' || m.mood === 'argue') rot = Math.sin(m.moodT * 16) * 12;
            else if (m.mood === 'despair') rot = Math.sin(m.moodT * 3) * 8;
            else if (m.mood === 'applaud' || m.mood === 'nervous') bob = -Math.abs(Math.sin(m.moodT * 7)) * 2.5;
            m.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + (p.y + bob).toFixed(1) + ') scale(' + k.toFixed(3) + ')');
            m.body.setAttribute('transform', rot ? 'rotate(' + rot.toFixed(1) + ')' : '');
            var op = m.mood ? Math.min(1, m.moodT * 5, (m.moodDur - m.moodT) * 3) : 0;
            m.bubble.setAttribute('opacity', Math.max(0, op).toFixed(2));
        });
    }

    function resetStaff() {
        clearScenes();
        clearLeavers();
        ['home', 'away'].forEach(function (side) {
            var m = managers[side];
            if (m) { m.mood = null; m.bubble.setAttribute('opacity', '0'); }
        });
    }

    // Eventos de una jugada en directo: lesión, reacción del entrenador.
    function playEvents(play, d) {
        if (!play) return;
        if (play.kind === 'injury' || /cae lesionado|camilla/i.test(play.text || '')) startInjury(play, d);
        managerReact(play, d);
    }

    /* ================= Coreógrafo (sesiones 11-12) =================
       Al cargar el informe se lee TODA la narración y se planifica el partido entero de una vez:
       cada jugada sabe de dónde viene (estado final de la anterior) y cómo acaba (remate fuera,
       parada, gol, despeje...). Se simula con el mismo motor físico (aceleración y frenada) pero
       sin pintar nada, y se guarda una línea temporal de posiciones de todas las figuras a 5 Hz
       (jugadores, balón, árbitro, asistencias). La reproducción solo interpola esa línea y la
       acompasa a la narración. El deslizador coloca el instante clave de la jugada elegida, con la
       alineación que había en ese momento. No cambia ningún resultado: solo se dibuja lo narrado. */
    var SIM_DT = 0.05, SAMPLE_DT = 0.2, NOMINAL_LINE = 2.0;
    var simulating = false, simClock = 0, simSeed = 1;
    var tl = null;                        // línea temporal construida
    var pb = { seg: null, prog: 0, off: null, disp: null, lastS: -1, held: 0, sad: null, flags: null, period: 1 };
    var BALL_CODE = { held: 0, free: 1, ground: 2, lofted: 3, shot: 4, reset: 5, over: 6 };
    var BALL_NAME = ['held', 'free', 'ground', 'lofted', 'shot', 'reset', 'over'];
    var ATTACK_KINDS = { shot: 1, save: 1, goal: 1, box: 1, oneonone: 1, counter: 1, wing: 1, play: 1 };

    function rng() {
        if (!simulating) return Math.random();
        simSeed = (simSeed * 1664525 + 1013904223) >>> 0;
        return simSeed / 4294967296;
    }
    function nowMs() { return simulating ? simClock * 1000 : performance.now(); }

    function normName(n) {
        return foldText(n).replace(/[_.\-']/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function sameName(a, b) {
        var x = normName(a), y = normName(b);
        if (!x || !y) return false;
        if (x === y) return true;
        var xs = x.split(' '), ys = y.split(' ');
        if (xs[xs.length - 1] !== ys[ys.length - 1]) return false;
        if (xs.length === 1 || ys.length === 1) return true;
        return xs[0][0] === ys[0][0];
    }
    function findIn(arr, name) {
        for (var i = 0; i < arr.length; i++) if (arr[i] && sameName(arr[i].name, name)) return i;
        return -1;
    }

    /* ---- Alineaciones de cada momento (cambios y expulsiones de todo el partido) ---- */
    function buildLineupHistory(d, plays) {
        function cp(a) { return (a || []).map(copyPlayer); }
        var cur = { home: cp(d.homeStartersInit && d.homeStartersInit.length ? d.homeStartersInit : d.homeStarters),
            away: cp(d.awayStartersInit && d.awayStartersInit.length ? d.awayStartersInit : d.awayStarters) };
        var pool = { home: cp(d.homeSubsInit && d.homeSubsInit.length ? d.homeSubsInit : d.homeSubs),
            away: cp(d.awaySubsInit && d.awaySubsInit.length ? d.awaySubsInit : d.awaySubs) };
        var reds = {};
        (d.redCardEvents || []).forEach(function (e) {
            var at = -1, i;
            for (i = 0; i < plays.length; i++) {
                var p = plays[i];
                if (p.minute === 'tanda') break;
                if (Math.floor(minuteValue(p.minute)) >= Math.floor(e.minute) && /roja|expuls|segunda amarilla/i.test(p.text || '')) { at = i; break; }
            }
            if (at < 0) for (i = 0; i < plays.length; i++) if (plays[i].minute !== 'tanda' && Math.floor(minuteValue(plays[i].minute)) >= Math.floor(e.minute)) { at = i; break; }
            if (at >= 0) (reds[at] = reds[at] || []).push(e);
        });
        var squad = { home: cur.home.concat(pool.home).map(function (p) { return p.name; }), away: cur.away.concat(pool.away).map(function (p) { return p.name; }) };
        var outNames = { home: [], away: [] }, sentOff = { home: [], away: [] };
        var hist = [];
        plays.forEach(function (p, i) {
            var before = { home: cur.home.slice(), away: cur.away.slice() };
            var events = [];
            var re = /sale\s+(.+?)\s*\((\w+)\)\s*,?\s*entra\s+(.+?)\s*(?:\((\w+)\)|$|\n)/gi, m;
            var text = String(p.text || '').replace(/ \n /g, '\n');
            while ((m = re.exec(text))) {
                var outN = m[1].trim(), inN = m[3].trim(), inPos = m[4] || m[2];
                var side = null, oi = -1;
                ['home', 'away'].forEach(function (s) { if (side) return; var k = findIn(cur[s], outN); if (k >= 0) { side = s; oi = k; } });
                if (!side) continue;
                var pi = findIn(pool[side], inN);
                var rec = pi >= 0 ? pool[side][pi] : { name: inN };
                var inP = { name: rec.name, position: /^(GK|DF|DM|MF|AM|FW)$/i.test(inPos || '') ? inPos.toUpperCase() : cur[side][oi].position };
                events.push({ type: 'sub', side: side, out: cur[side][oi].name, inn: inP.name });
                outNames[side].push(cur[side][oi].name);
                cur[side][oi] = inP;
                if (squad[side].indexOf(inP.name) === -1) squad[side].push(inP.name);
            }
            (reds[i] || []).forEach(function (e) {
                var s = e.side, k = findIn(cur[s], e.name);
                if (k < 0) { s = s === 'home' ? 'away' : 'home'; k = findIn(cur[s], e.name); }
                if (k < 0) return;
                events.push({ type: 'red', side: s, name: cur[s][k].name });
                sentOff[s].push(cur[s][k].name);
                cur[s].splice(k, 1);
            });
            var after = { home: cur.home.slice(), away: cur.away.slice() };
            var bench = {};
            ['home', 'away'].forEach(function (s) {
                var on = {};
                after[s].forEach(function (q) { on[q.name] = true; });
                bench[s] = squad[s].filter(function (n) { return !on[n] && sentOff[s].indexOf(n) === -1; });
            });
            hist.push({ before: before, after: after, events: events, bench: bench, out: { home: outNames.home.slice(), away: outNames.away.slice() } });
        });
        return { hist: hist, squad: squad, init: { home: cp(cur.home), away: cp(cur.away) } };
    }

    /* ---- Planificación de una jugada: fases del resolvedor + coherencia + desenlace ---- */
    function shotOutcome(play) {
        var t = foldText(play.text);
        var k = play.kind;
        if (k === 'goal' || k === 'own-goal') return 'goal';
        if (k === 'save') return /corner/.test(t) ? 'save-corner' : (/rechaz|suelta|despeja|repele/.test(t) ? 'save-parry' : 'save');
        if (k !== 'shot' && k !== 'oneonone' && k !== 'box') return null;
        if (/(poste|larguero|palo|madera|travesano)/.test(t) && !/rozando|junto al|cerca del|lame/.test(t)) return 'post';
        if (/alto|por encima|se eleva|arriba|nubes|grada/.test(t)) return 'over';
        if (/bloque|tapon|intercept|despeja la defensa|se estrella en|rebota en|corta el|desviado por/.test(t)) return 'block';
        if (k === 'shot' || /fuera|desviad|rozando|lejos|remat|chut|dispar/.test(t)) return 'wide';
        return null;
    }

    function ptAtt(x, attack) { return attack === 'home' ? x : 100 - x; }
    function fromAtt(ax, attack) { return attack === 'home' ? ax : 100 - ax; }

    function holderInSnapshot(snap, pt, maxM) {
        var best = null, bd = maxM || 2.8;
        Object.keys(snap || {}).forEach(function (k) {
            var t = snap[k];
            var dd = mDist(t.x, t.y, pt.x, pt.y);
            if (dd < bd) { bd = dd; best = k; }
        });
        return best;
    }

    // El balón progresa hacia la portería: nadie del equipo atacante recibe muy por detrás del punto
    // más avanzado que ya había alcanzado la jugada (se adelanta al receptor y el pase).
    function fixProgress(phases, attack) {
        var maxAx = null, fixed = 0;
        for (var p = 0; p < phases.length; p++) {
            var ph = phases[p];
            if (ph.pose != null) break;
            var path = ph.ballPath || [];
            for (var j = 0; j < path.length; j++) {
                var pt = path[j];
                if (pt.kind) continue;
                var k = holderInSnapshot(ph.players, pt);
                if (!k) continue;
                if (k.split(':')[0] !== attack) return fixed;
                var ax = ptAtt(pt.x, attack);
                if (maxAx != null && ax < maxAx - 4) {
                    var nax = Math.min(maxAx + 2, 92);
                    var nx = fromAtt(nax, attack);
                    var t = ph.players[k];
                    var dx = nx - pt.x;
                    path[j] = { x: nx, y: pt.y };
                    if (t) ph.players[k] = { x: clamp(t.x + dx, 2, 98), y: t.y };
                    for (var q = p + 1; q < phases.length; q++) {
                        var tq = phases[q].players && phases[q].players[k];
                        if (tq && Math.abs(tq.x - t.x) < 0.5 && Math.abs(tq.y - t.y) < 0.5) phases[q].players[k] = { x: clamp(tq.x + dx, 2, 98), y: tq.y };
                    }
                    ax = nax; fixed++;
                }
                maxAx = maxAx == null ? ax : Math.max(maxAx, ax);
            }
        }
        return fixed;
    }

    function clonePlayers(snap) {
        var o = {};
        Object.keys(snap || {}).forEach(function (k) { o[k] = { x: snap[k].x, y: snap[k].y }; });
        return o;
    }

    function addOutcome(phases, play, attack) {
        var oc = shotOutcome(play);
        if (!oc || oc === 'goal' || !phases.length) return oc;
        var dir = attack === 'home' ? 1 : -1;
        var gx = attack === 'home' ? 100 : 0;
        var last = phases[phases.length - 1];
        var lp = last.ballPath || [];
        var from = lp[lp.length - 1] || { x: 50, y: 50 };
        var side = from.y < 50 ? -1 : 1;
        var snap = clonePlayers(last.players);
        var path = null;
        if (oc === 'wide') path = [from, { x: gx + dir * 1.6, y: 50 + side * (5.6 + rng() * 3.5), kind: 'shot' }];
        else if (oc === 'over') path = [from, { x: gx + dir * 2.6, y: 50 + side * rng() * 2.5, kind: 'over' }];   // pasa por encima y cae detrás de la portería
        else if (oc === 'post') {
            var post = { x: gx - dir * 0.3, y: 50 + side * 3.6, kind: 'shot' };
            path = [from, post, { x: gx - dir * 9, y: 50 + side * 14, kind: 'ground' }];
        } else if (oc === 'block') {
            var defSide = attack === 'home' ? 'away' : 'home', best = null, bd = 1e9;
            Object.keys(snap).forEach(function (k) {
                if (k.split(':')[0] !== defSide) return;
                var t = snap[k];
                if (ptAtt(t.x, attack) > 97) return;
                var dd = mDist(t.x, t.y, from.x, from.y);
                if (dd < bd) { bd = dd; best = k; }
            });
            if (best) {
                var bp = { x: from.x + dir * 3.2, y: lerp(from.y, 50, 0.25) };
                snap[best] = bp;
                path = [from, { x: bp.x, y: bp.y, kind: 'shot' }];
            }
        } else if (oc === 'save-corner' || oc === 'save-parry') {
            path = [from, oc === 'save-corner' ? { x: gx + dir * 1.5, y: from.y < 50 ? 30 : 70, kind: 'ground', touch: 'def' } : { x: gx - dir * 10, y: clamp(from.y + side * 12, 15, 85), kind: 'ground' }];
        }
        if (oc.indexOf('save') === 0 && lp.length && ptAtt(from.x, attack) > 88) {
            // Parada: el remate sale de verdad hacia el portero (no es un pase al portero).
            if (lp.length === 1) lp.unshift({ x: from.x - dir * 9, y: lerp(from.y, 50, 0.3) });
            lp[lp.length - 1] = { x: from.x, y: from.y, kind: 'shot' };
        }
        if (path) phases.push({ players: snap, ballPath: path, ms: 650, highlight: last.highlight, ref: last.ref, outcome: oc });
        return oc;
    }

    // Gol: el corro alrededor del goleador es compacto y los rivales se retiran despacio, cabizbajos.
    function shapeGoal(phases, play, attack) {
        var cel = null, kick = null;
        phases.forEach(function (ph) { if (ph.pose === true && !cel) cel = ph; if (ph.pose === false) kick = ph; });
        if (!cel) return;
        var scorerSide = attack;
        // El balón entra de verdad en la portería: el último punto antes de la celebración va a la red.
        var ci = phases.indexOf(cel);
        var shotPh = ci > 0 ? phases[ci - 1] : null;
        if (shotPh && shotPh.ballPath && shotPh.ballPath.length) {
            var lastPt = shotPh.ballPath[shotPh.ballPath.length - 1];
            var intoRight = lastPt.x > 50;
            var netPt = { x: intoRight ? 101.3 : -1.3, y: clamp(lastPt.y, 45.5, 54.5), kind: 'shot' };
            if (shotPh.ballPath.length === 1) shotPh.ballPath.unshift({ x: lerp(lastPt.x, 50, 0.12), y: lastPt.y });
            shotPh.ballPath[shotPh.ballPath.length - 1] = netPt;
            cel.ballPath = [];
        }
        // el goleador es el último nombrado del equipo que marca (si no, el más adelantado)
        var scorer = null;
        (play.players || []).forEach(function (n) { var k = keyOf(scorerSide, n); if (cel.players[k]) scorer = k; });
        var mates = Object.keys(cel.players).filter(function (k) { return k.split(':')[0] === scorerSide; });
        if (!scorer) scorer = mates.slice().sort(function (a, b) { return ptAtt(cel.players[b].x, scorerSide) - ptAtt(cel.players[a].x, scorerSide); })[0];
        if (!scorer) return;
        // El último pase va al goleador: está donde llega el balón y remata él.
        if (play.kind === 'goal' && shotPh && shotPh.ballPath && shotPh.ballPath.length > 1) {
            var sp0 = shotPh.ballPath[0], back = scorerSide === 'home' ? -0.6 : 0.6;
            [phases[ci - 2], shotPh].forEach(function (q) {
                if (q && q.players && q.players[scorer] && q.pose !== false) q.players[scorer] = { x: sp0.x + back, y: sp0.y };
            });
        }
        var c = cel.players[scorer];
        c = { x: clamp(c.x, 6, 94), y: clamp(c.y, 10, 90) };
        cel.players[scorer] = c;
        var others = mates.filter(function (k) { return k !== scorer && !isGkKey(k); });
        others.sort(function (a, b) { return mDist(cel.players[a].x, cel.players[a].y, c.x, c.y) - mDist(cel.players[b].x, cel.players[b].y, c.x, c.y); });
        // Los cinco más cercanos le abrazan; el resto se acerca a unos metros, del lado del centro del campo.
        others.forEach(function (k, i) {
            var t;
            if (i < 5) {
                var a = i / Math.min(5, others.length) * Math.PI * 2;
                t = { x: c.x + Math.cos(a) * 2.2 / M_X, y: c.y + Math.sin(a) * 2.2 / M_Y };
            } else {
                var toC = Math.atan2((50 - c.y) * M_Y, (50 - c.x) * M_X);
                var a2 = toC + ((i - 5) / Math.max(1, others.length - 6) - 0.5) * 2.0;
                var r2 = 7 + (i % 2) * 3;
                t = { x: c.x + Math.cos(a2) * r2 / M_X, y: c.y + Math.sin(a2) * r2 / M_Y };
            }
            cel.players[k] = { x: clamp(t.x, 2, 98), y: clamp(t.y, 3, 97) };
        });
        // Los rivales no se meten en la celebración: se apartan cabizbajos.
        Object.keys(cel.players).forEach(function (k) {
            if (k.split(':')[0] === scorerSide) return;
            var q = cel.players[k], dm = mDist(q.x, q.y, c.x, c.y);
            if (dm < 12 && !isGkKey(k)) {
                var ang = Math.atan2((q.y - c.y) * M_Y, (q.x - c.x) * M_X);
                if (dm < 0.5) ang = Math.atan2((50 - c.y) * M_Y, (50 - c.x) * M_X);
                cel.players[k] = { x: clamp(c.x + Math.cos(ang) * 13 / M_X, 2, 98), y: clamp(c.y + Math.sin(ang) * 13 / M_Y, 3, 97) };
            }
        });
        cel.spdCap = {};
        Object.keys(cel.players).forEach(function (k) { if (k.split(':')[0] !== scorerSide) cel.spdCap[k] = 1.5; });
        cel.ms = 3400; cel.goal = scorerSide; cel.scorer = scorer;
        if (kick) kick.ms = 2400;
    }

    function isGkKey(k) {
        var st = playerState[k];
        return st && st.pos === 'GK';
    }

    // Saque de centro tras un gol: el que saca toca atrás a un compañero (nunca sale conduciendo).
    function addKickoffPass(phases) {
        for (var i = 0; i < phases.length; i++) {
            var ph = phases[i], bp = ph.ballPath || [];
            if (ph.pose !== false || bp.length !== 1 || Math.abs(bp[0].x - 50) > 0.5 || Math.abs(bp[0].y - 50) > 0.5) continue;
            var nx = phases[i + 1];
            if (nx && (nx.kickPass || ((nx.ballPath || []).length >= 2 && mDist(nx.ballPath[0].x, nx.ballPath[0].y, 50, 50) < 0.5))) continue;   // ya hay pase de saque
            var pl = ph.players || {}, taker = null, bd = 1e9;
            Object.keys(pl).forEach(function (k) { var dd = mDist(pl[k].x, pl[k].y, 50, 50); if (dd < bd) { bd = dd; taker = k; } });
            if (!taker || bd > 4) continue;
            var side = taker.split(':')[0], dir = side === 'home' ? 1 : -1, mate = null, md = 1e9;
            Object.keys(pl).forEach(function (k) {
                if (k === taker || k.split(':')[0] !== side) return;
                var dd = mDist(pl[k].x, pl[k].y, 50 - dir * 3.2, 50);
                if (dd < md && (pl[k].x - 50) * dir < 0) { md = dd; mate = k; }
            });
            if (!mate) continue;
            phases.splice(i + 1, 0, { players: clonePlayers(pl), ballPath: [{ x: 50, y: 50 }, { x: pl[mate].x, y: pl[mate].y }], ms: 500, pose: false, highlight: [], kickPass: true, ref: ph.ref });
            i++;
        }
    }

    function planPlay(play, dP) {
        var res = resolvePlay(play, dP);
        var phases = (res.phases || []).map(function (ph) {
            var o = {};
            Object.keys(ph).forEach(function (k) { o[k] = ph[k]; });
            o.players = clonePlayers(ph.players);
            o.ballPath = (ph.ballPath || []).map(function (p) { return { x: p.x, y: p.y }; });
            return o;
        });
        var attack = sideOfTeam(play.team, dP) || 'home';
        var info = { attack: attack, fixed: 0, outcome: null };
        if (ATTACK_KINDS[play.kind]) info.fixed = fixProgress(phases, attack);
        info.outcome = addOutcome(phases, play, attack);
        if (play.kind === 'goal' || play.kind === 'own-goal') shapeGoal(phases, play, attack);
        phases = markSetPieces(phases, play, attack);
        addPlausibleOut(phases, play, attack);
        addKickoffPass(phases);
        return { phases: phases, info: info };
    }

    /* ---------------- Sesiones 15-17: reanudaciones (banda, puerta, córner, centro), faltas con y sin
       barrera, fueras de juego, linieres y protestas. Todo ocurre dentro de la simulación del coreógrafo. ---- */
    var simDbg = [], simSegT = 99, tlData = null, simNextKind = null, simNextText = '', simNextSide = null;
    var FK_GOAL_RE = /(falta a cargo|lanza la falta|lanzamiento de falta|la falta se cuela|golpeo de falta|libre directo|tiro libre|ejecuta la falta|falta directa|saca la falta|clava la falta|de falta)/;
    var simRestart = null, simEvents = [], simNs = 0, simAR = [], simGoalPlay = false, simAttackSide = 'home', simExiting = false;
    var RESTART_PREP = { throw: 1.3, goalkick: 1.9, corner: 2.1, free: 1.5, wall: 2.8, offside: 1.8, penalty: 2.6 };
    var EVENT_LABEL = { throw: 'Saque de banda', goalkick: 'Saque de puerta', corner: 'Córner', free: 'Falta', wall: 'Falta · barrera',
        offside: 'Fuera de juego', kickoff: 'Saque de centro', penalty: 'Penalti', protest: 'Protestas', over: 'Por encima del larguero', appeal: '¿Fuera de juego?' };

    function goalXOf(side) { return side === 'home' ? 100 : 0; }   // portería a la que ataca ese equipo
    function oppOf(side) { return side === 'home' ? 'away' : 'home'; }
    function simEvent(type, x, y, extra) {
        var v = simVisOf(x, y);
        var e = { s: simNs, type: type, x: v.x, y: v.y };
        if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
        simEvents.push(e);
    }
    function sideKeys(side, noGk) {
        return Object.keys(playerState).filter(function (k) {
            var st = playerState[k];
            return st.side === side && !st.leaving && !st.hold && !st.down && !(noGk && st.pos === 'GK');
        });
    }
    function byDistTo(x, y) { return function (a, b) { return mDist(playerState[a].x, playerState[a].y, x, y) - mDist(playerState[b].x, playerState[b].y, x, y); }; }
    function nearestOf(keys, x, y) { return keys.slice().sort(byDistTo(x, y))[0] || null; }
    function gkOf(side) { return sideKeys(side).filter(function (k) { return playerState[k].pos === 'GK'; })[0] || null; }

    function startProtest(side, n, label) {
        var keys = sideKeys(side, true).sort(byDistTo(refState.x, refState.y)).slice(0, n);
        keys.forEach(function (k, i) {
            var st = playerState[k];
            var a = Math.atan2((st.y - refState.y) * M_Y, (st.x - refState.x) * M_X) + (i - (n - 1) / 2) * 0.55;
            setMoverTarget(st, clamp(refState.x + Math.cos(a) * 2.4 / M_X, 1, 99), clamp(refState.y + Math.sin(a) * 2.4 / M_Y, 1, 99), 1.2, { involved: true });
            st.protestUntil = simClock + 2.9;
        });
        if (keys.length) simEvent(label || 'protest', refState.x, refState.y, { side: side });
    }

    function startAppeal(side) {
        // Los defensas levantan el brazo pidiendo fuera de juego (el liniere no lo señala).
        var keys = sideKeys(side, true).sort(byDistTo(ball.x, ball.y)).slice(0, 2);
        keys.forEach(function (k) { playerState[k].protestUntil = simClock + 1.8; });
        if (keys.length) simEvent('appeal', ball.x, ball.y, { side: side });
    }

    // Una reanudación narrada que llega con otra automática pendiente del mismo tipo (el balón ya salió
    // por ese sitio): es la misma; se adopta lo narrado sin repetirla desde otro punto.
    function restartCompatible(r, sp) {
        if (!r || !r.auto || r.type !== sp.type || r.side !== sp.side || sp.offside) return false;
        if (sp.type === 'corner') return (r.spot.x > 50) === (sp.spot.x > 50);
        return sp.type === 'throw' || sp.type === 'goalkick';
    }

    function beginRestart(sp) {
        if (simRestart && !sp.auto && restartCompatible(simRestart, sp)) {
            var pr = simRestart;
            pr.auto = false;
            if (sp.kick) pr.kick = sp.kick;
            if (sp.protest) startProtest(sp.protest, sp.protestN || 2);
            pr.phase = motor.phase;
            motor.action = null; motor.actions = [];
            return;
        }
        if (simRestart) restartKick(simRestart);
        var r = { type: sp.type, side: sp.side, spot: { x: clamp(sp.spot.x, -0.5, 100.5), y: clamp(sp.spot.y, -0.5, 100.5) }, t: 0, stage: 0,
            wall: [], kick: sp.kick || null, prep: RESTART_PREP[sp.wallUp ? 'wall' : sp.type] || 1.6, auto: !!sp.auto, wallUp: !!sp.wallUp,
            offside: !!sp.offside, protest: sp.protest || null, protestN: sp.protestN || 2, born: simClock, hurry: !!sp.hurry, hold: !!sp.hold };
        if (r.hurry) r.prep = Math.min(r.prep, 1.4);   // va con retraso: se coloca y se saca rápido
        var inField = ball.x >= -0.2 && ball.x <= 100.2 && ball.y >= -0.2 && ball.y <= 100.2;
        // Lo narrado sale de lo que acaba de pasar: antes de un córner, saque de banda o de puerta el balón
        // sale de verdad por ese sitio; una falta se pita donde está el balón (se lleva hasta allí).
        if (!r.auto && !r.offside && /^(corner|throw|goalkick)$/.test(r.type)) {
            if (sp.optional && inField && mDist(ball.x, ball.y, r.spot.x, r.spot.y) > 30) return;   // saque de banda inventado: solo si cuadra
            r.stage = -1; r.need = 'out';
            if (r.type === 'throw' && inField && Math.abs(ball.x - r.spot.x) * M_X > 16) {
                r.spot = { x: clamp(ball.x + (r.spot.x > ball.x ? 1 : -1) * 6 / M_X, 2, 98), y: ball.y < 50 ? 0 : 100 };
                if (r.kick && mDist(r.kick.x, r.kick.y, r.spot.x, r.spot.y) > 26) r.kick = null;
            }
            if (r.type === 'throw' && inField) r.spot.y = ball.y < 50 ? 0 : 100;
            if (r.type === 'corner' && inField) r.spot.y = ball.y < 50 ? 0.6 : 99.4;
        } else if (!r.auto && !r.offside && r.type === 'penalty') {
            // El penalti se comete dentro del área: el balón llega allí, pita el árbitro y se coloca en el punto.
            var pgx = goalXOf(r.side), pdir2 = pgx === 100 ? 1 : -1;
            r.foulAt = { x: pgx - pdir2 * (6 + rng() * 8) / M_X, y: clamp(inField ? ball.y : 50, 50 - 14 / M_Y, 50 + 14 / M_Y) };
            if (!inField || mDist(ball.x, ball.y, r.foulAt.x, r.foulAt.y) > 4) { r.stage = -1; r.need = 'approach'; }
        } else if (!r.auto && !r.offside && r.type === 'free' && inField && mDist(ball.x, ball.y, r.spot.x, r.spot.y) > 6) {
            r.stage = -1; r.need = 'approach';
        }
        if (ball.state === 'held' && r.stage === 0) { ball.state = 'free'; ball.owner = null; }
        motor.action = null; motor.actions = [];
        r.phase = motor.phase;
        simRestart = r;
        if (r.stage === 0) placeRestart(r);
    }

    // Colocación de la reanudación (con el balón ya donde toca): lanzador, barrera, área, árbitro.
    function placeRestart(r) {
        r.from = { x: ball.x, y: ball.y }; r.whistleNs = simNs;
        var opp = oppOf(r.side), gx = goalXOf(r.side);
        r.taker = r.type === 'goalkick' ? (gkOf(r.side) || nearestOf(sideKeys(r.side), r.spot.x, r.spot.y)) : nearestOf(sideKeys(r.side, true), r.spot.x, r.spot.y);
        var aim = r.kick ? { x: r.kick.x, y: r.kick.y } : (r.type === 'throw' ? { x: r.spot.x, y: 50 } : { x: gx, y: 50 });
        var ux = (aim.x - r.spot.x) * M_X, uy = (aim.y - r.spot.y) * M_Y, ul = Math.max(0.1, Math.hypot(ux, uy));
        ux /= ul; uy /= ul;
        r.takerAt = r.type === 'throw' ? { x: r.spot.x, y: r.spot.y < 50 ? -0.5 : 100.5 } : { x: r.spot.x - ux * 1.3 / M_X, y: r.spot.y - uy * 1.3 / M_Y };
        if (r.taker) setMoverTarget(playerState[r.taker], r.takerAt.x, r.takerAt.y, 0.9, { involved: true });
        if (r.wallUp) {
            var gdx = (gx - r.spot.x) * M_X, gdy = (50 - r.spot.y) * M_Y, gl = Math.max(0.1, Math.hypot(gdx, gdy));
            var wx = r.spot.x + gdx / gl * 9.15 / M_X, wy = r.spot.y + gdy / gl * 9.15 / M_Y;
            var px = -gdy / gl, py = gdx / gl;
            // Barrera de 3 o 4 (más cerca, más jugadores), hombro con hombro tal y como se dibujan: sin montarse unos encima de otros.
            var wN = gl < 24 ? 4 : 3, wGap = 3.8 * sepFactor();
            var defs = sideKeys(opp, true).sort(byDistTo(wx, wy)).slice(0, wN);
            r.wallT = [];
            defs.forEach(function (k, i) {
                var o = (i - (defs.length - 1) / 2) * wGap, tx = clamp(wx + px * o / M_X, 0.5, 99.5), ty = clamp(wy + py * o / M_Y, 0.5, 99.5);
                setMoverTarget(playerState[k], tx, ty, 1.3, { involved: true });
                r.wallT.push({ k: k, x: tx, y: ty });
            });
            r.wall = defs; r.wallAt = { x: wx, y: wy };
            var gk = gkOf(opp);
            if (gk) setMoverTarget(playerState[gk], gx === 100 ? 99 : 1, clamp(50 + (r.spot.y - 50) * 0.12, 46, 54), 1.2, { involved: true });
            // atacantes esperando el rechace en el área
            var bxA = gx === 100 ? 90 : 10;
            sideKeys(r.side, true).filter(function (k) { return k !== r.taker; }).sort(byDistTo(bxA, 50)).slice(0, 3)
                .forEach(function (k, i) { setMoverTarget(playerState[k], bxA, 40 + i * 10, 1.6, { involved: true }); r.waitK = (r.waitK || []).concat([k]); });
            // Nadie más se mete encima de la barrera: los demás se apartan a un lado.
            Object.keys(playerState).forEach(function (k) {
                if (defs.indexOf(k) >= 0 || k === r.taker) return;
                var st = playerState[k];
                if (st.leaving || st.pos === 'GK') return;
                var tx = st.tx != null ? st.tx : st.x, ty = st.ty != null ? st.ty : st.y;
                r.wallT.forEach(function (w) {
                    var dx = (tx - w.x) * M_X, dy = (ty - w.y) * M_Y, dd = Math.hypot(dx, dy), need = 3.9 * sepFactor();
                    if (dd < need) {
                        if (dd < 0.2) { dx = px; dy = py; dd = 1; }
                        tx = clamp(w.x + dx / dd * need / M_X, 0.5, 99.5); ty = clamp(w.y + dy / dd * need / M_Y, 0.5, 99.5);
                    }
                });
                if (tx !== st.tx || ty !== st.ty) { setMoverTarget(st, tx, ty, 1.2, { involved: true }); st.wallAside = { x: tx, y: ty }; }
            });
        }
        if (r.type === 'penalty') {
            // Penalti: el portero en la línea, el lanzador tras el balón y todos los demás fuera del área y de la media luna.
            var pdir = gx === 100 ? 1 : -1, edgeX = gx - pdir * 17.6 / M_X;
            Object.keys(playerState).forEach(function (k) {
                var st = playerState[k];
                if (k === r.taker || st.leaving) return;
                if (st.pos === 'GK' && st.side === opp) { setMoverTarget(st, gx === 100 ? 99.4 : 0.6, 50, 1.0, { involved: true }); return; }
                if (st.pos === 'GK') return;
                var inBox = (st.x - edgeX) * pdir > -1.2 && Math.abs(st.y - 50) < 32;
                var tx = inBox ? edgeX - pdir * (1.5 + rng() * 3) / M_X : st.x;
                var ty = inBox ? clamp(st.y, 22, 78) : st.y;
                // la media luna: a más de 9,15 m del punto
                if (mDist(tx, ty, r.spot.x, r.spot.y) < 10) ty = ty < 50 ? Math.min(ty, 50 - 10.5 / M_Y) : Math.max(ty, 50 + 10.5 / M_Y);
                setMoverTarget(st, tx, ty, 1.3, { involved: inBox });
            });
        }
        if (r.type === 'corner') {
            var bx = gx === 100 ? 93 : 7, dirIn = gx === 100 ? -1 : 1;
            sideKeys(r.side, true).filter(function (k) { return k !== r.taker; }).sort(byDistTo(bx, 50)).slice(0, 4)
                .forEach(function (k, i) { setMoverTarget(playerState[k], bx + dirIn * (i % 2) * 3, 38 + i * 8, 1.7, { involved: true }); });
            sideKeys(opp, true).sort(byDistTo(bx, 50)).slice(0, 4)
                .forEach(function (k, i) { setMoverTarget(playerState[k], bx - dirIn * 1.5, 40 + i * 6.5, 1.7, { involved: true }); });
        }
        // el árbitro se acerca a ver la reanudación
        var rx = clamp(r.spot.x + (50 - r.spot.x) * 0.35, 6, 94), ry = clamp(r.spot.y + (50 - r.spot.y) * 0.35 + 6, 8, 92);
        refState.tx = rx; refState.ty = ry; refState.hx = rx; refState.hy = ry;
        refState.spd = clamp(mDist(refState.x, refState.y, rx, ry) / 1.6, 1.5, 7);
        if (r.offside) { var ai = r.spot.x >= 50 ? 0 : 1; if (simAR[ai]) simAR[ai].flagUntil = simClock + 3.0; }
        if (r.protest) startProtest(r.protest, r.protestN || 2);
        // El fuera de juego se señala al momento; el resto se rotula cuando el balón está colocado.
        r.evType = r.offside ? 'offside' : (r.wallUp ? 'wall' : r.type);
        if (r.offside) { simEvent('offside', r.spot.x, r.spot.y, { side: r.side }); r.evDone = true; }
        if (ball.state === 'held') { ball.state = 'free'; ball.owner = null; }
        ball.lock = true;
        motor.action = null; motor.actions = [];
        r.phase = motor.phase;
    }

    // Antes de la reanudación: el balón sale por donde se va a sacar, o llega a donde se pita la falta.
    function stepRestartPre(r, dt) {
        var outNow = ball.x < -0.2 || ball.x > 100.2 || ball.y < -0.2 || ball.y > 100.2;
        function go() { r.stage = 0; r.t = 0; r.rest = 0; placeRestart(r); }
        if (r.need === 'out') {
            if (!r.launched) {
                if (ball.state === 'flight' && r.t < 1.4) return;
                if (outNow && ball.state !== 'flight') { go(); return; }
                var to;
                if (r.type === 'corner') to = { x: r.spot.x > 50 ? 101.6 : -1.6, y: r.spot.y < 50 ? 5 + rng() * 14 : 81 + rng() * 14 };
                else if (r.type === 'goalkick') to = { x: r.spot.x > 50 ? 101.6 : -1.6, y: rng() < 0.5 ? 22 + rng() * 18 : 60 + rng() * 18 };
                else to = { x: clamp(r.spot.x + (rng() - 0.5) * 3, 1, 99), y: r.spot.y < 50 ? -1.6 : 101.6 };
                if (ball.state === 'held') { ball.state = 'free'; ball.owner = null; }
                var far = mDist(ball.x, ball.y, to.x, to.y);
                launchBall(to, far > 30 ? 'lofted' : 'ground', null);
                ball.fl.keep = true;
                // Último toque: el rival del que va a sacar (despeje o desvío de un defensa en el córner).
                ball.lastSide = oppOf(r.side);
                r.launched = true;
                return;
            }
            if (ball.state !== 'flight') { r.rest = (r.rest || 0) + dt; if (r.rest > 0.45) go(); }
            if (r.t > 6) go();
            return;
        }
        // Falta: el balón llega a donde se comete y entonces pita el árbitro (el penalti, en el área).
        var tgt = r.foulAt || r.spot;
        var dB = mDist(ball.x, ball.y, tgt.x, tgt.y);
        if (ball.state !== 'flight' && dB <= 3.5) { if (!r.foulAt) r.spot = { x: clamp(ball.x, 1, 99), y: clamp(ball.y, 1, 99) }; go(); return; }
        if (!r.launched && (ball.state !== 'flight' || r.t > 1.4)) {
            var recv = nearestOf(sideKeys(r.side, true), tgt.x, tgt.y);
            if (ball.state === 'held') { ball.state = 'free'; ball.owner = null; }
            launchBall({ x: tgt.x, y: tgt.y }, dB > 30 ? 'lofted' : 'ground', recv);
            if (recv) setMoverTarget(playerState[recv], tgt.x, tgt.y, 0.8, { involved: true });
            var fouler = nearestOf(sideKeys(oppOf(r.side), true), tgt.x, tgt.y);
            if (fouler) setMoverTarget(playerState[fouler], tgt.x + (r.side === 'home' ? 1.2 : -1.2), tgt.y, 0.8, { involved: true });
            r.launched = true;
            return;
        }
        if (r.t > 4.5) {
            if (ball.state !== 'flight' && !outNow && !r.foulAt) r.spot = { x: clamp(ball.x, 1, 99), y: clamp(ball.y, 1, 99) };
            go();
        }
    }

    // Datos de la reanudación para el auditor: barrera, punto de origen (falta o salida del balón).
    function restartEvExtra(r) {
        var ex = { side: r.side, t: Math.round(r.t * 10) / 10 };
        if (r.wallUp && r.wallAt) { var wv = simVisOf(r.wallAt.x, r.wallAt.y); ex.wallAt = { x: wv.x, y: wv.y }; ex.wall = r.wall.slice(); }
        if (r.from) { var fv = simVisOf(r.from.x, r.from.y); ex.from = { x: fv.x, y: fv.y }; }
        if (r.whistleNs != null) ex.whistle = r.whistleNs;
        if (r.need) ex.need = r.need;
        return ex;
    }

    // Mientras se forma la barrera, nadie más (compañero, rival que espera el rechace...) se queda encima de ella.
    function wallClear(r) {
        var need = 4.0 * sepFactor();
        Object.keys(playerState).forEach(function (k) {
            if (r.wall.indexOf(k) >= 0 || k === r.taker) return;
            var st = playerState[k];
            if (st.leaving || st.pos === 'GK') return;
            var tx = st.tx, ty = st.ty, moved = false;
            for (var it = 0; it < 2; it++) r.wallT.forEach(function (w) {
                var dx = (tx - w.x) * M_X, dy = (ty - w.y) * M_Y, dd = Math.hypot(dx, dy);
                if (dd < need) { if (dd < 0.2) { dx = 0; dy = 1; dd = 1; } tx = clamp(w.x + dx / dd * need / M_X, 0.5, 99.5); ty = clamp(w.y + dy / dd * need / M_Y, 0.5, 99.5); moved = true; }
            });
            if (moved) { st.tx = tx; st.ty = ty; st.hx = tx; st.hy = ty; st.pend = null; st.spd = Math.max(st.spd || 0, 4.5); if (!r.waitK) r.waitK = []; if (r.waitK.indexOf(k) < 0) r.waitK.push(k); }
        });
    }

    function stepRestart(dt) {
        var r = simRestart;
        r.t += dt;
        if (r.stage < 0) { stepRestartPre(r, dt); return; }
        var ts = r.taker ? playerState[r.taker] : null;
        if (r.stage === 0) {
            var dBall = mDist(ball.x, ball.y, r.spot.x, r.spot.y);
            // El balón que ha salido se queda fuera un instante antes de volver (nunca «rebota» en la línea).
            var outNow = ball.x < -0.2 || ball.x > 100.2 || ball.y < -0.2 || ball.y > 100.2;
            if (ball.state !== 'flight') r.rest = (r.rest || 0) + dt; else r.rest = 0;
            if (ball.state !== 'flight' && dBall > 1.0 && r.t > (r.auto ? 0.6 : 0.05) && (!outNow || r.rest > 0.7)) {
                if (ball.state === 'held') { ball.state = 'free'; ball.owner = null; }
                launchBall({ x: r.spot.x, y: r.spot.y }, 'reset', null);
                ball.fl.keep = true;
            }
            if (ts) { ts.tx = r.takerAt.x; ts.ty = r.takerAt.y; ts.hx = ts.tx; ts.hy = ts.ty; ts.pend = null; ts.spd = Math.max(ts.spd || 0, 5.5); }
            // La barrera se coloca entera antes de que se lance (cada uno en su sitio, sin montarse).
            var wallOk = !r.wallT || r.wallT.every(function (w) {
                var st = playerState[w.k];
                if (!st) return true;
                st.tx = w.x; st.ty = w.y; st.hx = w.x; st.hy = w.y; st.pend = null; st.spd = Math.max(st.spd || 0, 5);
                return mDist(st.x, st.y, w.x, w.y) < 0.3;
            });
            if (r.wallT) wallClear(r);
            if (typeof window !== 'undefined' && window.__wdbg && r.wallT) { var dc = playerState['home:De Chiara']; if (dc) window.__wdbg.push([simNs, r.t.toFixed(2), dc.x.toFixed(1), dc.y.toFixed(1), dc.tx.toFixed(1), dc.ty.toFixed(1), JSON.stringify(r.wallT.map(function(w){return [w.x.toFixed(1), w.y.toFixed(1)];})), wallOk]); }
            // ... y los que se colocan alrededor (los del rechace, los que se apartan) ya han llegado: nadie cruza la barrera al lanzar.
            if (wallOk && r.waitK) wallOk = r.waitK.every(function (k) { var st = playerState[k]; return !st || mDist(st.x, st.y, st.tx, st.ty) < 1.0; });
            var ready = ball.state !== 'flight' && dBall <= 1.0 && (!ts || mDist(ts.x, ts.y, r.takerAt.x, r.takerAt.y) < 1.6) && r.t >= r.prep && wallOk;
            if (!r.hold && (ready || r.t > r.prep + (r.hurry ? 1.6 : 4))) {
                r.stage = 1; r.t1 = r.t;
                if (!r.evDone) { simEvent(r.evType, r.spot.x, r.spot.y, restartEvExtra(r)); r.evDone = true; }
                if (ts && r.type === 'throw') { ts.throwing = true; ball.state = 'held'; ball.owner = r.taker; }
            }
        } else if (r.t - r.t1 > (r.type === 'throw' ? 0.75 : 0.45)) restartKick(r);
    }

    function restartKick(r) {
        if (r.stage < 0) { simRestart = null; ball.lock = false; if (ball.fl) ball.fl.keep = false; return; }   // aún no había salido / llegado: se abandona
        var to = null, kind = 'ground', recv = null;
        var gx = goalXOf(r.side), dir = gx === 100 ? 1 : -1;
        var mates = sideKeys(r.side, true).filter(function (k) { return k !== r.taker; });
        if (r.kick) { to = { x: r.kick.x, y: r.kick.y }; kind = r.kick.kind || 'ground'; }
        else if (r.type === 'throw') { recv = nearestOf(mates, r.spot.x + dir * 4, r.spot.y < 50 ? 12 : 88); kind = 'lofted'; }
        else if (r.type === 'goalkick') {
            var mid = mates.filter(function (k) { var a = ptAtt(playerState[k].x, r.side); return a > 35 && a < 70; });
            recv = nearestOf(mid.length ? mid : mates, fromAtt(52, r.side), 50); kind = 'lofted';
        } else if (r.type === 'corner') { to = { x: gx === 100 ? 93.5 : 6.5, y: 50 + (r.spot.y < 50 ? -4 : 4) }; kind = 'lofted'; }
        else recv = nearestOf(mates.filter(function (k) { return mDist(playerState[k].x, playerState[k].y, r.spot.x, r.spot.y) > 6; }), r.spot.x + dir * 8, r.spot.y);
        if (!to && recv) { var rs = playerState[recv]; to = { x: rs.x, y: rs.y }; }
        if (!to) to = { x: fromAtt(55, r.side), y: 50 };
        if (recv && playerState[recv]) setMoverTarget(playerState[recv], to.x, to.y, 0.8, { involved: true });
        var ts = r.taker ? playerState[r.taker] : null;
        if (!r.evDone) { simEvent(r.evType, r.spot.x, r.spot.y, restartEvExtra(r)); r.evDone = true; }
        if (ts) ts.throwing = false;
        if (ball.state === 'held') { ball.state = 'free'; ball.owner = null; }
        simRestart = null;
        launchBall(to, kind, recv);
        ball.lastSide = r.side;
        if (r.type === 'throw') ball.fl.H = 0.45;
        if (r.kick && r.kick.net) ball.fl.net = true;
        ball.fl.born = r.born;   // lanzamiento de una reanudación (puede venir de la jugada anterior)
        if (r.kick && r.kick.kind === 'over') ball.fl.H = 2.6;
        // Hecha la reanudación, la fase acaba enseguida y el juego sigue (nadie se queda congelado).
        if (motor.phase === r.phase) { motor.actions = []; motor.action = null; if (motor.phase) motor.phaseDur = Math.min(motor.phaseDur, motor.phaseT + 0.8); }
    }

    // ¿Ha salido el balón? Se reanuda con saque de banda, de puerta o córner (nunca rebota en la línea).
    function simCheckOut() {
        if (simRestart || ball.state !== 'free' || ball.goalNet) return;
        var x = ball.x, y = ball.y;
        var outSide = y < -0.2 || y > 100.2, outEnd = x < -0.2 || x > 100.2;
        if (!outSide && !outEnd) return;
        if (outEnd && !outSide && simGoalPlay && Math.abs(y - 50) < 6.5) { ball.goalNet = true; return; }   // gol: el balón se queda en la red
        var last = ball.lastSide || simAttackSide;
        if (outEnd) {
            var defSide = x > 50 ? 'away' : 'home', atkSide = oppOf(defSide);
            if (last === atkSide) beginRestart({ type: 'goalkick', side: defSide, spot: { x: x > 50 ? 94.8 : 5.2, y: y < 50 ? 41 : 59 }, auto: true });
            else beginRestart({ type: 'corner', side: atkSide, spot: { x: x > 50 ? 99.6 : 0.4, y: y < 50 ? 0.6 : 99.4 }, auto: true });
        } else beginRestart({ type: 'throw', side: oppOf(last), spot: { x: clamp(x, 1, 99), y: y < 50 ? 0 : 100 }, auto: true });
    }

    // Linieres: uno en cada banda, cada uno en una mitad, a la altura del penúltimo defensor (o del balón).
    function simInitAR() {
        simAR = [{ x: 72, y: -2.3, tx: 72, ty: -2.3, vx: 0, vy: 0, spd: 3, flagUntil: 0 }, { x: 28, y: 101.9, tx: 28, ty: 101.9, vx: 0, vy: 0, spd: 3, flagUntil: 0 }];
    }
    function simStepAR(dt) {
        if (!simAR.length) return;
        var ax = [], hx = [];
        Object.keys(playerState).forEach(function (k) { var st = playerState[k]; if (st.leaving) return; (st.side === 'away' ? ax : hx).push(st.x); });
        ax.sort(function (a, b) { return b - a; }); hx.sort(function (a, b) { return a - b; });
        var bx = clamp(ball.x, 0, 100);
        var lines = [clamp(Math.max(ax[1] != null ? ax[1] : 70, bx), 50, 99), clamp(Math.min(hx[1] != null ? hx[1] : 30, bx), 1, 50)];
        if (simExiting) {
            var te = simLogOfVis(50, 106);
            simAR.forEach(function (a) { a.tx = te.x; a.ty = te.y; a.spd = 2.6; a.flagUntil = 0; stepMover(a, dt, 1); });
            return;
        }
        lines.forEach(function (tx, i) {
            var a = simAR[i];
            // Con un saque de banda en su banda, el linier se aparta para no taparse con el que saca.
            var rT = simRestart && simRestart.type === 'throw' && simRestart.takerAt;
            if (rT && (i === 0) === (rT.y < 50) && Math.abs(tx - rT.x) < 8) {
                var away = tx >= rT.x ? 1 : -1;
                if (rT.x + away * 8 > 99 || rT.x + away * 8 < 1) away = -away;
                tx = rT.x + away * 8;
            }
            a.tx = tx; a.ty = i === 0 ? -2.3 : 101.9;
            a.spd = clamp(Math.abs(tx - a.x) * M_X * 1.3, 0.5, 7);
            stepMover(a, dt, 1);
        });
    }

    // Jugadas narradas: córner, saque de puerta, de banda, faltas (con o sin barrera), fuera de juego, protestas.
    function markSetPieces(phases, play, attack) {
        if (!phases.length) return phases;
        var t = foldText(play.text);
        var opp = oppOf(attack);
        var p0, i;
        if (play.kind === 'corner') {
            for (i = 0; i < phases.length; i++) {
                p0 = (phases[i].ballPath || [])[0];
                if (p0 && (p0.x > 93 || p0.x < 7) && (p0.y < 12 || p0.y > 88)) {
                    var nx = phases[i].ballPath[1];
                    phases[i].setPiece = { type: 'corner', side: attack, spot: { x: p0.x > 50 ? 99.6 : 0.4, y: p0.y < 50 ? 0.6 : 99.4 },
                        kick: nx ? { x: nx.x, y: nx.y, kind: 'lofted' } : null };
                    phases[i].ms = Math.max(phases[i].ms || 700, 2600);
                    break;
                }
            }
            return phases;
        }
        if (play.kind === 'throwin' || play.kind === 'goalkick') {
            p0 = (phases[0].ballPath || [])[0];
            if (p0) {
                var sp = play.kind === 'throwin' ? { type: 'throw', side: attack, spot: { x: clamp(p0.x, 1, 99), y: p0.y < 50 ? 0 : 100 } }
                    : { type: 'goalkick', side: attack, spot: { x: attack === 'home' ? 5.2 : 94.8, y: 41 } };
                phases[0].setPiece = sp;
                phases[0].ms = Math.max(phases[0].ms || 700, 2200);
            }
            return phases;
        }
        var offsideCall = /fuera de juego|bandera|banderin/.test(t) && /(levanta(do)? la bandera|levanta el banderin|senala (el )?fuera de juego|fuera de juego senalado|pita (el )?fuera de juego|anulado por fuera de juego)/.test(t) && !/no levanta/.test(t);
        var appeal = !offsideCall && /(pide fuera de juego|me parecio fuera de juego|desastre de fuera de juego|busco el fuera de juego|en claro fuera de juego)/.test(t);
        var isFoul = play.kind === 'foul' || ((play.kind === 'yellow' || play.kind === 'red') && /falta|derrib|entrada|zancadill|agarr|codazo|plancha|pisot|agrede/.test(t));
        if (!isFoul && /^(clearance|play|counter|box|injury)$/.test(play.kind) && /(falta (peligrosa|muy cerca|cerca|de |sobre)|comete (una )?falta|derriba a)/.test(t)) isFoul = true;
        var first = phases[0], lp = first.ballPath || [], fp = lp[lp.length - 1] || { x: 50, y: 50 };
        if (offsideCall) {
            // El asistente levanta la bandera y saca el equipo que defendía, desde donde estaba el adelantado.
            var spotO = { x: clamp(fp.x, 3, 97), y: clamp(fp.y, 4, 96) };
            first.ms = Math.min(first.ms || 700, 900);
            // Fuera de juego de verdad: en el momento del pase el receptor está por delante del penúltimo defensor.
            var opl = first.players || {}, ogx = goalXOf(attack), odir = ogx === 100 ? 1 : -1;
            var isGkK = function (k) { var st = playerState[k]; return st ? st.pos === 'GK' : false; };
            var lp0 = lp[0] || fp, passer = null, receiver = null, pd = 1e9, rd = 1e9;
            Object.keys(opl).forEach(function (k) {
                if (k.split(':')[0] !== attack || isGkK(k)) return;
                var d0 = mDist(opl[k].x, opl[k].y, lp0.x, lp0.y);
                if (d0 < pd) { pd = d0; passer = k; }
            });
            Object.keys(opl).forEach(function (k) {
                if (k.split(':')[0] !== attack || isGkK(k) || k === passer) return;
                var d1 = mDist(opl[k].x, opl[k].y, fp.x, fp.y);
                if (d1 < rd) { rd = d1; receiver = k; }
            });
            if (receiver && passer) {
                var lineX = ogx - odir * (13 + rng() * 6) / M_X;
                var np = {};
                Object.keys(opl).forEach(function (k) {
                    var t0 = opl[k];
                    if (k.split(':')[0] === opp && !isGkK(k) && (t0.x - lineX) * odir > 0) np[k] = { x: lineX - odir * rng() * 0.6, y: t0.y };   // la defensa sube en línea
                    else if (k.split(':')[0] === attack && k !== receiver && (t0.x - lineX) * odir > -1 / M_X) np[k] = { x: lineX - odir * (1.5 + rng() * 3) / M_X, y: t0.y };   // los demás, en posición legal
                    else np[k] = { x: t0.x, y: t0.y };
                });
                var ry = clamp(fp.y, 24, 76);
                np[receiver] = { x: lineX + odir * (2.2 + rng() * 1.6) / M_X, y: ry };
                var pp = np[passer];
                if ((pp.x - lineX) * odir > -6 / M_X) np[passer] = pp = { x: lineX - odir * (12 + rng() * 6) / M_X, y: pp.y };
                first.players = np;
                first.ballPath = [{ x: pp.x, y: pp.y }, { x: np[receiver].x, y: np[receiver].y }];
                first.waitRecv = receiver;
                first.ms = 1800;
                spotO = { x: clamp(np[receiver].x, 3, 97), y: clamp(np[receiver].y, 4, 96) };
            }
            return [first, { players: clonePlayers(first.players), ballPath: [{ x: spotO.x, y: spotO.y }], ms: 2600, highlight: first.highlight, ref: first.ref,
                setPiece: { type: 'free', side: opp, spot: spotO, offside: true } }];
        }
        if (appeal) first.appeal = opp;
        if (!isFoul && play.kind === 'goal' && FK_GOAL_RE.test(t) && !/penalti/.test(t)) {
            // Gol de falta directa: se coloca el balón, barrera si está cerca, y el lanzamiento entra entre los palos.
            var ggx = goalXOf(attack), gdir = ggx === 100 ? 1 : -1;
            var gspot = { x: clamp(fp.x, 3, 97), y: clamp(fp.y, 4, 96) };
            var gdist = Math.hypot((ggx - gspot.x) * M_X, (50 - gspot.y) * M_Y);
            if (gdist > 32 || gdist < 17) { gspot = { x: ggx - gdir * (20 + rng() * 6) / M_X, y: 38 + rng() * 24 }; gdist = Math.hypot((ggx - gspot.x) * M_X, (50 - gspot.y) * M_Y); }
            var gside = rng() < 0.5 ? -1 : 1;
            var gtail = phases.filter(function (ph) { return ph.pose === true || ph.pose === false; });
            return [{ players: clonePlayers(first.players), ballPath: [{ x: gspot.x, y: gspot.y }], ms: 3600, highlight: first.highlight, ref: null,
                setPiece: { type: 'free', side: attack, spot: gspot, wallUp: Math.abs(gspot.y - 50) < 30, fkGoal: true, kick: { x: ggx + gdir * 1.8, y: 50 + gside * (2.2 + rng() * 2.4), kind: 'shot', net: true } } }].concat(gtail);
        }
        if (isFoul) {
            var fouled = opp, fgx = goalXOf(fouled), fdir = fgx === 100 ? 1 : -1;
            var spot = { x: clamp(fp.x, 3, 97), y: clamp(fp.y, 4, 96) };
            if (/cerca del area|peligros|frontal|borde del area/.test(t)) spot = { x: fgx - fdir * (20 + rng() * 6) / M_X, y: 38 + rng() * 24 };
            var dist = Math.hypot((fgx - spot.x) * M_X, (50 - spot.y) * M_Y);
            var wallUp = dist < 32 && Math.abs(spot.y - 50) < 30;
            var kick = null, side = rng() < 0.5 ? -1 : 1;
            if (wallUp) {
                var gdx = (fgx - spot.x) * M_X, gdy = (50 - spot.y) * M_Y, gl = Math.max(0.1, Math.hypot(gdx, gdy));
                var wallAt = { x: spot.x + gdx / gl * 9.15 / M_X, y: spot.y + gdy / gl * 9.15 / M_Y };
                if (play.kind === 'goal') kick = { x: fgx + fdir * 1.8, y: 50 + side * (2.2 + rng() * 2.4), kind: 'shot', net: true };   // falta directa a la red (entre los palos)
                else if (/barrera/.test(t) && /estrell|rebota|choca|se queda|despeja/.test(t)) kick = { x: wallAt.x, y: wallAt.y, kind: 'shot' };
                else if (/larguero|por encima|alto|arriba|nubes/.test(t)) kick = { x: fgx + fdir * 2.6, y: 50 + side * rng() * 2.5, kind: 'over', net: true };
                else if (/portero|ataja|vuela|atrapa|blocad|saca la falta|despeja|desvi|rechaz|detiene|manopla|para el|repele/.test(t)) kick = { x: fgx - fdir * 1.2, y: 50 + side * 2.5, kind: 'shot' };
                else kick = { x: fgx + fdir * 1.8, y: 50 + side * (5.6 + rng() * 3), kind: 'shot', net: true };
            }
            var carded = play.kind === 'yellow' || play.kind === 'red';
            var protest = carded || /protest|reclam|airad/.test(t) || rng() < 0.4;
            // El lanzamiento se narra en la jugada siguiente (gol de falta): aquí solo se coloca y espera.
            var holdFk = simulating && simNextKind === 'goal' && simNextSide === fouled && FK_GOAL_RE.test(simNextText) && !/falta[^.]{0,40}\bsobre\b|comete (una )?falta|derriba/.test(simNextText);
            if (holdFk) kick = null;
            var spPh = { players: clonePlayers(first.players), ballPath: [{ x: spot.x, y: spot.y }], ms: wallUp ? 3600 : 2400, highlight: first.highlight, ref: null,
                setPiece: { type: 'free', side: fouled, spot: spot, wallUp: wallUp, kick: kick, protest: protest ? attack : null, protestN: carded ? 3 : 2, hold: holdFk } };
            return [first, spPh];
        }
        var penKick = /penalti/.test(t) && (play.kind === 'penalty' || play.kind === 'goal') &&
            /(punto (fatidico|de penalti)|coloca la pelota|coloca el balon|carrerilla|coge el balon|lanza|ejecuta|chuta|dispara|transforma|detiene|ataja|para el penalti|bloca|falla|al palo|palo contrario|imparable|se tiro|adivin|engana|a la red|gol)/.test(t);
        if (penKick) {
            var pgx = goalXOf(attack), pfd = pgx === 100 ? 1 : -1, pside = rng() < 0.5 ? -1 : 1;
            var pspot = { x: pgx - pfd * 11 / M_X, y: 50 };
            var pkick;
            if (play.kind === 'goal') pkick = { x: pgx + pfd * 1.8, y: 50 + pside * (2.2 + rng() * 2), kind: 'shot', net: true };
            else if (/(fuera|desviad|al palo|poste|larguero|por encima|alto|nubes|lo manda)/.test(t) && !/(detiene|ataja|para |bloca|despeja|con los pies|vuela)/.test(t))
                pkick = /(larguero|por encima|alto|nubes)/.test(t) ? { x: pgx + pfd * 2.6, y: 50 + pside * 1.5, kind: 'over' } : { x: pgx + pfd * 2.2, y: 50 + pside * 6.2, kind: 'shot' };
            else pkick = { x: pgx - pfd * 0.9, y: 50 + pside * 2.0, kind: 'shot' };
            var penPh = { players: clonePlayers(first.players), ballPath: [{ x: pspot.x, y: pspot.y }], ms: 3000, highlight: first.highlight, ref: null,
                setPiece: { type: 'penalty', side: attack, spot: pspot, kick: pkick, protest: opp, protestN: 3 } };
            var tail = [];
            if (play.kind === 'goal') phases.forEach(function (q) { if (q.pose === true || q.pose === false) tail.push(q); });
            first.ms = Math.min(first.ms || 700, 900);
            return [first, penPh].concat(tail);
        }
        if (play.kind === 'penalty' || /\bvar\b|anulad|anula el gol/.test(t)) {
            // Penalti, VAR o gol anulado: los afectados rodean al árbitro.
            var who = play.kind === 'penalty' ? opp : (/anula/.test(t) ? attack : opp);
            (phases[1] || phases[0]).protest = { side: who, n: 3 };
        }
        return phases;
    }

    // Saques de banda, de puerta y córners plausibles en el juego que la narración no detalla.
    function addPlausibleOut(phases, play, attack) {
        if (!phases.length) return;
        // Jugada sin detalle: a veces empieza con un saque de banda que pone el balón donde arranca.
        var q0 = (phases[0].ballPath || [])[0];
        if (play.kind === 'play' && q0 && !phases[0].setPiece && simSegT >= 3.9 && rng() < 0.6) {
            var tdir = attack === 'home' ? 1 : -1, ty = q0.y < 50 ? 0 : (q0.y > 50 ? 100 : (rng() < 0.5 ? 0 : 100));
            phases[0].setPiece = { type: 'throw', side: attack, spot: { x: clamp(q0.x - tdir * (4 + rng() * 6), 4, 96), y: ty }, kick: { x: q0.x, y: q0.y, kind: 'lofted' }, optional: true };
            phases[0].ms = Math.max(phases[0].ms || 700, 2200);
            return;
        }
        var last = phases[phases.length - 1], lp = last.ballPath || [], e = lp[lp.length - 1];
        if (!e || e.kind) return;
        // Si la jugada siguiente empieza con su propia falta o reanudación, este balón no se va fuera (no se encadenan dos).
        if (/^(foul|yellow|red|penalty|corner|throwin|goalkick|offside|freekick)$/.test(simNextKind || '')) return;
        var dir = attack === 'home' ? 1 : -1;
        if (play.kind === 'clearance' && rng() < 0.7) {
            lp.push({ x: clamp(e.x + dir * (6 + rng() * 8), 3, 97), y: e.y < 50 ? -3 : 103, kind: 'lofted' });
        } else if (play.kind === 'wing' && rng() < 0.35 && (e.y < 18 || e.y > 82)) {
            lp.push({ x: clamp(e.x + dir * 6, 3, 97), y: e.y < 50 ? -2.5 : 102.5, kind: 'ground' });
        } else if ((play.kind === 'play' || play.kind === 'counter') && rng() < 0.6) {
            // Pase largo que se va por la banda: saque de banda para el rival.
            var wy = e.y < 50 ? -2.5 : 102.5;
            lp.push({ x: clamp(e.x + dir * (8 + rng() * 10), 6, 94), y: wy, kind: rng() < 0.5 ? 'lofted' : 'ground' });
        }
    }

    /* ---- Simulación ---- */
    function simMirror() {
        Object.keys(playerState).forEach(function (k) { mirrorObj(playerState[k]); });
        Object.keys(simLeavers).forEach(function (k) { mirrorObj(simLeavers[k]); });
        mirrorObj(refState);
        ball.x = 100 - ball.x; ball.y = 100 - ball.y;
        if (ball.fl) { mirrorObj(ball.fl.from); mirrorObj(ball.fl.to); }
        simStaff.forEach(function (o) { if (o.on) mirrorObj(o); });
    }

    var simLeavers = {}, simStaff = [], simScene = null, simFlipped = false;

    function simLogOfVis(vx, vy) { return simFlipped ? { x: 100 - vx, y: 100 - vy } : { x: vx, y: vy }; }
    function simVisOf(x, y) { return simFlipped ? { x: 100 - x, y: 100 - y } : { x: x, y: y }; }

    function simSpawn(p, sideKey, vis, d) {
        var lg = simLogOfVis(vis.x, vis.y);
        return { name: p.name, side: sideKey, pos: normalizePos(p.position), baseX: 50, baseY: 50, x: lg.x, y: lg.y, vx: 0, vy: 0, tx: lg.x, ty: lg.y, hx: lg.x, hy: lg.y, spd: 3 };
    }

    function simLeave(k, why) {
        var st = playerState[k];
        if (!st) return;
        var v = simVisOf(st.x, st.y);
        var tgt = why === 'red' ? { x: 50, y: 106 } : (why === 'exit' ? { x: 48 + rng() * 4, y: 106 + rng() * 3 } : { x: clamp(v.x, 4, 96), y: v.y < 50 ? -5 : 105 });
        var lg = simLogOfVis(tgt.x, tgt.y);
        st.leaving = why; st.pend = null; st.hold = false;
        st.tx = lg.x; st.ty = lg.y; st.hx = null;
        st.spd = why === 'red' ? 1.5 : (why === 'exit' ? 3.1 : 3.6);
        simLeavers[k] = st;
        delete playerState[k];
        if (ball.owner === k) { ball.state = 'free'; ball.owner = null; }
    }

    function simStepLeavers(dt) {
        Object.keys(simLeavers).forEach(function (k) {
            var st = simLeavers[k];
            var d = stepMover(st, dt, 1);
            var v = simVisOf(st.x, st.y);
            if (d < 0.6 || v.y > 103.5 || v.y < -3.5) { st.gone = true; delete simLeavers[k]; }
        });
    }

    function simStartInjury(play) {
        var k = injuredKey(play);
        if (!k || simScene) return;
        var st = playerState[k];
        var t = foldText(play.text);
        var w = t.match(/lesion de (\d+) semana/);
        var serious = /camilla|no puede seguir|grave|retirado/.test(t) || (w ? parseInt(w[1], 10) >= 2 : /cae lesionado/.test(t));
        st.hold = true; st.pend = null; st.tx = st.x; st.ty = st.y; st.vx = 0; st.vy = 0; st.down = 1;
        var bench = BENCH[st.side];
        simStaff[0].on = simStaff[1].on = true;
        [0, 1].forEach(function (i) {
            var lg = simLogOfVis(bench.x + (i ? 2 : -2), 102.2);
            var o = simStaff[i];
            o.x = o.tx = lg.x; o.y = o.ty = lg.y; o.vx = o.vy = 0; o.spd = 5.5;
        });
        simScene = { key: k, st: st, serious: serious, stage: 0, t: 0, side: st.side };
    }

    function simStepScene(dt) {
        var sc = simScene;
        if (!sc) return;
        sc.t += dt;
        var st = sc.st, m0 = simStaff[0], m1 = simStaff[1], str = simStaff[2];
        var alive = playerState[sc.key] === st || sc.subbed;
        if (!alive && sc.stage < 4) sc.stage = 4;
        if (sc.stage === 0 && sc.t > 0.6) {
            [m0, m1].forEach(function (m, i) { m.tx = clamp(st.x + (i ? 1.6 : -1.6), 1, 99); m.ty = clamp(st.y + 1.2, 1, 99); m.spd = 5.5; });
            sc.stage = 1; sc.t = 0;
        } else if (sc.stage === 1) {
            if ((mDist(m0.x, m0.y, m0.tx, m0.ty) < 0.7 && mDist(m1.x, m1.y, m1.tx, m1.ty) < 0.7) || sc.t > 9) { sc.stage = 2; sc.t = 0; }
        } else if (sc.stage === 2 && sc.t > 1.8) {
            if (sc.serious) {
                str.on = true; str.x = st.x; str.y = st.y;
                var v = simVisOf(st.x, st.y);
                sc.exit = simLogOfVis(clamp(v.x, 8, 92), 101.6);
                st.down = 2;
                sc.stage = 3; sc.t = 0;
            } else { sc.stage = 4; sc.t = 0; st.hold = false; st.down = 0; if (st.hx != null) { st.tx = st.hx; st.ty = st.hy; st.spd = 2.5; } }
        } else if (sc.stage === 3) {
            var sp = 1.8 * dt;
            var dx = (sc.exit.x - st.x) * M_X, dy = (sc.exit.y - st.y) * M_Y, dd = Math.hypot(dx, dy);
            if (dd > 0.2) { st.x += dx / dd * Math.min(sp, dd) / M_X; st.y += dy / dd * Math.min(sp, dd) / M_Y; }
            st.tx = st.x; st.ty = st.y; st.vx = st.vy = 0;
            str.x = st.x; str.y = st.y;
            m0.x = m0.tx = st.x - 3.2 / M_X * (simFlipped ? -1 : 1); m0.y = m0.ty = st.y;
            m1.x = m1.tx = st.x + 3.2 / M_X * (simFlipped ? -1 : 1); m1.y = m1.ty = st.y;
            if (dd <= 0.2 || sc.t > 30) { sc.stage = 4; sc.t = 0; sc.returnAt = 6; }
        } else if (sc.stage === 4) {
            str.on = false;
            if (sc.subbed) {
                st.hold = false; st.down = 0;
                playerState[sc.key] = st; simLeave(sc.key, 'sub'); sc.subbed = false; sc.returnAt = 0;
            }
            var b = BENCH[sc.side];
            [m0, m1].forEach(function (m) { var lg = simLogOfVis(b.x, 102.4); m.tx = lg.x; m.ty = lg.y; m.spd = 3; });
            sc.stage = 5; sc.t = 0;
        } else if (sc.stage === 5) {
            if (sc.returnAt && sc.t > sc.returnAt && playerState[sc.key] === st) {
                st.hold = false; st.down = 0; sc.returnAt = 0;
                if (st.hx != null) { st.tx = st.hx; st.ty = st.hy; st.spd = 3; }
            }
            if (mDist(m0.x, m0.y, m0.tx, m0.ty) < 0.8 && mDist(m1.x, m1.y, m1.tx, m1.ty) < 0.8 && !sc.returnAt) {
                m0.on = m1.on = false;
                if (playerState[sc.key] === st && st.hold) { st.hold = false; st.down = 0; }
                simScene = null;
                return;
            }
        }
        if (sc.stage !== 3) { stepMover(m0, dt, 1); stepMover(m1, dt, 1); }
    }

    // Con la jugada ya resuelta y tiempo de sobra, el poseedor en zona de remate no se queda clavado:
    // busca hueco con pequeños movimientos (sin pasarse de la frontal del área pequeña).
    function simHolderSearch(now, attack) {
        if (ball.state !== 'held' || !ball.owner) return;
        var o = playerState[ball.owner];
        if (!o || o.hold) return;
        var att = o.side;
        var ax = ptAtt(o.x, att);
        if (now < (o.searchAt || 0)) return;
        if (ax < 78) {
            // Sin jugada narrada: conduce hacia delante con calma (no se queda plantado con el balón).
            o.tx = fromAtt(Math.min(78, ax + 5 + rng() * 5), att); o.ty = clamp(o.y + (rng() - 0.5) * 8, 10, 90);
            o.spd = 2 + rng(); o.searchAt = now + 1100 + rng() * 600;
            return;
        }
        var nax = clamp(ax + (rng() - 0.3) * 4, 78, 90);
        o.tx = fromAtt(nax, att); o.ty = clamp(o.y + (rng() - 0.5) * 9, 22, 78);
        o.spd = 1.6 + rng();
        o.searchAt = now + 900 + rng() * 700;
    }

    // Balón suelto sin jugada en curso: el más cercano va a por él (nunca se queda solo en el césped).
    function simChaseLoose() {
        var best = null, bd = 1e9;
        Object.keys(playerState).forEach(function (k) {
            var st = playerState[k];
            if (st.leaving || st.down || st.pos === 'GK') return;
            var dd = mDist(st.x, st.y, ball.x, ball.y);
            if (dd < bd) { bd = dd; best = st; }
        });
        if (!best || bd < 0.3) return;
        best.tx = ball.x; best.ty = ball.y; best.hx = ball.x; best.hy = ball.y; best.pend = null;
        best.spd = Math.max(best.spd || 0, 6.5);
    }

    function simStep(dt, ctx) {
        var now = nowMs();
        if (ctx.attack) simAttackSide = ctx.attack;
        if (simRestart) {
            if (motor.phase) motor.phaseT += dt;
            if (!ctx.frozen) stepRestart(dt);
        } else if (motor.waitRestart) {
            motor.waitRestart = false;
            if (motor.phases.length) startMotorPhase(motor.phases.shift());
        } else if (motor.phase) {
            motor.phaseT += dt;
            stepAction(dt);
            var busy = motor.action || motor.actions.length || ball.state === 'flight';
            var holdCel = motor.holdNext && motor.phases.length && motor.phases[0].pose === true;   // gol aún sin marcar: nadie celebra antes
            if (motor.phaseT >= motor.phaseDur && !busy) { if (!holdCel) startMotorPhase(motor.phases.length ? motor.phases.shift() : null); }
            else if (motor.phaseT > motor.phaseDur + 4 && !holdCel) { motor.actions = []; motor.action = null; startMotorPhase(motor.phases.length ? motor.phases.shift() : null); }
        } else if (ctx.search) simHolderSearch(now, ctx.attack);
        if (!simRestart && !ctx.frozen && ball.state === 'free' && !ball.lock && !ball.goalNet && (!motor.phase || (!motor.action && !motor.actions.length))) simChaseLoose();
        var allowIdle = !simRestart && (!motor.phase || motor.phaseT > motor.phaseDur * 0.9);
        Object.keys(playerState).forEach(function (k) {
            var st = playerState[k];
            if (st.pend) applyPending(st, now);
            var d = stepMover(st, dt, 1);
            if (allowIdle && !st.hold && !ctx.frozen && !(motor.phase && motor.phase.pose) && k !== ball.owner) idleWander(st, now, d);
        });
        stepMover(refState, dt, 1);
        stepBall(dt);
        if (!ctx.frozen) simCheckOut();
        simStepAR(dt);
        simStepLeavers(dt);
        simStepScene(dt);
    }

    function buildTimeline(d) {
        var t0 = performance.now();
        var plays = buildPlays(d);
        var lh = buildLineupHistory(d, plays);
        var dInit = Object.assign({}, d, { homeStarters: lh.hist.length ? lh.hist[0].before.home : lh.init.home, awayStarters: lh.hist.length ? lh.hist[0].before.away : lh.init.away, redCarded: [] });
        ensureRosterNumbers(Object.assign({}, d, { homeStarters: d.homeStartersInit && d.homeStartersInit.length ? d.homeStartersInit : d.homeStarters,
            awayStarters: d.awayStartersInit && d.awayStartersInit.length ? d.awayStartersInit : d.awayStarters,
            homeSubs: d.homeSubsInit && d.homeSubsInit.length ? d.homeSubsInit : d.homeSubs, awaySubs: d.awaySubsInit && d.awaySubsInit.length ? d.awaySubsInit : d.awaySubs }));
        // Figuras: todos los que pisan el campo en algún momento + árbitro + asistencias + camilla.
        var figs = [], fidx = {};
        function addFig(key, info) { if (fidx[key] != null) return; fidx[key] = figs.length; info.key = key; figs.push(info); }
        function addLineup(lu) { ['home', 'away'].forEach(function (s) { (lu[s] || []).forEach(function (p) { addFig(keyOf(s, p.name), { type: 'player', side: s, name: p.name, pos: normalizePos(p.position) }); }); }); }
        addLineup(dInit.homeStarters ? { home: dInit.homeStarters, away: dInit.awayStarters } : lh.init);
        lh.hist.forEach(function (h) { addLineup(h.after); });
        addFig('REF', { type: 'ref' });
        addFig('MED1', { type: 'medic' }); addFig('MED2', { type: 'medic' }); addFig('STR', { type: 'stretcher' });
        addFig('AR1', { type: 'ar' }); addFig('AR2', { type: 'ar' });
        var N = figs.length;
        // Duración nominal de cada tramo (a «Medio», 2 s por línea).
        var segDur = plays.map(function (p) {
            var t = Math.max(1, (p.lines && p.lines.length) || playLines(p)) * NOMINAL_LINE;
            // Cambio: el juego se para el tiempo suficiente para que salga uno y entre el otro
            // (la reproducción se queda un poco por detrás y luego se pone al día sin saltos).
            if (p.kind === 'sub') t = Math.max(t, 4.6);
            return t;
        });
        var KICK = 1.6, EXIT = 26;
        var total = KICK + segDur.reduce(function (a, b) { return a + b; }, 0) + EXIT;
        var S = Math.ceil(total / SAMPLE_DT) + 3;
        var X = new Float32Array(S * N), Y = new Float32Array(S * N), V = new Uint8Array(S * N), F = new Uint8Array(S * N);
        var BX = new Float32Array(S), BY = new Float32Array(S), BH = new Float32Array(S), BS = new Int8Array(S), BO = new Int16Array(S);
        var segs = [];
        // Guardar el estado vivo y simular en un mundo aparte.
        var saved = { playerState: playerState, ball: ball, refState: refState, motor: motor, ends: ends.flipped };
        simulating = true; simClock = 0; simSeed = 12345; simLeavers = {}; simScene = null; simFlipped = false;
        simDbg = []; simRestart = null; simEvents = []; simNs = 0; simGoalPlay = false; simAttackSide = 'home'; simExiting = false; simInitAR();
        simStaff = [{ on: false, x: 0, y: 0, vx: 0, vy: 0, spd: 5 }, { on: false, x: 0, y: 0, vx: 0, vy: 0, spd: 5 }, { on: false, x: 0, y: 0, vx: 0, vy: 0, spd: 2 }];
        var ns = 0;
        try {
            playerState = {};
            motor = { raf: 0, last: 0, running: false, phases: [], phase: null, phaseT: 0, phaseDur: 1, actions: [], action: null, actionT: 0, scale: 1, frame: 0, seekFrame: -1, stats: { plays: 0, cut: 0, droppedPhases: 0 } };
            ball = { x: 50, y: 50, h: 0, state: 'free', owner: null };
            refState = { x: 56, y: 70, tx: 56, ty: 70, vx: 0, vy: 0, spd: 3, el: null, name: '' };
            var kick = resolvePlay(null, dInit).phases[0];
            layoutTeam(dInit.homeStarters, 'home').concat(layoutTeam(dInit.awayStarters, 'away')).forEach(function (p) {
                var k = keyOf(p.side, p.name), t = kick.players[k] || { x: p.x, y: p.y };
                playerState[k] = { name: p.name, side: p.side, pos: p.pos, baseX: p.x, baseY: p.y, x: t.x, y: t.y, vx: 0, vy: 0, tx: t.x, ty: t.y, hx: t.x, hy: t.y, spd: 2 };
            });
            if (kick.ref) { refState.x = refState.tx = kick.ref.x; refState.y = refState.ty = kick.ref.y; }
            var nextSample = 0;
            function record() {
                if (ns >= S) return;
                simNs = ns;
                if (window.__campoDbg) simDbg[ns] = (simRestart ? simRestart.type[0] + simRestart.stage : '-') + (motor.phase ? 'P' + motor.phases.length : '_') + (motor.action ? 'A' : '') + motor.actions.length + (ball.lock ? 'L' : '') + (ball.goalNet ? 'N' : '') + (function () { var bd = 99; Object.keys(playerState).forEach(function (k) { var st = playerState[k]; bd = Math.min(bd, mDist(st.x, st.y, ball.x, ball.y)); }); return 'd' + bd.toFixed(1); })();
                var base = ns * N;
                figs.forEach(function (f, i) {
                    var o = null, flag = 0;
                    if (f.type === 'player') {
                        o = playerState[f.key] || simLeavers[f.key];
                        if (o) flag = o.down || (o.leaving === 'red' ? 3 : (!playerState[f.key] && o.leaving === 'sub' ? 4 : 0)) || (o.throwing ? 5 : 0) || (o.protestUntil > simClock ? 7 : 0);
                    }
                    else if (f.type === 'ref') o = refState;
                    else if (f.type === 'ar') { o = simAR[f.key === 'AR1' ? 0 : 1]; if (o) flag = o.flagUntil > simClock ? 6 : 0; }
                    else { var so = simStaff[f.type === 'stretcher' ? 2 : (f.key === 'MED1' ? 0 : 1)]; o = so.on ? so : null; }
                    if (o) { var v = simVisOf(o.x, o.y); X[base + i] = v.x; Y[base + i] = v.y; V[base + i] = 1; F[base + i] = flag; }
                    else if (ns > 0) { X[base + i] = X[base - N + i]; Y[base + i] = Y[base - N + i]; }
                });
                var bv = simVisOf(ball.x, ball.y);
                BX[ns] = bv.x; BY[ns] = bv.y; BH[ns] = ball.h || 0;
                BS[ns] = ball.state === 'held' ? 0 : ball.state === 'free' ? 1 : (BALL_CODE[(ball.fl && ball.fl.kind) || 'ground'] || 2);
                BO[ns] = ball.owner && fidx[ball.owner] != null ? fidx[ball.owner] : -1;
                ns++;
            }
            function advance(T, ctx, onStep) {
                var end = simClock + T - 1e-9;
                while (simClock < end) {
                    simStep(SIM_DT, ctx);
                    simClock += SIM_DT;
                    if (onStep) onStep();
                    while (simClock >= nextSample - 1e-9) { record(); nextSample += SAMPLE_DT; }
                }
            }
            record(); nextSample = SAMPLE_DT;
            segs.push({ i: -1, s0: 0, kind: 'kickoff', pose: 0, period: 1, flipped: false });
            simEvents.push({ s: 0, type: 'kickoff', x: 50, y: 50 });
            advance(KICK, { frozen: true });
            var period = 1;
            // Antes del descanso o del final: la falta narrada pendiente se lanza (no se queda sin sacar).
            function finishPending() {
                if (simRestart) simRestart.hold = false;
                if (!simRestart && motor.phases && motor.phases.length) {
                    var endSp = null;
                    motor.phases.forEach(function (q) { if (!endSp && q.setPiece) endSp = q.setPiece; });
                    if (endSp) { motor.actions = []; motor.action = null; motor.phases = []; beginRestart(endSp); }
                }
                if (simRestart && !simRestart.auto) {
                    var lastSeg = segs[segs.length - 1], tEnd = simClock + 10;
                    while (simRestart && simClock < tEnd) advance(0.2, { attack: simAttackSide, frozen: false, search: false });
                    if (!simRestart) advance(1.2, { attack: simAttackSide, frozen: false, search: false });
                    if (lastSeg && lastSeg.i >= 0) lastSeg.s1 = ns;
                }
            }
            plays.forEach(function (play, i) {
                var h = lh.hist[i];
                var p = play.minute === 'tanda' || play.kind === 'shootout' || play.kind === 'shootout-kick' ? period : periodOf(play);
                if ((p % 2 === 0) !== simFlipped) finishPending();
                var seg = { i: i, s0: ns, kind: play.kind, period: p, cut: false };
                // Cambio de campo: cada uno aparece ya en su mitad (la reproducción lo funde a negro y vuelve).
                if ((p % 2 === 0) !== simFlipped) { simFlipped = !simFlipped; seg.flip = true; seg.jumpFlip = true; }
                // Descanso (fundido): la segunda parte arranca con el balón ya en el centro.
                if (seg.jumpFlip && play.kickoffBefore) {
                    if (simRestart) { simRestart = null; }
                    ball.x = 50; ball.y = 50; ball.h = 0; ball.state = 'free'; ball.owner = null; ball.fl = null; ball.lock = false; ball.goalNet = false;
                }
                period = p;
                seg.flipped = simFlipped;
                // Altas que no han entrado por un cambio narrado (por si acaso): aparecen desde el banquillo.
                var dP = Object.assign({}, d, { homeStarters: h.before.home, awayStarters: h.before.away, redCarded: [] });
                var T = segDur[i];
                simSegT = T;
                simNextKind = plays[i + 1] ? plays[i + 1].kind : null;
                simNextText = plays[i + 1] ? foldText(plays[i + 1].text || '') : '';
                simNextSide = plays[i + 1] ? sideOfTeam(plays[i + 1].team, dP) : null;
                // Falta, córner... de la jugada anterior que no llegó a empezar: se hace ahora (nunca se pierde).
                var leftSpPh = null;
                if (motor.phases && motor.phases.length && !(play.kind === 'sub')) {
                    var leftSp = null;
                    motor.phases.forEach(function (q) { if (!leftSp && q.setPiece) { leftSp = q.setPiece; leftSpPh = q; } });
                    // Si aún hay otra reanudación en curso (p. ej. un saque de banda), la falta va justo después.
                    if (leftSp && !simRestart) { beginRestart(Object.assign({}, leftSp, { hurry: true })); leftSpPh = null; }
                }
                var plan = planPlay(play, dP);
                // Tras el descanso (fundido) todos aparecen ya en la formación de saque de centro.
                if (seg.jumpFlip && play.kickoffBefore && plan.phases[0]) {
                    var kt = plan.phases[0].players || {};
                    Object.keys(playerState).forEach(function (k) {
                        var st = playerState[k], t = kt[k];
                        if (!t || st.leaving) return;
                        st.x = t.x; st.y = t.y; st.tx = t.x; st.ty = t.y; st.hx = t.x; st.hy = t.y; st.vx = 0; st.vy = 0; st.pend = null;
                    });
                }
                simGoalPlay = play.kind === 'goal' || play.kind === 'own-goal';
                simAttackSide = plan.info.attack;
                // Una reanudación pendiente sigue su curso en la jugada siguiente (la jugada espera); en los goles se ejecuta ya.
                // Una reanudación pendiente (falta con barrera, córner...) termina antes de que empiece la jugada nueva:
                // la jugada espera a que se lance (nunca se lanza a medio colocar).
                seg.attack = plan.info.attack; seg.outcome = plan.info.outcome; seg.fixed = plan.info.fixed;
                var isSub = h.events.some(function (e) { return e.type === 'sub'; });
                var ctx = { attack: plan.info.attack, frozen: false, search: true };
                if (isSub && play.kind === 'sub') {
                    // Parón: el balón no está en juego mientras se hace el cambio.
                    motor.phases = []; motor.phase = null; motor.waitRestart = false; motor.actions = []; motor.action = null;
                    if (ball.state === 'flight') { ball.state = 'free'; ball.fl = null; ball.h = 0; }
                    Object.keys(playerState).forEach(function (k) { var st = playerState[k]; st.tx = st.x; st.ty = st.y; st.hx = st.x; st.hy = st.y; st.pend = null; });
                    ctx.frozen = true; ctx.search = false;
                    seg.pause = true;
                } else {
                    var phases = plan.phases;
                    var avail = T * 0.82;
                    var sum = phases.reduce(function (a, q) { return a + (q.ms || 700) / 1000; }, 0);
                    motor.scale = clamp(avail / Math.max(0.3, sum), 0.5, 4.5);
                    var celI = phases.findIndex(function (q) { return q.pose === true; });
                    if ((play.kind === 'goal' || play.kind === 'own-goal') && celI > 0) {
                        // Gol: la jugada llega pronto al remate y queda tiempo para celebrarlo y sacar de centro.
                        var preSum = 0, postSum = 0;
                        phases.forEach(function (q, qi) { if (qi < celI) preSum += (q.ms || 700); else if (q.pose !== true) postSum += (q.ms || 700); });
                        var preT = T * 0.3, celT = T * 0.44, kickT = T * 0.12;
                        phases.forEach(function (q, qi) {
                            if (qi < celI) q.ms = (q.ms || 700) * preT * 1000 / Math.max(1, preSum);
                            else if (q.pose === true) q.ms = celT * 1000;
                            else q.ms = (q.ms || 700) * kickT * 1000 / Math.max(1, postSum);
                        });
                        motor.scale = 1;
                    }
                    // Saque de centro de la jugada anterior (tras gol) que no llegó a hacerse: va primero (pase atrás, nunca conduciendo).
                    var koLeft = [];
                    var koBall = (ball.state === 'flight' && ball.fl && ball.fl.kind === 'reset' && mDist(ball.fl.to ? ball.fl.to.x : 50, ball.fl.to ? ball.fl.to.y : 50, 50, 50) < 2) || (ball.state !== 'flight' && mDist(ball.x, ball.y, 50, 50) < 2.5);
                    if (!simRestart && (koBall || ball.goalNet)) {
                        var pend = (motor.phase ? [motor.phase] : []).concat(motor.phases || []);
                        var isKo = function (q) { var bp = q.ballPath || []; return q.kickoff || q.kickPass || (q.pose === false && bp.length === 1 && Math.abs(bp[0].x - 50) < 0.5 && Math.abs(bp[0].y - 50) < 0.5); };
                        var koI = pend.findIndex(isKo);
                        if (koI >= 0) koLeft = pend.slice(koI).filter(isKo).map(function (q) { var o = Object.assign({}, q); o.ms = Math.min(o.ms || 700, 900); return o; });
                    }
                    if (koLeft.length) phases = koLeft.concat(phases);
                    // Falta colocada en la jugada anterior y lanzada en esta (gol de falta): el lanzamiento es el de esta jugada.
                    if (simRestart && simRestart.hold) {
                        var fkI = phases.findIndex(function (q) { return q.setPiece && q.setPiece.fkGoal; });
                        if (fkI >= 0) { simRestart.kick = phases[fkI].setPiece.kick; simRestart.born = simClock; phases = phases.slice(0, fkI).concat(phases.slice(fkI + 1)); }
                        simRestart.hold = false;
                    }
                    if (leftSpPh) { var lsp = Object.assign({}, leftSpPh); lsp.setPiece = Object.assign({}, leftSpPh.setPiece, { hurry: true }); lsp.ms = Math.min(lsp.ms || 2400, 2400); phases = [lsp].concat(phases); }
                    motor.actions = []; motor.action = null;
                    if (simRestart) { motor.phases = phases.slice(0); motor.phase = null; motor.waitRestart = true; }
                    else { motor.waitRestart = false; motor.phases = phases.slice(1); startMotorPhase(phases[0]); }
                    if (play.kind === 'injury' || /cae lesionado|camilla/i.test(play.text || '')) simStartInjury(play);
                }
                // Cambios y expulsiones de esta jugada.
                h.events.forEach(function (e) {
                    var k = keyOf(e.side, e.type === 'sub' ? e.out : e.name);
                    if (e.type === 'sub') {
                        if (simScene && simScene.key === k && simScene.stage < 4) { simScene.subbed = true; delete playerState[k]; }
                        else simLeave(k, 'sub');
                        var rec = null;
                        h.after[e.side].forEach(function (q) { if (q.name === e.inn) rec = q; });
                        var nk = keyOf(e.side, e.inn);
                        var lay = layoutTeam(h.after[e.side], e.side).filter(function (q) { return q.name === e.inn; })[0];
                        var st = simSpawn(rec || { name: e.inn, position: 'MF' }, e.side, { x: 50 + (e.side === 'home' ? -1.5 : 1.5), y: 101.2 });
                        if (lay) { st.baseX = lay.x; st.baseY = lay.y; st.pos = lay.pos; var lt = { x: lay.x, y: lay.y }; st.hx = lt.x; st.hy = lt.y;
                            st.pend = { tx: lt.x, ty: lt.y, spd: 3.4, at: nowMs() + 1200 }; }
                        playerState[nk] = st;
                    } else if (e.type === 'red') simLeave(k, 'red');
                });
                var poseS = null, goalS = null, sadEnd = null, lastPhase = motor.phase;
                var segT0 = simClock, outForced = false, outIdx = -1, sawNet = false, goalJumped = false, goalForce = false;
                if (phases && !seg.pause) phases.forEach(function (ph, qi) { if (outIdx < 0 && (ph.ballPath || []).some(function (q) { return q.kind === 'shot' || q.kind === 'over'; })) outIdx = qi; });
                var segStep = function () {
                    if (motor.phase !== lastPhase) {
                        if (lastPhase && lastPhase.pose !== false && motor.phase && motor.phase.pose === false && poseS == null) poseS = ns;
                        if (lastPhase && lastPhase.goal && sadEnd == null) sadEnd = ns;
                        lastPhase = motor.phase;
                    }
                    var isGoalPlay = play.kind === 'goal' || play.kind === 'own-goal';
                    if (!isGoalPlay && outIdx >= 0 && !outForced && simClock - segT0 > T * 0.45) {
                        var curIdx = phases.indexOf(motor.phase);
                        if (motor.phase && curIdx >= 0 && curIdx <= outIdx && !(ball.state === "flight" && ball.fl && (ball.fl.kind === "shot" || ball.fl.kind === "over"))) {
                            // La jugada va con retraso: se salta directamente al remate (nadie se queda esperando).
                            outForced = true;
                            motor.actions = []; motor.action = null;
                            motor.phases = phases.slice(outIdx + 1);
                            startMotorPhase(phases[outIdx]);
                            // Sin rodeos: el remate sale desde donde esté el balón.
                            var kicks = motor.actions.filter(function (q) { return q.forceKind; });
                            if (kicks.length) { motor.actions = kicks; motor.action = null; }
                        }
                    }
                    var lateGoal = isGoalPlay && simClock - segT0 > T * 0.3 && motor.phase && phases.indexOf(motor.phase) >= 0 && phases.indexOf(motor.phase) < phases.findIndex(function (q) { return q.pose === true; });
                    if (lateGoal && !simRestart && !goalJumped && goalS == null && !(ball.fl && ball.fl.net)) {
                        // Va con retraso: se pasa directamente a la fase del remate (pase al goleador y disparo).
                        goalJumped = true;
                        var shotIdx = -1;
                        phases.forEach(function (ph, qi) { if ((ph.ballPath || []).some(function (q) { return q.kind === 'shot' && (q.x > 100 || q.x < 0); })) shotIdx = qi; });
                        var curI = phases.indexOf(motor.phase);
                        if (shotIdx > curI && ball.state !== 'flight') {
                            motor.actions = []; motor.action = null;
                            motor.phases = phases.slice(shotIdx + 1);
                            startMotorPhase(phases[shotIdx]);
                            var sp0 = phases[shotIdx].ballPath[0];
                            var fk = motor.actions.filter(function (q) { return q.forceKind; });
                            if (sp0 && !sp0.kind && mDist(ball.x, ball.y, sp0.x, sp0.y) > 8) {
                                motor.actions = [{ type: 'kick', pt: { x: sp0.x, y: sp0.y }, forceKind: 'lofted' }].concat(fk);
                                motor.action = null;
                            }
                            lateGoal = false;
                        }
                    }
                    lateGoal = lateGoal && simClock - segT0 > T * 0.55;
                    motor.holdNext = isGoalPlay && goalS == null;
                    var stuckPre = isGoalPlay && motor.phase && motor.phases.length && motor.phases[0].pose === true && motor.phaseT >= motor.phaseDur && !motor.action && !motor.actions.length && ball.state !== 'flight';
                    if (goalForce && goalS == null && !motor.action && !motor.actions.length && ball.state !== 'flight' && !ball.lock) goalForce = false;   // el remate se perdió: se vuelve a intentar
                    if (isGoalPlay && goalS == null && !goalForce && !simRestart && !ball.lock && ((motor.phase && motor.phase.pose === true) || lateGoal || stuckPre) && !(ball.fl && ball.fl.net)) {
                        var celIdx = -1;
                        phases.forEach(function (ph, qi) { if (ph.pose === true && celIdx < 0) celIdx = qi; });
                        if (celIdx >= 0 && motor.phase && motor.phase.pose !== true) motor.phases = phases.slice(celIdx);
                        // Garantía: si la llegada se retrasó, el remate sale ya hacia la red antes de celebrar.
                        var netTo = null;
                        phases.forEach(function (ph) { (ph.ballPath || []).forEach(function (q) { if (q.kind === 'shot' && (q.x > 100 || q.x < 0)) netTo = q; }); });
                        if (!netTo) netTo = { x: ball.x > 50 ? 101.3 : -1.3, y: 50 };
                        motor.actions = []; motor.action = null;
                        var gxN = netTo.x > 50 ? 100 : 0;
                        if (ball.state === 'flight' && mDist(ball.x, ball.y, gxN, 50) > 30) {
                            // balón en el aire lejos de la portería: se espera a que lo reciba alguien
                        } else if (mDist(ball.x, ball.y, gxN, 50) > 30) {
                            // Lejos de la portería: primero llega a un compañero a distancia de tiro y luego remata.
                            goalForce = true;
                            motor.actions = [{ type: 'kick', pt: { x: netTo.x, y: clamp(netTo.y, 45.5, 54.5) }, shot: true, forceKind: 'shot' }];
                        } else {
                            if (ball.owner) { ball.owner = null; ball.state = 'free'; }
                            launchBall({ x: netTo.x, y: clamp(netTo.y, 45.5, 54.5) }, 'shot', null);
                            ball.fl.net = true;
                        }
                    }
                    if (ball.fl && ball.fl.net && ball.fl.at >= segT0 - 1e-6 && !(ball.fl.born != null && ball.fl.born < segT0 - 1e-6)) sawNet = true;   // un remate de la jugada anterior no cuenta
                    if (goalS == null && isGoalPlay && ball.lock && sawNet) goalS = ns;
                };
                advance(T, ctx, segStep);
                motor.holdNext = false;
                // Gol que llega tarde (la jugada esperó a una falta): la jugada se alarga hasta que el balón entra y se celebra un poco.
                if ((play.kind === 'goal' || play.kind === 'own-goal') && goalS == null && !seg.pause) {
                    var tMax = simClock + 12;
                    while (goalS == null && simClock < tMax) advance(0.2, ctx, segStep);
                    if (goalS != null) advance(2.4, ctx, segStep);
                }
                motor.holdNext = false;
                seg.s1 = ns;
                seg.pose = poseS != null ? poseS : Math.max(seg.s0, ns - 2);
                seg.goalS = goalS;
                seg.sadEnd = sadEnd != null ? sadEnd : (goalS != null ? Math.min(ns, goalS + Math.round(4 / SAMPLE_DT)) : null);
                seg.scorerSide = play.kind === 'goal' || play.kind === 'own-goal' ? plan.info.attack : null;
                seg.bench = h.bench; seg.out = h.out;
                if (goalS != null && !simEvents.some(function (e) { return e.type === 'kickoff' && e.s >= goalS; })) simEvents.push({ s: Math.max(goalS, ns - 2), type: 'kickoff', x: 50, y: 50 });
                segs.push(seg);
            });
            // Una falta narrada en la última jugada se lanza antes del final (no se queda sin sacar).
            finishPending();
            // Final: todos se retiran por el túnel.
            var ex = { i: -2, s0: ns, kind: 'exit', period: period, flipped: simFlipped };
            if (simRestart) restartKick(simRestart);
            simExiting = true;
            motor.phases = []; motor.phase = null; motor.waitRestart = false; motor.actions = []; motor.action = null;
            Object.keys(playerState).forEach(function (k) { simLeave(k, 'exit'); });
            var rt = simLogOfVis(50, 106); refState.tx = rt.x; refState.ty = rt.y; refState.spd = 2.4;
            advance(EXIT, { frozen: true });
            ex.s1 = ns; ex.pose = ns - 1;
            segs.push(ex);
        } finally {
            playerState = saved.playerState; ball = saved.ball; refState = saved.refState; motor = saved.motor;
            simulating = false;
        }
        // El árbitro desaparece al llegar al túnel.
        var ri = fidx.REF;
        var exSeg = segs[segs.length - 1];
        for (var s = exSeg.s0; s < ns; s++) if (Y[s * N + ri] > 103.5) V[s * N + ri] = 0;
        [fidx.AR1, fidx.AR2].forEach(function (ai) { for (var s2 = exSeg.s0; s2 < ns; s2++) if (Y[s2 * N + ai] > 103.5 || Y[s2 * N + ai] < -3.5) V[s2 * N + ai] = 0; });
        var segByPlay = {};
        // Huecos (figura aún no en el campo o ya retirada): se rellenan con su posición más cercana,
        // para que la interpolación no tire de ceros al aparecer o desaparecer.
        // Al final de la retirada ya no queda nadie en el campo.
        for (var zk = Math.max(0, ns - 3); zk < S; zk++) for (var zf = 0; zf < N; zf++) if (figs[zf].type === 'player') V[zk * N + zf] = 0;
        for (var fi = 0; fi < N; fi++) {
            var lastK = -1;
            for (var sk = 0; sk < S; sk++) {
                if (V[sk * N + fi]) {
                    if (lastK < 0) for (var bk = 0; bk < sk; bk++) { X[bk * N + fi] = X[sk * N + fi]; Y[bk * N + fi] = Y[sk * N + fi]; }
                    lastK = sk;
                } else if (lastK >= 0) { X[sk * N + fi] = X[lastK * N + fi]; Y[sk * N + fi] = Y[lastK * N + fi]; }
            }
        }
        segs.forEach(function (sg, k) { sg.k = k; if (sg.i >= 0) segByPlay[sg.i] = sg; });
        // Marcador y reacciones de los banquillos ligados al instante de la línea de tiempo en que pasa
        // lo narrado (el balón entra, el árbitro pita la falta o el penalti...), no al de la narración.
        var scoreTimes = [], reacts = [];
        var evSorted = simEvents.slice().sort(function (a, b) { return a.s - b.s; });
        segs.forEach(function (sg) {
            if (sg.i < 0) return;
            var pl = plays[sg.i];
            if (!pl) return;
            var isG = pl.kind === 'goal' || pl.kind === 'own-goal';
            if (isG) scoreTimes.push({ i: sg.i, s: sg.goalS != null ? sg.goalS : sg.s1, side: pl.scoreSide || sideOfTeam(pl.team, dInit) || 'home' });
            var key = isG ? (sg.goalS != null ? sg.goalS : sg.s1) : null;
            if (key == null) {
                for (var ek = 0; ek < evSorted.length; ek++) {
                    var e = evSorted[ek];
                    if (e.s < sg.s0) continue;
                    if (e.s > sg.s1 + 30) break;
                    if (/^(free|wall|penalty|offside|protest|var|appeal)$/.test(e.type) && (e.play == null || e.play === sg.i)) { key = e.s; break; }
                }
            }
            if (key == null) key = sg.s0 + 1;
            reacts.push({ i: sg.i, s: key });
        });
        reacts.sort(function (a, b) { return a.s - b.s; });
        return { scoreTimes: scoreTimes, reacts: reacts, events: simEvents.slice(), figs: figs, fidx: fidx, N: N, S: ns, X: X, Y: Y, V: V, F: F, BX: BX, BY: BY, BH: BH, BS: BS, BO: BO,
            segs: segs, segByPlay: segByPlay, squad: lh.squad, ms: performance.now() - t0, plays: plays.length,
            fixedPasses: segs.reduce(function (a, sg) { return a + (sg.fixed || 0); }, 0) };
    }

    /* ---- Reproducción: solo interpola la línea temporal ---- */
    var tlNodes = null;

    function tlBuildNodes(d) {
        if (!playersLayer || !tl) return;
        playersLayer.innerHTML = '';
        refState.el = null;
        tlNodes = tl.figs.map(function (f) {
            var el = null;
            if (f.type === 'player') { el = buildPlayerNode({ name: f.name, side: f.side, pos: f.pos }, d, { x: 50, y: 50 }); addGestures(el); }
            else if (f.type === 'ref') { el = buildRefNode((d && d.refereeName) || 'Árbitro'); }
            else if (f.type === 'ar') el = buildARNode();
            else el = staffNode(f.type === 'stretcher' ? 'stretcher' : 'medic');
            el.style.display = 'none';
            if (f.type === 'player' || f.type === 'ref' || f.type === 'ar') playersLayer.appendChild(el);
            else staffLayer.appendChild(el);
            return { el: el, shown: false, flag: 0, f: f };
        });
        // las asistencias y la camilla, por encima del jugador atendido
        if (staffLayer && staffLayer.parentNode) staffLayer.parentNode.appendChild(staffLayer);
        applyCompactNames();
        pb.off = new Float32Array(tl.N * 2); pb.disp = new Float32Array(tl.N * 2); pb.boff = [0, 0];
        pb.dispB = [50, 50];
        pb.seg = tl.segs[0]; pb.s = 0; pb.lastS = -1; pb.firstFrame = true;
    }

    // Brazos en alto (saque de banda) y bocadillo de protesta, ocultos salvo cuando toca.
    function addGestures(el) {
        var arms = svgEl('g', { 'class': 'campo-arms' });
        [-1, 1].forEach(function (sx) {
            arms.appendChild(svgEl('line', { x1: sx * 16, y1: -10, x2: sx * 11, y2: -38, stroke: '#1b1b1b', 'stroke-width': 8, 'stroke-linecap': 'round' }));
            arms.appendChild(svgEl('line', { x1: sx * 16, y1: -10, x2: sx * 11, y2: -38, stroke: '#f5d9b8', 'stroke-width': 5, 'stroke-linecap': 'round' }));
        });
        el.insertBefore(arms, el.firstChild);
        var bub = svgEl('g', { 'class': 'campo-bubble', transform: 'translate(15,-24)' });
        bub.appendChild(svgEl('circle', { r: 9, fill: '#fff', stroke: '#b91c1c', 'stroke-width': 2 }));
        var tx = svgEl('text', { y: 4.5, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 900, fill: '#b91c1c', 'font-family': 'Segoe UI, sans-serif' });
        tx.textContent = '!';
        bub.appendChild(tx);
        el.appendChild(bub);
    }
    // Árbitro asistente: de negro, con su banderín (se levanta en los fueras de juego).
    function buildARNode() {
        var g = svgEl('g', { 'class': 'campo-ar', filter: 'url(#campo-shadow)' });
        var flag = svgEl('g', { 'class': 'campo-ar-flag' });
        flag.appendChild(svgEl('line', { x1: 11, y1: 4, x2: 11, y2: -16, stroke: '#ddd', 'stroke-width': 2.2 }));
        flag.appendChild(svgEl('rect', { x: 11, y: -16, width: 13, height: 9, fill: '#facc15', stroke: '#b91c1c', 'stroke-width': 1.6 }));
        g.appendChild(flag);
        g.appendChild(svgEl('circle', { r: 14, fill: '#111111', stroke: '#f3f3f3', 'stroke-width': 2, 'class': 'campo-disk' }));
        var t = svgEl('text', { y: 3.5, 'text-anchor': 'middle', 'font-size': 8.5, 'font-weight': 800, fill: '#fff', 'font-family': 'Segoe UI, sans-serif' });
        t.textContent = 'AA';
        g.appendChild(t);
        return g;
    }

    // Rótulo breve junto a la acción: «Saque de banda», «Córner», «Falta · barrera», «Fuera de juego»...
    function showTag(e) {
        var top = root && root.querySelector('svg');
        var label = EVENT_LABEL[e.type];
        if (!top || !label) return;
        var p = toSvg(clamp(e.x, 8, 92), clamp(e.y, 2, 98));
        var w = label.length * 8.2 + 22;
        var ty = e.y < 22 ? p.y + 50 : p.y - 40;   // junto a la banda de arriba, el rótulo va debajo para no tapar al que saca
        var g = svgEl('g', { 'class': 'campo-tag campo-tag-' + e.type, transform: 'translate(' + p.x.toFixed(1) + ',' + ty.toFixed(1) + ')' });
        g.appendChild(svgEl('rect', { x: -w / 2, y: -14, width: w, height: 24, rx: 12, fill: 'rgba(8,14,10,0.82)', stroke: e.type === 'offside' ? '#facc15' : 'rgba(255,255,255,0.6)', 'stroke-width': 1.5 }));
        var t = svgEl('text', { y: 3, 'text-anchor': 'middle', fill: '#fff', 'font-size': 13.5, 'font-weight': 700, 'font-family': 'Segoe UI, sans-serif' });
        t.textContent = label;
        g.appendChild(t);
        top.appendChild(g);
        setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 1900);
    }

    function cr(p0, p1, p2, p3, t) {
        var t2 = t * t, t3 = t2 * t;
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }

    function tlSample(arr, N, i, s, lo, hi) {
        var k = Math.floor(s), t = s - k;
        var k0 = clamp(k - 1, lo, hi), k1 = clamp(k, lo, hi), k2 = clamp(k + 1, lo, hi), k3 = clamp(k + 2, lo, hi);
        return cr(arr[k0 * N + i], arr[k1 * N + i], arr[k2 * N + i], arr[k3 * N + i], t);
    }

    function segLimit(seg) {
        // La última jugada enlaza con la salida del campo; el resto se queda en su último instante.
        var next = tl.segs[seg.k + 1];
        if (next && next.i === -2) return next.s1 - 1;
        return seg.s1 - 1;
    }

    function tlCurrentS() {
        if (!pb.seg) return 0;
        return pb.s;
    }

    // Cambio de jugada: en directo, desde donde está todo (sin saltos); con el deslizador, al instante clave.
    function tlGoto(play, immediate, d) {
        if (!tl) return;
        var seg = play ? tl.segByPlay[play.i] : tl.segs[0];
        if (!seg) return;
        var prevSeg = pb.seg;
        if (window.__tlLog) window.__tlLog.push([Math.round(performance.now()), seg.i, seg.s0, Math.round(pb.s * 10) / 10, (seg.s1 - seg.s0) * SAMPLE_DT, !!immediate]);
        // En directo nunca se vuelve atrás (la narración a veces repite la jugada anterior un instante).
        if (!immediate && prevSeg && seg.k <= prevSeg.k && pb.s >= seg.s0) return;
        if (immediate) {
            pb.seg = seg;
            pb.s = seg.pose;
            pb.off.fill(0); pb.boff = [0, 0];
            pb.snap = true;
            // Con el deslizador se ve la alineación de ese momento: quien ya se va (cambio o roja) no aparece.
            pb.hidden = {};
            var kS = Math.floor(seg.pose);
            for (var hi2 = 0; hi2 < tl.N; hi2++) { var fS = tl.F[kS * tl.N + hi2]; if (fS === 3 || fS === 4) pb.hidden[hi2] = true; }
            window.__seeking = true; motor.seekFrame = motor.frame;
        } else {
            // La línea de tiempo es continua: si la narración va por delante, la reproducción acelera
            // hasta alcanzarla (sin saltos). Solo con un desfase enorme se funde lo que se ve con el destino.
            var s0 = seg.s0;
            var gapS = (s0 - pb.s) * SAMPLE_DT;
            if (gapS >= -0.01 && gapS < 16) { pb.seg = seg; if (seg.flip && prevSeg && prevSeg.k < seg.k) pb.flipBanner = seg; }
            else for (var i = 0; i < tl.N; i++) {
                var nx = tl.X[s0 * tl.N + i], ny = tl.Y[s0 * tl.N + i];
                pb.off[i * 2] = pb.disp[i * 2] - nx; pb.off[i * 2 + 1] = pb.disp[i * 2 + 1] - ny;
                if (!tlNodes[i].shown) { pb.off[i * 2] = 0; pb.off[i * 2 + 1] = 0; }
            }
            if (!(gapS >= -0.01 && gapS < 16)) {
                pb.boff = [pb.dispB[0] - tl.BX[s0], pb.dispB[1] - tl.BY[s0]];
                pb.seg = seg; pb.s = s0; pb.fadeOff = 0.6;
                if (seg.flip && prevSeg && prevSeg.k < seg.k) showBanner(seg.period === 3 ? 'Prórroga · cambio de campo' : 'Cambio de campo');
            }
        }
        pb.lastS = tlCurrentS();
        // vista girada: solo para las etiquetas Local/Visitante (las posiciones ya vienen giradas)
        ends.period = seg.period; ends.flipped = !!seg.flipped;
        if (ends.labels) { ends.labels[0].textContent = ends.flipped ? 'Visitante' : 'Local'; ends.labels[1].textContent = ends.flipped ? 'Local' : 'Visitante'; }
        benchSig = '';
        if (d) drawBenches(d);
        if (play && d) {
            var plays = buildPlays(d);
            var res = null;
            try { res = resolvePlay(play, Object.assign({}, d)); } catch (e) { res = null; }
            if (res && res.highlight) highlightPlayers(res.highlight);
            // Las reacciones (banquillos, VAR) salen cuando la reproducción llega al momento (tlFrame).
        } else highlightPlayers([]);
    }

    function tlFrame(dt) {
        if (!tl || !tlNodes || !pb.seg) return;
        var clock = window.getCampoClock ? window.getCampoClock() : { started: true, paused: false };
        var running = clock.started && !clock.paused && !clock.seeking && !dragging;
        var seg = pb.seg;
        var lim = segLimit(seg);
        var rate = NOMINAL_LINE * 1000 / lineMs();
        var behind = (seg.s0 - pb.s) * SAMPLE_DT;
        // Ponerse al día acelerando con suavidad, nunca saltando (tope global ×4, como el tempo del motor).
        if (behind > 0) rate = Math.min(Math.max(4, rate), rate * (1 + Math.min(1.2, behind / 2.5)));
        var adv = running || seg.i === -2 || (clock.finished && tl.segs[seg.k + 1] && tl.segs[seg.k + 1].i === -2);
        // La retirada final va a su ritmo (unos 20 s), sea cual sea la velocidad de la narración.
        if (clock.finished && (seg.i === -2 || pb.s >= seg.s1 - 1)) rate = Math.min(rate, 1.15);
        if (adv) pb.s += dt * rate / SAMPLE_DT;
        var heldT = 0;
        if (pb.s > lim) { heldT = (pb.s - lim) * SAMPLE_DT; pb.s = lim; }
        // Fundido en el cambio de campo: se oscurece, cada uno aparece en su mitad y vuelve la imagen.
        var swapNow = false;
        if (!pb.fadeSt && !pb.snap && pb.lastS >= 0) {
            for (var fq = 0; fq < tl.segs.length; fq++) {
                var fsg = tl.segs[fq];
                if (fsg.jumpFlip && pb.lastS < fsg.s0 && pb.s >= fsg.s0) { pb.fadeSt = { t: 0, s0: fsg.s0 }; break; }
            }
        }
        if (pb.fadeSt) {
            var FD = 0.4;
            pb.fadeSt.t += dt;
            if (pb.fadeSt.t < FD) pb.s = Math.min(pb.s, pb.fadeSt.s0 - 0.02);
            else if (!pb.fadeSt.swapped) { pb.fadeSt.swapped = true; swapNow = true; pb.s = Math.max(pb.s, pb.fadeSt.s0); }
            var op = pb.fadeSt.t < FD ? 1 - pb.fadeSt.t / FD : Math.min(1, (pb.fadeSt.t - FD) / FD);
            playersLayer.style.opacity = op < 1 ? op.toFixed(2) : '';
            if (ballEl) ballEl.style.opacity = op < 1 ? op.toFixed(2) : '';
            if (pb.fadeSt.t >= FD * 2) { pb.fadeSt = null; playersLayer.style.opacity = ''; if (ballEl) ballEl.style.opacity = ''; }
        } else if (pb.snap && playersLayer.style.opacity) { playersLayer.style.opacity = ''; if (ballEl) ballEl.style.opacity = ''; }
        var s = pb.s;
        if (pb.flipBanner && s >= pb.flipBanner.s0) { showBanner(pb.flipBanner.period === 3 ? 'Prórroga · cambio de campo' : 'Cambio de campo'); pb.flipBanner = null; }
        // Efectos según el tramo que se está viendo (puede ir por detrás del de la narración).
        var vseg = seg;
        if (s < seg.s0) { for (var q = seg.k - 1; q >= 0; q--) { if (tl.segs[q].s0 <= s) { vseg = tl.segs[q]; break; } } }
        pb.held = heldT > 0 ? pb.held + dt : 0;
        var N = tl.N, lo = 0, hi = tl.S - 1;
        // No se interpola a través de un cambio de campo (allí las posiciones cambian de mitad).
        for (var bq = 0; bq < tl.segs.length; bq++) {
            var bsg = tl.segs[bq];
            if (!bsg.jumpFlip) continue;
            if (pb.s < bsg.s0) hi = Math.min(hi, bsg.s0 - 1); else lo = Math.max(lo, bsg.s0);
        }
        var k = Math.floor(s);
        var decay = Math.exp(-dt / (pb.fadeOff || 0.16));
        // Efectos: gol (red y aviso), cabizbajos.
        if (pb.lastS >= 0 && vseg.goalS != null && pb.lastS < vseg.goalS && s >= vseg.goalS && !pb.snap) goalFx(vseg);
        var sad = vseg.goalS != null && s >= vseg.goalS && s < (vseg.sadEnd || vseg.s1) ? (vseg.scorerSide === 'home' ? 'away' : 'home') : null;
        if (sad !== pb.sad) {
            playersLayer.classList.toggle('campo-sad-home', sad === 'home');
            playersLayer.classList.toggle('campo-sad-away', sad === 'away');
            pb.sad = sad;
        }
        if (tl.events && pb.lastS >= 0 && !pb.snap && s > pb.lastS && s - pb.lastS < 25) {
            for (var ei = 0; ei < tl.events.length; ei++) { var ev = tl.events[ei]; if (ev.s > pb.lastS && ev.s <= s) showTag(ev); }
        }
        if (tl.reacts && pb.lastS >= 0 && !pb.snap && s > pb.lastS && s - pb.lastS < 25) {
            var dR = data(), plR = dR ? buildPlays(dR) : [];
            for (var ri2 = 0; ri2 < tl.reacts.length; ri2++) { var rc = tl.reacts[ri2]; if (rc.s > pb.lastS && rc.s <= s && plR[rc.i]) { managerReact(plR[rc.i], dR); varFx(plR[rc.i]); } }
        }
        if (ui.score && !dragging) { var dS = data(); if (dS) { var stx = tlScoreText(s, dS); if (stx && ui.score.textContent !== stx) ui.score.textContent = stx; } }
        pb.lastS = s; pb.snap = false;
        var ns = nodeScale !== 1 ? ' scale(' + nodeScale.toFixed(3) + ')' : '';
        var wob = Math.min(1, pb.held / 1.2);
        var t = performance.now() / 1000;
        for (var i = 0; i < N; i++) {
            var node = tlNodes[i];
            var vis = tl.V[k * N + i] === 1 && !swapNow;
            if (vis && pb.hidden && pb.hidden[i]) { var fH = tl.F[k * N + i]; if (fH === 3 || fH === 4) vis = false; else delete pb.hidden[i]; }
            if (vis !== node.shown) { node.el.style.display = vis ? '' : 'none'; node.shown = vis; if (!vis) { pb.off[i * 2] = 0; pb.off[i * 2 + 1] = 0; } }
            if (!vis) continue;
            var x = tlSample(tl.X, N, i, s, lo, hi), y = tlSample(tl.Y, N, i, s, lo, hi);
            pb.off[i * 2] *= decay; pb.off[i * 2 + 1] *= decay;
            x += pb.off[i * 2]; y += pb.off[i * 2 + 1];
            if (wob > 0 && node.f.type === 'player' && tl.BO[k] !== i) {
                x += Math.sin(t * 0.9 + i * 1.7) * 0.35 * wob; y += Math.cos(t * 0.7 + i * 2.3) * 0.5 * wob;
            }
            pb.disp[i * 2] = x; pb.disp[i * 2 + 1] = y;
            var p = toSvg(x, y);
            if (node.f.type === 'player' || node.f.type === 'ref' || node.f.type === 'ar') {
                node.el.setAttribute('transform', 'translate(' + p.x.toFixed(2) + ',' + p.y.toFixed(2) + ')' + (node.f.type === 'ar' ? (nodeScale !== 1 ? ' scale(' + (1 + (nodeScale - 1) * 0.8).toFixed(3) + ')' : '') : ns));
                var fl = tl.F[k * N + i];
                if (fl !== node.flag) {
                    node.el.classList.toggle('campo-down', fl === 1 || fl === 2);
                    node.el.classList.toggle('campo-on-stretcher', fl === 2);
                    node.el.classList.toggle('campo-sent-off', fl === 3);
                    node.el.classList.toggle('campo-throwing', fl === 5);
                    // Saque de banda: los brazos (y el balón) hacia el campo, nunca fuera del dibujo.
                    var armsEl = node.el.querySelector('.campo-arms');
                    if (armsEl) armsEl.setAttribute('transform', fl === 5 && y < 50 ? 'scale(1,-1)' : '');
                    node.el.classList.toggle('campo-flag-up', fl === 6);
                    node.el.classList.toggle('campo-protest', fl === 7);
                    node.flag = fl;
                }
                if (node.f.type === 'player') {
                    var fade = y > 100.5 ? clamp(1 - (y - 100.5) / 3, 0, 1) : (y < -0.5 ? clamp(1 + (y + 0.5) / 3, 0, 1) : 1);
                    var fs = fade < 1 ? fade.toFixed(2) : '';
                    if (node.fade !== fs) { node.el.style.opacity = fs; node.fade = fs; }
                }
            } else {
                var kk = 1 + (nodeScale - 1) * 0.7;
                node.el.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ') scale(' + kk.toFixed(3) + ')');
            }
        }
        // Balón: interpolación lineal (los botes y los remates no se suavizan de más).
        var k2 = Math.min(k + 1, hi), u = k2 > k ? s - k : 0;
        var bx = lerp(tl.BX[k], tl.BX[k2], u), by = lerp(tl.BY[k], tl.BY[k2], u), bh = lerp(tl.BH[k], tl.BH[k2], u);
        var own = tl.BO[k];
        if (own >= 0 && tl.BS[k] === 0 && tl.V[k * N + own]) {
            // pegado al pie del poseedor tal y como se dibuja (incluido su desfase)
            bx += pb.off[own * 2]; by += pb.off[own * 2 + 1];
        }
        if (own >= 0 && tl.BS[k] === 0 && tl.F[k * N + own] === 5) {
            // En las manos del que saca de banda, hacia el campo.
            var tyT = pb.disp[own * 2 + 1];
            bx = pb.disp[own * 2]; by = tyT + (tyT < 50 ? 1 : -1) * 30 * nodeScale / PITCH.h * 100; bh = 0;
        }
        pb.boff[0] *= decay; pb.boff[1] *= decay;
        bx += pb.boff[0]; by += pb.boff[1];
        pb.dispB[0] = bx; pb.dispB[1] = by;
        ball.x = bx; ball.y = by; ball.h = bh;
        placeBallVis(bx, by, bh);
        if (ballEl) { var bd = swapNow ? 'none' : ''; if (ballEl.style.display !== bd) ballEl.style.display = bd; }
        stepManagers(dt, performance.now());
    }

    function placeBallVis(x, y, h) {
        var sv = ends.flipped;
        ends.flipped = false;           // la línea temporal ya está en coordenadas de pantalla
        placeBall();
        ends.flipped = sv;
    }

    /* ---- VAR: el árbitro dibuja la pantalla, aviso de consulta y luego la decisión ---- */
    var varTimers = [];
    function varFx(play) {
        var txt = String(play.text || '').replace(/\s+/g, ' ');
        if (!/\bVAR\b/.test(txt)) return;
        varTimers.forEach(clearTimeout); varTimers = [];
        var m = txt.match(/VAR\s*\(([^)]*)\)\s*:\s*([^.…]+?)(?:\s*\.\.\.|\s*$|\.)/);
        var motivo = m ? m[1].trim() : '';
        var decision = m ? m[2].trim() : (/anula/i.test(txt) ? 'se anula' : (/confirma|se mantiene|válid/i.test(txt) ? 'se confirma' : ''));
        showBanner('Se consulta al VAR' + (motivo ? ' · ' + motivo : ''));
        var refNode = tlNodes && tlNodes.filter(function (n) { return n.f.type === 'ref'; })[0];
        if (refNode) {
            var tv = svgEl('rect', { 'class': 'campo-var-tv', x: -22, y: -46, width: 44, height: 28, rx: 3, fill: 'none', stroke: '#fff', 'stroke-width': 3 });
            refNode.el.appendChild(tv);
            varTimers.push(setTimeout(function () { if (tv.parentNode) tv.parentNode.removeChild(tv); }, 2600));
        }
        if (decision) varTimers.push(setTimeout(function () { showBanner('VAR: ' + decision.charAt(0).toUpperCase() + decision.slice(1)); }, 2700));
    }

    /* ---- Gol: la red se mueve y aviso «¡GOL!» con el marcador ---- */
    function goalFx(seg) {
        var d = data();
        var right = tl.BX[seg.goalS] > 50;
        var net = root && root.querySelector(right ? '.campo-net-r' : '.campo-net-l');
        if (net) { net.classList.remove('campo-net-hit'); void net.getBBox(); net.classList.add('campo-net-hit'); }
        var top = root && root.querySelector('svg');
        if (!top || !d) return;
        var plays = buildPlays(d);
        var score = tlScoreText(seg.goalS, d) || previewScore(plays, seg.i, d);
        var team = seg.scorerSide === 'home' ? d.homeTeam : d.awayTeam;
        var old = top.querySelector('.campo-goal-banner');
        if (old) old.remove();
        var p = toSvg(50, 13);
        var g = svgEl('g', { 'class': 'campo-goal-banner', transform: 'translate(' + p.x + ',' + p.y + ')' });
        var kc = teamColorsOf(seg.scorerSide || 'home', d);
        g.appendChild(svgEl('rect', { x: -170, y: -50, width: 340, height: 92, rx: 16, fill: 'rgba(8,14,10,0.88)', stroke: kitStyle(kc).fill, 'stroke-width': 4 }));
        var t1 = svgEl('text', { x: 0, y: -6, 'text-anchor': 'middle', fill: '#fff', 'font-size': 46, 'font-weight': 900, 'font-family': 'Segoe UI, sans-serif', 'letter-spacing': 3 });
        t1.textContent = '¡GOL!';
        var t2 = svgEl('text', { x: 0, y: 28, 'text-anchor': 'middle', fill: '#fde68a', 'font-size': 21, 'font-weight': 700, 'font-family': 'Segoe UI, sans-serif' });
        t2.textContent = (team || '') + '  ' + score;
        g.appendChild(t1); g.appendChild(t2);
        top.appendChild(g);
        setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 2900);
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
                if (p.scoreSide) { if (p.scoreSide === 'home') h++; else a++; }
                else if (p.team === d.homeTeam) h++;
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

    // Marcador en un instante de la línea de tiempo: goles cuyo balón ya ha entrado (y la tanda, si la hay).
    function tlScoreText(s, d) {
        if (!tl || !tl.scoreTimes || !d) return null;
        var h = 0, a = 0, idx = -1;
        tl.scoreTimes.forEach(function (g) { if (g.s <= s) { if (g.side === 'home') h++; else a++; } });
        tl.segs.forEach(function (sg) { if (sg.i >= 0 && sg.s0 <= s) idx = sg.i; });
        var text = h + ' - ' + a;
        var pens = idx >= 0 ? shootoutScoreAt(buildPlays(d), idx, d) : null;
        if (pens) text += ' (pen ' + pens.h + '-' + pens.a + ')';
        return text;
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
        if (ui.score) {
            var sgP = tl && tl.segByPlay ? tl.segByPlay[play.i] : null;
            ui.score.textContent = (sgP && tlScoreText(immediate ? sgP.pose : pb.s, d)) || previewScore(buildPlays(d), play.i, d);
        }
        updatePensBoard(buildPlays(d), play.i, d);
        var narrEl = $('narration');
        var minEl = $('minute');
        if (narrEl) narrEl.textContent = summarize(play.text);
        if (minEl) minEl.textContent = label;
        if (tl) { tlGoto(play, immediate, d); return; }
        renderPlayers(d, play, false);
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
        keepViewOnReset = true;
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
            ui.caption.innerHTML = '<span class="campo-kind kickoff">Saque inicial</span> ' + fallback;
            return;
        }
        var kind = play.kind || 'play';
        var label = KIND_LABEL[kind] || 'Jugada';
        var live = d && d.started && !dragging && d.narration && d.narration.trim();
        var text = live ? d.narration.trim() : summarize(play.text);
        var pre = '';
        if (play.kickoffBefore && play.kickoffLabel) pre = '<span class="campo-kind kickoff lead" title="Antes de esta jugada">' + escapeHtml(play.kickoffLabel) + '</span> ';
        var laneTxt = play.lane === 'L' ? 'por la izquierda' : play.lane === 'R' ? 'por la derecha' : play.lane === 'C' ? 'por el centro' : '';
        var laneChip = laneTxt ? ' <span class="campo-lane" title="Zona deducida de la narración (vista del equipo que ataca)">' + laneTxt + '</span>' : '';
        ui.caption.innerHTML = pre + '<span class="campo-kind ' + kind + '">' + escapeHtml(label) + '</span>' + laneChip + ' ' + escapeHtml(text);
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

    function renderPlayers(d, play, animate) {
        if (!playersLayer) return;
        var hadPlayers = Object.keys(playerState).length > 0;
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
                st = { name: p.name, side: p.side, pos: p.pos, baseX: p.x, baseY: p.y, x: p.x, y: p.y, vx: 0, vy: 0, tx: p.x, ty: p.y, el: null };
                if (leavers[k]) { st = leavers[k]; delete leavers[k]; st.leaving = null; if (st.el) { st.el.removeAttribute('data-leaving'); st.el.classList.remove('campo-leaving', 'campo-sent-off'); st.el.style.opacity = ''; } }
                else if (animate && hadPlayers) {
                    // Entra desde su banquillo, trotando hasta su sitio (nada de aparecer de golpe).
                    var sp = benchSpotLogical(p.side);
                    st.x = sp.x; st.y = sp.y; st.spd = 4; st.hx = p.x; st.hy = p.y;
                    st.idleAt = performance.now() + 4000;
                    var bi = benchOut[p.side].indexOf(p.name);
                    if (bi !== -1) benchOut[p.side].splice(bi, 1);
                }
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
                // En directo: el sustituido se va andando a su banquillo y el expulsado, a vestuarios.
                if (animate && hadPlayers && playerState[k].el) { startLeaving(k, playerState[k], leaveReason(playerState[k], play, d)); return; }
                if (playerState[k].el && playerState[k].el.parentNode) playerState[k].el.parentNode.removeChild(playerState[k].el);
                delete playerState[k];
            }
        });
        if (!animate) clearLeavers();
        if (rebuild) {
            Array.prototype.forEach.call(playersLayer.querySelectorAll('.campo-player'), function (g) {
                var k = g.getAttribute('data-side') + ':' + g.getAttribute('data-name');
                if (!live[k] && !leavers[k] && !scenes.some(function (sc) { return sc.key === k && sc.subbed; })) playersLayer.removeChild(g);
            });
        }
        drawBenches(d);
        ensureManagers(d);
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
        var pos = toView(st.x, st.y);
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
            if (tl && pb.seg && tl.scoreTimes) {
                // El marcador sigue a la reproducción: sube cuando el balón entra, no cuando lo narra el texto.
                ui.score.textContent = tlScoreText(pb.s, d);
            } else if (idxNow >= 0 && (d.finished || (play && (play.kind === 'shootout' || play.kind === 'shootout-kick')))) {
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
        // Durante un salto del deslizador la narración avanza a toda velocidad hasta la jugada elegida:
        // el campo ya muestra esa jugada (colocada al soltar), así que no se anima el avance rápido.
        if (d.seeking) return;
        keepViewOnReset = false;
        var play = currentPlay(d);
        if (useTimeline(d, matchId)) {
            updateChrome(d, play);
            setCaption(play, d);
            if (play && play.i !== lastPlayIndex) {
                var jumpT = lastPlayIndex === -1 || (d.finished && Math.abs(play.i - lastPlayIndex) > 3) || (lastPlayIndex === -2 && play.i > 3);
                var target = play;
                if (!jumpT && lastPlayIndex >= 0) {
                    // La narración avanza jugada a jugada: el emparejamiento por texto de jugadas del mismo
                    // minuto a veces se adelanta o retrocede una; el campo solo avanza de una en una.
                    if (play.i < lastPlayIndex && lastPlayIndex - play.i <= 3) target = null;
                    else if (play.i > lastPlayIndex + 1 && play.i - lastPlayIndex <= 4 && !d.finished) target = buildPlays(d)[lastPlayIndex + 1] || play;
                    // cada jugada dura al menos una línea de narración
                    if (target && target !== play && performance.now() - (pb.stepAt || 0) < lineMs() * 0.95) target = null;
                }
                if (target) pb.stepAt = performance.now();
                if (target) {
                    tlGoto(target, jumpT, d);
                    lastPlayIndex = target.i;
                }
            } else if (!play && lastPlayIndex !== -2) {
                tlGoto(null, true, d);
                lastPlayIndex = -2;
            }
            return;
        }
        renderPlayers(d, play, lastPlayIndex >= 0 && !!d.started);
        updateChrome(d, play);
        setCaption(play, d);
        if (play && play.i !== lastPlayIndex) {
            // -2 = estábamos en el saque inicial: la primera jugada se anima (con su saque de centro).
            // En directo nunca se salta: todo fluye desde donde está. Solo se coloca al instante
            // al cargar el partido o si se reanuda muy lejos (p. ej. tras «Ir al final»).
            var jump = lastPlayIndex === -1 || (d.finished && Math.abs(play.i - lastPlayIndex) > 3) || (lastPlayIndex === -2 && play.i > 3);
            playResolved(play, d, jump);
            lastPlayIndex = play.i;
        } else if (!play && lastPlayIndex !== -2) {
            playResolved(null, d, true);
            lastPlayIndex = -2;
        }
    }

    // Coreógrafo: se construye una vez por partido; si algo falla, queda el motor en directo de la sesión 10.
    var tlFailed = '';
    function useTimeline(d, matchId) {
        if (window.__campoNoChoreo) return false;
        if (tl && tl.matchId === matchId) return true;
        if (tlFailed === matchId) return false;
        try {
            tl = buildTimeline(d); tlData = d;
            tl.matchId = matchId;
            ensureMotor();
            tlBuildNodes(d);
            ensureManagers(d);
            benchSig = '';
            pb.seg = tl.segs[0];
            drawBenches(d);
            return true;
        } catch (e) {
            if (window.console) console.warn('Coreógrafo de la vista de campo desactivado:', e);
            tl = null; tlNodes = null; tlFailed = matchId;
            if (playersLayer) playersLayer.innerHTML = '';
            lastSignature = '';
            return false;
        }
    }

    function resetView() {
        if (keepViewOnReset) {
            // Reinicio provocado por el deslizador (salto a una jugada): el campo ya muestra esa jugada,
            // así que se conserva todo para que no parpadee ni salte al terminar el avance rápido.
            keepViewOnReset = false;
            return;
        }
        lastSignature = '';
        tl = null; tlNodes = null; tlFailed = ''; pb.seg = null;
        lastPlayIndex = -1;
        lastPlaysSource = '';
        parsedPlays = [];
        resetNumbers();
        playerState = {};
        if (refState.el && refState.el.parentNode) refState.el.parentNode.removeChild(refState.el);
        refState = { x: 53, y: 62, el: null, name: '' };
        motor.phases = []; motor.phase = null; motor.actions = []; motor.action = null;
        ball = { x: 50, y: 50, h: 0, state: 'free', owner: null };
        resetStaff();
        leavers = {};
        benchOut = { home: [], away: [] };
        benchSig = '';
        if (benchLayer) benchLayer.innerHTML = '';
        if (staffLayer) staffLayer.innerHTML = '';
        managers = { home: null, away: null };
        setEnds(1, true);
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
        // Solo para pruebas: deja el campo en la fase k de la jugada i (sin animación).
        debugShowPhase: function (i, k) {
            var d = data();
            var plays = buildPlays(d);
            var play = i == null ? null : plays[i];
            dragging = true;   // congela el refresco automático mientras se inspecciona (solo pruebas)
            renderPlayers(d, play);
            setCaption(play, d);
            var r = resolvePlay(play, d);
            var ph = (r.phases || [])[k == null ? 0 : k];
            if (ph) startPhase(ph, true);
            if (ph && ph.highlight) highlightPlayers(ph.highlight);
            return !!ph;
        },
        debugLane: function (text, prev) { return laneHint(text, prev || null); },
        debugPhases: function (i) {
            var d = data();
            var plays = buildPlays(d);
            var r = resolvePlay(i == null ? null : plays[i], d);
            return (r.phases || []).map(function (ph) {
                return { ms: ph.ms, pose: ph.pose, kickoff: !!ph.kickoff, ball: ph.ballPath, players: ph.players, ref: ph.ref };
            });
        },
        debugPlan: function (i) {
            var d = data(); var pl = parsedPlays.filter(function (q) { return q.i === i; })[0];
            var r = planPlay(pl, d); return r.phases.map(function (ph) { return { ms: ph.ms, pose: ph.pose, goal: ph.goal, path: ph.ballPath }; });
        },
        debugPb: function () { return { s: pb.s, seg: pb.seg && pb.seg.k, i: pb.seg && pb.seg.i, bx: pb.dispB && pb.dispB[0], by: pb.dispB && pb.dispB[1], boff: pb.boff, own: tl && tl.BO[Math.floor(pb.s)] }; },
        debugFig: function (name, i) {
            var sg = tl.segByPlay[i], fi = tl.figs.findIndex(function (f) { return f.key && f.key.indexOf(name) >= 0; });
            var out = [];
            for (var q = sg.s0; q < sg.s1; q += 2) out.push([((q - sg.s0) * SAMPLE_DT).toFixed(1), tl.X[q * tl.N + fi].toFixed(1), tl.Y[q * tl.N + fi].toFixed(1), tl.BX[q].toFixed(1), tl.BS[q]]);
            return { seg: [sg.s0, sg.goalS, sg.pose, sg.s1], out: out };
        },
        debugChoreo: function () {
            if (!tl) return null;
            var evc = {};
            (tl.events || []).forEach(function (e) { evc[e.type] = (evc[e.type] || 0) + 1; });
            // Rebotes en banda: el balón suelto llega a la línea y vuelve hacia dentro sin que haya reanudación.
            var reb = 0, rebEx = [];
            var evS = (tl.events || []).filter(function (e) { return e.type === 'throw' || e.type === 'corner' || e.type === 'goalkick'; }).map(function (e) { return e.s; });
            for (var q = 1; q < tl.S - 1; q++) {
                if (tl.BS[q] === 0) continue;
                var y = tl.BY[q], x = tl.BX[q];
                var nearSide = y < 1.2 || y > 98.8, nearEnd = (x < 0.8 || x > 99.2) && Math.abs(y - 50) > 6;
                if (!nearSide && !nearEnd) continue;
                var dy0 = tl.BY[q] - tl.BY[q - 1], dy1 = tl.BY[q + 1] - tl.BY[q], dx0 = tl.BX[q] - tl.BX[q - 1], dx1 = tl.BX[q + 1] - tl.BX[q];
                var back = nearSide ? (dy0 * dy1 < 0 && Math.abs(dy0) > 0.25 && Math.abs(dy1) > 0.25) : (dx0 * dx1 < 0 && Math.abs(dx0) > 0.25 && Math.abs(dx1) > 0.25);
                if (!back) continue;
                if (evS.some(function (es) { return es >= q - 3 && es <= q + 15; })) continue;
                // balón colocado para una reanudación y puesto en juego (no es un rebote)
                if ((tl.events || []).some(function (e) { return e.s <= q + 2 && e.s >= q - 60 && Math.abs(e.x - x) < 3 && Math.abs(e.y - y) < 3; })) continue;
                reb++; if (rebEx.length < 6) rebEx.push(q + '@' + x.toFixed(1) + ',' + y.toFixed(1));
            }
            return { events: evc, rebotesBanda: reb, rebEx: rebEx, ms: Math.round(tl.ms), samples: tl.S, figures: tl.N, plays: tl.plays, segs: tl.segs.length, fixedPasses: tl.fixedPasses,
                outcomes: tl.segs.filter(function (s) { return s.outcome; }).map(function (s) { return s.i + ':' + s.kind + ':' + s.outcome; }),
                goals: tl.segs.filter(function (s) { return s.goalS != null; }).map(function (s) { return s.i; }),
                subPauses: tl.segs.filter(function (s) { return s.pause; }).map(function (s) {
                    var mv = 0; for (var q = s.s0 + 1; q < s.s1; q++) mv = Math.max(mv, Math.hypot((tl.BX[q] - tl.BX[s.s0]) * M_X, (tl.BY[q] - tl.BY[s.s0]) * M_Y));
                    return s.i + ':' + ((s.s1 - s.s0) * SAMPLE_DT).toFixed(1) + 's:balón ' + mv.toFixed(1) + 'm';
                }),
                goalTiming: tl.segs.filter(function (s) { return s.goalS != null; }).map(function (s) { return [s.i, (s.goalS - s.s0) * SAMPLE_DT, (s.pose - s.s0) * SAMPLE_DT, (s.s1 - s.s0) * SAMPLE_DT].map(function (v) { return Math.round(v * 10) / 10; }); }), memKB: Math.round(tl.S * tl.N * 9 / 1024),
                ballJumps: (function () { var out = []; for (var q = 1; q < tl.S; q++) { var dm = Math.hypot((tl.BX[q] - tl.BX[q - 1]) * M_X, (tl.BY[q] - tl.BY[q - 1]) * M_Y); if (dm > 9) out.push(q + ':' + dm.toFixed(1) + ':' + tl.BS[q - 1] + '>' + tl.BS[q] + '@' + tl.BX[q-1].toFixed(1) + ',' + tl.BY[q-1].toFixed(1) + '>' + tl.BX[q].toFixed(1) + ',' + tl.BY[q].toFixed(1)); } return out; })(),
                shotless: tl.segs.filter(function (sg) {
                    if (['shot', 'save', 'goal', 'oneonone'].indexOf(sg.kind) < 0) return false;
                    for (var q = sg.s0; q < sg.s1; q++) if (tl.BS[q] === 4 || tl.BS[q] === 6) return false;
                    return true;
                }).map(function (sg) { return sg.i + ':' + sg.kind + ':' + sg.outcome; }) };
        },
        debugNow: function () {
            var d = data() || {};
            if (tl && pb.seg) {
                var s = tlCurrentS(), k = Math.floor(s), sg = pb.seg;
                var p = sg.i >= 0 ? parsedPlays[sg.i] : null;
                var fl = !!sg.flipped;
                var bs = tl.BS[k], own = tl.BO[k];
                var ov = null, owner = null;
                if (own >= 0) {
                    owner = tl.figs[own].key;
                    var k0 = Math.max(0, k - 1), N = tl.N;
                    ov = Math.hypot((tl.X[k * N + own] - tl.X[k0 * N + own]) * M_X, (tl.Y[k * N + own] - tl.Y[k0 * N + own]) * M_Y) / SAMPLE_DT;
                }
                var bx = tl.BX[k], by = tl.BY[k];
                return { i: sg.i >= 0 ? sg.i : -1, kind: p ? p.kind : sg.kind, side: sg.attack || (p ? sideOfTeam(p.team, d) : null),
                    bx: fl ? 100 - bx : bx, by: fl ? 100 - by : by, st: bs === 0 ? 'held' : bs === 1 ? 'free' : 'flight',
                    fk: bs >= 2 ? BALL_NAME[bs] : null, ov: ov, owner: owner, s: s, seg: sg.k };
            }
            var p2 = parsedPlays.filter(function (q) { return q.i === lastPlayIndex; })[0];
            var o = ball.owner && playerState[ball.owner];
            return { i: lastPlayIndex, kind: p2 ? p2.kind : null, side: p2 ? sideOfTeam(p2.team, d) : null, bx: ball.x, by: ball.y, st: ball.state,
                fk: ball.fl ? ball.fl.kind : null, ov: o ? Math.hypot(o.vx || 0, o.vy || 0) : null, owner: ball.owner || null };
        },
        debugStaff: function () {
            return { flipped: ends.flipped, period: ends.period, leavers: Object.keys(leavers).map(function (k) { return k + ':' + leavers[k].leaving; }),
                scenes: scenes.map(function (sc) { return sc.key + ':' + sc.stage + (sc.serious ? ':grave' : ''); }),
                moods: { home: managers.home && managers.home.mood, away: managers.away && managers.away.mood },
                bench: { home: benchNames('home', data() || {}), away: benchNames('away', data() || {}) }, benchOut: benchOut,
                held: Object.keys(playerState).filter(function (k) { return playerState[k].hold; }) };
        },
        debugMotor: function () {
            var lag = 0, n = 0;
            Object.keys(playerState).forEach(function (k) {
                var st = playerState[k];
                if (st.hx == null) return;
                lag += mDist(st.x, st.y, st.hx, st.hy); n++;
            });
            return { ball: { x: ball.x, y: ball.y, h: ball.h, state: ball.state, owner: ball.owner, lock: !!ball.lock },
                phase: !!motor.phase, phaseT: motor.phaseT, phaseDur: motor.phaseDur, queued: motor.phases.length,
                actions: motor.actions.length + (motor.action ? 1 : 0), scale: motor.scale, lagM: n ? lag / n : 0, frame: motor.frame, stats: motor.stats };
        },
        // Pinta el instante s de la línea de tiempo (para capturas): sin reproducción en curso.
        debugRender: function (s, tags) {
            if (!tl) return null;
            var k = 0; for (var j = 0; j < tl.segs.length; j++) if (tl.segs[j].s0 <= s) k = j;
            var sg = tl.segs[k]; sg.k = k;
            pb.seg = sg; pb.s = s; pb.lastS = s; pb.snap = true; pb.fadeSt = null; pb.fadeOff = 0;
            if (pb.off) for (var q = 0; q < pb.off.length; q++) pb.off[q] = 0;
            pb.boff = [0, 0];
            if (tags !== false) (tl.events || []).forEach(function (e) { if (e.s <= s && e.s > s - 15) showTag(e); });
            tlFrame(0);
            return { seg: sg.i, kind: sg.kind };
        },
        debugScoreAt: function (s) { var d = data(); return d ? String(tlScoreText(s, d) || '').replace(/\s*\(.*\)/, '').replace(/\s/g, '') : null; },
        debugTl: function () { var d = data(); return { tl: tl, plays: d ? buildPlays(d) : [], d: d, M_X: M_X, M_Y: M_Y, PITCH: PITCH, nodeScale: nodeScale }; },
        debugBuild: function () { var t0 = performance.now(); buildTimeline(tlData); return Math.round(performance.now() - t0); },
        debugBall: function (a, b) {
            var out = []; for (var q = a; q < Math.min(b, tl.S); q++) out.push(q + ':' + tl.BX[q].toFixed(1) + ',' + tl.BY[q].toFixed(1) + ',' + tl.BH[q].toFixed(1) + ',' + tl.BS[q] + ',' + tl.BO[q] + ',' + simDbg[q]);
            return out.join(' ');
        },
        debugSegs: function () { return tl.segs.map(function (g) { return g.i + ':' + g.kind + ':' + g.s0 + '-' + g.s1 + (g.flipped ? 'F' : ''); }).join(' '); },
        debugEvents: function () {
            if (!tl) return null;
            return (tl.events || []).map(function (e) {
                var sg = null; for (var j = 0; j < tl.segs.length; j++) if (tl.segs[j].s0 <= e.s) sg = tl.segs[j];
                return e.s + '|' + e.type + '|' + (sg ? sg.i + ':' + sg.kind : '') + '|' + e.x.toFixed(1) + ',' + e.y.toFixed(1);
            });
        },
        debugPlays: function () {
            var d = data();
            return buildPlays(d).map(function (p) {
                return { i: p.i, minute: p.minute, kind: p.kind, team: p.team, text: (p.text || '').slice(0, 220), players: p.players, target: p.target, lane: p.lane || null, laneSrc: p.laneSrc || null, kickoffBefore: p.kickoffBefore || null };
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
