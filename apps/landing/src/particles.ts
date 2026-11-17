export type Tone = "violet" | "indigo" | "amber";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  phase: number;
  depth: number;
  tone: Tone;
}

export interface ParticleSurface {
  width: number;
  height: number;
}

export interface Pointer {
  x: number;
  y: number;
  at: number;
}

export interface Scene extends ParticleSurface {
  scrollY: number;
  pointer: Pointer | null;
  time: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ParticleWindow {
  innerWidth: number;
  innerHeight: number;
  scrollY: number;
  devicePixelRatio: number;
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> & {
    documentElement: Pick<HTMLElement, "scrollHeight">;
  };
  matchMedia?: (query: string) => { matches: boolean };
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  addEventListener: (type: "resize" | "pointermove", listener: (event: Event) => void, options?: AddEventListenerOptions) => void;
  removeEventListener: (type: "resize" | "pointermove", listener: (event: Event) => void) => void;
}

export interface Backdrop {
  canvas: HTMLCanvasElement | null;
  track: HTMLElement | null;
}

const AREA_PER_PARTICLE = 9_000;
const MIN_PARTICLES = 40;
const MAX_PARTICLES = 170;
const LINK_DISTANCE = 150;
const POINTER_DISTANCE = 210;
const POINTER_FADE_MS = 2_500;
const SCROLL_PARALLAX = 0.25;
const POINTER_PARALLAX = 0.03;
const TRACK_SPAN = 3;
const MAX_STEP_MS = 50;

const COLORS: Record<Tone, string> = {
  violet: "167, 139, 250",
  indigo: "129, 140, 248",
  amber: "251, 191, 36",
};

const LINK_COLOR = "167, 139, 250";
const POINTER_COLOR = "221, 214, 254";

export const particleCount = (surface: ParticleSurface): number =>
  Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round((surface.width * surface.height) / AREA_PER_PARTICLE)));

const toneFor = (index: number): Tone => {
  if (index % 6 === 2) return "amber";
  return index % 3 === 0 ? "indigo" : "violet";
};

export const createParticles = (count: number, surface: ParticleSurface, random: () => number = Math.random): Particle[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = random() * Math.PI * 2;
    const speed = 0.008 + random() * 0.018;
    return {
      x: random() * surface.width,
      y: random() * surface.height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.005,
      radius: 1.2 + random() * 2.2,
      alpha: 0.55 + random() * 0.4,
      phase: random() * Math.PI * 2,
      depth: 0.35 + random() * 0.65,
      tone: toneFor(index),
    };
  });

const wrap = (value: number, size: number): number => ((value % size) + size) % size;

export const stepParticles = (particles: Particle[], surface: ParticleSurface, elapsedMs: number): void => {
  const step = Math.min(Math.max(elapsedMs, 0), MAX_STEP_MS);
  for (const particle of particles) {
    particle.x = wrap(particle.x + particle.vx * step, surface.width);
    particle.y = wrap(particle.y + particle.vy * step, surface.height);
  }
};

export const twinkle = (particle: Particle, timeMs: number): number =>
  particle.alpha * (0.75 + 0.25 * Math.sin(timeMs / 1400 + particle.phase));

export const pointerStrength = (pointer: Pointer | null, timeMs: number): number =>
  pointer ? Math.min(1, Math.max(0, 1 - (timeMs - pointer.at) / POINTER_FADE_MS)) : 0;

export const projectParticle = (particle: Particle, scene: Scene): Point => {
  const pointerX = scene.pointer ? (scene.pointer.x - scene.width / 2) * POINTER_PARALLAX : 0;
  const pointerY = scene.pointer ? (scene.pointer.y - scene.height / 2) * POINTER_PARALLAX : 0;
  return {
    x: wrap(particle.x - pointerX * particle.depth, scene.width),
    y: wrap(particle.y - (scene.scrollY * SCROLL_PARALLAX + pointerY) * particle.depth, scene.height),
  };
};

export const trackOffset = (scrollY: number, scrollHeight: number, viewportHeight: number): number => {
  const scrollable = Math.max(1, scrollHeight - viewportHeight);
  return -Math.min(1, Math.max(0, scrollY / scrollable)) * TRACK_SPAN * viewportHeight;
};

const line = (context: CanvasRenderingContext2D, from: Point, to: Point, color: string, alpha: number) => {
  context.strokeStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
};

export const drawParticles = (context: CanvasRenderingContext2D, particles: Particle[], scene: Scene): void => {
  context.clearRect(0, 0, scene.width, scene.height);
  const points = particles.map((particle) => projectParticle(particle, scene));
  const linkSquared = LINK_DISTANCE * LINK_DISTANCE;
  context.lineWidth = 1;
  points.forEach((a, i) => {
    points.forEach((b, j) => {
      if (j <= i) return;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const squared = dx * dx + dy * dy;
      if (squared >= linkSquared) return;
      line(context, a, b, LINK_COLOR, 0.3 * (1 - Math.sqrt(squared) / LINK_DISTANCE));
    });
  });
  const strength = pointerStrength(scene.pointer, scene.time);
  if (scene.pointer && strength > 0) {
    const pointer: Point = scene.pointer;
    context.lineWidth = 1.2;
    for (const point of points) {
      const distance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
      if (distance < POINTER_DISTANCE) line(context, pointer, point, POINTER_COLOR, 0.6 * (1 - distance / POINTER_DISTANCE) * strength);
    }
  }
  particles.forEach((particle, index) => {
    const point = points[index] as Point;
    const alpha = twinkle(particle, scene.time);
    const color = COLORS[particle.tone];
    context.fillStyle = `rgba(${color}, ${(alpha * 0.16).toFixed(3)})`;
    context.beginPath();
    context.arc(point.x, point.y, particle.radius * 3.4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
    context.beginPath();
    context.arc(point.x, point.y, particle.radius, 0, Math.PI * 2);
    context.fill();
  });
};

export const startParticles = ({ canvas: target, track }: Backdrop, view: ParticleWindow): (() => void) => {
  const context = target?.getContext("2d") ?? null;
  if (!context) return () => undefined;
  const canvas = context.canvas;
  const reduced = view.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const scene: Scene = { width: view.innerWidth, height: view.innerHeight, scrollY: 0, pointer: null, time: 0 };
  let particles: Particle[] = [];
  let frame: number | null = null;
  let last: number | null = null;

  const fit = () => {
    scene.width = view.innerWidth;
    scene.height = view.innerHeight;
    const ratio = Math.min(view.devicePixelRatio || 1, 2);
    canvas.width = Math.round(scene.width * ratio);
    canvas.height = Math.round(scene.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const render = () => {
    drawParticles(context, particles, scene);
    if (track) track.style.transform = `translate3d(0, ${trackOffset(scene.scrollY, view.document.documentElement.scrollHeight, scene.height).toFixed(1)}px, 0)`;
  };

  const tick = (time: number) => {
    stepParticles(particles, scene, last === null ? 0 : time - last);
    last = time;
    scene.time = time;
    scene.scrollY = view.scrollY;
    render();
    frame = view.requestAnimationFrame(tick);
  };

  const stop = () => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    last = null;
  };

  const play = () => {
    if (reduced || frame !== null || view.document.hidden) return;
    frame = view.requestAnimationFrame(tick);
  };

  const onResize = () => {
    fit();
    stepParticles(particles, scene, 0);
    if (reduced) render();
  };

  const onPointer = (event: Event) => {
    const { clientX, clientY, timeStamp } = event as PointerEvent;
    scene.pointer = { x: clientX, y: clientY, at: timeStamp };
  };

  const onVisibility = () => {
    track?.toggleAttribute("data-paused", view.document.hidden);
    if (view.document.hidden) stop();
    else play();
  };

  fit();
  particles = createParticles(particleCount(scene), scene);
  render();
  view.addEventListener("resize", onResize);
  if (!reduced) view.addEventListener("pointermove", onPointer, { passive: true });
  view.document.addEventListener("visibilitychange", onVisibility);
  onVisibility();

  return () => {
    stop();
    view.removeEventListener("resize", onResize);
    view.removeEventListener("pointermove", onPointer);
    view.document.removeEventListener("visibilitychange", onVisibility);
  };
};
