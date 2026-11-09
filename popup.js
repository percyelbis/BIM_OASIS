const TYPE_META = {
  WALL: { color: "#22c55e", letter: "W", label: "Muro" },
  WALLSTANDARDCASE: { color: "#22c55e", letter: "W", label: "Muro" },
  SLAB: { color: "#f59e0b", letter: "S", label: "Losa" },
  COLUMN: { color: "#8b5cf6", letter: "C", label: "Columna" },
  BEAM: { color: "#ec4899", letter: "B", label: "Viga" },
  MEMBER: { color: "#64748b", letter: "M", label: "Estructura" },
  WINDOW: { color: "#0ea5e9", letter: "V", label: "Ventana" },
  DOOR: { color: "#14b8a6", letter: "P", label: "Puerta" },
  ROOF: { color: "#ef4444", letter: "R", label: "Cubierta" },
  STAIR: { color: "#f97316", letter: "E", label: "Escalera" },
  RAILING: { color: "#94a3b8", letter: "R", label: "Baranda" },
  FURNITURE: { color: "#eab308", letter: "M", label: "Mobiliario" },
  FOOTING: { color: "#a16207", letter: "F", label: "Cimiento" },
  FOUNDATION: { color: "#a16207", letter: "F", label: "Cimiento" },
  SPACE: { color: "#34d399", letter: "E", label: "Espacio" },
  SITE: { color: "#10b981", letter: "T", label: "Terreno" },
  GEOGRAPHICELEMENT: { color: "#10b981", letter: "T", label: "Terreno" },
  BUILDING: { color: "#0ea5e9", letter: "E", label: "Edificio" },
  BUILDINGSTOREY: { color: "#06b6d4", letter: "N", label: "Nivel" },
  PLATE: { color: "#a78bfa", letter: "Pl", label: "Placa" },
  COVERING: { color: "#c084fc", letter: "R", label: "Revestimiento" },
  FLOWTERMINAL: { color: "#38bdf8", letter: "M", label: "Terminal MEP" },
  BUILDINGELEMENTPROXY: { color: "#3b82f6", letter: "G", label: "Genérico" },
};

export function metaFor(type) {
  const key = (type || "ITEM").replace(/^Ifc/i, "").toUpperCase();
  const hit = TYPE_META[key];
  if (hit) return hit;
  return { color: "#3b82f6", letter: key.slice(0, 2) || "?", label: key || "Elemento" };
}

/* ------------------------- utilidades IFC ------------------------- */

const rawValue = (value) => {
  if (value == null) return null;
  if (typeof value === "object" && "value" in value) return value.value;
  return value;
};

const textValue = (value) => {
  const raw = rawValue(value);
  if (raw == null || raw === "") return "";
  if (typeof raw === "boolean") return raw ? "Sí" : "No";
  if (typeof raw === "number") return String(raw);
  return String(raw);
};

const categoryOf = (item) =>
  String(item?._category?.value ?? item?._category ?? item?.type ?? "").toUpperCase();

const nameOf = (item) => textValue(item?.Name);

// Valor de una propiedad: NominalValue (psets) o HasQuantities (IfcElementQuantity).
const propertyValue = (prop) => {
  if (!prop) return "";
  const keys = [
    "NominalValue",
    "LengthValue",
    "AreaValue",
    "VolumeValue",
    "CountValue",
    "WeightValue",
    "TimeValue",
    "Value",
  ];
  for (const key of keys) {
    if (prop[key] !== undefined) return textValue(prop[key]);
  }
  return "";
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export function createPopup(components) {
  const root = document.getElementById("geo-popup");
  const body = root.querySelector("#gp-body");

  const q = (id) => root.querySelector(id);
  const iconEl = q("#gp-icon");
  const nameEl = q("#gp-name");
  const typeEl = q("#gp-type");
  const gidEl = q("#gp-gid");
  const latEl = q("#gp-lat");
  const lonEl = q("#gp-lon");
  const elevEl = q("#gp-elev");
  const isolateBtn = q("#gp-isolate");

  let onZoom = null;
  let onIsolate = null;
  let isolated = false;
  let onClose = null;
  let tsv = "";

  /* ------------------------ panel de datos ------------------------ */

  const addRow = (parent, label, value, { mono = false } = {}) => {
    if (value == null || value === "") return false;
    const row = el("div", "prop-row");
    row.appendChild(el("span", "prop-key", label));
    const val = el("span", mono ? "prop-value prop-mono" : "prop-value", value);
    val.title = value;
    row.appendChild(val);
    parent.appendChild(row);
    return true;
  };

  const addSection = (title, rows) => {
    const section = el("section", "prop-section");
    section.appendChild(el("div", "prop-section-title", title));
    let any = false;
    for (const [label, value, opts] of rows) {
      if (addRow(section, label, value, opts)) any = true;
    }
    if (!any) return null;
    body.appendChild(section);
    return section;
  };

  const addDetails = (title, rows) => {
    if (!rows.length) return;
    const details = el("details", "prop-details");
    details.open = true;
    const summary = el("summary", "prop-summary");
    summary.appendChild(el("span", "prop-summary-name", title));
    summary.appendChild(el("span", "prop-summary-count", String(rows.length)));
    details.appendChild(summary);
    const list = el("div", "prop-list");
    for (const [label, value, opts] of rows) addRow(list, label, value, opts);
    details.appendChild(list);
    body.appendChild(details);
  };

  const renderProperties = (item) => {
    body.innerHTML = "";
    tsv = "Sección\tPropiedad\tValor\n";

    if (!item) {
      body.appendChild(el("div", "prop-empty", "Sin datos de propiedades."));
      return;
    }

    const cat = categoryOf(item);
    const localId = textValue(item._localId);
    const guid = textValue(item._guid);

    // Identificación
    const identRows = [
      ["Categoría", cat],
      ["Nombre", nameOf(item)],
      ["GlobalId", guid, { mono: true }],
      ["LocalId", localId, { mono: true }],
      ["ObjectType", textValue(item.ObjectType)],
      ["Tag", textValue(item.Tag)],
      ["PredefinedType", textValue(item.PredefinedType)],
    ];
    const identSection = addSection("Identificación", identRows);
    if (identSection) {
      for (const [label, value] of identRows) {
        if (value) tsv += `Identificación\t${label}\t${value}\n`;
      }
    }

    // Nivel y tipo
    const relations = Array.isArray(item.IsDefinedBy) ? item.IsDefinedBy : [];
    const contained = Array.isArray(item.ContainedInStructure) ? item.ContainedInStructure : [];

    const storeys = contained
      .filter((rel) => /(BUILDINGSTOREY|SPATIALSTRUCTUREELEMENT)/.test(categoryOf(rel)))
      .map(nameOf)
      .filter(Boolean);
    const types = relations
      .filter((rel) => /TYPE$/.test(categoryOf(rel)))
      .map(nameOf)
      .filter(Boolean);

    const placeRows = [
      ["Nivel", storeys.join(", ")],
      ["Tipo", types.join(", ")],
    ];
    addSection("Ubicación en el modelo", placeRows);
    for (const [label, value] of placeRows) {
      if (value) tsv += `Ubicación\t${label}\t${value}\n`;
    }

    // Property sets y cantidades
    const psets = relations.filter((rel) => /PROPERTYSET|ELEMENTQUANTITY/.test(categoryOf(rel)));
    for (const pset of psets) {
      const psetName = nameOf(pset) || "Propiedades";
      const props = [
        ...(Array.isArray(pset.HasProperties) ? pset.HasProperties : []),
        ...(Array.isArray(pset.HasQuantities) ? pset.HasQuantities : []),
      ]
        .map((prop) => [nameOf(prop), propertyValue(prop)])
        .filter(([propName, value]) => propName && value !== "");

      if (!props.length) continue;
      addDetails(psetName, props);
      for (const [propName, value] of props) {
        tsv += `${psetName}\t${propName}\t${value}\n`;
      }
    }

    if (!body.children.length) {
      body.appendChild(el("div", "prop-empty", "Este elemento no tiene propiedades adicionales."));
    }
  };

  /* --------------------------- controles --------------------------- */

  const close = () => {
    root.hidden = true;
    root.classList.remove("gp-visible");
    isolated = false;
    isolateBtn.textContent = "Aislar";
    if (typeof onClose === "function") onClose();
  };

  q("#gp-close").addEventListener("click", close);

  q("#gp-copy").addEventListener("click", async () => {
    const btn = q("#gp-copy");
    const text = tsv || "";
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // Fallback para iOS/Safari y contextos sin HTTPS.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    btn.textContent = ok ? "¡Copiado!" : "No disponible";
    setTimeout(() => (btn.textContent = "Copiar"), 1300);
  });

  isolateBtn.addEventListener("click", async () => {
    if (!onIsolate) return;
    isolated = await onIsolate();
    isolateBtn.textContent = isolated ? "Ver todo" : "Aislar";
  });

  q("#gp-zoom").addEventListener("click", () => {
    if (onZoom) onZoom();
  });

  const show = ({ name, type, globalId, lat, lon, elev }) => {
    const meta = metaFor(type);
    iconEl.textContent = meta.letter;
    iconEl.style.background = meta.color;
    nameEl.textContent = name || "Sin nombre";
    nameEl.title = name || "";
    typeEl.textContent = type || "Desconocido";
    typeEl.style.background = meta.color + "1f";
    typeEl.style.color = meta.color;
    gidEl.textContent = globalId || "";
    latEl.textContent = lat != null ? `${lat.toFixed(6)}°` : "—";
    lonEl.textContent = lon != null ? `${lon.toFixed(6)}°` : "—";
    elevEl.textContent = elev != null ? `${elev.toFixed(2)} m` : "—";
    body.scrollTop = 0;
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add("gp-visible"));
  };

  const hide = () => {
    root.hidden = true;
    root.classList.remove("gp-visible");
    isolated = false;
    isolateBtn.textContent = "Aislar";
  };

  return {
    root,
    show,
    hide,
    setProperties: renderProperties,
    setOnZoom(fn) {
      onZoom = fn;
    },
    setOnIsolate(fn) {
      onIsolate = fn;
    },
    setOnClose(fn) {
      onClose = fn;
    },
  };
}
