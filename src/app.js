
(function () {
  'use strict';

  var HEX_SET = new Set('0123456789abcdefABCDEF');
  var BASE58_SET = new Set('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
  var BASE58_INVALID = ['0', 'O', 'I', 'l'];

  var EVM_PRESETS = ['CAFE', 'DEAD', 'BEEF', 'FACE', 'ACE', '7777'];
  var SOL_PRESETS = ['KEYS', 'PUNK', 'RABBY', 'SHUVO', 'NUR', 'FAST'];

  var LEET_MAP = {
    O: '0',
    I: '1',
    L: '1',
    S: '5',
    T: '7',
    G: '6',
    Z: '2',
    H: '4',
    Q: '9'
  };

  var CURATED_HEX = new Map([
    ['RABBY', ['ABBA', 'ABB']],
    ['SHUVO', ['50', '540']],
    ['BOSS', ['B055', 'B0B5']]
  ]);

  var META = {
    evm: {
      name: 'EVM',
      maxLeading: 6,
      maxPre: 4,
      cap: 7,
      chains: 'Ethereum · BNB Chain · Polygon · Base',
      chainRow: 'ETH · BSC · POLYGON · BASE',
      algo: 'secp256k1 → keccak-256',
      presets: EVM_PRESETS,
      presetLabel: 'Posh presets',
      suffixTag: 'HEX',
      suffixHint: 'Matched at the tail of the address',
      zeroWord: 'hex zero'
    },
    sol: {
      name: 'SOLANA',
      maxLeading: 4,
      maxPre: 4,
      cap: 5,
      chains: 'Solana · Ed25519 · Phantom-compatible',
      chainRow: 'SOL · ED25519 · PHANTOM',
      algo: 'ed25519 → base58',
      presets: SOL_PRESETS,
      presetLabel: 'Name presets',
      suffixTag: 'B58',
      suffixHint: 'Case-sensitive base58 suffix',
      zeroWord: 'Base58 one'
    }
  };

  var patterns = {
    evm: { leading: 1, pre: 0, suffix: 'ACE', strict: false },
    sol: { leading: 0, pre: 0, suffix: 'ACE', ignoreCase: false }
  };

  var engine = 'evm';
  var phase = 'idle';
  var found = null;
  var run = null;
  var workers = [];
  var workerURL = null;
  var sessionCounter = 0;
  var stats = freshStats();
  var chartValues = [];
  var lastChartAt = 0;
  var rafId = null;
  var soundOn = true;
  var audioCtx = null;
  var base58TipTimer = null;
  var toastTimers = new Map();
  var toastSeq = 0;
  var holdTimer = null;
  var holdRevealTimer = null;
  var holding = false;
  var revealing = false;
  var isMac = false;
  var threads = 1;
  var middleSamples = { evm: '7f9a3c8b', sol: 'k7Qm2xVa' };

  var netState = { count: 0, installed: false };

  var refs = {};

  function $(id) {
    return document.getElementById(id);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function freshStats() {
    return {
      attempts: 0,
      speed: 0,
      lastSpeed: 0,
      avgSpeed: 0,
      peakSpeed: 0,
      startedAt: 0,
      endedAt: 0,
      lastMessageAt: 0,
      workerRates: new Map()
    };
  }

  function readPref(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {
      
    }
  }

  function isLocked() {
    return phase === 'running' || phase === 'found';
  }

  function currentMeta() {
    return META[engine];
  }

  function currentState() {
    return patterns[engine];
  }

  function currentCap() {
    if (engine === 'sol') {
      return currentState().ignoreCase ? 6 : 5;
    }
    return 7;
  }

  function totalLocked() {
    var state = currentState();
    return state.leading + state.pre + state.suffix.length;
  }

  function suffixIsValid(suffix) {
    if (!suffix) return true;
    if (engine === 'evm') {
      for (var i = 0; i < suffix.length; i += 1) {
        if (!HEX_SET.has(suffix[i])) return false;
      }
      return true;
    }
    for (var j = 0; j < suffix.length; j += 1) {
      if (!BASE58_SET.has(suffix[j])) return false;
    }
    return true;
  }

  function invalidSuffixChars(suffix) {
    var invalid = [];
    var seen = new Set();
    for (var i = 0; i < suffix.length; i += 1) {
      var char = suffix[i];
      var allowed = engine === 'evm' ? HEX_SET.has(char) : BASE58_SET.has(char);
      if (!allowed && !seen.has(char)) {
        seen.add(char);
        invalid.push(char);
      }
    }
    return invalid;
  }

  function casedLetters(suffix) {
    var count = 0;
    var expression = engine === 'evm' ? /[a-fA-F]/ : /[A-Za-z]/;
    for (var i = 0; i < suffix.length; i += 1) {
      if (expression.test(suffix[i])) count += 1;
    }
    return count;
  }

  function maxForLeading() {
    var state = currentState();
    return Math.min(currentMeta().maxLeading, Math.max(0, currentCap() - state.pre - state.suffix.length));
  }

  function maxForPre() {
    var state = currentState();
    return Math.min(currentMeta().maxPre, Math.max(0, currentCap() - state.leading - state.suffix.length));
  }

  function maxSuffix() {
    var state = currentState();
    return Math.max(0, currentCap() - state.leading - state.pre);
  }

  function buildProfile() {
    var state = currentState();
    var meta = currentMeta();
    var cap = currentCap();
    var suffix = state.suffix;
    var invalid = invalidSuffixChars(suffix);
    var valid = invalid.length === 0;
    var total = state.leading + state.pre + suffix.length;
    var letters = casedLetters(suffix);
    var probability = 1;
    var suffixSpace = state.pre + suffix.length;

    if (engine === 'evm') {
      if (total > 0) probability = Math.pow(16, -total);
      if (state.strict && letters > 0) probability *= Math.pow(2, -letters);
    } else {
      if (state.leading > 0) probability *= Math.pow(256, -state.leading);
      if (suffixSpace > 0) probability *= Math.pow(58, -suffixSpace);
      if (state.ignoreCase && letters > 0) probability *= Math.pow(2, letters);
    }

    var ready = valid && total > 0 && total <= cap;
    var expected = ready ? 1 / probability : null;

    return {
      engine: engine,
      cap: cap,
      total: total,
      valid: valid,
      ready: ready,
      invalid: invalid,
      letters: letters,
      probability: probability,
      expected: expected,
      suffixLength: suffix.length,
      available: maxSuffix(),
      state: {
        leading: state.leading,
        pre: state.pre,
        suffix: suffix,
        strict: state.strict,
        ignoreCase: state.ignoreCase
      },
      meta: meta
    };
  }

  function formulaMarkup(profile) {
    var state = profile.state;
    var parts = [];
    if (profile.total === 0) {
      return 'P = 1';
    }
    if (profile.engine === 'evm') {
      parts.push('16<sup>−' + profile.total + '</sup>');
      if (state.strict && profile.letters > 0) {
        parts.push('2<sup>−' + profile.letters + '</sup>');
      }
    } else {
      if (state.leading > 0) {
        parts.push('256<sup>−' + state.leading + '</sup>');
      }
      var suffixSpace = state.pre + profile.suffixLength;
      if (suffixSpace > 0) {
        parts.push('58<sup>−' + suffixSpace + '</sup>');
      }
      if (state.ignoreCase && profile.letters > 0) {
        parts.push('2<sup>+' + profile.letters + '</sup>');
      }
    }
    return 'P = ' + parts.join(' × ');
  }

  function formulaAria(profile) {
    var state = profile.state;
    var pieces = [];
    if (profile.total === 0) return 'Probability equals one.';
    if (profile.engine === 'evm') {
      pieces.push('16 to the power of minus ' + profile.total);
      if (state.strict && profile.letters > 0) {
        pieces.push('2 to the power of minus ' + profile.letters);
      }
    } else {
      if (state.leading > 0) pieces.push('256 to the power of minus ' + state.leading);
      var suffixSpace = state.pre + profile.suffixLength;
      if (suffixSpace > 0) pieces.push('58 to the power of minus ' + suffixSpace);
      if (state.ignoreCase && profile.letters > 0) pieces.push('2 to the power of plus ' + profile.letters);
    }
    return 'Probability equals ' + pieces.join(' times ') + '.';
  }

  function modeLabel(profile) {
    if (profile.engine === 'evm') {
      return profile.state.strict ? 'EIP-55 strict case' : 'Case-insensitive hex';
    }
    return profile.state.ignoreCase ? 'Case-insensitive base58' : 'Exact base58 case';
  }

  function formatCount(value) {
    if (!Number.isFinite(value)) return '-';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.max(0, Math.floor(value)));
  }

  function compactNumber(value) {
    if (!Number.isFinite(value)) return '-';
    if (value < 1e6) return formatCount(value);
    if (value < 1e9) {
      var millions = value / 1e6;
      return (millions >= 100 ? millions.toFixed(0) : millions.toFixed(millions >= 10 ? 1 : 2).replace(/\.0+$/, '')) + 'M';
    }
    if (value < 1e12) {
      var billions = value / 1e9;
      return (billions >= 100 ? billions.toFixed(0) : billions.toFixed(billions >= 10 ? 1 : 2).replace(/\.0+$/, '')) + 'B';
    }
    if (value < 1e15) {
      var trillions = value / 1e12;
      return (trillions >= 100 ? trillions.toFixed(0) : trillions.toFixed(trillions >= 10 ? 1 : 2).replace(/\.0+$/, '')) + 'T';
    }
    return value.toExponential(2);
  }

  function formatRate(value) {
    if (!Number.isFinite(value) || value <= 0) return '0';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(value));
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDuration(seconds, options) {
    var opts = options || {};
    if (!Number.isFinite(seconds) || seconds < 0) return '-';
    seconds = Math.max(0, seconds);
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;

    if (hours > 0 || opts.clock) {
      var wholeHours = Math.floor(seconds / 3600);
      var wholeMinutes = Math.floor((seconds % 3600) / 60);
      var wholeSeconds = Math.floor(seconds % 60);
      return String(wholeHours).padStart(2, '0') + ':' + pad2(wholeMinutes) + ':' + pad2(wholeSeconds);
    }

    var milliseconds = Math.floor((secs - Math.floor(secs)) * 1000);
    return pad2(minutes) + ':' + pad2(Math.floor(secs)) + '.' + String(milliseconds).padStart(3, '0');
  }

  function formatProbability(attempts, probability) {
    if (phase === 'found') return '100.000%';
    if (!attempts || attempts <= 0 || !Number.isFinite(probability) || probability <= 0) return '0.000%';
    if (probability >= 1) return '100.000%';
    var hit = -Math.expm1(attempts * Math.log1p(-probability));
    if (!Number.isFinite(hit) || hit <= 0) return '0.000%';
    if (hit >= 0.999995) return '99.999%';
    return (hit * 100).toFixed(3) + '%';
  }

  function probabilityFor(attempts, probability) {
    if (!attempts || attempts <= 0 || !Number.isFinite(probability) || probability <= 0) return 0;
    if (probability >= 1) return 1;
    var hit = -Math.expm1(attempts * Math.log1p(-probability));
    return clamp(hit, 0, 1);
  }

  function displayChar(char) {
    if (char === ' ') return 'space';
    if (char === '\n') return 'newline';
    if (char === '\t') return 'tab';
    return char;
  }

  function makeIcon(symbolId, className) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (className) svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + symbolId);
    svg.appendChild(use);
    return svg;
  }

  

  function bumpNetworkCount() {
    netState.count += 1;
    updateNetworkUI();
  }

  function installNetworkMonitor() {
    if (netState.installed) return;
    netState.installed = true;

    try {
      if (typeof window.fetch === 'function') {
        var originalFetch = window.fetch;
        window.fetch = function () {
          bumpNetworkCount();
          return originalFetch.apply(this, arguments);
        };
      }
    } catch (_) {  }

    try {
      if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
        var originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () {
          bumpNetworkCount();
          return originalOpen.apply(this, arguments);
        };
      }
    } catch (_) {  }

    try {
      if (navigator.sendBeacon) {
        var originalBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function () {
          bumpNetworkCount();
          return originalBeacon.apply(null, arguments);
        };
      }
    } catch (_) {  }

    try {
      if (typeof window.WebSocket === 'function') {
        var OriginalWebSocket = window.WebSocket;
        var WrappedWebSocket = function () {
          bumpNetworkCount();
          return new OriginalWebSocket(arguments[0], arguments[1]);
        };
        WrappedWebSocket.prototype = OriginalWebSocket.prototype;
        Object.setPrototypeOf(WrappedWebSocket, OriginalWebSocket);
        window.WebSocket = WrappedWebSocket;
      }
    } catch (_) {  }

    try {
      if (typeof window.EventSource === 'function') {
        var OriginalEventSource = window.EventSource;
        var WrappedEventSource = function () {
          bumpNetworkCount();
          return new OriginalEventSource(arguments[0], arguments[1]);
        };
        WrappedEventSource.prototype = OriginalEventSource.prototype;
        Object.setPrototypeOf(WrappedEventSource, OriginalEventSource);
        window.EventSource = WrappedEventSource;
      }
    } catch (_) {  }
  }

  function updateNetworkUI() {
    if (!refs.networkBadge) return;
    var online = navigator.onLine;
    refs.networkBadge.classList.toggle('is-offline', !online);
    refs.netBadgeText.textContent = online ? 'NET ' + netState.count : 'AIR-GAPPED';
    refs.networkBadge.title = online
      ? 'Network interface online. ' + netState.count + ' outbound requests made by this app.'
      : 'Network interface offline. This app is air-gapped.';
    refs.heroNetwork.textContent = online ? 'ONLINE INTERFACE' : 'AIR-GAPPED';
    var stamp = refs.heroNetwork.closest('.spec-stamp');
    if (stamp) stamp.classList.toggle('is-offline', !online);

    refs.shieldBlock.classList.toggle('is-offline', !online);
    refs.shieldStatus.textContent = online ? 'ONLINE' : 'AIR-GAPPED';
    refs.shieldCopy.textContent = online
      ? 'Your network interface is active. Turn off Wi-Fi before grinding for a fully air-gapped run.'
      : 'Network interface is offline. The forge is fully air-gapped and still ready to generate.';

    var netNodes = document.querySelectorAll('.js-net-count');
    for (var i = 0; i < netNodes.length; i += 1) {
      netNodes[i].textContent = String(netState.count);
    }
  }

  

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    var meta = $('themeColorMeta');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#09090B' : '#FAFAFA');
    refs.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    refs.themeToggle.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    writePref('posh.theme', theme);
  }

  function toggleTheme() {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  }

  function ensureAudio() {
    var AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      if (!audioCtx) audioCtx = new AudioCtor();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(function () {});
      }
      return audioCtx;
    } catch (_) {
      return null;
    }
  }

  function playFoundChime() {
    if (!soundOn) return;
    var ctx = ensureAudio();
    if (!ctx) return;
    try {
      var now = ctx.currentTime;
      var master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.3, now + 0.025);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 1.55);
      master.connect(ctx.destination);

      var notes = [
        { frequency: 659.25, start: 0.0, duration: 0.9, level: 0.22, type: 'sine' },
        { frequency: 987.77, start: 0.11, duration: 0.95, level: 0.16, type: 'sine' },
        { frequency: 1318.51, start: 0.22, duration: 1.15, level: 0.09, type: 'sine' },
        { frequency: 329.63, start: 0.0, duration: 1.25, level: 0.12, type: 'triangle' }
      ];

      notes.forEach(function (note) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = note.type;
        osc.frequency.setValueAtTime(note.frequency, now + note.start);
        gain.gain.setValueAtTime(0.0001, now + note.start);
        gain.gain.exponentialRampToValueAtTime(note.level, now + note.start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note.start + note.duration);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now + note.start);
        osc.stop(now + note.start + note.duration + 0.05);
      });
    } catch (_) {  }
  }

  function playToggleBlip() {
    if (!soundOn) return;
    var ctx = ensureAudio();
    if (!ctx) return;
    try {
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(740, now);
      osc.frequency.exponentialRampToValueAtTime(980, now + 0.07);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.05, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
    } catch (_) {  }
  }

  function setSound(on, announce) {
    soundOn = Boolean(on);
    refs.soundToggle.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    refs.soundToggle.setAttribute('aria-label', soundOn ? 'Mute sound alerts' : 'Enable sound alerts');
    refs.soundToggle.title = soundOn ? 'Sound alerts on' : 'Sound alerts off';
    writePref('posh.sound', soundOn ? 'on' : 'off');
    if (soundOn && announce) playToggleBlip();
  }

  

  function toast(message, type) {
    if (!refs.toastStack) return;
    var node = document.createElement('div');
    node.className = 'toast';
    node.dataset.toastId = String(++toastSeq);
    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.appendChild(makeIcon(type === 'alert' ? 'i-alert' : 'i-check'));
    var copy = document.createElement('span');
    copy.textContent = message;
    node.appendChild(icon);
    node.appendChild(copy);
    refs.toastStack.appendChild(node);

    var active = refs.toastStack.querySelectorAll('.toast');
    if (active.length > 3) {
      active[0].remove();
    }

    var timer = setTimeout(function () {
      node.classList.add('is-leaving');
      var removeTimer = setTimeout(function () {
        node.remove();
        toastTimers.delete(node.dataset.toastId);
      }, 190);
      toastTimers.set(node.dataset.toastId + '-out', removeTimer);
    }, 3400);
    toastTimers.set(node.dataset.toastId, timer);
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (_) {  }
  }

  function clearToasts() {
    if (!refs.toastStack) return;
    refs.toastStack.replaceChildren();
    toastTimers.forEach(function (timer) { clearTimeout(timer); });
    toastTimers.clear();
  }

  function copyText(text, successMessage) {
    var done = function () { toast(successMessage); };
    var fallback = function () {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {
        ok = false;
      }
      textarea.remove();
      if (ok) {
        done();
      } else {
        toast('Clipboard is unavailable. Reveal the key and copy it manually.', 'alert');
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  

  function resetTelemetry() {
    stats = freshStats();
    chartValues = [];
    lastChartAt = 0;
    stopTicker();
    renderTelemetry();
    renderSparkline();
  }

  function retireStopState() {
    if (phase === 'stopped') {
      phase = 'idle';
      run = null;
      resetTelemetry();
      return true;
    }
    return false;
  }

  function setEngine(next) {
    if (isLocked() || next === engine) return;
    engine = next;
    hideBase58Tip();
    retireStopState();
    phase = phase === 'stopped' ? 'idle' : phase;
    if (phase === 'idle') resetTelemetry();
    refreshMiddleSamples();
    renderAll();
  }

  function setLeading(value) {
    if (isLocked()) return;
    var state = currentState();
    var requested = Number(value) || 0;
    var max = maxForLeading();
    var next = clamp(requested, 0, max);
    if (requested > max || (next > state.leading && totalLocked() >= currentCap())) {
      notifyCap();
    }
    if (next === state.leading) return;
    state.leading = next;
    patternEdited();
  }

  function setPre(value) {
    if (isLocked()) return;
    var state = currentState();
    var requested = Number(value) || 0;
    var max = maxForPre();
    var next = clamp(requested, 0, max);
    if (requested > max || (next > state.pre && totalLocked() >= currentCap())) {
      notifyCap();
    }
    if (next === state.pre) return;
    state.pre = next;
    patternEdited();
  }

  function setSuffix(raw, options) {
    if (isLocked()) return;
    var state = currentState();
    var source = String(raw == null ? '' : raw);
    var reported = false;

    if (engine === 'sol') {
      var cleaned = '';
      var invalid = [];
      for (var i = 0; i < source.length; i += 1) {
        var char = source[i];
        if (BASE58_SET.has(char)) {
          cleaned += char;
        } else if (invalid.indexOf(char) === -1) {
          invalid.push(char);
        }
      }
      if (invalid.length > 0) {
        showBase58Tip(invalid);
        reported = true;
      }
      source = cleaned;
    }

    var available = maxSuffix();
    if (source.length > available) {
      source = source.slice(0, available);
      if (!options || !options.silent) notifyCap();
      reported = true;
    }

    state.suffix = source;
    if (refs.suffixInput && refs.suffixInput.value !== source) {
      refs.suffixInput.value = source;
    }
    if (!reported) hideBase58Tip();
    patternEdited();
  }

  function patternEdited() {
    var wasStopped = retireStopState();
    if (!wasStopped && phase === 'idle') {
      if (stats.attempts > 0) resetTelemetry();
    }
    renderAll();
  }

  function applyWord(word) {
    if (isLocked()) return;
    if (!word) return;
    if (word.length > maxSuffix()) {
      toast('Need ' + word.length + ' free characters. Reduce a pad first.', 'alert');
      return;
    }
    if (engine === 'sol') {
      for (var i = 0; i < word.length; i += 1) {
        if (!BASE58_SET.has(word[i])) {
          toast('That preset contains a character Base58 excludes.', 'alert');
          return;
        }
      }
    }
    currentState().suffix = word;
    hideBase58Tip();
    patternEdited();
  }

  function onCaseToggle(checked) {
    if (isLocked()) return;
    var state = currentState();

    if (engine === 'evm') {
      state.strict = Boolean(checked);
    } else {
      state.ignoreCase = Boolean(checked);
      var cap = currentCap();
      var total = state.leading + state.pre + state.suffix.length;
      if (total > cap) {
        var excess = total - cap;
        var fromPre = Math.min(excess, state.pre);
        state.pre -= fromPre;
        excess -= fromPre;
        var fromLead = Math.min(excess, state.leading);
        state.leading -= fromLead;
        excess -= fromLead;
        var removedSuffix = 0;
        if (excess > 0) {
          var nextLength = Math.max(0, state.suffix.length - excess);
          removedSuffix = state.suffix.length - nextLength;
          state.suffix = state.suffix.slice(0, nextLength);
        }
        var removedPadding = fromPre + fromLead;
        var pieces = [];
        if (removedPadding > 0) {
          pieces.push(removedPadding + ' padding lock' + (removedPadding === 1 ? '' : 's'));
        }
        if (removedSuffix > 0) {
          pieces.push(removedSuffix + ' suffix character' + (removedSuffix === 1 ? '' : 's'));
        }
        toast('Strict case caps this pattern at ' + cap + ' locks. Removed ' + pieces.join(' and ') + '.', 'alert');
      }
    }

    patternEdited();
    if (engine === 'sol' && checked) {
      var boost = Math.pow(2, casedLetters(currentState().suffix));
      if (boost > 1) toast('Case-insensitive matching enabled. ' + boost + '× probability boost.');
    }
  }

  function notifyCap() {
    var now = performance.now();
    if (notifyCap.lastAt && now - notifyCap.lastAt < 1200) return;
    notifyCap.lastAt = now;
    var cap = currentCap();
    toast('Max Browser Safe Complexity Reached: ' + cap + ' locked characters. Lower a pad or shorten the word.', 'alert');
    if (refs.capBadge) {
      refs.capBadge.hidden = false;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && refs.capBadge.animate) {
        refs.capBadge.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(1.035)' },
            { transform: 'scale(1)' }
          ],
          { duration: 190, easing: 'ease-out' }
        );
      }
    }
  }
  notifyCap.lastAt = 0;

  function showBase58Tip(chars) {
    if (!refs.base58Tip) return;
    var listed = chars.map(function (char) {
      return '"' + displayChar(char) + '"';
    }).join(', ');
    refs.base58TipCopy.textContent = 'Removed ' + listed + '. Base58 avoids visually ambiguous characters such as 0/O and I/l, so a pasted address cannot silently change meaning.';
    refs.base58Tip.hidden = false;
    clearTimeout(base58TipTimer);
    base58TipTimer = setTimeout(hideBase58Tip, 6500);
  }

  function hideBase58Tip() {
    clearTimeout(base58TipTimer);
    if (refs.base58Tip) refs.base58Tip.hidden = true;
  }

  function refreshMiddleSamples() {
    var bytes = new Uint8Array(12);
    try {
      crypto.getRandomValues(bytes);
    } catch (_) {  }
    var hex = '';
    for (var i = 0; i < 8; i += 1) hex += (bytes[i] % 16).toString(16);
    var b58 = '';
    for (var j = 0; j < 8; j += 1) {
      b58 += '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[bytes[j] % 58];
    }
    middleSamples.evm = hex;
    middleSamples.sol = b58;
  }

  

  function renderEngineSwitch() {
    var buttons = document.querySelectorAll('.engine-btn');
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      var active = button.dataset.engine === engine;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.disabled = isLocked();
    }
  }

  function renderScale(container, maxIndex, value, dynamicMax) {
    if (!container) return;
    container.replaceChildren();
    for (var i = 0; i <= maxIndex; i += 1) {
      var tick = document.createElement('span');
      tick.className = 'range-tick';
      tick.textContent = String(i);
      if (i <= value) tick.classList.add('is-reached');
      if (i > dynamicMax) tick.classList.add('is-disabled');
      container.appendChild(tick);
    }
  }

  function renderStepper(field, value, dynamicMax, metaMax) {
    var isLeading = field === 'leading';
    var range = isLeading ? refs.leadRange : refs.preRange;
    var minus = isLeading ? refs.leadMinus : refs.preMinus;
    var plus = isLeading ? refs.leadPlus : refs.prePlus;
    var output = isLeading ? refs.leadValue : refs.preValue;
    var maxLabel = isLeading ? refs.leadMaxLabel : refs.preMaxLabel;
    var scale = isLeading ? refs.leadScale : refs.preScale;
    var foot = isLeading ? refs.leadFoot : refs.preFoot;
    var capNote = isLeading ? refs.leadCapNote : refs.preCapNote;
    var block = isLeading ? refs.leadBlock : refs.preBlock;
    var locked = isLocked();

    range.max = String(metaMax);
    range.value = String(value);
    range.disabled = locked || dynamicMax === 0;
    range.style.setProperty('--pct', metaMax > 0 ? (value / metaMax * 100).toFixed(2) + '%' : '0%');
    range.setAttribute('aria-valuetext', value + ' ' + (isLeading ? 'leading locks' : 'pre-suffix locks'));
    range.setAttribute('aria-valuemax', String(dynamicMax));

    minus.disabled = locked || value <= 0;
    plus.disabled = locked || value >= dynamicMax;

    output.textContent = String(value);
    maxLabel.textContent = '/ ' + metaMax;

    renderScale(scale, metaMax, value, dynamicMax);

    var noun = isLeading ? 'leading' : 'pre-suffix';
    if (value === 0) {
      foot.textContent = isLeading ? 'No leading pad.' : 'No pre-suffix pad.';
    } else if (engine === 'evm') {
      foot.textContent = isLeading
        ? 'Locks ' + value + ' zero' + (value === 1 ? '' : 's') + ' directly after 0x.'
        : 'Locks ' + value + ' zero' + (value === 1 ? '' : 's') + ' before the word.';
    } else {
      foot.textContent = isLeading
        ? 'Locks ' + value + ' Base58 one' + (value === 1 ? '' : 's') + ' at the start. Each one encodes a zero byte.'
        : 'Locks ' + value + ' Base58 one' + (value === 1 ? '' : 's') + ' before the word. Each one encodes a zero byte.';
    }

    var total = totalLocked();
    var cap = currentCap();
    if (dynamicMax === 0) {
      capNote.textContent = 'no room';
    } else if (value >= dynamicMax && dynamicMax < metaMax) {
      capNote.textContent = 'max ' + dynamicMax;
    } else if (total >= cap) {
      capNote.textContent = 'cap hit';
    } else {
      capNote.textContent = '';
    }
    capNote.classList.toggle('is-max', Boolean(capNote.textContent));
    block.classList.toggle('is-capped', total >= cap);
  }

  function renderCharStrip(state) {
    if (!refs.charStrip) return;
    refs.charStrip.replaceChildren();
    if (!state.suffix) {
      refs.charStrip.classList.add('is-empty');
      return;
    }
    refs.charStrip.classList.remove('is-empty');
    for (var i = 0; i < state.suffix.length; i += 1) {
      var char = state.suffix[i];
      var allowed = engine === 'evm' ? HEX_SET.has(char) : BASE58_SET.has(char);
      var token = document.createElement('span');
      token.className = 'char-token' + (allowed ? '' : ' is-invalid');
      token.textContent = char === ' ' ? '·' : char;
      if (!allowed) token.title = 'Not valid in ' + (engine === 'evm' ? 'hex' : 'base58');
      refs.charStrip.appendChild(token);
    }
  }

  function makeSuggestionCandidates(raw, available) {
    var candidates = [];
    var seen = new Set();

    function add(value, note) {
      if (!value || value.length > available) return;
      if (!/^[0-9a-fA-F]+$/.test(value)) return;
      var key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ value: value, note: note });
    }

    var curated = CURATED_HEX.get(raw.toUpperCase());
    if (curated) {
      curated.forEach(function (word) { add(word, 'smart fit'); });
    }

    var leet = '';
    for (var i = 0; i < raw.length; i += 1) {
      var char = raw[i];
      if (HEX_SET.has(char)) {
        leet += char;
      } else {
        var mapped = LEET_MAP[char.toUpperCase()];
        if (mapped) leet += mapped;
      }
    }
    add(leet, 'leet map');

    var stripped = '';
    for (var j = 0; j < raw.length; j += 1) {
      if (HEX_SET.has(raw[j])) stripped += raw[j];
    }
    add(stripped, 'trimmed');

    if (candidates.length === 0) {
      EVM_PRESETS.forEach(function (preset) {
        if (preset.length <= available) add(preset, 'preset');
      });
    }

    return candidates.slice(0, 3);
  }

  function renderSuggestions(profile) {
    if (!refs.suggestPanel) return;
    if (engine !== 'evm' || profile.invalid.length === 0) {
      refs.suggestPanel.hidden = true;
      refs.suggestList.replaceChildren();
      return;
    }

    var candidates = makeSuggestionCandidates(currentState().suffix, profile.available);
    var invalidLabel = profile.invalid.map(function (char) {
      return '"' + displayChar(char) + '"';
    }).join(', ');
    refs.suggestCopy.textContent =
      '"' + currentState().suffix + '" contains ' + invalidLabel +
      '. Hex can only use 0 to 9 and a to f. Try a visual translation:';
    refs.suggestList.replaceChildren();

    if (candidates.length === 0) {
      var none = document.createElement('span');
      none.className = 'validation-detail';
      none.textContent = 'No close hex form fits this pattern. Choose a posh preset below.';
      refs.suggestList.appendChild(none);
      refs.suggestPanel.hidden = false;
      return;
    }

    candidates.forEach(function (candidate) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'suggest-chip';
      button.dataset.suggestion = candidate.value;
      button.disabled = isLocked();
      button.setAttribute(
        'aria-label',
        'Apply ' + candidate.value + ' as the ending word. ' + candidate.note + '.'
      );

      var arrow = document.createElement('span');
      arrow.className = 'suggest-arrow';
      arrow.textContent = '→';
      var value = document.createElement('span');
      value.className = 'suggest-value';
      value.textContent = candidate.value;
      var note = document.createElement('span');
      note.className = 'suggest-note';
      note.textContent = candidate.note;

      button.appendChild(arrow);
      button.appendChild(value);
      button.appendChild(note);
      refs.suggestList.appendChild(button);
    });

    refs.suggestPanel.hidden = false;
  }

  function renderPresets(profile) {
    if (!refs.presetList) return;
    refs.presetList.replaceChildren();
    refs.presetLabel.textContent = currentMeta().presetLabel;
    var source = engine === 'evm' ? EVM_PRESETS : SOL_PRESETS;
    var state = currentState();
    var available = profile.available;

    source.forEach(function (word) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-chip';
      button.dataset.word = word;
      button.textContent = word;
      var fits = word.length <= available;
      button.disabled = isLocked() || !fits;
      button.classList.toggle('is-active', word.toLowerCase() === state.suffix.toLowerCase());
      if (!fits) {
        button.title = 'Needs ' + word.length + ' free characters; ' + available + ' available.';
      }
      refs.presetList.appendChild(button);
    });
  }

  function renderValidity(profile) {
    var status = refs.validationStatus;
    var label = status.querySelector('span');
    var use = status.querySelector('use');
    var detail = refs.validationDetail;
    var state = currentState();
    var valid = profile.valid;

    status.classList.toggle('is-invalid', !valid);
    status.classList.toggle('is-valid', valid);
    if (use) use.setAttribute('href', valid ? '#i-check' : '#i-alert');

    if (!valid) {
      label.textContent = engine === 'evm' ? 'INVALID HEX' : 'INVALID BASE58';
      detail.textContent = 'Remove ' + profile.invalid.map(function (char) {
        return '"' + displayChar(char) + '"';
      }).join(', ') + ': not valid ' + (engine === 'evm' ? 'hex' : 'Base58') + '.';
    } else if (!state.suffix) {
      label.textContent = 'OPTIONAL';
      detail.textContent = engine === 'evm'
        ? 'No ending word. Padding locks still apply.'
        : 'No ending word. Padding locks still apply.';
    } else {
      label.textContent = engine === 'evm' ? 'HEX VALID' : 'BASE58 VALID';
      if (engine === 'evm' && state.strict) {
        detail.textContent = 'EIP-55 casing enforced' + (profile.letters > 0
          ? ' · adds ×' + Math.pow(2, profile.letters) + ' difficulty.'
          : ' · no cased letters.');
      } else if (engine === 'sol' && state.ignoreCase) {
        detail.textContent = 'Case-insensitive matching' + (profile.letters > 0
          ? ' · ×' + Math.pow(2, profile.letters) + ' probability boost.'
          : ' · no cased letters.');
      } else {
        detail.textContent = 'Ready for ' + (engine === 'evm' ? 'secp256k1 derivation.' : 'ed25519 derivation.');
      }
    }

    refs.suffixField.classList.toggle('is-invalid', !valid);
  }

  function renderCase(profile) {
    var state = currentState();
    var isEvm = engine === 'evm';
    var on = isEvm ? state.strict : state.ignoreCase;
    var factor = on ? Math.pow(2, profile.letters) : 1;

    refs.caseToggle.checked = on;
    refs.caseToggle.disabled = isLocked();
    refs.caseRow.classList.toggle('is-on', on);
    refs.caseRow.classList.toggle('is-disabled', isLocked());

    refs.caseLabel.textContent = isEvm ? 'Strict EIP-55 casing' : 'Case-insensitive match';
    if (isEvm) {
      refs.caseHint.textContent = 'Match checksum casing exactly. Every cased letter doubles difficulty.';
    } else if (on) {
      refs.caseHint.textContent = 'Case variants accepted · this word gets a ×' + factor + ' probability boost.';
    } else if (profile.letters > 0) {
      refs.caseHint.textContent = 'Case variants accepted when on · ×' + Math.pow(2, profile.letters) + ' potential boost.';
    } else {
      refs.caseHint.textContent = 'No cased letters in this word, so case-insensitive matching adds no boost.';
    }
    refs.caseFactor.textContent = '×' + factor;
    refs.caseFactor.title = isEvm
      ? (on ? 'Strict casing multiplies expected attempts by ' + factor : 'Case-insensitive hex matching')
      : (on ? 'Case-insensitive matching multiplies hit probability by ' + factor : 'Exact Base58 casing');
  }

  function renderPreview(profile) {
    if (!refs.previewAddress) return;
    var state = currentState();
    var cap = profile.cap;
    var total = profile.total;
    var addressFragments = document.createDocumentFragment();
    var foundNow = phase === 'found' && found;
    var address = foundNow ? found.address : null;
    var sample = middleSamples[engine];

    function push(text, className) {
      if (!text) return;
      var span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      addressFragments.appendChild(span);
    }

    if (foundNow) {
      var suffixStart = address.length - profile.suffixLength;
      var preStart = suffixStart - state.pre;
      if (engine === 'evm') push('0x', 'addr-dim');
      push(address.slice(0, state.leading), 'addr-lock');
      push(address.slice(state.leading, preStart), 'addr-mid');
      push(address.slice(preStart, suffixStart), 'addr-lock');
      push(address.slice(suffixStart), 'addr-lock');
      refs.previewAddress.setAttribute('aria-label', 'Found address ' + address);
    } else {
      if (engine === 'evm') push('0x', 'addr-dim');
      if (engine === 'sol') {
        push('1'.repeat(state.leading), 'addr-lock');
      } else {
        push('0'.repeat(state.leading), 'addr-lock');
      }
      push(sample.slice(0, 4), 'addr-mid');
      push('…', 'addr-ellipsis');
      push(sample.slice(4, 8), 'addr-mid');
      push((engine === 'sol' ? '1' : '0').repeat(state.pre), 'addr-lock');
      if (state.suffix) {
        var suffixClass = profile.valid ? 'addr-lock' : 'addr-invalid';
        push(state.suffix, suffixClass);
      }
      refs.previewAddress.setAttribute(
        'aria-label',
        'Address preview. ' + profile.total + ' of ' + profile.cap + ' characters locked. Ending word ' +
        (state.suffix || 'none') + '.'
      );
    }

    refs.previewAddress.replaceChildren(addressFragments);

    refs.previewStatus.textContent = foundNow ? 'FOUND' : (phase === 'running' ? 'GRINDING' : 'SIMULATED');
    refs.previewStatus.classList.toggle('is-solid', Boolean(foundNow));
    refs.previewSub.textContent = foundNow
      ? 'Verified local result · full address'
      : (phase === 'running' ? 'Illustrative middle · workers live' : 'Illustrative middle characters');
    refs.previewNote.textContent = foundNow
      ? 'Matched, checksummed, and stopped.'
      : (state.suffix ? 'Locks are shown in solid.' : 'Add an ending word to complete the look.');
    refs.previewBadge.textContent = engine === 'evm' ? 'EIP-55' : 'BASE58';
    refs.previewChains.textContent = currentMeta().chainRow;

    refs.lockReadout.textContent = 'LOCKED ' + total + ' / ' + cap;
    refs.lockMeter.replaceChildren();
    for (var i = 0; i < cap; i += 1) {
      var cell = document.createElement('span');
      cell.className = 'lock-cell' + (i < total ? ' is-filled' : '');
      refs.lockMeter.appendChild(cell);
    }
    refs.lockMeter.classList.toggle('is-max', total === cap);

    refs.previewPanel = refs.previewPanel || document.querySelector('.preview-panel');
    if (refs.previewPanel) refs.previewPanel.setAttribute('data-found', foundNow ? 'true' : 'false');
  }

  function renderProfile(profile) {
    var mean = profile.expected;
    var exact = mean !== null && Number.isFinite(mean) ? formatCount(mean) : '';
    var formulaDescription = formulaAria(profile);
    if (engine === 'sol' && currentState().leading > 0) {
      formulaDescription += ' Each leading Base58 one encodes a zero byte, so it is modeled at one in 256.';
    }

    refs.profileMean.textContent = mean !== null ? compactNumber(mean) : '-';
    refs.profileMean.title = exact ? exact + ' expected attempts' : 'Pattern is not ready';
    refs.profileFormula.innerHTML = formulaMarkup(profile);
    refs.profileFormula.title = formulaDescription;
    refs.profileMode.textContent = modeLabel(profile);
    refs.profileEngine.textContent = currentMeta().algo;

    refs.formulaOut.innerHTML = formulaMarkup(profile);
    refs.formulaOut.setAttribute('aria-label', formulaDescription);
    refs.formulaOut.title = formulaDescription;
    refs.meanOut.textContent = mean !== null ? compactNumber(mean) : '-';
    refs.meanOut.title = exact ? exact + ' expected attempts' : 'Pattern is not ready';

    refs.suffixCount.textContent = currentState().suffix.length + ' / ' + profile.available;
    refs.suffixAvail.textContent = profile.available === 0 ? 'NO ROOM' : 'AVAILABLE';
    refs.suffixCount.title = profile.available === 0
      ? 'Complexity cap reached. Lower a pad or clear the word.'
      : profile.available + ' free characters at this pad setting';

    var total = profile.total;
    var cap = profile.cap;
    refs.capBadge.hidden = total < cap;
    if (total >= cap) {
      if (engine === 'sol' && !profile.state.ignoreCase && profile.letters > 0) {
        var looseBoost = Math.pow(2, profile.letters);
        refs.capLeft.textContent = 'All ' + cap + ' locks used · case-insensitive adds 1 slot & ×' + looseBoost + ' hit rate';
        refs.capLeft.title = 'Case-insensitive matching raises the Solana cap to 6 and boosts this word by ×' + looseBoost + '. Stop the engine to change it.';
      } else {
        refs.capLeft.textContent = 'All ' + cap + ' locks used · lower a pad to edit';
        refs.capLeft.title = '';
      }
    } else {
      refs.capLeft.textContent = total + ' of ' + cap + ' locks used · ' + (cap - total) + ' available';
      refs.capLeft.title = '';
    }

    refs.suffixInput.value = currentState().suffix;
    refs.suffixInput.disabled = isLocked();
    refs.resetBtn.disabled = isLocked();
    refs.builder = refs.builder || $('builder');
    if (refs.builder) refs.builder.classList.toggle('is-locked', isLocked());
  }

  function renderProfileLabels() {
    refs.engineContext.textContent = currentMeta().chains;
    refs.engineChains.textContent = currentMeta().chains;
    refs.engineAlgo.textContent = currentMeta().algo;
    refs.suffixEngineTag.textContent = currentMeta().suffixTag;
    refs.suffixHint.textContent = engine === 'evm'
      ? 'Matched at the tail of the address'
      : 'All Base58 characters are allowed here';
    refs.leadLabel.textContent = 'Leading pad';
    refs.leadHint.textContent = engine === 'evm' ? 'Zeros directly after 0x' : 'Base58 1s at the start';
    refs.preLabel.textContent = 'Pre-suffix pad';
    refs.preHint.textContent = engine === 'evm' ? 'Zeros immediately before the word' : 'Base58 1s before the word';
    refs.presetLabel.textContent = currentMeta().presetLabel;
  }

  function renderTerminal() {
    var state = currentState();
    var command = 'forge --engine ' + engine +
      ' --lead ' + state.leading +
      ' --pre ' + state.pre +
      ' --word ' + (state.suffix || '∅') +
      ' --case ' + (engine === 'evm'
        ? (state.strict ? 'strict' : 'loose')
        : (state.ignoreCase ? 'ignore' : 'strict'));
    refs.terminalCmd.textContent = command;
    refs.termSession.textContent = 'SESSION ' + String(sessionCounter).padStart(4, '0');
    refs.termWorkers.textContent = (phase === 'running' ? workers.length : 0) + ' WORKERS';
  }

  function renderCTA(profile) {
    var locked = isLocked();
    var running = phase === 'running';
    var foundNow = phase === 'found' && found;
    var invalid = !profile.valid;
    var empty = profile.total === 0;
    var over = profile.total > profile.cap;
    var button = refs.startBtn;
    var iconUse = refs.startIcon.querySelector('use');

    button.classList.toggle('is-running', running);
    button.classList.toggle('is-found', Boolean(foundNow));
    button.disabled = !running && !foundNow && (invalid || empty || over);
    button.setAttribute('aria-busy', running ? 'true' : 'false');

    if (running) {
      refs.startLabel.textContent = 'Stop engine';
      refs.startSub.textContent = (workers.length || threads) + ' workers live · stop safely';
      if (iconUse) iconUse.setAttribute('href', '#i-stop');
      refs.startHint.textContent = 'Press again or use Ctrl+Enter to stop. Attempts freeze.';
    } else if (foundNow) {
      refs.startLabel.textContent = 'View found wallet';
      refs.startSub.textContent = 'Match secured in local vault';
      if (iconUse) iconUse.setAttribute('href', '#i-arrow');
      refs.startHint.textContent = 'Open the vault to copy or back up your key.';
    } else if (invalid) {
      refs.startLabel.textContent = 'Resolve pattern';
      refs.startSub.textContent = 'Invalid suffix characters';
      if (iconUse) iconUse.setAttribute('href', '#i-alert');
      refs.startHint.textContent = 'Fix the highlighted characters before starting.';
    } else if (over) {
      refs.startLabel.textContent = 'Reduce complexity';
      refs.startSub.textContent = 'Browser-safe cap exceeded';
      if (iconUse) iconUse.setAttribute('href', '#i-alert');
      refs.startHint.textContent = 'Lower a pad or shorten the ending word.';
    } else if (empty) {
      refs.startLabel.textContent = 'Add a pattern';
      refs.startSub.textContent = 'At least one lock required';
      if (iconUse) iconUse.setAttribute('href', '#i-arrow');
      refs.startHint.textContent = 'Add leading padding, pre-suffix padding, or an ending word.';
    } else {
      refs.startLabel.textContent = phase === 'stopped' ? 'Start again' : 'Start grinding';
      refs.startSub.textContent = threads + ' local workers · no upload';
      if (iconUse) iconUse.setAttribute('href', '#i-arrow');
      refs.startHint.textContent = phase === 'stopped'
        ? 'Starting again resets the attempt counter.'
        : 'Runs entirely in this tab. Nothing leaves your browser.';
    }

    if (refs.startBtn.dataset.locked !== String(locked)) {
      refs.startBtn.dataset.locked = String(locked);
    }
  }

  function renderSuggestionsAndPresets(profile) {
    renderSuggestions(profile);
    renderPresets(profile);
  }

  function renderPattern() {
    renderEngineSwitch();
    renderProfileLabels();

    var profile = buildProfile();
    var state = currentState();

    renderStepper('leading', state.leading, maxForLeading(), currentMeta().maxLeading);
    renderStepper('pre', state.pre, maxForPre(), currentMeta().maxPre);
    renderCharStrip(state);
    renderValidity(profile);
    renderSuggestionsAndPresets(profile);
    renderCase(profile);
    renderProfile(profile);
    renderPreview(profile);
    renderCTA(profile);
    renderTerminal();
    updateNetworkUI();
    return profile;
  }

  function renderAll() {
    var profile = renderPattern();
    renderTelemetry();
    renderEngineStatus();
    return profile;
  }

  

  function renderEngineStatus() {
    if (!refs.engineStatus) return;
    var label = 'IDLE';
    var data = 'idle';
    if (phase === 'running') { label = 'RUNNING'; data = 'running'; }
    else if (phase === 'found') { label = 'FOUND'; data = 'found'; }
    else if (phase === 'stopped') { label = 'STOPPED'; data = 'stopped'; }
    refs.engineStatus.dataset.status = data;
    refs.engineStatusText.textContent = label;
  }

  function renderSparkline() {
    if (!refs.sparkPath || !refs.sparkDot) return;
    var W = 240;
    var H = 58;
    var top = 4;
    var bottom = 49;
    var values = chartValues.length ? chartValues : [0];
    var max = Math.max(1000, Math.max.apply(null, values)) * 1.06;
    var lastX = W;
    var lastY = bottom;

    var path = '';
    for (var i = 0; i < values.length; i += 1) {
      var x = values.length === 1 ? W : (i / (values.length - 1)) * W;
      var ratio = clamp(values[i] / max, 0, 1);
      var y = bottom - ratio * (bottom - top);
      path += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
      if (i === values.length - 1) {
        lastX = x;
        lastY = y;
      }
    }
    if (values.length === 1) {
      path = 'M0 ' + bottom + ' L' + W + ' ' + bottom;
      lastX = W;
      lastY = bottom;
    }
    refs.sparkPath.setAttribute('d', path);
    refs.sparkDot.setAttribute('cx', lastX.toFixed(2));
    refs.sparkDot.setAttribute('cy', lastY.toFixed(2));
  }

  function sampleChart(now) {
    if (phase !== 'running') return;
    if (lastChartAt && now - lastChartAt < 300) return;
    lastChartAt = now;
    chartValues.push(stats.speed);
    if (chartValues.length > 60) chartValues.shift();
    renderSparkline();
  }

  function renderTelemetry() {
    if (!refs.speedValue) return;
    var now = performance.now();
    var profile = run && run.profile ? run.profile : buildProfile();
    var running = phase === 'running';
    var currentElapsed = 0;

    if (stats.startedAt) {
      var end = running ? now : (stats.endedAt || stats.startedAt);
      currentElapsed = Math.max(0, (end - stats.startedAt) / 1000);
    }

    var displayAttempts = stats.attempts;
    if (running && stats.speed > 0 && stats.lastMessageAt) {
      var gap = clamp((now - stats.lastMessageAt) / 1000, 0, 0.85);
      displayAttempts += gap * stats.speed;
    }

    var hit = phase === 'found' ? 1 : probabilityFor(displayAttempts, profile.probability);
    var shownAttempts = phase === 'found' ? stats.attempts : Math.floor(displayAttempts);
    var attemptsText = formatCount(shownAttempts);
    refs.attemptsValue.textContent = attemptsText;
    refs.attemptsValue.classList.toggle('is-long', attemptsText.length > 10);

    var speed = running ? stats.speed : 0;
    var speedText = formatRate(speed);
    refs.speedValue.textContent = speedText;
    refs.speedValue.classList.toggle('is-long', speedText.length > 6);
    refs.speedPeak.textContent = 'PEAK ' + formatRate(stats.peakSpeed);
    if (running) {
      refs.speedSub.textContent = 'EWMA · ' + workers.length + ' WORKERS';
    } else if (phase === 'found') {
      refs.speedSub.textContent = 'ENGINE STOPPED';
    } else if (phase === 'stopped') {
      refs.speedSub.textContent = 'PAUSED · ' + formatRate(stats.avgSpeed) + ' AVG';
    } else {
      refs.speedSub.textContent = 'ALL WORKERS IDLE';
    }

    refs.elapsedValue.textContent = formatDuration(currentElapsed);
    refs.attemptsSub.textContent = phase === 'running'
      ? 'LIVE · BATCH 500'
      : (phase === 'found' ? 'MATCH SECURED' : (phase === 'stopped' ? 'ENGINE PAUSED' : 'NO ENGINE STARTED'));
    refs.attemptsWorkers.textContent = stats.startedAt ? threads + 'W' : '-';

    refs.probValue.textContent = formatProbability(shownAttempts, profile.probability);
    refs.probValue.classList.toggle('is-long', refs.probValue.textContent.length > 9);
    refs.probBar.style.transform = 'scaleX(' + hit.toFixed(6) + ')';
    refs.probTrack.setAttribute('aria-valuenow', (hit * 100).toFixed(3));
    refs.probTag.textContent = phase === 'found'
      ? 'MATCH'
      : (running ? 'LIVE' : (phase === 'stopped' ? 'PAUSED' : 'IDLE'));

    var etaText = '--:--';
    var etaSub = 'Awaiting engine';
    var etaTag = 'IDLE';
    var expectedText = profile.expected !== null ? 'MEAN ' + compactNumber(profile.expected) : 'MEAN -';
    var rateText = '@ ' + formatRate(running ? stats.speed : 0) + ' KEYS/S';

    if (phase === 'found') {
      etaText = '00:00.000';
      etaSub = 'Match found and verified.';
      etaTag = 'DONE';
      rateText = '@ ' + formatRate(stats.avgSpeed) + ' AVG';
    } else if (running) {
      etaTag = 'LIVE';
      if (stats.speed <= 0 || profile.expected === null) {
        etaText = '--:--';
        etaSub = 'Workers are warming up…';
        etaTag = 'ARMING';
      } else {
        var remaining = Math.max(0, profile.expected - displayAttempts);
        var seconds = remaining / stats.speed;
        etaText = formatDuration(seconds);
        etaSub = remaining <= 0
          ? 'Mean ETA passed. Probability keeps climbing.'
          : 'At the current EWMA rate.';
        if (remaining <= 0) etaTag = 'PAST MEAN';
        rateText = '@ ' + formatRate(stats.speed) + ' KEYS/S';
      }
    } else if (phase === 'stopped') {
      etaText = '--:--';
      etaSub = 'Engine paused. Starting again resets attempts.';
      etaTag = 'PAUSED';
    } else {
      etaSub = profile.ready
        ? 'Mean ' + compactNumber(profile.expected) + ' attempts. Start the engine for live ETA.'
        : 'Awaiting a valid pattern.';
    }

    refs.etaValue.textContent = etaText;
    refs.etaValue.classList.toggle('is-long', etaText.length > 9);
    refs.etaSub.textContent = etaSub;
    refs.etaTag.textContent = etaTag;
    refs.etaExpected.textContent = expectedText;
    refs.etaExpected.title = profile.expected !== null ? formatCount(profile.expected) + ' expected attempts' : '';
    refs.etaRate.textContent = rateText;

    refs.termWorkers.textContent = (running ? workers.length : 0) + ' WORKERS';
  }

  function startTicker() {
    stopTicker();
    var loop = function () {
      if (phase !== 'running') {
        rafId = null;
        renderTelemetry();
        return;
      }
      sampleChart(performance.now());
      renderTelemetry();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function stopTicker() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  

  function getThreadCount() {
    var count = Number(navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(count, 64));
  }

  function decodeWorkerURL() {
    if (workerURL) return workerURL;
    var source = $('worker-source');
    if (!source) throw new Error('Worker bundle is missing.');
    var encoded = source.textContent.trim();
    if (!encoded) throw new Error('Worker bundle is empty.');
    var binary = atob(encoded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    var blob = new Blob([bytes], { type: 'text/javascript' });
    workerURL = URL.createObjectURL(blob);
    return workerURL;
  }

  function configForWorkers(profile) {
    var state = profile.state;
    if (engine === 'evm') {
      return {
        engine: 'evm',
        leadingZeros: state.leading,
        preSuffixZeros: state.pre,
        suffix: state.suffix,
        caseSensitive: state.strict
      };
    }
    return {
      engine: 'sol',
      leadingOnes: state.leading,
      preSuffixOnes: state.pre,
      suffix: state.suffix,
      caseInsensitive: state.ignoreCase
    };
  }

  function verifyFoundResult(result, profile) {
    if (!result || result.chain !== engine) return false;
    var state = profile.state;
    if (engine === 'evm') {
      if (!/^[0-9a-fA-F]{40}$/.test(result.address || '')) return false;
      if (!/^0x[0-9a-f]{64}$/.test(result.privateKeyHex || '')) return false;
      var lower = result.address.toLowerCase();
      if (lower.slice(0, state.leading) !== '0'.repeat(state.leading)) return false;
      var suffixStart = 40 - state.suffix.length;
      var preStart = suffixStart - state.pre;
      if (lower.slice(preStart, suffixStart) !== '0'.repeat(state.pre)) return false;
      if (state.strict) {
        if (result.address.slice(suffixStart) !== state.suffix) return false;
      } else if (lower.slice(suffixStart) !== state.suffix.toLowerCase()) {
        return false;
      }
      return true;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.address || '')) return false;
    if (!result.privateKeyBase58 || !Array.isArray(result.privateKeyArray) || result.privateKeyArray.length !== 64) return false;
    if (!result.address.startsWith('1'.repeat(state.leading))) return false;
    var suffixStartSol = result.address.length - state.suffix.length;
    var preStartSol = suffixStartSol - state.pre;
    if (result.address.slice(preStartSol, suffixStartSol) !== '1'.repeat(state.pre)) return false;
    if (state.ignoreCase) {
      if (result.address.slice(suffixStartSol).toLowerCase() !== state.suffix.toLowerCase()) return false;
    } else if (result.address.slice(suffixStartSol) !== state.suffix) {
      return false;
    }
    return true;
  }

  function terminateWorkers() {
    for (var i = 0; i < workers.length; i += 1) {
      try { workers[i].terminate(); } catch (_) {  }
    }
    workers = [];
  }

  function haltRun(message) {
    if (phase !== 'running') return;
    stats.endedAt = performance.now();
    stats.avgSpeed = stats.attempts / Math.max(0.001, (stats.endedAt - stats.startedAt) / 1000);
    stats.lastSpeed = stats.speed;
    stats.speed = 0;
    phase = 'stopped';
    terminateWorkers();
    stopTicker();
    renderAll();
    if (message) toast(message, 'alert');
  }

  function handleWorkerProgress(workerId, message) {
    if (phase !== 'running' || !run || message.session !== run.id) return;
    stats.attempts += message.attempts;
    stats.lastMessageAt = performance.now();
    var elapsedSeconds = Math.max(0.001, message.elapsedMs / 1000);
    var sample = message.attempts / elapsedSeconds;
    var previous = stats.workerRates.get(workerId);
    var next = previous === undefined ? sample : previous * 0.72 + sample * 0.28;
    stats.workerRates.set(workerId, next);
    var total = 0;
    stats.workerRates.forEach(function (rate) { total += rate; });
    stats.speed = total;
    stats.lastSpeed = total;
    stats.peakSpeed = Math.max(stats.peakSpeed, total);
  }

  function handleWorkerFound(workerId, message) {
    if (phase !== 'running' || !run || message.session !== run.id) return;
    stats.attempts += message.attempts;
    stats.lastMessageAt = performance.now();
    var sample = message.attempts / Math.max(0.001, message.elapsedMs / 1000);
    var previous = stats.workerRates.get(workerId);
    stats.workerRates.set(workerId, previous === undefined ? sample : previous * 0.72 + sample * 0.28);
    var total = 0;
    stats.workerRates.forEach(function (rate) { total += rate; });
    stats.lastSpeed = total;
    stats.peakSpeed = Math.max(stats.peakSpeed, total);

    var profile = run.profile;
    if (!verifyFoundResult(message.result, profile)) {
      haltRun('Worker returned an unverifiable match. Engine stopped.');
      return;
    }

    phase = 'found';
    stats.endedAt = performance.now();
    stats.avgSpeed = stats.attempts / Math.max(0.001, (stats.endedAt - stats.startedAt) / 1000);
    stats.speed = 0;
    found = message.result;
    terminateWorkers();
    stopTicker();
    clearToasts();
    renderAll();
    playFoundChime();
    vibrate([35, 45, 90]);
    openVault();
  }

  function startWorkers(config) {
    var url = decodeWorkerURL();
    var count = getThreadCount();
    var spawned = [];

    try {
      for (var i = 0; i < count; i += 1) {
        var worker = new Worker(url);
        worker.onmessage = (function (id) {
          return function (event) {
            var message = event.data;
            if (!message || typeof message !== 'object') return;
            if (message.type === 'progress') handleWorkerProgress(id, message);
            else if (message.type === 'found') handleWorkerFound(id, message);
            else if (message.type === 'error') {
              haltRun('Worker fault: ' + (message.message || 'unknown error') + '.');
            }
          };
        })(i);
        worker.onerror = function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          haltRun('A worker could not start. Check browser worker support and CSP.');
        };
        spawned.push(worker);
      }
    } catch (error) {
      spawned.forEach(function (worker) { try { worker.terminate(); } catch (_) {} });
      haltRun('Worker initialization failed: ' + (error && error.message ? error.message : 'unknown error'));
      return;
    }

    workers = spawned;
    for (var j = 0; j < workers.length; j += 1) {
      workers[j].postMessage({ type: 'start', session: run.id, config: config });
    }
    renderTelemetry();
    renderCTA(buildProfile());
  }

  function startEngine() {
    if (phase === 'running') {
      stopEngine();
      return;
    }
    if (phase === 'found' && found) {
      openVault();
      return;
    }
    if (typeof Worker !== 'function') {
      toast('Web Workers are unavailable in this browser.', 'alert');
      return;
    }

    var profile = buildProfile();
    if (!profile.valid) {
      toast('Resolve the invalid suffix before starting.', 'alert');
      refs.suffixInput.focus();
      return;
    }
    if (profile.total === 0) {
      toast('Add at least one locked character.', 'alert');
      refs.leadRange.focus();
      return;
    }
    if (profile.total > profile.cap) {
      toast('Pattern exceeds the browser-safe complexity cap.', 'alert');
      return;
    }

    hideBase58Tip();
    ensureAudio();
    sessionCounter += 1;
    phase = 'running';
    found = null;
    stats = freshStats();
    stats.startedAt = performance.now();
    stats.lastMessageAt = stats.startedAt;
    chartValues = [0];
    lastChartAt = stats.startedAt;
    renderSparkline();
    run = {
      id: sessionCounter,
      startedAt: stats.startedAt,
      profile: profile,
      config: configForWorkers(profile)
    };

    renderAll();
    startTicker();
    try {
      startWorkers(run.config);
    } catch (error) {
      haltRun('Could not start the worker engine: ' + (error && error.message ? error.message : 'unknown error'));
      return;
    }
    if (phase === 'running') toast('Engine armed. ' + getThreadCount() + ' local workers running.');
  }

  function stopEngine() {
    if (phase !== 'running') return;
    stats.endedAt = performance.now();
    stats.avgSpeed = stats.attempts / Math.max(0.001, (stats.endedAt - stats.startedAt) / 1000);
    stats.lastSpeed = stats.speed;
    stats.speed = 0;
    phase = 'stopped';
    terminateWorkers();
    stopTicker();
    renderAll();
    toast('Engine stopped at ' + formatCount(stats.attempts) + ' attempts.');
  }

  

  function openVault() {
    if (!found) return;
    populateVault();
    if (!refs.vaultDialog.open) {
      try {
        refs.vaultDialog.showModal();
        document.documentElement.classList.add('modal-open');
      } catch (_) {
        
        refs.vaultDialog.setAttribute('open', '');
      }
    }
  }

  function closeVault(restoreFocus) {
    if (refs.vaultDialog.open) refs.vaultDialog.close();
    document.documentElement.classList.remove('modal-open');
    endHold();
    if (restoreFocus !== false) {
      setTimeout(function () {
        if (phase === 'found') refs.startBtn.focus();
      }, 0);
    }
  }

  function populateVault() {
    if (!found) return;
    var elapsed = stats.startedAt
      ? Math.max(0, ((stats.endedAt || performance.now()) - stats.startedAt) / 1000)
      : 0;
    var isEvm = found.chain === 'evm';

    refs.vaultElapsed.textContent = 'FOUND IN ' + formatDuration(elapsed);
    refs.vaultTitle.textContent = 'Wallet found.';
    refs.vaultAddress.textContent = found.address;
    refs.vaultChainBadge.textContent = isEvm ? 'EVM · EIP-55' : 'SOLANA · BASE58';
    refs.vaultAttempts.textContent = formatCount(stats.attempts);
    refs.vaultTime.textContent = formatDuration(elapsed);
    refs.vaultSpeed.textContent = formatRate(stats.avgSpeed) + '/s';
    refs.vaultProbability.textContent = '100.000%';

    refs.secretLabel.textContent = isEvm ? 'PRIVATE KEY / HEX' : 'SECRET KEY / BASE58';
    refs.secretValue.textContent = isEvm ? found.privateKeyHex : found.privateKeyBase58;
    refs.secretValue.setAttribute('aria-hidden', 'true');
    refs.phantomBlock.hidden = isEvm;
    if (isEvm) {
      refs.phantomValue.textContent = '';
      refs.phantomValue.setAttribute('aria-hidden', 'true');
      refs.phantomCopyBtn.hidden = true;
    } else {
      refs.phantomValue.textContent = JSON.stringify(found.privateKeyArray);
      refs.phantomValue.setAttribute('aria-hidden', 'true');
      refs.phantomCopyBtn.hidden = false;
    }

    var copyLabel = refs.copySecretBtn.querySelector('span');
    copyLabel.textContent = isEvm ? 'Copy private key' : 'Copy Base58 key';
    refs.vaultShell.classList.remove('is-revealed');
    refs.secretPanel.classList.remove('is-revealed', 'is-holding');
    refs.secretPanel.setAttribute('aria-pressed', 'false');
    refs.secretPanel.setAttribute('aria-label', isEvm ? 'Hold to reveal private key' : 'Hold to reveal secret key');
    refs.holdHint.textContent = 'HOLD TO REVEAL';
  }

  function beginHold(event) {
    if (!found || !refs.secretPanel || refs.secretPanel.classList.contains('is-revealed')) return;
    if (event) event.preventDefault();
    holding = true;
    clearTimeout(holdTimer);
    clearTimeout(holdRevealTimer);
    refs.secretPanel.classList.add('is-holding');
    refs.holdHint.textContent = 'REVEALING…';
    vibrate(8);
    holdTimer = setTimeout(function () {
      if (!holding) return;
      revealing = true;
      refs.secretPanel.classList.add('is-revealed');
      refs.vaultShell.classList.add('is-revealed');
      refs.secretPanel.setAttribute('aria-pressed', 'true');
      refs.secretPanel.setAttribute(
        'aria-label',
        found && found.chain === 'evm'
          ? 'Private key revealed. Release to hide.'
          : 'Secret key revealed. Release to hide.'
      );
      refs.secretValue.setAttribute('aria-hidden', 'false');
      if (!refs.phantomBlock.hidden) refs.phantomValue.setAttribute('aria-hidden', 'false');
      refs.holdHint.textContent = 'RELEASE TO HIDE';
    }, 360);
  }

  function endHold() {
    var wasRevealed = revealing;
    holding = false;
    revealing = false;
    clearTimeout(holdTimer);
    clearTimeout(holdRevealTimer);
    if (!refs.secretPanel) return;
    refs.secretPanel.classList.remove('is-holding', 'is-revealed');
    refs.vaultShell.classList.remove('is-revealed');
    refs.secretPanel.setAttribute('aria-pressed', 'false');
    refs.secretPanel.setAttribute(
      'aria-label',
      found && found.chain === 'evm' ? 'Hold to reveal private key' : 'Hold to reveal secret key'
    );
    refs.secretValue.setAttribute('aria-hidden', 'true');
    if (!refs.phantomBlock.hidden) refs.phantomValue.setAttribute('aria-hidden', 'true');
    refs.holdHint.textContent = 'HOLD TO REVEAL';
    if (wasRevealed) vibrate(4);
  }

  function downloadBackup() {
    if (!found) return;
    var isEvm = found.chain === 'evm';
    var now = new Date();
    var pattern = run ? run.profile : buildProfile();
    var state = pattern.state;
    var lines = [];

    lines.push('POSH / FORGE: LOCAL WALLET BACKUP');
    lines.push('Generated: ' + now.toISOString());
    lines.push('Engine: ' + (isEvm ? 'EVM (Ethereum, BNB Chain, Polygon, Base)' : 'Solana (Ed25519)'));
    lines.push('Address: ' + found.address);
    lines.push('Address format: ' + (isEvm ? 'EIP-55 checksummed' : 'Base58 public key'));
    lines.push('Pattern: ' + (state.leading || 0) + ' leading pad · ' + (state.pre || 0) + ' pre-suffix pad · suffix "' + (state.suffix || '') + '"');
    lines.push('Match mode: ' + (isEvm
      ? (state.strict ? 'EIP-55 strict case-sensitive' : 'Hex case-insensitive')
      : (state.ignoreCase ? 'Base58 case-insensitive' : 'Base58 exact case')));
    lines.push('Attempts: ' + formatCount(stats.attempts));
    lines.push('Search time: ' + formatDuration(stats.startedAt ? (stats.endedAt - stats.startedAt) / 1000 : 0));
    lines.push('');
    if (isEvm) {
      lines.push('PRIVATE KEY (HEX):');
      lines.push(found.privateKeyHex);
    } else {
      lines.push('SECRET KEY (BASE58, 64 BYTES):');
      lines.push(found.privateKeyBase58);
      lines.push('');
      lines.push('PHANTOM-COMPATIBLE SECRET KEY ARRAY (JSON, 64 BYTES):');
      lines.push(JSON.stringify(found.privateKeyArray));
      lines.push('');
      lines.push('PUBLIC KEY (HEX):');
      lines.push(found.publicKeyHex || '');
      lines.push('SEED (HEX):');
      lines.push(found.seedHex || '');
    }
    lines.push('');
    lines.push('SECURITY');
    lines.push('Anyone with this secret can control the wallet. Store this file offline,');
    lines.push('verify the address before funding, and never share the private key.');
    lines.push('This file was created entirely in your browser. No network request was made.');

    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    var short = found.address.slice(-6);
    anchor.href = url;
    anchor.download = 'posh-' + (isEvm ? 'evm' : 'solana') + '-' + short + '.txt';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('Backup file generated. Move it offline.');
  }

  function clearFound() {
    found = null;
    phase = 'idle';
    run = null;
    stats = freshStats();
    terminateWorkers();
    stopTicker();
    chartValues = [];
    lastChartAt = 0;
    if (refs.secretValue) refs.secretValue.textContent = '';
    if (refs.phantomValue) refs.phantomValue.textContent = '';
    if (refs.vaultAddress) refs.vaultAddress.textContent = '';
    refreshMiddleSamples();
    resetTelemetry();
    renderAll();
  }

  function newPatternFromVault() {
    closeVault(false);
    clearFound();
    toast('Vault cleared. Pattern retained.');
    setTimeout(function () {
      if (refs.builder) {
        refs.builder.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start'
        });
      }
    }, 60);
  }

  

  function bindEvents() {
    var engineButtons = document.querySelectorAll('.engine-btn');
    for (var i = 0; i < engineButtons.length; i += 1) {
      engineButtons[i].addEventListener('click', function () {
        setEngine(this.dataset.engine);
      });
    }

    refs.leadRange.addEventListener('input', function () { setLeading(this.value); });
    refs.preRange.addEventListener('input', function () { setPre(this.value); });
    refs.leadMinus.addEventListener('click', function () { setLeading(currentState().leading - 1); });
    refs.leadPlus.addEventListener('click', function () { setLeading(currentState().leading + 1); });
    refs.preMinus.addEventListener('click', function () { setPre(currentState().pre - 1); });
    refs.prePlus.addEventListener('click', function () { setPre(currentState().pre + 1); });

    refs.suffixInput.addEventListener('input', function () {
      setSuffix(this.value);
    });

    refs.suffixInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        startEngine();
      }
    });

    refs.caseToggle.addEventListener('change', function () {
      onCaseToggle(this.checked);
    });

    refs.presetList.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-word]');
      if (!button || button.disabled) return;
      applyWord(button.dataset.word);
    });

    refs.suggestList.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-suggestion]');
      if (!button || button.disabled) return;
      applyWord(button.dataset.suggestion);
    });

    refs.resetBtn.addEventListener('click', function () {
      if (isLocked()) return;
      patterns[engine] = engine === 'evm'
        ? { leading: 1, pre: 0, suffix: 'ACE', strict: false }
        : { leading: 0, pre: 0, suffix: 'ACE', ignoreCase: false };
      retireStopState();
      phase = 'idle';
      resetTelemetry();
      hideBase58Tip();
      renderAll();
      toast('Pattern reset.');
    });

    refs.startBtn.addEventListener('click', startEngine);
    refs.themeToggle.addEventListener('click', toggleTheme);

    refs.soundToggle.addEventListener('click', function () {
      setSound(!soundOn, true);
    });

    refs.base58TipClose.addEventListener('click', hideBase58Tip);

    refs.vaultClose.addEventListener('click', function () { closeVault(); });
    refs.copyAddressBtn.addEventListener('click', function () {
      if (found) copyText(found.address, 'Address copied.');
    });
    refs.copySecretBtn.addEventListener('click', function () {
      if (!found) return;
      var text = found.chain === 'evm' ? found.privateKeyHex : found.privateKeyBase58;
      copyText(text, 'Private key copied. Clear your clipboard after use.');
    });
    refs.phantomCopyBtn.addEventListener('click', function () {
      if (!found || found.chain !== 'sol') return;
      copyText(JSON.stringify(found.privateKeyArray), 'Phantom-compatible array copied.');
    });
    refs.downloadBtn.addEventListener('click', downloadBackup);
    refs.newSearchBtn.addEventListener('click', newPatternFromVault);

    refs.secretPanel.addEventListener('pointerdown', beginHold);
    refs.secretPanel.addEventListener('pointerup', endHold);
    refs.secretPanel.addEventListener('pointercancel', endHold);
    refs.secretPanel.addEventListener('pointerleave', function () {
      if (holding) endHold();
    });
    refs.secretPanel.addEventListener('keydown', function (event) {
      if (event.key === ' ' || event.key === 'Enter') {
        if (event.repeat) return;
        event.preventDefault();
        beginHold(event);
      }
    });
    refs.secretPanel.addEventListener('keyup', function (event) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        endHold();
      }
    });
    refs.secretPanel.addEventListener('blur', endHold);
    window.addEventListener('pointerup', endHold);
    window.addEventListener('keyup', function (event) {
      if (event.key === ' ' || event.key === 'Enter') endHold();
    });

    refs.vaultDialog.addEventListener('cancel', function () {
      document.documentElement.classList.remove('modal-open');
      endHold();
    });
    refs.vaultDialog.addEventListener('close', function () {
      document.documentElement.classList.remove('modal-open');
      endHold();
    });
    refs.vaultDialog.addEventListener('click', function (event) {
      if (event.target === refs.vaultDialog) closeVault();
    });

    document.addEventListener('keydown', function (event) {
      if (refs.vaultDialog.open) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        if (phase === 'running') stopEngine();
        else if (phase === 'found') openVault();
        else startEngine();
      }
    });

    window.addEventListener('online', updateNetworkUI);
    window.addEventListener('offline', updateNetworkUI);
    window.addEventListener('beforeunload', function () {
      terminateWorkers();
      if (workerURL) URL.revokeObjectURL(workerURL);
    });
  }

  

  function cacheRefs() {
    [
      'themeColorMeta', 'networkBadge', 'netBadgeText', 'heroNetwork', 'shieldBlock', 'shieldStatus',
      'shieldCopy', 'soundToggle', 'themeToggle', 'threadMeta', 'threadPill', 'footerThreads',
      'builder', 'engineContext', 'engineChains', 'engineAlgo', 'leadRange', 'leadMinus', 'leadPlus',
      'leadValue', 'leadMaxLabel', 'leadScale', 'leadFoot', 'leadCapNote', 'leadBlock', 'leadLabel', 'leadHint',
      'preRange', 'preMinus', 'prePlus', 'preValue', 'preMaxLabel', 'preScale', 'preFoot', 'preCapNote',
      'preBlock', 'preLabel', 'preHint', 'suffixInput', 'suffixField', 'suffixCount', 'suffixAvail',
      'suffixHint', 'suffixEngineTag', 'charStrip', 'validationStatus', 'validationDetail', 'base58Tip',
      'base58TipCopy', 'base58TipClose', 'presetLabel', 'presetList', 'suggestPanel', 'suggestCopy',
      'suggestList', 'caseRow', 'caseToggle', 'caseLabel', 'caseHint', 'caseFactor', 'formulaOut',
      'meanOut', 'capBadge', 'capLeft', 'resetBtn', 'previewAddress', 'previewStatus', 'previewSub',
      'previewNote', 'previewBadge', 'previewChains', 'lockReadout', 'lockMeter', 'profileMean',
      'profileFormula', 'profileMode', 'profileEngine', 'startBtn', 'startLabel', 'startSub', 'startIcon',
      'startHint', 'engineStatus', 'engineStatusText', 'speedValue', 'speedSub', 'speedPeak',
      'sparkPath', 'sparkDot', 'attemptsValue', 'elapsedValue', 'attemptsSub', 'attemptsWorkers',
      'probValue', 'probBar', 'probTrack', 'probTag', 'etaValue', 'etaSub', 'etaTag', 'etaExpected',
      'etaRate', 'terminalCmd', 'termSession', 'termWorkers', 'toastStack', 'vaultDialog', 'vaultShell',
      'vaultClose', 'vaultElapsed', 'vaultTitle', 'vaultAddress', 'vaultChainBadge', 'vaultAttempts',
      'vaultTime', 'vaultSpeed', 'vaultProbability', 'copyAddressBtn', 'secretLabel', 'secretValue',
      'secretPanel', 'secretCover', 'holdHint', 'copySecretBtn', 'phantomCopyBtn', 'downloadBtn',
      'phantomBlock', 'phantomValue', 'newSearchBtn', 'previewPanel'
    ].forEach(function (id) {
      refs[id] = $(id);
    });
  }

  function init() {
    cacheRefs();
    installNetworkMonitor();
    isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    threads = getThreadCount();
    netState.count = 0;

    applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    setSound(readPref('posh.sound', 'on') !== 'off', false);

    if (isMac) {
      var firstKey = document.querySelector('.shortcut-hint kbd');
      if (firstKey) firstKey.textContent = '⌘';
      var shortcut = document.querySelector('.shortcut-hint');
      if (shortcut) shortcut.setAttribute('aria-label', 'Keyboard shortcut Command plus Enter');
    }

    refs.threadMeta.textContent = threads + ' AVAILABLE';
    refs.threadPill.textContent = threads + ' THREADS';
    refs.footerThreads.textContent = String(threads);
    refs.termWorkers.textContent = '0 WORKERS';

    refreshMiddleSamples();
    bindEvents();
    updateNetworkUI();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
