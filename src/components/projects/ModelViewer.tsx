"use client";

import { Canvas } from "@react-three/fiber";
import { Center, OrbitControls, useGLTF } from "@react-three/drei";
import { Component, Suspense, type ReactNode } from "react";
import * as THREE from "three";
type ModelViewerProps = {
  url?: string;
};

function FallbackSculpture() {
  return (
    <mesh rotation={[0.4, 0.6, 0]} castShadow>
      <icosahedronGeometry args={[1.1, 0]} />
      <meshStandardMaterial
        color="#6b7c86"
        metalness={0.35}
        roughness={0.45}
        wireframe={false}
      />
    </mesh>
  );
}

function GlbModel({ url }: { url: string }) {
  // Target size (in scene units) the model's largest dimension is scaled to fit.
// Tuned for the fixed camera below (distance 4, fov 42).
const TARGET_SIZE = 2.6;

function GlbModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const cloned = useMemo(() => scene.clone(), [scene]);

  const scale = useMemo(() => {
    const box = new THREE.Box3().setFromObject(cloned);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!maxDim || !Number.isFinite(maxDim)) return 1;
    return TARGET_SIZE / maxDim;
  }, [cloned]);

  return (
    <Center>
      <primitive object={cloned} scale={scale} />
    </Center>
  );
}

class ModelErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { children: ReactNode }) {
    if (prevProps.children !== this.props.children && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function Scene({ url }: { url?: string }) {
  const resolved = url && url.length > 0 ? url : undefined;

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 6, 2]} intensity={1.2} />
      <directionalLight position={[-3, 2, -2]} intensity={0.35} />
      <Suspense fallback={<FallbackSculpture />}>
        <ModelErrorBoundary fallback={<FallbackSculpture />}>
          {resolved ? <GlbModel url={resolved} /> : <FallbackSculpture />}
        </ModelErrorBoundary>
      </Suspense>
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        minDistance={2}
        maxDistance={8}
        autoRotate
        autoRotateSpeed={0.6}
      />
    </>
  );
}

export function ModelViewer({ url }: ModelViewerProps) {
  return (
    <div className="h-full w-full bg-[var(--preview-bg)]">
      <Canvas camera={{ position: [0, 0, 4], fov: 42 }} dpr={[1, 1.75]}>
        <Scene url={url} />
      </Canvas>
    </div>
  );
}
