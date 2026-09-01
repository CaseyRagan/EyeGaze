import React, { useEffect, useRef, useState, useCallback } from 'react';
import { 
  Brush, 
  Check, 
  Circle, 
  Compass, 
  Copy, 
  Crosshair, 
  Download, 
  Eye, 
  Flame, 
  Focus, 
  Grid, 
  Maximize2, 
  Move, 
  Play, 
  RotateCcw, 
  Slash, 
  Sliders, 
  Sparkles, 
  Square, 
  Trash2, 
  Triangle, 
  Zap,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { 
  DrawingStroke, 
  DrawingToolMode, 
  GazeState, 
  Point2D, 
  ShapeKind, 
  TrackingEngineMode, 
  TrackingSettings 
} from '../types';
import { soundEngine } from '../services/audio';
import { HeatmapRenderer, HeatmapHotspot } from '../utils/heatmap';

interface DrawingCanvasProps {
  gaze: GazeState | null;
  settings: TrackingSettings;
  onUpdateSettings: (settings: Partial<TrackingSettings>) => void;
  onOpenCalibration: () => void;
}

const COLOR_PRESETS = [
  { name: 'Aura Emerald', color: '#10b981', glow: '#059669' },
  { name: 'Precision Cyan', color: '#06b6d4', glow: '#0891b2' },
  { name: 'Teal Vector', color: '#2dd4bf', glow: '#0d9488' },
  { name: 'Solar Amber', color: '#f59e0b', glow: '#d97706' },
  { name: 'Hyperion Violet', color: '#a855f7', glow: '#7e22ce' },
  { name: 'Monolith Silver', color: '#f5f5f5', glow: '#737373' },
];

export const DrawingCanvas: React.FC<DrawingCanvasProps> = ({
  gaze,
  settings,
  onUpdateSettings,
  onOpenCalibration,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const heatmapRef = useRef<HeatmapRenderer>(new HeatmapRenderer());

  // Drawing Modes & Tool States
  const [drawingTool, setDrawingTool] = useState<DrawingToolMode>('straight_laser');
  const [selectedShape, setSelectedShape] = useState<ShapeKind>('rectangle');
  const [isDrawing, setIsDrawing] = useState(true);
  const [currentPoints, setCurrentPoints] = useState<Point2D[]>([]);
  const [completedStrokes, setCompletedStrokes] = useState<DrawingStroke[]>([]);
  const [activePreset, setActivePreset] = useState(0);
  const [strokeWidth, setStrokeWidth] = useState(settings.strokeWidth || 5);
  const [copiedNotification, setCopiedNotification] = useState(false);
  const [singleLineMode, setSingleLineMode] = useState(false); // Multi-stroke default for versatile drawing

  // Anchor & Geometric Tools State
  const [startAnchor, setStartAnchor] = useState<Point2D | null>(null);
  const [anchorDwellProgress, setAnchorDwellProgress] = useState(0); // 0 to 1
  const [polylineAnchors, setPolylineAnchors] = useState<Point2D[]>([]);
  const [orthoOrigin, setOrthoOrigin] = useState<Point2D | null>(null);

  // Precision Nudge HUD State
  const [showPrecisionHUD, setShowPrecisionHUD] = useState(false);
  const [nudgeX, setNudgeX] = useState(settings.nudgeOffsetX || 0);
  const [nudgeY, setNudgeY] = useState(settings.nudgeOffsetY || 0);

  // Heatmap Overlay State
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.7);
  const [heatmapRadius, setHeatmapRadius] = useState(45);
  const [hotspotInfo, setHotspotInfo] = useState<HeatmapHotspot | null>(null);
  const [showHeatmapSettings, setShowHeatmapSettings] = useState(false);
  const [heatmapSampleCount, setHeatmapSampleCount] = useState(0);

  // Live stroke statistics
  const [lineLength, setLineLength] = useState(0);
  const [drawSpeed, setDrawSpeed] = useState(0);

  const isDrawingRef = useRef(isDrawing);
  isDrawingRef.current = isDrawing;

  const currentPointsRef = useRef<Point2D[]>([]);
  currentPointsRef.current = currentPoints;

  const gazeRef = useRef<GazeState | null>(gaze);
  gazeRef.current = gaze;

  // Helper to commit a straight line stroke between two points
  const commitStraightLine = useCallback((p1: Point2D, p2: Point2D) => {
    // Generate fine interpolated linear points for glowing shader rendering
    const points: Point2D[] = [];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(8, Math.floor(dist / 4));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push({
        x: p1.x + (p2.x - p1.x) * t,
        y: p1.y + (p2.y - p1.y) * t,
        time: Date.now(),
      });
    }

    const stroke: DrawingStroke = {
      id: `stroke-laser-${Date.now()}`,
      points,
      color: COLOR_PRESETS[activePreset].color,
      glowColor: COLOR_PRESETS[activePreset].glow,
      width: strokeWidth,
      createdAt: Date.now(),
      totalLength: Math.round(dist),
    };

    setCompletedStrokes(prev => [...prev, stroke]);
    setLineLength(l => Math.round(l + dist));
    soundEngine.playStarConnect(Math.min(5, Math.floor(dist / 80)));
  }, [activePreset, strokeWidth]);

  // Helper to commit a geometric shape
  const commitShape = useCallback((p1: Point2D, p2: Point2D, kind: ShapeKind) => {
    const points: Point2D[] = [];
    const left = Math.min(p1.x, p2.x);
    const right = Math.max(p1.x, p2.x);
    const top = Math.min(p1.y, p2.y);
    const bottom = Math.max(p1.y, p2.y);

    if (kind === 'rectangle') {
      const corners = [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
        { x: left, y: top },
      ];
      for (let i = 0; i < corners.length - 1; i++) {
        const a = corners[i];
        const b = corners[i + 1];
        for (let s = 0; s <= 10; s++) {
          const t = s / 10;
          points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
    } else if (kind === 'circle') {
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      const rx = Math.abs(p2.x - p1.x) / 2;
      const ry = Math.abs(p2.y - p1.y) / 2;
      const steps = 40;
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * Math.PI * 2;
        points.push({ x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) });
      }
    } else if (kind === 'triangle') {
      const midX = (p1.x + p2.x) / 2;
      const corners = [
        { x: midX, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
        { x: midX, y: top },
      ];
      for (let i = 0; i < corners.length - 1; i++) {
        const a = corners[i];
        const b = corners[i + 1];
        for (let s = 0; s <= 10; s++) {
          const t = s / 10;
          points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
    }

    const stroke: DrawingStroke = {
      id: `stroke-shape-${Date.now()}`,
      points,
      color: COLOR_PRESETS[activePreset].color,
      glowColor: COLOR_PRESETS[activePreset].glow,
      width: strokeWidth,
      createdAt: Date.now(),
      totalLength: points.length * 5,
    };

    setCompletedStrokes(prev => [...prev, stroke]);
    soundEngine.playLevelComplete();
  }, [activePreset, strokeWidth]);

  // Drop Anchor or Commit Line Trigger (Gaze Dwell or Space/Enter/Click)
  const handleAnchorTrigger = useCallback(() => {
    if (!gazeRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = gazeRef.current.screenX - rect.left;
    const y = gazeRef.current.screenY - rect.top;

    if (drawingTool === 'straight_laser') {
      if (!startAnchor) {
        setStartAnchor({ x, y });
        soundEngine.playChime(640, 0.2);
      } else {
        commitStraightLine(startAnchor, { x, y });
        setStartAnchor(null);
      }
    } else if (drawingTool === 'shapes') {
      if (!startAnchor) {
        setStartAnchor({ x, y });
        soundEngine.playChime(580, 0.2);
      } else {
        commitShape(startAnchor, { x, y }, selectedShape);
        setStartAnchor(null);
      }
    } else if (drawingTool === 'polyline') {
      const newAnchors = [...polylineAnchors, { x, y }];
      setPolylineAnchors(newAnchors);
      soundEngine.playStarConnect(newAnchors.length);

      if (newAnchors.length >= 2) {
        commitStraightLine(newAnchors[newAnchors.length - 2], { x, y });
      }
    }
  }, [drawingTool, startAnchor, selectedShape, polylineAnchors, commitStraightLine, commitShape]);

  const prevBlinkCountRef = useRef(gaze?.blinkCount || 0);

  // Handle Dwell & Blink Lock on Anchor
  useEffect(() => {
    const isAnchorTool = drawingTool === 'straight_laser' || drawingTool === 'shapes' || drawingTool === 'polyline';
    
    // Blink to click!
    if (gaze && isAnchorTool) {
      if (gaze.blinkCount > prevBlinkCountRef.current) {
        handleAnchorTrigger();
        prevBlinkCountRef.current = gaze.blinkCount;
        setAnchorDwellProgress(0); // Reset dwell since we clicked
        return;
      }
      prevBlinkCountRef.current = gaze.blinkCount;
    }

    if (!gaze || !isAnchorTool) {
      setAnchorDwellProgress(0);
      return;
    }

    if (gaze.isFixating) {
      setAnchorDwellProgress(prev => {
        const next = prev + 0.08;
        if (next >= 1.0 && prev < 1.0) {
          handleAnchorTrigger();
          return 0;
        }
        return Math.min(1, next);
      });
    } else if (anchorDwellProgress > 0) {
      setAnchorDwellProgress(prev => Math.max(0, prev - 0.05));
    }
  }, [gaze?.isFixating, gaze?.blinkCount, drawingTool, handleAnchorTrigger]);

  // Render Canvas Loop
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background grid
    const gridSize = settings.snapToGrid ? (settings.gridSnapSize || 40) : 48;
    ctx.strokeStyle = settings.snapToGrid ? 'rgba(16, 185, 129, 0.09)' : 'rgba(255, 255, 255, 0.025)';
    ctx.lineWidth = 1;

    for (let x = 0; x < canvas.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }

    for (let y = 0; y < canvas.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Intersection grid dots if snap to grid is on
    if (settings.snapToGrid) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.3)';
      for (let x = 0; x < canvas.width; x += gridSize) {
        for (let y = 0; y < canvas.height; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Render Heatmap Layer (if enabled)
    if (showHeatmap) {
      heatmapRef.current.setOpacity(heatmapOpacity);
      heatmapRef.current.setRadius(heatmapRadius);
      heatmapRef.current.render(ctx);
    }

    // Helper to draw smooth Catmull-Rom / Bezier stroke
    const drawSmoothPath = (points: Point2D[], color: string, glowColor: string, width: number) => {
      if (points.length < 2) return;

      ctx.save();
      // Outer glow
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
      }
      ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = width * 2.4;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 14;
      ctx.globalAlpha = 0.35;
      ctx.stroke();

      // Middle pass
      ctx.lineWidth = width * 1.3;
      ctx.strokeStyle = color;
      ctx.shadowBlur = 6;
      ctx.globalAlpha = 0.85;
      ctx.stroke();

      // Core highlight
      ctx.lineWidth = Math.max(1.5, width * 0.45);
      ctx.strokeStyle = '#ffffff';
      ctx.shadowBlur = 2;
      ctx.globalAlpha = 0.95;
      ctx.stroke();
      ctx.restore();
    };

    // Render completed strokes
    completedStrokes.forEach(stroke => {
      drawSmoothPath(stroke.points, stroke.color, stroke.glowColor, stroke.width);
    });

    // Render active freehand line
    if (currentPoints.length > 1) {
      const activeColor = COLOR_PRESETS[activePreset].color;
      const activeGlow = COLOR_PRESETS[activePreset].glow;
      drawSmoothPath(currentPoints, activeColor, activeGlow, strokeWidth);
    }

    // Render LIVE Straight Laser Guide Beam & Preview
    if (gaze && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const gx = gaze.screenX - rect.left;
      const gy = gaze.screenY - rect.top;

      if (startAnchor) {
        ctx.save();
        const activeColor = COLOR_PRESETS[activePreset].color;
        const activeGlow = COLOR_PRESETS[activePreset].glow;

        if (drawingTool === 'straight_laser') {
          // Laser beam from Start Anchor to Current Gaze
          ctx.beginPath();
          ctx.moveTo(startAnchor.x, startAnchor.y);
          ctx.lineTo(gx, gy);
          ctx.strokeStyle = activeGlow;
          ctx.lineWidth = strokeWidth * 2;
          ctx.shadowColor = activeGlow;
          ctx.shadowBlur = 16;
          ctx.globalAlpha = 0.4;
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(startAnchor.x, startAnchor.y);
          ctx.lineTo(gx, gy);
          ctx.strokeStyle = activeColor;
          ctx.lineWidth = strokeWidth;
          ctx.globalAlpha = 0.9;
          ctx.stroke();

          // Laser core
          ctx.beginPath();
          ctx.moveTo(startAnchor.x, startAnchor.y);
          ctx.lineTo(gx, gy);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (drawingTool === 'shapes') {
          // Shape preview
          const left = Math.min(startAnchor.x, gx);
          const top = Math.min(startAnchor.y, gy);
          const w = Math.abs(gx - startAnchor.x);
          const h = Math.abs(gy - startAnchor.y);

          ctx.strokeStyle = activeColor;
          ctx.lineWidth = strokeWidth;
          ctx.fillStyle = `${activeColor}15`;
          ctx.shadowColor = activeGlow;
          ctx.shadowBlur = 12;

          if (selectedShape === 'rectangle') {
            ctx.strokeRect(left, top, w, h);
            ctx.fillRect(left, top, w, h);
          } else if (selectedShape === 'circle') {
            ctx.beginPath();
            ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fill();
          } else if (selectedShape === 'triangle') {
            ctx.beginPath();
            ctx.moveTo(left + w / 2, top);
            ctx.lineTo(left + w, top + h);
            ctx.lineTo(left, top + h);
            ctx.closePath();
            ctx.stroke();
            ctx.fill();
          }
        }

        // Draw Start Anchor Beacon
        ctx.beginPath();
        ctx.arc(startAnchor.x, startAnchor.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = activeGlow;
        ctx.shadowBlur = 16;
        ctx.fill();
        ctx.restore();
      }
    }
  }, [completedStrokes, currentPoints, activePreset, strokeWidth, startAnchor, drawingTool, selectedShape, gaze?.screenX, gaze?.screenY, showHeatmap, heatmapOpacity, heatmapRadius, settings.snapToGrid, settings.gridSnapSize]);

  // Window resize handler
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (canvas && canvas.parentElement) {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
        heatmapRef.current.resize(canvas.width, canvas.height);
        renderCanvas();
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderCanvas]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (drawingTool === 'straight_laser' || drawingTool === 'shapes' || drawingTool === 'polyline') {
          handleAnchorTrigger();
        } else {
          setIsDrawing(prev => !prev);
        }
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setShowHeatmap(prev => !prev);
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        onUpdateSettings({ snapToGrid: !settings.snapToGrid });
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setShowPrecisionHUD(prev => !prev);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleNudge(0, -15);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleNudge(0, 15);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleNudge(-15, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNudge(15, 0);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawingTool, handleAnchorTrigger, settings.snapToGrid, onUpdateSettings]);

  // Nudge live calibration offset
  const handleNudge = (dx: number, dy: number) => {
    const newX = nudgeX + dx;
    const newY = nudgeY + dy;
    setNudgeX(newX);
    setNudgeY(newY);
    onUpdateSettings({ nudgeOffsetX: newX, nudgeOffsetY: newY });
    soundEngine.playGridSnapTick();
  };

  const handleResetNudge = () => {
    setNudgeX(0);
    setNudgeY(0);
    onUpdateSettings({ nudgeOffsetX: 0, nudgeOffsetY: 0 });
    soundEngine.playChime(400, 0.2);
  };

  // Main Gaze Feed into Canvas Points
  useEffect(() => {
    if (!gaze) {
      soundEngine.updateGazeHum(0, false);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    let x = gaze.screenX - rect.left;
    let y = gaze.screenY - rect.top;

    if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) return;

    // Accumulate heatmap
    heatmapRef.current.addPoint(x, y, gaze.isFixating);
    setHeatmapSampleCount(heatmapRef.current.getPointCount());

    const hotspot = heatmapRef.current.getPeakHotspot();
    if (hotspot) setHotspotInfo(hotspot);

    // If in Orthogonal Ruler mode: snap continuous freehand points to flat horizontal/vertical/45
    if (drawingTool === 'ortho_ruler') {
      if (!orthoOrigin) {
        setOrthoOrigin({ x, y });
      } else {
        const dx = x - orthoOrigin.x;
        const dy = y - orthoOrigin.y;
        const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);

        if (angle < 22.5 || angle > 157.5) {
          // Perfectly flat horizontal line!
          y = orthoOrigin.y;
        } else if (angle > 67.5 && angle < 112.5) {
          // Perfectly vertical line!
          x = orthoOrigin.x;
        } else {
          // 45 degree diagonal line!
          const dist = (Math.abs(dx) + Math.abs(dy)) / 2;
          x = orthoOrigin.x + Math.sign(dx) * dist;
          y = orthoOrigin.y + Math.sign(dy) * dist;
        }
      }
    } else {
      if (orthoOrigin) setOrthoOrigin(null);
    }

    // If freehand mode is active
    if (drawingTool === 'freehand' || drawingTool === 'ortho_ruler') {
      if (!isDrawingRef.current) {
        soundEngine.updateGazeHum(0, false);
        return;
      }

      const newPoint: Point2D = { x, y, time: Date.now() };

      setCurrentPoints(prev => {
        if (prev.length > 0) {
          const last = prev[prev.length - 1];
          const dist = Math.hypot(x - last.x, y - last.y);
          if (dist < 3) return prev;

          const dt = Math.max(1, (newPoint.time || 0) - (last.time || 0));
          const speed = (dist / dt) * 1000;
          setDrawSpeed(Math.round(speed));
          setLineLength(l => Math.round(l + dist));
          soundEngine.updateGazeHum(Math.min(1, speed / 800), true);
        }

        if (singleLineMode && prev.length > 1200) {
          return [...prev.slice(1), newPoint];
        }
        return [...prev, newPoint];
      });
    }

    renderCanvas();
  }, [gaze, drawingTool, orthoOrigin, singleLineMode, renderCanvas]);

  const clearCanvas = () => {
    setCurrentPoints([]);
    setCompletedStrokes([]);
    setStartAnchor(null);
    setPolylineAnchors([]);
    setLineLength(0);
    setDrawSpeed(0);
    heatmapRef.current.clear();
    setHotspotInfo(null);
    setHeatmapSampleCount(0);
    soundEngine.playChime(320, 0.25, 'triangle');
    renderCanvas();
  };

  const clearHeatmapOnly = () => {
    heatmapRef.current.clear();
    setHotspotInfo(null);
    setHeatmapSampleCount(0);
    soundEngine.playChime(320, 0.2, 'sine');
    renderCanvas();
  };

  const downloadArtwork = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    if (showHeatmap) {
      heatmapRef.current.render(ctx);
    }
    ctx.drawImage(canvas, 0, 0);

    const link = document.createElement('a');
    link.download = `gazeflow-art-${Date.now()}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
    soundEngine.playLevelComplete();
  };

  const copyToClipboard = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const ctx = exportCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        if (showHeatmap) heatmapRef.current.render(ctx);
        ctx.drawImage(canvas, 0, 0);

        exportCanvas.toBlob(async (blob) => {
          if (blob && navigator.clipboard && navigator.clipboard.write) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            setCopiedNotification(true);
            setTimeout(() => setCopiedNotification(false), 2000);
            soundEngine.playChime(660, 0.3);
          }
        });
      }
    } catch {
      // Clipboard fallback
    }
  };

  return (
    <div id="drawing-canvas-view" className="relative w-full h-full flex flex-col overflow-hidden select-none bg-[#050505]">
      {/* Side Technical Data Overlay */}
      <aside className="absolute left-8 top-1/2 -translate-y-1/2 space-y-4 hidden md:block pointer-events-none z-20">
        <div className="space-y-0.5">
          <p className="text-[9px] text-white/20 uppercase tracking-widest font-mono">Vector X</p>
          <p className="text-sm font-mono text-white/80">{gaze ? gaze.screenX.toFixed(1) : '000.0'}</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[9px] text-white/20 uppercase tracking-widest font-mono">Vector Y</p>
          <p className="text-sm font-mono text-white/80">{gaze ? gaze.screenY.toFixed(1) : '000.0'}</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[9px] text-white/20 uppercase tracking-widest font-mono">Stroke Length</p>
          <p className="text-sm font-mono text-emerald-400">{lineLength} px</p>
        </div>

        {/* Nudge Offsets */}
        {(nudgeX !== 0 || nudgeY !== 0) && (
          <div className="space-y-0.5 pt-2 border-t border-white/5">
            <p className="text-[9px] text-cyan-400 uppercase tracking-widest font-mono">Live Nudge</p>
            <p className="text-xs font-mono text-cyan-300">
              X: {nudgeX > 0 ? `+${nudgeX}` : nudgeX}px | Y: {nudgeY > 0 ? `+${nudgeY}` : nudgeY}px
            </p>
          </div>
        )}

        {/* Grid Snapping */}
        <div className="space-y-0.5 pt-2 border-t border-white/5">
          <p className="text-[9px] text-white/20 uppercase tracking-widest font-mono">Grid Lock</p>
          <p className={`text-xs font-mono font-medium ${settings.snapToGrid ? 'text-emerald-400' : 'text-white/30'}`}>
            {settings.snapToGrid ? `SNAP [${settings.gridSnapSize || 40}px]` : 'OFF'}
          </p>
        </div>
      </aside>

      {/* Top Floating Tool Switcher & Controls */}
      <div className="absolute top-4 left-6 right-6 z-20 flex flex-wrap items-center justify-between gap-3 pointer-events-auto">
        {/* Left: Drawing Tool Modes Selector */}
        <div className="flex items-center gap-1 bg-[#0a0a0a]/90 border border-white/10 backdrop-blur-md p-1 rounded-xl shadow-2xl">
          {/* Straight Laser Line (Anchor-to-Anchor) Tool */}
          <button
            id="tool-straight-laser-btn"
            onClick={() => {
              setDrawingTool('straight_laser');
              setStartAnchor(null);
              soundEngine.playChime(600, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              drawingTool === 'straight_laser'
                ? 'bg-emerald-500 text-black shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
            title="Laser Straight Line: Look & Fixate 2 Points to Draw Crisp Straight Lines"
          >
            <Slash className="w-3.5 h-3.5" />
            <span>STRAIGHT LASER</span>
          </button>

          {/* Orthogonal Ruler Assist */}
          <button
            id="tool-ortho-ruler-btn"
            onClick={() => {
              setDrawingTool('ortho_ruler');
              setStartAnchor(null);
              soundEngine.playChime(540, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              drawingTool === 'ortho_ruler'
                ? 'bg-teal-500 text-black shadow-[0_0_12px_rgba(45,212,191,0.3)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
            title="Orthogonal Ruler: Freehand Auto-Locks to Horizontal & Vertical Lines"
          >
            <Compass className="w-3.5 h-3.5" />
            <span>RULER LOCK</span>
          </button>

          {/* Freehand Flow */}
          <button
            id="tool-freehand-btn"
            onClick={() => {
              setDrawingTool('freehand');
              setStartAnchor(null);
              soundEngine.playChime(480, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              drawingTool === 'freehand'
                ? 'bg-cyan-500 text-black shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
            title="Freehand Vector Flow"
          >
            <Brush className="w-3.5 h-3.5" />
            <span>FREEHAND</span>
          </button>

          {/* Geometric Shapes */}
          <button
            id="tool-shapes-btn"
            onClick={() => {
              setDrawingTool('shapes');
              setStartAnchor(null);
              soundEngine.playChime(520, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              drawingTool === 'shapes'
                ? 'bg-purple-500 text-white shadow-[0_0_12px_rgba(168,85,247,0.3)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
            title="Geometric Shape Tool"
          >
            <Square className="w-3.5 h-3.5" />
            <span>SHAPES</span>
          </button>

          {/* Shape Sub-selector if shapes tool active */}
          {drawingTool === 'shapes' && (
            <div className="flex items-center gap-1 pl-1 border-l border-white/10">
              <button
                onClick={() => setSelectedShape('rectangle')}
                className={`p-1 rounded ${selectedShape === 'rectangle' ? 'bg-white/20 text-white' : 'text-white/40'}`}
                title="Rectangle"
              >
                <Square className="w-3 h-3" />
              </button>
              <button
                onClick={() => setSelectedShape('circle')}
                className={`p-1 rounded ${selectedShape === 'circle' ? 'bg-white/20 text-white' : 'text-white/40'}`}
                title="Circle"
              >
                <Circle className="w-3 h-3" />
              </button>
              <button
                onClick={() => setSelectedShape('triangle')}
                className={`p-1 rounded ${selectedShape === 'triangle' ? 'bg-white/20 text-white' : 'text-white/40'}`}
                title="Triangle"
              >
                <Triangle className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Right: Action Buttons & Precision HUD Toggle */}
        <div className="flex items-center gap-1.5 bg-[#0a0a0a]/90 border border-white/10 backdrop-blur-md p-1.5 rounded-xl shadow-2xl">
          {/* Quick Precision Nudge Toggle */}
          <button
            id="toggle-precision-hud-btn"
            onClick={() => setShowPrecisionHUD(!showPrecisionHUD)}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
              showPrecisionHUD
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.2)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
            title="Open Live Precision Tuning & Bias Nudge HUD (Press P)"
          >
            <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
            <span>NUDGE & BIAS</span>
            <kbd className="hidden sm:inline-block px-1 bg-black/30 rounded text-[9px] border border-white/10 text-white/50">P</kbd>
          </button>

          {/* Grid Snap Button */}
          <button
            id="toggle-snap-grid-btn"
            onClick={() => {
              const next = !settings.snapToGrid;
              onUpdateSettings({ snapToGrid: next });
              soundEngine.playChime(next ? 600 : 350, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
              settings.snapToGrid
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'text-white/50 hover:text-white hover:bg-white/5'
            }`}
            title="Snap Gaze to Grid on Focus (Press G)"
          >
            <Grid className={`w-3.5 h-3.5 ${settings.snapToGrid ? 'text-emerald-400' : 'text-white/40'}`} />
            <span>GRID</span>
          </button>

          {/* Heatmap Toggle */}
          <button
            id="toggle-heatmap-btn"
            onClick={() => {
              setShowHeatmap(!showHeatmap);
              soundEngine.playChime(!showHeatmap ? 580 : 400, 0.2);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
              showHeatmap
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'text-white/50 hover:text-white hover:bg-white/5'
            }`}
            title="Toggle Gaze Heatmap Overlay (Press H)"
          >
            <Flame className={`w-3.5 h-3.5 ${showHeatmap ? 'text-amber-400 animate-pulse' : 'text-white/40'}`} />
            <span>HEATMAP</span>
          </button>

          {/* Clear Button */}
          <button
            id="clear-canvas-btn"
            onClick={clearCanvas}
            className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            title="Clear Drawing"
          >
            <Trash2 className="w-4 h-4" />
          </button>

          {/* Copy Canvas */}
          <button
            id="copy-artwork-btn"
            onClick={copyToClipboard}
            className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            title="Copy Image to Clipboard"
          >
            {copiedNotification ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>

          {/* Export PNG */}
          <button
            id="download-artwork-btn"
            onClick={downloadArtwork}
            className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            title="Download PNG Image"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Floating Precision Tuning HUD (Live Nudge & Tracking Engine) */}
      {showPrecisionHUD && (
        <div className="absolute top-18 right-6 z-30 w-80 bg-[#0a0a0a]/95 border border-cyan-500/30 backdrop-blur-xl p-4 rounded-2xl shadow-2xl space-y-4 pointer-events-auto animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span className="text-xs font-mono font-bold tracking-wider text-cyan-400 uppercase flex items-center gap-1.5">
              <Crosshair className="w-4 h-4" />
              Live Bias & Precision HUD
            </span>
            <button
              onClick={() => setShowPrecisionHUD(false)}
              className="text-xs text-white/40 hover:text-white cursor-pointer font-mono"
            >
              ✕
            </button>
          </div>

          {/* 4-Way Directional Nudge Pad */}
          <div className="space-y-1.5 text-center">
            <p className="text-[10px] font-mono text-white/50 uppercase tracking-wider">
              Nudge Gaze Bias (Shift Pixels)
            </p>
            <div className="flex flex-col items-center gap-1 pt-1">
              <button
                onClick={() => handleNudge(0, -15)}
                className="p-2 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-white cursor-pointer"
                title="Nudge Up (15px)"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleNudge(-15, 0)}
                  className="p-2 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-white cursor-pointer"
                  title="Nudge Left (15px)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="w-14 text-center font-mono text-[10px] text-cyan-300">
                  {nudgeX},{nudgeY}
                </div>
                <button
                  onClick={() => handleNudge(15, 0)}
                  className="p-2 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-white cursor-pointer"
                  title="Nudge Right (15px)"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <button
                onClick={() => handleNudge(0, 15)}
                className="p-2 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-white cursor-pointer"
                title="Nudge Down (15px)"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
            {(nudgeX !== 0 || nudgeY !== 0) && (
              <button
                onClick={handleResetNudge}
                className="text-[10px] font-mono text-white/40 hover:text-red-400 pt-1 cursor-pointer"
              >
                Reset Bias Nudge
              </button>
            )}
          </div>

          {/* Tracking Engine Mode Switcher */}
          <div className="space-y-1.5 pt-2 border-t border-white/10">
            <p className="text-[10px] font-mono text-white/50 uppercase tracking-wider">
              Tracking Engine Mode
            </p>
            <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
              <button
                onClick={() => {
                  onUpdateSettings({ trackingEngineMode: 'hybrid_gaze' });
                  soundEngine.playChime(500, 0.15);
                }}
                className={`p-2 rounded-lg border text-center cursor-pointer ${
                  (settings.trackingEngineMode || 'hybrid_gaze') === 'hybrid_gaze'
                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                    : 'bg-white/5 border-white/10 text-white/60 hover:text-white'
                }`}
              >
                <p className="font-bold">Hybrid Eye Gaze</p>
                <p className="text-[9px] text-white/40">Iris + Blendshapes</p>
              </button>

              <button
                onClick={() => {
                  onUpdateSettings({ trackingEngineMode: 'head_laser' });
                  soundEngine.playChime(620, 0.15);
                }}
                className={`p-2 rounded-lg border text-center cursor-pointer ${
                  settings.trackingEngineMode === 'head_laser'
                    ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300'
                    : 'bg-white/5 border-white/10 text-white/60 hover:text-white'
                }`}
              >
                <p className="font-bold">Head-Laser Pointer</p>
                <p className="text-[9px] text-white/40">Ultra-Steady Lines</p>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Interactive Drawing Canvas */}
      <div className="relative flex-1 w-full h-full bg-[#050505] overflow-hidden cursor-crosshair">
        <canvas
          ref={canvasRef}
          onClick={handleAnchorTrigger}
          className="absolute inset-0 w-full h-full block"
        />

        {/* Live Anchor Dwell Indicator */}
        {gaze && (drawingTool === 'straight_laser' || drawingTool === 'shapes') && anchorDwellProgress > 0.05 && (
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20"
            style={{ left: gaze.screenX, top: gaze.screenY }}
          >
            <svg className="w-12 h-12 -rotate-90">
              <circle
                cx={24}
                cy={24}
                r={18}
                stroke="rgba(255,255,255,0.2)"
                strokeWidth={3}
                fill="transparent"
              />
              <circle
                cx={24}
                cy={24}
                r={18}
                stroke="#10b981"
                strokeWidth={3}
                fill="transparent"
                strokeDasharray={2 * Math.PI * 18}
                strokeDashoffset={(1 - anchorDwellProgress) * 2 * Math.PI * 18}
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute top-14 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/80 border border-white/10 px-2 py-0.5 rounded text-[9px] font-mono text-emerald-300">
              {startAnchor ? 'Fixate to Finish' : 'Fixate to Set Start'}
            </div>
          </div>
        )}

        {/* Empty Canvas Guidance Callout */}
        {currentPoints.length === 0 && completedStrokes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none p-6 text-center">
            <div className="max-w-md w-full bg-[#080808]/75 border border-white/10 backdrop-blur-xl rounded-2xl p-8 shadow-2xl space-y-3">
              <span className="inline-block px-3 py-1 bg-emerald-500/10 text-emerald-400 text-[10px] font-bold tracking-widest uppercase rounded-full font-mono">
                Precision Eye & Head Drawing
              </span>
              <h2 className="text-2xl font-light text-white font-serif-chic italic">
                {drawingTool === 'straight_laser' ? 'Straight Laser Line Tool Active' : 'Cast your gaze to draw'}
              </h2>
              <p className="text-xs text-white/50 leading-relaxed font-mono">
                {drawingTool === 'straight_laser'
                  ? 'Look and hold fixation at Point A (Start Anchor), then look at Point B (End Target) to draw razor-sharp straight lines.'
                  : 'Glide your ocular vector across the canvas to form a luminous trajectory.'}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[10px] font-mono text-white/40 bg-white/5 p-2 rounded-xl border border-white/5">
                <span>Spacebar: Drop Anchor / Draw</span>
                <span>•</span>
                <span>Press P: Live Bias Nudge HUD</span>
                <span>•</span>
                <span className="text-emerald-400">Press G: Grid Snap</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Floating Brush & Palette Controls */}
      <div className="absolute bottom-4 left-6 z-20 flex flex-wrap items-center gap-3 pointer-events-auto">
        <div className="flex items-center gap-3 bg-[#0a0a0a]/90 border border-white/10 backdrop-blur-md px-4 py-2 rounded-xl shadow-2xl">
          {/* Color Palettes */}
          <div className="flex items-center gap-2">
            {COLOR_PRESETS.map((preset, index) => (
              <button
                key={preset.name}
                id={`color-preset-${index}`}
                onClick={() => {
                  setActivePreset(index);
                  onUpdateSettings({
                    strokeColor: preset.color,
                    strokeGlowColor: preset.glow,
                  });
                  soundEngine.playChime(440 + index * 40, 0.2);
                }}
                className={`w-5 h-5 rounded-full transition-transform cursor-pointer relative ${
                  activePreset === index
                    ? 'scale-125 ring-2 ring-white shadow-lg'
                    : 'opacity-60 hover:opacity-100 hover:scale-110'
                }`}
                style={{
                  backgroundColor: preset.color,
                  boxShadow: `0 0 8px ${preset.glow}`,
                }}
                title={preset.name}
              />
            ))}
          </div>

          <div className="w-px h-4 bg-white/10" />

          {/* Stroke Width Selector */}
          <div className="flex items-center gap-2 text-xs text-white/70 font-mono">
            <span className="text-white/30 text-[10px] uppercase tracking-wider">Size</span>
            <input
              id="stroke-width-slider"
              type="range"
              min="2"
              max="20"
              value={strokeWidth}
              onChange={(e) => {
                const w = parseInt(e.target.value);
                setStrokeWidth(w);
                onUpdateSettings({ strokeWidth: w });
              }}
              className="w-18 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer"
            />
            <span className="w-3 text-right text-emerald-400 font-medium">{strokeWidth}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
