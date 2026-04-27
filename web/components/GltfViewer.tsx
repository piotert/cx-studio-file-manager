'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

type BgKey = 'dark' | 'light' | 'black' | 'blue' | 'grey'

const BG: Record<BgKey, number> = {
  dark: 0x1a1a2e, light: 0xf0f0f0, black: 0x000000, blue: 0x1a2a4e, grey: 0x2a2a2a,
}

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

export default function GltfViewer({ url }: { url: string }) {
  const mountRef  = useRef<HTMLDivElement>(null)

  // Three.js refs — persist across state changes so camera position is preserved
  const sceneRef    = useRef<THREE.Scene | null>(null)
  const meshesRef   = useRef<THREE.Mesh[]>([])
  const edgesRef    = useRef<LineSegments2[]>([])
  const wireRef     = useRef<LineSegments2[]>([])
  // LineMaterial refs for resolution updates in animate loop
  const edgeMatsRef = useRef<LineMaterial[]>([])
  const wireMatsRef = useRef<LineMaterial[]>([])

  const [loaded,     setLoaded]     = useState(false)
  const [showBody,   setShowBody]   = useState(true)
  const [showEdges,  setShowEdges]  = useState(false)
  const [showMesh,   setShowMesh]   = useState(false)
  const [edgesColor, setEdgesColor] = useState('#999999')
  const [meshColor,  setMeshColor]  = useState('#00aaff')
  const [lineWidth,  setLineWidth]  = useState(1)
  const [bgColor,    setBgColor]    = useState<BgKey>('dark')

  // ── 1. Main setup — rebuilds only on URL change ──────────────────────
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
    scene.background = new THREE.Color(BG[bgColor])
    sceneRef.current = scene

    const camera   = new THREE.PerspectiveCamera(45, w0 / h0, 0.01, 1000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

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

      // Collect meshes — line overlays are added as mesh children
      // so they automatically inherit the mesh's world transform
      const meshes: THREE.Mesh[] = []
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) meshes.push(child)
      })
      meshesRef.current = meshes
      setLoaded(true)
    })

    let animId: number
    const animate = () => {
      // Keep LineMaterial resolution in sync (cheap Vector2 update)
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

  // ── 2. Background color ───────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.background = new THREE.Color(BG[bgColor])
  }, [bgColor])

  // ── 3. Body visibility ────────────────────────────────────────────────
  useEffect(() => {
    meshesRef.current.forEach((m) => { m.visible = showBody })
  }, [showBody, loaded])

  // ── 4. Edges overlay ─────────────────────────────────────────────────
  useEffect(() => {
    disposeLines(edgesRef.current)
    edgesRef.current    = []
    edgeMatsRef.current = []
    const scene = sceneRef.current
    if (!loaded || !showEdges || !scene) return
    const lines: LineSegments2[] = []
    const mats:  LineMaterial[]  = []
    meshesRef.current.forEach((mesh) => {
      mesh.updateWorldMatrix(true, false)
      const src = new THREE.EdgesGeometry(mesh.geometry, 30)
      const el  = makeLineSegments2(src, edgesColor, lineWidth, 1.0, 1, 1)
      src.dispose()
      el.applyMatrix4(mesh.matrixWorld) // world-space position, independent of mesh.visible
      scene.add(el)
      lines.push(el)
      mats.push(el.material as LineMaterial)
    })
    edgesRef.current    = lines
    edgeMatsRef.current = mats
  }, [loaded, showEdges, edgesColor, lineWidth])

  // ── 5. Mesh (full tessellation wireframe) overlay ────────────────────
  useEffect(() => {
    disposeLines(wireRef.current)
    wireRef.current    = []
    wireMatsRef.current = []
    const scene = sceneRef.current
    if (!loaded || !showMesh || !scene) return
    const lines: LineSegments2[] = []
    const mats:  LineMaterial[]  = []
    meshesRef.current.forEach((mesh) => {
      mesh.updateWorldMatrix(true, false)
      const src = new THREE.WireframeGeometry(mesh.geometry)
      const wl  = makeLineSegments2(src, meshColor, lineWidth, 0.4, 1, 1)
      src.dispose()
      wl.applyMatrix4(mesh.matrixWorld)
      scene.add(wl)
      lines.push(wl)
      mats.push(wl.material as LineMaterial)
    })
    wireRef.current    = lines
    wireMatsRef.current = mats
  }, [loaded, showMesh, meshColor, lineWidth])

  // ── UI ────────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-1 flex-wrap items-center p-2 shrink-0 bg-gray-900 border-b border-gray-800">

        {/* Body toggle */}
        <button
          onClick={() => setShowBody(!showBody)}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            showBody
              ? 'bg-gray-600 text-white'
              : 'bg-gray-700 text-gray-400 line-through hover:bg-gray-600'
          }`}
          title="Show / hide solid mesh"
        >
          Body
        </button>

        <div className="border-l border-gray-600 self-stretch" />

        {/* Edges toggle + color */}
        <div className="flex items-center">
          <button
            onClick={() => setShowEdges(!showEdges)}
            className={`px-3 py-1 rounded-l text-sm font-medium transition-colors ${
              showEdges ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Edges
          </button>
          <input
            type="color"
            value={edgesColor}
            onChange={(e) => setEdgesColor(e.target.value)}
            className="h-7 w-7 rounded-r cursor-pointer p-0.5 bg-gray-700 border-0"
            title="Edges color"
          />
        </div>

        {/* Mesh toggle + color */}
        <div className="flex items-center">
          <button
            onClick={() => setShowMesh(!showMesh)}
            className={`px-3 py-1 rounded-l text-sm font-medium transition-colors ${
              showMesh ? 'bg-cyan-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Mesh
          </button>
          <input
            type="color"
            value={meshColor}
            onChange={(e) => setMeshColor(e.target.value)}
            className="h-7 w-7 rounded-r cursor-pointer p-0.5 bg-gray-700 border-0"
            title="Mesh color"
          />
        </div>

        {/* Line width slider */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-400 shrink-0">W</span>
          <input
            type="range" min="1" max="6" step="0.5"
            value={lineWidth}
            onChange={(e) => setLineWidth(Number(e.target.value))}
            className="w-20 accent-blue-500"
            title={`Line width: ${lineWidth}px`}
          />
          <span className="text-xs text-gray-500 w-5">{lineWidth}</span>
        </div>

        <div className="border-l border-gray-600 self-stretch" />

        {/* Background */}
        {(['dark', 'light', 'black', 'blue', 'grey'] as const).map((c) => (
          <button
            key={c}
            onClick={() => setBgColor(c)}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors capitalize ${
              bgColor === c ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div ref={mountRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
