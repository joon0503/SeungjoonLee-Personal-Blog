/**
 * Entrance animation for interactive figures, played the first time a mounted
 * figure scrolls into view and again when the reader returns to it later:
 * SVG strokes draw themselves and text and filled shapes fade in, in a
 * left-to-right sweep; canvases are revealed top to bottom like a sensor
 * reading out its rows, and the controls fade up last.
 *
 * Everything runs on the Web Animations API, so nothing is written to the
 * DOM: copies of a figure (the figure-reference preview) and redraws that
 * replace elements simply show the final state. Skipped for reduced motion.
 */

/** Playback speed of the whole intro: 2 is twice as fast, 0.5 half as fast. */
const SPEED = 1;
const ms = (t: number) => t / SPEED;

const START = ms(150); // before the first element starts
const SPREAD = ms(1000); // over which element start times are staggered (left to right)
const STROKE = ms(900); // to draw one stroke
const FADE = ms(550); // to fade one element in
const WIPE_SVG = ms(1200); // to reveal an SVG with too many shapes to animate one by one
const WIPE_CANVAS = ms(1100); // to reveal a canvas, top to bottom
const CONTROLS = ms(650); // to fade the controls up
const CONTROLS_DELAY = ms(400); // after START, before the first control
const CONTROLS_STEP = ms(100); // between successive controls
/** Replay the intro when a figure comes back into view after being out of view this long. */
const REPLAY_AFTER = 30_000; // ms
/** Above this many shapes an SVG is revealed as a whole instead of shape by shape. */
const MAX_SHAPES = 300;

const SHAPES = 'line, path, polyline, polygon, circle, ellipse, rect, text, image, foreignObject';
const EASE = 'cubic-bezier(0.33, 1, 0.68, 1)';

function svgAnimations(svg: SVGSVGElement): Animation[] {
  const shapes = [...svg.querySelectorAll<SVGGraphicsElement>(SHAPES)].filter((el) => !el.closest('text') || el.tagName === 'text');
  if (shapes.length === 0) return [];
  if (shapes.length > MAX_SHAPES) {
    return [svg.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: WIPE_SVG, delay: START, easing: EASE, fill: 'backwards' })];
  }
  // Stagger by position, so the figure builds up as a left-to-right sweep (slightly diagonal)
  const vb = svg.viewBox.baseVal;
  const w = vb?.width || svg.clientWidth || 1, h = vb?.height || svg.clientHeight || 1;
  const order = (el: SVGGraphicsElement) => {
    try {
      const b = el.getBBox();
      return Math.min(1, Math.max(0, (0.8 * (b.x - (vb?.x ?? 0))) / w + (0.2 * (b.y - (vb?.y ?? 0))) / h));
    } catch {
      return 0;
    }
  };
  return shapes.map((el) => {
    const delay = START + SPREAD * order(el);
    const style = getComputedStyle(el);
    const stroked = style.stroke !== 'none' && style.strokeDasharray === 'none' && style.fill === 'none';
    if (stroked && el instanceof SVGGeometryElement) {
      const len = el.getTotalLength();
      if (len > 0) {
        const dash = `${len} ${len}`;
        return el.animate(
          [
            { strokeDasharray: dash, strokeDashoffset: len },
            { strokeDasharray: dash, strokeDashoffset: 0 },
          ],
          { duration: STROKE, delay, easing: EASE, fill: 'backwards' },
        );
      }
    }
    // A lone keyframe is the end state unless given offset 0; here it is the start, animating to the element's own value
    return el.animate([{ opacity: 0, offset: 0 }], { duration: FADE, delay, easing: 'ease-out', fill: 'backwards' });
  });
}

/** All intro animations of a figure, created paused at their start (hidden) state. */
function buildIntro(root: HTMLElement): Animation[] {
  const animations: Animation[] = [];
  root.querySelectorAll<SVGSVGElement>('svg').forEach((svg) => {
    if (!svg.closest('button') && !svg.parentElement?.closest('svg')) animations.push(...svgAnimations(svg));
  });
  root.querySelectorAll('canvas').forEach((canvas) =>
    animations.push(
      canvas.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: WIPE_CANVAS, delay: START, easing: EASE, fill: 'backwards' }),
    ),
  );
  root.querySelectorAll('.chip-row, .controls, .readout, .readouts').forEach((el, i) => {
    if (el.parentElement?.closest('.readout')) return;
    animations.push(
      el.animate([{ opacity: 0, transform: 'translateY(6px)', offset: 0 }], { duration: CONTROLS, delay: START + CONTROLS_DELAY + CONTROLS_STEP * i, easing: EASE, fill: 'backwards' }),
    );
  });
  animations.forEach((a) => a.pause());
  return animations;
}

/**
 * Play the intro of a mounted figure once it is in view, and again when the
 * reader comes back after it has been out of view for REPLAY_AFTER. The
 * replay is armed while the figure is still off screen, so it never flashes
 * its final state first, and it is rebuilt from the figure's current content.
 */
export function playIntro(root: HTMLElement): void {
  if (!('animate' in root) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let animations = buildIntro(root);
  let armed = animations.length > 0;
  let timer = 0;

  new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) {
        // Fully out of view: re-arm the intro if the reader stays away long enough
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          animations.forEach((a) => a.cancel());
          animations = buildIntro(root);
          armed = animations.length > 0;
        }, REPLAY_AFTER);
        return;
      }
      clearTimeout(timer);
      if (armed && entry.intersectionRatio >= 0.2) {
        armed = false;
        animations.forEach((a) => a.play());
      }
    },
    { threshold: [0, 0.2] },
  ).observe(root);
}
