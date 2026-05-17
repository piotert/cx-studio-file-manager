'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parseGeometry, type ThreeGeometryJson } from './ThreeJsonViewer'

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

// ── Normalisation ─────────────────────────────────────────────────────────────

interface NormParams { cx: number; cy: number; cz: number; sc: number }

function computeNorm(vertices: Float32Array): NormParams {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < vertices.length; i += 3) {
    minX = Math.min(minX, vertices[i]);   maxX = Math.max(maxX, vertices[i])
    minY = Math.min(minY, vertices[i+1]); maxY = Math.max(maxY, vertices[i+1])
    minZ = Math.min(minZ, vertices[i+2]); maxZ = Math.max(maxZ, vertices[i+2])
  }
  const cx = (minX+maxX)/2, cy = (minY+maxY)/2, cz = (minZ+maxZ)/2
  let maxDist = 0
  for (let i = 0; i < vertices.length; i += 3) {
    const dx = vertices[i]-cx, dy = vertices[i+1]-cy, dz = vertices[i+2]-cz
    maxDist = Math.max(maxDist, Math.sqrt(dx*dx + dy*dy + dz*dz))
  }
  return { cx, cy, cz, sc: maxDist > 0 ? 1.35/maxDist : 1 }
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

// ── Voxel grid ─────────────────────────────────────────────────────────────────

const GRID_R = 1.5

interface VoxelGrid {
  centers: Array<[number, number, number]>
  gridIdx: Array<[number, number, number]>
  fullGrid: Int32Array
  grid: number
}

function buildVoxelGrid(grid: number): VoxelGrid {
  const step = (2 * GRID_R) / grid
  const fullGrid = new Int32Array(grid * grid * grid).fill(-1)
  const centers: Array<[number, number, number]> = []
  const gridIdx: Array<[number, number, number]> = []
  for (let xi = 0; xi < grid; xi++) {
    for (let yi = 0; yi < grid; yi++) {
      for (let zi = 0; zi < grid; zi++) {
        const x = -GRID_R + (xi + 0.5) * step
        const y = -GRID_R + (yi + 0.5) * step
        const z = -GRID_R + (zi + 0.5) * step
        if (x*x + y*y + z*z <= GRID_R * GRID_R) {
          fullGrid[xi*grid*grid + yi*grid + zi] = centers.length
          centers.push([x, y, z])
          gridIdx.push([xi, yi, zi])
        }
      }
    }
  }
  return { centers, gridIdx, fullGrid, grid }
}

// ── Space carving core ────────────────────────────────────────────────────────
//
// Each camera renders the object with a position-based shader:
//   colour = (worldPos + 1.5) / 3.0   →  maps [-1.5, 1.5] to [0, 1]
//
// For each voxel at world position p we compute its "expected" colour c_exp.
// After projecting p into camera k we read the rendered colour c_k at that pixel.
//
// Carve rules (applied for the first kCams cameras):
//   • outside  — any camera shows background (alpha=0) at that pixel
//   • interior — no camera shows a pixel whose colour is within `threshold` of c_exp
//               (every camera sees a different surface in front of this voxel)

function computeSpaceCarving(
  vg: VoxelGrid,
  dirs: THREE.Vector3[],
  axes: ReturnType<typeof projAxes>[],
  images: Uint8Array[],
  kCams: number,
  resolution: number,
  threshold: number,
): { inside: Uint8Array; volumes: number[] } {
  const { centers, grid } = vg
  const inside = new Uint8Array(centers.length).fill(1)
  const volumes: number[] = []

  for (let k = 0; k < kCams; k++) {
    const { u, v } = axes[k]
    const img = images[k]

    for (let vi = 0; vi < centers.length; vi++) {
      if (!inside[vi]) continue
      const [vx, vy, vz] = centers[vi]

      // Project voxel centre
      const pu = vx*u.x + vy*u.y + vz*u.z
      const pv = vx*v.x + vy*v.y + vz*v.z
      const px = Math.floor((pu + GRID_R) / (2 * GRID_R) * resolution)
      const py = Math.floor((pv + GRID_R) / (2 * GRID_R) * resolution)

      if (px < 0 || px >= resolution || py < 0 || py >= resolution) { inside[vi] = 0; continue }

      const idx = (py * resolution + px) * 4
      if (img[idx + 3] < 128) { inside[vi] = 0; continue } // background → outside

      // Expected colour based on position
      const expR = (vx + GRID_R) / (2 * GRID_R)
      const expG = (vy + GRID_R) / (2 * GRID_R)
      const expB = (vz + GRID_R) / (2 * GRID_R)

      const dr = img[idx  ]/255 - expR
      const dg = img[idx+1]/255 - expG
      const db = img[idx+2]/255 - expB
      const dist = Math.sqrt(dr*dr + dg*dg + db*db)

      if (dist > threshold) inside[vi] = 0
    }

    let count = 0; for (let vi = 0; vi < centers.length; vi++) count += inside[vi]
    volumes.push((count / centers.length) * 100)
  }

  return { inside, volumes }
}

// ── Hull surface mesh ─────────────────────────────────────────────────────────

const FACE_DEFS = [
  { g: [1,0,0] as const, n: [1,0,0] as const, s: [[1,1,1],[1,-1,1],[1,-1,-1],[1,1,-1]] as const },
  { g: [-1,0,0] as const, n: [-1,0,0] as const, s: [[-1,1,-1],[-1,-1,-1],[-1,-1,1],[-1,1,1]] as const },
  { g: [0,1,0] as const, n: [0,1,0] as const, s: [[1,1,-1],[-1,1,-1],[-1,1,1],[1,1,1]] as const },
  { g: [0,-1,0] as const, n: [0,-1,0] as const, s: [[1,-1,1],[-1,-1,1],[-1,-1,-1],[1,-1,-1]] as const },
  { g: [0,0,1] as const, n: [0,0,1] as const, s: [[-1,1,1],[1,1,1],[1,-1,1],[-1,-1,1]] as const },
  { g: [0,0,-1] as const, n: [0,0,-1] as const, s: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]] as const },
]

function buildHullSurface(vg: VoxelGrid, inside: Uint8Array): THREE.BufferGeometry {
  const { centers, gridIdx, fullGrid, grid } = vg
  const h = (2 * GRID_R) / grid / 2
  const verts: number[] = [], norms: number[] = []
  for (let vi = 0; vi < centers.length; vi++) {
    if (!inside[vi]) continue
    const [cx, cy, cz] = centers[vi]
    const [xi, yi, zi] = gridIdx[vi]
    for (const { g, n, s } of FACE_DEFS) {
      const nxi = xi+g[0], nyi = yi+g[1], nzi = zi+g[2]
      let nbIn = false
      if (nxi >= 0 && nxi < grid && nyi >= 0 && nyi < grid && nzi >= 0 && nzi < grid) {
        const nvi = fullGrid[nxi*grid*grid + nyi*grid + nzi]
        if (nvi !== -1 && inside[nvi]) nbIn = true
      }
      if (nbIn) continue
      const q = s.map(([qx,qy,qz]) => [cx+qx*h, cy+qy*h, cz+qz*h])
      verts.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3])
      for (let t = 0; t < 6; t++) norms.push(...n)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(norms, 3))
  geo.computeBoundingSphere()
  return geo
}

// ── Position shader ───────────────────────────────────────────────────────────
// Renders world position as colour: (pos + 1.5) / 3.0 → [0,1]

const VERT_SHADER = `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const FRAG_SHADER = `
  varying vec3 vWorldPos;
  void main() {
    vec3 col = clamp((vWorldPos + 1.5) / 3.0, 0.0, 1.0);
    gl_FragColor = vec4(col, 1.0);
  }
`

// ── Visual presets ─────────────────────────────────────────────────────────────

type PresetKey = 'dark' | 'blueprint' | 'light' | 'xray' | 'black'
interface Preset { bg: number; objColor: number; objEmissive: number; hullColor: number; hullEmissive: number; hullOpacity: number; edgeColor: number; sphereRefColor: number }

const PRESETS: Record<PresetKey, Preset> = {
  dark:      { bg: 0x0a0a14, objColor: 0xd4860a, objEmissive: 0x221100, hullColor: 0x00e5aa, hullEmissive: 0x003322, hullOpacity: 0.55, edgeColor: 0x4499ff, sphereRefColor: 0x1a1a33 },
  blueprint: { bg: 0x0a0f32, objColor: 0x5588ff, objEmissive: 0x001144, hullColor: 0x00ffcc, hullEmissive: 0x00332a, hullOpacity: 0.45, edgeColor: 0x88bbff, sphereRefColor: 0x0d1c4a },
  light:     { bg: 0xf0f2f5, objColor: 0x3366aa, objEmissive: 0x001133, hullColor: 0x009977, hullEmissive: 0x002211, hullOpacity: 0.45, edgeColor: 0x224488, sphereRefColor: 0xcccccc },
  xray:      { bg: 0x000000, objColor: 0x004422, objEmissive: 0x002211, hullColor: 0x00ff88, hullEmissive: 0x005533, hullOpacity: 0.35, edgeColor: 0x00ff88, sphereRefColor: 0x111111 },
  black:     { bg: 0x000000, objColor: 0xcc8800, objEmissive: 0x221100, hullColor: 0x00cc99, hullEmissive: 0x002211, hullOpacity: 0.50, edgeColor: 0x00aaff, sphereRefColor: 0x111111 },
}
const PRESET_LABELS: Record<PresetKey, string> = { dark: 'Dark', blueprint: 'Blueprint', light: 'Light', xray: 'X-Ray', black: 'Black' }

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

// ── Component ─────────────────────────────────────────────────────────────────

type ObjType = 'torusknot' | 'box'
interface FileItem { name: string; url: string; fileType: 'json' | 'gltf' }

interface SceneRefs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  rafId: number
  objectGroup: THREE.Group
  camerasGroup: THREE.Group
  planesGroup: THREE.Group
  hullGroup: THREE.Group
  refSphere: THREE.LineSegments
  // Off-screen capture
  offScene: THREE.Scene
  captureCam: THREE.OrthographicCamera
  renderTarget: THREE.WebGLRenderTarget
  posMaterial: THREE.ShaderMaterial
  offMesh: THREE.Mesh | null
}

export default function SpaceCarving() {
  const mountRef    = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sceneRef    = useRef<SceneRefs | null>(null)
  const voxGridRef  = useRef<VoxelGrid | null>(null)
  const imagesRef   = useRef<Uint8Array[] | null>(null)   // captured renders
  const dirsRef     = useRef<THREE.Vector3[]>([])
  const axesRef     = useRef<ReturnType<typeof projAxes>[]>([])
  const displayGeoRef = useRef<THREE.BufferGeometry | null>(null) // current obj geo

  const [objType, setObjType]   = useState<ObjType>('torusknot')
  const [nCams, setNCams]       = useState(16)
  const [gridSize, setGridSize] = useState(32)
  const [threshold, setThreshold] = useState(0.12)
  const [rtRes, setRtRes]       = useState<64 | 128 | 256>(128)

  const [captured, setCaptured]   = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [step, setStep]           = useState(0)
  const [volumes, setVolumes]     = useState<number[]>([])

  const [preset, setPreset]           = useState<PresetKey>('dark')
  const [showBody, setShowBody]       = useState(true)
  const [showEdges, setShowEdges]     = useState(false)
  const [showCams, setShowCams]       = useState(true)
  const [showPlanes, setShowPlanes]   = useState(true)
  const [showHull, setShowHull]       = useState(false)

  const [supaFiles, setSupaFiles]     = useState<FileItem[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [fileLabel, setFileLabel]     = useState<string | null>(null)
  const [showPicker, setShowPicker]   = useState(false)

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

    const objectGroup = new THREE.Group(), camerasGroup = new THREE.Group()
    const planesGroup = new THREE.Group(), hullGroup = new THREE.Group()
    scene.add(objectGroup, camerasGroup, planesGroup, hullGroup)

    // Off-screen scene for position rendering
    const offScene = new THREE.Scene()
    const captureCam = new THREE.OrthographicCamera(-GRID_R, GRID_R, GRID_R, -GRID_R, 0.01, 20)
    const renderTarget = new THREE.WebGLRenderTarget(128, 128)
    const posMaterial = new THREE.ShaderMaterial({ vertexShader: VERT_SHADER, fragmentShader: FRAG_SHADER })

    const resize = () => { const w = mount.clientWidth, h = mount.clientHeight; if (!w || !h) return; camera.aspect = w/h; camera.updateProjectionMatrix(); renderer.setSize(w, h) }
    resize(); const ro = new ResizeObserver(resize); ro.observe(mount)
    let rafId = 0
    const animate = () => { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }
    animate()

    sceneRef.current = { renderer, scene, camera, controls, rafId, objectGroup, camerasGroup, planesGroup, hullGroup, refSphere, offScene, captureCam, renderTarget, posMaterial, offMesh: null }
    return () => { cancelAnimationFrame(rafId); ro.disconnect(); controls.dispose(); renderTarget.dispose(); renderer.dispose(); if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement); sceneRef.current = null }
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
    s.hullGroup.traverse(child => {
      if ((child as THREE.Mesh).isMesh) { const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial; mat.color.setHex(p.hullColor); mat.emissive.setHex(p.hullEmissive); mat.opacity = p.hullOpacity }
    })
  }, [preset])

  // ── View toggles ───────────────────────────────────────────────────────────
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.objectGroup.traverse(c => { if (c.name === 'obj-mesh') c.visible = showBody }) }, [showBody])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.objectGroup.traverse(c => { if (c.name === 'obj-edges') c.visible = showEdges }) }, [showEdges])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.camerasGroup.visible = showCams }, [showCams])
  useEffect(() => { const s = sceneRef.current; if (!s) return; s.planesGroup.visible = showPlanes }, [showPlanes])

  // ── Hull mesh rebuild ──────────────────────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.hullGroup)
    const vg = voxGridRef.current
    if (!showHull || !vg || volumes.length === 0) return
    // Recompute inside from all captured images
    if (!imagesRef.current || imagesRef.current.length === 0) return
    const { inside } = computeSpaceCarving(vg, dirsRef.current, axesRef.current, imagesRef.current, imagesRef.current.length, rtRes, threshold)
    const p = PRESETS[preset]
    const geo = buildHullSurface(vg, inside)
    s.hullGroup.add(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: p.hullColor, emissive: p.hullEmissive, shininess: 50, transparent: true, opacity: p.hullOpacity, side: THREE.DoubleSide })))
    s.hullGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), new THREE.LineBasicMaterial({ color: p.hullColor, transparent: true, opacity: 0.2 })))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHull])

  // ── Add display mesh to main scene ────────────────────────────────────────
  const addDisplayMesh = useCallback((geo: THREE.BufferGeometry) => {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.objectGroup)
    if (!geo.attributes.normal) geo.computeVertexNormals()
    const p = PRESETS[preset]
    const mesh = Object.assign(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: p.objColor, emissive: p.objEmissive, shininess: 80, transparent: true, opacity: 0.88 })), { name: 'obj-mesh' })
    mesh.visible = showBody
    const edges = Object.assign(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: p.edgeColor, transparent: true, opacity: 0.4 })), { name: 'obj-edges' })
    edges.visible = showEdges
    s.objectGroup.add(mesh, edges)
    displayGeoRef.current = geo
    // Mirror to off-screen scene
    clearGroup(s.offScene as unknown as THREE.Group)
    const offMesh = new THREE.Mesh(geo, s.posMaterial)
    s.offScene.add(offMesh)
    s.offMesh = offMesh
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, showBody, showEdges])

  // ── Built-in object ────────────────────────────────────────────────────────
  const buildBuiltIn = useCallback((type: ObjType) => {
    let geo: THREE.BufferGeometry
    if (type === 'torusknot') geo = new THREE.TorusKnotGeometry(0.7, 0.18, 120, 16)
    else geo = new THREE.BoxGeometry(1.2, 1.2, 1.2)
    geo.computeBoundingSphere()
    const bs = geo.boundingSphere!
    const sc = 1.35 / bs.radius
    geo.scale(sc, sc, sc)
    const off = bs.center.clone().multiplyScalar(-sc)
    geo.translate(off.x, off.y, off.z)
    addDisplayMesh(geo)
  }, [addDisplayMesh])

  useEffect(() => {
    if (fileLabel) return
    buildBuiltIn(objType)
    resetState()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objType])

  useEffect(() => {
    if (!fileLabel) buildBuiltIn(objType)
    voxGridRef.current = buildVoxelGrid(gridSize)
    resetState()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridSize, nCams])

  function resetState() {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.camerasGroup); clearGroup(s.planesGroup); clearGroup(s.hullGroup)
    imagesRef.current = null
    setCaptured(false); setStep(0); setVolumes([]); setIsPlaying(false); setShowHull(false)
  }

  // ── Camera markers ────────────────────────────────────────────────────────
  const buildCameraMarkers = useCallback((dirs: THREE.Vector3[]) => {
    const s = sceneRef.current; if (!s) return
    clearGroup(s.camerasGroup)
    dirs.forEach((d, i) => {
      const t = i / Math.max(dirs.length - 1, 1)
      const col = new THREE.Color().setHSL(0.55 + t * 0.1, 0.9, 0.55)
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 }))
      m.position.copy(d.clone().multiplyScalar(1.65))
      s.camerasGroup.add(m)
    })
    s.camerasGroup.visible = showCams
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Capture all cameras (off-screen render + readback) ────────────────────
  const handleCapture = useCallback(async () => {
    const s = sceneRef.current; if (!s || !s.offMesh) return
    setCapturing(true)
    resetState()

    const dirs = makeFibDirs(nCams)
    const axes = dirs.map(d => projAxes(d))
    dirsRef.current = dirs
    axesRef.current = axes
    voxGridRef.current = buildVoxelGrid(gridSize)

    // Resize render target if needed
    if (s.renderTarget.width !== rtRes) {
      s.renderTarget.dispose()
      ;(s as { renderTarget: THREE.WebGLRenderTarget }).renderTarget = new THREE.WebGLRenderTarget(rtRes, rtRes)
    }

    buildCameraMarkers(dirs)

    const images: Uint8Array[] = []
    const pixBuf = new Uint8Array(rtRes * rtRes * 4)

    for (let k = 0; k < dirs.length; k++) {
      const dir = dirs[k]
      // Position orthographic camera
      s.captureCam.position.copy(dir.clone().multiplyScalar(GRID_R + 5))
      s.captureCam.lookAt(0, 0, 0)
      s.captureCam.up.set(0, 1, 0)
      s.captureCam.updateMatrixWorld()

      s.renderer.setRenderTarget(s.renderTarget)
      s.renderer.setClearColor(0x000000, 0)
      s.renderer.clear()
      s.renderer.render(s.offScene, s.captureCam)
      s.renderer.setRenderTarget(null)
      s.renderer.setClearColor(PRESETS[preset].bg, 1)

      s.renderer.readRenderTargetPixels(s.renderTarget, 0, 0, rtRes, rtRes, pixBuf)
      images.push(new Uint8Array(pixBuf))

      // Show camera plane with its rendered image (small floating preview)
      const { u, v } = axes[k]
      const texData = new Uint8Array(pixBuf)
      const tex = new THREE.DataTexture(texData, rtRes, rtRes)
      tex.needsUpdate = true
      const planePos = dir.clone().multiplyScalar(1.85)
      const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, dir))
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(0.55, 0.55),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
      )
      plane.position.copy(planePos); plane.quaternion.copy(quat)
      s.planesGroup.add(plane)

      // Yield to keep UI responsive every few frames
      if (k % 4 === 3) await new Promise(r => setTimeout(r, 0))
    }

    s.planesGroup.visible = showPlanes
    imagesRef.current = images
    setCaptured(true)
    setCapturing(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nCams, gridSize, rtRes, preset, showPlanes, buildCameraMarkers])

  // ── Animation: add one camera per step ────────────────────────────────────
  useEffect(() => {
    if (!isPlaying || !captured) return
    const images = imagesRef.current
    const vg = voxGridRef.current
    if (!images || !vg || step >= images.length) { setIsPlaying(false); if (step >= (imagesRef.current?.length ?? 0)) setShowHull(true); return }

    const timer = setTimeout(() => {
      const s = sceneRef.current; if (!s) return

      // Highlight active camera
      const camMesh = s.camerasGroup.children[step] as THREE.Mesh
      if (camMesh) { const m = camMesh.material as THREE.MeshPhongMaterial; m.color.set(0xffffff); m.emissive.set(0xffaa00); m.emissiveIntensity = 1.5 }

      // Recompute carved volume using first step+1 cameras
      const { inside, volumes: vols } = computeSpaceCarving(vg, dirsRef.current, axesRef.current, images, step + 1, rtRes, threshold)
      const vol = vols[vols.length - 1]
      setVolumes(prev => [...prev, vol])

      // Update hull mesh if already showing
      if (showHull) {
        clearGroup(s.hullGroup)
        const p = PRESETS[preset]
        const geo = buildHullSurface(vg, inside)
        s.hullGroup.add(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: p.hullColor, emissive: p.hullEmissive, shininess: 50, transparent: true, opacity: p.hullOpacity, side: THREE.DoubleSide })))
        s.hullGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), new THREE.LineBasicMaterial({ color: p.hullColor, transparent: true, opacity: 0.2 })))
      }

      setStep(prev => prev + 1)
    }, 300)
    return () => clearTimeout(timer)
  }, [isPlaying, step, captured, rtRes, threshold, preset, showHull])

  // ── Load local file ────────────────────────────────────────────────────────
  const loadLocalFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext !== 'json' && ext !== 'glb' && ext !== 'gltf') return
    setLoadingFile(true); resetState()
    try {
      if (ext === 'json') {
        const json = JSON.parse(await file.text()) as ThreeGeometryJson
        const norm = computeNorm(new Float32Array(json.vertices))
        const rawGeo = parseGeometry(json)
        const triPos = applyNorm(rawGeo.attributes.position.array as Float32Array, norm)
        const dispGeo = new THREE.BufferGeometry()
        dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(triPos, 3))
        addDisplayMesh(dispGeo)
      } else {
        const objectUrl = URL.createObjectURL(file)
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => new GLTFLoader().load(objectUrl, resolve, undefined, reject))
        URL.revokeObjectURL(objectUrl)
        const allVerts: number[] = [], allTri: number[] = []
        gltf.scene.updateMatrixWorld(true)
        gltf.scene.traverse(child => {
          if (!(child as THREE.Mesh).isMesh) return
          const mesh = child as THREE.Mesh
          const posAttr = mesh.geometry.attributes.position
          const index = mesh.geometry.index
          for (let i = 0; i < posAttr.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld); allVerts.push(v.x, v.y, v.z) }
          const count = index ? index.count : posAttr.count
          for (let i = 0; i < count; i++) { const vi = index ? index.getX(i) : i; const v = new THREE.Vector3().fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.matrixWorld); allTri.push(v.x, v.y, v.z) }
        })
        const norm = computeNorm(new Float32Array(allVerts))
        const triPos = applyNorm(new Float32Array(allTri), norm)
        const dispGeo = new THREE.BufferGeometry()
        dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(triPos, 3))
        addDisplayMesh(dispGeo)
      }
      setFileLabel(file.name)
    } catch (err) { console.error('Load error', err) }
    finally { setLoadingFile(false) }
  }, [addDisplayMesh])

  // ── Supabase ───────────────────────────────────────────────────────────────
  const fetchFileList = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const res = await fetch('/api/files'); if (!res.ok) throw new Error()
      const data: { name: string; url: string; type: string }[] = await res.json()
      setSupaFiles(data.filter(f => f.type === 'json' || f.type === 'gltf').map(f => ({ name: f.name, url: f.url, fileType: f.type as 'json' | 'gltf' })))
    } catch { setSupaFiles([]) } finally { setLoadingFiles(false) }
  }, [])

  const loadSupaFile = useCallback(async (url: string, label: string, fileType: 'json' | 'gltf') => {
    setLoadingFile(true); setShowPicker(false); resetState()
    try {
      if (fileType === 'json') {
        const json = await (await fetch(url)).json() as ThreeGeometryJson
        const norm = computeNorm(new Float32Array(json.vertices))
        const rawGeo = parseGeometry(json)
        const triPos = applyNorm(rawGeo.attributes.position.array as Float32Array, norm)
        const dispGeo = new THREE.BufferGeometry(); dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(triPos, 3))
        addDisplayMesh(dispGeo)
      } else {
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => new GLTFLoader().load(url, resolve, undefined, reject))
        const allVerts: number[] = [], allTri: number[] = []
        gltf.scene.updateMatrixWorld(true)
        gltf.scene.traverse(child => {
          if (!(child as THREE.Mesh).isMesh) return
          const mesh = child as THREE.Mesh
          const posAttr = mesh.geometry.attributes.position; const index = mesh.geometry.index
          for (let i = 0; i < posAttr.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld); allVerts.push(v.x, v.y, v.z) }
          const count = index ? index.count : posAttr.count
          for (let i = 0; i < count; i++) { const vi = index ? index.getX(i) : i; const v = new THREE.Vector3().fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.matrixWorld); allTri.push(v.x, v.y, v.z) }
        })
        const norm = computeNorm(new Float32Array(allVerts))
        const triPos = applyNorm(new Float32Array(allTri), norm)
        const dispGeo = new THREE.BufferGeometry(); dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(triPos, 3))
        addDisplayMesh(dispGeo)
      }
      setFileLabel(label)
    } catch (err) { console.error('Load error', err) }
    finally { setLoadingFile(false) }
  }, [addDisplayMesh])

  // ── Derived ────────────────────────────────────────────────────────────────
  const totalCams  = nCams
  const latestVol  = volumes.length > 0 ? volumes[volumes.length - 1] : 100
  const prevVol    = volumes.length > 1 ? volumes[volumes.length - 2] : 100
  const delta      = prevVol - latestVol
  const animDone   = captured && step >= totalCams && volumes.length > 0
  const voxelSize  = ((2 * GRID_R) / gridSize).toFixed(3)
  const btnT = (active: boolean) => `px-2 py-0.5 rounded border text-xs transition-colors ${active ? 'border-sky-500 text-sky-300 bg-sky-900/30' : 'border-gray-600 text-gray-400 hover:border-gray-400'}`

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-gray-800 shrink-0 flex-wrap bg-gray-950 text-xs">

        {/* Object */}
        <div className="flex items-center gap-1">
          <span className="text-gray-500 mr-1">Obj</span>
          {(['torusknot', 'box'] as ObjType[]).map(t => (
            <button key={t} disabled={!!fileLabel} onClick={() => { setFileLabel(null); setObjType(t) }}
              className={`px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${objType === t && !fileLabel ? 'border-orange-500 text-orange-300 bg-orange-900/30' : 'border-gray-600 text-gray-400 hover:border-gray-400'}`}>
              {t === 'torusknot' ? 'Torus' : 'Box'}
            </button>
          ))}
        </div>

        <div>
          <input ref={fileInputRef} type="file" accept=".json,.glb,.gltf" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) loadLocalFile(f); e.target.value = '' }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={loadingFile}
            className="px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:border-gray-300 transition-colors disabled:opacity-40">
            📂 Open…
          </button>
        </div>

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
                  <span className={`text-[10px] font-mono px-1 rounded ${f.fileType === 'json' ? 'bg-orange-900/40 text-orange-400' : 'bg-blue-900/40 text-blue-400'}`}>{f.fileType.toUpperCase()}</span>
                  {f.name.replace(/^\d+_/, '')}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-gray-700 shrink-0" />

        {/* Algorithm params */}
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 whitespace-nowrap">Cameras N</span>
          <input type="range" min={4} max={48} value={nCams} onChange={e => setNCams(+e.target.value)} className="w-20 accent-orange-500" />
          <span className="font-mono text-orange-300 w-5 tabular-nums">{nCams}</span>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 whitespace-nowrap">Voxel</span>
          <input type="range" min={12} max={96} step={4} value={gridSize} onChange={e => setGridSize(+e.target.value)} className="w-20 accent-purple-400" />
          <span className={`font-mono tabular-nums w-12 ${gridSize > 64 ? 'text-yellow-400' : 'text-purple-300'}`}>{voxelSize}{gridSize > 64 ? '⚠' : ''}</span>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 whitespace-nowrap">Threshold</span>
          <input type="range" min={0.02} max={0.5} step={0.01} value={threshold} onChange={e => setThreshold(+e.target.value)} className="w-20 accent-red-400" />
          <span className="font-mono text-red-300 tabular-nums w-10">{threshold.toFixed(2)}</span>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 whitespace-nowrap">RT res</span>
          {([64, 128, 256] as const).map(r => (
            <button key={r} onClick={() => setRtRes(r)} className={btnT(rtRes === r)}>{r}</button>
          ))}
        </label>

        <div className="w-px h-4 bg-gray-700 shrink-0" />

        {/* Presets */}
        <div className="flex items-center gap-1">
          {(Object.keys(PRESETS) as PresetKey[]).map(k => (
            <button key={k} onClick={() => setPreset(k)}
              className={`px-2 py-0.5 rounded border transition-colors ${preset === k ? 'border-white/50 text-white bg-white/10' : 'border-gray-700 text-gray-500 hover:border-gray-400 hover:text-gray-300'}`}>
              {PRESET_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-gray-700 shrink-0" />

        {/* View toggles */}
        <div className="flex items-center gap-1">
          <span className="text-gray-500 mr-0.5">Show</span>
          <button onClick={() => setShowBody(v => !v)} className={btnT(showBody)}>Body</button>
          <button onClick={() => setShowEdges(v => !v)} className={btnT(showEdges)}>Edges</button>
          <button onClick={() => setShowCams(v => !v)} className={btnT(showCams)}>Cams</button>
          <button onClick={() => setShowPlanes(v => !v)} className={btnT(showPlanes)}>Planes</button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setShowHull(v => !v)} disabled={!animDone}
            className={`px-2.5 py-1 rounded border transition-colors disabled:opacity-30 ${showHull ? 'border-teal-500 text-teal-300 bg-teal-900/30' : 'border-gray-600 text-gray-400 hover:border-teal-600'}`}>
            ◈ Hull
          </button>
          <button onClick={handleCapture} disabled={capturing || loadingFile}
            className={`px-2.5 py-1 rounded border transition-colors disabled:opacity-40 ${captured ? 'border-cyan-600 text-cyan-400 bg-cyan-900/20' : 'border-blue-600 text-blue-400 bg-blue-900/20'}`}>
            {capturing ? '⟳ Capturing…' : captured ? '↺ Re-capture' : '📷 Capture'}
          </button>
          <button onClick={() => setIsPlaying(v => !v)} disabled={!captured || step >= totalCams}
            className={`px-2.5 py-1 rounded border transition-colors disabled:opacity-40 ${isPlaying ? 'border-yellow-600 text-yellow-400 bg-yellow-900/20' : 'border-emerald-600 text-emerald-400 bg-emerald-900/20'}`}>
            {isPlaying ? '⏸ Pause' : step === 0 ? '▶ Carve' : '▶ Resume'}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div ref={mountRef} className="flex-1 min-w-0 min-h-0" />

        {/* Stats */}
        <div className="w-48 shrink-0 border-l border-gray-800 bg-gray-950 flex flex-col gap-3 p-3 text-xs overflow-y-auto">
          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Cameras</div>
            <div className="font-mono text-gray-300 text-lg tabular-nums">{step} <span className="text-gray-600 text-xs">/ {totalCams}</span></div>
            <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-orange-500 rounded-full transition-all" style={{ width: `${(step / Math.max(totalCams, 1)) * 100}%` }} />
            </div>
          </div>

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Volume remaining</div>
            <div className="font-mono text-blue-300 text-lg tabular-nums">{latestVol.toFixed(1)}<span className="text-gray-600 text-xs">%</span></div>
            <div className="text-gray-600 text-[10px]">of bounding sphere</div>
            <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, latestVol))}%` }} />
            </div>
          </div>

          {volumes.length > 1 && (
            <div>
              <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Δ per camera</div>
              <div className={`font-mono text-lg tabular-nums ${delta > 0.1 ? 'text-emerald-400' : 'text-red-400'}`}>−{delta.toFixed(3)}%</div>
              {latestVol > 0 && <div className="text-gray-600 text-[10px]">{((delta/latestVol)*100).toFixed(2)}% of hull</div>}
            </div>
          )}

          <div>
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Grid</div>
            <div className="font-mono text-purple-300">{gridSize}³</div>
            <div className="text-gray-600 text-[10px]">voxel {voxelSize} u · RT {rtRes}px</div>
          </div>

          {!captured && !capturing && (
            <div className="rounded border border-blue-800 bg-blue-900/20 px-2 py-1.5 text-blue-400 text-[11px]">
              Press 📷 Capture to render from all cameras
            </div>
          )}
          {capturing && (
            <div className="rounded border border-cyan-700 bg-cyan-900/20 px-2 py-1.5 text-cyan-400 text-[11px]">
              Rendering {nCams} views…
            </div>
          )}
          {captured && step === 0 && (
            <div className="rounded border border-emerald-800 bg-emerald-900/20 px-2 py-1.5 text-emerald-400 text-[11px]">
              {nCams} views captured — press ▶ Carve
            </div>
          )}
          {animDone && (
            <div className={`rounded border px-2 py-1.5 text-[11px] cursor-pointer transition-colors ${showHull ? 'border-teal-700 bg-teal-900/20 text-teal-400' : 'border-gray-700 text-gray-500 hover:border-teal-700'}`}
              onClick={() => setShowHull(v => !v)}>
              {showHull ? '◈ Hull visible' : '◈ Show carved solid'}
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

          <div className="text-gray-600 text-[10px] leading-relaxed border-t border-gray-800 pt-2">
            Shader: colour = (pos + 1.5) / 3.0<br />
            Carved if: background OR<br />
            min‑dist &gt; {threshold.toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  )
}
