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

### 3b. Sitting too close — the one that looks like a software fault

This deserves its own entry because it is invisible from either number that
causes it, and because its symptom points the wrong way.

What matters is not the viewing distance and not the screen size, but the angle
they produce together: how far off centre the edges of the window sit. At 27 cm
from a laptop, that is over 30 degrees. Webcam iris tracking degrades badly well
before then — past roughly 22 degrees the iris slides behind the eyelid and the
inner corner, so less of it is visible to estimate a centre from; its outline
turns increasingly elliptical; and people stop rotating their eyes that far and
start turning their heads instead, which breaks the assumption the calibration
rests on.

The symptom is the confusing part. Precision stays *good* — the estimate is
steady, confidence is high, the eyes are found in 95% of frames — while accuracy
is terrible and worst at the edges. A steady estimate that lands in the wrong
place looks exactly like a broken mapping, so it sends you into the software.

Real numbers from a session that prompted this: 9-20 degrees of error, steadiness
of 0.5-0.85 degrees, 95% of frames tracked, at a measured 27 cm. The tracker was
working; it was being asked for something no webcam can deliver.

`GazeRangeCheck` computes the half-angle and says how far back to sit. Below
about 22 degrees is comfortable. The alternatives, when moving back is not an
option, are a smaller browser window or a reduced working area.

### 3c. Camera processing that re-frames the picture

On a Mac, Centre Stage crops and pans the camera image to keep the subject
framed. That is precisely the opposite of what eye tracking needs: it changes
the apparent head position and size continuously, and independently of what the
head is actually doing, which corrupts the head-position features and the
distance estimate at the same time. Portrait mode and Studio Light alter the
image in less catastrophic but still unhelpful ways. All three are off by
default but easy to enable by accident from Control Centre.

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

## Things that quietly broke it, and how they were found

Worth recording, because each one produced plausible-looking numbers rather than
an obvious failure.

**The reported degrees were three times too large.** A real session reported
9.3 degrees of error at 163 px. Working backwards through the pixels-to-degrees
conversion, that implied a viewing distance of about 18 cm — impossible. The
tracking was roughly 3 degrees; the *reporting* was wrong. Both distance
estimates divide by an assumed camera field of view, and webcams vary enough
that the raw figure can be out by a large factor. They are now cross-checked
against each other, the measurement is refused when they disagree, and the user
can anchor it with one tape-measure reading in settings.

The lesson generalises: an accuracy figure in degrees is a claim about physical
geometry, and it is only as good as the two physical numbers underneath it.

**The transformation matrix was being read in the wrong order.** MediaPipe's
`MatrixData` proto carries a `layout` field; the JavaScript wrapper reads rows,
columns and data, and drops it. Assuming column-major when the data is row-major
transposes the rotation — which swaps yaw with pitch and inverts their signs —
and reads the translation out of a row of zeros. The layout is now detected from
the numbers: a rigid transform has its zero row at elements 3, 7, 11 written one
way and at 12, 13, 14 written the other, and exactly one of those holds.

**The calibration dots were drawn in the wrong coordinate space.** They were
positioned as a percentage of a flex container sitting below the header, while
anchors were stored as a fraction of the viewport. Every calibration therefore
learned a vertical offset of the header's height at the top of the screen,
tapering to nothing at the bottom. It was invisible in validation, because the
check inherited the same offset and cancelled it — the sort of bug that only
shows up when you make the test space and the production space differ. Caught by
driving the calibration in mouse-simulation mode, where the reported error
should be exactly zero and was 0.9 degrees.

**One bad point was contaminating the whole surface.** Least squares spreads a
single bad anchor's error across the entire fit, so a blink or a glance away at
the wrong moment degraded accuracy everywhere, not just near that point.
Leave-one-out error identifies such a point cleanly, and `pruneOutlierAnchors`
drops at most two of them. On synthetic data with one point captured while the
client looked at the opposite corner, this takes the result from 2.06 to 0.85
degrees; on a clean grid it removes nothing.

## The working area

For someone who cannot sit further back — or a client whose eyes genuinely
cannot make large excursions, which is common in exactly the populations this
tool is built for — the working area setting confines calibration and every
activity to a centred fraction of the window.

This is a better trade than it first appears. Accuracy is much better near the
centre than at the edges, so shrinking the area does not merely make targets
smaller: it moves all of them into the part of the range the tracker handles
well. A 70% working area takes a 32 degree half-angle down to 24.

## Things that were tried and did not help

Recorded so nobody spends the afternoon re-deriving them.

**Feeding the two eyes in separately.** The binocular estimate averages the left
and right eye 50/50. Handing the regression the difference between them instead
lets it learn the weighting that best predicts gaze, which should help when one
eye is noisier — a spectacle frame, glare on one lens, sitting slightly
off-axis. Measured on synthetic data with one eye four times noisier than the
other, it was worth about 5%. The reason is that each calibration point is
already a median over roughly thirty samples, which removes most of the
per-sample noise this was meant to address; what remains is structural fit
error, and re-weighting the eyes does not touch it. Two extra model parameters
for 5% is a bad trade on real data, so the average stands.

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

Degrees depend on two physical numbers: the screen diagonal entered in settings,
and the viewing distance. If either is wrong, every degree figure is wrong with
it, and the UI says so — and warns outright when the distance comes out somewhere
a person could not actually be sitting.
