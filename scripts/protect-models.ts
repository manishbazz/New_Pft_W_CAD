/**
 * Encrypts the 3D models for the site.
 *
 *   models-src/<project-id>/<name>.glb  ->  public/projects/<project-id>/<name>.glb.enc
 *
 * Run:  bun run protect-models            (all models)
 *       bun run protect-models --simplify 0.5 --quantize
 *
 * Steps per model:
 *   1. Strip what a thief would value but the viewer doesn't need: node /
 *      mesh / material names, extras (SolidWorks exports put custom
 *      properties there), cameras, animations, unused data.
 *   2. Optional --simplify <ratio>: decimate meshes to roughly that
 *      fraction of the triangles (meshoptimizer). The site only shows a
 *      small rotating preview, so a lighter mesh looks the same there but
 *      is far less useful if extracted.
 *   3. Optional --quantize: store positions/normals as 14/10-bit integers
 *      (KHR_mesh_quantization) — smaller download, and the coordinates are
 *      no longer exact CAD values.
 *   4. AES-256-GCM encrypt. File layout: "MKS1" | 12-byte IV | ciphertext+tag.
 *
 * models-src/ is gitignored: the originals never reach GitHub or the
 * deployed site. Keep your own backup of them.
 *
 * Honest limit: the browser must decrypt the model to draw it, and the key
 * ships in the JS bundle. This stops "save the .glb from the Network tab"
 * and casual scraping; it cannot stop someone who captures GPU buffers or
 * steps through the decryption in DevTools.
 */
import { readdirSync, mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { webcrypto } from "node:crypto";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune, dedup, weld, simplify, quantize } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import draco3d from "draco3dgltf";
import keyFile from "../src/lib/modelKey.json";

const SRC = "models-src";
const OUT = "public/projects";

function parseArgs() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--simplify");
  const ratio = i >= 0 ? Number(args[i + 1]) : null;
  if (ratio !== null && !(ratio > 0 && ratio <= 1)) throw new Error("--simplify needs a ratio in (0, 1]");
  return { ratio, quantize: args.includes("--quantize") };
}

async function main() {
  const { ratio, quantize: doQuantize } = parseArgs();
  if (!existsSync(SRC)) throw new Error(`No ${SRC}/ folder — put original .glb files in ${SRC}/<project-id>/`);
  // SolidWorks exports Draco-compressed GLBs; decode them, and re-encode
  // with Draco on write (Draco also quantises, so --quantize is skipped).
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
    "draco3d.encoder": await draco3d.createEncoderModule(),
  });
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(keyFile.key, "hex"),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  if (ratio !== null) await MeshoptSimplifier.ready;

  for (const project of readdirSync(SRC)) {
    const dir = join(SRC, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".glb"))) {
      const doc = await io.read(join(dir, file));
      const root = doc.getRoot();
      for (const list of [root.listNodes(), root.listMeshes(), root.listMaterials(), root.listTextures(), root.listScenes()]) {
        for (const item of list) {
          item.setName("");
          item.setExtras({});
        }
      }
      root.setExtras({});
      root.getAsset().generator = "";
      for (const a of root.listAnimations()) a.dispose();
      for (const c of root.listCameras()) c.dispose();

      const transforms = [dedup(), prune()];
      if (ratio !== null) transforms.push(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001 }));
      const usesDraco = root.listExtensionsUsed().some((e) => e.extensionName === "KHR_draco_mesh_compression");
      if (doQuantize && !usesDraco) transforms.push(quantize());
      transforms.push(prune());
      await doc.transform(...transforms);

      const plain = await io.writeBinary(doc);
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const cipher = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
      const out = new Uint8Array(4 + iv.length + cipher.length);
      out.set(new TextEncoder().encode("MKS1"), 0);
      out.set(iv, 4);
      out.set(cipher, 4 + iv.length);

      mkdirSync(join(OUT, project), { recursive: true });
      const dest = join(OUT, project, `${basename(file)}.enc`);
      writeFileSync(dest, out);
      const before = statSync(join(dir, file)).size;
      console.log(`${join(dir, file)} (${(before / 1024).toFixed(0)} KB) -> ${dest} (${(out.length / 1024).toFixed(0)} KB)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
