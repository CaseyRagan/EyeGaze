/**
 * Draws the head-position picture shared by set-up and the in-session guide.
 *
 * The important property is that the head **changes size with distance**. An
 * outline that only slides around tells you nothing about the one axis people
 * most often drift along, and depth drift is expensive: leaning in by 10 cm
 * from a 50 cm calibration throws the estimate outward by a fifth of the way to
 * the screen edge. Being told "drifting" without being shown which way to move
 * is not feedback, it is a scolding.
 *
 * So the live outline grows as you come closer and shrinks as you lean back,
 * and sits exactly on the dashed target when you are where you should be.
 */

export interface HeadPositionDrawOptions {
  width: number;
  height: number;
  /** 1 = exactly at the target distance; >1 = closer than target. */
  scale: number;
  /** Head offset from centre, in normalised image units. */
  translateX: number;
  translateY: number;
  yaw: number;
  pitch: number;
  roll: number;
  aligned: boolean;
  /** No face in frame, or nothing to compare against yet. */
  state: 'tracking' | 'no-face' | 'no-target';
  emptyLabel?: string;
}

/** Head offsets are scaled by this to fill a useful part of the box. */
const POSITION_GAIN = 1.15;

export function drawHeadPosition(ctx: CanvasRenderingContext2D, o: HeadPositionDrawOptions) {
  const { width: w, height: h } = o;
  ctx.clearRect(0, 0, w, h);

  const style = getComputedStyle(document.documentElement);
  const readVar = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const faint = readVar('--color-ink-faint', '#8b938f');
  const sage = readVar('--color-sage-500', '#4e8779');
  const clay = readVar('--color-clay-400', '#cc8f6e');

  // The target outline is sized so a correctly-placed head fills it exactly.
  const targetRx = Math.min(w, h) * 0.26;
  const targetRy = targetRx * 1.28;
  const cx = w / 2;
  const cy = h / 2;

  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = o.aligned ? sage : faint;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, targetRx, targetRy, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  if (o.state !== 'tracking') {
    ctx.fillStyle = faint;
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(o.emptyLabel ?? '', cx, h - 10);
    return;
  }

  const colour = o.aligned ? sage : clay;

  // A soft halo when everything lines up, so the moment of getting it right is
  // unmistakable without needing to read anything.
  if (o.aligned) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, targetRx + 10, targetRy + 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = sage;
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  const headX = cx + o.translateX * Math.min(w, h) * POSITION_GAIN;
  const headY = cy + o.translateY * Math.min(w, h) * POSITION_GAIN;
  const rx = targetRx * o.scale;
  const ry = targetRy * o.scale;

  ctx.save();
  ctx.translate(headX, headY);
  ctx.rotate(o.roll);

  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.16;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = o.aligned ? 2.5 : 2;
  ctx.strokeStyle = colour;
  ctx.stroke();

  // Eyes, so the picture reads as a face and the direction it is turned is
  // obvious at a glance rather than needing to be read off a number.
  const eyeSpacing = rx * 0.38;
  const yawShift = -o.yaw * rx * 0.8;
  const pitchShift = o.pitch * ry * 0.5 - ry * 0.12;
  ctx.fillStyle = colour;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * eyeSpacing + yawShift, pitchShift, Math.max(1.8, rx * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export interface AlignmentInput {
  scale: number;
  translateX: number;
  translateY: number;
  targetTranslateX: number;
  targetTranslateY: number;
  yaw: number;
  pitch: number;
}

export interface AlignmentVerdict {
  aligned: boolean;
  /** Plain instruction, or null when nothing needs saying. */
  instruction: string | null;
}

/**
 * What to tell someone to do about their position, one thing at a time.
 *
 * Depth comes first because it is the largest source of error and the hardest
 * to notice, and because a list of three simultaneous corrections is not
 * something anyone can act on.
 */
export function judgeAlignment(input: AlignmentInput): AlignmentVerdict {
  const dx = input.translateX - input.targetTranslateX;
  const dy = input.translateY - input.targetTranslateY;
  const turnDeg = (Math.hypot(input.yaw, input.pitch) * 180) / Math.PI;

  if (input.scale > 1.14) return { aligned: false, instruction: 'Move back a little' };
  if (input.scale < 0.88) return { aligned: false, instruction: 'Come a little closer' };
  if (dx > 0.045) return { aligned: false, instruction: 'Shift a little to your right' };
  if (dx < -0.045) return { aligned: false, instruction: 'Shift a little to your left' };
  if (dy > 0.05) return { aligned: false, instruction: 'Sit up a little' };
  if (dy < -0.05) return { aligned: false, instruction: 'Lower your seat a little' };
  if (turnDeg > 12) return { aligned: false, instruction: 'Face the screen square on' };

  return { aligned: true, instruction: null };
}
