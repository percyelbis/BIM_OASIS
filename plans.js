import * as THREE from "three";
import * as OBC from "@thatopen/components";

/* ------------------------------------------------------------------ */
/*  Planos 2D por nivel                                               */
/*                                                                    */
/*  Flujo:                                                            */
/*  1. Lee la estructura espacial del IFC (IfcBuildingStorey).        */
/*  2. Proyecta las aristas del nivel con TechnicalDrawings.          */
/*  3. Dibuja las líneas en un canvas 2D (sin segundo WebGL).         */
/*  4. Exporta DXF con DxfManager y PNG/PDF con una lámina A3.        */
/* ------------------------------------------------------------------ */

const STOREY_CAT = /^IFCBUILDINGSTOREY$/;
const BUILDING_CAT = /^IFCBUILDING$/;

// Categorías que no aportan a una planta arquitectónica.
const PLAN_EXCLUDE =
  /^(IFCSPACE|IFCOPENINGELEMENT|IFCVOIDINGELEMENT|IFCSITE|IFCGEOGRAPHICELEMENT|IFCROAD|IFCTERRAIN|IFCPROJECT|IFCBUILDINGSTOREY|IFCBUILDING$|IFCANNOTATION|IFCGRID|IFCPORT|IFCDISTRIBUTIONPORT|IFCREL|IFCPROPERTY|IFCQUANTITY|IFCMATERIAL|IFCSTYLE|IFCPRESENTATION|IFCSURFACESTYLE|IFCTYPEOBJECT|IFCTYPEPRODUCT|IFCELEMENTTYPE)/;

const FURNITURE_CAT =
  /^(IFCFURNITURE|IFCFURNISHINGELEMENT|IFCSYSTEMFURNITUREELEMENT)/;

const MEP_CAT =
  /^(IFCFLOW|IFCDISTRIBUTION|IFCPIPE|IFCDUCT|IFCCABLECARRIER|IFCSANITARYTERMINAL|IFCELECTRIC|IFCLIGHTING|IFCAIRTERMINAL|IFCBOILER|IFCCHILLER|IFCPUMP|IFCVALVE|IFCFAN|IFCENERGYCONVERSION|IFCUNITARYEQUIPMENT)/;

const PROXY_CAT = /^IFCBUILDINGELEMENTPROXY/;

const LAYER_VISIBLE = "PLANTA";
const LAYER_HIDDEN = "OCULTAS";

const PAPER = { widthMm: 420, heightMm: 297, margin: 10 };
const SHEET_DPI = 150;
const SHEET_TITLE_H = 32; // mm reservados para el cajetín
const STANDARD_SCALES = [
  20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250,
  1500, 2000, 2500, 3000, 4000, 5000,
];

const $ = (sel) => document.querySelector(sel);

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const num = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const safeName = (text) =>
  String(text || "modelo")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "modelo";

const fmt = (n, digits = 0) =>
  Number(n).toLocaleString("es-PE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const elevLabel = (y) => {
  if (Math.abs(y) < 0.005) return "±0.00 m";
  return `${y > 0 ? "+" : "−"}${Math.abs(y).toFixed(2)} m`;
};

const niceMeters = (target) => {
  const values = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  for (const v of values) if (v >= target) return v;
  return values[values.length - 1];
};

const pickScale = (widthM, heightM, availWmm, availHmm) => {
  const needed = Math.max((widthM * 1000) / availWmm, (heightM * 1000) / availHmm);
  return STANDARD_SCALES.find((s) => s >= needed) || Math.ceil(needed / 500) * 500;
};

const translateProgress = (message) => {
  const text = String(message || "").toLowerCase();
  if (text.includes("extract")) return "Extrayendo geometría del nivel…";
  if (text.includes("bvh") || text.includes("overlap")) return "Calculando oclusiones y aristas…";
  if (text.includes("project")) return "Proyectando líneas del plano…";
  if (text.includes("build")) return "Construyendo el plano…";
  return message ? String(message) : "Generando plano…";
};

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 6000);
};

const canvasToBlob = (canvas) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No se pudo generar la imagen."))), "image/png");
  });

export function createPlanManager({ components, world, getModel, getModelName, getModelBox, getLayerItems }) {
  /* ------------------------------ DOM ------------------------------ */

  const modal = $("#plan-modal");
  const stage = $("#plan-stage");
  const canvas = $("#plan-canvas");
  const ctx = canvas?.getContext("2d");
  const levelSelect = $("#plan-level");
  const cutSelect = $("#plan-cut");
  const generateBtn = $("#plan-generate");
  const hiddenCheck = $("#plan-hidden");
  const furnitureCheck = $("#plan-furniture");
  const mepCheck = $("#plan-mep");
  const proxyCheck = $("#plan-proxies");
  const cropCheck = $("#plan-crop");
  const dxfBtn = $("#plan-dxf");
  const pngBtn = $("#plan-png");
  const pdfBtn = $("#plan-print");
  const closeBtn = $("#plan-close");
  const statusEl = $("#plan-status");
  const countEl = $("#plan-count");
  const modelEl = $("#plan-model");
  const emptyEl = $("#plan-empty");
  const progressEl = $("#plan-progress");
  const progressBar = $("#plan-progress-bar");
  const progressText = $("#plan-progress-text");
  const scaleBarEl = $("#plan-scalebar");
  const scaleFillEl = $("#plan-scale-fill");
  const scaleLabelEl = $("#plan-scale-label");
  const zoomBtns = [...document.querySelectorAll("[data-plan-zoom]")];

  if (!modal || !canvas || !ctx || !stage) {
    return {
      open: () => {},
      reset: () => {},
      setModel: () => {},
      isOpen: () => false,
    };
  }

  /* ----------------------------- estado ---------------------------- */

  const state = {
    model: null,
    modelId: null,
    name: "",
    modelBox: null,
    levels: [],
    selected: 0,
    cut: 1.2,
    includeFurniture: false,
    includeMEP: false,
    includeProxies: true,
    cropToBuilding: true,
    footprint: null,
    showHidden: false,
    visiblePath: null,
    hiddenPath: null,
    bounds: null,
    lineCount: 0,
    itemCount: 0,
    ready: false,
    stale: true,
    busy: false,
    levelsLoading: false,
  };

  const view = {
    scale: 1,
    ox: 0,
    oy: 0,
    cssW: 1,
    cssH: 1,
    fitScale: 1,
  };

  let drawing = null;
  let viewport = null;
  let lineSegments = [];
  let detectToken = 0;
  let generateToken = 0;

  /* --------------------------- utilidades -------------------------- */

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const setCount = (text) => {
    if (countEl) countEl.textContent = text;
  };

  const setEmpty = (show, title = "", sub = "") => {
    if (!emptyEl) return;
    emptyEl.hidden = !show;
    if (show) {
      const h = emptyEl.querySelector(".plan-empty-title");
      const p = emptyEl.querySelector(".plan-empty-sub");
      if (h) h.textContent = title;
      if (p) p.textContent = sub;
    }
  };

  const showProgress = (text, pct = null) => {
    if (!progressEl) return;
    progressEl.hidden = false;
    if (progressText) progressText.textContent = text;
    if (progressBar) {
      if (pct == null || !Number.isFinite(pct)) {
        progressBar.classList.add("indeterminate");
        progressBar.style.width = "100%";
      } else {
        progressBar.classList.remove("indeterminate");
        progressBar.style.width = `${clamp(pct * 100, 2, 100)}%`;
      }
    }
  };

  const hideProgress = () => {
    if (progressEl) progressEl.hidden = true;
    if (progressBar) {
      progressBar.classList.remove("indeterminate");
      progressBar.style.width = "0%";
    }
  };

  const setBusy = (busy) => {
    state.busy = busy;
    if (generateBtn) {
      generateBtn.disabled = busy;
      generateBtn.textContent = busy ? "Generando…" : "Generar plano";
    }
    if (levelSelect) levelSelect.disabled = busy;
    if (cutSelect) cutSelect.disabled = busy;
    if (furnitureCheck) furnitureCheck.disabled = busy;
    if (mepCheck) mepCheck.disabled = busy;
    if (proxyCheck) proxyCheck.disabled = busy;
    if (cropCheck) cropCheck.disabled = busy;
    for (const b of [dxfBtn, pngBtn, pdfBtn]) if (b) b.disabled = busy || !state.ready;
  };

  const updateExportButtons = () => {
    for (const b of [dxfBtn, pngBtn, pdfBtn]) if (b) b.disabled = state.busy || !state.ready;
  };

  const markStale = (message) => {
    state.stale = true;
    if (generateBtn) generateBtn.classList.add("dirty");
    setStatus(message || "Configuración cambiada. Pulsa «Generar plano».");
  };

  const clearDrawingLines = () => {
    for (const child of [...(drawing?.three?.children || [])]) {
      if (child.isLineSegments) {
        drawing.three.remove(child);
        try {
          child.geometry?.boundsTree?.dispose?.();
        } catch {}
        try {
          child.geometry?.dispose?.();
        } catch {}
      }
    }
    lineSegments = [];
  };

  const ensureDrawing = () => {
    if (drawing) return drawing;
    const tech = components.get(OBC.TechnicalDrawings);
    drawing = tech.create(world);
    drawing.orientTo(new THREE.Vector3(0, -1, 0));
    drawing.layers.create(LAYER_VISIBLE, {
      material: new THREE.LineBasicMaterial({ color: 0x1e293b }),
    });
    drawing.layers.create(LAYER_HIDDEN, {
      material: new THREE.LineDashedMaterial({
        color: 0x94a3b8,
        dashSize: 0.12,
        gapSize: 0.08,
      }),
    });
    drawing.activeLayer = LAYER_VISIBLE;
    // El plano no debe aparecer sobre el modelo 3D: solo se dibuja en su
    // canvas 2D. Las líneas viven en la capa 1 y se proyectan igual.
    drawing.three.visible = false;
    drawing.three.position.set(0, 0, 0);
    drawing.three.updateWorldMatrix(true, false);
    return drawing;
  };

  const ensureViewport = () => {
    if (!drawing) return null;
    if (!viewport) {
      viewport = drawing.viewports.create({
        left: -10,
        right: 10,
        top: 10,
        bottom: -10,
        scale: 100,
        name: "Planta",
      });
    }
    return viewport;
  };

  /* --------------------------- niveles ----------------------------- */

  const getAllIds = () => Object.values(getLayerItems?.() || {}).flat();

  const isPlanCategoryEnabled = (cat) => {
    const c = String(cat || "").toUpperCase();
    if (PLAN_EXCLUDE.test(c)) return false;
    if (!state.includeFurniture && FURNITURE_CAT.test(c)) return false;
    if (!state.includeMEP && MEP_CAT.test(c)) return false;
    if (!state.includeProxies && PROXY_CAT.test(c)) return false;
    return true;
  };

  const getCategoryMap = () => {
    const map = new Map();
    for (const [cat, ids] of Object.entries(getLayerItems?.() || {})) {
      for (const id of ids) map.set(id, String(cat || "").toUpperCase());
    }
    return map;
  };

  /**
   * Contorno del edificio a partir de la unión de losas (o cubiertas).
   * Sirve para descartar muros perimetrales del sitio que inflan el plano.
   */
  const computeFootprint = async (model, planIds, catMap) => {
    const slabIds = planIds.filter((id) => /^IFCSLAB/.test(catMap.get(id) || ""));
    const roofIds = planIds.filter((id) => /^IFCROOF/.test(catMap.get(id) || ""));
    for (const group of [slabIds, roofIds]) {
      if (!group.length) continue;
      try {
        const boxes = (await model.getBoxes(group)).filter((b) => b && !b.isEmpty());
        if (!boxes.length) continue;
        const union = new THREE.Box3();
        for (const b of boxes) union.union(b);
        if (union.isEmpty()) continue;
        const margin = 3;
        return {
          minX: union.min.x - margin,
          maxX: union.max.x + margin,
          minZ: union.min.z - margin,
          maxZ: union.max.z + margin,
        };
      } catch {}
    }
    return null;
  };

  const filterByFootprint = async (model, ids, footprint) => {
    const list = [...ids];
    if (!list.length || !footprint) return new Set(list);
    try {
      const boxes = await model.getBoxes(list);
      const out = new Set();
      for (let i = 0; i < list.length; i++) {
        const b = boxes[i];
        if (!b || b.isEmpty()) continue;
        if (b.max.x < footprint.minX || b.min.x > footprint.maxX) continue;
        if (b.max.z < footprint.minZ || b.min.z > footprint.maxZ) continue;
        out.add(list[i]);
      }
      return out;
    } catch {
      return new Set(list);
    }
  };

  const getStoreyIds = async (model) => {
    for (const regex of [STOREY_CAT, BUILDING_CAT]) {
      try {
        const found = await model.getItemsOfCategories([regex]);
        const key = Object.keys(found || {}).find((k) => regex.test(String(k).toUpperCase()));
        const ids = key ? found[key] : Object.values(found || {})[0];
        if (Array.isArray(ids) && ids.length) return { ids, kind: regex === STOREY_CAT ? "storey" : "building" };
      } catch (error) {
        console.warn("Planos: no se pudo leer la categoría espacial.", error);
      }
    }
    return { ids: [], kind: null };
  };

  const estimateElevationFromGeometry = async (model, ids, catMap, modelBox) => {
    const list = [...ids];
    if (!list.length) return null;

    const boxesOf = async (group) => {
      if (!group.length) return [];
      try {
        return (await model.getBoxes(group)).filter((b) => b && !b.isEmpty());
      } catch {
        return [];
      }
    };

    let wallBase = null;
    let slabTop = null;

    // Los muros nacen en el nivel de piso. El percentil 25 evita que un
    // muro de cimentación o un foso arrastren el nivel.
    const wallIds = list.filter((id) => /^IFCWALL/.test(catMap.get(id) || ""));
    const wallBoxes = await boxesOf(wallIds);
    if (wallBoxes.length) {
      const mins = wallBoxes.map((b) => b.min.y).sort((a, b) => a - b);
      wallBase = mins[Math.min(mins.length - 1, Math.floor(mins.length * 0.25))];
    }

    // La cara superior de la losa más baja es el nivel de piso.
    const slabIds = list.filter((id) => /^IFCSLAB/.test(catMap.get(id) || ""));
    const slabBoxes = await boxesOf(slabIds);
    if (slabBoxes.length) {
      slabTop = Math.min(...slabBoxes.map((b) => b.max.y));
    }

    if (wallBase != null && slabTop != null) return Math.max(wallBase, slabTop);
    if (slabTop != null) return slabTop;
    if (wallBase != null) return wallBase;

    // Sin muros ni losas: percentil 10 de las bases de todo el nivel.
    const allBoxes = await boxesOf(list);
    if (allBoxes.length) {
      const mins = allBoxes.map((b) => b.min.y).sort((a, b) => a - b);
      return mins[Math.min(mins.length - 1, Math.floor(mins.length * 0.1))];
    }
    return modelBox && !modelBox.isEmpty() ? modelBox.min.y : null;
  };

  /**
   * Elige el factor de unidad (m, mm, pies) comparando las diferencias entre
   * niveles con una altura de entrepiso típica. Esto evita confundir una
   * elevación absoluta (p. ej. 3883.74 m sobre el nivel del mar) con milímetros.
   */
  const chooseUnitScale = (rawElevations) => {
    const values = rawElevations.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (values.length < 2) return 1;
    const candidates = [1, 0.001, 0.01, 0.3048, 0.0254];
    let best = 1;
    let bestScore = Infinity;
    for (const c of candidates) {
      const scaled = values.map((v) => v * c);
      const diffs = [];
      for (let i = 1; i < scaled.length; i++) {
        const d = scaled[i] - scaled[i - 1];
        if (d > 0.005) diffs.push(d);
      }
      if (!diffs.length) continue;
      let score = 0;
      for (const d of diffs) {
        // Altura de entrepiso objetivo: 3 m. Se toleran sótanos y
        // entrepisos bajos, pero no diferencias de 0.001 m.
        score += Math.abs(Math.log(Math.max(d, 0.05) / 3));
      }
      score /= diffs.length;
      if (score < bestScore - 1e-9) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  };

  const assignLevelsByBoxes = async (model, levels, planIds, modelBox) => {
    const ids = [...planIds];
    if (!ids.length || !levels.length) return;
    try {
      const boxes = await model.getBoxes(ids);
      const sorted = [...levels].sort((a, b) => a.elevation - b.elevation);
      for (const level of sorted) level.ids = new Set();
      for (let i = 0; i < ids.length; i++) {
        const box = boxes[i];
        if (!box || box.isEmpty()) continue;
        const minY = box.min.y;
        let target = sorted[0];
        for (let j = 0; j < sorted.length; j++) {
          const current = sorted[j];
          const nextY = sorted[j + 1]?.elevation ?? current.elevation + 3.2;
          if (minY < nextY - 0.15) {
            target = current;
            break;
          }
          target = current;
        }
        target.ids.add(ids[i]);
      }
      // Si un nivel quedó vacío, se conserva para que el usuario lo vea,
      // pero se avisa en el estado.
      for (const level of levels) level.assignedByBoxes = true;
    } catch (error) {
      console.warn("Planos: no se pudieron asignar elementos por cajas.", error);
      for (const level of levels) level.ids = new Set(ids);
    }
  };

  const detectLevels = async () => {
    const model = getModel();
    if (!model) return [];
    const token = ++detectToken;

    const modelBox = getModelBox?.() || (await (async () => {
      const boxer = components.get(OBC.BoundingBoxer);
      boxer.list.clear();
      await boxer.addFromModelIdMap({ [model.modelId]: new Set(await model.getItemsIdsWithGeometry()) });
      return boxer.get();
    })());

    state.modelBox = modelBox;
    const catMap = getCategoryMap();
    // Los elementos del nivel se guardan completos. Los filtros de
    // Mobiliario/MEP/Genéricos se aplican al generar, para que se puedan
    // cambiar sin volver a leer la estructura espacial.
    const planIds = getAllIds();
    const planIdSet = new Set(planIds);
    state.footprint = null;
    if (state.cropToBuilding) {
      state.footprint = await computeFootprint(model, planIds, catMap);
    }

    const { ids: spatialIds, kind } = await getStoreyIds(model);
    if (token !== detectToken) return state.levels;

    if (!spatialIds.length) {
      // Sin estructura espacial: una única planta con todo el modelo.
      const elevation = modelBox && !modelBox.isEmpty() ? modelBox.min.y : 0;
      state.levels = [
        {
          id: "all",
          name: "Planta única",
          elevation,
          ids: new Set(planIds),
          rawElevation: elevation,
          fallback: true,
        },
      ];
      return state.levels;
    }

    let data = [];
    try {
      // No pasar `attributes`: en Fragments 3.x esa opción reemplaza los
      // atributos por defecto y deja el ítem sin Name/Elevation.
      data = await model.getItemsData(spatialIds, { attributesDefault: true });
    } catch (error) {
      console.warn("Planos: no se pudieron leer los datos de niveles.", error);
    }
    if (token !== detectToken) return state.levels;

    const rawElevations = spatialIds.map((_, i) => num(data[i]?.Elevation?.value));
    const unitScale = chooseUnitScale(rawElevations);

    const levels = [];
    for (let i = 0; i < spatialIds.length; i++) {
      const id = spatialIds[i];
      const item = data[i] || {};
      const name = String(item.Name?.value || item.LongName?.value || (kind === "building" ? "Edificio" : `Nivel ${i + 1}`)).trim();

      let ids = new Set();
      try {
        const children = await model.getItemsChildren([id]);
        for (const childId of children) {
          if (planIdSet.has(childId)) ids.add(childId);
        }
      } catch (error) {
        console.warn("Planos: no se pudieron leer los elementos del nivel.", error);
      }
      if (token !== detectToken) return state.levels;

      levels.push({
        id,
        name,
        elevation: null,
        rawElevation: rawElevations[i],
        ids,
        fallback: ids.size === 0,
      });
    }

    if (token !== detectToken) return state.levels;

    // Las elevaciones IFC pueden ser relativas (0, 3, 6) o absolutas
    // (3883.74, 3883.84…). Calculamos un único desplazamiento de datum
    // usando el nivel más bajo y su geometría real (muros/losas).
    const minY = modelBox?.min?.y ?? -Infinity;
    const maxY = modelBox?.max?.y ?? Infinity;
    const span = Number.isFinite(maxY - minY) ? maxY - minY : 10;
    const plausible = (y) =>
      y != null &&
      Number.isFinite(y) &&
      y >= minY - span * 0.3 &&
      y <= maxY + span * 0.3;

    const validRaw = levels.map((l) => l.rawElevation).filter((v) => Number.isFinite(v));
    let offset = 0;
    if (validRaw.length) {
      const minRaw = Math.min(...validRaw);
      const lowest = levels
        .filter((l) => Number.isFinite(l.rawElevation))
        .sort((a, b) => a.rawElevation - b.rawElevation)[0];
      const anchor = lowest
        ? await estimateElevationFromGeometry(model, lowest.ids, catMap, modelBox)
        : null;
      if (anchor != null && Number.isFinite(anchor)) {
        offset = anchor - minRaw * unitScale;
      }
    }

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      let elevation = Number.isFinite(level.rawElevation)
        ? level.rawElevation * unitScale + offset
        : null;
      if (!plausible(elevation)) {
        elevation = await estimateElevationFromGeometry(model, level.ids, catMap, modelBox);
      }
      if (!plausible(elevation)) {
        elevation = minY + (span * i) / Math.max(1, levels.length - 1 || 1);
      }
      level.elevation = elevation;
    }

    if (token !== detectToken) return state.levels;

    // Si la estructura espacial no trajo elementos, se asignan por caja.
    const totalAssigned = levels.reduce((n, l) => n + l.ids.size, 0);
    if (totalAssigned === 0 && planIds.length) {
      await assignLevelsByBoxes(model, levels, planIds, modelBox);
    }

    levels.sort((a, b) => a.elevation - b.elevation);

    // Nombres repetidos: se diferencian para que el selector sea claro.
    const seen = new Map();
    for (const level of levels) {
      const key = level.name.toLowerCase();
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) level.name = `${level.name} (${n})`;
    }

    state.levels = levels.filter((l) => l.ids.size > 0 || levels.length === 1);
    if (!state.levels.length) {
      state.levels = [
        {
          id: "all",
          name: "Planta única",
          elevation: modelBox?.min?.y ?? 0,
          ids: new Set(planIds),
          fallback: true,
        },
      ];
    }
    return state.levels;
  };

  const renderLevelOptions = () => {
    if (!levelSelect) return;
    levelSelect.innerHTML = "";
    state.levels.forEach((level, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `${level.name} · ${elevLabel(level.elevation)}`;
      levelSelect.appendChild(option);
    });
    levelSelect.value = String(clamp(state.selected, 0, Math.max(0, state.levels.length - 1)));
  };

  /* -------------------------- proyección --------------------------- */

  const buildPaths = () => {
    const visiblePath = new Path2D();
    const hiddenPath = new Path2D();
    let vCount = 0;
    let hCount = 0;
    const vBounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const hBounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };

    const addGeometry = (geom, path, bounds) => {
      const pos = geom?.attributes?.position;
      if (!pos) return 0;
      let n = 0;
      for (let i = 0; i + 1 < pos.count; i += 2) {
        const x1 = pos.getX(i);
        const z1 = pos.getZ(i);
        const x2 = pos.getX(i + 1);
        const z2 = pos.getZ(i + 1);
        if (!Number.isFinite(x1) || !Number.isFinite(z1) || !Number.isFinite(x2) || !Number.isFinite(z2)) continue;
        const dx = x2 - x1;
        const dz = z2 - z1;
        if (dx * dx + dz * dz < 1e-6) continue; // menos de 1 mm
        path.moveTo(x1, z1);
        path.lineTo(x2, z2);
        n++;
        if (x1 < bounds.minX) bounds.minX = x1;
        if (x1 > bounds.maxX) bounds.maxX = x1;
        if (x2 < bounds.minX) bounds.minX = x2;
        if (x2 > bounds.maxX) bounds.maxX = x2;
        if (z1 < bounds.minZ) bounds.minZ = z1;
        if (z1 > bounds.maxZ) bounds.maxZ = z1;
        if (z2 < bounds.minZ) bounds.minZ = z2;
        if (z2 > bounds.maxZ) bounds.maxZ = z2;
      }
      return n;
    };

    lineSegments = (drawing?.three?.children || []).filter((c) => c.isLineSegments);
    for (const ls of lineSegments) {
      if (ls.userData?.layer === LAYER_HIDDEN) {
        hCount += addGeometry(ls.geometry, hiddenPath, hBounds);
      } else {
        vCount += addGeometry(ls.geometry, visiblePath, vBounds);
      }
    }

    state.visiblePath = vCount ? visiblePath : null;
    state.hiddenPath = hCount ? hiddenPath : null;
    state.lineCount = vCount + hCount;
    // El encuadre se basa en las líneas visibles. Las ocultas pueden
    // extenderse fuera del edificio y no deben descentrar la lámina.
    const bounds = vCount ? vBounds : hBounds;
    state.bounds =
      Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.minZ) && Number.isFinite(bounds.maxZ)
        ? { ...bounds }
        : null;
    return state.lineCount;
  };

  const clearProjection = () => {
    clearDrawingLines();
    state.visiblePath = null;
    state.hiddenPath = null;
    state.bounds = null;
    state.lineCount = 0;
    state.ready = false;
    updateExportButtons();
  };

  const generate = async () => {
    const model = getModel();
    const level = state.levels[state.selected];
    if (!model || !level) {
      setStatus("No hay un modelo o nivel disponible.");
      return;
    }
    if (state.busy) return;

    const token = ++generateToken;
    setBusy(true);
    setEmpty(false);
    setStatus(`Generando ${level.name}…`);
    setCount("");
    showProgress("Preparando el plano…", null);

    try {
      ensureDrawing();
      clearProjection();

      const catMap = getCategoryMap();

      // Filtros de categoría en tiempo de generación (no de detección).
      let planIds = new Set(
        [...level.ids].filter((id) => isPlanCategoryEnabled(catMap.get(id)))
      );

      // Recorte al contorno real del edificio: evita que los muros
      // perimetrales del terreno dominen la lámina.
      if (state.cropToBuilding) {
        if (!state.footprint) {
          state.footprint = await computeFootprint(model, getAllIds(), catMap);
        }
        if (state.footprint) {
          const filtered = await filterByFootprint(model, planIds, state.footprint);
          if (filtered.size >= 5) planIds = filtered;
        }
      }
      state.itemCount = planIds.size;

      const isWholeModel = level.id === "all";
      const cutY = isWholeModel
        ? (state.modelBox?.max?.y ?? level.elevation + state.cut) + 0.5
        : level.elevation + state.cut;
      const far = isWholeModel
        ? Math.max(3, (state.modelBox?.max?.y ?? 0) - (state.modelBox?.min?.y ?? 0) + 2)
        : state.cut + 0.35;

      drawing.three.position.set(0, cutY, 0);
      drawing.orientTo(new THREE.Vector3(0, -1, 0));
      drawing.far = far;
      drawing.three.updateWorldMatrix(true, false);

      const modelIdMap = { [model.modelId]: planIds };
      await drawing.addProjectionFromItems(modelIdMap, {
        layers: { visible: LAYER_VISIBLE, hidden: LAYER_HIDDEN },
        onProgress: (message, pct) => {
          if (token !== generateToken) return;
          showProgress(translateProgress(message), Number.isFinite(pct) ? pct : null);
        },
      });
      if (token !== generateToken) return;

      const lines = buildPaths();
      state.ready = lines > 0;
      state.stale = false;
      if (generateBtn) generateBtn.classList.remove("dirty");
      updateExportButtons();

      if (lines > 0) {
        fitView();
        render();
        setStatus(
          `${level.name} · ${fmt(state.itemCount)} elementos · ${fmt(lines)} líneas`
        );
        setCount(`Corte +${state.cut.toFixed(2)} m sobre el nivel`);
        setEmpty(false);
      } else {
        render();
        setStatus(`${level.name}: no se generaron líneas. Prueba otra altura de corte.`);
        setCount("");
        setEmpty(
          true,
          "Sin líneas en este nivel",
          "Prueba con otra altura de corte o revisa que el IFC tenga geometría en la planta."
        );
      }
    } catch (error) {
      console.error("Planos: error al generar.", error);
      setStatus(`No se pudo generar el plano: ${error?.message || error}`);
      setEmpty(
        true,
        "No se pudo generar el plano",
        "Revisa la consola (F12) para más detalle. También puedes probar otra altura de corte."
      );
    } finally {
      if (token === generateToken) {
        setBusy(false);
        hideProgress();
      }
    }
  };

  /* ---------------------------- canvas ----------------------------- */

  const resizeCanvas = () => {
    if (!stage || !canvas) return;
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    view.cssW = Math.max(1, rect.width);
    view.cssH = Math.max(1, rect.height);
  };

  const clampView = () => {
    const b = state.bounds;
    if (!b) return;
    const w = view.cssW;
    const h = view.cssH;
    const mw = (b.maxX - b.minX) * view.scale;
    const mh = (b.maxZ - b.minZ) * view.scale;
    const pad = 40;
    // Evita perder el plano al hacer pan: siempre deja una parte visible.
    view.ox = clamp(view.ox, -mw + pad, w - pad);
    view.oy = clamp(view.oy, -mh + pad, h - pad);
  };

  const fitView = () => {
    const b = state.bounds;
    if (!b) return;
    const w = view.cssW;
    const h = view.cssH;
    const pad = 30;
    const bw = Math.max(1e-3, b.maxX - b.minX);
    const bh = Math.max(1e-3, b.maxZ - b.minZ);
    const scale = Math.max(1e-4, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh));
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    view.scale = scale;
    view.fitScale = scale;
    view.ox = w / 2 - cx * scale;
    view.oy = h / 2 - cz * scale;
  };

  const render = () => {
    if (!ctx || !canvas) return;
    const dpr = canvas.width / view.cssW || 1;
    const w = view.cssW;
    const h = view.cssH;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Marco de la hoja.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1));

    if (!state.visiblePath && !state.hiddenPath) {
      updateScaleBar();
      return;
    }

    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (state.visiblePath) {
      ctx.strokeStyle = "#1e293b";
      ctx.lineWidth = 1 / view.scale;
      ctx.setLineDash([]);
      ctx.stroke(state.visiblePath);
    }

    if (state.showHidden && state.hiddenPath) {
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 0.8 / view.scale;
      ctx.setLineDash([4 / view.scale, 3 / view.scale]);
      ctx.stroke(state.hiddenPath);
      ctx.setLineDash([]);
    }

    ctx.restore();
    updateScaleBar();
  };

  const updateScaleBar = () => {
    if (!scaleBarEl || !scaleFillEl || !scaleLabelEl) return;
    if (!state.ready || !state.bounds) {
      scaleBarEl.hidden = true;
      return;
    }
    scaleBarEl.hidden = false;
    const meters = niceMeters(100 / view.scale);
    const px = meters * view.scale;
    scaleFillEl.style.width = `${clamp(px, 24, 220)}px`;
    scaleLabelEl.textContent = `${meters} m`;
  };

  const zoomAt = (clientX, clientY, factor) => {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const min = Math.max(1e-5, view.fitScale * 0.12);
    const max = Math.max(min * 2, view.fitScale * 40);
    const next = clamp(view.scale * factor, min, max);
    const k = next / view.scale;
    view.ox = px - (px - view.ox) * k;
    view.oy = py - (py - view.oy) * k;
    view.scale = next;
    render();
  };

  /* --------------------------- punteros ---------------------------- */

  const pointers = new Map();
  let panStart = null;
  let pinchStart = null;

  const onPointerDown = (event) => {
    if (!state.ready) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.classList.add("dragging");

    if (pointers.size === 1) {
      panStart = { x: event.clientX, y: event.clientY, ox: view.ox, oy: view.oy };
      pinchStart = null;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: view.scale,
      };
      panStart = null;
    }
  };

  const onPointerMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1 && panStart) {
      view.ox = panStart.ox + (event.clientX - panStart.x);
      view.oy = panStart.oy + (event.clientY - panStart.y);
      render();
      return;
    }

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart.dist > 1) {
        const target = clamp(
          pinchStart.scale * (dist / pinchStart.dist),
          Math.max(1e-5, view.fitScale * 0.12),
          Math.max(1e-4, view.fitScale * 40)
        );
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        zoomAt(midX, midY, target / view.scale);
      }
    }
  };

  const endPointer = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) {
      panStart = null;
      pinchStart = null;
      canvas.classList.remove("dragging");
      if (state.ready) {
        clampView();
        render();
      }
    } else if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      panStart = { x: p.x, y: p.y, ox: view.ox, oy: view.oy };
      pinchStart = null;
    }
  };

  const onWheel = (event) => {
    if (!state.ready) return;
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
  };

  /* -------------------------- exportación -------------------------- */

  const getExportScale = (level) => {
    const b = state.bounds;
    if (!b) return 100;
    const availW = PAPER.widthMm - 2 * PAPER.margin;
    const availH = PAPER.heightMm - 2 * PAPER.margin;
    return pickScale(b.maxX - b.minX, b.maxZ - b.minZ, availW, availH);
  };

  const configureViewport = (scale) => {
    const b = state.bounds;
    const vp = ensureViewport();
    if (!b || !vp) return null;
    vp.left = b.minX;
    vp.right = b.maxX;
    vp.top = -b.minZ;
    vp.bottom = -b.maxZ;
    vp.drawingScale = scale;
    vp.name = state.levels[state.selected]?.name || "Planta";
    return vp;
  };

  const exportDxf = () => {
    if (!state.ready || !drawing || !state.bounds) return;
    try {
      const scale = getExportScale();
      const vp = configureViewport(scale);
      if (!vp) throw new Error("No se pudo crear el viewport del plano.");
      const mmPerMeter = 1000 / scale;
      const planW = (state.bounds.maxX - state.bounds.minX) * mmPerMeter;
      const planH = (state.bounds.maxZ - state.bounds.minZ) * mmPerMeter;
      const availW = PAPER.widthMm - 2 * PAPER.margin;
      const availH = PAPER.heightMm - 2 * PAPER.margin;
      // Coordenadas relativas al área de dibujo (el exportador ya aplica
      // el margen de la lámina).
      const x = Math.max(0, (availW - planW) / 2);
      const y = Math.max(0, (availH - planH) / 2);

      const dxfManager = components.get(OBC.DxfManager);
      dxfManager.enabled = true;

      // Si «Ocultas» está apagado, el DXF también las omite: la lámina
      // y el CAD quedan coherentes y el archivo pesa mucho menos.
      const hiddenLines = (drawing.three.children || []).filter(
        (c) => c.isLineSegments && c.userData?.layer === LAYER_HIDDEN
      );
      const removeHidden = !state.showHidden;
      if (removeHidden) {
        for (const ls of hiddenLines) drawing.three.remove(ls);
      }
      try {
        const dxf = dxfManager.exporter.export(
          [{ drawing, viewports: [{ viewport: vp, x, y }] }],
          PAPER
        );
        const level = state.levels[state.selected];
        downloadBlob(
          new Blob([dxf], { type: "application/dxf" }),
          `${safeName(state.name)}-${safeName(level?.name || "planta")}-1-${scale}.dxf`
        );
        setStatus(`DXF generado: escala 1:${scale}, A3.`);
      } finally {
        if (removeHidden) {
          for (const ls of hiddenLines) drawing.three.add(ls);
        }
      }
    } catch (error) {
      console.error("Planos: error DXF.", error);
      setStatus(`No se pudo exportar el DXF: ${error?.message || error}`);
    }
  };

  const buildSheet = () => {
    const b = state.bounds;
    const level = state.levels[state.selected];
    if (!b || !level) return null;

    const mmPerPx = 25.4 / SHEET_DPI;
    const sheet = document.createElement("canvas");
    sheet.width = Math.round(PAPER.widthMm / mmPerPx);
    sheet.height = Math.round(PAPER.heightMm / mmPerPx);
    const g = sheet.getContext("2d");
    if (!g) return null;

    const pxPerMm = 1 / mmPerPx;
    g.setTransform(pxPerMm, 0, 0, pxPerMm, 0, 0); // unidades = mm

    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, PAPER.widthMm, PAPER.heightMm);

    // Marco exterior.
    g.strokeStyle = "#0f172a";
    g.lineWidth = 0.6;
    g.strokeRect(PAPER.margin, PAPER.margin, PAPER.widthMm - 2 * PAPER.margin, PAPER.heightMm - 2 * PAPER.margin);

    const drawTop = PAPER.margin + 2;
    const drawLeft = PAPER.margin + 2;
    const drawW = PAPER.widthMm - 2 * PAPER.margin - 4;
    const drawH = PAPER.heightMm - 2 * PAPER.margin - SHEET_TITLE_H - 6;

    const scale = pickScale(b.maxX - b.minX, b.maxZ - b.minZ, drawW, drawH);
    const mmPerMeter = 1000 / scale;
    const planW = (b.maxX - b.minX) * mmPerMeter;
    const planH = (b.maxZ - b.minZ) * mmPerMeter;
    const offX = drawLeft + (drawW - planW) / 2 - b.minX * mmPerMeter;
    const offY = drawTop + (drawH - planH) / 2 - b.minZ * mmPerMeter;

    g.save();
    g.translate(offX, offY);
    g.scale(mmPerMeter, mmPerMeter);
    g.lineCap = "round";
    g.lineJoin = "round";
    if (state.visiblePath) {
      g.strokeStyle = "#0f172a";
      g.lineWidth = 0.25 / mmPerMeter;
      g.stroke(state.visiblePath);
    }
    if (state.showHidden && state.hiddenPath) {
      g.strokeStyle = "#94a3b8";
      g.lineWidth = 0.18 / mmPerMeter;
      g.setLineDash([0.8 / mmPerMeter, 0.6 / mmPerMeter]);
      g.stroke(state.hiddenPath);
      g.setLineDash([]);
    }
    g.restore();

    // Barra de escala gráfica.
    const barMeters = niceMeters(60 / mmPerMeter);
    const barMm = barMeters * mmPerMeter;
    const barX = drawLeft + 4;
    const barY = drawTop + drawH - 7;
    g.fillStyle = "#0f172a";
    g.fillRect(barX, barY, barMm / 2, 2.2);
    g.fillStyle = "#ffffff";
    g.fillRect(barX + barMm / 2, barY, barMm / 2, 2.2);
    g.strokeStyle = "#0f172a";
    g.lineWidth = 0.3;
    g.strokeRect(barX, barY, barMm, 2.2);
    g.font = "2.6px sans-serif";
    g.fillStyle = "#0f172a";
    g.fillText("0", barX - 0.7, barY + 6);
    g.fillText(`${barMeters} m`, barX + barMm - 3.2, barY + 6);

    // Cajetín.
    const tbW = 190;
    const tbH = SHEET_TITLE_H - 2;
    const tbX = PAPER.widthMm - PAPER.margin - tbW;
    const tbY = PAPER.heightMm - PAPER.margin - tbH;
    g.strokeStyle = "#0f172a";
    g.lineWidth = 0.4;
    g.strokeRect(tbX, tbY, tbW, tbH);
    g.beginPath();
    g.moveTo(tbX + 120, tbY);
    g.lineTo(tbX + 120, tbY + tbH);
    g.moveTo(tbX + 120, tbY + tbH / 2);
    g.lineTo(tbX + tbW, tbY + tbH / 2);
    g.stroke();

    g.fillStyle = "#0f172a";
    g.font = "bold 5.4px sans-serif";
    g.fillText("BIM·3D", tbX + 4, tbY + 8);
    g.font = "2.6px sans-serif";
    g.fillText("PLANO DE PLANTA", tbX + 4, tbY + 13);
    g.font = "bold 3.2px sans-serif";
    const modelName = String(state.name || "Modelo").slice(0, 38);
    g.fillText(modelName, tbX + 4, tbY + 18.5);
    g.font = "2.4px sans-serif";
    g.fillText("Generado desde el visor BIM", tbX + 4, tbY + 25);
    g.fillText("percyquasar", tbX + 4, tbY + 28.5);

    g.font = "2.2px sans-serif";
    g.fillStyle = "#475569";
    g.fillText("NIVEL", tbX + 123, tbY + 6);
    g.fillText("ESCALA", tbX + 123, tbY + 17);
    g.font = "bold 3.4px sans-serif";
    g.fillStyle = "#0f172a";
    g.fillText(String(level.name).slice(0, 28), tbX + 123, tbY + 11.5);
    g.fillText(`1:${scale}`, tbX + 123, tbY + 22.5);
    g.font = "2.2px sans-serif";
    g.fillStyle = "#475569";
    g.fillText("FECHA", tbX + 165, tbY + 6);
    g.font = "3px sans-serif";
    g.fillStyle = "#0f172a";
    g.fillText(new Date().toLocaleDateString("es-PE"), tbX + 165, tbY + 11.5);
    g.font = "2.2px sans-serif";
    g.fillStyle = "#475569";
    g.fillText("A3", tbX + 165, tbY + 17);
    g.font = "3px sans-serif";
    g.fillStyle = "#0f172a";
    g.fillText("420 × 297 mm", tbX + 165, tbY + 22.5);

    return { sheet, scale };
  };

  const exportPng = async () => {
    if (!state.ready) return;
    const built = buildSheet();
    if (!built) return;
    try {
      const blob = await canvasToBlob(built.sheet);
      const level = state.levels[state.selected];
      downloadBlob(blob, `${safeName(state.name)}-${safeName(level?.name || "planta")}-1-${built.scale}.png`);
      setStatus(`PNG A3 generado: escala 1:${built.scale}.`);
    } catch (error) {
      console.error("Planos: error PNG.", error);
      setStatus(`No se pudo exportar el PNG: ${error?.message || error}`);
    }
  };

  const exportPdf = async () => {
    if (!state.ready) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setStatus("El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes.");
      return;
    }
    const built = buildSheet();
    if (!built) {
      printWindow.close();
      return;
    }
    try {
      const blob = await canvasToBlob(built.sheet);
      const url = URL.createObjectURL(blob);
      const level = state.levels[state.selected];
      const title = `Plano ${level?.name || ""} · ${state.name}`;
      printWindow.document.write(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${title.replace(/[<>&]/g, "")}</title>
  <style>
    @page { size: A3 landscape; margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    img { display: block; width: 100%; height: auto; }
    @media print { img { width: 100%; } }
  </style>
</head>
<body>
  <img src="${url}" alt="${title.replace(/[<>&"]/g, "")}">
  <script>window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 250); });</script>
</body>
</html>`);
      printWindow.document.close();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus("Ventana de impresión abierta: elige «Guardar como PDF».");
    } catch (error) {
      console.error("Planos: error PDF.", error);
      printWindow.close();
      setStatus(`No se pudo preparar el PDF: ${error?.message || error}`);
    }
  };

  /* ----------------------------- eventos --------------------------- */

  const open = async () => {
    const model = getModel();
    if (!model) {
      modal.hidden = false;
      if (modelEl) modelEl.textContent = "Sin modelo";
      setEmpty(
        true,
        "Carga un modelo IFC",
        "Arrastra un archivo .ifc al visor y vuelve a abrir Planos 2D."
      );
      setStatus("Carga un modelo IFC para generar planos.");
      return;
    }

    modal.hidden = false;
    if (modelEl) modelEl.textContent = getModelName?.() || state.name || "Modelo";
    resizeCanvas();

    if (state.modelId !== model.modelId) {
      state.model = model;
      state.modelId = model.modelId;
      state.name = getModelName?.() || "Modelo";
      state.levels = [];
      state.selected = 0;
      clearProjection();
      setEmpty(true, "Leyendo niveles…", "Interpretando la estructura espacial del IFC.");
    }

    if (!state.levels.length) {
      if (state.levelsLoading) return;
      state.levelsLoading = true;
      showProgress("Leyendo niveles del modelo…", null);
      setStatus("Leyendo niveles del IFC…");
      try {
        await detectLevels();
        renderLevelOptions();
        if (state.levels.length) {
          state.selected = 0;
          setStatus(`${state.levels.length} niveles detectados. Generando el primero…`);
          hideProgress();
          state.levelsLoading = false;
          await generate();
          return;
        }
        setStatus("No se detectaron niveles. Se usará una planta única.");
        setEmpty(
          true,
          "Sin niveles definidos",
          "El IFC no contiene IfcBuildingStorey. Se generará una vista de planta única."
        );
      } catch (error) {
        console.error("Planos: error al leer niveles.", error);
        setStatus(`No se pudieron leer los niveles: ${error?.message || error}`);
      } finally {
        state.levelsLoading = false;
        hideProgress();
      }
    }

    renderLevelOptions();
    if (state.ready) {
      fitView();
      render();
      updateExportButtons();
      setEmpty(false);
    } else if (state.levels.length && !state.busy) {
      await generate();
    }
  };

  const close = () => {
    modal.hidden = true;
  };

  const reset = () => {
    detectToken++;
    generateToken++;
    state.model = null;
    state.modelId = null;
    state.name = "";
    state.levels = [];
    state.selected = 0;
    state.ready = false;
    state.stale = true;
    clearProjection();
    if (drawing) {
      clearDrawingLines();
      drawing.three.visible = false;
    }
    if (modal) modal.hidden = true;
  };

  const setModel = (model, name, modelBox) => {
    detectToken++;
    generateToken++;
    state.model = model;
    state.modelId = model?.modelId ?? null;
    state.name = name || "Modelo";
    state.modelBox = modelBox || getModelBox?.() || null;
    state.levels = [];
    state.selected = 0;
    state.ready = false;
    state.stale = true;
    clearProjection();
    if (modelEl) modelEl.textContent = state.name;
    if (levelSelect) levelSelect.innerHTML = "";
    if (modal) modal.hidden = true;
    hideProgress();
    setBusy(false);
  };

  const markConfigStale = () => {
    if (!state.ready) return;
    markStale();
  };

  levelSelect?.addEventListener("change", () => {
    state.selected = clamp(Number(levelSelect.value) || 0, 0, Math.max(0, state.levels.length - 1));
    state.stale = true;
    if (!state.busy) generate();
  });

  cutSelect?.addEventListener("change", () => {
    const value = Number(cutSelect.value);
    state.cut = Number.isFinite(value) ? value : 1.2;
    markConfigStale();
  });

  furnitureCheck?.addEventListener("change", () => {
    state.includeFurniture = !!furnitureCheck.checked;
    markConfigStale();
  });

  mepCheck?.addEventListener("change", () => {
    state.includeMEP = !!mepCheck.checked;
    markConfigStale();
  });

  proxyCheck?.addEventListener("change", () => {
    state.includeProxies = !!proxyCheck.checked;
    markConfigStale("Elementos genéricos cambiados. Pulsa «Generar plano».");
  });

  cropCheck?.addEventListener("change", () => {
    state.cropToBuilding = !!cropCheck.checked;
    if (!state.cropToBuilding) state.footprint = null;
    markConfigStale("Recorte cambiado. Pulsa «Generar plano».");
  });

  hiddenCheck?.addEventListener("change", () => {
    state.showHidden = !!hiddenCheck.checked;
    render();
  });

  generateBtn?.addEventListener("click", () => generate());
  dxfBtn?.addEventListener("click", exportDxf);
  pngBtn?.addEventListener("click", exportPng);
  pdfBtn?.addEventListener("click", exportPdf);
  closeBtn?.addEventListener("click", close);

  zoomBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.ready) return;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (btn.dataset.planZoom === "fit") fitView();
      else zoomAt(cx, cy, btn.dataset.planZoom === "in" ? 1.35 : 1 / 1.35);
      render();
    });
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", (event) => {
    if (pointers.has(event.pointerId)) endPointer(event);
  });
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", () => {
    if (!state.ready) return;
    fitView();
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (modal.hidden) return;
    if (event.key === "Escape") close();
  });

  // El modal cambia de tamaño al rotar el dispositivo o al abrir el panel.
  const ro = new ResizeObserver(() => {
    if (modal.hidden) return;
    resizeCanvas();
    if (state.ready) {
      // Mantiene el centro visible; no reencuadra para no perder el zoom.
      render();
    }
  });
  ro.observe(stage);

  // Botón del panel lateral. En móvil cerramos el panel para que el modal
  // ocupe la pantalla y no quede abierto detrás al cerrar los planos.
  $("#btn-plans")?.addEventListener("click", () => {
    $("#panel")?.classList.remove("open");
    $("#panel-open")?.classList.remove("hidden");
    open();
  });

  /* ------------------------------ API ------------------------------ */

  const api = {
    open,
    close,
    reset,
    setModel,
    generate,
    isOpen: () => !modal.hidden,
    getState: () => ({
      levels: state.levels.map((l) => ({
        name: l.name,
        elevation: l.elevation,
        items: l.ids.size,
      })),
      selected: state.selected,
      lineCount: state.lineCount,
      itemCount: state.itemCount,
      ready: state.ready,
      busy: state.busy,
      bounds: state.bounds,
    }),
    debug: {
      exportDxfString: () => {
        if (!state.ready || !drawing) return null;
        const scale = getExportScale();
        const vp = configureViewport(scale);
        const dxfManager = components.get(OBC.DxfManager);
        dxfManager.enabled = true;
        return dxfManager.exporter.export(
          [{ drawing, viewports: [{ viewport: vp, x: 0, y: 0 }] }],
          PAPER
        );
      },
      buildSheet: () => {
        const built = buildSheet();
        return built ? { width: built.sheet.width, height: built.sheet.height, scale: built.scale } : null;
      },
      layerSummary: () => {
        const items = getLayerItems?.() || {};
        let total = 0;
        for (const ids of Object.values(items)) total += ids.length;
        return {
          categories: Object.keys(items).length,
          total,
          detail: Object.entries(items).map(([cat, ids]) => [cat, ids.length]),
        };
      },
    },
  };

  return api;
}
