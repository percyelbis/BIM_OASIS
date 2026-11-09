import { defineConfig } from "vite";

// En produccion usa rutas relativas para que funcione igual en
// https://usuario.github.io/repositorio/ que en un dominio propio.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
}));
