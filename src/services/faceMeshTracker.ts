import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { GazeState, HeadPose, Point2D, TrackingSettings } from '../types';
import { calibrationEngine } from './calibration';
import { soundEngine } from './audio';
import { OneEuroFilter2D } from './oneEuroFilter';

export type TrackerStatus = 'uninitialized' | 'loading_model' | 'requesting_camera' | 'running' | 'error';

export interface TrackerCallbacks {
  onStatusChange?: (status: TrackerStatus, errorMsg?: string) => void;
  onGazeUpdate?: (gaze: GazeState) => void;
  onVideoFrame?: (video: HTMLVideoElement, landmarks?: any) => void;
  onBlink?: (eye: 'left' | 'right' | 'both') => void;
}

export class FaceMeshTracker {
  private faceLandmarker: FaceLandmarker | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private status: TrackerStatus = 'uninitialized';
  private callbacks: TrackerCallbacks = {};
  private lastVideoTime = -1;

  // 1€ (One-Euro) Adaptive Filters for zero-lag saccades + tremor-free fixations
  private screenOneEuroFilter = new OneEuroFilter2D(0.8, 0.04);
  private rawOneEuroFilter = new OneEuroFilter2D(0.8, 0.04);

  private filteredScreenX = window.innerWidth / 2;
  private filteredScreenY = window.innerHeight / 2;
  private filteredRawX = 0;
  private filteredRawY = 0;
  private lastBlinkLeft = false;
  private lastBlinkRight = false;
  private blinkCount = 0;
  private lastBlinkTime = 0;

  // Fixation stability tracking
  private fixationBuffer: Point2D[] = [];
  private isFixating = false;
  private lastSnappedTarget: { x: number; y: number } | null = null;

  private settings: TrackingSettings = {
    smoothingFactor: 0.18,
    oneEuroMinCutoff: 0.8,
    oneEuroBeta: 0.04,
    saccadeThreshold: 45,
    sensitivityX: 1.3,
    sensitivityY: 1.3,
    deadzone: 5,
    snapToGrid: false,
    gridSnapSize: 40,
    dwellDurationMs: 800,
    invertX: false,
    invertY: false,
    useHeadCompensation: true,
    useQuadraticMapping: true,
    penMode: 'auto_stream',
    audioEnabled: true,
    showWebcamPiP: true,
    showLandmarkMesh: true,
    showGazeTrail: true,
    showGazeReticle: true,
    strokeColor: '#10b981',
    strokeGlowColor: '#059669',
    strokeWidth: 5,
  };

  constructor(callbacks: TrackerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: TrackerCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public updateSettings(newSettings: Partial<TrackingSettings>) {
    this.settings = { ...this.settings, ...newSettings };
    if (newSettings.oneEuroMinCutoff !== undefined || newSettings.oneEuroBeta !== undefined) {
      this.screenOneEuroFilter.setParameters(
        this.settings.oneEuroMinCutoff || 0.8,
        this.settings.oneEuroBeta || 0.04
      );
      this.rawOneEuroFilter.setParameters(
        this.settings.oneEuroMinCutoff || 0.8,
        this.settings.oneEuroBeta || 0.04
      );
    }
  }

  public getSettings(): TrackingSettings {
    return this.settings;
  }

  public getStatus(): TrackerStatus {
    return this.status;
  }

  public async initialize(): Promise<void> {
    try {
      this.setStatus('loading_model');

      const filesetResolver = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );

      this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });

      this.setStatus('requesting_camera');
      await this.startCamera();
      this.setStatus('running');
      this.startTrackingLoop();
    } catch (err: any) {
      console.error('Tracker initialization failed:', err);
      this.setStatus('error', err?.message || 'Failed to initialize camera or vision model');
    }
  }

  private setStatus(status: TrackerStatus, errorMsg?: string) {
    this.status = status;
    this.callbacks.onStatusChange?.(status, errorMsg);
  }

  private async startCamera(): Promise<void> {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }

    const video = document.createElement('video');
    video.playsInline = true;
    video.autoplay = true;
    video.muted = true;
    video.setAttribute('style', 'position: fixed; top: -9999px; left: -9999px; opacity: 0; pointer-events: none;');
    document.body.appendChild(video);
    this.videoElement = video;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
        frameRate: { ideal: 60, max: 60 },
      },
      audio: false,
    });

    this.stream = stream;
    this.videoElement.srcObject = stream;

    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => {
        video.play().then(() => resolve());
      };
    });
  }

  public getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  private startTrackingLoop() {
    const processFrame = () => {
      if (this.status !== 'running' || !this.faceLandmarker || !this.videoElement) {
        this.animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const video = this.videoElement;
      if (video.readyState >= 2 && video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = video.currentTime;
        const startTimeMs = performance.now();

        try {
          const results = this.faceLandmarker.detectForVideo(video, startTimeMs);
          if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
            const landmarks = results.faceLandmarks[0];
            const blendshapes = results.faceBlendshapes?.[0]?.categories || [];

            this.processLandmarks(landmarks, blendshapes);
            this.callbacks.onVideoFrame?.(video, landmarks);
          } else {
            this.callbacks.onVideoFrame?.(video, null);
          }
        } catch {
          // Frame skip or minor pipeline hiccup
        }
      }

      this.animationFrameId = requestAnimationFrame(processFrame);
    };

    this.animationFrameId = requestAnimationFrame(processFrame);
  }

  private processLandmarks(landmarks: any[], blendshapes: any[]) {
    // -------------------------------------------------------------
    // 1. Anatomical Iris-to-Canthus Landmark Extraction
    // -------------------------------------------------------------
    // Left eye (viewer's left / user's right side in mirrored feed):
    // Iris center: 468; Outer canthus: 33; Inner canthus: 133; Top: 159; Bottom: 145
    // Right eye (viewer's right / user's left side in mirrored feed):
    // Iris center: 473; Inner canthus: 362; Outer canthus: 263; Top: 386; Bottom: 374
    const irisLeft = landmarks[468] || landmarks[159];
    const irisRight = landmarks[473] || landmarks[386];

    const leftOuter = landmarks[33];
    const leftInner = landmarks[133];
    const rightInner = landmarks[362];
    const rightOuter = landmarks[263];

    const leftTop = landmarks[159];
    const leftBottom = landmarks[145];
    const rightTop = landmarks[386];
    const rightBottom = landmarks[374];

    // Compute head pose based on key facial geometry
    const noseTip = landmarks[1];
    const chin = landmarks[152];
    const forehead = landmarks[10];
    const leftCheek = landmarks[234];
    const rightCheek = landmarks[454];

    let headYaw = 0;
    let headPitch = 0;
    let headRoll = 0;

    if (noseTip && leftCheek && rightCheek && forehead && chin) {
      const faceWidth = Math.abs(rightCheek.x - leftCheek.x) || 1;
      const noseCenterX = (leftCheek.x + rightCheek.x) / 2;
      headYaw = (noseTip.x - noseCenterX) / faceWidth; // Negative = turned left, Positive = turned right

      const faceHeight = Math.abs(chin.y - forehead.y) || 1;
      const noseCenterY = (forehead.y + chin.y) / 2;
      headPitch = (noseTip.y - noseCenterY) / faceHeight; // Up / Down

      const dx = rightCheek.x - leftCheek.x;
      const dy = rightCheek.y - leftCheek.y;
      headRoll = Math.atan2(dy, dx);
    }

    const headPose: HeadPose = { pitch: headPitch, yaw: headYaw, roll: headRoll };

    // Blendshape lookup
    const bsMap: { [key: string]: number } = {};
    for (const cat of blendshapes) {
      bsMap[cat.categoryName] = cat.score;
    }

    const blinkLeftScore = bsMap['eyeBlinkLeft'] || 0;
    const blinkRightScore = bsMap['eyeBlinkRight'] || 0;
    const isBlinkingLeft = blinkLeftScore > 0.45;
    const isBlinkingRight = blinkRightScore > 0.45;
    const isBlinkingBoth = isBlinkingLeft && isBlinkingRight;

    const now = Date.now();
    if (isBlinkingBoth && (!this.lastBlinkLeft || !this.lastBlinkRight)) {
      if (now - this.lastBlinkTime > 300) {
        this.blinkCount++;
        this.lastBlinkTime = now;
        this.callbacks.onBlink?.('both');
        soundEngine.playBlinkClick();
      }
    } else if (isBlinkingLeft && !this.lastBlinkLeft && !isBlinkingBoth) {
      this.callbacks.onBlink?.('left');
    } else if (isBlinkingRight && !this.lastBlinkRight && !isBlinkingBoth) {
      this.callbacks.onBlink?.('right');
    }

    this.lastBlinkLeft = isBlinkingLeft;
    this.lastBlinkRight = isBlinkingRight;

    // -------------------------------------------------------------
    // 2. 3D Spherical Eyeball Gaze Vector Projection
    // -------------------------------------------------------------
    // Inspired by academic pupil tracking (e.g. JEOresearch), we estimate a 3D 
    // spherical eyeball model to compute the true rotational gaze vector.
    let leftGazeYaw = 0;
    let leftGazePitch = 0;
    if (leftOuter && leftInner && leftTop && leftBottom && irisLeft) {
      // Estimate eyeball radius from canthus-to-canthus span
      const eyeWidth = Math.hypot(leftInner.x - leftOuter.x, leftInner.y - leftOuter.y);
      const eyeRadius = eyeWidth / 2.0;

      // Estimate center of eye socket rotation
      const centerX = (leftInner.x + leftOuter.x) / 2.0;
      const centerY = (leftTop.y + leftBottom.y) / 2.0;

      // Calculate 3D spherical rotation angles (arcsin of normalized displacement)
      const dx = (irisLeft.x - centerX) / (eyeRadius || 0.001);
      const dy = (irisLeft.y - centerY) / ((leftBottom.y - leftTop.y) / 2.0 || 0.001); // Eyes are often elliptical in camera view

      leftGazeYaw = Math.asin(Math.max(-1, Math.min(1, dx))) * 1.5;
      leftGazePitch = Math.asin(Math.max(-1, Math.min(1, dy))) * 1.5;
    }

    let rightGazeYaw = 0;
    let rightGazePitch = 0;
    if (rightOuter && rightInner && rightTop && rightBottom && irisRight) {
      const eyeWidth = Math.hypot(rightOuter.x - rightInner.x, rightOuter.y - rightInner.y);
      const eyeRadius = eyeWidth / 2.0;

      const centerX = (rightOuter.x + rightInner.x) / 2.0;
      const centerY = (rightTop.y + rightBottom.y) / 2.0;

      const dx = (irisRight.x - centerX) / (eyeRadius || 0.001);
      const dy = (irisRight.y - centerY) / ((rightBottom.y - rightTop.y) / 2.0 || 0.001);

      rightGazeYaw = Math.asin(Math.max(-1, Math.min(1, dx))) * 1.5;
      rightGazePitch = Math.asin(Math.max(-1, Math.min(1, dy))) * 1.5;
    }

    const anatomicalGazeX = (leftGazeYaw + rightGazeYaw) / 2;
    const anatomicalGazeY = (leftGazePitch + rightGazePitch) / 2;

    // Blendshape gaze fusion
    const lookInL = bsMap['eyeLookInLeft'] || 0;
    const lookOutL = bsMap['eyeLookOutLeft'] || 0;
    const lookInR = bsMap['eyeLookInRight'] || 0;
    const lookOutR = bsMap['eyeLookOutRight'] || 0;
    const lookUpL = bsMap['eyeLookUpLeft'] || 0;
    const lookDownL = bsMap['eyeLookDownLeft'] || 0;
    const lookUpR = bsMap['eyeLookUpRight'] || 0;
    const lookDownR = bsMap['eyeLookDownRight'] || 0;

    const bsGazeX = ((lookOutR + lookInL) - (lookOutL + lookInR)) * 0.75;
    const bsGazeY = (((lookDownL + lookDownR) / 2) - ((lookUpL + lookUpR) / 2)) * 0.85;

    // Multi-Mode Tracking Engine Selection
    const mode = this.settings.trackingEngineMode || 'hybrid_gaze';

    let rawX = 0;
    let rawY = 0;

    if (mode === 'head_laser') {
      // Head-Laser Pointer: uses 3D head yaw/pitch vector for ultra-stable linear drawing
      rawX = headYaw * 1.6;
      rawY = headPitch * 1.8;
    } else if (mode === 'iris_only') {
      // Pure Iris Anatomical Tracking without blendshapes
      rawX = anatomicalGazeX;
      rawY = anatomicalGazeY;
    } else {
      // Hybrid Gaze: 65% anatomical iris-to-canthus ratio + 35% neural blendshape fusion
      rawX = anatomicalGazeX * 0.65 + bsGazeX * 0.35;
      rawY = anatomicalGazeY * 0.65 + bsGazeY * 0.35;
    }

    if (this.settings.invertX) rawX = -rawX;
    if (this.settings.invertY) rawY = -rawY;

    const scrW = window.innerWidth;
    const scrH = window.innerHeight;

    // -------------------------------------------------------------
    // 3. High-Order Quadratic / Polynomial Calibration Mapping
    // -------------------------------------------------------------
    const screenTarget = calibrationEngine.mapRawGazeToScreen(
      rawX,
      rawY,
      headYaw,
      headPitch,
      scrW,
      scrH,
      this.settings.sensitivityX,
      this.settings.sensitivityY,
      mode !== 'iris_only' && this.settings.useHeadCompensation,
      this.settings.useQuadraticMapping !== false
    );

    // Apply Live User Nudge Offsets (if configured)
    const nudgeX = this.settings.nudgeOffsetX || 0;
    const nudgeY = this.settings.nudgeOffsetY || 0;
    screenTarget.x = Math.max(5, Math.min(scrW - 5, screenTarget.x + nudgeX));
    screenTarget.y = Math.max(5, Math.min(scrH - 5, screenTarget.y + nudgeY));

    // -------------------------------------------------------------
    // 4. 1€ (One-Euro) Adaptive Filtering
    // -------------------------------------------------------------
    // Deadzone dampening: suppress sub-pixel involuntary microsaccades
    const distToTarget = Math.hypot(screenTarget.x - this.filteredScreenX, screenTarget.y - this.filteredScreenY);
    let targetToFilterX = screenTarget.x;
    let targetToFilterY = screenTarget.y;

    if (distToTarget < (this.settings.deadzone || 5)) {
      targetToFilterX = this.filteredScreenX;
      targetToFilterY = this.filteredScreenY;
    }

    const filteredScreen = this.screenOneEuroFilter.filter(targetToFilterX, targetToFilterY, now);
    const filteredRaw = this.rawOneEuroFilter.filter(rawX, rawY, now);

    this.filteredScreenX = filteredScreen.x;
    this.filteredScreenY = filteredScreen.y;
    this.filteredRawX = filteredRaw.x;
    this.filteredRawY = filteredRaw.y;

    // Fixation check
    this.fixationBuffer.push({ x: this.filteredScreenX, y: this.filteredScreenY, time: now });
    if (this.fixationBuffer.length > 20) this.fixationBuffer.shift();

    let isFixatingNow = false;
    if (this.fixationBuffer.length >= 10) {
      const recent = this.fixationBuffer.slice(-10);
      const avgX = recent.reduce((sum, p) => sum + p.x, 0) / recent.length;
      const avgY = recent.reduce((sum, p) => sum + p.y, 0) / recent.length;
      const maxDev = Math.max(...recent.map(p => Math.hypot(p.x - avgX, p.y - avgY)));
      isFixatingNow = maxDev < 32;
    }
    this.isFixating = isFixatingNow;

    // Grid snapping logic when focus is maintained
    let finalScreenX = this.filteredScreenX;
    let finalScreenY = this.filteredScreenY;
    let isSnapped = false;

    if (this.settings.snapToGrid && this.isFixating) {
      const gridSize = this.settings.gridSnapSize || 40;
      const snapX = Math.round(this.filteredScreenX / gridSize) * gridSize;
      const snapY = Math.round(this.filteredScreenY / gridSize) * gridSize;

      finalScreenX = snapX;
      finalScreenY = snapY;
      isSnapped = true;

      if (!this.lastSnappedTarget || this.lastSnappedTarget.x !== snapX || this.lastSnappedTarget.y !== snapY) {
        this.lastSnappedTarget = { x: snapX, y: snapY };
        soundEngine.playGridSnapTick();
      }
    } else {
      this.lastSnappedTarget = null;
    }

    const gazeState: GazeState = {
      screenX: finalScreenX,
      screenY: finalScreenY,
      normX: Math.max(0, Math.min(1, finalScreenX / scrW)),
      normY: Math.max(0, Math.min(1, finalScreenY / scrH)),
      rawX: this.filteredRawX,
      rawY: this.filteredRawY,
      snappedX: isSnapped ? finalScreenX : undefined,
      snappedY: isSnapped ? finalScreenY : undefined,
      isSnapped,
      isBlinkingLeft,
      isBlinkingRight,
      isBlinkingBoth,
      blinkCount: this.blinkCount,
      isFixating: this.isFixating,
      confidence: Math.max(0.6, 1 - (blinkLeftScore + blinkRightScore) * 0.4),
      headPose,
      timestamp: now,
    };

    this.callbacks.onGazeUpdate?.(gazeState);
  }

  // Fallback simulator for mouse/touch
  public simulateGazeFromPointer(clientX: number, clientY: number) {
    const scrW = window.innerWidth;
    const scrH = window.innerHeight;
    const normX = clientX / scrW;
    const normY = clientY / scrH;

    this.filteredScreenX = clientX;
    this.filteredScreenY = clientY;

    const gazeState: GazeState = {
      screenX: clientX,
      screenY: clientY,
      normX,
      normY,
      rawX: normX - 0.5,
      rawY: normY - 0.5,
      isBlinkingLeft: false,
      isBlinkingRight: false,
      isBlinkingBoth: false,
      blinkCount: this.blinkCount,
      isFixating: true,
      confidence: 1.0,
      headPose: { pitch: 0, yaw: 0, roll: 0 },
      timestamp: Date.now(),
    };

    this.callbacks.onGazeUpdate?.(gazeState);
  }

  public dispose() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.videoElement && this.videoElement.parentNode) {
      this.videoElement.parentNode.removeChild(this.videoElement);
      this.videoElement = null;
    }
    if (this.faceLandmarker) {
      this.faceLandmarker.close();
      this.faceLandmarker = null;
    }
    this.screenOneEuroFilter.reset();
    this.rawOneEuroFilter.reset();
  }
}
