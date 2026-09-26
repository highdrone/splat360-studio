/**
 * Minimal typings for @mkkellogg/gaussian-splats-3d (the package ships none).
 * Only the surface used by SplatViewer is declared.
 */
declare module '@mkkellogg/gaussian-splats-3d' {
  import type { Camera, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

  export enum SceneFormat {
    Splat = 0,
    KSplat = 1,
    Ply = 2,
    Spz = 3,
  }
  export enum RenderMode {
    Always = 0,
    OnChange = 1,
    Never = 2,
  }
  export enum SceneRevealMode {
    Default = 0,
    Gradual = 1,
    Instant = 2,
  }
  export enum LogLevel {
    None = 0,
    Error = 1,
    Warning = 2,
    Info = 3,
    Debug = 4,
  }
  export enum WebXRMode {
    None = 0,
    VR = 1,
    AR = 2,
  }
  export enum SplatRenderMode {
    ThreeD = 0,
    TwoD = 1,
  }

  export interface ViewerOptions {
    rootElement?: HTMLElement;
    cameraUp?: [number, number, number];
    initialCameraPosition?: [number, number, number];
    initialCameraLookAt?: [number, number, number];
    selfDrivenMode?: boolean;
    useBuiltInControls?: boolean;
    ignoreDevicePixelRatio?: boolean;
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
    integerBasedSort?: boolean;
    halfPrecisionCovariancesOnGPU?: boolean;
    dynamicScene?: boolean;
    webXRMode?: WebXRMode;
    renderMode?: RenderMode;
    sceneRevealMode?: SceneRevealMode;
    antialiased?: boolean;
    focalAdjustment?: number;
    logLevel?: LogLevel;
    sphericalHarmonicsDegree?: number;
    enableOptionalEffects?: boolean;
    freeIntermediateSplatData?: boolean;
    threeScene?: Scene;
    renderer?: WebGLRenderer;
    camera?: Camera;
    splatRenderMode?: SplatRenderMode;
  }

  export interface AddSplatSceneOptions {
    format?: SceneFormat;
    splatAlphaRemovalThreshold?: number;
    showLoadingUI?: boolean;
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    progressiveLoad?: boolean;
    onProgress?: (percent: number, percentLabel: string, loaderStatus: number) => void;
    headers?: Record<string, string>;
  }

  export interface OrbitControlsLike {
    target: import('three').Vector3;
    object: Camera;
    update(): void;
    reset(): void;
    saveState(): void;
    enabled: boolean;
  }

  export class AbortablePromise<T> extends Promise<T> {
    abort(): void;
  }

  export class Viewer {
    constructor(options?: ViewerOptions);
    camera: Camera;
    perspectiveCamera: PerspectiveCamera;
    controls: OrbitControlsLike | null;
    threeScene: Scene;
    renderer: WebGLRenderer;
    rootElement: HTMLElement;
    addSplatScene(path: string, options?: AddSplatSceneOptions): AbortablePromise<void>;
    start(): void;
    stop(): void;
    dispose(): Promise<void>;
    forceRenderNextFrame(): void;
    isLoadingOrUnloading(): boolean;
    isDisposingOrDisposed(): boolean;
    getSceneCount(): number;
  }
}
