# Visor BIM + OpenStreetMap

Visor web del modelo IFC (`proyecto.ifc`) con mapa base OpenStreetMap, propiedades de elementos, capas, vistas 3D/Planta/Frente, aislamiento, georreferencia UTM y generación de planos 2D por nivel.

## Planos 2D

1. Abre el panel lateral y pulsa **Planos → Abrir planos 2D**.
2. Elige el nivel y la altura de corte (por defecto 1.20 m).
3. Pulsa **Generar plano**. Se proyectan las aristas del nivel sobre un plano horizontal.
4. Exporta:
   - **DXF**: geometría vectorial a escala, capas `PLANTA` y `OCULTAS`, lámina A3.
   - **PNG**: lámina A3 con cajetín, escala gráfica y datos del nivel.
   - **PDF**: abre la lámina en una ventana de impresión para guardarla como PDF.

Opciones:
- **Ocultas**: muestra las aristas ocultas en gris discontinuo.
- **Mobiliario**: incluye muebles (puede ralentizar la proyección).
- **MEP**: incluye instalaciones.
- **Recortar**: descarta elementos fuera del contorno de las losas del edificio.

> La generación es una proyección de aristas (líneas), no un motor de documentación completo: no crea sombreados, cotas ni rótulos automáticos. Para modelos grandes conviene desactivar **Genéricos**, **Mobiliario** y **MEP**; el plano tarda menos y queda más limpio.

## Requisitos

- Node.js 18 o superior
- npm

## Uso local

```powershell
npm install
npm run dev
```

Abrir `http://localhost:5173/`.

## Compilar

```powershell
npm run build
npm run preview
```
