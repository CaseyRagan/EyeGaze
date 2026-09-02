# Lantern

Webcam eye tracking for therapy and for play. Two jobs, deliberately in one app:

- **A measurement tool** for audiologists, and for occupational and speech
  therapists — guided calibration that reports its accuracy in degrees of visual
  angle rather than a reassuring percentage, and a reading assessment that
  reports fixations, regressions, span of recognition and reading rate against
  developmental norms.
- **Something worth doing** for the person in the chair — mazes, targets, join-the-dots,
  drawing and a communication board, all driven by gaze alone.

## Running it

```bash
bun install      # or npm install
bun run dev      # http://localhost:3000
```

Needs a webcam and a browser with `getUserMedia`. The face model is fetched from
a CDN on first run, so the first load needs a network connection.

```bash
bun run typecheck          # tsc --noEmit
bun run check:calibration  # synthetic regression test of the gaze mapping
bun run check:reading      # reading measures against hand-built gaze streams
```

## Accuracy

Accuracy is the whole game, and `docs/accuracy.md` is the honest account of it:
what limits it, what the numbers mean, whether a chin rest is worth buying, and
whether camera angle matters. Short version:

- Set up the screen angle **before** calibrating and leave it alone. On a laptop,
  tilting the lid afterwards re-aims the camera and quietly invalidates the
  calibration. This is the most common way a good session goes bad.
- Light the face from the front. A window behind the head is the most common
  reason a calibration comes out poor.
- Run the six-second head-movement pass. On synthetic ground truth it cuts the
  error caused by shifting in the seat from 2.5° to 0.3°, and it is most of what
  a chin rest would have bought you.
- Nine points for a session, thirteen before a reading assessment. Five points is
  worth roughly 2–3° — fine for the games, not for measuring anything.
- Check the viewing distance in settings once. Accuracy in degrees is computed
  from it, so an estimate that is out by a factor of two reports twice the error
  you actually have.
- **Do not sit close to the screen.** What matters is how far off centre the
  window edges sit: past about 22° the iris starts hiding behind the eyelid and
  accuracy collapses, while precision stays deceptively good. Set-up computes
  this and tells you how far back to sit. On a small laptop that is usually
  45–55 cm.
- On a Mac, turn off Centre Stage, Portrait and Studio Light. Centre Stage
  re-frames the picture as you move, which pulls the calibration apart
  underneath you.

The head-position guide stays on screen during a session so anyone who shifts,
or looks away and back, can line up again without redoing set-up. Press **H** to
toggle it, **C** to re-centre after a big move, **K** to run set-up again.

The check step after calibration measures error at five points the model was
never fitted on, so the figure it reports cannot flatter itself. Everything the
app displays is measured; nothing is a placeholder.

## Layout

```
src/services/
  gazeFeatures.ts     landmarks -> scale-, roll- and foreshortening-invariant eye measurement
  calibration.ts      eye measurement -> screen, plus head compensation and drift detection
  viewingGeometry.ts  pixels <-> degrees of visual angle
  readingMetrics.ts   fixations -> reading measures
  gazeBus.ts          gaze distribution that does not re-render React at camera rate
  faceMeshTracker.ts  camera, MediaPipe, filtering, event classification
src/data/             reading passages and developmental norms
scripts/              synthetic regression test of the mapping
docs/accuracy.md      why the pipeline is shaped the way it is
```

## A caution about the reading norms

The grade equivalents come from the Taylor developmental norms (Educational
Developmental Laboratories, 1960) — the reference set the established clinical
reading-eye-movement instruments report against. They were collected with
infrared instruments on printed text. A webcam reading a screen is a different
measurement and agreement has not been established.

Use the figures to track change within a client over time. Check them against
your own service's reference before they go in a report.
