# Visor BIM + OpenStreetMap

Visor web del modelo IFC (`proyecto.ifc`) con mapa base OpenStreetMap, propiedades de elementos, capas, vistas 3D/Planta/Frente, aislamiento y georreferencia UTM.

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

El resultado queda en `dist/`.

## Publicar en GitHub Pages

El repositorio incluye `.github/workflows/deploy.yml`, que compila y publica `dist/` automáticamente en cada push a `main`.

1. Crear un repositorio público en GitHub (sin README ni `.gitignore`, para no chocar con los del proyecto).
2. En esta carpeta:

```powershell
git init
git add .
git commit -m "Visor BIM con OpenStreetMap"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

3. En GitHub entrar a **Settings → Pages → Build and deployment** y elegir **Source: GitHub Actions**.
4. Esperar el workflow en la pestaña **Actions**. La URL queda como:

```text
https://TU_USUARIO.github.io/TU_REPO/
```

Cada push a `main` vuelve a publicar la versión nueva.

## Notas

- `node_modules/` y `dist/` están en `.gitignore`; GitHub Actions instala y compila.
- El IFC pesa ~12 MB, por eso la primera carga puede tardar unos segundos.
- Las rutas del worker, `web-ifc.wasm` y assets son relativas: funciona en la raíz de un dominio o en `usuario.github.io/repositorio/`.
- Si GitHub pide autenticación al hacer push, usar el navegador (Git Credential Manager) o un token personal.
