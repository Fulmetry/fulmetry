// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Box, Focus, MessageSquareText, Rotate3D, ScanLine } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { elementId, titleCase } from "../lib/utils";
import { canCopyComponentMoveFeedback, componentMoveFeedbackPrompt, resolveComponentFeedbackSelection, type ComponentFeedbackSelection } from "../lib/component-feedback";
import type { CircuitElement } from "../types";
import { Badge, Button, EmptyState } from "./ui";

interface BoardDimensions { width: number; height: number; thickness: number; x: number; y: number }

const glbCache = new Map<string, Promise<THREE.Group>>();

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function position(element: CircuitElement): { x: number; y: number } | undefined {
  const center = element.center && typeof element.center === "object" ? element.center as Record<string, unknown> : undefined;
  const x = finite(center?.x ?? element.x, Number.NaN);
  const y = finite(center?.y ?? element.y, Number.NaN);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function position3(element: CircuitElement): THREE.Vector3 | undefined {
  const record = element.position && typeof element.position === "object" ? element.position as Record<string, unknown> : undefined;
  const x = finite(record?.x, Number.NaN);
  const y = finite(record?.y, Number.NaN);
  const z = finite(record?.z, Number.NaN);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? new THREE.Vector3(x, y, z) : undefined;
}

function boardDimensions(circuit: readonly CircuitElement[]): BoardDimensions | undefined {
  const board = circuit.find(({ type }) => type === "pcb_board");
  if (!board) return undefined;
  const center = position(board) ?? { x: 0, y: 0 };
  return { width: finite(board.width, 40), height: finite(board.height, 30), thickness: finite(board.thickness, 1.6), ...center };
}

function sceneSelection(circuit: readonly CircuitElement[], element: CircuitElement): ComponentFeedbackSelection {
  return {
    id: elementId(element),
    ...resolveComponentFeedbackSelection(circuit, {
      type: element.type,
      ...(typeof element.pcb_component_id === "string" ? { pcbComponentId: element.pcb_component_id } : {}),
      ...(typeof element.source_component_id === "string" ? { sourceComponentId: element.source_component_id } : {}),
      ...(typeof element.layer === "string" ? { layer: element.layer } : {}),
    }),
  };
}

function material(color: number, options: { metal?: boolean; transparent?: boolean; opacity?: number } = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness: options.metal ? 0.72 : 0.08, roughness: options.metal ? 0.28 : 0.68, ...(options.transparent === undefined ? {} : { transparent: options.transparent }), ...(options.opacity === undefined ? {} : { opacity: options.opacity }) });
}

function addMesh(scene: THREE.Scene, geometry: THREE.BufferGeometry, meshMaterial: THREE.Material, at: THREE.Vector3, data: Record<string, unknown>, rotation = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, meshMaterial);
  mesh.position.copy(at);
  mesh.rotation.z = rotation * Math.PI / 180;
  mesh.userData = data;
  scene.add(mesh);
  return mesh;
}

function addOutline(mesh: THREE.Mesh, color: number, opacity = 0.72): void {
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, 24),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  outline.userData = mesh.userData;
  mesh.add(outline);
}

function createBoardScene(scene: THREE.Scene, circuit: readonly CircuitElement[], board: BoardDimensions): THREE.Object3D[] {
  const selectable: THREE.Object3D[] = [];
  const boardElement = circuit.find(({ type }) => type === "pcb_board")!;
  const boardMesh = addMesh(scene, new THREE.BoxGeometry(board.width, board.height, board.thickness), new THREE.MeshBasicMaterial({ color: 0x22a879 }), new THREE.Vector3(board.x, board.y, 0), { type: "pcb_board", id: elementId(boardElement) });
  addOutline(boardMesh, 0x55d9ba, 0.8);
  selectable.push(boardMesh);

  const copper = material(0xd89c45, { metal: true });
  const componentBody = material(0x202733);
  const throughHole = material(0xd6a34f, { metal: true });
  const modelBackedComponents = new Set(circuit.filter(({ type, model_glb_url }) => type === "cad_component" && typeof model_glb_url === "string").map(({ pcb_component_id }) => pcb_component_id));
  for (const element of circuit) {
    const at = position(element);
    if (!at) continue;
    const id = elementId(element);
    const layer = typeof element.layer === "string" ? element.layer : "top";
    const top = layer !== "bottom";
    const surfaceZ = top ? board.thickness / 2 + 0.035 : -board.thickness / 2 - 0.035;
    if (element.type === "pcb_smtpad") {
      const width = finite(element.width, finite(element.radius, 0.45) * 2);
      const height = finite(element.height, finite(element.radius, 0.45) * 2);
      const shape = element.shape === "circle" ? new THREE.CylinderGeometry(width / 2, width / 2, 0.07, 24) : new THREE.BoxGeometry(width, height, 0.07);
      if (element.shape === "circle") shape.rotateX(Math.PI / 2);
      const mesh = addMesh(scene, shape, copper, new THREE.Vector3(at.x, at.y, surfaceZ), sceneSelection(circuit, element), finite(element.rotation ?? element.pcb_rotation, 0));
      addOutline(mesh, 0xffd38a);
      selectable.push(mesh);
    } else if (element.type === "pcb_plated_hole" || element.type === "pcb_via") {
      const diameter = finite(element.outer_diameter ?? element.diameter, element.type === "pcb_via" ? 0.65 : 1.2);
      const mesh = addMesh(scene, new THREE.CylinderGeometry(diameter / 2, diameter / 2, board.thickness + 0.12, 24), throughHole, new THREE.Vector3(at.x, at.y, 0), sceneSelection(circuit, element));
      mesh.rotation.x = Math.PI / 2;
      selectable.push(mesh);
    } else if (element.type === "pcb_component") {
      if (modelBackedComponents.has(element.pcb_component_id)) continue;
      const width = Math.max(0.7, finite(element.width, 2.4));
      const height = Math.max(0.7, finite(element.height, 1.6));
      const bodyHeight = Math.max(0.45, finite(element.size_z, Math.min(width, height) * 0.55));
      const z = top ? board.thickness / 2 + bodyHeight / 2 + 0.09 : -board.thickness / 2 - bodyHeight / 2 - 0.09;
      const mesh = addMesh(scene, new THREE.BoxGeometry(width, height, bodyHeight), componentBody, new THREE.Vector3(at.x, at.y, z), sceneSelection(circuit, element), finite(element.rotation ?? element.pcb_rotation, 0));
      addOutline(mesh, 0x94a3b8, 0.88);
      selectable.push(mesh);
    }
  }

  for (const trace of circuit.filter(({ type }) => type === "pcb_trace")) {
    const route = Array.isArray(trace.route) ? trace.route : [];
    const points = route.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const x = finite(record.x, Number.NaN);
      const y = finite(record.y, Number.NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y) || record.route_type === "via") return [];
      const layer = typeof record.layer === "string" ? record.layer : "top";
      return [new THREE.Vector3(x, y, layer === "bottom" ? -board.thickness / 2 - 0.075 : board.thickness / 2 + 0.075)];
    });
    if (points.length < 2) continue;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xe2a94f }));
    line.userData = { type: trace.type, id: elementId(trace) };
    scene.add(line);
    selectable.push(line);
  }

  const grid = new THREE.GridHelper(Math.max(board.width, board.height) * 2.2, 20, 0x164e63, 0x1e293b);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(board.x, board.y, -board.thickness / 2 - 0.7);
  scene.add(grid);
  scene.add(new THREE.AxesHelper(Math.max(board.width, board.height) * 0.12));
  return selectable;
}

function loadGlb(url: string): Promise<THREE.Group> {
  let pending = glbCache.get(url);
  if (pending === undefined) {
    pending = new GLTFLoader().loadAsync(url).then(({ scene }) => scene);
    glbCache.set(url, pending);
  }
  return pending;
}

async function addCadModels(
  scene: THREE.Scene,
  circuit: readonly CircuitElement[],
  selectable: THREE.Object3D[],
  disposed: () => boolean,
): Promise<{ loaded: number; failed: readonly string[] }> {
  const pcbComponents = new Map(circuit.filter(({ type }) => type === "pcb_component").map((element) => [element.pcb_component_id, element]));
  const models = circuit.filter(({ type, model_glb_url }) => type === "cad_component" && typeof model_glb_url === "string");
  const results = await Promise.all(models.map(async (cad) => {
    const url = String(cad.model_glb_url);
    try {
      const prototype = await loadGlb(url);
      if (disposed()) return { url, loaded: false, disposed: true } as const;
      const model = prototype.clone(true);
      const at = position3(cad);
      if (at === undefined) throw new Error("CAD position is missing");
      model.position.copy(at);
      const rotation = cad.rotation && typeof cad.rotation === "object" ? cad.rotation as Record<string, unknown> : undefined;
      model.rotation.order = "XYZ";
      model.rotation.set(
        THREE.MathUtils.degToRad(finite(rotation?.x, 0)),
        THREE.MathUtils.degToRad(finite(rotation?.y, 0)),
        THREE.MathUtils.degToRad(finite(rotation?.z, 0)),
      );
      const scale = finite(cad.model_unit_to_mm_scale_factor, 1);
      model.scale.setScalar(scale);
      const pcb = pcbComponents.get(cad.pcb_component_id);
      const data = pcb === undefined ? { type: cad.type, id: elementId(cad) } : sceneSelection(circuit, pcb);
      model.userData = data;
      model.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.userData = data;
          selectable.push(child);
        }
      });
      scene.add(model);
      return { url, loaded: true, disposed: false } as const;
    } catch {
      return { url, loaded: false, disposed: false } as const;
    }
  }));
  return {
    loaded: results.filter(({ loaded }) => loaded).length,
    failed: Object.freeze(results.filter(({ loaded, disposed: wasDisposed }) => !loaded && !wasDisposed).map(({ url }) => url)),
  };
}

export default function Board3D({ circuit }: { circuit: readonly CircuitElement[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const dimensions = useMemo(() => boardDimensions(circuit), [circuit]);
  const sceneObjects = useMemo(() => circuit.filter(({ type }) => type === "pcb_component").map((element) => sceneSelection(circuit, element)), [circuit]);
  const [selected, setSelected] = useState<ComponentFeedbackSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelState, setModelState] = useState<{ loaded: number; total: number; failed: readonly string[] }>({ loaded: 0, total: 0, failed: [] });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !dimensions) return;
    let animation = 0;
    let disposed = false;
    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x080b0a);
      scene.fog = new THREE.FogExp2(0x080b0a, 0.004);
      const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 2_000);
      camera.up.set(0, 0, 1);
      const distance = Math.max(dimensions.width, dimensions.height) * 1.45;
      camera.position.set(dimensions.x + distance * 0.72, dimensions.y - distance * 0.72, distance * 0.66);
      camera.lookAt(dimensions.x, dimensions.y, 0);
      cameraRef.current = camera;
      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.55;
      host.replaceChildren(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.target.set(dimensions.x, dimensions.y, 0);
      controls.minDistance = Math.max(dimensions.thickness * 2, 1);
      controls.maxDistance = Math.max(dimensions.width, dimensions.height) * 12;
      controls.saveState();
      controlsRef.current = controls;
      scene.add(new THREE.HemisphereLight(0xe8f7ff, 0x243147, 3.2));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
      keyLight.position.set(dimensions.x + distance, dimensions.y - distance, distance * 1.4);
      scene.add(keyLight);
      const rimLight = new THREE.DirectionalLight(0x67e8f9, 1.3);
      rimLight.position.set(dimensions.x - distance, dimensions.y + distance, distance * 0.7);
      scene.add(rimLight);
      const selectable = createBoardScene(scene, circuit, dimensions);
      const totalModels = circuit.filter(({ type, model_glb_url }) => type === "cad_component" && typeof model_glb_url === "string").length;
      setModelState({ loaded: 0, total: totalModels, failed: [] });
      void addCadModels(scene, circuit, selectable, () => disposed).then(({ loaded, failed }) => {
        if (disposed) return;
        setModelState({ loaded, total: totalModels, failed });
        host.dataset.fulmetryLoadedModels = String(loaded);
        host.dataset.fulmetryFailedModels = String(failed.length);
      });
      const resize = () => {
        const width = Math.max(host.clientWidth, 1);
        const height = Math.max(host.clientHeight, 1);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();
      const raycaster = new THREE.Raycaster();
      raycaster.params.Line!.threshold = Math.max(dimensions.width, dimensions.height) / 200;
      const pointer = new THREE.Vector2();
      let pointerDown = { x: 0, y: 0 };
      const down = (event: PointerEvent) => { pointerDown = { x: event.clientX, y: event.clientY }; };
      const click = (event: PointerEvent) => {
        if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4) return;
        const bounds = renderer.domElement.getBoundingClientRect();
        pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        setSelected((raycaster.intersectObjects(selectable, false)[0]?.object.userData as ComponentFeedbackSelection | undefined) ?? null);
      };
      renderer.domElement.addEventListener("pointerdown", down);
      renderer.domElement.addEventListener("click", click);
      const render = () => {
        controls.update();
        renderer.render(scene, camera);
        host.dataset.fulmetrySceneObjects = String(scene.children.length);
        host.dataset.fulmetryRenderCalls = String(renderer.info.render.calls);
        host.dataset.fulmetryRenderTriangles = String(renderer.info.render.triangles);
        animation = requestAnimationFrame(render);
      };
      render();
      return () => {
        disposed = true;
        cancelAnimationFrame(animation);
        observer.disconnect();
        renderer.domElement.removeEventListener("pointerdown", down);
        renderer.domElement.removeEventListener("click", click);
        controls.dispose();
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
            object.geometry.dispose();
            for (const current of Array.isArray(object.material) ? object.material : [object.material]) current.dispose();
          }
        });
        renderer.dispose();
        renderer.domElement.remove();
        controlsRef.current = null;
        cameraRef.current = null;
      };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [circuit, dimensions]);

  function cameraPreset(preset: "iso" | "top") {
    if (!dimensions || !cameraRef.current || !controlsRef.current) return;
    const distance = Math.max(dimensions.width, dimensions.height) * 1.45;
    cameraRef.current.up.set(0, preset === "top" ? 1 : 0, preset === "top" ? 0 : 1);
    cameraRef.current.position.set(preset === "top" ? dimensions.x : dimensions.x + distance * 0.72, preset === "top" ? dimensions.y : dimensions.y - distance * 0.72, preset === "top" ? distance * 1.25 : distance * 0.66);
    cameraRef.current.lookAt(dimensions.x, dimensions.y, 0);
    controlsRef.current.target.set(dimensions.x, dimensions.y, 0);
    controlsRef.current.update();
  }

  if (!dimensions) return <div className="p-6"><EmptyState icon={<Box size={22} />} title="No board geometry" description="Add a PCB board to the circuit before opening the assembled 3D view." /></div>;
  if (error) return <div className="p-6"><EmptyState icon={<Box size={22} />} title="WebGL rendering unavailable" description={`${error}. The 2D PCB and structured board data remain available.`} /></div>;
  return <div className="relative isolate h-full min-h-80 overflow-hidden bg-[#080b0a]" data-fulmetry-3d-viewer>
    <div ref={hostRef} className="absolute inset-0 z-0" data-fulmetry-3d-host />
    <div className="absolute left-3 top-3 z-10 flex gap-1 rounded-lg border border-slate-700/70 bg-slate-950/85 p-1 backdrop-blur"><Button variant="ghost" size="sm" onClick={() => cameraPreset("iso")}><Rotate3D size={14} /> Isometric</Button><Button variant="ghost" size="sm" onClick={() => cameraPreset("top")}><Focus size={14} /> Top</Button><Button variant="ghost" size="sm" onClick={() => controlsRef.current?.reset()}><ScanLine size={14} /> Reset</Button></div>
    {selected && <div className="absolute right-3 top-3 z-10 w-72 rounded-lg border border-slate-700/70 bg-slate-950/90 p-3 text-xs shadow-xl backdrop-blur"><div className="flex items-center justify-between"><span className="font-semibold text-white">Component feedback</span><Badge tone="info">{titleCase(String(selected.type ?? "object"))}</Badge></div><dl className="mt-3 max-h-52 space-y-2 overflow-auto">{Object.entries(selected).filter(([, value]) => value !== undefined).map(([key, value]) => <div key={key}><dt className="text-[10px] uppercase tracking-wider text-slate-600">{key}</dt><dd className="mt-0.5 truncate font-mono text-slate-300">{String(value)}</dd></div>)}</dl>{canCopyComponentMoveFeedback(selected) ? <><Button className="mt-3 w-full" size="sm" onClick={() => void navigator.clipboard.writeText(componentMoveFeedbackPrompt(selected))}><MessageSquareText size={14} /> Copy move request</Button><p className="mt-2 text-[11px] leading-4 text-slate-500">Paste into your coding-agent chat and replace the bracketed instruction.</p></> : <p className="mt-3 rounded-md border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 text-[11px] leading-4 text-amber-100/80">Select a component body, pad, or plated hole. Board geometry, traces, and vias cannot be moved as components.</p>}</div>}
    <div className="absolute left-3 top-14 z-10 rounded-md border border-slate-700/70 bg-slate-950/85 px-2.5 py-1.5 text-[11px] text-slate-300 backdrop-blur" data-fulmetry-model-status>{modelState.failed.length > 0 ? `${modelState.loaded}/${modelState.total} models loaded · ${modelState.failed.length} failed` : modelState.loaded === modelState.total ? `${modelState.loaded} realistic models loaded` : `Loading models ${modelState.loaded}/${modelState.total}`}</div>
    <div className="absolute bottom-3 right-3 z-10 hidden max-h-48 w-72 overflow-auto rounded-lg border border-slate-700/70 bg-slate-950/85 p-2 shadow-xl backdrop-blur sm:block"><p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Scene objects</p>{sceneObjects.map((object, index) => <button key={`${String(object.id)}-${index}`} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-800 hover:text-white" onClick={() => setSelected(object)}><span className="shrink-0 font-mono text-xs font-bold text-slate-200">{String(object.reference ?? object.id ?? titleCase(String(object.type)))}</span>{(object.description ?? object.manufacturerPartNumber) !== undefined && <span className="min-w-0 truncate text-[10px] leading-4 text-slate-500">— {String(object.description ?? object.manufacturerPartNumber)}</span>}</button>)}</div>
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-slate-700/70 bg-slate-950/85 px-2.5 py-1.5 text-[11px] text-slate-300 backdrop-blur"><Rotate3D size={13} className="text-[#9cff57]" /> Drag to orbit · Scroll to zoom · Right-drag to pan</div>
  </div>;
}
