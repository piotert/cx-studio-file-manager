'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

type BgKey = 'dark' | 'light' | 'black' | 'blue' | 'grey'

const BG: Record<BgKey, number> = {
  dark: 0x1a1a2e, light: 0xf0f0f0, black: 0x000000, blue: 0x1a2a4e, grey: 0x2a2a2a,
}

// Works for lines added either to scene or as mesh children
function disposeLines(lines: THREE.LineSegments[]) {
  lines.forEach((l) => {
    l.geometry.dispose()
    const m = l.material
    Array.isArray(m) ? m.forEach((x) => x.dispose()) : m.dispose()
    l.parent?.remove(l)
  })
}

export default function GltfViewer({ url }: { url: string }) {
  const mountRef  = useRef<HTMLDivElement>(null)

  // Three.js refs — persist across state changes so camera position is preserved
  const sceneRef  = useRef<THREE.Scene | null>(null)
  const meshesRef = useRef<THREE.Mesh[]>([])
  const edgesRef  = useRef<THREE.LineSegments[]>([])
  const wireRef   = useRef<THREE.LineSegments[]>([])

  const [loaded,     setLoaded]     = useState(false)
  const [showBody,   setShowBody]   = useState(true)
  const [showEdges,  setShowEdges]  = useState(false)
  const [showMesh,   setShowMesh]   = useState(false)
  const [edgesColor, setEdgesColor] = useState('#999999')
  const [meshColor,  setMeshColor]  = useState('#00aaff')
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
    edgesRef.current = []
    if (!loaded || !showEdges) return
    const lines: THREE.LineSegments[] = []
    meshesRef.current.forEach((mesh) => {
      const el = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 30),
        new THREE.LineBasicMaterial({ color: edgesColor }),
      )
      mesh.add(el)   // child → inherits mesh transform automatically
      lines.push(el)
    })
    edgesRef.current = lines
  }, [loaded, showEdges, edgesColor])

  // ── 5. Mesh (full tessellation wireframe) overlay ────────────────────
  useEffect(() => {
    disposeLines(wireRef.current)
    wireRef.current = []
    if (!loaded || !showMesh) return
    const lines: THREE.LineSegments[] = []
    meshesRef.current.forEach((mesh) => {
      const wl = new THREE.LineSegments(
        new THREE.WireframeGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: meshColor, opacity: 0.4, transparent: true }),
      )
      mesh.add(wl)
      lines.push(wl)
    })
    wireRef.current = lines
  }, [loaded, showMesh, meshColor])

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
