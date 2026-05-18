'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parseGeometry, type ThreeGeometryJson } from './ThreeJsonViewer'
import { TeapotGeometry } from 'three/examples/jsm/geometries/TeapotGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'

// ── Fibonacci sphere ───────────────────────────────────────────────────────────

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

// ── Projection axes ────────────────────────────────────────────────────────────

function projAxes(d: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const up = Math.abs(d.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(d, up).normalize()
  const v = new THREE.Vector3().crossVectors(d, u).normalize()
  return { u, v }
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

interface NormParams { cx: number; cy: number; cz: number; sc: number }

function computeNorm(vertices: Float32Array): NormParams {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < vertices.length; i += 3) {
    minX = Math.min(minX, vertices[i]);   maxX = Math.max(maxX, vertices[i])
    minY = Math.min(minY, vertices[i+1]); maxY = Math.max(maxY, vertices[i+1])
    minZ = Math.min(minZ, vertices[i+2]); maxZ = Math.max(maxZ, vertices[i+2])
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
  let maxDist = 0
  for (let i = 0; i < vertices.length; i += 3) {
    const dx = vertices[i]-cx, dy = vertices[i+1]-cy, dz = vertices[i+2]-cz
    maxDist = Math.max(maxDist, Math.sqrt(dx*dx + dy*dy + dz*dz))
  }
  return { cx, cy, cz, sc: maxDist > 0 ? 1.35 / maxDist : 1 }
}

function applyNorm(pos: Float32Array, n: NormParams): Float32Array {
  const out = new Float32Array(pos.length)
  for (let i = 0; i < pos.length; i += 3) {
    out[i]   = (pos[i]   - n.cx) * n.sc
    out[i+1] = (pos[i+1] - n.cy) * n.sc
    out[i+2] = (pos[i+2] - n.cz) * n.sc
  }
  return out
}

// Extract triangle-soup (9 floats / triangle) from a BufferGeometry
function extractTriSoup(geo: THREE.BufferGeometry): Float32Array {
  const posAttr = geo.attributes.position
  const index = geo.index
  const count = index ? index.count : posAttr.count
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const vi = index ? index.getX(i) : i
    arr[i*3]   = posAttr.getX(vi)
    arr[i*3+1] = posAttr.getY(vi)
    arr[i*3+2] = posAttr.getZ(vi)
  }
  return arr
}

// ── Triangle shadow-mask rasteriser ───────────────────────────────────────────

const GRID_R = 1.5

// Full-spectrum rainbow: t=0→red, t=1→violet
function rainbow(t: number): THREE.Color { return new THREE.Color().setHSL(t * 0.82, 0.92, 0.58) }

// SLERP-based geodesic arc between two unit vectors (radius r)
function geodesicArc(a: THREE.Vector3, b: THREE.Vector3, segments: number, r = 1): THREE.Vector3[] {
  const dot = Math.max(-1, Math.min(1, a.dot(b)))
  const theta = Math.acos(dot)
  if (theta < 1e-6) return [a.clone().multiplyScalar(r), b.clone().multiplyScalar(r)]
  const sinTheta = Math.sin(theta)
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const w1 = Math.sin((1 - t) * theta) / sinTheta
    const w2 = Math.sin(t * theta) / sinTheta
    pts.push(new THREE.Vector3(a.x * w1 + b.x * w2, a.y * w1 + b.y * w2, a.z * w1 + b.z * w2).multiplyScalar(r))
  }
  return pts
}

function rasterizeTriangle(
  pu0: number, pv0: number,
  pu1: number, pv1: number,
  pu2: number, pv2: number,
  mask: Uint8Array, grid: number, step: number,
): void {
  // world → grid-cell coords
  const tg = (p: number) => (p + GRID_R) / step
  const u0 = tg(pu0), v0 = tg(pv0)
  const u1 = tg(pu1), v1 = tg(pv1)
  const u2 = tg(pu2), v2 = tg(pv2)

  const minU = Math.max(0, Math.floor(Math.min(u0, u1, u2)))
  const maxU = Math.min(grid - 1, Math.floor(Math.max(u0, u1, u2)))
  const minV = Math.max(0, Math.floor(Math.min(v0, v1, v2)))
  const maxV = Math.min(grid - 1, Math.floor(Math.max(v0, v1, v2)))

  for (let ui = minU; ui <= maxU; ui++) {
    for (let vi = minV; vi <= maxV; vi++) {
      const cu = ui + 0.5, cv = vi + 0.5
      const d1 = (u1-u0)*(cv-v0) - (v1-v0)*(cu-u0)
      const d2 = (u2-u1)*(cv-v1) - (v2-v1)*(cu-u1)
      const d3 = (u0-u2)*(cv-v2) - (v0-v2)*(cu-u2)
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)))
        mask[ui * grid + vi] = 1
    }
  }
}

// ── Visual-hull data ──────────────────────────────────────────────────────────

interface HullData {
  dirs: THREE.Vector3[]
  masks: Uint8Array[]                               // exact rasterized silhouette per direction
  axes: { u: THREE.Vector3; v: THREE.Vector3 }[]
  volumes: number[]
  finalInside: Uint8Array
  insideSnapshots: Uint8Array[]                     // inside state after each direction (step-frame)
  voxCenters: Array<[number, number, number]>
  voxGridIdx: Array<[number, number, number]>
  fullGrid: Int32Array
  grid: number
}

function computeHullData(triPositions: Float32Array, dirs: THREE.Vector3[], grid: number): HullData {
  const step = (2 * GRID_R) / grid
  const nTri = triPositions.length / 9

  const axes = dirs.map(d => projAxes(d))
  const masks: Uint8Array[] = []

  // Build voxel grid with neighbour lookup
  const fullGrid = new Int32Array(grid * grid * grid).fill(-1)
  const voxCenters: Array<[number, number, number]> = []
  const voxGridIdx: Array<[number, number, number]> = []
  for (let xi = 0; xi < grid; xi++) {
    for (let yi = 0; yi < grid; yi++) {
      for (let zi = 0; zi < grid; zi++) {
        const x = -GRID_R + (xi + 0.5) * step
        const y = -GRID_R + (yi + 0.5) * step
        const z = -GRID_R + (zi + 0.5) * step
        if (x*x + y*y + z*z <= GRID_R * GRID_R) {
          fullGrid[xi*grid*grid + yi*grid + zi] = voxCenters.length
          voxCenters.push([x, y, z])
          voxGridIdx.push([xi, yi, zi])
        }
      }
    }
  }

  const totalVox = voxCenters.length
  const inside = new Uint8Array(totalVox).fill(1)
  const volumes: number[] = []
  const insideSnapshots: Uint8Array[] = []

  for (let k = 0; k < dirs.length; k++) {
    const { u, v } = axes[k]

    // Rasterize every triangle onto a 2-D shadow mask; save for projection display
    const mask = new Uint8Array(grid * grid)
    for (let t = 0; t < nTri; t++) {
      const b = t * 9
      const pu0 = triPositions[b  ]*u.x + triPositions[b+1]*u.y + triPositions[b+2]*u.z
      const pv0 = triPositions[b  ]*v.x + triPositions[b+1]*v.y + triPositions[b+2]*v.z
      const pu1 = triPositions[b+3]*u.x + triPositions[b+4]*u.y + triPositions[b+5]*u.z
      const pv1 = triPositions[b+3]*v.x + triPositions[b+4]*v.y + triPositions[b+5]*v.z
      const pu2 = triPositions[b+6]*u.x + triPositions[b+7]*u.y + triPositions[b+8]*u.z
      const pv2 = triPositions[b+6]*v.x + triPositions[b+7]*v.y + triPositions[b+8]*v.z
      rasterizeTriangle(pu0, pv0, pu1, pv1, pu2, pv2, mask, grid, step)
    }
    masks.push(mask)

    // Carve voxels whose 2-D projection falls outside the mask
    for (let vi = 0; vi < totalVox; vi++) {
      if (!inside[vi]) continue
      const [x, y, z] = voxCenters[vi]
      const pu = x*u.x + y*u.y + z*u.z
      const pv = x*v.x + y*v.y + z*v.z
      const ui = Math.floor((pu + GRID_R) / step)
      const vj = Math.floor((pv + GRID_R) / step)
      if (ui < 0 || ui >= grid || vj < 0 || vj >= grid || !mask[ui * grid + vj])
        inside[vi] = 0
    }

    let count = 0
    for (let vi = 0; vi < totalVox; vi++) count += inside[vi]
    volumes.push((count / totalVox) * 100)
    insideSnapshots.push(inside.slice()) // snapshot after this direction
  }

  return { dirs, masks, axes, volumes, finalInside: inside, insideSnapshots, voxCenters, voxGridIdx, fullGrid, grid }
}

// ── Hull surface mesh (exposed voxel faces) ───────────────────────────────────

const FACE_DEFS = [
  { g: [1,0,0] as const, n: [1,0,0] as const, s: [[1,1,1],[1,-1,1],[1,-1,-1],[1,1,-1]] as const },
  { g: [-1,0,0] as const, n: [-1,0,0] as const, s: [[-1,1,-1],[-1,-1,-1],[-1,-1,1],[-1,1,1]] as const },
  { g: [0,1,0] as const, n: [0,1,0] as const, s: [[1,1,-1],[-1,1,-1],[-1,1,1],[1,1,1]] as const },
  { g: [0,-1,0] as const, n: [0,-1,0] as const, s: [[1,-1,1],[-1,-1,1],[-1,-1,-1],[1,-1,-1]] as const },
  { g: [0,0,1] as const, n: [0,0,1] as const, s: [[-1,1,1],[1,1,1],[1,-1,1],[-1,-1,1]] as const },
  { g: [0,0,-1] as const, n: [0,0,-1] as const, s: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]] as const },
]

function buildHullSurface(data: HullData, insideOverride?: Uint8Array): THREE.BufferGeometry {
  const inside = insideOverride ?? data.finalInside
  const { voxCenters, voxGridIdx, fullGrid, grid } = data
  const h = (2 * GRID_R) / grid / 2
  const verts: number[] = [], norms: number[] = []

  for (let vi = 0; vi < voxCenters.length; vi++) {
    if (!inside[vi]) continue
    const [cx, cy, cz] = voxCenters[vi]
    const [xi, yi, zi] = voxGridIdx[vi]
    for (const { g, n, s } of FACE_DEFS) {
      const nxi = xi+g[0], nyi = yi+g[1], nzi = zi+g[2]
      let nbIn = false
      if (nxi >= 0 && nxi < grid && nyi >= 0 && nyi < grid && nzi >= 0 && nzi < grid) {
        const nvi = fullGrid[nxi*grid*grid + nyi*grid + nzi]
        if (nvi !== -1 && inside[nvi]) nbIn = true
      }
      if (nbIn) continue
      const q = s.map(([qx, qy, qz]) => [cx+qx*h, cy+qy*h, cz+qz*h])
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
interface Preset { bg: number; objColor: number; objEmissive: number; hullColor: number; hullEmissive: number; hullOpacity: number; edgeColor: number; projColor: number; sphereRefColor: number }

const PRESETS: Record<PresetKey, Preset> = {
  dark:      { bg: 0x0a0a14, objColor: 0xd4860a, objEmissive: 0x221100, hullColor: 0x00e5aa, hullEmissive: 0x003322, hullOpacity: 0.55, edgeColor: 0x4499ff, projColor: 0x1155cc, sphereRefColor: 0x1a1a33 },
  blueprint: { bg: 0x0a0f32, objColor: 0x5588ff, objEmissive: 0x001144, hullColor: 0x00ffcc, hullEmissive: 0x00332a, hullOpacity: 0.45, edgeColor: 0x88bbff, projColor: 0x2244cc, sphereRefColor: 0x0d1c4a },
  light:     { bg: 0xf0f2f5, objColor: 0x3366aa, objEmissive: 0x001133, hullColor: 0x009977, hullEmissive: 0x002211, hullOpacity: 0.45, edgeColor: 0x224488, projColor: 0x2244aa, sphereRefColor: 0xcccccc },
  drawing:   { bg: 0xf5f5f0, objColor: 0x555555, objEmissive: 0x111111, hullColor: 0x224444, hullEmissive: 0x000000, hullOpacity: 0.40, edgeColor: 0x111111, projColor: 0x334444, sphereRefColor: 0xbbbbaa },
  xray:      { bg: 0x000000, objColor: 0x004422, objEmissive: 0x002211, hullColor: 0x00ff88, hullEmissive: 0x005533, hullOpacity: 0.35, edgeColor: 0x00ff88, projColor: 0x003322, sphereRefColor: 0x111111 },
  black:     { bg: 0x000000, objColor: 0xcc8800, objEmissive: 0x221100, hullColor: 0x00cc99, hullEmissive: 0x002211, hullOpacity: 0.50, edgeColor: 0x00aaff, projColor: 0x113355, sphereRefColor: 0x111111 },
}
const PRESET_LABELS: Record<PresetKey, string> = { dark: 'Dark', blueprint: 'Blueprint', light: 'Light', drawing: 'Drawing', xray: 'X-Ray', black: 'Black' }

// ── Scene helpers ─────────────────────────────────────────────────────────────

function disposeObj(obj: THREE.Object3D) {
  if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose()
  const mat = (obj as THREE.Mesh).material
  if (mat) {
    const mats = Array.isArray(mat) ? mat : [mat as THREE.Material]
    mats.forEach(m => { if ((m as THREE.MeshBasicMaterial).map) (m as THREE.MeshBasicMaterial).map!.dispose(); m.dispose() })
  }
}
function clearGroup(g: THREE.Group) {
  while (g.children.length > 0) { const c = g.children[0]; g.remove(c); disposeObj(c) }
}

function buildProjectionMesh(
  mask: Uint8Array, grid: number,
  dir: THREE.Vector3, axes: { u: THREE.Vector3; v: THREE.Vector3 },
  dist: number, opacity: number, projColor: number,
): THREE.Group {
  const group = new THREE.Group()
  const pos = dir.clone().multiplyScalar(dist)
  const { u, v } = axes
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, dir))

  // Build RGBA DataTexture from exact rasterized mask
  // mask[ui * grid + vj]: ui = horizontal (u-axis), vj = vertical (v-axis)
  // DataTexture: index (vj * grid + ui) * 4 — row-major, y=0 at bottom
  const col = new THREE.Color(projColor)
  const r = Math.round(col.r * 255), g = Math.round(col.g * 255), b = Math.round(col.b * 255)
  const a = Math.round(opacity * 255)
  const texData = new Uint8Array(grid * grid * 4)
  for (let vj = 0; vj < grid; vj++) {
    for (let ui = 0; ui < grid; ui++) {
      if (mask[ui * grid + vj]) {
        const idx = (vj * grid + ui) * 4
        texData[idx] = r; texData[idx+1] = g; texData[idx+2] = b; texData[idx+3] = a
      }
    }
  }
  const tex = new THREE.DataTexture(texData, grid, grid)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * GRID_R, 2 * GRID_R),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  )
  plane.position.copy(pos); plane.quaternion.copy(quat)
  group.add(plane)

  // Axis line from origin to plane centre
  const axisGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), pos])
  group.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: new THREE.Color(projColor).multiplyScalar(0.6), transparent: true, opacity: 0.4 })))
  return group
}

// ── Component ─────────────────────────────────────────────────────────────────

type ObjType = 'torusknot' | 'box' | 'torus' | 'teapot' | 'star' | 'icosahedron' | 'cylinder' | 'cone' | 'duck'

const OBJ_LABELS: Record<ObjType, string> = {
  torusknot: 'Knot', box: 'Box', torus: 'Torus', teapot: 'Teapot',
  star: 'Star', icosahedron: 'Ico', cylinder: 'Cylinder', cone: 'Cone', duck: '🦆 Duck',
}

// Build wireframe overlay using LineMaterial (true pixel-width lines)
function makeWireMesh(geo: THREE.BufferGeometry, color: string, width: number): LineSegments2 {
  const wGeo = new THREE.WireframeGeometry(geo)
  const lsGeo = new LineSegmentsGeometry()
  lsGeo.setPositions(wGeo.attributes.position.array as Float32Array)
  wGeo.dispose()
  const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity: 0.55 })
  const ls = new LineSegments2(lsGeo, mat)
  ls.name = 'obj-wire'
  return ls
}

function makeWireFromTriPos(triPos: Float32Array, color: string, width: number): LineSegments2 {
  const tmpGeo = new THREE.BufferGeometry()
  tmpGeo.setAttribute('position', new THREE.Float32BufferAttribute(triPos, 3))
  const ls = makeWireMesh(tmpGeo, color, width)
  tmpGeo.dispose()
  return ls
}

function buildStarShape(outerR: number, innerR: number, n: number): THREE.Shape {
  const shape = new THREE.Shape()
  for (let i = 0; i < n * 2; i++) {
    const angle = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2
    const r = i % 2 === 0 ? outerR : innerR
    const x = Math.cos(angle) * r, y = Math.sin(angle) * r
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)
  }
  shape.closePath()
  return shape
}
type StopMode = 'delta' | 'all'
interface FileItem { name: string; url: string; fileType: 'json' | 'gltf' }
interface SceneRefs {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera
  controls: OrbitControls; rafId: number
  objectGroup: THREE.Group; dirSpheresGroup: THREE.Group
  projectionsGroup: THREE.Group; hullMeshGroup: THREE.Group
  refSphere: THREE.LineSegments
}

export default function VisualHull() {
  const mountRef    = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sceneRef    = useRef<SceneRefs | null>(null)
  const hullDataRef = useRef<HullData | null>(null)
  const highlightRef = useRef<THREE.Mesh | null>(null)
  const triPosRef   = useRef<Float32Array | null>(null)   // normalised triangle soup

  const [objType, setObjType]   = useState<ObjType>('torusknot')
  const [nDirs, setNDirs]       = useState(16)
  const [gridSize, setGridSize] = useState(32)
  const [stopMode, setStopMode] = useState<StopMode>('delta')
  const [deltaThreshold, setDeltaThreshold] = useState(0.5)
  const [stepDelay, setStepDelay] = useState(500)
  const [projOpacity, setProjOpacity] = useState(0.35)

  const [isPlaying, setIsPlaying]     = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [volumes, setVolumes]         = useState<number[]>([])
  const [stopped, setStopped]         = useState(false)
  const [showHull, setShowHull]       = useState(false)

  const [preset, setPreset]               = useState<PresetKey>('dark')
  const [showBody, setShowBody]           = useState(true)
  const [showEdges, setShowEdges]         = useState(false)
  const [showDirSpheres, setShowDirSpheres] = useState(true)
  const [showProjections, setShowProjections] = useState(true)
  const [showRefSphere, setShowRefSphere]   = useState(true)
  const [showWire, setShowWire]             = useState(false)
  const [showSidebar, setShowSidebar]       = useState(true)
  const [showShortcuts, setShowShortcuts]   = useState(false)
  const [showParams, setShowParams]         = useState(true)
  const [showViewOpts, setShowViewOpts]     = useState(false)
  const [wireColor, setWireColor]           = useState('#aaaaaa')
  const [wireWidth, setWireWidth]           = useState(0.8)

  const [supaFiles, setSupaFiles]   = useState<FileItem[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingFile, setLoadingFile]   = useState(false)
  const [fileLabel, setFileLabel]       = useState<string | null>(null)
  const [showPicker, setShowPicker]     = useState(false)

  // ── Scene init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(PRESETS.dark.bg, 1)
    mount.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 50)
    camera.position.set(0, 1.5, 4.5)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = 0.05
    controls.autoRotate = true; controls.autoRotateSpeed = 0.5
    const refSphere = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.SphereGeometry(1.5, 24, 12)),
      new THREE.LineBasicMaterial({ color: PRESETS.dark.sphereRefColor, transparent: true, opacity: 0.3 })
    )
    scene.add(refSphere)
    scene.add(new THREE.AmbientLight(0x7788aa, 0.9))
    const dl = new THREE.DirectionalLight(0xaabbdd, 2.0); dl.position.set(3, 4, 3); scene.add(dl)
    const dl2 = new THREE.DirectionalLight(0x334466, 0.8); dl2.position.set(-2, -1, -3); scene.add(dl2)
    const objectGroup = new THREE.Group(), dirSpheresGroup = new THREE.Group()
    const projectionsGroup = new THREE.Group(), hullMeshGroup = new THREE.Group()
    scene.add(objectGroup, dirSpheresGroup, projectionsGroup, hullMeshGroup)
    const resize = () => { const w = mount.clientWidth, h = mount.clientHeight; if (!w || !h) return; camera.aspect = w/h; camera.updateProjectionMatrix(); renderer.setSize(w, h) }
    resize(); const ro = new ResizeObserver(resize); ro.observe(mount)
    let rafId = 0
    const animate = () => {
      rafId = requestAnimationFrame(animate); controls.update()
      // Keep LineMaterial resolution in sync for correct pixel-width wire lines
      const w = mount.clientWidth || 1, h = mount.clientHeight || 1
      objectGroup.traverse(c => { if (c.name === 'obj-wire' && (c as LineSegments2).isLineSegments2) (c as LineSegments2).material.resolution.set(w, h) })
      renderer.render(scene, camera)
    }
    animate()
    sceneRef.current = { renderer, scene, camera, controls, rafId, objectGroup, dirSpheresGroup, projectionsGroup, hullMeshGroup, refSphere }
    return () => { cancelAnimationFrame(rafId); ro.disconnect(); controls.dispose(); renderer.dispose(); if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement); sceneRef.current = null }
  }, [])

  // ── Apply preset ───────────────────────────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    const p = PRESETS[preset]
    s.renderer.setClearColor(p.bg, 1)
    ;(s.refSphere.material as THREE.LineBasicMaterial).color.setHex(p.sphereRefColor)
    s.objectGroup.traverse(child => {
      if (child.name === 'obj-mesh' && (child as THREE.Mesh).isMesh) { const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial; mat.color.setHex(p.objColor); mat.emissive.setHex(p.objEmissive) }
      if (child.name === 'obj-edges') (child as THREE.LineSegments).material = new THREE.LineBasicMaterial({ color: p.edgeColor, transparent: true, opacity: 0.4 })
    })
    s.hullMeshGroup.traverse(child => {
      if ((child as THREE.Mesh).isMesh) { const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial; mat.color.setHex(p.hullColor); mat.emissive.setHex(p.hullEmissive); mat.opacity = p.hullOpacity }
    })
  }, [preset])

  // ── Hull mesh rebuild ──────────────────────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.hullMeshGroup)
    if (!showHull || !hullDataRef.current) return
    const p = PRESETS[preset]
    const geo = buildHullSurface(hullDataRef.current)
    s.hullMeshGroup.add(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: p.hullColor, emissive: p.hullEmissive, shininess: 50, transparent: true, opacity: p.hullOpacity, side: THREE.DoubleSide })))
    s.hullMeshGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), new THREE.LineBasicMaterial({ color: p.hullColor, transparent: true, opacity: 0.2 })))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHull])

  // ── View toggles ───────────────────────────────────────────────────────────
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.objectGroup.traverse(c => { if (c.name === 'obj-mesh') c.visible = showBody }) }, [showBody])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.objectGroup.traverse(c => { if (c.name === 'obj-edges') c.visible = showEdges }) }, [showEdges])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.dirSpheresGroup.visible = showDirSpheres }, [showDirSpheres])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.projectionsGroup.visible = showProjections }, [showProjections])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.refSphere.visible = showRefSphere }, [showRefSphere])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.objectGroup.traverse(c => { if (c.name === 'obj-wire') c.visible = showWire }) }, [showWire])
  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    s.objectGroup.traverse(c => {
      if (c.name === 'obj-wire' && (c as LineSegments2).isLineSegments2) {
        const mat = (c as LineSegments2).material as LineMaterial
        mat.color.set(wireColor); mat.linewidth = wireWidth
      }
    })
  }, [wireColor, wireWidth])

  // ── Direction spheres + geodesic arcs + hull computation ─────────────────
  const setupDirsAndHull = useCallback((triPos: Float32Array, grid: number, n: number) => {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.dirSpheresGroup)
    const dirs = makeFibDirs(n)
    const R = 1.55 // radius of direction sphere markers

    // Coloured point markers (full rainbow)
    dirs.forEach((d, i) => {
      const t = i / Math.max(n - 1, 1)
      const col = rainbow(t)
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 8, 6),
        new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: 0.35 })
      )
      sphere.position.copy(d.clone().multiplyScalar(R))
      sphere.userData.origColor = col.clone()
      s.dirSpheresGroup.add(sphere)
    })

    // Geodesic arcs along sphere surface connecting consecutive directions
    if (dirs.length >= 2) {
      const ARC_SEG = 14
      const allPts: THREE.Vector3[] = []
      const allCols: number[] = []
      for (let i = 0; i < dirs.length - 1; i++) {
        const t1 = i / (dirs.length - 1), t2 = (i + 1) / (dirs.length - 1)
        const col1 = rainbow(t1), col2 = rainbow(t2)
        const arc = geodesicArc(dirs[i].clone().normalize(), dirs[i + 1].clone().normalize(), ARC_SEG, R * 0.98)
        arc.slice(i === 0 ? 0 : 1).forEach((pt, j) => {
          const tArc = (j + (i === 0 ? 0 : 1)) / ARC_SEG
          const col = col1.clone().lerp(col2, tArc)
          allPts.push(pt.clone())
          allCols.push(col.r, col.g, col.b)
        })
      }
      const geo = new THREE.BufferGeometry().setFromPoints(allPts)
      geo.setAttribute('color', new THREE.Float32BufferAttribute(allCols, 3))
      const arc = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }))
      arc.name = 'dir-arcs'
      s.dirSpheresGroup.add(arc)
    }

    s.dirSpheresGroup.visible = showDirSpheres
    hullDataRef.current = computeHullData(triPos, dirs, grid)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Add mesh to scene ──────────────────────────────────────────────────────
  const addMeshToScene = useCallback((geo: THREE.BufferGeometry) => {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.objectGroup)
    const p = PRESETS[preset]
    if (!geo.attributes.normal) geo.computeVertexNormals()
    const mesh = Object.assign(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: p.objColor, emissive: p.objEmissive, shininess: 80, transparent: true, opacity: 0.88 })), { name: 'obj-mesh' })
    mesh.visible = showBody
    const edges = Object.assign(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: p.edgeColor, transparent: true, opacity: 0.4 })), { name: 'obj-edges' })
    edges.visible = showEdges
    const wire = makeWireMesh(geo, wireColor, wireWidth)
    wire.visible = showWire
    s.objectGroup.add(mesh, edges, wire)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, showBody, showEdges, showWire, wireColor, wireWidth])

  // ── Built-in object ────────────────────────────────────────────────────────
  const buildBuiltIn = useCallback((type: ObjType, grid: number, n: number) => {
    // Duck is a GLB loaded asynchronously from /Duck.glb (public/)
    if (type === 'duck') {
      const s = sceneRef.current; if (!s) return
      setLoadingFile(true)
      clearGroup(s.objectGroup); clearGroup(s.dirSpheresGroup)
      clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
      highlightRef.current = null
      new GLTFLoader().load('/Duck.glb',
        (gltf) => {
          const sc2 = sceneRef.current; if (!sc2) { setLoadingFile(false); return }
          // Extract verts + triangle soup inline (no processGltfScene dependency)
          const allVerts: number[] = [], allTriPos: number[] = []
          gltf.scene.updateMatrixWorld(true)
          gltf.scene.traverse(child => {
            if (!(child as THREE.Mesh).isMesh) return
            const mesh = child as THREE.Mesh
            const posAttr = mesh.geometry.attributes.position
            const index = mesh.geometry.index
            for (let i = 0; i < posAttr.count; i++) {
              const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld)
              allVerts.push(v.x, v.y, v.z)
            }
            const cnt = index ? index.count : posAttr.count
            for (let i = 0; i < cnt; i++) {
              const vi = index ? index.getX(i) : i
              const v = new THREE.Vector3().fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.matrixWorld)
              allTriPos.push(v.x, v.y, v.z)
            }
          })
          const norm = computeNorm(new Float32Array(allVerts))
          const triPos = applyNorm(new Float32Array(allTriPos), norm)
          triPosRef.current = triPos
          gltf.scene.scale.setScalar(norm.sc)
          gltf.scene.position.set(-norm.cx*norm.sc, -norm.cy*norm.sc, -norm.cz*norm.sc)
          gltf.scene.traverse(child => {
            if ((child as THREE.Mesh).isMesh) {
              const m = child as THREE.Mesh
              m.name = 'obj-mesh'; m.visible = showBody
              m.material = new THREE.MeshPhongMaterial({ color: 0xf5c518, emissive: 0x221100, shininess: 90, transparent: true, opacity: 0.92 })
            }
          })
          const duckWire = makeWireFromTriPos(triPos, wireColor, wireWidth)
          duckWire.visible = showWire
          sc2.objectGroup.add(gltf.scene, duckWire)
          setupDirsAndHull(triPos, grid, n)
          setLoadingFile(false)
        },
        undefined,
        (err) => { console.error('Duck load error', err); setLoadingFile(false) }
      )
      return
    }

    let geo: THREE.BufferGeometry
    if (type === 'torusknot')   geo = new THREE.TorusKnotGeometry(0.7, 0.18, 120, 16)
    else if (type === 'torus')  geo = new THREE.TorusGeometry(0.65, 0.28, 48, 96)
    else if (type === 'teapot') geo = new TeapotGeometry(0.8, 12)
    else if (type === 'star')   geo = new THREE.ExtrudeGeometry(buildStarShape(0.85, 0.38, 5), { depth: 0.55, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 3 })
    else if (type === 'icosahedron') geo = new THREE.IcosahedronGeometry(0.9, 2)
    else if (type === 'cylinder') geo = new THREE.CylinderGeometry(0.45, 0.7, 1.4, 6, 1)
    else if (type === 'cone')   geo = new THREE.ConeGeometry(0.75, 1.5, 5, 1)
    else                        geo = new THREE.BoxGeometry(1.2, 1.2, 1.2)

    geo.computeBoundingSphere()
    const bs = geo.boundingSphere!
    const sc = 1.35 / bs.radius
    geo.scale(sc, sc, sc)
    const off = bs.center.clone().multiplyScalar(-sc)
    geo.translate(off.x, off.y, off.z)

    const triPos = extractTriSoup(geo)
    triPosRef.current = triPos

    addMeshToScene(geo)
    setupDirsAndHull(triPos, grid, n)
  }, [addMeshToScene, setupDirsAndHull, showBody])

  useEffect(() => {
    if (fileLabel) return
    const s = sceneRef.current; if (!s) return
    clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
    highlightRef.current = null
    buildBuiltIn(objType, gridSize, nDirs)
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objType, nDirs, gridSize])

  useEffect(() => {
    if (!fileLabel || !triPosRef.current) return
    const s = sceneRef.current; if (!s) return
    clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
    highlightRef.current = null
    setupDirsAndHull(triPosRef.current, gridSize, nDirs)
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nDirs, gridSize])

  // ── Animation ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying || stopped) return
    const data = hullDataRef.current
    if (!data || currentStep >= data.dirs.length) { setIsPlaying(false); if (data && currentStep >= data.dirs.length) setShowHull(true); return }
    const timer = setTimeout(() => {
      const s = sceneRef.current; if (!s || !hullDataRef.current) return
      const d = hullDataRef.current, step = currentStep
      if (highlightRef.current) { const m = highlightRef.current.material as THREE.MeshPhongMaterial; m.emissiveIntensity = 0.35; const orig = highlightRef.current.userData.origColor as THREE.Color; if (orig) { m.color.copy(orig); m.emissive.copy(orig) } }
      const dirSphere = s.dirSpheresGroup.children[step] as THREE.Mesh
      if (dirSphere) { const m = dirSphere.material as THREE.MeshPhongMaterial; m.color.set(0xffffff); m.emissive.set(0xffaa00); m.emissiveIntensity = 1.0; highlightRef.current = dirSphere }
      s.projectionsGroup.add(buildProjectionMesh(d.masks[step], d.grid, d.dirs[step], d.axes[step], 1.75, projOpacity, PRESETS[preset].projColor))
      const vol = d.volumes[step], prevVol = step > 0 ? d.volumes[step - 1] : 100, delta = prevVol - vol
      setVolumes(prev => [...prev, vol])

      // Rebuild hull from snapshot after this step
      clearGroup(s.hullMeshGroup)
      const p = PRESETS[preset]
      const snapGeo = buildHullSurface(d, d.insideSnapshots[step])
      s.hullMeshGroup.add(new THREE.Mesh(snapGeo, new THREE.MeshPhongMaterial({ color: p.hullColor, emissive: p.hullEmissive, shininess: 50, transparent: true, opacity: p.hullOpacity, side: THREE.DoubleSide })))
      s.hullMeshGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(snapGeo, 15), new THREE.LineBasicMaterial({ color: p.hullColor, transparent: true, opacity: 0.2 })))

      const isLast = step === d.dirs.length - 1
      const deltaStop = stopMode === 'delta' && delta < deltaThreshold && step > 0
      if (isLast || deltaStop) { setStopped(deltaStop && !isLast); setIsPlaying(false); setShowHull(true) }
      else setCurrentStep(step + 1)
    }, stepDelay)
    return () => clearTimeout(timer)
  }, [isPlaying, currentStep, stepDelay, deltaThreshold, projOpacity, stopped, stopMode, preset])

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    const s = sceneRef.current
    if (s) { clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup) }
    highlightRef.current = null
    if (s) s.dirSpheresGroup.children.forEach(c => {
      if (c.name === 'dir-arcs') return
      const mesh = c as THREE.Mesh; if (!mesh.isMesh) return
      const mat = mesh.material as THREE.MeshPhongMaterial
      const orig = mesh.userData.origColor as THREE.Color
      if (orig) { mat.color.copy(orig); mat.emissive.copy(orig); mat.emissiveIntensity = 0.35 }
    })
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  }, [nDirs])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const OBJS: ObjType[] = ['torusknot','box','torus','teapot','star','icosahedron','cylinder','cone','duck']
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      switch (e.key) {
        case ' ':    e.preventDefault(); setStopped(false); setIsPlaying(v => !v); break
        case 'r': case 'R': handleReset(); break
        case 'h': case 'H': setShowHull(v => !v); break
        case 'b': case 'B': setShowBody(v => !v); break
        case 'e': case 'E': setShowEdges(v => !v); break
        case 'w': case 'W': setShowWire(v => !v); break
        case 'd': case 'D': setShowDirSpheres(v => !v); break
        case 'p': case 'P': setShowProjections(v => !v); break
        case 's': case 'S': setShowRefSphere(v => !v); break
        case 'i': case 'I': setShowSidebar(v => !v); break
        case '?':           setShowShortcuts(v => !v); break
        default:
          if (e.key >= '1' && e.key <= '9') {
            const t = OBJS[+e.key - 1]
            if (t) { setFileLabel(null); setObjType(t) }
          }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleReset])


  // ── Shared GLB extraction ─────────────────────────────────────────────────
  const processGltfScene = useCallback((gltf: { scene: THREE.Group }): { triPos: Float32Array; norm: NormParams } => {
    const allVerts: number[] = [], allTriPos: number[] = []
    gltf.scene.updateMatrixWorld(true)
    gltf.scene.traverse(child => {
      if (!(child as THREE.Mesh).isMesh) return
      const mesh = child as THREE.Mesh
      const posAttr = mesh.geometry.attributes.position
      const index = mesh.geometry.index
      for (let i = 0; i < posAttr.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld)
        allVerts.push(v.x, v.y, v.z)
      }
      const count = index ? index.count : posAttr.count
      for (let i = 0; i < count; i++) {
        const vi = index ? index.getX(i) : i
        const v = new THREE.Vector3().fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.matrixWorld)
        allTriPos.push(v.x, v.y, v.z)
      }
    })
    const norm = computeNorm(new Float32Array(allVerts))
    const triPos = applyNorm(new Float32Array(allTriPos), norm)
    return { triPos, norm }
  }, [])

  // ── Load local file ────────────────────────────────────────────────────────
  const loadLocalFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext !== 'json' && ext !== 'glb' && ext !== 'gltf') return
    setLoadingFile(true); handleReset()
    try {
      const s = sceneRef.current; if (!s) return
      clearGroup(s.objectGroup); clearGroup(s.dirSpheresGroup); clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
      highlightRef.current = null

      if (ext === 'json') {
        const json = JSON.parse(await file.text()) as ThreeGeometryJson
        const norm = computeNorm(new Float32Array(json.vertices))
        const rawGeo = parseGeometry(json)
        const rawTriPos = rawGeo.attributes.position.array as Float32Array
        const triPos = applyNorm(rawTriPos, norm)
        const dispGeo = new THREE.BufferGeometry()
        dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(triPos, 3))
        triPosRef.current = triPos
        addMeshToScene(dispGeo)
      } else {
        const objectUrl = URL.createObjectURL(file)
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
          new GLTFLoader().load(objectUrl, resolve, undefined, reject)
        )
        URL.revokeObjectURL(objectUrl)
        const { triPos, norm } = processGltfScene(gltf)
        triPosRef.current = triPos
        gltf.scene.scale.setScalar(norm.sc)
        gltf.scene.position.set(-norm.cx*norm.sc, -norm.cy*norm.sc, -norm.cz*norm.sc)
        clearGroup(s.objectGroup)
        const p = PRESETS[preset]
        gltf.scene.traverse(child => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh
            m.name = 'obj-mesh'; m.visible = showBody
            m.material = new THREE.MeshPhongMaterial({ color: p.objColor, emissive: p.objEmissive, shininess: 70, transparent: true, opacity: 0.88 })
          }
        })
        const wl1 = makeWireFromTriPos(triPosRef.current!, wireColor, wireWidth)
        wl1.visible = showWire; s.objectGroup.add(gltf.scene, wl1)
      }

      setupDirsAndHull(triPosRef.current!, gridSize, nDirs)
      setFileLabel(file.name)
      setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
    } catch (err) { console.error('Load error', err) }
    finally { setLoadingFile(false) }
  }, [handleReset, addMeshToScene, processGltfScene, setupDirsAndHull, gridSize, nDirs, preset, showBody])

  // ── Supabase picker ────────────────────────────────────────────────────────
  const fetchFileList = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const res = await fetch('/api/files'); if (!res.ok) throw new Error()
      const data: { name: string; url: string; type: string }[] = await res.json()
      setSupaFiles(data.filter(f => f.type === 'json' || f.type === 'gltf').map(f => ({ name: f.name, url: f.url, fileType: f.type as 'json' | 'gltf' })))
    } catch { setSupaFiles([]) } finally { setLoadingFiles(false) }
  }, [])

  const loadSupaFile = useCallback(async (url: string, label: string, fileType: 'json' | 'gltf') => {
    setLoadingFile(true); setShowPicker(false); handleReset()
    try {
      const s = sceneRef.current; if (!s) return
      clearGroup(s.objectGroup); clearGroup(s.dirSpheresGroup); clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
      highlightRef.current = null

      if (fileType === 'json') {
        const json = await (await fetch(url)).json() as ThreeGeometryJson
        const norm = computeNorm(new Float32Array(json.vertices))
        const rawGeo = parseGeometry(json)
        const triPos = applyNorm(rawGeo.attributes.position.array as Float32Array, norm)
        const dispGeo = new THREE.BufferGeometry()
        dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(triPos, 3))
        triPosRef.current = triPos
        addMeshToScene(dispGeo)
      } else {
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
          new GLTFLoader().load(url, resolve, undefined, reject)
        )
        const { triPos, norm } = processGltfScene(gltf)
        triPosRef.current = triPos
        gltf.scene.scale.setScalar(norm.sc)
        gltf.scene.position.set(-norm.cx*norm.sc, -norm.cy*norm.sc, -norm.cz*norm.sc)
        clearGroup(s.objectGroup)
        const p = PRESETS[preset]
        gltf.scene.traverse(child => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh
            m.name = 'obj-mesh'; m.visible = showBody
            m.material = new THREE.MeshPhongMaterial({ color: p.objColor, emissive: p.objEmissive, shininess: 70, transparent: true, opacity: 0.88 })
          }
        })
        const wl2 = makeWireFromTriPos(triPosRef.current!, wireColor, wireWidth)
        wl2.visible = showWire; s.objectGroup.add(gltf.scene, wl2)
      }

      setupDirsAndHull(triPosRef.current!, gridSize, nDirs)
      setFileLabel(label)
      setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
    } catch (err) { console.error('Load error', err) }
    finally { setLoadingFile(false) }
  }, [handleReset, addMeshToScene, processGltfScene, setupDirsAndHull, gridSize, nDirs, preset, showBody])

  // ── Derived ────────────────────────────────────────────────────────────────
  const latestVol  = volumes.length > 0 ? volumes[volumes.length - 1] : 100
  const prevVol    = volumes.length > 1 ? volumes[volumes.length - 2] : 100
  const delta      = prevVol - latestVol
  const totalSteps = hullDataRef.current?.dirs.length ?? nDirs
  const animDone   = (currentStep >= totalSteps && volumes.length > 0) || stopped
  const voxelSize  = ((2 * GRID_R) / gridSize).toFixed(3)
  const btnToggle  = (active: boolean) => `px-2 py-0.5 rounded border text-xs transition-colors ${active ? 'border-sky-500 text-sky-300 bg-sky-900/30' : 'border-gray-600 text-gray-400 hover:border-gray-400'}`

  // ── Shared button class helpers ────────────────────────────────────────────
  const btn = (active: boolean, col = 'sky') => `px-3 py-1.5 rounded border text-xs font-medium transition-colors ${
    active
      ? col === 'teal'   ? 'border-teal-500 text-teal-300 bg-teal-900/30'
      : col === 'orange' ? 'border-orange-500 text-orange-300 bg-orange-900/30'
      : col === 'green'  ? 'border-emerald-600 text-emerald-300 bg-emerald-900/20'
      :                    'border-sky-500 text-sky-300 bg-sky-900/30'
      : 'border-gray-700 text-gray-400 hover:border-gray-400 hover:text-gray-200'
  }`
  const WIRE_PRESETS = ['#ffffff','#aaaaaa','#ffcc00','#00e5ff','#ff6644','#88ff44']

  return (
    <div className="h-full flex flex-col">

      {/* ── Row 1: Primary controls ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-950 border-b border-gray-800 text-xs flex-wrap">

        {/* Object selector */}
        <select
          value={fileLabel ? '__file__' : objType}
          disabled={loadingFile}
          onChange={e => { if (e.target.value !== '__file__') { setFileLabel(null); setObjType(e.target.value as ObjType) } }}
          className="bg-gray-900 border border-gray-600 text-gray-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-gray-400 disabled:opacity-50"
        >
          {(Object.keys(OBJ_LABELS) as ObjType[]).map(t => <option key={t} value={t}>{OBJ_LABELS[t]}</option>)}
          {fileLabel && <option value="__file__">📄 {fileLabel.replace(/^\d+_/, '').slice(0, 20)}</option>}
        </select>

        {/* File open */}
        <input ref={fileInputRef} type="file" accept=".json,.glb,.gltf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) loadLocalFile(f); e.target.value = '' }} />
        <button onClick={() => fileInputRef.current?.click()} disabled={loadingFile} title="Open local file"
          className="px-3 py-1.5 rounded border border-gray-700 text-gray-300 hover:border-gray-400 transition-colors disabled:opacity-40 text-xs">
          📂 Open
        </button>

        {/* Supabase picker */}
        <div className="relative">
          <button onClick={() => { setShowPicker(v => !v); if (!supaFiles.length && !loadingFiles) fetchFileList() }}
            className={`px-3 py-1.5 rounded border text-xs transition-colors ${fileLabel ? 'border-cyan-600 text-cyan-300 bg-cyan-900/20' : 'border-gray-700 text-gray-400 hover:border-gray-400'}`}>
            {loadingFile ? '…' : '☁ Cloud'}
          </button>
          {showPicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-gray-900 border border-gray-700 rounded shadow-xl min-w-[220px] max-h-52 overflow-y-auto">
              {loadingFiles && <div className="px-3 py-2 text-xs text-gray-400">Loading…</div>}
              {!loadingFiles && supaFiles.length === 0 && <div className="px-3 py-2 text-xs text-gray-500">No JSON / GLB files</div>}
              {supaFiles.map(f => (
                <button key={f.url} onClick={() => loadSupaFile(f.url, f.name, f.fileType)}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 truncate flex items-center gap-2">
                  <span className={`text-[10px] font-mono px-1 rounded ${f.fileType === 'json' ? 'bg-orange-900/40 text-orange-400' : 'bg-blue-900/40 text-blue-400'}`}>{f.fileType.toUpperCase()}</span>
                  {f.name.replace(/^\d+_/, '')}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-5 bg-gray-700 shrink-0" />

        {/* Presets */}
        <div className="flex items-center gap-1">
          {(Object.keys(PRESETS) as PresetKey[]).map(k => (
            <button key={k} onClick={() => setPreset(k)}
              className={`px-2.5 py-1.5 rounded border text-xs transition-colors ${preset === k ? 'border-white/40 text-white bg-white/10' : 'border-gray-700 text-gray-500 hover:border-gray-400 hover:text-gray-300'}`}>
              {PRESET_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-gray-700 shrink-0" />

        {/* Panel toggles */}
        <button onClick={() => setShowParams(v => !v)} title="Algorithm parameters"
          className={btn(showParams, 'sky')}>⚙ Params</button>
        <button onClick={() => setShowViewOpts(v => !v)} title="View options"
          className={btn(showViewOpts, 'sky')}>👁 View</button>

        {/* Right: actions */}
        <div className="ml-auto flex items-center gap-1.5">
          <button title="Keyboard shortcuts [?]" onClick={() => setShowShortcuts(v => !v)}
            className="w-8 h-8 flex items-center justify-center rounded border border-gray-700 text-gray-500 hover:border-gray-400 hover:text-gray-200 transition-colors">⌨</button>
          <button title="Toggle stats [I]" onClick={() => setShowSidebar(v => !v)}
            className="w-8 h-8 flex items-center justify-center rounded border border-gray-700 text-gray-500 hover:border-gray-400 hover:text-gray-200 transition-colors">▐</button>
          <button title="Hull solid [H]" onClick={() => setShowHull(v => !v)} disabled={!animDone}
            className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors disabled:opacity-30 ${showHull ? 'border-teal-500 text-teal-300 bg-teal-900/30' : 'border-gray-700 text-gray-400 hover:border-teal-600'}`}>
            ◈ Hull
          </button>
          <button title="Play / Pause [Space]" onClick={() => { setStopped(false); setIsPlaying(v => !v) }} disabled={currentStep >= totalSteps && !stopped}
            className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors disabled:opacity-40 min-w-[72px] ${isPlaying ? 'border-yellow-600 text-yellow-400 bg-yellow-900/20' : 'border-emerald-600 text-emerald-400 bg-emerald-900/20'}`}>
            {isPlaying ? '⏸ Pause' : currentStep === 0 ? '▶ Play' : '▶ Resume'}
          </button>
          <button title="Reset [R]" onClick={handleReset}
            className="w-8 h-8 flex items-center justify-center rounded border border-gray-700 text-gray-400 hover:border-gray-400 hover:text-gray-200 transition-colors text-base">↺</button>
        </div>
      </div>

      {/* ── Row 2: Algorithm params (collapsible) ───────────────────────────── */}
      {showParams && (
        <div className="flex items-center gap-x-4 gap-y-1.5 px-3 py-2 bg-gray-950/80 border-b border-gray-800/60 text-xs flex-wrap">
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500 whitespace-nowrap">Dirs</span>
            <input type="range" min={3} max={120} value={nDirs} onChange={e => setNDirs(+e.target.value)} className="w-24 accent-orange-500" />
            <span className="font-mono text-orange-300 w-6 tabular-nums">{nDirs}</span>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500 whitespace-nowrap">Voxel</span>
            <input type="range" min={12} max={128} step={4} value={gridSize} onChange={e => setGridSize(+e.target.value)} className="w-24 accent-purple-400" />
            <span className={`font-mono tabular-nums w-12 ${gridSize > 64 ? 'text-yellow-400' : 'text-purple-300'}`}>{voxelSize}{gridSize > 64 ? ' ⚠' : ''}</span>
          </label>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">Stop</span>
            <button onClick={() => setStopMode('delta')} className={btn(stopMode === 'delta')}>Δ</button>
            <button onClick={() => setStopMode('all')} className={btn(stopMode === 'all')}>All N</button>
          </div>
          {stopMode === 'delta' && (
            <label className="flex items-center gap-1.5">
              <span className="text-gray-500 whitespace-nowrap">Δ &lt;</span>
              <input type="range" min={0.01} max={5} step={0.01} value={deltaThreshold} onChange={e => setDeltaThreshold(+e.target.value)} className="w-20 accent-red-400" />
              <span className="font-mono text-red-300 tabular-nums w-12">{deltaThreshold.toFixed(2)}%</span>
            </label>
          )}
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">Speed</span>
            <input type="range" min={50} max={2000} step={50} value={stepDelay} onChange={e => setStepDelay(+e.target.value)} className="w-20 accent-gray-500" />
            <span className="font-mono text-gray-500 w-12 tabular-nums">{stepDelay}ms</span>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">Silhouette</span>
            <input type="range" min={0.05} max={0.8} step={0.05} value={projOpacity} onChange={e => setProjOpacity(+e.target.value)} className="w-16 accent-blue-400" />
            <span className="font-mono text-blue-400 w-8 tabular-nums">{projOpacity.toFixed(2)}</span>
          </label>
        </div>
      )}

      {/* ── Row 3: View options (collapsible) ───────────────────────────────── */}
      {showViewOpts && (
        <div className="flex items-center gap-x-3 gap-y-1.5 px-3 py-2 bg-gray-950/80 border-b border-gray-800/60 text-xs flex-wrap">
          <div className="flex items-center gap-1">
            <span className="text-gray-500 mr-0.5">Show</span>
            <button title="[B]" onClick={() => setShowBody(v => !v)} className={btn(showBody)}>Body</button>
            <button title="[E]" onClick={() => setShowEdges(v => !v)} className={btn(showEdges)}>Edges</button>
            <button title="[W]" onClick={() => setShowWire(v => !v)} className={btn(showWire)}>Wire</button>
            <button title="[D]" onClick={() => setShowDirSpheres(v => !v)} className={btn(showDirSpheres)}>Dirs</button>
            <button title="[P]" onClick={() => setShowProjections(v => !v)} className={btn(showProjections)}>Proj</button>
            <button title="[S]" onClick={() => setShowRefSphere(v => !v)} className={btn(showRefSphere)}>Sphere</button>
          </div>
          <div className="w-px h-4 bg-gray-700 shrink-0" />
          {/* Wireframe settings */}
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">Wire colour</span>
            {WIRE_PRESETS.map(c => (
              <button key={c} onClick={() => setWireColor(c)} title={c}
                style={{ background: c }}
                className={`w-5 h-5 rounded-full border-2 transition-colors ${wireColor === c ? 'border-white' : 'border-transparent hover:border-gray-400'}`} />
            ))}
            <input type="color" value={wireColor} onChange={e => setWireColor(e.target.value)}
              className="w-6 h-6 rounded cursor-pointer border border-gray-600 bg-transparent p-0" title="Custom colour" />
          </div>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">Width</span>
            <input type="range" min={0.3} max={4} step={0.1} value={wireWidth} onChange={e => setWireWidth(+e.target.value)} className="w-20 accent-gray-400" />
            <span className="font-mono text-gray-400 w-10 tabular-nums">{wireWidth.toFixed(1)}px</span>
          </label>
        </div>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        <div ref={mountRef} className="flex-1 min-w-0 min-h-0" />

        {/* Keyboard shortcuts overlay */}
        {showShortcuts && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 bg-gray-900/95 border border-gray-700 rounded-lg shadow-2xl p-4 text-xs text-gray-300 min-w-[260px]">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-400 font-medium uppercase tracking-wider text-[10px]">Keyboard Shortcuts</span>
              <button onClick={() => setShowShortcuts(false)} className="text-gray-600 hover:text-gray-300">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {[['Space','Play / Pause'],['R','Reset'],['H','Toggle Hull'],['B','Body'],['E','Edges'],['W','Wireframe'],['D','Dir spheres'],['P','Projections'],['S','Ref sphere'],['I','Stats panel'],['1–9','Select object']].map(([k, v]) => (
                <div key={k} className="flex items-center gap-2">
                  <kbd className="px-1.5 py-0.5 bg-gray-800 border border-gray-600 rounded text-[10px] font-mono text-gray-300 shrink-0">{k}</kbd>
                  <span className="text-gray-500">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stats sidebar */}
        {showSidebar && (
        <div className="w-44 shrink-0 border-l border-gray-800 bg-gray-950 flex flex-col gap-3 p-3 text-xs overflow-y-auto">
          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Progress</div>
            <div className="font-mono text-gray-300 text-lg tabular-nums">{currentStep} <span className="text-gray-600 text-xs">/ {totalSteps}</span></div>
            <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-orange-500 rounded-full transition-all" style={{ width: `${(currentStep / Math.max(totalSteps, 1)) * 100}%` }} />
            </div>
          </div>

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Hull Volume</div>
            <div className="font-mono text-blue-300 text-lg tabular-nums">{latestVol.toFixed(1)}<span className="text-gray-600 text-xs">%</span></div>
            <div className="text-gray-600 text-[10px]">of bounding sphere</div>
            <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, latestVol))}%` }} />
            </div>
          </div>

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Δ per step</div>
            <div className={`font-mono text-lg tabular-nums ${delta > deltaThreshold ? 'text-emerald-400' : 'text-red-400'}`}>
              {volumes.length > 1 ? `−${delta.toFixed(3)}%` : '—'}
            </div>
            {volumes.length > 1 && <div className="text-gray-600 text-[10px]">{latestVol > 0 ? `${((delta/latestVol)*100).toFixed(2)}% of hull` : ''}</div>}
            {volumes.length > 1 && stopMode === 'delta' && (
              <div className="mt-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${delta > deltaThreshold ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${Math.min(100, (delta / Math.max(0.01, deltaThreshold)) * 50)}%` }} />
              </div>
            )}
          </div>

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Grid</div>
            <div className="font-mono text-purple-300">{gridSize}³</div>
            <div className="text-gray-600 text-[10px]">voxel {voxelSize} u</div>
          </div>

          {stopped && <div className="rounded border border-red-800 bg-red-900/20 px-2 py-1.5 text-red-400 text-[11px]">Δ &lt; {deltaThreshold.toFixed(2)}% — stopped</div>}
          {currentStep >= totalSteps && !stopped && volumes.length > 0 && <div className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-gray-400 text-[11px]">All {totalSteps} directions done</div>}
          {animDone && (
            <div className={`rounded border px-2 py-1.5 text-[11px] cursor-pointer transition-colors ${showHull ? 'border-teal-700 bg-teal-900/20 text-teal-400' : 'border-gray-700 text-gray-500 hover:border-teal-700'}`}
              onClick={() => setShowHull(v => !v)}>
              {showHull ? '◈ Hull visible' : '◈ Show hull solid'}
            </div>
          )}

          {volumes.length > 1 && (
            <div>
              <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Convergence</div>
              <svg viewBox={`0 0 ${volumes.length} 40`} className="w-full h-10" preserveAspectRatio="none">
                <polyline points={volumes.map((v, i) => `${i},${40 - (v/100)*36}`).join(' ')} fill="none" stroke="#3366cc" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
