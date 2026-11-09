import * as THREE from "three";
import { ZONE, latLonToUtm, lonLatToTile, tileToLonLat, tileWorldSize } from "./gis.js";

export const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const textureLoader = new THREE.TextureLoader();

export function pickZoom(centerLat, sizeMeters, targetTiles = 5) {
  const c = tileWorldSize(centerLat, 0);
  const z = Math.round(Math.log2((targetTiles * c) / sizeMeters));
  return Math.min(19, Math.max(8, z));
}

/**
 * Construye la capa base OSM alineada con el modelo.
 *
 * El modelo vive en coordenadas locales con origen en (anchorE, anchorN) UTM.
 * En esta escena +X es este, +Y elevacion y -Z norte (IFC Y-up). Cada tile se
 * proyecta con sus esquinas UTM reales y se apoya en el plano XZ con la cara
 * frontal hacia +Y, de modo que el norte de la imagen mira hacia -Z.
 */
export function buildBaseMap({ centerLat, centerLon, sizeMeters, mapZ, anchorE, anchorN, onTile }) {
  const zoom = pickZoom(centerLat, sizeMeters);
  const group = new THREE.Group();
  const { x, y } = lonLatToTile(centerLon, centerLat, zoom);
  const tileW = tileWorldSize(centerLat, zoom);
  const tilesAcross = Math.ceil(sizeMeters / tileW / 2) + 1;
  const template = OSM_URL.replace("{z}", zoom);
  const pending = [];

  for (let dx = -tilesAcross; dx <= tilesAcross; dx++) {
    for (let dy = -tilesAcross; dy <= tilesAcross; dy++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= 2 ** zoom || ty >= 2 ** zoom) continue;

      const { lonMin, lonMax, latMin, latMax } = tileToLonLat(tx, ty, zoom);
      const c1 = latLonToUtm(latMin, lonMin, ZONE, true);
      const c2 = latLonToUtm(latMax, lonMax, ZONE, true);
      const minE = Math.min(c1.e, c2.e);
      const maxE = Math.max(c1.e, c2.e);
      const minN = Math.min(c1.n, c2.n);
      const maxN = Math.max(c1.n, c2.n);

      const width = maxE - minE;
      const height = maxN - minN;
      const cx = (minE + maxE) / 2 - anchorE;
      // El modelo usa -Z como norte (coordenadas Y-up del IFC).
      const cz = anchorN - (minN + maxN) / 2;

      // Solape de 2 m entre tiles para ocultar las costuras.
      const geo = new THREE.PlaneGeometry(width + 2, height + 2);
      // -90°: cara frontal hacia +Y. El borde superior de la imagen (norte)
      // queda hacia -Z, que es el norte del modelo. Sin espejos.
      geo.rotateX(-Math.PI / 2);

      const mat = new THREE.MeshBasicMaterial({
        transparent: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, mapZ, cz);
      mesh.renderOrder = -1;

      const url = template.replace("{x}", tx).replace("{y}", ty);
      pending.push(
        new Promise((resolve) => {
          textureLoader.load(
            url,
            (tex) => {
              tex.colorSpace = THREE.SRGBColorSpace;
              tex.anisotropy = 4;
              mat.map = tex;
              mat.needsUpdate = true;
              resolve();
            },
            undefined,
            () => resolve()
          );
        })
      );
      group.add(mesh);
    }
  }

  group.userData.zoom = zoom;
  group.userData.pending = Promise.all(pending);
  if (onTile) group.userData.pending.then(() => onTile());
  return group;
}
