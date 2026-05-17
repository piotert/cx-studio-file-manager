'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parseGeometry, type ThreeGeometryJson } from './ThreeJsonViewer'

// ── Fibonacci sphere directions ────────────────────────────────────────────────

const PHI = (1 + Math.sqrt(5)) / 2
const GOLDEN_ANGLE_RAD = 2 * Math.PI * (2 - PHI)

function makeFibDirs(n: number): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (2 * i) / (n - 1)
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = GOLDEN_ANGLE_RAD * i
    dirs.push(new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta)).normalize())
  }
  return dirs
}

// ── 2-D convex hull (Andrew's monotone chain) ─────────────────────────────────

type P2 = [number, number]

function cross2d(O: P2, A: P2, B: P2): number {
  return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0])
}

function convexHull2D(raw: P2[]): P2[] {
  const pts = [...raw].sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])
  const n = pts.length
  if (n < 2) return pts
  const lower: P2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross2d(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: P2[] = []
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross2d(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function pointInConvexHull(px: number, py: number, hull: P2[]): boolean {
  const n = hull.length
  if (n === 0) return false
  for (let i = 0; i < n; i++) {
    const [ax, ay] = hull[i]
    const [bx, by] = hull[(i + 1) % n]
    if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0) return false
  }
  return true
}

// ── Projection helpers ────────────────────────────────────────────────────────

function projAxes(d: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const up = Math.abs(d.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(d, up).normalize()
  const v = new THREE.Vector3().crossVectors(d, u).normalize()
  return { u, v }
}

// ── Visual hull data ──────────────────────────────────────────────────────────

interface HullData {
  dirs: THREE.Vector3[]
  hulls: P2[][]
  axes: { u: THREE.Vector3; v: THREE.Vector3 }[]
  volumes: number[]
  finalInside: Uint8Array
  voxCenters: Array<[number, number, number]>
  voxGridIdx: Array<[number, number, number]>
  fullGrid: Int32Array
  grid: number
}

const GRID_R = 1.5

function computeHullData(positions: Float32Array, dirs: THREE.Vector3[], grid: number): HullData {
  const step = (2 * GRID_R) / grid

  const axes = dirs.map(d => projAxes(d))
  const hulls = dirs.map((d, k) => {
    const { u, v } = axes[k]
    const pts2d: P2[] = []
    const n = positions.length / 3
    for (let j = 0; j < n; j++) {
      const x = positions[j * 3], y = positions[j * 3 + 1], z = positions[j * 3 + 2]
      pts2d.push([x * u.x + y * u.y + z * u.z, x * v.x + y * v.y + z * v.z])
    }
    return convexHull2D(pts2d)
  })

  const fullGrid = new Int32Array(grid * grid * grid).fill(-1)
  const voxCenters: Array<[number, number, number]> = []
  const voxGridIdx: Array<[number, number, number]> = []

  for (let xi = 0; xi < grid; xi++) {
    for (let yi = 0; yi < grid; yi++) {
      for (let zi = 0; zi < grid; zi++) {
        const x = -GRID_R + (xi + 0.5) * step
        const y = -GRID_R + (yi + 0.5) * step
        const z = -GRID_R + (zi + 0.5) * step
        if (x * x + y * y + z * z <= GRID_R * GRID_R) {
          fullGrid[xi * grid * grid + yi * grid + zi] = voxCenters.length
          voxCenters.push([x, y, z])
          voxGridIdx.push([xi, yi, zi])
        }
      }
    }
  }

  const totalVox = voxCenters.length
  const inside = new Uint8Array(totalVox).fill(1)
  const volumes: number[] = []

  for (let k = 0; k < dirs.length; k++) {
    const { u, v } = axes[k]
    const hull = hulls[k]
    for (let vi = 0; vi < totalVox; vi++) {
      if (!inside[vi]) continue
      const [x, y, z] = voxCenters[vi]
      const px = x * u.x + y * u.y + z * u.z
      const py = x * v.x + y * v.y + z * v.z
      if (!pointInConvexHull(px, py, hull)) inside[vi] = 0
    }
    let count = 0
    for (let vi = 0; vi < totalVox; vi++) count += inside[vi]
    volumes.push((count / totalVox) * 100)
  }

  return { dirs, hulls, axes, volumes, finalInside: inside, voxCenters, voxGridIdx, fullGrid, grid }
}

// ── Build hull surface mesh (exposed voxel face extraction) ───────────────────

const FACE_DEFS = [
  { g: [1,0,0] as const, n: [1,0,0] as const, s: [[1,1,1],[1,-1,1],[1,-1,-1],[1,1,-1]] as const },
  { g: [-1,0,0] as const, n: [-1,0,0] as const, s: [[-1,1,-1],[-1,-1,-1],[-1,-1,1],[-1,1,1]] as const },
  { g: [0,1,0] as const, n: [0,1,0] as const, s: [[1,1,-1],[-1,1,-1],[-1,1,1],[1,1,1]] as const },
  { g: [0,-1,0] as const, n: [0,-1,0] as const, s: [[1,-1,1],[-1,-1,1],[-1,-1,-1],[1,-1,-1]] as const },
  { g: [0,0,1] as const, n: [0,0,1] as const, s: [[-1,1,1],[1,1,1],[1,-1,1],[-1,-1,1]] as const },
  { g: [0,0,-1] as const, n: [0,0,-1] as const, s: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]] as const },
]

function buildHullSurface(data: HullData): THREE.BufferGeometry {
  const { finalInside, voxCenters, voxGridIdx, fullGrid, grid } = data
  const h = (2 * GRID_R) / grid / 2
  const verts: number[] = []
  const norms: number[] = []

  for (let vi = 0; vi < voxCenters.length; vi++) {
    if (!finalInside[vi]) continue
    const [cx, cy, cz] = voxCenters[vi]
    const [xi, yi, zi] = voxGridIdx[vi]

    for (const { g, n, s } of FACE_DEFS) {
      const nxi = xi + g[0], nyi = yi + g[1], nzi = zi + g[2]
      let nbIn = false
      if (nxi >= 0 && nxi < grid && nyi >= 0 && nyi < grid && nzi >= 0 && nzi < grid) {
        const nvi = fullGrid[nxi * grid * grid + nyi * grid + nzi]
        if (nvi !== -1 && finalInside[nvi]) nbIn = true
      }
      if (nbIn) continue
      const q = s.map(([qx, qy, qz]) => [cx + qx * h, cy + qy * h, cz + qz * h])
      verts.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3])
      for (let t = 0; t < 6; t++) norms.push(...n)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3))
  geo.computeBoundingSphere()
  return geo
}

// ── Visual presets ────────────────────────────────────────────────────────────

type PresetKey = 'dark' | 'blueprint' | 'light' | 'drawing' | 'xray' | 'black'

interface Preset {
  bg: number
  objColor: number
  objEmissive: number
  hullColor: number
  hullEmissive: number
  hullOpacity: number
  edgeColor: number
  projColor: number
  sphereRefColor: number
}

const PRESETS: Record<PresetKey, Preset> = {
  dark:      { bg: 0x0a0a14, objColor: 0xd4860a, objEmissive: 0x221100, hullColor: 0x00e5aa, hullEmissive: 0x003322, hullOpacity: 0.55, edgeColor: 0x4499ff, projColor: 0x1155cc, sphereRefColor: 0x1a1a33 },
  blueprint: { bg: 0x0a0f32, objColor: 0x5588ff, objEmissive: 0x001144, hullColor: 0x00ffcc, hullEmissive: 0x00332a, hullOpacity: 0.45, edgeColor: 0x88bbff, projColor: 0x2244cc, sphereRefColor: 0x0d1c4a },
  light:     { bg: 0xf0f2f5, objColor: 0x3366aa, objEmissive: 0x001133, hullColor: 0x009977, hullEmissive: 0x002211, hullOpacity: 0.45, edgeColor: 0x224488, projColor: 0x2244aa, sphereRefColor: 0xcccccc },
  drawing:   { bg: 0xf5f5f0, objColor: 0x555555, objEmissive: 0x111111, hullColor: 0x224444, hullEmissive: 0x000000, hullOpacity: 0.40, edgeColor: 0x111111, projColor: 0x334444, sphereRefColor: 0xbbbbaa },
  xray:      { bg: 0x000000, objColor: 0x004422, objEmissive: 0x002211, hullColor: 0x00ff88, hullEmissive: 0x005533, hullOpacity: 0.35, edgeColor: 0x00ff88, projColor: 0x003322, sphereRefColor: 0x111111 },
  black:     { bg: 0x000000, objColor: 0xcc8800, objEmissive: 0x221100, hullColor: 0x00cc99, hullEmissive: 0x002211, hullOpacity: 0.50, edgeColor: 0x00aaff, projColor: 0x113355, sphereRefColor: 0x111111 },
}

const PRESET_LABELS: Record<PresetKey, string> = {
  dark: 'Dark', blueprint: 'Blueprint', light: 'Light', drawing: 'Drawing', xray: 'X-Ray', black: 'Black',
}

// ── Normalise vertex positions to bounding sphere R≈1.35 ──────────────────────

function normalisePositions(rawPos: Float32Array): Float32Array {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < rawPos.length; i += 3) {
    minX = Math.min(minX, rawPos[i]); maxX = Math.max(maxX, rawPos[i])
    minY = Math.min(minY, rawPos[i + 1]); maxY = Math.max(maxY, rawPos[i + 1])
    minZ = Math.min(minZ, rawPos[i + 2]); maxZ = Math.max(maxZ, rawPos[i + 2])
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
  let maxDist = 0
  for (let i = 0; i < rawPos.length; i += 3) {
    const dx = rawPos[i] - cx, dy = rawPos[i + 1] - cy, dz = rawPos[i + 2] - cz
    maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz))
  }
  const sc = maxDist > 0 ? 1.35 / maxDist : 1
  const out = new Float32Array(rawPos.length)
  for (let i = 0; i < rawPos.length; i += 3) {
    out[i] = (rawPos[i] - cx) * sc
    out[i + 1] = (rawPos[i + 1] - cy) * sc
    out[i + 2] = (rawPos[i + 2] - cz) * sc
  }
  return out
}

// ── Scene helpers ─────────────────────────────────────────────────────────────

function disposeObj(obj: THREE.Object3D) {
  if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose()
  const mat = (obj as THREE.Mesh).material
  if (mat) { Array.isArray(mat) ? mat.forEach(m => m.dispose()) : (mat as THREE.Material).dispose() }
}

function clearGroup(g: THREE.Group) {
  while (g.children.length > 0) { const c = g.children[0]; g.remove(c); disposeObj(c) }
}

function buildProjectionMesh(
  hull2d: P2[], dir: THREE.Vector3,
  axes: { u: THREE.Vector3; v: THREE.Vector3 },
  dist: number, opacity: number, projColor: number,
): THREE.Group {
  const group = new THREE.Group()
  const pos = dir.clone().multiplyScalar(dist)
  const { u, v } = axes
  const rotMat = new THREE.Matrix4().makeBasis(u, v, dir)
  const quat = new THREE.Quaternion().setFromRotationMatrix(rotMat)

  if (hull2d.length >= 3) {
    const shape = new THREE.Shape()
    shape.moveTo(hull2d[0][0], hull2d[0][1])
    for (let i = 1; i < hull2d.length; i++) shape.lineTo(hull2d[i][0], hull2d[i][1])
    shape.closePath()
    const fillGeo = new THREE.ShapeGeometry(shape)
    const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
      color: projColor, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }))
    fill.position.copy(pos); fill.quaternion.copy(quat)
    group.add(fill)
    const edgeColor = new THREE.Color(projColor).multiplyScalar(1.6)
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(fillGeo),
      new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: Math.min(1, opacity * 2) }))
    edge.position.copy(pos); edge.quaternion.copy(quat)
    group.add(edge)
  }

  const axisGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), pos])
  const axisColor = new THREE.Color(projColor).multiplyScalar(0.6)
  group.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: axisColor, transparent: true, opacity: 0.4 })))
  return group
}

// ── Component ─────────────────────────────────────────────────────────────────

type ObjType = 'torusknot' | 'box'
type StopMode = 'delta' | 'all'

interface FileItem { name: string; url: string; fileType: 'json' | 'gltf' }

interface SceneRefs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  rafId: number
  objectGroup: THREE.Group
  dirSpheresGroup: THREE.Group
  projectionsGroup: THREE.Group
  hullMeshGroup: THREE.Group
  refSphere: THREE.LineSegments
}

export default function VisualHull() {
  const mountRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)
  const hullDataRef = useRef<HullData | null>(null)
  const highlightRef = useRef<THREE.Mesh | null>(null)
  const positionsRef = useRef<Float32Array | null>(null)

  // Algorithm params
  const [objType, setObjType] = useState<ObjType>('torusknot')
  const [nDirs, setNDirs] = useState(16)
  const [gridSize, setGridSize] = useState(32)
  const [stopMode, setStopMode] = useState<StopMode>('delta')
  const [deltaThreshold, setDeltaThreshold] = useState(0.5)
  const [stepDelay, setStepDelay] = useState(500)
  const [projOpacity, setProjOpacity] = useState(0.35)

  // Animation state
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [volumes, setVolumes] = useState<number[]>([])
  const [stopped, setStopped] = useState(false)
  const [showHull, setShowHull] = useState(false)

  // Visual
  const [preset, setPreset] = useState<PresetKey>('dark')
  const [showBody, setShowBody] = useState(true)
  const [showEdges, setShowEdges] = useState(false)
  const [showDirSpheres, setShowDirSpheres] = useState(true)
  const [showProjections, setShowProjections] = useState(true)

  // File picker
  const [supaFiles, setSupaFiles] = useState<FileItem[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [fileLabel, setFileLabel] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  // ── Scene init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(PRESETS.dark.bg, 1)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 50)
    camera.position.set(0, 1.5, 4.5)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.5

    const refSphere = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.SphereGeometry(1.5, 24, 12)),
      new THREE.LineBasicMaterial({ color: PRESETS.dark.sphereRefColor, transparent: true, opacity: 0.3 })
    )
    scene.add(refSphere)

    scene.add(new THREE.AmbientLight(0x7788aa, 0.9))
    const dl = new THREE.DirectionalLight(0xaabbdd, 2.0); dl.position.set(3, 4, 3); scene.add(dl)
    const dl2 = new THREE.DirectionalLight(0x334466, 0.8); dl2.position.set(-2, -1, -3); scene.add(dl2)

    const objectGroup = new THREE.Group()
    const dirSpheresGroup = new THREE.Group()
    const projectionsGroup = new THREE.Group()
    const hullMeshGroup = new THREE.Group()
    scene.add(objectGroup, dirSpheresGroup, projectionsGroup, hullMeshGroup)

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      if (!w || !h) return
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h)
    }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(mount)

    let rafId = 0
    const animate = () => { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }
    animate()

    sceneRef.current = { renderer, scene, camera, controls, rafId, objectGroup, dirSpheresGroup, projectionsGroup, hullMeshGroup, refSphere }
    return () => {
      cancelAnimationFrame(rafId); ro.disconnect(); controls.dispose(); renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [])

  // ── Apply preset ───────────────────────────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    const p = PRESETS[preset]
    s.renderer.setClearColor(p.bg, 1)
    ;(s.refSphere.material as THREE.LineBasicMaterial).color.setHex(p.sphereRefColor)

    // Object meshes
    s.objectGroup.traverse(child => {
      if (child.name === 'obj-mesh' && (child as THREE.Mesh).isMesh) {
        const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial
        mat.color.setHex(p.objColor); mat.emissive.setHex(p.objEmissive)
      }
      if (child.name === 'obj-edges') {
        ;(child as THREE.LineSegments).material = new THREE.LineBasicMaterial({ color: p.edgeColor, transparent: true, opacity: 0.4 })
      }
    })

    // Hull mesh
    s.hullMeshGroup.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial
        mat.color.setHex(p.hullColor); mat.emissive.setHex(p.hullEmissive); mat.opacity = p.hullOpacity
      }
    })
  }, [preset])

  // ── Hull mesh rebuild ──────────────────────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    clearGroup(s.hullMeshGroup)
    if (!showHull || !hullDataRef.current) return

    const p = PRESETS[preset]
    const geo = buildHullSurface(hullDataRef.current)
    s.hullMeshGroup.add(Object.assign(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color: p.hullColor, emissive: p.hullEmissive, shininess: 50,
      transparent: true, opacity: p.hullOpacity, side: THREE.DoubleSide,
    })), { name: 'hull-mesh' }))
    s.hullMeshGroup.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 15),
      new THREE.LineBasicMaterial({ color: p.hullColor, transparent: true, opacity: 0.2 })
    ))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHull])

  // ── View mode toggles ──────────────────────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    s.objectGroup.traverse(c => { if (c.name === 'obj-mesh') c.visible = showBody })
  }, [showBody])

  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    s.objectGroup.traverse(c => { if (c.name === 'obj-edges') c.visible = showEdges })
  }, [showEdges])

  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    s.dirSpheresGroup.visible = showDirSpheres
  }, [showDirSpheres])

  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    s.projectionsGroup.visible = showProjections
  }, [showProjections])

  // ── Build direction spheres + hull data ───────────────────────────────────
  const setupDirsAndHull = useCallback((positions: Float32Array, grid: number, n: number) => {
    const s = sceneRef.current
    if (!s) return
    clearGroup(s.dirSpheresGroup)

    const dirs = makeFibDirs(n)
    dirs.forEach((d, i) => {
      const t = i / Math.max(n - 1, 1)
      const col = new THREE.Color().setHSL(0.08 + t * 0.05, 0.9, 0.55)
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 8, 6),
        new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: 0.3 })
      )
      sphere.position.copy(d.clone().multiplyScalar(1.55))
      s.dirSpheresGroup.add(sphere)
    })
    s.dirSpheresGroup.visible = showDirSpheres

    hullDataRef.current = computeHullData(positions, dirs, grid)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Helper: add a built-in mesh to objectGroup ────────────────────────────
  const addMeshToScene = useCallback((geo: THREE.BufferGeometry, color: number, emissive: number) => {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.objectGroup)
    const mesh = Object.assign(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color, emissive, shininess: 80, transparent: true, opacity: 0.88,
    })), { name: 'obj-mesh' })
    mesh.visible = showBody
    const edges = Object.assign(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 30),
      new THREE.LineBasicMaterial({ color: PRESETS[preset].edgeColor, transparent: true, opacity: 0.4 })
    ), { name: 'obj-edges' })
    edges.visible = showEdges
    const wire = Object.assign(new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05 })
    ), { name: 'obj-wire' })
    s.objectGroup.add(mesh, edges, wire)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, showBody, showEdges])

  // ── Built-in object rebuild ───────────────────────────────────────────────
  const buildBuiltIn = useCallback((type: ObjType, grid: number, n: number) => {
    let geo: THREE.BufferGeometry
    if (type === 'torusknot') geo = new THREE.TorusKnotGeometry(0.7, 0.18, 80, 14)
    else geo = new THREE.BoxGeometry(1.2, 1.2, 1.2)

    geo.computeBoundingSphere()
    const bs = geo.boundingSphere!
    const sc = 1.35 / bs.radius
    geo.scale(sc, sc, sc)
    const off = bs.center.clone().multiplyScalar(-sc)
    geo.translate(off.x, off.y, off.z)

    const p = PRESETS[preset]
    addMeshToScene(geo, p.objColor, p.objEmissive)

    const positions = geo.attributes.position.array as Float32Array
    positionsRef.current = positions
    setupDirsAndHull(positions, grid, n)
  }, [preset, addMeshToScene, setupDirsAndHull])

  // Rebuild when params change (only for built-in objects)
  useEffect(() => {
    if (fileLabel) return
    const s = sceneRef.current; if (!s) return
    clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
    highlightRef.current = null
    buildBuiltIn(objType, gridSize, nDirs)
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objType, nDirs, gridSize])

  // Rebuild hull data only when grid/dirs change (for loaded files)
  useEffect(() => {
    if (!fileLabel || !positionsRef.current) return
    const s = sceneRef.current; if (!s) return
    clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
    highlightRef.current = null
    setupDirsAndHull(positionsRef.current, gridSize, nDirs)
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nDirs, gridSize])

  // ── Animation: step-by-step carving ───────────────────────────────────────
  useEffect(() => {
    if (!isPlaying || stopped) return
    const data = hullDataRef.current
    if (!data || currentStep >= data.dirs.length) {
      setIsPlaying(false)
      if (data && currentStep >= data.dirs.length) setShowHull(true)
      return
    }

    const timer = setTimeout(() => {
      const s = sceneRef.current
      if (!s || !hullDataRef.current) return
      const d = hullDataRef.current
      const step = currentStep

      if (highlightRef.current) {
        const prevMat = highlightRef.current.material as THREE.MeshPhongMaterial
        prevMat.emissiveIntensity = 0.3
        prevMat.color.setHSL(0.08, 0.9, 0.55)
      }
      const dirSphere = s.dirSpheresGroup.children[step] as THREE.Mesh
      if (dirSphere) {
        const mat = dirSphere.material as THREE.MeshPhongMaterial
        mat.color.set(0xffffff); mat.emissive.set(0xffaa00); mat.emissiveIntensity = 1.0
        highlightRef.current = dirSphere
      }

      s.projectionsGroup.add(buildProjectionMesh(
        d.hulls[step], d.dirs[step], d.axes[step], 1.75, projOpacity, PRESETS[preset].projColor
      ))

      const vol = d.volumes[step]
      const prevVol = step > 0 ? d.volumes[step - 1] : 100
      const delta = prevVol - vol
      setVolumes(prev => [...prev, vol])

      const isLast = step === d.dirs.length - 1
      const deltaStop = stopMode === 'delta' && delta < deltaThreshold && step > 0
      if (isLast || deltaStop) {
        setStopped(deltaStop && !isLast)
        setIsPlaying(false)
        setShowHull(true)
      } else {
        setCurrentStep(step + 1)
      }
    }, stepDelay)

    return () => clearTimeout(timer)
  }, [isPlaying, currentStep, stepDelay, deltaThreshold, projOpacity, stopped, stopMode, preset])

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    const s = sceneRef.current
    if (s) { clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup) }
    highlightRef.current = null
    if (s) {
      s.dirSpheresGroup.children.forEach((c, i) => {
        const mesh = c as THREE.Mesh
        const mat = mesh.material as THREE.MeshPhongMaterial
        const t = nDirs > 1 ? i / (nDirs - 1) : 0.5
        const col = new THREE.Color().setHSL(0.08 + t * 0.05, 0.9, 0.55)
        mat.color.copy(col); mat.emissive.copy(col); mat.emissiveIntensity = 0.3
      })
    }
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  }, [nDirs])

  // ── Load local file ───────────────────────────────────────────────────────
  const applyLoadedMesh = useCallback((
    dispGeo: THREE.BufferGeometry | null,
    gltfScene: THREE.Group | null,
    normPos: Float32Array,
    label: string,
  ) => {
    const s = sceneRef.current; if (!s) return
    const p = PRESETS[preset]
    clearGroup(s.objectGroup)

    if (dispGeo) {
      if (!dispGeo.attributes.normal) dispGeo.computeVertexNormals()
      const mesh = Object.assign(new THREE.Mesh(dispGeo, new THREE.MeshPhongMaterial({
        color: p.objColor, emissive: p.objEmissive, shininess: 70, transparent: true, opacity: 0.88,
      })), { name: 'obj-mesh' })
      mesh.visible = showBody
      const edges = Object.assign(new THREE.LineSegments(
        new THREE.EdgesGeometry(dispGeo, 30),
        new THREE.LineBasicMaterial({ color: p.edgeColor, transparent: true, opacity: 0.4 })
      ), { name: 'obj-edges' })
      edges.visible = showEdges
      s.objectGroup.add(mesh, edges)
    }

    if (gltfScene) {
      gltfScene.traverse(child => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh
          m.name = 'obj-mesh'
          m.visible = showBody
          m.material = new THREE.MeshPhongMaterial({ color: p.objColor, emissive: p.objEmissive, shininess: 70, transparent: true, opacity: 0.88 })
        }
      })
      s.objectGroup.add(gltfScene)
    }

    positionsRef.current = normPos
    setupDirsAndHull(normPos, gridSize, nDirs)
    setFileLabel(label)
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, showBody, showEdges, gridSize, nDirs, setupDirsAndHull])

  const loadLocalFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext !== 'json' && ext !== 'glb' && ext !== 'gltf') return
    setLoadingFile(true)
    handleReset()

    try {
      const s = sceneRef.current; if (!s) return
      clearGroup(s.dirSpheresGroup); clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
      highlightRef.current = null

      if (ext === 'json') {
        const json = JSON.parse(await file.text()) as ThreeGeometryJson
        const normPos = normalisePositions(new Float32Array(json.vertices))
        const dispGeo = parseGeometry(json)
        dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(normPos, 3))
        applyLoadedMesh(dispGeo, null, normPos, file.name)
      } else {
        const objectUrl = URL.createObjectURL(file)
        const loader = new GLTFLoader()
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
          loader.load(objectUrl, resolve, undefined, reject)
        )
        URL.revokeObjectURL(objectUrl)
        const allPos: number[] = []
        gltf.scene.updateMatrixWorld(true)
        gltf.scene.traverse(child => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh
            const pos = mesh.geometry.attributes.position
            for (let i = 0; i < pos.count; i++) {
              const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
              allPos.push(v.x, v.y, v.z)
            }
          }
        })
        const normPos = normalisePositions(new Float32Array(allPos))
        // fit GLTF scene to same normalised scale
        const raw = new Float32Array(allPos)
        let mnX = Infinity, mnY = Infinity, mnZ = Infinity, mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity
        for (let i = 0; i < raw.length; i += 3) {
          mnX = Math.min(mnX, raw[i]); mxX = Math.max(mxX, raw[i])
          mnY = Math.min(mnY, raw[i+1]); mxY = Math.max(mxY, raw[i+1])
          mnZ = Math.min(mnZ, raw[i+2]); mxZ = Math.max(mxZ, raw[i+2])
        }
        const ocx = (mnX+mxX)/2, ocy = (mnY+mxY)/2, ocz = (mnZ+mxZ)/2
        let oMx = 0
        for (let i = 0; i < raw.length; i += 3) {
          const dx = raw[i]-ocx, dy = raw[i+1]-ocy, dz = raw[i+2]-ocz
          oMx = Math.max(oMx, Math.sqrt(dx*dx+dy*dy+dz*dz))
        }
        const oSc = oMx > 0 ? 1.35/oMx : 1
        gltf.scene.scale.setScalar(oSc)
        gltf.scene.position.set(-ocx*oSc, -ocy*oSc, -ocz*oSc)
        applyLoadedMesh(null, gltf.scene, normPos, file.name)
      }
    } catch (err) { console.error('Load error', err) }
    finally { setLoadingFile(false) }
  }, [handleReset, applyLoadedMesh])

  // ── Supabase file list ────────────────────────────────────────────────────
  const fetchFileList = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const res = await fetch('/api/files')
      if (!res.ok) throw new Error()
      const data: { name: string; url: string; type: string }[] = await res.json()
      setSupaFiles(data.filter(f => f.type === 'json' || f.type === 'gltf')
        .map(f => ({ name: f.name, url: f.url, fileType: f.type as 'json' | 'gltf' })))
    } catch { setSupaFiles([]) }
    finally { setLoadingFiles(false) }
  }, [])

  const loadSupaFile = useCallback(async (url: string, label: string, fileType: 'json' | 'gltf') => {
    setLoadingFile(true); setShowPicker(false)
    handleReset()
    try {
      const s = sceneRef.current; if (!s) return
      clearGroup(s.dirSpheresGroup); clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
      highlightRef.current = null

      if (fileType === 'json') {
        const json = await (await fetch(url)).json() as ThreeGeometryJson
        const normPos = normalisePositions(new Float32Array(json.vertices))
        const dispGeo = parseGeometry(json)
        dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(normPos, 3))
        applyLoadedMesh(dispGeo, null, normPos, label)
      } else {
        const loader = new GLTFLoader()
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
          loader.load(url, resolve, undefined, reject)
        )
        const allPos: number[] = []
        gltf.scene.updateMatrixWorld(true)
        gltf.scene.traverse(child => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh
            const pos = mesh.geometry.attributes.position
            for (let i = 0; i < pos.count; i++) {
              const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
              allPos.push(v.x, v.y, v.z)
            }
          }
        })
        const normPos = normalisePositions(new Float32Array(allPos))
        const raw = new Float32Array(allPos)
        let mnX = Infinity, mnY = Infinity, mnZ = Infinity, mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity
        for (let i = 0; i < raw.length; i += 3) {
          mnX = Math.min(mnX, raw[i]); mxX = Math.max(mxX, raw[i])
          mnY = Math.min(mnY, raw[i+1]); mxY = Math.max(mxY, raw[i+1])
          mnZ = Math.min(mnZ, raw[i+2]); mxZ = Math.max(mxZ, raw[i+2])
        }
        const ocx = (mnX+mxX)/2, ocy = (mnY+mxY)/2, ocz = (mnZ+mxZ)/2
        let oMx = 0
        for (let i = 0; i < raw.length; i += 3) {
          const dx = raw[i]-ocx, dy = raw[i+1]-ocy, dz = raw[i+2]-ocz
          oMx = Math.max(oMx, Math.sqrt(dx*dx+dy*dy+dz*dz))
        }
        const oSc = oMx > 0 ? 1.35/oMx : 1
        gltf.scene.scale.setScalar(oSc); gltf.scene.position.set(-ocx*oSc, -ocy*oSc, -ocz*oSc)
        applyLoadedMesh(null, gltf.scene, normPos, label)
      }
    } catch (err) { console.error('Load error', err) }
    finally { setLoadingFile(false) }
  }, [handleReset, applyLoadedMesh])

  // ── Derived ───────────────────────────────────────────────────────────────
  const latestVol = volumes.length > 0 ? volumes[volumes.length - 1] : 100
  const prevVol   = volumes.length > 1 ? volumes[volumes.length - 2] : 100
  const delta     = prevVol - latestVol
  const totalSteps = hullDataRef.current?.dirs.length ?? nDirs
  const animDone  = (currentStep >= totalSteps && volumes.length > 0) || stopped
  const voxelSize = ((2 * GRID_R) / gridSize).toFixed(3)

  const btnToggle = (active: boolean) =>
    `px-2 py-0.5 rounded border text-xs transition-colors ${
      active ? 'border-sky-500 text-sky-300 bg-sky-900/30' : 'border-gray-600 text-gray-400 hover:border-gray-400'
    }`

  return (
    <div className="h-full flex flex-col">
      {/* ── Controls row ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-gray-800 shrink-0 flex-wrap bg-gray-950 text-xs">

        {/* Object source */}
        <div className="flex items-center gap-1">
          <span className="text-gray-500 mr-1">Obj</span>
          {(['torusknot', 'box'] as ObjType[]).map(t => (
            <button key={t} disabled={!!fileLabel}
              onClick={() => { setFileLabel(null); setObjType(t) }}
              className={`px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                objType === t && !fileLabel ? 'border-orange-500 text-orange-300 bg-orange-900/30' : 'border-gray-600 text-gray-400 hover:border-gray-400'
              }`}>
              {t === 'torusknot' ? 'Torus' : 'Box'}
            </button>
          ))}
        </div>

        {/* Local file open */}
        <div>
          <input ref={fileInputRef} type="file" accept=".json,.glb,.gltf" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) loadLocalFile(f); e.target.value = '' }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={loadingFile}
            className="px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:border-gray-300 transition-colors disabled:opacity-40">
            📂 Open…
          </button>
        </div>

        {/* Supabase picker */}
        <div className="relative">
          <button onClick={() => { setShowPicker(v => !v); if (!supaFiles.length && !loadingFiles) fetchFileList() }}
            className={`px-2 py-0.5 rounded border transition-colors ${fileLabel ? 'border-cyan-600 text-cyan-300 bg-cyan-900/20' : 'border-gray-600 text-gray-400 hover:border-gray-400'}`}>
            {loadingFile ? '…' : fileLabel ? `↗ ${fileLabel.replace(/^\d+_/, '')}` : '↗ Supabase'}
          </button>
          {showPicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-gray-900 border border-gray-700 rounded shadow-xl min-w-[220px] max-h-52 overflow-y-auto">
              {loadingFiles && <div className="px-3 py-2 text-gray-400">Loading…</div>}
              {!loadingFiles && supaFiles.length === 0 && <div className="px-3 py-2 text-gray-500">No files</div>}
              {supaFiles.map(f => (
                <button key={f.url} onClick={() => loadSupaFile(f.url, f.name, f.fileType)}
                  className="w-full text-left px-3 py-1.5 text-gray-300 hover:bg-gray-800 truncate flex items-center gap-2">
                  <span className={`text-[10px] font-mono px-1 rounded ${f.fileType === 'json' ? 'bg-orange-900/40 text-orange-400' : 'bg-blue-900/40 text-blue-400'}`}>
                    {f.fileType.toUpperCase()}
                  </span>
                  {f.name.replace(/^\d+_/, '')}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-gray-700 shrink-0" />

        {/* Algorithm params */}
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 whitespace-nowrap">Dirs N</span>
          <input type="range" min={3} max={48} value={nDirs} onChange={e => setNDirs(+e.target.value)} className="w-20 accent-orange-500" />
          <span className="font-mono text-orange-300 w-5 tabular-nums">{nDirs}</span>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 whitespace-nowrap">Voxel</span>
          <input type="range" min={12} max={56} step={4} value={gridSize} onChange={e => setGridSize(+e.target.value)} className="w-20 accent-purple-400" />
          <span className="font-mono text-purple-300 tabular-nums w-12">{voxelSize}</span>
        </label>

        {/* Stop mode */}
        <div className="flex items-center gap-1">
          <span className="text-gray-400">Stop</span>
          <button onClick={() => setStopMode('delta')} className={btnToggle(stopMode === 'delta')}>Δ</button>
          <button onClick={() => setStopMode('all')} className={btnToggle(stopMode === 'all')}>All N</button>
        </div>

        {stopMode === 'delta' && (
          <label className="flex items-center gap-1.5">
            <span className="text-gray-400 whitespace-nowrap">Δ &lt;</span>
            <input type="range" min={0.01} max={5} step={0.01} value={deltaThreshold}
              onChange={e => setDeltaThreshold(+e.target.value)} className="w-20 accent-red-400" />
            <span className="font-mono text-red-300 tabular-nums w-12">{deltaThreshold.toFixed(2)}%</span>
          </label>
        )}

        <label className="flex items-center gap-1.5">
          <span className="text-gray-400">Speed</span>
          <input type="range" min={50} max={2000} step={50} value={stepDelay}
            onChange={e => setStepDelay(+e.target.value)} className="w-16 accent-gray-400" />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-gray-400">Silhouette</span>
          <input type="range" min={0.05} max={0.8} step={0.05} value={projOpacity}
            onChange={e => setProjOpacity(+e.target.value)} className="w-14 accent-blue-400" />
        </label>

        <div className="w-px h-4 bg-gray-700 shrink-0" />

        {/* Presets */}
        <div className="flex items-center gap-1">
          {(Object.keys(PRESETS) as PresetKey[]).map(k => (
            <button key={k} onClick={() => setPreset(k)}
              className={`px-2 py-0.5 rounded border transition-colors ${
                preset === k ? 'border-white/50 text-white bg-white/10' : 'border-gray-700 text-gray-500 hover:border-gray-400 hover:text-gray-300'
              }`}>
              {PRESET_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-gray-700 shrink-0" />

        {/* View toggles */}
        <div className="flex items-center gap-1">
          <span className="text-gray-500 mr-0.5">Show</span>
          <button onClick={() => setShowBody(v => !v)} className={btnToggle(showBody)}>Body</button>
          <button onClick={() => setShowEdges(v => !v)} className={btnToggle(showEdges)}>Edges</button>
          <button onClick={() => setShowDirSpheres(v => !v)} className={btnToggle(showDirSpheres)}>Dirs</button>
          <button onClick={() => setShowProjections(v => !v)} className={btnToggle(showProjections)}>Proj</button>
        </div>

        {/* Playback */}
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setShowHull(v => !v)} disabled={!animDone}
            className={`px-2.5 py-1 rounded border transition-colors disabled:opacity-30 ${
              showHull ? 'border-teal-500 text-teal-300 bg-teal-900/30' : 'border-gray-600 text-gray-400 hover:border-teal-600'
            }`}>
            ◈ Hull
          </button>
          <button
            onClick={() => { setStopped(false); setIsPlaying(v => !v) }}
            disabled={currentStep >= totalSteps && !stopped}
            className={`px-2.5 py-1 rounded border transition-colors disabled:opacity-40 ${
              isPlaying ? 'border-yellow-600 text-yellow-400 bg-yellow-900/20' : 'border-emerald-600 text-emerald-400 bg-emerald-900/20'
            }`}>
            {isPlaying ? '⏸ Pause' : currentStep === 0 ? '▶ Play' : '▶ Resume'}
          </button>
          <button onClick={handleReset}
            className="px-2.5 py-1 rounded border border-gray-600 text-gray-400 hover:border-gray-400 transition-colors">
            ↺ Reset
          </button>
        </div>
      </div>

      {/* ── Main area ──────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div ref={mountRef} className="flex-1 min-w-0 min-h-0" />

        {/* Stats sidebar */}
        <div className="w-48 shrink-0 border-l border-gray-800 bg-gray-950 flex flex-col gap-3 p-3 text-xs overflow-y-auto">
          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Progress</div>
            <div className="font-mono text-gray-300 text-lg tabular-nums">
              {currentStep} <span className="text-gray-600 text-xs">/ {totalSteps}</span>
            </div>
            <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-orange-500 rounded-full transition-all"
                style={{ width: `${(currentStep / Math.max(totalSteps, 1)) * 100}%` }} />
            </div>
          </div>

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Hull Volume</div>
            <div className="font-mono text-blue-300 text-lg tabular-nums">
              {latestVol.toFixed(1)}<span className="text-gray-600 text-xs">%</span>
            </div>
            <div className="text-gray-600 text-[10px]">of bounding sphere</div>
            <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.max(0, latestVol))}%` }} />
            </div>
          </div>

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Δ per step</div>
            <div className={`font-mono text-lg tabular-nums ${delta > deltaThreshold ? 'text-emerald-400' : 'text-red-400'}`}>
              {volumes.length > 1 ? `−${delta.toFixed(3)}%` : '—'}
            </div>
            {volumes.length > 1 && stopMode === 'delta' && (
              <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${delta > deltaThreshold ? 'bg-emerald-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.min(100, (delta / Math.max(0.01, deltaThreshold)) * 50)}%` }} />
              </div>
            )}
          </div>

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Grid</div>
            <div className="font-mono text-purple-300">{gridSize}³</div>
            <div className="text-gray-600 text-[10px]">voxel {voxelSize} u</div>
          </div>

          {stopped && (
            <div className="rounded border border-red-800 bg-red-900/20 px-2 py-1.5 text-red-400 text-[11px]">
              Δ &lt; {deltaThreshold.toFixed(2)}% — stopped
            </div>
          )}
          {currentStep >= totalSteps && !stopped && volumes.length > 0 && (
            <div className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-gray-400 text-[11px]">
              All {totalSteps} directions done
            </div>
          )}
          {animDone && (
            <div className={`rounded border px-2 py-1.5 text-[11px] cursor-pointer transition-colors ${
              showHull ? 'border-teal-700 bg-teal-900/20 text-teal-400' : 'border-gray-700 text-gray-500 hover:border-teal-700'
            }`} onClick={() => setShowHull(v => !v)}>
              {showHull ? '◈ Hull visible' : '◈ Show hull solid'}
            </div>
          )}

          {volumes.length > 1 && (
            <div>
              <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Convergence</div>
              <svg viewBox={`0 0 ${volumes.length} 40`} className="w-full h-10" preserveAspectRatio="none">
                <polyline
                  points={volumes.map((v, i) => `${i},${40 - (v / 100) * 36}`).join(' ')}
                  fill="none" stroke="#3366cc" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
