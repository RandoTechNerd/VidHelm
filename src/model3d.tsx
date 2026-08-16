// 3D Studio: import an STL / 3MF / OBJ (the maker formats), pose it in a live viewer,
// then render a spinning turntable clip or a still straight into the media bin.
// Rendering happens on the WebGL canvas via MediaRecorder; main converts webm → mp4.
import { useState, useRef, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'

const FINISHES = {
  matte: { roughness: 0.9, metalness: 0.0 },
  satin: { roughness: 0.45, metalness: 0.05 },
  glossy: { roughness: 0.15, metalness: 0.1 },
  metal: { roughness: 0.35, metalness: 0.9 },
} as const
type Finish = keyof typeof FINISHES

const W = 1600, H = 900   // internal render buffer (downscaled by CSS in the modal)

export function Model3DModal({ open, onClose, initialPath, onRendered }: {
  open: boolean; onClose: () => void
  initialPath: string | null
  onRendered: (path: string, kind: 'video' | 'image', name: string) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera
    controls: OrbitControls; pivot: THREE.Group; raf: number
  } | null>(null)
  const [modelName, setModelName] = useState('')
  const [hasOwnMaterials, setHasOwnMaterials] = useState(false)
  const [color, setColor] = useState('#f472b6')
  const [override, setOverride] = useState(false)
  const [finish, setFinish] = useState<Finish>('satin')
  const [bg, setBg] = useState('#0f1420')
  const [zUp, setZUp] = useState(false)
  const [spin, setSpin] = useState(true)
  const [seconds, setSeconds] = useState(6)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Drop an STL, 3MF or OBJ here — or click Open model.')
  const recState = useRef<{ start: number; baseRot: number; rec: MediaRecorder } | null>(null)
  const spinRef = useRef(spin); spinRef.current = spin
  const zUpRef = useRef(zUp); zUpRef.current = zUp

  // ---- scene lifecycle ----
  useEffect(() => {
    if (!open || !hostRef.current) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setSize(W, H, false)
    renderer.domElement.className = 'm3d-canvas'
    hostRef.current.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, W / H, 0.05, 100)
    camera.position.set(2.6, 1.6, 2.6)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x30281e, 1.15))
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(4, 6, 3); scene.add(key)
    const rim = new THREE.DirectionalLight(0x9db8ff, 0.9); rim.position.set(-5, 3, -4); scene.add(rim)
    const pivot = new THREE.Group()
    scene.add(pivot)
    const clock = new THREE.Clock()
    const tick = () => {
      const dt = clock.getDelta()
      const st = threeRef.current
      if (!st) return
      if (recState.current) {
        const { start, baseRot, rec } = recState.current
        const el = (performance.now() - start) / 1000
        st.pivot.rotation.y = baseRot + (el / secondsRef.current) * Math.PI * 2
        if (el >= secondsRef.current && rec.state === 'recording') rec.stop()
      } else if (spinRef.current) st.pivot.rotation.y += dt * 0.5
      st.controls.update()
      st.renderer.render(st.scene, st.camera)
      st.raf = requestAnimationFrame(tick)
    }
    threeRef.current = { renderer, scene, camera, controls, pivot, raf: 0 }
    threeRef.current.raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(threeRef.current?.raf || 0)
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      threeRef.current = null
    }
  }, [open])
  const secondsRef = useRef(seconds); secondsRef.current = seconds

  // background + material live-apply
  useEffect(() => { if (threeRef.current) threeRef.current.scene.background = new THREE.Color(bg) }, [bg, open, modelName])
  useEffect(() => {
    const st = threeRef.current
    if (!st) return
    st.pivot.rotation.x = zUp ? -Math.PI / 2 : 0
    st.pivot.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return
      if (!hasOwnMaterials || override) {
        const m = o.material as THREE.MeshStandardMaterial
        if (m?.isMaterial && (m as any).color) { m.color.set(color); Object.assign(m, FINISHES[finish]) }
      }
    })
  }, [color, finish, override, zUp, modelName, hasOwnMaterials])

  // ---- loading ----
  const loadModel = useCallback(async (path: string) => {
    const st = threeRef.current
    if (!st) return
    setStatus('Loading model…')
    try {
      const ext = (path.split('.').pop() || '').toLowerCase()
      const url = 'file:///' + path.replace(/\\/g, '/').split('/').map((s, i) => i === 0 ? s : encodeURIComponent(s)).join('/')
      st.pivot.clear()
      let obj: THREE.Object3D
      let own = false
      if (ext === 'stl') {
        const geo = await new STLLoader().loadAsync(url)
        geo.computeVertexNormals()
        obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, ...FINISHES[finish] }))
      } else if (ext === '3mf') {
        obj = await new ThreeMFLoader().loadAsync(url); own = true
      } else if (ext === 'obj') {
        obj = await new OBJLoader().loadAsync(url); own = true
      } else { setStatus(`Unsupported file: .${ext} (STL, 3MF or OBJ)`); return }
      obj.traverse(o => { if (o instanceof THREE.Mesh && !(o.material as any)?.isMeshStandardMaterial && !own) o.material = new THREE.MeshStandardMaterial({ color }) })
      // center on origin and normalize size so every model fills the frame the same way
      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3())
      const scale = 2 / Math.max(size.x, size.y, size.z, 0.0001)
      obj.position.sub(center).multiplyScalar(scale)
      obj.scale.setScalar(scale)
      st.pivot.add(obj)
      const isZUp = ext === 'stl' || ext === '3mf'   // print formats are Z-up; OBJ is usually Y-up
      setZUp(isZUp)
      st.pivot.rotation.set(isZUp ? -Math.PI / 2 : 0, 0, 0)
      setHasOwnMaterials(own)
      setModelName((path.split(/[\\/]/).pop() || 'model').replace(/\.[^.]+$/, ''))
      setStatus(`Loaded ${path.split(/[\\/]/).pop()} — drag to orbit, scroll to zoom.`)
    } catch (e) { console.error(e); setStatus('Could not load that file: ' + String(e)) }
  }, [color, finish])

  useEffect(() => { if (open && initialPath) loadModel(initialPath) }, [open, initialPath])  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- outputs ----
  const recordTurntable = () => {
    const st = threeRef.current
    if (!st || !modelName) return
    const stream = st.renderer.domElement.captureStream(30)
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || ''
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 14_000_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = async () => {
      recState.current = null
      setRecording(false)
      setBusy(true); setStatus('Encoding mp4…')
      try {
        const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...Array.from(buf.subarray(i, i + 0x8000)))
        const r = await window.ipcRenderer.save3DRender({ base64: btoa(bin), name: modelName })
        if (r.path) { setStatus('Turntable added to the Media Bin ✓'); onRendered(r.path, 'video', `${modelName} spin`) }
        else setStatus(r.error || 'encode failed')
      } catch (e) { setStatus(String(e)) }
      setBusy(false)
    }
    recState.current = { start: performance.now(), baseRot: st.pivot.rotation.y, rec }
    setRecording(true)
    setStatus(`Recording ${seconds}s turntable…`)
    rec.start()
  }

  const snapshot = async () => {
    const st = threeRef.current
    if (!st || !modelName) return
    setBusy(true); setStatus('Saving still…')
    st.renderer.render(st.scene, st.camera)
    const r = await window.ipcRenderer.save3DStill({ dataUrl: st.renderer.domElement.toDataURL('image/png'), name: modelName })
    if (r.path) { setStatus('Still added to the Media Bin ✓'); onRendered(r.path, 'image', `${modelName} still`) }
    else setStatus(r.error || 'save failed')
    setBusy(false)
  }

  const exportObj = async () => {
    const st = threeRef.current
    if (!st || !modelName) return
    setBusy(true); setStatus('Converting to OBJ…')
    try {
      const text = new OBJExporter().parse(st.pivot)
      const r = await window.ipcRenderer.saveObjFile({ text, defaultName: `${modelName}.obj` })
      setStatus(r.path ? `Saved ${r.path.split(/[\\/]/).pop()} ✓` : (r.error || 'save canceled'))
    } catch (e) { setStatus(String(e)) }
    setBusy(false)
  }

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal m3d-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>🧊 3D Studio</h2><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="m3d-stage" ref={hostRef}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadModel(window.ipcRenderer.getPathForFile(f)) }}>
            {!modelName && <div className="m3d-empty">Drop an STL / 3MF / OBJ</div>}
          </div>
          <p className="hint" style={{ margin: '6px 0' }}>{status}</p>
          <div className="m3d-controls">
            <button onClick={async () => { const p = await window.ipcRenderer.pickModel(); if (p) loadModel(p) }}>Open model…</button>
            <label>Color <input type="color" value={color} onChange={e => { setColor(e.target.value); if (hasOwnMaterials) setOverride(true) }} /></label>
            <label>Finish
              <select value={finish} onChange={e => setFinish(e.target.value as Finish)}>
                <option value="matte">Matte</option><option value="satin">Satin</option><option value="glossy">Glossy</option><option value="metal">Metal</option>
              </select>
            </label>
            <label>Backdrop <input type="color" value={bg} onChange={e => setBg(e.target.value)} /></label>
            {hasOwnMaterials && <label className="switch" title="3MF/OBJ files carry their own colors — tick to recolor"><input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} /> recolor</label>}
            <label className="switch" title="STL/3MF prints are Z-up; untick if the model lies on its side"><input type="checkbox" checked={zUp} onChange={e => setZUp(e.target.checked)} /> Z-up</label>
            <label className="switch"><input type="checkbox" checked={spin} onChange={e => setSpin(e.target.checked)} /> idle spin</label>
          </div>
        </div>
        <div className="modal-foot m3d-foot">
          <label>Turntable
            <select value={seconds} onChange={e => setSeconds(parseInt(e.target.value))}>
              <option value="3">3s</option><option value="6">6s</option><option value="10">10s</option><option value="15">15s</option>
            </select>
          </label>
          <button className="primary" disabled={!modelName || recording || busy} onClick={recordTurntable}>{recording ? 'Recording…' : '⏺ Render turntable clip'}</button>
          <button disabled={!modelName || recording || busy} onClick={snapshot}>📷 Still</button>
          <button disabled={!modelName || recording || busy} onClick={exportObj} title="Convert the loaded model to .obj">Save as OBJ…</button>
        </div>
      </div>
    </div>
  )
}
