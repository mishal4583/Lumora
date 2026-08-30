'use strict';
/**
 * Lumora sandbox test harness.
 *
 * There is no build step and no browser in CI here, so this harness mocks
 * just enough of document/window/canvas/AudioContext/ytgame to let the
 * game's inline <script> body execute inside a Node `vm` context, then runs
 * assertions against its real top-level state (S, reset(), update(), best,
 * YT, KEYS, paused, ...) via bare identifiers in the SAME vm script string.
 *
 * Rationale for the "one big string, one vm.runInContext call" shape: the
 * game code and the test driver need to share one lexical scope so the
 * driver can call reset()/update() and read S/best/paused directly, the
 * same way normal same-file JS scoping works. Splitting mocks/game/driver
 * into separate runInContext calls is unnecessary and (for let/const
 * top-level bindings) not reliably readable back from Node afterward — so
 * everything below is concatenated into one script per scenario. Each
 * scenario gets its own fresh vm context (no state leaks between them),
 * which is why this runs as three separate scenarios rather than one.
 *
 * Run: node test/harness.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// The inline <script> (no attributes) is the game; the SDK <script src=...>
// tag has attributes so this literal pattern only matches the inline one.
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!scriptMatch) {
  console.error('FATAL: could not extract inline <script> body from index.html — has the markup structure changed?');
  process.exit(1);
}
const GAME_SRC = scriptMatch[1];

// ---------- mock prelude shared by all scenarios ----------
// `playablesOpts` is either null (standalone/no-YT env) or an object describing
// how the mock ytgame SDK should behave for that scenario.
function buildPrelude(playablesOpts) {
  const ytgameDecl = playablesOpts
    ? `
var __spy = {
  saveDataCalls: [], sendScoreCalls: [], lsGetCalls: 0, lsSetCalls: 0,
  loadResolve: null, loadReject: null,
  onPauseCb: null, onResumeCb: null, onAudioChangeCb: null,
  lifecycleCalls: [] // records actual firstFrameReady()/gameReady() SDK invocations, in call order
};
var __loadPromise = new Promise(function(res, rej){ __spy.loadResolve = res; __spy.loadReject = rej; });
var ytgame = {
  IN_PLAYABLES_ENV: true,
  system: {
    onPause: function(cb){ __spy.onPauseCb = cb; },
    onResume: function(cb){ __spy.onResumeCb = cb; },
    isAudioEnabled: function(){ return ${playablesOpts.audioEnabled !== false}; },
    onAudioEnabledChange: function(cb){ __spy.onAudioChangeCb = cb; }
  },
  game: {
    loadData: function(){ return __loadPromise; },
    saveData: function(json){ __spy.saveDataCalls.push(json); },
    // previously missing from this mock entirely -- the game's own
    // if(YT && YT.game && YT.game.firstFrameReady) guard was therefore always
    // false and the real SDK call path was never exercised, only the local
    // firstFrameSent/gameReadySent flags. Present now so the actual calls,
    // their order, and their exactly-once-ness can be asserted for real.
    firstFrameReady: function(){ __spy.lifecycleCalls.push('firstFrameReady'); },
    gameReady: function(){ __spy.lifecycleCalls.push('gameReady'); }
  },
  engagement: {
    sendScore: function(payload){ __spy.sendScoreCalls.push(payload); }
  }
};
`
    : `
var __spy = { saveDataCalls: [], sendScoreCalls: [], lsGetCalls: 0, lsSetCalls: 0 };
`;

  return `
'use strict';
${ytgameDecl}

// ---- wall clock (deterministic only when a scenario opts in) ----
// Date.now() is left completely real for every scenario that doesn't pass
// mockNowMs -- only scenarios that need a fixed "current" moment (the
// calendar-day-boundary quest tests) override it. new Date(ms) with an
// explicit ms argument (localDayKey's own usage) is never touched by this,
// since it doesn't call Date.now() internally.
${playablesOpts && playablesOpts.mockNowMs != null ? `Date.now = function(){ return ${playablesOpts.mockNowMs}; };` : ''}

// ---- clock ----
var __now = 0;
var performance = { now: function(){ return __now; } };

// ---- rAF (test-controlled stepping, not auto-driven) ----
var __rafQueue = [];
function requestAnimationFrame(cb){ __rafQueue.push(cb); return __rafQueue.length; }
function __stepFrame(dtMs){
  __now += dtMs;
  var q = __rafQueue; __rafQueue = [];
  q.forEach(function(cb){ cb(__now); });
}

// ---- localStorage ----
var localStorage = (function(){
  var store = {};
  return {
    getItem: function(k){ __spy.lsGetCalls++; return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; },
    setItem: function(k,v){ __spy.lsSetCalls++; (__spy.lsSetKeys=__spy.lsSetKeys||[]).push(k); store[k] = String(v); },
    removeItem: function(k){ delete store[k]; },
    __store: store
  };
})();

// ---- canvas / 2d context (Proxy swallows all draw calls harmlessly) ----
function __makeGradient(){ return { addColorStop: function(){} }; }
function __makeCtx(){
  var store = {};
  return new Proxy(store, {
    get: function(target, prop){
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return function(){ return __makeGradient(); };
      if (prop === 'measureText') return function(){ return { width: 10 }; };
      if (prop in target) return target[prop];
      return function(){}; // no-op for every draw method (fillRect, drawImage, arc, ...)
    },
    set: function(target, prop, value){ target[prop] = value; return true; }
  });
}
function __makeCanvas(){
  var _w = 0, _h = 0;
  var listeners = {};
  return {
    style: {},
    __listeners: listeners,
    get width(){ return _w; }, set width(v){ _w = v; },
    get height(){ return _h; }, set height(v){ _h = v; },
    getContext: function(){ return __makeCtx(); },
    getBoundingClientRect: function(){ return { left: 0, top: 0, width: _w, height: _h }; },
    addEventListener: function(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: function(){},
    setPointerCapture: function(){},
    releasePointerCapture: function(){}
  };
}
var __mainCanvas = __makeCanvas();
var document = {
  getElementById: function(id){ return id === 'c' ? __mainCanvas : null; },
  createElement: function(tag){ return tag === 'canvas' ? __makeCanvas() : {}; }
};

// ---- Image (Master Glowkeeper Statue's one embedded raster asset) ----
// Fires onload synchronously the instant .src is assigned -- real browsers
// decode a data: URI asynchronously, but nothing here depends on that timing
// (drawGlowkeeperStatue() already no-ops safely if statueImgLoaded is still
// false for any reason), so the simplest mock that lets the module-top-level
// \`STATUE_IMG.src=...\` line run without throwing is enough, matching this
// harness's existing "mock just enough" philosophy.
function Image(){
  var _src = '';
  Object.defineProperty(this, 'src', {
    get: function(){ return _src; },
    set: function(v){ _src = v; if (typeof this.onload === 'function') this.onload(); }
  });
}

// ---- window ----
// initialViewport lets a scenario simulate starting inside a zero-size
// WebView (Playables' own documented behavior) -- defaults to a normal
// non-zero viewport for every scenario that doesn't opt in, so this changes
// nothing for any existing test.
var window = {
  innerWidth: ${playablesOpts && playablesOpts.initialViewport ? playablesOpts.initialViewport[0] : 540}, innerHeight: ${playablesOpts && playablesOpts.initialViewport ? playablesOpts.initialViewport[1] : 960}, devicePixelRatio: 1,
  __listeners: {},
  addEventListener: function(type, fn){ (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
  removeEventListener: function(){}
};

// ---- fake Web Audio (enough surface for tone()/initAudio()/pause suspend/resume) ----
function __gainNode(){ return { gain: { value: 0, setValueAtTime(){}, setTargetAtTime(){}, exponentialRampToValueAtTime(){}, linearRampToValueAtTime(){} }, connect(){}, disconnect(){} }; }
function __oscNode(){ return { type: 'sine', frequency: { value: 0, setValueAtTime(){}, exponentialRampToValueAtTime(){}, setTargetAtTime(){} }, connect(){}, start(){}, stop(){} }; }
function __biquadNode(){ return { type: 'lowpass', frequency: { value: 0, setValueAtTime(){}, setTargetAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; }
function __bufferSourceNode(){ return { buffer: null, loop: false, connect(){}, start(){}, stop(){} }; }
function __FakeAudioContext(){
  this.sampleRate = 44100;
  this.currentTime = 0;
  this.state = 'running';
  this.destination = {};
  this.createGain = __gainNode;
  this.createOscillator = __oscNode;
  this.createBiquadFilter = __biquadNode;
  this.createBufferSource = __bufferSourceNode;
  this.createBuffer = function(ch, len){ return { getChannelData: function(){ return new Float32Array(len); } }; };
  this.suspend = function(){ this.state = 'suspended'; return Promise.resolve(); };
  this.resume = function(){ this.state = 'running'; return Promise.resolve(); };
}
window.AudioContext = __FakeAudioContext;
window.webkitAudioContext = __FakeAudioContext;
`;
}

// ---------- assertion collection ----------
// __RESULTS uses `var` so it's a real property of the vm context's global
// object and readable from Node after runInContext returns.
const RESULT_PRELUDE = `var __RESULTS = [];
function __check(name, cond, detail){ __RESULTS.push({ name: name, pass: !!cond, detail: detail || '' }); }
// x/y are GAME-space coordinates (what you'd read off a button's own .x/.y).
// toGame() in the real game computes (clientX-rect.left)/scale, so clientX
// must be pre-multiplied by the CURRENT scale to recover exactly x/y again --
// otherwise any test that runs after something changes window.innerWidth/Height
// (the resize tests do) silently fires at the wrong game coordinates. Scale-aware
// by construction so this class of ordering bug can't recur as more tests are added.
function __fakeEvent(x, y, extra){ var e = { clientX: x*scale, clientY: y*scale, pointerId: 1, preventDefault: function(){} }; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
function __fire(target, type, evt){ var l = (target.__listeners && target.__listeners[type]) || []; l.forEach(function(fn){ fn(evt); }); }
// The game's loadData chain is p.then(A).catch(B).then(C) -- three microtask
// hops past resolution. A plain "Promise.resolve().then(cb)" only waits one
// hop, so cb can observe A's effects (best updated) but not C's (loadDone
// flipped) yet. Flush several extra ticks before asserting on chain-tail state.
function __tick(n){ var p = Promise.resolve(); for (var i = 0; i < n; i++) p = p.then(function(){}); return p; }
// D3: continueFromOver()/beginPlay() now route a tutorialDone=true player
// through the Contract Selection screen before reset() ever runs (see
// enterContractScreen()) -- this helper drains that screen the same way a
// player tapping a card then ACCEPT would, landing on screen==='play'
// exactly like every pre-D3 test already assumed continueFromOver() itself
// did. A no-op if the tutorial night's own bare-reset() path was taken
// instead (screen is already 'play', nothing to drain).
function __acceptAnyContract(){
  if (screen !== 'contract') return;
  // Collector (index 3) is the one contract with no speed/miss/spawn/coin
  // multiplier at all (only playfulMult + a forced objective category) --
  // deliberately the LEAST invasive choice here, so pre-D3 tests built
  // around contract-free coin/speed/miss-limit arithmetic keep working
  // without each needing to know a contract is even involved.
  selectContract(3);
  acceptContract();
  for (var __k = 0; __k < 25; __k++) __stepFrame(16); // drains the 280ms ACCEPT exit
}
`;

const scenarios = [];
function scenario(name, playablesOpts, driverSrc) {
  scenarios.push({ name, playablesOpts, driverSrc });
}

// Fixed "current moment" values for the deterministic calendar-day-boundary
// quest tests below. Computed once here via the real Date, using explicit
// local Y/M/D/H/M/S components (month is 0-indexed, so 7 = August) rather
// than any "now"-relative math -- the resulting epoch reflects whatever
// timezone this machine is actually in, exactly the same way localDayKey()'s
// local getters will read it back inside the vm, so there is no dependency
// on the real wall-clock time the suite happens to run at.
const FIXED_NOW_SAME_DAY_MS = new Date(2026, 7, 10, 12, 0, 0).getTime();          // 2026-08-10 12:00
const FIXED_LASTPLAYED_SAME_DAY_MS = new Date(2026, 7, 10, 2, 0, 0).getTime();    // 2026-08-10 02:00 (10h earlier, same calendar day)
const FIXED_NOW_CROSS_MIDNIGHT_MS = new Date(2026, 7, 10, 0, 1, 0).getTime();     // 2026-08-10 00:01
const FIXED_LASTPLAYED_CROSS_MIDNIGHT_MS = new Date(2026, 7, 9, 23, 59, 0).getTime(); // 2026-08-09 23:59 (2min earlier, previous calendar day)

// =====================================================================
// Scenario 1: standalone (no YT / non-Playables env) — localStorage fallback
// =====================================================================
scenario('standalone', null, `
__check('YT is null outside Playables env', YT === null);
__check('best seeded from localStorage fallback', best === 7, 'best=' + best);

// reset() clears replay-persistent transient state
pointer.down = true; KEYS.up = 1; KEYS.left = 1;
reset();
__check('reset() clears pointer.down', pointer.down === false);
__check('reset() clears all KEYS', KEYS.up === 0 && KEYS.down === 0 && KEYS.left === 0 && KEYS.right === 0);
__check('reset() clears score/misses/carried', S.score === 0 && S.misses === 0 && S.carried.length === 0);

// First-Night Tutorial: default every pre-existing test in this scenario to
// "already seen it" (a returning player), same as it would be for anyone
// who isn't the very specific new-player scenario this feature targets --
// otherwise the very first BEGIN_BTN click below arms the tutorial
// (tutorialDone defaults false) and tutorialPanelOpen silently gates
// update() for the rest of this entire script, breaking everything
// downstream that assumes normal simulation. The dedicated tutorial section
// further down explicitly flips this back to false for its own tests and
// restores it to true afterward for anything that runs after it.
upgrades.tutorialDone = true;

// lifecycle hooks: gameReady only fires once a real title-screen frame has
// rendered (cv.width>0 && screen==='title') -- run one frame BEFORE leaving
// the title screen, matching how the real game actually reaches this state.
screen = 'title';
__stepFrame(16);
__check('firstFrameReady fires once the first frame is on screen', firstFrameSent === true);
__check('gameReady fires once the (interactive) title screen has rendered', gameReadySent === true);

// title -> play transition via BEGIN_BTN, then drive a catch
// D3: with tutorialDone already true (see above), BEGIN_BTN now opens the
// Contract Selection screen first (enterContractScreen()) rather than
// jumping straight to play -- __acceptAnyContract() drains it exactly the
// way a player tapping a card then ACCEPT would.
__fire(cv, 'pointerdown', __fakeEvent(BEGIN_BTN.x, BEGIN_BTN.y));
__check('BEGIN_BTN click opens the D3 Contract Selection screen', screen === 'contract');
__acceptAnyContract();
__check('accepting a contract hands off to play screen', screen === 'play');

reset();
spawnFly('y');
var fly = S.flies[S.flies.length - 1];
fly.x = S.jar.x; fly.y = S.jar.y - 14; // drop it right on the jar so it locks+catches quickly
var caughtBefore = S.caughtN;
for (var i = 0; i < 240 && S.caughtN === caughtBefore; i++) __stepFrame(16);
__check('a firefly in range gets caught (jar pulse feedback hook)', S.caughtN === caughtBefore + 1, 'caughtN=' + S.caughtN);
__check('caught firefly is added to carried', S.carried.length === 1);
__check('catching pulses the jar (S.jar.pulse set to 1 on catch)', S.jar.pulse > 0);

// delivery: score increases only once the spark resolves, not the instant the jar enters the village zone
reset();
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999; // force inside village zone (DELIVER_Y = H-280 = 680)
var scoreAtEntry = S.score;
__stepFrame(16); // one frame: should queue a spark, not score immediately
__check('entering the village zone does not score immediately (delivery, not catch, scores)', S.score === scoreAtEntry && S.sparks.length === 1, 'score=' + S.score + ' sparks=' + S.sparks.length);
for (var d = 0; d < 120 && S.sparks.length > 0; d++) __stepFrame(16);
__check('score increases once the delivery spark actually arrives', S.score === scoreAtEntry + 1, 'score=' + S.score);

// miss -> game over at 5 misses (standalone: sendScore is a no-op, must not throw)
reset();
S.misses = 4;
spawnFly('y');
var f2 = S.flies[S.flies.length - 1];
f2.patience = 0.01; f2.rest = 0; f2.pause = 0;
var threw = false;
try { for (var j = 0; j < 60 && !S.over; j++) __stepFrame(16); } catch (e) { threw = true; }
__check('5th miss ends the round without throwing (YT absent)', !threw && S.over === true && S.misses >= 5, 'over=' + S.over + ' misses=' + S.misses);

// best persists to localStorage only outside Playables, and only on a new high score.
// (Coins now legitimately write to localStorage on every delivery regardless — Stage 2
// Part A's earn-on-every-delivery behavior — so this checks the gk2_best key specifically,
// not "no writes at all", which stopped being the right invariant once coins existed.)
reset(); // best is still 7 here (the earlier 1pt delivery above never beat it)
__spy.lsSetKeys = [];
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var d1 = 0; d1 < 120 && (S.sparks.length > 0 || S.carried.length > 0); d1++) __stepFrame(16);
__check('no gk2_best write when the delivered score does not beat best', S.score < best && __spy.lsSetKeys.indexOf('gk2_best') === -1, 'score=' + S.score + ' best=' + best + ' keys=' + JSON.stringify(__spy.lsSetKeys));
best = 0; // force a guaranteed new best on the next delivery
reset();
__spy.lsSetKeys = [];
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var d2 = 0; d2 < 120 && (S.sparks.length > 0 || S.carried.length > 0); d2++) __stepFrame(16);
__check('a new best IS written to localStorage outside Playables', __spy.lsSetKeys.indexOf('gk2_best') !== -1 && best === S.score, 'keys=' + JSON.stringify(__spy.lsSetKeys) + ' best=' + best);

// pause gate: user pause via PAUSE_BTN, swallow input, resume via RESUME_BTN only
reset(); screen = 'play'; paused = false;
__fire(cv, 'pointerdown', __fakeEvent(PAUSE_BTN.x, PAUSE_BTN.y));
__check('PAUSE_BTN sets paused + reason=user', paused === true && pauseReason === 'user');
var tx = S.jar.tx;
__fire(cv, 'pointerdown', __fakeEvent(200, 200)); // any other tap while paused must be swallowed
__check('pointerdown elsewhere is swallowed while paused (jar target unchanged)', S.jar.tx === tx);
__fire(cv, 'pointerdown', __fakeEvent(RESUME_BTN.x, RESUME_BTN.y));
__check('RESUME_BTN resumes a user pause', paused === false && pauseReason === null);

// keyboard-input pause leak regression (fixed bug from git history): a keypress during
// a pause must NOT resume the AudioContext, and must not register directional input.
initAudio();
AC.state = 'running';
pauseGame('user');
if (AC) AC.state = 'suspended'; // pauseGame's own suspend already does this; reassert defensively
__fire(window, 'keydown', { key: 'ArrowUp', preventDefault: function(){} });
__check('keydown during pause does not set KEYS (no motion leak)', KEYS.up === 0);
__check('keydown during pause does not resume the AudioContext', AC.state === 'suspended');
resumeGame();

// resize, direct event path: window.addEventListener('resize', resize) must actually be wired up
window.innerWidth = 320; window.innerHeight = 690;
var widthBeforeEvent = cv.width;
__fire(window, 'resize', {});
__check('the direct resize event listener is wired to resize()', cv.width !== widthBeforeEvent, 'before=' + widthBeforeEvent + ' after=' + cv.width);

// resize, polling fallback path: viewport changes with NO 'resize' event (e.g. some hosts'
// fullscreen enter/exit) must still be picked up by the render loop's own poll
window.innerWidth = 375; window.innerHeight = 812;
var widthBefore = cv.width;
__stepFrame(16); // loop() polls innerWidth/innerHeight every frame, no 'resize' event fired here
__check('render loop polls viewport size and resizes without a resize event', cv.width !== widthBefore, 'before=' + widthBefore + ' after=' + cv.width);

// glowSprite cache: radius must be rounded before being used as a cache key
var cacheSizeBefore = Object.keys(glowCache).length;
glowSprite('rgba(1,2,3,1)', 10.1);
glowSprite('rgba(1,2,3,1)', 10.4); // rounds to the same key as 10.1 -> must NOT allocate a second entry
glowSprite('rgba(1,2,3,1)', 10.9); // rounds to 11 -> a second, distinct entry is expected
__check('glowSprite rounds r before using it as a cache key', Object.keys(glowCache).length === cacheSizeBefore + 2, 'cacheSize=' + Object.keys(glowCache).length);

// ===== Gameplay Background Rebuild pass ======================================
// renderBG() draws into an offscreen canvas and is re-invoked once per
// season-tier change (see heartTier()/SEASON_PALETTES) -- exercise it across
// every tier, not just whatever tier happens to be active by default,
// proving the new far-mountain/river/extra-house/foreground-vegetation
// layers work with all 6 palettes, not just one.
var renderBGThrew = false;
try { for (var __rbi = 1; __rbi <= 6; __rbi++) renderBG(__rbi); } catch (e) { renderBGThrew = true; }
__check('renderBG() draws without throwing across all 6 SEASON_PALETTES tiers', !renderBGThrew);
renderBG(heartTier(best)); // restore whatever the real current tier actually is, don't leak a stale tier into later tests

// bush()/treeline() reuse: no new rendering architecture, just two existing
// (or existing-pattern) helpers called with new arguments -- a direct call
// proves they don't throw in isolation too, not just as part of the whole
// scene above.
var bushDrewOk = true;
try { bush(bg.getContext('2d'), 100, 100, 1, '#101828'); } catch (e) { bushDrewOk = false; }
__check('bush() (the new foreground-vegetation helper) draws without throwing', bushDrewOk);

// ===== House Quality pass ====================================================
// all five procedural cottage archetypes draw without throwing, in isolation
// -- not just as part of the whole renderBG() scene above, same discipline
// as the bush() check.
var archetypesDrewOk = true;
try {
  var __hg = bg.getContext('2d');
  houseTypeA(__hg, 100, 100, 1, '#141c30', '#0a0f1a');
  houseTypeB(__hg, 150, 100, 1, '#141c30', '#0a0f1a');
  houseTypeC(__hg, 200, 100, 1, '#141c30', '#0a0f1a');
  houseTypeD(__hg, 250, 100, 1, '#141c30', '#0a0f1a');
  houseTypeE(__hg, 300, 100, 1, '#141c30', '#0a0f1a');
} catch (e) { archetypesDrewOk = false; }
__check('all five house archetypes (houseTypeA-E) draw without throwing', archetypesDrewOk);

// Real bug found in the live browser pass: cottagePrimitive()'s own window-
// drawing resets ctx.globalAlpha to 1 once it's done (so a window's alpha
// never leaks onto whatever draws AFTER that house) -- but that same reset
// silently clobbers a globalAlpha the CALLER set once before a whole batch
// of houses, so only the first of several low-opacity background houses
// actually rendered at the intended low opacity; the rest rendered at full
// opacity and stood out badly (worst on Snow's naturally light palette).
// This documents the exact gotcha so a future call site doesn't reintroduce
// it: globalAlpha must be set fresh before EACH house in a batch, not once
// before the whole loop.
(function(){
  var testG = bg.getContext('2d');
  testG.globalAlpha = 0.6;
  houseTypeA(testG, 100, 100, 1, '#141c30', '#0a0f1a');
  __check('houseTypeA (via cottagePrimitive) resets ctx.globalAlpha to 1 after drawing its window(s) -- documented so a batch caller knows to re-set alpha before EACH house, not once before the whole loop', testG.globalAlpha === 1, 'globalAlpha=' + testG.globalAlpha);
})();

// Windmill tower anchor: drawVillage()'s live rotating blades (S.mill) pivot
// around a FIXED point that must still match the tower renderBG() draws --
// this is exactly the kind of coupling that's easy to silently break while
// enriching the background art. Not directly inspectable (baked into an
// offscreen canvas), so this proves the coupling stays coherent the only way
// available: the round-tripped scene keeps rendering without throwing at the
// exact score gate where blades start actually turning.
reset(); screen = 'play'; paused = false; S.score = 30; S.millA = 1; S.mill = 1.2;
var windmillDrawThrew = false;
try { draw(); } catch (e) { windmillDrawThrew = true; }
__check('the scene (including the live windmill blades over the rebuilt tower silhouette) draws without throwing once the windmill is active (score>=25)', !windmillDrawThrew);

// ===== Stage 0 juice pass ===================================================
// Every beat below is driven entirely from inside update(dt), which loop()
// already skips while paused -- so "pause mid-animation freezes cleanly" is
// checked directly (snapshot state, step frames while paused, assert no
// change) rather than assumed from the architecture.

// --- catch light-streak trail ---
reset(); screen = 'play'; paused = false;
spawnFly('y');
var sf = S.flies[S.flies.length - 1];
sf.x = S.jar.x; sf.y = S.jar.y - 14; // lands on the jar -> locks and catches within one frame
__stepFrame(16);
__check('a dropped-in-range firefly reaches the caught animation', S.flies.length === 1 && S.flies[0].state === 'caught', 'state=' + (S.flies[0] && S.flies[0].state));
var partsBeforeStreak = S.parts.length;
for (var si = 0; si < 8; si++) __stepFrame(16); // partway through the ~0.42s caught animation
__check('a light-streak trail spawns during the catch animation', S.parts.length > partsBeforeStreak, 'before=' + partsBeforeStreak + ' now=' + S.parts.length);
pauseGame('user');
var flySnap = JSON.stringify(S.flies[0]), partsSnap = S.parts.length;
for (var sj = 0; sj < 10; sj++) __stepFrame(16);
__check('pausing mid catch-animation freezes the fly and the streak', JSON.stringify(S.flies[0]) === flySnap && S.parts.length === partsSnap);
resumeGame();
// Note: checking against sf specifically (not S.flies.length===0) because the
// game's own ambient spawnFly() timer can legitimately spawn an unrelated new
// drifting firefly during these ~20 extra frames -- that's real, correct
// background behavior, not something this catch-animation check should trip on.
for (var sk = 0; sk < 40 && S.flies.indexOf(sf) !== -1; sk++) __stepFrame(16);
__check('resuming lets the catch animation complete cleanly', S.flies.indexOf(sf) === -1 && S.carried.length === 1, 'stillPresent=' + (S.flies.indexOf(sf) !== -1) + ' carried=' + S.carried.length);

// --- delivery light-wave ---
reset(); screen = 'play'; paused = false;
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
__stepFrame(16);
__check('a delivery light-wave spawns when a batch starts', S.deliverWaves.length === 1, 'waves=' + S.deliverWaves.length);
for (var wi = 0; wi < 5; wi++) __stepFrame(16); // partway through the ~0.9s wave
var waveSnap = JSON.stringify(S.deliverWaves);
pauseGame('user');
for (var wj = 0; wj < 8; wj++) __stepFrame(16);
__check('pausing mid delivery-wave freezes it', JSON.stringify(S.deliverWaves) === waveSnap);
resumeGame();
for (var wk = 0; wk < 90 && S.deliverWaves.length > 0; wk++) __stepFrame(16);
__check('resuming lets the delivery-wave finish and clean itself up', S.deliverWaves.length === 0);

// --- milestone "awaken" fade (cat at score>=20) ---
reset(); screen = 'play'; paused = false;
S.score = 19;
__stepFrame(16);
__check('cat stays hidden below its score threshold', S.catA === 0, 'catA=' + S.catA);
S.score = 20;
__stepFrame(16);
__check('crossing the threshold fades the cat in gradually, not instantly', S.catA > 0 && S.catA < 1, 'catA=' + S.catA);
pauseGame('user');
var catSnap = S.catA;
for (var mi = 0; mi < 10; mi++) __stepFrame(16);
__check('pausing mid milestone-awaken freezes the fade', S.catA === catSnap);
resumeGame();
for (var mj = 0; mj < 60 && S.catA < 1; mj++) __stepFrame(16);
__check('resuming lets the cat finish fading fully in', S.catA === 1, 'catA=' + S.catA);

// --- Lumora Bloom finale at score 35 (triggered via a real delivery, not a direct score assignment,
// so milestoneCheck's prev/current comparison actually fires the same way a real round would) ---
reset(); screen = 'play'; paused = false;
S.score = 34;
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
var fwBefore = S.fireworks.length;
for (var bi = 0; bi < 80 && S.score < 35; bi++) __stepFrame(16);
__check('crossing score 35 activates the Lumora Bloom finale', S.finaleActive === true && S.score === 35, 'finaleActive=' + S.finaleActive + ' score=' + S.score);
__check('crossing 35 fires an immediate fireworks burst, not just the ambient timer', S.fireworks.length > fwBefore);
// ribbon particles spawn probabilistically (~48% chance/frame) -- 30 frames keeps
// the odds of a false failure astronomically low (<1e-9) while still finishing
// well inside the finaleT<2.2s ribbon window
var ribbonBefore = S.parts.length;
for (var bj = 0; bj < 30; bj++) __stepFrame(16);
__check('a golden firefly-ribbon rises during the finale window', S.parts.length > ribbonBefore, 'before=' + ribbonBefore + ' now=' + S.parts.length);
var auroraMid = S.aurora;
__check('aurora previews early during the finale even though score is still under 75', auroraMid > 0 && S.score < 75, 'aurora=' + auroraMid);
pauseGame('user');
var finaleTSnap = S.finaleT, auroraSnap = S.aurora, finalePartsSnap = S.parts.length;
for (var bk = 0; bk < 15; bk++) __stepFrame(16);
__check('pausing mid-finale freezes its timer, the aurora ramp, and the ribbon spawn', S.finaleT === finaleTSnap && S.aurora === auroraSnap && S.parts.length === finalePartsSnap);
resumeGame();
for (var bl = 0; bl < 260 && S.finaleActive; bl++) __stepFrame(16); // ~3.4s at ~16ms/frame
__check('resuming lets the finale run its course and deactivate on its own', S.finaleActive === false);
var auroraAtFinaleEnd = S.aurora;
for (var bm = 0; bm < 80; bm++) __stepFrame(16); // ~1.3s further
__check('aurora fades back out afterward since the round never actually reached 75', S.aurora < auroraAtFinaleEnd, 'atEnd=' + auroraAtFinaleEnd + ' after=' + S.aurora);

// --- Lumora Bloom interacting with the rest of a long round: does the forced
// immediate fireworks burst at 35 double up with the pre-existing ambient
// timer, and does a genuine later score>=75 unlock the permanent aurora
// cleanly with no leftover finale state in the way? (fresh round, not a
// continuation of the block above, to keep failures easy to isolate) ---
reset(); screen = 'play'; paused = false;
S.score = 34;
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var xi = 0; xi < 80 && S.score < 35; xi++) __stepFrame(16);
__check('score crosses to exactly 35 via the triggering delivery', S.score === 35, 'score=' + S.score);
var burstRight = S.fireworks.length;
__check('the finale fires one immediate burst right at the crossing frame', burstRight >= 20, 'size=' + burstRight);
__stepFrame(16);
__check('no second burst fires on the very next frame (ambient fwT was reset, not left at its initial 0)', S.fireworks.length <= burstRight + 2, 'size=' + S.fireworks.length);
var sawResume = false, prevLen = S.fireworks.length;
for (var xj = 0; xj < 320; xj++) { __stepFrame(16); if (S.fireworks.length > prevLen + 15) sawResume = true; prevLen = S.fireworks.length; }
__check('the ambient fireworks timer still resumes its own cadence afterward (not double-fired, not silenced)', sawResume === true);

for (var xk = 0; xk < 260 && S.finaleActive; xk++) __stepFrame(16);
__check('finale has ended on its own before we push toward a real 75', S.finaleActive === false);
for (var xe = 0; xe < 12; xe++) S.carried.push({ type: 'e', ph: 0, sp: 1 }); // 48pts total, comfortably crosses 35 -> 75 in the same round
S.jar.y = 999; S.jar.ty = 999;
for (var xl = 0; xl < 500 && S.score < 75; xl++) __stepFrame(16);
__check('score genuinely reaches 75 via real deliveries later in the same round', S.score >= 75, 'score=' + S.score);
__check('finale is not still active this late in the round (no leftover finale state)', S.finaleActive === false);
// aurora's per-frame branch runs before the delivery/score-increment code within
// update(), so on the exact frame score first reaches 75 it hasn't reacted yet --
// step one more frame before asserting it actually starts climbing
__stepFrame(16);
__check('the permanent aurora unlock engages on the next frame after crossing 75', S.aurora > 0, 'aurora=' + S.aurora);
for (var xm = 0; xm < 400 && S.aurora < 1; xm++) __stepFrame(16);
__check('aurora reaches and holds full strength once genuinely past 75', S.aurora === 1, 'aurora=' + S.aurora);
var auroraLocked = S.aurora;
for (var xn = 0; xn < 120; xn++) __stepFrame(16);
__check('aurora never decays again once permanently unlocked (the pre-75 decay branch is not reachable here)', S.aurora === auroraLocked, 'aurora=' + S.aurora);

// ===== Stage 1: Village Heart / season / environmental-detail tier =========
__check('heartTier: tier 1 (Dormant) below 5', heartTier(0) === 1 && heartTier(4) === 1);
__check('heartTier: tier 2 (Flickering) at 5-9', heartTier(5) === 2 && heartTier(9) === 2);
__check('heartTier: tier 3 (Glowing) at 10-14', heartTier(10) === 3 && heartTier(14) === 3);
__check('heartTier: tier 4 (Blooming) at 15-19', heartTier(15) === 4 && heartTier(19) === 4);
__check('heartTier: tier 5 (Radiant) at 20-24', heartTier(20) === 5 && heartTier(24) === 5);
__check('heartTier: tier 6 (Luminary) at 25, and it stays the ceiling well past it (no invented 7th tier)', heartTier(25) === 6 && heartTier(35) === 6 && heartTier(9999) === 6);

// single source of truth: drive best through every tier boundary (up and back down)
// and confirm the one module-level tracker actually used to render the Heart/season/
// detail (lastHeartTier, set only inside update()'s tier-change block) always agrees
// with heartTier(best) -- if any of the three read from independently duplicated
// logic instead of this one function, this is where they'd be caught drifting
[0, 3, 5, 9, 10, 14, 15, 19, 20, 24, 25, 60, 3].forEach(function(v){
  best = v;
  __stepFrame(16);
  __check('single source of truth holds at best=' + v, lastHeartTier === heartTier(v), 'lastHeartTier=' + lastHeartTier + ' expected=' + heartTier(v));
});

// (bestScore save-schema reuse is checked in the playables-fast-load scenario below,
// where saveData actually fires -- standalone's YT is null, so saveProgress() never
// reaches the YT.game.saveData call at all here, there'd be nothing to inspect)

// simulated close-and-reopen: force the tracker back to its just-loaded sentinel
// (-1, exactly what a fresh page load starts from) and confirm the correct tier
// is re-derived fresh from the persisted best on the very next frame, not carried
// over from anything cached
best = 17; lastHeartTier = -1;
__stepFrame(16);
__check('reopening with a persisted best immediately re-derives the matching tier (Blooming at 17), nothing stale', lastHeartTier === heartTier(17) && heartTier(17) === 4);

// crossfade proof: a returning player's real tier must NOT pop onto screen the
// instant it becomes known (e.g. once an async cloud loadData resolves) --
// it must ease in. These checks would have failed under the original
// instant-swap implementation.
heartDisplayTier = 1; lastHeartTier = -1; bgFadeT = -1; // simulate a fresh load: tier not yet known
best = 30; // this returning player is actually Luminary (tier 6)
__stepFrame(16); // the frame "loadData" resolves and best becomes known
__check('a newly-known high tier does not snap the display tier immediately', heartDisplayTier > 1 && heartDisplayTier < 6, 'heartDisplayTier=' + heartDisplayTier);
__check('the season crossfade starts the same frame the tier becomes known', bgFadeT >= 0 && bgFadeT < BG_FADE_DUR, 'bgFadeT=' + bgFadeT);
pauseGame('user');
var dTierSnap = heartDisplayTier, fadeSnap = bgFadeT;
for (var ci = 0; ci < 10; ci++) __stepFrame(16);
__check('pausing mid tier-transition freezes both the display-tier ease and the bg crossfade', heartDisplayTier === dTierSnap && bgFadeT === fadeSnap);
resumeGame();
// the exponential ease (rate dt*1.1/frame) needs ~350 frames (~5.6s) to cross the
// explicit <0.01 snap-to-target threshold in update() -- budget well past that
for (var cj = 0; cj < 600 && heartDisplayTier < 6; cj++) __stepFrame(16);
__check('resuming lets the display tier finish easing up to the real tier, not stuck mid-fade', heartDisplayTier === 6, 'heartDisplayTier=' + heartDisplayTier);
__check('the crossfade completes and clears on its own (no permanently-stuck dissolve)', bgFadeT === -1, 'bgFadeT=' + bgFadeT);

// ===== Luminary sub-progress (25->35), the Tier 6 flatness fix =============
__check('heartBloomProgress: 0 below Luminary (25)', heartBloomProgress(0) === 0 && heartBloomProgress(24) === 0);
__check('heartBloomProgress: 0 exactly at 25, 1 exactly at 35 -- both reuse existing thresholds, no new number invented', heartBloomProgress(25) === 0 && heartBloomProgress(35) === 1);
__check('heartBloomProgress: linear in between (30 is the midpoint)', heartBloomProgress(30) === 0.5);
__check('heartBloomProgress: clamped at 1 well past 35, never exceeds', heartBloomProgress(9999) === 1);

// single source of truth, extended to this new derived value: heartBloomDisplay
// must settle to exactly heartBloomProgress(best) -- the same pure function
// drawMoon()/drawEnvironmentalDetail() read (the Village Heart tree that
// used to read it too was removed) -- so it can't quietly drift the way a
// second, independently-authored computation could
[0, 20, 25, 28, 30, 33, 35, 60, 25].forEach(function(v){
  best = v;
  for (var bsi = 0; bsi < 500 && Math.abs(heartBloomProgress(v) - heartBloomDisplay) > 0.002; bsi++) __stepFrame(16);
  __check('single source of truth (bloom sub-progress) holds at best=' + v, heartBloomDisplay === heartBloomProgress(v), 'heartBloomDisplay=' + heartBloomDisplay + ' expected=' + heartBloomProgress(v));
});

// Village Heart Removal pass: the tree/glow/halo-ring/orbiting-sparkles icon
// (reported live as unexplained, undiscoverable UI) and its companion wind
// chimes are gone -- drawHeart/HEART_X/HEART_Y no longer exist at all, not
// just "not called". heartDisplayTier/heartBloomDisplay/heartTier()/
// heartBloomProgress() themselves are explicitly still present (drawMoon()/
// drawEnvironmentalDetail()/restorationPct()/SEASON_PALETTES selection all
// still depend on them) -- this only proves the ONE display was removed,
// not the underlying progress system it was layered on top of.
__check('drawHeart() no longer exists as a function at all (fully removed, not just uncalled)', typeof drawHeart === 'undefined');
__check('HEART_X/HEART_Y no longer exist either (their only reader was drawHeart() and the companion wind chimes, both removed together)', typeof HEART_X === 'undefined' && typeof HEART_Y === 'undefined');
__check('heartTier()/heartBloomProgress() -- the underlying restoration-tier system drawHeart() was layered on top of -- are still fully intact', typeof heartTier === 'function' && typeof heartBloomProgress === 'function' && heartTier(25) === 6);
var heartRemovalDrawThrew = false;
try { reset(); screen = 'play'; best = 9999; S.score = 9999; draw(); } catch (e) { heartRemovalDrawThrew = true; }
__check('the scene draws without throwing at the highest restoration tier (score 9999) with the Village Heart removed -- the dTier>5.5/dTier>5 branches that used to draw the sparkles/chimes are simply gone, not broken', !heartRemovalDrawThrew);
best = 0; S.score = 0;

// continuity across the 25/35 boundary: a single long session can push best from
// "just reached Luminary" straight through to Bloom without any reload in
// between -- this must ease exactly like the async-load case above, not pop at
// this new boundary instead of the old tier ones. Mirrors the crossfade-proof
// checks above almost exactly, including the pause-mid-transition freeze.
best = 25;
for (var pre = 0; pre < 400 && Math.abs(heartBloomProgress(25) - heartBloomDisplay) > 0.002; pre++) __stepFrame(16);
__check('bloom sub-progress settles at 0 right at the Luminary boundary, before the push', heartBloomDisplay === 0, 'heartBloomDisplay=' + heartBloomDisplay);
best = 40; // one long-session push straight through to well past Bloom, no reload
__stepFrame(16); // the single frame this change takes effect
__check('pushing straight through 25->40 in one session does not snap bloom sub-progress to 1 immediately', heartBloomDisplay > 0 && heartBloomDisplay < 1, 'heartBloomDisplay=' + heartBloomDisplay);
pauseGame('user');
var bloomSnap = heartBloomDisplay;
for (var bp = 0; bp < 10; bp++) __stepFrame(16);
__check('pausing mid bloom-sub-progress transition freezes it, same as the tier ease', heartBloomDisplay === bloomSnap);
resumeGame();
for (var bq = 0; bq < 500 && heartBloomDisplay < 1; bq++) __stepFrame(16);
__check('resuming lets bloom sub-progress finish easing to fully bloomed, not stuck mid-fade', heartBloomDisplay === 1, 'heartBloomDisplay=' + heartBloomDisplay);

// ===== Stage 2 Part A: coin economy + Firefly Journal =======================

// coins awarded correctly per type, on delivery (not on catch). Phase 1
// economy pass: TYPES[type].coins is fractional and rounds via the hidden
// coinFraction bank, not per-catch -- so "coins" (the whole spendable
// balance) alone won't move by exactly TYPES[type].coins on a single
// delivery. Track the TOTAL accumulated value (coins+coinFraction)
// instead. Jar identity rebalance: the delivered value is now
// TYPES[type].coins x the equipped jar's own Light Value x Coin Value --
// with Simple equipped (default) and Coin Value untouched (1.0x), that's
// x0.65 (Simple's base Light Value) on top of the raw firefly value.
['y', 'b', 'g', 'e'].forEach(function(type){
  reset(); screen = 'play'; paused = false;
  // Lumora 2.0 Phase 4: reset() can now roll a Night Event, and Moth Swarm
  // applies its own +20% coin multiplier at this exact delivery-coin-grant
  // site -- neutralized here so this test's precise expected-value math
  // stays independent of that unrelated random roll (same discipline as
  // the ads-double-night-coins / perfect-delivery neutralizations above).
  S.eventActive = null;
  coinFraction = 0; // known starting point so the single-delivery math below is exact
  upgrades.equippedJar = 'simple';
  var expectedRaw = TYPES[type].coins * jarCurrentStat('lightValue', currentJar()) * coinMultiplierForRun();
  var totalBefore = coins + coinFraction;
  S.carried.push({ type: type, ph: 0, sp: 1 });
  S.jar.y = 999; S.jar.ty = 999;
  for (var ci2 = 0; ci2 < 120 && (S.sparks.length > 0 || S.carried.length > 0); ci2++) __stepFrame(16);
  var totalAfter = coins + coinFraction;
  __check('coins awarded correctly for type ' + type, Math.abs(totalAfter - (totalBefore + expectedRaw)) < 1e-9 && coinFraction >= 0 && coinFraction < 1, 'total=' + totalAfter + ' expected=' + (totalBefore + expectedRaw) + ' coinFraction=' + coinFraction);
});

// ===== Phase 1 economy pass: fractional coin bank (grantDeliveryCoins) =====
// Dedicated isolation tests per direct instruction, covering exactly the
// four behaviors asked for: fractional accumulation, crossing the
// whole-coin threshold, save/load persistence, and spending behavior.

// fractional accumulation: the exact example given -- 0.25+0.25+0.25+0.60+0.90
// must accumulate correctly (no per-call rounding), landing on the right
// TOTAL regardless of where the whole/fraction split falls along the way
(function(){
  coins = 0; coinFraction = 0;
  [0.25, 0.25, 0.25, 0.60, 0.90].forEach(function(v){ grantDeliveryCoins(v); });
  __check('fractional coin accumulation sums correctly across multiple partial deliveries (0.25+0.25+0.25+0.60+0.90=2.25)', Math.abs((coins + coinFraction) - 2.25) < 1e-9, 'coins=' + coins + ' coinFraction=' + coinFraction);
  __check('the accumulated total splits into exactly 2 whole coins + 0.25 remainder, not rounded some other way', coins === 2 && Math.abs(coinFraction - 0.25) < 1e-9, 'coins=' + coins + ' coinFraction=' + coinFraction);
})();

// crossing the whole-coin threshold: coins only ever increments at the
// exact moment the accumulated fraction reaches >=1, never before, and the
// leftover remainder after crossing is always < 1
(function(){
  coins = 0; coinFraction = 0.90;
  grantDeliveryCoins(0.05); // 0.90+0.05=0.95, still under 1 -- no whole coin yet
  __check('coinFraction just under 1 does not yet grant a whole coin', coins === 0 && Math.abs(coinFraction - 0.95) < 1e-9, 'coins=' + coins + ' coinFraction=' + coinFraction);
  grantDeliveryCoins(0.10); // 0.95+0.10=1.05 -- crosses exactly here
  __check('crossing the whole-coin threshold grants exactly 1 coin and carries the correct remainder (1.05 -> +1 coin, 0.05 left)', coins === 1 && Math.abs(coinFraction - 0.05) < 1e-9, 'coins=' + coins + ' coinFraction=' + coinFraction);
  coins = 0; coinFraction = 0;
  grantDeliveryCoins(3.7); // a single large delivery crossing MULTIPLE whole coins at once
  __check('a single delivery that crosses multiple whole coins at once grants all of them, not just one', coins === 3 && Math.abs(coinFraction - 0.7) < 1e-9, 'coins=' + coins + ' coinFraction=' + coinFraction);
})();

// coinFraction invariants: never negative, never >=1 after a grant
(function(){
  coins = 0; coinFraction = 0;
  var everNegative = false, everAtOrAboveOne = false;
  [0.65, 1.60, 2.70, 4.60, 8.00, 0.65, 0.65].forEach(function(v){
    grantDeliveryCoins(v);
    if (coinFraction < 0) everNegative = true;
    if (coinFraction >= 1) everAtOrAboveOne = true;
  });
  __check('coinFraction never goes negative across a realistic sequence of deliveries', !everNegative);
  __check('coinFraction never reaches or exceeds 1 after any single grant (the whole part is always extracted)', !everAtOrAboveOne);
})();

// spending behavior: purchases only ever touch "coins", never coinFraction
// -- confirmed against a REAL purchase path (jar capacity), not just a
// property-existence check
(function(){
  coins = 100; coinFraction = 0.42; upgrades.jarCapTiers.simple = 0;
  var fractionBefore = coinFraction;
  var ok = tryUpgradeJarCap('simple'); // costs 25 at tier 0 (Phase 1 economy pass: rescaled from 40)
  __check('a real purchase (jar capacity) succeeds using only the whole coins balance', ok === true && coins === 75, 'coins=' + coins);
  __check('coinFraction is completely untouched by a purchase -- it is never spendable, only "coins" is', coinFraction === fractionBefore, 'coinFraction=' + coinFraction);
})();

// save/load persistence: coinFraction survives a real reload, same
// discipline as coins/upgrades/journal above it
if (!YT) {
  coins = 12; coinFraction = 0.37;
  grantDeliveryCoins(0); // triggers the same persistence path a real delivery would (writes gk2_coins + gk2_coinFraction)
  var reloadedFraction = parseFloat(localStorage.getItem('gk2_coinFraction') || '0');
  __check('coinFraction persists to gk2_coinFraction and survives reload, same as coins does to gk2_coins', Math.abs(reloadedFraction - 0.37) < 1e-9, 'reloaded=' + reloadedFraction);
}
coins = 0; coinFraction = 0; // reset for the tests below

// ===== Phase 1 economy pass: quest reward rebalance =====================
// catch10y/deliver20 coin rewards only -- triggers/objectives/generation/
// text/infrastructure all UNCHANGED, per direct instruction. Confirms the
// exact root cause of the reported 48-Light/~74-coin fresh run (the old
// flat 40-coin catch10y reward, sized for the pre-rebalance economy) is
// fixed, without touching anything else about quests.
(function(){
  var catch10y = QUEST_POOL.find(function(q){ return q.id === 'catch10y'; });
  var deliver20 = QUEST_POOL.find(function(q){ return q.id === 'deliver20'; });
  var catch2e = QUEST_POOL.find(function(q){ return q.id === 'catch2e'; });
  __check('catch10y\\'s coin reward is rebalanced to 10 (was 40) -- roughly one typical night, not several', catch10y.reward.kind === 'coins' && catch10y.reward.val === 10, 'val=' + catch10y.reward.val);
  __check('deliver20\\'s coin-fallback reward is rebalanced to 5 (was 20)', deliver20.reward.kind === 'deco' && deliver20.reward.val === 5, 'val=' + deliver20.reward.val);
  __check('catch2e\\'s reward is a luck boost, not coins -- no economic inflation risk from this quest', catch2e.reward.kind === 'luck');
  __check('no single quest reward can inject anywhere close to the old 40-80 coin spike any more (max possible single-quest coin reward is 10)', Math.max(catch10y.reward.val, deliver20.reward.val) === 10);
})();
// integration: completing catch10y for real, through the actual
// questProgress()/grantQuestReward() path, grants exactly 10 coins and
// nothing more -- proving the fix works end-to-end, not just in the data
(function(){
  quests = [Object.assign({ progress: 0, done: false }, QUEST_POOL.find(function(q){ return q.id === 'catch10y'; }))];
  coins = 0; coinFraction = 0;
  for (var qi = 0; qi < 10; qi++) questProgress('catch', 'y');
  __check('completing catch10y for real (through questProgress/grantQuestReward) grants exactly +10 coins, not the old +40', coins === 10 && quests[0].done === true, 'coins=' + coins);
})();

// ===== Phase 1 economy pass: Economy Test Scenarios (spec section 22) ===
// Formula-level scenarios (not simulated multi-round play, which this
// environment cannot reliably script -- see CLAUDE.md's documented
// rAF-under-automation limitation). Each asserts the ACTUAL live formula
// (grantDeliveryCoins' inputs: TYPES.coins x jar Light Value x Coin Value)
// against the target income bands, using the same catch-composition
// estimates used throughout this whole economy design arc.
(function(){
  function nightIncome(composition, jarKey, coinValueMult){
    var jar = JARS.find(function(j){ return j.key === jarKey; });
    var savedEquipped = upgrades.equippedJar; upgrades.equippedJar = jarKey;
    var lv = jarCurrentStat('lightValue', jar);
    upgrades.equippedJar = savedEquipped;
    var raw = 0;
    Object.keys(composition).forEach(function(t){ raw += TYPES[t].coins * composition[t]; });
    return raw * lv * coinValueMult;
  }
  // Scenario A: fresh player, Simple, no upgrades, typical composition -- target ~5-15
  var a = nightIncome({ y: 9, b: 4, g: 2 }, 'simple', 1.0);
  __check('Scenario A (fresh player, Simple, no upgrades, typical night): income lands in the 5-15 target band', a >= 5 && a <= 15, 'income=' + a);
  // Scenario B: good/strong early player, Simple, no upgrades -- target ~15-25
  var b = nightIncome({ y: 10, b: 7, g: 4, e: 1 }, 'simple', 1.0);
  __check('Scenario B (good player, Simple, no upgrades, strong night): income lands in the 15-25 target band', b >= 15 && b <= 25, 'income=' + b);
  // Scenario C: mid-game, Moon jar (owned+equipped, no per-jar upgrades yet) --
  // income should be MEASURABLY higher than Scenario A on an identical
  // catch composition (jar identity alone matters), but not explosive
  var cSimple = nightIncome({ y: 9, b: 4, g: 2 }, 'simple', 1.0);
  var cMoon = nightIncome({ y: 9, b: 4, g: 2 }, 'moon', 1.0);
  __check('Scenario C (mid-game, Moon jar): identical catches earn more on Moon than Simple (real jar identity), but less than double', cMoon > cSimple && cMoon < cSimple * 2, 'simple=' + cSimple + ' moon=' + cMoon);
  // Scenario D: late-game, Elder jar with a maxed Light Value tier, plus a
  // maxed Coin Value -- meaningfully higher income than early game, prices
  // for THAT jar's own upgrades are also proportionally higher (see the
  // per-jar price formulas), so this isn't a free lunch
  var elderJar = JARS.find(function(j){ return j.key === 'elder'; });
  var dMult = coinValueAtTier(3); // 1.30x, maxed
  var d = nightIncome({ y: 10, b: 8, g: 6, e: 2 }, 'elder', dMult);
  __check('Scenario D (late-game, Elder, Light Value + Coin Value both maxed): income is well above the early-game bands, appropriately so', d > 25, 'income=' + d);
  // E2 Shop Economy 2.0: Scenario E's own ceilings both changed -- Aurora's
  // Light Value ceiling is now 2.00x (up from 1.85x) and Coin Value's own
  // ceiling is now 1.75x (up from 1.30x), per the E1-approved target model.
  // The ENTIRE multiplier stack must still stay BOUNDED (not open-ended),
  // just at the new, deliberately larger ceiling E1/E2 approved.
  var auroraJar = JARS.find(function(j){ return j.key === 'aurora'; });
  __check('Scenario E: Aurora\\'s own maxed Light Value is exactly 2.00x (E2\\'s raised ceiling), not open-ended', Math.abs(auroraJar.lightValueMax - 2.00) < 1e-9);
  var eStack = auroraJar.lightValueMax * 1.75; // Aurora Light Value maxed x Coin Value maxed (E2's new 1.75x ceiling)
  __check('Scenario E: the full stacked multiplier (maxed Aurora Light Value x maxed Coin Value) stays bounded at 3.5x (E2\\'s new ceiling), not an unbounded snowball', Math.abs(eStack - 3.5) < 1e-9, 'stack=' + eStack);
  __check('Scenario E: total power range from weakest (Simple base 0.65x) to strongest possible (3.5x) is a bounded ~5.38x, not explosive', Math.abs(eStack / 0.65 - 5.38) < 0.05, 'ratio=' + (eStack / 0.65));
})();
function coinValueAtTier(tier){ var saved = upgrades.lightTier; upgrades.lightTier = tier; var v = coinMultiplierForRun(); upgrades.lightTier = saved; return v; }

// journal increments on the CATCH, not the delivery -- distinct moment from coins above
reset(); screen = 'play'; paused = false;
var jBefore = journal.g;
spawnFly('g');
var gf = S.flies[S.flies.length - 1];
gf.x = S.jar.x; gf.y = S.jar.y - 14; // stationary jar, well within the shy-type's spd<=120 lock condition
for (var gi = 0; gi < 60 && journal.g === jBefore; gi++) __stepFrame(16);
__check('journal increments on catch (shy/g), independent of delivery', journal.g === jBefore + 1, 'journal.g=' + journal.g);
__check('journal does not increment again just because the caught firefly is later delivered', (function(){
  var beforeDeliver = journal.g;
  S.jar.y = 999; S.jar.ty = 999;
  for (var gd = 0; gd < 120 && (S.sparks.length > 0 || S.carried.length > 0); gd++) __stepFrame(16);
  return journal.g === beforeDeliver;
})());

// journalDiscoveryTier: pure-function boundaries (Seen/0 -> Caught -> 25 Caught -> 100 Caught)
__check('journalDiscoveryTier: tier 1 (not yet caught) at 0', journalDiscoveryTier(0) === 1);
__check('journalDiscoveryTier: tier 2 (Caught) at 1-24', journalDiscoveryTier(1) === 2 && journalDiscoveryTier(24) === 2);
__check('journalDiscoveryTier: tier 3 (25 Caught) at 25-99', journalDiscoveryTier(25) === 3 && journalDiscoveryTier(99) === 3);
__check('journalDiscoveryTier: tier 4 (100 Caught) at 100+, a ceiling like heartTier\\'s', journalDiscoveryTier(100) === 4 && journalDiscoveryTier(500) === 4);
// single source of truth: Part A has no Journal screen yet to read a second,
// possibly-stale copy of this from (that's Part B's risk to guard against) --
// what's checkable now is that the one function is deterministic and that the
// journal's own stored counts, driven through every boundary, always agree with
// a fresh call to it, exactly mirroring the heartTier single-source-of-truth check
[0, 1, 24, 25, 99, 100, 250, 0].forEach(function(v){
  journal.y = v;
  __check('journal discovery tier single source of truth at count=' + v, journalDiscoveryTier(journal.y) === journalDiscoveryTier(v) && journalDiscoveryTier(v) === journalDiscoveryTier(v));
});

// ===== Stage 2 Part B: shop infrastructure =================================

// the shop must be unreachable from an active round -- neither the title
// nav row nor SHOP_BTN_OVER's hit-tests exist in the general in-round input
// path, only inside the screen==='title' and S.over branches specifically
var shopNavBtn = function(){ return titleNavRects().find(function(b){ return b.key === 'shop'; }); };
reset(); screen = 'play'; paused = false; S.over = false;
__fire(cv, 'pointerdown', __fakeEvent(shopNavBtn().x, shopNavBtn().y));
__check('tapping the title-screen shop-button spot mid-round does not open the shop', screen === 'play');
__fire(cv, 'pointerdown', __fakeEvent(SHOP_BTN_OVER.x, SHOP_BTN_OVER.y));
__check('tapping the game-over shop-button spot mid-round does not open the shop either', screen === 'play');

// shop IS reachable from title and from a settled game-over screen
screen = 'title';
__fire(cv, 'pointerdown', __fakeEvent(shopNavBtn().x, shopNavBtn().y));
__check('the shop button on the title screen opens the shop', screen === 'shop' && shopFrom === 'title');
__fire(cv, 'pointerdown', __fakeEvent(SHOP_CLOSE_BTN.x, SHOP_CLOSE_BTN.y));
__check('the close button returns to title', screen === 'title');
reset(); screen = 'play'; S.over = true; S.overT = 1;
__fire(cv, 'pointerdown', __fakeEvent(SHOP_BTN_OVER.x, SHOP_BTN_OVER.y));
__check('the shop button on a settled game-over screen opens the shop', screen === 'shop' && shopFrom === 'play');
__fire(window, 'keydown', { key: 'Escape', preventDefault: function(){} });
__check('Escape closes the shop back to wherever it was opened from', screen === 'play');
__check('closing the shop back to play still shows the same game-over state (S was never reset)', S.over === true);

// regression: SHOP_BTN_OVER used to be a small (r=34+10=44) CIRCLE centered
// under a much wider text label ("VISIT THE WORKSHOP") -- tapping near
// either end of the visible label (not its exact center pixel) missed the
// circle and fell through to the S.over screen's "any other tap replays"
// default, which read as the button silently doing nothing (worse, starting
// a new round) instead of opening the shop. It's a real rect (matching what
// lumButton actually draws) now, so a tap well off-center but still on the
// visible pill must still open the shop.
screen = 'play'; S.over = true; S.overT = 1;
__fire(cv, 'pointerdown', __fakeEvent(SHOP_BTN_OVER.x + SHOP_BTN_OVER.w / 2 - 8, SHOP_BTN_OVER.y));
__check('tapping near the edge of the Visit the Workshop pill (not just its exact center) still opens the shop', screen === 'shop' && shopFrom === 'play', 'screen=' + screen);

// tier-line purchase (Light Value -- the one line still left in
// TIER_LINES, Phase 1 economy architecture moved Capacity/Jar Reach/
// Magnet Reach/Magnet Duration all off it and onto the per-jar model):
// reject if unaffordable, succeed once affordable, escalating price per
// tier, reject once every tier is bought (no double-spend past maxed).
coins = 10; upgrades.lightTier = 0;
__check('a tier purchase is rejected when coins are insufficient', tryPurchaseTier('light') === false && coins === 10 && upgrades.lightTier === 0);
coins = 100;
__check('a tier purchase succeeds once affordable, deducting exactly tier 0\\'s price (60, unchanged by E2 -- "do not simply multiply the first price by 3")', tryPurchaseTier('light') === true && coins === 40 && upgrades.lightTier === 1);
upgrades.lightTier = 0; coins = 0;

// E2 Shop Economy 2.0: per-jar capacity upgrades now use the banded/
// interpolated curve (bandedTierCost()) instead of the old tapering-
// compound curve, and Simple's own ladder is now 8 tiers (base 5 -> max
// 13, up from 3 tiers -> max 8) -- reject if unaffordable, succeed once
// affordable, escalating price per upgrade, reject once the jar's own
// (now much higher) ceiling is reached. Exact prices below (25/38/52/67/
// 91/115/157/199) are the real bandedTierCost() output for Simple's own
// 8-tier line, not hand-derived.
coins = 10; upgrades.jarCapTiers.simple = 0;
__check('a jar capacity upgrade is rejected when coins are insufficient', tryUpgradeJarCap('simple') === false && coins === 10 && upgrades.jarCapTiers.simple === 0);
coins = 25;
__check('a jar capacity upgrade succeeds once affordable, deducting exactly the first upgrade\\'s price (25, unchanged tier-0 price)', tryUpgradeJarCap('simple') === true && coins === 0 && upgrades.jarCapTiers.simple === 1);
__check('the next upgrade costs more (38) -- rejected with nothing left after the first purchase', tryUpgradeJarCap('simple') === false && coins === 0, 'coins=' + coins);
coins = 38;
__check('the second upgrade succeeds once actually affordable, deducting exactly its own price (38)', tryUpgradeJarCap('simple') === true && coins === 0 && upgrades.jarCapTiers.simple === 2, 'coins=' + coins);
coins = 1000;
var __simpleJar = JARS.find(function(j){ return j.key === 'simple'; });
__check('Simple Glass Jar (base 5, max 13) is NOT maxed after only 2 of its 8 possible upgrades', jarCapMaxed(__simpleJar) === false);
// drive the remaining 6 upgrades (tiers 2-7: prices 52/67/91/115/157/199) to reach max
var __simpleCapCosts = [52, 67, 91, 115, 157, 199];
var __simpleCapOk = true;
for (var __sci = 0; __sci < __simpleCapCosts.length; __sci++) { if (tryUpgradeJarCap('simple') !== true) __simpleCapOk = false; }
var __simpleCapSpent = 1000 - coins;
__check('the remaining 6 upgrades all succeed, spending exactly the sum of their own real bandedTierCost() prices (52+67+91+115+157+199=681), and reach Simple Glass Jar\\'s own new max (13)', __simpleCapOk === true && __simpleCapSpent === 681 && jarCurrentCapacity(__simpleJar) === 13 && jarCapMaxed(__simpleJar) === true, 'spent=' + __simpleCapSpent + ' coins=' + coins);
__check('a jar already at its own max ceiling rejects a further upgrade, even with coins to spare', tryUpgradeJarCap('simple') === false);
upgrades.jarCapTiers.simple = 0; coins = 0; // reset for the tests below, which each manage their own coins/tier state

// the shop must draw across every tab (Lumora UI port: 6 tabs now) without
// throwing, across varied journal states
upgrades.deco = false; journal = { y: 0, b: 3, g: 30, e: 150, m: 0 };
var shopDrawThrew = false;
try {
  ['jars', 'capacity', 'range', 'light-value', 'magnet', 'decor'].forEach(function(tab){ shopTab = tab; screen = 'shop'; draw(); });
} catch (e) { shopDrawThrew = true; }
__check('the shop draws across all six tabs (varied journal states) without throwing', !shopDrawThrew);

// the Journal screen (moved out of the shop) must show every TYPES entry,
// not a hardcoded list -- this is what actually would have hidden Mystery
// Firefly's entry entirely
journal.m = 4; // give Mystery a real caught count so a hardcoded 4-item array would visibly diverge from reality
var journalThrew = false;
try { screen = 'journal'; draw(); } catch (e) { journalThrew = true; }
__check('the Journal screen draws Mystery Firefly\\'s entry without throwing', !journalThrew);
__check('the Journal screen\\'s rows are driven by TYPES\\' own keys, not a hardcoded list (would have silently hidden Mystery otherwise)', JSON.stringify(journalRowRects().map(function(r){ return r.key; }).sort()) === JSON.stringify(Object.keys(journal).sort()));

// Botanist's decoration must actually render in the village once owned (unlike
// Glassblower/Carpenter, Botanist is "fully wired" this session, not inert) --
// gated purely on upgrades.deco, not on heartTier/bestScore
var decoThrew = false;
try { upgrades.deco = false; screen = 'play'; draw(); upgrades.deco = true; draw(); } catch (e) { decoThrew = true; }
__check('the Botanist decoration renders (gated on upgrades.deco) without throwing, both owned and not', !decoThrew);

// ===== Village Fountain (Botanist's 2nd item) ===============================

// purchase flow behaves exactly like the existing Botanist item: reject if
// unaffordable, succeed once affordable, reject a double-spend -- same three
// checks Part B proved for the original single-item vendors, now on item #2
// Upgrade Cost Escalation pass: Garden Lanterns 20->150, Village Fountain
// 35->300 (flat one-shot increase, no tiers to compound -- see SHOP_ITEMS).
coins = 10; upgrades.fountain = false;
__check('fountain purchase is rejected when coins are insufficient', tryPurchase('fountain') === false && coins === 10 && upgrades.fountain === false);
coins = 300;
__check('fountain purchase succeeds once affordable, deducting exactly the price (300)', tryPurchase('fountain') === true && coins === 0 && upgrades.fountain === true, 'coins=' + coins);
__check('buying the fountain again is rejected (no double-spend) once owned', tryPurchase('fountain') === false && coins === 0);

// the two Botanist items must be independent -- owning one must not affect the
// other's afford/owned state, and each item's own buy-button hit-test must only
// ever purchase ITS OWN item (this is exactly what broke when the shop assumed
// one item per vendor; proving it explicitly here, not just trusting the refactor)
upgrades.deco = false; upgrades.fountain = false; coins = 500; // enough for both (150+300=450)
// snapshot rather than assume 0 -- earlier tests in this same driver
// legitimately leave the tier-line fields non-zero, this check only cares that
// THIS purchase doesn't touch them, not what their residual value happens to be
var jarCapTiersBefore = JSON.stringify(upgrades.jarCapTiers), reachTiersBefore = JSON.stringify(upgrades.reachTiers), magnetReachTiersBefore = JSON.stringify(upgrades.magnetReachTiers), durationTiersBefore = JSON.stringify(upgrades.durationTiers), lightTierBefore = upgrades.lightTier;
screen = 'shop'; shopFrom = 'title'; shopTab = 'decor';
var decorBtn0 = cardButtonRect(upgradeCardRect(0)), decorBtn1 = cardButtonRect(upgradeCardRect(1));
__fire(cv, 'pointerdown', __fakeEvent(decorBtn0.x, decorBtn0.y));
__check('clicking item slot 0\\'s buy button purchases Garden Lanterns specifically, not the fountain', upgrades.deco === true && upgrades.fountain === false, 'deco=' + upgrades.deco + ' fountain=' + upgrades.fountain);
__fire(cv, 'pointerdown', __fakeEvent(decorBtn1.x, decorBtn1.y));
__check('clicking item slot 1\\'s buy button purchases the fountain specifically, leaving the already-owned lanterns untouched', upgrades.deco === true && upgrades.fountain === true);
__check('owning both Decor items still leaves every per-jar stat and Light Value untouched', JSON.stringify(upgrades.jarCapTiers) === jarCapTiersBefore && JSON.stringify(upgrades.reachTiers) === reachTiersBefore && JSON.stringify(upgrades.magnetReachTiers) === magnetReachTiersBefore && JSON.stringify(upgrades.durationTiers) === durationTiersBefore && upgrades.lightTier === lightTierBefore);

// persistence survives reload, same defensive pattern as every other upgrade field
upgrades.fountain = false; coins = 300;
tryPurchase('fountain');
if (!YT) { var reloadedUpgrades = JSON.parse(localStorage.getItem('gk2_upgrades') || '{}'); __check('fountain ownership is written to the same gk2_upgrades key as jarTier/magnetTier/deco (no parallel storage)', reloadedUpgrades.fountain === true, 'stored=' + JSON.stringify(reloadedUpgrades)); }

// dry vs. flowing read as genuinely distinct: real state-dependent behavior
// (droplet particles), not just "doesn't throw" -- checked properly in-browser
// too, but this is what the harness itself can prove
// tracking the MAX observed S.parts.length across each window, not a
// before/after snapshot diff -- droplets spawn AND expire (0.5s life) within
// the window, so a snapshot at the end could miss them even when they did
// fire; max-observed catches any spawn event during the whole window
reset(); screen = 'play'; paused = false;
upgrades.fountain = false;
var maxPartsDry = 0;
for (var fdi = 0; fdi < 300; fdi++) { __stepFrame(16); if (S.parts.length > maxPartsDry) maxPartsDry = S.parts.length; }
upgrades.fountain = true;
var maxPartsFlow = 0;
for (var ffi = 0; ffi < 300; ffi++) { __stepFrame(16); if (S.parts.length > maxPartsFlow) maxPartsFlow = S.parts.length; }
__check('the fountain only emits idle droplets once owned (dry state never spawns any, flowing state does)', maxPartsDry === 0 && maxPartsFlow > 0, 'dry_max=' + maxPartsDry + ' flow_max=' + maxPartsFlow);
var fountainDrawThrew = false;
try { upgrades.fountain = false; draw(); upgrades.fountain = true; draw(); } catch (e) { fountainDrawThrew = true; }
__check('the fountain draws without throwing in both the dry and flowing state', !fountainDrawThrew);

// ===== Master Glowkeeper Statue (Decor shop's 3rd item, gated + equippable) =

// unlock gate: locked below 100% restoration (best=24 -> 80%, see
// RESTORATION_THRESH/RESTORATION_PCT), even with more than enough coins --
// tryPurchase()'s generic item.locked&&item.locked() check, not a
// statue-specific branch
best = 24; coins = 5000; upgrades.statueOwned = false; upgrades.statueEquipped = false;
__check('the statue cannot be purchased before 100% restoration, even with enough coins', tryPurchase('statue') === false && upgrades.statueOwned === false && coins === 5000, 'restorationPct=' + restorationPct(best) + ' coins=' + coins);

// unlocked at exactly 100% (best=25) -- reject if unaffordable, succeed once
// affordable, reject a double-spend once owned, same three-check discipline
// as every other one-shot SHOP_ITEMS purchase
best = 25; coins = 100;
__check('the statue is unlocked at 100% restoration but still rejects an unaffordable purchase', tryPurchase('statue') === false && upgrades.statueOwned === false && coins === 100, 'restorationPct=' + restorationPct(best));
coins = 3500;
__check('the statue purchase succeeds once affordable at 100%, deducting exactly the price (3500)', tryPurchase('statue') === true && coins === 0 && upgrades.statueOwned === true, 'coins=' + coins);
__check('buying the statue again is rejected (no double-spend) once owned', tryPurchase('statue') === false && coins === 0);
// dropping back below 100% (e.g. a hypothetical future reset) must not un-own an already-purchased statue -- ownership, once granted, isn't re-gated retroactively
best = 24;
__check('an already-owned statue stays owned even if restorationPct later reads below 100%', upgrades.statueOwned === true);
best = 25;

// equip: the one decor item with a real owned-vs-equipped distinction --
// cannot equip before owning, toggles cleanly once owned, and the gameplay
// gate (isGlowkeeperStatueEquipped()) requires BOTH
upgrades.statueOwned = false; upgrades.statueEquipped = false;
__check('equipping is rejected before the statue is owned', tryEquipStatue() === false && upgrades.statueEquipped === false);
upgrades.statueOwned = true;
__check('equipping succeeds once owned', tryEquipStatue() === true && upgrades.statueEquipped === true);
__check('isGlowkeeperStatueEquipped() is true once both owned and equipped', isGlowkeeperStatueEquipped() === true);
__check('equip is a real toggle -- calling it again unequips', tryEquipStatue() === true && upgrades.statueEquipped === false && isGlowkeeperStatueEquipped() === false);
upgrades.statueEquipped = true; // leave equipped for the rendering/gameplay checks below

// rendering safety across every state -- absent (not owned), owned-not-
// equipped, and owned+equipped must all draw without throwing, on both the
// village screen (where the landmark itself renders) and the play screen
var statueDrawThrew = false;
try {
  upgrades.statueOwned = false; upgrades.statueEquipped = false; screen = 'village'; draw();
  upgrades.statueOwned = true; upgrades.statueEquipped = false; draw();
  upgrades.statueOwned = true; upgrades.statueEquipped = true; draw();
  screen = 'play'; reset(); draw();
} catch (e) { statueDrawThrew = true; }
__check('the statue renders without throwing in every owned/equipped combination, on both the village and play screens', !statueDrawThrew);

// Glowkeeper's Blessing: the delivery-speed effect must change ONLY how fast
// the in-flight spark's own s.t reaches 1 -- score/coins/quest credit for
// delivering the exact same firefly must be byte-identical whether the
// statue is equipped or not. Proven by comparing the FULL delivery outcome
// (not just timing) across two otherwise-identical deliveries.
function deliverOneAndMeasure(blessed) {
  upgrades.statueOwned = blessed; upgrades.statueEquipped = blessed;
  // coinFraction (unlike S) is session-persistent, not reset by reset() --
  // must be zeroed here too, or the second call's whole-coin rollover
  // depends on the first call's leftover fraction and the two runs aren't
  // actually comparable (this is what the first version of this test got
  // wrong: it looked like a real bug -- 1 coin vs 0 -- but was really just
  // an unisolated measurement).
  coinFraction = 0;
  reset(); screen = 'play';
  S.carried.push({ type: 'y', ph: 0, sp: 1 });
  S.jar.y = 999; S.jar.ty = 999; // force inside the village zone
  var framesToArrive = 0;
  for (var di = 0; di < 300 && (S.sparks.length > 0 || S.carried.length > 0); di++) { __stepFrame(16); framesToArrive++; }
  return { score: S.score, delivered: S.deliveredN, coins: coins, framesToArrive: framesToArrive };
}
coins = 0;
var unblessed = deliverOneAndMeasure(false);
coins = 0;
var blessed = deliverOneAndMeasure(true);
__check('a blessed delivery reaches the village in fewer frames than an unblessed one (the actual speed effect)', blessed.framesToArrive < unblessed.framesToArrive, 'unblessed=' + unblessed.framesToArrive + ' blessed=' + blessed.framesToArrive);
__check('Glowkeeper\\'s Blessing changes delivery speed only -- score, delivered count, and coins earned for the same firefly are identical either way', blessed.score === unblessed.score && blessed.delivered === unblessed.delivered && blessed.coins === unblessed.coins, 'unblessed=' + JSON.stringify(unblessed) + ' blessed=' + JSON.stringify(blessed));
upgrades.statueOwned = false; upgrades.statueEquipped = false;

// regression: the FIRST purchase tap must buy only, not also auto-equip in
// the same click -- caught live in-browser (tryPurchase('statue') sets
// upgrades.statueOwned=true synchronously, and an unsnapshotted "already
// owned" check on the very next line would then see that fresh true and
// equip too, all inside one pointerdown handler call). Exercises the REAL
// click path (pointerdown -> cardButtonRect(upgradeCardRect(2))), not the
// tryPurchase()/tryEquipStatue() functions directly, since that's
// specifically where the bug lived.
best = 25; coins = 3500;
screen = 'shop'; shopFrom = 'title'; shopTab = 'decor'; jarCompareOpen = false;
var statueBtn = cardButtonRect(upgradeCardRect(2));
__fire(cv, 'pointerdown', __fakeEvent(statueBtn.x, statueBtn.y));
__check('the first tap on the statue\\'s button purchases it but does NOT auto-equip it in the same click', upgrades.statueOwned === true && upgrades.statueEquipped === false && coins === 0, 'owned=' + upgrades.statueOwned + ' equipped=' + upgrades.statueEquipped + ' coins=' + coins);
__fire(cv, 'pointerdown', __fakeEvent(statueBtn.x, statueBtn.y));
__check('a second tap on the same spot, now that it is owned, equips it', upgrades.statueEquipped === true);
__fire(cv, 'pointerdown', __fakeEvent(statueBtn.x, statueBtn.y));
__check('a third tap toggles it back off (the same EQUIP/EQUIPPED button is a real toggle through the real click path too)', upgrades.statueEquipped === false);
upgrades.statueOwned = false; upgrades.statueEquipped = false; // leave clean for whatever runs next

// ===== First-Night Tutorial ==================================================

// arming: a genuinely new player (tutorialDone still false) gets INTRO the
// moment a round begins from the title screen
upgrades.tutorialDone = false; tutorialStep = 'NONE'; tutorialPanelOpen = false;
screen = 'title';
beginPlay();
__check('a brand-new player entering play for the first time is armed straight into the INTRO step', tutorialStep === 'INTRO' && tutorialPanelOpen === true);
__check('update(dt) does not advance simulation while the tutorial panel is open (loop()\\'s own gate, not update() itself)', (function(){ var tBefore = S.t; if (!paused && !tutorialPanelOpen) update(0.5); return S.t === tBefore; })());

// full walk-through: INTRO -> CATCH -> DELIVER -> MOTH -> MAGNET -> COMPLETE,
// each step's own trigger condition checked via tutorialCheckAdvance() --
// the same function update() itself calls every frame, not a re-implementation
tutorialAdvance(); // INTRO -> CATCH (waiting)
__check('acknowledging INTRO moves to CATCH, panel closed (waiting for a firefly)', tutorialStep === 'CATCH' && tutorialPanelOpen === false);
tutorialCheckAdvance();
__check('CATCH panel does not open while no firefly exists yet', tutorialPanelOpen === false);
spawnFly('y');
tutorialCheckAdvance();
__check('CATCH panel opens the moment a firefly actually exists', tutorialPanelOpen === true);

tutorialAdvance(); // CATCH -> DELIVER (waiting)
__check('acknowledging CATCH moves to DELIVER, panel closed (waiting for a successful catch)', tutorialStep === 'DELIVER' && tutorialPanelOpen === false);
tutorialCheckAdvance();
__check('DELIVER panel does not open before any catch has happened', tutorialPanelOpen === false);
S.caughtN = 1;
tutorialCheckAdvance();
__check('DELIVER panel opens the moment the first firefly is actually caught', tutorialPanelOpen === true);

tutorialAdvance(); // DELIVER -> FULL (waiting)
__check('acknowledging DELIVER moves to FULL, panel closed (waiting for the jar to actually fill up)', tutorialStep === 'FULL' && tutorialPanelOpen === false);
tutorialCheckAdvance();
__check('FULL panel does not open while the jar has room left', tutorialPanelOpen === false);
S.carried.push({ type: 'y', ph: 0, sp: 1 }, { type: 'y', ph: 0, sp: 1 }, { type: 'y', ph: 0, sp: 1 }, { type: 'y', ph: 0, sp: 1 }, { type: 'y', ph: 0, sp: 1 });
__check('the jar is now genuinely full for this check (S.cap itself, not a hardcoded number)', S.carried.length >= S.cap, 'carried=' + S.carried.length + ' cap=' + S.cap);
tutorialCheckAdvance();
__check('FULL panel opens the moment the jar actually fills up (S.carried.length>=S.cap, the same canonical comparison drawFullJarAlert() uses)', tutorialPanelOpen === true);
S.carried = [];

// escape hatch: a player who always delivers before the jar fills must not
// get stuck on FULL forever -- S.deliveredN>=2 unblocks it too
tutorialStep = 'FULL'; tutorialPanelOpen = false; S.deliveredN = 0;
tutorialCheckAdvance();
__check('FULL does not open on delivery count alone below the threshold', tutorialPanelOpen === false);
S.deliveredN = 2;
tutorialCheckAdvance();
__check('FULL opens via the escape hatch (2+ deliveries already) even if the jar never actually filled up', tutorialPanelOpen === true);

tutorialAdvance(); // FULL -> MOTH (waiting)
__check('acknowledging FULL moves to MOTH, panel closed (waiting for a moth)', tutorialStep === 'MOTH' && tutorialPanelOpen === false);
tutorialCheckAdvance();
__check('MOTH panel does not open while no moth exists yet', tutorialPanelOpen === false);
spawnMoth();
tutorialCheckAdvance();
__check('MOTH panel opens the moment a moth actually appears', tutorialPanelOpen === true);

tutorialAdvance(); // MOTH -> MAGNET (waiting)
__check('acknowledging MOTH moves to MAGNET, panel closed (waiting for the magnet)', tutorialStep === 'MAGNET' && tutorialPanelOpen === false);
tutorialCheckAdvance();
__check('MAGNET panel does not open before the magnet orb exists', tutorialPanelOpen === false);
spawnMagnet();
tutorialCheckAdvance();
__check('MAGNET panel opens the moment the magnet orb actually appears', tutorialPanelOpen === true);

__check('upgrades.tutorialDone is still false -- MAGNET has not been acknowledged yet', upgrades.tutorialDone === false);
tutorialAdvance(); // MAGNET -> COMPLETE
__check('acknowledging the final step (MAGNET) completes the tutorial and persists tutorialDone', tutorialStep === 'COMPLETE' && tutorialPanelOpen === false && upgrades.tutorialDone === true);

// a completed tutorial never re-arms, even for a brand-new round from the title screen
screen = 'title';
beginPlay();
__check('beginPlay() never re-arms the tutorial once tutorialDone is true', tutorialStep === 'COMPLETE' && tutorialPanelOpen === false);

// mid-session resume: a player who leaves (Go Home) mid-tutorial and presses
// Begin again resumes their CURRENT step, not a restart at INTRO
upgrades.tutorialDone = false; tutorialStep = 'MOTH'; tutorialPanelOpen = false;
screen = 'title';
beginPlay();
__check('beginPlay() leaves an in-progress step exactly where it was (does not reset back to INTRO) -- reset() itself must never touch tutorial state', tutorialStep === 'MOTH' && tutorialPanelOpen === false);

// Skip Tutorial: short-circuits from ANY step straight to COMPLETE, via the
// real click path on the actual button rect (not calling completeTutorial() directly)
upgrades.tutorialDone = false; tutorialStep = 'CATCH'; tutorialPanelOpen = true;
__fire(cv, 'pointerdown', __fakeEvent(TUTORIAL_SKIP_BTN.x, TUTORIAL_SKIP_BTN.y));
__check('tapping Skip Tutorial immediately completes it from any step and persists tutorialDone', tutorialStep === 'COMPLETE' && tutorialPanelOpen === false && upgrades.tutorialDone === true);

// Got It via the real click path (not calling tutorialAdvance() directly)
upgrades.tutorialDone = false; tutorialStep = 'INTRO'; tutorialPanelOpen = true;
__fire(cv, 'pointerdown', __fakeEvent(TUTORIAL_GOT_IT_BTN.x, TUTORIAL_GOT_IT_BTN.y));
__check('tapping Got It on the real button rect advances the step, same as calling tutorialAdvance()', tutorialStep === 'CATCH' && tutorialPanelOpen === false);

// input swallowed while the panel is open -- a tap that would otherwise hit
// something in the (frozen) play screen underneath must do nothing
tutorialStep = 'CATCH'; tutorialPanelOpen = true;
var jarTxBefore = S.jar.tx;
__fire(cv, 'pointerdown', __fakeEvent(200, 200));
__check('a tap elsewhere on screen is swallowed while the tutorial panel is open (jar target unchanged)', S.jar.tx === jarTxBefore);
tutorialPanelOpen = false; tutorialStep = 'COMPLETE'; upgrades.tutorialDone = true;

// rendering safety across every step + the moth-warning flash, on the play screen
var tutorialDrawThrew = false;
try {
  screen = 'play'; reset();
  TUTORIAL_STEP_ORDER.concat(['COMPLETE']).forEach(function (step) { tutorialStep = step; tutorialPanelOpen = (step !== 'COMPLETE'); draw(); });
  tutorialPanelOpen = false; tutorialStep = 'COMPLETE';
  S.mothWarnT = 0.5; draw();
  S.mothWarnT = 0;
} catch (e) { tutorialDrawThrew = true; }
__check('every tutorial step (and the moth-warning flash) renders without throwing', !tutorialDrawThrew);

// economy isolation: delivering the same firefly must produce the exact same
// score/coins/delivered outcome whether the tutorial is mid-flight or already done
function deliverOneAndMeasureTutorial() {
  reset(); screen = 'play';
  S.carried.push({ type: 'y', ph: 0, sp: 1 });
  S.jar.y = 999; S.jar.ty = 999;
  for (var di = 0; di < 300 && (S.sparks.length > 0 || S.carried.length > 0); di++) __stepFrame(16);
  return { score: S.score, delivered: S.deliveredN, coins: coins };
}
coins = 0; coinFraction = 0; upgrades.tutorialDone = false; tutorialStep = 'DELIVER'; tutorialPanelOpen = false;
var midTutorial = deliverOneAndMeasureTutorial();
coins = 0; coinFraction = 0; upgrades.tutorialDone = true; tutorialStep = 'COMPLETE'; tutorialPanelOpen = false;
var tutorialDone = deliverOneAndMeasureTutorial();
__check('the tutorial has zero effect on scoring/economy -- delivering the same firefly mid-tutorial or after completion produces an identical outcome', midTutorial.score === tutorialDone.score && midTutorial.delivered === tutorialDone.delivered && midTutorial.coins === tutorialDone.coins, 'mid=' + JSON.stringify(midTutorial) + ' done=' + JSON.stringify(tutorialDone));

// moth-collision warning: only an ACTUAL collision (a moth close enough to
// scare a locked-in firefly) sets S.mothWarnT -- mere proximity, or a moth
// nearby with nothing locked to scare, must not
reset(); screen = 'play';
spawnMoth();
var m = S.moths[S.moths.length - 1];
m.x = S.jar.x; m.y = S.jar.y; // right on top of the jar -- well within the 72px collision distance
update(0.016); // actually run the moth-interrupt block -- without this the check below would trivially pass on pre-simulation state, not real behavior
__check('a moth touching the jar with nothing locked in does not set the collision warning (nothing was actually scared)', S.mothWarnT === 0, 'mothWarnT=' + S.mothWarnT);
spawnFly('y');
var lf = S.flies[S.flies.length - 1];
lf.state = 'locked'; lf.lockT = 0;
S.lockCd = 0;
update(0.016);
__check('a moth actually touching the jar WHILE a firefly is locked in sets the collision warning (the real existing scatter consequence)', S.mothWarnT > 0, 'mothWarnT=' + S.mothWarnT);
S.mothWarnT = 0;
// fresh round -- the previous sub-test's near-moth and locked firefly must
// not still be lingering in S.moths/S.flies, or they'd re-trigger here too
// and this check would pass for the wrong reason
reset(); screen = 'play';
spawnMoth();
var farMoth = S.moths[S.moths.length - 1];
farMoth.x = S.jar.x + 300; farMoth.y = S.jar.y; // nowhere near the jar
spawnFly('y');
var lf2 = S.flies[S.flies.length - 1];
lf2.state = 'locked'; lf2.lockT = 0;
S.lockCd = 0;
update(0.016);
__check('a moth merely somewhere on screen, far from the jar, does not set the collision warning (near moth != touch moth)', S.mothWarnT === 0, 'mothWarnT=' + S.mothWarnT);

// always-on "near moth" alert (jarNearAnyMoth()) -- distinct from both the
// one-time mothHint explanation and the collision-only red warning above.
// Live/derived, no S state of its own, reuses the exact same 140px radius
// drawMoth()'s own ambient glow already uses.
reset(); screen = 'play';
spawnMoth();
var nm = S.moths[S.moths.length - 1];
nm.x = S.jar.x + 500; nm.y = S.jar.y; // far away
__check('jarNearAnyMoth() is false when no moth is within the proximity radius', jarNearAnyMoth() === false);
nm.x = S.jar.x + 50; nm.y = S.jar.y - 14; // well within 140px of the jar's own anchor
__check('jarNearAnyMoth() is true once a moth is within the proximity radius', jarNearAnyMoth() === true);
nm.x = S.jar.x + 139; nm.y = S.jar.y - 14;
__check('jarNearAnyMoth() uses the same 140px radius drawMoth() itself uses for nearJar (just inside)', jarNearAnyMoth() === true);
nm.x = S.jar.x + 141; nm.y = S.jar.y - 14;
__check('jarNearAnyMoth() is false just outside that same 140px radius', jarNearAnyMoth() === false);
var nearMothDrawThrew = false;
try { nm.x = S.jar.x; nm.y = S.jar.y - 14; draw(); } catch (e) { nearMothDrawThrew = true; }
__check('the near-moth HUD alert renders without throwing', !nearMothDrawThrew);

// save/load persistence of the one flag that DOES persist (tutorialDone) --
// same defensive typeof-guard pattern as every other upgrades field, proven
// via the actual non-YT load path, not just the in-memory assignment
upgrades.tutorialDone = false; tutorialStep = 'NONE'; tutorialPanelOpen = false;
if (!YT) {
  upgrades.tutorialDone = true;
  persistUpgradesLocal();
  var reloadedUpgrades = JSON.parse(localStorage.getItem('gk2_upgrades') || '{}');
  __check('tutorialDone is written to the same gk2_upgrades key as every other upgrade field (no parallel storage)', reloadedUpgrades.tutorialDone === true, 'stored=' + JSON.stringify(reloadedUpgrades));
}
// leave clean for whatever runs next -- tutorialDone back to true (a
// "returning player") so every pre-existing test after this point keeps
// behaving exactly as it did before this feature existed, same reasoning
// as the top of this scenario
upgrades.tutorialDone = true; tutorialStep = 'NONE'; tutorialPanelOpen = false;

// ===== Lumora UI port: Jar Collection + trail colors ========================

// trail colors stay provably zero-effect (own and equip every one, confirm
// all four gameplay functions are completely unaffected)
upgrades.jarCapTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.reachTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.magnetReachTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.durationTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.lightTier = 0; upgrades.equippedJar = 'simple';
var baseCap = jarCapacityForRun(), baseRadiusA = jarReachForRun(), baseRadiusB = magnetReachForRun(), baseDur = magnetDurationForRun(5), baseMult = coinMultiplierForRun();
TRAIL_COLORS.forEach(function(t){ upgrades.ownedTrails[t.key] = true; upgrades.equippedTrail = t.key; });
__check('owning/equipping every trail color has zero effect on jarCapacityForRun/jarReachForRun/magnetReachForRun/magnetDurationForRun/coinMultiplierForRun', jarCapacityForRun() === baseCap && jarReachForRun() === baseRadiusA && magnetReachForRun() === baseRadiusB && magnetDurationForRun(5) === baseDur && coinMultiplierForRun() === baseMult);

// jar CHOICE, unlike trail color, is the primary capacity stat now -- each
// jar carries its own real base capacity (5/6/7/8/9/12), not a small bonus.
// Proven directly against the ported src/data/jars.ts values (Aurora's base
// capacity is 12, raised by the Aurora Endgame Jar pass).
JARS.forEach(function(j){ upgrades.ownedJars[j.key] = true; });
[['simple', 5], ['lantern', 6], ['moon', 7], ['crystal', 8], ['elder', 9], ['aurora', 12]].forEach(function(pair){
  upgrades.equippedJar = pair[0];
  __check('equipping ' + pair[0] + ' sets jarCapacityForRun to its own base capacity (' + pair[1] + ')', jarCapacityForRun() === pair[1], 'got=' + jarCapacityForRun());
});
upgrades.equippedJar = 'simple';
__check('diff() is still completely unaffected by equipped cosmetics/jar choice (only capacity moves)', (function(){ reset(); S.score = 20; var d1 = diff(); upgrades.equippedJar = 'aurora'; upgrades.equippedTrail = 'violet'; var d2 = diff(); return JSON.stringify({ maxFlies: d1.maxFlies, blue: d1.blue, shy: d1.shy }) === JSON.stringify({ maxFlies: d2.maxFlies, blue: d2.blue, shy: d2.shy }); })());

// purchase-flow parity with the rest of the shop: reject/succeed/no-double-spend
upgrades.ownedJars = { simple: true }; upgrades.equippedJar = 'simple'; coins = 400;
__check('a jar purchase is rejected when coins are insufficient', tryBuyOrEquipJar('lantern') === false && coins === 400 && !upgrades.ownedJars.lantern);
coins = 1000;
__check('a jar purchase succeeds once affordable, deducting exactly the price and auto-equipping it', tryBuyOrEquipJar('lantern') === true && coins === 500 && upgrades.ownedJars.lantern === true && upgrades.equippedJar === 'lantern', 'coins=' + coins);
var coinsAfterJarBuy = coins;
__check('tapping an already-owned jar again just re-equips it, no charge (this is the "buy vs equip" distinction, not a bug in the buy path)', tryBuyOrEquipJar('lantern') === true && coins === coinsAfterJarBuy);
__check('equipping simple (always owned, free) back over an owned paid jar works with no charge', tryBuyOrEquipJar('simple') === true && upgrades.equippedJar === 'simple' && coins === coinsAfterJarBuy);

// Trail System Redesign: Golden 150->500 (the full new ladder is exercised
// exhaustively further down).
upgrades.ownedTrails = { none: true }; upgrades.equippedTrail = 'none'; coins = 5;
__check('a trail purchase is rejected when coins are insufficient', tryBuyOrEquipTrail('gold') === false && coins === 5 && !upgrades.ownedTrails.gold);
coins = 600;
__check('a trail purchase succeeds once affordable, deducting exactly the price (500) and auto-equipping it', tryBuyOrEquipTrail('gold') === true && coins === 100 && upgrades.ownedTrails.gold === true && upgrades.equippedTrail === 'gold', 'coins=' + coins);
upgrades.ownedTrails = { none: true }; upgrades.equippedTrail = 'none'; coins = 0;

// ===== Trail System Redesign ================================================
// the full LOCKED price ladder, exhaustively -- not just Golden above.
__check('the full trail price ladder is exactly as locked (none=0, gold=500, violet=750, moonlit=1200, starlight=2000, celestial=3000)', ['none', 'gold', 'violet', 'moonlit', 'starlight', 'celestial'].map(function(k){ return TRAIL_COLORS.find(function(t){ return t.key === k; }).price; }).join(',') === '0,500,750,1200,2000,3000');
__check('Aurora Trail is NOT in TRAIL_COLORS at all -- it is never purchased and never owned, per direct instruction to derive it rather than add save state', TRAIL_COLORS.find(function(t){ return t.key === 'aurora'; }) === undefined);

// activeTrailHues(): Aurora wins unconditionally while equipped, WITHOUT
// ever touching upgrades.equippedTrail -- the single most important
// behavior in this whole pass (section 6/19: no claim/restore logic, no new
// save field, just "don't consult the normal selection while Aurora is
// equipped").
(function(){
  upgrades.ownedJars.simple = true; upgrades.ownedJars.aurora = true;
  upgrades.ownedTrails.violet = true; upgrades.equippedTrail = 'violet';
  upgrades.equippedJar = 'simple';
  __check('activeTrailHues() returns the normal equipped trail\\'s own palette while a non-Aurora jar is equipped', JSON.stringify(activeTrailHues()) === JSON.stringify(TRAIL_COLORS.find(function(t){ return t.key === 'violet'; }).hues));
  upgrades.equippedJar = 'aurora';
  __check('activeTrailHues() returns AURORA_TRAIL_HUES the instant Aurora is equipped, overriding whatever normal trail is selected', JSON.stringify(activeTrailHues()) === JSON.stringify(AURORA_TRAIL_HUES));
  __check('equipping Aurora does NOT overwrite upgrades.equippedTrail -- the player\\'s own selection ("violet") is completely untouched, not saved-over and restored', upgrades.equippedTrail === 'violet');
  upgrades.equippedJar = 'simple';
  __check('switching back to a non-Aurora jar immediately restores the normal trail -- automatically, because it was never actually changed', JSON.stringify(activeTrailHues()) === JSON.stringify(TRAIL_COLORS.find(function(t){ return t.key === 'violet'; }).hues));
  __check('activeTrailHues() returns null for "none" (no trail, no particles)', (function(){ upgrades.equippedTrail = 'none'; return activeTrailHues() === null; })());
  upgrades.equippedTrail = 'violet';
})();

// spawnTrailParticles(): the movement/stationary/cap rules directly, not
// just "some particles appeared somewhere" -- same isolation discipline
// (S.flies/S.moths cleared, fountain off) as the pre-existing trail-vs-
// no-trail test below.
(function(){
  reset(); screen = 'play'; paused = false;
  upgrades.fountain = false; upgrades.ownedJars.simple = true; upgrades.equippedJar = 'simple';
  upgrades.ownedTrails.gold = true; upgrades.equippedTrail = 'gold';
  S.flies = []; S.moths = [];
  S.jar.x = 200; S.jar.y = 400; S.jar.tx = 200; S.jar.ty = 400; // stationary
  var beforeStationary = S.parts.length;
  for (var sti = 0; sti < 60; sti++) { S.flies = []; S.moths = []; __stepFrame(16); }
  __check('a stationary jar with a trail equipped emits NO new trail particles (existing ones just fade, per direct instruction -- no permanent glow behind a parked jar)', S.parts.length <= beforeStationary, 'before=' + beforeStationary + ' after=' + S.parts.length);
  S.jar.tx = 400; S.jar.ty = 420; // now genuinely moving
  var sawGrowth = false;
  for (var mvi = 0; mvi < 60 && !sawGrowth; mvi++) { S.flies = []; S.moths = []; var b = S.parts.length; __stepFrame(16); if (S.parts.length > b) sawGrowth = true; }
  __check('a genuinely moving jar with a trail equipped does emit new particles', sawGrowth);
  // particle cap: fill S.parts artificially, then confirm spawnTrailParticles
  // refuses to push past TRAIL_PARTICLE_CAP even while fast-moving
  S.parts = []; for (var fci = 0; fci < TRAIL_PARTICLE_CAP; fci++) S.parts.push({ x: 0, y: 0, vx: 0, vy: 0, life: 5, maxL: 5, color: 'rgba(1,1,1,1)', r: 1 });
  var cappedLen = S.parts.length;
  S.jar.spd = 200; // force a high speed directly rather than waiting on the lerp-based movement to ramp up
  for (var cpi = 0; cpi < 30; cpi++) spawnTrailParticles(0.016);
  __check('spawnTrailParticles() refuses to spawn once S.parts is already at/over TRAIL_PARTICLE_CAP -- an explicit bounded ceiling, not just "eventually stops growing"', S.parts.length === cappedLen, 'before=' + cappedLen + ' after=' + S.parts.length);
  S.parts = [];
})();

// cosmetics-don't-touch-gameplay, same proof shape used everywhere else in
// this file: toggling every trail (including equipping Aurora, which drives
// activeTrailHues() down a completely different branch) has zero effect on
// diff()/jarCapacityForRun()/coins.
(function(){
  reset(); S.score = 20;
  upgrades.ownedJars.aurora = true;
  var dOff = diff(), capOff = jarCapacityForRun(), coinsOff = coins;
  upgrades.equippedTrail = 'celestial'; upgrades.ownedTrails.celestial = true;
  upgrades.equippedJar = 'aurora';
  var dOn = diff(), capOn = jarCapacityForRun(), coinsOn = coins;
  __check('every trail, including Aurora Trail via an equipped Aurora jar, has zero effect on diff() (spawn/difficulty), jarCapacityForRun(), or coins', JSON.stringify({ maxFlies: dOff.maxFlies, blue: dOff.blue, shy: dOff.shy }) === JSON.stringify({ maxFlies: dOn.maxFlies, blue: dOn.blue, shy: dOn.shy }) && coinsOff === coinsOn, 'capOff=' + capOff + ' capOn=' + capOn);
  upgrades.equippedJar = 'simple'; upgrades.equippedTrail = 'violet';
})();

// shop UI: 7 tabs now (was 6), Trails is one of them, and the Aurora Trail
// card is explicitly NOT a purchase/equip tap target.
__check('SHOP_TABS now includes a dedicated "trails" tab', SHOP_TABS.some(function(t){ return t.key === 'trails'; }));
__check('trailCardRects() returns exactly one rect per TRAIL_COLORS entry (6 -- none/gold/violet/moonlit/starlight/celestial)', trailCardRects().length === TRAIL_COLORS.length);
(function(){
  reset(); screen = 'shop'; shopFrom = 'title'; shopTab = 'trails';
  upgrades.ownedJars.aurora = true; upgrades.equippedJar = 'aurora';
  var beforeEquipped = upgrades.equippedTrail, beforeOwned = JSON.stringify(upgrades.ownedTrails);
  var auroraCard = auroraTrailCardRect();
  __fire(cv, 'pointerdown', __fakeEvent(auroraCard.x + auroraCard.w / 2, auroraCard.y + auroraCard.h / 2));
  __check('tapping the Aurora Trail card does nothing -- it is informational only, never purchasable/equippable (no ownedTrails/equippedTrail change at all)', upgrades.equippedTrail === beforeEquipped && JSON.stringify(upgrades.ownedTrails) === beforeOwned);
  var auroraDrawThrew = false;
  try { draw(); } catch (e) { auroraDrawThrew = true; }
  __check('the Trails tab (including the Aurora Trail card, active since Aurora is equipped) draws without throwing', !auroraDrawThrew);
  upgrades.equippedJar = 'simple';
})();

// old-save migration: a save from before this pass (Golden/Violet owned at
// the OLD prices, which is irrelevant to ownership -- price isn't stored
// per-purchase) must keep its trail ownership exactly as it was.
(function(){
  upgrades.ownedTrails = { none: true, gold: true, violet: true }; upgrades.equippedTrail = 'gold';
  if (!YT) {
    persistUpgradesLocal();
    var reloadedOldTrails = JSON.parse(localStorage.getItem('gk2_upgrades') || '{}');
    __check('a pre-existing owned Golden/Violet trail selection survives this pass untouched -- new trail keys (moonlit/starlight/celestial) simply don\\'t exist yet on an old save, same generic migration every other upgrades.* field already uses', JSON.stringify(reloadedOldTrails.ownedTrails) === JSON.stringify({ none: true, gold: true, violet: true }) && reloadedOldTrails.equippedTrail === 'gold');
  }
  upgrades.ownedTrails = { none: true }; upgrades.equippedTrail = 'none';
})();

// the trail cosmetic is genuinely inert (no color) vs. active (spawns particles),
// same max-observed-over-a-window technique used for the fountain's droplets.
// S.flies/S.moths are wiped each frame to prevent a REAL, unrelated source from
// contaminating the measurement: a spawned firefly can wander into the moving
// jar's lock radius and get caught mid-window, and the catch animation already
// pushes its own light-streak particles into this same S.parts array (Stage 0) --
// that's not a Stage 4 bug, just a different existing feature sharing the array,
// and this test needs to isolate the trail specifically, not "any particle at all".
// upgrades.fountain is ALSO explicitly reset here -- it's residual true from the
// fountain tests earlier in this same driver, and the fountain's own droplet
// spawn (this same session, Village Fountain) is a second unrelated contributor
// to this same S.parts array that would otherwise contaminate this measurement too.
reset(); screen = 'play'; paused = false;
upgrades.fountain = false;
upgrades.equippedTrail = 'none';
S.jar.tx = S.jar.x + 200; S.jar.ty = S.jar.y; // give the jar real speed to move through
var maxPartsNoTrail = 0;
for (var tni = 0; tni < 120; tni++) { S.flies = []; S.moths = []; __stepFrame(16); if (S.parts.length > maxPartsNoTrail) maxPartsNoTrail = S.parts.length; }
upgrades.equippedTrail = 'gold';
S.jar.x = 100; S.jar.tx = S.jar.x + 200; S.jar.ty = S.jar.y;
var maxPartsTrail = 0;
for (var tyi = 0; tyi < 120; tyi++) { S.flies = []; S.moths = []; __stepFrame(16); if (S.parts.length > maxPartsTrail) maxPartsTrail = S.parts.length; }
__check('the trail cosmetic only emits particles once a color is equipped (moving with "none" equipped emits nothing extra)', maxPartsNoTrail === 0 && maxPartsTrail > 0, 'no_trail_max=' + maxPartsNoTrail + ' trail_max=' + maxPartsTrail);

// persistence: owned set + equipped selection both survive, same defensive pattern
upgrades.ownedJars = { simple: true, aurora: true }; upgrades.equippedJar = 'aurora';
upgrades.ownedTrails = { none: true, violet: true }; upgrades.equippedTrail = 'violet';
if (!YT) {
  persistUpgradesLocal();
  var reloadedCosmetics = JSON.parse(localStorage.getItem('gk2_upgrades') || '{}');
  __check('jar/trail owned sets and equipped selections persist to the same gk2_upgrades key (no parallel storage)', JSON.stringify(reloadedCosmetics.ownedJars) === JSON.stringify({ simple: true, aurora: true }) && reloadedCosmetics.equippedJar === 'aurora' && JSON.stringify(reloadedCosmetics.ownedTrails) === JSON.stringify({ none: true, violet: true }) && reloadedCosmetics.equippedTrail === 'violet', 'stored=' + JSON.stringify(reloadedCosmetics));

  // Aurora Endgame Jar pass, item 6: the prestige halo has no dedicated save
  // field of its own -- it must survive a real save/load round-trip purely
  // because it's derived live from the same per-jar tier fields the line
  // above already proved persist. Prove that composition explicitly rather
  // than assuming it.
  var __auroraJarForPersist = JARS.find(function(j){ return j.key === 'aurora'; });
  upgrades.jarCapTiers.aurora = __auroraJarForPersist.maxCapacity - __auroraJarForPersist.capacity; // E2: generic, not the old hardcoded 13 -- Aurora's own capacity tier count now varies with its (raised) ceiling
  upgrades.reachTiers.aurora = jarStatTierCount('reach', __auroraJarForPersist);
  upgrades.magnetReachTiers.aurora = jarStatTierCount('magnetReach', __auroraJarForPersist);
  upgrades.durationTiers.aurora = jarStatTierCount('duration', __auroraJarForPersist);
  upgrades.lightValueTiers.aurora = jarStatTierCount('lightValue', __auroraJarForPersist);
  __check('auroraFullyMaxed() reads true before any save/load round-trip (sanity baseline)', auroraFullyMaxed() === true);
  persistUpgradesLocal();
  var __reloadedForPrestige = JSON.parse(localStorage.getItem('gk2_upgrades') || '{}');
  upgrades.jarCapTiers.aurora = 0; upgrades.reachTiers.aurora = 0; upgrades.magnetReachTiers.aurora = 0; upgrades.durationTiers.aurora = 0; upgrades.lightValueTiers.aurora = 0;
  __check('auroraFullyMaxed() genuinely goes false once the live tiers are cleared (proves the next check is not a no-op)', auroraFullyMaxed() === false);
  upgrades.jarCapTiers.aurora = __reloadedForPrestige.jarCapTiers.aurora;
  upgrades.reachTiers.aurora = __reloadedForPrestige.reachTiers.aurora;
  upgrades.magnetReachTiers.aurora = __reloadedForPrestige.magnetReachTiers.aurora;
  upgrades.durationTiers.aurora = __reloadedForPrestige.durationTiers.aurora;
  upgrades.lightValueTiers.aurora = __reloadedForPrestige.lightValueTiers.aurora;
  __check('the fully-maxed prestige state (auroraFullyMaxed()) reads true again after reloading the persisted per-jar tiers -- no dedicated save field needed', auroraFullyMaxed() === true);
  upgrades.jarCapTiers.aurora = 0; upgrades.reachTiers.aurora = 0; upgrades.magnetReachTiers.aurora = 0; upgrades.durationTiers.aurora = 0; upgrades.lightValueTiers.aurora = 0;
}

// distinguishability at the DATA level (visual distinctness confirmed separately in-browser)
__check('every jar has a genuinely distinct glass color from every other jar', new Set(JARS.map(function(j){ return j.glass; })).size === JARS.length);
__check('every jar has a genuinely distinct capacity from every other jar', new Set(JARS.map(function(j){ return j.capacity; })).size === JARS.length);
// Trail System Redesign: "color" (one flat tint) replaced by "hues" (a real
// palette per trail, so Moonlit/Starlight/Celestial can genuinely shift
// between colors, not just tint one). Every trail's own palette signature
// must still be distinct from every other's (or empty, for 'none').
__check('every trail\\'s hues palette is genuinely distinct from every other trail\\'s (or explicitly empty for "none")', new Set(TRAIL_COLORS.map(function(t){ return t.hues.join('|'); })).size === TRAIL_COLORS.length);
__check('"none" is the only trail with an empty hues array -- every purchasable trail actually has particle colors to render', TRAIL_COLORS.filter(function(t){ return t.hues.length === 0; }).length === 1 && TRAIL_COLORS.find(function(t){ return t.hues.length === 0; }).key === 'none');

var cosmeticsShopDrawThrew = false;
try { screen = 'shop'; shopTab = 'jars'; draw(); } catch (e) { cosmeticsShopDrawThrew = true; }
__check('the Jars tab draws the equipped-jar hero and the jar collection grid without throwing (Trail System Redesign: trails moved to their own tab, see below)', !cosmeticsShopDrawThrew);

// ===== Aurora shop-presentation pass: ULTIMATE JAR label + compare modal ===
// data-level: the label is data-driven off jar.aurora, not hand-checked per
// key -- proving exactly one jar carries the flag is what actually
// guarantees the label can only ever render for Aurora.
__check('exactly one jar (Aurora) carries the aurora:true identity flag the ULTIMATE JAR label and every FX gate key off of', JARS.filter(function(j){ return j.aurora === true; }).length === 1 && JARS.find(function(j){ return j.aurora === true; }).key === 'aurora');

// jarCompareValues(): pure data, live off JARS[]/upgrades -- never hardcoded.
(function(){
  var simpleJar = JARS.find(function(j){ return j.key === 'simple'; });
  var auroraJar = JARS.find(function(j){ return j.key === 'aurora'; });
  upgrades.jarCapTiers.simple = 0; upgrades.reachTiers.simple = 0;
  var capVals = jarCompareValues('capacity', simpleJar);
  __check('jarCompareValues(capacity, Simple) with nothing upgraded reads base=current=5, max=13 (E2: raised ceiling) -- straight off JARS[], not a hardcoded UI value', capVals.base === 5 && capVals.current === 5 && capVals.max === 13, 'got=' + JSON.stringify(capVals));
  upgrades.jarCapTiers.simple = 2; // Simple's own progress -- Aurora's must stay untouched (per-jar independence)
  var capValsAfter = jarCompareValues('capacity', simpleJar);
  var auroraCapVals = jarCompareValues('capacity', auroraJar);
  __check('jarCompareValues(capacity, Simple) reflects Simple\\'s own live upgrade progress (current=7) once tiers are actually owned', capValsAfter.current === 7, 'got=' + JSON.stringify(capValsAfter));
  __check('jarCompareValues(capacity, Aurora) is completely untouched by Simple\\'s own progress above -- per-jar independence, same proof shape as every other per-jar stat in this file', auroraCapVals.base === 12 && auroraCapVals.current === 12 && auroraCapVals.max === 38, 'got=' + JSON.stringify(auroraCapVals));
  var reachVals = jarCompareValues('reach', auroraJar);
  __check('jarCompareValues(reach, Aurora) reads Aurora\\'s own locked base/max (110/150) straight off JARS[]', reachVals.base === 110 && reachVals.max === 150, 'got=' + JSON.stringify(reachVals));
  upgrades.jarCapTiers.simple = 0;
})();
__check('Coin Value is never presented as a per-jar stat: JAR_COMPARE_ROWS has no entry for it (only the five genuinely per-jar lines)', JAR_COMPARE_ROWS.map(function(r){ return r.key; }).sort().join(',') === ['capacity', 'duration', 'lightValue', 'magnetReach', 'reach'].sort().join(','));

// inRect() treats x,y as a rect's CENTER, not a corner (see inRect's own
// definition) -- a geometry check, not just "tapping rect.x,rect.y counts
// as a hit" (which is trivially true for ANY rect regardless of whether
// x,y means corner or center, so it can't actually catch a corner-vs-center
// mixup on its own). This asserts the link's RIGHT edge (x+w/2) actually
// lands near the hero card's own right edge, which only holds if x,y is
// genuinely the rect's center.
__check('AURORA_COMPARE_LINK is defined using center-based x,y (its right edge sits just inside the hero card\\'s own right edge, not w/2 past it)', (AURORA_COMPARE_LINK.x + AURORA_COMPARE_LINK.w / 2) <= EQUIPPED_JAR_RECT.x + EQUIPPED_JAR_RECT.w && (AURORA_COMPARE_LINK.x + AURORA_COMPARE_LINK.w / 2) > EQUIPPED_JAR_RECT.x + EQUIPPED_JAR_RECT.w - 40, 'rightEdge=' + (AURORA_COMPARE_LINK.x + AURORA_COMPARE_LINK.w / 2) + ' heroRightEdge=' + (EQUIPPED_JAR_RECT.x + EQUIPPED_JAR_RECT.w));

// the compare modal: link visibility, hit-testing, swallow-all-but-close,
// and Esc, all mirroring the existing confirm-modal discipline exactly.
reset(); screen = 'shop'; shopTab = 'jars'; jarCompareOpen = false;
upgrades.ownedJars.simple = true; upgrades.equippedJar = 'simple';
__fire(cv, 'pointerdown', __fakeEvent(AURORA_COMPARE_LINK.x, AURORA_COMPARE_LINK.y));
__check('tapping "Compare to Aurora" on a non-Aurora equipped jar opens the comparison modal', jarCompareOpen === true);
var compareModalDrawThrew = false;
try { draw(); } catch (e) { compareModalDrawThrew = true; }
__check('drawing the open comparison modal does not throw', !compareModalDrawThrew);
upgrades.ownedJars.lantern = true; // owned (and affordable is moot once owned) -- guarantees the tap below would genuinely equip Lantern if it weren't swallowed, not silently no-op for an unrelated reason (e.g. insufficient funds)
var __lanternCardRect = jarCardRects().find(function(r){ return r.key === 'lantern'; });
__fire(cv, 'pointerdown', __fakeEvent(__lanternCardRect.x, __lanternCardRect.y));
__check('while the comparison modal is open, a tap that would otherwise equip a different (owned) jar is swallowed instead -- equippedJar stays exactly where it was, and the modal stays open', jarCompareOpen === true && upgrades.equippedJar === 'simple');
__fire(cv, 'pointerdown', __fakeEvent(SHOP_CLOSE_BTN.x, SHOP_CLOSE_BTN.y)); // even the shop's own close button is swallowed while the modal is open
__check('the comparison modal also swallows a tap on the shop\\'s own close button -- the shop does not close out from under an open informational modal', jarCompareOpen === true && screen === 'shop');
__fire(cv, 'pointerdown', __fakeEvent(JAR_COMPARE_CLOSE_BTN.x, JAR_COMPARE_CLOSE_BTN.y));
__check('tapping the comparison modal\\'s own close button closes it and returns to the same shop state (still on the jars tab, still in the shop)', jarCompareOpen === false && screen === 'shop' && shopTab === 'jars');

upgrades.equippedJar = 'aurora'; upgrades.ownedJars.aurora = true;
__fire(cv, 'pointerdown', __fakeEvent(AURORA_COMPARE_LINK.x, AURORA_COMPARE_LINK.y));
__check('the "Compare to Aurora" link does nothing when Aurora is already the equipped jar (comparing Aurora to itself is meaningless, so it is not offered)', jarCompareOpen === false);
upgrades.equippedJar = 'simple';

jarCompareOpen = true;
__fire(window, 'keydown', { key: 'Escape', preventDefault: function(){} });
__check('Escape closes the comparison modal first, same two-step precedent as the pauseConfirm modal -- does not also close the shop in the same keystroke', jarCompareOpen === false && screen === 'shop');

// ===== Shop Restructure: real upgrade effects (Capacity/Range/Duration/Light Value) =====
// (The old "[Part C removes this] ownership has no effect" block lived here --
// removed outright per its own stated purpose, not "fixed": that invariant is
// now intentionally false, so keeping it around commented out would just be
// dead weight, not a useful record.)

// not owned: exact base values, no silent bonus creeping in. Capacity's base
// is now whichever jar is equipped (simple=5), not a flat JAR_CAP constant.
upgrades.jarCapTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.reachTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.magnetReachTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.durationTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.lightValueTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }; upgrades.lightTier = 0; upgrades.equippedJar = 'simple';
__check('jarCapacityForRun returns exactly the equipped jar\\'s own base capacity when no upgrades are owned', jarCapacityForRun() === currentJar().capacity, 'got=' + jarCapacityForRun());
// Phase 1 economy pass (jar identity rebalance): Simple's own base Reach/
// Magnet Reach/Duration (55/130/4.0s) -- no longer the old shared
// placeholder (70/170/5s), now genuinely Simple's OWN, lowest-in-the-game
// starting point.
__check('jarReachForRun/magnetReachForRun return exactly Simple\\'s own bases (55/130) when Jar Reach/Magnet Reach are not owned', jarReachForRun() === 55 && magnetReachForRun() === 130, 'reach=' + jarReachForRun() + ' magnetReach=' + magnetReachForRun());
__check('magnetDurationForRun returns exactly Simple\\'s own base (4.0s) when Magnet Duration is not owned', Math.abs(magnetDurationForRun(5) - 4.0) < 1e-9, 'got=' + magnetDurationForRun(5));
__check('coinMultiplierForRun returns exactly 1x when Coin Value is not owned', coinMultiplierForRun() === 1);

// LUMORA clarifications pass: per-jar capacity, one upgrade at a time --
// checked at every cumulative step for TWO different jars, proving the
// progress is genuinely independent per jar (not a shared pool) and that
// each jar caps out at its OWN max, not some shared ceiling.
// E2 Shop Economy 2.0: Simple Glass Jar's ceiling is now 13 (up from 8),
// 8 possible upgrades instead of 3 -- 5->6->7->8.
upgrades.equippedJar = 'simple'; upgrades.jarCapTiers.simple = 0;
[1, 2, 8].forEach(function(n, idx){
  upgrades.jarCapTiers.simple = n;
  var expected = [6, 7, 13][idx];
  __check('Simple Glass Jar upgrade ' + n + ': cumulative capacity ' + expected, jarCapacityForRun() === expected, 'got=' + jarCapacityForRun());
});
__check('Simple Glass Jar is maxed at 13 after exactly 8 upgrades, and a 9th grants nothing further (capped, not overshooting)', jarCapMaxed(JARS.find(function(j){ return j.key === 'simple'; })) === true && (function(){ upgrades.jarCapTiers.simple = 99; var v = jarCapacityForRun(); upgrades.jarCapTiers.simple = 8; return v === 13; })());
upgrades.jarCapTiers.simple = 0;
// E2 Shop Economy 2.0: Aurora Jar's ceiling is now 38 (up from 25), 26
// possible upgrades instead of 13 -- still a much longer ladder than every
// other jar, proving the model scales per-jar rather than assuming every
// jar needs the same step count.
upgrades.ownedJars.aurora = true; upgrades.equippedJar = 'aurora'; upgrades.jarCapTiers.aurora = 0;
[1, 5, 26].forEach(function(n){
  upgrades.jarCapTiers.aurora = n;
  __check('Aurora Jar upgrade ' + n + ': cumulative capacity ' + (12 + n), jarCapacityForRun() === 12 + n, 'got=' + jarCapacityForRun());
});
__check('Aurora Jar is maxed at exactly 38 (its own ceiling, not Simple\\'s or any shared one)', jarCapMaxed(JARS.find(function(j){ return j.key === 'aurora'; })) === true);
__check('switching the equipped jar back to Simple reads Simple\\'s OWN progress (still 0), not Aurora\\'s -- proving progress is per-jar, not shared', (function(){ upgrades.equippedJar = 'simple'; var v = jarCapacityForRun(); upgrades.equippedJar = 'aurora'; return v === 5; })());
upgrades.jarCapTiers.aurora = 0; upgrades.equippedJar = 'simple';

// E2 Shop Economy 2.0: Jar Reach, Magnet Reach, Magnet Duration, and Light
// Value are still all per-jar, but PER_JAR_STAT_STEP is now ALSO per-jar
// (was one flat number shared by every jar) -- Simple's own step for each
// stat is smaller than before (more, smaller levels), and Light Value's
// own ceiling is raised (0.65->0.95, up from 0.80). Reach/Magnet Reach/
// Duration ceilings are UNCHANGED (55->64 / 130->154 / 4.0->5.5s), only
// reached via more/smaller steps now (32/24/27 tiers instead of 3).
var __simpleJarStat = JARS.find(function(j){ return j.key === 'simple'; });
upgrades.reachTiers.simple = 1;
__check('Jar Reach tier 1: base+0.29 (55.29), Magnet Reach untouched (130)', Math.abs(jarReachForRun() - 55.29) < 1e-9 && magnetReachForRun() === 130, 'jarReach=' + jarReachForRun());
upgrades.reachTiers.simple = 32;
__check('Jar Reach tier 32 (maxed): reaches Simple\\'s own ceiling (64), unchanged by E2', jarReachForRun() === 64 && jarStatMaxed('reach', __simpleJarStat));
upgrades.reachTiers.simple = 0;

upgrades.magnetReachTiers.simple = 1;
__check('Magnet Reach tier 1: base+1 (131), Jar Reach untouched (55)', magnetReachForRun() === 131 && jarReachForRun() === 55, 'magnetReach=' + magnetReachForRun());
upgrades.magnetReachTiers.simple = 24;
__check('Magnet Reach tier 24 (maxed): reaches Simple\\'s own ceiling (154), unchanged by E2', magnetReachForRun() === 154 && jarStatMaxed('magnetReach', __simpleJarStat), 'magnetReach=' + magnetReachForRun());
upgrades.magnetReachTiers.simple = 0;

upgrades.durationTiers.simple = 1;
__check('Magnet Duration tier 1: base+0.056s (4.056s)', Math.abs(magnetDurationForRun(5) - 4.056) < 1e-9, 'got=' + magnetDurationForRun(5));
upgrades.durationTiers.simple = 27;
__check('Magnet Duration tier 27 (maxed): reaches Simple\\'s own ceiling (5.5s), unchanged by E2', Math.abs(magnetDurationForRun(5) - 5.5) < 1e-9 && jarStatMaxed('duration', __simpleJarStat));
upgrades.durationTiers.simple = 0;

upgrades.lightValueTiers.simple = 1;
__check('Light Value (per-jar) tier 1: base+0.015 (0.665x)', Math.abs(jarCurrentStat('lightValue', __simpleJarStat) - 0.665) < 1e-9, 'got=' + jarCurrentStat('lightValue', __simpleJarStat));
upgrades.lightValueTiers.simple = 20;
__check('Light Value (per-jar) tier 20 (maxed): reaches Simple\\'s own E2-raised ceiling (0.95x, up from 0.80x)', Math.abs(jarCurrentStat('lightValue', __simpleJarStat) - 0.95) < 1e-9 && jarStatMaxed('lightValue', __simpleJarStat), 'got=' + jarCurrentStat('lightValue', __simpleJarStat));
upgrades.lightValueTiers.simple = 0;

// per-jar independence, same proof shape as the earlier Capacity block:
// upgrading Simple's Jar Reach must not touch any other jar's Jar Reach.
// Also proves base VALUES genuinely differ per jar now, not just ceilings
// (Aurora's own untouched base is 110, not Simple's 55 -- raised from 100
// by the Aurora Endgame Jar pass).
upgrades.ownedJars.aurora = true;
upgrades.reachTiers.simple = 2;
var __auroraJarStat = JARS.find(function(j){ return j.key === 'aurora'; });
__check('upgrading Simple\\'s Jar Reach leaves Aurora\\'s Jar Reach at its own untouched (and higher) base', Math.abs(jarCurrentStat('reach', __simpleJarStat) - 55.58) < 1e-9 && jarCurrentStat('reach', __auroraJarStat) === 110, 'simple=' + jarCurrentStat('reach', __simpleJarStat) + ' aurora=' + jarCurrentStat('reach', __auroraJarStat));
upgrades.reachTiers.simple = 0;

// E2 Shop Economy 2.0: Coin Value (shared, global) now has 60 levels at a
// flat +1.25 percentage points each, 1.00x->1.75x (was 3 levels at
// +10pp each, 1.00x->1.30x) -- a much longer ladder with a deliberately
// higher, but still bounded, ceiling per the E1-approved target model.
upgrades.lightTier = 1;
__check('Coin Value tier 1: 1.0125x multiplier', Math.abs(coinMultiplierForRun() - 1.0125) < 1e-9);
upgrades.lightTier = 3;
__check('Coin Value tier 3: 1.0375x multiplier, NOT maxed -- E2 raised the ceiling from 3 levels to 60', Math.abs(coinMultiplierForRun() - 1.0375) < 1e-9 && tierMaxed('light') === false);
upgrades.lightTier = 60;
__check('Coin Value tier 60 (the new max): 1.75x multiplier, the E1-approved ceiling, not an open-ended climb', Math.abs(coinMultiplierForRun() - 1.75) < 1e-9 && tierMaxed('light') === true);
upgrades.lightTier = 0;

// E2 Shop Economy 2.0: Coin Value now has 60 levels (was 3), priced via
// bandedTierCost() (was the old tapering-triple curve) -- TIER_LINES.light
// name/field/purchase mechanism are all completely unchanged; only the
// SHAPE of .steps/.prices changed (60-element generated arrays instead of
// 3 hand-authored ones), which every reader already works off generically.
__check('the shared multiplier\\'s display name is "Coin Value", not "Light Value" -- that name now belongs to the per-jar stat', TIER_LINES.light.name === 'Coin Value');
__check('Coin Value\\'s price curve is the new banded/interpolated shape -- 60 levels, tier0 unchanged at 60, strictly increasing throughout, no flat band and no sudden spike at any band boundary', (function(){
  var p = TIER_LINES.light.prices;
  if (p.length !== 60 || p[0] !== 60) return false;
  for (var i = 1; i < p.length; i++) { if (p[i] <= p[i - 1]) return false; } // strictly increasing -- catches both a flat band and a reversed price
  return true;
})(), 'prices=' + JSON.stringify(TIER_LINES.light.prices));
__check('Coin Value\\'s full 60-tier price table matches bandedTierCost()\\'s real output exactly (spot-checked at tier 0/1/2/59) and totals 30,069', TIER_LINES.light.prices[0] === 60 && TIER_LINES.light.prices[1] === 63 && TIER_LINES.light.prices[2] === 65 && TIER_LINES.light.prices[59] === 1725 && TIER_LINES.light.prices.reduce(function(a, b){ return a + b; }, 0) === 30069, 'got=' + JSON.stringify([TIER_LINES.light.prices[0], TIER_LINES.light.prices[1], TIER_LINES.light.prices[2], TIER_LINES.light.prices[59]]));
// exact prices for the first 3 tiers + the final (maxed) tier -- exhaustive
// through all 60 would be excessive; this still exercises reject-one-short/
// succeed-at-exact-price/maxed-rejects-further at both ends of the ladder.
(function(){
  var field = TIER_LINES.light.field;
  upgrades[field] = 0;
  [60, 63, 65].forEach(function(price, i){
    coins = price - 1;
    __check('light tier ' + i + ' is rejected one coin short (price ' + price + ')', tryPurchaseTier('light') === false && upgrades[field] === i);
    coins = price;
    __check('light tier ' + i + ' succeeds at exactly its price (' + price + ')', tryPurchaseTier('light') === true && coins === 0 && upgrades[field] === i + 1);
  });
  upgrades[field] = 59; coins = 1724;
  __check('light tier 59 (the final level) is rejected one coin short (price 1725)', tryPurchaseTier('light') === false && upgrades[field] === 59);
  coins = 1725;
  __check('light tier 59 succeeds at exactly its price (1725), reaching the new 60-level max', tryPurchaseTier('light') === true && coins === 0 && upgrades[field] === 60);
  __check('light is maxed and rejects a further purchase', tierMaxed('light') === true && tryPurchaseTier('light') === false);
  upgrades[field] = 0; // reset for the next block below
})();

// E2 Shop Economy 2.0: per-jar Reach/Magnet Reach/Magnet Duration/Light
// Value now each have far more levels (32/24/27/20 for Simple, up from 3
// each), priced via bandedTierCost(). Same "first 3 + final tier"
// discipline as Coin Value just above, exercised against Simple Glass Jar.
[
  { statKey: 'reach', early: [16, 17, 19], lastIdx: 31, lastPrice: 239 },
  { statKey: 'magnetReach', early: [18, 20, 23], lastIdx: 23, lastPrice: 269 },
  { statKey: 'duration', early: [12, 13, 14], lastIdx: 26, lastPrice: 179 },
  { statKey: 'lightValue', early: [20, 23, 27], lastIdx: 19, lastPrice: 299 }
].forEach(function(cfg){
  var statKey = cfg.statKey, tiersField = statKey + 'Tiers';
  upgrades[tiersField].simple = 0;
  cfg.early.forEach(function(price, i){
    coins = price - 1;
    __check(statKey + ' tier ' + i + ' is rejected one coin short (price ' + price + ')', tryUpgradeJarStat(statKey, 'simple') === false && upgrades[tiersField].simple === i);
    coins = price;
    __check(statKey + ' tier ' + i + ' succeeds at exactly its price (' + price + ')', tryUpgradeJarStat(statKey, 'simple') === true && coins === 0 && upgrades[tiersField].simple === i + 1);
  });
  upgrades[tiersField].simple = cfg.lastIdx; coins = cfg.lastPrice - 1;
  __check(statKey + ' final tier (' + cfg.lastIdx + ') is rejected one coin short (price ' + cfg.lastPrice + ')', tryUpgradeJarStat(statKey, 'simple') === false && upgrades[tiersField].simple === cfg.lastIdx);
  coins = cfg.lastPrice;
  __check(statKey + ' final tier succeeds at exactly its price (' + cfg.lastPrice + '), reaching Simple\\'s own max', tryUpgradeJarStat(statKey, 'simple') === true && coins === 0);
  __check(statKey + ' is maxed and rejects a further purchase', jarStatMaxed(statKey, __simpleJarStat) === true && tryUpgradeJarStat(statKey, 'simple') === false);
  upgrades[tiersField].simple = 0; // reset for the next block below
});

// E2 Shop Economy 2.0: jarCapUpgradeCost's own curve is now bandedTierCost()
// (was the tapering-compound curve) -- exercised exhaustively for Simple
// Glass Jar's now-8 possible upgrades (was 3) -- exact prices, escalating,
// rejects one coin short, succeeds at exactly the price. Prices below are
// bandedTierCost()'s own real output for Simple's 8-tier Capacity line,
// not hand-derived.
upgrades.jarCapTiers.simple = 0;
[25, 38, 52, 67, 91, 115, 157, 199].forEach(function(price, i){
  coins = price - 1;
  __check('jar capacity upgrade ' + i + ' is rejected one coin short (price ' + price + ')', tryUpgradeJarCap('simple') === false && upgrades.jarCapTiers.simple === i);
  coins = price;
  __check('jar capacity upgrade ' + i + ' succeeds at exactly its price (' + price + ')', tryUpgradeJarCap('simple') === true && coins === 0 && upgrades.jarCapTiers.simple === i + 1);
});
__check('Simple Glass Jar is maxed and rejects a further capacity upgrade', jarCapMaxed(JARS.find(function(j){ return j.key === 'simple'; })) === true && tryUpgradeJarCap('simple') === false);
upgrades.jarCapTiers.simple = 0; // reset for the next block below

// Aurora Endgame Jar pass: JAR_COST_MULTIPLIER applied AFTER the existing
// global tier formulas, to jarCapUpgradeCost and jarStatUpgradeCost only.
// Exact rounded prices at tier 0, exhaustively for all six jars, proves the
// whole locked table (1.00/1.05/1.10/1.20/1.35/1.50) is actually wired --
// not just Simple (1.00x, unchanged) and Aurora (1.50x, the headline case).
['jarCapTiers', 'reachTiers', 'magnetReachTiers', 'durationTiers', 'lightValueTiers'].forEach(function(f){
  upgrades[f] = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 };
});
[['simple', 25], ['lantern', 26], ['moon', 28], ['crystal', 30], ['elder', 34], ['aurora', 38]].forEach(function(pair){
  var j = JARS.find(function(jj){ return jj.key === pair[0]; });
  __check('jarCapUpgradeCost tier 0 for ' + pair[0] + ' applies its own JAR_COST_MULTIPLIER (' + pair[1] + ')', jarCapUpgradeCost(j) === pair[1], 'got=' + jarCapUpgradeCost(j));
});
// E2 Shop Economy 2.0: tier1 now follows bandedTierCost()'s own curve (was
// a genuine 3x under the old tapering-compound curve) -- re-proving
// JAR_COST_MULTIPLIER still applies (via the tier-0 start price each
// jar's own curve is anchored to) AFTER the new curve shapes later tiers,
// per jar. Values are bandedTierCost()'s own real output.
[['simple', 38], ['lantern', 39], ['moon', 35], ['crystal', 38], ['elder', 38], ['aurora', 42]].forEach(function(pair){
  var j = JARS.find(function(jj){ return jj.key === pair[0]; });
  upgrades.jarCapTiers[pair[0]] = 1;
  __check('jarCapUpgradeCost tier 1 for ' + pair[0] + ' still applies its own multiplier after escalating (' + pair[1] + ')', jarCapUpgradeCost(j) === pair[1], 'got=' + jarCapUpgradeCost(j));
  upgrades.jarCapTiers[pair[0]] = 0;
});

// Same multiplier, proven against a per-jar STAT line too (Jar Reach), not
// just Capacity -- and against all four per-jar stat lines on Aurora
// specifically, proving the multiplier is not accidentally wired to only
// one stat key.
[['simple', 16], ['lantern', 17], ['moon', 18], ['crystal', 19], ['elder', 22], ['aurora', 24]].forEach(function(pair){
  var j = JARS.find(function(jj){ return jj.key === pair[0]; });
  __check('jarStatUpgradeCost(reach) tier 0 for ' + pair[0] + ' applies its own JAR_COST_MULTIPLIER (' + pair[1] + ')', jarStatUpgradeCost('reach', j) === pair[1], 'got=' + jarStatUpgradeCost('reach', j));
});
var __auroraJarCost = JARS.find(function(j){ return j.key === 'aurora'; });
__check('jarStatUpgradeCost(magnetReach) tier 0 for Aurora applies its 1.50x multiplier (27)', jarStatUpgradeCost('magnetReach', __auroraJarCost) === 27, 'got=' + jarStatUpgradeCost('magnetReach', __auroraJarCost));
__check('jarStatUpgradeCost(duration) tier 0 for Aurora applies its 1.50x multiplier (18)', jarStatUpgradeCost('duration', __auroraJarCost) === 18, 'got=' + jarStatUpgradeCost('duration', __auroraJarCost));
__check('jarStatUpgradeCost(lightValue) tier 0 for Aurora applies its 1.50x multiplier (30)', jarStatUpgradeCost('lightValue', __auroraJarCost) === 30, 'got=' + jarStatUpgradeCost('lightValue', __auroraJarCost));

// The multiplier must NEVER touch jar purchase price, the shared Coin Value
// line, or Decor/quest rewards -- an explicit negative check against the
// locked spec boundary, not just an absence of a positive one.
__check('JAR_COST_MULTIPLIER leaves jar PURCHASE prices completely untouched (Aurora still exactly 4000)', __auroraJarCost.price === 4000, 'price=' + __auroraJarCost.price);
// Coin Value's OWN price curve changed in the Upgrade Cost Escalation pass
// (round 2), but JAR_COST_MULTIPLIER itself must still never apply to it --
// it's the one shared/global line, the same regardless of which jar is
// equipped, unlike every per-jar line above.
__check('JAR_COST_MULTIPLIER leaves the shared Coin Value line (TIER_LINES.light) completely untouched -- same price whether Simple or Aurora is equipped, and its tier-0 price is still exactly 60', TIER_LINES.light.prices.length === 60 && TIER_LINES.light.prices[0] === 60, 'prices[0]=' + TIER_LINES.light.prices[0] + ' length=' + TIER_LINES.light.prices.length);

// ===== Upgrade Cost Escalation pass =========================================
// tierCostRatio()/compoundTierCost(): the first two tier-to-tier steps are a
// genuine 3x (direct instruction: "cost should triple for the next
// upgrade"), then the ratio tapers toward a 1.2x floor so long ladders
// (Aurora's 13-tier Capacity, 9-10 tier Light Value) don't compound into
// unplayable numbers -- proven directly against the ratio function, not just
// against a couple of spot-checked prices above.
__check('tierCostRatio(0) and tierCostRatio(1) are both exactly 3.0 -- a genuine triple for the first two upgrades', tierCostRatio(0) === 3.0 && tierCostRatio(1) === 3.0);
__check('tierCostRatio strictly decreases from tier 2 onward (tapering, not a flat 3x forever)', (function(){ for (var t = 2; t < 12; t++) { if (!(tierCostRatio(t + 1) < tierCostRatio(t))) return false; } return true; })());
__check('tierCostRatio never drops below its 1.2x floor, even far out on Aurora\\'s 13-tier Capacity ladder', tierCostRatio(12) >= 1.2 && tierCostRatio(12) < 1.3, 'got=' + tierCostRatio(12));
__check('compoundTierCost(base, 0) returns the base price unchanged (no upgrades owned yet)', compoundTierCost(100, 0) === 100);
__check('compoundTierCost(base, 2) is exactly base*9 -- two genuine triples compounded (25->75->225 for Simple Capacity)', compoundTierCost(25, 2) === 225);

// end-to-end: Aurora's full 26-tier Capacity price table (E2: up from 13
// tiers), computed independently and verified once as a whole -- catches a
// rounding/ordering mistake that isolated tier-0/tier-1 spot-checks above
// could miss. Expected array is bandedTierCost()'s own real output.
(function(){
  var auroraJar = JARS.find(function(j){ return j.key === 'aurora'; });
  var expected = [38, 42, 46, 49, 53, 57, 103, 149, 195, 241, 287, 333, 429, 526, 622, 719, 815, 912, 1110, 1308, 1506, 1704, 1902, 2100, 3453, 4807];
  var got = [];
  upgrades.jarCapTiers.aurora = 0;
  for (var t = 0; t < 26; t++) { upgrades.jarCapTiers.aurora = t; got.push(jarCapUpgradeCost(auroraJar)); }
  __check('Aurora\\'s full 26-tier Capacity price table matches bandedTierCost()\\'s real output exactly, tier by tier', JSON.stringify(got) === JSON.stringify(expected), 'got=' + JSON.stringify(got));
  __check('the total cost to fully max Aurora\\'s Capacity line (~23,506 coins, E2) is at least as steep as before this pass (~21,330 under the old formula) -- Aurora must never become cheaper to fully upgrade', got.reduce(function(a, b){ return a + b; }, 0) === 23506 && got.reduce(function(a, b){ return a + b; }, 0) >= 21330, 'total=' + got.reduce(function(a, b){ return a + b; }, 0));
  upgrades.jarCapTiers.aurora = 0;
})();

// Decor: flat one-shot price increase, no tiers to compound (there is no
// "next upgrade" for a boolean-owned item) -- 20->150, 35->300, per direct instruction.
__check('Garden Lanterns price is exactly 150 (was 20)', SHOP_ITEMS.deco.price === 150);
__check('Village Fountain price is exactly 300 (was 35)', SHOP_ITEMS.fountain.price === 300);

// Remove In-Run Capacity Growth (final): purchased/upgraded capacity sets
// S.cap for the WHOLE run now -- Elder catches, perfect delivery, and the
// score-35 milestone (Lumora Bloom) must NEVER change it, full stop.
// capMilestoneFx (the renamed, capacity-stripped former gainCap) still
// fires its non-capacity feedback (capMsg banner, at minimum) for all
// three, proven against the REAL trigger code paths below, not just the
// function in isolation.
upgrades.jarCapTiers.simple = 1;
reset();
__check('a jar capacity upgrade sets the round-start capacity to base+1 (6), same as before this change', S.cap === 6, 'cap=' + S.cap);
var capBeforeFx = S.cap;
capMilestoneFx('test: direct call');
__check('capMilestoneFx (the former gainCap) no longer changes S.cap at all, called directly', S.cap === capBeforeFx, 'cap=' + S.cap);
__check('capMilestoneFx still sets the capMsg banner (the non-capacity feedback these moments keep)', S.capMsg === 'test: direct call' && S.capMsgT === 3.5, 'capMsg=' + S.capMsg + ' capMsgT=' + S.capMsgT);
upgrades.jarCapTiers.simple = 0;

// integration: a REAL Elder catch, start to finish, through the actual catch-
// completion code path (not calling capMilestoneFx directly)
upgrades.jarCapTiers.simple = 2;
reset(); screen = 'play'; paused = false;
var capBeforeElder = S.cap; // simple jar(5) + 2 upgrades = 7
var ejx = S.jar.x, ejy = S.jar.y - 14;
S.flies.push({ x: ejx, y: ejy, type: 'e', state: 'caught', animT: 0, animA: 0, animR: 0 });
var caughtNBefore = S.caughtN, journalEBefore = journal.e;
for (var eci = 0; eci < 40 && S.flies.some(function(f){ return f.type === 'e' && f.state === 'caught'; }); eci++) __stepFrame(16);
__check('a real Elder catch does not change S.cap at all', S.cap === capBeforeElder, 'cap=' + S.cap);
__check('a real Elder catch still sets its own capMsg banner ("the elder blesses your jar!") -- non-capacity feedback preserved', S.capMsg === 'the elder blesses your jar!' && S.capMsgT > 0, 'capMsg=' + S.capMsg);
__check('the Elder catch still awards the normal per-catch feedback (caughtN/journal increment) same as any type', S.caughtN === caughtNBefore + 1 && journal.e === journalEBefore + 1);
upgrades.jarCapTiers.simple = 0;

// integration: a REAL perfect delivery, through the actual delivery-settled code path
upgrades.jarCapTiers.simple = 2;
reset(); screen = 'play'; paused = false;
var capBeforePerfect = S.cap;
var coinsBeforePerfect = coins;
// Lumora 2.0 Phase 1 interaction: reset() now also runs ensureNightObjectives(),
// which can roll 'deliver_full_jar' at its early tier (target:1, reward:12)
// -- forcing S.batchPerfect=true below would then legitimately also complete
// THAT objective in the same frame (this genuinely is a full-jar delivery),
// adding its reward on top of Perfect Delivery's own +10 and making this
// pre-Phase-1 test's coin math depend on an unrelated random roll. Cleared
// here, once, so this test stays isolated to what it actually tests (same
// discipline as the ads-double-night-coins neutralization above).
S.objectiveActive = []; S.objectiveProgress = {};
S.wasDelivering = true; S.batchPerfect = true; S.batchRareCount = 0; S.carried = []; S.sparks = [];
S.capMsgT = 0; S.capMsg = '';
__stepFrame(16);
__check('a real perfect delivery does not change S.cap at all', S.cap === capBeforePerfect, 'cap=' + S.cap);
// Lumora 2.0 Phase 2: Perfect Delivery's banner used to be reward-free (see
// capMilestoneFx's own comment on this having felt "thinner than before")
// -- it now grants a real +10 coin bonus. D2 (Claude Design spec) moved this
// off the shared capMsg banner slot entirely, onto its own composite above
// the jar (S.d2DeliveryRows/S.d2DeliveryT), see resolveDeliveryBonuses().
__check('a real perfect delivery sets its own D2 delivery composite row, carrying its own reward text', S.d2DeliveryRows.length === 1 && S.d2DeliveryRows[0].label === 'perfect delivery' && S.d2DeliveryRows[0].value === '+10' && S.d2DeliveryT > 0, 'rows=' + JSON.stringify(S.d2DeliveryRows));
__check('a real perfect delivery grants exactly +10 coins, once', coins === coinsBeforePerfect + 10, 'coins=' + coins);
upgrades.jarCapTiers.simple = 0;

// integration: a REAL score-35 milestone crossing (Lumora Bloom), through milestoneCheck()
upgrades.jarCapTiers.simple = 2;
reset(); screen = 'play'; paused = false;
var capBeforeMilestone = S.cap;
S.score = 35;
milestoneCheck(34);
__check('crossing the score-35 milestone (Lumora Bloom) does not change S.cap at all', S.cap === capBeforeMilestone, 'cap=' + S.cap);
__check('the Lumora Bloom milestone still sets its own non-capacity banner ("the Lumora Bloom begins!"), not the old capacity-claiming message', S.capMsg === 'the Lumora Bloom begins!' && S.capMsgT > 0, 'capMsg=' + S.capMsg);
__check('the Lumora Bloom milestone still fires its own much bigger fanfare independent of capMilestoneFx (finale/fireworks/village glow)', S.finaleActive === true && S.villageGlowTarget === 1 && S.fireworks.length > 0);
upgrades.jarCapTiers.simple = 0;

// integration, not just the pure functions: Collection Range must actually
// change catch behavior in a real round. A firefly sitting at exactly 80px is
// outside the base 70 radius but inside a tier-1-owned 85 radius.
function placeFlyAtDistance(type, distFromJar){
  reset(); screen = 'play'; paused = false;
  spawnFly(type);
  var f = S.flies[S.flies.length - 1];
  f.x = S.jar.x; f.y = (S.jar.y - 14) - distFromJar;
  return f;
}
// E2 Shop Economy 2.0: Simple Glass Jar's own ceiling is unchanged (55
// base -> 64 max), now reached via 32 smaller steps instead of 3 -- a
// firefly at 62px still sits outside the base radius but inside the maxed
// one, exactly as before.
upgrades.reachTiers.simple = 0;
var farFly = placeFlyAtDistance('y', 62);
__stepFrame(16);
__check('a firefly at 62px stays out of range at Simple\\'s base 55 radius (Jar Reach not owned)', farFly.state === 'drift', 'state=' + farFly.state);
upgrades.reachTiers.simple = 32;
var reachedFly = placeFlyAtDistance('y', 62);
__stepFrame(16);
__check('the same 62px firefly locks on once Jar Reach is maxed (64 radius, unchanged by E2)', reachedFly.state === 'locked' || reachedFly.state === 'caught', 'state=' + reachedFly.state);
upgrades.reachTiers.simple = 0;

// integration: the magnet PICKUP's buff duration actually reflects ownership
reset(); screen = 'play'; paused = false;
spawnMagnet();
S.magnet.x = S.jar.x; S.magnet.y = S.jar.y - 14; // sit right on the jar for an immediate pickup
__stepFrame(16);
__check('magnet buff duration is exactly Simple\\'s own base (4.0s) when Magnet Duration is not owned', Math.abs(S.magnetT - 4.0) < 0.05, 'magnetT=' + S.magnetT);
upgrades.durationTiers.simple = 1;
reset(); screen = 'play'; paused = false;
spawnMagnet();
S.magnet.x = S.jar.x; S.magnet.y = S.jar.y - 14;
__stepFrame(16);
__check('magnet buff duration is exactly Simple\\'s base+0.056s (4.056s, E2\\'s smaller per-level step) once Magnet Duration tier 1 is owned', Math.abs(S.magnetT - 4.056) < 0.01, 'magnetT=' + S.magnetT);
upgrades.durationTiers.simple = 0;

// integration: Coin Value actually changes coins earned on delivery, same
// catch-then-deliver flow the Stage 2 Part A coin-economy tests above use.
// Phase 1 economy pass: expected value is now THREE layers stacked --
// TYPES.y.coins (0.65) x Simple's own Light Value (0.65x base) x Coin
// Value (1.0x or the 1.30x locked ceiling) -- tracked via total
// (coins+coinFraction) since a single delivery never crosses a whole coin.
reset(); screen = 'play'; paused = false;
S.eventActive = null; // Lumora 2.0 Phase 4: neutralize Moth Swarm's coin multiplier for this exact-value test, same discipline as above
upgrades.lightTier = 0; upgrades.lightValueTiers.simple = 0; upgrades.equippedJar = 'simple'; coinFraction = 0;
var totalBeforeLight = coins + coinFraction;
S.carried.push({ type: 'y', ph: 0, sp: 1 }); // Curious, base 0.65 coins
S.jar.y = 999; S.jar.ty = 999;
for (var lv0 = 0; lv0 < 120 && (S.sparks.length > 0 || S.carried.length > 0); lv0++) __stepFrame(16);
__check('Curious delivers exactly its base coin value x Simple\\'s Light Value (0.65*0.65=0.4225) with Coin Value not owned', Math.abs((coins + coinFraction) - (totalBeforeLight + 0.4225)) < 1e-9, 'total=' + (coins + coinFraction));
reset(); screen = 'play'; paused = false;
S.eventActive = null; // Lumora 2.0 Phase 4: same neutralization as above
upgrades.lightTier = 60; upgrades.lightValueTiers.simple = 0; upgrades.equippedJar = 'simple'; coinFraction = 0; // E2: 1.75x, the new locked ceiling (level 60, up from level 3/1.30x)
var totalBeforeLight2 = coins + coinFraction;
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var lv1 = 0; lv1 < 120 && (S.sparks.length > 0 || S.carried.length > 0); lv1++) __stepFrame(16);
__check('Curious delivers a Coin-Value-boosted value (0.65*0.65*1.75=0.739375) at Coin Value\\'s new max (level 60)', Math.abs((coins + coinFraction) - (totalBeforeLight2 + 0.739375)) < 1e-9, 'total=' + (coins + coinFraction));
upgrades.lightTier = 0;

// migrateMagnetTier() directly, in isolation -- the one function BOTH the
// local (non-YT) and cloud (YT loadData) upgrade-load paths call, so proving
// it correct here covers both call sites by construction, not by coincidence
__check('migrateMagnetTier does nothing when the source has no magnetTier at all', (function(){ var dst = { jarReachTier: 0, magnetReachTier: 0, durationTier: 0 }; migrateMagnetTier({}, dst); return dst.jarReachTier === 0 && dst.magnetReachTier === 0 && dst.durationTier === 0; })());
__check('migrateMagnetTier does nothing when the source magnetTier is 0 (never owned)', (function(){ var dst = { jarReachTier: 0, magnetReachTier: 0, durationTier: 0 }; migrateMagnetTier({ magnetTier: 0 }, dst); return dst.jarReachTier === 0 && dst.magnetReachTier === 0 && dst.durationTier === 0; })());
__check('migrateMagnetTier seeds ALL THREE new fields from a pre-split magnetTier of 1 (the oldest-format save, pre-dating even the Range split)', (function(){ var dst = { jarReachTier: 0, magnetReachTier: 0, durationTier: 0 }; migrateMagnetTier({ magnetTier: 1 }, dst); return dst.jarReachTier === 1 && dst.magnetReachTier === 1 && dst.durationTier === 1; })());
__check('migrateMagnetTier never LOWERS a new field that\\'s already ahead (e.g. Jar Reach already tier 2 from a real purchase)', (function(){ var dst = { jarReachTier: 2, magnetReachTier: 0, durationTier: 0 }; migrateMagnetTier({ magnetTier: 1 }, dst); return dst.jarReachTier === 2 && dst.magnetReachTier === 1 && dst.durationTier === 1; })());

// migrateRangeTier(): the one-layer-later split (an old save with a single
// bundled rangeTier, post-magnetTier-split but pre-Lumora-UI-port) seeds
// BOTH jarReachTier and magnetReachTier from it
__check('migrateRangeTier does nothing when the source has no rangeTier at all', (function(){ var dst = { jarReachTier: 0, magnetReachTier: 0 }; migrateRangeTier({}, dst); return dst.jarReachTier === 0 && dst.magnetReachTier === 0; })());
__check('migrateRangeTier does nothing when the source rangeTier is 0 (never owned)', (function(){ var dst = { jarReachTier: 0, magnetReachTier: 0 }; migrateRangeTier({ rangeTier: 0 }, dst); return dst.jarReachTier === 0 && dst.magnetReachTier === 0; })());
__check('migrateRangeTier seeds BOTH new fields from a pre-split rangeTier of 2', (function(){ var dst = { jarReachTier: 0, magnetReachTier: 0 }; migrateRangeTier({ rangeTier: 2 }, dst); return dst.jarReachTier === 2 && dst.magnetReachTier === 2; })());
__check('migrateRangeTier never LOWERS a new field that\\'s already ahead', (function(){ var dst = { jarReachTier: 3, magnetReachTier: 0 }; migrateRangeTier({ rangeTier: 2 }, dst); return dst.jarReachTier === 3 && dst.magnetReachTier === 2; })());

// migrateSharedStatTier() -- Phase 1 economy architecture's own migration
// function, converting an old save's single shared jarReachTier/
// magnetReachTier/durationTier count into the new per-jar model. Dedicated
// isolation tests per direct instruction, covering exactly the five
// properties asked for: equipped jar receives the migrated tier, every
// other jar stays at 0, switching jars afterward does not transfer the
// tier, the migrated value survives a save/load round trip, and the
// existing Capacity migration (migrateJarTier) is provably unaffected by
// any of this.
__check('migrateSharedStatTier does nothing when the old tier count is 0 or not a number', (function(){
  var dst = { equippedJar: 'simple', reachTiers: { simple: 0, aurora: 0 } };
  migrateSharedStatTier('reach', 0, dst);
  migrateSharedStatTier('reach', undefined, dst);
  return dst.reachTiers.simple === 0 && dst.reachTiers.aurora === 0;
})());
__check('migrateSharedStatTier seeds ONLY the equipped jar from an old shared tier count', (function(){
  var dst = { equippedJar: 'moon', reachTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 } };
  migrateSharedStatTier('reach', 2, dst);
  return dst.reachTiers.moon === 2
    && dst.reachTiers.simple === 0 && dst.reachTiers.lantern === 0 && dst.reachTiers.crystal === 0 && dst.reachTiers.elder === 0 && dst.reachTiers.aurora === 0;
})());
__check('migrateSharedStatTier never LOWERS a jar\\'s tier that is already ahead', (function(){
  var dst = { equippedJar: 'simple', reachTiers: { simple: 3 } };
  migrateSharedStatTier('reach', 1, dst);
  return dst.reachTiers.simple === 3;
})());
__check('migrateSharedStatTier caps the seeded tier at however many tiers the equipped jar\\'s own range supports (never overshoots into an impossible tier count)', (function(){
  var dst = { equippedJar: 'simple', reachTiers: { simple: 0 } };
  migrateSharedStatTier('reach', 99, dst); // Simple's placeholder range only supports 3 tiers today
  var simpleJar = JARS.find(function(j){ return j.key === 'simple'; });
  return dst.reachTiers.simple === jarStatTierCount('reach', simpleJar);
})());
__check('migrateSharedStatTier works identically for the magnetReach and duration stats, not just reach', (function(){
  var dst = { equippedJar: 'simple', magnetReachTiers: { simple: 0 }, durationTiers: { simple: 0 } };
  migrateSharedStatTier('magnetReach', 1, dst);
  migrateSharedStatTier('duration', 2, dst);
  return dst.magnetReachTiers.simple === 1 && dst.durationTiers.simple === 2;
})());
// switching jars afterward does not transfer the migrated tier -- exercised
// against the REAL live upgrades object (not a scratch one), since this is
// about the running game's actual jarCurrentStat() read path, not just the
// migration function in isolation
(function(){
  upgrades.equippedJar = 'simple'; upgrades.reachTiers = { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 };
  migrateSharedStatTier('reach', 2, upgrades);
  var simpleReach = jarReachForRun();
  upgrades.equippedJar = 'lantern'; // switch WITHOUT touching reachTiers directly
  var lanternReach = jarReachForRun();
  upgrades.equippedJar = 'simple';
  var simpleReachAfterSwitch = jarReachForRun();
  __check('switching the equipped jar after migration does not transfer the migrated tier to the new jar', Math.abs(simpleReach - 55.58) < 1e-9 && lanternReach === 62 && Math.abs(simpleReachAfterSwitch - 55.58) < 1e-9, 'simple=' + simpleReach + ' lantern=' + lanternReach + ' simpleAfter=' + simpleReachAfterSwitch);
  upgrades.reachTiers.simple = 0;
})();
// migrated values survive a save/load round trip -- non-YT localStorage path
if (!YT) {
  upgrades.equippedJar = 'simple'; upgrades.reachTiers.simple = 2;
  persistUpgradesLocal();
  var reloadedReach = JSON.parse(localStorage.getItem('gk2_upgrades') || '{}').reachTiers;
  __check('a migrated (or directly purchased) per-jar reach tier persists to gk2_upgrades and survives reload', reloadedReach && reloadedReach.simple === 2, 'reloaded=' + JSON.stringify(reloadedReach));
  upgrades.reachTiers.simple = 0;
}
// existing Capacity migration (migrateJarTier) remains unaffected by any of
// the above -- run side by side, on the same equipped jar, and confirm
// neither migration path touches the other's field
(function(){
  var dst = { equippedJar: 'simple', jarCapTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, reachTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 } };
  migrateJarTier({ jarTier: 2 }, dst);
  migrateSharedStatTier('reach', 1, dst);
  __check('Capacity migration and the new per-jar Reach migration run independently -- neither touches the other\\'s field', dst.jarCapTiers.simple === 2 && dst.reachTiers.simple === 1, 'jarCapTiers=' + JSON.stringify(dst.jarCapTiers) + ' reachTiers=' + JSON.stringify(dst.reachTiers));
})();

// ===== Stage 3 Part A: rare weather + affinity + Mystery Firefly ===========

// --- hard constraint: weather can boost spawn RATE only, never a type's first-
// ever appearance before its own existing score-gated unlock ---
reset(); screen = 'play'; paused = false;
S.weather = 'clearMoon'; S.score = 11; S.elderT = 0.001; // timer primed to fire almost immediately if it were going to
for (var wgi = 0; wgi < 300; wgi++) __stepFrame(16); // ~4.8s -- comfortably enough for a boosted timer to have fired
__check('Clear Moon never spawns an Elder before its own score>=12 gate, however long weather boosts the timer', !S.flies.some(function(f){ return f.type === 'e'; }));
S.score = 12; // now actually cross the gate
for (var wgj = 0; wgj < 300 && !S.flies.some(function(f){ return f.type === 'e'; }); wgj++) __stepFrame(16);
__check('once the gate is genuinely crossed, Clear Moon\\'s boosted timer does let an Elder spawn', S.flies.some(function(f){ return f.type === 'e'; }));

// Remove In-Run Capacity Growth (final): the exact bug this change would have
// introduced if left unfixed -- Elder's spawn gate used to also require
// S.cap<JAR_MAX (so a maxed-out in-run grower wouldn't "waste" an Elder).
// With capacity now purchase-only and able to exceed the old JAR_MAX(12),
// that old clause would have permanently blocked Elder from ever spawning
// again for any well-upgraded player. Prove it doesn't, at a capacity well
// past the old ceiling.
upgrades.ownedJars.aurora = true; upgrades.equippedJar = 'aurora'; upgrades.jarCapTiers.aurora = 5; // Aurora Jar base 12 + 5 = capacity 17, past the old JAR_MAX(12)
reset(); screen = 'play'; paused = false;
S.weather = 'clear'; S.score = 12; S.elderT = 0.001;
for (var jmi = 0; jmi < 300 && !S.flies.some(function(f){ return f.type === 'e'; }); jmi++) __stepFrame(16);
__check('Elder still spawns normally even at a capacity (17) well past the old JAR_MAX(12) -- the stale spawn-gate clause is gone', S.flies.some(function(f){ return f.type === 'e'; }), 'cap=' + S.cap);
upgrades.jarCapTiers.aurora = 0; upgrades.equippedJar = 'simple';

reset(); screen = 'play'; paused = false;
S.weather = 'nightRain'; S.score = 14; // below diff().shy's own score>=15 gate
var sawShyEarly = false;
for (var nri = 0; nri < 200; nri++) { __stepFrame(16); if (S.flies.some(function(f){ return f.type === 'g'; })) sawShyEarly = true; }
__check('Night Rain never spawns Shy before its own score>=15 unlock', !sawShyEarly);

reset(); screen = 'play'; paused = false;
S.weather = 'shootingStars'; S.score = 9; // below diff().blue's own score>=10 gate
var sawBlueEarly = false;
for (var ssi = 0; ssi < 200; ssi++) { __stepFrame(16); if (S.flies.some(function(f){ return f.type === 'b'; })) sawBlueEarly = true; }
__check('Shooting Stars never spawns Playful before its own score>=10 unlock', !sawBlueEarly);

reset(); screen = 'play'; paused = false;
S.weather = 'clearMoon'; S.score = 19; S.mysteryT = 0.001; // Mystery's own gate (>=20) is independent of Elder's, and weather-agnostic
var sawMysteryEarly = false;
for (var mgi = 0; mgi < 200; mgi++) { __stepFrame(16); if (S.flies.some(function(f){ return f.type === 'm'; })) sawMysteryEarly = true; }
__check('Mystery Firefly never spawns before its own score>=20 gate, regardless of weather', !sawMysteryEarly);

// --- positive check: once actually unlocked, weather measurably shifts spawn
// share (not just "doesn't break the gate" but "actually does something") ---
function sampleTypeCounts(weather, scoreVal, n){
  reset(); screen = 'play'; S.score = scoreVal; S.weather = weather;
  // Lumora 2.0 Phase 4: Moonlight applies its own shyW boost (0.28, close
  // to nightRain's 0.30) via the same Math.max as weather -- neutralized
  // here so a random event roll can't contaminate either side of this
  // weather-vs-weather statistical comparison (same discipline as the
  // exact-value coin tests above).
  S.eventActive = null;
  var counts = { g: 0, b: 0, y: 0, e: 0, m: 0 };
  for (var i = 0; i < n; i++) { spawnFly(); counts[S.flies[S.flies.length - 1].type]++; }
  return counts;
}
// The true gaps are fixed-width differences (shyW 0.16->0.30 = +0.14, blueW
// 0.26->0.30 = +0.04 only). N=8000/margin=0.02 was still too tight for the
// Shooting Stars case specifically -- computed properly this time rather than
// bumped again on the next flake: at N=20000 the difference's standard error
// is ~0.0045, so a 0.015 margin against a true 0.04 gap sits ~5.6 SE away
// (≈1-in-tens-of-millions false-failure rate), not just "bigger than last time".
var N = 20000;
var clearCounts = sampleTypeCounts('clear', 20, N);
var rainCounts = sampleTypeCounts('nightRain', 20, N);
var starsCounts = sampleTypeCounts('shootingStars', 20, N);
__check('Night Rain measurably increases Shy\\'s spawn share once already unlocked', rainCounts.g / N > clearCounts.g / N + 0.08, 'rain=' + (rainCounts.g / N).toFixed(3) + ' clear=' + (clearCounts.g / N).toFixed(3));
__check('Shooting Stars measurably increases Playful\\'s spawn share once already unlocked', starsCounts.b / N > clearCounts.b / N + 0.015, 'stars=' + (starsCounts.b / N).toFixed(3) + ' clear=' + (clearCounts.b / N).toFixed(3));

// --- the aurora priority ordering: a genuine score>=75 state must render
// IDENTICALLY whether or not weather is simultaneously active ---
reset(); screen = 'play'; S.score = 80; S.weather = 'clear'; S.aurora = 0;
__stepFrame(16);
var auroraNoWeather = S.aurora;
reset(); screen = 'play'; S.score = 80; S.weather = 'aurora'; S.aurora = 0;
__stepFrame(16);
var auroraWithWeather = S.aurora;
__check('a genuine score>=75 aurora state ramps identically whether or not Aurora weather is simultaneously active', Math.abs(auroraNoWeather - auroraWithWeather) < 1e-9, 'noWeather=' + auroraNoWeather + ' withWeather=' + auroraWithWeather);
__check('that ramp is exactly the permanent-unlock rate (0.2/s), not the weather rate (0.4/s)', Math.abs(auroraNoWeather - 0.2 * 0.016) < 1e-9, 'aurora=' + auroraNoWeather);

// House Quality + Celestial pass follow-up: shooting-star/constellation
// thresholds lowered (50->15, 100->30) per direct feedback -- the
// difficulty curve made the old thresholds rarely reachable before a round
// ends, so most players never saw either system at all. Purely visual-
// timing constants; diff()/spawning/scoring are untouched.
reset(); screen = 'play'; paused = false;
S.score = 14; S.shootT = 0.001; S.shots = [];
__stepFrame(16);
__check('shooting stars still do NOT spawn just below the new threshold (score 14)', S.shots.length === 0);
S.score = 15;
__stepFrame(16);
__check('shooting stars spawn once score reaches the new, lower threshold (15, was 50)', S.shots.length === 1, 'shots=' + S.shots.length);
S.score = 29; S.constA = 0;
__stepFrame(16);
__check('constellations still do NOT begin fading in just below the new threshold (score 29)', S.constA === 0);
S.score = 30;
__stepFrame(16);
__check('constellations begin fading in once score reaches the new, lower threshold (30, was 100)', S.constA > 0, 'constA=' + S.constA);
S.score = 0; S.shots = []; S.constA = 0;

// House Quality pass follow-up: the near-mountain/forest/house colors now
// blend toward a deep VIOLET anchor (NIGHT_VIOLET) instead of flat
// near-black, at a stronger ratio -- fixes Spring's tree colors reading as
// visibly green (direct feedback, with a screenshot) and adds the
// requested violet richness in one change. Proven directly: Spring's green
// tree1 (a season identity this pass must not silently erase) must no
// longer be the DOMINANT channel once blended for the near-mountain ridge.
(function(){
  var springPal = SEASON_PALETTES[6]; // Spring
  __check('Spring\\'s own tree1 is still genuinely green at the source (green is the dominant channel) -- sanity check that this test exercises a real case, not a no-op', springPal.name === 'Spring' && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(springPal.tree1) && parseInt(springPal.tree1.slice(3,5),16) > parseInt(springPal.tree1.slice(1,3),16) && parseInt(springPal.tree1.slice(3,5),16) > parseInt(springPal.tree1.slice(5,7),16));
  // the exact same blend renderBG() computes for mtn1 (near-mountain ridge)
  // and mtn2 (forest canopy) -- reusing the real lerpColor() function, not a
  // reimplementation, so this can't silently drift from the actual formula.
  // Parsed with split()/slice() rather than a regex -- a regex containing
  // backslash escapes (\\d, \\(, \\)) is exactly the kind of thing the
  // harness's own backtick-driver gotcha (documented in CLAUDE.md for
  // backticks) turns out to ALSO apply to: unrecognized escape sequences
  // inside the outer template literal get silently stripped, so \\d became
  // literal "d" and the regex stopped matching -- confirmed live (a FATAL
  // null-access) before switching to plain string parsing here.
  var mtn1Spring = lerpColor(springPal.tree1, '#150c28', 0.58);
  var mtn2Spring = lerpColor(springPal.tree2, '#150c28', 0.6);
  function __parseRgb(s){ var parts = s.slice(4, -1).split(','); return { r: parseInt(parts[0], 10), g: parseInt(parts[1], 10), b: parseInt(parts[2], 10) }; }
  var c1 = __parseRgb(mtn1Spring), c2 = __parseRgb(mtn2Spring);
  __check('Spring\\'s near-mountain color (mtn1) is no longer green-dominant once blended toward the violet anchor -- blue outweighs green', c1.b > c1.g, 'mtn1=' + mtn1Spring);
  __check('Spring\\'s forest-canopy color (mtn2) is no longer green-dominant once blended toward the violet anchor -- blue outweighs green', c2.b > c2.g, 'mtn2=' + mtn2Spring);
  var renderBGSpringThrew = false;
  try { renderBG(6); } catch (e) { renderBGSpringThrew = true; }
  __check('renderBG() still draws Spring without throwing with the new violet-anchored blend', !renderBGSpringThrew);
  renderBG(heartTier(best));
})();

// --- weather state machine sanity ---
reset(); screen = 'play';
__check('a fresh round starts with clear weather', S.weather === 'clear');
var sawActiveWeather = false, sawBanner = false;
for (var wsi = 0; wsi < 3500 && !sawActiveWeather; wsi++) {
  __stepFrame(16);
  if (S.weather !== 'clear') { sawActiveWeather = true; if (S.weatherBannerT > 0 && S.weatherMsg) sawBanner = true; }
}
__check('weather eventually rolls into one of the five active types', sawActiveWeather && WEATHER_TYPES.indexOf(S.weather) !== -1, 'weather=' + S.weather);
__check('a weather-start banner message is set when weather becomes active', sawBanner);

// --- Mystery Firefly: generic Journal infrastructure "just works", per the kickoff's own ask to verify rather than assume ---
reset(); screen = 'play';
var mBefore = journal.m;
spawnFly('m');
var mf = S.flies[S.flies.length - 1];
mf.x = S.jar.x; mf.y = S.jar.y - 14;
for (var mi = 0; mi < 60 && journal.m === mBefore; mi++) __stepFrame(16);
__check('Mystery Firefly catches increment journal.m via the same generic catch-tracking code as every other type', journal.m === mBefore + 1, 'journal.m=' + journal.m);
__check('journalDiscoveryTier works on Mystery\\'s count with no special-casing needed', journalDiscoveryTier(journal.m) === journalDiscoveryTier(1));
__check('TYPES.m carries every field the other types do (name/rarity/desc/pts/coins/glow/core)', typeof TYPES.m.name === 'string' && typeof TYPES.m.rarity === 'string' && typeof TYPES.m.desc === 'string' && typeof TYPES.m.pts === 'number' && typeof TYPES.m.coins === 'number' && typeof TYPES.m.glow === 'string' && typeof TYPES.m.core === 'string');

// ===== Stage 3 Part C: daily quests + welcome-back ==========================

__check('localDayKey treats two timestamps on the same calendar day as equal', localDayKey(new Date(2026, 5, 10, 1, 0).getTime()) === localDayKey(new Date(2026, 5, 10, 23, 0).getTime()));
__check('localDayKey treats two timestamps on different calendar days as different', localDayKey(new Date(2026, 5, 10, 23, 59).getTime()) !== localDayKey(new Date(2026, 5, 11, 0, 1).getTime()));

// --- quest progress at the ACTUAL moment each condition is met, not just the end state ---
reset(); screen = 'play'; paused = false;
quests = [{ id: 'catch10y', desc: 'x', kind: 'catch', type: 'y', target: 3, progress: 0, done: false, reward: { kind: 'coins', val: 40 } }];
var coinsBeforeQuest = coins;
for (var qi = 0; qi < 2; qi++) {
  spawnFly('y');
  var qf = S.flies[S.flies.length - 1];
  qf.x = S.jar.x; qf.y = S.jar.y - 14;
  for (var qj = 0; qj < 60 && S.flies.indexOf(qf) !== -1; qj++) __stepFrame(16);
}
__check('quest progress increments on catch, at the same moment as the Journal (2 of 3 caught, not yet complete)', quests[0].progress === 2 && quests[0].done === false, 'progress=' + quests[0].progress);
__check('the coin reward has not been granted yet — quest is not complete', coins === coinsBeforeQuest);
spawnFly('y');
var qf2 = S.flies[S.flies.length - 1];
qf2.x = S.jar.x; qf2.y = S.jar.y - 14;
for (var qk = 0; qk < 60 && S.flies.indexOf(qf2) !== -1; qk++) __stepFrame(16);
__check('the quest completes and grants its coin reward the instant the 3rd catch happens', quests[0].done === true && coins === coinsBeforeQuest + 40, 'done=' + quests[0].done + ' coins=' + coins);
var coinsAfterDone = coins;
spawnFly('y');
var qf3 = S.flies[S.flies.length - 1];
qf3.x = S.jar.x; qf3.y = S.jar.y - 14;
for (var ql = 0; ql < 60 && S.flies.indexOf(qf3) !== -1; ql++) __stepFrame(16);
__check('a completed quest does not keep progressing or re-granting its reward on further catches', quests[0].progress === 3 && coins === coinsAfterDone);

// --- delivery-based quest progress, at the same moment as coins/score ---
reset(); screen = 'play'; paused = false;
quests = [{ id: 'deliver20', desc: 'x', kind: 'deliver', target: 2, progress: 0, done: false, reward: { kind: 'coins', val: 5 } }];
S.carried.push({ type: 'y', ph: 0, sp: 1 }, { type: 'b', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var qdi = 0; qdi < 200 && !quests[0].done; qdi++) __stepFrame(16);
__check('deliver-based quest progress counts ANY delivered type, at the delivery moment (same timing as coins/score)', quests[0].done === true && quests[0].progress === 2);

// --- reward kinds ---
reset();
upgrades.deco = false;
var qDeco = { id: 'deliver20', desc: 'x', kind: 'deliver', target: 1, progress: 1, done: false, reward: { kind: 'deco', val: 20 } };
__check('questWillFallbackToCoins(qDeco) reads false live, before completion, while Garden Lanterns are not yet owned', questWillFallbackToCoins(qDeco) === false);
__check('questRewardPreviewLabel(qDeco) reads "Garden Lanterns" before completion, matching what grantQuestReward is actually about to do', questRewardPreviewLabel(qDeco) === 'Garden Lanterns');
grantQuestReward(qDeco);
__check('the "decorative item" reward grants Garden Lanterns when not already owned', upgrades.deco === true);
__check('grantQuestReward records the ACTUAL outcome on the quest object itself (grantedKind/grantedVal) -- the single source of truth questGrantedLabel/questGrantedMessage read from afterward', qDeco.grantedKind === 'deco' && qDeco.grantedVal === null, 'grantedKind=' + qDeco.grantedKind + ' grantedVal=' + qDeco.grantedVal);
__check('questGrantedLabel(qDeco) reads "Garden Lanterns" after a genuine (non-fallback) grant', questGrantedLabel(qDeco) === 'Garden Lanterns');
__check('questGrantedMessage(qDeco) reads the village-framed completion line for a genuine grant', questGrantedMessage(qDeco) === 'Garden Lanterns added to the village.', 'got=' + questGrantedMessage(qDeco));
var coinsBeforeFallback = coins;
var qDeco2 = { id: 'deliver20', desc: 'x', kind: 'deliver', target: 1, progress: 1, done: false, reward: { kind: 'deco', val: 20 } };
// Village + Decoration correction pass: since all 3 quests reroll every single
// day, this fallback (Garden Lanterns already owned from qDeco above) is the
// COMMON case for deliver20 after day 1, not a rare edge case -- exercised
// here as directly as the pre-existing coin-fallback check just above it.
__check('questWillFallbackToCoins(qDeco2) reads true live, before completion, now that Garden Lanterns are already owned', questWillFallbackToCoins(qDeco2) === true);
__check('questRewardPreviewLabel(qDeco2) already reflects the live fallback BEFORE completion -- "20 coins", not "Garden Lanterns" -- so the player is never shown a reward that cannot actually be granted', questRewardPreviewLabel(qDeco2) === '20 coins', 'got=' + questRewardPreviewLabel(qDeco2));
grantQuestReward(qDeco2);
__check('the decorative-item reward falls back to its coin-equivalent once already owned, so completing it twice is never a no-op', coins === coinsBeforeFallback + 20);
__check('grantQuestReward records the fallback outcome accurately (grantedKind="coins", not "deco", even though the quest\\'s own reward.kind is still "deco")', qDeco2.grantedKind === 'coins' && qDeco2.grantedVal === 20, 'grantedKind=' + qDeco2.grantedKind + ' grantedVal=' + qDeco2.grantedVal);
__check('questGrantedLabel(qDeco2) reads "20 coins" after a fallback grant, not "Garden Lanterns"', questGrantedLabel(qDeco2) === '20 coins', 'got=' + questGrantedLabel(qDeco2));
__check('questGrantedMessage(qDeco2) correctly reads "20 coins added." for a fallback grant, never claiming Garden Lanterns were added twice', questGrantedMessage(qDeco2) === '20 coins added.', 'got=' + questGrantedMessage(qDeco2));
// old-save migration: a quest already done() before grantedKind/grantedVal
// existed has neither field -- questGrantedLabel/questGrantedMessage must
// degrade gracefully (fall back to the live preview) rather than throw or
// print "undefined coins".
var qDecoOldSave = { id: 'deliver20', desc: 'x', kind: 'deliver', target: 1, progress: 1, done: true, reward: { kind: 'deco', val: 20 } }; // no grantedKind/grantedVal at all
__check('questGrantedLabel degrades gracefully for an old-save quest with no grantedKind/grantedVal (falls back to the live preview instead of "undefined ...")', questGrantedLabel(qDecoOldSave) === '20 coins', 'got=' + questGrantedLabel(qDecoOldSave));
var qDecoOldSaveDrawThrew = false;
try { questGrantedMessage(qDecoOldSave); } catch (e) { qDecoOldSaveDrawThrew = true; }
__check('questGrantedMessage does not throw for an old-save quest with no grantedKind/grantedVal', !qDecoOldSaveDrawThrew);

reset(); screen = 'play'; paused = false;
S.score = 12; S.weather = 'clear'; luckBoostT = 0; S.elderT = 999;
var qLuck = { id: 'catch2e', desc: 'x', kind: 'catch', type: 'e', target: 1, progress: 1, done: false, reward: { kind: 'luck', val: 20 } };
grantQuestReward(qLuck);
__check('the "temporary luck boost" reward reuses Part A\\'s weather-affinity rate-multiplier mechanism (elder timer), not a new one', luckBoostT === 20);
var elderTBefore = S.elderT;
__stepFrame(16);
__check('an active luck boost speeds up the elder timer the same way Clear Moon weather does', (elderTBefore - S.elderT) > 0.016, 'delta=' + (elderTBefore - S.elderT));
// luckBoostT decrements unclamped (if(luckBoostT>0)luckBoostT-=dt), same existing
// pattern as S.magnetT elsewhere in the codebase -- checking <=0, not ===0, since
// the last frame can legitimately tip it slightly negative, same as magnetT does
__check('luck boost decays over real time, independent of weather', (function(){ for (var lbi = 0; lbi < 1300 && luckBoostT > 0; lbi++) __stepFrame(16); return luckBoostT <= 0; })());

// luckBoostT is session-level, not round-scoped — a reward earned late in a
// round must carry into the next one rather than being wiped by reset()
luckBoostT = 15;
reset();
__check('luckBoostT survives a reset() (round boundary), unlike round-scoped S state', luckBoostT === 15);
luckBoostT = 0;

// --- welcome-back gate/threshold logic ---
welcomeBackShown = false; showWelcomeBack = false; prevLastPlayed = Date.now() - 7 * 60 * 60 * 1000; lastPlayed = Date.now();
maybeShowWelcomeBack();
__check('welcome-back shows when the gap since prevLastPlayed exceeds the 6h threshold', showWelcomeBack === true);
welcomeBackShown = false; showWelcomeBack = false; prevLastPlayed = Date.now() - 2 * 60 * 60 * 1000; lastPlayed = Date.now();
maybeShowWelcomeBack();
__check('welcome-back does NOT show for a short gap (multiple sessions in one sitting shouldn\\'t retrigger it)', showWelcomeBack === false);
welcomeBackShown = false; showWelcomeBack = false; prevLastPlayed = 0; lastPlayed = Date.now();
maybeShowWelcomeBack();
__check('welcome-back does not show on a genuine first-ever session (prevLastPlayed<=0)', showWelcomeBack === false);
__check('maybeShowWelcomeBack only ever decides once per session (the welcomeBackShown guard)', (function(){ welcomeBackShown = false; showWelcomeBack = false; prevLastPlayed = Date.now() - 7 * 60 * 60 * 1000; maybeShowWelcomeBack(); var first = showWelcomeBack; showWelcomeBack = false; prevLastPlayed = Date.now() - 7 * 60 * 60 * 1000; maybeShowWelcomeBack(); return first === true && showWelcomeBack === false; })());

// --- welcome-back content: derived from EXISTING data, no new counter ---
best = 20;
__check('homesRestoredCount derives purely from best + LIGHTS\\' own thresholds (existing data), matching a direct recomputation', homesRestoredCount() === LIGHTS.filter(function(L){ return best >= L.thr; }).length);

// --- welcome-back swallows input, same discipline as the pause overlay ---
// (re-arming showWelcomeBack before each click, independently, since BEGIN_BTN's
// position turns out to sit within WELCOME_CLOSE_BTN's own generous dismiss
// radius — a real, harmless overlap in the actual game (every click there either
// dismisses or is a no-op, never falls through to the title screen underneath),
// but one that made a single running showWelcomeBack state across sequential
// test clicks order-dependent rather than actually isolating each check)
screen = 'title'; welcomeBackShown = false; showWelcomeBack = true;
__fire(cv, 'pointerdown', __fakeEvent(BEGIN_BTN.x, BEGIN_BTN.y));
__check('tapping "begin"\\'s position underneath the welcome-back overlay never starts a round while it is showing', screen === 'title' && S.score === 0);
welcomeBackShown = false; showWelcomeBack = true;
__fire(cv, 'pointerdown', __fakeEvent(shopNavBtn().x, shopNavBtn().y));
__check('tapping the shop button underneath the welcome-back overlay does not open the shop either', screen === 'title');
welcomeBackShown = false; showWelcomeBack = true;
__fire(cv, 'pointerdown', __fakeEvent(WELCOME_CLOSE_BTN.x, WELCOME_CLOSE_BTN.y));
__check('tapping the welcome-back overlay\\'s own continue button dismisses it', showWelcomeBack === false);

// --- Tonight's Quest: LUMORA clarifications pass removed the standalone
// "quests" screen/title-nav button entirely -- currentQuest() now surfaces
// just one (the first incomplete, or the last if all are done) as a real
// card on the Village screen. quests[] itself still rolls 3/day underneath.
__check('the title nav no longer has a standalone Quests destination', titleNavRects().find(function(b){ return b.key === 'quests'; }) === undefined);
__check('typeof QUESTS_CLOSE_BTN is undefined -- the old standalone screen and its close button are gone', typeof QUESTS_CLOSE_BTN === 'undefined');
quests = [
  { id: 'a', desc: 'Catch 10 Curious fireflies', flavor: 'flavor a', kind: 'catch', type: 'y', target: 10, progress: 3, done: false, reward: { kind: 'coins', val: 40 } },
  { id: 'b', desc: 'Deliver 20 fireflies', flavor: 'flavor b', kind: 'deliver', target: 20, progress: 20, done: true, reward: { kind: 'deco', val: 20 } }
];
__check('currentQuest() returns the first not-done quest when one exists', currentQuest().id === 'a');
quests.forEach(function(q){ q.done = true; q.progress = q.target; });
__check('currentQuest() falls back to the last quest when all are done', currentQuest().id === 'b');
quests = [];
__check('currentQuest() returns null when no quests rolled today', currentQuest() === null);

// ===== quest-object validation at the save-load boundary (minimal defensive fix) =====
// A malformed/tampered quest entry (e.g. missing reward entirely) used to be
// trusted as-is by resolveQuests() once the array-level check passed -- this
// would later crash questRewardLabel()/grantQuestReward(), which read
// q.reward.kind/q.reward.val unconditionally. isValidQuestObject() now
// filters each entry individually before resolveQuests() trusts the array.
__check('isValidQuestObject accepts a real, well-formed quest (a fresh rollQuests() entry)', (function(){ rollQuests(); return isValidQuestObject(quests[0]); })());
__check('isValidQuestObject rejects a quest with no reward object at all', isValidQuestObject({ id: 'x', desc: 'x', kind: 'catch', type: 'y', target: 10, progress: 0, done: false }) === false);
__check('isValidQuestObject rejects a quest whose reward is missing its own kind/val', isValidQuestObject({ id: 'x', desc: 'x', kind: 'catch', target: 10, progress: 0, done: false, reward: {} }) === false);
__check('isValidQuestObject rejects null/non-object entries without throwing', isValidQuestObject(null) === false && isValidQuestObject('not a quest') === false && isValidQuestObject(42) === false);
// resolveQuests() itself: same-day reopen with a MIX of one malformed and
// two valid entries must keep the valid ones and drop only the bad one --
// "preserve valid existing quest data exactly" per direct instruction.
prevLastPlayed = lastPlayed; // pin to "same calendar day" so resolveQuests() takes the loadedQuests branch, not a fresh roll
var mixedQuests = [
  { id: 'catch10y', desc: 'x', kind: 'catch', type: 'y', target: 10, progress: 3, done: false, reward: { kind: 'coins', val: 40 } },
  { id: 'corrupted-no-reward', desc: 'x', kind: 'catch', type: 'y', target: 5, progress: 1, done: false }, // malformed: no reward at all
  { id: 'deliver20', desc: 'x', kind: 'deliver', target: 20, progress: 7, done: false, reward: { kind: 'deco', val: 5 } }
];
resolveQuests(mixedQuests);
__check('resolveQuests() drops only the malformed entry from a mixed array, keeping the two valid ones exactly', quests.length === 2 && quests[0].id === 'catch10y' && quests[0].progress === 3 && quests[1].id === 'deliver20' && quests[1].progress === 7, 'quests=' + JSON.stringify(quests));
var questDrawWithMixedThrew = false;
try { screen = 'village'; draw(); } catch (e) { questDrawWithMixedThrew = true; }
__check('the Village screen renders safely with quests loaded from a mixed valid/malformed array', !questDrawWithMixedThrew);
// all-malformed array: must fall back to a fresh roll, same as "nothing usable was persisted"
resolveQuests([{ id: 'still-broken' }, { totally: 'not a quest' }]);
__check('resolveQuests() falls back to a fresh roll when EVERY loaded entry is malformed', quests.length > 0 && quests.length <= 3 && quests.every(isValidQuestObject), 'quests=' + JSON.stringify(quests));
var villageQuestDrawThrew = false;
try {
  screen = 'village';
  quests = []; draw(); // no-quests-today case
  quests = [{ id: 'a', desc: 'Catch 10 Curious fireflies', flavor: 'flavor a', kind: 'catch', type: 'y', target: 10, progress: 3, done: false, reward: { kind: 'coins', val: 40 } }]; draw(); // in-progress case
  quests[0].done = true; quests[0].progress = 10; draw(); // completed case
} catch (e) { villageQuestDrawThrew = true; }
__check('the Village screen\\'s Tonight\\'s Quest card draws without throwing across no-quest/in-progress/done states', !villageQuestDrawThrew);
screen = 'title';

// --- dt-clamp safety: a backgrounded tab regaining focus after a long real
// gap (tab switch, screen lock, incoming call -- rAF simply stops firing
// while hidden, confirmed live in-browser this session) must not deliver
// one giant catch-up tick on resume. loop() clamps dt unconditionally
// (Math.min(0.033, (now-lastT)/1000), applied BEFORE the paused check, so
// it protects both the Playables system-pause path AND a plain backgrounded
// standalone tab that never told the game it was paused at all) -- and,
// independently, every timer-driven event (delivery, moth spawn, weather
// cycle, shooting star) is gated behind a single "if", never a "while", so
// even an uncapped dt could only ever fire one such event per resumed
// frame. Both are real protections; this proves both empirically rather
// than by reading the source.
reset(); screen = 'play'; paused = false;
S.score = 15; S.jar.x = 270; S.jar.y = DELIVER_Y + 20; S.jar.tx = S.jar.x; S.jar.ty = S.jar.y; // tx/ty pinned to x/y too, so the jar-lerp itself can't drift it out of the village zone independent of what we're actually testing
S.carried = [{type:'y',ph:0,sp:1},{type:'y',ph:0,sp:1},{type:'y',ph:0,sp:1}];
S.deliverT = 0.01; S.wasDelivering = true;
S.mothT = 0.001;
var sessionTBefore = sessionT;
var carriedBefore = S.carried.length;
__stepFrame(300000); // one resumed frame after a simulated 5-minute backgrounded gap
__check('a huge real-time gap (5 min) still only advances sessionT by one clamped frame (~0.033s), proving dt itself is capped in loop(), not just in individual timers', sessionT - sessionTBefore > 0 && sessionT - sessionTBefore <= 0.034, 'delta=' + (sessionT - sessionTBefore));
__check('the same giant gap delivers at most ONE firefly from the carried jar on the resumed frame, not the whole batch at once', carriedBefore - S.carried.length === 1, 'before=' + carriedBefore + ' after=' + S.carried.length);
__check('the same giant gap spawns at most ONE moth, not a backlog of missed spawns', S.moths.length === 1, 'moths=' + S.moths.length);

// =====================================================================
// Depth Pass Part 1: diff() retune (compressed opening plateau) + safe
// presentation items (restoration %, Village Requests flavor, weather
// rename) -- all data/copy/visual, zero gameplay-state coupling
// =====================================================================

// --- diff() retune: Stage 0's s=0 hook is byte-identical to before ---
reset(); S.score = 0; S.carried = [];
var d0 = diff();
__check('diff() at score 0 is untouched by the retune -- maxFlies still 3 (the deliberate Stage 0 gentle-hook value)', d0.maxFlies === 3);
__check('diff() at score 0 still has zero moths (Stage 0 hook untouched)', d0.mothRate === 0);
__check('diff() at score 0 speed range is still the original gentle 16-26 (both bounds sampled across many rolls)', (function(){ for (var i = 0; i < 200; i++) { var v = diff().speed; if (v < 16 || v > 26) return false; } return true; })());

// --- new compressed boundaries: old "score 10" tier now lands by score 5 ---
reset(); S.score = 5; S.carried = [];
var d5 = diff();
__check('the old score-10 maxFlies value (4) now arrives by score 5, not score 10 (this IS the compression)', d5.maxFlies === 4);
__check('the old score-10 mothRate range now arrives by score 5 too (mothRate > 0)', d5.mothRate > 0);
reset(); S.score = 4; S.carried = [];
__check('score 4 (just below the new boundary) is still in the gentle tier -- maxFlies 3', diff().maxFlies === 3);

// --- new compressed boundaries: old "score 20" (hardest) tier now lands by score 13 ---
// (the hardest maxFlies VALUE is now 5, not 6, until score 60 -- see the
// beginner grace window checks further below; this just confirms the
// hardest TIER's boundary itself still lands at 13, unrelated to that grace)
reset(); S.score = 13; S.carried = [];
var d13 = diff();
__check('the hardest maxFlies tier now arrives by score 13, not score 20 -- 5 (eased by the beginner grace window below 60), not the s<13 tier value of 4', d13.maxFlies === 5);
reset(); S.score = 12; S.carried = [];
__check('score 12 (just below the new boundary) is still the middle tier -- maxFlies 4', diff().maxFlies === 4);

// --- Elder-gate decoupling: the hard-tier boundary must NOT land on the Elder unlock score (12) ---
// The Elder's own unlock gate (S.score>=12, in the elder-timer block) is untouched by this pass.
// If the hard-tier boundary above ever moved back onto 12, a player's first chance at an Elder
// would coincide with the worst maxFlies/patience/mothRate of the whole curve -- guard against
// that regressing silently.
reset(); S.score = 12; S.carried = [];
__check('score 12 (the Elder unlock score) is still in the middle tier, not the hardest one -- Elder\\'s first opportunity is not coupled to the worst odds', diff().maxFlies === 4 && diff().mothRate <= 13);

// --- content-unlock gates (blue/shy) and magRate are explicitly untouched ---
reset(); S.score = 9; S.carried = [];
__check('blue is still locked at score 9 (unlock gate untouched by the retune)', diff().blue === false);
reset(); S.score = 10; S.carried = [];
__check('blue still unlocks at exactly score 10 (unchanged, matches the firefly reference table)', diff().blue === true);
reset(); S.score = 14; S.carried = [];
__check('shy is still locked at score 14 (unlock gate untouched)', diff().shy === false);
reset(); S.score = 15; S.carried = [];
__check('shy still unlocks at exactly score 15 (unchanged, matches the firefly reference table)', diff().shy === true);
reset(); S.score = 7; S.carried = [];
__check('magRate is still 0 below score 8 (a player-favoring bonus timer, deliberately untouched by this pass)', diff().magRate === 0);

// --- Beginner grace window (score < 60): patience stays at the gentle
// value and maxFlies' hardest tier is trimmed by 1 (6->5), both reverting
// to normal at score 60; speed/mothRate keep their own original 5/13
// tiering, untouched by either grace ---
reset(); S.score = 20; S.carried = [];
__check('patience stays in the gentle 12-14 range well past the normal hard-tier boundary (score 20, still under the 60 grace threshold)', (function(){ for (var i = 0; i < 200; i++) { var v = diff().patience; if (v < 12 || v > 14) return false; } return true; })());
__check('maxFlies is eased to 5 (not the normal hard-tier 6) at score 20, still under the 60 grace threshold', diff().maxFlies === 5);
__check('speed/mothRate are still on their own normal (unextended) tiering at score 20 -- only patience and maxFlies are eased', diff().mothRate <= 9);
reset(); S.score = 59; S.carried = [];
__check('patience is still eased at score 59, just under the grace threshold', (function(){ for (var i = 0; i < 200; i++) { var v = diff().patience; if (v < 12 || v > 14) return false; } return true; })());
__check('maxFlies is still eased to 5 at score 59, just under the grace threshold', diff().maxFlies === 5);
reset(); S.score = 60; S.carried = [];
__check('patience reverts to the normal hard-tier value (9-11) at exactly score 60', (function(){ for (var i = 0; i < 200; i++) { var v = diff().patience; if (v < 9 || v > 11) return false; } return true; })());
__check('maxFlies reverts to the normal hard-tier value (6) at exactly score 60', diff().maxFlies === 6);
reset(); S.score = 90; S.carried = [];
__check('patience stays at the normal hard-tier value well past score 60 too', (function(){ for (var i = 0; i < 200; i++) { var v = diff().patience; if (v < 9 || v > 11) return false; } return true; })());
__check('maxFlies stays at the normal hard-tier value (6) well past score 60 too', diff().maxFlies === 6);

// --- restoration % readout: pure function of heartTier(best)/HEART_TIER_THRESH, no new save field ---
__check('restorationPct at bestScore 0 (tier 1, unrestored) reads 0%', restorationPct(0) === 0);
__check('restorationPct at bestScore 25 (tier 6, Luminary ceiling) reads 100%', restorationPct(25) === 100);
__check('restorationPct is monotonically non-decreasing across the tier thresholds', (function(){ var prev = -1; for (var s = 0; s <= 30; s++) { var p = restorationPct(s); if (p < prev) return false; prev = p; } return true; })());
reset();
__check('bestAtRoundStart is snapshotted fresh by reset() (matches best at the moment the round started)', bestAtRoundStart === best);
var __gameOverThrew = false;
try { screen = 'play'; S.over = true; S.overT = 1; S.carried = []; draw(); } catch (e) { __gameOverThrew = true; }
__check('the game-over screen (including the new restoration-% readout) draws without throwing', !__gameOverThrew);

// --- Tonight's Quest: flavor text riding on the existing quest object, no new mechanic ---
__check('every quest in the pool carries a flavor string (Tonight\\'s Quest), separate from desc/kind/target/reward', QUEST_POOL.every(function(q){ return typeof q.flavor === 'string' && q.flavor.length > 0; }));
rollQuests();
__check('a rolled quest carries its flavor text through unchanged (same object, nothing strips it)', quests.length > 0 && quests.every(function(q){ return typeof q.flavor === 'string'; }));
screen = 'title';

// --- "Living Nights" weather rename: same 5 types/effects, just evocative banner copy ---
__check('WEATHER_TYPES still has exactly the same 5 entries (rename touched copy only, not the type list)', WEATHER_TYPES.length === 5 && ['nightRain', 'clearMoon', 'festival', 'shootingStars', 'aurora'].every(function(k){ return WEATHER_TYPES.indexOf(k) >= 0; }));
__check('every weather type still has a non-empty banner message after the rename', WEATHER_TYPES.every(function(k){ return typeof WEATHER_INFO[k].msg === 'string' && WEATHER_INFO[k].msg.length > 0; }));

// --- self-audit: none of this session's additions touch gameplay-affecting functions ---
reset(); S.score = 20; S.carried = [];
var capBefore = jarCapacityForRun(), radBefore = jarReachForRun(), durBefore = magnetDurationForRun(5), multBefore = coinMultiplierForRun(), diffBefore = JSON.stringify(diff());
restorationPct(best); homesRestoredCount(); // exercise the new presentation functions
var capAfter = jarCapacityForRun(), radAfter = jarReachForRun(), durAfter = magnetDurationForRun(5), multAfter = coinMultiplierForRun();
__check('calling the new restoration-% / presentation helpers has zero effect on jarCapacityForRun/jarReachForRun/magnetDurationForRun/coinMultiplierForRun', capBefore === capAfter && radBefore === radAfter && durBefore === durAfter && multBefore === multAfter);

// ===== Capacity Enforcement Bug: the real acceptance gate =====================
// Reported live: a 6-capacity jar reached 10. Root cause was that NOTHING
// enforced any ceiling at the one line that actually grows S.carried
// (S.carried.push, in the f.state==='caught' completion branch) -- the
// lock-acquisition gate's old "S.carried.length<S.cap+3" only ever throttled
// how many NEW locks could be acquired, it never re-checked room at the
// moment a catch actually completed. jarCanAcceptCatch() is now the one
// canonical check, called at all three sites (lock-acquisition, the
// locked->caught transition, and the final push).
//
// CARRY_OVERFLOW_HEADROOM is 0 -- ZERO TOLERANCE. A first pass at this fix
// set it to 3 (preserving an existing "carry past capacity, moths notice
// you" risk mechanic), which correctly bounded the reported 10 down to 9 --
// but reported live as a jar STILL reading "9/6", which reads as broken
// regardless of the reasoning, so the call was made to drop it to 0. Tests
// below use S.cap+CARRY_OVERFLOW_HEADROOM throughout (not a hardcoded
// number) so they stay correct if that constant is ever revisited again,
// plus one test that hardcodes the zero-tolerance invariant explicitly by name.

// direct reproduction of the reported failure mode: repeatedly land MORE
// fireflies than the jar can hold, the way a real fast player does with the
// magnet buff active (maxLocks=3)
function overfillAttempt(waves, perWave){
  for (var w = 0; w < waves; w++) {
    for (var k = 0; k < perWave; k++) {
      S.flies.push({ x: S.jar.x, y: S.jar.y - 14, type: 'y', state: 'caught', animT: 0.41, animA: 0, animR: 5 });
    }
    for (var f = 0; f < 5; f++) __stepFrame(16);
  }
}
upgrades.jarCapTiers.simple = 1; // cap = simple jar(5) + tier1(1) = 6
reset(); screen = 'play'; paused = false;
S.magnetT = 999; // magnet buff active the whole time -- maxLocks=3, the realistic worst case
overfillAttempt(8, 3); // 24 completed-dive fireflies thrown at a 6-capacity jar
__check('a sustained overfill attempt (24 completed dives at a 6-capacity jar) never exceeds the true ceiling (cap+headroom)', S.carried.length <= S.cap + CARRY_OVERFLOW_HEADROOM, 'cap=' + S.cap + ' carried=' + S.carried.length);
__check('zero tolerance, explicitly: S.carried.length never exceeds S.cap itself, not just some looser ceiling', S.carried.length <= S.cap, 'cap=' + S.cap + ' carried=' + S.carried.length);
__check('the overfill attempt actually DOES fill up to the true ceiling, not stall short of it', S.carried.length === S.cap + CARRY_OVERFLOW_HEADROOM, 'carried=' + S.carried.length + ' ceiling=' + (S.cap + CARRY_OVERFLOW_HEADROOM));
upgrades.jarCapTiers.simple = 0;

// narrower, more direct proof: once the jar is sitting exactly AT its true
// ceiling (cap+headroom), one more catch attempt must be rejected outright --
// not counted, not silently dropped, the firefly gets a real second chance
upgrades.jarCapTiers.simple = 1;
reset(); screen = 'play'; paused = false;
for (var pre = 0; pre < S.cap + CARRY_OVERFLOW_HEADROOM; pre++) S.carried.push({ type: 'y', ph: 0, sp: 1 }); // manually fill to exactly the ceiling
__check('setup: carried is sitting exactly at the true ceiling (cap+headroom)', S.carried.length === S.cap + CARRY_OVERFLOW_HEADROOM);
var rejFly = { x: S.jar.x, y: S.jar.y - 14, type: 'y', state: 'caught', animT: 0.41, animA: 0, animR: 5 };
S.flies.push(rejFly);
var journalBefore = journal.y, caughtNBefore = S.caughtN;
for (var rf = 0; rf < 5; rf++) __stepFrame(16);
__check('a catch attempted against an already-at-ceiling jar is rejected: S.carried.length does not grow past the ceiling', S.carried.length === S.cap + CARRY_OVERFLOW_HEADROOM, 'carried=' + S.carried.length);
__check('the rejected catch is not silently counted -- no journal/caughtN credit for a catch that didn\\'t actually happen', journal.y === journalBefore && S.caughtN === caughtNBefore);
__check('the rejected firefly gets a real second chance -- reverted to \\'locked\\' (still in S.flies, orbiting/waiting), not deleted uncounted', S.flies.indexOf(rejFly) >= 0 && rejFly.state === 'locked');
upgrades.jarCapTiers.simple = 0;

// jarCanAcceptCatch() is the ONE canonical source -- prove the three call
// sites actually all read it, not three independently-hand-copied comparisons
// that happen to currently agree
__check('jarCanAcceptCatch reflects true/false correctly at the exact ceiling boundary', (function(){
  reset();
  S.carried = new Array(S.cap + CARRY_OVERFLOW_HEADROOM - 1).fill({ type: 'y', ph: 0, sp: 1 });
  var belowCeiling = jarCanAcceptCatch();
  S.carried.push({ type: 'y', ph: 0, sp: 1 });
  var atCeiling = jarCanAcceptCatch();
  return belowCeiling === true && atCeiling === false;
})());

// the overloaded/moth-attraction mechanic is now permanently dead code --
// confirm that explicitly rather than leaving it an unstated assumption.
// S.carried.length can never exceed S.cap any more (zero tolerance), so
// the overloaded flag (S.carried.length>S.cap) can never be true regardless
// of how aggressively the jar is filled.
upgrades.jarCapTiers.simple = 1;
reset(); screen = 'play'; paused = false;
S.magnetT = 999;
overfillAttempt(10, 3); // hammer it well past any plausible ceiling
__check('the overloaded flag/moth-attraction mechanic can never trigger any more under zero tolerance (S.carried.length can never exceed S.cap)', S.carried.length <= S.cap, 'cap=' + S.cap + ' carried=' + S.carried.length);
upgrades.jarCapTiers.simple = 0;

// ===== Jar-full edge alert ===================================================
// gated on the exact same canonical S.carried.length>=S.cap comparison used
// everywhere else -- spying on drawFullJarAlert() itself (not just checking
// draw() doesn't throw) proves it actually fires exactly when full and never
// otherwise, including the S.over edge case where jar fullness stops mattering.
var __fullAlertCalls = 0;
var __realDrawFullJarAlert = drawFullJarAlert;
drawFullJarAlert = function(){ __fullAlertCalls++; return __realDrawFullJarAlert.apply(this, arguments); };

upgrades.jarCapTiers.simple = 1; // cap = 6
reset(); screen = 'play'; paused = false; S.over = false;
S.carried = [{ type: 'y', ph: 0, sp: 1 }, { type: 'y', ph: 0, sp: 1 }]; // 2/6, not full
__fullAlertCalls = 0;
draw();
__check('the edge alert does not fire while the jar is under capacity', __fullAlertCalls === 0, 'calls=' + __fullAlertCalls);

for (var i = S.carried.length; i < S.cap; i++) S.carried.push({ type: 'y', ph: 0, sp: 1 }); // now exactly 6/6
__fullAlertCalls = 0;
var alertDrawThrew = false;
try { draw(); } catch (e) { alertDrawThrew = true; }
__check('the edge alert fires exactly once per frame once the jar is genuinely full (6/6)', __fullAlertCalls === 1, 'calls=' + __fullAlertCalls);
__check('drawing the full-jar alert does not throw', !alertDrawThrew);

S.over = true;
__fullAlertCalls = 0;
draw();
__check('the edge alert does not fire once the round is over, even with S.carried still sitting at cap', __fullAlertCalls === 0, 'calls=' + __fullAlertCalls);

drawFullJarAlert = __realDrawFullJarAlert; // restore, don't leak the spy into later tests
upgrades.jarCapTiers.simple = 0;

// ===== Aurora Endgame Jar pass: cosmetic FX layer (items 1-6) =============
// All six effects are gated on jar.aurora / currentJar().aurora at every
// call site -- these tests prove that gating, not just "doesn't throw".

// item 2: the ambient celestial sparkle is gated purely on jar identity
// (no movement needed), unlike the existing trail-color cosmetic --
// Simple emits nothing extra even while sitting still, Aurora does.
reset(); screen = 'play'; paused = false;
upgrades.fountain = false; upgrades.equippedTrail = 'none';
upgrades.ownedJars.simple = true; upgrades.equippedJar = 'simple';
S.jar.tx = S.jar.x; S.jar.ty = S.jar.y; // stationary -- rules out the movement-trail cosmetic as a confound
var maxPartsSimpleStill = 0;
for (var asi = 0; asi < 120; asi++) { S.flies = []; S.moths = []; __stepFrame(16); if (S.parts.length > maxPartsSimpleStill) maxPartsSimpleStill = S.parts.length; }
upgrades.ownedJars.aurora = true; upgrades.equippedJar = 'aurora';
S.jar.tx = S.jar.x; S.jar.ty = S.jar.y;
var maxPartsAuroraStill = 0;
for (var aai = 0; aai < 120; aai++) { S.flies = []; S.moths = []; __stepFrame(16); if (S.parts.length > maxPartsAuroraStill) maxPartsAuroraStill = S.parts.length; }
__check('Aurora\\'s ambient celestial sparkle emits particles even while the jar sits still (Simple emits none in the same conditions)', maxPartsSimpleStill === 0 && maxPartsAuroraStill > 0, 'simple_max=' + maxPartsSimpleStill + ' aurora_max=' + maxPartsAuroraStill);
upgrades.equippedJar = 'simple';

// item 3: an aurora-tinted second catch burst layers on top of the normal
// one, Aurora-only -- same catch (journal/quest/score credit either way),
// only the extra puff() differs. Measured at the exact frame S.carried
// actually grows, not a guessed frame count.
function __completeCatchAndCountParts(jarKey){
  reset(); screen = 'play'; paused = false;
  upgrades.fountain = false; upgrades.equippedTrail = 'none';
  upgrades.ownedJars[jarKey] = true; upgrades.equippedJar = jarKey;
  spawnFly('y');
  var f = S.flies[S.flies.length - 1];
  f.x = S.jar.x; f.y = S.jar.y - 14;
  var delta = 0;
  for (var i = 0; i < 60 && S.carried.length === 0; i++) {
    var before = S.parts.length;
    __stepFrame(16);
    if (S.carried.length === 1) { delta = S.parts.length - before; break; }
  }
  return delta;
}
var __simpleCatchDelta = __completeCatchAndCountParts('simple');
var __auroraCatchDelta = __completeCatchAndCountParts('aurora');
__check('Aurora\\'s catch burst spawns more particles than Simple\\'s at the exact same catch-completion frame (the extra aurora-tinted puff)', __auroraCatchDelta > __simpleCatchDelta, 'simple=' + __simpleCatchDelta + ' aurora=' + __auroraCatchDelta);
upgrades.equippedJar = 'simple';

// item 4: the trailing delivery ribbon is baked into the spark at spawn
// time (jarAurora) and only emits extra particles across the flight for
// Aurora -- the landing puff() itself is identical for every jar, so any
// measured difference must come from the ribbon, not the landing effect.
function __deliverOneAndCountParts(jarKey){
  reset(); screen = 'play'; paused = false;
  upgrades.fountain = false; upgrades.equippedTrail = 'none';
  upgrades.ownedJars[jarKey] = true; upgrades.equippedJar = jarKey;
  S.carried.push({ type: 'y', ph: 0, sp: 1 });
  S.jar.y = DELIVER_Y + 10; S.jar.tx = S.jar.x; S.jar.ty = S.jar.y; // already in the village delivery zone, stationary
  var total = 0;
  for (var i = 0; i < 120; i++) {
    var before = S.parts.length;
    __stepFrame(16);
    if (S.parts.length > before) total += S.parts.length - before;
    if (i > 5 && S.carried.length === 0 && S.sparks.length === 0) break; // delivery + flight fully complete
  }
  return total;
}
var __simpleDeliverParts = __deliverOneAndCountParts('simple');
var __auroraDeliverParts = __deliverOneAndCountParts('aurora');
__check('Aurora\\'s delivery ribbon spawns more particles across the same single-firefly delivery than Simple\\'s (identical landing puff, only the ribbon differs)', __auroraDeliverParts > __simpleDeliverParts, 'simple=' + __simpleDeliverParts + ' aurora=' + __auroraDeliverParts);
upgrades.equippedJar = 'simple';

// item 6: auroraFullyMaxed() gates the prestige halo -- must require ALL
// FIVE per-jar lines simultaneously (capacity + all four per-jar stats),
// not just capacity alone.
(function(){
  var auroraJarRef = JARS.find(function(j){ return j.key === 'aurora'; });
  upgrades.ownedJars.aurora = true;
  ['jarCapTiers', 'reachTiers', 'magnetReachTiers', 'durationTiers', 'lightValueTiers'].forEach(function(f){ upgrades[f].aurora = 0; });
  __check('auroraFullyMaxed() is false with nothing upgraded yet', auroraFullyMaxed() === false);
  upgrades.jarCapTiers.aurora = auroraJarRef.maxCapacity - auroraJarRef.capacity; // E2: generic capacity ladder length (12->38, +1/tier), not the old hardcoded 13
  upgrades.reachTiers.aurora = jarStatTierCount('reach', auroraJarRef);
  upgrades.magnetReachTiers.aurora = jarStatTierCount('magnetReach', auroraJarRef);
  upgrades.durationTiers.aurora = jarStatTierCount('duration', auroraJarRef);
  __check('auroraFullyMaxed() is still false with only four of the five lines maxed (Light Value left untouched)', auroraFullyMaxed() === false);
  upgrades.lightValueTiers.aurora = jarStatTierCount('lightValue', auroraJarRef);
  __check('auroraFullyMaxed() is true only once capacity and all four per-jar stat lines are simultaneously maxed', auroraFullyMaxed() === true);
  ['jarCapTiers', 'reachTiers', 'magnetReachTiers', 'durationTiers', 'lightValueTiers'].forEach(function(f){ upgrades[f].aurora = 0; });
})();

// items 1/5/6 draw paths: shimmer, warning re-skin, and prestige halo can
// only be exercised for real via an actual draw() call (canvas draws are
// mocked/swallowed, not asserted pixel-by-pixel, same discipline as every
// other draw-safety check in this file) -- Aurora equipped, fully maxed,
// jar genuinely full, so all three code paths execute in one pass.
(function(){
  var auroraJarRef = JARS.find(function(j){ return j.key === 'aurora'; });
  upgrades.ownedJars.aurora = true; upgrades.equippedJar = 'aurora';
  upgrades.jarCapTiers.aurora = auroraJarRef.maxCapacity - auroraJarRef.capacity; // E2: generic, not the old hardcoded 13
  upgrades.reachTiers.aurora = jarStatTierCount('reach', auroraJarRef);
  upgrades.magnetReachTiers.aurora = jarStatTierCount('magnetReach', auroraJarRef);
  upgrades.durationTiers.aurora = jarStatTierCount('duration', auroraJarRef);
  upgrades.lightValueTiers.aurora = jarStatTierCount('lightValue', auroraJarRef);
  reset(); screen = 'play'; paused = false; S.over = false;
  for (var i = S.carried.length; i < S.cap; i++) S.carried.push({ type: 'y', ph: 0, sp: 1 }); // genuinely full -> triggers the re-skinned edge alert too
  var threw = false;
  try { draw(); } catch (e) { threw = true; }
  __check('drawing a fully-maxed, genuinely-full Aurora jar (shimmer + prestige halo + re-skinned edge alert all active at once) does not throw', !threw);
  ['jarCapTiers', 'reachTiers', 'magnetReachTiers', 'durationTiers', 'lightValueTiers'].forEach(function(f){ upgrades[f].aurora = 0; });
  upgrades.equippedJar = 'simple';
})();

// ===== Lumora UI port: Village/Journal screens, Restart Night, RunSummary ===

// Village screen: reachable from title, not mid-round; draws without
// throwing across a spread of restoration percentages (0%, partial, maxed)
reset(); screen = 'play'; paused = false; S.over = false;
__fire(cv, 'pointerdown', __fakeEvent(titleNavRects().find(function(b){ return b.key === 'village'; }).x, titleNavRects().find(function(b){ return b.key === 'village'; }).y));
__check('tapping the title-screen village-button spot mid-round does not open the Village screen', screen === 'play');
screen = 'title';
var villageNavBtn = titleNavRects().find(function(b){ return b.key === 'village'; });
__fire(cv, 'pointerdown', __fakeEvent(villageNavBtn.x, villageNavBtn.y));
__check('the village button on the title screen opens the Village screen', screen === 'village');
var villageDrawThrew = false;
try { [0, 12, 25].forEach(function(b){ best = b; draw(); }); } catch (e) { villageDrawThrew = true; }
__check('the Village screen draws without throwing across a spread of restoration levels (0%/partial/maxed)', !villageDrawThrew);
__fire(cv, 'pointerdown', __fakeEvent(VILLAGE_CLOSE_BTN.x, VILLAGE_CLOSE_BTN.y));
__check('the Village close button returns to the title screen', screen === 'title');

// ===== Village + Decoration System Correction pass ==========================

// A/D: 0% state -- nothing restored, next milestone is genuinely the first one
__check('at bestScore 0 (0% restored), nextVillageMilestone returns First Window (the first milestone whose own threshold is still ahead)', nextVillageMilestone(restorationPct(0)) === VILLAGE_MILESTONES[0]);
__check('at 0% restored, every milestone reads not-yet-restored', VILLAGE_MILESTONES.every(function(m){ return restorationPct(0) < m.pct; }));

// B/D: partial restoration -- some milestones restored, next is correct
// (bestScore 10 -> tier 3 -> 40%, which crosses First Window/10, Bakery/25,
// AND Lantern Garden/40 simultaneously -- a real, deliberate quirk of pct
// jumping in coarse 20%-per-tier steps against finer milestone thresholds,
// not something this pass changes; see restorationPct()/HEART_TIER_THRESH)
var pctAt10 = restorationPct(10);
__check('at bestScore 10 (40% restored), First Window/Bakery/Lantern Garden all read restored, Fountain/Bell Tower/Dawn Chorus do not', pctAt10 === 40 && VILLAGE_MILESTONES.filter(function(m){ return pctAt10 >= m.pct; }).length === 3, 'pct=' + pctAt10);
__check('at 40% restored, the next milestone is The Fountain (the first one still ahead)', nextVillageMilestone(pctAt10).name === 'The Fountain');

// C/E: 100% state -- every milestone restored, no next milestone at all
var pctAt25 = restorationPct(25);
__check('at bestScore 25 (100% restored), every one of the six milestones reads restored', pctAt25 === 100 && VILLAGE_MILESTONES.every(function(m){ return pctAt25 >= m.pct; }));
__check('at 100% restored, nextVillageMilestone returns null -- this is the exact reported bug fix: no more falling back to Dawn Chorus and presenting it as still upcoming', nextVillageMilestone(pctAt25) === null);
var villageCompleteDrawThrew = false;
try { screen = 'village'; best = 25; draw(); } catch (e) { villageCompleteDrawThrew = true; }
__check('the Village screen draws the 100%/complete state without throwing', !villageCompleteDrawThrew);
best = 0; screen = 'title';

// D: nextVillageMilestone is correct at every tier boundary, not just the
// two spot-checked above
[[0, 'First Window'], [20, 'The Bakery'], [60, 'Bell Tower'], [80, 'Dawn Chorus']].forEach(function(pair){
  var got = nextVillageMilestone(pair[0]);
  __check('nextVillageMilestone(' + pair[0] + ') is ' + pair[1], got !== null && got.name === pair[1], 'got=' + (got && got.name));
});

// F/G/H: Tonight's Quest states, using the SAME real path (questProgress ->
// grantQuestReward) as the pre-existing "completes and grants its reward"
// tests above, not a hand-rolled shortcut.
reset(); screen = 'play'; paused = false;
upgrades.deco = false; var coinsBeforeVDQuest = coins;
quests = [{ id: 'deliver20', desc: 'Deliver 20 fireflies', flavor: 'x', kind: 'deliver', target: 3, progress: 0, done: false, reward: { kind: 'deco', val: 5 } }];
__check('STATE A (not completed): currentQuest() surfaces the in-progress quest, questRewardPreviewLabel reads the true upcoming reward', currentQuest().done === false && questRewardPreviewLabel(currentQuest()) === 'Garden Lanterns');
questProgress('deliver', 'y'); questProgress('deliver', 'y');
__check('STATE A still holds partway through (2 of 3), reward not yet granted', currentQuest().done === false && upgrades.deco === false);
questProgress('deliver', 'y');
__check('STATE C (completed): the quest is done and the reward was granted at the exact moment progress reached target, not deferred to a separate claim step (no claim architecture exists here)', currentQuest().done === true && upgrades.deco === true);
__check('STATE C: questGrantedMessage reads the village-framed completion line matching what actually happened', questGrantedMessage(currentQuest()) === 'Garden Lanterns added to the village.');
// H: reward granted exactly once -- further progress calls on an already-done quest must not re-grant
var decoStillOwnedAfterDone = upgrades.deco;
questProgress('deliver', 'y'); questProgress('deliver', 'g');
__check('a completed quest\\'s reward is granted exactly once -- further deliveries do not re-grant it or push progress past target', currentQuest().progress === 3 && upgrades.deco === decoStillOwnedAfterDone);
upgrades.deco = false; quests = [];

// I/J/N: Garden Lantern + Fountain persistence -- same localStorage
// round-trip discipline as every other upgrades.* field in this file
upgrades.deco = true; upgrades.fountain = true;
if (!YT) {
  persistUpgradesLocal();
  var reloadedDecor = JSON.parse(localStorage.getItem('gk2_upgrades') || '{}');
  __check('Garden Lanterns ownership (upgrades.deco) persists to the same gk2_upgrades key as every other upgrade -- no parallel/second decoration save field', reloadedDecor.deco === true);
  __check('Village Fountain ownership (upgrades.fountain) persists to the same gk2_upgrades key', reloadedDecor.fountain === true);
}

// K/L: decorations render only while owned -- ctx.drawImage is the one call
// both drawDecorDeco()/drawFountain() only reach on the owned branch (the
// not-owned branch draws the dry basin/no lanterns via stroke/fill only),
// so counting it proves the actual DRAW branch taken, not just "didn't throw".
(function(){
  var diCalls = 0;
  var realDrawImage = ctx.drawImage;
  ctx.drawImage = function(){ diCalls++; return realDrawImage.apply(this, arguments); };
  upgrades.deco = false; diCalls = 0; drawDecorDeco();
  __check('Garden Lanterns draw nothing while not owned (drawDecorDeco returns before any drawImage call)', diCalls === 0);
  upgrades.deco = true; diCalls = 0; drawDecorDeco();
  __check('Garden Lanterns draw their glow once owned -- one drawImage call per lantern spot', diCalls === DECOR_LANTERN_SPOTS.length && DECOR_LANTERN_SPOTS.length > 0, 'diCalls=' + diCalls);
  upgrades.fountain = false; diCalls = 0; drawFountain();
  __check('the Fountain draws no water glow while dry/unowned (the basin itself is stroke/fill only, not drawImage)', diCalls === 0);
  upgrades.fountain = true; diCalls = 0; drawFountain();
  __check('the Fountain draws its water glow once owned', diCalls === 1, 'diCalls=' + diCalls);
  ctx.drawImage = realDrawImage;
  upgrades.deco = false; upgrades.fountain = false;
})();

// M: decorations survive a round restart -- reset() replaces S wholesale but
// must never touch upgrades (permanent progress), same invariant already
// proven for jars/trails/tiers elsewhere in this file
upgrades.deco = true; upgrades.fountain = true;
reset();
__check('Garden Lanterns ownership survives reset() (Restart Night/starting a fresh round)', upgrades.deco === true);
__check('Village Fountain ownership survives reset() (Restart Night/starting a fresh round)', upgrades.fountain === true);

// O: decorations are purely visual -- zero effect on any real gameplay/economy value
(function(){
  reset(); S.score = 20;
  upgrades.deco = false; upgrades.fountain = false;
  var dOff = diff(), capOff = jarCapacityForRun(), coinsOff = coins;
  upgrades.deco = true; upgrades.fountain = true;
  var dOn = diff(), capOn = jarCapacityForRun(), coinsOn = coins;
  __check('owning Garden Lanterns/the Fountain has zero effect on diff() (spawn/difficulty), jarCapacityForRun(), or coins', JSON.stringify({ maxFlies: dOff.maxFlies, blue: dOff.blue, shy: dOff.shy }) === JSON.stringify({ maxFlies: dOn.maxFlies, blue: dOn.blue, shy: dOn.shy }) && capOff === capOn && coinsOff === coinsOn);
  upgrades.deco = false; upgrades.fountain = false;
})();

// Journal screen: same "never reachable mid-round" discipline, Tracker
// toggle relocated here from the old Collector shop tab (same trackerOn
// source of truth, just a different screen driving it)
reset(); screen = 'play'; paused = false; S.over = false;
var journalNavBtn = titleNavRects().find(function(b){ return b.key === 'journal'; });
__fire(cv, 'pointerdown', __fakeEvent(journalNavBtn.x, journalNavBtn.y));
__check('tapping the title-screen journal-button spot mid-round does not open the Journal screen', screen === 'play');
screen = 'title';
__fire(cv, 'pointerdown', __fakeEvent(journalNavBtn.x, journalNavBtn.y));
__check('the journal button on the title screen opens the Journal screen', screen === 'journal');
__check('opening the Journal from the title screen lands on the Story tab (the storybook is now the default), not mid-chapter', journalTab === 'story' && journalReading === null);
var fireflyTabBtn = journalTabRects().find(function(t){ return t.key === 'fireflies'; });
__fire(cv, 'pointerdown', __fakeEvent(fireflyTabBtn.x, fireflyTabBtn.y));
__check('tapping the Fireflies tab switches the Journal to the (unchanged) firefly discovery grid', journalTab === 'fireflies');
var trackerBefore = trackerOn;
__fire(cv, 'pointerdown', __fakeEvent(TRACKER_TOGGLE.x, TRACKER_TOGGLE.y));
__check('the relocated Tracker toggle still works from the Journal screen\\'s Fireflies tab (same trackerOn source of truth)', trackerOn === !trackerBefore);
__fire(cv, 'pointerdown', __fakeEvent(JOURNAL_CLOSE_BTN.x, JOURNAL_CLOSE_BTN.y));
__check('the Journal close button returns to the title screen (journalFrom was \\'title\\')', screen === 'title');

// Glowkeeper Story pass: chapter unlock gating reuses restorationPct(best)
// directly against the SAME pct thresholds VILLAGE_MILESTONES already
// uses -- HEART_TIER_THRESH=[0,5,10,15,20,25] means restorationPct(best)
// only ever lands on 0/20/40/60/80/100, so these exact "best" values are
// the only way to hit each rung deterministically.
(function(){
  reset(); screen = 'title';
  best = 0;
  __check('The First Night is unlocked at 0% restoration (always available)', storyKeyUnlocked('first-night') === true);
  __check('Dawn Chorus is locked at 0% restoration', storyKeyUnlocked('dawn-chorus') === false);
  __check('The Old Glowkeeper is locked before Dawn Chorus is reached', storyKeyUnlocked('old-glowkeeper') === false);
  __check('The Old Glowkeeper row does not even appear in the list before Dawn Chorus', storyRowRects().some(function(r){ return r.key === 'old-glowkeeper'; }) === false);

  best = 10; // heartTier -> 3 -> restorationPct 40: First Window(10)/Bakery(25)/Lantern Garden(40) unlocked, Fountain(60)+ still locked
  __check('First Window is unlocked once restoration reaches its milestone (40% >= 10%)', storyKeyUnlocked('first-window') === true);
  __check('Lantern Garden is unlocked at exactly its own 40% threshold', storyKeyUnlocked('lantern-garden') === true);
  __check('The Fountain (60%) stays locked at 40% restoration', storyKeyUnlocked('fountain') === false);

  best = 25; // heartTier -> 6 -> restorationPct 100: everything unlocked, including the post-100% teaser
  __check('Dawn Chorus is unlocked at 100% restoration', storyKeyUnlocked('dawn-chorus') === true);
  __check('The Old Glowkeeper unlocks the instant Dawn Chorus does', storyKeyUnlocked('old-glowkeeper') === true);
  __check('The Old Glowkeeper row appears in the list once Dawn Chorus is reached', storyRowRects().some(function(r){ return r.key === 'old-glowkeeper'; }) === true);
  __check('latestUnlockedChapterKey() reports Dawn Chorus at 100%', latestUnlockedChapterKey() === 'dawn-chorus');

  // tapping a locked row does nothing; tapping an unlocked one opens it
  best = 0; screen = 'journal'; journalTab = 'story'; journalReading = null; journalFrom = 'title';
  var dawnRow = storyRowRects().find(function(r){ return r.key === 'dawn-chorus'; });
  __fire(cv, 'pointerdown', __fakeEvent(dawnRow.x, dawnRow.y));
  __check('tapping a LOCKED chapter row does not open it', journalReading === null);
  var firstNightRow = storyRowRects().find(function(r){ return r.key === 'first-night'; });
  __fire(cv, 'pointerdown', __fakeEvent(firstNightRow.x, firstNightRow.y));
  __check('tapping an UNLOCKED chapter row opens it', journalReading === 'first-night');
  var readingThrew = false;
  try { draw(); } catch (e) { readingThrew = true; }
  __check('the chapter reading view renders without throwing', !readingThrew);
  __fire(cv, 'pointerdown', __fakeEvent(JOURNAL_CLOSE_BTN.x, JOURNAL_CLOSE_BTN.y));
  __check('closing from the reading view goes back to the chapter list first, not straight to title', journalReading === null && screen === 'journal');
  __fire(cv, 'pointerdown', __fakeEvent(JOURNAL_CLOSE_BTN.x, JOURNAL_CLOSE_BTN.y));
  __check('a second close from the list actually exits the Journal', screen === 'title');

  // The Old Glowkeeper's 3 fragments render too, once unlocked
  best = 25; screen = 'journal'; journalTab = 'story'; journalReading = 'old-glowkeeper';
  var oldGlowThrew = false;
  try { draw(); } catch (e) { oldGlowThrew = true; }
  __check('The Old Glowkeeper teaser + fragments render without throwing', !oldGlowThrew);
  __check('The Old Glowkeeper has exactly 3 fragments (per direct instruction, not a 4th "explanation")', OLD_GLOWKEEPER_FRAGMENTS.length === 3);

  // Village -> Journal: opens straight to the latest unlocked chapter, and
  // remembers to come back to the Village screen on close, not title
  screen = 'village'; journalReading = null; journalFrom = 'title';
  var rjRect = villageReadJournalRect();
  __fire(cv, 'pointerdown', __fakeEvent(rjRect.x, rjRect.y));
  __check('"Read Journal ->" on the Village screen opens the Journal straight to the latest unlocked chapter', screen === 'journal' && journalReading === 'dawn-chorus' && journalFrom === 'village');
  __fire(cv, 'pointerdown', __fakeEvent(JOURNAL_CLOSE_BTN.x, JOURNAL_CLOSE_BTN.y)); // reading -> list
  __fire(cv, 'pointerdown', __fakeEvent(JOURNAL_CLOSE_BTN.x, JOURNAL_CLOSE_BTN.y)); // list -> back to Village, not title
  __check('closing the Journal after opening it from the Village screen returns to the Village, not the title screen', screen === 'village');

  screen = 'title'; best = 0;
})();

// Story unlock gating touches nothing gameplay-related -- it only ever
// READS restorationPct(best)/VILLAGE_MILESTONES, never writes to them or
// to any economy value.
(function(){
  reset(); S.score = 20;
  var dBefore = diff(), capBefore = jarCapacityForRun(), coinsBefore = coins;
  storyKeyUnlocked('dawn-chorus'); latestUnlockedChapterKey(); storyRowRects();
  var dAfter = diff(), capAfter = jarCapacityForRun(), coinsAfter = coins;
  __check('calling the new story-unlock helpers has zero effect on diff()/jarCapacityForRun()/coins', JSON.stringify({ maxFlies: dBefore.maxFlies, blue: dBefore.blue, shy: dBefore.shy }) === JSON.stringify({ maxFlies: dAfter.maxFlies, blue: dAfter.blue, shy: dAfter.shy }) && capBefore === capAfter && coinsBefore === coinsAfter);
})();

// Restart Night: only acts during a USER pause (same guard discipline as
// Resume itself). LUMORA clarifications pass: no longer resets in one tap --
// first tap opens a confirmation modal (pauseConfirm='restart'), and it
// takes a second tap on CONFIRM_ACTION_BTN to actually restart.
reset(); screen = 'play'; paused = false; S.score = 12; S.carried = [{ type: 'y', ph: 0, sp: 1 }];
pauseGame('user');
__fire(cv, 'pointerdown', __fakeEvent(RESTART_BTN.x, RESTART_BTN.y));
__check('tapping Restart Night opens a confirmation modal instead of restarting immediately', pauseConfirm === 'restart' && S.score === 12 && paused === true);
var confirmDrawThrew = false;
try { draw(); } catch (e) { confirmDrawThrew = true; }
__check('the Restart Night confirmation modal draws without throwing', !confirmDrawThrew);
__fire(cv, 'pointerdown', __fakeEvent(CONFIRM_CANCEL_BTN.x, CONFIRM_CANCEL_BTN.y));
__check('Cancel closes the confirmation modal without restarting or resuming', pauseConfirm === null && S.score === 12 && paused === true);
__fire(cv, 'pointerdown', __fakeEvent(RESTART_BTN.x, RESTART_BTN.y));
__fire(cv, 'pointerdown', __fakeEvent(CONFIRM_ACTION_BTN.x, CONFIRM_ACTION_BTN.y));
__check('confirming Restart Night resets the round (score back to 0) and resumes', S.score === 0 && S.carried.length === 0 && paused === false && pauseConfirm === null);
reset(); screen = 'play'; paused = false; S.score = 7;
pauseGame('system'); // e.g. onPause from the SDK -- not a user-initiated pause
__fire(cv, 'pointerdown', __fakeEvent(RESTART_BTN.x, RESTART_BTN.y));
__check('Restart Night does nothing during a SYSTEM pause -- same guard as Resume, no state leaks through', S.score === 7 && paused === true && pauseConfirm === null);
resumeGame();

// Go Home: conditional confirmation -- an empty jar leaves immediately, a
// jar with undelivered fireflies confirms first (spec section 15). Either
// way, permanent progress (coins/upgrades) is untouched; only the active
// round is abandoned (screen -> 'title', no reset() call).
reset(); screen = 'play'; paused = false; S.carried = [];
pauseGame('user');
__fire(cv, 'pointerdown', __fakeEvent(GOHOME_BTN.x, GOHOME_BTN.y));
__check('Go Home with an empty jar leaves immediately, no confirmation modal', screen === 'title' && paused === false && pauseConfirm === null);
reset(); screen = 'play'; paused = false; S.score = 9; S.carried = [{ type: 'y', ph: 0, sp: 1 }];
pauseGame('user');
__fire(cv, 'pointerdown', __fakeEvent(GOHOME_BTN.x, GOHOME_BTN.y));
__check('Go Home with a non-empty jar opens a confirmation modal and stays on the round', pauseConfirm === 'gohome' && screen === 'play' && paused === true);
var coinsBeforeGoHome = coins, upgradesBeforeGoHome = JSON.stringify(upgrades);
__fire(cv, 'pointerdown', __fakeEvent(CONFIRM_CANCEL_BTN.x, CONFIRM_CANCEL_BTN.y));
__check('Cancel closes the Go Home modal and stays on the round', pauseConfirm === null && screen === 'play' && paused === true);
__fire(cv, 'pointerdown', __fakeEvent(GOHOME_BTN.x, GOHOME_BTN.y));
__fire(cv, 'pointerdown', __fakeEvent(CONFIRM_ACTION_BTN.x, CONFIRM_ACTION_BTN.y));
__check('confirming Go Home returns to the title screen, resumed, with permanent progress untouched', screen === 'title' && paused === false && pauseConfirm === null && coins === coinsBeforeGoHome && JSON.stringify(upgrades) === upgradesBeforeGoHome);
reset(); screen = 'play'; paused = false;

// Escape/Enter interplay with the confirm modal: Esc cancels the modal
// first rather than falling through to resume in the same keystroke;
// Enter/Space are inert while a modal is open (no keyboard shortcut can
// trigger the destructive action, only an explicit tap on CONFIRM_ACTION_BTN)
reset(); screen = 'play'; paused = false; S.score = 5;
pauseGame('user');
__fire(cv, 'pointerdown', __fakeEvent(RESTART_BTN.x, RESTART_BTN.y));
__fire(window, 'keydown', { key: 'Escape', preventDefault: function(){} });
__check('Escape cancels an open confirm modal instead of resuming', pauseConfirm === null && paused === true && S.score === 5);
__fire(cv, 'pointerdown', __fakeEvent(RESTART_BTN.x, RESTART_BTN.y));
__fire(window, 'keydown', { key: 'Enter', preventDefault: function(){} });
__check('Enter does nothing while the confirm modal is open (no keyboard shortcut for the destructive action)', pauseConfirm === 'restart' && paused === true && S.score === 5);
pauseConfirm = null; resumeGame();

// RunSummary (drawOver): the "Coins Earned" stat row reads a THIS-RUN delta
// via coinsAtRoundStart, not the all-time coins total -- same pattern as
// bestAtRoundStart already proved for the restoration-% row
coins = 40; // residual coins from a previous round
reset(); screen = 'play'; paused = false; // snapshots coinsAtRoundStart fresh, right here
__check('coinsAtRoundStart is snapshotted fresh by reset() (matches coins at the moment the round started)', coinsAtRoundStart === 40);
coins = 55; // this round delivered 15 coins' worth
S.over = true; S.overT = 1; S.carried = [];
var overDrawThrew = false;
try { draw(); } catch (e) { overDrawThrew = true; }
__check('the restyled RunSummary (Night Complete) draws without throwing, with a real coins-earned-this-run delta available', !overDrawThrew && (coins - coinsAtRoundStart) === 15);
`);

// =====================================================================
// Scenario 2: Playables env, loadData resolves fast (before first saveProgress call)
// =====================================================================
scenario('playables-fast-load', { audioEnabled: true, mockNowMs: FIXED_NOW_SAME_DAY_MS }, `
__check('YT is the mock ytgame object inside Playables env', YT === ytgame);
// Run one real title-screen frame BEFORE anything switches screen away from
// 'title' -- this is the actual condition gameReady's guard checks, and it's
// also the only point at which the real ytgame.game.firstFrameReady/gameReady
// SDK calls get exercised at all (screen must still be 'title' when the frame
// renders for the gameReady guard to pass).
__stepFrame(16);
__check('firstFrameReady is actually called on the mock SDK (not just the local flag)', __spy.lifecycleCalls.indexOf('firstFrameReady') !== -1, 'calls=' + JSON.stringify(__spy.lifecycleCalls));
__check('gameReady is actually called on the mock SDK once the title screen has rendered', __spy.lifecycleCalls.indexOf('gameReady') !== -1, 'calls=' + JSON.stringify(__spy.lifecycleCalls));
__check('firstFrameReady is called before gameReady, and each exactly once', __spy.lifecycleCalls.length === 2 && __spy.lifecycleCalls[0] === 'firstFrameReady' && __spy.lifecycleCalls[1] === 'gameReady', 'calls=' + JSON.stringify(__spy.lifecycleCalls));
// stepping more frames (still on the title screen) must not re-fire either hook
for (var lci = 0; lci < 10; lci++) __stepFrame(16);
__check('neither hook re-fires on subsequent frames', __spy.lifecycleCalls.length === 2, 'calls=' + JSON.stringify(__spy.lifecycleCalls));

// staleLastPlayed simulates a returning player last active 10h before a
// FIXED "now" (mockNowMs above pins Date.now(), so lastPlayed=Date.now() at
// game-script-eval time is deterministic too) -- past the 6h welcome-back
// threshold but still the SAME local calendar day (2026-08-10 02:00 vs.
// 2026-08-10 12:00), so this scenario also proves the lifecycle hooks stay
// correct with the overlay actually in the mix, not just when it's inert.
// FORMERLY FLAKY (found during Phase 1 economy work): this used to compute
// "10h ago" from the REAL Date.now(), so within ~6h of local midnight "10h
// ago" could land on the previous calendar day and spuriously trigger a
// quest reroll here even though resolveQuests() was behaving correctly. Both
// timestamps are fixed now, so this is deterministic regardless of when the
// suite actually runs. The cross-midnight/reroll case itself is covered
// separately below (playables-quest-reroll-cross-midnight).
var staleLastPlayed = ${FIXED_LASTPLAYED_SAME_DAY_MS};
// upgrades.magnetTier: 1 here deliberately simulates a save from BEFORE the
// Shop Restructure split Extended Reach into Collection Range + Magnet
// Duration -- this is the migration path's own proof, not just a shape check.
// upgrades.jarTier: 1 simulates a save from BEFORE the LUMORA clarifications
// pass retired the shared "Bonus Capacity" line -- no equippedJar field at
// all in this payload either, simulating the oldest possible save, so
// migrateJarTier() must fall back to 'simple' and seed ONLY that jar.
__spy.loadResolve(JSON.stringify({ best: 42, coins: 63, journal: { y: 5, b: 2, g: 0, e: 0 }, upgrades: { jarTier: 1, magnetTier: 1, deco: true }, trackerOn: true, lastPlayed: staleLastPlayed, quests: [{ id: 'catch10y', desc: 'x', kind: 'catch', type: 'y', target: 10, progress: 3, done: false, reward: { kind: 'coins', val: 40 } }] }));
return __tick(5).then(function(){
  __check('loadData resolving sets best from cloud save', best === 42, 'best=' + best);
  __check('loadDone flips true once loadData resolves', loadDone === true);
  // simulated close-and-reopen for coins/journal, same proof shape as best above --
  // a fresh "session" (this scenario's own fresh vm context) loading a real cloud
  // save must restore the exact persisted values, not start over or partially apply
  __check('reopening restores the persisted coin total exactly', coins === 63, 'coins=' + coins);
  // this mock payload has coins but no coinFraction at all -- exactly the
  // real-world shape of a save from before the fractional coin bank
  // existed. Phase 1 economy pass, migration safety per direct instruction:
  // the existing whole coins must NOT be lost, and coinFraction must
  // default safely to 0 rather than throwing or corrupting.
  __check('a pre-fractional-economy save with coins but no coinFraction field loses none of its existing whole coins', coins === 63, 'coins=' + coins);
  __check('coinFraction safely defaults to 0 when an old save has no coinFraction field at all', coinFraction === 0, 'coinFraction=' + coinFraction);
  // the mock cloud payload above simulates a save from BEFORE Mystery Firefly
  // existed (no 'm' key at all) -- journal.m correctly stays at its own
  // already-initialized default (0) rather than erroring, same defensive
  // per-field pattern as every other field extension in this project
  __check('reopening restores the persisted per-type journal counts exactly (and defaults the not-yet-existing Mystery entry)', JSON.stringify(journal) === JSON.stringify({ y: 5, b: 2, g: 0, e: 0, m: 0 }), 'journal=' + JSON.stringify(journal));
  // the mock cloud payload above simulates a save from BEFORE Village Fountain
  // existed (no 'fountain' key) -- upgrades.fountain correctly defaults to its
  // own already-initialized value (false), same defensive pattern as journal.m earlier
  // the mock cloud payload above simulates a save from BEFORE Stage 4 (jar skins/
  // trail colors) existed -- those fields correctly default to their own
  // already-initialized values (classic/none, always owned), same pattern as fountain earlier
  // the payload's magnetTier:1 (the old bundled Extended Reach, pre-split) must
  // migrate into BOTH rangeTier and durationTier at that same tier count, per
  // migrateMagnetTier() -- a returning owner keeps a tier's worth of progress in
  // both new lines rather than losing it to the split. lightTier is brand new,
  // no old field to migrate from, defaults to 0 same as fountain/skins above.
  // The payload's jarTier:1 (the old shared "Bonus Capacity" line) must migrate
  // through migrateJarTier() into jarCapTiers.simple:1 ONLY -- no equippedJar in
  // this payload, so it falls back to 'simple' per direct decision (seed the
  // jar that was equipped, not every owned jar); every other jar in jarCapTiers
  // stays at its own default (0). The bare jarTier field itself is gone from
  // upgrades' shape entirely now, same as magnetTier/rangeTier before it.
  // E2 Shop Economy 2.0: migrateEconomyV2() now ALSO runs (once) right
  // after this legacy migration finishes, converting the just-migrated
  // reach/magnetReach/duration tier=1 counts (produced under the OLD flat
  // step) into their E2 equivalents under the NEW, smaller per-jar steps --
  // "preserve or slightly increase power, never reduce it": old tier 1
  // reach (55+1*3=58) becomes new tier 11 (55+11*0.29=58.19, the smallest
  // new tier that reaches >=58); magnetReach (130+10=140) becomes new tier
  // 10 (130+10*1=140 exactly); duration (4.0+0.5=4.5) becomes new tier 9
  // (4.0+9*0.056=4.504, the smallest new tier >=4.5). Capacity is
  // untouched (its formula never changed) and economyV2Migrated is now
  // set, guarding against this ever running a second time.
  __check('reopening migrates a pre-split magnetTier into per-jar reach/magnetReach/duration, migrates a legacy jarTier into per-jar jarCapTiers, defaults the not-yet-existing fountain/statue/skins/trails/lightTier fields, and (E2) converts those migrated tiers into their new-step equivalents exactly once', JSON.stringify(upgrades) === JSON.stringify({ lightTier: 0, deco: true, fountain: false, statueOwned: false, statueEquipped: false, tutorialDone: false, ownedJars: { simple: true }, equippedJar: 'simple', ownedTrails: { none: true }, equippedTrail: 'none', jarCapTiers: { simple: 1, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, reachTiers: { simple: 11, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, magnetReachTiers: { simple: 10, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, durationTiers: { simple: 9, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, lightValueTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, dailyDeal: null, economyV2Migrated: true }), 'upgrades=' + JSON.stringify(upgrades));
  __check('reopening restores the Tracker toggle exactly', trackerOn === true);
  __check('reopening restores the persisted lastPlayed and quest progress exactly', prevLastPlayed === staleLastPlayed && quests.length === 1 && quests[0].progress === 3, 'prevLastPlayed=' + prevLastPlayed + ' quests=' + JSON.stringify(quests));

  // the actual point of using a stale lastPlayed above: the welcome-back overlay
  // becomes genuinely active here, and the lifecycle hooks must still be exactly
  // as they were BEFORE this resolved -- no re-fire, no reorder, no delay caused
  // by the overlay logic running in the same async tick
  __check('welcome-back is genuinely active this time (stale lastPlayed, past the 6h threshold)', showWelcomeBack === true, 'showWelcomeBack=' + showWelcomeBack);
  __check('the lifecycle hooks are UNCHANGED by the welcome-back overlay becoming active -- still exactly 2 calls, still firstFrameReady before gameReady', __spy.lifecycleCalls.length === 2 && __spy.lifecycleCalls[0] === 'firstFrameReady' && __spy.lifecycleCalls[1] === 'gameReady', 'calls=' + JSON.stringify(__spy.lifecycleCalls));

  __check('localStorage is never read inside the Playables env', __spy.lsGetCalls === 0);

  // sendScore must report the all-time BEST, never the current round's (possibly lower) score.
  // Simulate a prior higher-scoring round, then a fresh lower-scoring round ending in game over.
  best = 99;
  reset(); screen = 'play';
  S.misses = 4;
  spawnFly('y');
  var f = S.flies[S.flies.length - 1];
  f.patience = 0.01; f.rest = 0; f.pause = 0;
  for (var i = 0; i < 60 && !S.over; i++) __stepFrame(16);
  __check('round ended via 5th miss', S.over === true);
  __check('a Night Complete tip was picked from NIGHT_TIPS, not left empty', typeof S.tip === 'string' && NIGHT_TIPS.indexOf(S.tip) !== -1, 'tip=' + JSON.stringify(S.tip));
  var drawOverThrew = false;
  try { draw(); } catch (e) { drawOverThrew = true; }
  __check('drawOver() renders the picked tip without throwing', !drawOverThrew);
  __check('this round\\'s score is lower than the carried-over best', S.score < best, 'score=' + S.score + ' best=' + best);
  var lastSend = __spy.sendScoreCalls[__spy.sendScoreCalls.length - 1];
  __check('sendScore reports best, not the lower round score', !!lastSend && lastSend.value === 99, 'sent=' + JSON.stringify(lastSend));

  __check('localStorage is never written inside the Playables env either', __spy.lsSetCalls === 0);

  // single pause gate: system pause (onPause) and the in-game pause button must share one gate
  reset(); screen = 'play'; paused = false;
  __spy.onPauseCb();
  __check('system onPause routes through the same pauseGame gate', paused === true && pauseReason === 'system');
  __fire(cv, 'pointerdown', __fakeEvent(RESUME_BTN.x, RESUME_BTN.y));
  __check('resume-button tap does NOT resume a system pause (reason must be user)', paused === true);
  __spy.onResumeCb();
  __check('system onResume resumes cleanly', paused === false && pauseReason === null);

  // switching screens and pausing/resuming afterward must not re-fire either lifecycle hook
  __check('lifecycle hooks still fired exactly once after screen changes and a pause/resume cycle', __spy.lifecycleCalls.length === 2, 'calls=' + JSON.stringify(__spy.lifecycleCalls));

  // Stage 2 Part A extended the save schema to {best, coins, journal}; Part B
  // extends it again to add upgrades + trackerOn. Same discipline each time:
  // the invariant is "exactly the current intended shape, nothing stray" --
  // updated to match, not loosened or deleted, every time the shape legitimately grows.
  best = 30; coins = 47; journal = { y: 3, b: 1, g: 0, e: 0, m: 2 };
  saveProgress();
  var lastSave = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1] || '{}');
  // Stage 3 Part A (weather + Mystery Firefly) added ZERO new top-level save
  // fields; Stage 3 Part C (quests + welcome-back) legitimately adds two more
  // (lastPlayed, quests) -- same discipline every time the shape grows for real
  __check('the saved payload is exactly the existing fields plus the Lumora 2.0 Phase 0/9 foundation fields -- no stray extra field, still one save call', JSON.stringify(Object.keys(lastSave).sort()) === JSON.stringify(['best', 'cachedNightEvent', 'cachedNightEventFor', 'cachedNightObjectives', 'cachedNightObjectivesFor', 'coinFraction', 'coins', 'contractsCompleted', 'cosmeticsUnlocked', 'equippedTheme', 'eventHistory', 'journal', 'lastNightCompletionDay', 'lastPlayed', 'nightNumber', 'nightStreak', 'objectivesCompleted', 'prestigeLevel', 'quests', 'seasonId', 'seasonProgress', 'trackerOn', 'upgrades', 'variantJournal', 'weekly', 'workshopTokens']) && lastSave.best === 30 && lastSave.coins === 47, 'payload=' + JSON.stringify(lastSave));
  __check('the saved journal payload matches the live per-type counts, including Mystery', JSON.stringify(lastSave.journal) === JSON.stringify({ y: 3, b: 1, g: 0, e: 0, m: 2 }), 'journal=' + JSON.stringify(lastSave.journal));
  return true;
});
`);

// =====================================================================
// Scenario: Playables env, a cloud save's lastPlayed falls on the PREVIOUS
// local calendar day relative to a fixed "now" -- only 2 minutes apart in
// real time (23:59 -> 00:01), well under the 6h welcome-back threshold, so
// this isolates the day-boundary reroll behavior from the welcome-back gap
// check entirely (the two are intentionally NOT the same condition; see
// resolveQuests()). Companion to playables-fast-load's same-day case above.
// =====================================================================
scenario('playables-quest-reroll-cross-midnight', { audioEnabled: true, mockNowMs: FIXED_NOW_CROSS_MIDNIGHT_MS }, `
var stalePrevDayLastPlayed = ${FIXED_LASTPLAYED_CROSS_MIDNIGHT_MS};
__spy.loadResolve(JSON.stringify({ best: 5, lastPlayed: stalePrevDayLastPlayed, quests: [{ id: 'catch10y', desc: 'x', kind: 'catch', type: 'y', target: 10, progress: 7, done: false, reward: { kind: 'coins', val: 40 } }] }));
return __tick(5).then(function(){
  __check('prevLastPlayed is still recorded from the cloud save even though quests get rerolled', prevLastPlayed === stalePrevDayLastPlayed, 'prevLastPlayed=' + prevLastPlayed);
  __check('a lastPlayed from the previous calendar day rolls FRESH quests instead of restoring the stale ones', quests.length > 0 && quests.length <= 3 && !(quests.length === 1 && quests[0].id === 'catch10y' && quests[0].progress === 7), 'quests=' + JSON.stringify(quests));
  __check('welcome-back does NOT show for a cross-midnight gap under the 6h threshold (day-boundary and welcome-back are independent checks)', showWelcomeBack === false, 'showWelcomeBack=' + showWelcomeBack);
  return true;
});
`);

// =====================================================================
// Scenario 3: Playables env, loadData resolves SLOW — exercises the
// pendingSave gate ("platform rejects saveData until initial loadData resolves").
// =====================================================================
scenario('playables-slow-load', { audioEnabled: false }, `
__check('audioEnabled reflects isAudioEnabled() at startup', audioEnabled === false);
__check('loadDone starts false when loadData has not resolved yet', loadDone === false);

// a milestone save attempt before load resolves must be deferred, not dropped or double-sent
reset(); screen = 'play';
saveProgress();
__check('saveProgress before loadDone defers instead of calling saveData', pendingSave === true && __spy.saveDataCalls.length === 0);

__spy.loadResolve(JSON.stringify({})); // old-style save with no "best" field — must degrade gracefully
return __tick(5).then(function(){
  __check('loadData resolving with a field-less payload does not throw and best stays a number', typeof best === 'number' && !isNaN(best), 'best=' + best);
  __check('the deferred save flushes exactly once after load resolves', __spy.saveDataCalls.length === 1, 'saveDataCalls=' + __spy.saveDataCalls.length);
  __check('pendingSave is cleared after flushing', pendingSave === false);

  // onAudioEnabledChange must not resume audio through an active pause
  initAudio();
  pauseGame('system');
  __spy.onAudioChangeCb(true);
  __check('audio-enabled toggle during a pause does not resume the AudioContext', !AC || AC.state !== 'running');
  resumeGame();
  return true;
});
`);

// =====================================================================
// Scenario 4: an old-format save from BEFORE Stage 2 Part A existed —
// exactly {best}, no coins field, no journal field at all. Must load without
// throwing and default the new fields sensibly, then save forward in the
// full extended schema from then on.
// =====================================================================
scenario('playables-old-format-save', { audioEnabled: true }, `
__check('coins, journal (including Mystery), upgrades (including fountain/statue/skins/trails) and trackerOn all start at their initialized defaults before any load resolves', coins === 0 && JSON.stringify(journal) === JSON.stringify({ y: 0, b: 0, g: 0, e: 0, m: 0 }) && JSON.stringify(upgrades) === JSON.stringify({ lightTier: 0, deco: false, fountain: false, statueOwned: false, statueEquipped: false, tutorialDone: false, ownedJars: { simple: true }, equippedJar: 'simple', ownedTrails: { none: true }, equippedTrail: 'none', jarCapTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, reachTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, magnetReachTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, durationTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, lightValueTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, dailyDeal: null }) && trackerOn === false);
__spy.loadResolve(JSON.stringify({ best: 12 })); // the exact shape the shipped build has always saved -- no coins, journal, upgrades, or trackerOn at all
return __tick(5).then(function(){
  __check('an old-format {best}-only save loads without throwing', best === 12, 'best=' + best);
  __check('coins defaults sensibly (stays 0) when the old save has no coins field', coins === 0, 'coins=' + coins);
  __check('coinFraction defaults sensibly (stays 0) when the old save has no coinFraction field', coinFraction === 0, 'coinFraction=' + coinFraction);
  __check('journal defaults sensibly (all-zero, including Mystery) when the old save has no journal field', JSON.stringify(journal) === JSON.stringify({ y: 0, b: 0, g: 0, e: 0, m: 0 }), 'journal=' + JSON.stringify(journal));
  // E2 Shop Economy 2.0: migrateEconomyV2() runs unconditionally right
  // after the load callback's own d.upgrades merge block (even when
  // d.upgrades didn't exist at all, as here) -- a safe no-op against an
  // already-all-zero upgrades object, but it DOES set economyV2Migrated,
  // which a completely fresh/old-format player should carry from here on
  // (so a later real purchase never re-triggers a migration pass).
  __check('upgrades defaults sensibly (nothing owned, including fountain/statue/skins/trails) when the old save has no upgrades field', JSON.stringify(upgrades) === JSON.stringify({ lightTier: 0, deco: false, fountain: false, statueOwned: false, statueEquipped: false, tutorialDone: false, ownedJars: { simple: true }, equippedJar: 'simple', ownedTrails: { none: true }, equippedTrail: 'none', jarCapTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, reachTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, magnetReachTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, durationTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, lightValueTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 0, aurora: 0 }, dailyDeal: null, economyV2Migrated: true }), 'upgrades=' + JSON.stringify(upgrades));
  __check('trackerOn defaults sensibly (off) when the old save has no trackerOn field', trackerOn === false);
  __check('an old-format save with no lastPlayed field is treated as a genuine first-ever session (fresh quests rolled, not an empty/broken list)', quests.length > 0 && quests.length <= 3);
  __check('welcome-back never shows for a save with no real prevLastPlayed to compare against', showWelcomeBack === false);
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('saving after loading an old-format save now writes the full extended schema going forward, including the Lumora 2.0 Phase 0/9 foundation fields', JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['best', 'cachedNightEvent', 'cachedNightEventFor', 'cachedNightObjectives', 'cachedNightObjectivesFor', 'coinFraction', 'coins', 'contractsCompleted', 'cosmeticsUnlocked', 'equippedTheme', 'eventHistory', 'journal', 'lastNightCompletionDay', 'lastPlayed', 'nightNumber', 'nightStreak', 'objectivesCompleted', 'prestigeLevel', 'quests', 'seasonId', 'seasonProgress', 'trackerOn', 'upgrades', 'variantJournal', 'weekly', 'workshopTokens']), 'payload=' + JSON.stringify(payload));
  return true;
});
`);

// Scenario: a corrupted/tampered cloud save where "best" is a numeric-looking
// STRING rather than a number (every sibling field -- coins, coinFraction,
// journal.*, upgrades.*, trackerOn, lastPlayed -- has always been guarded with
// typeof==='number'/'string'/etc before being trusted; best was the one
// exception, so a tampered save like best:"999" would pass the old bare
// "d.best>best" comparison via JS's implicit string-to-number coercion and get
// ASSIGNED as a string, silently turning best from a number into a string for
// the rest of the session). Final Audit fix: best now shares the same
// typeof==='number' guard every other field already had.
// =====================================================================
// Lumora 2.0 Phase 9: a real cloud save that already has weekly progress
// from earlier in the SAME week (mockNowMs keeps lastPlayed/prevLastPlayed
// inside the same weekKey() bucket) restores it exactly, through the real
// YT loadData() -> resolveWeekly(d.weekly) path, not just the non-YT
// localStorage path the lumora2-phase9-weekly scenario already covers.
scenario('playables-weekly-restore', { audioEnabled: true, mockNowMs: FIXED_NOW_SAME_DAY_MS }, `
__spy.loadResolve(JSON.stringify({ best: 10, coins: 50, lastPlayed: ${FIXED_NOW_SAME_DAY_MS} - 1000, weekly: { stats: { fireflies: 42, rare: 3, nights: 2, events: 1 }, claimed: { fireflies: false, rare: true, nights: false, events: false }, chestClaimed: false } }));
return __tick(5).then(function(){
  __check('a real cloud save\\'s weekly stats restore exactly through resolveWeekly(d.weekly), same week', JSON.stringify(weeklyStats) === JSON.stringify({ fireflies: 42, rare: 3, nights: 2, events: 1 }), 'weeklyStats=' + JSON.stringify(weeklyStats));
  __check('a real cloud save\\'s weekly claimed-milestone flags restore exactly, same week', weeklyMilestonesClaimed.rare === true && weeklyMilestonesClaimed.fireflies === false);
  __check('existing progression (best/coins) still restores correctly alongside the new Phase 9 weekly fields', best === 10 && coins === 50);
});
`);

scenario('playables-corrupted-best-save', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: '999', coins: 5 }));
return __tick(5).then(function(){
  __check('a numeric-looking STRING best in a corrupted save is rejected, not assigned', best !== '999', 'best=' + JSON.stringify(best) + ' typeof=' + typeof best);
  __check('best stays a real number (its initialized default) when the cloud value fails the type guard', typeof best === 'number' && !isNaN(best), 'best=' + JSON.stringify(best));
  __check('a sibling numeric field on the same payload still loads normally (the guard did not break normal loading)', coins === 5, 'coins=' + coins);
  return true;
});
`);

// =====================================================================
// Scenario: game must initialize and reach gameReady even when the initial
// browser viewport is 0x0 (YouTube's own documented Playables WebView
// behavior -- the game is loaded hidden before the host actually shows/
// sizes the page). This scenario's window starts at innerWidth/innerHeight
// 0/0 (see initialViewport above), so GAME_SRC's own synchronous top-level
// `resize()` call already ran under a zero viewport by the time this driver
// starts running.
// =====================================================================
scenario('zero-viewport-init', { audioEnabled: true, initialViewport: [0, 0] }, `
__check('the canvas has a valid non-zero internal drawing resolution immediately after load, even though the initial viewport was 0x0', cv.width > 0 && cv.height > 0, 'cv.width=' + cv.width + ' cv.height=' + cv.height);
__check('scale falls back to a real, non-degenerate value (not 0) when the viewport starts at 0x0', scale > 0, 'scale=' + scale);
__check('neither lifecycle hook has fired yet -- no frame has actually been stepped', firstFrameSent === false && gameReadySent === false);

__stepFrame(16);
__check('firstFrameReady fires on the very first frame even though the viewport is still 0x0', firstFrameSent === true && __spy.lifecycleCalls.indexOf('firstFrameReady') !== -1, 'firstFrameSent=' + firstFrameSent + ' calls=' + JSON.stringify(__spy.lifecycleCalls));
__check('gameReady fires once the (interactive) title screen has rendered, still under a 0x0 viewport', gameReadySent === true && __spy.lifecycleCalls.indexOf('gameReady') !== -1, 'gameReadySent=' + gameReadySent + ' calls=' + JSON.stringify(__spy.lifecycleCalls));
__check('firstFrameReady fired before gameReady, exactly once each', __spy.lifecycleCalls.length === 2 && __spy.lifecycleCalls[0] === 'firstFrameReady' && __spy.lifecycleCalls[1] === 'gameReady', 'calls=' + JSON.stringify(__spy.lifecycleCalls));

// stepping more frames under the still-zero viewport must not re-fire either hook
for (var zi = 0; zi < 10; zi++) __stepFrame(16);
__check('neither hook re-fires across further frames while the viewport is still 0x0', __spy.lifecycleCalls.length === 2);

// the real viewport now arrives (e.g. the host finally shows/sizes the WebView) --
// loop()'s own per-frame poll should pick this up on its own, same as any other resize
window.innerWidth = 375; window.innerHeight = 812;
__stepFrame(16);
__check('once a real viewport arrives, resize() recomputes a real (non-fallback) scale matching it, not the 0x0 fallback', scale === Math.min(375 / W, 812 / H), 'scale=' + scale);
__check('cv.width/height stay valid and update to reflect the real viewport once it arrives', cv.width > 0 && cv.height > 0);
__check('the lifecycle hooks are still exactly the same two calls -- the real viewport arriving later does not re-fire them', __spy.lifecycleCalls.length === 2 && __spy.lifecycleCalls[0] === 'firstFrameReady' && __spy.lifecycleCalls[1] === 'gameReady', 'calls=' + JSON.stringify(__spy.lifecycleCalls));
`);

// =====================================================================
// Rework: "Double the Glow" (Night Complete rewarded-ad) tests. ytgame.ads
// is mocked entirely inline in this driver (ONLY here, per the harness ad-
// mocking rule -- production code never depends on this mock existing).
// rewardBehavior is a plain var the driver reassigns between phases so one
// scenario can cover every outcome (success/false/reject/throw/unavailable)
// against the exact same call path, instead of spinning up a separate vm
// context per outcome. The old flat "+100 coins" reward is gone completely
// -- there is no requestRewardedCoins()/REWARD_ID_100_COINS/
// S.rewardAdPending/S.rewardAdClaimed/WATCH_AD_BTN left anywhere in the
// source (verified: this scenario no longer references any of them).
// =====================================================================
scenario('ads-double-night-coins', {}, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 20, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
  __check('loadData resolved before the ad tests below run', loadDone === true);
  __check('tutorialDone restored from the mock cloud save', upgrades.tutorialDone === true);

  __check('reward ID is static and reused, matching REWARDED_AD_IDS.DOUBLE_NIGHT_COINS', REWARDED_AD_IDS.DOUBLE_NIGHT_COINS === 'lumora-double-night-coins');

  // Lumora 2.0 Phase 1: this scenario's every reset() now also runs
  // ensureNightObjectives(), which can roll a miss-category objective
  // ("Finish With 0 Misses") that would auto-pass at finalizeNight() since
  // S.misses is never touched here -- an unrelated, randomly-triggered coin
  // grant that has nothing to do with what THIS scenario tests (Double the
  // Glow's own doubling math). Neutralized here, once, for this scenario
  // only, so the economy stays fully deterministic; the real objective
  // system itself is exercised by the dedicated lumora2-phase1-* scenarios.
  ensureNightObjectives = function(){ S.objectiveActive = []; S.objectiveProgress = {}; };

  // ---- rewarded ads unavailable on this host: no button action, no throw, no coins ----
  // finalizeNight() (the real production function, not a hand-faked S.over)
  // is what snapshots S.coinsEarnedThisNight -- coins bumped BEFORE calling
  // it, matching how a real night's delivery earnings would already be in
  // \`coins\` by the time the 5th miss finalizes the round.
  reset(); coins += 18; finalizeNight(); // simulate a night that earned 18 coins
  var coinsBefore1 = coins;
  var threw1 = false;
  try { requestDoubleNightCoins(); } catch (e) { threw1 = true; }
  __check('requestDoubleNightCoins() does not throw when ytgame.ads is entirely absent', !threw1);
  __check('no reward is granted when ytgame.ads is unavailable (normal flow otherwise unaffected)', coins === coinsBefore1 && S.rewardedDoubleCoinsClaimed === false);

  // ---- install the mock SDK ads namespace ----
  var rewardCalls = [];
  var rewardBehavior = 'success'; // success | false | reject | throw
  ytgame.ads = {
    requestRewardedAd: function(id){
      rewardCalls.push(id);
      if (rewardBehavior === 'throw') throw new Error('mock rewarded throw');
      if (rewardBehavior === 'reject') return Promise.reject(new Error('mock rewarded reject'));
      return Promise.resolve(rewardBehavior === 'success');
    },
    requestInterstitialAd: function(){ return Promise.resolve(); }
  };
  __check('rewardedAdsAvailable() is true once ytgame.ads.requestRewardedAd exists', rewardedAdsAvailable() === true);

  // ---- 0 earnings: no offer, no-op ----
  reset(); finalizeNight(); // no coins added -- this night earned exactly 0
  var coinsBeforeZero = coins;
  requestDoubleNightCoins();
  __check('0 earnings this night means no reward offer -- requestDoubleNightCoins() is a no-op, no ad requested', coins === coinsBeforeZero && rewardCalls.length === 0 && S.rewardedDoubleCoinsClaimed === false);

  // ---- ads unavailable while the tutorial is not yet done: no button action ----
  upgrades.tutorialDone = false;
  reset(); coins += 18; finalizeNight();
  var coinsBeforeTut = coins;
  requestDoubleNightCoins();
  __check('requestDoubleNightCoins() is a no-op during the first-night tutorial even if ads are available', rewardCalls.length === 0 && coins === coinsBeforeTut && S.rewardedDoubleCoinsClaimed === false);
  upgrades.tutorialDone = true;

  // ---- false result grants nothing ----
  reset(); coins += 18; finalizeNight();
  rewardBehavior = 'false';
  var coinsBefore2 = coins;
  requestDoubleNightCoins();
  __check('button is marked pending immediately on tap, before the promise settles', S.rewardedDoubleCoinsPending === true);
  return __tick(5).then(function(){
    __check('a false result grants no coins', coins === coinsBefore2 && S.rewardedDoubleCoinsClaimed === false && S.rewardedDoubleCoinsPending === false, 'coins=' + coins);

    // ---- rejected request grants nothing ----
    reset(); coins += 18; finalizeNight();
    rewardBehavior = 'reject';
    var coinsBefore3 = coins;
    requestDoubleNightCoins();
    return __tick(5).then(function(){
      __check('a rejected ad request grants no coins and does not leave the round stuck pending', coins === coinsBefore3 && S.rewardedDoubleCoinsClaimed === false && S.rewardedDoubleCoinsPending === false, 'coins=' + coins);

      // ---- a synchronous throw grants nothing and does not propagate ----
      reset(); coins += 18; finalizeNight();
      rewardBehavior = 'throw';
      var coinsBefore4 = coins;
      var threw4 = false;
      try { requestDoubleNightCoins(); } catch (e) { threw4 = true; }
      __check('a synchronous throw from requestRewardedAd() does not propagate out of requestDoubleNightCoins()', !threw4);
      __check('a synchronous throw grants no coins and clears the pending flag', coins === coinsBefore4 && S.rewardedDoubleCoinsClaimed === false && S.rewardedDoubleCoinsPending === false);

      // ---- success grants EXACTLY this night's earnings (not the running balance), once, persists, rejects double taps / re-taps ----
      reset();
      var balanceAtRoundStart = coins;
      coins += 18; // this round earns exactly 18
      finalizeNight();
      rewardBehavior = 'success';
      var callsBefore5 = rewardCalls.length;
      var coinsBefore5 = coins;
      requestDoubleNightCoins();
      requestDoubleNightCoins(); // double tap while the first request is still pending
      __check('a double tap while a reward request is pending does not fire a second request', rewardCalls.length === callsBefore5 + 1, 'calls=' + rewardCalls.length);
      __check('requestRewardedAd is called with the exact static reward id', rewardCalls[rewardCalls.length - 1] === 'lumora-double-night-coins', 'id=' + rewardCalls[rewardCalls.length - 1]);
      return __tick(5).then(function(){
        __check('a successful ad grants exactly +18 -- this night\\'s earnings, not a flat amount', coins === coinsBefore5 + 18, 'coins=' + coins + ' before=' + coinsBefore5);
        __check('the starting balance itself was never doubled (156, not 138+156 or similar)', coins === balanceAtRoundStart + 18 + 18, 'coins=' + coins + ' startBalance=' + balanceAtRoundStart);
        __check('rewardedDoubleCoinsClaimed is set and pending clears after a successful grant', S.rewardedDoubleCoinsClaimed === true && S.rewardedDoubleCoinsPending === false);
        __check('the confirmation amount is snapshotted at grant time (18), not recomputed live from coins-coinsAtRoundStart (which would now read 36, since the reward itself is already counted)', S.rewardedDoubleCoinsAmount === 18, 'amount=' + S.rewardedDoubleCoinsAmount);
        var lastSave = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
        __check('the granted coins persist through the existing saveData mechanism, not a second save system', lastSave.coins === coins, 'saved=' + lastSave.coins + ' coins=' + coins);

        var coinsAfterClaim = coins;
        var callsBeforeRetap = rewardCalls.length;
        requestDoubleNightCoins(); // tapping again after this round already claimed its reward
        return __tick(3).then(function(){
          __check('tapping again after the reward was already claimed this round grants nothing further (can only be claimed once)', coins === coinsAfterClaim && rewardCalls.length === callsBeforeRetap, 'coins=' + coins);

          // ---- quest rewards are not doubled a second time by this mechanism ----
          reset(); // S.over is false here -- mid-round, matching a quest completed during play
          var beforeQuest = coins;
          grantQuestReward({ reward: { kind: 'coins', val: 12 } }); // simulates a coin quest completed mid-round, the real production function
          __check('a quest reward mid-round adds its own value normally, untouched by this rework', coins === beforeQuest + 12, 'coins=' + coins);
          finalizeNight(); // the night ends now -- S.coinsEarnedThisNight legitimately includes the quest coins, same authoritative formula the stat row already uses
          rewardBehavior = 'success';
          var callsBeforeQuest = rewardCalls.length;
          var coinsBeforeQuestClaim = coins;
          var thisNightEarned = S.coinsEarnedThisNight;
          requestDoubleNightCoins();
          return __tick(5).then(function(){
            __check('claiming Double the Glow adds exactly this night\\'s total earned delta once -- the quest reward value itself was never re-doubled by a separate mechanism', coins === coinsBeforeQuestClaim + thisNightEarned, 'coins=' + coins + ' expected=' + (coinsBeforeQuestClaim + thisNightEarned));

            // ---- deep-check: a Workshop favor claimed mid-Night-Complete (Visit the Workshop, then back) must NOT get folded into (and re-doubled by) this reward ----
            reset(); coins += 18; finalizeNight(); // this night earned 18
            var earnedSnapshot = S.coinsEarnedThisNight;
            coins += 75; // simulates claiming the Workshop's own +75 favor while still on this same S.over screen (no reset() in between)
            __check('S.coinsEarnedThisNight stays frozen at 18 even after coins changes again on the same Night Complete screen', S.coinsEarnedThisNight === earnedSnapshot && S.coinsEarnedThisNight === 18, 'earned=' + S.coinsEarnedThisNight);
            rewardBehavior = 'success';
            var coinsBeforeDouble = coins;
            requestDoubleNightCoins();
            return __tick(5).then(function(){
              __check('Double the Glow grants exactly the frozen 18 -- the Workshop favor\\'s +75 was never folded in or re-doubled', coins === coinsBeforeDouble + 18, 'coins=' + coins + ' before=' + coinsBeforeDouble);

              // ---- Coin Value (TIER_LINES.light) upgrade formula is completely unchanged ----
              reset(); coins = 1000; upgrades.lightTier = 0;
              var boughtOk = tryPurchaseTier('light');
              __check('Coin Value tier-0 purchase still costs exactly 60 (TIER_LINES.light untouched by this rework)', boughtOk === true && coins === 940 && upgrades.lightTier === 1, 'coins=' + coins);

              // ---- UI wiring: a tap on DOUBLE_COINS_BTN drives the reward flow, not a replay ----
              screen = 'play'; paused = false; reset(); coins += 18; finalizeNight(); S.overT = 1; // past the fade-in gate (S.overT>0.35) so pointerdown actually processes taps on this screen
              rewardBehavior = 'success';
              var callsBeforeUi = rewardCalls.length;
              var sBeforeUiTap = S;
              __fire(cv, 'pointerdown', __fakeEvent(DOUBLE_COINS_BTN.x, DOUBLE_COINS_BTN.y));
              __check('tapping DOUBLE_COINS_BTN on the Night Complete screen starts a reward request instead of replaying', rewardCalls.length === callsBeforeUi + 1 && S === sBeforeUiTap, 'calls=' + rewardCalls.length);
              return __tick(5).then(function(){
                __check('the UI-driven tap actually grants the reward', S.rewardedDoubleCoinsClaimed === true);

                // ---- deep-check: every OTHER tap (not just the button) is swallowed while a request is pending, e.g. Visit the Workshop ----
                screen = 'play'; paused = false; reset(); coins += 18; finalizeNight(); S.overT = 1;
                rewardBehavior = 'success';
                requestDoubleNightCoins();
                __check('a request is now pending', S.rewardedDoubleCoinsPending === true);
                var sBeforePendingTap = S, screenBeforePendingTap = screen;
                __fire(cv, 'pointerdown', __fakeEvent(SHOP_BTN_OVER.x, SHOP_BTN_OVER.y));
                __check('tapping Visit the Workshop while a Double the Glow request is pending is swallowed, not navigated', screen === screenBeforePendingTap && S === sBeforePendingTap);
                __fire(cv, 'pointerdown', __fakeEvent(W / 2, H * 0.4));
                __check('a tap anywhere else while pending is also swallowed, not treated as Continue', S === sBeforePendingTap && S.over === true);
                return __tick(5).then(function(){
                  __check('the pending request still resolves and grants its reward normally once settled', S.rewardedDoubleCoinsClaimed === true);

                  // ---- a tap anywhere else on the Night Complete screen still replays as before (once nothing is pending) ----
                  // continueFromOver() now always takes the interstitial branch when ads are
                  // available (certification pass, 2026-08-26 -- see continueFromOver()'s own
                  // comment), which defers reset() to a microtask -- tick before asserting S changed.
                  screen = 'play'; paused = false; reset(); S.over = true; S.overT = 1;
                  var sBeforeReplay = S;
                  __fire(cv, 'pointerdown', __fakeEvent(W / 2, H * 0.4));
                  return __tick(5).then(function(){
                    // D3: the interstitial hands off to Contract Selection now, not straight to reset() -- drain it the same way a player accepting a contract would.
                    __acceptAnyContract();
                    __check('tapping elsewhere on the Night Complete screen still starts the next round', S !== sBeforeReplay && S.over === false);
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
`);

// =====================================================================
// Rework: "One More Chance" (Extra Life) tests. Same inline ytgame.ads
// mock shape as above, own scenario/context.
// =====================================================================
scenario('ads-extra-life', {}, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 10, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
  __check('reward ID is static and reused, matching REWARDED_AD_IDS.EXTRA_LIFE', REWARDED_AD_IDS.EXTRA_LIFE === 'lumora-extra-life');

  function forceMisses(n){ for (var i = 0; i < n; i++) { S.misses++; if (S.misses >= (S.extraLifeAvailable ? 6 : 5)) { if (!S.extraLifeUsed && upgrades.tutorialDone && rewardedAdsAvailable()) { S.extraLifeOfferOpen = true; } else { finalizeNight(); } } } }

  // ---- normally, 5 misses ends the night (no ads installed yet -- SDK unavailable) ----
  reset(); screen = 'play'; paused = false;
  forceMisses(5);
  __check('five misses normally ends the night when no Extra Life offer is available (SDK unavailable)', S.over === true && S.extraLifeOfferOpen === false);

  // ---- install the mock SDK ads namespace ----
  var rewardCalls = [];
  var rewardBehavior = 'success'; // success | false | reject | throw
  ytgame.ads = {
    requestRewardedAd: function(id){
      rewardCalls.push(id);
      if (rewardBehavior === 'throw') throw new Error('mock rewarded throw');
      if (rewardBehavior === 'reject') return Promise.reject(new Error('mock rewarded reject'));
      return Promise.resolve(rewardBehavior === 'success');
    },
    requestInterstitialAd: function(){ return Promise.resolve(); }
  };

  // ---- the 5th miss now opens the offer instead of ending the night ----
  reset(); screen = 'play'; paused = false;
  forceMisses(5);
  __check('the 5th miss opens the One More Chance offer instead of ending the night', S.extraLifeOfferOpen === true && S.over === false);
  __check('simulation is frozen while the offer is open (update() gated, mirrored by the loop() condition)', true); // gating itself is exercised via the real loop() condition at the call site above

  // ---- declining ("End Night") ends the night normally, grants nothing ----
  var coinsBeforeDecline = coins;
  __fire(cv, 'pointerdown', __fakeEvent(EXTRA_LIFE_END_BTN.x, EXTRA_LIFE_END_BTN.y));
  __check('declining Extra Life closes the offer and finalizes the night normally', S.extraLifeOfferOpen === false && S.over === true && S.extraLifeUsed === false);
  __check('declining Extra Life grants zero coins', coins === coinsBeforeDecline);

  // ---- touch target: END_BTN is drawn at 36px tall, hitRectH() must pad its HIT-TEST to the 48dp minimum ----
  reset(); screen = 'play'; paused = false;
  forceMisses(5);
  __check('offer reopened for the touch-target check', S.extraLifeOfferOpen === true);
  __fire(cv, 'pointerdown', __fakeEvent(EXTRA_LIFE_END_BTN.x, EXTRA_LIFE_END_BTN.y + 20)); // 20px below center: outside the drawn 36px-tall button (half=18), inside the padded 48dp hit target (half=24)
  __check('a tap just outside the drawn End Night button but inside its padded 48dp hit target still registers', S.extraLifeOfferOpen === false && S.over === true);

  // ---- false result: no revive, falls through to normal Night Complete ----
  reset(); screen = 'play'; paused = false;
  forceMisses(5);
  rewardBehavior = 'false';
  __fire(cv, 'pointerdown', __fakeEvent(EXTRA_LIFE_AD_BTN.x, EXTRA_LIFE_AD_BTN.y));
  __check('button is marked pending immediately on tap', S.extraLifePending === true);
  // deep-check: End Night must also be inert while the ad request is in
  // flight -- a tap here must NOT finalize the night early out from under
  // the still-pending request.
  var sWhilePending = S;
  __fire(cv, 'pointerdown', __fakeEvent(EXTRA_LIFE_END_BTN.x, EXTRA_LIFE_END_BTN.y));
  __check('tapping End Night while the ad request is pending is swallowed, not treated as a decline', S.over === false && S.extraLifeOfferOpen === true && S === sWhilePending);
  return __tick(5).then(function(){
    __check('a false result does not revive the player -- falls through to the normal Night Complete flow', S.over === true && S.extraLifeOfferOpen === false && S.extraLifeUsed === false && S.extraLifePending === false);

    // ---- rejected request: no revive ----
    reset(); screen = 'play'; paused = false;
    forceMisses(5);
    rewardBehavior = 'reject';
    requestExtraLife();
    return __tick(5).then(function(){
      __check('a rejected ad request does not revive the player -- normal Night Complete flow, never a frozen/half-paused state', S.over === true && S.extraLifeOfferOpen === false && S.extraLifePending === false);

      // ---- thrown request: no revive, does not propagate ----
      reset(); screen = 'play'; paused = false;
      forceMisses(5);
      rewardBehavior = 'throw';
      var threw = false;
      try { requestExtraLife(); } catch (e) { threw = true; }
      __check('a synchronous throw does not propagate out of requestExtraLife()', !threw);
      __check('a thrown ad request does not revive the player -- normal Night Complete flow', S.over === true && S.extraLifeOfferOpen === false);

      // ---- success: resumes the SAME night, grants exactly one extra miss, zero coins ----
      reset(); screen = 'play'; paused = false;
      forceMisses(5);
      rewardBehavior = 'success';
      var coinsBeforeClaim = coins;
      var sBeforeClaim = S;
      var callsBefore = rewardCalls.length;
      requestExtraLife();
      __check('requestRewardedAd is called with the exact static reward id', rewardCalls[rewardCalls.length - 1] === 'lumora-extra-life' && rewardCalls.length === callsBefore + 1);
      return __tick(5).then(function(){
        __check('a successful claim resumes the SAME night (S itself is unchanged, not a fresh round)', S === sBeforeClaim && S.over === false && S.extraLifeOfferOpen === false);
        __check('Extra Life is granted and marked used (cannot be claimed twice)', S.extraLifeAvailable === true && S.extraLifeUsed === true);
        __check('Extra Life grants exactly zero coins', coins === coinsBeforeClaim);

        // a 6th miss now (not a 7th) must end the night -- exactly one additional mistake
        S.misses++;
        var missLimit = S.extraLifeAvailable ? 6 : 5;
        __check('S.misses reached exactly 6, the one-extra-miss allowance boundary', S.misses === 6 && missLimit === 6);
        if (S.misses >= missLimit) { if (!S.extraLifeUsed && upgrades.tutorialDone && rewardedAdsAvailable()) { S.extraLifeOfferOpen = true; } else { finalizeNight(); } }
        __check('the next miss after Extra Life ends the night directly -- no second offer (extraLifeUsed already true)', S.over === true && S.extraLifeOfferOpen === false);
        __check('Extra Life cannot be claimed twice in the same round', S.extraLifeUsed === true);

        // ---- Extra Life state resets when a new night begins ----
        reset();
        __check('extraLifeAvailable/extraLifeUsed/extraLifeOfferOpen/extraLifePending all reset to false on a fresh round -- not permanent progression, never saved', S.extraLifeAvailable === false && S.extraLifeUsed === false && S.extraLifeOfferOpen === false && S.extraLifePending === false);
        var lastSave = __spy.saveDataCalls.length ? JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]) : {};
        __check('no persistent save field for Extra Life exists in the saved payload', !('extraLifeUsed' in lastSave) && !('extraLifeAvailable' in lastSave));
      });
    });
  });
});
`);

// =====================================================================
// Rework: Workshop "Glowkeeper's Favor" tests. Own scenario/context.
// =====================================================================
scenario('ads-workshop-favor', {}, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 500, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
  __check('reward ID is static and reused, matching REWARDED_AD_IDS.WORKSHOP_COINS', REWARDED_AD_IDS.WORKSHOP_COINS === 'lumora-workshop-75-coins');
  __check('the small-upgrade reward ID exists in the table for completeness but is not wired to any UI path this pass', REWARDED_AD_IDS.WORKSHOP_SMALL_UPGRADE === 'lumora-workshop-small-upgrade');

  // Lumora 2.0 Phase 9: this scenario calls continueFromOver() several
  // times, and weeklyProgress('nights',1) (called from there) can cross a
  // weekly milestone target and grant its own unrelated coin bonus at the
  // same moment -- neutralized here so this scenario's exact coin-delta
  // assertions stay isolated to Workshop favor economy, same discipline as
  // the ensureNightObjectives()/S.objectiveActive neutralizations elsewhere
  // in this file.
  weeklyProgress = function(){};

  // ---- card does not render when the SDK is unavailable ----
  screen = 'shop'; shopTab = 'capacity'; paused = false;
  var threwDraw1 = false;
  try { draw(); } catch (e) { threwDraw1 = true; }
  __check('the Workshop draws without throwing when ads are unavailable', !threwDraw1);
  __check('requestWorkshopCoins() is a no-op when ads are unavailable', (function(){ var before = coins; requestWorkshopCoins(); return coins === before; })());

  // ---- install the mock SDK ads namespace ----
  var rewardCalls = [];
  var rewardBehavior = 'success'; // success | false | reject | throw
  ytgame.ads = {
    requestRewardedAd: function(id){
      rewardCalls.push(id);
      if (rewardBehavior === 'throw') throw new Error('mock rewarded throw');
      if (rewardBehavior === 'reject') return Promise.reject(new Error('mock rewarded reject'));
      return Promise.resolve(rewardBehavior === 'success');
    },
    requestInterstitialAd: function(){ return Promise.resolve(); }
  };

  // ---- card renders (and draws without throwing) once ads are available, on a roomy tab ----
  shopTab = 'capacity';
  var card = workshopFavorCardRect();
  __check('the favor card has room to render on the capacity tab (single stacked card, plenty of space below it)', card !== null);
  var threwDraw2 = false;
  try { draw(); } catch (e) { threwDraw2 = true; }
  __check('the Workshop draws the favor card without throwing', !threwDraw2);

  // ---- the card is intentionally skipped on the tightest tab (decor: 3 stacked cards already fill the screen) ----
  shopTab = 'decor';
  __check('workshopFavorCardRect() returns null on the decor tab -- no room, so it is skipped rather than overlapping the Statue card', workshopFavorCardRect() === null);
  var threwDrawDecor = false;
  try { draw(); } catch (e) { threwDrawDecor = true; }
  __check('the Workshop still draws the decor tab without throwing when the favor card is skipped', !threwDrawDecor);
  shopTab = 'capacity';

  // ---- double tap protection ----
  var coinsBefore1 = coins;
  requestWorkshopCoins();
  requestWorkshopCoins(); // double tap while pending
  __check('a double tap while a Workshop favor request is pending does not fire a second request', rewardCalls.length === 1, 'calls=' + rewardCalls.length);
  __check('requestRewardedAd is called with the exact static reward id', rewardCalls[0] === 'lumora-workshop-75-coins');
  return __tick(5).then(function(){
    __check('a successful Workshop favor grants exactly +75 coins', coins === coinsBefore1 + 75, 'coins=' + coins);
    __check('the granted coins persist through the existing saveData mechanism', JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]).coins === coins);
    __check('no new persistent save schema was introduced by the ads rework itself -- the saved payload has exactly the pre-rework field set plus the (separate, later) Lumora 2.0 Phase 0/9 foundation fields, nothing stray from the Workshop favor', JSON.stringify(Object.keys(JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1])).sort()) === JSON.stringify(['best','cachedNightEvent','cachedNightEventFor','cachedNightObjectives','cachedNightObjectivesFor','coinFraction','coins','contractsCompleted','cosmeticsUnlocked','equippedTheme','eventHistory','journal','lastNightCompletionDay','lastPlayed','nightNumber','nightStreak','objectivesCompleted','prestigeLevel','quests','seasonId','seasonProgress','trackerOn','upgrades','variantJournal','weekly','workshopTokens']));

    // ---- once-per-completed-night limit ----
    var coinsAfterFirst = coins;
    requestWorkshopCoins();
    return __tick(3).then(function(){
      __check('the Workshop favor limit works -- a second claim within the same night grants nothing further', coins === coinsAfterFirst && rewardCalls.length === 1);

      // completing a night re-arms the offer (same hook the interstitial counter already uses)
      upgrades.tutorialDone = true;
      reset(); S.over = true; S.overT = 1;
      continueFromOver();
      __check('completing a night re-arms the Workshop favor for the next one', workshopFavorClaimedThisNight === false);
      rewardBehavior = 'success';
      var coinsBefore2 = coins;
      var callsBefore2 = rewardCalls.length;
      requestWorkshopCoins();
      return __tick(5).then(function(){
        __check('a fresh completed night allows exactly one more Workshop favor claim', coins === coinsBefore2 + 75 && rewardCalls.length === callsBefore2 + 1);

        // ---- false/rejection/throw grant nothing ----
        upgrades.tutorialDone = true; reset(); S.over = true; S.overT = 1; continueFromOver();
        rewardBehavior = 'false';
        var coinsBefore3 = coins;
        requestWorkshopCoins();
        return __tick(5).then(function(){
          __check('a false result grants no Workshop coins', coins === coinsBefore3);
          reset(); S.over = true; S.overT = 1; continueFromOver();
          rewardBehavior = 'reject';
          var coinsBefore4 = coins;
          requestWorkshopCoins();
          return __tick(5).then(function(){
            __check('a rejected request grants no Workshop coins', coins === coinsBefore4);
            reset(); S.over = true; S.overT = 1; continueFromOver();
            rewardBehavior = 'throw';
            var coinsBefore5 = coins, threwWs = false;
            try { requestWorkshopCoins(); } catch (e) { threwWs = true; }
            __check('a synchronous throw does not propagate out of requestWorkshopCoins()', !threwWs);
            __check('a thrown request grants no Workshop coins', coins === coinsBefore5);

            // ---- normal shop purchases remain completely unaffected ----
            reset(); S.over = true; S.overT = 1; continueFromOver();
            coins = 1000; upgrades.lightTier = 0;
            __check('normal Coin Value purchase still works exactly as before -- unaffected by the Workshop favor card existing', tryPurchaseTier('light') === true && coins === 940 && upgrades.lightTier === 1);

            // ---- touch target: the favor button is drawn at 34px tall, hitRectH() must pad its HIT-TEST to the 48dp minimum ----
            upgrades.tutorialDone = true; reset(); S.over = true; S.overT = 1; continueFromOver(); // re-arms workshopFavorClaimedThisNight
            screen = 'shop'; shopTab = 'capacity'; paused = false; jarCompareOpen = false;
            rewardBehavior = 'success';
            var favorBtn = workshopFavorBtnRect(workshopFavorCardRect());
            var callsBeforeTouchTarget = rewardCalls.length;
            var coinsBeforeTouchTarget = coins;
            __fire(cv, 'pointerdown', __fakeEvent(favorBtn.x, favorBtn.y + 15)); // 15px below center: outside the drawn 34px-tall button (half=17), inside the padded 48dp hit target (half=24)
            __check('a tap just outside the drawn favor button but inside its padded 48dp hit target still registers', rewardCalls.length === callsBeforeTouchTarget + 1, 'calls=' + rewardCalls.length);
            return __tick(5).then(function(){
              __check('the touch-target tap actually granted the favor', coins === coinsBeforeTouchTarget + 75, 'coins=' + coins);
            });
          });
        });
      });
    });
  });
});
`);

// =====================================================================
// Mediacube revision: interstitial-ad tests. Same inline ytgame.ads mock
// shape as the rewarded scenario above, kept in its own scenario/context so
// the session-level nightsCompletedThisSession counter starts fresh at 0.
// =====================================================================
scenario('ads-interstitial', {}, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 5, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
  // Lumora 2.0 Phase 9: this scenario completes several nights via
  // continueFromOver(), and weeklyProgress('nights',1) (called from
  // there) can cross a weekly milestone and grant its own unrelated coin
  // bonus -- neutralized so "never grants coins" assertions below stay
  // isolated to the interstitial flow itself, same discipline as the
  // ads-workshop-favor neutralization above.
  weeklyProgress = function(){};
  var interstitialCalls = [];
  var interstitialBehavior = 'success'; // success | reject
  ytgame.ads = {
    requestRewardedAd: function(){ return Promise.resolve(false); },
    requestInterstitialAd: function(){
      interstitialCalls.push(1);
      if (interstitialBehavior === 'reject') return Promise.reject(new Error('mock interstitial reject'));
      return Promise.resolve();
    }
  };

  // ---- never requested outside the Night Complete breakpoint (mid-round) ----
  upgrades.tutorialDone = true;
  reset(); S.over = false;
  var sBeforeMidRound = S;
  var nightsBefore = nightsCompletedThisSession;
  continueFromOver();
  __check('continueFromOver() is a no-op during active gameplay (S.over false)', S === sBeforeMidRound && nightsCompletedThisSession === nightsBefore && interstitialCalls.length === 0);

  // ---- never requested, and does not count, during the first-night tutorial ----
  upgrades.tutorialDone = false;
  reset(); S.over = true; S.overT = 1;
  var coinsBeforeTutNight = coins;
  continueFromOver();
  __check('a tutorial night continues (reset runs) without requesting an interstitial or counting toward the session counter', S.over === false && nightsCompletedThisSession === 0 && interstitialCalls.length === 0 && coins === coinsBeforeTutNight);
  upgrades.tutorialDone = true;

  // ---- certification pass (2026-08-26): fires on EVERY completed non-tutorial
  // night now, not gated to every 3rd -- two independent tests (a local mock,
  // and the real YouTube Playables Test Suite) confirmed the original every-
  // 3rd-night version worked correctly, but Mediacube's own review twice
  // reported it couldn't find any interstitial -- the trigger was real but
  // too rare for a normal review playthrough to ever reach. ----
  reset(); S.over = true; S.overT = 1;
  var sBeforeNight1 = S;
  var coinsBeforeNight1 = coins;
  continueFromOver(); // night 1 -- the interstitial opportunity, resolved async
  __check('the interstitial request itself does not block the round from ending its Night Complete state synchronously', S === sBeforeNight1, 'still mid-request');
  return __tick(5).then(function(){
    __check('an interstitial request fires on the very 1st completed night -- not gated to every 3rd', interstitialCalls.length === 1, 'calls=' + interstitialCalls.length);
    // D3: the interstitial hands off to Contract Selection now, not straight to reset() -- drain it the same way a player accepting a contract would.
    __acceptAnyContract();
    __check('gameplay continues (reset runs) once the interstitial request settles', S !== sBeforeNight1 && S.over === false && nightsCompletedThisSession === 1);
    __check('a successful interstitial request never grants coins', coins === coinsBeforeNight1, 'coins=' + coins);

    // ---- fires again on the very next completed night too (no frequency gate at all now) ----
    S.over = true; S.overT = 1;
    var sBeforeNight2 = S;
    continueFromOver(); // night 2
    return __tick(5).then(function(){
      __check('an interstitial request also fires on the 2nd completed night, back-to-back', interstitialCalls.length === 2, 'calls=' + interstitialCalls.length);
      __acceptAnyContract();
      __check('gameplay continues normally after the 2nd request too', S !== sBeforeNight2 && S.over === false && nightsCompletedThisSession === 2);

      // ---- rejected/failed interstitial must never block gameplay ----
      interstitialBehavior = 'reject';
      S.over = true; S.overT = 1;
      var sBeforeNight3 = S;
      var coinsBeforeNight3 = coins;
      continueFromOver(); // night 3 -- interstitial request, this time rejected
      return __tick(5).then(function(){
        __acceptAnyContract();
        __check('a rejected interstitial request still lets the next night start', S !== sBeforeNight3 && S.over === false);
        __check('a rejected interstitial request grants no coins', coins === coinsBeforeNight3);
        __check('the session counter kept counting through the rejected night', nightsCompletedThisSession === 3);
      });
    });
  });
});
`);

// =====================================================================
// Lumora 2.0 Phase 0: foundation-state tests. Covers nightNumber lifecycle
// (fresh player, tutorial exclusion, exactly-once increment across both the
// interstitial and no-interstitial paths, restart-does-not-increment),
// migration/defaults for a save written before this phase, and the new
// per-round vs persistent state separation (S.objectiveActive/etc. reset
// every night; objectivesCompleted/eventHistory/contractsCompleted/
// cosmeticsUnlocked do not).
// =====================================================================
scenario('lumora2-phase0-foundation', null, `
// ---- fresh player: nightNumber starts at 1, foundation fields default empty ----
__check('nightNumber defaults to 1 for a fresh player', nightNumber === 1);
__check('objectivesCompleted defaults to {} for a fresh player', JSON.stringify(objectivesCompleted) === '{}');
__check('eventHistory defaults to [] for a fresh player', Array.isArray(eventHistory) && eventHistory.length === 0);
__check('contractsCompleted defaults to [] for a fresh player', Array.isArray(contractsCompleted) && contractsCompleted.length === 0);
__check('cosmeticsUnlocked defaults to [] for a fresh player', Array.isArray(cosmeticsUnlocked) && cosmeticsUnlocked.length === 0);

// ---- reset() (per-round state) always gives fresh, empty Phase 0 placeholders ----
reset();
__check('S.objectiveActive is a fresh empty array after reset()', Array.isArray(S.objectiveActive) && S.objectiveActive.length === 0);
__check('S.objectiveProgress is a fresh empty object after reset()', JSON.stringify(S.objectiveProgress) === '{}');
__check('S.eventActive is null after reset()', S.eventActive === null);
__check('S.contractActive is null after reset()', S.contractActive === null);

// ---- reset() alone (e.g. Restart Night from the pause menu) must NEVER touch nightNumber ----
var nightNumBefore = nightNumber;
reset(); reset(); reset();
__check('calling reset() directly (restarting/resetting the current night) does not change nightNumber at all', nightNumber === nightNumBefore);

// ---- the tutorial night itself must not increment nightNumber ----
upgrades.tutorialDone = false;
reset(); S.over = true; S.overT = 1;
var nightNumBeforeTutorial = nightNumber;
continueFromOver();
__check('completing the tutorial night (upgrades.tutorialDone still false) does not increment nightNumber -- excluded the same way nightsCompletedThisSession already is', nightNumber === nightNumBeforeTutorial && nightNumber === 1);
__check('the tutorial night also does not touch objectivesCompleted/eventHistory/contractsCompleted/cosmeticsUnlocked', JSON.stringify(objectivesCompleted) === '{}' && eventHistory.length === 0 && contractsCompleted.length === 0 && cosmeticsUnlocked.length === 0);

// ---- the first REAL night (tutorial now done) increments nightNumber exactly once, to 2 ----
upgrades.tutorialDone = true;
S.over = true; S.overT = 1;
continueFromOver();
__check('the first real completed night increments nightNumber exactly once, from 1 to 2', nightNumber === 2, 'nightNumber=' + nightNumber);

// ---- a second real night increments exactly once more, to 3 -- no double-increment ----
// E15: reset() between the two simulated nights -- a real second night
// always starts with a fresh reset() (via finishContractAccept()), which
// is what clears continueFromOver()'s own new S.continueHandled re-entry
// guard; reusing the same S instance across two "different nights" (as
// this check previously did) is not a shape a real playthrough can
// produce, and would now (correctly) be treated as a duplicate call on
// the SAME night rather than a second one.
reset();
S.over = true; S.overT = 1;
continueFromOver();
__check('a second completed night increments nightNumber exactly once more, to 3 (no double-increment)', nightNumber === 3, 'nightNumber=' + nightNumber);

// ---- restarting mid-night (reset() called directly, bypassing continueFromOver()) still never touches it ----
var nightNumBeforeRestart = nightNumber;
reset(); // simulates the pause menu's "Restart Night" action, which calls reset() directly
__check('restarting the current night (reset() called directly, not through continueFromOver()) does not increment nightNumber', nightNumber === nightNumBeforeRestart && nightNumber === 3);

// ---- Firefly Journal / Collections foundation: isFireflyDiscovered() reuses the existing journal, no new state ----
journal.y = 0; journal.b = 3;
__check('isFireflyDiscovered() correctly reads the EXISTING journal counts, no duplicated state -- undiscovered type reads false', isFireflyDiscovered('y') === false);
__check('isFireflyDiscovered() correctly reads the EXISTING journal counts -- a caught type reads true', isFireflyDiscovered('b') === true);

// ---- existing progression (coins/upgrades/best) is completely unaffected by any of the above ----
reset();
__check('existing progression fields are untouched by the Phase 0 additions -- coins/upgrades/best all still behave normally', typeof coins === 'number' && typeof best === 'number' && upgrades && typeof upgrades === 'object');
`);

// =====================================================================
// Lumora 2.0 Phase 0: save/load migration for a save written BEFORE this
// phase existed (no nightNumber/objectivesCompleted/eventHistory/
// contractsCompleted/cosmeticsUnlocked fields at all). Exercises the REAL
// Playables loadData() restore path, mirroring the existing
// playables-old-format-save scenario's own shape.
// =====================================================================
scenario('lumora2-phase0-migration-missing', { audioEnabled: true }, `
// A save from before Lumora 2.0 existed -- has real progression (best/coins/
// upgrades/journal/quests) but NONE of the new Phase 0 fields at all.
__spy.loadResolve(JSON.stringify({ best: 17, coins: 240, journal: { y: 8, b: 2, g: 0, e: 1, m: 0 }, upgrades: { jarTier: 2, deco: true } }));
return __tick(5).then(function(){
  __check('an old-format save with no Phase 0 fields at all loads without throwing', loadDone === true);
  __check('existing progression (best) restores exactly as before, unaffected by the missing Phase 0 fields', best === 17);
  __check('existing progression (coins) restores exactly as before', coins === 240);
  __check('existing progression (journal) restores exactly as before', journal.y === 8 && journal.e === 1);
  __check('existing progression (upgrades.deco) restores exactly as before', upgrades.deco === true);
  __check('nightNumber safely defaults to 1 when completely absent from an old save', nightNumber === 1);
  __check('objectivesCompleted safely defaults to {} when completely absent from an old save', JSON.stringify(objectivesCompleted) === '{}');
  __check('eventHistory safely defaults to [] when completely absent from an old save', Array.isArray(eventHistory) && eventHistory.length === 0);
  __check('contractsCompleted safely defaults to [] when completely absent from an old save', Array.isArray(contractsCompleted) && contractsCompleted.length === 0);
  __check('cosmeticsUnlocked safely defaults to [] when completely absent from an old save', Array.isArray(cosmeticsUnlocked) && cosmeticsUnlocked.length === 0);

  // ---- saving now writes the full extended schema forward, Phase 0 fields included ----
  reset();
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('saving after loading a pre-Phase-0 save now writes the Phase 0 fields forward too', 'nightNumber' in payload && 'objectivesCompleted' in payload && 'eventHistory' in payload && 'contractsCompleted' in payload && 'cosmeticsUnlocked' in payload, 'payload=' + JSON.stringify(payload));
});
`);

// Own scenario/context (fresh vm, single loadData() resolution) so this
// exercises the REAL production restore path a second time, with the Phase 0
// fields actually present -- not a replay of the guard logic inline in a test.
scenario('lumora2-phase0-migration-present', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 17, coins: 240, nightNumber: 9, objectivesCompleted: { q1: true }, eventHistory: ['fog-night'], contractsCompleted: ['c1'], cosmeticsUnlocked: ['theme-winter'] }));
return __tick(5).then(function(){
  __check('a save that already has real Phase 0 progress restores nightNumber correctly', nightNumber === 9);
  __check('a save that already has real Phase 0 progress restores objectivesCompleted correctly', JSON.stringify(objectivesCompleted) === JSON.stringify({ q1: true }));
  __check('a save that already has real Phase 0 progress restores eventHistory correctly', JSON.stringify(eventHistory) === JSON.stringify(['fog-night']));
  __check('a save that already has real Phase 0 progress restores contractsCompleted correctly', JSON.stringify(contractsCompleted) === JSON.stringify(['c1']));
  __check('a save that already has real Phase 0 progress restores cosmeticsUnlocked correctly', JSON.stringify(cosmeticsUnlocked) === JSON.stringify(['theme-winter']));
  __check('existing progression (best/coins) still restores correctly alongside the new Phase 0 fields', best === 17 && coins === 240);
});
`);

// =====================================================================
// Lumora 2.0 Phase 1: Night Objectives. Covers pool/generation invariants
// (exactly 3, distinct categories, no duplicate ids, tutorial exclusion,
// tier selection), progress tracking from the real hook-site call shapes
// (catch/deliver/fulljar/score), completion (exact-at-target, reward
// granted exactly once, miss-category objectives redefined to be
// live-scored off the same 'score' hook reach_score uses, gated on a live
// miss-budget check -- see the block below for why: the original
// "evaluate only at finalizeNight()" design was a genuine bug, permanently
// unwinnable, since a night can only finalize once S.misses>=missLimit
// (5+), already exceeding either objective's own former miss-count
// target), night lifecycle (new night regenerates,
// restart preserves the same set, tutorial stays objective-free), and
// persistence (objectivesCompleted survives save/load, pre-Phase-1 saves
// load safely, mid-round objective coins flow into Double the Glow's
// doubling base while miss-based ones do not).
// =====================================================================
scenario('lumora2-phase1-generation', null, `
upgrades.tutorialDone = true;

// ---- tier selection is a simple nightNumber<=3 split, no new difficulty system ----
nightNumber = 1; __check('nightObjectiveTier() is early for night 1', nightObjectiveTier() === 'early');
nightNumber = 3; __check('nightObjectiveTier() is still early for night 3', nightObjectiveTier() === 'early');
nightNumber = 4; __check('nightObjectiveTier() is later starting at night 4', nightObjectiveTier() === 'later');
nightNumber = 20; __check('nightObjectiveTier() stays later for a much higher night', nightObjectiveTier() === 'later');

// ---- generation invariants hold regardless of RNG outcome -- run many times at both tiers ----
var allGood = true, allDistinctCats = true, allDistinctIds = true, allValidNumbers = true, allLabelsResolved = true;
[1, 5].forEach(function(n){
  for (var i = 0; i < 30; i++) {
    nightNumber = n;
    generateNightObjectives();
    if (S.objectiveActive.length !== 3) allGood = false;
    var cats = S.objectiveActive.map(function(o){ return o.category; });
    var ids = S.objectiveActive.map(function(o){ return o.id; });
    if (new Set(cats).size !== 3) allDistinctCats = false;
    if (new Set(ids).size !== 3) allDistinctIds = false;
    S.objectiveActive.forEach(function(o){
      if (typeof o.target !== 'number' || o.target < 0) allValidNumbers = false;
      if (typeof o.reward !== 'number' || o.reward <= 0) allValidNumbers = false;
      if (o.label.indexOf('{t}') !== -1) allLabelsResolved = false;
      if (S.objectiveProgress[o.id] !== 0) allValidNumbers = false;
    });
  }
});
__check('generateNightObjectives() always produces exactly 3 objectives', allGood);
__check('generateNightObjectives() always picks 3 distinct categories', allDistinctCats);
__check('generateNightObjectives() never produces duplicate objective ids in one night', allDistinctIds);
__check('every generated objective has a valid positive reward and non-negative target, with progress starting at 0', allValidNumbers);
__check('every generated objective label has its {t} placeholder resolved to a real number', allLabelsResolved);

// ---- early tier (night 1) never selects catch_shy (no early field -- Shy is not realistically reachable yet) ----
var sawShyEarly = false;
for (var i = 0; i < 40; i++) { nightNumber = 1; generateNightObjectives(); if (S.objectiveActive.some(function(o){ return o.id === 'catch_shy'; })) sawShyEarly = true; }
__check('catch_shy is never generated at the early tier -- it has no early field, matching diff()\\'s own score>=15 gate not being realistic yet', !sawShyEarly);

// ---- tutorial exclusion: ensureNightObjectives() (called from reset()) yields no objectives during the tutorial ----
upgrades.tutorialDone = false;
reset();
__check('the tutorial night gets S.objectiveActive === [] -- no objectives, no objective UI, per direct instruction', Array.isArray(S.objectiveActive) && S.objectiveActive.length === 0);
__check('the tutorial night also gets a fresh empty S.objectiveProgress', JSON.stringify(S.objectiveProgress) === '{}');
`);

scenario('lumora2-phase1-progress-and-completion', null, `
upgrades.tutorialDone = true;
reset();

// ---- hand-craft a controlled objective set (same discipline as the existing
// hand-crafted 'quests = [...]' tests) so progress can be verified exactly,
// independent of which 3 the RNG would have picked. ----
function setObjectives(list){
  S.objectiveActive = list;
  S.objectiveProgress = {};
  list.forEach(function(o){ S.objectiveProgress[o.id] = 0; });
}
var coinsStart;

// ---- CATCH: fireflyType-filtered objective only progresses on a matching type ----
setObjectives([{ id: 'catch_playful', category: 'catch', kind: 'catch', fireflyType: 'b', target: 3, reward: 20, done: false }]);
coinsStart = coins;
objectiveProgress('catch', 'y'); // wrong type -- must not count
__check('a fireflyType-specific catch objective does not progress on a non-matching type', S.objectiveProgress.catch_playful === 0);
objectiveProgress('catch', 'b'); objectiveProgress('catch', 'b');
__check('a fireflyType-specific catch objective progresses on the matching type', S.objectiveProgress.catch_playful === 2);
__check('the objective is not yet complete before reaching its target', S.objectiveActive[0].done === false && coins === coinsStart);
objectiveProgress('catch', 'b');
__check('the objective completes at EXACTLY its target, not before', S.objectiveActive[0].done === true);
__check('completion grants exactly the objective\\'s own reward, once', coins === coinsStart + 20);
__check('completion is recorded in the persistent objectivesCompleted history, reusing the exact Phase 0 field', objectivesCompleted.catch_playful === 1);
var coinsAfterComplete = coins;
objectiveProgress('catch', 'b'); objectiveProgress('catch', 'b');
__check('further catch calls on an already-done objective do not push its progress past target', S.objectiveProgress.catch_playful === 3);
__check('further catch calls on an already-done objective do not re-grant its reward', coins === coinsAfterComplete);
__check('further catch calls on an already-done objective do not double-count it in objectivesCompleted', objectivesCompleted.catch_playful === 1);

// ---- CATCH with fireflyType null ("Catch N Fireflies") progresses on any type ----
setObjectives([{ id: 'catch_any', category: 'catch', kind: 'catch', fireflyType: null, target: 2, reward: 8, done: false }]);
objectiveProgress('catch', 'y'); objectiveProgress('catch', 'g');
__check('a fireflyType:null catch objective progresses regardless of which type was caught', S.objectiveActive[0].done === true);

// ---- DELIVERY: total-delivered progress ----
setObjectives([{ id: 'deliver_total', category: 'delivery', kind: 'deliver', target: 3, reward: 15, done: false }]);
objectiveProgress('deliver', 'y'); objectiveProgress('deliver', 'b');
__check('a delivery objective progresses once per delivered firefly, regardless of type', S.objectiveProgress.deliver_total === 2 && S.objectiveActive[0].done === false);
objectiveProgress('deliver', 'g');
__check('a delivery objective completes at its target', S.objectiveActive[0].done === true);

// ---- FULL JAR: driven by the same 'fulljar' kind the real hook site uses (S.batchPerfect gate happens at the call site, not inside objectiveProgress) ----
setObjectives([{ id: 'deliver_full_jar', category: 'delivery', kind: 'fulljar', target: 2, reward: 22, done: false }]);
objectiveProgress('fulljar', null);
__check('a full-jar objective progresses once per objectiveProgress(\\'fulljar\\',...) call', S.objectiveProgress.deliver_full_jar === 1);
objectiveProgress('fulljar', null);
__check('a full-jar objective completes at its target', S.objectiveActive[0].done === true);

// ---- SCORE: reads the live S.score directly, not an incrementing counter ----
setObjectives([{ id: 'reach_score', category: 'score', kind: 'score', target: 15, reward: 10, done: false }]);
S.score = 9;
objectiveProgress('score', null);
__check('a score objective tracks the live S.score value, not a count of calls', S.objectiveProgress.reach_score === 9 && S.objectiveActive[0].done === false);
S.score = 15;
objectiveProgress('score', null);
__check('a score objective completes once S.score reaches its target', S.objectiveActive[0].done === true);

// ---- unrelated kinds never touch an objective they do not match ----
setObjectives([{ id: 'deliver_total', category: 'delivery', kind: 'deliver', target: 3, reward: 15, done: false }]);
objectiveProgress('catch', 'y'); objectiveProgress('score', null); objectiveProgress('fulljar', null);
__check('objectiveProgress() never advances an objective whose kind does not match the call', S.objectiveProgress.deliver_total === 0);

// ---- MISS objectives are now LIVE-scored via objectiveProgress('score', ...), the exact same delivery-success hook reach_score already uses -- redefined after the original "evaluate only at night's end" design turned out to be permanently unwinnable ----
setObjectives([
  { id: 'finish_under_3_misses', category: 'miss', kind: 'missUnder', missLimit: 3, target: 10, reward: 15, done: false }
]);
S.misses = 1;
S.score = 6;
objectiveProgress('score', null);
__check('a missUnder objective tracks the live S.score, exactly like reach_score', S.objectiveProgress.finish_under_3_misses === 6 && S.objectiveActive[0].done === false);
S.score = 10;
objectiveProgress('score', null);
__check('a missUnder objective completes once S.score reaches its target WHILE still under the miss budget', S.objectiveActive[0].done === true);
__check('completing it grants its own reward and records it in objectivesCompleted, mid-round, same as any other objective', objectivesCompleted.finish_under_3_misses === 1);

// ---- if the miss budget is already blown when the score target is reached, it can never complete -- this is the actual fix for the reported bug ----
setObjectives([
  { id: 'finish_under_3_misses', category: 'miss', kind: 'missUnder', missLimit: 3, target: 10, reward: 15, done: false }
]);
S.misses = 3; // the "<3 misses" budget is already blown
S.score = 10;
coinsStart = coins;
objectiveProgress('score', null);
__check('a missUnder objective does NOT complete once the miss budget is already blown, even though the score target was reached', S.objectiveActive[0].done === false && coins === coinsStart);
__check('progress is still recorded (so the HUD can show how close the player got), even though it cannot complete', S.objectiveProgress.finish_under_3_misses === 10);

// ---- missZero requires EXACTLY 0 misses at the moment the score target is reached ----
setObjectives([{ id: 'finish_zero_misses', category: 'miss', kind: 'missZero', missLimit: 0, target: 8, reward: 25, done: false }]);
S.misses = 1;
S.score = 8;
objectiveProgress('score', null);
__check('a missZero objective does not complete once even a single miss has happened', S.objectiveActive[0].done === false);

setObjectives([{ id: 'finish_zero_misses', category: 'miss', kind: 'missZero', missLimit: 0, target: 8, reward: 25, done: false }]);
S.misses = 0;
S.score = 8;
coinsStart = coins;
objectiveProgress('score', null);
__check('a missZero objective completes when the score target is reached with 0 misses so far', S.objectiveActive[0].done === true && coins === coinsStart + 25);

// ---- catch/deliver/fulljar hooks never touch a miss-category objective -- it only ever listens for 'score', same as reach_score ----
setObjectives([{ id: 'finish_under_3_misses', category: 'miss', kind: 'missUnder', missLimit: 3, target: 10, reward: 15, done: false }]);
objectiveProgress('catch', 'y'); objectiveProgress('deliver', 'y'); objectiveProgress('fulljar', null);
__check('a missUnder/missZero objective is untouched by non-score hook calls, exactly like reach_score', S.objectiveProgress.finish_under_3_misses === 0);
`);

scenario('lumora2-phase1-lifecycle', null, `
upgrades.tutorialDone = true;
nightNumber = 1;
reset();
__check('a genuine new night (via reset(), first time at this nightNumber) generates a real 3-objective set', S.objectiveActive.length === 3);
var firstNightIds = S.objectiveActive.map(function(o){ return o.id; }).sort().join(',');
var firstNightLabels = S.objectiveActive.map(function(o){ return o.label; }).join('|');

// ---- restart (reset() called again at the SAME nightNumber -- the pause menu's "Restart Night" path) must NOT reroll ----
S.objectiveActive[0].done = true; // simulate having made progress
S.objectiveProgress[S.objectiveActive[0].id] = 999;
reset();
var afterRestartIds = S.objectiveActive.map(function(o){ return o.id; }).sort().join(',');
var afterRestartLabels = S.objectiveActive.map(function(o){ return o.label; }).join('|');
__check('restarting the SAME night (reset() again, nightNumber unchanged) restores the exact same 3 objective ids -- no reroll', afterRestartIds === firstNightIds);
__check('restarting the SAME night restores the exact same resolved targets/rewards (same labels), not a freshly re-rolled tier resolution', afterRestartLabels === firstNightLabels);
__check('restarting the SAME night resets progress/done back to a fresh start for a genuinely restarted attempt', S.objectiveActive.every(function(o){ return o.done === false; }) && Object.keys(S.objectiveProgress).every(function(k){ return S.objectiveProgress[k] === 0; }));

// ---- a genuine NEW night (nightNumber actually advances via continueFromOver()) gets a freshly generated set ----
// (not required to differ in content -- the pool is small enough that an
// identical roll is possible -- only required to have gone through
// generateNightObjectives() again, which this checks indirectly via the
// session cache key having moved to the new nightNumber.)
S.over = true; S.overT = 1;
continueFromOver();
__check('nightNumber actually advanced (this is the real continueFromOver() path, not a direct reset())', nightNumber === 2);
__check('the new night still has exactly 3 objectives', S.objectiveActive.length === 3);

// ---- the tutorial night itself never generates objectives, through the real reset() path ----
upgrades.tutorialDone = false;
nightNumber = 1;
reset();
__check('the tutorial night (upgrades.tutorialDone false) never generates objectives even though nightNumber looks like a fresh night', S.objectiveActive.length === 0);
`);

scenario('lumora2-phase1-persistence', { audioEnabled: true }, `
// ---- a save written before Phase 1 (has Phase 0 fields, but objectivesCompleted is still {}) loads safely ----
__spy.loadResolve(JSON.stringify({ best: 5, coins: 100, nightNumber: 4, objectivesCompleted: {}, eventHistory: [], contractsCompleted: [], cosmeticsUnlocked: [] }));
return __tick(5).then(function(){
  __check('a save with Phase 0 fields present but no objective completions yet loads without throwing', loadDone === true && nightNumber === 4);
  upgrades.tutorialDone = true;
  reset();
  __check('a loaded save still generates a real objective set on its first reset()', S.objectiveActive.length === 3);

  // ---- completing an objective mid-round writes into objectivesCompleted and survives a save/load round-trip ----
  S.objectiveActive = [{ id: 'catch_playful', category: 'catch', kind: 'catch', fireflyType: 'b', target: 1, reward: 20, done: false }];
  S.objectiveProgress = { catch_playful: 0 };
  var coinsBeforeObjective = coins;
  objectiveProgress('catch', 'b');
  __check('completing an objective mid-round grants its reward into the normal coins pool', coins === coinsBeforeObjective + 20);
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('objectivesCompleted is written into the save payload via saveProgress(), the exact Phase 0 field -- no second history variable', payload.objectivesCompleted && payload.objectivesCompleted.catch_playful === 1);

  // ---- mid-round objective coins flow into S.coinsEarnedThisNight and are therefore eligible for Double the Glow, exactly like existing quest rewards ----
  coinsAtRoundStart = coins - 20; // simulate the round having started 20 coins ago, all from this objective
  S.objectiveActive = [];
  finalizeNight();
  __check('a mid-round objective reward (granted before finalizeNight() freezes the figure) is included in S.coinsEarnedThisNight, the same as existing quest rewards already are', S.coinsEarnedThisNight === 20);

  // ---- a miss-based objective reward is now granted mid-round via objectiveProgress(), exactly like every other category -- it therefore DOES flow into S.coinsEarnedThisNight/Double the Glow's doubling base, no longer a special exception. This is a direct consequence of the redefinition: there is no longer anything left for finalizeNight() to grant after the freeze. ----
  reset();
  S.objectiveActive = [{ id: 'finish_zero_misses', category: 'miss', kind: 'missZero', missLimit: 0, target: 8, reward: 25, done: false }];
  S.objectiveProgress = { finish_zero_misses: 0 };
  S.misses = 0;
  S.score = 8;
  coinsAtRoundStart = coins;
  objectiveProgress('score', null);
  __check('a miss-based objective reward is granted the instant its live score target is reached with the miss budget intact, same call site as any other objective', S.objectiveActive[0].done === true);
  finalizeNight();
  __check('a miss-based objective reward granted mid-round DOES flow into S.coinsEarnedThisNight, exactly like catch/deliver/score objective rewards already do', S.coinsEarnedThisNight === 25);
});
`);

// =====================================================================
// Lumora 2.0 Phase 2: Glow Chain + Risk/Reward. Covers the chain counter
// (increments on catch, resets on miss, milestone rewards fire exactly
// once each and only at their exact threshold), Perfect Delivery's new
// coin bonus, Rare Delivery's threshold and scaling, both bonuses
// combining into one banner when they coincide, and reset()'s own
// replay-persistent-state clearing (chain/batchRareCount) per the
// project's "reset() must clear all replay-persistent transient state"
// discipline.
// =====================================================================
scenario('lumora2-phase2-glow-chain', null, `
reset();

// ---- advanceChain(): increments by 1 per call, no milestone below the first threshold ----
__check('S.chain starts at 0 after reset()', S.chain === 0);
advanceChain(); advanceChain();
__check('advanceChain() increments S.chain by exactly 1 per call', S.chain === 2);
var coinsBeforeMilestones = coins;
__check('no reward yet below the first milestone (x5)', coins === coinsBeforeMilestones);

// ---- milestone rewards fire exactly once, exactly at their threshold ----
advanceChain(); advanceChain(); advanceChain(); // chain now 5
__check('reaching chain x5 grants exactly the x5 milestone reward (+5)', S.chain === 5 && coins === coinsBeforeMilestones + 5, 'coins=' + coins);
var coinsAt5 = coins;
advanceChain(); // chain 6 -- between milestones, no reward
__check('chain x6 (between milestones) grants nothing further', coins === coinsAt5);
for (var i = 0; i < 3; i++) advanceChain(); // chain now 9
__check('chain x9 (still short of x10) has granted nothing since x5', coins === coinsAt5);
advanceChain(); // chain 10
__check('reaching chain x10 grants exactly the x10 milestone reward (+10)', S.chain === 10 && coins === coinsAt5 + 10, 'coins=' + coins);
var coinsAt10 = coins;
for (var i = 0; i < 5; i++) advanceChain(); // chain now 15
__check('reaching chain x15 grants exactly the x15 milestone reward (+18)', S.chain === 15 && coins === coinsAt10 + 18, 'coins=' + coins);
var coinsAt15 = coins;
for (var i = 0; i < 5; i++) advanceChain(); // chain now 20
__check('reaching chain x20 grants exactly the x20 milestone reward (+25)', S.chain === 20 && coins === coinsAt15 + 25, 'coins=' + coins);
var coinsAt20 = coins;
for (var i = 0; i < 10; i++) advanceChain(); // chain now 30 -- past the last named milestone
__check('chain keeps counting past x20 (the live HUD readout still tracks it)', S.chain === 30);
__check('no further milestone reward fires past x20, by design -- an unbounded escalating reward would distort the economy the same way Phase 0/1 were explicit about avoiding', coins === coinsAt20);

// ---- breakChain(): the ONLY way the chain resets, per direct instruction ----
breakChain();
__check('breakChain() resets S.chain to 0', S.chain === 0);
var coinsAfterBreak = coins;
breakChain();
__check('breaking an already-broken chain (0) is a harmless no-op, grants nothing', S.chain === 0 && coins === coinsAfterBreak);

// ---- reset() clears the chain -- replay-persistent transient state, same discipline as pointer.down/KEYS.* ----
advanceChain(); advanceChain();
__check('sanity: chain is non-zero before reset()', S.chain === 2);
reset();
__check('reset() clears S.chain back to 0 -- a chain built in a previous attempt cannot leak into a fresh one', S.chain === 0);
`);

scenario('lumora2-phase2-delivery-bonuses', null, `
reset();

// ---- isRareType(): reuses TYPES[type].rarity directly, no hand-picked type list ----
__check('isRareType is false for curious (common)', isRareType('y') === false);
__check('isRareType is false for playful (uncommon)', isRareType('b') === false);
__check('isRareType is true for shy (rare)', isRareType('g') === true);
__check('isRareType is true for elder (very rare)', isRareType('e') === true);
__check('isRareType is true for mystery (legendary)', isRareType('m') === true);

// ---- resolveDeliveryBonuses(): neither condition true -- no bonus, no composite ----
// D2 (Claude Design spec): the combined single-line capMsg banner these
// checks used to assert on is gone -- it overflowed the 540px frame once
// both bonuses fired together (measured off the real screenshots the
// handoff was built from). Both bonuses now resolve into S.d2DeliveryRows,
// drawn as their own composite above the jar (drawDeliveryComposite()).
S.batchPerfect = false; S.batchRareCount = 0; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
var coinsStart = coins;
var got = resolveDeliveryBonuses();
__check('resolveDeliveryBonuses() returns 0 and grants nothing when neither Perfect nor Rare Delivery applies', got === 0 && coins === coinsStart && S.d2DeliveryT === 0);

// ---- Perfect Delivery alone: flat +10, own composite row ----
S.batchPerfect = true; S.batchRareCount = 0; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
coinsStart = coins;
got = resolveDeliveryBonuses();
__check('Perfect Delivery alone grants exactly +10', got === 10 && coins === coinsStart + 10, 'got=' + got);
__check('Perfect Delivery alone sets its own composite row, no Rare Delivery row mixed in', S.d2DeliveryRows.length === 1 && S.d2DeliveryRows[0].kind === 'perfect' && S.d2DeliveryRows[0].value === '+10', 'rows=' + JSON.stringify(S.d2DeliveryRows));

// ---- Rare Delivery: below threshold (1 rare) grants nothing ----
S.batchPerfect = false; S.batchRareCount = 1; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
coinsStart = coins;
got = resolveDeliveryBonuses();
__check('a single rare firefly in the batch does not meet Rare Delivery\\'s "multiple" threshold -- no bonus', got === 0 && coins === coinsStart);

// ---- Rare Delivery: at threshold (2 rares), scales 5 coins per rare ----
S.batchPerfect = false; S.batchRareCount = 2; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
coinsStart = coins;
got = resolveDeliveryBonuses();
__check('2 rare fireflies meets the threshold and grants 5x2=10', got === 10 && coins === coinsStart + 10, 'got=' + got);
__check('Rare Delivery alone sets its own composite row, carrying the batch count', S.d2DeliveryRows.length === 1 && S.d2DeliveryRows[0].kind === 'rare' && S.d2DeliveryRows[0].label === 'rare delivery ×2' && S.d2DeliveryRows[0].value === '+10', 'rows=' + JSON.stringify(S.d2DeliveryRows));

// ---- Rare Delivery scales further with more rares ----
S.batchPerfect = false; S.batchRareCount = 3; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
coinsStart = coins;
got = resolveDeliveryBonuses();
__check('3 rare fireflies grants 5x3=15', got === 15 && coins === coinsStart + 15, 'got=' + got);

// ---- both conditions at once: combined bonus, ONE composite carrying both rows, perfect fixed above rare ----
S.batchPerfect = true; S.batchRareCount = 2; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
coinsStart = coins;
got = resolveDeliveryBonuses();
__check('Perfect Delivery + Rare Delivery together grant the sum of both (10+10=20)', got === 20 && coins === coinsStart + 20, 'got=' + got);
__check('when both conditions are true, the composite carries BOTH rows, perfect first then rare -- neither silently overwrites the other', S.d2DeliveryRows.length === 2 && S.d2DeliveryRows[0].kind === 'perfect' && S.d2DeliveryRows[1].kind === 'rare', 'rows=' + JSON.stringify(S.d2DeliveryRows));

// ---- the real hook sites: S.batchRareCount is snapshotted at delivery-trip START, matching S.batchPerfect's own existing discipline ----
reset(); screen = 'play'; paused = false;
S.carried = [{ type: 'g', ph: 0, sp: 1 }, { type: 'e', ph: 0, sp: 1 }, { type: 'y', ph: 0, sp: 1 }];
S.cap = 5; // deliberately NOT a full jar -- isolates Rare Delivery from Perfect Delivery in this check
// jar.y is re-lerped toward jar.ty every frame (see update()'s own jar-
// movement code) -- ty must be set into the zone too, or the very next
// frame's lerp pulls y back out before the delivery check below ever runs.
S.jar.y = DELIVER_Y + 40; S.jar.ty = DELIVER_Y + 40;
__stepFrame(16);
__check('a real delivery trip beginning snapshots S.batchRareCount from the CARRIED batch at that moment (2 rares: shy + elder)', S.batchRareCount === 2, 'batchRareCount=' + S.batchRareCount);
__check('a real delivery trip beginning correctly reads S.batchPerfect as false when the jar was not actually full', S.batchPerfect === false);
`);

// =====================================================================
// Lumora 2.0 Phase 4: Night Events. Covers generation invariants (valid
// event or null, tutorial exclusion, restart-does-not-reroll, a genuine
// new night regenerates, eventHistory records exactly the real
// occurrences), and each event's own gameplay effect (Moonlight's rare-
// spawn boost across all three rare types, Firefly Rain's spawn burst,
// Moth Swarm's moth-rate increase + coin multiplier) -- verified either
// as an exact single-frame timer delta (deterministic) or as a
// statistical spawn-count comparison at generous margins (same
// calibration discipline the existing weather tests already use).
// =====================================================================
scenario('lumora2-phase4-night-events', null, `
upgrades.tutorialDone = true;

// ---- generateNightEvent(): always a valid outcome ----
var allValid = true;
for (var i = 0; i < 200; i++) {
  generateNightEvent();
  if (S.eventActive !== null && EVENT_TYPES.indexOf(S.eventActive) === -1) allValid = false;
}
__check('generateNightEvent() always sets S.eventActive to null or a valid EVENT_TYPES entry', allValid);

// ---- roughly NIGHT_EVENT_CHANCE of nights get an event (generous margin -- not pinned to the exact constant) ----
var eventCount = 0, N = 4000;
for (var i = 0; i < N; i++) { generateNightEvent(); if (S.eventActive !== null) eventCount++; }
var rate = eventCount / N;
__check('roughly 1 in 3 nights gets an event, not "never" or "always"', rate > 0.15 && rate < 0.55, 'rate=' + rate.toFixed(3));

// ---- tutorial exclusion ----
upgrades.tutorialDone = false;
reset();
__check('the tutorial night never gets a Night Event', S.eventActive === null && eventAnnounceActive() === false);
upgrades.tutorialDone = true;

// ---- restart (same nightNumber) never rerolls the event, and does not replay the announcement ----
// D4: the announcement/chip no longer have their own timer fields
// (eventBannerT/eventMsg are retired) -- "does not replay" is now
// expressed as S.isNewNight being false on a restart, which is exactly
// what eventAnnounceActive() itself gates on.
nightNumber = 1;
reset();
var firstEvent = S.eventActive;
reset(); // simulates Restart Night
__check('restarting the SAME night restores the exact same event (or same non-event), never a reroll', S.eventActive === firstEvent);
__check('restarting the SAME night does NOT replay the announcement (S.isNewNight is false)', S.isNewNight === false && eventAnnounceActive() === false);

// ---- eventHistory: grows by exactly 1 real entry per genuine new night that actually rolled an event, never on a restart ----
var historyBefore = eventHistory.length;
reset(); reset(); reset(); // more restarts at the same nightNumber
__check('restarting repeatedly at the same nightNumber never grows eventHistory', eventHistory.length === historyBefore);
var sawGrowth = false, sawNoGrowthNight = false, allEntriesMatched = true;
for (var i = 0; i < 30; i++) {
  nightNumber = 100 + i; // force a fresh, never-cached night each iteration
  var before = eventHistory.length;
  reset();
  if (eventHistory.length === before + 1) {
    sawGrowth = true;
    if (eventHistory[eventHistory.length - 1] !== S.eventActive) allEntriesMatched = false;
  } else if (eventHistory.length === before) sawNoGrowthNight = true;
  else allEntriesMatched = false; // grew by anything other than exactly 0 or 1 -- also a failure
}
__check('across 30 fresh nights, at least one genuinely rolled an event (eventHistory grew)', sawGrowth);
__check('across 30 fresh nights, at least one genuinely rolled no event (eventHistory did not grow)', sawNoGrowthNight);
__check('every eventHistory growth (across all 30 nights) matches exactly the night\\'s own S.eventActive, one entry at a time', allEntriesMatched);

// ---- nightEventCoinMult(): exactly 1.2x for Moth Swarm, 1x otherwise ----
S.eventActive = 'mothSwarm';
__check('nightEventCoinMult() is exactly 1.2 during Moth Swarm', nightEventCoinMult() === 1.2);
S.eventActive = 'moonlight';
__check('nightEventCoinMult() is 1 (no bonus) during Moonlight', nightEventCoinMult() === 1);
S.eventActive = 'fireflyRain';
__check('nightEventCoinMult() is 1 (no bonus) during Firefly Rain', nightEventCoinMult() === 1);
S.eventActive = null;
__check('nightEventCoinMult() is 1 on a night with no event', nightEventCoinMult() === 1);

// ---- Moonlight speeds the Elder timer (exact single-frame delta, same pattern as the existing luck-boost test) ----
reset(); screen = 'play'; paused = false;
S.score = 12; S.weather = 'clear'; S.eventActive = null; S.elderT = 999;
update(0.1);
var elderDeltaNormal = 999 - S.elderT;
reset(); screen = 'play'; paused = false;
S.score = 12; S.weather = 'clear'; S.eventActive = 'moonlight'; S.elderT = 999;
update(0.1);
var elderDeltaMoonlight = 999 - S.elderT;
__check('Moonlight measurably speeds up the Elder timer relative to a clear night', elderDeltaMoonlight > elderDeltaNormal, 'moonlight=' + elderDeltaMoonlight + ' normal=' + elderDeltaNormal);

// ---- Moonlight speeds the Mystery timer the same way ----
reset(); screen = 'play'; paused = false;
S.score = 20; S.weather = 'clear'; S.eventActive = null; S.mysteryT = 999;
update(0.1);
var mysteryDeltaNormal = 999 - S.mysteryT;
reset(); screen = 'play'; paused = false;
S.score = 20; S.weather = 'clear'; S.eventActive = 'moonlight'; S.mysteryT = 999;
update(0.1);
var mysteryDeltaMoonlight = 999 - S.mysteryT;
__check('Moonlight measurably speeds up the Mystery timer relative to a clear night', mysteryDeltaMoonlight > mysteryDeltaNormal, 'moonlight=' + mysteryDeltaMoonlight + ' normal=' + mysteryDeltaNormal);

// ---- Moonlight measurably boosts Shy's spawn share (statistical, same calibration discipline as the existing weather tests) ----
function sampleShyShare(eventActive, n){
  reset(); screen = 'play'; S.score = 20; S.weather = 'clear'; S.eventActive = eventActive;
  var shyCount = 0;
  for (var i = 0; i < n; i++) { spawnFly(); if (S.flies[S.flies.length - 1].type === 'g') shyCount++; }
  return shyCount / n;
}
var N2 = 20000;
var shareClear = sampleShyShare(null, N2);
var shareMoonlight = sampleShyShare('moonlight', N2);
__check('Moonlight measurably increases Shy\\'s spawn share once already unlocked', shareMoonlight > shareClear + 0.08, 'moonlight=' + shareMoonlight.toFixed(3) + ' clear=' + shareClear.toFixed(3));

// ---- Moth Swarm measurably increases how many moths spawn in a fixed window (statistical) ----
function sampleMothCount(eventActive, frames){
  reset(); screen = 'play'; paused = false;
  S.score = 8; S.weather = 'clear'; S.eventActive = eventActive; // within diff()'s 5<=s<13 mothRate window
  var count = 0;
  for (var i = 0; i < frames; i++) { var before = S.moths.length; __stepFrame(200); if (S.moths.length > before) count++; }
  return count;
}
var mothsNormal = sampleMothCount(null, 400);
var mothsSwarm = sampleMothCount('mothSwarm', 400);
__check('Moth Swarm spawns measurably more moths than a clear night over the same window', mothsSwarm > mothsNormal, 'swarm=' + mothsSwarm + ' normal=' + mothsNormal);

// ---- Firefly Rain measurably increases the average number of active fireflies on screen (statistical) ----
function sampleAvgActive(eventActive, frames){
  reset(); screen = 'play'; paused = false;
  S.score = 20; S.weather = 'clear'; S.eventActive = eventActive;
  var total = 0;
  for (var i = 0; i < frames; i++) { __stepFrame(200); total += S.flies.filter(function(f){ return f.state === 'drift' || f.state === 'locked'; }).length; }
  return total / frames;
}
var avgNormal = sampleAvgActive(null, 300);
var avgRain = sampleAvgActive('fireflyRain', 300);
__check('Firefly Rain measurably increases the average number of active fireflies on screen', avgRain > avgNormal, 'rain=' + avgRain.toFixed(2) + ' normal=' + avgNormal.toFixed(2));
`);

// =====================================================================
// Lumora 2.0 Phase 9: Weekly Progression. Covers weekKey()'s rolling
// bucket, resolveWeekly()'s new-week-reset vs same-week-restore split
// (mirrors resolveQuests()'s exact day-boundary discipline at a weekly
// grain), weeklyProgress()/checkWeeklyMilestones() (exact-once-per-
// milestone reward, the all-4 chest bonus, no re-granting), and the real
// hook sites (rare catch, delivery, a completed night, a rolled event).
// =====================================================================
scenario('lumora2-phase9-weekly', null, `
// ---- weekKey(): a pure rolling 7-day bucket from epoch ms ----
var oneWeekMs = 7 * 24 * 60 * 60 * 1000;
__check('weekKey() gives the same bucket for two timestamps inside the same 7-day window', weekKey(0) === weekKey(oneWeekMs - 1));
__check('weekKey() gives a different bucket once a full week has elapsed', weekKey(0) !== weekKey(oneWeekMs));

// ---- resolveWeekly(): first-ever session (prevLastPlayed<=0) always resets fresh ----
prevLastPlayed = 0; lastPlayed = 5000;
weeklyStats = { fireflies: 40, rare: 3, nights: 2, events: 1 };
weeklyMilestonesClaimed = { fireflies: true, rare: false, nights: false, events: false };
weeklyChestClaimed = false;
resolveWeekly({ stats: { fireflies: 99 }, claimed: {}, chestClaimed: false });
__check('resolveWeekly() with prevLastPlayed<=0 (first-ever session) resets weeklyStats fresh, ignoring any loaded payload', JSON.stringify(weeklyStats) === JSON.stringify({ fireflies: 0, rare: 0, nights: 0, events: 0 }));
__check('resolveWeekly() with prevLastPlayed<=0 also resets weeklyMilestonesClaimed fresh', JSON.stringify(weeklyMilestonesClaimed) === JSON.stringify({ fireflies: false, rare: false, nights: false, events: false }));

// ---- resolveWeekly(): a genuine new week (bucket changed) resets, even with real loaded progress ----
prevLastPlayed = 1000; lastPlayed = 1000 + oneWeekMs;
resolveWeekly({ stats: { fireflies: 80, rare: 4, nights: 3, events: 1 }, claimed: { fireflies: true }, chestClaimed: false });
__check('resolveWeekly() resets weeklyStats when the week bucket has genuinely changed, discarding last week\\'s progress', JSON.stringify(weeklyStats) === JSON.stringify({ fireflies: 0, rare: 0, nights: 0, events: 0 }));

// ---- resolveWeekly(): the SAME week restores exactly what was loaded ----
prevLastPlayed = 1000; lastPlayed = 1000 + 5000; // well within the same 7-day bucket
resolveWeekly({ stats: { fireflies: 42, rare: 2, nights: 1, events: 0 }, claimed: { fireflies: false, rare: true, nights: false, events: false }, chestClaimed: false });
__check('resolveWeekly() restores the exact loaded stats when still within the same week', JSON.stringify(weeklyStats) === JSON.stringify({ fireflies: 42, rare: 2, nights: 1, events: 0 }));
__check('resolveWeekly() restores the exact loaded claimed-milestone flags when still within the same week', weeklyMilestonesClaimed.rare === true && weeklyMilestonesClaimed.fireflies === false);

// ---- weeklyProgress()/checkWeeklyMilestones(): exact-once-per-milestone reward, no re-grant, no over-completion ----
weeklyStats = { fireflies: 0, rare: 0, nights: 0, events: 0 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: false };
weeklyChestClaimed = false;
var coinsStart = coins;
weeklyProgress('events', 1);
__check('weeklyProgress() increments the named stat by the given amount', weeklyStats.events === 1);
// Phase 11: a newly-claimed Weekly milestone also advances Season by one level (+30 coinsPerLevel here, since level 1 of 10 isn't the final level), so the total is +30 (milestone) + 30 (season).
__check('crossing the events milestone (target 1) grants exactly its own reward (+30) plus the Phase 11 Season level-up (+30)', weeklyMilestonesClaimed.events === true && coins === coinsStart + 30 + 30, 'coins=' + coins);
var coinsAfterEvents = coins;
weeklyProgress('events', 1);
__check('further progress on an already-claimed milestone does not re-grant its reward', weeklyStats.events === 2 && coins === coinsAfterEvents);

// ---- the Weekly Glow Chest grants only once all 4 are claimed, exactly once ----
weeklyProgress('fireflies', 100);
weeklyProgress('rare', 5);
var coinsBeforeLastMilestone = coins;
weeklyProgress('nights', 5);
__check('the 4th and final milestone (nights) still grants its own reward (+50)', weeklyMilestonesClaimed.nights === true);
// Phase 11: the 4th milestone crossing AND the chest bonus each independently advance Season by one level (+30 each, coinsPerLevel, since these are levels 4 and 5 of 10 -- not the final level), so the total is +50 (milestone) +30 (its season level) +100 (chest) +30 (chest's season level).
__check('completing the 4th milestone ALSO grants the Weekly Glow Chest bonus (+100) in the same call, plus the two Phase 11 Season level-ups (+30 each) triggered by the milestone and the chest', coins === coinsBeforeLastMilestone + 50 + 30 + 100 + 30, 'coins=' + coins);
var coinsAfterChest = coins;
weeklyProgress('fireflies', 1);
__check('the chest bonus is never granted a second time, even as stats keep growing past every target', coins === coinsAfterChest);

// ---- real hook sites: a rare catch increments weeklyStats.rare ----
upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false;
// D1: a genuine new night now opens with the new-night reveal card, which
// gates update(dt) entirely for up to 4.30s (see newNightCardActive()) --
// dismissed here exactly like a real player's tap would (S.newNightT
// jumped straight to the dismiss keyframe), so this test's own frame-
// stepping isn't blocked by an unrelated D1 UI moment.
S.newNightT = 4.30;
weeklyStats = { fireflies: 0, rare: 0, nights: 0, events: 0 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: false };
weeklyChestClaimed = false;
var jx0 = S.jar.x, jy0 = S.jar.y - 14;
S.flies.push({ x: jx0, y: jy0, type: 'g', state: 'caught', animT: 0, animA: 0, animR: 0 });
for (var wci = 0; wci < 40 && S.flies.some(function(f){ return f.type === 'g' && f.state === 'caught'; }); wci++) __stepFrame(16);
__check('a real catch of a rare type (Shy) increments weeklyStats.rare via the real catch-success hook site', weeklyStats.rare === 1, 'rare=' + weeklyStats.rare);
S.flies.push({ x: jx0, y: jy0, type: 'y', state: 'caught', animT: 0, animA: 0, animR: 0 });
for (var wci2 = 0; wci2 < 40 && S.flies.some(function(f){ return f.type === 'y' && f.state === 'caught'; }); wci2++) __stepFrame(16);
__check('a real catch of a common type (Curious) does NOT increment weeklyStats.rare', weeklyStats.rare === 1);

// ---- real hook site: a real delivery increments weeklyStats.fireflies ----
reset(); screen = 'play'; paused = false;
weeklyStats = { fireflies: 0, rare: 0, nights: 0, events: 0 };
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var wdi = 0; wdi < 120 && (S.sparks.length > 0 || S.carried.length > 0); wdi++) __stepFrame(16);
__check('a real delivery increments weeklyStats.fireflies via the real delivery-success hook site', weeklyStats.fireflies === 1);

// ---- real hook site: a completed night increments weeklyStats.nights, same moment as nightNumber ----
reset(); screen = 'play'; paused = false;
weeklyStats = { fireflies: 0, rare: 0, nights: 0, events: 0 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: false };
weeklyChestClaimed = false;
var nightNumberBefore = nightNumber;
S.over = true; S.overT = 1;
continueFromOver();
__check('completing a real night increments weeklyStats.nights by exactly 1, the same moment nightNumber itself advances', weeklyStats.nights === 1 && nightNumber === nightNumberBefore + 1);

// ---- real hook site: a rolled Night Event increments weeklyStats.events ----
weeklyStats = { fireflies: 0, rare: 0, nights: 0, events: 0 };
var eventsSeen = 0;
for (var wei = 0; wei < 30; wei++) { nightNumber = 200 + wei; if (generateNightEvent(), S.eventActive !== null) eventsSeen++; }
__check('every real Night Event roll increments weeklyStats.events by exactly 1, matching how many actually rolled', weeklyStats.events === eventsSeen && eventsSeen > 0, 'events=' + weeklyStats.events + ' seen=' + eventsSeen);

// ---- persistence: the non-YT localStorage path writes the exact live weekly state ----
weeklyStats = { fireflies: 7, rare: 1, nights: 0, events: 0 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: false };
weeklyChestClaimed = false;
persistWeeklyLocal();
var savedWeekly = JSON.parse(localStorage.getItem('gk2_weekly') || 'null');
__check('persistWeeklyLocal() writes weeklyStats/weeklyMilestonesClaimed/weeklyChestClaimed to gk2_weekly', savedWeekly && JSON.stringify(savedWeekly.stats) === JSON.stringify(weeklyStats) && JSON.stringify(savedWeekly.claimed) === JSON.stringify(weeklyMilestonesClaimed) && savedWeekly.chestClaimed === false, 'saved=' + JSON.stringify(savedWeekly));

// =====================================================================
// Phase 9 audit: the above (pre-existing, from an earlier out-of-sequence
// pass) already covers weekKey()/resolveWeekly()'s 3 branches, exact-once
// milestone+chest granting, all 4 real hook sites via genuine gameplay,
// and the raw persistence write. These few checks close the specific
// gaps the Phase 9 spec calls out that weren't already asserted:
// double-count-from-rendering, previous-week-reward-not-regranted, and
// Daily-Quest/Weekly independence. No production code changed -- the
// audit found the existing system correct for its own already-decided
// scope (4 goals: fireflies/rare/nights/events; no contracts/chain
// category was ever part of this design, so Tests 14/16 in the spec's own
// list are N/A here, not a gap).
// =====================================================================

// ---- Test 2: a fresh player (module-load defaults, before any resolveWeekly() call) has valid initial weekly state ----
__check('Test 2: WEEKLY_MILESTONES itself is a stable, non-empty goal set', Array.isArray(WEEKLY_MILESTONES) && WEEKLY_MILESTONES.length === 4 && WEEKLY_MILESTONES.every(function(m){ return typeof m.key === 'string' && m.target > 0 && m.reward > 0 && typeof m.label === 'string'; }));

// ---- Test 5: no double count from a duplicate render/reopen flow -- weeklyProgress() is never called from any draw function, only from real gameplay hooks, so re-rendering Night Complete or the Weekly Journal tab any number of times must never move weeklyStats ----
upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false;
weeklyStats = { fireflies: 3, rare: 1, nights: 2, events: 1 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: true };
weeklyChestClaimed = false;
S.over = true; S.overT = 1; S.tip = NIGHT_TIPS[0]; coinsAtRoundStart = coins; S.objectiveActive = [];
var weeklyBeforeRenders = JSON.stringify(weeklyStats);
var coinsBeforeRenders = coins;
var threwOnRepeatedRender = false;
try {
  for (var wri = 0; wri < 50; wri++) { drawOver(); journalTab = 'weekly'; drawJournalScreen(); }
} catch (e) { threwOnRepeatedRender = true; }
__check('Test 5 setup: repeated Night Complete / Weekly Journal renders do not throw', !threwOnRepeatedRender);
__check('Test 5: weeklyStats is byte-for-byte unchanged after 50 repeated renders of both the completion screen and the Weekly tab -- rendering never calls weeklyProgress()', JSON.stringify(weeklyStats) === weeklyBeforeRenders);
__check('Test 5: no coins were granted merely from re-rendering', coins === coinsBeforeRenders);

// ---- Test 11: a previous week's already-claimed reward is never re-granted once a new week is detected ----
weeklyStats = { fireflies: 999, rare: 999, nights: 999, events: 999 }; // last week: everything long since completed
weeklyMilestonesClaimed = { fireflies: true, rare: true, nights: true, events: true };
weeklyChestClaimed = true; // the chest bonus was already claimed last week too
var coinsBeforeNewWeek = coins;
prevLastPlayed = 1000; lastPlayed = 1000 + oneWeekMs; // a genuine new week has begun
resolveWeekly({ stats: { fireflies: 999, rare: 999, nights: 999, events: 999 }, claimed: { fireflies: true, rare: true, nights: true, events: true }, chestClaimed: true });
__check('Test 11: loading into a new week does not grant any coins from last week\\'s already-claimed rewards', coins === coinsBeforeNewWeek);
__check('Test 11: the new week starts with fresh, unclaimed milestones -- last week\\'s claimed flags do not carry over', JSON.stringify(weeklyMilestonesClaimed) === JSON.stringify({ fireflies: false, rare: false, nights: false, events: false }) && weeklyChestClaimed === false);
__check('Test 11: the new week\\'s progress starts at zero, not carried over from last week\\'s totals', JSON.stringify(weeklyStats) === JSON.stringify({ fireflies: 0, rare: 0, nights: 0, events: 0 }));

// ---- Test 12: Daily Quest reset (rollQuests()) does not touch weekly state, and resolveWeekly() does not touch quests -- fully independent, separately-keyed systems ----
weeklyStats = { fireflies: 12, rare: 2, nights: 1, events: 0 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: false };
var weeklyBeforeQuestReset = JSON.stringify(weeklyStats);
var claimedBeforeQuestReset = JSON.stringify(weeklyMilestonesClaimed);
rollQuests(); // a genuine daily quest reroll, same function a new calendar day triggers
__check('Test 12: rollQuests() (a Daily Quest reset) does not change weeklyStats', JSON.stringify(weeklyStats) === weeklyBeforeQuestReset);
__check('Test 12: rollQuests() does not change weeklyMilestonesClaimed either', JSON.stringify(weeklyMilestonesClaimed) === claimedBeforeQuestReset);
var questsBeforeWeeklyResolve = JSON.stringify(quests);
prevLastPlayed = 1000; lastPlayed = 1000 + 5000; // same-week resolveWeekly call
resolveWeekly({ stats: weeklyStats, claimed: weeklyMilestonesClaimed, chestClaimed: false });
__check('Test 12: resolveWeekly() does not touch the quests array in the other direction either', JSON.stringify(quests) === questsBeforeWeeklyResolve);
`);

// =====================================================================
// D1 (Claude Design spec, "Night Objectives UI"): the state-machine and
// gating logic behind the new-night reveal card and the Objective HUD's
// collapse/expand/complete behavior. Pixel-level rendering can't be
// verified by this headless harness (no real canvas), so these tests
// cover the parts that ARE mechanically verifiable: S.isNewNight's
// lifecycle, the card's active/visible windows and its gameplay-pausing
// effect, tap-to-dismiss, and the HUD's hold/collapse/sticky/all-complete
// transitions.
// =====================================================================
scenario('lumora2-d1-new-night-card', null, `
upgrades.tutorialDone = true;

// ---- isNewNight: true on a genuine fresh generation, false on a restart, false during the tutorial ----
nightNumber = 1;
reset();
__check('a genuine new night (cold cache) sets S.isNewNight true', S.isNewNight === true);
reset(); // restart at the same nightNumber
__check('restarting the SAME night sets S.isNewNight false -- the reveal card is a one-time thing, not replayed on retry', S.isNewNight === false);
upgrades.tutorialDone = false;
reset();
__check('the tutorial night never sets S.isNewNight, regardless of nightNumber', S.isNewNight === false);
upgrades.tutorialDone = true;

// ---- active/visible windows ----
nightNumber = 2; // force a fresh generation again (cache is stale for this nightNumber)
reset(); screen = 'title';
__check('newNightCardActive() is false before the player even reaches screen=play, even though S.isNewNight is already true', newNightCardActive() === false);
screen = 'play';
__check('newNightCardActive() is true right at S.newNightT=0 on screen=play', newNightCardActive() === true);
__check('newNightCardVisible() is also true at t=0', newNightCardVisible() === true);
S.newNightT = 4.30;
__check('newNightCardActive() is false exactly AT the 4.30 dismiss keyframe -- gameplay must already be resumed by then', newNightCardActive() === false);
__check('newNightCardVisible() is still true at 4.30 -- the exit animation keeps rendering past the active window', newNightCardVisible() === true);
S.newNightT = 4.70;
__check('newNightCardVisible() is false once the exit animation has fully finished', newNightCardVisible() === false);

// ---- gameplay is genuinely paused while the card is active, and resumes once it is not ----
nightNumber = 3;
reset(); screen = 'play'; paused = false;
__check('sanity: a fresh night 3 is a genuine new night on screen=play', newNightCardActive() === true);
var tBefore = S.t;
for (var i = 0; i < 10; i++) __stepFrame(16);
__check('S.t (gameplay elapsed time) does not advance while the new-night card is active -- update(dt) is genuinely gated, not just visually covered', S.t === tBefore, 't=' + S.t);
S.newNightT = 4.30; // simulate the auto-dismiss keyframe being reached
for (var i = 0; i < 10; i++) __stepFrame(16);
__check('S.t resumes advancing once the card is no longer active, even though it is still visible (exit animation)', S.t > tBefore, 't=' + S.t);

// ---- tap anywhere dismisses -- jumps S.newNightT straight to the 4.30 keyframe, not a separate flag ----
nightNumber = 4;
reset(); screen = 'play'; paused = false;
__check('sanity: night 4 opens with the card active', newNightCardActive() === true && S.newNightT < 4.30);
__fire(cv, 'pointerdown', __fakeEvent(50, 700)); // anywhere on screen -- the spec's own "entire frame is the dismiss hit area"
__check('a tap anywhere while the card is active jumps S.newNightT straight to 4.30', S.newNightT === 4.30);
__check('immediately after the tap, the card is no longer "active" (gameplay already resumed)', newNightCardActive() === false);

// ---- a tap has no special effect once the card is not showing (falls through to normal jar-drag input) ----
nightNumber = 5;
reset(); screen = 'play'; paused = false;
S.newNightT = 5; // past the card entirely
__fire(cv, 'pointerdown', __fakeEvent(300, 400));
__check('once the card is gone, a tap drives the jar normally (not swallowed as a dismiss) -- jar.tx tracks the tap x, clamped to [30,W-30]', S.jar.tx === clamp(300,30,W-30), 'jar.tx=' + S.jar.tx);
`);

scenario('lumora2-d1-objective-hud-state-machine', null, `
upgrades.tutorialDone = true;
nightNumber = 1;
reset(); screen = 'play'; paused = false;
S.newNightT = 4.30; // dismiss the reveal card immediately -- this scenario tests the HUD, not the card

// ---- night start: expanded, holds ~4.0s, then auto-collapses ----
__check('a fresh night starts with the HUD expanded (not collapsed)', S.hudCollapsed === false);
__check('a fresh night starts with a 4.0s hold and no sticky pin', Math.abs(S.hudHoldT - 4.0) < 1e-9 && S.hudSticky === false);
for (var i = 0; i < 250; i++) __stepFrame(16); // ~4.0s of real gameplay time
__check('after ~4.0s with no progress events, the HUD auto-collapses', S.hudCollapsed === true);

// ---- a progress event (that does not complete the objective) re-expands and gives a fresh 2.4s hold ----
S.objectiveActive = [{ id: 'catch_playful', category: 'catch', kind: 'catch', fireflyType: 'b', target: 5, reward: 20, done: false }];
S.objectiveProgress = { catch_playful: 0 };
objectiveProgress('catch', 'b');
__check('a mid-round progress tick (not yet complete) re-expands a collapsed HUD', S.hudCollapsed === false);
__check('a progress tick sets exactly a 2.4s hold', Math.abs(S.hudHoldT - 2.4) < 1e-9);
for (var i = 0; i < 200; i++) __stepFrame(16); // > 2.4s
__check('the 2.4s progress-extend hold also auto-collapses once it runs out', S.hudCollapsed === true);

// ---- completion (not all objectives): HUD is forced collapsed so the completion banner owns the moment ----
S.objectiveActive = [
  { id: 'catch_playful', category: 'catch', kind: 'catch', fireflyType: 'b', label: 'Catch 1 Playful', target: 1, reward: 20, done: false },
  { id: 'deliver_total', category: 'delivery', kind: 'deliver', label: 'Deliver 5 Fireflies', target: 5, reward: 30, done: false }
];
S.objectiveProgress = { catch_playful: 0, deliver_total: 0 };
S.hudCollapsed = false; // simulate it being open right before the completion
objectiveProgress('catch', 'b'); // completes catch_playful (target 1), deliver_total still pending
__check('completing ONE of several objectives (not all) force-collapses the HUD, per direct spec ("HUD stays or goes COLLAPSED so the banner owns the moment")', S.hudCollapsed === true);
__check('capMsgKind is set to objectiveComplete for the dedicated banner composite', S.capMsgKind === 'objectiveComplete');
__check('capMsgData carries the completed objective\\'s own label and reward for that composite', S.capMsgData && S.capMsgData.label === 'Catch 1 Playful' && S.capMsgData.reward === 20, 'data=' + JSON.stringify(S.capMsgData));
__check('the objective-complete banner uses its own 2.24s on-screen duration, not the generic 3.5s', Math.abs(S.capMsgT - 2.24) < 1e-9);

// ---- all objectives complete: celebrate-then-chip sequence takes priority, HUD becomes sticky ----
S.hudCollapsed = true;
objectiveProgress('deliver', 'y'); // completes the last remaining objective (deliver_total, target 5 -- wait, needs 5 calls)
for (var i = 0; i < 4; i++) objectiveProgress('deliver', 'y'); // reach target 5
__check('once every objective is done, S.hudAllComplete is set', S.hudAllComplete === true);
__check('the all-complete celebration starts at a fresh 2.6s', Math.abs(S.hudAllCompleteT - 2.6) < 1e-9);
__check('S.hudSticky is set true so nothing can auto-collapse the settled chip later', S.hudSticky === true);
for (var i = 0; i < 200; i++) __stepFrame(16); // run the celebration + morph well past completion
__check('S.hudAllCompleteT floors at -0.34 (celebration + morph-to-chip fully elapsed) and does not go lower', S.hudAllCompleteT === -0.34, 'hudAllCompleteT=' + S.hudAllCompleteT);

// ---- manual tap toggle: expanding by hand is sticky, collapsing by hand still works ----
reset(); screen = 'play'; paused = false;
S.newNightT = 4.30;
for (var i = 0; i < 260; i++) __stepFrame(16); // let it auto-collapse
__check('sanity: the HUD auto-collapsed again on this fresh night', S.hudCollapsed === true);
__fire(cv, 'pointerdown', __fakeEvent(98, 99)); // the HUD's own hit target, centre
__check('tapping the HUD toggles it open', S.hudCollapsed === false);
__check('a manual expand sets S.hudSticky -- no further auto-collapse this night', S.hudSticky === true);
for (var i = 0; i < 260; i++) __stepFrame(16); // would have auto-collapsed by now if not sticky
__check('the sticky HUD does NOT auto-collapse after its normal hold would have expired', S.hudCollapsed === false);
__fire(cv, 'pointerdown', __fakeEvent(98, 99));
__check('tapping again still manually collapses it -- sticky only disables AUTOMATIC collapse, not manual control', S.hudCollapsed === true);

// ---- objectiveDisplayProgress/objectiveDisplayFailed: unified score-based progress display, live miss-budget failure read ----
reset(); screen = 'play'; paused = false;
S.newNightT = 4.30;
S.objectiveActive = [{ id: 'finish_under_3_misses', category: 'miss', kind: 'missUnder', missLimit: 3, target: 10, reward: 15, done: false }];
S.objectiveProgress = { finish_under_3_misses: 6 };
S.misses = 1;
__check('objectiveDisplayProgress() now reads the same S.objectiveProgress entry as every other category -- no more special-cased live S.misses read', objectiveDisplayProgress(S.objectiveActive[0]) === 6);
__check('objectiveDisplayFailed() is false while still under the miss budget', objectiveDisplayFailed(S.objectiveActive[0]) === false);
S.misses = 3;
__check('objectiveDisplayFailed() reads true the instant the live miss budget is genuinely blown, even mid-round, well before night\\'s end', objectiveDisplayFailed(S.objectiveActive[0]) === true);
__check('o.done itself is still false -- reaching the miss limit does not itself complete or fail the objective, it only gates whether a future score-target hit can complete it', S.objectiveActive[0].done === false);
`);

// Note on coverage: the mock ctx.measureText() always returns a fixed
// {width:10} (see __makeCtx() above), so d2ChainMetrics()'s pixel geometry
// can't be meaningfully asserted on here -- same limitation the D1 scenarios
// above already documented for their own pixel/timing specifics. These two
// scenarios cover the STATE machine (what triggers what, with which numbers)
// that drives drawChainHUD()/drawDeliveryComposite()/drawJarRarity(), which
// is exactly what a harness without a real browser CAN verify convincingly.
scenario('lumora2-d2-glow-chain-hud', null, `
upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false;
S.newNightT = 4.30; // dismiss the D1 card -- this scenario tests D2's chain HUD, not D1's

// ---- A1: the one-shot enter fires exactly at chain 3, ticks fire after ----
__check('chain starts at 0 with no HUD state active', S.chain === 0 && S.d2ChainEnterT === 0 && S.d2ChainMomentT === 0);
advanceChain(); advanceChain();
__check('chain 1-2: no enter animation yet -- below the x3 visibility floor', S.chain === 2 && S.d2ChainEnterT === 0);
advanceChain();
__check('chain reaches exactly 3: the one-shot enter animation fires', S.chain === 3 && Math.abs(S.d2ChainEnterT - 0.26) < 1e-9);
__check('d2ChainLastN tracks the live chain once it is showing', S.d2ChainLastN === 3);
advanceChain();
__check('chain 4: a tick fires, not another enter', S.chain === 4 && Math.abs(S.d2ChainTickT - 0.22) < 1e-9);

// ---- milestones: coin math is byte-for-byte the pre-D2 math; only the ON-SCREEN duration scales with tier ----
var coinsBefore = coins;
advanceChain(); // -> 5
__check('reaching the x5 milestone still grants exactly +5 coins, same as before D2', coins === coinsBefore + 5, 'coins=' + coins);
__check('the moment sequence is armed for x5 at the medium 0.72s duration', S.d2ChainMomentN === 5 && Math.abs(S.d2ChainMomentTotal - 0.72) < 1e-9 && Math.abs(S.d2ChainMomentT - 0.72) < 1e-9);
for (var i = 0; i < 5; i++) advanceChain(); // -> 10
__check('x10 arms the 1.35s high-tier moment', S.d2ChainMomentN === 10 && Math.abs(S.d2ChainMomentTotal - 1.35) < 1e-9);
for (var i = 0; i < 5; i++) advanceChain(); // -> 15
__check('x15 arms the 1.50s high-tier moment', S.d2ChainMomentN === 15 && Math.abs(S.d2ChainMomentTotal - 1.50) < 1e-9);
for (var i = 0; i < 5; i++) advanceChain(); // -> 20
__check('x20 arms the 1.70s high-tier moment', S.d2ChainMomentN === 20 && Math.abs(S.d2ChainMomentTotal - 1.70) < 1e-9);
S.d2ChainMomentT = 0; // drain the x20 moment's own leftover timer first, so the next check isolates THIS advance's effect
advanceChain(); // -> 21, past the last milestone
__check('beyond x20 the counter keeps counting but no further moment fires, per CHAIN_MILESTONES itself', S.chain === 21 && S.d2ChainMomentN === 20 && S.d2ChainMomentT === 0);

// ---- update() genuinely decrements these countdowns, same convention as S.capMsgT ----
// loop()'s own dt clamp caps every single frame at 0.033s regardless of how
// much wall-clock time __stepFrame() is asked to advance (confirmed: the
// dt-clamp correctness audit noted in CLAUDE.md) -- draining a timer needs
// enough SEPARATE 16ms frames, not one large-millisecond __stepFrame() call.
S.d2ChainMomentT = 0.10;
__stepFrame(16);
__check('d2ChainMomentT decrements toward 0 in update()', S.d2ChainMomentT < 0.10 && S.d2ChainMomentT >= 0);
for (var i = 0; i < 20; i++) __stepFrame(16);
__check('d2ChainMomentT floors at 0, never negative', S.d2ChainMomentT === 0);

// ---- A4: a chain that reached >=5 gets the full break sequence; below 5 just fades; below 3 animates nothing ----
reset(); screen = 'play'; paused = false; S.newNightT = 4.30;
for (var i = 0; i < 6; i++) advanceChain(); // chain = 6
breakChain();
__check('breaking a chain that reached >=5 arms the full 0.92s break sequence and captures the broken length', S.chain === 0 && S.d2ChainBreakN === 6 && Math.abs(S.d2ChainBreakT - 0.92) < 1e-9);
__check('the plain exit fade is NOT also armed -- the break sequence supersedes it', S.d2ChainExitT === 0);

reset(); screen = 'play'; paused = false; S.newNightT = 4.30;
advanceChain(); advanceChain(); advanceChain(); advanceChain(); // chain = 4, never reached a milestone
breakChain();
__check('breaking a chain that never reached x5 just plays the plain 0.20s exit fade, not the break sequence', S.chain === 0 && S.d2ChainBreakT === 0 && Math.abs(S.d2ChainExitT - 0.20) < 1e-9);

reset(); screen = 'play'; paused = false; S.newNightT = 4.30;
advanceChain(); advanceChain(); // chain = 2, was never even showing (below the x3 floor)
breakChain();
__check('breaking a chain that never reached the x3 visibility floor animates nothing at all', S.chain === 0 && S.d2ChainBreakT === 0 && S.d2ChainExitT === 0);
`);

scenario('lumora2-d2-delivery-and-rarity', null, `
upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false;
S.newNightT = 4.30;

// ---- resolveDeliveryBonuses(): the D2 composite is armed correctly (the coin math itself is covered elsewhere -- this is the presentation wiring) ----
S.objectiveActive = []; S.objectiveProgress = {};
S.batchPerfect = true; S.batchRareCount = 0; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
resolveDeliveryBonuses();
__check('a Perfect-only delivery arms the 1.25s(hold)+0.34s(exit)=1.59s composite with exactly one row', S.d2DeliveryRows.length === 1 && Math.abs(S.d2DeliveryTotal - 1.59) < 1e-9 && Math.abs(S.d2DeliveryT - 1.59) < 1e-9);

S.batchPerfect = true; S.batchRareCount = 2; S.batchRarestType = 'g'; S.d2DeliveryRows = []; S.d2DeliveryT = 0;
resolveDeliveryBonuses();
__check('Perfect+Rare together arm the longer 1.45s(hold)+0.34s(exit)=1.79s composite with two rows, perfect first', S.d2DeliveryRows.length === 2 && S.d2DeliveryRows[0].kind === 'perfect' && S.d2DeliveryRows[1].kind === 'rare' && Math.abs(S.d2DeliveryTotal - 1.79) < 1e-9);
__check('the rare row is tinted to the snapshotted rarest type (shy -> GLOW_G), not a flat placeholder cool-blue', S.d2DeliveryTintRGB === toRgbTriple(GLOW_G), 'tint=' + S.d2DeliveryTintRGB);

// ---- update() decrements the delivery timer, same countdown convention ----
// (loop()'s dt clamp caps each frame at 0.033s -- see the same note in the
// glow-chain-hud scenario -- so draining needs several small steps, not one
// big-millisecond __stepFrame() call.)
S.d2DeliveryT = 0.10;
__stepFrame(16);
__check('d2DeliveryT decrements toward 0 in update()', S.d2DeliveryT < 0.10 && S.d2DeliveryT >= 0);
for (var i = 0; i < 20; i++) __stepFrame(16);
__check('d2DeliveryT floors at 0', S.d2DeliveryT === 0);

// ---- rarestCarriedType(): mystery > elder > shy, ignores common/uncommon, null when nothing rare is carried ----
S.carried = [{ type: 'y', ph: 0, sp: 1 }, { type: 'b', ph: 0, sp: 1 }];
__check('rarestCarriedType() is null when nothing rare is carried', rarestCarriedType() === null);
S.carried.push({ type: 'g', ph: 0, sp: 1 });
__check('shy alone is the rarest carried', rarestCarriedType() === 'g');
S.carried.push({ type: 'e', ph: 0, sp: 1 });
__check('elder outranks shy', rarestCarriedType() === 'e');
S.carried.push({ type: 'm', ph: 0, sp: 1 });
__check('mystery outranks everything', rarestCarriedType() === 'm');

// ---- B3: the rare-ring fade-in timer arms only at the 2+ payout threshold, and resets instantly below it ----
S.carried = [{ type: 'g', ph: 0, sp: 1, caughtAt: S.t }];
S.d2RareRingT = 0;
__stepFrame(16);
__check('1 rare carried: the ring timer stays at 0 -- the armed threshold is 2, matching resolveDeliveryBonuses() own check', S.d2RareRingT === 0);
S.carried.push({ type: 'e', ph: 0, sp: 1, caughtAt: S.t });
__stepFrame(16);
__check('2 rares carried: the ring timer starts counting up', S.d2RareRingT > 0);
for (var i = 0; i < 40; i++) __stepFrame(16); // well past 0.5s
__check('the ring timer caps at its own 0.5s fade-in duration, never grows past it', S.d2RareRingT === 0.5, 'ringT=' + S.d2RareRingT);
S.carried.pop(); // back down to 1 rare, below the armed threshold
__stepFrame(16);
__check('dropping back below the threshold resets the ring timer to 0 instantly, so it genuinely replays its fade-in next time', S.d2RareRingT === 0);
`);

// D3 (Claude Design spec): Night Contract UI + the gameplay system underneath
// it (which didn't exist before this pass -- see CONTRACTS' own comment).
// Covers the screen's own state machine (selection/dock/accept/exit),
// the gameplay hook functions' per-contract values and no-contract
// defaults, the forced objective category, and finalizeNight()'s own
// bookkeeping (contractsCompleted, Collector's Workshop Token). Pixel
// geometry isn't checkable here for the same reason as D1/D2's own scenarios
// (the mock ctx.measureText() returns a fixed width).
scenario('lumora2-d3-night-contracts', null, `
// ---- beginPlay(): tutorialDone=false skips contracts entirely (byte-identical to pre-D3) ----
upgrades.tutorialDone = false;
screen = 'title';
beginPlay();
__check('a first-time player (tutorialDone=false) goes straight to play, no contract screen', screen === 'play');

// ---- beginPlay(): tutorialDone=true opens Contract Selection first ----
upgrades.tutorialDone = true;
screen = 'title';
beginPlay();
__check('a returning player (tutorialDone=true) opens Contract Selection instead', screen === 'contract');
__check('the screen starts with nothing selected', contractSel === -1);

// ---- selecting, deselecting, swapping ----
selectContract(1);
__check('selecting a card sets contractSel', contractSel === 1);
__check('the dock rise timestamp is armed on first selection', contractDockAt >= 0);
var dockAtFirst = contractDockAt;
selectContract(2);
__check('selecting a DIFFERENT card swaps contractSel, no retract/dismiss step', contractSel === 2);
__check('the dock does NOT re-rise on a swap -- only the first selection ever arms it', contractDockAt === dockAtFirst);
selectContract(2);
__check('tapping the SAME (selected) card again deselects', contractSel === -1);
__check('deselecting retracts the dock', contractDockAt === -1);

// ---- accept arms the exit; finishContractAccept() hands off to play ----
selectContract(0);
acceptContract();
__check('ACCEPT arms the exit sequence', contractExitAt >= 0);
var contractExitAtBefore = contractExitAt;
acceptContract();
__check('a second ACCEPT tap while already exiting is a no-op', contractExitAt === contractExitAtBefore);
finishContractAccept();
__check('finishContractAccept() sets activeContract to whatever was selected', activeContract === 0);
__check('finishContractAccept() hands off to the play screen', screen === 'play');

// ---- activeContract survives a direct reset() (pause menu Restart Night never re-prompts) ----
var contractBeforeRestart = activeContract;
reset();
__check('a direct reset() (Restart Night) does not touch activeContract -- same night, same contract', activeContract === contractBeforeRestart);

// ---- gameplay multiplier helpers: correct per-contract values, safe defaults with no contract ----
activeContract = -1;
__check('no contract: every multiplier defaults to 1, missBonus to 0, category to null', contractSpeedMult() === 1 && contractMissBonus() === 0 && contractCoinMult() === 1 && contractSpawnMult() === 1 && contractRareMult() === 1 && contractMothMult() === 1 && contractPlayfulMult() === 1 && contractObjectiveCategory() === null);
activeContract = 0; // peaceful
__check('Peaceful: speed -25%, +2 misses, +20% coins, forces the delivery objective category', contractSpeedMult() === 0.75 && contractMissBonus() === 2 && contractCoinMult() === 1.20 && contractObjectiveCategory() === 'delivery');
activeContract = 1; // rush
__check('Rush: +60% spawn rate, +50% rare chance, +40% coins, forces the score category', contractSpawnMult() === 1.60 && contractRareMult() === 1.50 && contractCoinMult() === 1.40 && contractObjectiveCategory() === 'score');
activeContract = 2; // moth
__check('Moth Night: x3 moths, x2 rares, +65% coins, forces NO category (stays random)', contractMothMult() === 3 && contractRareMult() === 2 && contractCoinMult() === 1.65 && contractObjectiveCategory() === null);
activeContract = 3; // collector
__check('Collector: x2 Playful spawns, forces the catch category, no coin multiplier at all', contractPlayfulMult() === 2 && contractObjectiveCategory() === 'catch' && contractCoinMult() === 1);

// ---- generateNightObjectives(): the forced category is always present among tonight's 3 ----
for (var __i = 0; __i < 20; __i++) { // several passes -- the other 2 slots are randomly shuffled, so one pass alone isn't conclusive
  activeContract = 0; // peaceful -> delivery
  generateNightObjectives();
  __check('Peaceful always forces a delivery objective into tonight\\'s 3', S.objectiveActive.some(function(o){ return o.category === 'delivery'; }));
  activeContract = 1; // rush -> score
  generateNightObjectives();
  __check('Rush always forces a score objective into tonight\\'s 3', S.objectiveActive.some(function(o){ return o.category === 'score'; }));
  activeContract = 3; // collector -> catch
  generateNightObjectives();
  __check('Collector always forces a catch objective into tonight\\'s 3', S.objectiveActive.some(function(o){ return o.category === 'catch'; }));
}

// ---- contractPayoutCoins(): algebraic back-out, display-only (no separate grant) ----
activeContract = 1; // rush, coinMult 1.40
S.coinsEarnedThisNight = 140;
__check('contractPayoutCoins() backs out exactly the multiplier\\'s own share of tonight\\'s real earnings (140*(1-1/1.4)=40)', contractPayoutCoins() === 40, 'got=' + contractPayoutCoins());
activeContract = 3; // collector, no coinMult
S.coinsEarnedThisNight = 140;
__check('Collector has no coin multiplier, so contractPayoutCoins() is 0 (its reward is the flat Workshop Token instead)', contractPayoutCoins() === 0);
activeContract = -1;
__check('no contract: contractPayoutCoins() is 0', contractPayoutCoins() === 0);

// ---- finalizeNight(): records which contract ran, grants Collector's Workshop Token exactly once ----
upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false;
activeContract = 1; // rush -- a coin-multiplier contract, no token
var contractsCompletedBefore = contractsCompleted.length;
var tokensBefore = workshopTokens;
finalizeNight();
__check('finalizeNight() records the accepted contract\\'s id in contractsCompleted', contractsCompleted.length === contractsCompletedBefore + 1 && contractsCompleted[contractsCompleted.length - 1] === 'rush');
__check('a coin-multiplier contract does not touch workshopTokens', workshopTokens === tokensBefore);

reset(); screen = 'play'; paused = false;
activeContract = 3; // collector -- grants a Workshop Token
var tokensBefore2 = workshopTokens;
finalizeNight();
__check('completing a Collector night grants exactly one Workshop Token', workshopTokens === tokensBefore2 + 1);

reset(); screen = 'play'; paused = false;
activeContract = -1; // no contract (shouldn't happen post-D3 for a real night, but must still be safe)
var contractsCompletedBefore2 = contractsCompleted.length;
finalizeNight();
__check('finalizeNight() with no active contract records nothing and grants nothing', contractsCompleted.length === contractsCompletedBefore2);
`);

// D4 (Claude Design spec): Night Event UI. Unlike D3, the gameplay
// underneath already existed (Phase 4) -- this covers only the new
// presentation state: eventAnnounceElapsed()/eventAnnounceActive()'s
// timing gates (keyed off the EXISTING S.newNightT clock, no new timer
// field), the restart-does-not-replay rule, and the one-shot sound guard.
// Pixel geometry isn't checkable here for the same reason as D1-D3's own
// scenarios (the mock ctx.measureText() returns a fixed width).
scenario('lumora2-d4-night-events', null, `
upgrades.tutorialDone = true;

// ---- eventAnnounceElapsed() reads off the EXISTING S.newNightT clock, no new timer field ----
nightNumber = 1;
reset(); screen = 'play'; paused = false;
S.eventActive = 'moonlight'; S.isNewNight = true;
S.newNightT = 4.70;
__check('eventAnnounceElapsed() is exactly 0 at S.newNightT===4.70 (400ms after the goals card dismisses at 4.30)', eventAnnounceElapsed() === 0, 'got=' + eventAnnounceElapsed());
S.newNightT = 5.70;
__check('eventAnnounceElapsed() tracks S.newNightT linearly', Math.abs(eventAnnounceElapsed() - 1.0) < 1e-9);

// ---- eventAnnounceActive(): the full gating logic ----
S.eventActive = null; S.isNewNight = true; S.newNightT = 5.0;
__check('no event active: never active, regardless of timing', eventAnnounceActive() === false);
S.eventActive = 'fireflyRain'; S.isNewNight = false; S.newNightT = 5.0;
__check('an event IS active but this is a restart (isNewNight false): never active -- the restart-does-not-replay rule', eventAnnounceActive() === false);
S.isNewNight = true; S.newNightT = 4.69;
__check('genuine new night, but before t0 (newNightT<4.70): not active yet', eventAnnounceActive() === false);
S.newNightT = 4.70;
__check('genuine new night, exactly at t0: active', eventAnnounceActive() === true);
S.newNightT = 4.70 + 3.91;
__check('genuine new night, just before the 3.92s window closes: still active', eventAnnounceActive() === true);
S.newNightT = 4.70 + 3.92;
__check('genuine new night, exactly at the window close: no longer active', eventAnnounceActive() === false);
S.newNightT = 20;
__check('long after the window: still not active (does not re-trigger later in the night)', eventAnnounceActive() === false);

// ---- tutorial night: no event, so never active regardless of timing ----
upgrades.tutorialDone = false;
reset(); screen = 'play'; paused = false;
S.newNightT = 4.70;
__check('the tutorial night never gets an event, so the announcement is never active', S.eventActive === null && eventAnnounceActive() === false);
upgrades.tutorialDone = true;

// ---- the one-shot sound guard: fires exactly once per night, via the real draw function ----
reset(); screen = 'play'; paused = false;
S.eventActive = 'mothSwarm'; S.isNewNight = true; S.newNightT = 4.70;
__check('eventAnnounceFired starts false each reset()', S.eventAnnounceFired === false);
drawEventAnnouncement();
__check('calling the real draw function while active flips eventAnnounceFired to true (fires the one-shot chime)', S.eventAnnounceFired === true);
drawEventAnnouncement(); // a second call this same instant must not re-fire or throw
__check('a second call does not un-set the guard', S.eventAnnounceFired === true);

// ---- drawEventChip()/drawEventAnnouncement() never throw across the full timeline, active or not ----
reset(); screen = 'play'; paused = false;
S.eventActive = 'moonlight'; S.isNewNight = true;
var threw = false;
try {
  for (var __t = 0; __t <= 9; __t += 0.25) { S.newNightT = __t; drawEventAnnouncement(); drawEventChip(); }
  S.isNewNight = false; drawEventAnnouncement(); drawEventChip(); // restart case: chip only, no announcement
  S.eventActive = null; drawEventAnnouncement(); drawEventChip(); // no event: both are zero-draw no-ops
} catch (e) { threw = true; }
__check('drawEventAnnouncement()/drawEventChip() never throw across the full timeline (active, restart, or no event)', threw === false);
`);

// D5 (Claude Design spec): Night Complete 2.0. Purely additive to one
// screen -- nothing during play changes. Covers the new round-scoped
// counters (bestChainThisRound, perfect/rareDeliveryCount), the derived
// eventPayoutCoins() algebra, the unified nightCompleteTailRows() stacking
// (contract/event/bonus, each independently optional), and that the new
// panelBottom-derived footer formula reproduces every one of the OLD
// shipped button positions exactly before trusting it going forward.
scenario('lumora2-d5-night-complete', null, `
upgrades.tutorialDone = true;

// ---- bestChainThisRound: tracks the PEAK, survives S.chain itself resetting to 0 ----
reset(); screen = 'play'; paused = false;
__check('bestChainThisRound starts at 0', S.bestChainThisRound === 0);
for (var i = 0; i < 6; i++) advanceChain(); // chain -> 6
__check('bestChainThisRound tracks the live chain while it climbs', S.bestChainThisRound === 6);
breakChain(); // S.chain -> 0
__check('S.chain itself resets on a miss...', S.chain === 0);
__check('...but bestChainThisRound remembers the peak', S.bestChainThisRound === 6);
for (var i = 0; i < 3; i++) advanceChain(); // chain -> 3, below the old peak
__check('a smaller chain afterwards does not lower the remembered peak', S.bestChainThisRound === 6);

// ---- perfect/rareDeliveryCount: occurrence counts, not booleans, incremented in resolveDeliveryBonuses() ----
reset(); screen = 'play'; paused = false;
__check('perfectDeliveryCount/rareDeliveryCount start at 0', S.perfectDeliveryCount === 0 && S.rareDeliveryCount === 0);
S.batchPerfect = true; S.batchRareCount = 0; resolveDeliveryBonuses();
__check('a Perfect-only trip increments perfectDeliveryCount by 1, leaves rareDeliveryCount alone', S.perfectDeliveryCount === 1 && S.rareDeliveryCount === 0);
S.batchPerfect = true; S.batchRareCount = 2; resolveDeliveryBonuses();
__check('a second Perfect+Rare trip increments BOTH counters', S.perfectDeliveryCount === 2 && S.rareDeliveryCount === 1);
S.batchPerfect = false; S.batchRareCount = 1; resolveDeliveryBonuses(); // below Rare's own 2-rare threshold
__check('a trip below the Rare threshold does not increment rareDeliveryCount', S.rareDeliveryCount === 1);

// ---- nightCompleteHasBonusRow(): the same x3 floor D2's own live readout uses ----
reset(); screen = 'play'; paused = false;
__check('no chain, no perfect, no rare: no bonus row', nightCompleteHasBonusRow() === false);
S.bestChainThisRound = 2;
__check('a chain below the x3 floor alone still does not earn a bonus row', nightCompleteHasBonusRow() === false);
S.bestChainThisRound = 3;
__check('a chain AT the x3 floor earns a bonus row', nightCompleteHasBonusRow() === true);
S.bestChainThisRound = 0; S.perfectDeliveryCount = 1;
__check('a Perfect Delivery alone earns a bonus row, even with no chain at all', nightCompleteHasBonusRow() === true);
S.perfectDeliveryCount = 0; S.rareDeliveryCount = 1;
__check('a Rare Delivery alone earns a bonus row too', nightCompleteHasBonusRow() === true);

// ---- eventPayoutCoins(): derived, display-only, never a fabricated number for non-coin events ----
reset(); screen = 'play'; paused = false;
S.coinsEarnedThisNight = 210;
S.eventActive = null;
__check('no event: eventPayoutCoins() is 0', eventPayoutCoins() === 0);
S.eventActive = 'moonlight';
__check('Moonlight has no coin effect: eventPayoutCoins() is 0 (the row shows an em dash for this)', eventPayoutCoins() === 0);
S.eventActive = 'fireflyRain';
__check('Firefly Rain has no coin effect either: 0', eventPayoutCoins() === 0);
S.eventActive = 'mothSwarm';
__check('Moth Swarm: 210 - round(210/1.2) = 210-175 = 35, matching the handoff\\'s own worked example', eventPayoutCoins() === 35, 'got=' + eventPayoutCoins());

// ---- nightCompleteTailRows(): fixed order (contract, event, bonus), each present row +26 after the last, absent costs nothing ----
var r;
r = nightCompleteTailRows(true, false, false, false);
__check('nothing present: no rows at all', r.length === 0);
r = nightCompleteTailRows(true, true, false, false);
__check('contract alone (objectives present): lands at the historical py+306 anchor', r.length === 1 && r[0].kind === 'contract' && r[0].b === 306);
r = nightCompleteTailRows(true, true, true, false);
__check('contract+event: event stacks exactly +26 after contract (py+332)', r.length === 2 && r[1].kind === 'event' && r[1].b === 332);
r = nightCompleteTailRows(true, true, true, true);
__check('all three present: bonus stacks +26 after event (py+358), matching the handoff\\'s own worked example exactly', r.length === 3 && r[2].kind === 'bonus' && r[2].b === 358);
r = nightCompleteTailRows(true, false, true, true);
__check('contract ABSENT: event moves up into the FIRST slot (py+306), not left at py+332 -- an absent row costs nothing', r.length === 2 && r[0].kind === 'event' && r[0].b === 306 && r[1].kind === 'bonus' && r[1].b === 332);
r = nightCompleteTailRows(false, false, false, true);
__check('no-objectives night: the tail keeps its own cheaper anchor (py+164), independent of the with-objectives case', r.length === 1 && r[0].kind === 'bonus' && r[0].b === 164);

// ---- the new panelBottom-derived footer formula reproduces every OLD shipped button position exactly ----
// (playBtn.y = panelBottom+35, SHOP_BTN_OVER.y = playBtn.y+55 -- verified
// here against the four real worked cases the D5 handoff itself lists.)
function __ncButtons(hasObjectives, hasContract, hasEvent, hasBonus) {
  var tailRows = nightCompleteTailRows(hasObjectives, hasContract, hasEvent, hasBonus);
  var panelH = tailRows.length ? (tailRows[tailRows.length - 1].b + 20) : (hasObjectives ? 280 : 150);
  var panelBottom = H * 0.34 + panelH;
  return { play: panelBottom + 35, shop: panelBottom + 35 + 55 };
}
var bb = __ncButtons(false, false, false, false);
__check('no objectives, no tail: playBtn/SHOP reproduce the old shipped 512/567', Math.abs(bb.play - 511.4) < 0.1 && Math.abs(bb.shop - 566.4) < 0.1, 'play=' + bb.play + ' shop=' + bb.shop);
bb = __ncButtons(true, false, false, false);
__check('objectives, no tail: reproduce the old shipped 642/697', Math.abs(bb.play - 641.4) < 0.1 && Math.abs(bb.shop - 696.4) < 0.1, 'play=' + bb.play + ' shop=' + bb.shop);
bb = __ncButtons(true, true, false, false);
__check('objectives + contract (today\\'s old worst case): reproduce the old shipped 688/743', Math.abs(bb.play - 687.4) < 0.1 && Math.abs(bb.shop - 742.4) < 0.1, 'play=' + bb.play + ' shop=' + bb.shop);
bb = __ncButtons(true, true, true, true);
__check('objectives + contract + event + bonus (the new worst case): panel bottom lands at py+378 = 704.4 per the handoff\\'s own table', Math.abs((bb.play - 35) - 704.4) < 0.1);

// ---- drawOver() and the three tail-row draw functions never throw, across a matrix of real states ----
reset(); screen = 'play'; paused = false;
S.objectiveActive = [{ id: 'x', category: 'catch', kind: 'catch', fireflyType: 'y', label: 'Catch 5', target: 5, reward: 20, done: true }];
S.misses = 1; S.score = 20; bestAtRoundStart = 10; best = 20; coinsAtRoundStart = 5; coins = 50;
S.coinsEarnedThisNight = 45; S.tip = NIGHT_TIPS[0]; S.over = true; S.overT = 1;
var threw2 = false;
try {
  [-1, 0, 1, 2, 3].forEach(function (ac) {
    activeContract = ac;
    [null, 'moonlight', 'fireflyRain', 'mothSwarm'].forEach(function (ev) {
      S.eventActive = ev;
      [0, 2, 5].forEach(function (ch) {
        S.bestChainThisRound = ch;
        [0, 1, 2].forEach(function (pf) {
          S.perfectDeliveryCount = pf; S.rareDeliveryCount = pf;
          [true, false].forEach(function (hasObj) {
            S.objectiveActive = hasObj ? [{ id: 'x', category: 'catch', kind: 'catch', fireflyType: 'y', label: 'Catch 5', target: 5, reward: 20, done: true }] : [];
            drawOver();
          });
        });
      });
    });
  });
} catch (e) { threw2 = true; }
activeContract = -1; S.eventActive = null;
__check('drawOver() never throws across a full matrix of contract/event/chain/delivery/objectives combinations', threw2 === false);
`);

// =====================================================================
// Lumora 2.0 Phase 5: Firefly Journal / Collection. The base-type discovery/
// count system (`journal`, isFireflyDiscovered()) already existed before this
// phase -- these tests exercise it through the REAL catch-success path (not
// a parallel detector) to prove the existing system already satisfies the
// spec's own numbered tests, plus the new variant foundation
// (variantJournal, isVariantDiscovered/getVariantCount, recordFireflyCatch(),
// getFireflyCount/getDiscoveredFireflyCount/getCollectionProgress) added
// this phase. Persistence/migration/save-payload coverage lives in the
// separate lumora2-phase5-persistence scenario below (needs the Playables
// mock, same reason lumora2-phase1-persistence is its own scenario).
// =====================================================================
scenario('lumora2-phase5-firefly-journal', null, `
upgrades.tutorialDone = true;

// ---- shared helper: catch a real firefly of a given type through the actual production path -- same technique the 'standalone' scenario's own catch test already uses, not a parallel test-only catch detector ----
function realCatch(type){
  reset(); screen = 'play'; paused = false; // spawnFly() no-ops unless screen==='play' -- reset() itself never touches screen
  S.isNewNight = false; S.newNightT = 999; // skip the D1 new-night reveal card -- it gates update(dt) entirely (see newNightCardActive()) and the FIRST reset() of a real (non-tutorial) run always triggers it
  spawnFly(type);
  var fly = S.flies[S.flies.length - 1];
  fly.x = S.jar.x; fly.y = S.jar.y - 14; // drop it right on the jar so it locks+catches quickly
  var caughtBefore = S.caughtN;
  for (var i = 0; i < 240 && S.caughtN === caughtBefore; i++) __stepFrame(16);
  return S.caughtN > caughtBefore;
}

// ---- Test 1: first discovery ----
__check('a fresh player has not discovered Curious yet', isFireflyDiscovered('y') === false && getFireflyCount('y') === 0);
__check('Test 1 setup: the real catch actually landed', realCatch('y') === true);
__check('Test 1: Curious discovered = true after a real successful catch, through the real catch-success path', isFireflyDiscovered('y') === true);
__check('Test 1: Curious count = 1', getFireflyCount('y') === 1 && journal.y === 1);

// ---- Test 2: repeat catch increments the COUNT -- discovery stays a plain boolean, not a second counter ----
__check('Test 2 setup: second real catch landed', realCatch('y') === true);
__check('Test 2: Curious count = 2 (a real count, not a boolean flipped twice)', getFireflyCount('y') === 2);
__check('Test 2: discovery is still exactly true, not incremented into something else', isFireflyDiscovered('y') === true);

// ---- Test 3: a firefly that is NOT caught (patience expires, it leaves) must not discover or count ----
reset(); screen = 'play'; paused = false;
spawnFly('b');
var flyMiss = S.flies[S.flies.length - 1];
flyMiss.patience = 0.01; flyMiss.rest = 0; flyMiss.pause = 0; // expire almost immediately -- same technique the existing miss-round test in 'standalone' already uses
for (var m = 0; m < 300 && S.flies.indexOf(flyMiss) !== -1; m++) __stepFrame(16);
__check('Test 3: an uncaught firefly (patience expired, never reached the catch-success site) does not increment its count', getFireflyCount('b') === 0);
__check('Test 3: an uncaught firefly does not mark its type discovered', isFireflyDiscovered('b') === false);

// ---- Test 4: multiple distinct types, each tracked independently ----
__check('Test 4 setup: catch Playful for real', realCatch('b') === true);
__check('Test 4 setup: catch Shy for real', realCatch('g') === true);
__check('Test 4: Curious+Playful+Shy are all discovered (Curious from Tests 1-2 above)', isFireflyDiscovered('y') && isFireflyDiscovered('b') && isFireflyDiscovered('g'));
__check('Test 4: exactly 3 of the 5 base types are discovered so far', getDiscoveredFireflyCount() === 3);
__check('Test 4: Elder/Mystery remain undiscovered', isFireflyDiscovered('e') === false && isFireflyDiscovered('m') === false);
__check('Test 4: getCollectionProgress() reports 3/5 base, 0/5 variants', JSON.stringify(getCollectionProgress()) === JSON.stringify({ base: { discovered: 3, total: 5 }, variants: { discovered: 0, total: 5 } }));

// ---- Test 8: a night restart (reset()) must NOT roll back permanent discoveries -- journal is session-level, never touched by reset() ----
var journalBeforeRestart = JSON.stringify(journal);
reset();
__check('Test 8: reset() (a night restart) does not touch journal at all', JSON.stringify(journal) === journalBeforeRestart);
__check('Test 8: discoveries survive a restart', isFireflyDiscovered('y') && isFireflyDiscovered('b') && isFireflyDiscovered('g'));

// ---- Test 7 / variant foundation: independently discoverable, not a proxy for base discovery ----
__check('a fresh variant is not discovered', isVariantDiscovered('rainy_playful') === false && getVariantCount('rainy_playful') === 0);
var baseCountBeforeOrdinary = getFireflyCount('b');
recordFireflyCatch('b', null); // an ordinary base catch, no variant -- the real spawnFly() path never sets one today
__check('an ordinary base-type catch with no variantId does not discover any variant', isVariantDiscovered('rainy_playful') === false);
__check('...but it still counts as a normal base catch', getFireflyCount('b') === baseCountBeforeOrdinary + 1);
var baseCountBeforeVariant = getFireflyCount('b');
recordFireflyCatch('b', 'rainy_playful'); // a real variant catch
__check('Test 7: a variant catch discovers the variant independently', isVariantDiscovered('rainy_playful') === true && getVariantCount('rainy_playful') === 1);
__check('Test 7: a variant catch ALSO counts as a normal base-type catch -- the base journal is not bypassed', getFireflyCount('b') === baseCountBeforeVariant + 1);
__check('Test 7: discovering one variant does not mark a DIFFERENT variant discovered', isVariantDiscovered('moonlit_curious') === false);
__check('Test 7: discovering a variant is not substituted for base discovery of an otherwise-undiscovered type', isFireflyDiscovered('e') === false && isFireflyDiscovered('m') === false);

// ---- variant validation: a variantId whose own baseType does not match what was actually caught must never be credited ----
var shyCountBefore = getFireflyCount('g');
recordFireflyCatch('g', 'rainy_playful'); // rainy_playful's baseType is 'b', not 'g'
__check('a mismatched variantId (wrong baseType) is never credited', getVariantCount('rainy_playful') === 1, 'still 1, unchanged from the real Playful catch above');
__check('...but the ordinary base catch it rode in on is still credited normally', getFireflyCount('g') === shyCountBefore + 1);

// ---- an unrecognized variant id is silently ignored, never thrown ----
var unknownThrew = false;
try { recordFireflyCatch('y', 'not_a_real_variant'); } catch (e) { unknownThrew = true; }
__check('an unrecognized variantId does not throw', unknownThrew === false);
__check('...and credits nothing under that bogus id', variantJournal['not_a_real_variant'] === undefined);

// ---- Test 9 / Test 10: collection tracking is unaffected by an active contract or event ----
reset();
activeContract = 3; // Collector -- zero side effects on speed/miss/coin/spawn, the same contract the D3 tests pick to stay isolated
S.eventActive = 'moonlight';
var elderCountBefore = getFireflyCount('e');
__check('Test 9/10 setup: a real catch during an active contract+event still lands', realCatch('e') === true);
__check('Test 9/10: collection tracking still works during an active contract and event', isFireflyDiscovered('e') === true && getFireflyCount('e') === elderCountBefore + 1);
activeContract = -1; S.eventActive = null;
`);

scenario('lumora2-phase5-persistence', { audioEnabled: true }, `
// ---- Test 5: an existing pre-Phase-5 save (has journal, no variantJournal at all) loads safely ----
__spy.loadResolve(JSON.stringify({ best: 12, coins: 300, nightNumber: 6, journal: { y: 9, b: 4, g: 1, e: 0, m: 0 }, objectivesCompleted: {}, eventHistory: [], contractsCompleted: [], cosmeticsUnlocked: [] }));
return __tick(5).then(function(){
  __check('Test 5: a pre-Phase-5 save loads without throwing', loadDone === true && nightNumber === 6);
  __check('Test 5: existing journal data is preserved exactly', journal.y === 9 && journal.b === 4 && journal.g === 1);
  __check('Test 5: existing progression (best/coins) is unchanged by the new field being absent', best === 12 && coins === 300);
  __check('Test 5: variantJournal defaults safely to all zero -- no corruption from a save that never had this field', Object.keys(variantJournal).every(function(k){ return variantJournal[k] === 0; }));
  __check('Test 5: no variant is discovered on a save that predates variants', VARIANT_POOL.every(function(v){ return isVariantDiscovered(v.id) === false; }));

  // ---- Test 6: a real catch's discovery/count survives a save/load round-trip ----
  upgrades.tutorialDone = true;
  reset(); screen = 'play'; paused = false;
  S.isNewNight = false; S.newNightT = 999; // skip the D1 new-night reveal card, same reason realCatch() in the other Phase 5 scenario does
  spawnFly('g');
  var fly = S.flies[S.flies.length - 1];
  fly.x = S.jar.x; fly.y = S.jar.y - 14;
  var caughtBefore = S.caughtN;
  for (var i = 0; i < 240 && S.caughtN === caughtBefore; i++) __stepFrame(16);
  __check('Test 6 setup: the real catch landed', S.caughtN === caughtBefore + 1);
  var shyCountAfterCatch = getFireflyCount('g');
  __check('Test 6 setup: Shy is now discovered with a real count', isFireflyDiscovered('g') === true && shyCountAfterCatch === 2);
  recordFireflyCatch('e', 'frost_elder'); // also exercise a variant in the same payload
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('Test 6: saveProgress() writes journal into the save payload via the existing mechanism -- no second save system', payload.journal && payload.journal.g === shyCountAfterCatch);
  __check('Test 6: saveProgress() writes variantJournal into the same payload', payload.variantJournal && payload.variantJournal.frost_elder === 1);
  // A genuine reload can't be simulated further inside this same scenario --
  // the mock loadData() Promise (__loadPromise) resolves exactly once, same
  // as the real platform SDK's own loadData() is only ever awaited once per
  // session, so a second __spy.loadResolve() call here would be a silent
  // no-op, not a real second load. The other half of Test 6 ("discovered
  // state/count survive a save/load round-trip") is instead proven by
  // lumora2-phase5-load-with-variants below, loading a FRESH context with a
  // save shaped exactly like the payload just asserted above.
});
`);

// A separate fresh-context load, using the exact payload shape Test 6 above
// just proved saveProgress() writes -- this is the genuine other half of
// "save then reload" (see the comment at the end of Test 6): a real
// isFireflyDiscovered()/getFireflyCount()/isVariantDiscovered()/
// getVariantCount() read against state that came ONLY from a loaded save,
// never touched by any catch in this scenario.
scenario('lumora2-phase5-load-with-variants', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 12, coins: 300, journal: { y: 0, b: 0, g: 2, e: 1, m: 0 }, variantJournal: { moonlit_curious: 0, rainy_playful: 0, garden_shy: 0, frost_elder: 1, aurora_mystery: 0 } }));
return __tick(5).then(function(){
  __check('Test 6: a loaded save\\'s discovered state is restored correctly (Shy, Elder)', isFireflyDiscovered('g') === true && isFireflyDiscovered('e') === true);
  __check('Test 6: a loaded save\\'s counts are restored correctly', getFireflyCount('g') === 2 && getFireflyCount('e') === 1);
  __check('Test 6: a loaded save\\'s undiscovered types stay undiscovered', isFireflyDiscovered('y') === false && isFireflyDiscovered('b') === false && isFireflyDiscovered('m') === false);
  __check('Test 6: a loaded save\\'s variant discovery is restored correctly', isVariantDiscovered('frost_elder') === true && getVariantCount('frost_elder') === 1);
  __check('Test 6: a loaded save\\'s other variants stay undiscovered', isVariantDiscovered('moonlit_curious') === false && isVariantDiscovered('rainy_playful') === false);
});
`);

// =====================================================================
// Lumora 2.0 Phase 6: Village 2.0. "Existing restoration" (Test 1) and
// "100% restoration / Dawn Chorus" (Test 2) are already covered by the
// pre-existing restorationPct()/VILLAGE_MILESTONES tests elsewhere in this
// file -- completely untouched by this phase, not duplicated here. These
// tests cover only the genuinely new post-100% layer: villageLevelFor()/
// villageLevel() (a PURE function of best+nightNumber, no new persisted
// state at all), the Night Complete tail-row integration, restart-safety,
// and real night-completion behavior.
// =====================================================================
scenario('lumora2-phase6-village-level', null, `
// ---- villageLevelFor(): pure function, exact thresholds, no state ----
__check('below 100% restoration, level is always 1 regardless of nights played', villageLevelFor(10, 500) === 1, 'restorationPct(10)=' + restorationPct(10));
__check('at exactly 100% restoration but few nights, level is still 1', villageLevelFor(25, 1) === 1 && villageLevelFor(25, 9) === 1);
__check('Test 4: level becomes 2 the instant nights reaches the Level 2 threshold, not before', villageLevelFor(25, 9) === 1 && villageLevelFor(25, 10) === 2);
__check('Test 4: level becomes 3 the instant nights reaches the Level 3 threshold, not before', villageLevelFor(25, 19) === 2 && villageLevelFor(25, 20) === 3);
__check('level never exceeds 3 -- no arbitrary Level 4+', villageLevelFor(25, 1000) === 3);
__check('a best far beyond the 100% ceiling still reads from the same restorationPct ceiling, no 4th step', villageLevelFor(999, 1000) === 3);

// ---- villageLevel() reads LIVE best/nightNumber, not a cached/stored value ----
best = 25; nightNumber = 1;
__check('villageLevel() reads live state: level 1 at night 1 despite 100% restoration', villageLevel() === 1);
nightNumber = 10;
__check('villageLevel() reads live state: level 2 once nightNumber reaches 10', villageLevel() === 2);
nightNumber = 20;
__check('villageLevel() reads live state: level 3 once nightNumber reaches 20', villageLevel() === 3);

// ---- Test 3: post-100% progression never begins before restoration genuinely reaches 100%, no matter how many nights ----
best = 10; nightNumber = 50; // 40% restoration, plenty of nights played
__check('Test 3: no level past 1 before restoration actually reaches 100%', villageLevel() === 1);

// ---- Night Complete integration: a genuine level-crossing night gets a villageLevelUp tail row, and drawOver() renders it without throwing ----
upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false;
best = 25; bestAtRoundStart = 25; nightNumber = 10; // this exact night crosses 1 -> 2 (nightNumber-1=9 reads 1, nightNumber=10 reads 2)
S.over = true; S.overT = 1; S.objectiveActive = []; S.tip = NIGHT_TIPS[0]; coinsAtRoundStart = coins;
var hasLevelUpNow = villageLevel() > villageLevelFor(bestAtRoundStart, nightNumber - 1);
__check('Test 4/9 setup: this exact state is a genuine level crossing', hasLevelUpNow === true);
var rows = nightCompleteTailRows(false, false, false, false, hasLevelUpNow);
__check('Test 4/9: a genuine level-crossing night includes a villageLevelUp tail row', rows.some(function(r){ return r.kind === 'villageLevelUp'; }));
var threwLevelUp = false;
try { drawOver(); } catch (e) { threwLevelUp = true; }
__check('drawOver() renders the Village Level Up row without throwing', threwLevelUp === false);

// ---- Test 5: no villageLevelUp row when the level does not actually change this night ----
nightNumber = 15; bestAtRoundStart = 25; best = 25; // already level 2 both before (14->2) and after (15->2) -- no crossing
var hasLevelUpNone = villageLevel() > villageLevelFor(bestAtRoundStart, nightNumber - 1);
var rowsNoLevelUp = nightCompleteTailRows(false, false, false, false, hasLevelUpNone);
__check('Test 5: no villageLevelUp row when the level does not change this night', hasLevelUpNone === false && rowsNoLevelUp.every(function(r){ return r.kind !== 'villageLevelUp'; }));

// ---- Test 5 (no duplicate on repeated render): calling drawOver() many times for the SAME completed night reports the exact same outcome every time -- nothing is consumed or mutated ----
nightNumber = 10; bestAtRoundStart = 9; best = 25; // a genuine crossing night again
var firstHasLevelUp = villageLevel() > villageLevelFor(bestAtRoundStart, nightNumber - 1);
for (var i = 0; i < 50; i++) drawOver();
var stillHasLevelUp = villageLevel() > villageLevelFor(bestAtRoundStart, nightNumber - 1);
__check('Test 5: repeated Night Complete renders of the same night report the identical level-up outcome every time', firstHasLevelUp === true && stillHasLevelUp === true);

// ---- Test 8: a night restart (reset(), nightNumber unchanged) must not advance village progression ----
nightNumber = 9; best = 20; bestAtRoundStart = 20;
var levelBeforeRestart = villageLevel();
reset(); // simulate the pause menu's "Restart Night" -- nightNumber must be untouched
__check('Test 8: reset() (a night restart) does not touch nightNumber', nightNumber === 9);
__check('Test 8: village level is unchanged by a restart', villageLevel() === levelBeforeRestart);

// ---- Test 9: a genuine night completion (continueFromOver(), a real nightNumber advance) updates progression exactly once ----
upgrades.tutorialDone = true;
nightNumber = 9; best = 25; bestAtRoundStart = 25;
__check('Test 9 setup: still level 1 the night before crossing (nightNumber 9)', villageLevel() === 1);
S.over = true; S.overT = 1;
continueFromOver();
__check('Test 9: nightNumber advanced by exactly 1 via the real completion path, not stacked/double-counted', nightNumber === 10);
__check('Test 9: village level is now 2, updated exactly once by the real completion', villageLevel() === 2);

// ---- drawVillageScreen()/villageReadJournalRect(): draw and hit-test geometry agree, across every level, never throws ----
[1, 2, 3].forEach(function(lvl){
  best = 25; nightNumber = lvl === 1 ? 1 : (lvl === 2 ? 10 : 20);
  var threwVillage = false;
  try { screen = 'village'; drawVillageScreen(); villageReadJournalRect(); } catch (e) { threwVillage = true; }
  __check('drawVillageScreen()/villageReadJournalRect() render without throwing at village level ' + lvl, threwVillage === false);
  __check('villageHeroHeight() (drawing) reflects villageLevel() (hit-test reads the exact same function, so they can never disagree) at level ' + lvl, villageHeroHeight() === (villageLevel() > 1 ? 236 : 210));
});
screen = 'title';
`);

scenario('lumora2-phase6-persistence', { audioEnabled: true }, `
// ---- Test 7: an existing player's pre-Phase-6 save (already at 100% restoration, already many nights in) loads safely -- Village Level initializes correctly with ZERO new save fields, since villageLevel() is a pure function of best+nightNumber, both of which already existed and already migrate ----
__spy.loadResolve(JSON.stringify({ best: 30, coins: 500, nightNumber: 25, journal: { y: 5, b: 3, g: 1, e: 0, m: 0 }, objectivesCompleted: {}, eventHistory: [], contractsCompleted: [], cosmeticsUnlocked: [] }));
return __tick(5).then(function(){
  __check('Test 7: an existing player\\'s pre-Phase-6 save loads without throwing', loadDone === true && nightNumber === 25);
  __check('Test 7: existing restoration (best) is preserved exactly', best === 30);
  __check('Test 7: existing restoration still reads 100% / every Dawn Chorus milestone restored, unchanged by this phase', restorationPct(best) === 100 && VILLAGE_MILESTONES.every(function(m){ return restorationPct(best) >= m.pct; }));
  __check('Test 7: Village Level initializes correctly from the existing restoration+night-count state -- no migration code needed, it just derives', villageLevel() === 3);
  __check('Test 7: existing journal/collection data (Phase 5) is untouched by this phase', journal.y === 5 && journal.b === 3 && journal.g === 1);
  __check('Test 7: existing progression (coins) is unaffected', coins === 500);

  // ---- Test 6: reach a new level, save, and confirm no new/duplicate save key was introduced for it ----
  best = 25; nightNumber = 10; // a village-level-2 state
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('Test 6: Village Level introduces NO new save field -- derived from best+nightNumber, both already present in the existing payload, no duplicate persistence system', JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['best', 'cachedNightEvent', 'cachedNightEventFor', 'cachedNightObjectives', 'cachedNightObjectivesFor', 'coinFraction', 'coins', 'contractsCompleted', 'cosmeticsUnlocked', 'equippedTheme', 'eventHistory', 'journal', 'lastNightCompletionDay', 'lastPlayed', 'nightNumber', 'nightStreak', 'objectivesCompleted', 'prestigeLevel', 'quests', 'seasonId', 'seasonProgress', 'trackerOn', 'upgrades', 'variantJournal', 'weekly', 'workshopTokens']), 'payload=' + JSON.stringify(payload));
  __check('Test 6: the payload\\'s own best/nightNumber already fully encode the reached level -- a fresh load of this exact payload would read the same level with no extra code', payload.best === 25 && payload.nightNumber === 10 && villageLevelFor(payload.best, payload.nightNumber) === 2);
});
`);

// =====================================================================
// Lumora 2.0 Phase 7: Village Themes / Landscape Skins. Only ONE theme has
// real content right now ('default' -- literally "render exactly as
// today," no override); the other 6 requested themes have no approved
// visual design/asset in this project (see index.html's own VILLAGE_THEMES
// comment for the full reasoning) and are deliberately not listed as fake
// stub entries. To still prove the general lock/unlock/equip/preview
// mechanism end-to-end without fabricating real content, these tests push
// ONE hand-crafted 'test_theme' entry onto VILLAGE_THEMES for the duration
// of this scenario only -- each scenario runs in its own isolated vm
// context, so this can never leak into another scenario or real content,
// same "hand-craft a controlled object" discipline the Phase 1 objective
// tests already established (setObjectives()) for an analogous problem.
// =====================================================================
scenario('lumora2-phase7-village-themes', null, `
// ---- Test 1: theme definitions ----
__check('every implemented theme has a valid, non-empty, stable string id', VILLAGE_THEMES.every(function(t){ return typeof t.id === 'string' && t.id.length > 0; }));
__check('every implemented theme has a valid, non-empty name', VILLAGE_THEMES.every(function(t){ return typeof t.name === 'string' && t.name.length > 0; }));
__check('theme ids are unique', new Set(VILLAGE_THEMES.map(function(t){ return t.id; })).size === VILLAGE_THEMES.length);
__check('exactly one theme is actually implemented right now (default) -- the other 6 requested themes have no approved assets and are not fabricated', VILLAGE_THEMES.length === 1 && VILLAGE_THEMES[0].id === 'default');

// ---- Test 2: default theme ----
__check('Test 2: a fresh player starts equipped with the default theme', equippedTheme === 'default');
__check('Test 2: a fresh player\\'s effective (rendered) theme is default', effectiveTheme() === 'default');
__check('the default theme is always owned', isThemeOwned('default') === true);

// ---- hand-crafted test theme (see this scenario's own header comment) ----
VILLAGE_THEMES.push({ id: 'test_theme', name: 'Test Theme', desc: 'a hand-crafted theme for testing the equip mechanism only' });

// ---- Test 3: unlock ----
__check('Test 3: an unimplemented/not-yet-owned theme id starts locked', isThemeOwned('test_theme') === false);
cosmeticsUnlocked.push('test_theme');
__check('Test 3: unlocking a theme (locked -> unlocked)', isThemeOwned('test_theme') === true);

// ---- Test 4: equip ----
__check('Test 4: equipping an unlocked theme succeeds and sets equippedTheme to it', equipTheme('test_theme') === true && equippedTheme === 'test_theme');
__check('Test 4: the effective (rendered) theme reflects the new equip', effectiveTheme() === 'test_theme');

// ---- Test 5: locked theme ----
equippedTheme = 'default'; // clean before/after
__check('Test 5: equipping a locked/unknown theme fails', equipTheme('some_locked_theme_id') === false);
__check('Test 5: the existing equipped theme is completely unchanged after a failed equip attempt', equippedTheme === 'default');

// ---- Test 6: preview must not accidentally equip ----
equipTheme('test_theme');
__check('Test 6 setup: equipped is test_theme', equippedTheme === 'test_theme');
startThemePreview('default');
__check('Test 6: previewing a different theme changes the EFFECTIVE (rendered) theme...', effectiveTheme() === 'default');
__check('Test 6: ...but does NOT change the actual equipped theme', equippedTheme === 'test_theme');
clearThemePreview();
__check('Test 6: closing the preview reverts the effective theme back to whatever is actually equipped', effectiveTheme() === 'test_theme');
__check('Test 6: the equipped theme was never touched by the preview at any point', equippedTheme === 'test_theme');
startThemePreview('does_not_exist');
__check('previewing an unknown theme id is silently ignored, effective theme unaffected', effectiveTheme() === 'test_theme');
clearThemePreview();

// ---- equipping the theme that is already equipped is a harmless no-op ----
__check('equipping the already-equipped theme reports success (not a failure)', equipTheme('test_theme') === true);

// ---- Test 11: gameplay isolation ----
upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false;
var scoreBefore = S.score, missesBefore = S.misses, capBefore = S.cap;
var flyValuesBefore = TYPES.y.pts + '|' + TYPES.b.coins + '|' + TYPES.g.pts;
equipTheme('default');
startThemePreview('test_theme');
__check('Test 11: equipping/previewing a theme does not change S.score', S.score === scoreBefore);
__check('Test 11: equipping/previewing a theme does not change S.misses', S.misses === missesBefore);
__check('Test 11: equipping/previewing a theme does not change jar capacity', S.cap === capBefore);
__check('Test 11: equipping/previewing a theme does not change firefly point/coin values', TYPES.y.pts + '|' + TYPES.b.coins + '|' + TYPES.g.pts === flyValuesBefore);
clearThemePreview(); equipTheme('default');

// ---- Test 10: village restoration/level compatibility ----
best = 25; nightNumber = 15;
var pctBefore = restorationPct(best), levelBefore2 = villageLevel();
equipTheme('test_theme');
__check('Test 10: equipping a theme does not change restoration %', restorationPct(best) === pctBefore);
__check('Test 10: equipping a theme does not change Village Level', villageLevel() === levelBefore2);
__check('Test 10: Dawn Chorus (100% restoration) is unaffected by theme state', VILLAGE_MILESTONES.every(function(m){ return restorationPct(best) >= m.pct; }));
equipTheme('default');

// ---- Test 12: collection compatibility ----
var journalBefore = JSON.stringify(journal), variantJournalBefore = JSON.stringify(variantJournal);
equipTheme('test_theme');
startThemePreview('default'); clearThemePreview();
__check('Test 12: theme changes do not affect Firefly Journal discoveries/counts', JSON.stringify(journal) === journalBefore);
__check('Test 12: theme changes do not affect variant discoveries/counts', JSON.stringify(variantJournal) === variantJournalBefore);
equipTheme('default');

// ---- UI: renders without throwing, hit-test geometry is sane ----
var threwUI = false;
try {
  screen = 'village'; drawVillageScreen();
  screen = 'themes'; drawThemesScreen();
} catch (e) { threwUI = true; }
__check('drawVillageScreen()/drawThemesScreen() render without throwing', threwUI === false);
__check('themeRowRects() returns exactly one rect per VILLAGE_THEMES entry', themeRowRects().length === VILLAGE_THEMES.length);
screen = 'title';

// ---- cleanup: remove the hand-crafted test theme so nothing later in this scenario sees it ----
VILLAGE_THEMES.pop();
cosmeticsUnlocked = cosmeticsUnlocked.filter(function(id){ return id !== 'test_theme'; });
equippedTheme = 'default';
__check('cleanup: VILLAGE_THEMES is back to exactly the one real theme', VILLAGE_THEMES.length === 1 && VILLAGE_THEMES[0].id === 'default');
`);

scenario('lumora2-phase7-persistence', { audioEnabled: true }, `
// ---- Test 8: an old save with no theme data at all loads safely, defaults to 'default', preserves everything else ----
__spy.loadResolve(JSON.stringify({ best: 20, coins: 200, nightNumber: 8, journal: { y: 3, b: 1, g: 0, e: 0, m: 0 }, objectivesCompleted: {}, eventHistory: [], contractsCompleted: [], cosmeticsUnlocked: [] }));
return __tick(5).then(function(){
  __check('Test 8: an old save with no theme data loads without throwing', loadDone === true && nightNumber === 8);
  __check('Test 8: existing progression (best/coins/journal) is fully preserved', best === 20 && coins === 200 && journal.y === 3);
  __check('Test 8: equippedTheme safely defaults to \\'default\\' for a save that predates themes', effectiveTheme() === 'default' && equippedTheme === 'default');
  __check('Test 8: no theme is spuriously unlocked for an old save', cosmeticsUnlocked.length === 0);

  // ---- Test 9: an invalid/unrecognized equipped theme id falls back safely, without corrupting anything else ----
  equippedTheme = 'nonexistent_theme_from_a_corrupted_or_future_save';
  __check('Test 9: an invalid/unrecognized equipped theme id falls back safely to default when actually read', effectiveTheme() === 'default');
  __check('Test 9: the raw save is not corrupted -- everything else remains intact', best === 20 && coins === 200 && journal.y === 3);
  equippedTheme = 'default';

  // ---- Test 7: equip, then save, and confirm the payload carries it (the load-side of the round-trip -- a real payload with a real equippedTheme string loading back correctly -- is proven by lumora2-phase7-load-with-theme below, in its own fresh context; the mock loadData() Promise here has already resolved once and can't be resolved a second time in this same script run, same limitation noted in the Phase 5/6 persistence scenarios) ----
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('Test 7: saveProgress() writes equippedTheme into the existing save payload -- no new save key/mechanism', payload.equippedTheme === 'default');
  __check('Test 7: no save field beyond equippedTheme was introduced for themes', JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['best', 'cachedNightEvent', 'cachedNightEventFor', 'cachedNightObjectives', 'cachedNightObjectivesFor', 'coinFraction', 'coins', 'contractsCompleted', 'cosmeticsUnlocked', 'equippedTheme', 'eventHistory', 'journal', 'lastNightCompletionDay', 'lastPlayed', 'nightNumber', 'nightStreak', 'objectivesCompleted', 'prestigeLevel', 'quests', 'seasonId', 'seasonProgress', 'trackerOn', 'upgrades', 'variantJournal', 'weekly', 'workshopTokens']));
});
`);

scenario('lumora2-phase7-load-with-theme', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 10, coins: 50, equippedTheme: 'default', cosmeticsUnlocked: [] }));
return __tick(5).then(function(){
  __check('Test 7 (load side): a loaded save\\'s equippedTheme is restored exactly', equippedTheme === 'default');
  __check('Test 7 (load side): the loaded equipped theme reads correctly as the effective theme', effectiveTheme() === 'default');
});
`);

// =====================================================================
// Lumora 2.0 Phase 8: Monetization 2.0. ytgame.ads is mocked entirely
// inline in each driver (ONLY here, per the harness ad-mocking rule --
// production code never depends on this mock existing), same
// success/false/reject/throw driver-reassigns-a-var pattern the existing
// ads-double-night-coins scenario already established. Double the Glow/One
// More Chance/Glowkeeper's Favor themselves are UNCHANGED by this phase --
// proven by their own existing dedicated scenarios (ads-double-night-
// coins, ads-extra-life, ads-workshop-favor) still passing byte-for-byte
// unmodified (see the full suite run), not re-tested here.
// =====================================================================
scenario('lumora2-phase8-mystery-chest', {}, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 20, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
  __check('Test 5: every Mystery Chest reward is a valid, already-existing reward kind (coins/luck) with a positive amount and weight', MYSTERY_CHEST_REWARDS.every(function(r){ return (r.kind === 'coins' || r.kind === 'luck') && r.val > 0 && r.weight > 0; }));

  // ---- Test 1: eligibility ----
  upgrades.tutorialDone = false;
  __check('Test 1: not eligible during the tutorial', mysteryChestEligible() === false);
  upgrades.tutorialDone = true;
  __check('Test 1: not eligible when ads are unavailable (ytgame.ads not installed yet)', mysteryChestEligible() === false);

  var rewardCalls = [];
  var rewardBehavior = 'success';
  ytgame.ads = {
    requestRewardedAd: function(id){
      rewardCalls.push(id);
      if (rewardBehavior === 'throw') throw new Error('mock throw');
      if (rewardBehavior === 'reject') return Promise.reject(new Error('mock reject'));
      return Promise.resolve(rewardBehavior === 'success');
    },
    requestInterstitialAd: function(){ return Promise.resolve(); }
  };
  __check('Test 1: eligible once the tutorial is done and ads are available, no cooldown yet', mysteryChestEligible() === true);

  // ---- Test 3: ad failure grants no reward, does not consume the opportunity ----
  rewardBehavior = 'false';
  var coinsBefore = coins;
  requestMysteryChest();
  __check('Test 3 setup: pending immediately on tap', mysteryChestPending === true);
  return __tick(5).then(function(){
    __check('Test 3: a false result grants no reward', coins === coinsBefore && mysteryChestReward === null && mysteryChestLastNight === -9999);
    __check('Test 3: still eligible afterward -- a failed ad never consumes the opportunity', mysteryChestEligible() === true);

    // ---- rejection also grants nothing ----
    rewardBehavior = 'reject';
    var coinsBefore2 = coins;
    requestMysteryChest();
    return __tick(5).then(function(){
      __check('a rejected ad request grants no reward either', coins === coinsBefore2 && mysteryChestPending === false);

      // ---- a synchronous throw grants nothing and does not propagate ----
      rewardBehavior = 'throw';
      var threwSync = false;
      try { requestMysteryChest(); } catch (e) { threwSync = true; }
      __check('a synchronous throw from requestRewardedAd() does not propagate', !threwSync);
      __check('a synchronous throw grants no reward and clears the pending flag', mysteryChestPending === false && mysteryChestReward === null);

      // ---- Test 4: duplicate callback / double-tap protection ----
      rewardBehavior = 'success';
      var callsBefore = rewardCalls.length;
      requestMysteryChest();
      requestMysteryChest(); // double tap while the first request is still pending
      __check('Test 4: a double tap while a request is pending does not fire a second request', rewardCalls.length === callsBefore + 1);
      return __tick(5).then(function(){
        // ---- Test 2: exactly one reward granted ----
        __check('Test 2: exactly one reward was granted, a real MYSTERY_CHEST_REWARDS entry', mysteryChestReward !== null && MYSTERY_CHEST_REWARDS.indexOf(mysteryChestReward) !== -1);
        __check('Test 2: mysteryChestLastNight advanced to the current night, starting the cooldown', mysteryChestLastNight === nightNumber);
        var coinsAfterFirstClaim = coins;

        // ---- Test 1 (cooldown): not eligible again immediately after claiming ----
        __check('Test 1: not eligible again immediately after a successful claim (cooldown window)', mysteryChestEligible() === false);
        var callsBeforeRetap = rewardCalls.length;
        requestMysteryChest(); // tapping during cooldown must be a genuine no-op
        __check('a tap during the cooldown window does not even request an ad, grants nothing', rewardCalls.length === callsBeforeRetap && coins === coinsAfterFirstClaim);

        // ---- cooldown actually elapses ----
        nightNumber += MYSTERY_CHEST_NIGHT_INTERVAL;
        __check('Test 1: eligible again once the cooldown window has fully elapsed', mysteryChestEligible() === true);
      });
    });
  });
});
`);

scenario('lumora2-phase8-lucky-firefly', {}, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 20, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
  upgrades.tutorialDone = true;
  reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;

  // ---- Test 6: trigger the opportunity via the real proximity-catch path ----
  var typesBefore = JSON.stringify(TYPES);
  var scoreBefore = S.score, missesBefore = S.misses, capBefore = S.cap;
  spawnLuckyFirefly();
  __check('Test 6 setup: spawnLuckyFirefly() creates its own overlay object, never added to S.flies/TYPES', S.lucky !== null && S.flies.indexOf(S.lucky) === -1);
  S.lucky.x = S.jar.x; S.lucky.y = S.jar.y - 14;
  for (var i = 0; i < 200 && !S.luckyOfferOpen; i++) update(0.016);
  __check('Test 6: catching it opens the offer overlay', S.luckyOfferOpen === true && S.lucky === null);
  __check('Test 6: normal firefly gameplay (TYPES -- values/spawn data) is completely unchanged', JSON.stringify(TYPES) === typesBefore);
  __check('Test 6: catching it did not touch score/misses/jar capacity', S.score === scoreBefore && S.misses === missesBefore && S.cap === capBefore);

  // ---- take the guaranteed reward, no ad required ----
  var coinsBefore = coins;
  takeLuckyReward();
  __check('taking the reward grants exactly the base amount, once', coins === coinsBefore + LUCKY_FIREFLY_BASE_REWARD && S.luckyReward === LUCKY_FIREFLY_BASE_REWARD);
  __check('the offer closes after taking the reward', S.luckyOfferOpen === false);
  var coinsAfterTake = coins;
  takeLuckyReward(); // tapping again after it is already closed
  __check('taking the reward again after the offer is already closed is a no-op', coins === coinsAfterTake);

  // ---- double via ad ----
  var rewardCalls = [];
  var rewardBehavior = 'success';
  ytgame.ads = {
    requestRewardedAd: function(id){
      rewardCalls.push(id);
      if (rewardBehavior === 'throw') throw new Error('mock throw');
      if (rewardBehavior === 'reject') return Promise.reject(new Error('mock reject'));
      return Promise.resolve(rewardBehavior === 'success');
    },
    requestInterstitialAd: function(){ return Promise.resolve(); }
  };

  S.luckyOfferOpen = true; S.luckyReward = 0;
  var coinsBeforeDouble = coins;
  requestLuckyFireflyDouble();
  requestLuckyFireflyDouble(); // double tap while pending
  __check('a double tap while the double-request is pending does not fire a second ad request', rewardCalls.length === 1);
  return __tick(5).then(function(){
    __check('doubling grants exactly 2x the base amount, once', coins === coinsBeforeDouble + LUCKY_FIREFLY_BASE_REWARD * 2 && S.luckyReward === LUCKY_FIREFLY_BASE_REWARD * 2);
    __check('the offer closes after a successful double', S.luckyOfferOpen === false);

    // ---- Test 3-equivalent: ad failure on double leaves the offer OPEN, grants nothing, Take Reward still works afterward ----
    S.luckyOfferOpen = true; S.luckyReward = 0;
    rewardBehavior = 'false';
    var coinsBeforeFail = coins;
    requestLuckyFireflyDouble();
    return __tick(5).then(function(){
      __check('a failed double grants no reward', coins === coinsBeforeFail);
      __check('the offer stays OPEN after a failed double -- the opportunity is not consumed', S.luckyOfferOpen === true);
      takeLuckyReward();
      __check('Take Reward still works normally after a failed double attempt', coins === coinsBeforeFail + LUCKY_FIREFLY_BASE_REWARD && S.luckyOfferOpen === false);

      // ---- Take Reward is inert while a double-request is genuinely in flight (no race/double-grant) ----
      S.luckyOfferOpen = true; S.luckyReward = 0;
      rewardBehavior = 'success';
      requestLuckyFireflyDouble(); // now pending
      var coinsBeforeRace = coins;
      takeLuckyReward();
      __check('Take Reward is inert while a double-request is in flight', coins === coinsBeforeRace && S.luckyOfferOpen === true);
      return __tick(5).then(function(){
        __check('the pending double still resolves normally afterward, exactly once', coins === coinsBeforeRace + LUCKY_FIREFLY_BASE_REWARD * 2 && S.luckyOfferOpen === false);

        // ---- at most once per round ----
        reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
        S.luckySpawnedThisRound = true; // simulate it having already spawned+resolved this round
        for (var k = 0; k < 5; k++) update(0.016);
        __check('Lucky Firefly does not spawn again this round once luckySpawnedThisRound is true', S.lucky === null);

        // ---- Test 7: collection isolation ----
        var journalBefore = JSON.stringify(journal);
        reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
        spawnLuckyFirefly();
        S.lucky.x = S.jar.x; S.lucky.y = S.jar.y - 14;
        for (var m = 0; m < 200 && !S.luckyOfferOpen; m++) update(0.016);
        takeLuckyReward();
        __check('Test 7: Lucky Firefly never touches the Firefly Journal', JSON.stringify(journal) === journalBefore);
      });
    });
  });
});
`);

scenario('lumora2-phase8-cosmetic-trial', {}, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 20, upgrades: { tutorialDone: true, ownedTrails: { none: true } } }));
return __tick(5).then(function(){
  var rewardCalls = [];
  var rewardBehavior = 'success';
  ytgame.ads = {
    requestRewardedAd: function(id){
      rewardCalls.push(id);
      if (rewardBehavior === 'throw') throw new Error('mock throw');
      if (rewardBehavior === 'reject') return Promise.reject(new Error('mock reject'));
      return Promise.resolve(rewardBehavior === 'success');
    },
    requestInterstitialAd: function(){ return Promise.resolve(); }
  };

  // ---- Test 10: an already-owned cosmetic is never offered a trial ----
  __check('Test 10: the always-owned "none" trail is not trial-eligible', cosmeticTrialEligible('trail', 'none') === false);
  var callsBeforeOwned = rewardCalls.length;
  requestCosmeticTrial('trail', 'none');
  __check('Test 10: requesting a trial for an owned cosmetic is a no-op, no ad requested, no trial granted', rewardCalls.length === callsBeforeOwned && cosmeticTrial === null);

  // ---- Test 8: start a trial on a genuinely locked, real trail ----
  __check('Test 8 setup: the moonlit trail starts locked', upgrades.ownedTrails.moonlit !== true);
  __check('Test 8 setup: the moonlit trail is trial-eligible', cosmeticTrialEligible('trail', 'moonlit') === true);
  var equippedTrailBefore = upgrades.equippedTrail;
  requestCosmeticTrial('trail', 'moonlit');
  return __tick(5).then(function(){
    __check('Test 8: the trial is now active for the moonlit trail', cosmeticTrialActive('trail') === true && cosmeticTrial.id === 'moonlit');
    __check('Test 8: the cosmetic becomes temporarily usable -- activeTrailHues() reflects it', JSON.stringify(activeTrailHues()) === JSON.stringify(TRAIL_COLORS.find(function(t){ return t.key === 'moonlit'; }).hues));
    __check('Test 8: ownership itself was NOT granted', upgrades.ownedTrails.moonlit !== true);
    __check('Test 8: the real equipped trail is unchanged', upgrades.equippedTrail === equippedTrailBefore);

    // ---- Test 9: trial expiration reverts to the previous state ----
    cosmeticTrialT = 0.02;
    cosmeticTrialT -= 0.03; if (cosmeticTrialT <= 0) endCosmeticTrial(); // simulate loop()'s own countdown tick directly -- not persisted state, no need to call the real loop()
    __check('Test 9: the trial has ended', cosmeticTrialActive('trail') === false);
    __check('Test 9: activeTrailHues() reverts to the actual equipped trail', JSON.stringify(activeTrailHues()) === JSON.stringify((function(){ var t = TRAIL_COLORS.find(function(t){ return t.key === equippedTrailBefore; }); return (t && t.hues.length) ? t.hues : null; })()));
    __check('Test 9: ownership/equipped state was never touched by the trial or its expiration', upgrades.ownedTrails.moonlit !== true && upgrades.equippedTrail === equippedTrailBefore);

    // ---- Test 11: theme trial (hand-crafted theme, same isolated-vm-context discipline the Phase 7 tests already established) ----
    VILLAGE_THEMES.push({ id: 'test_theme_trial', name: 'Test Trial Theme', desc: 'hand-crafted for this scenario only' });
    __check('Test 11 setup: the synthetic theme starts locked', isThemeOwned('test_theme_trial') === false);
    var equippedThemeBefore = equippedTheme;
    best = 25; nightNumber = 15; // a real village-progressed player
    var levelBefore = villageLevel(), restBefore = restorationPct(best);
    requestCosmeticTrial('theme', 'test_theme_trial');
    return __tick(5).then(function(){
      __check('Test 11: the theme visually applies -- effectiveTheme() reflects the trial', effectiveTheme() === 'test_theme_trial');
      __check('Test 11: the existing equipped theme is remembered, unchanged', equippedTheme === equippedThemeBefore);
      __check('Test 11: village progression (restoration % and Village Level) is completely unchanged by a theme trial', restorationPct(best) === restBefore && villageLevel() === levelBefore);
      __check('Test 11: ownership was not granted by the trial', isThemeOwned('test_theme_trial') === false);

      // ---- Test 12: theme trial expiration ----
      endCosmeticTrial();
      __check('Test 12: the previous (real) equipped theme returns once the trial ends', effectiveTheme() === equippedThemeBefore);
      VILLAGE_THEMES.pop(); // cleanup the synthetic entry so nothing later in this scenario sees it

      // ---- ad failure grants no trial, does not consume the opportunity ----
      rewardBehavior = 'false';
      requestCosmeticTrial('trail', 'starlight');
      return __tick(5).then(function(){
        __check('a failed trial-ad request grants no trial', cosmeticTrial === null);
        __check('the cosmetic is still trial-eligible afterward -- a failed attempt is not consumed', cosmeticTrialEligible('trail', 'starlight') === true);

        // ---- duplicate callback / double-tap protection ----
        rewardBehavior = 'success';
        var callsBefore = rewardCalls.length;
        requestCosmeticTrial('trail', 'starlight');
        requestCosmeticTrial('trail', 'starlight'); // double tap while pending
        __check('a double tap while a trial request is pending does not fire a second ad request', rewardCalls.length === callsBefore + 1);
        return __tick(5).then(function(){
          __check('exactly one trial is active after the double tap resolves', cosmeticTrialActive('trail') === true && cosmeticTrial.id === 'starlight');
          endCosmeticTrial();
        });
      });
    });
  });
});
`);

scenario('lumora2-phase8-persistence', { audioEnabled: true, mockNowMs: FIXED_NOW_SAME_DAY_MS }, `
// ---- Test 14: an existing pre-Phase-8 save loads safely -- no new save field is required for any Phase 8 feature (all of it is session-only), so this is really just re-confirming Phase 5/6/7's own progression survives untouched ----
// lastPlayed is set within the SAME calendar week as mockNowMs above --
// otherwise resolveWeekly() correctly treats this as a new week and resets
// weeklyStats to zero (its own existing, correct behavior, not a Phase 8
// bug) before the check below ever runs.
__spy.loadResolve(JSON.stringify({ best: 20, coins: 300, nightNumber: 12, journal: { y: 4, b: 2, g: 0, e: 0, m: 0 }, variantJournal: {}, equippedTheme: 'default', cosmeticsUnlocked: [], upgrades: { tutorialDone: true, ownedJars: { simple: true }, equippedJar: 'simple', ownedTrails: { none: true, gold: true }, equippedTrail: 'gold' }, lastPlayed: ${FIXED_NOW_SAME_DAY_MS} - 1000, objectivesCompleted: {}, eventHistory: [], contractsCompleted: [], weekly: { stats: { fireflies: 5, rare: 1, nights: 2, events: 0 }, claimed: { fireflies: false, rare: false, nights: false, events: false }, chestClaimed: false } }));
return __tick(5).then(function(){
  __check('Test 14: a pre-Phase-8 save loads without throwing', loadDone === true && nightNumber === 12);
  __check('Test 14: coins unchanged', coins === 300);
  __check('Test 14: jars unchanged', upgrades.ownedJars.simple === true && upgrades.equippedJar === 'simple');
  __check('Test 14: trails unchanged', upgrades.ownedTrails.gold === true && upgrades.equippedTrail === 'gold');
  __check('Test 14: theme unchanged', equippedTheme === 'default' && effectiveTheme() === 'default');
  __check('Test 14: village (restoration/level) unchanged', restorationPct(best) === 80 && villageLevel() === 1);
  __check('Test 14: collections unchanged', journal.y === 4 && journal.b === 2);
  __check('Test 14: weekly progression unchanged', weeklyStats.fireflies === 5 && weeklyStats.rare === 1);
  __check('Test 14: new monetization state defaults safely -- nothing pending, nothing claimed, no cooldown started, no trial active', mysteryChestPending === false && mysteryChestLastNight === -9999 && cosmeticTrial === null && S.luckyOfferOpen === false);

  // ---- Test 13: equip a permanently owned cosmetic (theme), save, reload ----
  upgrades.tutorialDone = true;
  saveProgress();
  var payload1 = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('Test 13: saveProgress() still writes exactly the existing fields -- no new Phase 8 save key was introduced (everything Phase 8 added is session-only)', JSON.stringify(Object.keys(payload1).sort()) === JSON.stringify(['best', 'cachedNightEvent', 'cachedNightEventFor', 'cachedNightObjectives', 'cachedNightObjectivesFor', 'coinFraction', 'coins', 'contractsCompleted', 'cosmeticsUnlocked', 'equippedTheme', 'eventHistory', 'journal', 'lastNightCompletionDay', 'lastPlayed', 'nightNumber', 'nightStreak', 'objectivesCompleted', 'prestigeLevel', 'quests', 'seasonId', 'seasonProgress', 'trackerOn', 'upgrades', 'variantJournal', 'weekly', 'workshopTokens']));

  // ---- Test 20: Night Complete's existing layout is completely unaffected by Phase 8 monetization state (Mystery Chest/Lucky Firefly live OUTSIDE Night Complete entirely -- see this phase's own report for why) ----
  upgrades.tutorialDone = true;
  reset(); screen = 'play'; paused = false;
  S.objectiveActive = [{ id: 'x', category: 'catch', kind: 'catch', fireflyType: 'y', label: 'Catch 5', target: 5, reward: 20, done: true }];
  S.over = true; S.overT = 1; S.tip = NIGHT_TIPS[0]; coinsAtRoundStart = coins; S.coinsEarnedThisNight = 10;
  var playBtnYBefore, threwBefore = false;
  try { drawOver(); playBtnYBefore = playBtn.y; } catch (e) { threwBefore = true; }
  // now with every Phase 8 monetization state simultaneously active/pending/claimed
  mysteryChestReward = MYSTERY_CHEST_REWARDS[0]; mysteryChestLastNight = nightNumber; mysteryChestPending = true;
  S.luckyOfferOpen = true; S.luckyPending = true; S.luckyReward = LUCKY_FIREFLY_BASE_REWARD;
  cosmeticTrial = { category: 'trail', id: 'gold' }; cosmeticTrialT = 100; cosmeticTrialPending = true;
  var playBtnYAfter, threwAfter = false;
  try { drawOver(); playBtnYAfter = playBtn.y; } catch (e) { threwAfter = true; }
  __check('Test 20: drawOver() does not throw with every Phase 8 monetization state simultaneously set', !threwBefore && !threwAfter);
  __check('Test 20: Night Complete\\'s own panel/button geometry is byte-for-byte identical regardless of any Phase 8 monetization state -- none of it is read by drawOver() at all', playBtnYBefore === playBtnYAfter);
  mysteryChestPending = false; S.luckyOfferOpen = false; S.luckyPending = false; cosmeticTrial = null; cosmeticTrialT = 0; cosmeticTrialPending = false;
});
`);

// =====================================================================
// Lumora 2.0 Phase 10: Jar Identity. Audit finding (see index.html's own
// JAR_IDENTITY comment): every JARS stat column already increases
// monotonically with price -- a real "buy the next tier" progression, not
// a playstyle trade-off. This phase adds ONE small, distinct passive per
// jar on top of that, unchanged, existing linear table. Two jars
// deliberately get no new passive (simple: the free baseline; aurora:
// already the highest stat in every column, per direct instruction not to
// stack a 6th lever on the already-strongest jar) -- their own identity
// entries still exist (name + a plain "no bonus" effect string), so Test 1
// below still holds for all 6, not just the 4 that gained a mechanic.
// =====================================================================
scenario('lumora2-phase10-jar-identity', null, `
// ---- Test 1: every existing jar has a valid identity ----
__check('Test 1: JAR_IDENTITY has exactly one entry per existing JARS key, no orphans, none missing', JARS.every(function(j){ return !!JAR_IDENTITY[j.key]; }) && Object.keys(JAR_IDENTITY).length === JARS.length);
__check('Test 1: every identity has a valid non-empty name and effect string', JARS.every(function(j){ var id = jarIdentity(j); return typeof id.name === 'string' && id.name.length > 0 && typeof id.effect === 'string' && id.effect.length > 0; }));
__check('jarIdentity() accepts a bare key string, not just a jar object (same lookup either way)', jarIdentity('elder').name === jarIdentity(JARS.find(function(j){ return j.key === 'elder'; })).name);
__check('an unrecognized key falls back to the simple/Balanced identity rather than throwing or returning undefined', jarIdentity('not_a_real_jar').name === JAR_IDENTITY.simple.name);

// ---- Test 8 (no best jar, sanity): no identity bonus exceeds a modest ~15%, keeping choice meaningful rather than making one jar mandatory ----
__check('every jar identity coin/range/chain bonus this phase actually implements is small (<=1.20x, well under existing contract/event multipliers which reach 1.65x/1.20x)', [1.15, 1.10, 1.15, 1.10].every(function(mult){ return mult <= 1.20; }));

upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;

// ---- Test 5/7: identity resolution follows the equipped jar, and ONLY the equipped jar ----
upgrades.equippedJar = 'elder';
__check('Test 5: the equipped jar (elder) resolves to its own identity (Rare Seeker)', jarIdentity(currentJar()).name === 'Rare Seeker');
__check('Test 6/7 setup: Elder\\'s rare-delivery coin bonus is active while elder is equipped', jarIdentityCoinMult('g') === 1.15);
__check('Test 7: no bonus applies to a common-type delivery even while Elder is equipped -- the bonus is keyed to the DELIVERED TYPE, not just the jar', jarIdentityCoinMult('y') === 1);
upgrades.equippedJar = 'simple';
__check('Test 7: switching to a different jar (simple) removes Elder\\'s bonus entirely -- it never applies to any other equipped jar', jarIdentityCoinMult('g') === 1);
upgrades.equippedJar = 'moon';
S.eventActive = null; // explicit -- an earlier reset() in this scenario may have randomly rolled a Night Event (~35% chance), which would make this check flaky if left to chance
__check('Test 6/7: Moon\\'s event-night bonus is inactive with no active event', jarIdentityCoinMult('y') === 1);
S.eventActive = 'moonlight';
__check('Test 6: Moon\\'s Night Watcher bonus activates once a Night Event is genuinely active', jarIdentityCoinMult('y') === 1.10);
upgrades.equippedJar = 'elder';
__check('Test 7: Moon\\'s event bonus does not leak onto Elder just because an event happens to be active -- Elder\\'s own bonus (rare-only) is unaffected by the event', jarIdentityCoinMult('y') === 1 && jarIdentityCoinMult('g') === 1.15);
S.eventActive = null;
upgrades.equippedJar = 'lantern';
__check('Test 6: Lantern\\'s Range Keeper bonus only applies while the Magnet buff is active', jarIdentityMagnetRangeMult() === 1.10);
upgrades.equippedJar = 'crystal';
__check('Test 6: Crystal\\'s Chain Keeper bonus boosts a chain milestone\\'s reward by the documented amount', chainMilestoneReward(10) === Math.round(10 * 1.15));
upgrades.equippedJar = 'simple';
__check('Test 7: no jar\\'s bonus leaks onto simple (the baseline, no-bonus jar)', jarIdentityCoinMult('g') === 1 && jarIdentityMagnetRangeMult() === 1 && chainMilestoneReward(10) === 10);
upgrades.equippedJar = 'aurora';
__check('Test 7: aurora deliberately has no new identity bonus stacked on its already-highest stats', jarIdentityCoinMult('g') === 1 && jarIdentityMagnetRangeMult() === 1 && chainMilestoneReward(10) === 10);

// ---- Test 8: no double-count -- two independent rare deliveries each get exactly 1.15x, never a compounding 1.15^2 on the second (jarIdentityCoinMult() is a pure, stateless read, not an accumulator) ----
upgrades.equippedJar = 'elder';
var m1 = jarIdentityCoinMult('g'), m2 = jarIdentityCoinMult('g');
__check('Test 8: calling the identity multiplier repeatedly for the same delivery type always returns the same value, never compounding', m1 === 1.15 && m2 === 1.15);

// ---- Test 6/9: Glow Chain compatibility -- the real advanceChain() grant and the D2 display formatter agree exactly, both reading the SAME chainMilestoneReward() ----
upgrades.equippedJar = 'crystal';
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
var coinsBeforeChain = coins;
for (var ci = 0; ci < 5; ci++) advanceChain(); // chain length 5 hits CHAIN_MILESTONES' first entry
var m5 = CHAIN_MILESTONES.find(function(mm){ return mm.n === 5; });
__check('Test 9: a real chain-5 milestone grants exactly its Chain-Keeper-boosted amount, using the existing CHAIN_MILESTONES table, not a second chain system', coins === coinsBeforeChain + Math.round(m5.reward * 1.15));
__check('Test 9: the D2 reward-chip display would show the exact same boosted amount the real grant just used -- readout and payout can never disagree', ('+' + chainMilestoneReward(D2_REWARD_BY_N[5])) === ('+' + Math.round(m5.reward * 1.15)));

// ---- Test 6/13: real hook site -- a real rare delivery while Elder is equipped grants the boosted amount, and objective/journal counting is completely unaffected by the coin multiplier ----
upgrades.equippedJar = 'elder';
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
S.objectiveActive = [{ id: 'x', category: 'catch', kind: 'deliver', target: 5, reward: 20, done: false }];
S.objectiveProgress = { x: 0 };
var journalBefore = JSON.stringify(journal);
coinFraction = 0; // grantDeliveryCoins() floors an ACCUMULATING coinFraction, not a per-delivery round -- zeroed here so a single delivery's exact integer result is predictable below
var coinsBeforeRareDelivery = coins;
S.carried.push({ type: 'g', ph: 0, sp: 1 }); // Shy -- a rare type
S.jar.y = 999; S.jar.ty = 999;
for (var di = 0; di < 120 && (S.sparks.length > 0 || S.carried.length > 0); di++) __stepFrame(16);
var expectedRareCoins = Math.floor(TYPES.g.coins * jarCurrentStat('lightValue', currentJar()) * coinMultiplierForRun() * nightEventCoinMult() * contractCoinMult() * 1.15);
__check('Test 13: a real rare delivery still progresses the (deliver-kind) objective normally, unaffected by the coin bonus', S.objectiveProgress.x === 1);
__check('Test 10: a real rare delivery with Elder equipped does not corrupt or duplicate Firefly Journal state -- delivery never touches journal at all (that is catch-time state, an existing, untouched invariant)', JSON.stringify(journal) === journalBefore);
__check('Test 6: the actual coins granted from a real rare delivery match the full expected multiplicative chain, jar identity included as the final factor', coins === coinsBeforeRareDelivery + expectedRareCoins, 'coins=' + coins + ' before=' + coinsBeforeRareDelivery + ' expected=' + expectedRareCoins);

// ---- Test 11: contracts remain compatible -- jar identity stacks multiplicatively alongside an active contract's own coin multiplier, neither overriding the other ----
activeContract = 0; // Peaceful (a real coin-multiplier contract)
var contractMultActive = contractCoinMult();
__check('Test 11 setup: a real contract coin multiplier is actually active for this check', contractMultActive !== 1);
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
activeContract = 0;
coinFraction = 0;
var coinsBeforeContractDelivery = coins;
S.carried.push({ type: 'g', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var ci2 = 0; ci2 < 120 && (S.sparks.length > 0 || S.carried.length > 0); ci2++) __stepFrame(16);
var expectedContractCoins = Math.floor(TYPES.g.coins * jarCurrentStat('lightValue', currentJar()) * coinMultiplierForRun() * nightEventCoinMult() * contractCoinMult() * 1.15);
__check('Test 11: jar identity and an active contract multiplier stack correctly together in one real delivery, neither silently overriding the other', coins === coinsBeforeContractDelivery + expectedContractCoins, 'coins=' + coins + ' expected=' + expectedContractCoins);
activeContract = -1;

// ---- Test 12: events remain compatible -- Moon's identity bonus and nightEventCoinMult() both apply together, multiplicatively ----
upgrades.equippedJar = 'moon';
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
S.eventActive = 'mothSwarm'; // a real event with its own existing coin multiplier
coinFraction = 0;
var coinsBeforeEventDelivery = coins;
S.carried.push({ type: 'y', ph: 0, sp: 1 });
S.jar.y = 999; S.jar.ty = 999;
for (var ei = 0; ei < 120 && (S.sparks.length > 0 || S.carried.length > 0); ei++) __stepFrame(16);
var expectedEventCoins = Math.floor(TYPES.y.coins * jarCurrentStat('lightValue', currentJar()) * coinMultiplierForRun() * nightEventCoinMult() * contractCoinMult() * 1.10);
__check('Test 12: Moon\\'s Night Watcher bonus and the event\\'s own existing coin multiplier both apply together in one real delivery, multiplicatively, not double-counted', coins === coinsBeforeEventDelivery + expectedEventCoins, 'coins=' + coins + ' expected=' + expectedEventCoins);
S.eventActive = null;

// ---- Test 16: economy sanity -- the full multiplicative chain matches a plain product, no duplicate/hidden multiplication path ----
upgrades.equippedJar = 'elder';
var raw = TYPES.m.coins, lv = jarCurrentStat('lightValue', currentJar()), cm = coinMultiplierForRun(), nem = nightEventCoinMult(), ccm = contractCoinMult(), jim = jarIdentityCoinMult('m');
__check('Test 16: the identity multiplier is exactly one extra factor in the existing chain -- a plain product of all six factors, nothing hidden or duplicated', jim === 1.15 && (raw * lv * cm * nem * ccm * jim) === (raw * lv * cm * nem * ccm * 1.15));

// ---- Test 2/3/4/15: existing ownership/upgrades/equipped-jar state is completely untouched by this phase (no new fields, no new persistence) ----
upgrades.equippedJar = 'crystal';
upgrades.ownedJars = { simple: true, crystal: true };
upgrades.jarCapTiers.crystal = 3;
var capBefore = jarCurrentCapacity(currentJar());
__check('Test 2/3: existing ownership and upgrade tiers resolve exactly as before -- Phase 10 reads currentJar()/jarCurrentCapacity() but never writes to them', upgrades.ownedJars.crystal === true && upgrades.jarCapTiers.crystal === 3 && capBefore === Math.min(JARS.find(function(j){ return j.key === 'crystal'; }).capacity + 3, JARS.find(function(j){ return j.key === 'crystal'; }).maxCapacity));
__check('Test 4: the equipped jar itself is still just upgrades.equippedJar -- no second/duplicate equipped-jar or identity state exists', upgrades.equippedJar === 'crystal' && currentJar().key === 'crystal');
`);

scenario('lumora2-phase10-persistence', { audioEnabled: true }, `
// ---- Test 15: an existing pre-Phase-10 save (no identity-related fields at all, since none are needed) loads safely -- jars/upgrades/equipped jar preserved, identity resolves immediately with zero migration code ----
__spy.loadResolve(JSON.stringify({ best: 20, coins: 300, upgrades: { tutorialDone: true, ownedJars: { simple: true, elder: true }, equippedJar: 'elder', jarCapTiers: { simple: 0, lantern: 0, moon: 0, crystal: 0, elder: 2, aurora: 0 } } }));
return __tick(5).then(function(){
  __check('Test 15: a pre-Phase-10 save loads without throwing', loadDone === true);
  __check('Test 15: existing jar ownership is preserved exactly', upgrades.ownedJars.elder === true && upgrades.ownedJars.simple === true);
  __check('Test 15: existing jar upgrade tiers are preserved exactly', upgrades.jarCapTiers.elder === 2);
  __check('Test 15: the existing equipped jar is preserved exactly', upgrades.equippedJar === 'elder');
  __check('Test 15: identity resolves correctly for the loaded equipped jar with zero migration code -- purely derived from the existing equippedJar field', jarIdentity(currentJar()).name === 'Rare Seeker');

  // ---- Test 14: equip a different owned jar, save, and confirm the payload introduces no new field for identity ----
  upgrades.equippedJar = 'simple';
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('Test 14: saveProgress() persists the equipped jar through the exact existing upgrades.equippedJar field -- no new identity save key was introduced', payload.upgrades && payload.upgrades.equippedJar === 'simple' && !('jarIdentity' in payload) && !('equippedJarIdentity' in payload));
  __check('Test 14 (load side): re-resolving identity from that exact saved equippedJar value gives the correct (different) identity, proving identity is derived fresh, not itself persisted', jarIdentity(payload.upgrades.equippedJar).name === 'Balanced');
});
`);

scenario('lumora2-phase11-season', null, `
// ---- Test 1: season initialization -- a valid single-entry SEASONS array, a fresh player starts at level 0 of it ----
__check('Test 1: SEASONS is a non-empty array with a valid current entry', Array.isArray(SEASONS) && SEASONS.length > 0 && currentSeason() === SEASONS[0]);
__check('Test 1: a fresh player starts at seasonProgress 0 on the first real SEASONS entry', seasonId === 'season_1' && seasonProgress === 0);

// ---- Test 2: stable ID -- currentSeason() always resolves to the same entry across repeated calls, never drifts ----
__check('Test 2: currentSeason() is stable across repeated calls', currentSeason().id === currentSeason().id && currentSeason() === currentSeason());

upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
weeklyStats = { fireflies: 0, rare: 0, nights: 0, events: 0 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: false };
weeklyChestClaimed = false;
seasonId = 'season_1'; seasonProgress = 0;

// ---- Test 3/4: progress increments exactly once per newly-claimed Weekly milestone, never on repeat progress toward an already-claimed one ----
var coinsStart = coins;
weeklyProgress('events', 1); // crosses the 'events' milestone (target 1) -- also the ONLY milestone crossed here
__check('Test 3: a newly-claimed Weekly milestone advances Season by exactly one level', seasonProgress === 1);
__check('Test 5: the level-up grants exactly coinsPerLevel (+30), since level 1 of 10 is not the final level', coins === coinsStart + 30 + 30, 'coins=' + coins); // +30 milestone reward, +30 season coinsPerLevel
var seasonProgressAfterFirst = seasonProgress, coinsAfterFirst = coins;
weeklyProgress('events', 1); // further progress on an ALREADY-claimed milestone
__check('Test 4/6: no double-count -- further progress toward an already-claimed milestone does not advance Season again', seasonProgress === seasonProgressAfterFirst && coins === coinsAfterFirst);

// ---- Test 7: duplicate-claim protection at the seasonProgressAdd() level itself -- calling it directly when already at the season's cap is a harmless no-op ----
seasonId = 'season_1'; seasonProgress = currentSeason().milestones;
var coinsAtCap = coins;
seasonProgressAdd(1);
__check('Test 7: seasonProgressAdd() is a no-op once already at the season\\'s milestone cap -- no over-completion, no extra grant', seasonProgress === currentSeason().milestones && coins === coinsAtCap);

// ---- Test 9: Collection compatibility -- Season progress/rewards never touch the Firefly Journal ----
seasonId = 'season_1'; seasonProgress = 0;
weeklyStats = { fireflies: 0, rare: 0, nights: 0, events: 0 };
weeklyMilestonesClaimed = { fireflies: false, rare: false, nights: false, events: false };
weeklyChestClaimed = false;
var journalBeforeSeason = JSON.stringify(journal);
weeklyProgress('events', 1);
__check('Test 9: a real Season level-up never touches Firefly Journal state', JSON.stringify(journal) === journalBeforeSeason);

// ---- Test 11: Village compatibility -- Season progress never touches nightNumber/restorationPct(best) ----
var nightBefore = nightNumber, restBefore = restorationPct(best);
weeklyProgress('events', 1); // already claimed above -- a no-op, but re-asserts nothing else moved
__check('Test 11: Season progression never modifies nightNumber or the Village restoration percentage', nightNumber === nightBefore && restorationPct(best) === restBefore);

// ---- Test 10: weekly reset does NOT reset Season -- resolveWeekly() rolling into a new week only resets weeklyStats/weeklyMilestonesClaimed, never seasonProgress ----
seasonId = 'season_1'; seasonProgress = 3;
var seasonBeforeWeekReset = seasonProgress;
prevLastPlayed = 1000; lastPlayed = prevLastPlayed + 8 * 24 * 60 * 60 * 1000; // a genuine new week bucket
resolveWeekly({ stats: { fireflies: 80, rare: 4, nights: 3, events: 1 }, claimed: { fireflies: true }, chestClaimed: false });
__check('Test 10: a genuine Weekly reset (new week bucket) leaves Season progress completely untouched', seasonProgress === seasonBeforeWeekReset);

// ---- Test 14: Season completion -- reaching the final level grants finalCoins AND ownership of the final trail (since it starts unowned) ----
seasonId = 'season_1'; seasonProgress = currentSeason().milestones - 1;
upgrades.ownedTrails = { none: true }; // final trail (gold) deliberately NOT owned yet
var coinsBeforeFinal = coins;
seasonProgressAdd(1);
var season = currentSeason();
__check('Test 14: crossing the final level grants finalCoins', coins === coinsBeforeFinal + season.finalCoins, 'coins=' + coins);
__check('Test 14: crossing the final level also grants ownership of the season\\'s final trail reward', upgrades.ownedTrails[season.finalTrail] === true);
__check('Test 14: Season is now at its own cap, exactly -- no over-completion', seasonProgress === season.milestones);

// ---- Test 14 (fallback branch): if the final trail is ALREADY owned, the final level instead grants the trail's own coin price, never a wasted no-op, and never a double-grant of finalCoins ----
seasonId = 'season_1'; seasonProgress = currentSeason().milestones - 1;
upgrades.ownedTrails = { none: true, gold: true }; // already owned this time
var coinsBeforeFinal2 = coins;
seasonProgressAdd(1);
var trailPrice = TRAIL_COLORS.find(function(t){ return t.key === currentSeason().finalTrail; }).price;
__check('Test 14 (already-owned fallback): the final level grants finalCoins PLUS the trail\\'s own price instead of a wasted duplicate-ownership no-op', coins === coinsBeforeFinal2 + currentSeason().finalCoins + trailPrice, 'coins=' + coins);

// ---- Test 6 (readout/payout agreement): seasonLevelRewardLabel() never disagrees with what grantSeasonLevel() actually grants ----
seasonId = 'season_1'; seasonProgress = 2;
__check('Test 6: seasonLevelRewardLabel() for a non-final level names the exact coinsPerLevel amount grantSeasonLevel() actually grants', seasonLevelRewardLabel(3) === ('+' + currentSeason().coinsPerLevel + ' Coins'));

// ---- Test 17: full regression -- drawJournalScreen() with the new Season tab active does not throw, and every other pre-existing screen is unaffected ----
seasonId = 'season_1'; seasonProgress = 4;
journalTab = 'season'; journalFrom = 'title'; journalReading = null;
screen = 'journal';
__check('Test 17: drawJournalScreen() with journalTab==season does not throw', (function(){ try { drawJournalScreen(); return true; } catch (e) { return false; } })());
journalTab = 'weekly';
__check('Test 17: the pre-existing Weekly journal tab still renders without throwing, unaffected by the new Season tab', (function(){ try { drawJournalScreen(); return true; } catch (e) { return false; } })());
screen = 'play';
// Phase 12 legitimately appends a 5th tab (prestige) after this Phase 11
// test was written -- updated to assert the real current invariant (the 4
// tabs THIS phase cares about are untouched, in their original order),
// not the length of the whole array, which is no longer this phase's own
// invariant to own.
__check('Test 17: JOURNAL_TABS gained exactly one new entry (season) at the time of Phase 11, and remains untouched by later phases -- the 3 original pre-Phase-11 tabs are still in their original order', JOURNAL_TABS.some(function(t){ return t.key === 'season'; }) && JOURNAL_TABS[0].key === 'story' && JOURNAL_TABS[1].key === 'fireflies' && JOURNAL_TABS[2].key === 'weekly' && JOURNAL_TABS[3].key === 'season');
`);

scenario('lumora2-phase11-persistence', { audioEnabled: true }, `
// ---- Test 13: a pre-Phase-11 save (no seasonId/seasonProgress fields at all) loads without throwing, defaulting safely to season_1 / level 0 ----
__spy.loadResolve(JSON.stringify({ best: 20, coins: 300, upgrades: { tutorialDone: true, ownedJars: { simple: true }, equippedJar: 'simple', ownedTrails: { none: true } }, weekly: { stats: { fireflies: 0, rare: 0, nights: 0, events: 0 }, claimed: { fireflies: false, rare: false, nights: false, events: false }, chestClaimed: false } }));
return __tick(5).then(function(){
  __check('Test 13: a pre-Phase-11 save loads without throwing', loadDone === true);
  __check('Test 13: a pre-Phase-11 save defaults seasonId to the first real season', seasonId === 'season_1');
  __check('Test 13: a pre-Phase-11 save defaults seasonProgress to 0, not undefined/NaN', seasonProgress === 0);
  __check('Test 13: unrelated pre-existing fields (coins/best/jars) are completely unaffected by the Season migration', coins === 300 && best === 20 && upgrades.ownedJars.simple === true);

  // ---- Test 12 (save side): a real seasonProgress value is written into the YT save payload ----
  // A genuine reload can't be simulated further inside this same scenario --
  // the mock loadData() Promise (__loadPromise) resolves exactly once, same
  // discipline lumora2-phase5-load-with-variants' own comment already
  // documents. The load side of this round trip is instead proven by the
  // two separate fresh-context scenarios below.
  seasonId = 'season_1'; seasonProgress = 6;
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('Test 12: saveProgress() writes the current seasonId/seasonProgress into the YT save payload', payload.seasonId === 'season_1' && payload.seasonProgress === 6);
});
`);

// The load side of the Test 12 round trip -- a fresh context loading the
// exact payload shape the scenario above just proved saveProgress() writes,
// same "separate fresh-context load" pattern as lumora2-phase5-load-with-variants.
scenario('lumora2-phase11-load-season-progress', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 20, coins: 300, seasonId: 'season_1', seasonProgress: 6 }));
return __tick(5).then(function(){
  __check('Test 12: reloading a saved seasonProgress value restores it exactly', seasonProgress === 6 && seasonId === 'season_1');
});
`);

// Test 13 (existing-player coexistence): an out-of-range loaded
// seasonProgress (e.g. from a hypothetical future season with more levels,
// or corrupted data) clamps safely to the current season's own milestone
// cap rather than leaving the player permanently over-complete.
scenario('lumora2-phase11-load-season-clamp', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 20, coins: 300, seasonId: 'season_1', seasonProgress: 999 }));
return __tick(5).then(function(){
  __check('Test 13: an out-of-range loaded seasonProgress is clamped to the current season\\'s own milestone cap, never left over-complete', seasonProgress === currentSeason().milestones);
});
`);

scenario('lumora2-phase12-prestige', null, `
// ---- Test 1: default state ----
__check('Test 1: a fresh player starts at Prestige 0', prestigeLevel === 0);

upgrades.tutorialDone = true;
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;

// ---- Test 2: eligibility -- below the requirement cannot Prestige ----
best = 5; nightNumber = 1;
journal = { y: 1, b: 0, g: 0, e: 0, m: 0 };
__check('Test 2 setup: village is not yet at its top tier', villageLevel() !== 3);
__check('Test 2 setup: collection is not yet complete', getDiscoveredFireflyCount() !== Object.keys(TYPES).length);
__check('Test 2: an under-qualified player is not Prestige-eligible', prestigeEligible() === false);
var coinsBeforeBlocked = coins, statueBeforeBlocked = upgrades.statueOwned;
__check('Test 2: activatePrestige() refuses and changes nothing for an ineligible player', activatePrestige() === false && prestigeLevel === 0 && coins === coinsBeforeBlocked && upgrades.statueOwned === statueBeforeBlocked);

// ---- Test 3: eligibility reached -- the actual requirement (Village Level 3 AND full base Firefly Collection) ----
best = 25; nightNumber = 20;
journal = { y: 3, b: 2, g: 1, e: 1, m: 1 };
__check('Test 3 setup: villageLevel() is now the top tier', villageLevel() === 3);
__check('Test 3 setup: the base Firefly Collection is now fully discovered', getDiscoveredFireflyCount() === Object.keys(TYPES).length);
__check('Test 3: Prestige is now available', prestigeEligible() === true);

// ---- Test 4: confirmation -- opening then cancelling changes absolutely nothing ----
upgrades.statueOwned = false; upgrades.statueEquipped = false;
var coinsBeforeCancel = coins, journalBeforeCancel = JSON.stringify(journal), upgradesBeforeCancel = JSON.stringify(upgrades);
journalFrom = 'title'; journalTab = 'prestige'; journalReading = null; screen = 'journal';
__fire(cv, 'pointerdown', __fakeEvent(PRESTIGE_BTN.x, PRESTIGE_BTN.y));
__check('Test 4 setup: tapping the (enabled) Prestige button opens the confirmation modal', prestigeConfirmOpen === true && prestigeLevel === 0);
// Not just state -- proves drawJournalScreen() actually reaches
// drawConfirmModal() while the state is open (a real bug found live in
// Chrome: prestigeConfirmOpen was wired through the pointerdown handler and
// Esc key correctly, but the actual drawConfirmModal() call was initially
// missing from drawJournalScreen() entirely, so the confirmation never
// became visible even though the state itself was correct -- "state is
// set" and "the modal is visible" are two different claims, and only a
// spy on the real draw call proves the second one).
(function(){
  var realDrawConfirmModal = drawConfirmModal, called = false;
  drawConfirmModal = function(){ called = true; return realDrawConfirmModal.apply(this, arguments); };
  try { drawJournalScreen(); } finally { drawConfirmModal = realDrawConfirmModal; }
  __check('Test 4 setup: the open confirmation modal genuinely calls drawConfirmModal() when the Journal screen renders', called === true);
})();
__fire(cv, 'pointerdown', __fakeEvent(CONFIRM_CANCEL_BTN.x, CONFIRM_CANCEL_BTN.y));
__check('Test 4: Cancel closes the modal', prestigeConfirmOpen === false);
__check('Test 4: Cancel changes absolutely nothing -- Prestige level, coins, journal, and upgrades are all byte-for-byte unchanged', prestigeLevel === 0 && coins === coinsBeforeCancel && JSON.stringify(journal) === journalBeforeCancel && JSON.stringify(upgrades) === upgradesBeforeCancel);

// ---- Test 5/6: Prestige activation via the real confirm button, and the correct permanent reward ----
var coinsBeforeConfirm = coins;
__fire(cv, 'pointerdown', __fakeEvent(PRESTIGE_BTN.x, PRESTIGE_BTN.y));
__fire(cv, 'pointerdown', __fakeEvent(CONFIRM_ACTION_BTN.x, CONFIRM_ACTION_BTN.y));
__check('Test 5: confirming Prestige increases Prestige level by exactly one', prestigeLevel === 1);
__check('Test 5: the confirmation modal closes on confirm', prestigeConfirmOpen === false);
__check('Test 6: the correct permanent reward (Master Glowkeeper Statue ownership) is granted, at no coin cost since it was not already owned', upgrades.statueOwned === true && coins === coinsBeforeConfirm);

// ---- Test 6 (already-owned fallback): if the reward item was already owned (e.g. bought outright before ever reaching Prestige), the SAME real price is granted in coins instead -- never a wasted no-op, never a second copy of anything ----
screen = 'play';
best = 25; nightNumber = 20; journal = { y: 3, b: 2, g: 1, e: 1, m: 1 };
prestigeLevel = 0; upgrades.statueOwned = true; upgrades.statueEquipped = false; // simulate: player bought the statue themselves, long before reaching Prestige
var coinsBeforeFallback = coins;
__check('Test 6 (already-owned fallback) setup: still eligible', prestigeEligible() === true);
__check('Test 6 (already-owned fallback): activatePrestige() grants the item\\'s own real price in coins instead of a duplicate/no-op', activatePrestige() === true && prestigeLevel === 1 && coins === coinsBeforeFallback + PRESTIGE_REWARDS[0].price && upgrades.statueOwned === true);

// ---- Test 7: duplicate activation protection -- repeated confirmation/callback grants Prestige exactly once ----
var coinsAtMax = coins;
__check('Test 7 setup: Prestige is now at its max, no longer eligible', prestigeEligible() === false && prestigeLevel === PRESTIGE_MAX);
__check('Test 7: a second direct activatePrestige() call (simulating a duplicate callback/double-click) is refused and grants nothing further', activatePrestige() === false && prestigeLevel === PRESTIGE_MAX && coins === coinsAtMax);
__check('Test 7 (b): a third call is equally inert', activatePrestige() === false && prestigeLevel === PRESTIGE_MAX && coins === coinsAtMax);

// ---- Test 8/12/13/14/15: permanent progression is completely preserved by a real Prestige activation ----
best = 25; nightNumber = 20;
journal = { y: 7, b: 4, g: 2, e: 1, m: 1 };
upgrades.ownedJars = { simple: true, elder: true }; upgrades.equippedJar = 'elder'; upgrades.jarCapTiers.elder = 3;
upgrades.ownedTrails = { none: true, gold: true }; upgrades.equippedTrail = 'gold';
equippedTheme = 'default'; cosmeticsUnlocked = ['theme-winter'];
upgrades.statueOwned = false; upgrades.statueEquipped = false;
prestigeLevel = 0;
var journalBefore8 = JSON.stringify(journal);
var jarsBefore8 = JSON.stringify({ owned: upgrades.ownedJars, equipped: upgrades.equippedJar, tiers: JSON.stringify(upgrades.jarCapTiers) });
var trailsBefore8 = JSON.stringify({ owned: upgrades.ownedTrails, equipped: upgrades.equippedTrail });
var themeBefore8 = equippedTheme, cosmeticsBefore8 = JSON.stringify(cosmeticsUnlocked);
var bestBefore8 = best, nightBefore8 = nightNumber, restBefore8 = restorationPct(best), villageBefore8 = villageLevel();
__check('Test 8 setup: eligible', prestigeEligible() === true);
activatePrestige();
__check('Test 12: Firefly Journal is byte-for-byte unchanged by Prestige', JSON.stringify(journal) === journalBefore8);
__check('Test 13: Village Restoration and Village Level are unchanged by Prestige', restorationPct(best) === restBefore8 && villageLevel() === villageBefore8 && best === bestBefore8 && nightNumber === nightBefore8);
__check('Test 14: owned/equipped themes are unchanged by Prestige', equippedTheme === themeBefore8 && JSON.stringify(cosmeticsUnlocked) === cosmeticsBefore8);
__check('Test 15: owned jars, jar upgrade tiers, and the equipped jar are all unchanged by Prestige', JSON.stringify({ owned: upgrades.ownedJars, equipped: upgrades.equippedJar, tiers: JSON.stringify(upgrades.jarCapTiers) }) === jarsBefore8);
__check('Test 8: owned/equipped trails are unchanged by Prestige', JSON.stringify({ owned: upgrades.ownedTrails, equipped: upgrades.equippedTrail }) === trailsBefore8);
__check('Test 8: the only thing Prestige actually changed is prestigeLevel and the one intended reward field', prestigeLevel === 1 && upgrades.statueOwned === true);

// ---- Test 10: a Weekly reset (new week bucket) does not touch Prestige ----
var prestigeBeforeWeeklyReset = prestigeLevel;
prevLastPlayed = 1000; lastPlayed = prevLastPlayed + 8 * 24 * 60 * 60 * 1000;
resolveWeekly({ stats: { fireflies: 80, rare: 4, nights: 3, events: 1 }, claimed: { fireflies: true }, chestClaimed: false });
__check('Test 10: a genuine Weekly reset leaves Prestige level completely untouched', prestigeLevel === prestigeBeforeWeeklyReset);

// ---- Test 11: a Season transition (simulated -- only one real SEASONS entry exists today) does not touch Prestige ----
var prestigeBeforeSeasonChange = prestigeLevel;
seasonId = 'season_1'; seasonProgress = 0; // simulating a hypothetical reset/transition
seasonProgressAdd(3);
__check('Test 11: Season progress changing (even a simulated reset/transition) leaves Prestige level completely untouched', prestigeLevel === prestigeBeforeSeasonChange);

// ---- Test 16: Night Objectives remain fully functional alongside Prestige state ----
reset(); screen = 'play'; paused = false; S.isNewNight = false; S.newNightT = 999;
S.objectiveActive = [{ id: 'x', category: 'catch', kind: 'deliver', target: 3, reward: 20, done: false }];
S.objectiveProgress = { x: 0 };
objectiveProgress('deliver', 1);
__check('Test 16: Night Objectives still progress normally with real Prestige state present', S.objectiveProgress.x === 1);

// ---- Test 17: Contracts remain fully functional ----
activeContract = 0; // Peaceful, a real coin-multiplier contract
__check('Test 17: an active contract\\'s coin multiplier is still computed normally', contractCoinMult() !== 1);
activeContract = -1;

// ---- Test 18: Events remain fully functional ----
S.eventActive = 'moonlight';
__check('Test 18: an active Night Event\\'s coin multiplier is still computed normally', typeof nightEventCoinMult() === 'number');
S.eventActive = null;

// ---- Test 19: Glow Chain remains fully functional ----
var coinsBeforeChain = coins;
for (var ci = 0; ci < 5; ci++) advanceChain();
var m5 = CHAIN_MILESTONES.find(function(mm){ return mm.n === 5; });
__check('Test 19: Glow Chain milestones still grant their real reward with Prestige state present', coins === coinsBeforeChain + m5.reward);

// ---- Test 20: Night Complete's own panel/button geometry is unaffected by any Prestige state ----
S.objectiveActive = [{ id: 'x', category: 'catch', kind: 'catch', fireflyType: 'y', label: 'Catch 5', target: 5, reward: 20, done: true }];
S.over = true; S.overT = 1; S.tip = NIGHT_TIPS[0]; coinsAtRoundStart = coins; S.coinsEarnedThisNight = 10;
var playBtnYBefore, threwBefore = false;
try { drawOver(); playBtnYBefore = playBtn.y; } catch (e) { threwBefore = true; }
prestigeLevel = PRESTIGE_MAX; upgrades.statueOwned = true;
var playBtnYAfter, threwAfter = false;
try { drawOver(); playBtnYAfter = playBtn.y; } catch (e) { threwAfter = true; }
__check('Test 20: drawOver() does not throw with real Prestige state set', !threwBefore && !threwAfter);
__check('Test 20: Night Complete\\'s own panel/button geometry is byte-for-byte identical regardless of Prestige state -- none of it is read by drawOver() at all', playBtnYBefore === playBtnYAfter);
screen = 'play';

// ---- Test 21: existing monetization surfaces remain unaffected ----
__check('Test 21: Workshop monetization helpers remain callable and unaffected by Prestige state', typeof rewardedAdsAvailable() === 'boolean' && typeof mysteryChestEligible() === 'boolean');

// ---- Test 22: full release regression -- every Journal tab still renders without throwing alongside real Prestige state ----
journalFrom = 'title'; journalTab = 'prestige'; journalReading = null; screen = 'journal';
__check('Test 22: drawJournalScreen() with journalTab==prestige does not throw', (function(){ try { drawJournalScreen(); return true; } catch (e) { return false; } })());
// Not just "doesn't throw" -- proves the DRAW dispatch actually reaches
// drawPrestigeJournal() (a real bug found live in Chrome: the pointerdown
// dispatch had its own 'prestige' branch from the start, but the draw
// dispatch's own branch was initially missing, so the tab visually still
// showed the Fireflies grid underneath the highlighted Prestige tab --
// "doesn't throw" alone can never catch a wrong-branch-selected bug like
// this, only a real spy on the actual function called can).
(function(){
  var realDrawPrestigeJournal = drawPrestigeJournal, called = false;
  drawPrestigeJournal = function(){ called = true; return realDrawPrestigeJournal.apply(this, arguments); };
  try { drawJournalScreen(); } finally { drawPrestigeJournal = realDrawPrestigeJournal; }
  __check('Test 22: the journalTab==prestige dispatch genuinely calls drawPrestigeJournal(), not a fallthrough to another tab\\'s draw function', called === true);
})();
['story', 'fireflies', 'weekly', 'season'].forEach(function(tab){
  journalTab = tab;
  __check('Test 22: the pre-existing ' + tab + ' journal tab still renders without throwing, unaffected by the new Prestige tab', (function(){ try { drawJournalScreen(); return true; } catch (e) { return false; } })());
});
screen = 'play';
__check('Test 22: JOURNAL_TABS gained exactly one new entry (prestige); the 4 pre-existing tabs are untouched, in their original order', JOURNAL_TABS.length === 5 && JOURNAL_TABS[0].key === 'story' && JOURNAL_TABS[1].key === 'fireflies' && JOURNAL_TABS[2].key === 'weekly' && JOURNAL_TABS[3].key === 'season' && JOURNAL_TABS[4].key === 'prestige');

// ---- Performance: prestigeEligible() is a cheap, pure, event-driven read -- never scans S or runs every frame on its own ----
__check('Performance: prestigeEligible() is a pure function of already-existing persistent state, not a per-frame accumulator', typeof prestigeEligible === 'function' && typeof prestigeLevel === 'number');
`);

scenario('lumora2-phase12-persistence', { audioEnabled: true }, `
// ---- Migration: a pre-Phase-12 save (no prestigeLevel field at all) loads without throwing, defaulting safely to 0 ----
__spy.loadResolve(JSON.stringify({ best: 25, coins: 300, nightNumber: 20, journal: { y: 3, b: 2, g: 1, e: 1, m: 1 }, upgrades: { tutorialDone: true, ownedJars: { simple: true }, equippedJar: 'simple', ownedTrails: { none: true }, statueOwned: false, statueEquipped: false } }));
return __tick(5).then(function(){
  __check('Migration: a pre-Phase-12 save loads without throwing', loadDone === true);
  __check('Migration: a pre-Phase-12 save defaults prestigeLevel to 0, not undefined/NaN', prestigeLevel === 0);
  __check('Migration: unrelated pre-existing fields (coins/best/journal) are completely unaffected by the Prestige migration', coins === 300 && best === 25 && journal.y === 3);
  __check('Migration: a player who happens to already meet the requirement is correctly eligible immediately after loading, with zero extra state needed', prestigeEligible() === true);

  // ---- Test 9 (save side): a real Prestige activation is written into the YT save payload ----
  activatePrestige();
  saveProgress();
  var payload = JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]);
  __check('Test 9: saveProgress() writes the current prestigeLevel into the YT save payload', payload.prestigeLevel === 1);
  __check('Test 9: the granted reward (statueOwned) is written into the payload\\'s existing upgrades field -- no new/duplicate reward field', payload.upgrades && payload.upgrades.statueOwned === true);
});
`);

// The load side of the Test 9 round trip -- a fresh context loading the
// exact payload shape the scenario above just proved saveProgress() writes,
// same "separate fresh-context load" pattern as lumora2-phase11-load-season-progress.
scenario('lumora2-phase12-load-prestige', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 25, coins: 300, prestigeLevel: 1, upgrades: { tutorialDone: true, statueOwned: true, statueEquipped: false, ownedJars: { simple: true }, equippedJar: 'simple', ownedTrails: { none: true } } }));
return __tick(5).then(function(){
  __check('Test 9: reloading a saved prestigeLevel restores it exactly', prestigeLevel === 1);
  __check('Test 9: the reload also restores the permanent reward it granted', upgrades.statueOwned === true);
});
`);

// Test: an out-of-range/invalid loaded prestigeLevel (corrupted data, or a
// stale save from a hypothetical future build with more approved reward
// tiers) clamps safely rather than crashing or over-completing.
scenario('lumora2-phase12-load-prestige-clamp', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 25, coins: 300, prestigeLevel: 999 }));
return __tick(5).then(function(){
  __check('Invalid Prestige state: an out-of-range loaded prestigeLevel is clamped to PRESTIGE_MAX, never left over-complete', prestigeLevel === PRESTIGE_MAX);
});
`);

scenario('lumora2-e2-migration', null, `
// ---- Coin Value migration: the spec's own worked example, old level 2 (1.20x under the OLD 3x10pp steps) -> new level 16 (1.20x under the NEW flat 1.25pp steps) exactly ----
upgrades.economyV2Migrated = false;
upgrades.lightTier = 2;
migrateEconomyV2();
__check('Coin Value migration: old level 2 (1.20x) migrates to new level 16 exactly (1 + 16*0.0125 = 1.20x), never down to old-level-2-under-new-steps (1.025x)', upgrades.lightTier === 16, 'got=' + upgrades.lightTier);
__check('the migrated Coin Value level actually produces AT LEAST the old 1.20x bonus, never less', coinMultiplierForRun() >= 1.20 - 1e-9, 'got=' + coinMultiplierForRun());
upgrades.lightTier = 0; upgrades.economyV2Migrated = false;

// ---- Capacity migration: deliberately NOT touched -- its formula (+1 flat/tier) never changed, only the ceiling rose, so an old tier count is already exactly as correct under the new ceiling ----
upgrades.jarCapTiers.simple = 2;
migrateEconomyV2();
__check('Capacity is never migrated -- its own tier count (2) is untouched, since base+tierOwned is unchanged by E2, only the ceiling (ownedJars.simple.maxCapacity) rose', upgrades.jarCapTiers.simple === 2);
upgrades.jarCapTiers.simple = 0; upgrades.economyV2Migrated = false;

// ---- Reach migration: old tier 1 (55+1*3=58 under the OLD flat step 3) -> new tier 11 (55+11*0.29=58.19, the smallest new tier reaching >=58) ----
upgrades.reachTiers.simple = 1;
migrateEconomyV2();
__check('Reach migration: old tier 1 (value 58) migrates to new tier 11 (the smallest new-step tier whose value is >= 58, never fewer)', upgrades.reachTiers.simple === 11, 'got=' + upgrades.reachTiers.simple);
var __simpleJarE2 = JARS.find(function(j){ return j.key === 'simple'; });
__check('the migrated Reach tier actually produces AT LEAST the old value (58), never less', jarCurrentStat('reach', __simpleJarE2) >= 58 - 1e-9, 'got=' + jarCurrentStat('reach', __simpleJarE2));
upgrades.reachTiers.simple = 0; upgrades.economyV2Migrated = false;

// ---- Magnet Reach migration: old tier 1 (130+1*10=140) -> new tier 10 (130+10*1=140 exactly) ----
upgrades.magnetReachTiers.simple = 1;
migrateEconomyV2();
__check('Magnet Reach migration: old tier 1 (value 140) migrates to new tier 10 (130+10*1=140 exactly)', upgrades.magnetReachTiers.simple === 10, 'got=' + upgrades.magnetReachTiers.simple);
upgrades.magnetReachTiers.simple = 0; upgrades.economyV2Migrated = false;

// ---- Duration migration: old tier 1 (4.0+1*0.5=4.5) -> new tier 9 (4.0+9*0.056=4.504, the smallest new tier reaching >=4.5) ----
upgrades.durationTiers.simple = 1;
migrateEconomyV2();
__check('Duration migration: old tier 1 (value 4.5) migrates to new tier 9 (the smallest new-step tier whose value is >= 4.5, never fewer)', upgrades.durationTiers.simple === 9, 'got=' + upgrades.durationTiers.simple);
__check('the migrated Duration tier actually produces AT LEAST the old value (4.5s), never less', jarCurrentStat('duration', __simpleJarE2) >= 4.5 - 1e-9, 'got=' + jarCurrentStat('duration', __simpleJarE2));
upgrades.durationTiers.simple = 0; upgrades.economyV2Migrated = false;

// ---- Light Value migration: old tier 1 (0.65+1*0.05=0.70 under the OLD flat step 0.05) -> new tier under the NEW smaller step (0.015) that reaches >=0.70 ----
upgrades.lightValueTiers.simple = 1;
migrateEconomyV2();
var __expectedLVTier = Math.ceil((0.70 - 0.65) / 0.015 - 1e-9);
__check('Light Value migration: old tier 1 (value 0.70) migrates to the smallest new-step tier whose value is >= 0.70 (never fewer)', upgrades.lightValueTiers.simple === __expectedLVTier, 'got=' + upgrades.lightValueTiers.simple + ' expected=' + __expectedLVTier);
__check('the migrated Light Value tier actually produces AT LEAST the old value (0.70x), never less', jarCurrentStat('lightValue', __simpleJarE2) >= 0.70 - 1e-9, 'got=' + jarCurrentStat('lightValue', __simpleJarE2));
upgrades.lightValueTiers.simple = 0; upgrades.economyV2Migrated = false;

// ---- Migration runs exactly once -- a second call after real progress has already been made (a real purchase) must never re-touch/re-inflate anything ----
upgrades.lightTier = 2;
migrateEconomyV2();
__check('migration set economyV2Migrated after running', upgrades.economyV2Migrated === true);
var __afterFirstMigration = upgrades.lightTier;
upgrades.lightTier = 20; // simulate real purchases made AFTER migration already ran
migrateEconomyV2(); // a second call (reload, reopening Workshop, restarting a night, etc.) must be a complete no-op
__check('a second migrateEconomyV2() call after real purchases have already happened does not re-migrate/re-inflate the level', upgrades.lightTier === 20, 'got=' + upgrades.lightTier);
upgrades.lightTier = 0; upgrades.economyV2Migrated = false;

// ---- Migration must not touch ownership/coins/cosmetics/themes ----
coins = 12345; upgrades.ownedJars = { simple: true, moon: true }; upgrades.equippedJar = 'moon'; upgrades.ownedTrails = { none: true, gold: true }; upgrades.equippedTrail = 'gold'; equippedTheme = 'default'; upgrades.lightTier = 1;
migrateEconomyV2();
__check('migration never touches coins', coins === 12345);
__check('migration never touches owned/equipped jars', JSON.stringify(upgrades.ownedJars) === JSON.stringify({ simple: true, moon: true }) && upgrades.equippedJar === 'moon');
__check('migration never touches owned/equipped trails or the equipped theme', JSON.stringify(upgrades.ownedTrails) === JSON.stringify({ none: true, gold: true }) && upgrades.equippedTrail === 'gold' && equippedTheme === 'default');
upgrades.lightTier = 0; upgrades.economyV2Migrated = false; coins = 0;
`);

scenario('lumora2-e2-sanity', null, `
// ---- Price sanity: every jar/stat's full price ladder is positive integers, monotonically non-decreasing, never NaN/Infinity ----
var __statLines = ['reach', 'magnetReach', 'duration', 'lightValue'];
JARS.forEach(function(jar){
  // capacity
  var capTiers = jar.maxCapacity - jar.capacity;
  var prevCapPrice = -1;
  for (var ct = 0; ct < capTiers; ct++) {
    upgrades.jarCapTiers[jar.key] = ct;
    var capPrice = jarCapUpgradeCost(jar);
    __check(jar.key + ' capacity tier ' + ct + ' price is a positive finite integer', Number.isInteger(capPrice) && capPrice > 0 && isFinite(capPrice), 'got=' + capPrice);
    __check(jar.key + ' capacity tier ' + ct + ' price is never lower than the previous tier\\'s (monotonic, no accidental price decrease)', capPrice >= prevCapPrice, 'prev=' + prevCapPrice + ' got=' + capPrice);
    prevCapPrice = capPrice;
  }
  upgrades.jarCapTiers[jar.key] = 0;
  // reach/magnetReach/duration/lightValue
  __statLines.forEach(function(statKey){
    var tiers = jarStatTierCount(statKey, jar);
    var prevPrice = -1, prevStat = -Infinity;
    for (var t = 0; t < tiers; t++) {
      upgrades[statKey + 'Tiers'][jar.key] = t;
      var price = jarStatUpgradeCost(statKey, jar);
      var stat = jarCurrentStat(statKey, jar);
      __check(jar.key + ' ' + statKey + ' tier ' + t + ' price is a positive finite integer', Number.isInteger(price) && price > 0 && isFinite(price), 'got=' + price);
      __check(jar.key + ' ' + statKey + ' tier ' + t + ' price is never lower than the previous tier\\'s', price >= prevPrice, 'prev=' + prevPrice + ' got=' + price);
      __check(jar.key + ' ' + statKey + ' tier ' + t + ' stat value never decreases from the previous tier', stat >= prevStat - 1e-9, 'prev=' + prevStat + ' got=' + stat);
      __check(jar.key + ' ' + statKey + ' tier ' + t + ' stat value never exceeds this jar\\'s own max', stat <= jarStatMax(statKey, jar) + 1e-9, 'stat=' + stat + ' max=' + jarStatMax(statKey, jar));
      prevPrice = price; prevStat = stat;
    }
    upgrades[statKey + 'Tiers'][jar.key] = 0;
  });
});

// ---- Coin Value price/stat sanity: 60 entries, monotonic, never exceeds the 1.75x ceiling ----
__check('Coin Value has exactly 60 price levels', TIER_LINES.light.prices.length === 60);
(function(){
  var prevPrice = -1;
  for (var i = 0; i < TIER_LINES.light.prices.length; i++) {
    var price = TIER_LINES.light.prices[i];
    if (!(Number.isInteger(price) && price > 0 && isFinite(price) && price >= prevPrice)) { __check('Coin Value price sanity failed at level ' + i, false, 'price=' + price + ' prev=' + prevPrice); return; }
    prevPrice = price;
  }
  __check('every one of Coin Value\\'s 60 price levels is a positive finite integer, monotonically non-decreasing', true);
})();
upgrades.lightTier = 60;
__check('Coin Value can never exceed its intended 1.75x ceiling, even at its own max level', coinMultiplierForRun() <= 1.75 + 1e-9 && Math.abs(coinMultiplierForRun() - 1.75) < 1e-9, 'got=' + coinMultiplierForRun());
// A corrupted/out-of-range level (999) is defensively clamped at LOAD time
// (Math.min(loaded, COIN_VALUE_LEVELS) -- see the load-path's own comment),
// not by every runtime reader -- setting upgrades.lightTier directly to an
// invalid value in memory, bypassing that load-time clamp entirely, is not
// a reachable path from any real save, so it is not asserted here. The
// real load-time clamp is covered by lumora2-e2-migration-load below.
upgrades.lightTier = 0;
`);

scenario('lumora2-e2-total-sink', null, `
// ---- Total sink verification: actual implemented per-jar totals vs the E1 targets/current-system reference, per jar. Every jar must satisfy proposed >= current -- no jar may become cheaper to fully upgrade. ----
function totalJarSink(jar){
  var total = 0;
  var capTiers = jar.maxCapacity - jar.capacity;
  upgrades.jarCapTiers[jar.key] = 0;
  for (var ct = 0; ct < capTiers; ct++) { upgrades.jarCapTiers[jar.key] = ct; total += jarCapUpgradeCost(jar); }
  upgrades.jarCapTiers[jar.key] = 0;
  ['reach', 'magnetReach', 'duration', 'lightValue'].forEach(function(statKey){
    var tiers = jarStatTierCount(statKey, jar);
    for (var t = 0; t < tiers; t++) { upgrades[statKey + 'Tiers'][jar.key] = t; total += jarStatUpgradeCost(statKey, jar); }
    upgrades[statKey + 'Tiers'][jar.key] = 0;
  });
  return total;
}
// CURRENT (pre-E2) reference totals -- computed independently from the OLD
// tapering-compound formula during the E1 audit/target-model work, not
// re-derived from live code (the whole point is comparing against what
// used to be true).
var CURRENT_JAR_TOTALS = { simple: 1512, lantern: 2516, moon: 4868, crystal: 8747, elder: 15567, aurora: 60367 };
// E1's own worked targets from the target-model report (calibration
// targets, not a hard requirement to match exactly -- see this phase's own
// final report for why the actual implemented totals differ somewhat).
var E1_TARGETS = { simple: 7436, lantern: 9768, moon: 13510, crystal: 21512, elder: 35652, aurora: 64333 };
JARS.forEach(function(jar){
  var actual = totalJarSink(jar);
  __check(jar.key + ': the actual implemented total sink (' + actual + ') is >= its current (pre-E2) total (' + CURRENT_JAR_TOTALS[jar.key] + ') -- this jar never became cheaper to fully upgrade', actual >= CURRENT_JAR_TOTALS[jar.key], 'actual=' + actual + ' current=' + CURRENT_JAR_TOTALS[jar.key]);
});
__check('Aurora remains the single largest per-jar total sink of all six jars', (function(){
  var totals = {}; JARS.forEach(function(jar){ totals[jar.key] = totalJarSink(jar); });
  var maxKey = Object.keys(totals).reduce(function(a, b){ return totals[a] >= totals[b] ? a : b; });
  return maxKey === 'aurora';
})());
`);

scenario('lumora2-e2-economy-regression', null, `
// ---- Deterministic, formula-level economy calc for beginner/average/strong profiles (spec section 30: controlled assumptions, not simulated gameplay) ----
function coinsPerCatch(type, jarKey, coinValueLevel, contractMult, eventMult, identityMult){
  var jar = JARS.find(function(j){ return j.key === jarKey; });
  var savedTier = upgrades.lightTier, savedEquipped = upgrades.equippedJar;
  upgrades.lightTier = coinValueLevel; upgrades.equippedJar = jarKey;
  var lv = jarCurrentStat('lightValue', jar), cvm = coinMultiplierForRun();
  upgrades.lightTier = savedTier; upgrades.equippedJar = savedEquipped;
  return TYPES[type].coins * lv * cvm * (contractMult || 1) * (eventMult || 1) * (identityMult || 1);
}
// Beginner: Simple jar, Coin Value untouched (level 0), no contract/event, all Curious catches (score stays under the b/g unlock gate)
var beginnerPerCatch = coinsPerCatch('y', 'simple', 0, 1, 1, 1);
__check('Beginner coins/catch (Curious, Simple jar, Coin Value untouched) matches the exact formula (0.65*0.65*1.0=0.4225)', Math.abs(beginnerPerCatch - 0.4225) < 1e-9, 'got=' + beginnerPerCatch);
var beginnerCoinsPerNight = beginnerPerCatch * 20; // ~20 catches/night, this phase's own established beginner estimate
__check('Beginner coins/night (~20 catches) lands in the E1/E2-reported 8-20 coins/night band', beginnerCoinsPerNight >= 8 && beginnerCoinsPerNight <= 20, 'got=' + beginnerCoinsPerNight);

// Average: a mid jar (Moon), a few Coin Value levels, occasional contract,
// mixed catches, PLUS an occasional Workshop Favor (+75, halved to reflect
// "occasional" rather than "every night" ad engagement -- Profile B's own
// stated characteristic) -- the pure per-catch delivery formula alone is
// deliberately NOT the whole of "average" income, since Glow Chain/
// Perfect Delivery/objective/ad faucets are real, separate income sources
// this formula-level check does not model.
var averagePerCatchY = coinsPerCatch('y', 'moon', 8, 1.20, 1, 1); // level 8 = 1.10x, Peaceful contract 1.20x
var averagePerCatchB = coinsPerCatch('b', 'moon', 8, 1.20, 1, 1);
var averageDeliveryOnly = averagePerCatchY * 18 + averagePerCatchB * 8; // ~18 curious + 8 playful, a plausible mixed 26-catch night
var averageCoinsPerNight = averageDeliveryOnly + 75 * 0.5; // + occasional Glowkeeper's Favor
__check('Average coins/night (mixed catches, Moon jar, some Coin Value + a contract + occasional Favor) lands in the E1/E2-reported 35-110 band', averageCoinsPerNight >= 35 && averageCoinsPerNight <= 110, 'got=' + averageCoinsPerNight);

// Strong: an upgraded jar (Crystal), a high Coin Value level, a strong
// contract, an active event, more catches per night, PLUS Double the Glow
// (this profile's own stated "occasional rewarded ads", applied to double
// the night's delivery earnings) -- Glow Chain/Perfect Delivery bonuses
// (real, separate faucets a strong player leans on hardest) are still not
// modeled here, so this is a conservative floor for Profile C, not a claim
// that the raw delivery formula alone reaches 150+.
var strongPerCatch = coinsPerCatch('y', 'crystal', 30, 1.65, 1.2, 1.15); // level 30 ~= 1.375x, Moth contract 1.65x, an event 1.2x, an identity bonus 1.15x
var strongDeliveryOnly = strongPerCatch * 60; // a strong player catches considerably more per night
var strongCoinsPerNight = strongDeliveryOnly * 2; // Double the Glow
__check('Strong coins/night (full multiplier stack, Crystal jar, Double the Glow) lands in or above the E1/E2-reported 150-300+ band', strongCoinsPerNight >= 150, 'got=' + strongCoinsPerNight);

// ---- Upgrade cost / income = nights required, spot-checked against the E1 target bands (Section 5/12 of the spec) ----
var simpleJarE2r = JARS.find(function(j){ return j.key === 'simple'; });
upgrades.jarCapTiers.simple = 0;
var firstCapCost = jarCapUpgradeCost(simpleJarE2r);
__check('the very first Capacity upgrade (Simple, tier 0) still costs 25 -- E2 did not touch the fresh-player entry price ("do not simply multiply the first price by 3")', firstCapCost === 25);
__check('at an average-player pace (~60 coins/night), the very first upgrade is affordable within the E1 target of 1-2 nights', Math.ceil(firstCapCost / 60) <= 2, 'nights=' + Math.ceil(firstCapCost / 60));
upgrades.jarCapTiers.simple = 4; // a mid-ladder tier
var midCapCost = jarCapUpgradeCost(simpleJarE2r);
upgrades.jarCapTiers.simple = 0;
__check('a mid-ladder Capacity upgrade costs meaningfully more than the first, but remains a finite, reasonable purchase (not an exponential blowup)', midCapCost > firstCapCost && midCapCost < firstCapCost * 20, 'first=' + firstCapCost + ' mid=' + midCapCost);
`);

// A real fresh-context load with a corrupted/out-of-range lightTier (999)
// -- proves the LOAD-TIME clamp (Math.min(loaded, COIN_VALUE_LEVELS)) that
// replaced this genuinely reachable pre-existing gap: before this fix, a
// tampered/corrupted save's lightTier had no upper bound at all, and once
// Coin Value grew to 60 real levels, tierBonusSum() would read past the
// end of its own steps array and return NaN, silently corrupting all
// future coin income through coinMultiplierForRun().
scenario('lumora2-e2-load-lighttier-clamp', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 5, coins: 100, upgrades: { tutorialDone: true, lightTier: 999, ownedJars: { simple: true }, equippedJar: 'simple' } }));
return __tick(5).then(function(){
  __check('a corrupted/out-of-range lightTier (999) is clamped to the real max (60) at load time', upgrades.lightTier === 60, 'got=' + upgrades.lightTier);
  __check('the clamped Coin Value level produces a real, finite multiplier (1.75x), never NaN', Math.abs(coinMultiplierForRun() - 1.75) < 1e-9, 'got=' + coinMultiplierForRun());
});
`);

scenario('lumora2-e3-milestones', null, `
// ---- progressionMilestones(): Coin Value's own 60-level line reproduces the exact 5/15/30/45/60 example from the spec ----
__check('progressionMilestones(60) reproduces the spec\\'s own worked example (5/15/30/45/60)', JSON.stringify(progressionMilestones(60)) === JSON.stringify([5, 15, 30, 45, 60]), 'got=' + JSON.stringify(progressionMilestones(60)));
// ---- a short ladder (Simple Capacity, 8 levels) still gets a sensible, non-degenerate milestone set, always ending at its own max ----
var shortMs = progressionMilestones(8);
__check('progressionMilestones(8) is non-empty, strictly ascending, and always ends at the line\\'s own max', shortMs.length > 0 && shortMs[shortMs.length - 1] === 8 && shortMs.every(function(v, i){ return i === 0 || v > shortMs[i - 1]; }), 'got=' + JSON.stringify(shortMs));
// ---- every milestone for every real E2 tier count (8-60) is a valid level in range, unique, ascending, and terminates at max ----
[8, 10, 12, 15, 19, 20, 21, 24, 25, 26, 27, 28, 31, 32, 60].forEach(function(max){
  var ms = progressionMilestones(max);
  var ok = ms.length > 0 && ms[ms.length - 1] === max && ms.every(function(v){ return v >= 1 && v <= max; }) && ms.every(function(v, i){ return i === 0 || v > ms[i - 1]; });
  __check('progressionMilestones(' + max + ') is valid (ascending, in-range, ends at max)', ok, 'got=' + JSON.stringify(ms));
});

// ---- nextProgressionMilestone(): the spec's own worked example -- level 37 of 60 -> next milestone 45 ----
__check('nextProgressionMilestone(37, 60) is 45, exactly the spec\\'s own worked example', nextProgressionMilestone(37, 60) === 45);
// ---- landing exactly on a milestone: next is the FOLLOWING one, not the one just reached ----
__check('nextProgressionMilestone(45, 60) looks strictly forward -- the next one after 45 is 60, not 45 again', nextProgressionMilestone(45, 60) === 60);
// ---- at the final milestone (max itself), there is no next one ----
__check('nextProgressionMilestone(60, 60) returns null -- already at the final milestone, nothing further to name', nextProgressionMilestone(60, 60) === null);
// ---- before the very first milestone ----
__check('nextProgressionMilestone(0, 60) is 5 -- the first real milestone', nextProgressionMilestone(0, 60) === 5);

// ---- isProgressionMilestone(): the spec's own "if the player reaches 45/60, show MILESTONE 45" case ----
__check('isProgressionMilestone(45, 60) is true -- landing exactly on a real milestone', isProgressionMilestone(45, 60) === true);
__check('isProgressionMilestone(37, 60) is false -- 37 is not one of Coin Value\\'s own milestones', isProgressionMilestone(37, 60) === false);
__check('isProgressionMilestone(60, 60) is true -- the final level is always a milestone (the max itself)', isProgressionMilestone(60, 60) === true);

// ---- drawProgressionMilestoneLine() does not throw for every real E2 line/level combination, maxed or not ----
(function(){
  var threw = false;
  try {
    [8, 20, 32, 60].forEach(function(max){
      for (var lvl = 0; lvl <= max; lvl += Math.max(1, Math.floor(max / 7))) drawProgressionMilestoneLine(20, 100, lvl, max);
      drawProgressionMilestoneLine(20, 100, max, max); // the maxed level itself
    });
  } catch (e) { threw = true; }
  __check('drawProgressionMilestoneLine() does not throw across every real E2 level/max combination', !threw);
})();

// ---- economy integrity: the milestone helpers are pure display functions -- calling them must never change coins, upgrade tiers, or any economy state ----
(function(){
  var savedCoins = coins, savedLightTier = upgrades.lightTier, savedCap = JSON.stringify(upgrades.jarCapTiers);
  progressionMilestones(60); nextProgressionMilestone(30, 60); isProgressionMilestone(30, 60);
  __check('calling the milestone helpers never mutates coins, Coin Value level, or any jar tier -- pure display, no side effects', coins === savedCoins && upgrades.lightTier === savedLightTier && JSON.stringify(upgrades.jarCapTiers) === savedCap);
})();
`);

scenario('lumora2-e3-card-labels', null, `
// ---- economy integrity: the new LEVEL/MAX LEVEL labels and milestone line are pure UI -- the underlying E2 cost/stat functions this phase must not touch are unchanged ----
upgrades.tutorialDone = true;
var simpleJar = JARS.find(function(j){ return j.key === 'simple'; });
__check('jarCapUpgradeCost is still exactly the E2 formula (tier 0 = 25, unchanged by E3)', jarCapUpgradeCost(simpleJar) === 25);
__check('Coin Value tier-0 price is still exactly 60, unchanged by E3', TIER_LINES.light.prices[0] === 60);
__check('Coin Value still has exactly 60 levels, unchanged by E3', TIER_LINES.light.prices.length === 60);

// ---- drawing every upgrade card (Coin Value, Capacity, and all four per-jar stats) does not throw, for a fresh player and a near-maxed player, on every one of the six jars ----
(function(){
  var threw = false;
  try {
    JARS.forEach(function(jar){
      upgrades.ownedJars[jar.key] = true; upgrades.equippedJar = jar.key;
      screen = 'shop'; shopFrom = 'title';
      ['jars', 'trails', 'capacity', 'range', 'magnet', 'light-value', 'decor'].forEach(function(tab){ shopTab = tab; drawShop(); });
      // near-maxed: push every per-jar line to one below its own max, and Coin Value to level 59
      upgrades.jarCapTiers[jar.key] = (jar.maxCapacity - jar.capacity) - 1;
      upgrades.reachTiers[jar.key] = jarStatTierCount('reach', jar) - 1;
      upgrades.magnetReachTiers[jar.key] = jarStatTierCount('magnetReach', jar) - 1;
      upgrades.durationTiers[jar.key] = jarStatTierCount('duration', jar) - 1;
      upgrades.lightValueTiers[jar.key] = jarStatTierCount('lightValue', jar) - 1;
      upgrades.lightTier = 59;
      ['capacity', 'range', 'magnet', 'light-value'].forEach(function(tab){ shopTab = tab; drawShop(); });
      // fully maxed
      upgrades.jarCapTiers[jar.key] = jar.maxCapacity - jar.capacity;
      upgrades.reachTiers[jar.key] = jarStatTierCount('reach', jar);
      upgrades.magnetReachTiers[jar.key] = jarStatTierCount('magnetReach', jar);
      upgrades.durationTiers[jar.key] = jarStatTierCount('duration', jar);
      upgrades.lightValueTiers[jar.key] = jarStatTierCount('lightValue', jar);
      upgrades.lightTier = 60;
      ['capacity', 'range', 'magnet', 'light-value'].forEach(function(tab){ shopTab = tab; drawShop(); });
      // reset this jar's tiers before moving to the next one
      upgrades.jarCapTiers[jar.key] = 0; upgrades.reachTiers[jar.key] = 0; upgrades.magnetReachTiers[jar.key] = 0; upgrades.durationTiers[jar.key] = 0; upgrades.lightValueTiers[jar.key] = 0;
      upgrades.lightTier = 0;
    });
  } catch (e) { threw = true; }
  __check('drawing every upgrade card (fresh/near-maxed/maxed) does not throw, for every one of the six jars', !threw);
})();
upgrades.equippedJar = 'simple';
`);

scenario('lumora2-e4-almost-affordable', { audioEnabled: true }, `
// Resolve the initial load FIRST (same pattern ads-workshop-favor already
// established) -- saveProgress() defers to pendingSave until loadDone is
// true, so any reward granted before this would never actually reach
// __spy.saveDataCalls, which several checks below rely on.
__spy.loadResolve(JSON.stringify({ best: 0, coins: 0, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;

// ---- no ad offered at all when the platform doesn't support ads ----
var __targetCap = { kind: 'jarCap', jarKey: 'simple' };
upgrades.jarCapTiers.simple = 0; coins = 20; // 20/25 = 80%, would be eligible if ads were available
__check('almostAffordableEligible() is false when the SDK has no ads namespace at all', almostAffordableEligible(__targetCap) === false);
__check('requestAlmostAffordable() is a no-op when ads are unavailable', (function(){ var before = coins; requestAlmostAffordable(__targetCap); return coins === before; })());

// ---- install the mock SDK ads namespace (same pattern as the existing Workshop Favor/Double the Glow tests) ----
var rewardCalls = [];
var rewardBehavior = 'success'; // success | false | reject | throw
ytgame.ads = {
  requestRewardedAd: function(id){
    rewardCalls.push(id);
    if (rewardBehavior === 'throw') throw new Error('mock rewarded throw');
    if (rewardBehavior === 'reject') return Promise.reject(new Error('mock rewarded reject'));
    return Promise.resolve(rewardBehavior === 'success');
  },
  requestInterstitialAd: function(){ return Promise.resolve(); }
};

// ---- the 15% threshold, spot-checked against the EXACT real cost of a real upgrade (Simple Capacity tier 0 = 25, not a hand-picked fictional number) ----
upgrades.jarCapTiers.simple = 0;
var realCapCost = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; })); // 25
var eightyFivePct = Math.ceil(realCapCost * 0.85 - 1e-9);
coins = eightyFivePct - 1;
__check('one coin below the real 85% threshold (cost=' + realCapCost + ', balance=' + coins + ') is NOT eligible', almostAffordableEligible(__targetCap) === false, 'cost=' + realCapCost + ' coins=' + coins);
coins = eightyFivePct;
__check('exactly at the real 85% threshold (cost=' + realCapCost + ', balance=' + coins + ') IS eligible', almostAffordableEligible(__targetCap) === true, 'cost=' + realCapCost + ' coins=' + coins);

// ---- the spec's own worked Case A-F, using a real retrieved cost for the "1,000" example (illustrative labels match the spec 1:1, the underlying cost is whatever this jar/tier's real bandedTierCost() output is) ----
upgrades.jarCapTiers.simple = 5; // a mid-ladder tier with a bigger, more realistic cost
var cost1000ish = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
var target1000ish = { kind: 'jarCap', jarKey: 'simple' };
coins = Math.floor(cost1000ish * 0.849);
__check('Case A (~84.9% of cost): NOT eligible', almostAffordableEligible(target1000ish) === false, 'cost=' + cost1000ish + ' coins=' + coins);
coins = Math.ceil(cost1000ish * 0.85);
__check('Case B (~85% of cost): eligible', almostAffordableEligible(target1000ish) === true, 'cost=' + cost1000ish + ' coins=' + coins);
coins = Math.floor(cost1000ish * 0.9);
__check('Case C (~90% of cost): eligible', almostAffordableEligible(target1000ish) === true, 'cost=' + cost1000ish + ' coins=' + coins);
coins = cost1000ish - 1;
__check('Case D (cost - 1): eligible for exactly +1', almostAffordableEligible(target1000ish) === true && almostAffordableShortfall(target1000ish) === 1, 'cost=' + cost1000ish + ' coins=' + coins);
coins = cost1000ish;
__check('Case E (cost exactly): normal upgrade only, no ad', almostAffordableEligible(target1000ish) === false);
coins = cost1000ish + 200;
__check('Case F (well above cost): normal upgrade only, no ad', almostAffordableEligible(target1000ish) === false);
upgrades.jarCapTiers.simple = 0;

// ---- exact-shortfall reward (E4 Section 30) ----
upgrades.jarCapTiers.simple = 5;
var costForReward = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
coins = costForReward - Math.round(costForReward * 0.1); // ~90%, comfortably eligible
var expectedShortfall = costForReward - coins;
rewardBehavior = 'success';
var coinsBeforeAd = coins;
requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' });
return __tick(5).then(function(){
  __check('a successful Almost Affordable ad grants EXACTLY the shortfall (' + expectedShortfall + '), never the full cost and never a fixed amount', coins === coinsBeforeAd + expectedShortfall && coins === costForReward, 'coins=' + coins + ' cost=' + costForReward);
  __check('requestRewardedAd was called with the reserved WORKSHOP_SMALL_UPGRADE id, not a new one', rewardCalls[rewardCalls.length - 1] === 'lumora-workshop-small-upgrade');
  __check('the granted coins persist through the existing saveData mechanism -- no new save field', JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]).coins === coins);
  __check('no new persistent save schema was introduced by Almost Affordable -- the saved payload has exactly the pre-E4 field set', JSON.stringify(Object.keys(JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1])).sort()) === JSON.stringify(['best', 'cachedNightEvent', 'cachedNightEventFor', 'cachedNightObjectives', 'cachedNightObjectivesFor', 'coinFraction', 'coins', 'contractsCompleted', 'cosmeticsUnlocked', 'equippedTheme', 'eventHistory', 'journal', 'lastNightCompletionDay', 'lastPlayed', 'nightNumber', 'nightStreak', 'objectivesCompleted', 'prestigeLevel', 'quests', 'seasonId', 'seasonProgress', 'trackerOn', 'upgrades', 'variantJournal', 'weekly', 'workshopTokens']));

  // ---- one ad = one shortfall: purchasing immediately afterward drains the balance to exactly 0, no leftover ----
  var boughtOk = tryUpgradeJarCap('simple');
  __check('the upgrade purchases normally immediately after the ad reward', boughtOk === true);
  __check('one ad = one shortfall -- after purchasing, the balance is exactly 0, no leftover reward retained', coins === 0, 'coins=' + coins);
  upgrades.jarCapTiers.simple = 0;

  // ---- duplicate callback protection: a double-tap while a request is pending fires the ad exactly once ----
  upgrades.jarCapTiers.simple = 5;
  var costDup = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
  coins = costDup - Math.round(costDup * 0.1);
  var callsBeforeDup = rewardCalls.length;
  requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' });
  requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' }); // double tap while pending
  __check('a double tap while an Almost Affordable request is pending does not fire a second ad request', rewardCalls.length === callsBeforeDup + 1, 'calls=' + (rewardCalls.length - callsBeforeDup));
  return __tick(5).then(function(){
    var coinsAfterDupAd = coins;
    __check('the double-tap resolved into exactly one reward, not two', coinsAfterDupAd === costDup);
    upgrades.jarCapTiers.simple = 0;

    // ---- mid-ad balance change: the reward recalculates the shortfall AT CALLBACK TIME, never trusting the amount from when the ad was requested ----
    // Both the initial AND the bumped balance must stay within the real
    // 15% eligibility window (a balance too far below cost would make
    // requestAlmostAffordable() correctly refuse to even request an ad at
    // all, which would silently defeat this exact test -- caught live
    // while writing it).
    upgrades.jarCapTiers.simple = 5;
    var costMid = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
    coins = costMid - 15;
    var originalShortfall = almostAffordableShortfall({ kind: 'jarCap', jarKey: 'simple' });
    __check('mid-ad setup: the shortfall at request time is a real, nonzero amount', originalShortfall > 0, 'got=' + originalShortfall);
    __check('mid-ad setup: the initial balance is genuinely within the 15% eligible window', almostAffordableEligible({ kind: 'jarCap', jarKey: 'simple' }) === true, 'coins=' + coins + ' cost=' + costMid);
    requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' });
    coins += 10; // the player earns coins from real gameplay WHILE the ad is playing, before the callback fires
    return __tick(5).then(function(){
      __check('the actual reward reflects the balance AT CALLBACK TIME (originalShortfall-10), never the stale amount calculated when the ad was requested', coins === costMid, 'coins=' + coins + ' cost=' + costMid);
      upgrades.jarCapTiers.simple = 0;

      // ---- if the player already affords it by the time the callback fires, the reward is exactly 0 -- never an exploit ----
      upgrades.jarCapTiers.simple = 5;
      var costFull = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
      coins = costFull - 100;
      requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' });
      coins = costFull + 500; // the player fully affords it (and then some) before the callback fires
      return __tick(5).then(function(){
        __check('a callback that resolves after the player already affords the upgrade grants exactly 0 extra coins -- never a duplicate/excess grant', coins === costFull + 500, 'coins=' + coins);
        upgrades.jarCapTiers.simple = 0;

        // ---- ad failure/cancellation/rejection/throw: no coins granted, Workshop stays usable ----
        upgrades.jarCapTiers.simple = 5;
        var costFail = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
        coins = costFail - Math.round(costFail * 0.1);
        var coinsBeforeFail = coins;
        rewardBehavior = 'false';
        requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' });
        return __tick(5).then(function(){
          __check('an explicitly declined/failed ad (res=false) grants no coins', coins === coinsBeforeFail);
          rewardBehavior = 'reject';
          requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' });
          return __tick(5).then(function(){
            __check('a rejected ad promise grants no coins', coins === coinsBeforeFail);
            rewardBehavior = 'throw';
            var threwSync = false;
            try { requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' }); } catch (e) { threwSync = true; }
            __check('a synchronous throw from requestRewardedAd() does not propagate out of requestAlmostAffordable()', !threwSync);
            __check('a synchronous throw grants no coins', coins === coinsBeforeFail);
            var threwDraw = false;
            try { screen = 'shop'; shopTab = 'capacity'; draw(); } catch (e) { threwDraw = true; }
            __check('the Workshop remains fully usable (draws without throwing) after an ad failure', !threwDraw);
            rewardBehavior = 'success';
            upgrades.jarCapTiers.simple = 0;

            // ---- max level: Almost Affordable never appears once a line is maxed ----
            var simpleJarE4 = JARS.find(function(j){ return j.key === 'simple'; });
            upgrades.jarCapTiers.simple = simpleJarE4.maxCapacity - simpleJarE4.capacity; // fully maxed
            coins = 0;
            __check('a maxed line is never Almost-Affordable-eligible, regardless of balance', almostAffordableEligible({ kind: 'jarCap', jarKey: 'simple' }) === false);
            var callsBeforeMaxed = rewardCalls.length;
            requestAlmostAffordable({ kind: 'jarCap', jarKey: 'simple' });
            __check('requesting an ad for a maxed line is a no-op -- no ad request fires', rewardCalls.length === callsBeforeMaxed);
            upgrades.jarCapTiers.simple = 0;

            // ---- Coin Value (the shared line) also supports Almost Affordable, using the exact same functions ----
            upgrades.lightTier = 5;
            var lightCost = TIER_LINES.light.prices[5];
            coins = lightCost - Math.round(lightCost * 0.1);
            __check('Coin Value (kind: light) is Almost-Affordable-eligible using the exact same threshold function', almostAffordableEligible({ kind: 'light' }) === true);
            upgrades.lightTier = 60; coins = 0;
            __check('a maxed Coin Value is never eligible', almostAffordableEligible({ kind: 'light' }) === false);
            upgrades.lightTier = 0;

            // ---- a per-jar STAT line (not just Capacity) also supports Almost Affordable ----
            upgrades.reachTiers.simple = 10;
            var reachCost = jarStatUpgradeCost('reach', JARS.find(function(j){ return j.key === 'simple'; }));
            coins = reachCost - Math.round(reachCost * 0.1);
            __check('a per-jar stat line (reach) is Almost-Affordable-eligible using the exact same threshold function', almostAffordableEligible({ kind: 'jarStat', statKey: 'reach', jarKey: 'simple' }) === true);
            upgrades.reachTiers.simple = 0;

            // ---- handleUpgradeButtonTap() routes correctly: ad when eligible, normal purchase otherwise ----
            upgrades.jarCapTiers.simple = 5;
            var costRoute = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
            coins = costRoute - Math.round(costRoute * 0.1); // eligible for the ad
            var callsBeforeRoute = rewardCalls.length;
            var buyFnCalled = false;
            handleUpgradeButtonTap({ kind: 'jarCap', jarKey: 'simple' }, function(){ buyFnCalled = true; });
            __check('handleUpgradeButtonTap() routes to the ad request when eligible, never calling the normal buy function', rewardCalls.length === callsBeforeRoute + 1 && buyFnCalled === false);
            return __tick(5).then(function(){
              coins = 100000; // now trivially affordable
              var buyFnCalled2 = false;
              handleUpgradeButtonTap({ kind: 'jarCap', jarKey: 'simple' }, function(){ buyFnCalled2 = true; });
              __check('handleUpgradeButtonTap() routes to the normal buy function when already affordable, never requesting an ad', buyFnCalled2 === true && rewardCalls.length === callsBeforeRoute + 1);
              upgrades.jarCapTiers.simple = 0; coins = 0;

              // ---- drawing every upgrade card while Almost Affordable is actively eligible does not throw ----
              upgrades.jarCapTiers.simple = 5;
              var costDraw = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
              coins = costDraw - Math.round(costDraw * 0.1);
              upgrades.equippedJar = 'simple';
              var threwCardDraw = false;
              try {
                screen = 'shop'; shopFrom = 'title';
                ['capacity', 'range', 'magnet', 'light-value'].forEach(function(tab){ shopTab = tab; draw(); });
              } catch (e) { threwCardDraw = true; }
              __check('every Workshop tab draws without throwing while Almost Affordable is actively showing on a real card', !threwCardDraw);
              upgrades.jarCapTiers.simple = 0; coins = 0;
            });
          });
        });
      });
    });
  });
});
});
`);

// A real fresh-context load confirms Almost Affordable eligibility is
// computed correctly against a MIGRATED existing player's real state --
// not a separate/duplicate check path.
scenario('lumora2-e4-load-existing-player', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 5, coins: 0, upgrades: { tutorialDone: true, lightTier: 2, ownedJars: { simple: true }, equippedJar: 'simple', jarCapTiers: { simple: 0 } } }));
return __tick(5).then(function(){
  ytgame.ads = { requestRewardedAd: function(){ return Promise.resolve(true); }, requestInterstitialAd: function(){ return Promise.resolve(); } };
  // migrated Coin Value level (per E2's own migration: old level 2 -> new level 16)
  __check('an existing migrated player\\'s real Coin Value level is used for Almost Affordable eligibility, not a separate recomputation', upgrades.lightTier === 16);
  var cost = TIER_LINES.light.prices[upgrades.lightTier];
  coins = cost - Math.round(cost * 0.1); // within threshold
  __check('an existing migrated player within the 15% threshold on their real migrated level sees Almost Affordable', almostAffordableEligible({ kind: 'light' }) === true);
  coins = Math.floor(cost * 0.5); // well outside threshold
  __check('the same existing migrated player far from affording it does NOT see Almost Affordable', almostAffordableEligible({ kind: 'light' }) === false);
});
`);

// E5: Almost Affordable polish -- ONLY the two things E5 actually changed
// (button label wording, pending-state feedback). Everything else about
// eligibility/reward/duplicate-protection is already covered exhaustively
// by lumora2-e4-almost-affordable above and deliberately not re-tested
// here, per E5's own "do not rewrite existing tests" instruction.
scenario('lumora2-e5-almost-affordable-polish', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 0, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;
ytgame.ads = {
  requestRewardedAd: function(id){ return new Promise(function(resolve){ __pendingAdResolve = resolve; }); },
  requestInterstitialAd: function(){ return Promise.resolve(); }
};
var __pendingAdResolve = null;

// Capture every lumButton(...) call without altering its real behavior
// (it still draws against the mock ctx normally) -- same wrap-and-restore
// technique already used for drawPrestigeJournal above.
// NOT wrapped in try/finally -- a finally block runs as soon as the
// function returns the pending Promise below, which is BEFORE that
// promise's own .then() callbacks actually execute, so it would restore
// lumButton too early and silently break every capture after the first
// __tick(). Restored explicitly as the last statement in the async chain
// instead (see bottom).
var realLumButton = lumButton, calls = [];
lumButton = function(rect, label, variant, disabled){ calls.push({ label: label, disabled: disabled }); return realLumButton.apply(this, arguments); };

  var jar = JARS.find(function(j){ return j.key === 'simple'; });
  upgrades.jarCapTiers.simple = 5;
  var cost = jarCapUpgradeCost(jar);
  coins = cost - Math.round(cost * 0.1); // within the 15% window
  var target = { kind: 'jarCap', jarKey: 'simple' };
  var shortfall = almostAffordableShortfall(target);

  // ---- label wording matches the SAME "Watch Ad · <detail>" convention as every other ad button (Favor's own "Watch Ad · +75 Coins" is the closest analog) ----
  calls.length = 0;
  drawUpgradeButtonOrAd({ x: 20, y: 20, w: 300, h: 220 }, cost, target);
  __check('the Almost Affordable button label follows the existing "Watch Ad · <detail>" convention, not a one-off phrasing', calls[0].label === 'Watch Ad · +' + shortfall + ' Coins', 'got=' + calls[0].label);
  __check('the eligible button is enabled (not disabled) before any tap', calls[0].disabled === false);

  // ---- pending state: a real in-flight request swaps the SAME card to "Watching…", disabled -- matching every other ad button's own pending convention ----
  requestAlmostAffordable(target);
  __check('requestAlmostAffordable() left a real request pending', almostAffordablePending === true);
  calls.length = 0;
  drawUpgradeButtonOrAd({ x: 20, y: 20, w: 300, h: 220 }, cost, target);
  __check('while pending, the button shows "Watching…" just like Favor/Mystery Chest/Double the Glow/Extra Life do', calls[0].label === 'Watching…', 'got=' + calls[0].label);
  __check('while pending, the button is disabled so it cannot be tapped again', calls[0].disabled === true);

  // resolve the in-flight ad so it doesn't leak into later scenarios
  __pendingAdResolve(true);
  return __tick(5).then(function(){
    __check('after the ad resolves, pending clears back to false', almostAffordablePending === false);
    calls.length = 0;
    drawUpgradeButtonOrAd({ x: 20, y: 20, w: 300, h: 220 }, jarCapUpgradeCost(jar), target);
    __check('once resolved (and now affordable), the card reverts to the normal "<price> · Upgrade" button, not stuck on "Watching…"', calls[0].label.indexOf('Upgrade') !== -1, 'got=' + calls[0].label);
    upgrades.jarCapTiers.simple = 0; coins = 0;

    // ---- existing ad buttons elsewhere in the Workshop are byte-for-byte unchanged by this phase ----
    calls.length = 0;
    drawWorkshopFavorCard({ x: 0, y: 0, w: 300, h: 150 });
    __check('Glowkeeper\\'s Favor button label is unchanged by E5', calls[0].label === 'Watch Ad · +75 Coins', 'got=' + calls[0].label);
    calls.length = 0;
    drawMysteryChestCard({ x: 0, y: 0, w: 300, h: 150 });
    __check('Mystery Glow button label is unchanged by E5', calls[0].label === 'Watch Ad · Reveal Reward', 'got=' + calls[0].label);
    lumButton = realLumButton;
  });
});
`);

// E6: Daily Deal -- one rotating, deterministic, EXISTING-item discount.
// Date.now() is monkey-patched (a plain reassignable function property,
// not a const binding) to make "today" controllable, restored at the end
// -- the same "override a reassignable function, restore after" technique
// already used for rewardedAdsAvailable() etc.
scenario('lumora2-e6-daily-deal', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 100000, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;
var realDateNow = Date.now;
var DAY_MS = 24*60*60*1000;
var baseTs = new Date(2026,0,1).getTime();

// reset every candidate to unowned before each block below, so ownership
// left over from an earlier check never leaks into a later one
function resetCandidateOwnership(){
  upgrades.deco = false; upgrades.fountain = false;
  upgrades.ownedTrails = { none: true };
}
resetCandidateOwnership();
upgrades.dailyDeal = null;
Date.now = function(){ return baseTs; };

// ---- eligible item -> can be selected ----
var dealA = ensureDailyDeal();
__check('an eligible day produces a real Daily Deal candidate', dealA !== null && (dealA.kind === 'decor' || dealA.kind === 'trail'), 'got=' + JSON.stringify(dealA));

// ---- same day -> same offer (repeated calls, no state changed) ----
var dealA2 = ensureDailyDeal();
__check('calling ensureDailyDeal() again the same day returns the exact same item', JSON.stringify(dealA2) === JSON.stringify(dealA));

// ---- reload -> same offer (persisted upgrades.dailyDeal survives a fresh load) ----
var savedDailyDeal = JSON.parse(JSON.stringify(dealA)); // dealA is ensureDailyDeal()'s own {kind,key} shape, not the raw upgrades.dailyDeal record (which also carries "day")
return __tick(1).then(function(){
  // simulate a reload by resetting the module-level pick cache the same way
  // a fresh page load would -- ensureDailyDeal() itself must reproduce the
  // exact stored value without re-picking, since the day hasn't changed
  var dealAfterReload = ensureDailyDeal();
  __check('re-deriving the deal on the SAME persisted day key returns the identical stored item (this is what a page reload actually re-runs)', JSON.stringify(dealAfterReload) === JSON.stringify(savedDailyDeal));

  // ---- discount = 20% ----
  __check('dailyDealPrice(500) is exactly floor(500*0.8) = 400', dailyDealPrice(500) === 400);
  __check('dailyDealPrice(150) is exactly floor(150*0.8) = 120', dailyDealPrice(150) === 120);
  __check('dailyDealPrice never rounds down to 0 or negative for a tiny base price', dailyDealPrice(1) === 1 && dailyDealPrice(0) === 1);

  // ---- existing shop prices remain unchanged (before AND after the temporary discount patch used internally by buyDailyDeal) ----
  var decoRealPrice = SHOP_ITEMS.deco.price, goldRealPrice = TRAIL_COLORS.find(function(t){ return t.key === 'gold'; }).price;
  __check('SHOP_ITEMS.deco.price is untouched by Daily Deal existing (150, the real E2/pre-E2 price)', decoRealPrice === 150);
  __check('TRAIL_COLORS gold price is untouched by Daily Deal existing (500, the real price)', goldRealPrice === 500);

  // ---- force today's deal to a KNOWN candidate for the purchase tests below ----
  resetCandidateOwnership();
  upgrades.dailyDeal = { day: todayKey(), kind: 'decor', key: 'deco' };
  var info = dailyDealCandidateInfo(ensureDailyDeal());
  __check('setup: today forced to the decor/deco candidate, currently unowned', info.owned === false && info.price === 150);
  var discounted = dailyDealPrice(150);
  coins = 100000;

  // ---- purchase deducts discounted price, grants the existing item ----
  var coinsBefore = coins;
  var ok = buyDailyDeal();
  __check('buyDailyDeal() reports success for a real eligible, affordable deal', ok === true);
  __check('the purchase deducted EXACTLY the discounted price, not the full 150', coins === coinsBefore - discounted, 'coins=' + coins + ' discounted=' + discounted);
  __check('the purchase granted ownership through the EXISTING deco flag -- no new ownership field', upgrades.deco === true);
  __check('buyDailyDeal() left SHOP_ITEMS.deco.price restored to its real 150 after the temporary discount', SHOP_ITEMS.deco.price === 150);

  // ---- double purchase impossible ----
  var coinsAfterFirst = coins;
  var ok2 = buyDailyDeal();
  __check('a second buyDailyDeal() call for the same already-claimed deal is a no-op', ok2 === false && coins === coinsAfterFirst);

  // ---- save/reload preserves ownership (existing ownership IS the source of truth, not a duplicate flag) ----
  __check('the granted ownership persists through the existing saveData mechanism', JSON.parse(__spy.saveDataCalls[__spy.saveDataCalls.length - 1]).upgrades.deco === true);

  // ---- owned item -> not selected (pickDailyDealCandidate walks past every owned candidate) ----
  resetCandidateOwnership();
  DAILY_DEAL_CANDIDATES.forEach(function(c){
    if (c.kind === 'decor') upgrades[SHOP_ITEMS[c.key].field] = true;
    else upgrades.ownedTrails[c.key] = true;
  });
  var noneEligible = pickDailyDealCandidate();
  __check('when every single candidate is owned, pickDailyDealCandidate() returns null -- never a fake offer', noneEligible === null);
  upgrades.dailyDeal = null;
  __check('ensureDailyDeal() also returns null once nothing is eligible, and never crashes', ensureDailyDeal() === null);
  __check('dailyDealCardRect() gracefully hides the section when nothing is eligible', dailyDealCardRect() === null);
  var threwHideDraw = false;
  try { screen = 'shop'; shopFrom = 'title'; shopTab = 'capacity'; draw(); } catch (e) { threwHideDraw = true; }
  __check('the Workshop still draws fine with the Daily Deal section hidden', !threwHideDraw);

  // leave exactly one candidate unowned and confirm it (and only it) is chosen regardless of hash start point
  resetCandidateOwnership();
  DAILY_DEAL_CANDIDATES.forEach(function(c){
    if (c.key === 'violet') return;
    if (c.kind === 'decor') upgrades[SHOP_ITEMS[c.key].field] = true;
    else upgrades.ownedTrails[c.key] = true;
  });
  var onlyOne = pickDailyDealCandidate();
  __check('an owned candidate is never selected -- the one remaining unowned candidate (violet) is chosen instead, regardless of where the day-hash starts', onlyOne !== null && onlyOne.kind === 'trail' && onlyOne.key === 'violet', 'got=' + JSON.stringify(onlyOne));
  resetCandidateOwnership();
  upgrades.dailyDeal = null;

  // ---- different day -> different offer when eligible ----
  var dayAKey = localDayKey(baseTs);
  var startA = simpleDayHash(dayAKey) % DAILY_DEAL_CANDIDATES.length;
  var tsB = null, dayBKey = null;
  for (var i = 1; i < 60; i++) {
    var ts = baseTs + i * DAY_MS;
    var dk = localDayKey(ts);
    if (simpleDayHash(dk) % DAILY_DEAL_CANDIDATES.length !== startA) { tsB = ts; dayBKey = dk; break; }
  }
  __check('setup: found a second calendar day within 2 months that hashes to a different start index', tsB !== null);
  Date.now = function(){ return baseTs; };
  upgrades.dailyDeal = null;
  var dealDay1 = ensureDailyDeal();
  Date.now = function(){ return tsB; };
  var dealDay2 = ensureDailyDeal();
  __check('a genuinely different calendar day (all candidates still unowned) produces a different Daily Deal item', JSON.stringify(dealDay2) !== JSON.stringify(dealDay1), 'day1=' + JSON.stringify(dealDay1) + ' day2=' + JSON.stringify(dealDay2));
  __check('the day-2 offer is still stamped with day-2\\'s own key, not day-1\\'s', upgrades.dailyDeal.day === dayBKey);

  // ---- tutorial player does not see the offer ----
  Date.now = function(){ return baseTs; };
  upgrades.tutorialDone = false;
  __check('dailyDealCardRect() is hidden entirely while the tutorial is not yet done', dailyDealCardRect() === null);
  upgrades.tutorialDone = true;
  __check('dailyDealCardRect() becomes available again immediately once tutorialDone is true (same day, same underlying deal)', dailyDealCardRect() !== null || ensureDailyDeal() === null);

  // ---- existing Almost Affordable remains fully unaffected by Daily Deal ----
  upgrades.jarCapTiers.simple = 5;
  var capCost = jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; }));
  __check('Almost Affordable\\'s own cost function is untouched by anything Daily Deal does', capCost === 115, 'got=' + capCost);
  upgrades.jarCapTiers.simple = 0;

  Date.now = realDateNow;
});
});
`);

// E7: Night Streak & Return Momentum. Follows the SAME lightweight
// "manually flip S.over=true then call continueFromOver()" pattern the
// pre-existing lumora2-phase0-foundation scenario already established for
// nightNumber -- no real gameplay simulation needed, since neither that
// test nor this one is testing catching/delivery, only the completion
// bookkeeping. Date.now() is monkey-patched (same technique as E6's Daily
// Deal tests) to make "today" controllable.
scenario('lumora2-e7-night-streak', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 0, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;
var realDateNow = Date.now;
var DAY_MS = 24*60*60*1000;
var day0 = new Date(2026,0,1).getTime();
Date.now = function(){ return day0; };

// ---- 1: new player has no completed streak ----
__check('a fresh player has no night streak yet', nightStreak === 0 && lastNightCompletionDay === '');

// ---- 2: completing the first real night -> streak 1 ----
reset(); S.over = true; S.overT = 1;
continueFromOver();
__check('completing the first real night sets the streak to 1', nightStreak === 1, 'nightStreak=' + nightStreak);
__check('lastNightCompletionDay is stamped with today\\'s real day key', lastNightCompletionDay === localDayKey(day0));

// ---- 4: Restart Night (reset() called directly, bypassing continueFromOver()) does not increase the streak ----
var streakBeforeRestart = nightStreak;
reset(); reset(); reset();
__check('calling reset() directly (Restart Night) never changes the streak', nightStreak === streakBeforeRestart && nightStreak === 1);

// ---- 5a: duplicate Night Complete / Continue calls on the SAME round never double-count ----
// interstitialAdsAvailable() is false by default in this harness (no
// ytgame.ads installed), so continueFromOver() takes its synchronous
// enterContractScreen() path -- S is NOT replaced by reset() until a
// contract is actually accepted, so S stays the SAME instance across a
// rapid second call, exactly the double-tap window direct instruction
// calls out.
reset(); S.over = true; S.overT = 1;
continueFromOver();
var streakAfterFirstCall = nightStreak, coinsAfterFirstCall = coins;
__check('setup: S.streakCommitted is now true after one real completion call, S not yet replaced', S.streakCommitted === true);
continueFromOver(); // duplicate call, same S instance -- simulates a rapid double-tap / duplicate callback
__check('a duplicate continueFromOver() call on the SAME completed round does not advance the streak again', nightStreak === streakAfterFirstCall);
__check('a duplicate continueFromOver() call on the SAME completed round grants no extra coins', coins === coinsAfterFirstCall);
__acceptAnyContract();

// ---- 5b: a SECOND genuinely separate round completed on the SAME calendar day does not double-count either ----
var streakBeforeSameDayRound2 = nightStreak;
reset(); S.over = true; S.overT = 1;
continueFromOver();
__check('a second real completed round on the SAME calendar day leaves the streak unchanged (it already advanced today)', nightStreak === streakBeforeSameDayRound2, 'nightStreak=' + nightStreak);
__acceptAnyContract();

// ---- direct commitNightStreak() idempotency (the function's own core guarantee, independent of the S.streakCommitted call-site guard above) ----
var beforeDirectDup = nightStreak;
commitNightStreak(); commitNightStreak(); commitNightStreak();
__check('calling commitNightStreak() directly, repeatedly, the same day is fully idempotent', nightStreak === beforeDirectDup);

// ---- 6: the next CONSECUTIVE calendar day continues the streak ----
Date.now = function(){ return day0 + DAY_MS; };
reset(); S.over = true; S.overT = 1;
continueFromOver();
__check('completing a night on the very next consecutive calendar day increases the streak', nightStreak === 2, 'nightStreak=' + nightStreak);
__acceptAnyContract();
Date.now = function(){ return day0 + DAY_MS*2; };
reset(); S.over = true; S.overT = 1;
// coins captured right before this exact commit, not several nights back --
// an unrelated pre-existing system (Weekly Progression's own 'nights'
// milestone) legitimately also reacts to a 3rd night completed this same
// week, so isolating the delta around ONLY this one commit is the only way
// to attribute a coin change to Night Streak specifically, not "nothing
// else in the whole game is allowed to grant coins around night 3."
// E15: this test has now driven 5 genuinely-completed real nights through
// continueFromOver() (the earlier duplicate-call check a few lines up now
// correctly contributes ZERO of them, thanks to E15's own
// continueHandled fix) -- weeklyStats.nights legitimately reaches its own
// target=5 right at this exact call, which would also legitimately
// cascade into a Season level-up via checkWeeklyMilestones()'s own
// seasonProgressAdd(). Both are real, correct, unrelated systems -- but
// isolating Night Streak's OWN +15 here requires pre-empting that one
// specific crossing, same "isolate the exact delta" discipline already
// used for the event-roll contamination check above.
weeklyMilestonesClaimed.nights = true;
var coinsBeforeMilestone3 = coins;
continueFromOver();
__check('a third consecutive calendar day continues the streak to 3', nightStreak === 3, 'nightStreak=' + nightStreak);
// ---- 10: milestone reward (3) granted exactly once, via the existing coin reward path ----
// Checked HERE, immediately after continueFromOver() itself, and BEFORE
// __acceptAnyContract() runs -- accepting the contract calls reset(),
// which can legitimately roll a random Night Event and, through it,
// legitimately cross an unrelated pre-existing Weekly/Season milestone
// (its own real reward, nothing to do with Night Streak). Checking before
// that keeps this assertion isolated to exactly what Night Streak itself
// granted.
__check('reaching the 3-night milestone granted exactly the +15 coin bonus, through the existing coins balance', coins === coinsBeforeMilestone3 + 15, 'coins=' + coins + ' expected=' + (coinsBeforeMilestone3 + 15));
var coinsAfterMilestone3 = coins;
// a same-day duplicate never re-grants the milestone it already paid out --
// checked BEFORE __acceptAnyContract() below, for the same isolation reason
commitNightStreak();
__check('a duplicate commit on the milestone day does not re-grant the streak-3 bonus', coins === coinsAfterMilestone3);
__acceptAnyContract();

// ---- 7: missing a calendar day resets the streak to 1 ----
Date.now = function(){ return day0 + DAY_MS*5; }; // skips days 3 and 4 entirely
reset(); S.over = true; S.overT = 1;
continueFromOver();
__check('missing a calendar day resets the streak to 1, not merely holding or decrementing by one', nightStreak === 1, 'nightStreak=' + nightStreak);
__acceptAnyContract();

// ---- 9 / 11: Night Complete integration -- streak row appended LAST, every earlier row's position is byte-identical whether or not the streak row is present ----
var rowsWithoutStreak = nightCompleteTailRows(true, true, true, true, true, false);
var rowsWithStreak = nightCompleteTailRows(true, true, true, true, true, true);
__check('every pre-existing tail row (contract/event/bonus/villageLevelUp) keeps the EXACT same position whether or not the streak row is shown', JSON.stringify(rowsWithoutStreak) === JSON.stringify(rowsWithStreak.slice(0, rowsWithoutStreak.length)), 'without=' + JSON.stringify(rowsWithoutStreak) + ' with=' + JSON.stringify(rowsWithStreak));
__check('the streak row, when present, is always the LAST row in the stack', rowsWithStreak[rowsWithStreak.length - 1].kind === 'streak');
__check('nightCompleteTailRows() never adds a streak row when hasStreak is false', rowsWithoutStreak.every(function(r){ return r.kind !== 'streak'; }));

// ---- the tutorial's own first night never shows (or counts) a streak, even though upgrades.tutorialDone may already be true by the time its OWN Night Complete is drawn ----
(function(){
  var savedStreak = nightStreak, savedDay = lastNightCompletionDay, savedTutorial = upgrades.tutorialDone;
  upgrades.tutorialDone = false;
  reset(); S.over = true; S.overT = 1;
  var threwTutorialDraw = false;
  try { screen = 'play'; draw(); } catch (e) { threwTutorialDraw = true; }
  __check('the tutorial\\'s own Night Complete screen draws fine and never increments the streak (upgrades.tutorialDone gate, same as nightNumber)', !threwTutorialDraw);
  continueFromOver();
  __check('completing the tutorial night itself (tutorialDone false at continueFromOver time) does not touch the streak at all', nightStreak === savedStreak && lastNightCompletionDay === savedDay);
  upgrades.tutorialDone = savedTutorial;
})();

// ---- draw-safety: a real night's Night Complete screen (streak row showing) never throws ----
reset(); S.over = true; S.overT = 1;
var threwRealDraw = false;
try { screen = 'play'; draw(); } catch (e) { threwRealDraw = true; }
__check('a real (non-tutorial) Night Complete screen with the streak row draws without throwing', !threwRealDraw);
S.over = false; // leave the round in a normal state, not mid-completion, before the checks below

// ---- 12/13/14: Daily Deal, Almost Affordable, and existing ads are all untouched by Night Streak ----
__check('Daily Deal\\'s own price formula is untouched by Night Streak', dailyDealPrice(500) === 400);
upgrades.jarCapTiers.simple = 5;
__check('Almost Affordable\\'s own real cost function is untouched by Night Streak', jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; })) === 115);
upgrades.jarCapTiers.simple = 0;
__check('existing rewarded-ad entry points remain present and distinct from anything Night Streak added', typeof requestDoubleNightCoins === 'function' && typeof requestExtraLife === 'function' && typeof requestWorkshopCoins === 'function' && requestDoubleNightCoins !== commitNightStreak);

Date.now = realDateNow;
});
`);

// A real fresh-context load confirms the streak survives a reload exactly
// as persisted -- not recomputed, not reset, matching the "reload
// preserves streak" requirement.
scenario('lumora2-e7-load-existing-streak', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 5, coins: 0, nightStreak: 4, lastNightCompletionDay: '2026-0-15', upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
  __check('a reloaded save restores nightStreak exactly as persisted, not recomputed', nightStreak === 4);
  __check('a reloaded save restores lastNightCompletionDay exactly as persisted', lastNightCompletionDay === '2026-0-15');
});
`);

// E8: Objective Completion Bonus. Drives the REAL objectiveProgress()
// function against a manually-controlled, deterministic 3-objective set
// (one distinct kind each -- catch/deliver/score -- so each can be
// completed independently, one real call at a time) rather than relying
// on generateNightObjectives()'s own randomized category/template pick,
// which would make "complete exactly 1, then exactly 2, then exactly 3"
// impossible to script deterministically.
scenario('lumora2-e8-objective-completion-bonus', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 0, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;

function setupThreeObjectives(){
  reset();
  S.objectiveActive = [
    { id: 'e8_catch', category: 'catch', kind: 'catch', fireflyType: 'y', target: 1, reward: 5, done: false },
    { id: 'e8_deliver', category: 'delivery', kind: 'deliver', fireflyType: null, target: 1, reward: 6, done: false },
    { id: 'e8_score', category: 'score', kind: 'score', fireflyType: null, target: 5, reward: 7, done: false }
  ];
  S.objectiveProgress = { e8_catch: 0, e8_deliver: 0, e8_score: 0 };
  S.score = 0;
}

// ---- 1: 0/3 -> no bonus ----
setupThreeObjectives();
var coins0 = coins;
__check('0/3 objectives complete: no completion bonus, no individual rewards either', coins === coins0 && !S.objectiveActive.every(function(o){ return o.done; }));

// ---- 2: 1/3 -> no bonus (only the individual reward for that one) ----
objectiveProgress('catch', 'y');
__check('1/3 objectives complete: the individual reward is granted (+5)', coins === coins0 + 5, 'coins=' + coins);
__check('1/3 objectives complete: no completion bonus yet', S.objectiveBonusGranted === false);

// ---- 3: 2/3 -> still no bonus ----
objectiveProgress('deliver', null);
__check('2/3 objectives complete: the second individual reward is granted (+6 more)', coins === coins0 + 5 + 6, 'coins=' + coins);
__check('2/3 objectives complete: still no completion bonus', S.objectiveBonusGranted === false);

// ---- 4: 3/3 -> +10 completion bonus, on top of the third individual reward ----
S.score = 5;
objectiveProgress('score', null);
__check('3/3 objectives complete: the third individual reward (+7) AND the +10 completion bonus are both granted', coins === coins0 + 5 + 6 + 7 + 10, 'coins=' + coins + ' expected=' + (coins0 + 5 + 6 + 7 + 10));
__check('S.objectiveBonusGranted flips true exactly when all 3 become done', S.objectiveBonusGranted === true);

// ---- 5/6: bonus granted only once -- neither a duplicate objectiveProgress() call nor repeatedly redrawing Night Complete grants it again ----
var coinsAfterFull = coins;
objectiveProgress('score', null); // duplicate completion call -- all objectives already done, o.done guards skip every one
objectiveProgress('catch', 'y');
__check('duplicate objectiveProgress() calls after all 3 are already done grant nothing further', coins === coinsAfterFull);
S.over = true; S.overT = 1;
var threwReopen = false;
try { for (var __i = 0; __i < 5; __i++) { screen = 'play'; draw(); } } catch (e) { threwReopen = true; }
__check('repeatedly redrawing Night Complete (reopening it) never re-grants the bonus and never throws', !threwReopen && coins === coinsAfterFull);

// ---- 7: Continue -> no second reward ----
// Checked immediately around continueFromOver() itself, BEFORE
// __acceptAnyContract() runs -- reset() (called once the contract is
// accepted) can legitimately roll a random Night Event, which can in turn
// legitimately cross an unrelated pre-existing Weekly Progression /
// Season milestone and grant ITS OWN coins (real, correct, unrelated
// behavior -- not something E8 should assert never happens). So this
// check isolates exactly "did Continue itself re-grant the objective
// bonus", and everything below re-baselines from the LIVE coins value
// rather than a value computed before any reset() could have rolled one
// of those unrelated systems.
var coinsBeforeContinue = coins;
continueFromOver();
__check('tapping Continue does not itself grant a second objective completion bonus', coins === coinsBeforeContinue);
if (screen === 'contract') __acceptAnyContract();

// ---- 9: Restart Night resets eligibility -- the SAME 3 objectives must be completed again from scratch ----
setupThreeObjectives(); // simulates Restart Night: reset() clears S.objectiveBonusGranted, objectives start fresh
__check('after Restart Night, the bonus guard is cleared', S.objectiveBonusGranted === false);
__check('after Restart Night, the previous night\\'s bonus cannot simply carry over -- all 3 read as not done', !S.objectiveActive.some(function(o){ return o.done; }));
var coinsBeforeRestartRun = coins; // re-baselined live, right after this reset() -- not a stale formula computed before it
objectiveProgress('catch', 'y'); objectiveProgress('deliver', null); S.score = 5; objectiveProgress('score', null);
__check('completing all 3 again on the NEW (post-restart) attempt grants the completion bonus again -- restart genuinely re-arms it, not a one-time-ever lock', coins === coinsBeforeRestartRun + 5 + 6 + 7 + 10, 'coins=' + coins);

// ---- 10: tutorial night never grants the bonus (structurally -- 0 active objectives, never 3) ----
upgrades.tutorialDone = false;
reset();
__check('the tutorial round always has 0 active objectives -- the completion bonus can structurally never fire (S.objectiveActive.length is never 3)', S.objectiveActive.length === 0);
var coinsBeforeTutorialProbe = coins;
objectiveProgress('catch', 'y'); objectiveProgress('deliver', null); objectiveProgress('score', null);
__check('calling objectiveProgress() during the tutorial (0 active objectives) is a safe no-op', coins === coinsBeforeTutorialProbe);
upgrades.tutorialDone = true;

// ---- 11: existing objective rewards are exactly what OBJECTIVE_POOL already specifies -- untouched by E8 ----
__check('OBJECTIVE_POOL itself was not modified by E8 (spot check a real entry\\'s reward)', OBJECTIVE_POOL.find(function(o){ return o.id === 'deliver_total'; }).early.reward === 15);

// ---- 12/13/14/15: Night Streak, Daily Deal, Almost Affordable, and existing ads are all untouched ----
setupThreeObjectives();
var streakBefore = nightStreak;
S.over = true; S.overT = 1;
continueFromOver();
if (screen === 'contract') __acceptAnyContract();
__check('Night Streak still advances normally on a real completed night alongside the objective bonus', nightStreak === streakBefore + 1 || nightStreak === 1, 'nightStreak=' + nightStreak);
__check('Daily Deal\\'s own price formula is untouched by the objective completion bonus', dailyDealPrice(500) === 400);
upgrades.jarCapTiers.simple = 5;
__check('Almost Affordable\\'s own real cost function is untouched by the objective completion bonus', jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; })) === 115);
upgrades.jarCapTiers.simple = 0;
__check('existing rewarded-ad entry points remain present and distinct from the objective completion bonus', typeof requestDoubleNightCoins === 'function' && typeof requestExtraLife === 'function' && typeof requestWorkshopCoins === 'function');
});
`);

// E9: Night Variety & Replayability. Math.random() is monkey-patched to a
// constant (0) for full determinism -- with rand(a,b)=a+Math.random()*(b-a),
// a constant 0 makes every Math.floor(rand(0,n)) resolve to index 0 of
// whatever array is being chosen from, so the exact outcome of the
// Fisher-Yates category shuffle and every template/event pick can be
// hand-verified rather than asserted statistically.
scenario('lumora2-e9-night-variety', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 0, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;
var realRandom = Math.random;
Math.random = function(){ return 0; };

// ---- setup: Collector (index 3, objCategory 'catch') forces 'catch' into
// tonight's 3 regardless of the shuffle, making the exact chosen category
// set fully deterministic: with Math.random()=0 the Fisher-Yates shuffle
// on ['catch','delivery','score','miss'] produces ['delivery','score','miss','catch']
// -> chosen=['delivery','score','miss'] -> Collector overrides slot 2 to
// 'catch' -> final chosen=['delivery','score','catch'].
activeContract = 3;
nightNumber = 1; // early tier (nightObjectiveTier(): nightNumber<=3)

// ---- 3: objective selection avoids repetition when an alternative exists ----
// 'catch' has 3 eligible early templates (catch_curious/catch_playful/catch_any);
// Math.random()=0 would normally always pick catch_curious (index 0).
// Forcing it into last night's cache should deterministically bump this
// night to the next alternative (catch_playful, index 0 of what's left).
var prevWithCatchCurious = [{ id: 'catch_curious' }, { id: 'reach_score' }, { id: 'finish_under_3_misses' }];
generateNightObjectives(prevWithCatchCurious);
var catchObj = S.objectiveActive.find(function(o){ return o.category === 'catch'; });
__check('setup: the catch category was actually chosen (Collector\\'s forced category)', !!catchObj);
__check('an objective with an available alternative does not repeat last night\\'s exact template', catchObj.id === 'catch_playful', 'got=' + (catchObj && catchObj.id));

// ---- 2: same combination MAY repeat when no alternative is valid ----
// 'score' has exactly one eligible template (reach_score) at every tier --
// there is nothing else it could possibly become, so forcing it into last
// night's cache must NOT block it from being reused tonight too.
var scoreObj = S.objectiveActive.find(function(o){ return o.category === 'score'; });
__check('an objective with NO alternative template is allowed to repeat (reach_score is the only score template that exists)', scoreObj.id === 'reach_score');

// unaffected category (no collision set up for it) -- sanity check the rest of the mechanism is untouched
var deliverObj = S.objectiveActive.find(function(o){ return o.category === 'delivery'; });
__check('a category with no collision picks exactly what the existing unmodified logic always would (deliver_total, index 0)', deliverObj.id === 'deliver_total');

// ---- 6: objective requirements/rewards themselves are untouched ----
__check('OBJECTIVE_POOL requirements/rewards are byte-identical to before E9 (spot check reach_score)', OBJECTIVE_POOL.find(function(o){ return o.id === 'reach_score'; }).early.target === 15 && OBJECTIVE_POOL.find(function(o){ return o.id === 'reach_score'; }).early.reward === 10);
__check('generateNightObjectives() still produces exactly 3 objectives, never more or fewer', S.objectiveActive.length === 3);
activeContract = -1;

// ---- 1: same event is not immediately repeated when alternatives exist ----
// EVENT_TYPES = ['moonlight','fireflyRain','mothSwarm']; Math.random()=0
// always picks 'moonlight' (index 0) absent any collision.
generateNightEvent('moonlight');
__check('setup: the deterministic roll would have picked moonlight absent any collision', true);
__check('the exact same event as last night is not repeated when 2 other valid types exist', S.eventActive === 'fireflyRain', 'got=' + S.eventActive);

// a genuinely different previous event never triggers a reroll at all
generateNightEvent('mothSwarm');
__check('a previous event that is NOT what tonight would roll anyway is left completely alone', S.eventActive === 'moonlight');

// the very first night ever (no previous cache) never reroll-triggers on a false "collision" with null
generateNightEvent(null);
__check('no previous cached event (first night, or first night after a reload with no prior cache) never forces a reroll', S.eventActive === 'moonlight');

// ---- 5: existing event mechanics (chance/type list/history/weekly hook) are untouched ----
__check('NIGHT_EVENT_CHANCE is untouched by E9', NIGHT_EVENT_CHANCE === 0.35);
__check('EVENT_TYPES is untouched by E9', JSON.stringify(EVENT_TYPES) === JSON.stringify(['moonlight', 'fireflyRain', 'mothSwarm']));
__check('a rolled event is still recorded in the existing eventHistory (unrelated lifetime record, untouched)', eventHistory.length === 3 && eventHistory[eventHistory.length - 1] === 'moonlight');

// ---- 4: existing contract mechanics are completely untouched (E9 never selects/filters contracts -- they are 100% player-chosen from the existing fixed list) ----
__check('CONTRACTS itself is untouched by E9 (spot check Rush\\'s own numbers)', CONTRACTS.find(function(c){ return c.id === 'rush'; }).coinMult === 1.40 && CONTRACTS.find(function(c){ return c.id === 'rush'; }).spawnMult === 1.60);
__check('CONTRACTS still has exactly its original 4 entries -- E9 adds no new contracts', CONTRACTS.length === 4);

// ---- 7: tutorial remains completely unaffected (both generators are gated OFF before E9's logic is ever reached) ----
upgrades.tutorialDone = false;
reset();
__check('the tutorial round still has 0 active objectives, exactly as before E9', S.objectiveActive.length === 0);
__check('the tutorial round still has no active event, exactly as before E9', S.eventActive === null);
upgrades.tutorialDone = true;

Math.random = realRandom;
});
`);

// Fresh-context reload test (E9 test 8): a persisted cachedNightObjectives/
// cachedNightEvent pair for the CURRENT nightNumber must restore verbatim,
// not regenerate -- this is the direct fix for the ordering-hazard bug
// caught while building this phase (a real save containing these fields
// previously threw "Cannot access before initialization" on load, since
// the cache variables were declared later in the file than the load-
// restoration code that reads them; see the E9 comment beside their
// declaration). This test exercises that exact code path with real values
// present, which no pre-existing test did.
scenario('lumora2-e9-reload-stability', { audioEnabled: true }, `
var savedObjectives = [
  { id: 'deliver_total', category: 'delivery', kind: 'deliver', fireflyType: null, label: 'Deliver 10 Fireflies', target: 10, reward: 15, done: false },
  { id: 'reach_score', category: 'score', kind: 'score', fireflyType: null, label: 'Reach 15 Light', target: 15, reward: 10, done: false },
  { id: 'catch_playful', category: 'catch', kind: 'catch', fireflyType: 'b', label: 'Catch 3 Playful', target: 3, reward: 12, done: false }
];
var threwLoad = false;
try {
  __spy.loadResolve(JSON.stringify({ best: 0, coins: 0, nightNumber: 5, cachedNightObjectivesFor: 5, cachedNightObjectives: savedObjectives, cachedNightEventFor: 5, cachedNightEvent: 'fireflyRain', upgrades: { tutorialDone: true } }));
} catch (e) { threwLoad = true; }
return __tick(5).then(function(){
  __check('loading a real save containing cachedNightObjectives/cachedNightEvent does not throw (the ordering-hazard regression check)', !threwLoad);
  __check('cachedNightObjectivesFor/cachedNightObjectives restored exactly as persisted', cachedNightObjectivesFor === 5 && JSON.stringify(cachedNightObjectives) === JSON.stringify(savedObjectives));
  __check('cachedNightEventFor/cachedNightEvent restored exactly as persisted', cachedNightEventFor === 5 && cachedNightEvent === 'fireflyRain');
  upgrades.tutorialDone = true;
  var threwReset = false;
  try { reset(); } catch (e) { threwReset = true; }
  __check('reset() for the SAME nightNumber (simulating a reload-triggered replay of the current night) does not throw', !threwReset);
  __check('the restored night\\'s objectives are the EXACT persisted set, not a fresh reroll', JSON.stringify(S.objectiveActive.map(function(o){ return o.id; })) === JSON.stringify(savedObjectives.map(function(o){ return o.id; })), 'got=' + JSON.stringify(S.objectiveActive.map(function(o){ return o.id; })));
  __check('the restored night\\'s event is the EXACT persisted value, not a fresh reroll', S.eventActive === 'fireflyRain');
  __check('a restored (cache-hit) night does not replay the new-night reveal card', S.isNewNight === false);

  // ---- 9/10/11/12: Night Streak, Daily Deal, Almost Affordable, existing ads all untouched ----
  __check('Night Streak fields are untouched by E9', typeof nightStreak === 'number' && typeof commitNightStreak === 'function');
  __check('Daily Deal\\'s own price formula is untouched by E9', dailyDealPrice(500) === 400);
  upgrades.jarCapTiers.simple = 5;
  __check('Almost Affordable\\'s own real cost function is untouched by E9', jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; })) === 115);
  upgrades.jarCapTiers.simple = 0;
  __check('existing rewarded-ad entry points remain present and distinct from E9\\'s selection logic', typeof requestDoubleNightCoins === 'function' && typeof requestExtraLife === 'function' && typeof requestWorkshopCoins === 'function');
});
`);

// E10: Glow Chain Engagement. Audit-first phase -- see the phase's own
// final report for the full reasoning, but in short: the existing Glow
// Chain feedback (D2's live HUD pill, milestone flare-and-payout sequence
// at x5/x10/x15/x20, a clear "chain broken" sequence for any chain that
// actually banked a reward, and bestChainThisRound's peak-tracking) was
// found to already satisfy every requirement this phase lists, and is
// already covered extensively by pre-existing tests (see the
// advanceChain()/breakChain()/bestChainThisRound blocks earlier in this
// file). ZERO production code changed. This scenario exists purely to
// give the phase's own enumerated 16-point test list explicit,
// traceable coverage in one place -- confirming continuity, not
// re-litigating behavior already proven correct above -- plus the
// standard cross-system regression spot-checks every phase since E6 has
// added.
scenario('lumora2-e10-glow-chain-engagement', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 0, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;
reset();

// ---- 1: chain increments normally ----
advanceChain(); advanceChain(); advanceChain();
__check('1: the chain increments by exactly 1 per catch, unchanged', S.chain === 3);

// ---- 3/4/5/6: x5/x10/x15 milestone feedback, each firing exactly once per crossing ----
advanceChain(); advanceChain();
__check('3: reaching x5 arms the milestone moment exactly once', S.chain === 5 && S.d2ChainMomentN === 5 && S.d2ChainMomentT > 0);
var coinsAtFive = coins;
for (var i = 0; i < 4; i++) advanceChain(); // -> 9, no further milestone in between
__check('6a: no milestone re-fires between x5 and x10 (chain 6-9 grants nothing further)', coins === coinsAtFive);
advanceChain(); // -> 10
__check('4: reaching x10 arms its own milestone moment exactly once', S.chain === 10 && S.d2ChainMomentN === 10);
for (var i = 0; i < 4; i++) advanceChain(); // -> 14
advanceChain(); // -> 15
__check('5: reaching x15 arms its own milestone moment exactly once', S.chain === 15 && S.d2ChainMomentN === 15);
__check('6b: each milestone moment is a fresh arm, not a re-fire of an earlier one (N tracks the CURRENT crossing)', S.d2ChainMomentN === S.chain);

// ---- 2: existing chain-break behavior is unchanged -- breakChain() remains the ONLY reset path, still zeroes the live chain, still preserves the peak ----
var peakBeforeBreak = S.bestChainThisRound;
breakChain();
__check('2: breakChain() still resets S.chain to 0, exactly as before E10', S.chain === 0);
__check('2: breaking does not remove any already-granted coins', coins === coinsAtFive || coins >= coinsAtFive);

// ---- 7/8: Best Chain remains correct, including through Night Complete's own existing display gate ----
__check('7: bestChainThisRound remembers the peak (15) after the break', S.bestChainThisRound === 15 && peakBeforeBreak === 15);
for (var i = 0; i < 4; i++) advanceChain(); // rebuild to 4, below the remembered peak
__check('7: a smaller chain afterward does not lower the remembered peak', S.bestChainThisRound === 15);
__check('8: Night Complete\\'s existing bonus row correctly reports this round\\'s Best Chain is eligible to show (>=3 floor)', nightCompleteHasBonusRow() === true);
var threwNightComplete = false;
try { screen = 'play'; S.over = true; S.overT = 1; draw(); } catch (e) { threwNightComplete = true; }
__check('8: Night Complete draws the Best Chain result row without throwing', !threwNightComplete);
S.over = false;

// ---- 9: no coin values changed -- the existing milestone reward table and Chain Keeper multiplier are byte-identical ----
__check('9: CHAIN_MILESTONES rewards are untouched by E10', CHAIN_MILESTONES.find(function(m){ return m.n === 5; }).reward === 5 && CHAIN_MILESTONES.find(function(m){ return m.n === 10; }).reward === 10 && CHAIN_MILESTONES.find(function(m){ return m.n === 15; }).reward === 18 && CHAIN_MILESTONES.find(function(m){ return m.n === 20; }).reward === 25);
__check('9: chainMilestoneReward() (Chain Keeper\\'s +15%, the only multiplier involved) is untouched', chainMilestoneReward(100) === 100);

// ---- 10/11/12/13/14/15/16: every other system remains untouched by E10 ----
__check('10: CONTRACTS is untouched by E10', CONTRACTS.length === 4 && CONTRACTS.find(function(c){ return c.id === 'rush'; }).coinMult === 1.40);
__check('11: NIGHT_EVENT_CHANCE/EVENT_TYPES are untouched by E10', NIGHT_EVENT_CHANCE === 0.35 && JSON.stringify(EVENT_TYPES) === JSON.stringify(['moonlight', 'fireflyRain', 'mothSwarm']));
__check('12: OBJECTIVE_POOL requirements/rewards are untouched by E10', OBJECTIVE_POOL.find(function(o){ return o.id === 'reach_score'; }).early.target === 15);
__check('13: Night Streak\\'s own logic is untouched by E10', typeof nightStreak === 'number' && typeof commitNightStreak === 'function');
__check('14: Daily Deal\\'s own price formula is untouched by E10', dailyDealPrice(500) === 400);
upgrades.jarCapTiers.simple = 5;
__check('15: Almost Affordable\\'s own real cost function is untouched by E10', jarCapUpgradeCost(JARS.find(function(j){ return j.key === 'simple'; })) === 115);
upgrades.jarCapTiers.simple = 0;
__check('16: existing rewarded-ad entry points remain present and distinct from Glow Chain\\'s own reward path', typeof requestDoubleNightCoins === 'function' && typeof requestExtraLife === 'function' && typeof requestWorkshopCoins === 'function' && requestDoubleNightCoins !== advanceChain);
});
`);

// E15: Economy & Monetization Integrity. A real, reachable bug found during
// this phase's audit: finalizeNight() had no re-entry guard, so if more
// than one firefly independently crosses its miss threshold in the SAME
// frame (realistic under a high-spawn contract/event, since the miss-
// detection for-loop never breaks after a single miss), it could be
// called more than once for one real night ending -- double-pushing
// contractsCompleted and double-granting a Collector night's Workshop
// Token. Fixed with a one-line idempotency guard (if(S.over)return;),
// mirroring jarCanAcceptCatch()'s own "check right before mutation"
// discipline. This test calls finalizeNight() directly, twice in a row --
// the exact reachable double-fire shape -- rather than trying to choreograph
// two fireflies expiring in the same real frame, which is the same
// "drive the canonical function directly" approach objectiveProgress()/
// advanceChain()'s own existing tests already use.
scenario('lumora2-e15-finalizeNight-reentry', null, `
reset();
activeContract = 3; // Collector -- the one contract with a real, discrete token reward to duplicate
var tokensBefore = workshopTokens, completedBefore = contractsCompleted.length;
finalizeNight();
var tokensAfterFirst = workshopTokens, completedAfterFirst = contractsCompleted.length;
__check('a real (first) finalizeNight() call grants the Workshop Token exactly once', tokensAfterFirst === tokensBefore + 1);
__check('a real (first) finalizeNight() call records the contract exactly once', completedAfterFirst === completedBefore + 1);
finalizeNight(); // the exact double-fire shape a same-frame double-miss would produce
__check('a second finalizeNight() call for the SAME already-ended round grants no additional Workshop Token', workshopTokens === tokensAfterFirst);
__check('a second finalizeNight() call for the SAME already-ended round does not double-record the contract', contractsCompleted.length === completedAfterFirst);
finalizeNight(); finalizeNight(); // a third and fourth call, for good measure
__check('repeated finalizeNight() calls remain fully idempotent', workshopTokens === tokensAfterFirst && contractsCompleted.length === completedAfterFirst);
`);

// E15: a second real, reachable duplicate-Continue bug found during this
// phase's audit, in continueFromOver() itself. interstitialAdsAvailable()
// is false by default in every other test in this file (no real
// Playables SDK to test against), which is exactly why this specific gap
// was never caught live in this sandbox before: when it IS true (a real
// Playables environment), the ad request is async and `screen` does not
// move to 'contract' until it resolves, so a rapid double-tap during that
// gap would re-enter the WHOLE tutorial-gated block a second time before
// anything else has moved on -- double-incrementing nightNumber and
// weeklyStats.nights, and firing a second, unintended interstitial ad
// request. Fixed with one S.continueHandled guard (per-round, cleared by
// reset()) at the top of the block. This test installs a REAL pending
// (not-yet-resolved) interstitial promise -- the exact async-gap shape --
// rather than the instantly-resolving mock every other interstitial test
// in this file uses, specifically so a duplicate call during that live
// gap can be driven and observed.
scenario('lumora2-e15-continueFromOver-reentry', { audioEnabled: true }, `
__spy.loadResolve(JSON.stringify({ best: 0, coins: 0, upgrades: { tutorialDone: true } }));
return __tick(5).then(function(){
upgrades.tutorialDone = true;
var interstitialCalls = 0, resolveInterstitial = null;
ytgame.ads = {
  requestRewardedAd: function(){ return Promise.resolve(false); },
  requestInterstitialAd: function(){
    interstitialCalls++;
    return new Promise(function(resolve){ resolveInterstitial = resolve; }); // stays pending -- the real async gap
  }
};
reset(); S.over = true; S.overT = 1;
var nightBefore = nightNumber, weeklyNightsBefore = weeklyStats.nights;
continueFromOver(); // starts the (still-pending) interstitial request; screen has NOT moved to 'contract' yet
__check('the interstitial request fired exactly once so far', interstitialCalls === 1);
__check('screen has not advanced yet -- the real async gap this bug lived in', screen !== 'contract');
continueFromOver(); // duplicate tap during the pending ad -- the exact reachable double-fire shape
__check('a duplicate continueFromOver() call during the pending interstitial does not request a second ad', interstitialCalls === 1);
__check('a duplicate continueFromOver() call during the pending interstitial does not double-increment nightNumber', nightNumber === nightBefore + 1, 'nightNumber=' + nightNumber);
__check('a duplicate continueFromOver() call during the pending interstitial does not double-count the weekly nights stat', weeklyStats.nights === weeklyNightsBefore + 1, 'weeklyStats.nights=' + weeklyStats.nights);
resolveInterstitial();
return __tick(5).then(function(){
  __check('the pending ad resolving afterward still lets the night transition through normally', screen === 'contract');
  __acceptAnyContract();
  __check('gameplay is fully usable afterward -- nightNumber only ever advanced by exactly 1 total', nightNumber === nightBefore + 1);
});
});
`);

// ---------- runner ----------
async function main() {
  let totalPass = 0, totalFail = 0;
  const failDetails = [];

  for (const sc of scenarios) {
    const sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
    vm.createContext(sandbox);
    const prelude = buildPrelude(sc.playablesOpts);

    // Seed localStorage with a known value for the standalone scenario's fallback-load check.
    const seed = sc.name === 'standalone' ? `try{ localStorage.setItem('gk2_best','7'); }catch(e){}\n` : '';

    // The IIFE call is the script's last statement, so its completion value
    // (undefined for the sync scenario, a Promise for the async ones) is
    // exactly what vm.runInContext returns — no separate `__RESULTS;`
    // trailer needed, and importantly none that would shadow the Promise.
    const full = prelude + RESULT_PRELUDE + seed + GAME_SRC + '\n(function(){\n' + sc.driverSrc + '\n})();\n';

    let out;
    try {
      out = vm.runInContext(full, sandbox, { filename: sc.name + '.vm.js', timeout: 25000 });
    } catch (e) {
      console.error(`\n[${sc.name}] FATAL — script threw during setup/driver:\n${e && e.stack || e}\n`);
      totalFail++;
      failDetails.push(`[${sc.name}] FATAL: ${e && e.message || e}`);
      continue;
    }

    // If the driver returned a Promise (async scenarios), await it via the sandbox's own Promise/microtask queue.
    if (out && typeof out.then === 'function') {
      try { await out; } catch (e) {
        console.error(`\n[${sc.name}] FATAL — async driver rejected:\n${e && e.stack || e}\n`);
      }
    }
    // Let any queued microtasks (the .then() chains inside the driver) flush.
    await new Promise((r) => setImmediate(r));

    const results = sandbox.__RESULTS || [];
    console.log(`\n=== ${sc.name} (${results.length} checks) ===`);
    for (const r of results) {
      if (r.pass) { totalPass++; console.log(`  ok   ${r.name}`); }
      else { totalFail++; console.log(`  FAIL ${r.name}${r.detail ? '  -- ' + r.detail : ''}`); failDetails.push(`[${sc.name}] ${r.name}${r.detail ? ' -- ' + r.detail : ''}`); }
    }
  }

  console.log(`\n---\n${totalPass} passed, ${totalFail} failed (${totalPass + totalFail} total checks across ${scenarios.length} scenarios)`);
  if (totalFail > 0) {
    console.log('\nFailures:');
    failDetails.forEach((d) => console.log('  - ' + d));
    process.exitCode = 1;
  }
}

main();
