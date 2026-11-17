export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  phase: number;
  warm: boolean;
}

export interface ParticleSurface {
  width: number;
  height: number;
}

export interface ParticleWindow {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  matchMedia?: (query: string) => { matches: boolean };
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  addEventListener: (type: "resize", listener: () => void) => void;
  removeEventListener: (type: "resize", listener: () => void) => void;
}

const AREA_PER_PARTICLE = 26_000;
const MIN_PARTICLES = 18;
const MAX_PARTICLES = 64;
const LINK_DISTANCE = 130;
const MAX_STEP_MS = 50;
const VIOLET = "139, 92, 246";
const AMBER = "245, 158, 11";

export const particleCount = (surface: ParticleSurface): number =>
  Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round((surface.width * surface.height) / AREA_PER_PARTICLE)));

export const createParticles = (count: number, surface: ParticleSurface, random: () => number = Math.random): Particle[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = random() * Math.PI * 2;
    const speed = 0.006 + random() * 0.014;
    return {
      x: random() * surface.width,
      y: random() * surface.height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.004,
      radius: 0.8 + random() * 1.6,
      alpha: 0.25 + random() * 0.45,
      phase: random() * Math.PI * 2,
      warm: index % 7 === 3,
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
  particle.alpha * (0.7 + 0.3 * Math.sin(timeMs / 1400 + particle.phase));

export const drawParticles = (context: CanvasRenderingContext2D, particles: Particle[], surface: ParticleSurface, timeMs: number): void => {
  context.clearRect(0, 0, surface.width, surface.height);
  context.lineWidth = 1;
  particles.forEach((a, i) => {
    particles.forEach((b, j) => {
      if (j <= i) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance >= LINK_DISTANCE) return;
      context.strokeStyle = `rgba(${VIOLET}, ${(0.11 * (1 - distance / LINK_DISTANCE)).toFixed(3)})`;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    });
  });
  for (const particle of particles) {
    context.fillStyle = `rgba(${particle.warm ? AMBER : VIOLET}, ${twinkle(particle, timeMs).toFixed(3)})`;
    context.beginPath();
    context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    context.fill();
  }
};

export const startParticles = (target: HTMLCanvasElement | null, view: ParticleWindow): (() => void) => {
  const context = target?.getContext("2d") ?? null;
  if (!context) return () => undefined;
  const canvas = context.canvas;
  const reduced = view.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const surface: ParticleSurface = { width: view.innerWidth, height: view.innerHeight };
  let particles: Particle[] = [];
  let frame: number | null = null;
  let last: number | null = null;

  const fit = () => {
    surface.width = view.innerWidth;
    surface.height = view.innerHeight;
    const ratio = Math.min(view.devicePixelRatio || 1, 2);
    canvas.width = Math.round(surface.width * ratio);
    canvas.height = Math.round(surface.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const tick = (time: number) => {
    stepParticles(particles, surface, last === null ? 0 : time - last);
    last = time;
    drawParticles(context, particles, surface, time);
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
    stepParticles(particles, surface, 0);
    if (reduced) drawParticles(context, particles, surface, 0);
  };

  const onVisibility = () => {
    if (view.document.hidden) stop();
    else play();
  };

  fit();
  particles = createParticles(particleCount(surface), surface);
  drawParticles(context, particles, surface, 0);
  view.addEventListener("resize", onResize);
  view.document.addEventListener("visibilitychange", onVisibility);
  play();

  return () => {
    stop();
    view.removeEventListener("resize", onResize);
    view.document.removeEventListener("visibilitychange", onVisibility);
  };
};
