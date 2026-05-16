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
    while (lower.length >= 2 && cross2d(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper: P2[] = []
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross2d(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop()
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

// ── Voxel grid constants ──────────────────────────────────────────────────────

const GRID = 32
const GRID_R = 1.5
const GRID_STEP = (2 * GRID_R) / GRID

// ── Visual-hull data ──────────────────────────────────────────────────────────

interface HullData {
  dirs: THREE.Vector3[]
  hulls: P2[][]
  axes: { u: THREE.Vector3; v: THREE.Vector3 }[]
  volumes: number[]
  finalInside: Uint8Array
  voxCenters: Array<[number, number, number]>
  voxGridIdx: Array<[number, number, number]>
  fullGrid: Int32Array  // GRID³ → voxel index, or -1 if outside sphere
}

function computeHullData(positions: Float32Array, dirs: THREE.Vector3[]): HullData {
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

  // Build voxel grid with full GRID³ lookup for neighbour queries
  const fullGrid = new Int32Array(GRID * GRID * GRID).fill(-1)
  const voxCenters: Array<[number, number, number]> = []
  const voxGridIdx: Array<[number, number, number]> = []

  for (let xi = 0; xi < GRID; xi++) {
    for (let yi = 0; yi < GRID; yi++) {
      for (let zi = 0; zi < GRID; zi++) {
        const x = -GRID_R + (xi + 0.5) * GRID_STEP
        const y = -GRID_R + (yi + 0.5) * GRID_STEP
        const z = -GRID_R + (zi + 0.5) * GRID_STEP
        if (x * x + y * y + z * z <= GRID_R * GRID_R) {
          fullGrid[xi * GRID * GRID + yi * GRID + zi] = voxCenters.length
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

  return { dirs, hulls, axes, volumes, finalInside: inside, voxCenters, voxGridIdx, fullGrid }
}

// ── Build visual-hull surface mesh (voxel surface extraction) ─────────────────

// Each entry: neighbour offset [dx,dy,dz], face quad corners ×½step, outward normal
const FACE_DEFS = [
  { g: [1,0,0] as const, n: [1,0,0] as const, s: [[1,1,1],[1,-1,1],[1,-1,-1],[1,1,-1]] as const },
  { g: [-1,0,0] as const, n: [-1,0,0] as const, s: [[-1,1,-1],[-1,-1,-1],[-1,-1,1],[-1,1,1]] as const },
  { g: [0,1,0] as const, n: [0,1,0] as const, s: [[1,1,-1],[-1,1,-1],[-1,1,1],[1,1,1]] as const },
  { g: [0,-1,0] as const, n: [0,-1,0] as const, s: [[1,-1,1],[-1,-1,1],[-1,-1,-1],[1,-1,-1]] as const },
  { g: [0,0,1] as const, n: [0,0,1] as const, s: [[-1,1,1],[1,1,1],[1,-1,1],[-1,-1,1]] as const },
  { g: [0,0,-1] as const, n: [0,0,-1] as const, s: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]] as const },
]

function buildHullSurface(data: HullData): THREE.BufferGeometry {
  const { finalInside, voxCenters, voxGridIdx, fullGrid } = data
  const h = GRID_STEP / 2
  const verts: number[] = []
  const norms: number[] = []

  for (let vi = 0; vi < voxCenters.length; vi++) {
    if (!finalInside[vi]) continue
    const [cx, cy, cz] = voxCenters[vi]
    const [xi, yi, zi] = voxGridIdx[vi]

    for (const { g, n, s } of FACE_DEFS) {
      const nxi = xi + g[0], nyi = yi + g[1], nzi = zi + g[2]
      let nbIn = false
      if (nxi >= 0 && nxi < GRID && nyi >= 0 && nyi < GRID && nzi >= 0 && nzi < GRID) {
        const nvi = fullGrid[nxi * GRID * GRID + nyi * GRID + nzi]
        if (nvi !== -1 && finalInside[nvi]) nbIn = true
      }
      if (nbIn) continue

      // Add two triangles for this exposed face (quad split 0-1-2 + 0-2-3)
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

// ── Normalise vertex positions to fit bounding sphere R≈1.35 ─────────────────

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
  if (mat) {
    if (Array.isArray(mat)) mat.forEach(m => m.dispose())
    else (mat as THREE.Material).dispose()
  }
}

function clearGroup(g: THREE.Group) {
  while (g.children.length > 0) {
    const c = g.children[0]
    g.remove(c)
    disposeObj(c)
  }
}

function buildProjectionMesh(
  hull2d: P2[],
  dir: THREE.Vector3,
  axes: { u: THREE.Vector3; v: THREE.Vector3 },
  dist: number,
  opacity: number
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
      color: 0x1155cc, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }))
    fill.position.copy(pos); fill.quaternion.copy(quat)
    group.add(fill)

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(fillGeo),
      new THREE.LineBasicMaterial({ color: 0x4499ff, transparent: true, opacity: 0.75 })
    )
    edge.position.copy(pos); edge.quaternion.copy(quat)
    group.add(edge)
  }

  const axisGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), pos])
  group.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: 0x1a3355, transparent: true, opacity: 0.4 })))
  return group
}

// ── Component ─────────────────────────────────────────────────────────────────

type ObjType = 'torusknot' | 'box'

interface FileItem {
  name: string
  url: string
  fileType: 'json' | 'gltf'
}

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
}

export default function VisualHull() {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)
  const hullDataRef = useRef<HullData | null>(null)
  const highlightRef = useRef<THREE.Mesh | null>(null)

  const [objType, setObjType] = useState<ObjType>('torusknot')
  const [nDirs, setNDirs] = useState(12)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [deltaThreshold, setDeltaThreshold] = useState(0.5)
  const [stepDelay, setStepDelay] = useState(600)
  const [projOpacity, setProjOpacity] = useState(0.35)
  const [volumes, setVolumes] = useState<number[]>([])
  const [stopped, setStopped] = useState(false)
  const [showHull, setShowHull] = useState(false)

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
    renderer.setClearColor(0x0a0a14, 1)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 50)
    camera.position.set(0, 1.5, 4.5)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.5

    scene.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.SphereGeometry(1.5, 24, 12)),
      new THREE.LineBasicMaterial({ color: 0x1a1a33, transparent: true, opacity: 0.3 })
    ))

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
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    let rafId = 0
    const animate = () => { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }
    animate()

    sceneRef.current = { renderer, scene, camera, controls, rafId, objectGroup, dirSpheresGroup, projectionsGroup, hullMeshGroup }
    return () => {
      cancelAnimationFrame(rafId); ro.disconnect(); controls.dispose(); renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [])

  // ── Hull mesh rebuild when showHull toggles ────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    clearGroup(s.hullMeshGroup)
    if (!showHull || !hullDataRef.current) return

    const geo = buildHullSurface(hullDataRef.current)
    const mat = new THREE.MeshPhongMaterial({
      color: 0x00e5aa, emissive: 0x003322, shininess: 50,
      transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    })
    s.hullMeshGroup.add(new THREE.Mesh(geo, mat))
    s.hullMeshGroup.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 15),
      new THREE.LineBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.2 })
    ))
  }, [showHull])

  // ── Build direction spheres and compute hull data ─────────────────────────
  const setupDirsAndHull = useCallback((positions: Float32Array) => {
    const s = sceneRef.current
    if (!s) return
    clearGroup(s.dirSpheresGroup)

    const dirs = makeFibDirs(nDirs)
    dirs.forEach((d, i) => {
      const t = i / Math.max(nDirs - 1, 1)
      const col = new THREE.Color().setHSL(0.08 + t * 0.05, 0.9, 0.55)
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 8, 6),
        new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: 0.3 })
      )
      sphere.position.copy(d.clone().multiplyScalar(1.55))
      s.dirSpheresGroup.add(sphere)
    })

    hullDataRef.current = computeHullData(positions, dirs)
  }, [nDirs])

  // ── Built-in object geometry ───────────────────────────────────────────────
  const buildObjectGeometry = useCallback((type: ObjType): { mesh: THREE.Mesh; positions: Float32Array } => {
    let geo: THREE.BufferGeometry
    if (type === 'torusknot') {
      geo = new THREE.TorusKnotGeometry(0.7, 0.18, 80, 14)
    } else {
      geo = new THREE.BoxGeometry(1.2, 1.2, 1.2)
    }
    geo.computeBoundingSphere()
    const bs = geo.boundingSphere!
    const scale = 1.35 / bs.radius
    geo.scale(scale, scale, scale)
    const off = bs.center.clone().multiplyScalar(-scale)
    geo.translate(off.x, off.y, off.z)

    const mat = new THREE.MeshPhongMaterial({
      color: type === 'torusknot' ? 0xd4860a : 0x3399cc,
      emissive: type === 'torusknot' ? 0x331800 : 0x001122,
      shininess: 80, transparent: true, opacity: 0.88,
    })
    return { mesh: new THREE.Mesh(geo, mat), positions: geo.attributes.position.array as Float32Array }
  }, [])

  // Rebuild when built-in object type or nDirs changes
  useEffect(() => {
    if (fileLabel) return
    const s = sceneRef.current
    if (!s) return
    clearGroup(s.objectGroup); clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
    highlightRef.current = null

    const { mesh, positions } = buildObjectGeometry(objType)
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 })
    )
    s.objectGroup.add(mesh, wire)
    setupDirsAndHull(positions)
    setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)
  }, [objType, nDirs, buildObjectGeometry, setupDirsAndHull, fileLabel])

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

      s.projectionsGroup.add(buildProjectionMesh(d.hulls[step], d.dirs[step], d.axes[step], 1.75, projOpacity))

      const vol = d.volumes[step]
      const prevVol = step > 0 ? d.volumes[step - 1] : 100
      const delta = prevVol - vol
      setVolumes(prev => [...prev, vol])

      if (delta < deltaThreshold && step > 0) {
        setStopped(true); setIsPlaying(false); setShowHull(true)
      } else {
        setCurrentStep(step + 1)
      }
    }, stepDelay)

    return () => clearTimeout(timer)
  }, [isPlaying, currentStep, stepDelay, deltaThreshold, projOpacity, stopped])

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

  // ── Load file from Supabase ───────────────────────────────────────────────
  const fetchFileList = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const res = await fetch('/api/files')
      if (!res.ok) throw new Error()
      const data: { name: string; url: string; type: string }[] = await res.json()
      setSupaFiles(
        data
          .filter(f => f.type === 'json' || f.type === 'gltf')
          .map(f => ({ name: f.name, url: f.url, fileType: f.type as 'json' | 'gltf' }))
      )
    } catch { setSupaFiles([]) }
    finally { setLoadingFiles(false) }
  }, [])

  const loadFile = useCallback(async (url: string, label: string, fileType: 'json' | 'gltf') => {
    const s = sceneRef.current
    if (!s) return
    setLoadingFile(true); setShowPicker(false)
    handleReset()

    try {
      clearGroup(s.objectGroup); clearGroup(s.dirSpheresGroup)
      clearGroup(s.projectionsGroup); clearGroup(s.hullMeshGroup)
      highlightRef.current = null

      let normPos: Float32Array

      if (fileType === 'json') {
        // Three.js legacy geometry JSON
        const resp = await fetch(url)
        const json = await resp.json() as ThreeGeometryJson

        normPos = normalisePositions(new Float32Array(json.vertices))

        // Build display mesh using the same parser as ThreeJsonViewer
        const dispGeo = parseGeometry(json)
        // Scale / centre the display geometry to match normPos
        dispGeo.setAttribute('position', new THREE.Float32BufferAttribute(normPos, 3))
        if (!dispGeo.attributes.normal) dispGeo.computeVertexNormals()

        const mesh = new THREE.Mesh(dispGeo, new THREE.MeshPhongMaterial({
          color: 0xd4860a, emissive: 0x221100, shininess: 70, transparent: true, opacity: 0.88,
        }))
        s.objectGroup.add(mesh)
        s.objectGroup.add(new THREE.LineSegments(
          new THREE.WireframeGeometry(dispGeo),
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06 })
        ))

      } else {
        // GLB / GLTF
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

        normPos = normalisePositions(new Float32Array(allPos))

        // Fit the GLTF scene to the same bounding sphere as normPos
        const rawBuf = new Float32Array(allPos)
        let minX = Infinity, minY = Infinity, minZ = Infinity
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
        for (let i = 0; i < rawBuf.length; i += 3) {
          minX = Math.min(minX, rawBuf[i]); maxX = Math.max(maxX, rawBuf[i])
          minY = Math.min(minY, rawBuf[i + 1]); maxY = Math.max(maxY, rawBuf[i + 1])
          minZ = Math.min(minZ, rawBuf[i + 2]); maxZ = Math.max(maxZ, rawBuf[i + 2])
        }
        const ocx = (minX + maxX) / 2, ocy = (minY + maxY) / 2, ocz = (minZ + maxZ) / 2
        let oMaxDist = 0
        for (let i = 0; i < rawBuf.length; i += 3) {
          const dx = rawBuf[i] - ocx, dy = rawBuf[i + 1] - ocy, dz = rawBuf[i + 2] - ocz
          oMaxDist = Math.max(oMaxDist, Math.sqrt(dx * dx + dy * dy + dz * dz))
        }
        const oSc = oMaxDist > 0 ? 1.35 / oMaxDist : 1
        gltf.scene.scale.setScalar(oSc)
        gltf.scene.position.set(-ocx * oSc, -ocy * oSc, -ocz * oSc)
        gltf.scene.traverse(child => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh
            m.material = new THREE.MeshPhongMaterial({ color: 0x3399cc, shininess: 70, transparent: true, opacity: 0.88 })
          }
        })
        s.objectGroup.add(gltf.scene)
      }

      setupDirsAndHull(normPos)
      setFileLabel(label)
      setCurrentStep(0); setVolumes([]); setIsPlaying(false); setStopped(false); setShowHull(false)

    } catch (err) {
      console.error('Load error', err)
    } finally {
      setLoadingFile(false)
    }
  }, [handleReset, setupDirsAndHull])

  // ── Derived metrics ───────────────────────────────────────────────────────
  const latestVol = volumes.length > 0 ? volumes[volumes.length - 1] : 100
  const prevVol = volumes.length > 1 ? volumes[volumes.length - 2] : 100
  const delta = prevVol - latestVol
  const totalSteps = hullDataRef.current?.dirs.length ?? nDirs
  const animDone = (currentStep >= totalSteps && volumes.length > 0) || stopped

  return (
    <div className="h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 shrink-0 flex-wrap gap-y-1.5 bg-gray-950">
        {/* Object selector */}
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500 mr-1">Object</span>
          {(['torusknot', 'box'] as ObjType[]).map(t => (
            <button
              key={t}
              disabled={!!fileLabel}
              onClick={() => { setFileLabel(null); setObjType(t) }}
              className={`px-2 py-0.5 rounded border text-xs transition-colors disabled:opacity-40 ${
                objType === t && !fileLabel
                  ? 'border-orange-500 text-orange-300 bg-orange-900/30'
                  : 'border-gray-600 text-gray-400 hover:border-gray-400'
              }`}
            >
              {t === 'torusknot' ? 'Torus Knot' : 'Box'}
            </button>
          ))}
        </div>

        {/* File picker */}
        <div className="relative">
          <button
            onClick={() => { setShowPicker(v => !v); if (!supaFiles.length && !loadingFiles) fetchFileList() }}
            className={`px-2 py-0.5 rounded border text-xs transition-colors ${
              fileLabel
                ? 'border-cyan-600 text-cyan-300 bg-cyan-900/20'
                : 'border-gray-600 text-gray-400 hover:border-gray-400'
            }`}
          >
            {loadingFile ? '…loading' : fileLabel ? `↗ ${fileLabel.replace(/^\d+_/, '')}` : '↗ Load file'}
          </button>
          {showPicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-gray-900 border border-gray-700 rounded shadow-xl min-w-[220px] max-h-52 overflow-y-auto">
              {loadingFiles && <div className="px-3 py-2 text-xs text-gray-400">Loading…</div>}
              {!loadingFiles && supaFiles.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-500">No JSON / GLB files found</div>
              )}
              {supaFiles.map(f => (
                <button
                  key={f.url}
                  onClick={() => loadFile(f.url, f.name, f.fileType)}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 truncate flex items-center gap-2"
                >
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

        {/* N slider */}
        <label className="flex items-center gap-2 text-xs">
          <span className="text-gray-400 whitespace-nowrap">Dirs N</span>
          <input type="range" min={3} max={30} value={nDirs}
            onChange={e => setNDirs(+e.target.value)}
            className="w-24 accent-orange-500"
          />
          <span className="font-mono text-orange-300 w-5 tabular-nums">{nDirs}</span>
        </label>

        {/* Speed */}
        <label className="flex items-center gap-2 text-xs">
          <span className="text-gray-400">Speed</span>
          <input type="range" min={100} max={2000} step={100} value={stepDelay}
            onChange={e => setStepDelay(+e.target.value)}
            className="w-20 accent-gray-400"
          />
        </label>

        {/* Delta threshold */}
        <label className="flex items-center gap-2 text-xs">
          <span className="text-gray-400 whitespace-nowrap">Stop Δ &lt;</span>
          <input type="range" min={0.1} max={5} step={0.1} value={deltaThreshold}
            onChange={e => setDeltaThreshold(+e.target.value)}
            className="w-20 accent-red-400"
          />
          <span className="font-mono text-red-300 tabular-nums">{deltaThreshold.toFixed(1)}%</span>
        </label>

        {/* Projection opacity */}
        <label className="flex items-center gap-2 text-xs">
          <span className="text-gray-400">α proj</span>
          <input type="range" min={0.05} max={0.8} step={0.05} value={projOpacity}
            onChange={e => setProjOpacity(+e.target.value)}
            className="w-16 accent-blue-400"
          />
        </label>

        <div className="flex items-center gap-1.5 ml-auto">
          {/* Hull toggle — always visible, activates automatically at end */}
          <button
            onClick={() => setShowHull(v => !v)}
            disabled={!animDone}
            className={`px-2.5 py-1 text-xs rounded border transition-colors disabled:opacity-30 ${
              showHull
                ? 'border-teal-500 text-teal-300 bg-teal-900/30'
                : 'border-gray-600 text-gray-400 hover:border-teal-600'
            }`}
            title="Show/hide visual hull solid"
          >
            ◈ Hull
          </button>

          <button
            onClick={() => { setStopped(false); setIsPlaying(v => !v) }}
            disabled={currentStep >= totalSteps && !stopped}
            className={`px-2.5 py-1 text-xs rounded border transition-colors disabled:opacity-40 ${
              isPlaying
                ? 'border-yellow-600 text-yellow-400 bg-yellow-900/20'
                : 'border-emerald-600 text-emerald-400 bg-emerald-900/20'
            }`}
          >
            {isPlaying ? '⏸ Pause' : currentStep === 0 ? '▶ Play' : '▶ Resume'}
          </button>
          <button
            onClick={handleReset}
            className="px-2.5 py-1 text-xs rounded border border-gray-600 text-gray-400 hover:border-gray-400 transition-colors"
          >
            ↺ Reset
          </button>
        </div>
      </div>

      {/* Main area */}
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
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Delta</div>
            <div className={`font-mono text-lg tabular-nums ${delta > deltaThreshold ? 'text-emerald-400' : 'text-red-400'}`}>
              {volumes.length > 1 ? `−${delta.toFixed(2)}%` : '—'}
            </div>
            {volumes.length > 1 && (
              <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${delta > deltaThreshold ? 'bg-emerald-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.min(100, Math.max(0, (delta / Math.max(1, prevVol)) * 100 * 5))}%` }}
                />
              </div>
            )}
          </div>

          {stopped && (
            <div className="rounded border border-red-800 bg-red-900/20 px-2 py-1.5 text-red-400 text-[11px]">
              Stopped — Δ &lt; {deltaThreshold}%
            </div>
          )}

          {currentStep >= totalSteps && !stopped && volumes.length > 0 && (
            <div className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-gray-400 text-[11px]">
              All {totalSteps} directions processed
            </div>
          )}

          {animDone && (
            <div className={`rounded border px-2 py-1.5 text-[11px] ${
              showHull
                ? 'border-teal-700 bg-teal-900/20 text-teal-400'
                : 'border-gray-700 text-gray-500'
            }`}>
              {showHull ? '◈ Hull visible' : '◈ Hull ready — click Hull button'}
            </div>
          )}

          {volumes.length > 1 && (
            <div>
              <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">Convergence</div>
              <svg viewBox={`0 0 ${volumes.length} 40`} className="w-full h-10" preserveAspectRatio="none">
                <polyline
                  points={volumes.map((v, i) => `${i},${40 - (v / 100) * 36}`).join(' ')}
                  fill="none" stroke="#3366cc" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
