const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;

export const ZONE = 19;
// Origen por defecto (Río Salado / Espinar, Cusco, EPSG:32719).
// En la escena local: +X = este, +Y = elevacion, -Z = norte.
export const SITE_E = 246226.22859;
export const SITE_N = 8363461.91194;
export const SITE_ELEV = 3883.842;

export function latLonToUtm(lat, lon, zone = ZONE, south = true) {
  const e = Math.sqrt(F * (2 - F));
  const e2 = e * e;
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const lon0 = ((zone * 6 - 183) * Math.PI) / 180;
  const N = A / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = (e2 / (1 - e2)) * Math.cos(latR) ** 2;
  const l = lonR - lon0;
  const M =
    A *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * latR -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latR) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latR) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * latR));
  const northing0 = south ? 10000000 : 0;
  const aRad = l * Math.cos(latR);
  const E =
    500000 +
    K0 *
      N *
      (aRad + ((1 - T + C) * aRad ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * e2) * aRad ** 5) / 120);
  const N_utm =
    northing0 +
    K0 *
      (M +
        N *
          Math.tan(latR) *
          (aRad ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * aRad ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * e2) * aRad ** 6) / 720));
  return { e: E, n: N_utm };
}

export function utmToLatLon(E, N, zone = ZONE, south = true) {
  const e = Math.sqrt(F * (2 - F));
  const e2 = e * e;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = E - 500000;
  const y = south ? N - 10000000 : N;
  const M = y / K0;
  const mu = M / (A * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1s = e1 * e1;
  const e1c = e1 ** 3;
  const e1d = e1 ** 4;
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1c) / 32) * Math.sin(2 * mu) +
    ((21 * e1s) / 16 - (55 * e1d) / 32) * Math.sin(4 * mu) +
    ((151 * e1c) / 96) * Math.sin(6 * mu) +
    ((1097 * e1d) / 512) * Math.sin(8 * mu);
  const sinp = Math.sin(phi1);
  const cosp = Math.cos(phi1);
  const C1 = e2 * cosp * cosp;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - e2 * sinp * sinp);
  const R1 = (A * (1 - e2)) / (1 - e2 * sinp * sinp) ** 1.5;
  const D = x / (N1 * K0);
  const lat =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * e2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * e2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon =
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * e2 + 24 * T1 ** 2) * D ** 5) / 120) / Math.cos(phi1);
  return { lat: (lat * 180) / Math.PI, lon: zone * 6 - 183 + (lon * 180) / Math.PI };
}

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { x: Math.floor(x), y: Math.floor(y) };
}

export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const latMin = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { lonMin, lonMax, latMin, latMax };
}

export const tileWorldSize = (lat, z) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/**
 * Extrae la georreferencia real de CUALQUIER archivo IFC (STEP/ISO-10303-21)
 * Analiza IFCPROJECTEDCRS, IFCMAPCONVERSION, IFCSITE e IFCCARTESIANPOINT.
 */
export function extractIfcGeoreference(ifcBufferOrText) {
  let text = "";
  if (typeof ifcBufferOrText === "string") {
    text = ifcBufferOrText.slice(0, 800000);
  } else if (ifcBufferOrText instanceof Uint8Array || ArrayBuffer.isView(ifcBufferOrText)) {
    const len = Math.min(ifcBufferOrText.length, 800000);
    text = new TextDecoder("utf-8").decode(ifcBufferOrText.subarray(0, len));
  } else {
    return { hasGeoref: false, E: null, N: null, lat: null, lon: null };
  }

  let crs = null;
  let zone = ZONE;
  let isSouth = true;
  let E = null;
  let N = null;
  let elev = null;
  let lat = null;
  let lon = null;
  let hasGeoref = false;

  // 1. Detectar Sistema Proyectado (EPSG)
  const crsMatch = text.match(/IFCPROJECTEDCRS\s*\(\s*['"]([^'"]+)['"]/i);
  if (crsMatch) {
    crs = crsMatch[1];
    const epsgMatch = crs.match(/EPSG:(\d+)/i);
    if (epsgMatch) {
      const code = parseInt(epsgMatch[1], 10);
      if (code >= 32701 && code <= 32760) {
        zone = code - 32700;
        isSouth = true;
      } else if (code >= 32601 && code <= 32660) {
        zone = code - 32600;
        isSouth = false;
      }
    }
  }

  // 2. Detectar IFCMAPCONVERSION (Eastings, Northings, OrthogonalHeight)
  const mapMatch = text.match(/IFCMAPCONVERSION\s*\([^,]+,[^,]+,\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)/i);
  if (mapMatch) {
    const mE = parseFloat(mapMatch[1]);
    const mN = parseFloat(mapMatch[2]);
    const mH = parseFloat(mapMatch[3]);
    if (Math.abs(mE) > 1000 && Math.abs(mN) > 1000) {
      E = mE;
      N = mN;
      elev = mH;
      hasGeoref = true;
    }
  }

  // 3. Detectar coordenadas UTM en puntos cartesianos del Site/Project placement
  if (!hasGeoref) {
    const ptMatches = [
      ...text.matchAll(
        /IFCCARTESIANPOINT\s*\(\s*\(\s*([1-9]\d{4,}\.?\d*)\s*,\s*([1-9]\d{5,}\.?\d*)\s*,\s*([-\d.]+)\s*\)\s*\)/gi
      ),
    ];
    if (ptMatches.length > 0) {
      const first = ptMatches[0];
      E = parseFloat(first[1]);
      N = parseFloat(first[2]);
      elev = parseFloat(first[3]);
      hasGeoref = true;
    }
  }

  // 4. Detectar IFCSITE (RefLatitude, RefLongitude)
  if (!hasGeoref) {
    const siteMatch = text.match(
      /IFCSITE\s*\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*\(([^)]+)\)\s*,\s*\(([^)]+)\)\s*,\s*([-\d.]+)/i
    );
    if (siteMatch) {
      const parseDms = (str) => {
        const parts = str.split(",").map((s) => parseFloat(s.trim()));
        if (parts.length >= 3) {
          const sign = parts[0] < 0 || Object.is(parts[0], -0) ? -1 : 1;
          const d = Math.abs(parts[0]);
          const m = parts[1] || 0;
          const s = parts[2] || 0;
          const u = parts[3] || 0;
          return sign * (d + m / 60 + (s + u / 1000000) / 3600);
        }
        return null;
      };
      const sLat = parseDms(siteMatch[1]);
      const sLon = parseDms(siteMatch[2]);
      const sElev = parseFloat(siteMatch[3]);

      // Filtrar default de plantilla Revit genérica (40.42, -3.70 Madrid)
      const isRevitDefault = sLat && Math.abs(sLat - 40.42) < 0.1 && sLon && Math.abs(sLon - (-3.7)) < 0.1;
      if (sLat != null && sLon != null && !isRevitDefault && (Math.abs(sLat) > 0.01 || Math.abs(sLon) > 0.01)) {
        lat = sLat;
        lon = sLon;
        elev = sElev || 0;
        hasGeoref = true;
      }
    }
  }

  // Convertir UTM -> Lat/Lon o viceversa
  if (E != null && N != null) {
    const converted = utmToLatLon(E, N, zone, isSouth);
    lat = converted.lat;
    lon = converted.lon;
  } else if (lat != null && lon != null) {
    const converted = latLonToUtm(lat, lon, zone, isSouth);
    E = converted.e;
    N = converted.n;
  }

  return {
    hasGeoref,
    crs: crs || (hasGeoref ? `UTM ${zone}${isSouth ? "S" : "N"}` : null),
    zone,
    isSouth,
    E,
    N,
    elev: elev ?? 0,
    lat,
    lon,
  };
}
