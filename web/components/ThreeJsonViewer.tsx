'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

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
  const uvSets   = json.uvs ?? ([] as number[][])
  const nUvSets  = uvSets.length
  const facesArr = json.faces
  const numMats  = Math.max(1, json.materials?.length ?? 1)

  const buckets: { pos: number[]; uv: number[] }[] =
    Array.from({ length: numMats }, () => ({ pos: [], uv: [] }))

  let i = 0
  while (i < facesArr.length) {
    const type     = facesArr[i++]
    const isQuad   = !!(type & QUAD)
    const hasMat   = !!(type & HAS_MATERIAL)
    const hasVUv   = !!(type & HAS_VERTEX_UV)
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

    if (type & HAS_FACE_NORMAL) i++
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
      }
    }
  }

  const allPos: number[] = []
  const allUv: number[]  = []
  const groups: { start: number; count: number; mat: number }[] = []
  let offset = 0

  for (let m = 0; m < numMats; m++) {
    const b = buckets[m]
    if (b.pos.length === 0) continue
    const count = b.pos.length / 3
    groups.push({ start: offset, count, mat: m })
    for (let j = 0; j < b.pos.length; j++) allPos.push(b.pos[j])
    for (let j = 0; j < b.uv.length;  j++) allUv.push(b.uv[j])
    offset += count
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3))
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(allUv, 2))
  for (const g of groups) geo.addGroup(g.start, g.count, g.mat)
  geo.computeVertexNormals()
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

export default function ThreeJsonViewer({ data }: { data: ThreeGeometryJson }) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const width  = mount.clientWidth
    const height = 500

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(window.devicePixelRatio)
    mount.appendChild(renderer.domElement)

    const scene  = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    const camera   = new THREE.PerspectiveCamera(45, width / height, 0.001, 1000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(5, 10, 5)
    scene.add(dir)

    let geometry: THREE.BufferGeometry | null = null
    let materials: THREE.Material[] = []

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
      cancelAnimationFrame(animId)
      geometry?.dispose()
      materials.forEach((m) => m.dispose())
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [data])

  return <div ref={mountRef} className="w-full rounded overflow-hidden" style={{ height: 500 }} />
}
