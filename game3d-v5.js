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


  /* ---------- 3D 场景（卡通渲染版） ---------- */
  var renderer = null, scene = null, camera = null, glOK = true;
  var padMeshes = [], towerGroups = [], pickList = [];
  var rangeRing = null, crown = null, duckGroup = null, duckShadow = null;
  var enemyMesh = null, enemyShadow = null;
  var projMesh = null, partMesh = null;
  var towerShadowMesh = null, starMesh = null, cloudMesh = null;
  var sunLight = null, pondTex = null, pondCtx = null, pondTimer = 0;
  var sparkleMesh = null, cloudShadowMeshes = [], pollenMesh = null, pollenSeeds = [];
  var shadowOff = false, shadowFrames = 0;
  var POND = { x: -6.8, z: 8.9, r: 2.3 };
  var MAX_ENEMY = 48, MAX_PROJ = 40, MAX_PART = 60;
  var dummy = null, tmpColor = null;
  var toonGradient = null, toonMat = null;
  var catGeos = {};
  var cloudBases = [];

  /* 给几何体刷上顶点色（合并后靠顶点色区分部件） */
  function colorize(geo, color) {
    var c = new THREE.Color(color);
    var n = geo.attributes.position.count;
    var arr = new Float32Array(n * 3);
    var i;
    for (i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  }
  function mergeParts(parts) {
    return THREE.mergeGeometries(parts, false);
  }
  function toonMaterial() {
    if (!toonMat) {
      if (!toonGradient) {
        var data = new Uint8Array([90, 150, 205, 255]);
        toonGradient = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
        toonGradient.minFilter = THREE.NearestFilter;
        toonGradient.magFilter = THREE.NearestFilter;
        toonGradient.needsUpdate = true;
      }
      toonMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient });
    }
    return toonMat;
  }
  function lambert(color) {
    return new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
  }

  /* 程序纹理：纯代码画的草地 / 泥土，没有任何外部图片 */
  function canvasTexture(size, draw) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    draw(c.getContext('2d'), size);
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  function grassTexture() {
    return canvasTexture(256, function (g, s) {
      g.fillStyle = '#79c25f'; g.fillRect(0, 0, s, s);
      var i, x, y;
      for (i = 0; i < 900; i++) {
        x = Math.random() * s; y = Math.random() * s;
        g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,80,0,0.08)';
        g.fillRect(x, y, 2, 2);
      }
      g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1.5;
      for (i = 0; i < 90; i++) {
        x = Math.random() * s; y = Math.random() * s;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + 2, y - 6); g.stroke();
      }
    });
  }
  function dirtTexture() {
    return canvasTexture(256, function (g, s) {
      g.fillStyle = '#d9a86c'; g.fillRect(0, 0, s, s);
      var i, x, y, r;
      for (i = 0; i < 500; i++) {
        x = Math.random() * s; y = Math.random() * s; r = 1 + Math.random() * 3;
        g.fillStyle = Math.random() < 0.5 ? 'rgba(120,70,20,0.12)' : 'rgba(255,240,200,0.12)';
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      for (i = 0; i < 40; i++) {
        x = Math.random() * s; y = Math.random() * s;
        g.strokeStyle = 'rgba(120,70,20,0.15)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + 6, y + 3); g.stroke();
      }
    });
  }

  /* ---------- 模型：每个角色先拼零件再合并成一个几何体 ---------- */
  function sphere(r, w, h, color, x, y, z, sx, sy, sz) {
    var g = new THREE.SphereGeometry(r, w || 12, h || 10);
    g.scale(sx || 1, sy || 1, sz || 1);
    g.translate(x, y, z);
    return colorize(g, color);
  }
  function cone(r, h, color, x, y, z, rx, ry, rz) {
    var g = new THREE.ConeGeometry(r, h, 8);
    g.rotateX(rx || 0); g.rotateY(ry || 0); g.rotateZ(rz || 0);
    g.translate(x, y, z);
    return colorize(g, color);
  }
  function torus(r, t, color, x, y, z, rx, ry, rz, arc) {
    var g = new THREE.TorusGeometry(r, t, 6, 12, arc || Math.PI * 0.9);
    g.rotateX(rx || 0); g.rotateY(ry || 0); g.rotateZ(rz || 0);
    g.translate(x, y, z);
    return colorize(g, color);
  }
  function cyl(rt, rb, h, color, x, y, z) {
    var g = new THREE.CylinderGeometry(rt, rb, h, 10);
    g.translate(x, y, z);
    return colorize(g, color);
  }

  /* 猫：大头圆身 + 粉色内耳 + 眼睛 + 腮红，4 种颜色各一个几何体 */
  function catGeometry(color) {
    if (catGeos[color]) return catGeos[color];
    var dark = '#333333', pink = '#f7a8b8';
    var parts = [
      sphere(0.55, 14, 12, color, 0, 0.45, 0, 1, 0.85, 1),
      sphere(0.46, 14, 12, color, 0, 1.0, 0.08),
      cone(0.17, 0.34, color, -0.26, 1.38, 0.06, 0, 0, 0.28),
      cone(0.17, 0.34, color, 0.26, 1.38, 0.06, 0, 0, -0.28),
      cone(0.09, 0.18, pink, -0.26, 1.34, 0.12, 0, 0, 0.28),
      cone(0.09, 0.18, pink, 0.26, 1.34, 0.12, 0, 0, -0.28),
      sphere(0.06, 8, 6, dark, -0.17, 1.05, 0.5),
      sphere(0.06, 8, 6, dark, 0.17, 1.05, 0.5),
      sphere(0.07, 8, 6, '#e75480', 0, 0.96, 0.52, 1, 0.7, 0.6),
      sphere(0.09, 8, 6, pink, -0.3, 0.92, 0.42, 1, 0.6, 0.5),
      sphere(0.09, 8, 6, pink, 0.3, 0.92, 0.42, 1, 0.6, 0.5),
      torus(0.42, 0.09, color, -0.58, 0.55, -0.28, 0.3, 0.4, 0.9)
    ];
    var geo = mergeParts(parts);
    catGeos[color] = geo;
    return geo;
  }
  function buildCat(color) {
    var m = new THREE.Mesh(catGeometry(color), toonMaterial());
    return m;
  }

  /* 鸭子：圆身 + 大头 + 扁喙 + 小翅膀 */
  function duckGeometry() {
    var parts = [
      sphere(0.55, 14, 12, '#ffd93b', 0, 0.5, 0, 1, 0.85, 1.25),
      sphere(0.4, 14, 12, '#ffd93b', 0, 1.08, 0.32),
      sphere(0.2, 10, 8, '#f39c12', 0, 1.02, 0.72, 1.2, 0.55, 0.9),
      sphere(0.06, 8, 6, '#333333', -0.15, 1.14, 0.66),
      sphere(0.06, 8, 6, '#333333', 0.15, 1.14, 0.66),
      sphere(0.09, 8, 6, '#f7a8b8', -0.3, 1.0, 0.55, 1, 0.6, 0.5),
      sphere(0.09, 8, 6, '#f7a8b8', 0.3, 1.0, 0.55, 1, 0.6, 0.5),
      cone(0.12, 0.3, '#ffd93b', 0, 1.48, 0.28),
      sphere(0.3, 10, 8, '#f2c230', -0.52, 0.55, -0.05, 0.5, 0.9, 1.1),
      sphere(0.3, 10, 8, '#f2c230', 0.52, 0.55, -0.05, 0.5, 0.9, 1.1)
    ];
    return mergeParts(parts);
  }
  function buildDuck() {
    var m = new THREE.Mesh(duckGeometry(), toonMaterial());
    m.visible = false;
    return m;
  }

  /* 老鼠：圆身 + 大圆耳 + 粉鼻 + 细尾巴（实例化用，颜色靠 instanceColor 微调） */
  function mouseGeometry() {
    var parts = [
      sphere(0.5, 12, 10, '#ffffff', 0, 0.32, 0, 1, 0.8, 1.15),
      sphere(0.2, 10, 8, '#ffffff', -0.3, 0.62, -0.05, 1, 1, 0.4),
      sphere(0.2, 10, 8, '#ffffff', 0.3, 0.62, -0.05, 1, 1, 0.4),
      sphere(0.11, 8, 6, '#f7a8b8', -0.3, 0.62, 0.14, 1, 1, 0.4),
      sphere(0.11, 8, 6, '#f7a8b8', 0.3, 0.62, 0.14, 1, 1, 0.4),
      sphere(0.08, 8, 6, '#e75480', 0, 0.3, 0.55, 1, 0.7, 0.6),
      sphere(0.05, 8, 6, '#333333', -0.14, 0.4, 0.48),
      sphere(0.05, 8, 6, '#333333', 0.14, 0.4, 0.48),
      torus(0.35, 0.045, '#b0a090', 0, 0.22, -0.62, Math.PI / 2.3, 0, 0, Math.PI * 1.1)
    ];
    return mergeParts(parts);
  }

  /* 装饰：树 / 花 / 灌木 / 云 / 石头，全部合并成单几何体后实例化 */
  function treeGeometry() {
    return mergeParts([
      cyl(0.16, 0.22, 0.7, '#8d6e63', 0, 0.35, 0),
      sphere(0.75, 12, 10, '#5da24a', 0, 1.25, 0),
      sphere(0.55, 12, 10, '#6fbf5a', 0.25, 1.75, 0.1),
      sphere(0.4, 10, 8, '#f2a541', 0.55, 1.1, 0.35),
      sphere(0.4, 10, 8, '#f2a541', -0.5, 1.35, 0.3)
    ]);
  }
  function flowerGeometry() {
    return mergeParts([
      cyl(0.03, 0.03, 0.35, '#4e9a3d', 0, 0.17, 0),
      sphere(0.13, 8, 6, '#ffffff', 0, 0.4, 0)
    ]);
  }
  function bushGeometry() {
    return mergeParts([
      sphere(0.5, 10, 8, '#5da24a', 0, 0.3, 0),
      sphere(0.35, 10, 8, '#6fbf5a', 0.4, 0.22, 0.1),
      sphere(0.3, 10, 8, '#6fbf5a', -0.38, 0.2, -0.05)
    ]);
  }
  function cloudGeometry() {
    return mergeParts([
      sphere(0.7, 10, 8, '#ffffff', 0, 0, 0, 1.4, 0.75, 1),
      sphere(0.5, 10, 8, '#ffffff', -0.7, -0.05, 0.1),
      sphere(0.45, 10, 8, '#ffffff', 0.7, -0.08, -0.05)
    ]);
  }
  function rockGeometry() {
    return mergeParts([
      sphere(0.4, 8, 6, '#b0bec5', 0, 0.16, 0, 1.2, 0.55, 1),
      sphere(0.25, 8, 6, '#90a4ae', 0.35, 0.1, 0.15, 1, 0.5, 0.9)
    ]);
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
    scene.background = new THREE.Color('#ffeecf');
    scene.fog = new THREE.Fog(new THREE.Color('#ffeecf'), 32, 58);

    var aspect = W / H;
    camera = new THREE.OrthographicCamera(-11.5 * aspect, 11.5 * aspect, 11.5, -11.5, 0.1, 100);
    camera.position.set(0, 19, 15);
    camera.lookAt(0, 0, 0.5);
    camera.updateProjectionMatrix();

    scene.add(new THREE.HemisphereLight(0xfff6e0, 0x7fb35a, 1.25));
    sunLight = new THREE.DirectionalLight(0xfff2d9, 1.25);
    sunLight.position.set(8, 9, 5);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.left = -13;
    sunLight.shadow.camera.right = 13;
    sunLight.shadow.camera.top = 13;
    sunLight.shadow.camera.bottom = -13;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 40;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);
    scene.add(sunLight.target);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    /* 地面：程序草地纹理 */
    var grassTex = grassTexture();
    grassTex.repeat.set(4, 4);
    var ground = new THREE.Mesh(
      new THREE.BoxGeometry(19.5, 0.5, 22.5),
      new THREE.MeshLambertMaterial({ map: grassTex })
    );
    ground.position.set(0, -0.25, 0);
    ground.receiveShadow = true;
    scene.add(ground);
    /* 路：程序泥土纹理 */
    var dirtTex = dirtTexture();
    var i;
    for (i = 0; i < PATH.length - 1; i++) {
      var a = PATH[i], b = PATH[i + 1];
      var len = dist(a.x, a.y, b.x, b.y) / 40;
      var seg = new THREE.Mesh(
        new THREE.BoxGeometry(len + 0.4, 0.08, 1.35),
        new THREE.MeshLambertMaterial({ map: dirtTex })
      );
      seg.position.set(wx((a.x + b.x) / 2), 0.04, wz((a.y + b.y) / 2));
      seg.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
      seg.receiveShadow = true;
      scene.add(seg);
    }
    /* 建造点：石墩 + 描边圆环 */
    PADS.forEach(function (p, idx) {
      var pad = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 0.22, 20), lambert('#e8e0d0'));
      pad.position.set(wx(p.x), 0.11, wz(p.y));
      pad.userData.padIndex = idx;
      pad.receiveShadow = true;
      scene.add(pad);
      padMeshes.push(pad);
      pickList.push(pad);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.06, 6, 24), lambert('#c9b8a3'));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(wx(p.x), 0.24, wz(p.y));
      scene.add(ring);
      towerGroups.push(null);
    });
    /* 鱼堆：碗 + 3 条小鱼 */
    var bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.6, 0.35, 16), lambert('#b08968'));
    bowl.position.set(wx(FISH.x), 0.18, wz(FISH.y));
    bowl.castShadow = true;
    scene.add(bowl);
    for (i = 0; i < 3; i++) {
      var fish = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), lambert('#7fc4f5'));
      fish.scale.set(1.5, 0.55, 0.8);
      fish.position.set(wx(FISH.x) - 0.35 + i * 0.35, 0.45 + i * 0.12, wz(FISH.y));
      fish.rotation.y = 0.5;
      fish.castShadow = true;
      scene.add(fish);
    }
    /* 池塘：左下角，水面涟漪是逐帧重画的程序纹理 */
    var pondCanvas = document.createElement('canvas');
    pondCanvas.width = 256; pondCanvas.height = 256;
    pondCtx = pondCanvas.getContext('2d');
    pondTex = new THREE.CanvasTexture(pondCanvas);
    pondTex.colorSpace = THREE.SRGBColorSpace;
    var pond = new THREE.Mesh(
      new THREE.CircleGeometry(POND.r, 32),
      new THREE.MeshLambertMaterial({ map: pondTex, transparent: true, opacity: 0.96, emissive: new THREE.Color('#1a4a6a'), emissiveIntensity: 0.25 })
    );
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(POND.x, 0.05, POND.z);
    pond.receiveShadow = true;
    scene.add(pond);
    var bank = new THREE.Mesh(new THREE.TorusGeometry(POND.r, 0.14, 6, 32), lambert('#d9c9a8'));
    bank.rotation.x = Math.PI / 2;
    bank.position.set(POND.x, 0.06, POND.z);
    bank.receiveShadow = true;
    scene.add(bank);
    /* 荷叶 + 荷花 */
    var lilySpots = [[-7.4, 9.3, 0.45], [-6.2, 8.5, 0.35], [-7.0, 8.2, 0.3]];
    lilySpots.forEach(function (s) {
      var lily = new THREE.Mesh(new THREE.CircleGeometry(s[2], 16), lambert('#4e9a3d'));
      lily.rotation.x = -Math.PI / 2;
      lily.position.set(s[0], 0.07, s[1]);
      scene.add(lily);
    });
    var lotus = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), lambert('#ff8fab'));
    lotus.scale.set(1, 0.6, 1);
    lotus.position.set(-6.2, 0.14, 8.5);
    scene.add(lotus);
    /* 芦苇：围着池塘边 */
    var reedParts = [];
    var reedSpots = [[-4.8, 10.05], [-7.2, 11.16], [-8.95, 9.68], [-9.55, 7.41], [-6.4, 6.64], [-4.6, 8.1]];
    reedSpots.forEach(function (s) {
      reedParts.push(cyl(0.035, 0.035, 1.2, '#4e9a3d', s[0], 0.6, s[1]));
      reedParts.push(cyl(0.09, 0.09, 0.35, '#8d6e63', s[0], 1.3, s[1]));
    });
    var reeds = new THREE.Mesh(mergeParts(reedParts), toonMaterial());
    reeds.castShadow = true;
    scene.add(reeds);
    /* 水面闪光 */
    var sparkleSpots = [[-7.8, 9.3], [-6.2, 9.0], [-7.0, 8.6], [-5.9, 9.2], [-7.4, 8.3], [-6.6, 9.5]];
    sparkleMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }), sparkleSpots.length);
    sparkleSpots.forEach(function (s, k) {
      dummy.position.set(s[0], 0.09, s[1]);
      dummy.scale.set(0.08, 0.08, 0.08);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      sparkleMesh.setMatrixAt(k, dummy.matrix);
    });
    scene.add(sparkleMesh);
    /* 飘动的云影：大片淡淡的影子慢慢划过草地 */
    var cloudShadowZ = [-4, 1, 6];
    cloudShadowZ.forEach(function (z) {
      var cs = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.09 }));
      cs.rotation.x = -Math.PI / 2;
      cs.scale.set(2.6, 1.6, 1);
      cs.position.set(-12, 0.06, z);
      scene.add(cs);
      cloudShadowMeshes.push(cs);
    });
    /* 漂浮的光尘 */
    pollenMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }), 14);
    for (i = 0; i < 14; i++) {
      pollenSeeds.push({
        x: -9 + Math.random() * 18, y: 0.8 + Math.random() * 2.6, z: -10 + Math.random() * 20,
        ph: Math.random() * Math.PI * 2, sp: 0.15 + Math.random() * 0.25
      });
    }
    scene.add(pollenMesh);
    drawPond(0);
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
    duckGroup.traverse(function (o) { o.castShadow = true; });
    scene.add(duckGroup);
    duckShadow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 }));
    duckShadow.rotation.x = -Math.PI / 2;
    duckShadow.position.y = 0.03;
    duckShadow.visible = false;
    scene.add(duckShadow);
    /* 敌人：合并后的老鼠几何体，实例化 */
    enemyMesh = new THREE.InstancedMesh(mouseGeometry(), toonMaterial(), MAX_ENEMY);
    enemyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    enemyMesh.castShadow = true;
    scene.add(enemyMesh);
    enemyShadow = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 }), MAX_ENEMY);
    enemyShadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(enemyShadow);
    /* 塔下影子 */
    towerShadowMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 }), PADS.length);
    towerShadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(towerShadowMesh);
    /* 等级小星星 */
    starMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: 0xffd93b }), PADS.length * 2);
    starMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(starMesh);
    /* 弹道与粒子 */
    projMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PROJ);
    projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(projMesh);
    partMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PART);
    partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(partMesh);

    /* 场景装饰：树 / 花 / 灌木 / 石头（手摆位置，避开路和建造点） */
    var treeSpots = [[-8.7, -10], [8.7, -10], [-8.7, -4.5], [8.7, -0.5], [-9.2, 5.5], [8.7, 10]];
    var treeMesh = new THREE.InstancedMesh(treeGeometry(), toonMaterial(), treeSpots.length);
    treeMesh.castShadow = true;
    treeSpots.forEach(function (s, k) {
      dummy.position.set(s[0], 0, s[1]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, k * 1.1, 0);
      dummy.updateMatrix();
      treeMesh.setMatrixAt(k, dummy.matrix);
    });
    scene.add(treeMesh);
    var bushSpots = [[-8.6, 6.5], [8.6, 6.8], [-8.6, -7.8], [8.6, -7.6], [-2.5, -10.2], [3.5, 10.4]];
    var bushMesh = new THREE.InstancedMesh(bushGeometry(), toonMaterial(), bushSpots.length);
    bushMesh.castShadow = true;
    bushSpots.forEach(function (s, k) {
      dummy.position.set(s[0], 0, s[1]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, k * 0.7, 0);
      dummy.updateMatrix();
      bushMesh.setMatrixAt(k, dummy.matrix);
    });
    scene.add(bushMesh);
    var rockSpots = [[-2.8, 10.5], [6.9, -4.2], [-8.9, 2.8], [8.9, 9.6], [2.2, -10.3]];
    var rockMesh = new THREE.InstancedMesh(rockGeometry(), toonMaterial(), rockSpots.length);
    rockMesh.castShadow = true;
    rockSpots.forEach(function (s, k) {
      dummy.position.set(s[0], 0, s[1]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, k * 1.3, 0);
      dummy.updateMatrix();
      rockMesh.setMatrixAt(k, dummy.matrix);
    });
    scene.add(rockMesh);
    var flowerSpots = [
      [-3.5, 9.8], [-3, -9.5], [2, -9.8], [6, -9.2], [-7.5, -9], [-4, 10.2],
      [1.5, 9.6], [5.5, 8.8], [-8.9, -1.5], [8.9, 2.2], [-6.5, -5.8], [7.2, 5.6]
    ];
    var flowerColors = ['#ff8fab', '#ffd93b', '#c77dff', '#ff8fab', '#ffd93b', '#c77dff', '#ff8fab', '#ffd93b', '#c77dff', '#ff8fab', '#ffd93b', '#c77dff'];
    var flowerMesh = new THREE.InstancedMesh(flowerGeometry(), toonMaterial(), flowerSpots.length);
    flowerSpots.forEach(function (s, k) {
      dummy.position.set(s[0], 0, s[1]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      flowerMesh.setMatrixAt(k, dummy.matrix);
      tmpColor.set(flowerColors[k]);
      flowerMesh.setColorAt(k, tmpColor);
    });
    scene.add(flowerMesh);
    /* 云：4 朵，慢慢飘 */
    cloudBases = [[-6, 7, -6], [4, 8.5, -8], [-2, 7.5, 9], [7, 8, 7]];
    cloudMesh = new THREE.InstancedMesh(cloudGeometry(), toonMaterial(), cloudBases.length);
    cloudBases.forEach(function (s, k) {
      dummy.position.set(s[0], s[1], s[2]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      cloudMesh.setMatrixAt(k, dummy.matrix);
    });
    scene.add(cloudMesh);

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

  /* 水面：蓝绿渐变底 + 扩散的涟漪圈 + 几道反光 */
  function drawPond(now) {
    if (!pondCtx) return;
    var g = pondCtx, s = 256;
    var grad = g.createLinearGradient(0, 0, s, s);
    grad.addColorStop(0, '#6fc3e8');
    grad.addColorStop(1, '#2f7fc9');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    var k, r, a;
    for (k = 0; k < 4; k++) {
      r = ((now * 0.06 + k * 55) % 120) + 8;
      a = 0.45 * (1 - r / 130);
      if (a <= 0) continue;
      g.strokeStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(128 + Math.sin(k * 2.1) * 30, 128 + Math.cos(k * 1.7) * 30, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 5;
    for (k = 0; k < 3; k++) {
      var y = 40 + k * 80 + Math.sin(now * 0.001 + k) * 6;
      g.beginPath();
      g.moveTo(30, y);
      g.lineTo(110 + k * 30, y + 8);
      g.stroke();
    }
  }

  /* 光影动效：太阳缓慢摆动、云影漂移、水面闪光、光尘浮动 */
  function animateEnvironment(now, dt) {
    if (!sunLight) return;
    sunLight.position.set(8 + Math.sin(now * 0.00012) * 2.5, 9, 5 + Math.cos(now * 0.00009) * 2);
    sunLight.intensity = 1.25 + Math.sin(now * 0.0004) * 0.1;
    pondTimer += dt;
    if (pondTimer > 0.12) {
      pondTimer = 0;
      drawPond(now);
      if (pondTex) pondTex.needsUpdate = true;
    }
    var i;
    if (sparkleMesh) {
      for (i = 0; i < 6; i++) {
        var sc = 0.05 + 0.08 * (0.5 + 0.5 * Math.sin(now * 0.005 + i * 1.3));
        dummy.position.set([-7.8, -6.2, -7.0, -5.9, -7.4, -6.6][i], 0.09, [9.3, 9.0, 8.6, 9.2, 8.3, 9.5][i]);
        dummy.scale.set(sc, sc, sc);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        sparkleMesh.setMatrixAt(i, dummy.matrix);
      }
      sparkleMesh.instanceMatrix.needsUpdate = true;
    }
    for (i = 0; i < cloudShadowMeshes.length; i++) {
      var cs = cloudShadowMeshes[i];
      var cx = -14 + ((now * 0.0007 + i * 9) % 28);
      cs.position.x = cx;
    }
    if (pollenMesh) {
      for (i = 0; i < pollenSeeds.length; i++) {
        var p = pollenSeeds[i];
        var px = p.x + Math.sin(now * 0.0002 * p.sp * 10 + p.ph) * 0.8;
        var py = p.y + Math.sin(now * 0.0005 + p.ph) * 0.35;
        var ps = 0.05 + 0.03 * Math.sin(now * 0.002 + p.ph);
        dummy.position.set(px, py, p.z);
        dummy.scale.set(ps, ps, ps);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        pollenMesh.setMatrixAt(i, dummy.matrix);
      }
      pollenMesh.instanceMatrix.needsUpdate = true;
    }
    /* 二档降级：还卡就关掉真实阴影 */
    if (degraded && !shadowOff && frameEMA > 45) {
      shadowFrames += 1;
      if (shadowFrames > 120) {
        shadowOff = true;
        sunLight.castShadow = false;
      }
    } else if (frameEMA <= 45) {
      shadowFrames = 0;
    }
  }

  function driftClouds(now) {
    if (!cloudMesh) return;
    var i;
    for (i = 0; i < cloudBases.length; i++) {
      var b = cloudBases[i];
      var x = b[0] + Math.sin(now * 0.00008 + i * 1.7) * 1.2;
      dummy.position.set(x, b[1], b[2]);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      cloudMesh.setMatrixAt(i, dummy.matrix);
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
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
    var towerCount = 0, starCount = 0;
    PADS.forEach(function (p, idx) {
      tw = state.towers[idx];
      if (tw && !towerGroups[idx]) {
        var g = buildCat(TOWER_TYPES[tw.type].color);
        g.position.set(wx(p.x), 0.2, wz(p.y));
        g.traverse(function (o) { o.userData.padIndex = idx; o.castShadow = true; });
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
        g2.rotation.y = -tw.angle + Math.PI / 2;
        var sc = 1 + (tw.level - 1) * 0.14;
        g2.scale.set(sc, sc, sc);
        setInst(towerShadowMesh, towerCount, wx(p.x), 0.03, wz(p.y), 0.85, 0.85, 0.85, null);
        towerCount += 1;
        var s;
        for (s = 0; s < tw.level - 1; s++) {
          var bob = Math.sin(performance.now() * 0.003 + idx + s) * 0.06;
          dummy.position.set(wx(p.x) - 0.2 + s * 0.4, 1.75 + bob, wz(p.y));
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(0, performance.now() * 0.001 + s, 0);
          dummy.updateMatrix();
          starMesh.setMatrixAt(starCount, dummy.matrix);
          starCount += 1;
        }
      }
    });
    towerShadowMesh.count = towerCount;
    towerShadowMesh.instanceMatrix.needsUpdate = true;
    starMesh.count = starCount;
    starMesh.instanceMatrix.needsUpdate = true;
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
    /* 敌人：单实例化老鼠 */
    var n = Math.min(state.enemies.length, MAX_ENEMY);
    var now = performance.now() / 1000;
    var bossVisible = false;
    for (i = 0; i < n; i++) {
      e = state.enemies[i];
      var r = e.r / 40;
      var ex = wx(e.x), ez = wz(e.y);
      var slowed = now < e.slowUntil;
      var tint;
      if (e.flash > 0) tint = '#ffffff';
      else if (slowed) tint = '#bcd9ff';
      else tint = e.color;
      dummy.position.set(ex, 0, ez);
      dummy.scale.set(r / 0.375, r / 0.375, r / 0.375);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      enemyMesh.setMatrixAt(i, dummy.matrix);
      tmpColor.set(tint);
      enemyMesh.setColorAt(i, tmpColor);
      setInst(enemyShadow, i, ex, 0.03, ez, r * 1.1, r * 1.1, r * 1.1, null);
      if (e.type === 'boss') {
        bossVisible = true;
        crown.visible = true;
        crown.position.set(ex, 0.9 * (r / 0.375) + 0.3, ez);
      }
    }
    enemyMesh.count = n;
    enemyShadow.count = n;
    enemyMesh.instanceMatrix.needsUpdate = true;
    enemyShadow.instanceMatrix.needsUpdate = true;
    if (enemyMesh.instanceColor) enemyMesh.instanceColor.needsUpdate = true;
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
      var s2 = 0.12 * clamp(pt.life / pt.max, 0.05, 1);
      setInst(partMesh, i, wx(pt.x), 0.6, wz(pt.y), s2, s2, s2, pt.color);
    }
    partMesh.count = qn;
    partMesh.instanceMatrix.needsUpdate = true;
    if (partMesh.instanceColor) partMesh.instanceColor.needsUpdate = true;
    /* 鸭子 */
    if (state.duck) {
      duckGroup.visible = true;
      duckGroup.position.set(wx(state.duck.x), 0.2, wz(state.duck.y));
      duckGroup.rotation.y += 0.2;
      duckShadow.visible = true;
      duckShadow.position.set(wx(state.duck.x), 0.03, wz(state.duck.y));
    } else {
      duckGroup.visible = false;
      duckShadow.visible = false;
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
      animateEnvironment(now, dt);
      driftClouds(now);
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
