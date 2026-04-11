'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export default function GltfViewer({ url }: { url: string }) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const width = mount.clientWidth
    const height = mount.clientHeight || 500

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(window.devicePixelRatio)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000)
    camera.position.set(0, 1, 3)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(5, 10, 5)
    scene.add(dir)

    const loader = new GLTFLoader()
    loader.load(url, (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3()).length()
      gltf.scene.position.sub(center)
      camera.position.set(0, size * 0.4, size * 1.2)
      controls.target.set(0, 0, 0)
      controls.update()
      scene.add(gltf.scene)
    })

    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(animId)
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [url])

  return <div ref={mountRef} className="w-full rounded overflow-hidden" style={{ height: 500 }} />
}
