// Lola — 3D VRM Avatar module
// منفصل عن index.html عمدًا (زي firebase-bundle.js بالظبط): Three.js +
// VRM loader مكتبة تقيلة، وفصلها بيخلي المتصفح يكاشيها لوحدها من غير ما
// تتحمل تاني كل مرة تتعدل فيها index.html. بيتحمّل lazy — أول ما اليوزر
// يفتح فقاعة الأفاتار لأول مرة، مش مع تحميل الصفحة (lola.vrm نفسه 15 ميجا).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

let renderer, scene, camera, currentVrm, clock, animId;
let blinkTimer = 0, nextBlinkAt = 2.5 + Math.random() * 3;
let waveUntil = 0;
let container, canvasReady = false;
let isTalking = false;
let talkPhase = 0;

// كل تعبير عنده وزن هدف (targetWeights) بيتحرك نحوه تدريجيًا كل فريم بدل
// ما يتغير فجأة — ده الفرق بين وش "بيتفاعل" ووش بيقلب بين حالتين ثابتتين.
const EXPR_NAMES = ['neutral', 'happy', 'relaxed', 'angry', 'sad'];
const targetWeights = { neutral: 1, happy: 0, relaxed: 0, angry: 0, sad: 0 };
const currentWeights = { neutral: 1, happy: 0, relaxed: 0, angry: 0, sad: 0 };

const STATE_EXPR = { idle: 'neutral', playful: 'happy', support: 'relaxed', wave: 'happy', focus: 'neutral' };

function setExpressionTarget(name, weight = 0.7) {
  EXPR_NAMES.forEach(e => { targetWeights[e] = 0; });
  targetWeights[name] = weight;
  targetWeights.neutral = Math.max(targetWeights.neutral, 1 - weight);
}

function spawnFX(kind, layerEl) {
  if (!layerEl) return;
  let count = 0;
  const t = setInterval(() => {
    if (count++ > 4) { clearInterval(t); return; }
    const el = document.createElement('div');
    el.className = 'lola-fx-item';
    el.style.left = (20 + Math.random() * 60) + '%';
    el.textContent = kind === 'support' ? '✦' : (kind === 'focus' ? '🔥' : '♥');
    el.style.color = kind === 'support' ? '#7DA0CA' : (kind === 'focus' ? '#DC143C' : '#C1E8FF');
    layerEl.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }, 220);
}

function animate() {
  animId = requestAnimationFrame(animate);
  if (!canvasReady) return;
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.getElapsedTime();

  if (currentVrm) {
    // نفس تنفسي هادي + ميل كاميرا خفيف جدًا — النقطتين دول سوا هما اللي
    // بيفرقوا بين "موديل واقف" و"حد موجود قدامك فعلاً"
    currentVrm.scene.position.y = Math.sin(t * 1.4) * 0.006;
    if (camera) {
      camera.position.x = Math.sin(t * 0.35) * 0.02;
      camera.lookAt(0, 1.32, 0);
    }

    // انتقال ناعم (lerp) لكل وزن تعبير نحو هدفه — مش قفزة فجائية
    EXPR_NAMES.forEach(e => {
      currentWeights[e] += (targetWeights[e] - currentWeights[e]) * Math.min(1, dt * 6);
      currentVrm.expressionManager?.setValue(e, currentWeights[e]);
    });

    // حركة فم بسيطة وهي "بتتكلم" — بديل رخيص لكن فعّال لـ lip-sync حقيقي،
    // بيدّي إحساس إنها فعلاً بترد مش بس واقفة وسط بيتحرك بالنص فوقها
    if (isTalking) {
      talkPhase += dt * 14;
      const mouth = Math.max(0, Math.sin(talkPhase)) * 0.55;
      currentVrm.expressionManager?.setValue('aa', mouth);
    } else if (talkPhase !== 0) {
      currentVrm.expressionManager?.setValue('aa', 0);
      talkPhase = 0;
    }

    blinkTimer += dt;
    if (blinkTimer > nextBlinkAt) {
      currentVrm.expressionManager?.setValue('blink', 1);
      if (blinkTimer > nextBlinkAt + 0.12) {
        currentVrm.expressionManager?.setValue('blink', 0);
        blinkTimer = 0;
        nextBlinkAt = 2.5 + Math.random() * 3;
      }
    }

    if (currentVrm.humanoid) {
      const upperArm = currentVrm.humanoid.getNormalizedBoneNode('rightUpperArm');
      const lowerArm = currentVrm.humanoid.getNormalizedBoneNode('rightLowerArm');
      if (t < waveUntil) {
        if (upperArm) upperArm.rotation.z = 1.1 + Math.sin(t * 9) * 0.15;
        if (lowerArm) lowerArm.rotation.z = 0.3 + Math.sin(t * 9) * 0.1;
      } else {
        if (upperArm) upperArm.rotation.z += (0 - upperArm.rotation.z) * 0.08;
        if (lowerArm) lowerArm.rotation.z += (0 - lowerArm.rotation.z) * 0.08;
      }
    }
    currentVrm.update(dt);
  }
  renderer.render(scene, camera);
}

function resize() {
  if (!renderer || !container) return;
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/**
 * بيتنده مرة واحدة أول ما اليوزر يفتح فقاعة الأفاتار لأول مرة.
 * containerEl: الـ div اللي هيحوي الـ canvas.
 * modelUrl: مسار lola.vrm (نسبي لصفحة index.html، يعني './lola.vrm').
 */
export function initAvatar(containerEl, modelUrl, onReady) {
  container = containerEl;
  clock = new THREE.Clock();

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, container.clientWidth / container.clientHeight, 0.1, 20);
  camera.position.set(0, 1.36, 1.15);

  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xdcefff, 1.4); // إضاءة باردة تناسب باليتة Lola (ice/navy)
  key.position.set(0.6, 1.8, 1.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdc143c, 0.35); // rim خفيف بلون crimson بدل الروز
  rim.position.set(-1, 1, -1);
  scene.add(rim);

  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  loader.load(
    modelUrl,
    gltf => {
      const vrm = gltf.userData.vrm;
      currentVrm = vrm;
      scene.add(vrm.scene);
      vrm.scene.rotation.y = Math.PI; // VRM بتتحمل بايصة للخلف بشكل افتراضي
      canvasReady = true;
      if (onReady) onReady();
    },
    undefined,
    err => { console.error('فشل تحميل lola.vrm:', err); if (onReady) onReady(err); }
  );

  window.addEventListener('resize', resize);
  animate();
}

export function setAvatarState(state, fxLayerEl) {
  const expr = STATE_EXPR[state] || 'neutral';
  setExpressionTarget(expr, state === 'idle' ? 0.15 : 0.7);
  if (state === 'playful' || state === 'support' || state === 'focus') spawnFX(state, fxLayerEl);
  if (state === 'wave' && clock) waveUntil = clock.getElapsedTime() + 1.6;
}

/** بيتنده وهي "بترد" في الشات — بيحرك فمها بشكل بسيط طول مدة الرد. */
export function setTalking(talking) {
  isTalking = !!talking;
}

export function destroyAvatar() {
  // بيتنده لو الأوفرلاي بيتقفل نهائيًا وعايز تفضي الـ WebGL context (اختياري،
  // مش لازم تستخدمه لو هتسيب الأوفرلاي مخفي بس بـ display:none)
  if (animId) cancelAnimationFrame(animId);
  window.removeEventListener('resize', resize);
  if (renderer) { renderer.dispose(); renderer.domElement.remove(); }
  canvasReady = false;
}
