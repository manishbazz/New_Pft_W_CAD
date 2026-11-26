import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { LoadingManager } from "three";
import keyFile from "@/lib/modelKey.json";
import { BASE_PATH } from "@/lib/siteUrl";

/**
 * GLTFLoader for the site's encrypted models (*.glb.enc, written by
 * scripts/protect-models.ts): fetch -> AES-256-GCM decrypt in memory ->
 * parse. The decrypted GLB never exists as a URL or a file, so it doesn't
 * show up as a downloadable .glb in DevTools' Network tab and can't be
 * hot-linked. Plain .glb URLs are still loaded normally.
 *
 * This is a deterrent, not DRM: the key ships in this bundle and the
 * geometry has to reach the GPU to be drawn.
 */
const MAGIC = "MKS1";
let keyPromise: Promise<CryptoKey> | null = null;

function getKey() {
  keyPromise ??= crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyFile.key.match(/../g)!.map((h) => parseInt(h, 16))),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return keyPromise;
}

async function decrypt(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buf);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error("Not an encrypted model");
  const iv = bytes.subarray(4, 16);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, await getKey(), bytes.subarray(16));
}

export class EncryptedGLTFLoader extends GLTFLoader {
  constructor(manager?: LoadingManager) {
    super(manager);
    // Self-hosted Draco decoder (public/draco) instead of Google's CDN.
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${BASE_PATH}/draco/`);
    this.setDRACOLoader(draco);
  }

  override load(
    url: string,
    onLoad: Parameters<GLTFLoader["load"]>[1],
    onProgress?: Parameters<GLTFLoader["load"]>[2],
    onError?: Parameters<GLTFLoader["load"]>[3],
  ) {
    if (!url.endsWith(".enc")) {
      super.load(url, onLoad, onProgress, onError);
      return;
    }
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r.arrayBuffer();
      })
      .then(decrypt)
      .then((glb) => this.parse(glb, "", onLoad, onError))
      .catch((err) => (onError ? onError(err) : console.error(err)));
  }
}
