import * as THREE from "three";
import { ZONE, latLonToUtm, lonLatToTile, tileToLonLat, tileWorldSize } from "./gis.js";

export const BASEMAP_PROVIDERS = {
  satellite: {
    name: "Satélite",
    url: "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
  },
  osm: {
    name: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  },
};

const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin("anonymous");

export function pickZoom(centerLat, sizeMeters, targetTiles = 5) {
  const c = tileWorldSize(centerLat, 0);
  const z = Math.round(Math.log2((targetTiles * c) / sizeMeters));
  return Math.min(19, Math.max(10, z));
}

/**
 * Construye la capa base (Satélite o OSM) alineada con el modelo IFC georreferenciado.
 *
 * El modelo vive en coordenadas locales con origen en (anchorE, anchorN) UTM 19S.
 * En la escena: +X es este, +Y elevación y -Z norte (IFC Y-up).
 */
export function buildBaseMap({
  type = "satellite",
  centerLat,
  centerLon,
  sizeMeters = 300,
  mapZ = 0,
  anchorE,
  anchorN,
  anchorLat,
  anchorLon,
  zone = ZONE,
  south = true,
  onTile,
}) {
  const provider = BASEMAP_PROVIDERS[type] || BASEMAP_PROVIDERS.satellite;
  const zoom = pickZoom(centerLat, sizeMeters);
  const group = new THREE.Group();
  group.name = "BIM_BASEMAP";

  const { x, y } = lonLatToTile(centerLon, centerLat, zoom);
  const tileW = tileWorldSize(centerLat, zoom);
  const tilesAcross = Math.max(1, Math.ceil(sizeMeters / tileW / 2) + 1);
  const pending = [];

  // Anclaje UTM real
  let aE = anchorE;
  let aN = anchorN;
  if (aE == null || aN == null) {
    const utm = latLonToUtm(anchorLat, anchorLon, zone, south);
    aE = utm.e;
    aN = utm.n;
  }

  for (let dx = -tilesAcross; dx <= tilesAcross; dx++) {
    for (let dy = -tilesAcross; dy <= tilesAcross; dy++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= 2 ** zoom || ty >= 2 ** zoom) continue;

      const { lonMin, lonMax, latMin, latMax } = tileToLonLat(tx, ty, zoom);
      const c1 = latLonToUtm(latMin, lonMin, zone, south);
      const c2 = latLonToUtm(latMax, lonMax, zone, south);
      const minE = Math.min(c1.e, c2.e);
      const maxE = Math.max(c1.e, c2.e);
      const minN = Math.min(c1.n, c2.n);
      const maxN = Math.max(c1.n, c2.n);

      const width = maxE - minE;
      const height = maxN - minN;
      const cx = (minE + maxE) / 2 - aE;
      // En IFC Y-up: -Z es Norte
      const cz = aN - (minN + maxN) / 2;

      // Solape de 1.5 m entre tiles para evitar costuras
      const geo = new THREE.PlaneGeometry(width + 1.5, height + 1.5);
      geo.rotateX(-Math.PI / 2);

      const mat = new THREE.MeshBasicMaterial({
        transparent: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: 0.95,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, mapZ, cz);
      mesh.renderOrder = -1;

      const tileUrl = provider.url
        .replace("{z}", zoom)
        .replace("{x}", tx)
        .replace("{y}", ty);

      pending.push(
        new Promise((resolve) => {
          textureLoader.load(
            tileUrl,
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
  group.userData.type = type;
  group.userData.pending = Promise.all(pending);
  if (onTile) group.userData.pending.then(() => onTile());
  return group;
}
