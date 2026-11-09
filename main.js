import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";
import ifcUrl from "./proyecto.ifc?url";
import { ZONE, SITE_E, SITE_N, SITE_ELEV, utmToLatLon } from "./gis.js";
import { buildBaseMap } from "./basemap.js";
import { createPopup, metaFor } from "./popup.js";

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
const fileInput = $("#file-input");
const loadingEl = $("#loading");
const loadingBar = $("#loading-bar");
const loadingPct = $("#loading-pct");
const loadingSub = $("#loading-sub");
const loadingError = $("#loading-error");
const viewChips = [...document.querySelectorAll("[data-view]")];
const mapChips = [...document.querySelectorAll("[data-map]")];
const geoHint = $("#geo-hint");

/* ------------------------------------------------------------------ */
/*  UI helpers                                                         */
/* ------------------------------------------------------------------ */

const status = (text) => {
  statusEl.textContent = text;
};

const setLoadingProgress = (progress) => {
  const pct = Math.round(progress * 100);
  loadingBar.style.width = `${pct}%`;
  loadingPct.textContent = `${pct}%`;
};

const showLoading = (sub) => {
  loadingSub.textContent = sub || "Convirtiendo a Fragments";
  loadingError.style.display = "none";
  loadingBar.style.width = "0%";
  loadingPct.textContent = "0%";
  loadingEl.hidden = false;
};

const hideLoading = () => {
  loadingEl.hidden = true;
};

const showLoadingError = (message) => {
  loadingError.textContent = `Error: ${message}. Revisa la consola (F12).`;
  loadingError.style.display = "block";
  loadingPct.textContent = "Falló la carga";
};

const isMobile = () => window.matchMedia("(max-width: 899px)").matches;

const openPanel = () => {
  panel.classList.add("open");
  panelOpenBtn.classList.add("hidden");
};

const closePanel = () => {
  panel.classList.remove("open");
  panelOpenBtn.classList.remove("hidden");
};

panelOpenBtn.addEventListener("click", openPanel);
panelCloseBtn.addEventListener("click", closePanel);

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const init = async () => {
  const components = new OBC.Components();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create({
    scene: OBC.SimpleScene,
    camera: OBC.OrthoPerspectiveCamera,
    renderer: OBC.SimpleRenderer,
  });

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = null;

  world.renderer = new OBC.SimpleRenderer(components, container);
  world.renderer.showLogo = false;
  world.renderer.three.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  world.camera.controls.enableRotate = true;
  world.camera.controls.enablePan = true;
  world.camera.controls.enableZoom = true;

  components.init();

  const grids = components.get(OBC.Grids);
  const grid = grids.create(world);
  if (grid?.three) {
    grid.three.position.y = -0.01;
  }

  const fragments = components.get(OBC.FragmentsManager);
  fragments.init(`${APP_BASE}fragments-worker.mjs`);

  const ifcLoader = components.get(OBC.IfcLoader);
  ifcLoader.onIfcImporterInitialized.add((importer) => {
    importer.includeUniqueAttributes = true;
  });

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
  let mapMode = "osm";
  let mapGroup = null;
  let mapSize = 200;
  let mapZ = 0;
  let currentView = "iso";
  let currentSelection = null;
  let isolatedIds = null;
  let layerItems = {}; // categoria -> number[]
  let hiddenCats = new Set();
  let activeModel = null;
  let geoOrigin = { E: SITE_E, N: SITE_N, elev: SITE_ELEV };
  let center = utmToLatLon(geoOrigin.E, geoOrigin.N, ZONE, true);

  const updateGeoHint = () => {
    center = utmToLatLon(geoOrigin.E, geoOrigin.N, ZONE, true);
    geoHint.textContent = `UTM 19S · EPSG:32719 · ${center.lat.toFixed(5)}, ${center.lon.toFixed(5)}`;
  };
  updateGeoHint();

  /* ------------------------ vistas ------------------------- */

  const VIEW_DIRS = {
    iso: new THREE.Vector3(0.72, 0.85, 0.72).normalize(),
    top: new THREE.Vector3(0.0001, 1, 0.0001).normalize(),
    front: new THREE.Vector3(0.18, 0.14, -1).normalize(),
  };

  const UP_Y = new THREE.Vector3(0, 1, 0);
  const UP_NORTH = new THREE.Vector3(0, 0, -1);

  // camera-controls necesita que se le avise cuando cambia el up de la camara.
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
    const anchor = centerBox.clone().addScaledVector(normal, Math.max(sphere.radius * 3, 10));

    controls.setLookAt(anchor.x, anchor.y, anchor.z, centerBox.x, centerBox.y, centerBox.z, false);

    // extensiones de la caja en el plano de la camara
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
        controls.zoomTo(Math.min(w / extX, h / extY), false);
      }
    } else {
      const dist = controls.getDistanceToFitBox(extX, extY, extZ, false);
      if (isFinite(dist) && dist > 0) controls.dollyTo(dist, false);
      if (!isFinite(cam.zoom)) {
        cam.zoom = 1;
        cam.updateProjectionMatrix();
      }
      const need = dist + sphere.radius * 2 + 100;
      if (isFinite(need) && cam.far < need) {
        cam.far = need;
        cam.updateProjectionMatrix();
      }
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

  // Encuadra el edificio por defecto; "Encuadrar" muestra todo el sitio.
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

  fitBtn.addEventListener("click", () => {
    modelBox = getModelBox();
    applyView(currentView, modelBox);
  });

  // Caja ajustada del edificio (sin muros perimetrales ni terreno).
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

  /* ------------------------ mapa OSM ----------------------- */

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
    // La rejilla CAD solo tiene sentido sin mapa base.
    if (grid?.three) grid.three.visible = mapMode !== "osm";
    if (mapMode !== "osm" || !modelBox) return;
    status("Cargando mapa OSM…");
    mapGroup = buildBaseMap({
      centerLat: center.lat,
      centerLon: center.lon,
      sizeMeters: mapSize,
      mapZ,
      anchorE: geoOrigin.E,
      anchorN: geoOrigin.N,
      onTile: () => {
        status("Mapa OSM alineado con el modelo.");
      },
    });
    world.scene.three.add(mapGroup);
  };

  const setMapMode = (mode) => {
    mapMode = mode;
    mapChips.forEach((c) => c.classList.toggle("active", c.dataset.map === mode));
    refreshMap();
    if (mode === "none") status("Mapa base oculto.");
  };

  mapChips.forEach((chip) => {
    chip.addEventListener("click", () => setMapMode(chip.dataset.map));
  });

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
    // El terreno IFC es enorme y tapa el edificio; se activa a demanda.
    hiddenCats = new Set(["IFCGEOGRAPHICELEMENT"]);
    layersEl.innerHTML = "";
    layersCountEl.textContent = "";

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

    // Ambas listas vienen alineadas por indice; _localId ya esta resuelto.
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
    layersCountEl.textContent = `${total.toLocaleString("es-PE")} elementos`;

    for (const group of visibleGroups) {
      const row = document.createElement("label");
      row.className = "layer";
      const initiallyVisible = !group.cats.some((cat) => hiddenCats.has(cat));
      row.innerHTML = `
        <input type="checkbox" ${initiallyVisible ? "checked" : ""} />
        <span class="dot" style="background:${group.color}"></span>
        <span class="name">${group.label}</span>
        <span class="count">${group.ids.length}</span>
        <span class="swatch"></span>
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
      layersEl.appendChild(row);
    }
  };

  const applyVisibility = async () => {
    if (!activeModel) return;
    // Dos llamadas en lote (ocultar y mostrar) en lugar de una por categoria.
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

  // Terreno translucido (estilo BIM+GIS) para que nunca tape los muros.
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
    // El resaltado de Fragments puede devolver la opacidad original.
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

  // Punto exacto de un toque, para no depender de la ultima posicion del mouse.
  let pendingPickPoint = null;

  highlighter.events.select.onHighlight.add(async (modelIdMap) => {
    currentSelection = modelIdMap;
    const first = Object.entries(modelIdMap)[0];
    if (!first) return;
    const [modelId, localIds] = first;
    const model = fragments.list.get(modelId);
    if (!model) return;

    // El punto del toque se consume de inmediato para que dos selecciones
    // seguidas no se pisen entre si.
    const pickPoint = pendingPickPoint;
    pendingPickPoint = null;

    const ids = Array.from(localIds);
    const [itemData] = await model.getItemsData(ids);

    // Propiedades completas (psets, nivel y tipo) para el panel.
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
    let lat = null;
    let lon = null;
    let elev = null;
    const point = hit ? hit.point : null;
    if (point) {
      // Marco local: +X este, +Y elevacion, -Z norte.
      const easting = point.x + geoOrigin.E;
      const northing = geoOrigin.N - point.z;
      const g = utmToLatLon(easting, northing, ZONE, true);
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
    popup.hide();
    hidePin();
    if (isolatedIds) await clearIsolation();
    refreshTerrainStyle();
  });

  popup.setOnClose(async () => {
    hidePin();
    if (isolatedIds) await clearIsolation();
  });

  /* -------------------- seleccion tactil ------------------- */

  // El Highlighter solo escucha mousedown/mouseup; en tactil se resuelve el
  // picking con pointer events y se reutiliza el punto exacto del toque.
  const canvas = world.renderer.three.domElement;
  let tapStart = null;
  const activeTouches = new Set();

  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "mouse") return;
      activeTouches.add(event.pointerId);
      // Un pinch (dos o mas dedos) nunca es un toque de seleccion.
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
      // Solo toques cortos y sin arrastre (el resto es orbita/pan).
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

  // La matriz de coordinacion del IFC da el origen real del modelo en UTM.
  const syncGeoreference = async (model) => {
    try {
      const c = await model.getCoordinates();
      if (Array.isArray(c) && c.length >= 3) {
        const E = -c[0];
        const elev = -c[1];
        const N = c[2];
        if (Number.isFinite(E) && Number.isFinite(N)) {
          geoOrigin = { E, N, elev: Number.isFinite(elev) ? elev : SITE_ELEV };
          updateGeoHint();
        }
      }
    } catch (error) {
      console.warn("Sin matriz de coordinacion; uso las constantes UTM.", error);
    }
  };

  const onModelReady = async (model, name) => {
    activeModel = model;
    modelNameEl.textContent = name;
    modelBox = getModelBox();
    if (modelBox) {
      const size = modelBox.getSize(new THREE.Vector3());
      mapSize = Math.max(size.x, size.z) * 1.6;
      mapZ = modelBox.min.y - 0.5;
    }

    await syncGeoreference(model);
    await buildLayers(model);
    buildingBox = await computeBuildingBox(model);
    await applyVisibility();
    applyView("iso");
    if (isMobile()) closePanel();
    refreshMap();

    status(
      mapMode === "osm"
        ? "Modelo cargado. Toca un elemento para consultar; usa el mapa OSM de base."
        : "Modelo cargado. Toca un elemento para ver sus propiedades."
    );
  };

  const loadIfcBuffer = async (buffer, name) => {
    const model = await ifcLoader.load(buffer, false, name, {
      processData: {
        progressCallback: (progress) => setLoadingProgress(progress),
      },
    });
    return model;
  };

  const loadAndFit = async (buffer, name, opts = {}) => {
    try {
      showLoading(`Convirtiendo ${name} a Fragments…`);
      hidePin();
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

  loadFileBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.ifc$/i, "") || "modelo";
    const buffer = new Uint8Array(await file.arrayBuffer());
    await loadAndFit(buffer, name);
    fileInput.value = "";
  });

  /* ----------------------- render -------------------------- */

  const animate = () => {
    requestAnimationFrame(animate);
    world.renderer.update();
  };
  animate();

  const resize = () => {
    const { clientWidth, clientHeight } = container;
    world.camera.three.aspect = clientWidth / clientHeight;
    world.camera.three.updateProjectionMatrix();
    world.renderer.three.setSize(clientWidth, clientHeight);
  };

  resize();
  new ResizeObserver(resize).observe(container);
  window.addEventListener("orientationchange", () => setTimeout(resize, 250));

  /* ----------------------- arranque ------------------------ */

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

  showLoading("Cargando modelo IFC…");
  try {
    const file = await fetch(ifcUrl);
    if (!file.ok) throw new Error(`No se pudo descargar proyecto.ifc (HTTP ${file.status})`);
    const data = await file.arrayBuffer();
    await loadAndFit(new Uint8Array(data), "proyecto");
  } catch (error) {
    console.error(error);
    showLoadingError(error?.message || String(error));
  }

  window.__bim = { components, world, fragments, ifcLoader, THREE, OBC, OBF, popup, metaFor };
};

init();
