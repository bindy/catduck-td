/* 猫鸭塔防 · 守卫小鱼干（3D 版）
 * 玩法与数值与 2D 版一致；渲染换成 three.js（已转译为 ES2017 经典脚本）。
 * 小工具规范：ES2017 经典脚本，无内联事件，无外部资源，无联网，纯 Canvas WebGL。
 */
(function () {
  'use strict';

  var W = 720, H = 840;
  /* 2D 逻辑坐标 -> 世界坐标：40px = 1 单位 */
  function wx(x) { return (x - 360) / 40; }
  function wz(y) { return (y - 420) / 40; }
  function px(x) { return x * 40 + 360; }

  var canvas = document.getElementById('game');

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dist(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function loadBest() {
    try { return parseInt(window.localStorage.getItem('catduck-td-best') || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function saveBest(v) {
    try { window.localStorage.setItem('catduck-td-best', String(v)); } catch (e) { /* 存不了就只记本局 */ }
  }

  /* ---------- 音效（WebAudio 合成，无外部音频） ---------- */
  var audioCtx = null, muted = false;
  function beep(freq, dur, type, vol) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.08, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) { /* 没音频就静默 */ }
  }
  function sfx(name) {
    if (name === 'shoot') beep(620, 0.06, 'triangle', 0.05);
    else if (name === 'kill') beep(880, 0.12, 'sine', 0.08);
    else if (name === 'leak') beep(160, 0.3, 'sawtooth', 0.08);
    else if (name === 'build') beep(520, 0.1, 'sine', 0.08);
    else if (name === 'wave') beep(440, 0.15, 'square', 0.05);
    else if (name === 'duck') { beep(300, 0.12, 'square', 0.08); setTimeout(function () { beep(380, 0.12, 'square', 0.08); }, 120); }
  }

  /* ---------- 地图（逻辑坐标，与 2D 版一致） ---------- */
  var PATH = [
    { x: -30, y: 130 }, { x: 590, y: 130 }, { x: 590, y: 330 },
    { x: 130, y: 330 }, { x: 130, y: 530 }, { x: 590, y: 530 },
    { x: 590, y: 700 }, { x: 750, y: 700 }
  ];
  var FISH = { x: 665, y: 700 };
  var PADS = [
    { x: 180, y: 230 }, { x: 360, y: 230 }, { x: 540, y: 230 },
    { x: 180, y: 430 }, { x: 360, y: 430 }, { x: 540, y: 430 },
    { x: 180, y: 630 }, { x: 360, y: 630 }
  ];
  var PAD_R = 36;

  /* ---------- 塔（猫） ---------- */
  var TOWER_TYPES = {
    yarn:   { name: '橘猫', sub: '毛线球', cost: 50,  range: 115, dmg: 9,  rate: 2.2, color: '#f39c12', desc: '攻速快，射程短', proj: 'yarn' },
    pounce: { name: '狸花猫', sub: '扑击', cost: 100, range: 135, dmg: 20, rate: 0.9, color: '#8d6e63', desc: '溅射伤害，打一片', proj: 'paw', splash: 55 },
    ice:    { name: '白猫', sub: '冰爪', cost: 80,  range: 125, dmg: 5,  rate: 1.5, color: '#ecf0f1', desc: '冻住老鼠 40%', proj: 'snow', slow: 0.6, slowDur: 1.4 },
    snipe:  { name: '黑猫', sub: '狙击', cost: 150, range: 230, dmg: 60, rate: 0.45, color: '#2c3e50', desc: '射程远，伤害高', proj: 'dart' }
  };
  var TOWER_ORDER = ['yarn', 'pounce', 'ice', 'snipe'];

  function towerStat(type, level) {
    var t = TOWER_TYPES[type];
    return {
      range: t.range + (level - 1) * 14,
      dmg: Math.round(t.dmg * Math.pow(1.55, level - 1)),
      rate: t.rate
    };
  }
  function upgradeCost(type, level) {
    return Math.round(TOWER_TYPES[type].cost * 0.8 * level);
  }

  /* ---------- 敌（老鼠） ---------- */
  var ENEMY_TYPES = {
    normal:  { name: '田鼠',   hp: 30, speed: 42, reward: 6,   steal: 1, r: 15, color: '#9e9e9e' },
    fast:    { name: '疾行鼠', hp: 21, speed: 80, reward: 8,   steal: 1, r: 13, color: '#bcaaa4' },
    armored: { name: '铁甲鼠', hp: 66, speed: 26, reward: 14,  steal: 1, r: 17, color: '#78909c' },
    boss:    { name: '鼠王',   hp: 750, speed: 22, reward: 120, steal: 5, r: 26, color: '#5d4037' }
  };

  /* ---------- 状态 ---------- */
  var state;
  function resetState() {
    state = {
      started: false, over: false, paused: false, speed: 1,
      gold: 220, fish: 20, wave: 0, best: loadBest(),
      towers: [], enemies: [], projectiles: [], particles: [],
      spawnQueue: [], spawnTimer: 0, waveActive: false,
      autoCmd: false, autoTimer: 0, duckCd: 0, duck: null,
      selPad: -1, selTower: -1, eid: 0
    };
    PADS.forEach(function () { state.towers.push(null); });
  }
  resetState();

  /* ---------- 生成波次 ---------- */
  function buildWave(n) {
    var q = [];
    var count = Math.min(5 + n * 2, 42);
    var i, roll;
    for (i = 0; i < count; i++) {
      roll = Math.random();
      if (n >= 5 && roll < 0.2) q.push('armored');
      else if (n >= 3 && roll < 0.45) q.push('fast');
      else q.push('normal');
    }
    if (n % 5 === 0) q.push('boss');
    return q;
  }
  function startWave() {
    if (state.waveActive || state.over || !state.started) return;
    state.wave += 1;
    state.spawnQueue = buildWave(state.wave);
    state.spawnTimer = 0.5;
    state.waveActive = true;
    state.selPad = -1; state.selTower = -1;
    sfx('wave');
    refreshPanel(); refreshHUD(); refreshWaveBtn();
  }
  function waveCleared() {
    var bonus = 25 + state.wave * 3;
    state.gold += bonus;
    state.waveActive = false;
    if (state.wave > state.best) { state.best = state.wave; saveBest(state.best); }
    showToast('第 ' + state.wave + ' 波守住了！+' + bonus + ' 鱼干');
    refreshHUD(); refreshWaveBtn();
  }

  /* ---------- 造塔 / 升级 / 出售 ---------- */
  function buildTower(padIdx, type) {
    var t = TOWER_TYPES[type];
    if (state.towers[padIdx] || state.gold < t.cost) return false;
    state.gold -= t.cost;
    state.towers[padIdx] = { type: type, level: 1, cd: 0, angle: -Math.PI / 2 };
    sfx('build');
    burst(PADS[padIdx].x, PADS[padIdx].y, t.color);
    state.selPad = -1;
    refreshHUD(); refreshPanel();
    return true;
  }
  function upgradeTower(padIdx) {
    var tw = state.towers[padIdx];
    if (!tw || tw.level >= 3) return false;
    var cost = upgradeCost(tw.type, tw.level);
    if (state.gold < cost) return false;
    state.gold -= cost;
    tw.level += 1;
    sfx('build');
    burst(PADS[padIdx].x, PADS[padIdx].y, '#f1c40f');
    refreshHUD(); refreshPanel();
    return true;
  }
  function sellTower(padIdx) {
    var tw = state.towers[padIdx];
    if (!tw) return false;
    var spent = TOWER_TYPES[tw.type].cost;
    var l;
    for (l = 1; l < tw.level; l++) spent += upgradeCost(tw.type, l);
    state.gold += Math.round(spent * 0.7);
    state.towers[padIdx] = null;
    state.selTower = -1;
    refreshHUD(); refreshPanel();
    return true;
  }

  /* ---------- 鸭子 ---------- */
  function duckCharge() {
    if (state.duck || state.duckCd > 0 || !state.started || state.over) return;
    state.duck = { seg: 0, t: 0, hit: {}, x: PATH[0].x, y: PATH[0].y };
    state.duckCd = 25;
    sfx('duck');
  }
  function autoCommand(dt) {
    if (!state.autoCmd) return;
    state.autoTimer -= dt;
    if (state.autoTimer > 0) return;
    state.autoTimer = 2.5;
    var i, cheapest = null, cheapestCost = 1e9;
    TOWER_ORDER.forEach(function (k) {
      if (TOWER_TYPES[k].cost < cheapestCost) { cheapestCost = TOWER_TYPES[k].cost; cheapest = k; }
    });
    for (i = 0; i < PADS.length; i++) {
      if (!state.towers[i] && state.gold >= cheapestCost) {
        var pick = TOWER_ORDER[(state.wave + i) % TOWER_ORDER.length];
        if (state.gold >= TOWER_TYPES[pick].cost) { buildTower(i, pick); return; }
        buildTower(i, cheapest);
        return;
      }
    }
    var cands = [];
    for (i = 0; i < PADS.length; i++) {
      var tw = state.towers[i];
      if (tw && tw.level < 3 && state.gold >= upgradeCost(tw.type, tw.level)) cands.push(i);
    }
    if (cands.length) upgradeTower(cands[Math.floor(Math.random() * cands.length)]);
  }

  /* ---------- 特效数据（3D 里只画圆点粒子，文字走 DOM 提示） ---------- */
  function burst(x, y, color) {
    var i;
    for (i = 0; i < 8; i++) {
      state.particles.push({
        x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 30,
        life: 0.5, max: 0.5, color: color
      });
    }
  }
  function showToast(text) {
    var hint = $('panel-hint');
    hint.textContent = text;
    hint.classList.remove('hidden');
    setTimeout(function () { if (state.selPad < 0 && state.selTower < 0) refreshPanel(); }, 1800);
  }

  /* ---------- 战斗更新 ---------- */
  function spawnEnemy(type) {
    var base = ENEMY_TYPES[type];
    var hpMul = Math.pow(1.17, state.wave - 1);
    state.eid += 1;
    state.enemies.push({
      id: state.eid, type: type, name: base.name,
      x: PATH[0].x, y: PATH[0].y, wp: 1,
      hp: Math.round(base.hp * hpMul), maxHp: Math.round(base.hp * hpMul),
      speed: base.speed, reward: base.reward, steal: base.steal,
      r: base.r, color: base.color, dist: 0,
      slowUntil: 0, slowFactor: 1, flash: 0
    });
  }

  function update(dt) {
    var i, j, e, tw, st;
    /* 生成 */
    if (state.waveActive && state.spawnQueue.length) {
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0) {
        spawnEnemy(state.spawnQueue.shift());
        state.spawnTimer = Math.max(0.35, 0.9 - state.wave * 0.02);
      }
    }
    /* 敌人移动 */
    for (i = state.enemies.length - 1; i >= 0; i--) {
      e = state.enemies[i];
      var now = performance.now() / 1000;
      var sp = e.speed * (now < e.slowUntil ? e.slowFactor : 1);
      var tgt = PATH[e.wp];
      var d = dist(e.x, e.y, tgt.x, tgt.y);
      var step = sp * dt;
      if (d <= step) {
        e.x = tgt.x; e.y = tgt.y; e.wp += 1;
        if (e.wp >= PATH.length) {
          state.enemies.splice(i, 1);
          state.fish -= e.steal;
          sfx('leak');
          showToast('老鼠偷走了 ' + e.steal + ' 条鱼！');
          if (state.fish <= 0) { state.fish = 0; gameOver(); }
          refreshHUD();
          continue;
        }
      } else {
        e.x += (tgt.x - e.x) / d * step;
        e.y += (tgt.y - e.y) / d * step;
        e.dist += step;
      }
      if (e.flash > 0) e.flash -= dt;
    }
    /* 塔开火 */
    for (i = 0; i < PADS.length; i++) {
      tw = state.towers[i];
      if (!tw) continue;
      st = towerStat(tw.type, tw.level);
      tw.cd -= dt;
      var best = null, bestDist = -1;
      for (j = 0; j < state.enemies.length; j++) {
        e = state.enemies[j];
        if (dist(PADS[i].x, PADS[i].y, e.x, e.y) <= st.range && e.dist > bestDist) {
          best = e; bestDist = e.dist;
        }
      }
      if (best) {
        tw.angle = Math.atan2(best.y - PADS[i].y, best.x - PADS[i].x);
        if (tw.cd <= 0) {
          tw.cd = 1 / st.rate;
          state.projectiles.push({
            x: PADS[i].x, y: PADS[i].y, target: best,
            type: TOWER_TYPES[tw.type].proj, dmg: st.dmg,
            splash: TOWER_TYPES[tw.type].splash || 0,
            slow: TOWER_TYPES[tw.type].slow || 0,
            slowDur: TOWER_TYPES[tw.type].slowDur || 0,
            speed: 520
          });
          sfx('shoot');
        }
      }
    }
    /* 弹道 */
    for (i = state.projectiles.length - 1; i >= 0; i--) {
      var p = state.projectiles[i];
      if (!p.target || p.target.hp <= 0 || state.enemies.indexOf(p.target) === -1) {
        state.projectiles.splice(i, 1);
        continue;
      }
      var pd = dist(p.x, p.y, p.target.x, p.target.y);
      var pstep = p.speed * dt;
      if (pd <= pstep + 6) {
        hitEnemy(p.target, p.dmg, p);
        state.projectiles.splice(i, 1);
      } else {
        p.x += (p.target.x - p.x) / pd * pstep;
        p.y += (p.target.y - p.y) / pd * pstep;
      }
    }
    /* 鸭子冲锋 */
    if (state.duck) {
      var dk = state.duck;
      dk.t += dt * 1.6;
      var segFloat = dk.t * (PATH.length - 1);
      var seg = Math.floor(segFloat);
      if (seg >= PATH.length - 1) {
        state.duck = null;
      } else {
        var a = PATH[seg], b = PATH[seg + 1], f = segFloat - seg;
        dk.x = a.x + (b.x - a.x) * f;
        dk.y = a.y + (b.y - a.y) * f;
        for (j = state.enemies.length - 1; j >= 0; j--) {
          e = state.enemies[j];
          if (!dk.hit[e.id] && dist(dk.x, dk.y, e.x, e.y) < 70) {
            dk.hit[e.id] = true;
            hitEnemy(e, 80, null);
          }
        }
      }
    }
    if (state.duckCd > 0) state.duckCd -= dt;
    /* 粒子 */
    for (i = state.particles.length - 1; i >= 0; i--) {
      var pt = state.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) state.particles.splice(i, 1);
    }
    /* 波次结束 */
    if (state.waveActive && !state.spawnQueue.length && !state.enemies.length) {
      waveCleared();
    }
    autoCommand(dt);
  }

  function hitEnemy(e, dmg, p) {
    e.hp -= dmg;
    e.flash = 0.12;
    if (p && p.slow) {
      e.slowUntil = performance.now() / 1000 + p.slowDur;
      e.slowFactor = p.slow;
    }
    if (p && p.splash) {
      var i, o;
      for (i = state.enemies.length - 1; i >= 0; i--) {
        o = state.enemies[i];
        if (o !== e && dist(e.x, e.y, o.x, o.y) <= p.splash) {
          o.hp -= Math.round(dmg * 0.6);
          o.flash = 0.12;
          if (o.hp <= 0) killEnemy(i, o);
        }
      }
    }
    if (e.hp <= 0) {
      var idx = state.enemies.indexOf(e);
      if (idx !== -1) killEnemy(idx, e);
    }
  }
  function killEnemy(idx, e) {
    state.enemies.splice(idx, 1);
    state.gold += e.reward;
    burst(e.x, e.y, '#f1c40f');
    sfx('kill');
    refreshHUD();
  }

  function gameOver() {
    state.over = true;
    state.waveActive = false;
    if (state.wave > state.best) { state.best = state.wave; saveBest(state.best); }
    $('over-wave').textContent = state.wave;
    $('over-best').textContent = state.best;
    $('overlay-over').classList.remove('hidden');
    refreshWaveBtn();
  }

  /* ---------- 3D 场景 ---------- */
  var renderer = null, scene = null, camera = null, glOK = true;
  var padMeshes = [], towerGroups = [], pickList = [];
  var rangeRing = null, crown = null, duckGroup = null;
  var enemyBody = null, enemyEar = null, enemyNose = null, enemyShadow = null;
  var projMesh = null, partMesh = null;
  var MAX_ENEMY = 48, MAX_PROJ = 40, MAX_PART = 60;
  var dummy = null;
  var matCache = {};
  var tmpColor = null;

  function lambert(color) {
    if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
    return matCache[color];
  }
  function basic(color) {
    var k = 'b' + color;
    if (!matCache[k]) matCache[k] = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
    return matCache[k];
  }

  function buildCat(color) {
    var g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), lambert(color));
    body.scale.set(1, 0.82, 1);
    body.position.y = 0.45;
    g.add(body);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), lambert(color));
    head.position.set(0, 0.95, 0.1);
    g.add(head);
    var earGeo = new THREE.ConeGeometry(0.16, 0.32, 6);
    var earL = new THREE.Mesh(earGeo, lambert(color));
    earL.position.set(-0.24, 1.32, 0.08);
    earL.rotation.z = 0.25;
    g.add(earL);
    var earR = new THREE.Mesh(earGeo, lambert(color));
    earR.position.set(0.24, 1.32, 0.08);
    earR.rotation.z = -0.25;
    g.add(earR);
    var nose = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), lambert('#e75480'));
    nose.position.set(0, 0.9, 0.5);
    g.add(nose);
    var tail = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.09, 6, 10, Math.PI * 0.9), lambert(color));
    tail.position.set(-0.55, 0.55, -0.25);
    tail.rotation.set(0.3, 0.4, 0.9);
    g.add(tail);
    return g;
  }

  function buildDuck() {
    var g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), lambert('#ffd93b'));
    body.scale.set(1, 0.85, 1.25);
    body.position.y = 0.5;
    g.add(body);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 10), lambert('#ffd93b'));
    head.position.set(0, 1.05, 0.35);
    g.add(head);
    var beak = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), lambert('#f39c12'));
    beak.scale.set(1.2, 0.55, 0.9);
    beak.position.set(0, 1.0, 0.72);
    g.add(beak);
    var tuft = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 6), lambert('#ffd93b'));
    tuft.position.set(0, 1.45, 0.3);
    g.add(tuft);
    g.visible = false;
    return g;
  }

  function initGL() {
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    } catch (e) {
      glOK = false;
      return;
    }
    dummy = new THREE.Object3D();
    tmpColor = new THREE.Color();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#fdf6e3');
    scene.fog = new THREE.Fog(new THREE.Color('#fdf6e3'), 30, 55);

    var aspect = W / H;
    camera = new THREE.OrthographicCamera(-11.5 * aspect, 11.5 * aspect, 11.5, -11.5, 0.1, 100);
    camera.position.set(0, 20, 14);
    camera.lookAt(0, 0, 0.5);
    camera.updateProjectionMatrix();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8fce7a, 1.15));
    var sun = new THREE.DirectionalLight(0xfff2d9, 1.1);
    sun.position.set(6, 12, 4);
    scene.add(sun);

    /* 地面 */
    var ground = new THREE.Mesh(new THREE.BoxGeometry(19.5, 0.5, 22.5), lambert('#8fce7a'));
    ground.position.set(0, -0.25, 0);
    scene.add(ground);
    /* 草地斑点 */
    var i;
    for (i = 0; i < 40; i++) {
      var dot = new THREE.Mesh(new THREE.CircleGeometry(0.12 + Math.random() * 0.16, 8), basic('#a5dd8f'));
      dot.rotation.x = -Math.PI / 2;
      dot.position.set((Math.random() - 0.5) * 18, 0.01, (Math.random() - 0.5) * 21);
      scene.add(dot);
    }
    /* 路：按逻辑路径逐段铺 */
    for (i = 0; i < PATH.length - 1; i++) {
      var a = PATH[i], b = PATH[i + 1];
      var len = dist(a.x, a.y, b.x, b.y) / 40;
      var seg = new THREE.Mesh(new THREE.BoxGeometry(len + 0.4, 0.08, 1.35), lambert('#d9b380'));
      seg.position.set(wx((a.x + b.x) / 2), 0.04, wz((a.y + b.y) / 2));
      seg.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
      scene.add(seg);
    }
    /* 建造点 */
    PADS.forEach(function (p, idx) {
      var pad = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.0, 0.22, 20), lambert('#d7ccc8'));
      pad.position.set(wx(p.x), 0.11, wz(p.y));
      pad.userData.padIndex = idx;
      scene.add(pad);
      padMeshes.push(pad);
      pickList.push(pad);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.05, 6, 24), lambert('#a1887f'));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(wx(p.x), 0.24, wz(p.y));
      scene.add(ring);
      towerGroups.push(null);
    });
    /* 鱼堆 */
    var bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.6, 0.35, 16), lambert('#a1887f'));
    bowl.position.set(wx(FISH.x), 0.18, wz(FISH.y));
    scene.add(bowl);
    for (i = 0; i < 3; i++) {
      var fish = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), lambert('#90caf9'));
      fish.scale.set(1.5, 0.55, 0.8);
      fish.position.set(wx(FISH.x) - 0.35 + i * 0.35, 0.45 + i * 0.12, wz(FISH.y));
      fish.rotation.y = 0.5;
      scene.add(fish);
    }
    /* 射程圈 */
    rangeRing = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.0, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    rangeRing.rotation.x = -Math.PI / 2;
    rangeRing.position.y = 0.06;
    rangeRing.visible = false;
    scene.add(rangeRing);
    /* 鼠王皇冠 */
    crown = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.45, 4), lambert('#f1c40f'));
    crown.visible = false;
    scene.add(crown);
    /* 鸭子 */
    duckGroup = buildDuck();
    scene.add(duckGroup);
    /* 敌人：实例化 */
    enemyBody = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_ENEMY);
    enemyBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(enemyBody);
    enemyEar = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_ENEMY * 2);
    enemyEar.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(enemyEar);
    enemyNose = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_ENEMY);
    enemyNose.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(enemyNose);
    enemyShadow = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }), MAX_ENEMY);
    enemyShadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(enemyShadow);
    /* 弹道与粒子：实例化 */
    projMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PROJ);
    projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(projMesh);
    partMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PART);
    partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(partMesh);

    canvas.addEventListener('webglcontextlost', function (evt) {
      evt.preventDefault();
      showToast('3D 渲染中断了，请重新进入小工具');
    }, false);

    fitRenderer();
    window.addEventListener('resize', fitRenderer);
  }

  function fitRenderer() {
    if (!renderer) return;
    var w = canvas.clientWidth || W;
    var h = Math.round(w * H / W);
    renderer.setSize(w, h, false);
    var aspect = w / h;
    camera.left = -11.5 * aspect;
    camera.right = 11.5 * aspect;
    camera.updateProjectionMatrix();
  }

  /* ---------- 每帧同步 3D ---------- */
  var PROJ_COLOR = { yarn: '#e74c3c', paw: '#8d6e63', snow: '#aed6f1', dart: '#2c3e50' };

  function setInst(mesh, idx, x, y, z, sx, sy, sz, color) {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(idx, dummy.matrix);
    if (color) {
      tmpColor.set(color);
      mesh.setColorAt(idx, tmpColor);
    }
  }

  function syncScene() {
    var i, e, tw;
    /* 塔 */
    PADS.forEach(function (p, idx) {
      tw = state.towers[idx];
      if (tw && !towerGroups[idx]) {
        var g = buildCat(TOWER_TYPES[tw.type].color);
        g.userData.color = TOWER_TYPES[tw.type].color;
        g.position.set(wx(p.x), 0.2, wz(p.y));
        g.traverse(function (o) { o.userData.padIndex = idx; });
        scene.add(g);
        towerGroups[idx] = g;
        pickList.push(g);
      } else if (!tw && towerGroups[idx]) {
        scene.remove(towerGroups[idx]);
        var gi = pickList.indexOf(towerGroups[idx]);
        if (gi !== -1) pickList.splice(gi, 1);
        towerGroups[idx] = null;
      }
      if (towerGroups[idx]) {
        var g2 = towerGroups[idx];
        var want = TOWER_TYPES[tw.type].color;
        if (g2.userData.color !== want) {
          scene.remove(g2);
          var gi2 = pickList.indexOf(g2);
          if (gi2 !== -1) pickList.splice(gi2, 1);
          var g3 = buildCat(want);
          g3.position.set(wx(p.x), 0.2, wz(p.y));
          g3.traverse(function (o) { o.userData.padIndex = idx; });
          g3.userData.color = want;
          scene.add(g3);
          towerGroups[idx] = g3;
          pickList.push(g3);
        }
        g2.rotation.y = -tw.angle + Math.PI / 2;
        var sc = 1 + (tw.level - 1) * 0.14;
        g2.scale.set(sc, sc, sc);
        g2.userData.color = want;
      }
    });
    /* 射程圈 */
    if (state.selTower >= 0 && state.towers[state.selTower]) {
      var st = towerStat(state.towers[state.selTower].type, state.towers[state.selTower].level);
      rangeRing.visible = true;
      rangeRing.position.x = wx(PADS[state.selTower].x);
      rangeRing.position.z = wz(PADS[state.selTower].y);
      rangeRing.scale.set(st.range / 40, st.range / 40, 1);
    } else {
      rangeRing.visible = false;
    }
    /* 敌人 */
    var n = Math.min(state.enemies.length, MAX_ENEMY);
    var now = performance.now() / 1000;
    var bossVisible = false;
    for (i = 0; i < n; i++) {
      e = state.enemies[i];
      var r = e.r / 40;
      var ex = wx(e.x), ez = wz(e.y);
      var slowed = now < e.slowUntil;
      var bodyColor = e.flash > 0 ? '#ffffff' : (slowed ? '#aed6f1' : e.color);
      setInst(enemyBody, i, ex, 0.32 * r / 0.375, ez, r, r * 0.82, r, bodyColor);
      setInst(enemyEar, i * 2, ex - r * 0.45, 0.62 * r / 0.375, ez - r * 0.1, r * 0.32, r * 0.32, r * 0.32, e.color);
      setInst(enemyEar, i * 2 + 1, ex + r * 0.45, 0.62 * r / 0.375, ez - r * 0.1, r * 0.32, r * 0.32, r * 0.32, e.color);
      setInst(enemyNose, i, ex, 0.3 * r / 0.375, ez + r * 0.85, r * 0.12, r * 0.12, r * 0.12, '#e75480');
      setInst(enemyShadow, i, ex, 0.03, ez, r * 1.1, r * 1.1, r * 1.1, null);
      if (e.type === 'boss') {
        bossVisible = true;
        crown.visible = true;
        crown.position.set(ex, 0.32 * (r / 0.375) + r * 0.82 + 0.18, ez);
      }
    }
    enemyBody.count = n;
    enemyEar.count = n * 2;
    enemyNose.count = n;
    enemyShadow.count = n;
    enemyBody.instanceMatrix.needsUpdate = true;
    enemyEar.instanceMatrix.needsUpdate = true;
    enemyNose.instanceMatrix.needsUpdate = true;
    enemyShadow.instanceMatrix.needsUpdate = true;
    if (enemyBody.instanceColor) enemyBody.instanceColor.needsUpdate = true;
    if (enemyEar.instanceColor) enemyEar.instanceColor.needsUpdate = true;
    if (enemyNose.instanceColor) enemyNose.instanceColor.needsUpdate = true;
    if (!bossVisible) crown.visible = false;
    /* 弹道 */
    var pn = Math.min(state.projectiles.length, MAX_PROJ);
    for (i = 0; i < pn; i++) {
      var pr = state.projectiles[i];
      var pr2 = pr.type === 'paw' ? 0.16 : 0.11;
      setInst(projMesh, i, wx(pr.x), 0.7, wz(pr.y), pr2, pr2, pr2, PROJ_COLOR[pr.type] || '#ffffff');
    }
    projMesh.count = pn;
    projMesh.instanceMatrix.needsUpdate = true;
    if (projMesh.instanceColor) projMesh.instanceColor.needsUpdate = true;
    /* 粒子 */
    var qn = Math.min(state.particles.length, MAX_PART);
    for (i = 0; i < qn; i++) {
      var pt = state.particles[i];
      var s = 0.12 * clamp(pt.life / pt.max, 0.05, 1);
      setInst(partMesh, i, wx(pt.x), 0.6, wz(pt.y), s, s, s, pt.color);
    }
    partMesh.count = qn;
    partMesh.instanceMatrix.needsUpdate = true;
    if (partMesh.instanceColor) partMesh.instanceColor.needsUpdate = true;
    /* 鸭子 */
    if (state.duck) {
      duckGroup.visible = true;
      duckGroup.position.set(wx(state.duck.x), 0.2, wz(state.duck.y));
      duckGroup.rotation.y += 0.2;
    } else {
      duckGroup.visible = false;
    }
  }

  /* ---------- HUD 与面板 ---------- */
  function refreshHUD() {
    $('hud-wave').textContent = Math.max(1, state.wave);
    $('hud-gold').textContent = state.gold;
    $('hud-fish').textContent = state.fish;
    $('hud-best').textContent = state.best;
  }
  function refreshWaveBtn() {
    var b = $('btn-wave');
    if (state.over) { b.disabled = true; b.textContent = '游戏结束'; return; }
    if (state.waveActive) { b.disabled = true; b.textContent = '第 ' + state.wave + ' 波进行中…'; return; }
    b.disabled = false;
    b.textContent = '开始第 ' + (state.wave + 1) + ' 波';
  }
  var duckBtnEl = $('btn-duck'), duckBtnText = '';
  function refreshDuckBtn() {
    var b = duckBtnEl, txt;
    if (state.duck) { txt = '🦆 冲锋中…'; }
    else if (state.duckCd > 0) { txt = '🦆 冲锋冷却 ' + Math.ceil(state.duckCd) + 's'; }
    else { txt = '🦆 鸭子冲锋'; }
    if (txt !== duckBtnText) {
      duckBtnText = txt;
      b.textContent = txt;
      b.disabled = txt !== '🦆 鸭子冲锋';
    }
  }
  function refreshPanel() {
    var hint = $('panel-hint'), build = $('panel-build'), tower = $('panel-tower');
    hint.classList.add('hidden'); build.classList.add('hidden'); tower.classList.add('hidden');
    build.innerHTML = ''; tower.innerHTML = '';
    if (state.selPad >= 0 && !state.towers[state.selPad]) {
      build.classList.remove('hidden');
      TOWER_ORDER.forEach(function (k) {
        var t = TOWER_TYPES[k];
        var btn = document.createElement('button');
        btn.className = 'tower-btn';
        btn.disabled = state.gold < t.cost;
        btn.innerHTML = '<b>' + t.name + ' · ' + t.sub + '</b>' +
          '<span>' + t.desc + ' ｜ 射程 ' + t.range + ' ｜ 伤害 ' + t.dmg + '</span>' +
          '<span class="cost">🐟 ' + t.cost + ' 鱼干</span>';
        btn.addEventListener('click', function () { buildTower(state.selPad, k); });
        build.appendChild(btn);
      });
    } else if (state.selTower >= 0 && state.towers[state.selTower]) {
      tower.classList.remove('hidden');
      var tw = state.towers[state.selTower];
      var t = TOWER_TYPES[tw.type];
      var st = towerStat(tw.type, tw.level);
      var info = document.createElement('div');
      info.className = 'act-btn';
      info.innerHTML = '<b>' + t.name + ' · ' + t.sub + ' Lv' + tw.level + '</b>' +
        '<span>伤害 ' + st.dmg + ' ｜ 射程 ' + st.range + ' ｜ 攻速 ' + st.rate + '/秒</span>';
      tower.appendChild(info);
      if (tw.level < 3) {
        var up = document.createElement('button');
        up.className = 'act-btn';
        var uc = upgradeCost(tw.type, tw.level);
        up.disabled = state.gold < uc;
        up.innerHTML = '<b>⬆️ 升级到 Lv' + (tw.level + 1) + '</b><span class="cost">🐟 ' + uc + ' 鱼干</span>';
        up.addEventListener('click', function () { upgradeTower(state.selTower); });
        tower.appendChild(up);
      }
      var sell = document.createElement('button');
      sell.className = 'act-btn';
      sell.innerHTML = '<b>💰 出售</b><span>返还 70% 鱼干</span>';
      sell.addEventListener('click', function () { sellTower(state.selTower); });
      tower.appendChild(sell);
    } else {
      hint.classList.remove('hidden');
      hint.textContent = '点一块空地，造一只猫塔';
    }
  }

  /* ---------- 输入（射线点选） ---------- */
  var raycaster = null, pointerNDC = null;
  function onCanvasTap(evt) {
    if (!state.started || state.over || !glOK || !raycaster) return;
    var rect = canvas.getBoundingClientRect();
    pointerNDC.set(
      ((evt.clientX - rect.left) / rect.width) * 2 - 1,
      -((evt.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointerNDC, camera);
    var hits = raycaster.intersectObjects(pickList, true);
    var i;
    for (i = 0; i < hits.length; i++) {
      var o = hits[i].object;
      while (o && o.userData.padIndex === undefined) o = o.parent;
      if (o && o.userData.padIndex !== undefined) {
        var idx = o.userData.padIndex;
        if (state.towers[idx]) { state.selTower = idx; state.selPad = -1; }
        else { state.selPad = idx; state.selTower = -1; }
        refreshPanel();
        return;
      }
    }
    state.selPad = -1; state.selTower = -1;
    refreshPanel();
  }

  $('btn-start').addEventListener('click', function () {
    state.started = true;
    $('overlay-start').classList.add('hidden');
    refreshHUD(); refreshWaveBtn(); refreshPanel();
  });
  $('btn-restart').addEventListener('click', function () {
    resetState();
    state.started = true;
    $('overlay-over').classList.add('hidden');
    refreshHUD(); refreshWaveBtn(); refreshPanel(); refreshDuckBtn();
  });
  $('btn-wave').addEventListener('click', startWave);
  $('btn-pause').addEventListener('click', function () {
    if (!state.started || state.over) return;
    state.paused = !state.paused;
    $('btn-pause').textContent = state.paused ? '继续' : '暂停';
  });
  $('btn-speed').addEventListener('click', function () {
    state.speed = state.speed === 1 ? 2 : 1;
    $('btn-speed').textContent = '速度 ' + state.speed + 'x';
  });
  $('btn-auto').addEventListener('click', function () {
    state.autoCmd = !state.autoCmd;
    $('btn-auto').textContent = '自动指挥：' + (state.autoCmd ? '开' : '关');
    $('btn-auto').classList.toggle('on', state.autoCmd);
    if (state.autoCmd) showToast('鸭子接管指挥！');
  });
  $('btn-duck').addEventListener('click', duckCharge);
  $('btn-sound').addEventListener('click', function () {
    muted = !muted;
    $('btn-sound').textContent = muted ? '🔇 已静音' : '🔊 音效';
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.started && !state.over && !state.paused) {
      state.paused = true;
      $('btn-pause').textContent = '继续';
    }
  });

  /* ---------- 主循环 ---------- */
  var last = performance.now();
  var frameEMA = 16, slowFrames = 0, degraded = false;
  function loop(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state.started && !state.over && !state.paused) {
      update(dt * state.speed);
    }
    if (glOK) {
      syncScene();
      renderer.render(scene, camera);
      /* 自动降档：持续掉帧就把像素比降到 1 */
      frameEMA = frameEMA * 0.95 + dt * 1000 * 0.05;
      if (!degraded && frameEMA > 45) {
        slowFrames += 1;
        if (slowFrames > 90) {
          degraded = true;
          renderer.setPixelRatio(1);
        }
      } else {
        slowFrames = 0;
      }
    }
    refreshDuckBtn();
    requestAnimationFrame(loop);
  }

  /* ---------- 启动 ---------- */
  (function init() {
    if (typeof THREE === 'undefined') {
      glOK = false;
      showToast('3D 引擎没加载出来，请重新进入');
      return;
    }
    raycaster = new THREE.Raycaster();
    pointerNDC = new THREE.Vector2();
    initGL();
    if (glOK) {
      canvas.addEventListener('click', onCanvasTap);
    } else {
      showToast('这台设备不支持 WebGL，玩不了 3D 版');
    }
    refreshHUD(); refreshWaveBtn(); refreshPanel();
    requestAnimationFrame(loop);
  })();
})();
