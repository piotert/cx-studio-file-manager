'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

interface JsonMaterial {
  DbgIndex?: number
  DbgName?: string
  colorDiffuse?: number[]
  colorSpecular?: number[]
  specularCoef?: number
  opacity?: number
}

export interface ThreeGeometryJson {
  metadata?: { formatVersion?: number; generatedBy?: string }
  materials?: JsonMaterial[]
  vertices: number[]
  normals?: number[]
  colors?: number[]
  uvs?: number[][]
  faces: number[]
}

// Parses Three.js legacy geometry format v3 (THREE.JSONLoader format)
// Face bitmask: bit0=quad, bit1=material, bit2=faceUV, bit3=vertexUV,
//               bit4=faceNormal, bit5=vertexNormals, bit6=faceColor, bit7=vertexColors
function parseGeometry(json: ThreeGeometryJson): THREE.BufferGeometry {
  const QUAD             = 0x01
  const HAS_MATERIAL     = 0x02
  const HAS_FACE_UV      = 0x04
  const HAS_VERTEX_UV    = 0x08
  const HAS_FACE_NORMAL  = 0x10
  const HAS_VERTEX_NRM   = 0x20
  const HAS_FACE_COLOR   = 0x40
  const HAS_VERTEX_CLR   = 0x80

  const verts    = json.vertices
  const normals  = json.normals ?? []
  const uvSets   = json.uvs ?? ([] as number[][])
  const nUvSets  = uvSets.length
  const facesArr = json.faces
  const numMats  = Math.max(1, json.materials?.length ?? 1)

  const buckets: { pos: number[]; uv: number[]; nrm: number[] }[] =
    Array.from({ length: numMats }, () => ({ pos: [], uv: [], nrm: [] }))

  let i = 0
  while (i < facesArr.length) {
    const type     = facesArr[i++]
    const isQuad   = !!(type & QUAD)
    const hasMat   = !!(type & HAS_MATERIAL)
    const hasVUv   = !!(type & HAS_VERTEX_UV)
    const hasFNrm  = !!(type & HAS_FACE_NORMAL)
    const nVerts   = isQuad ? 4 : 3

    const vi: number[] = []
    for (let v = 0; v < nVerts; v++) vi.push(facesArr[i++])

    let matIdx = 0
    if (hasMat) matIdx = facesArr[i++]

    // face UV: one UV index per UV set (skip)
    if (type & HAS_FACE_UV) i += nUvSets

    // vertex UV: nUvSets × nVerts indices
    const uvIdx: number[][] = []
    if (hasVUv) {
      for (let s = 0; s < nUvSets; s++) {
        const set: number[] = []
        for (let v = 0; v < nVerts; v++) set.push(facesArr[i++])
        uvIdx.push(set)
      }
    }

    // face normal index (one per triangle, applied to all 3 vertices)
    let faceNormalIdx = 0
    if (hasFNrm) faceNormalIdx = facesArr[i++]

    if (type & HAS_VERTEX_NRM)  i += nVerts
    if (type & HAS_FACE_COLOR)  i++
    if (type & HAS_VERTEX_CLR)  i += nVerts

    const bucket = buckets[matIdx] ?? buckets[0]
    const tris = isQuad ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]]

    for (const tri of tris) {
      for (const lv of tri) {
        const gv = vi[lv]
        bucket.pos.push(verts[gv * 3], verts[gv * 3 + 1], verts[gv * 3 + 2])

        if (hasVUv && uvIdx.length > 0) {
          const ui   = uvIdx[0][lv]
          const uvSet = uvSets[0]
          bucket.uv.push(
            ui * 2 + 1 < uvSet.length ? uvSet[ui * 2]     : 0,
            ui * 2 + 1 < uvSet.length ? uvSet[ui * 2 + 1] : 0,
          )
        } else {
          bucket.uv.push(0, 0)
        }

        // Per-face normal (same for all 3 vertices of the triangle)
        if (hasFNrm && normals.length > 0) {
          const ni = faceNormalIdx * 3
          bucket.nrm.push(
            ni + 2 < normals.length ? normals[ni]     : 0,
            ni + 2 < normals.length ? normals[ni + 1] : 0,
            ni + 2 < normals.length ? normals[ni + 2] : 0,
          )
        }
      }
    }
  }

  const allPos: number[] = []
  const allUv: number[]  = []
  const allNrm: number[] = []
  const groups: { start: number; count: number; mat: number }[] = []
  let offset = 0

  for (let m = 0; m < numMats; m++) {
    const b = buckets[m]
    if (b.pos.length === 0) continue
    const count = b.pos.length / 3
    groups.push({ start: offset, count, mat: m })
    for (let j = 0; j < b.pos.length; j++) allPos.push(b.pos[j])
    for (let j = 0; j < b.uv.length;  j++) allUv.push(b.uv[j])
    for (let j = 0; j < b.nrm.length; j++) allNrm.push(b.nrm[j])
    offset += count
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3))
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(allUv, 2))

  // Use per-face normals if available (typ 18), otherwise compute from geometry (typ 10)
  if (allNrm.length > 0) {
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(allNrm, 3))
  } else {
    geo.computeVertexNormals()
  }

  for (const g of groups) geo.addGroup(g.start, g.count, g.mat)
  return geo
}

function buildMaterials(json: ThreeGeometryJson): THREE.Material[] {
  if (!json.materials?.length) {
    return [new THREE.MeshPhongMaterial({ color: 0x888888, side: THREE.DoubleSide })]
  }
  return json.materials.map((m) => {
    const cd = m.colorDiffuse
    const cs = m.colorSpecular
    return new THREE.MeshPhongMaterial({
      color:     cd ? new THREE.Color(cd[0] ?? 0.8, cd[1] ?? 0.8, cd[2] ?? 0.8) : 0x888888,
      specular:  cs ? new THREE.Color(cs[0] ?? 0.9, cs[1] ?? 0.9, cs[2] ?? 0.9) : 0xe4e4e4,
      shininess: m.specularCoef ?? 10,
      side:      THREE.DoubleSide,
    })
  })
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

export default function ThreeJsonViewer({
  data,
  onSwitchToText,
}: {
  data: ThreeGeometryJson
  onSwitchToText?: () => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [showEdges, setShowEdges] = useState(false)
  const [showMesh,  setShowMesh]  = useState(false)
  const [edgesColor, setEdgesColor] = useState('#999999')
  const [meshColor,  setMeshColor]  = useState('#00aaff')
  const [lineWidth,  setLineWidth]  = useState(1)
  const [bgColor, setBgColor] = useState<'dark' | 'light' | 'black' | 'blue' | 'grey'>('dark')

  const bgColors = {
    dark:  0x1a1a2e,
    light: 0xf0f0f0,
    black: 0x000000,
    blue:  0x1a2a4e,
    grey:  0x2a2a2a,
  }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const w0 = mount.clientWidth  || 400
    const h0 = mount.clientHeight || 400

    // All LineMaterials created in this effect run — updated on resize
    const lineMats: LineMaterial[] = []

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w0, h0)
    renderer.setPixelRatio(window.devicePixelRatio)
    mount.appendChild(renderer.domElement)

    const scene  = new THREE.Scene()
    scene.background = new THREE.Color(bgColors[bgColor])

    const camera   = new THREE.PerspectiveCamera(45, w0 / h0, 0.001, 1000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth
      const nh = mount.clientHeight
      if (nw > 0 && nh > 0) {
        renderer.setSize(nw, nh)
        camera.aspect = nw / nh
        camera.updateProjectionMatrix()
        lineMats.forEach((m) => m.resolution.set(nw, nh))
      }
    })
    ro.observe(mount)

    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(5, 10, 5)
    scene.add(dir)

    let geometry: THREE.BufferGeometry | null = null
    let materials: THREE.Material[] = []
    let edgesLine: LineSegments2 | null = null
    let meshLine:  LineSegments2 | null = null

    try {
      geometry  = parseGeometry(data)
      materials = buildMaterials(data)
      const mesh = new THREE.Mesh(geometry, materials)

      geometry.computeBoundingBox()
      const box    = geometry.boundingBox!
      const center = box.getCenter(new THREE.Vector3())
      const size   = box.getSize(new THREE.Vector3()).length()

      mesh.position.sub(center)
      camera.position.set(0, size * 0.4, size * 1.2)
      controls.target.set(0, 0, 0)
      controls.update()
      scene.add(mesh)

      if (showEdges && geometry) {
        const src = new THREE.EdgesGeometry(geometry, 30)
        edgesLine = makeLineSegments2(src, edgesColor, lineWidth, 1.0, w0, h0)
        src.dispose()
        lineMats.push(edgesLine.material as LineMaterial)
        edgesLine.position.copy(mesh.position)
        scene.add(edgesLine)
      }

      if (showMesh && geometry) {
        const src = new THREE.WireframeGeometry(geometry)
        meshLine = makeLineSegments2(src, meshColor, lineWidth, 0.4, w0, h0)
        src.dispose()
        lineMats.push(meshLine.material as LineMaterial)
        meshLine.position.copy(mesh.position)
        scene.add(meshLine)
      }
    } catch (err) {
      console.error('ThreeJsonViewer parse error:', err)
    }

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
      geometry?.dispose()
      materials.forEach((m) => m.dispose())
      lineMats.forEach((m) => m.dispose())
      edgesLine?.geometry.dispose()
      meshLine?.geometry.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [data, showEdges, showMesh, edgesColor, meshColor, lineWidth, bgColor])

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex gap-1 flex-wrap items-center p-2 shrink-0 bg-gray-900 border-b border-gray-800">

        {/* Switch to JSON text */}
        {onSwitchToText && (
          <button
            onClick={onSwitchToText}
            className="px-3 py-1 rounded text-sm font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
          >
            JSON
          </button>
        )}

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

      {/* Canvas */}
      <div ref={mountRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
