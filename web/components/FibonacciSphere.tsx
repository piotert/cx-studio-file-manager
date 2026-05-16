'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// Golden ratio and derived constants
const PHI = (1 + Math.sqrt(5)) / 2
const GOLDEN_ANGLE_RAD = 2 * Math.PI * (2 - PHI) // ≈ 2.39996… rad
const GOLDEN_ANGLE_DEG = GOLDEN_ANGLE_RAD * (180 / Math.PI) // ≈ 137.5077…°

function makeFibonacciPoints(n: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (2 * i) / (n - 1)
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = GOLDEN_ANGLE_RAD * i
    pts.push(new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta)))
  }
  return pts
}

interface SceneRefs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  rafId: number
  pointsGroup: THREE.Group
  linesGroup: THREE.Group
}

function disposeGroup(g: THREE.Group) {
  while (g.children.length > 0) {
    const c = g.children[0]
    g.remove(c)
    if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose()
    const mat = (c as THREE.Mesh).material
    if (mat) {
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else (mat as THREE.Material).dispose()
    }
  }
}

export default function FibonacciSphere() {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)
  const [n, setN] = useState(30)
  const [autoRotate, setAutoRotate] = useState(true)

  // ── Scene init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x0d0d1a, 1)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 50)
    camera.position.set(0, 0.4, 3.1)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.8

    // Stop auto-rotation when user drags
    controls.addEventListener('start', () => setAutoRotate(false))

    // Background sphere wireframe
    scene.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.SphereGeometry(1.01, 24, 12)),
        new THREE.LineBasicMaterial({ color: 0x1a2a44, transparent: true, opacity: 0.35 })
      )
    )

    // Subtle axis lines
    const axisMat = new THREE.LineBasicMaterial({ color: 0x334455, transparent: true, opacity: 0.22 })
    ;[
      [new THREE.Vector3(-1.3, 0, 0), new THREE.Vector3(1.3, 0, 0)],
      [new THREE.Vector3(0, -1.3, 0), new THREE.Vector3(0, 1.3, 0)],
      [new THREE.Vector3(0, 0, -1.3), new THREE.Vector3(0, 0, 1.3)],
    ].forEach(([a, b]) =>
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), axisMat))
    )

    scene.add(new THREE.AmbientLight(0x8899cc, 1.0))
    const dl = new THREE.DirectionalLight(0xaabbff, 1.8)
    dl.position.set(2, 3, 2)
    scene.add(dl)

    const pointsGroup = new THREE.Group()
    const linesGroup = new THREE.Group()
    scene.add(pointsGroup, linesGroup)

    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    let rafId = 0
    const animate = () => {
      rafId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    sceneRef.current = { renderer, scene, camera, controls, rafId, pointsGroup, linesGroup }

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [])

  // ── Rebuild points & spiral lines when N changes ───────────────────────────
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return

    disposeGroup(s.pointsGroup)
    disposeGroup(s.linesGroup)

    const pts = makeFibonacciPoints(n)

    pts.forEach((p, i) => {
      const t = n > 1 ? i / (n - 1) : 0.5
      // color gradient: deep blue → cyan → teal
      const hue = 0.58 + t * 0.27
      const col = new THREE.Color().setHSL(hue, 0.88, 0.62)
      const geo = new THREE.SphereGeometry(0.038, 8, 6)
      const mat = new THREE.MeshPhongMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: 0.22,
        shininess: 90,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.copy(p)
      s.pointsGroup.add(mesh)
    })

    if (pts.length >= 2) {
      const posArr: number[] = []
      for (let i = 0; i < pts.length - 1; i++) {
        posArr.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3))
      s.linesGroup.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({ color: 0x3377bb, transparent: true, opacity: 0.5 })
        )
      )
    }
  }, [n])

  // ── Sync autoRotate ────────────────────────────────────────────────────────
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.controls.autoRotate = autoRotate
  }, [autoRotate])

  // ── Export JSON ───────────────────────────────────────────────────────────
  const exportJSON = useCallback(() => {
    const data = makeFibonacciPoints(n).map(p => ({
      x: +p.x.toFixed(7),
      y: +p.y.toFixed(7),
      z: +p.z.toFixed(7),
    }))
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fibonacci_sphere_n${n}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [n])

  return (
    <div className="h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 shrink-0 flex-wrap gap-y-1.5 bg-gray-950">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-gray-400 whitespace-nowrap">Points N</span>
          <input
            type="range"
            min={3}
            max={120}
            value={n}
            onChange={e => setN(+e.target.value)}
            className="w-32 md:w-44 accent-blue-500"
          />
          <span className="font-mono text-blue-300 w-8 text-right tabular-nums">{n}</span>
        </label>

        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-gray-600">φ =</span>
          <span className="font-mono text-amber-400 tabular-nums">{GOLDEN_ANGLE_DEG.toFixed(4)}°</span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => setAutoRotate(v => !v)}
            className={`px-2.5 py-1 text-xs rounded border transition-colors ${
              autoRotate
                ? 'border-blue-600 text-blue-400 bg-blue-900/30'
                : 'border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-200'
            }`}
          >
            {autoRotate ? '⏸ Pause' : '▶ Rotate'}
          </button>
          <button
            onClick={exportJSON}
            className="px-2.5 py-1 text-xs rounded border border-gray-600 text-gray-400 hover:border-emerald-600 hover:text-emerald-400 transition-colors"
          >
            ↓ Export JSON
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div ref={mountRef} className="flex-1 min-h-0" />
    </div>
  )
}
