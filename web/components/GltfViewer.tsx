'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

// ── Shared viewer types ───────────────────────────────────────────────────────

export type BgKey = 'dark' | 'light' | 'black' | 'blue' | 'grey'

export const BG: Record<BgKey, number> = {
  dark: 0x1a1a2e, light: 0xf0f0f0, black: 0x000000, blue: 0x0a0f32, grey: 0x2a2a2a,
}

export type ViewerSettings = {
  showBody: boolean
  showEdges: boolean
  showMesh: boolean
  showRgb: boolean
  edgesColor: string
  meshColor: string
  lineWidth: number
  bgColor: BgKey
}

export const DEFAULT_SETTINGS: ViewerSettings = {
  showBody: true,
  showEdges: false,
  showMesh: false,
  showRgb: false,
  edgesColor: '#999999',
  meshColor: '#00aaff',
  lineWidth: 1,
  bgColor: 'dark',
}

export type Preset = { name: string } & ViewerSettings

export const PRESETS: Preset[] = [
  { name: 'Blueprint', bgColor: 'blue',  showBody: true,  showEdges: true,  showMesh: false, showRgb: false, edgesColor: '#c8dcff', meshColor: '#4488ff', lineWidth: 1.5 },
  { name: 'Dark',      bgColor: 'dark',  showBody: true,  showEdges: false, showMesh: false, showRgb: false, edgesColor: '#999999', meshColor: '#00aaff', lineWidth: 1   },
  { name: 'Light',     bgColor: 'light', showBody: true,  showEdges: false, showMesh: false, showRgb: false, edgesColor: '#666666', meshColor: '#0044aa', lineWidth: 1   },
  { name: 'Drawing',   bgColor: 'light', showBody: true,  showEdges: true,  showMesh: false, showRgb: false, edgesColor: '#111111', meshColor: '#444444', lineWidth: 1.5 },
  { name: 'Black',     bgColor: 'black', showBody: true,  showEdges: false, showMesh: false, showRgb: false, edgesColor: '#aaaaaa', meshColor: '#00aaff', lineWidth: 1   },
  { name: 'X-Ray',     bgColor: 'black', showBody: false, showEdges: true,  showMesh: true,  showRgb: false, edgesColor: '#00ff88', meshColor: '#004422', lineWidth: 1   },
  { name: 'Normals',   bgColor: 'dark',  showBody: true,  showEdges: false, showMesh: false, showRgb: true,  edgesColor: '#999999', meshColor: '#00aaff', lineWidth: 1   },
]

// ── Camera sync types ─────────────────────────────────────────────────────────

export type CameraState = {
  px: number; py: number; pz: number
  qx: number; qy: number; qz: number; qw: number
  tx: number; ty: number; tz: number
  version: number
  masterId: string
}

export type CameraLink = {
  state: { current: CameraState }
  id: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLineSegments2(
  srcGeom: THREE.BufferGeometry,
  color: string,
  lw: number,
  opacity: number,
  w: number,
  h: number,
): LineSegments2 {
  const lg = new LineSegmentsGeometry()
  lg.setPositions(srcGeom.attributes.position.array as Float32Array)
  const mat = new LineMaterial({
    color,
    linewidth: lw,
    resolution: new THREE.Vector2(w, h),
    transparent: opacity < 1,
    opacity,
  })
  return new LineSegments2(lg, mat)
}

function disposeLines(lines: LineSegments2[]) {
  lines.forEach((l) => {
    l.geometry.dispose()
    l.material.dispose()
    l.parent?.remove(l)
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GltfViewer({
  url,
  cameraLink,
  settings,
  fileName,
}: {
  url: string
  cameraLink?: CameraLink
  settings: ViewerSettings
  fileName?: string
}) {
  const mountRef = useRef<HTMLDivElement>(null)

  const sceneRef    = useRef<THREE.Scene | null>(null)
  const meshesRef   = useRef<THREE.Mesh[]>([])
  const edgesRef    = useRef<LineSegments2[]>([])
  const wireRef     = useRef<LineSegments2[]>([])
  const edgeMatsRef = useRef<LineMaterial[]>([])
  const wireMatsRef = useRef<LineMaterial[]>([])

  const cameraLinkLive = useRef(cameraLink)
  useEffect(() => { cameraLinkLive.current = cameraLink }, [cameraLink])

  // Keep latest settings accessible inside long-lived effect closures
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  const [loaded, setLoaded] = useState(false)

  // ── 1. Main setup — rebuilds only on URL change ──────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    setLoaded(false)
    meshesRef.current = []

    const w0 = mount.clientWidth  || 400
    const h0 = mount.clientHeight || 400

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w0, h0)
    renderer.setPixelRatio(window.devicePixelRatio)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(BG[settingsRef.current.bgColor])
    sceneRef.current = scene

    const camera   = new THREE.PerspectiveCamera(45, w0 / h0, 0.01, 1000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    let isRemoteUpdate = false
    controls.addEventListener('change', () => {
      if (isRemoteUpdate) return
      const link = cameraLinkLive.current
      if (!link) return
      const s = link.state.current
      s.px = camera.position.x; s.py = camera.position.y; s.pz = camera.position.z
      s.qx = camera.quaternion.x; s.qy = camera.quaternion.y
      s.qz = camera.quaternion.z; s.qw = camera.quaternion.w
      s.tx = controls.target.x; s.ty = controls.target.y; s.tz = controls.target.z
      s.version++
      s.masterId = link.id
    })

    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth
      const nh = mount.clientHeight
      if (nw > 0 && nh > 0) {
        renderer.setSize(nw, nh)
        camera.aspect = nw / nh
        camera.updateProjectionMatrix()
      }
    })
    ro.observe(mount)

    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(5, 10, 5)
    scene.add(dir)

    const loader = new GLTFLoader()
    loader.load(url, (gltf) => {
      const box    = new THREE.Box3().setFromObject(gltf.scene)
      const center = box.getCenter(new THREE.Vector3())
      const size   = box.getSize(new THREE.Vector3()).length()
      gltf.scene.position.sub(center)
      camera.position.set(0, size * 0.4, size * 1.2)
      controls.target.set(0, 0, 0)
      controls.update()
      scene.add(gltf.scene)

      const meshes: THREE.Mesh[] = []
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) meshes.push(child)
      })
      meshesRef.current = meshes
      setLoaded(true)
    })

    let lastAppliedVersion = -1
    let animId: number
    const animate = () => {
      const link = cameraLinkLive.current
      if (link) {
        const s = link.state.current
        if (s.masterId !== link.id && s.version > lastAppliedVersion) {
          lastAppliedVersion = s.version
          isRemoteUpdate = true
          camera.position.set(s.px, s.py, s.pz)
          camera.quaternion.set(s.qx, s.qy, s.qz, s.qw)
          controls.target.set(s.tx, s.ty, s.tz)
          controls.update()
          isRemoteUpdate = false
        }
      }
      const nw = mount.clientWidth
      const nh = mount.clientHeight
      edgeMatsRef.current.forEach((m) => m.resolution.set(nw, nh))
      wireMatsRef.current.forEach((m) => m.resolution.set(nw, nh))
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      ro.disconnect()
      cancelAnimationFrame(animId)
      disposeLines(edgesRef.current)
      disposeLines(wireRef.current)
      edgesRef.current  = []
      wireRef.current   = []
      meshesRef.current = []
      sceneRef.current  = null
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [url]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Background color ───────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.background = new THREE.Color(BG[settings.bgColor])
  }, [settings.bgColor])

  // ── 3. Body visibility ────────────────────────────────────────────────────
  useEffect(() => {
    meshesRef.current.forEach((m) => { m.visible = settings.showBody })
  }, [settings.showBody, loaded])

  // ── 4. Edges overlay ──────────────────────────────────────────────────────
  useEffect(() => {
    disposeLines(edgesRef.current)
    edgesRef.current    = []
    edgeMatsRef.current = []
    const scene = sceneRef.current
    if (!loaded || !settings.showEdges || !scene) return
    const lines: LineSegments2[] = []
    const mats:  LineMaterial[]  = []
    meshesRef.current.forEach((mesh) => {
      mesh.updateWorldMatrix(true, false)
      const src = new THREE.EdgesGeometry(mesh.geometry, 30)
      const el  = makeLineSegments2(src, settings.edgesColor, settings.lineWidth, 1.0, 1, 1)
      src.dispose()
      el.applyMatrix4(mesh.matrixWorld)
      scene.add(el)
      lines.push(el)
      mats.push(el.material as LineMaterial)
    })
    edgesRef.current    = lines
    edgeMatsRef.current = mats
  }, [loaded, settings.showEdges, settings.edgesColor, settings.lineWidth])

  // ── 5. Wireframe overlay ──────────────────────────────────────────────────
  useEffect(() => {
    disposeLines(wireRef.current)
    wireRef.current    = []
    wireMatsRef.current = []
    const scene = sceneRef.current
    if (!loaded || !settings.showMesh || !scene) return
    const lines: LineSegments2[] = []
    const mats:  LineMaterial[]  = []
    meshesRef.current.forEach((mesh) => {
      mesh.updateWorldMatrix(true, false)
      const src = new THREE.WireframeGeometry(mesh.geometry)
      const wl  = makeLineSegments2(src, settings.meshColor, settings.lineWidth, 0.4, 1, 1)
      src.dispose()
      wl.applyMatrix4(mesh.matrixWorld)
      scene.add(wl)
      lines.push(wl)
      mats.push(wl.material as LineMaterial)
    })
    wireRef.current    = lines
    wireMatsRef.current = mats
  }, [loaded, settings.showMesh, settings.meshColor, settings.lineWidth])

  // ── 6. RGB (normal-map) shader ────────────────────────────────────────────
  useEffect(() => {
    meshesRef.current.forEach((mesh) => {
      if (settings.showRgb) {
        if (mesh.userData._mat === undefined) mesh.userData._mat = mesh.material
        mesh.material = new THREE.MeshNormalMaterial()
      } else {
        if (mesh.userData._mat !== undefined) {
          mesh.material = mesh.userData._mat
          delete mesh.userData._mat
        }
      }
    })
  }, [settings.showRgb, loaded])

  return (
    <div className="relative h-full w-full overflow-hidden">
      {fileName && (
        <div className="absolute top-2 left-2 z-10 text-xs text-white/80 bg-black/50 px-2 py-0.5 rounded pointer-events-none font-mono leading-tight">
          {fileName}
        </div>
      )}
      <div ref={mountRef} className="h-full w-full" />
    </div>
  )
}
