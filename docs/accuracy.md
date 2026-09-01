# Accuracy on a built-in webcam

This is the reasoning behind the tracking pipeline, and the honest answer to
"how accurate can this get, and would a head frame help?"

## What limits accuracy

The error you actually experience is the sum of four things. They are listed in
rough order of how much they cost on typical laptop hardware.

### 1. Head translation — the biggest single term

Sliding sideways in the chair changes the eye rotation needed to fixate the same
point on the screen. At a 55 cm viewing distance, moving 3 cm sideways changes
the required rotation by about 3°. A good webcam calibration is worth roughly
1–2°, so a small shift in posture can more than double the total error.

Nothing in the eye measurement can detect this on its own: the eye looks exactly
the same whether you moved your head or moved your gaze. The mapping only knows
because the head-position features tell it.

**Mitigations in the app.** Head movement is undone in feature space, before the
mapping, by `compensateForHead` in `calibration.ts`. This has to happen before
the polynomial rather than as a correction after it: head movement shifts the
measurement itself, so the observed feature is the one the client would have
produced looking somewhere else entirely, and no additive correction downstream
of a curved mapping can recover from that.

The compensation constants come from anatomy and camera geometry, so they work
even for a client who held perfectly still during calibration. The
head-movement pass then measures them for the individual — see below.

There is also a live posture monitor (`PostureGuide`) reporting drift in
centimetres, and a one-point drift correction (`RecentreOverlay`) that removes
the constant part of the residual error in about two seconds.

### 2. Distance changes

Moving nearer or further changes the angular size of the screen, so a mapping
learned at one distance over- or under-shoots at another.

The eye *measurement* itself is already distance-invariant: every feature is a
ratio of two lengths measured on the same eye (iris offset over eye width), so
it does not change when the face gets bigger or smaller in frame. What changes
is the geometry between the eye and the screen. Error grows roughly in
proportion to the fractional change in distance.

A frame fixes distance as a side effect of fixing translation. Without one, the
posture monitor reports depth drift and prompts a re-centre.

### 3. Head rotation

Turning or nodding is partly handled. Because the iris offset and the eye width
foreshorten by the same cosine factor when the head turns, their ratio survives
moderate rotation unchanged — this is a real advantage of the ratio formulation
over measuring iris position directly. Yaw and pitch also enter the regression
as features.

What is not handled is the far eye becoming occluded at large yaw angles. The
binocular fusion weights each eye by how square-on it is to the camera, so the
estimate degrades gracefully rather than jumping, but accuracy still falls off
past roughly 20°.

### 4. Landmark noise

The iris centre estimate wobbles by a fraction of a pixel frame to frame, and
that wobble is amplified by the mapping. This is the floor on precision — the
"steadiness" number the check reports.

**Mitigations.** Capture runs at 1280×720 rather than 640×480 where the camera
allows it, which roughly halves the angular cost of one pixel of landmark noise
and is the cheapest accuracy win available. A 1€ filter runs on the features
before the mapping can amplify them, and a second on the screen position.

## Does camera angle matter?

**Not directly, as long as it does not change.** The camera's position and angle
relative to the screen is a fixed geometric relationship, and calibration
absorbs it. A camera below the screen, off to one side, or tilted is fine.

Three things about camera placement *do* matter:

1. **The angle must not change after calibration.** On a laptop this is the
   single most common cause of a calibration silently going bad: tilting the lid
   re-aims the camera relative to the screen and invalidates the mapping. Set
   the screen angle before calibrating and leave it. The set-up screen says so
   explicitly.

2. **Extreme vertical angles hurt the vertical axis.** A camera far below eye
   level — a laptop low on a desk, a client looking down at it — foreshortens
   the eye vertically, so the vertical iris offset shrinks and its
   signal-to-noise falls. Vertical is already the weaker axis; a very low camera
   makes it markedly worse. Raising the laptop so the camera is near eye level
   is worth doing.

3. **Both eyes must be visible and lit from the front.** Light behind the head
   puts the eyes in shadow, which is the most common cause of a poor result in
   practice.

## The head-movement pass

This is the most useful thing in the pipeline for free-headed use, and it is
worth understanding why it exists.

How much the eye must counter-rotate for a given head movement depends on the
ratio of eyeball radius to eye width, and on the camera's field of view. Both
vary between people and between machines, by enough to matter. So the nominal
constants are only ever approximately right.

They cannot be measured from the ordinary calibration grid. There, each screen
position is seen at exactly one head pose, so "the eye moved because the head
moved" and "the eye moved because they looked somewhere else" are perfectly
aliased. No amount of cleverness separates them from that data.

Holding the target fixed while the head moves removes the ambiguity. Every bit
of variation in the measurement is then head-driven, and a plain three-parameter
regression recovers the coefficients directly. Six seconds is enough.

Measured on synthetic data whose true coefficients sit 30% away from the nominal
ones (`scripts/calibrationCheck.ts`), for a 5° head turn combined with a 1.6 cm
lateral shift:

| | error after the head moved |
|---|---|
| no compensation at all | 6.1° |
| nominal constants only | 2.5° |
| after a head-movement pass | 0.3° |

Those are synthetic numbers on an idealised eye and should be read as evidence
that the mechanism works, not as a promise about a real client. But the size of
the effect is why the pass is on by default.

## So: is a head frame worth it?

**Yes, and mainly for translation rather than distance** — which is worth
stating, because the intuitive reason to add a frame is usually "to keep the
distance constant", and distance is the term the pipeline already handles best.

Expected effect of a chin/forehead rest:

- Removes most of term 1, the largest error source.
- Removes term 2 as a side effect.
- Reduces term 3, since a rested head rotates less.
- Does nothing for term 4.

A reasonable expectation on a decent built-in webcam with good lighting is
1.5–2.5° free-headed, and 0.8–1.5° with a rest — but measure it rather than
trusting the estimate. That is what the check step is for, and it is why it
measures at points the model was never fitted on.

**If a frame is not practical** — and many clients will not tolerate one — run
the head-movement pass. On the synthetic evidence above it recovers most of what
a rest would have given you, and it costs six seconds rather than a piece of
equipment and a conversation about putting your chin on it. The posture monitor
and quick re-centring cover the rest, provided someone acts on the prompts.

A frame is still the better answer where it is tolerated, for assessment work,
and for clients whose head position varies a lot within a session.

## How the mapping works

Eye measurement (`gazeFeatures.ts`) → regression (`calibration.ts`) → screen.

The features are, per eye, the iris centre's offset from the midpoint of the two
eye corners, projected onto a basis built from the line between the eyes and
divided by that eye's corner-to-corner width. This gives scale invariance
(term 2), roll invariance, and foreshortening invariance (term 3) in one step.

Two notes on things that were wrong in an earlier version and are worth not
reintroducing:

- The vertical component must **not** be normalised by the eyelid aperture. The
  aperture changes with every blink, squint and raised eyebrow, which couples
  all of those directly into the vertical gaze estimate.
- Interpolating between calibration points by inverse-distance weighting of
  their *screen positions* does not work. IDW is an averaging interpolator: it
  cannot leave the convex hull of its inputs, so the estimate collapses toward
  the centroid of the calibration grid and the screen edges become unreachable.

The mapping is a ridge-regularised polynomial whose feature set grows with the
number of calibration points, plus a Gaussian-kernel local correction of the
residuals that fades to zero away from the calibrated region. Head pose is
handled upstream of the polynomial, in feature space, and deliberately does
*not* also appear as an additive output term: having both competing for the same
signal leaves each of them underdetermined, and measurably degrades the result.

`scripts/calibrationCheck.ts` exercises all of this against synthetic ground
truth, including the edge-reachability property that the old interpolator
failed. Run it with `bun run check:calibration`.

Measured there on a curved synthetic eye with realistic landmark noise:

| grid | error at points it was never fitted on |
|---|---|
| 5 points | ~2.5° |
| 9 points | ~0.6° |
| 13 points | ~0.25° |

which is why the set-up screen describes five points as good enough for the
games but not for measuring.

## What the numbers mean

- **Accuracy** — mean distance between the estimate and the true target, at five
  points the model was not fitted on. Reported in degrees of visual angle, using
  the screen size from settings and a viewing distance measured from the face
  model.
- **Steadiness (precision)** — root-mean-square distance between successive
  samples while holding still. This is the figure eye-tracker specifications
  normally quote as precision.
- **Eyes found** — the share of frames during the check that produced a usable
  estimate. A high accuracy figure computed from 40% of frames is not
  trustworthy, so this is always shown alongside.

Degrees depend on the screen diagonal entered in settings. If that is wrong, the
degree figures are wrong with it, and the UI says so.
