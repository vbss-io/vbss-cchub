import { describe, expect, it, vi } from "vitest";
import { createParticles, drawParticles, particleCount, startParticles, stepParticles, twinkle, type Particle, type ParticleWindow } from "./particles";

const fakeContext = () => {
  const canvas = { width: 0, height: 0 };
  const context = {
    canvas,
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setTransform: vi.fn(),
  };
  return { canvas, context, target: { getContext: () => context } as unknown as HTMLCanvasElement };
};

interface FakeWindowOptions {
  reduced?: boolean;
  hidden?: boolean;
  ratio?: number;
  withMatchMedia?: boolean;
}

const fakeWindow = ({ reduced = false, hidden = false, ratio = 1, withMatchMedia = true }: FakeWindowOptions = {}) => {
  const frames: FrameRequestCallback[] = [];
  const listeners = new Map<string, () => void>();
  const documentListeners = new Map<string, () => void>();
  const doc = {
    hidden,
    addEventListener: vi.fn((type: string, listener: () => void) => documentListeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => documentListeners.delete(type)),
  };
  const view: ParticleWindow = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: ratio,
    document: doc as unknown as ParticleWindow["document"],
    matchMedia: withMatchMedia ? vi.fn(() => ({ matches: reduced })) : undefined,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
    cancelAnimationFrame: vi.fn(),
    addEventListener: vi.fn((type: "resize", listener: () => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: "resize") => listeners.delete(type)),
  };
  return { view, doc, frames, listeners, documentListeners };
};

const particle = (overrides: Partial<Particle> = {}): Particle => ({
  x: 10,
  y: 10,
  vx: 0.01,
  vy: -0.01,
  radius: 1,
  alpha: 0.5,
  phase: 0,
  warm: false,
  ...overrides,
});

describe("particle maths", () => {
  it("scales the count with the screen area inside fixed bounds", () => {
    expect(particleCount({ width: 390, height: 844 })).toBe(18);
    expect(particleCount({ width: 1440, height: 900 })).toBe(50);
    expect(particleCount({ width: 3840, height: 2160 })).toBe(64);
  });

  it("creates particles inside the surface with an amber one every seventh", () => {
    const particles = createParticles(8, { width: 100, height: 50 }, () => 0.5);

    expect(particles).toHaveLength(8);
    expect(particles.every((item) => item.x === 50 && item.y === 25)).toBe(true);
    expect(particles.map((item) => item.warm)).toEqual([false, false, false, true, false, false, false, false]);
    expect(particles[0]?.radius).toBeCloseTo(1.6);
    expect(particles[0]?.alpha).toBeCloseTo(0.475);
  });

  it("uses Math.random when no source is given", () => {
    const particles = createParticles(3, { width: 10, height: 10 });

    expect(particles.every((item) => item.x >= 0 && item.x < 10 && item.y >= 0 && item.y < 10)).toBe(true);
  });

  it("moves particles, wraps them around the edges and caps long frames", () => {
    const moving = particle({ x: 99, y: 1, vx: 0.1, vy: -0.1 });
    const surface = { width: 100, height: 100 };

    stepParticles([moving], surface, 20);
    expect(moving.x).toBeCloseTo(1);
    expect(moving.y).toBeCloseTo(99);

    stepParticles([moving], surface, 5000);
    expect(moving.x).toBeCloseTo(6);

    stepParticles([moving], surface, -10);
    expect(moving.x).toBeCloseTo(6);
  });

  it("twinkles around the base alpha", () => {
    expect(twinkle(particle({ alpha: 0.5 }), 0)).toBeCloseTo(0.35);
    expect(twinkle(particle({ alpha: 0.5, phase: Math.PI / 2 }), 0)).toBeCloseTo(0.5);
  });

  it("links close particles only and colours warm ones amber", () => {
    const { context } = fakeContext();
    const near = [particle({ x: 0, y: 0 }), particle({ x: 30, y: 40, warm: true }), particle({ x: 500, y: 500 })];

    drawParticles(context as unknown as CanvasRenderingContext2D, near, { width: 600, height: 600 }, 0);

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 600, 600);
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.lineTo).toHaveBeenCalledWith(30, 40);
    expect(context.fill).toHaveBeenCalledTimes(3);
    expect(context.fillStyle).toBe("rgba(139, 92, 246, 0.350)");
  });
});

describe("startParticles", () => {
  it("does nothing without a canvas or a 2d context", () => {
    const { view } = fakeWindow();
    const noContext = { getContext: () => null } as unknown as HTMLCanvasElement;

    startParticles(null, view)();
    startParticles(noContext, view)();

    expect(view.requestAnimationFrame).not.toHaveBeenCalled();
    expect(view.addEventListener).not.toHaveBeenCalled();
  });

  it("sizes the canvas for the screen, draws and keeps animating", () => {
    const { canvas, context, target } = fakeContext();
    const { view, frames } = fakeWindow({ ratio: 3 });

    startParticles(target, view);

    expect(canvas).toEqual({ width: 1600, height: 1200 });
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);

    frames[0]?.(1000);
    frames[1]?.(1016);

    expect(context.clearRect).toHaveBeenCalledTimes(3);
    expect(frames).toHaveLength(3);
  });

  it("falls back to a pixel ratio of 1 and works without matchMedia", () => {
    const { canvas, target } = fakeContext();
    const { view, frames } = fakeWindow({ ratio: 0, withMatchMedia: false });

    startParticles(target, view);

    expect(canvas).toEqual({ width: 800, height: 600 });
    expect(frames).toHaveLength(1);
  });

  it("pauses while the tab is hidden and resumes when it comes back", () => {
    const { target } = fakeContext();
    const { view, doc, frames, documentListeners } = fakeWindow();

    startParticles(target, view);
    doc.hidden = true;
    documentListeners.get("visibilitychange")?.();

    expect(view.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(frames).toHaveLength(1);

    doc.hidden = false;
    documentListeners.get("visibilitychange")?.();
    documentListeners.get("visibilitychange")?.();

    expect(frames).toHaveLength(2);
  });

  it("waits for a visible tab before animating", () => {
    const { target } = fakeContext();
    const { view, frames } = fakeWindow({ hidden: true });

    startParticles(target, view);

    expect(frames).toHaveLength(0);
  });

  it("draws one still frame and redraws on resize when motion is reduced", () => {
    const { canvas, context, target } = fakeContext();
    const { view, frames, listeners } = fakeWindow({ reduced: true });

    startParticles(target, view);
    expect(frames).toHaveLength(0);
    expect(context.clearRect).toHaveBeenCalledTimes(1);

    view.innerWidth = 400;
    listeners.get("resize")?.();

    expect(canvas.width).toBe(400);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
  });

  it("only refits on resize while animating, and cleans up on stop", () => {
    const { canvas, context, target } = fakeContext();
    const { view, doc, listeners, documentListeners } = fakeWindow();

    const stop = startParticles(target, view);
    view.innerHeight = 300;
    listeners.get("resize")?.();

    expect(canvas.height).toBe(300);
    expect(context.clearRect).toHaveBeenCalledTimes(1);

    stop();

    expect(view.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(listeners.size).toBe(0);
    expect(documentListeners.size).toBe(0);
    expect(doc.removeEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("does not cancel a frame that was never requested", () => {
    const { target } = fakeContext();
    const { view } = fakeWindow({ reduced: true });

    startParticles(target, view)();

    expect(view.cancelAnimationFrame).not.toHaveBeenCalled();
  });
});
