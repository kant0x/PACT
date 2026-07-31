import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * PACT WebGL intro — an immersive "dive in" experience shown once per visitor.
 *
 * A fixed Three.js canvas renders a deep field of instanced points that the
 * visitor flies through as they scroll. Scroll progress (0→1) drives a camera
 * dolly along -Z plus a subtle displacement of the field, echoing the
 * "SCROLL TO DIVE IN" language of mesh3d.gallery. Reaching the end reveals an
 * ENTER button and lets the overlay fade into the site.
 *
 * Accessibility / robustness:
 *  - prefers-reduced-motion or missing WebGL → a static, non-animated fallback.
 *  - Skip button always available.
 *  - Full dispose() of renderer/geometry/material + ResizeObserver teardown.
 *
 * Text is deliberately minimal and English-only so it plays nicely with the
 * DOM translator that runs over the app shell (this overlay lives outside it).
 */

interface IntroExperienceProps {
  /** Called when the visitor finishes or skips. Parent persists the flag. */
  onDone: () => void;
}

const PARTICLE_COUNT = 2600;
const FIELD_DEPTH = 260; // world units along -Z
const FIELD_SPREAD = 90; // x/y half-extent

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function webglAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export default function IntroExperience({ onDone }: IntroExperienceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const pctRef = useRef<HTMLSpanElement | null>(null);

  const [ready, setReady] = useState(false); // progress complete → ENTER shows
  const [leaving, setLeaving] = useState(false);
  const [staticMode] = useState(() => prefersReducedMotion() || !webglAvailable());

  // Latest scroll progress, shared between the scroll handler and RAF loop.
  const progressRef = useRef(0);

  const finish = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    // Match the .intro-root--leaving fade (620ms) before unmounting.
    window.setTimeout(onDone, 640);
  }, [leaving, onDone]);

  // ---- WebGL scene -----------------------------------------------------
  useEffect(() => {
    if (staticMode) return;
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    if (!canvas || !scroller) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      // Context creation blew up mid-flight — bail to letting Skip/ENTER work.
      return;
    }

    renderer.setClearColor(new THREE.Color('#050504'), 1);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2('#050504', 0.006);

    const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 600);
    camera.position.set(0, 0, FIELD_DEPTH * 0.5);

    // --- Particle field ---------------------------------------------------
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const seeds = new Float32Array(PARTICLE_COUNT); // per-point phase for drift
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3 + 0] = (Math.random() * 2 - 1) * FIELD_SPREAD;
      positions[i * 3 + 1] = (Math.random() * 2 - 1) * FIELD_SPREAD;
      positions[i * 3 + 2] = -Math.random() * FIELD_DEPTH;
      seeds[i] = Math.random() * Math.PI * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    // Round, soft points via a canvas sprite (cheap, no external asset).
    const sprite = makeDiscTexture();

    const material = new THREE.PointsMaterial({
      size: 1.5,
      map: sprite,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color('#ff7a45'),
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // A faint second field in cream for depth layering.
    const points2 = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.8,
        map: sprite,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: new THREE.Color('#f4ead8'),
      }),
    );
    points2.position.z = -FIELD_DEPTH * 0.5;
    scene.add(points2);

    // --- Sizing -----------------------------------------------------------
    const setSize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    setSize();

    const ro = new ResizeObserver(setSize);
    ro.observe(canvas);

    // --- Scroll → progress ------------------------------------------------
    const onScroll = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0;
      progressRef.current = p;
      if (fillRef.current) fillRef.current.style.width = `${(p * 100).toFixed(1)}%`;
      if (pctRef.current) pctRef.current.textContent = `${Math.round(p * 100)}%`;
      if (p > 0.985) setReady(true);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // --- Pointer parallax -------------------------------------------------
    const pointer = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    // --- Render loop ------------------------------------------------------
    const clock = new THREE.Clock();
    let raf = 0;
    let disposed = false;

    const camZStart = FIELD_DEPTH * 0.5;
    const camZEnd = -FIELD_DEPTH * 0.55;

    const tick = () => {
      if (disposed) return;
      const t = clock.getElapsedTime();
      const p = progressRef.current;

      // Dolly the camera forward as the visitor scrolls.
      const targetZ = camZStart + (camZEnd - camZStart) * easeInOut(p);
      camera.position.z += (targetZ - camera.position.z) * 0.06;

      // Gentle pointer-driven look + idle sway.
      const swayX = Math.sin(t * 0.18) * 2.2 + pointer.x * 6;
      const swayY = Math.cos(t * 0.15) * 1.6 - pointer.y * 6;
      camera.position.x += (swayX - camera.position.x) * 0.04;
      camera.position.y += (swayY - camera.position.y) * 0.04;
      camera.lookAt(0, 0, camera.position.z - 40);

      // Slow rotation of the field for life; accelerates slightly with depth.
      points.rotation.z = t * 0.02 + p * 0.4;
      points2.rotation.z = -t * 0.014 - p * 0.3;

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // --- Teardown ---------------------------------------------------------
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointer);
      geometry.dispose();
      material.dispose();
      (points2.material as THREE.PointsMaterial).dispose();
      sprite.dispose();
      renderer.dispose();
    };
  }, [staticMode]);

  // ---- Static fallback (reduced-motion / no WebGL) ---------------------
  if (staticMode) {
    return (
      <div
        className={`intro-root${leaving ? ' intro-root--leaving' : ''}`}
        ref={rootRef}
        role="dialog"
        aria-label="Intro"
      >
        <div className="intro-fallback">
          <div className="intro-fallback__lead">Programmable Agent Coordination</div>
          <h1 className="intro-fallback__title">PACT</h1>
          <button type="button" className="intro-enter intro-enter--ready" onClick={finish}>
            Enter
          </button>
        </div>
      </div>
    );
  }

  // ---- WebGL overlay ----------------------------------------------------
  return (
    <div
      className={`intro-root${leaving ? ' intro-root--leaving' : ''}`}
      ref={rootRef}
      role="dialog"
      aria-label="Intro"
    >
      <canvas className="intro-canvas" ref={canvasRef} />
      <div className="intro-veil" />

      {/* Scroll driver — provides travel distance for the dive. */}
      <div className="intro-root__scroll" ref={scrollRef}>
        <div className="intro-root__spacer" />
      </div>

      {/* Overlay copy */}
      <div className="intro-overlay">
        <div className="intro-overlay__top">
          <div className="intro-wordmark">PACT</div>
          <button type="button" className="intro-skip" onClick={finish}>
            Skip
          </button>
        </div>
        <div className="intro-overlay__bottom">
          <div className="intro-tag">Programmable Agent Coordination</div>
          <div className="intro-hint">
            Scroll
            <svg
              className="intro-hint__chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      {/* Centre headline */}
      <div className="intro-center">
        <div className="intro-center__lead">Scroll to dive in</div>
        <h1 className="intro-center__title">PACT</h1>
        <div className="intro-center__sub">A coordination layer for autonomous agents</div>
      </div>

      {/* Progress rail */}
      <div className="intro-progress">
        <div className="intro-progress__track">
          <div className="intro-progress__fill" ref={fillRef} />
        </div>
        <span className="intro-progress__pct" ref={pctRef}>
          0%
        </span>
      </div>

      {/* Enter button — appears once the dive completes */}
      <button
        type="button"
        className={`intro-enter${ready ? ' intro-enter--ready' : ''}`}
        onClick={finish}
      >
        Enter
      </button>
    </div>
  );
}

// --- helpers -------------------------------------------------------------

function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/** Build a soft radial disc texture for round additive points. */
function makeDiscTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
