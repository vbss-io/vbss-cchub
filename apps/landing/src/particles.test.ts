import { describe, expect, it, vi } from "vitest";
import {
  createParticles,
  drawParticles,
  particleCount,
  pointerStrength,
  projectParticle,
  startParticles,
  stepParticles,
  trackOffset,
  twinkle,
  type Particle,
  type ParticleWindow,
  type Scene,
} from "./particles";

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

const fakeTrack = () => {
  const track = document.createElement("div");
  return track;
};

interface FakeWindowOptions {
  reduced?: boolean;
  hidden?: boolean;
  ratio?: number;
  withMatchMedia?: boolean;
}

const fakeWindow = ({ reduced = false, hidden = false, ratio = 1, withMatchMedia = true }: FakeWindowOptions = {}) => {
  const frames: FrameRequestCallback[] = [];
  const listeners = new Map<string, (event: Event) => void>();
  const documentListeners = new Map<string, () => void>();
  const doc = {
    hidden,
    documentElement: { scrollHeight: 3600 },
    addEventListener: vi.fn((type: string, listener: () => void) => documentListeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => documentListeners.delete(type)),
  };
  const view: ParticleWindow = {
    innerWidth: 800,
    innerHeight: 600,
    scrollY: 0,
    devicePixelRatio: ratio,
    document: doc as unknown as ParticleWindow["document"],
    matchMedia: withMatchMedia ? vi.fn(() => ({ matches: reduced })) : undefined,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
    cancelAnimationFrame: vi.fn(),
    addEventListener: vi.fn((type: "resize" | "pointermove", listener: (event: Event) => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: "resize" | "pointermove") => listeners.delete(type)),
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
  depth: 1,
  tone: "violet",
  ...overrides,
});

const scene = (overrides: Partial<Scene> = {}): Scene => ({ width: 600, height: 600, scrollY: 0, pointer: null, time: 0, ...overrides });

describe("particle maths", () => {
  it("scales the count with the screen area inside fixed bounds", () => {
    expect(particleCount({ width: 390, height: 844 })).toBe(40);
    expect(particleCount({ width: 1440, height: 900 })).toBe(144);
    expect(particleCount({ width: 3840, height: 2160 })).toBe(170);
  });

  it("creates particles inside the surface with violet, indigo and amber tones", () => {
    const particles = createParticles(8, { width: 100, height: 50 }, () => 0.5);

    expect(particles).toHaveLength(8);
    expect(particles.every((item) => item.x === 50 && item.y === 25)).toBe(true);
    expect(particles.map((item) => item.tone)).toEqual(["indigo", "violet", "amber", "indigo", "violet", "violet", "indigo", "violet"]);
    expect(particles[0]?.radius).toBeCloseTo(2.3);
    expect(particles[0]?.alpha).toBeCloseTo(0.75);
    expect(particles[0]?.depth).toBeCloseTo(0.675);
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
    expect(twinkle(particle({ alpha: 0.8 }), 0)).toBeCloseTo(0.6);
    expect(twinkle(particle({ alpha: 0.8, phase: Math.PI / 2 }), 0)).toBeCloseTo(0.8);
  });

  it("fades the pointer influence over time", () => {
    expect(pointerStrength(null, 0)).toBe(0);
    expect(pointerStrength({ x: 0, y: 0, at: 1000 }, 1000)).toBe(1);
    expect(pointerStrength({ x: 0, y: 0, at: 1000 }, 2250)).toBeCloseTo(0.5);
    expect(pointerStrength({ x: 0, y: 0, at: 1000 }, 9000)).toBe(0);
    expect(pointerStrength({ x: 0, y: 0, at: 1000 }, 500)).toBe(1);
  });

  it("shifts deeper particles more with scroll and pointer", () => {
    const near = particle({ x: 300, y: 300, depth: 1 });
    const far = particle({ x: 300, y: 300, depth: 0.5 });

    expect(projectParticle(near, scene())).toEqual({ x: 300, y: 300 });
    expect(projectParticle(near, scene({ scrollY: 400 }))).toEqual({ x: 300, y: 200 });
    expect(projectParticle(far, scene({ scrollY: 400 }))).toEqual({ x: 300, y: 250 });
    const moved = projectParticle(near, scene({ pointer: { x: 600, y: 0, at: 0 } }));
    expect(moved.x).toBeCloseTo(291);
    expect(moved.y).toBeCloseTo(309);
    expect(projectParticle(near, scene({ scrollY: 1600 })).y).toBeCloseTo(500);
  });

  it("maps the page scroll onto the backdrop track", () => {
    expect(trackOffset(0, 3600, 600)).toBeCloseTo(0);
    expect(trackOffset(1500, 3600, 600)).toBe(-900);
    expect(trackOffset(3000, 3600, 600)).toBe(-1800);
    expect(trackOffset(9000, 3600, 600)).toBe(-1800);
    expect(trackOffset(-50, 3600, 600)).toBeCloseTo(0);
    expect(trackOffset(10, 500, 600)).toBe(-1800);
  });

  it("links close particles, glows every dot and colours them by tone", () => {
    const { context } = fakeContext();
    const dots = [particle({ x: 0, y: 0, tone: "indigo" }), particle({ x: 30, y: 40, tone: "amber" }), particle({ x: 500, y: 500 })];

    drawParticles(context as unknown as CanvasRenderingContext2D, dots, scene());

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 600, 600);
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.lineTo).toHaveBeenCalledWith(30, 40);
    expect(context.fill).toHaveBeenCalledTimes(6);
    expect(context.arc).toHaveBeenCalledWith(0, 0, 3.4, 0, Math.PI * 2);
    expect(context.fillStyle).toBe("rgba(167, 139, 250, 0.375)");
  });

  it("draws lines from a recent pointer to the nearby particles only", () => {
    const { context } = fakeContext();
    const dots = [particle({ x: 300, y: 300 }), particle({ x: 590, y: 20 })];
    const pointer = { x: 300, y: 300, at: 0 };

    drawParticles(context as unknown as CanvasRenderingContext2D, dots, scene({ pointer, time: 100 }));
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.moveTo).toHaveBeenCalledWith(300, 300);

    context.stroke.mockClear();
    drawParticles(context as unknown as CanvasRenderingContext2D, dots, scene({ pointer, time: 10_000 }));
    expect(context.stroke).not.toHaveBeenCalled();
  });
});

describe("startParticles", () => {
  it("does nothing without a canvas or a 2d context", () => {
    const { view } = fakeWindow();
    const noContext = { getContext: () => null } as unknown as HTMLCanvasElement;

    startParticles({ canvas: null, track: null }, view)();
    startParticles({ canvas: noContext, track: null }, view)();

    expect(view.requestAnimationFrame).not.toHaveBeenCalled();
    expect(view.addEventListener).not.toHaveBeenCalled();
  });

  it("sizes the canvas, draws, follows the scroll and keeps animating", () => {
    const { canvas, context, target } = fakeContext();
    const track = fakeTrack();
    const { view, frames } = fakeWindow({ ratio: 3 });

    startParticles({ canvas: target, track }, view);

    expect(canvas).toEqual({ width: 1600, height: 1200 });
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(track.style.transform).toBe("translate3d(0, 0.0px, 0)");
    expect(frames).toHaveLength(1);

    view.scrollY = 1500;
    frames[0]?.(1000);
    frames[1]?.(1016);

    expect(context.clearRect).toHaveBeenCalledTimes(3);
    expect(track.style.transform).toBe("translate3d(0, -900.0px, 0)");
    expect(frames).toHaveLength(3);
  });

  it("works without a track, a pixel ratio or matchMedia", () => {
    const { canvas, target } = fakeContext();
    const { view, frames } = fakeWindow({ ratio: 0, withMatchMedia: false });

    startParticles({ canvas: target, track: null }, view);
    frames[0]?.(16);

    expect(canvas).toEqual({ width: 800, height: 600 });
    expect(frames).toHaveLength(2);
  });

  it("follows the pointer and links it to the particles nearby", () => {
    const { context, target } = fakeContext();
    const { view, frames, listeners } = fakeWindow();

    startParticles({ canvas: target, track: null }, view);
    listeners.get("pointermove")?.({ clientX: 400, clientY: 300, timeStamp: 1000 } as unknown as Event);
    context.moveTo.mockClear();
    frames[0]?.(1010);

    expect(context.moveTo).toHaveBeenCalledWith(400, 300);
  });

  it("pauses while the tab is hidden and resumes when it comes back", () => {
    const { target } = fakeContext();
    const track = fakeTrack();
    const { view, doc, frames, documentListeners } = fakeWindow();

    startParticles({ canvas: target, track }, view);
    doc.hidden = true;
    documentListeners.get("visibilitychange")?.();

    expect(view.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(track.hasAttribute("data-paused")).toBe(true);
    expect(frames).toHaveLength(1);

    doc.hidden = false;
    documentListeners.get("visibilitychange")?.();
    documentListeners.get("visibilitychange")?.();

    expect(track.hasAttribute("data-paused")).toBe(false);
    expect(frames).toHaveLength(2);
  });

  it("waits for a visible tab before animating", () => {
    const { target } = fakeContext();
    const track = fakeTrack();
    const { view, frames } = fakeWindow({ hidden: true });

    startParticles({ canvas: target, track }, view);

    expect(frames).toHaveLength(0);
    expect(track.hasAttribute("data-paused")).toBe(true);
  });

  it("draws one still frame, ignores the pointer and redraws on resize when motion is reduced", () => {
    const { canvas, context, target } = fakeContext();
    const { view, frames, listeners } = fakeWindow({ reduced: true });

    startParticles({ canvas: target, track: null }, view);
    expect(frames).toHaveLength(0);
    expect(listeners.has("pointermove")).toBe(false);
    expect(context.clearRect).toHaveBeenCalledTimes(1);

    view.innerWidth = 400;
    listeners.get("resize")?.(new Event("resize"));

    expect(canvas.width).toBe(400);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
  });

  it("only refits on resize while animating, and cleans up on stop", () => {
    const { canvas, context, target } = fakeContext();
    const { view, doc, listeners, documentListeners } = fakeWindow();

    const stop = startParticles({ canvas: target, track: null }, view);
    view.innerHeight = 300;
    listeners.get("resize")?.(new Event("resize"));

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

    startParticles({ canvas: target, track: null }, view)();

    expect(view.cancelAnimationFrame).not.toHaveBeenCalled();
  });
});
