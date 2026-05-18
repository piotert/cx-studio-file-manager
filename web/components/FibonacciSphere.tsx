'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const PHI = (1 + Math.sqrt(5)) / 2
const GOLDEN_ANGLE_RAD = 2 * Math.PI * (2 - PHI)
const GOLDEN_ANGLE_DEG = GOLDEN_ANGLE_RAD * (180 / Math.PI)

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

// SLERP-based geodesic arc between two unit vectors
function geodesicArc(a: THREE.Vector3, b: THREE.Vector3, segments: number): THREE.Vector3[] {
  const dot = Math.max(-1, Math.min(1, a.dot(b)))
  const theta = Math.acos(dot)
  if (theta < 1e-6) return [a.clone(), b.clone()]
  const sinTheta = Math.sin(theta)
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const w1 = Math.sin((1 - t) * theta) / sinTheta
    const w2 = Math.sin(t * theta) / sinTheta
    pts.push(new THREE.Vector3(a.x * w1 + b.x * w2, a.y * w1 + b.y * w2, a.z * w1 + b.z * w2))
  }
  return pts
}

// Full-spectrum rainbow colour: t=0 → red, t=1 → violet
function rainbow(t: number): THREE.Color {
  return new THREE.Color().setHSL(t * 0.82, 0.92, 0.58)
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
    const c = g.children[0]; g.remove(c)
    if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose()
    const mat = (c as THREE.Mesh).material
    if (mat) { Array.isArray(mat) ? mat.forEach(m => m.dispose()) : (mat as THREE.Material).dispose() }
  }
}

export default function FibonacciSphere() {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)
  const [n, setN] = useState(30)
  const [showArcs, setShowArcs] = useState(true)
  const [autoRotate, setAutoRotate] = useState(true)

  // ── Scene init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x080814, 1)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 50)
    camera.position.set(0, 0.4, 3.1)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = 0.06
    controls.autoRotate = true; controls.autoRotateSpeed = 0.8
    controls.addEventListener('start', () => setAutoRotate(false))

    scene.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.SphereGeometry(1.01, 32, 16)),
      new THREE.LineBasicMaterial({ color: 0x111830, transparent: true, opacity: 0.4 })
    ))

    const axisMat = new THREE.LineBasicMaterial({ color: 0x223344, transparent: true, opacity: 0.18 })
    ;[[[-1.3,0,0],[1.3,0,0]],[[0,-1.3,0],[0,1.3,0]],[[0,0,-1.3],[0,0,1.3]]].forEach(([a,b]) =>
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...(a as [number,number,number])), new THREE.Vector3(...(b as [number,number,number]))]), axisMat))
    )

    scene.add(new THREE.AmbientLight(0x8899cc, 1.0))
    const dl = new THREE.DirectionalLight(0xaabbff, 1.8); dl.position.set(2, 3, 2); scene.add(dl)

    const pointsGroup = new THREE.Group(), linesGroup = new THREE.Group()
    scene.add(pointsGroup, linesGroup)

    const resize = () => { const w = mount.clientWidth, h = mount.clientHeight; if (!w || !h) return; camera.aspect = w/h; camera.updateProjectionMatrix(); renderer.setSize(w, h) }
    resize(); const ro = new ResizeObserver(resize); ro.observe(mount)

    let rafId = 0
    const animate = () => { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }
    animate()

    sceneRef.current = { renderer, scene, camera, controls, rafId, pointsGroup, linesGroup }
    return () => { cancelAnimationFrame(rafId); ro.disconnect(); controls.dispose(); renderer.dispose(); if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement); sceneRef.current = null }
  }, [])

  // ── Rebuild when N or showArcs changes ────────────────────────────────────
  useEffect(() => {
    const s = sceneRef.current; if (!s) return
    disposeGroup(s.pointsGroup); disposeGroup(s.linesGroup)

    const pts = makeFibonacciPoints(n)

    // Coloured point spheres (full rainbow)
    pts.forEach((p, i) => {
      const t = n > 1 ? i / (n - 1) : 0.5
      const col = rainbow(t)
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.038, 10, 8),
        new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: 0.3, shininess: 100 })
      )
      mesh.position.copy(p)
      s.pointsGroup.add(mesh)
    })

    if (pts.length >= 2) {
      if (showArcs) {
        // Geodesic arcs along sphere surface with per-vertex rainbow colours
        const ARC_SEG = 16
        const allPts: THREE.Vector3[] = []
        const allCols: number[] = []

        for (let i = 0; i < pts.length - 1; i++) {
          const t1 = i / (pts.length - 1)
          const t2 = (i + 1) / (pts.length - 1)
          const col1 = rainbow(t1), col2 = rainbow(t2)
          const arc = geodesicArc(pts[i].clone().normalize(), pts[i + 1].clone().normalize(), ARC_SEG)
          const startJ = i === 0 ? 0 : 1 // skip duplicate endpoint
          arc.slice(startJ).forEach((pt, j) => {
            const tArc = (j + (i === 0 ? 0 : 1)) / ARC_SEG
            const col = col1.clone().lerp(col2, tArc)
            allPts.push(pt.clone())
            allCols.push(col.r, col.g, col.b)
          })
        }

        const geo = new THREE.BufferGeometry().setFromPoints(allPts)
        geo.setAttribute('color', new THREE.Float32BufferAttribute(allCols, 3))
        s.linesGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 })))
      } else {
        // Fallback: straight chord segments, single colour
        const posArr: number[] = []
        for (let i = 0; i < pts.length - 1; i++) {
          posArr.push(pts[i].x, pts[i].y, pts[i].z, pts[i+1].x, pts[i+1].y, pts[i+1].z)
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3))
        s.linesGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x4488cc, transparent: true, opacity: 0.45 })))
      }
    }
  }, [n, showArcs])

  useEffect(() => { if (sceneRef.current) sceneRef.current.controls.autoRotate = autoRotate }, [autoRotate])

  const exportJSON = useCallback(() => {
    const data = makeFibonacciPoints(n).map(p => ({ x: +p.x.toFixed(7), y: +p.y.toFixed(7), z: +p.z.toFixed(7) }))
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `fibonacci_sphere_n${n}.json`; a.click()
    URL.revokeObjectURL(url)
  }, [n])

  const btnCls = (active: boolean) => `px-2.5 py-1 text-xs rounded border transition-colors ${active ? 'border-blue-600 text-blue-400 bg-blue-900/30' : 'border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-200'}`

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 shrink-0 flex-wrap gap-y-1.5 bg-gray-950 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-gray-400 whitespace-nowrap">Points N</span>
          <input type="range" min={3} max={200} value={n} onChange={e => setN(+e.target.value)} className="w-32 md:w-44 accent-blue-500" />
          <span className="font-mono text-blue-300 w-8 text-right tabular-nums">{n}</span>
        </label>

        <div className="flex items-center gap-1.5">
          <span className="text-gray-600">φ =</span>
          <span className="font-mono text-amber-400 tabular-nums">{GOLDEN_ANGLE_DEG.toFixed(4)}°</span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button onClick={() => setShowArcs(v => !v)} className={btnCls(showArcs)}>
            {showArcs ? '⌒ Arcs' : '— Chords'}
          </button>
          <button onClick={() => setAutoRotate(v => !v)} className={btnCls(autoRotate)}>
            {autoRotate ? '⏸ Pause' : '▶ Rotate'}
          </button>
          <button onClick={exportJSON} className="px-2.5 py-1 text-xs rounded border border-gray-600 text-gray-400 hover:border-emerald-600 hover:text-emerald-400 transition-colors">
            ↓ JSON
          </button>
        </div>
      </div>
      <div ref={mountRef} className="flex-1 min-h-0" />
    </div>
  )
}
