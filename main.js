import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";
import { createPopup, metaFor } from "./popup.js";
import { buildBaseMap } from "./basemap.js";
import { ZONE, SITE_E, SITE_N, SITE_ELEV, utmToLatLon, extractIfcGeoreference } from "./gis.js";

const $ = (sel) => document.querySelector(sel);

// Base del sitio en tiempo de ejecucion (sirve en raiz o en /nombre-repo/).
const APP_BASE = new URL(".", window.location.href).href;

const container = $("#container");
const statusEl = $("#status");
const modelNameEl = $("#model-name");
const layersEl = $("#layers");
const layersCountEl = $("#layers-count");
const panel = $("#panel");
const panelOpenBtn = $("#panel-open");
const panelCloseBtn = $("#panel-close");
const fitBtn = $("#btn-fit");
const loadFileBtn = $("#load-file");
const loadFile2Btn = $("#load-file-2");
const fileInput = $("#file-input");
const loadingEl = $("#loading");
const loadingBar = $("#loading-bar");
const loadingPct = $("#loading-pct");
const loadingSub = $("#loading-sub");
const loadingError = $("#loading-error");
const dropZone = $("#drop-zone");
const geoHint = $("#geo-hint");
const viewChips = [...document.querySelectorAll("[data-view]")];
const bgChips = [...document.querySelectorAll("[data-bg]")];
const mapChips = [...document.querySelectorAll("[data-map]")];
const themeBtn = $("#btn-theme");

/* ------------------------------------------------------------------ */
/*  UI helpers                                                         */
/* ------------------------------------------------------------------ */

const status = (text) => {
  if (statusEl) statusEl.textContent = text;
};

const setLoadingProgress = (progress) => {
  const pct = Math.round(progress * 100);
  if (loadingBar) loadingBar.style.width = `${pct}%`;
  if (loadingPct) loadingPct.textContent = `${pct}%`;
};

const showLoading = (sub) => {
  if (loadingSub) loadingSub.textContent = sub || "Convirtiendo a Fragments";
  if (loadingError) loadingError.style.display = "none";
  if (loadingBar) loadingBar.style.width = "0%";
  if (loadingPct) loadingPct.textContent = "0%";
  if (loadingEl) loadingEl.hidden = false;
};

const hideLoading = () => {
  if (loadingEl) loadingEl.hidden = true;
};

const showLoadingError = (message) => {
  if (loadingError) {
    loadingError.textContent = `Error: ${message}. Revisa la consola (F12).`;
    loadingError.style.display = "block";
  }
  if (loadingPct) loadingPct.textContent = "Falló la carga";
};

const isMobile = () => window.matchMedia("(max-width: 899px)").matches;

const openPanel = () => {
  if (panel) panel.classList.add("open");
  if (panelOpenBtn) panelOpenBtn.classList.add("hidden");
};

const closePanel = () => {
  if (panel) panel.classList.remove("open");
  if (panelOpenBtn) panelOpenBtn.classList.remove("hidden");
};

panelOpenBtn?.addEventListener("click", openPanel);
panelCloseBtn?.addEventListener("click", closePanel);

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const init = async () => {
  const components = new OBC.Components();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();

  // Fondo por defecto
  let bgDark = document.body.classList.contains("dark");
  world.scene.three.background = new THREE.Color(bgDark ? 0x0b1120 : 0xf8fafc);

  // Buffer de profundidad logarítmico para eliminar temblores (Z-fighting)
  world.renderer = new OBC.SimpleRenderer(components, container, {
    antialias: true,
    logarithmicDepthBuffer: true,
    powerPreference: "high-performance",
  });
  world.renderer.showLogo = false;
  world.renderer.three.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // Cámara con planos near/far equilibrados
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  world.camera.three.near = 0.2;
  world.camera.three.far = 4000;
  world.camera.three.updateProjectionMatrix();

  // Suavizado y amortiguación estable de la cámara (sin micro-vibraciones)
  world.camera.controls.enableRotate = true;
  world.camera.controls.enablePan = true;
  world.camera.controls.enableZoom = true;
  world.camera.controls.restThreshold = 0.001;
  world.camera.controls.smoothTime = 0.12;
  world.camera.controls.dollyToCursor = true;

  components.init();

  const grids = components.get(OBC.Grids);
  const grid = grids.create(world);
  if (grid?.three) {
    grid.three.position.y = -0.01;
  }

  const fragments = components.get(OBC.FragmentsManager);
  const ensureFragments = () => {
    if (!fragments.initialized) {
      fragments.init(`${APP_BASE}fragments-worker.mjs`);
    }
  };
  ensureFragments();

  const ifcLoader = components.get(OBC.IfcLoader);
  ifcLoader.onIfcImporterInitialized.add((importer) => {
    importer.includeUniqueAttributes = true;
  });

  try {
    await ifcLoader.setup({
      autoSetWasm: false,
      wasm: { path: APP_BASE, absolute: true },
    });
  } catch (error) {
    console.error(error);
    showLoadingError(`No se pudo inicializar web-ifc: ${error?.message || error}`);
    return;
  }

  const caster = components.get(OBC.Raycasters).get(world);
  const highlighter = components.get(OBF.Highlighter);
  highlighter.setup({
    world,
    selectMaterialDefinition: {
      color: new THREE.Color("#f59e0b"),
      renderedFaces: 0,
      opacity: 0.6,
      transparent: true,
    },
  });

  const popup = createPopup(components);

  /* -------------------------- pin -------------------------- */

  const pinGroup = new THREE.Group();
  const pinMat = new THREE.MeshBasicMaterial({ color: "#2563eb" });
  const pinStem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), pinMat);
  const pinHead = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), pinMat);
  pinHead.position.y = 2.2;
  pinGroup.add(pinStem, pinHead);
  pinGroup.visible = false;
  world.scene.three.add(pinGroup);

  /* ------------------------ estado ------------------------- */

  let modelBox = null;
  let buildingBox = null;
  let currentView = "iso";
  let currentSelection = null;
  let isolatedIds = null;
  let layerItems = {}; // categoria -> number[]
  let hiddenCats = new Set();
  let activeModel = null;
  let mapMode = "none"; // "none" | "satellite" | "osm"
  let mapGroup = null;
  let mapSize = 350;
  let mapZ = -0.1;

  // Estado dinámico de georreferencia: inicia en null si no hay modelo
  let geoOrigin = null;
  let center = null;

  const applyGeoreference = (georef) => {
    if (georef && georef.hasGeoref) {
      geoOrigin = {
        E: georef.E,
        N: georef.N,
        elev: georef.elev,
        zone: georef.zone || ZONE,
        isSouth: georef.isSouth !== false,
      };
      center = { lat: georef.lat, lon: georef.lon };
      if (geoHint) {
        geoHint.textContent = `${georef.crs || `UTM ${geoOrigin.zone}${geoOrigin.isSouth ? "S" : "N"}`} · ${center.lat.toFixed(5)}°, ${center.lon.toFixed(5)}°`;
      }
    } else {
      geoOrigin = null;
      center = null;
      if (geoHint) {
        geoHint.textContent = "Modelo local (sin georreferencia GPS/UTM)";
      }
      if (mapMode !== "none") {
        setMapMode("none");
      }
    }
  };

  // Etiquetas BIM (sobreimpresiones en la vista 3D)
  const bimLabels = document.getElementById("bim-labels");
  let selectedLabelEl = null;

  /* ------------------------ vistas ------------------------- */

  const VIEW_DIRS = {
    iso: new THREE.Vector3(0.72, 0.85, 0.72).normalize(),
    top: new THREE.Vector3(0.0001, 1, 0.0001).normalize(),
    front: new THREE.Vector3(0.18, 0.14, -1).normalize(),
  };

  const UP_Y = new THREE.Vector3(0, 1, 0);
  const UP_NORTH = new THREE.Vector3(0, 0, -1);

  const setCameraUp = (up) => {
    const cam = world.camera.three;
    if (cam.up.distanceToSquared(up) < 1e-10) return;
    cam.up.copy(up);
    world.camera.controls.updateCameraUp();
  };

  const frameBox = (box, normal, up = UP_Y) => {
    if (!box || box.isEmpty()) return;
    const controls = world.camera.controls;
    const cam = world.camera.three;

    setCameraUp(up);

    const centerBox = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const anchor = centerBox.clone().addScaledVector(normal, Math.max(sphere.radius * 2.8, 10));

    controls.setLookAt(anchor.x, anchor.y, anchor.z, centerBox.x, centerBox.y, centerBox.z, true);

    const zAxis = normal.clone();
    let xAxis = new THREE.Vector3().crossVectors(up, zAxis);
    if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
    xAxis.normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    const v = new THREE.Vector3();
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          v.set(x, y, z).sub(anchor);
          const px = v.dot(xAxis);
          const py = v.dot(yAxis);
          const pz = v.dot(zAxis);
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
          if (pz < minZ) minZ = pz;
          if (pz > maxZ) maxZ = pz;
        }
      }
    }
    const extX = Math.max(maxX - minX, 1e-6);
    const extY = Math.max(maxY - minY, 1e-6);
    const extZ = Math.max(maxZ - minZ, 1e-6);

    if (cam.isOrthographicCamera) {
      const w = cam.right - cam.left;
      const h = cam.top - cam.bottom;
      if (isFinite(w) && isFinite(h) && w > 0 && h > 0) {
        controls.zoomTo(Math.min(w / extX, h / extY), true);
      }
    } else {
      const dist = controls.getDistanceToFitBox(extX, extY, extZ, false);
      if (isFinite(dist) && dist > 0) controls.dollyTo(dist, true);
    }
  };

  const getModelBox = () => {
    const boxer = components.get(OBC.BoundingBoxer);
    boxer.list.clear();
    boxer.addFromModels();
    const box = boxer.get();
    if (!box || box.isEmpty()) return null;
    return box;
  };

  const applyView = (kind = currentView, box = null) => {
    currentView = kind;
    const target = box || buildingBox || modelBox || getModelBox();
    if (!target) return;
    const up = kind === "top" ? UP_NORTH : UP_Y;
    frameBox(target, VIEW_DIRS[kind] || VIEW_DIRS.iso, up);
    viewChips.forEach((c) => c.classList.toggle("active", c.dataset.view === kind));
  };

  viewChips.forEach((chip) => {
    chip.addEventListener("click", () => applyView(chip.dataset.view));
  });

  fitBtn?.addEventListener("click", () => {
    modelBox = getModelBox();
    applyView(currentView, modelBox);
  });

  const BUILDING_BOX_CATS =
    /^(IFCSLAB|IFCROOF|IFCCOVERING|IFCCOLUMN|IFCBEAM|IFCMEMBER|IFCDOOR|IFCWINDOW|IFCSTAIR|IFCRAILING)/;

  const computeBuildingBox = async (model) => {
    const ids = [];
    for (const [cat, list] of Object.entries(layerItems)) {
      if (BUILDING_BOX_CATS.test(cat)) ids.push(...list);
    }
    if (!ids.length) return null;
    try {
      const boxer = components.get(OBC.BoundingBoxer);
      boxer.list.clear();
      await boxer.addFromModelIdMap({ [model.modelId]: new Set(ids) });
      const box = boxer.get();
      return box && !box.isEmpty() ? box : null;
    } catch (error) {
      console.warn("No se pudo calcular la caja del edificio.", error);
      return null;
    }
  };

  /* ------------------------ fondo claro / oscuro ----------------------- */

  const setBg = (dark) => {
    bgDark = dark;
    document.body.classList.toggle("dark", dark);
    document.body.classList.toggle("light", !dark);
    world.scene.three.background = new THREE.Color(bgDark ? 0x0b1120 : 0xf8fafc);
    bgChips.forEach((c) => c.classList.toggle("active", c.dataset.bg === (dark ? "dark" : "light")));
    setThemeIcon(dark);
  };

  themeBtn?.addEventListener("click", () => setBg(!bgDark));

  bgChips.forEach((chip) => {
    chip.addEventListener("click", () => setBg(chip.dataset.bg === "dark"));
  });

  const setThemeIcon = (dark) => {
    if (!themeBtn) return;
    themeBtn.textContent = dark ? "☀️" : "🌙";
    themeBtn.setAttribute("title", dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
  };
  setThemeIcon(bgDark);

  /* ------------------------ mapa base (Satélite / OSM) ----------------------- */

  const clearMap = () => {
    if (!mapGroup) return;
    world.scene.three.remove(mapGroup);
    mapGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
    mapGroup = null;
  };

  const refreshMap = () => {
    clearMap();
    if (grid?.three) grid.three.visible = mapMode === "none";
    if (mapMode === "none" || !modelBox || !geoOrigin || !center) return;

    status(`Cargando ${mapMode === "satellite" ? "Google Satélite" : "OpenStreetMap"}…`);
    mapGroup = buildBaseMap({
      type: mapMode,
      centerLat: center.lat,
      centerLon: center.lon,
      sizeMeters: mapSize,
      mapZ,
      anchorE: geoOrigin.E,
      anchorN: geoOrigin.N,
      zone: geoOrigin.zone,
      south: geoOrigin.isSouth,
      onTile: () => {
        status("Mapa base alineado con el modelo.");
      },
    });
    world.scene.three.add(mapGroup);
  };

  const setMapMode = (mode) => {
    if (mode !== "none" && (!geoOrigin || !center)) {
      status("Este modelo IFC no contiene datos de georreferencia GPS/UTM.");
      mapMode = "none";
      mapChips.forEach((c) => c.classList.toggle("active", c.dataset.map === "none"));
      clearMap();
      return;
    }
    mapMode = mode;
    mapChips.forEach((c) => c.classList.toggle("active", c.dataset.map === mode));
    refreshMap();
    if (mode === "none") status("Mapa base apagado.");
  };

  mapChips.forEach((chip) => {
    chip.addEventListener("click", () => setMapMode(chip.dataset.map));
  });

  /* ------------------------ etiquetas BIM ----------------------- */

  const createLabelEl = (text) => {
    const el = document.createElement("div");
    el.className = "bim-label";
    el.textContent = text;
    el.style.position = "absolute";
    el.style.padding = "4px 8px";
    el.style.borderRadius = "6px";
    el.style.background = "rgba(37, 99, 235, 0.92)";
    el.style.color = "#fff";
    el.style.fontSize = "11px";
    el.style.fontWeight = "600";
    el.style.pointerEvents = "none";
    el.style.whiteSpace = "nowrap";
    el.style.transform = "translate(-50%, -100%)";
    el.style.zIndex = "20";
    el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.3)";
    return el;
  };

  const clearBimLabels = () => {
    if (selectedLabelEl) {
      selectedLabelEl.remove();
      selectedLabelEl = null;
    }
  };

  const updateBimLabelsPosition = () => {
    if (!selectedLabelEl || !selectedPickPoint) return;
    const camera = world.camera.three;
    const pos = selectedPickPoint.clone();
    pos.project(camera);
    if (pos.z > 1) {
      selectedLabelEl.style.display = "none";
      return;
    }
    const x = ((pos.x + 1) / 2) * window.innerWidth;
    const y = ((1 - pos.y) / 2) * window.innerHeight;
    selectedLabelEl.style.left = `${x}px`;
    selectedLabelEl.style.top = `${y}px`;
    selectedLabelEl.style.display = "block";
  };

  // Escuchar movimiento de la cámara sin sobrecargar el hilo de render
  world.camera.controls.addEventListener("update", updateBimLabelsPosition);

  /* ------------------------ capas -------------------------- */

  const LAYER_DEFS = [
    { label: "Muros", color: "#22c55e", match: /^IFCWALL/ },
    { label: "Lozas", color: "#f59e0b", match: /^(IFCSLAB|IFCPLATE)/ },
    { label: "Cubiertas", color: "#ef4444", match: /^(IFCROOF|IFCCOVERING)/ },
    { label: "Columnas", color: "#8b5cf6", match: /^IFCCOLUMN/ },
    { label: "Vigas y estructura", color: "#64748b", match: /^(IFCBEAM|IFCMEMBER)/ },
    { label: "Puertas y ventanas", color: "#0ea5e9", match: /^(IFCDOOR|IFCWINDOW)/ },
    { label: "Mobiliario", color: "#eab308", match: /^IFCFURNITURE/ },
    { label: "MEP", color: "#38bdf8", match: /^(IFCFLOW|IFCDISTRIBUTION|IFCPIPE|IFCDUCT|IFCCABLECARRIER)/ },
    { label: "Espacios", color: "#34d399", match: /^IFCSPACE/ },
    { label: "Terreno y vías", color: "#10b981", match: /^(IFCSITE|IFCGEOGRAPHIC|IFCROAD|IFCCIVILELEMENT)/ },
    { label: "Entorno", color: "#64748b", match: /^IFCBUILDINGELEMENTPROXY/ },
    { label: "Otros", color: "#94a3b8", match: /.*/ },
  ];

  const buildLayers = async (model) => {
    layerItems = {};
    hiddenCats = new Set();
    if (layersEl) layersEl.innerHTML = "";
    if (layersCountEl) layersCountEl.textContent = "";

    let items = [];
    let cats = [];
    try {
      [items, cats] = await Promise.all([
        model.getItemsWithGeometry(),
        model.getItemsWithGeometryCategories(),
      ]);
    } catch (error) {
      console.warn("No se pudieron leer las categorías", error);
      return;
    }

    const groups = LAYER_DEFS.map((def) => ({ ...def, ids: [], cats: [] }));
    const byCat = new Map();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const id = item?._localId ?? item?.localId ?? item?.id;
      const cat = String(cats[i] ?? "").toUpperCase();
      if (id == null) continue;
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(id);

      const def = LAYER_DEFS.find((d) => d.match.test(cat)) || LAYER_DEFS[LAYER_DEFS.length - 1];
      const group = groups[LAYER_DEFS.indexOf(def)];
      group.ids.push(id);
      if (!group.cats.includes(cat)) group.cats.push(cat);
    }

    for (const [cat, ids] of byCat) layerItems[cat] = ids;

    const visibleGroups = groups.filter((g) => g.ids.length > 0);
    const total = visibleGroups.reduce((n, g) => n + g.ids.length, 0);
    if (layersCountEl) layersCountEl.textContent = `${total.toLocaleString("es-PE")} elementos`;

    for (const group of visibleGroups) {
      const row = document.createElement("label");
      row.className = "layer";
      const initiallyVisible = !group.cats.some((cat) => hiddenCats.has(cat));
      row.innerHTML = `
        <input type="checkbox" ${initiallyVisible ? "checked" : ""} />
        <span class="dot" style="background:${group.color}"></span>
        <span class="lname">${group.label}</span>
        <span class="lcount">${group.ids.length}</span>
        <span class="toggle"></span>
      `;
      if (!initiallyVisible) row.classList.add("off");
      const input = row.querySelector("input");
      input.addEventListener("change", async () => {
        row.classList.toggle("off", !input.checked);
        for (const cat of group.cats) {
          if (input.checked) hiddenCats.delete(cat);
          else hiddenCats.add(cat);
        }
        await applyVisibility();
        if (input.checked && group.label.startsWith("Terreno")) {
          await applyTerrainStyle(activeModel);
        }
      });
      if (layersEl) layersEl.appendChild(row);
    }
  };

  const applyVisibility = async () => {
    if (!activeModel) return;
    const show = [];
    const hide = [];
    for (const [cat, ids] of Object.entries(layerItems)) {
      if (!isolatedIds) {
        (hiddenCats.has(cat) ? hide : show).push(...ids);
      } else {
        for (const id of ids) (isolatedIds.has(id) ? show : hide).push(id);
      }
    }
    if (hide.length) await activeModel.setVisible(hide, false);
    if (show.length) await activeModel.setVisible(show, true);
  };

  const clearIsolation = async () => {
    isolatedIds = null;
    await applyVisibility();
  };

  const applyTerrainStyle = async (model) => {
    const geoIds = layerItems["IFCGEOGRAPHICELEMENT"] || [];
    if (!geoIds.length) return;
    try {
      const data = await model.getItemsData(geoIds);
      const terrainIds = [];
      for (let i = 0; i < geoIds.length; i++) {
        const name = String(data[i]?.Name?.value || "");
        if (/camino|asfalto|pista|road|v[ií]a/i.test(name)) continue;
        terrainIds.push(geoIds[i]);
      }
      if (terrainIds.length) await model.setOpacity(terrainIds, 0.32);
    } catch (error) {
      console.warn("No se pudo ajustar la opacidad del terreno.", error);
    }
  };

  const refreshTerrainStyle = () => {
    if (!activeModel) return;
    if (hiddenCats.has("IFCGEOGRAPHICELEMENT")) return;
    setTimeout(() => applyTerrainStyle(activeModel), 180);
  };

  /* ---------------------- seleccion ------------------------ */

  const hidePin = () => {
    pinGroup.visible = false;
  };

  const placePin = (point) => {
    if (!point) return;
    pinGroup.position.set(point.x, point.y + 1.2, point.z);
    pinGroup.visible = true;
  };

  let pendingPickPoint = null;
  let selectedPickPoint = null;

  highlighter.events.select.onHighlight.add(async (modelIdMap) => {
    currentSelection = modelIdMap;
    const first = Object.entries(modelIdMap)[0];
    if (!first) return;
    const [modelId, localIds] = first;
    const model = fragments.list.get(modelId);
    if (!model) return;

    selectedPickPoint = pendingPickPoint ?? null;
    const pickPoint = pendingPickPoint;
    pendingPickPoint = null;

    const ids = Array.from(localIds);
    const [itemData] = await model.getItemsData(ids);

    let fullData = null;
    try {
      [fullData] = await model.getItemsData(ids, {
        attributesDefault: true,
        relationsDefault: { attributes: false, relations: false },
        relations: {
          IsDefinedBy: { attributes: true, relations: true },
          ContainedInStructure: { attributes: true, relations: false },
        },
      });
    } catch (error) {
      console.warn("No se pudieron leer las propiedades completas.", error);
    }

    const hit = pickPoint ? { point: pickPoint } : await caster.castRay();
    const point = hit ? hit.point : null;

    // Coordenadas geograficas reales del elemento (si el IFC tiene georreferencia)
    let lat = null;
    let lon = null;
    let elev = null;
    if (point && geoOrigin) {
      const easting = point.x + geoOrigin.E;
      const northing = geoOrigin.N - point.z;
      const g = utmToLatLon(easting, northing, geoOrigin.zone || ZONE, geoOrigin.isSouth !== false);
      lat = g.lat;
      lon = g.lon;
      elev = point.y + geoOrigin.elev;
    }

    popup.setProperties(fullData || itemData);
    popup.show({
      name: itemData?.Name?.value,
      type: itemData?._category?.value,
      globalId: itemData?._guid?.value,
      lat,
      lon,
      elev,
    });

    // Etiqueta flotante estable
    clearBimLabels();
    if (bimLabels && selectedPickPoint) {
      selectedLabelEl = createLabelEl(itemData?.Name?.value || `Elemento ${ids[0]}`);
      bimLabels.appendChild(selectedLabelEl);
      updateBimLabelsPosition();
    }

    popup.setOnZoom(async () => {
      const target = point || new THREE.Vector3();
      const boxer = components.get(OBC.BoundingBoxer);
      boxer.list.clear();
      await boxer.addFromModelIdMap(modelIdMap);
      const box = boxer.get();
      if (box && !box.isEmpty()) {
        const up = currentView === "top" ? UP_NORTH : UP_Y;
        frameBox(box, VIEW_DIRS[currentView] || VIEW_DIRS.iso, up);
      } else {
        world.camera.controls.setLookAt(
          target.x + 20, target.y + 20, target.z + 20,
          target.x, target.y, target.z, true
        );
      }
    });

    popup.setOnIsolate(async () => {
      if (isolatedIds) {
        await clearIsolation();
        return false;
      }
      isolatedIds = new Set(ids);
      await applyVisibility();
      status(`Aislado: ${itemData?.Name?.value || "elemento"}`);
      return true;
    });

    placePin(point);
    refreshTerrainStyle();
  });

  highlighter.events.select.onClear.add(async () => {
    currentSelection = null;
    selectedPickPoint = null;
    clearBimLabels();
    popup.hide();
    hidePin();
    if (isolatedIds) await clearIsolation();
    refreshTerrainStyle();
  });

  popup.setOnClose(async () => {
    hidePin();
    clearBimLabels();
    if (isolatedIds) await clearIsolation();
  });

  /* -------------------- seleccion tactil ------------------- */

  const canvas = world.renderer.three.domElement;
  let tapStart = null;
  const activeTouches = new Set();

  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "mouse") return;
      activeTouches.add(event.pointerId);
      if (activeTouches.size > 1) {
        tapStart = null;
        return;
      }
      tapStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        time: performance.now(),
      };
    },
    { passive: true }
  );

  const cancelTap = (event) => {
    if (event?.pointerId != null) activeTouches.delete(event.pointerId);
    tapStart = null;
  };
  canvas.addEventListener("pointercancel", cancelTap, { passive: true });

  canvas.addEventListener(
    "pointerup",
    async (event) => {
      if (event.pointerType === "mouse") return;
      activeTouches.delete(event.pointerId);
      if (!tapStart || tapStart.id !== event.pointerId) return;
      const dx = event.clientX - tapStart.x;
      const dy = event.clientY - tapStart.y;
      const elapsed = performance.now() - tapStart.time;
      tapStart = null;
      if (Math.hypot(dx, dy) > 10 || elapsed > 800) return;

      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const position = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      try {
        const hit = await caster.castRay({ position });
        if (hit?.localId != null && hit.fragments?.modelId) {
          pendingPickPoint = hit.point || null;
          await highlighter.highlightByID(
            "select",
            { [hit.fragments.modelId]: new Set([hit.localId]) },
            true,
            false,
            null,
            true
          );
        } else {
          pendingPickPoint = null;
          await highlighter.clear("select");
        }
      } catch (error) {
        pendingPickPoint = null;
        console.warn("No se pudo seleccionar con el toque.", error);
      }
    },
    { passive: true }
  );

  /* ---------------------- carga IFC ------------------------ */

  const onModelReady = async (model, name) => {
    activeModel = model;
    if (modelNameEl) modelNameEl.textContent = name;
    modelBox = getModelBox();
    if (dropZone) dropZone.classList.add("hidden");

    if (modelBox) {
      const size = modelBox.getSize(new THREE.Vector3());
      mapSize = Math.max(size.x, size.z) * 2.2;
      mapZ = modelBox.min.y - 0.15;
    }

    await buildLayers(model);
    buildingBox = await computeBuildingBox(model);
    await applyVisibility();
    applyView("iso");
    if (isMobile()) closePanel();
    refreshMap();

    status("Modelo cargado. Toca un elemento para ver sus propiedades.");
  };

  // Limpieza segura del modelo anterior (sin destruir FragmentsManager)
  const clearModel = async () => {
    try {
      if (highlighter) {
        try { await highlighter.clear("select"); } catch {}
      }
      clearBimLabels();
      if (activeModel) {
        try { world.scene.three.remove(activeModel.object); } catch {}
        try {
          if (typeof activeModel.dispose === "function") {
            await activeModel.dispose();
          }
        } catch {}
        try {
          if (fragments?.core?.models?.list) {
            fragments.core.models.list.delete(activeModel.modelId);
          }
        } catch {}
        activeModel = null;
      }
      modelBox = null;
      buildingBox = null;
      layerItems = {};
      hiddenCats = new Set();
      isolatedIds = null;
      currentSelection = null;
      selectedPickPoint = null;
      try { popup.hide(); } catch {}
      if (layersEl) layersEl.innerHTML = '<p class="layers-empty">Carga un modelo IFC<br>para ver las capas.</p>';
      if (layersCountEl) layersCountEl.textContent = "";
      if (modelNameEl) modelNameEl.textContent = "Sin modelo";
      if (dropZone) dropZone.classList.remove("hidden");
      clearMap();
      status("Listo. Carga un modelo IFC para comenzar.");
    } catch (error) {
      console.warn("clearModel:", error);
    }
  };

  const loadIfcBuffer = async (buffer, name) => {
    ensureFragments();
    const model = await ifcLoader.load(buffer, false, name, {
      processData: {
        progressCallback: (progress) => setLoadingProgress(progress),
      },
    });
    return model;
  };

  const loadAndFit = async (buffer, name, opts = {}) => {
    try {
      await clearModel();
      showLoading(`Analizando ${name}…`);
      hidePin();

      // Extraer y aplicar georreferencia real del archivo IFC
      const georef = extractIfcGeoreference(buffer);
      applyGeoreference(georef);

      showLoading(`Convirtiendo ${name} a Fragments…`);
      const model = await loadIfcBuffer(buffer, name);
      if (model?.object && !model.object.parent) {
        world.scene.three.add(model.object);
      }
      model?.object?.updateMatrixWorld(true);
      await onModelReady(model, name);
      hideLoading();
      if (opts.onDone) opts.onDone();
    } catch (error) {
      console.error(error);
      showLoadingError(error?.message || String(error));
      if (opts.onError) opts.onError(error);
    }
  };

  loadFileBtn?.addEventListener("click", () => fileInput?.click());
  loadFile2Btn?.addEventListener("click", () => fileInput?.click());

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.ifc$/i, "") || "modelo";
    const buffer = new Uint8Array(await file.arrayBuffer());
    await loadAndFit(buffer, name);
    fileInput.value = "";
  });

  // Drag and drop en ventana completa
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (dropZone) dropZone.classList.add("drag-over");
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (dropZone) dropZone.classList.remove("drag-over");
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (dropZone) dropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (!file || !/\.ifc$/i.test(file.name)) return;
    const name = file.name.replace(/\.ifc$/i, "") || "modelo";
    const buffer = new Uint8Array(await file.arrayBuffer());
    await loadAndFit(buffer, name);
  });

  /* ----------------------- resize -------------------------- */

  const resize = () => {
    const { clientWidth, clientHeight } = container;
    world.camera.three.aspect = clientWidth / clientHeight;
    world.camera.three.updateProjectionMatrix();
    world.renderer.three.setSize(clientWidth, clientHeight);
    updateBimLabelsPosition();
  };

  resize();
  new ResizeObserver(resize).observe(container);
  window.addEventListener("orientationchange", () => setTimeout(resize, 250));

  /* ----------------------- arranque ------------------------ */
  status("Listo. Carga un modelo IFC para comenzar.");

  window.__bim = { components, world, fragments, ifcLoader, THREE, OBC, OBF, popup, metaFor, clearModel, loadAndFit };
};

init();
