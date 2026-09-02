/**
 * Does the feature extraction actually measure what it thinks it measures?
 *
 * Every other check in this repo starts from synthetic *features* and tests the
 * mapping built on top of them. That leaves the step underneath untested: the
 * one that turns MediaPipe landmarks into those features. This builds a face of
 * known size at a known distance, projects it through a pinhole camera into an
 * image of a known shape, normalises the result exactly as MediaPipe does, and
 * asks the extractor what it sees.
 *
 * The answers are checkable against the geometry that produced them, so this is
 * a test rather than a demonstration.
 */

// A DOM-free stand-in, because the module reads window for nothing here but the
// import graph pulls in code that expects a browser.
(globalThis as any).window = (globalThis as any).window ?? { innerWidth: 1456, innerHeight: 949 };
(globalThis as any).localStorage = (globalThis as any).localStorage ?? {
  getItem: () => null,
  setItem: () => {},
};

const { extractGazeFeatures } = await import('../src/services/gazeFeatures');

// --- The camera and the face ------------------------------------------------

/** A 720p webcam: the shape of the image is the whole point of this file. */
const IMAGE_W = 1280;
const IMAGE_H = 720;
const HFOV_DEG = 60;
/** Focal length in pixels, from the horizontal field of view. */
const FOCAL_PX = IMAGE_W / 2 / Math.tan((HFOV_DEG * Math.PI) / 360);

/** Adult anatomy, in centimetres. These are the numbers the extractor assumes. */
const INTEROCULAR_CM = 6.3;
const IRIS_RADIUS_CM = 0.585;
const EYE_HALF_WIDTH_CM = 1.5;
const EYE_HALF_HEIGHT_CM = 0.5;

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Pinhole projection into MediaPipe's normalised frame: x by width, y by height. */
function project(p: Point3): { x: number; y: number; z: number } {
  return {
    x: (IMAGE_W / 2 + (FOCAL_PX * p.x) / p.z) / IMAGE_W,
    y: (IMAGE_H / 2 - (FOCAL_PX * p.y) / p.z) / IMAGE_H,
    z: 0,
  };
}

function rotateRoll(p: Point3, rollRad: number): Point3 {
  return {
    x: p.x * Math.cos(rollRad) - p.y * Math.sin(rollRad),
    y: p.x * Math.sin(rollRad) + p.y * Math.cos(rollRad),
    z: p.z,
  };
}

/**
 * Builds the landmark array the extractor reads.
 *
 * `gazeOffsetCm` slides both irises within their sockets, which is what looking
 * somewhere else does to the picture. Only the indices the extractor actually
 * uses are populated; the rest exist so the length check passes.
 */
function buildLandmarks(options: {
  distanceCm: number;
  rollDeg: number;
  gazeOffsetCm?: { x: number; y: number };
}) {
  const { distanceCm, rollDeg } = options;
  const gaze = options.gazeOffsetCm ?? { x: 0, y: 0 };
  const roll = (rollDeg * Math.PI) / 180;

  const landmarks: Array<{ x: number; y: number; z: number }> = Array.from(
    { length: 478 },
    () => ({ x: 0.5, y: 0.5, z: 0 })
  );

  const place = (index: number, local: { x: number; y: number }) => {
    const rotated = rotateRoll({ x: local.x, y: local.y, z: 0 }, roll);
    landmarks[index] = project({ x: rotated.x, y: rotated.y, z: distanceCm });
  };

  /**
   * Places a point that rotates with the head *and then* takes a displacement
   * fixed in the world.
   *
   * This is what a fixating eye actually does. Roll your head while staying on
   * the same target and the direction from your eye to that target is unchanged
   * in the room, so in the socket the iris has counter-rotated. Rotating the
   * gaze offset along with the skull instead describes an eye painted onto the
   * face, which is the one case where a wrong basis cancels itself out.
   */
  const placeWithWorldOffset = (
    index: number,
    local: { x: number; y: number },
    world: { x: number; y: number }
  ) => {
    const rotated = rotateRoll({ x: local.x, y: local.y, z: 0 }, roll);
    landmarks[index] = project({ x: rotated.x + world.x, y: rotated.y + world.y, z: distanceCm });
  };

  // The extractor mirrors the frame, so eye A here lands on one side and eye B
  // on the other; which is which does not matter to any of the assertions.
  const eyes = [
    { centreX: -INTEROCULAR_CM / 2, spec: { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468, ring: [469, 470, 471, 472] } },
    { centreX: +INTEROCULAR_CM / 2, spec: { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473, ring: [474, 475, 476, 477] } },
  ];

  for (const eye of eyes) {
    const cx = eye.centreX;
    const s = eye.spec;
    const outward = cx < 0 ? -1 : 1;

    place(s.outer, { x: cx + outward * EYE_HALF_WIDTH_CM, y: 0 });
    place(s.inner, { x: cx - outward * EYE_HALF_WIDTH_CM, y: 0 });
    place(s.top, { x: cx, y: EYE_HALF_HEIGHT_CM });
    place(s.bottom, { x: cx, y: -EYE_HALF_HEIGHT_CM });

    placeWithWorldOffset(s.iris, { x: cx, y: 0 }, gaze);
    // Four cardinal points around the iris, as MediaPipe provides.
    placeWithWorldOffset(s.ring[0], { x: cx + IRIS_RADIUS_CM, y: 0 }, gaze);
    placeWithWorldOffset(s.ring[1], { x: cx, y: IRIS_RADIUS_CM }, gaze);
    placeWithWorldOffset(s.ring[2], { x: cx - IRIS_RADIUS_CM, y: 0 }, gaze);
    placeWithWorldOffset(s.ring[3], { x: cx, y: -IRIS_RADIUS_CM }, gaze);
  }

  // Face landmarks used by the head-pose fallback.
  place(1, { x: 0, y: -2 });
  place(10, { x: 0, y: 6 });
  place(152, { x: 0, y: -8 });
  place(234, { x: -7, y: 0 });
  place(454, { x: 7, y: 0 });

  return landmarks;
}

let failures = 0;

function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
}

// --- 1. Distance ------------------------------------------------------------
//
// The iris is very nearly the same physical size in every adult, which is the
// whole reason it is used as a ruler. Put a known iris at a known distance and
// the reported distance should come back.

console.log('\n--- Distance from iris size (head square on) ---');
for (const trueDistance of [40, 50, 60]) {
  const result = extractGazeFeatures(buildLandmarks({ distanceCm: trueDistance, rollDeg: 0 }), {});
  const reported = result?.diagnostics.irisDistanceCm ?? NaN;
  const ratio = reported / trueDistance;
  check(
    `true ${trueDistance} cm`,
    Math.abs(ratio - 1) < 0.05,
    `reported ${reported.toFixed(1)} cm  (${ratio.toFixed(3)}x)`
  );
}

// --- 2. Roll ----------------------------------------------------------------
//
// The eye basis is built from the line between the eyes, so a head rolled by θ
// should produce a basis rotated by θ. If the two image axes are not in the same
// units, it will not.

console.log('\n--- Head roll recovered from the eye line ---');
for (const trueRoll of [0, 7, 15]) {
  const result = extractGazeFeatures(buildLandmarks({ distanceCm: 50, rollDeg: trueRoll }), {});
  const reported = ((result?.headPose.roll ?? NaN) * 180) / Math.PI;
  check(
    `true roll ${trueRoll}°`,
    Math.abs(Math.abs(reported) - trueRoll) < 1.5,
    `reported ${reported.toFixed(1)}°  (error ${(Math.abs(reported) - trueRoll).toFixed(1)}°)`
  );
}

// --- 3. Is the gaze feature isotropic? --------------------------------------
//
// An iris displaced by the same physical distance horizontally and vertically
// should produce gaze features of the same magnitude. The mapping can absorb a
// constant scale difference between the axes, so this one is reported for
// information — but the size of it says how far apart the two axes really are.

console.log('\n--- Equal iris movement, horizontal vs vertical ---');
{
  const horizontal = extractGazeFeatures(
    buildLandmarks({ distanceCm: 50, rollDeg: 0, gazeOffsetCm: { x: 0.1, y: 0 } }),
    {}
  );
  const vertical = extractGazeFeatures(
    buildLandmarks({ distanceCm: 50, rollDeg: 0, gazeOffsetCm: { x: 0, y: 0.1 } }),
    {}
  );
  const gx = Math.abs(horizontal?.features.gx ?? 0);
  const gy = Math.abs(vertical?.features.gy ?? 0);
  const ratio = gy / gx;
  check(
    'vertical vs horizontal sensitivity',
    Math.abs(ratio - 1) < 0.05,
    `gx ${gx.toFixed(4)}  gy ${gy.toFixed(4)}  (ratio ${ratio.toFixed(3)})`
  );
}

// --- 4. Does a roll change the horizontal reading? --------------------------
//
// This is the one that costs accuracy. Rolling the head does not change where
// the person is looking, so gx must not move. If the basis is built in a
// distorted space it will, and the calibration cannot absorb it because it
// varies with a pose the model is not told about.

console.log('\n--- Same gaze, head rolled: gx must not move ---');
{
  const upright = extractGazeFeatures(
    buildLandmarks({ distanceCm: 50, rollDeg: 0, gazeOffsetCm: { x: 0.12, y: 0 } }),
    {}
  );
  for (const roll of [7, 15]) {
    const rolled = extractGazeFeatures(
      buildLandmarks({ distanceCm: 50, rollDeg: roll, gazeOffsetCm: { x: 0.12, y: 0 } }),
      {}
    );
    const drift = Math.abs((rolled?.features.gx ?? 0) - (upright?.features.gx ?? 0));
    // Screen width spans roughly 0.16 feature units, so this converts the drift
    // into the fraction of the screen the estimate would jump by.
    const screenFraction = drift / 0.16;
    check(
      `roll ${roll}° with gaze held still`,
      screenFraction < 0.02,
      `gx moved ${drift.toFixed(5)} = ${(screenFraction * 100).toFixed(1)}% of screen width`
    );
  }
}

console.log(failures === 0 ? '\nAll geometry checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
