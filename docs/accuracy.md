# Accuracy on a built-in webcam

This is the reasoning behind the tracking pipeline, and the honest answer to
"how accurate can this get, and would a head frame help?"

## The two image axes were never in the same unit

This one sat underneath everything else for the whole project, and none of the
existing checks could see it, because they all started from synthetic *features*
and tested the mapping built on top of them. The step underneath — landmarks into
features — had no test at all.

MediaPipe normalises landmark `x` by the image width and `y` by the image height.
On a 1280x720 camera one vertical unit is therefore **1.778 horizontal units**.
Every length in `gazeFeatures.ts` was computed with `hypot` across those two axes
as though they were the same: the iris radius, the eye width, the distance
between the eyes, the eyelid aperture.

`scripts/geometryCheck.ts` builds a face of known size at a known distance,
projects it through a pinhole camera into an image of a known shape, normalises
the result the way MediaPipe does, and asks the extractor what it sees. Before
the fix:

| measurement | truth | reported |
|---|---|---|
| distance | 40 / 50 / 60 cm | 28.8 / 36.0 / 43.2 cm — **0.720x**, at every distance |
| head roll | 7° | 12.3° |
| head roll | 15° | 25.5° |
| vertical vs horizontal gaze sensitivity | 1.000 | **1.778** — exactly the aspect ratio |
| horizontal estimate while rolling the head 15° | no movement | 3.9% of the screen |

After: 1.000x at every distance, roll exact, sensitivity ratio 1.000, and the
roll drift down to 0.9%.

What it was costing:

- **Every figure quoted in degrees**, because they all scale with the viewing
  distance, and the iris ruler was reading 28% short. So was the advice about
  where to sit — "aim for 45 cm" was seating people at about 62.
- **Vertical head compensation.** The constant is derived from the image width,
  but it was being applied to a vertical feature inflated by 1.778, so the pitch
  term was under-applied by that factor.
- **Anyone who tilts their head.** The eye basis is built from the line between
  the eyes; in a stretched space it over-rotates, and the horizontal estimate
  drifts with a pose nothing downstream is told about.
- **The blink thresholds**, which are an aperture-to-width ratio. They were tuned
  by eye on a 16:9 camera with that camera's stretch baked in, so they quietly
  meant something different on a 4:3 webcam. They are now divided through by it.

Because the gaze features changed meaning, the stored calibration key moved to
`v4`: a model fitted before this is wrong in a way nothing downstream could
detect, so old ones are dropped rather than loaded.

## Knowing how big the screen is, without asking

Every figure reported in degrees is scaled by the physical size of the screen,
and the browser will not tell you it — CSS "inches" are defined as 96 CSS pixels
and have nothing to do with the glass. So it was a number in settings, which
people reasonably forgot to set until after they had already calibrated. A wrong
one is invisible: it rescales every accuracy figure without anything looking
broken.

Two things are available instead of asking.

**The panel's own resolution.** `screen.width * devicePixelRatio` is the native
panel resolution, and for the machines this tool runs on — laptops and tablets —
that identifies the panel, because manufacturers ship a small number of
distinctive ones. 3024x1964 is a 14-inch MacBook Pro and nothing else. The table
in `screenSize.ts` is deliberately Apple-heavy: those panels identify exactly. A
Windows laptop at 1920x1080 is deliberately *absent*, because that resolution
spans 13 to 17 inches and a guess there would be worse than admitting the guess.

**A bank card.** ID-1 is 85.60 x 53.98 mm by international standard, so a card
held against an on-screen rectangle the user drags to match measures the screen
directly. That is exact rather than inferred, and it is what the unknown panels
get. It also measures millimetres per pixel, which is the quantity everything
downstream actually wants — the diagonal is only a proxy for it.

The card is also where the figure now lives in the *set-up flow*, next to the
distance check, rather than only in settings. The failure being prevented is one
of timing, and no amount of detection helps the panel it cannot recognise.

Worth stating plainly, because it reads worse than it is: **the calibration does
not depend on this.** Targets are placed as fractions of the window and the model
is fitted in those fractions, so a wrong screen size produces a wrong *number*,
not a wrong mapping. Correcting it afterwards re-reports the same session
correctly.

## A disagreement is not a reason to use a number nobody chose

The viewing distance is estimated two ways, and when they disagreed by enough the
code fell back to `assumedDistanceCm` — a fixed 55 cm from settings. The
reasoning was that a measurement the app cannot vouch for is worse than a
default. It is not. The default is a number nobody chose, and substituting it
means a client who really is at 40 cm has every figure rescaled by a third with
no indication anything happened.

Disagreement is real information, but it is information about *how much* to trust
the figure, not about whether to use it — so it is reported as confidence
(`good` / `uncertain` / `assumed`) and the interface asks for one tape measure.

This surfaced immediately after the aspect-ratio fix. The two estimates used to
agree at 0.87, which looked reassuring; with the iris ruler corrected they fell
to 0.38, which looks worse and is more honest. Their ratio is independent of the
assumed field of view — both scale with focal length identically — so a stable
disagreement is telling us the person's anatomy differs from the assumed
constants, not that the measurement failed.

## Keeping the samples, not just the conclusions

Everything else this app reports is a summary — an accuracy figure, a
cross-validated error, five per-point numbers. A summary is enough to know a
session went badly and never enough to know why. Four disappointing runs in a row
produced four different signatures, each diagnosed by inference from about five
aggregate numbers, which is guessing with extra steps.

A session can now be saved from the result screen. It contains every sample that
went into every calibration point — not the accepted subset, the whole window,
because which samples *should* have been accepted is one of the things worth
re-deciding later — along with whether each was judged settled at the time, when
it arrived, the head pose it was taken at, the head-movement pass, and the fitted
model including its residuals. About 130 KB for a nine-point session. It stays on
the machine unless someone sends it.

`bun run replay <file>` is the other half, and without it the file is just data.
It rebuilds the calibration from the recorded samples, reproduces the accuracy
figure the client was shown — which is the check that the recording is complete
enough to reason from — and then refits the *same* samples under variations,
scoring each on the check points no variant was fitted on:

```
--- Same samples, different model (scored on the check points) ---
  as it ran                          0.36°  (15 px)   loo 63 px   terms 1
  no head compensation               0.36°  (15 px)   loo 63 px   terms 1
  global fit only (no local term)    0.59°  (24 px)   loo 63 px   terms 1
  every sample, settled or not       0.40°  (16 px)   loo 62 px   terms 1
```

It also answers, directly, two questions that were previously guessed at: whether
the head-movement pass contained any head movement (it reports the yaw and pitch
actually swept, so a pass that "succeeded" while measuring nothing says so), and
how far the head drifted between teaching the model and checking it — the one
failure where the grid is internally consistent, the check is internally
consistent, and they describe two different head positions.

The point is that a change to the mapping can now be argued from a real client's
eyes rather than from synthetic data and a plausible story. Every number above is
measured on held-out points, so a variation that fits the grid better and the
check worse is one that has learned the grid, and the table says so.

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

A screen point sitting X cm off centre demands an eye rotation of atan(X / D),
so the whole mapping scales with viewing distance. Calibrate at 50 cm, lean in
to 40 cm, and every estimate flies outward by a quarter unless the mapping
shrinks to match — a fifth of the way to the screen edge at the extremes.

The eye *measurement* is already distance-invariant: every feature is a ratio of
two lengths on the same eye, so it does not change when the face gets bigger in
frame. What changes is the geometry between the eye and the screen.

`getDepthScale` handles it, using the ratio of apparent eye separation now to
what it was at calibration. That ratio is a direct measurement and cancels the
assumed camera optics that make the absolute distance figure unreliable. On
synthetic data, a 50 to 40 cm lean costs 1.29 degrees uncorrected and 0.49 with
the correction.

This was measured and reported as "drifting" for a while before it was acted on,
which is a poor combination: the client is told they have moved without being
told what it costs, and without the estimate being fixed. Leaning in to look at
something is close to a reflex, so it has to be handled rather than warned about.

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
regression recovers the coefficients directly.

### The head was turning the wrong way

The landmarks are mirrored, so the picture matches what the client sees and
"looked to the right" means the irises moved right. MediaPipe's transformation
matrix is **not** mirrored — it arrives in the camera's own frame. Head yaw taken
straight from that matrix therefore pointed the opposite way to every quantity it
was combined with.

Nothing catches that by inspection, and downstream it does not look like a sign
error. It looks like head compensation making accuracy worse, and like the pass
that measures how much to apply returning a negative number that gets rejected
for being out of range. Both of those were happening, for months.

Two recorded sessions proved it without any appeal to matrix conventions.
Turning your head left rotates you left *and* slides your eyes left, because the
pivot is your neck — so in one consistent frame those must move together:

| | yaw vs sideways travel | pitch vs vertical travel |
|---|---|---|
| session 1 | **−0.98** | +0.99 |
| session 2 | **−0.99** | +0.99 |

A horizontal mirror negates rotation about the vertical axis (yaw) and about the
view axis (roll), and leaves rotation about the horizontal axis (pitch) alone.
That is exactly the pattern. `scripts/geometryCheck.ts` now builds a yawed head
with matching landmarks and matrix and requires the two to agree; it failed
before the fix and passes after.

The clearest confirmation is in the shape of the curve. Sweeping the
compensation multiplier against held-out error, *before* the fix both sessions
fell monotonically all the way to the most negative value tried — the signature
of a term pointing the wrong way. After it, both have an interior minimum, which
is what a real physical parameter looks like.

### Turning and nodding are not the same measurement

The gain fit produced one `rotation` figure and `compensateForHead` applied it to
both axes. Measured separately on the movement pass, across three recorded
sessions from the same person:

| | turn (yaw → horizontal) | nod (pitch → vertical) |
|---|---|---|
| session 1 | **+0.68** | −0.22 |
| session 2 | **+0.65** | −0.25 |
| session 3 | **+0.83** | −0.10 |

Reproducible, and nothing like each other. The reason is anatomical rather than
numerical: **the eyelid follows the eye vertically.** Look down and the lid comes
down with you, clipping the visible iris and dragging its estimated centre back
toward the middle of the aperture. The vertical feature therefore under-responds
to vertical eye rotation in a way the horizontal one does not, and a small or
slightly negative vertical gain is the honest result rather than a broken one.

Merging them meant applying a horizontally-derived number to the vertical axis.
In session 3, whose entire error was a 6.5° drift in head pitch between teaching
the model and checking it, that is the one place it could do most harm — top-row
check points came in at 0.09° and 1.31° while the bottom row was 9.76° and
11.52°, an error growing straight down the screen.

Each axis is now fitted and applied on its own, with its own plausible range:
horizontal is a well-conditioned measurement so a figure far from the textbook
constant there is a failure, while vertical is allowed to be near zero because
that is what it repeatedly is.

Replayed across the three sessions: **5.30° mean → 4.60°.** Two improved
substantially (5.14 → 3.72 and 5.04 → 4.23) and one got slightly worse
(5.72 → 5.86), which is recorded here rather than rounded away.

### One bad axis was destroying a good one

Even with the sign right, the gain fit kept failing. The horizontal and vertical
estimates are separate measurements of very different quality — horizontal is
easy, because the eye sweeps a wide arc with the iris fully visible; vertical is
not, because the lid covers the iris as the eye rolls. On one session horizontal
came back at 0.65, perfectly plausible, and vertical at −0.25, which is not a
person but a failed measurement. Their weighted mean was 0.20, below the
plausible floor, so the entire pass was written off.

An implausible estimate is now discarded as a failure on that axis rather than
folded into the answer for the other. Both recorded sessions now measure a gain
of 0.65 and 0.68 — two independent measurements of the same person agreeing, at
about two thirds of the textbook constant.

### An unmeasured gain must not be applied to an aliased grid

The section above has always said the head gain cannot be *measured* from an
ordinary calibration grid, because each screen position is seen at exactly one
head pose and the two explanations for a moved eye are aliased. The corollary
went unnoticed for much longer: it cannot safely be **applied** to that grid
either.

People turn their head toward whatever they are looking at. In a recorded
session, head yaw against target x came back at **r = −0.87** — nearly as
correlated with the target as the eye signal itself (r = +0.98). Subtracting a
head term from the feature therefore subtracts most of the gaze signal with it,
and the regression has to fight its own input to get back to where it started.

Sweeping the multiplier on that recording, scored on the five check points the
model never saw:

| head gain | held-out error |
|---|---|
| ×0 | **4.32°** |
| ×0.5 | 4.82° |
| ×1 (nominal) | 5.27° |
| ×2 | 6.04° |

Monotonic. Compensation was costing a degree, and the more of it, the worse.

**That sweep was measured with the head turning the wrong way**, and the section
above explains why. With the sign corrected the curve has an interior minimum
and compensation is roughly a wash across the two sessions — it helps one by
0.43° and costs the other the same. The reasoning below still stands as the
right default when the gain *cannot* be measured, which is the only case it now
applies to; it is no longer the whole story it briefly appeared to be.

The pose measurement is also noisier than the movement it is correcting for: on
that session the within-dwell spread of head yaw was 0.19° against 0.27° of real
drift across the grid — a signal-to-noise ratio of 1.46. Even without the
aliasing there is not much there worth correcting.

So compensation is now applied only to the extent it is trustworthy. Measured by
the movement pass — which holds the target still and breaks the aliasing by
construction — it is trusted in full. Unmeasured, on a grid where head pose
tracks the targets, it is not applied at all. Unmeasured but on a grid where the
head genuinely stayed put, it is applied, because there is nothing for it to be
confused with. Nothing is lost in the case that matters: compensation exists for
movement *after* set-up, and where the pose is aliased with the targets the
regression has already absorbed that person's head behaviour into its weights.

### Rotation and translation cannot be separated from one movement

The pass fits two constants: how much the eye counter-rotates per radian of head
turn, and how much per unit of sideways head travel. It could not have been
measuring both, because **you rotate about your neck, not about your eyeballs**.
Turning your head by dθ also slides your eyes sideways by roughly 10 cm · dθ, so
the two regressors arrive almost perfectly correlated. Working the constants
through, the rotation term carries about **eight times** the leverage of the
translation term, so least squares can trade a small change in one against a
large change in the other at almost no cost in residual. The split it returns is
arbitrary, and it is then applied to every prediction afterwards.

A field report showed exactly that: rotation pushed outside its plausible range
and silently replaced by the fallback, translation left at 0.507, and the
accuracy check afterwards 2.4x worse than the calibration grid it was fitted on.

The old regression check could not catch it, because it drove the pass with
`yaw: 0.08·sin(phase)` against `translateX: 0.022·cos(0.9·phase)` — sine against
cosine at different frequencies, i.e. deliberately decorrelated. A head that
rotates and translates independently. No neck does that.

Now the fit measures the correlation first and declines to split what moved
together, fitting the rotation term alone and leaving translation nominal. That
is a worse model of a pure sideways slide than a good split would be, and a far
better one than a split invented from collinear data. Measured on the movement
that fills the ring:

| movement | rotation | translation |
|---|---|---|
| turn and nod only | 1.42 (the combined truth) | 1.00 — declined |
| turn and nod, plus a square-on slide | 1.32 | 1.32 (truth 1.30 / 1.30) |

The second row is the argument for asking the client for two movements rather
than one, and is why the ring will grow a second phase.

### How much movement, and how the client knows

The pass used to run for a fixed six seconds against the instruction "slowly
turn your head side to side, then nod". That instruction is clear about *what*
and silent about *how much*, and testers who followed it faithfully still moved
too little — while the step reported success anyway, because a fit that cannot
trust its own estimate falls back to the nominal constants rather than failing
loudly. The visible result was a completed step and a head gain of exactly
1.0 on both axes, which is the fallback wearing the same clothes as a
measurement.

Both halves of that are fixed. The amount is now shown as a ring of four arcs
around the target, in the manner of Face ID's set-up: each arc fills as the head
reaches far enough in that direction, a marker inside the ring shows where the
head currently is, and the pass ends when the ring is full rather than when a
clock runs out. A client can see how far is far enough, and can see that they
are finished.

The targets are 0.16 rad (about 9°) of yaw and 0.10 rad (about 6°) of pitch,
asymmetric because turning is comfortable over a wider range than nodding. A
sweep to those peaks and back has a standard deviation near 0.11 rad, against
the 0.02 rad the fit needs before it will trust an axis — so a client who
manages half of what the ring asks for still clears the bar. That relationship
is a regression check rather than a hope: `scripts/calibrationCheck.ts` plays
back exactly the movement that fills the ring and requires a real gain to come
back, so shrinking the ring's targets to make the step feel easier will fail the
check rather than silently stop measuring anything.

And a gain of exactly 1.0 on both axes is now reported as *not measured*, with
the ring's final coverage distinguishing the two reasons: the client did not
move far enough, or they did and the measurement still failed (usually the eyes
left the dot while the head moved).

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

## Showing someone where to sit

The head-position picture scales with distance: the outline grows as you come
closer and shrinks as you lean back, sitting exactly on the dashed target when
you are where you should be.

That sounds cosmetic and is not. Depth is the drift people are least able to
feel and, per the section above, one of the more expensive. An outline that only
slides around conveys nothing about it, so a client could be 10 cm out of
position, be told they were "drifting", and have no way to work out what to
change. Being told there is a problem without being shown which way to move is
not feedback.

For the same reason the in-session guide's label is an instruction — "Move back
a little", "Shift a little to your left" — rather than a status. One correction
at a time, depth first, because a list of three simultaneous adjustments is not
something anyone can act on.

## The working area

For someone who cannot sit further back — or a client whose eyes genuinely
cannot make large excursions, which is common in exactly the populations this
tool is built for — the working area setting confines calibration and every
activity to a centred fraction of the window.

This is a better trade than it first appears. Accuracy is much better near the
centre than at the edges, so shrinking the area does not merely make targets
smaller: it moves all of them into the part of the range the tracker handles
well. A 70% working area takes a 32 degree half-angle down to 24.

## Blinks, again: the tool was still announcing them

The visual side of this was fixed a while ago and the reasoning below still
stands. A tester reported months later that it *still* felt like the tracker lost
everything on a blink — and it did, in the two places nobody had looked.

**A sound played on every blink.** A 600 Hz tone dropping to 180 Hz, on every
closure. At fifteen blinks a minute that is an alarm going off every four
seconds, telling the client that an involuntary reflex is a problem. Nothing
consumed the event; the callback existed only to make the noise. The blink count
is kept, because blink rate is a real clinical measure, but counting is not
announcing.

**The status readout flipped to "Blink".** The estimate is *held* through a
blink rather than lost, so the honest label during one is the label it already
had. An interruption long enough to be something other than a blink still reads
as "Holding".

The lesson worth keeping: the code had the right intent written into its own
comments, and two channels the comments did not mention went on contradicting
it. A claim that blinks are handled silently is only as good as an audit of
every channel that can speak.

## Blinks

People blink about fifteen times a minute and cannot help it. Everything about
how the app handles that follows from one observation from a real session: when
the display reacted to every blink, the client stopped blinking, and within a
minute had dry eyes and was tracking worse. The interface was creating the
instability it was reporting.

So a blink is ridden out in silence. Concretely:

- The pointer, the trail and the drawing stroke do not change for an
  interruption shorter than 450 ms. `isVisiblyInterrupted` exists for anything
  shown to the user; `isHeld` is for anything that needs to know the estimate is
  not currently measured. Nothing user-facing should key off `isHeld`.
- The estimate is held from the *first* sign of the lids closing, at an openness
  well above the threshold that counts a blink. A lid on its way down covers the
  top of the iris before the eye reads as closed, dragging the iris centre with
  it, so waiting for a declared blink meant the pointer had already lurched.
- The smoothing filter keeps running during a hold, fed the held position.
  Bypassing it left its notion of time stale, so the first real sample after a
  blink arrived with a large gap, took a near-unity weight, and snapped.
- A dwell in progress survives a blink rather than resetting.

Blinks also corrupted two measurements until this was noticed:

- **Steadiness.** Precision is the scatter between consecutive samples, and a
  pair straddling a blink measures the eye's real travel across the gap rather
  than any wobble. One blink during a check could turn a genuine 0.1 degrees
  into several. Pairs more than one frame interval apart are now skipped.
- **Fixation counts.** The reading analysis merged fixations across gaps shorter
  than 75 ms, which is shorter than a blink, so every blink split one fixation
  into two and inflated fixations per hundred words — pushing every grade
  equivalent the wrong way. The threshold is now 250 ms, sized for a blink; the
  distance test still prevents merging across a genuine saccade.

"Eyes found" excludes blink frames from its denominator. It is meant to say how
reliably the tracker held on to open eyes, and counting a reflex against that
both misdescribes the measurement and, shown to a client, discourages blinking.

## Confirming each point, instead of inferring it

Capture used to advance on its own once the eye held still. The reasoning was
sound as far as it went: before calibration there is no mapping, so there is no
way to know *where* someone is looking — but fixation is measurable without any
mapping, and a settled eye during a target's presentation is probably settled on
that target.

"Probably" is the problem. A client holding a steady gaze on the therapist, on
their own reflection in the screen, or on the dot they have already finished
with is perfectly settled, and the dot fills from samples that describe
somewhere else entirely. Least squares then spreads that point's error across
the whole surface. Testers reported it in exactly those terms: *the targets
filled on their own regardless of where I was looking.*

The proxy is now optional, and off by default. The client presses the space bar
when they are on the dot, because only the person looking knows that. Three
details make it work rather than merely exist:

- **The samples come from before the press.** Deciding to press and pressing
  both take time in which the eye can start to leave, and the tail of the window
  is where anticipation of the next dot shows up. The window closes 130 ms
  before the key goes down and reaches back 900 ms from there.
- **Nothing is banked until the eye has arrived.** When a new dot appears the
  eye is still on the old one and still settled, so without this a dot is ready
  to confirm the instant it appears, from samples describing the previous
  target — worse than any noise the mode was built to remove. A saccade has to
  be seen first; a two-second grace period covers a gaze that never crosses the
  threshold.
- **A press with too little behind it is refused, visibly.** Recording it anyway
  would put back the unverified point this exists to prevent, and refusing it
  silently would leave the client pressing a key that does nothing.

Hands-free capture remains one checkbox away, on the briefing card as well as in
settings, because a fair share of the people this is built for cannot press a
key at a chosen moment. It is the same flow with the eye's own stillness
standing in for the press.

## Leave-one-out error is pessimistic, and was being quoted as if it were not

The calibration result used to show two numbers: accuracy measured at five held-
out points, and the mean leave-one-out error over the calibration grid. The
second was always much larger, and it was being read — including by me — as
evidence that the grid points disagreed with each other.

Measured against synthetic data whose true error is known
(`scripts/calibrationCheck.ts`), on a nine-point grid:

| landmark noise | true error at held-out points | leave-one-out says |
|---|---|---|
| 0.001 | 32 px | 115 px |
| 0.004 | 34 px | 115 px |
| 0.008 | 39 px | 121 px |

It overstates by about 3.4×, and — the giveaway — barely responds to noise at
all across an eightfold range. The cause is structural, not statistical: the
model carries a local correction term indexed at each anchor, so removing an
anchor does not just remove one observation, it removes the correction that
would have been there in use, leaving a hole no real prediction ever sits in.

So the figure has been withdrawn from the client-facing result. It is still the
right tool for comparing two models fitted on the same points, where the bias
cancels, and it still drives outlier pruning and model selection. It is still
reported in diagnostics, labelled for what it is. It is not an accuracy figure,
and a report showing 212 px there next to 105 px of measured accuracy is not
describing a problem.

## Choosing how much model to fit

The feature set used to be chosen by anchor count: nine or more points bought
the six-parameter surface, four bought four, fewer bought three. Count says what
can be fitted; it does not say what is worth fitting. If a person's eyes really
do move linearly with the target, the extra parameters spend themselves on
measurement noise — the fit through the calibration points improves while
predictions between them get worse, which is invisible in a check that lands on
the same points that were fitted.

Selection is now by cross-validation: each affordable feature set is scored by
leave-one-out, and the simplest one wins unless a richer one beats it by 5%.
Affordability is judged against the held-out fit rather than the full one, so
every candidate is still overdetermined with one anchor removed and the number
being compared is real.

The measured result was not what was expected: **the degree barely matters.**
Forced to each candidate in turn and measured on held-out points, a nine-point
grid gives 0.65° at every degree, and a thirteen-point grid 0.33° at every
degree. The local correction term is doing the work the polynomial was assumed
to be doing. Selection is kept because it stops an unjustified six-parameter fit
being made on no evidence, and because the per-degree scores are worth having in
diagnostics — but it is not where the remaining error is, and the hypothesis
that degree-3 overfitting explained a large leave-one-out figure was wrong.

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

## What a number is good for

A single verdict — "good", "needs another go" — answers a question nobody asked.
What a clinician needs to know is whether *this* session supports *this* task,
and the tasks differ enormously in what they forgive. Taken from the activities
themselves rather than invented, the reach of each target (its radius plus the
assist margin the activity already allows):

| | reach | at 43 cm on a 14" screen |
|---|---|---|
| games, large setting | 117 px | 3.1° |
| games, medium setting | 79 px | 2.1° |
| spelling by gaze | 60 px | 1.6° |
| games, small setting | 48 px | 1.3° |
| reading assessment | 35 px | 0.9° |

Landing exactly on a target's reach means missing about half the time, so
"comfortable" is set at 60% of it and "workable" at the boundary.

That reframes the grade usefully. A tester at 3.77° was being told his set-up
had failed and shown a list of physical causes; what he actually needed to know
is that he is 0.7° away from the large game targets becoming usable, and a
long way from reading assessment. The result screen now says both, and names the
accuracy that would bring the next task into range.

It also sets the honest expectation for this whole class of tracker. Reading
assessment wants under a degree, which is around the best a webcam ever
manages — that is a hard target, and pretending otherwise in the interface would
be a disservice to the clinician relying on it.

## The vertical channel was half blind, and the report could not see it

A tester finished a session at 3.0°, said it was the most accurate yet, and sent
two screenshots. In one he was looking at the navigation bar across the top of
the window; the cursor sat near the middle of the screen. In the other he was
looking at the stats row along the bottom; the cursor sat near the middle again.
Both figures on the result screen — 3.0° accuracy, 0.12° steadiness, 100% of
frames tracked — said the set-up was fine.

The session recording settled it in one table. Averaging the accepted samples at
each of the nine calibration points:

| | signal moves | per unit of screen |
|---|---|---|
| horizontal, full width | 0.157 | **0.206** |
| vertical, full height | 0.025 | **0.041** |

The vertical channel carried a fifth of the horizontal channel's range. Split in
half it was worse: across the bottom half of the screen `gy` moved 0.064 per unit,
across the top half **0.017**, against a per-point sample noise of 0.001 to 0.006.
Over the entire upper half of the screen the vertical signal was barely above its
own noise.

That is the eyelid. `gy` is the iris centre's offset from the eye corners, and
when the eye rolls up the upper lid rises with it and covers the top of the iris.
MediaPipe fits the iris landmarks to whatever arc is still visible, so the centre
it reports is dragged back down, cancelling most of the movement. Looking down
the lid follows too, but the iris still clears it — which is exactly why the
bottom half of the screen survived and the top half did not.

Running his fitted model forward reproduced both screenshots. Looking at the
navigation bar at 3% of screen height, it predicted 39%. Looking at the stats row
at 93%, it predicted 76% — the observed dot was at 77%.

### Why 3.0° did not notice

Two reasons, and both were fixable.

The check points sat at 28% and 72% of the height, covering the middle 44% of the
screen. Inside a band that narrow, a mapping that only reaches half as far as it
should is still nearly right. They now sit at 20% and 80%, and the calibration
grid — which had been pulled in to 20/80 to keep the top row clear of the
instruction text — went out to 10/90, since the text had already been moved to
whichever end of the screen the target is not at.

The bigger reason is that one mean over two axes cannot report an axis that has
stopped working. Measured separately, that session reaches **90% side to side and
50% up and down**. The result screen now shows both, as reach rather than error:
error shrinks when the points being tested are near the centre, and reach does
not. Reach is also what makes the failure legible to a person — *when you looked
right to the edge, did the estimate follow* is the question the screenshots were
asking.

### A second opinion on the vertical axis

The landmarker also emits `eyeLookUp` and `eyeLookDown` blendshapes, predicted
from the whole eye region rather than from a circle fitted to the visible iris.
They are coarser than the geometric feature. The useful property is not that they
are better — it is that they are wrong about different things, and in particular
they do not go blind when the lid covers the iris.

`lidGy = eyeLookDown - eyeLookUp` now goes to the regression as its own column
rather than being blended in with a weight chosen here. A fixed blend would be a
guess applied to every face; a column is a question asked of each person's own
calibration. If the cue tells us nothing, ridge shrinks it to nothing and the
mapping is no worse than before.

### The tests could not have caught this

The synthetic eye in `scripts/calibrationCheck.ts` was isotropic — a degree of
upward gaze moved `gy` exactly as far as a degree of sideways gaze moved `gx` —
so every scenario passed while the real vertical channel was five times weaker.
It now has a lid: a visibility term that falls off as the eye rolls up, with its
three constants fitted by grid search so the synthetic eye reproduces both ratios
measured on the real session (5.03x horizontal-to-vertical against a measured
5.04x, and 3.72x bottom-half-to-top-half against a measured 3.72x).

Against that eye the check now asserts four things, and the numbers are worth
recording because they are the closest thing to a prediction of what the cue will
do on a real face:

| | vertical reach | mean error |
|---|---|---|
| healthy eye | 90% | 0.60° |
| lidded eye, no cue | **30%** | 2.66° |
| lidded eye, with the cue | **85%** | 0.83° |
| healthy eye, with the cue | — | 0.60° |

The 30% is independent corroboration rather than a coincidence: it was produced
by an eye tuned only to the two sensitivity ratios, and it lands close to the 50%
measured on the session itself. The last row matters as much as the others — the
cue must not be a tax on someone whose vertical channel was never in trouble.

What none of this proves is how good MediaPipe's `eyeLook` outputs actually are
on a real face. The mechanism is now tested; the magnitude is not, and only a
recorded session can settle it. `bun run replay <file>` scores every session with
the cue and without it, so the next recording answers the question directly
instead of by screenshot.

## The cue worked, and made accuracy worse

Two runs the day after shipping the eyelid cue, one with the laptop raised to
eye level and one flat on the desk:

| | before the cue | eye level | on the desk |
|---|---|---|---|
| accuracy | 3.0° | 5.2° | 4.8° |
| side to side | 90% · — | 89% · 1.5° | 92% · 2.0° |
| up and down | **50%** · — | **120%** · 4.9° | **100%** · 4.2° |
| steadiness | 0.12° | 0.25° | 0.23° |

The cue did the thing it was added to do — the vertical range came back, from
half the screen to all of it and past it — and the tracker got worse anyway.
Vertical error more than doubled and the frame-to-frame wobble doubled with it.

Steadiness doubling is the tell. The gaze signal did not get noisier between
those sessions; the only thing that changed is what the mapping was doing with
it. Output wobble scales with the size of the fitted weights, so weights that
had roughly doubled is the plain reading — and two near-collinear columns are
exactly how a fit ends up with large weights. Both `gy` and `lidGy` measure
vertical gaze, so the regression can satisfy every anchor with a large positive
weight on one and a large negative weight on the other. The anchors are hit, the
range is restored, and every bit of noise in either signal is multiplied.

### The obvious repair was wrong

The textbook answer is to hand the regression only the part of the cue the iris
feature cannot already predict — fit `lidGy ~ 1 + gx + gy` and use the residual.
Collinearity gone, and the polynomial's own coefficients come out as they would
have without the cue.

Measured on the lidded synthetic eye:

| column | cross-validated error | vertical reach |
|---|---|---|
| none | 260 px | 30% |
| orthogonalised residual | 257 px | 30% |
| raw | **100 px** | **85%** |

Orthogonalising recovered nothing, because what the cue is *for* is that its
vertical range does not collapse — and projecting out everything the iris
already explains removes precisely that, leaving only curvature. The reasoning
was sound and the measurement disagreed, so the raw column stayed.

### What actually makes it safe

Two things, neither of them a weakening of the column.

**Decline it rather than dilute it.** The model is now fitted both with the cue
and without, and the cue is kept only when holding an anchor out says it earns
its place, by the same 5% margin used for choosing polynomial degree. "Ridge
will shrink it to nothing if it says nothing" was the intention in the first
version and simply was not true — ridge shrinks *toward* zero, which is not the
same as declining a column that is hurting. The check now sweeps a cue from
clean to pure noise and asserts a crossover exists: taken up to a noise sigma of
0.1, refused at 0.2.

An earlier version of that check also asserted a sign-flipped cue would be
refused. That was wrong — a linear fit simply gives it a negative coefficient,
so inverting a cue proves nothing about the guard. What matters is
signal-to-noise, which is what the sweep tests.

**Withdraw it while a lid is moving.** This is very likely the root cause of the
regression, and it is the same fault the user had been reporting for weeks as
losing the target on every blink. The cue is read from the eye region, and a
descending lid looks a great deal like an eye rolling downward, so `eyeLookDown`
climbs at the *start* of a blink — long before the lid is closed enough for the
blink gate at half-open to engage. In that window the cue has spiked, nothing
has stopped it being mapped, and the estimate lurches toward the bottom of the
screen. During calibration the same window puts contaminated samples into the
anchors, which is a noisy cue by construction.

`lidGy` is now withdrawn entirely below 0.65 openness — above the blink
threshold (0.35) and above the gaze-trust threshold (0.5), because this signal
starts lying earliest. Null rather than held, so the model stands the term at
its own fitted mean and the vertical estimate falls back on the iris: degraded,
rather than actively misled.

### And the blink stopped being an event

Separately, the fixation classifier was resetting its clock on every blink, so a
perfectly steady gaze was reclassified as a saccade for a moment each time the
client blinked — fifteen times a minute, on a held estimate that had not moved.
Everything keyed off fixation flinched with it: the pointer shrank, the fixation
centre was discarded, and a dwell in progress read as momentarily lost. The eyes
were never lost. Only the label was, and the label was driving the display.

## The cue was wrong, and the guard that was meant to catch it chose it

Two more sessions a few minutes apart, one with the laptop flat on the desk and
one raised to eye level, replayed with the cue and without:

| | held-out check points | | leave-one-out on the anchors | |
|---|---|---|---|---|
| | with cue | without | with cue | without |
| camera on the desk | 8.56° | **4.22°** | **162 px** | 275 px |
| camera at eye level | 3.41° | **2.86°** | **143 px** | 264 px |

The check points say the cue costs 4.34° and 0.55°. Leave-one-out says it saves
113 px and 121 px. It is not that cross-validation was insensitive to this
failure — it is confidently, consistently **anti-correlated** with it.

The reason is that the nine anchors are not nine independent observations. They
come from one continuous minute, sharing a posture, a lighting condition and the
same lid contamination. Holding one out and predicting it from its eight
neighbours rewards exactly the extra flexibility that does not survive to a check
taken a minute later. The validation points are the only genuinely held-out data
in the session, and they were saying the opposite.

So the eyelid cue is off. Not gated, not weighted down — off, as a constant
rather than a setting, because there is no in-app evidence that could justify
switching it on: the only selector available prefers it precisely when it is
worst. The feature extraction, the recording and the replay variant all stay,
since that is what would produce such evidence. `bun run replay <file>` scores
every session both ways.

It is worth being clear about how this got shipped. The cue was validated on a
synthetic eye whose lid model was fitted to two real sensitivity ratios, and it
looked convincing — vertical reach 30% to 85%, cross-validated error 260 px to
100 px. What that eye did not have was a *realistically bad cue*: the synthetic
`eyeLookUp`/`eyeLookDown` signal was clean, and MediaPipe's is not. A synthetic
test can only ever be as honest as its worst-modelled component, and the
component that mattered was the one invented rather than measured.

The camera height result is a consequence rather than a separate finding: a
camera below eye level sees more eyelid, and this cue is read from the eye
region. That is why the desk run was the catastrophic one, and why camera height
mattered far more after the cue shipped than before it. Without the cue the gap
is 4.22° against 2.86° — real, worth sitting up for, and not the six degrees it
had become.

## Capture order and screen row were the same variable

In every recorded session, the correlation between the order the dots were
captured in and their vertical position on screen is **+0.95**. The grid was
listed left to right, top to bottom, and captured that way.

That makes anything that drifts over the minute of set-up indistinguishable from
a genuine effect of looking up or down. Head pitch is exactly such a thing:

| session | corr(capture order, pitch) | corr(row, pitch) | drift across the grid |
|---|---|---|---|
| camera on the desk | −0.82 | −0.91 | −0.8° |
| camera at eye level | +0.47 | +0.23 | +0.9° |
| earlier session | +0.87 | +0.71 | +1.5° |

The sign flips between sessions. That is the whole argument: if this were a real
property of looking up versus down it would point the same way every time.
Instead, whatever the client's neck happened to do during that particular minute
was being fitted into the vertical mapping as though it were gaze — which is the
same aliasing problem already documented for the head-movement pass, arriving
through a different door.

The fix costs nothing. Each row is now captured early, in the middle, and late:
in the nine-point grid the middle row takes positions 0, 4 and 8, the top row
1, 5 and 6, and the bottom row 2, 3 and 7, so every row averages position 4 and
the columns balance the same way. Order-versus-row correlation drops from +0.95
to 0.00 on all three grids, asserted as a property in the check rather than
eyeballed, since one transposed pair would restore the confound silently.

The centre goes first, which was the user's own suggestion and is right for a
second reason: it is the one target that asks for no eccentric gaze at all, so
it is captured while the client is still square on, and it is the anchor the
whole mapping pivots around. Consecutive points also end up far apart, which
makes each move a real saccade rather than a drift along a row.

## Nothing was ever standardised

The vertical channel has under-reached in every recorded session — 50%, 55%,
63%, 66% — while the horizontal channel sat between 86% and 103%. Three separate
explanations were offered for that over several days: the eyelid hiding the iris,
the check grid being too narrow, the capture order aliasing posture with row. The
first two were wrong and the third was real but minor.

The actual cause was five lines in `standardiseColumns`:

```js
const std = new Array(k).fill(1);   // fallback for a column with no spread
...
std[i] += d * d;                    // ...and then used as the accumulator
```

The variance accumulator was initialised to 1 and then had squared deviations
summed on top of it, so every column came back as `sqrt((1 + spread) / n)`
instead of `sqrt(spread / n)`. With nine anchors that is 0.3333 for a constant
column and 0.3336 for the vertical gaze column, whose real spread is 0.011.
Nothing was standardised. Every column was divided by roughly a third.

Ridge regression is scale-sensitive — that is the entire reason to standardise
before it — so the penalty fell on the columns wildly unevenly:

| column | real spread | shrinkage under λ = 0.022 |
|---|---|---|
| horizontal gaze | 0.086 | **4%** |
| vertical gaze | 0.011 | **70%** |

Measured on a real session, the fitted vertical slope was 9.0 screen-fractions
per feature unit where a plain least-squares line through the same anchors gives
29.9. The mapping was being told, by the regulariser, not to believe the vertical
axis.

### What that means for everything above

The eyelid cue "worked" on the synthetic eye because it supplied a *second*
vertical column with enough spread to survive a penalty the first one was being
crushed by. It was compensating for this bug, not for the eyelid. With the
scaling fixed, the check scenario that showed vertical reach collapsing from 90%
to 30% now shows 101% to 107% — a compressed but monotonic signal is perfectly
recoverable by a larger coefficient, once the penalty stops forbidding one. What
the lid actually costs is signal-to-noise (0.17° to 0.50° on the synthetic eye),
not range.

The "upper half of the screen is nearly blind" measurement was also mostly
wrong, and for the separate reason above: with raster capture, the top row was
taken first and the bottom last, so posture drift was aliased with row. Balanced
capture put the vertical response at 0.036 per unit over the top half against
0.031 over the bottom — symmetric, where the confounded measurement had said
0.017 against 0.064.

### Effect on real recordings

Every session replayed under the fix, scored on its own check points, in pixels
(distance-independent, since the distance estimate is itself unstable):

| session | before | after |
|---|---|---|
| earlier session | 119 px | **73 px** |
| camera on desk | 202 px | 190 px |
| camera at eye level | 125 px | 146 px |
| latest, run 1 | 143 px | **79 px** |
| latest, run 2 | 163 px | 214 px |

The mean improves modestly, and two sessions get worse. That is not a
contradiction: the broken shrinkage was pulling every estimate toward the centre
of the screen, which incidentally damped the error from anything that shifted
between calibration and check. Removing it makes the mapping faithful to what it
was taught, including any head drift. Run 2 has 3.4° of pitch drift between the
grid and the check, and now pays for it in full.

Synthetically, where there is no drift to be faithful to, everything improved by
two to three times at once: the nine-point grid under realistic noise went from
0.60° to 0.17°, outlier recovery from 2.04°→0.92° to 1.80°→0.18°, and the
lean-in distance case from 0.49° to 0.21°.

So the next thing to attack is head pitch drift between the grid and the check,
which was previously hidden underneath a regulariser that was quietly discarding
the vertical axis.

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
